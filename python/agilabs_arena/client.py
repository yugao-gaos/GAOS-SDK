"""Thin HTTP client over the AgiLabs Arena session API (spec/openapi.yaml).

No logic lives here — the server is authoritative. This is deliberately a
plain request/response mapping so any harness (or curl) stays equivalent.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
from dataclasses import dataclass, field
from typing import Any


PROTOCOL_ID = "agilabs.ticks"
PROTOCOL_VERSION = "1.0"
ARENA_CONTROL_EXTENSION = "agilabs.arena"
PARTICIPANT_ID_PATTERN = r"^[A-Za-z0-9_.:@-]{1,128}$"
_PARTICIPANT_ID_RE = re.compile(PARTICIPANT_ID_PATTERN)
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_FINITE_NUMBER = float.fromhex("0x1.fffffffffffffp+1023")
_ARENA_ROOM_STATUSES = {"connecting", "active", "completed", "expired"}
_ARENA_OUTCOME_REASONS = {"game", "disconnect", "idle", "abandoned"}


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


class ArenaAPIError(Exception):
    """Non-2xx response from the API."""

    def __init__(self, status: int, error: str, code: str | None = None, body: str | None = None):
        super().__init__(f"HTTP {status}: {error}")
        self.status = status
        self.error = error
        self.code = code
        self.body = body


class IllegalActionRejected(ArenaAPIError):
    """422 — the action was not in the legal set for this tick."""


class ProtocolMismatchError(Exception):
    """Response is not a valid AgiLabs Turns v1 envelope."""


def _validate_json(value: Any, label: str = "value", active: set[int] | None = None) -> None:
    active = set() if active is None else active
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > _MAX_FINITE_NUMBER:
            raise ProtocolMismatchError(f"{label} must contain only finite numbers")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ProtocolMismatchError(f"{label} must contain only finite numbers")
        return
    if not isinstance(value, (list, dict)):
        raise ProtocolMismatchError(f"{label} must contain only plain JSON values")
    identity = id(value)
    if identity in active:
        raise ProtocolMismatchError(f"{label} must not contain cycles")
    active.add(identity)
    try:
        if isinstance(value, list):
            for index, item in enumerate(value):
                _validate_json(item, f"{label}[{index}]", active)
        else:
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ProtocolMismatchError(f"{label} object keys must be strings")
                _validate_json(item, f"{label}.{key}", active)
    finally:
        active.remove(identity)


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value}")


def _json_loads(value: bytes | str, label: str) -> Any:
    try:
        parsed = json.loads(value, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, OverflowError) as error:
        raise ProtocolMismatchError(f"{label} is not valid JSON") from error
    _validate_json(parsed, label)
    return parsed


def _json_dumps(value: Any, label: str) -> str:
    _validate_json(value, label)
    try:
        return json.dumps(value, allow_nan=False)
    except (TypeError, ValueError, OverflowError) as error:
        raise ProtocolMismatchError(f"{label} is not valid JSON") from error


def parse_session_binding(value: Any) -> dict[str, Any]:
    """Validate a JSON-safe persisted cursor/seat binding."""
    if not isinstance(value, dict):
        raise ProtocolMismatchError("session binding must be an object")
    if value.get("protocol") != PROTOCOL_ID or value.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolMismatchError(f"session binding must use {PROTOCOL_ID} {PROTOCOL_VERSION}")
    revision = value.get("revision")
    participant = value.get("participantId")
    if (
        not isinstance(value.get("sessionId"), str) or not value["sessionId"].strip()
        or not isinstance(value.get("tickId"), str) or not value["tickId"].strip()
        or not isinstance(revision, int) or isinstance(revision, bool)
        or revision < 0 or revision > _MAX_SAFE_INTEGER
        or not isinstance(participant, str) or _PARTICIPANT_ID_RE.fullmatch(participant) is None
    ):
        raise ProtocolMismatchError("session binding cursor or participant is invalid")
    control_revision = value.get("controlRevision")
    if "controlRevision" in value and (
        not isinstance(control_revision, int) or isinstance(control_revision, bool)
        or control_revision < 0 or control_revision > _MAX_SAFE_INTEGER
    ):
        raise ProtocolMismatchError("session binding controlRevision is invalid")
    return {
        "protocol": PROTOCOL_ID,
        "protocolVersion": PROTOCOL_VERSION,
        "sessionId": value["sessionId"],
        "tickId": value["tickId"],
        "revision": revision,
        "participantId": participant,
        **({"controlRevision": control_revision} if "controlRevision" in value else {}),
    }


def parse_tick_result(data: Any) -> dict[str, Any]:
    """Validate only the genre-neutral v1 envelope, not game observation fields."""
    if not isinstance(data, dict):
        raise ProtocolMismatchError("response is not an object")
    if data.get("protocol") != PROTOCOL_ID or data.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolMismatchError(f"expected {PROTOCOL_ID} {PROTOCOL_VERSION}")
    if data.get("kind") not in ("tick", "pending"):
        raise ProtocolMismatchError("response kind must be tick or pending")
    if (
        not isinstance(data.get("sessionId"), str)
        or not data["sessionId"].strip()
        or not isinstance(data.get("tickId"), str)
        or not data["tickId"].strip()
    ):
        raise ProtocolMismatchError("response sessionId/tickId missing")
    revision = data.get("revision")
    if (
        not isinstance(revision, int)
        or isinstance(revision, bool)
        or revision < 0
        or revision > 9_007_199_254_740_991
        or "tick" not in data
    ):
        raise ProtocolMismatchError("response revision/tick missing")
    if data["kind"] == "pending":
        submitted = data.get("submittedParticipants")
        awaiting = data.get("awaitingParticipants")
        if (
            not _is_participant_list(submitted)
            or not _is_participant_list(awaiting)
        ):
            raise ProtocolMismatchError("pending participant lists missing")
        if len(set(submitted)) != len(submitted) or len(set(awaiting)) != len(awaiting):
            raise ProtocolMismatchError("pending participant lists must be unique")
        if not awaiting:
            raise ProtocolMismatchError("pending envelope must await a participant")
        if set(submitted).intersection(awaiting):
            raise ProtocolMismatchError("pending participant lists must be disjoint")
        accepted = data.get("acceptedParticipantId")
        if "acceptedParticipantId" in data and (
            not isinstance(accepted, str)
            or _PARTICIPANT_ID_RE.fullmatch(accepted) is None
            or accepted not in submitted
        ):
            raise ProtocolMismatchError("pending acceptedParticipantId must be submitted")
    if "extensions" in data:
        if not isinstance(data["extensions"], dict):
            raise ProtocolMismatchError("response extensions must be a plain JSON object")
        _validate_json(data["extensions"], "response extensions")
    return data


def _is_participant_list(value: Any) -> bool:
    return isinstance(value, list) and all(
        isinstance(participant_id, str)
        and _PARTICIPANT_ID_RE.fullmatch(participant_id) is not None
        for participant_id in value
    )


@dataclass
class Tick:
    tick_number: int
    narrative: str | None
    grid: str
    visual_events: list[dict[str, Any]]
    actions: list[dict[str, Any]]
    status: str  # "playing" | "won" | "failed"
    stars: int | None
    actions_used: int
    max_actions: int
    carrying: int | None
    control_revision: int | None = None
    units: list[dict[str, Any]] = field(default_factory=list)
    characters: list[dict[str, Any]] = field(default_factory=list)
    arena_outcome: str | None = None
    mode: str | None = None
    targetable_cells: list[list[int]] = field(default_factory=list)
    action_targeting: dict[str, Any] = field(default_factory=dict)
    dialogue_options: list[dict[str, Any]] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    pois: list[dict[str, Any]] = field(default_factory=list)
    talking_to: dict[str, Any] | None = None
    dialogue_speaker: str | None = None
    dialogue_emotion: str | None = None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Tick":
        hud = data.get("hud", {})
        return cls(
            tick_number=data["tickNumber"],
            narrative=data.get("narrative"),
            grid=data["grid"],
            visual_events=data.get("visualEvents", []),
            actions=data.get("actions", []),
            status=data["status"],
            stars=data.get("stars"),
            actions_used=hud.get("actionsUsed", 0),
            max_actions=hud.get("maxActions", 0),
            carrying=hud.get("carrying"),
            control_revision=data.get("controlRevision"),
            units=hud.get("units", []),
            characters=hud.get("characters", []),
            arena_outcome=hud.get("arenaOutcome"),
            mode=hud.get("mode"),
            targetable_cells=hud.get("targetableCells", []),
            action_targeting=hud.get("actionTargeting", {}),
            dialogue_options=hud.get("dialogueOptions", []),
            items=hud.get("items", []),
            pois=hud.get("pois", []),
            talking_to=hud.get("talkingTo"),
            dialogue_speaker=hud.get("dialogueSpeaker"),
            dialogue_emotion=hud.get("dialogueEmotion"),
        )

    @property
    def legal_action_ids(self) -> list[str]:
        return [a["id"] for a in self.actions]

    @property
    def done(self) -> bool:
        return self.status != "playing"


class ArenaClient:
    def __init__(
        self,
        base_url: str = "http://localhost:8899",
        api_key: str | None = None,
        timeout: float | None = 30.0,
        max_response_bytes: int = 1024 * 1024,
    ):
        if timeout is not None and (
            isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or timeout <= 0
        ):
            raise ValueError("timeout must be a positive finite number or None")
        if (
            isinstance(max_response_bytes, bool)
            or not isinstance(max_response_bytes, int)
            or max_response_bytes < 1
        ):
            raise ValueError("max_response_bytes must be a positive integer")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self._bindings: dict[str, dict[str, Any]] = {}
        self._observed_arena_cursors: dict[str, dict[str, Any]] = {}

    def _remember(self, result: dict[str, Any], participant_id: str | None = None) -> None:
        previous = self._bindings.get(result["sessionId"], {})
        binding = {
            "protocol": PROTOCOL_ID,
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": result["sessionId"],
            "tickId": result["tickId"],
            "revision": result["revision"],
            "participantId": participant_id or previous.get("participantId", "player"),
        }
        tick = result.get("tick")
        control_revision = tick.get("controlRevision") if isinstance(tick, dict) else None
        if (
            isinstance(control_revision, int)
            and not isinstance(control_revision, bool)
            and 0 <= control_revision <= _MAX_SAFE_INTEGER
        ):
            binding["controlRevision"] = control_revision
        self._bindings[result["sessionId"]] = binding
        self._observed_arena_cursors.pop(result["sessionId"], None)

    def get_session_binding(self, session_id: str) -> dict[str, Any] | None:
        """Return a JSON-safe snapshot for persistence across process restarts."""
        binding = self._bindings.get(session_id)
        return dict(binding) if binding is not None else None

    def restore_session_binding(self, value: Any) -> dict[str, Any]:
        """Restore a persisted binding before issuing an exact retry."""
        binding = parse_session_binding(value)
        self._bindings[binding["sessionId"]] = binding
        self._observed_arena_cursors.pop(binding["sessionId"], None)
        return dict(binding)

    def _read_body(self, response: Any) -> bytes:
        raw = response.read(self.max_response_bytes + 1)
        if len(raw) > self.max_response_bytes:
            raise ProtocolMismatchError(
                f"HTTP response exceeds {self.max_response_bytes} bytes"
            )
        return raw

    def _call(self, method: str, path: str, body: dict | None = None) -> Any:
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(
            self.base_url + path,
            method=method,
            data=_json_dumps(body, "request body").encode() if body is not None else None,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw_body = self._read_body(resp)
                return _json_loads(raw_body, "successful HTTP response")
        except urllib.error.HTTPError as e:
            try:
                raw_body = self._read_body(e).decode("utf-8", errors="replace")
            except ProtocolMismatchError:
                raise ArenaAPIError(
                    e.code,
                    f"HTTP error response exceeds {self.max_response_bytes} bytes",
                ) from None
            try:
                payload = _json_loads(raw_body, "HTTP error response")
                error = payload.get("error", str(e))
                code = payload.get("code") if isinstance(payload.get("code"), str) else None
            except Exception:
                error = raw_body.strip() or str(e)
                code = None
            if e.code == 422:
                raise IllegalActionRejected(e.code, error, code, raw_body) from None
            raise ArenaAPIError(e.code, error, code, raw_body) from None

    def create_session(
        self,
        level_id: str | None = None,
        game_mode: str = "challenge",
        play_method: str = "autonomous_scored",
        season_id: str | None = None,
        game_id: str | None = None,
        community_level_id: str | None = None,
        participants: list[str] | None = None,
    ) -> tuple[str, Tick]:
        """Open a session.

        Per-level sessions (human/coach/autonomous_local practice) pass
        ``level_id``. A Challenge ``autonomous_scored`` submission passes
        ``game_id`` instead: the run spans that game type's FULL scored level
        set as one session (watch for ``level_advance`` visual events as the
        board rolls level-to-level).
        """
        body: dict[str, Any] = {
            "gameMode": game_mode,
            "playMethod": play_method,
        }
        if level_id:
            body["levelId"] = level_id
        if community_level_id:
            body["communityLevelId"] = community_level_id
        if game_id:
            body["gameId"] = game_id
        if season_id:
            body["seasonId"] = season_id
        if participants is not None:
            body["participants"] = participants
        result = parse_tick_result(self._call("POST", "/v1/sessions", body))
        if result["kind"] != "tick":
            raise ProtocolMismatchError("new session must start resolved")
        self._remember(result)
        return result["sessionId"], Tick.from_json(result["tick"])

    def get_tick_envelope(self, session_id: str) -> dict[str, Any]:
        result = parse_tick_result(self._call("GET", f"/v1/sessions/{_quote(session_id)}/tick"))
        if result["sessionId"] != session_id:
            raise ProtocolMismatchError("response session does not match request")
        self._remember(result)
        return result

    def get_tick(self, session_id: str) -> Tick:
        return Tick.from_json(self.get_tick_envelope(session_id)["tick"])

    def submit_intent(
        self,
        session_id: str,
        command: Any,
        participant_id: str | None = None,
        submission_id: str | None = None,
        cursor: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._submit_intent_to(
            f"/v1/sessions/{_quote(session_id)}/actions",
            session_id,
            command,
            participant_id,
            submission_id,
            cursor=cursor,
        )

    def _submit_intent_to(
        self,
        path: str,
        session_id: str,
        command: Any,
        participant_id: str | None = None,
        submission_id: str | None = None,
        control_revision: int | None = None,
        cursor: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        binding = self._bindings.get(session_id)
        if binding is None and cursor is None:
            if submission_id is not None:
                raise ProtocolMismatchError(
                    "explicit submission_id requires the original cursor or a restored session binding"
                )
            self.get_tick_envelope(session_id)
            binding = self._bindings[session_id]
        selected = cursor or binding
        if not isinstance(selected, dict):
            raise ProtocolMismatchError("session cursor unavailable")
        tick_id = selected.get("tickId")
        revision = selected.get("revision")
        if (
            not isinstance(tick_id, str) or not tick_id.strip()
            or not isinstance(revision, int) or isinstance(revision, bool)
            or revision < 0 or revision > _MAX_SAFE_INTEGER
        ):
            raise ProtocolMismatchError("session cursor is invalid")
        participant = participant_id or (binding or {}).get("participantId", "player")
        _validate_json(command, "command")
        body = {
            "protocol": PROTOCOL_ID,
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session_id,
            "tickId": tick_id,
            "revision": revision,
            "participantId": participant,
            "command": command,
        }
        # Stable across an application retry after an ambiguous network error.
        body["submissionId"] = submission_id or f"{participant}:{tick_id}"
        if control_revision is not None:
            body["extensions"] = {
                ARENA_CONTROL_EXTENSION: {"controlRevision": control_revision}
            }
        result = parse_tick_result(
            self._call("POST", path, body)
        )
        if result["sessionId"] != session_id:
            raise ProtocolMismatchError("response session does not match request")
        self._remember(result, participant)
        return result

    # ------------------------------------------------ hosted Arena mode

    def arena_catalog(self) -> dict[str, Any]:
        """Return the host's stable map summaries and game-owned team presets."""
        return self._call("GET", "/v1/arena/maps")

    def join_arena_queue(
        self,
        map_id: str,
        team_id: str,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Join live matchmaking. Reuse request_id after an ambiguous retry."""
        return self._call("POST", "/v1/arena/matchmaking", {
            "mapId": map_id,
            "teamId": team_id,
            "requestId": request_id or str(uuid.uuid4()),
        })

    def arena_queue_ticket(self, queue_id: str, ticket_id: str) -> dict[str, Any]:
        return self._call("GET", f"/v1/arena/matchmaking/{_quote(queue_id)}/{_quote(ticket_id)}")

    def cancel_arena_queue_ticket(self, queue_id: str, ticket_id: str) -> dict[str, Any]:
        return self._call("DELETE", f"/v1/arena/matchmaking/{_quote(queue_id)}/{_quote(ticket_id)}")

    def _parse_arena_room(self, data: Any, match_id: str) -> dict[str, Any]:
        if not isinstance(data, dict):
            raise ProtocolMismatchError("Arena room is not an object")
        if data.get("sessionId") != match_id or data.get("matchId") != match_id:
            raise ProtocolMismatchError("Arena room does not match request")
        participant = data.get("participantId")
        if not isinstance(participant, str) or _PARTICIPANT_ID_RE.fullmatch(participant) is None:
            raise ProtocolMismatchError("Arena room participant missing")
        participants = data.get("participants")
        participant_ids = {
            item.get("participantId")
            for item in participants
            if isinstance(item, dict) and isinstance(item.get("participantId"), str)
        } if isinstance(participants, list) else set()
        if (
            data.get("status") not in _ARENA_ROOM_STATUSES
            or not _is_finite_number(data.get("readyDeadline"))
            or not _is_nullable_finite_number(data.get("tickDeadline"))
            or not _is_nullable_finite_number(data.get("expiresAt"))
            or not isinstance(participants, list)
            or not all(_is_arena_participant(item) for item in participants)
            or len({item["participantId"] for item in participants}) != len(participants)
            or participant not in participant_ids
            or not _is_arena_outcome(data.get("outcome"), participant_ids)
        ):
            raise ProtocolMismatchError("Arena room fields are invalid")
        tick = parse_tick_result(data.get("tick"))
        if tick["sessionId"] != match_id:
            raise ProtocolMismatchError("Arena room tick does not match request")
        self._remember(tick, participant)
        return {**data, "tick": tick}

    def get_arena_room(self, match_id: str) -> dict[str, Any]:
        """Read-only room snapshot; does not claim or heartbeat the seat."""
        return self._parse_arena_room(
            self._call("GET", f"/v1/arena/matches/{_quote(match_id)}"),
            match_id,
        )

    def set_arena_presence(self, match_id: str, connected: bool) -> dict[str, Any]:
        return self._parse_arena_room(
            self._call(
                "POST",
                f"/v1/arena/matches/{_quote(match_id)}/presence",
                {"connected": connected},
            ),
            match_id,
        )

    def heartbeat_arena_match(self, match_id: str) -> dict[str, Any]:
        return self.set_arena_presence(match_id, True)

    def connect_arena_match(self, match_id: str) -> dict[str, Any]:
        """Claim a matched seat; the second claim starts the tick timers."""
        return self.set_arena_presence(match_id, True)

    def disconnect_arena_match(self, match_id: str) -> dict[str, Any]:
        return self.set_arena_presence(match_id, False)

    def get_arena_tick_envelope(self, match_id: str) -> dict[str, Any]:
        result = parse_tick_result(
            self._call("GET", f"/v1/arena/matches/{_quote(match_id)}/tick")
        )
        if result["sessionId"] != match_id:
            raise ProtocolMismatchError("response session does not match request")
        binding = self._bindings.get(match_id)
        # Tick envelopes intentionally omit authenticated seat identity. Avoid
        # inventing the ordinary solo `player` seat when callers poll first;
        # submit_arena_intent will recover the real room binding on demand.
        if binding is not None:
            self._remember(result, binding["participantId"])
        else:
            tick = result.get("tick")
            control_revision = tick.get("controlRevision") if isinstance(tick, dict) else None
            self._observed_arena_cursors[match_id] = {
                "tickId": result["tickId"],
                "revision": result["revision"],
                **(
                    {"controlRevision": control_revision}
                    if isinstance(control_revision, int) and not isinstance(control_revision, bool)
                    and 0 <= control_revision <= _MAX_SAFE_INTEGER else {}
                ),
            }
        return result

    def submit_arena_intent(
        self,
        match_id: str,
        command: Any,
        submission_id: str | None = None,
        control_revision: int | None = None,
    ) -> dict[str, Any]:
        binding = self._bindings.get(match_id)
        original_cursor = (
            self._observed_arena_cursors.get(match_id)
            if submission_id is not None else None
        )
        if binding is None:
            if submission_id is not None and original_cursor is None:
                raise ProtocolMismatchError(
                    "explicit submission_id requires the original cursor or a restored Arena session binding"
                )
            self.get_arena_room(match_id)
            binding = self._bindings[match_id]
        expected_control_revision = (
            control_revision
            if control_revision is not None
            else (original_cursor or {}).get(
                "controlRevision", binding.get("controlRevision")
            )
        )
        if (
            not isinstance(expected_control_revision, int)
            or isinstance(expected_control_revision, bool)
            or expected_control_revision < 0
            or expected_control_revision > _MAX_SAFE_INTEGER
        ):
            raise ProtocolMismatchError("Arena controlRevision unavailable")
        participant = binding["participantId"]
        return self._submit_intent_to(
            f"/v1/arena/matches/{_quote(match_id)}/actions",
            match_id,
            command,
            participant,
            submission_id
            or f"{participant}:{binding['tickId']}:control:{expected_control_revision}",
            expected_control_revision,
            cursor=original_cursor,
        )

    def submit_action(
        self,
        session_id: str,
        action_id: str,
        x: int | None = None,
        y: int | None = None,
        index: int | None = None,
        participant_id: str | None = None,
        submission_id: str | None = None,
        poll_interval: float = 0.25,
        max_poll_attempts: int = 120,
    ) -> Tick:
        body: dict[str, Any] = {"id": action_id}
        if x is not None:
            body["x"] = x
        if y is not None:
            body["y"] = y
        if index is not None:
            body["index"] = index
        result = self.submit_intent(
            session_id,
            body,
            participant_id=participant_id,
            submission_id=submission_id,
        )
        if result["kind"] == "tick":
            return Tick.from_json(result["tick"])
        pending_revision = result["revision"]
        for _ in range(max_poll_attempts):
            time.sleep(poll_interval)
            polled = self.get_tick_envelope(session_id)
            if polled["kind"] == "tick" and polled["revision"] > pending_revision:
                return Tick.from_json(polled["tick"])
        raise ArenaAPIError(408, f"timed out waiting after {max_poll_attempts} polls")

    def submit_session(self, session_id: str, harness_category: str | None = None) -> dict:
        body = {"harnessCategory": harness_category} if harness_category else {}
        return self._call("POST", f"/v1/sessions/{_quote(session_id)}/submit", body)

    def lab_level_versions(self) -> list[dict]:
        return self._call("GET", "/levels/lab/versions")  # type: ignore[return-value]

    def report_unpaid_challenge(self, game_id: str, stars: int, steps: int) -> dict:
        """Self-report an unpaid Challenge claim (authenticated, stored unverified)."""
        return self._call(
            "POST",
            "/leaderboards/challenge/unpaid",
            {"gameId": game_id, "stars": stars, "steps": steps},
        )

    def challenge_boards(self, game_id: str) -> dict:
        return self._call("GET", f"/leaderboards/challenge/{_quote(game_id)}")


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _is_nullable_finite_number(value: Any) -> bool:
    return value is None or _is_finite_number(value)


def _is_arena_participant(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("participantId"), str)
        and _PARTICIPANT_ID_RE.fullmatch(value["participantId"]) is not None
        and isinstance(value.get("claimed"), bool)
        and isinstance(value.get("connected"), bool)
        and _is_nullable_finite_number(value.get("reconnectDeadline"))
    )


def _is_arena_outcome(value: Any, participant_ids: set[Any]) -> bool:
    if value is None:
        return True
    return (
        isinstance(value, dict)
        and (value.get("winner") is None or (
            isinstance(value.get("winner"), str)
            and value.get("winner") in participant_ids
        ))
        and (value.get("loser") is None or (
            isinstance(value.get("loser"), str)
            and value.get("loser") in participant_ids
        ))
        and value.get("reason") in _ARENA_OUTCOME_REASONS
        and ("gameReason" not in value or isinstance(value.get("gameReason"), str))
    )


class AsyncArenaClient:
    """Async facade over the dependency-free synchronous client.

    Requests run in worker threads so asyncio applications do not block their
    event loop. The synchronous client remains available as ``sync_client``.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8899",
        api_key: str | None = None,
        timeout: float | None = 30.0,
        max_response_bytes: int = 1024 * 1024,
    ):
        self.sync_client = ArenaClient(
            base_url,
            api_key,
            timeout,
            max_response_bytes,
        )
        self._lock = asyncio.Lock()

    async def _run(self, name: str, *args: Any, **kwargs: Any) -> Any:
        async with self._lock:
            worker = asyncio.create_task(asyncio.to_thread(
                getattr(self.sync_client, name), *args, **kwargs
            ))
            try:
                return await asyncio.shield(worker)
            except asyncio.CancelledError:
                try:
                    await worker
                except Exception:
                    pass
                raise

    async def create_session(self, *args: Any, **kwargs: Any) -> tuple[str, Tick]:
        return await self._run("create_session", *args, **kwargs)

    async def get_tick_envelope(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("get_tick_envelope", *args, **kwargs)

    async def get_tick(self, *args: Any, **kwargs: Any) -> Tick:
        return await self._run("get_tick", *args, **kwargs)

    async def submit_intent(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("submit_intent", *args, **kwargs)

    async def arena_catalog(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("arena_catalog", *args, **kwargs)

    async def join_arena_queue(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("join_arena_queue", *args, **kwargs)

    async def arena_queue_ticket(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("arena_queue_ticket", *args, **kwargs)

    async def cancel_arena_queue_ticket(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("cancel_arena_queue_ticket", *args, **kwargs)

    async def get_arena_room(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("get_arena_room", *args, **kwargs)

    async def connect_arena_match(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("connect_arena_match", *args, **kwargs)

    async def set_arena_presence(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("set_arena_presence", *args, **kwargs)

    async def heartbeat_arena_match(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("heartbeat_arena_match", *args, **kwargs)

    async def disconnect_arena_match(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("disconnect_arena_match", *args, **kwargs)

    async def get_arena_tick_envelope(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("get_arena_tick_envelope", *args, **kwargs)

    async def submit_arena_intent(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("submit_arena_intent", *args, **kwargs)

    async def submit_action(self, *args: Any, **kwargs: Any) -> Tick:
        return await self._run("submit_action", *args, **kwargs)

    async def submit_session(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("submit_session", *args, **kwargs)
