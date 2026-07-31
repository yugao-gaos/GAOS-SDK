"""Product-neutral HTTP client for hosts implementing GAOS Ticks v1."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .replay import canonical_json

PROTOCOL_ID = "gaos.ticks"
PROTOCOL_VERSION = "1.0"
PARTICIPANT_ID_PATTERN = r"^[A-Za-z0-9_.:@-]{1,128}$"
_PARTICIPANT_ID_RE = re.compile(PARTICIPANT_ID_PATTERN)
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_FINITE_NUMBER = float.fromhex("0x1.fffffffffffffp+1023")


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


class GaosAPIError(Exception):
    """Non-2xx response from a GAOS host."""

    def __init__(
        self,
        status: int,
        error: str,
        code: str | None = None,
        body: str | None = None,
    ):
        super().__init__(f"HTTP {status}: {error}")
        self.status = status
        self.error = error
        self.code = code
        self.body = body


class IllegalActionRejected(GaosAPIError):
    """422 — the command was not legal for this tick."""


class ProtocolMismatchError(Exception):
    """Response is not a valid GAOS Ticks v1 envelope."""


def _validate_json(
    value: Any,
    label: str = "value",
    active: set[int] | None = None,
) -> None:
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
                    raise ProtocolMismatchError(
                        f"{label} object keys must be strings"
                    )
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


def _is_participant_list(value: Any) -> bool:
    return isinstance(value, list) and all(
        isinstance(participant_id, str)
        and _PARTICIPANT_ID_RE.fullmatch(participant_id) is not None
        for participant_id in value
    )


def parse_session_binding(value: Any) -> dict[str, Any]:
    """Validate a JSON-safe persisted cursor and participant binding."""
    if not isinstance(value, dict):
        raise ProtocolMismatchError("session binding must be an object")
    if (
        value.get("protocol") != PROTOCOL_ID
        or value.get("protocolVersion") != PROTOCOL_VERSION
    ):
        raise ProtocolMismatchError(
            f"session binding must use {PROTOCOL_ID} {PROTOCOL_VERSION}"
        )
    revision = value.get("revision")
    participant = value.get("participantId")
    if (
        not isinstance(value.get("sessionId"), str)
        or not value["sessionId"].strip()
        or not isinstance(value.get("tickId"), str)
        or not value["tickId"].strip()
        or not isinstance(revision, int)
        or isinstance(revision, bool)
        or revision < 0
        or revision > _MAX_SAFE_INTEGER
        or not isinstance(participant, str)
        or _PARTICIPANT_ID_RE.fullmatch(participant) is None
    ):
        raise ProtocolMismatchError("session binding cursor or participant is invalid")
    return {
        "protocol": PROTOCOL_ID,
        "protocolVersion": PROTOCOL_VERSION,
        "sessionId": value["sessionId"],
        "tickId": value["tickId"],
        "revision": revision,
        "participantId": participant,
    }


def parse_tick_result(data: Any) -> dict[str, Any]:
    """Validate the product-neutral envelope without inspecting the observation."""
    if not isinstance(data, dict):
        raise ProtocolMismatchError("response is not an object")
    if (
        data.get("protocol") != PROTOCOL_ID
        or data.get("protocolVersion") != PROTOCOL_VERSION
    ):
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
        or revision > _MAX_SAFE_INTEGER
        or "tick" not in data
    ):
        raise ProtocolMismatchError("response revision/tick missing")
    _validate_json(data["tick"], "response tick")
    if data["kind"] == "pending":
        submitted = data.get("submittedParticipants")
        awaiting = data.get("awaitingParticipants")
        if not _is_participant_list(submitted) or not _is_participant_list(awaiting):
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
            raise ProtocolMismatchError(
                "pending acceptedParticipantId must be submitted"
            )
    if "extensions" in data:
        if not isinstance(data["extensions"], dict):
            raise ProtocolMismatchError(
                "response extensions must be a plain JSON object"
            )
        _validate_json(data["extensions"], "response extensions")
    return data


def session_attach_receipt_digest(receipt: dict[str, Any]) -> str:
    """Digest a canonical receipt object that omits ``receiptDigest``."""
    _validate_json(receipt, "session attach receipt")
    if "receiptDigest" in receipt:
        raise ProtocolMismatchError(
            "unsigned session attach receipt must omit receiptDigest"
        )
    return hashlib.sha256(canonical_json(receipt).encode()).hexdigest()


def create_session_attach_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    """Construct a portable ``gaos.session-attach-receipt.v1`` receipt."""
    unsigned = {
        "schema": "gaos.session-attach-receipt.v1",
        **receipt,
    }
    unsigned.pop("receiptDigest", None)
    return {
        **unsigned,
        "receiptDigest": session_attach_receipt_digest(unsigned),
    }


def verify_session_attach_receipt_chain(
    receipts: list[dict[str, Any]],
) -> dict[str, Any]:
    """Verify canonical contents, revision monotonicity, and digest links."""
    problems: list[str] = []
    previous: dict[str, Any] | None = None
    for index, receipt in enumerate(receipts):
        sequence = receipt.get("sequence")
        revision = receipt.get("revision")
        if receipt.get("schema") != "gaos.session-attach-receipt.v1":
            problems.append(f"receipt {index} has an unsupported schema")
            continue
        if (
            not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or sequence < 0
            or sequence > _MAX_SAFE_INTEGER
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 0
            or revision > _MAX_SAFE_INTEGER
        ):
            problems.append(f"receipt {index} sequence or revision is invalid")
        for field in (
            "sessionId",
            "requestId",
            "transcriptDigest",
            "stateDigest",
            "receiptDigest",
        ):
            if (
                not isinstance(receipt.get(field), str)
                or not receipt[field].strip()
            ):
                problems.append(f"receipt {index} {field} is invalid")
        unsigned = {key: value for key, value in receipt.items()
                    if key != "receiptDigest"}
        try:
            digest = session_attach_receipt_digest(unsigned)
        except (ProtocolMismatchError, TypeError):
            problems.append(f"receipt {index} is not canonical JSON")
            digest = None
        if digest is not None and digest != receipt.get("receiptDigest"):
            problems.append(f"receipt {index} digest does not match its contents")
        if previous is None:
            if "previousReceiptDigest" in receipt:
                problems.append(
                    "first receipt unexpectedly links to an omitted predecessor"
                )
        else:
            if receipt.get("sessionId") != previous.get("sessionId"):
                problems.append(f"receipt {index} changes session identity")
            previous_sequence = previous.get("sequence")
            if (
                not isinstance(previous_sequence, int)
                or sequence != previous_sequence + 1
            ):
                problems.append(f"receipt {index} sequence is not contiguous")
            if (
                not isinstance(revision, int)
                or not isinstance(previous.get("revision"), int)
                or revision < previous["revision"]
            ):
                problems.append(f"receipt {index} rolls revision backward")
            if (
                receipt.get("previousReceiptDigest")
                != previous.get("receiptDigest")
            ):
                problems.append(
                    f"receipt {index} does not link to the previous receipt"
                )
        previous = receipt
    return {"valid": not problems, "problems": problems}


def parse_session_attach(
    data: Any,
    requested_session_id: str | None = None,
) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ProtocolMismatchError("session attachment must be an object")
    session_id = data.get("sessionId")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ProtocolMismatchError(
            "attachment sessionId must be a non-empty string"
        )
    if requested_session_id is not None and session_id != requested_session_id:
        raise ProtocolMismatchError("attachment session does not match request")
    if "tick" not in data:
        raise ProtocolMismatchError("attachment tick missing")
    _validate_json(data["tick"], "attachment tick")
    binding = parse_session_binding(data.get("binding"))
    if binding["sessionId"] != session_id:
        raise ProtocolMismatchError(
            "attachment binding does not match session"
        )
    receipt = data.get("receipt")
    if receipt is not None:
        if not isinstance(receipt, dict):
            raise ProtocolMismatchError("attach receipt must be an object")
        checked = verify_session_attach_receipt_chain([receipt])
        if not checked["valid"]:
            raise ProtocolMismatchError(checked["problems"][0])
    _validate_json(data, "session attachment")
    return data


def parse_session_result(
    data: Any,
    requested_session_id: str | None = None,
) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ProtocolMismatchError("session result must be an object")
    session_id = data.get("sessionId")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ProtocolMismatchError("result sessionId must be a non-empty string")
    if requested_session_id is not None and session_id != requested_session_id:
        raise ProtocolMismatchError("result session does not match request")
    if data.get("status") != "finalized" or "outcome" not in data:
        raise ProtocolMismatchError(
            "session result must be finalized with an outcome"
        )
    _validate_json(data, "session result")
    return data


class SessionClient:
    """Product-neutral client for the GAOS ``/v1/sessions`` contract."""

    def __init__(
        self,
        base_url: str = "http://localhost:8899",
        api_key: str | None = None,
        timeout: float | None = 30.0,
        max_response_bytes: int = 1024 * 1024,
    ):
        if timeout is not None and (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
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

    def _remember(
        self,
        result: dict[str, Any],
        participant_id: str | None = None,
    ) -> None:
        previous = self._bindings.get(result["sessionId"], {})
        self._bindings[result["sessionId"]] = {
            "protocol": PROTOCOL_ID,
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": result["sessionId"],
            "tickId": result["tickId"],
            "revision": result["revision"],
            "participantId": participant_id
            or previous.get("participantId", "player"),
        }

    def get_session_binding(self, session_id: str) -> dict[str, Any] | None:
        binding = self._bindings.get(session_id)
        return dict(binding) if binding is not None else None

    def restore_session_binding(self, value: Any) -> dict[str, Any]:
        binding = parse_session_binding(value)
        self._bindings[binding["sessionId"]] = binding
        return dict(binding)

    def _read_body(self, response: Any) -> bytes:
        raw = response.read(self.max_response_bytes + 1)
        if len(raw) > self.max_response_bytes:
            raise ProtocolMismatchError(
                f"HTTP response exceeds {self.max_response_bytes} bytes"
            )
        return raw

    def _call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> Any:
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(
            self.base_url + path,
            method=method,
            data=(
                _json_dumps(body, "request body").encode()
                if body is not None
                else None
            ),
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return _json_loads(
                    self._read_body(response),
                    "successful HTTP response",
                )
        except urllib.error.HTTPError as error_response:
            try:
                raw_body = self._read_body(error_response).decode(
                    "utf-8",
                    errors="replace",
                )
            except ProtocolMismatchError:
                raise GaosAPIError(
                    error_response.code,
                    f"HTTP error response exceeds {self.max_response_bytes} bytes",
                ) from None
            try:
                payload = _json_loads(raw_body, "HTTP error response")
                message = payload.get("error", str(error_response))
                code = (
                    payload.get("code")
                    if isinstance(payload.get("code"), str)
                    else None
                )
            except Exception:
                message = raw_body.strip() or str(error_response)
                code = None
            if error_response.code == 422:
                raise IllegalActionRejected(
                    error_response.code,
                    message,
                    code,
                    raw_body,
                ) from None
            raise GaosAPIError(
                error_response.code,
                message,
                code,
                raw_body,
            ) from None

    def create_session(
        self,
        request: dict[str, Any],
        participant_id: str = "player",
    ) -> dict[str, Any]:
        _validate_json(request, "session request")
        result = parse_tick_result(
            self._call("POST", "/v1/sessions", request)
        )
        if result["kind"] != "tick":
            raise ProtocolMismatchError("new session must start resolved")
        self._remember(result, participant_id)
        return result

    def get_tick_envelope(self, session_id: str) -> dict[str, Any]:
        result = parse_tick_result(
            self._call(
                "GET",
                f"/v1/sessions/{_quote(session_id)}/tick",
            )
        )
        if result["sessionId"] != session_id:
            raise ProtocolMismatchError("response session does not match request")
        self._remember(result)
        return result

    def attach_session(
        self,
        session_id: str,
        request: dict[str, Any],
    ) -> dict[str, Any]:
        request_id = request.get("requestId")
        if not isinstance(request_id, str) or not request_id.strip():
            raise ProtocolMismatchError(
                "attach requestId must be a non-empty string"
            )
        _validate_json(request, "attach request")
        attachment = parse_session_attach(
            self._call(
                "POST",
                f"/v1/sessions/{_quote(session_id)}/attach",
                request,
            ),
            session_id,
        )
        binding = parse_session_binding(attachment["binding"])
        requested_participant = request.get(
            "participantId",
            binding["participantId"],
        )
        if requested_participant != binding["participantId"]:
            raise ProtocolMismatchError(
                "attachment participant does not match request"
            )
        receipt = attachment.get("receipt")
        if receipt is not None and receipt.get("requestId") != request_id:
            raise ProtocolMismatchError(
                "attachment receipt does not match request"
            )
        self._bindings[session_id] = binding
        return attachment

    def finalize_session(
        self,
        session_id: str,
        request: dict[str, Any],
    ) -> dict[str, Any]:
        request_id = request.get("requestId")
        if not isinstance(request_id, str) or not request_id.strip():
            raise ProtocolMismatchError(
                "finalization requestId must be a non-empty string"
            )
        _validate_json(request, "finalization request")
        return parse_session_result(
            self._call(
                "POST",
                f"/v1/sessions/{_quote(session_id)}/finalize",
                request,
            ),
            session_id,
        )

    def submit_intent(
        self,
        session_id: str,
        command: Any,
        participant_id: str | None = None,
        submission_id: str | None = None,
        cursor: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        binding = self._bindings.get(session_id)
        if binding is None and cursor is None:
            if submission_id is not None:
                raise ProtocolMismatchError(
                    "explicit submission_id requires the original cursor "
                    "or a restored session binding"
                )
            self.get_tick_envelope(session_id)
            binding = self._bindings[session_id]
        selected = cursor or binding
        if not isinstance(selected, dict):
            raise ProtocolMismatchError("session cursor unavailable")
        tick_id = selected.get("tickId")
        revision = selected.get("revision")
        if (
            not isinstance(tick_id, str)
            or not tick_id.strip()
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 0
            or revision > _MAX_SAFE_INTEGER
        ):
            raise ProtocolMismatchError("session cursor is invalid")
        participant = participant_id or (binding or {}).get(
            "participantId",
            "player",
        )
        _validate_json(command, "command")
        body = {
            "protocol": PROTOCOL_ID,
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session_id,
            "tickId": tick_id,
            "revision": revision,
            "participantId": participant,
            "submissionId": submission_id or f"{participant}:{tick_id}",
            "command": command,
        }
        result = parse_tick_result(
            self._call(
                "POST",
                f"/v1/sessions/{_quote(session_id)}/actions",
                body,
            )
        )
        if result["sessionId"] != session_id:
            raise ProtocolMismatchError("response session does not match request")
        self._remember(result, participant)
        return result


class AsyncSessionClient:
    """Serialized async facade over the dependency-free synchronous client."""

    def __init__(
        self,
        base_url: str = "http://localhost:8899",
        api_key: str | None = None,
        timeout: float | None = 30.0,
        max_response_bytes: int = 1024 * 1024,
    ):
        self.sync_client = SessionClient(
            base_url,
            api_key,
            timeout,
            max_response_bytes,
        )
        self._lock = asyncio.Lock()

    async def _run(self, name: str, *args: Any, **kwargs: Any) -> Any:
        async with self._lock:
            worker = asyncio.create_task(
                asyncio.to_thread(
                    getattr(self.sync_client, name),
                    *args,
                    **kwargs,
                )
            )
            try:
                return await asyncio.shield(worker)
            except asyncio.CancelledError:
                try:
                    await worker
                except Exception:
                    pass
                raise

    async def create_session(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("create_session", *args, **kwargs)

    async def get_tick_envelope(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._run("get_tick_envelope", *args, **kwargs)

    async def attach_session(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("attach_session", *args, **kwargs)

    async def finalize_session(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("finalize_session", *args, **kwargs)

    async def submit_intent(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await self._run("submit_intent", *args, **kwargs)
