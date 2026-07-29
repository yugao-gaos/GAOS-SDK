"""Portable ``gaos.replay`` v1 JSONL parsing, validation, and serialization."""

from __future__ import annotations

import json
import math
import re
from typing import Any

from .signatures import (
    SUBMISSION_SIGNATURE_SCHEME,
    periodic_signature_preimage_v1,
    signature_bytes_from_base64,
    submission_chain_hash_v1,
    submission_genesis_hash_v1,
    submission_preimage_v1,
    submission_roster_hash_v1,
    verify_ed25519_base64,
)

GAOS_REPLAY_FORMAT_ID = "gaos.replay"
GAOS_REPLAY_FORMAT_VERSION = "1.3"
GAOS_REPLAY_SIGNED_FORMAT_VERSION = "1.2"
GAOS_REPLAY_UNSIGNED_FORMAT_VERSION = "1.1"
GAOS_REPLAY_LEGACY_FORMAT_VERSION = "1.0"
GAOS_REPLAY_MIME = "application/vnd.gaos.replay+jsonl"
GAOS_REPLAY_EXTENSION = "gaos-replay.jsonl"
GAOS_REPLAY_DERIVED_SEEDS = "gaos.run-level-seed.v1"
GAOS_TIMEOUT_POLICY_REF = "header.timeoutPolicy"
GAOS_REPLAY_MANIFEST_FORMAT = {
    "mime": GAOS_REPLAY_MIME,
    "extension": GAOS_REPLAY_EXTENSION,
    "compressed": False,
}

_ACTION_ID = re.compile(r"^Action ([1-9][0-9]*)$")
_LOWER_HASH = re.compile(r"^[0-9a-f]{64}$")
_LOWER_SALT = re.compile(r"^(?:[0-9a-f]{2}){16,64}$")
_COMMITMENT_SCHEME = "gaos.commit.sha256.v1"
_U32_MAX = 0xFFFF_FFFF
_SAFE_INTEGER_MAX = (1 << 53) - 1


class ReplayFormatError(ValueError):
    """Raised when a portable replay fails transport-level validation."""

    def __init__(self, problems: list[str]):
        self.problems = tuple(problems)
        super().__init__(
            f"invalid {GAOS_REPLAY_FORMAT_ID} {GAOS_REPLAY_FORMAT_VERSION} artifact: "
            + "; ".join(problems)
        )


def run_level_seed(session_seed: int | float, level_index: int | float) -> int:
    """Match the TypeScript SDK's unsigned 32-bit per-level seed derivation."""

    if not _is_int(session_seed) or not _is_int(level_index):
        raise TypeError("session_seed and level_index must be integer numbers")
    return (int(session_seed) ^ (0x9E3779B9 * (int(level_index) + 1))) & _U32_MAX


def _is_int(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and (not isinstance(value, float) or (math.isfinite(value) and value.is_integer()))
    )


def _valid_safe_integer(value: Any) -> bool:
    return _is_int(value) and -_SAFE_INTEGER_MAX <= value <= _SAFE_INTEGER_MAX


def _valid_non_negative_integer(value: Any) -> bool:
    return _valid_safe_integer(value) and value >= 0


def _valid_u32(value: Any) -> bool:
    return _is_int(value) and 0 <= value <= _U32_MAX


def _is_grouped_version(value: Any) -> bool:
    return value in (
        GAOS_REPLAY_UNSIGNED_FORMAT_VERSION,
        GAOS_REPLAY_SIGNED_FORMAT_VERSION,
        GAOS_REPLAY_FORMAT_VERSION,
    )

def _has_v12_integrity_semantics(value: Any) -> bool:
    return value in (
        GAOS_REPLAY_SIGNED_FORMAT_VERSION,
        GAOS_REPLAY_FORMAT_VERSION,
    )


def _validate_v12_integrity_fields(
    candidate: dict[str, Any],
    label: str,
) -> list[str]:
    problems: list[str] = []
    identity = (
        "submissionId",
        "canonicalCommand",
        "cursor",
    )
    chain = (
        "clientTime",
        "prevChainHash",
    )
    identity_present = [field for field in identity if field in candidate]
    chain_present = [field for field in chain if field in candidate]
    if len(identity_present) not in (0, len(identity)):
        problems.append(
            f"{label} must carry every submission identity field or none"
        )
    if len(chain_present) not in (0, len(chain)):
        problems.append(
            f"{label} must carry both clientTime and prevChainHash or neither"
        )
    if chain_present and len(identity_present) != len(identity):
        problems.append(
            f"{label} chain fields require every submission identity field"
        )
    if "sig" in candidate and (
        len(identity_present) != len(identity)
        or len(chain_present) != len(chain)
    ):
        problems.append(
            f"{label} sig requires every submission and chain field"
        )
    if len(identity_present) == len(identity):
        if (
            not isinstance(candidate["submissionId"], str)
            or not candidate["submissionId"]
        ):
            problems.append(f"{label} submissionId must be a non-empty string")
        if not _valid_non_negative_integer(candidate["cursor"]):
            problems.append(f"{label} cursor must be a non-negative safe integer")
        canonical = candidate["canonicalCommand"]
        if not isinstance(canonical, str):
            problems.append(f"{label} canonicalCommand must be canonical JSON text")
        else:
            try:
                if canonical_json(json.loads(canonical)) != canonical:
                    problems.append(
                        f"{label} canonicalCommand must use canonical JSON bytes"
                    )
            except (TypeError, ValueError, json.JSONDecodeError):
                problems.append(
                    f"{label} canonicalCommand must be valid canonical JSON"
                )
    if len(chain_present) == len(chain):
        if not _valid_non_negative_integer(candidate["clientTime"]):
            problems.append(
                f"{label} clientTime must be a non-negative safe integer"
            )
        try:
            signature_bytes_from_base64(
                candidate["prevChainHash"],
                f"{label} prevChainHash",
                32,
            )
        except (TypeError, ValueError) as error:
            problems.append(str(error))
    if "sig" in candidate:
        try:
            signature_bytes_from_base64(candidate["sig"], f"{label} sig", 64)
        except (TypeError, ValueError) as error:
            problems.append(str(error))
    return problems


def _valid_permutation(value: Any) -> bool:
    return (
        isinstance(value, list)
        and all(_is_int(entry) and 0 <= entry < len(value) for entry in value)
        and len(set(value)) == len(value)
    )


def _valid_location(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {"container", "coord"}:
        return False
    if not isinstance(value["container"], str) or not value["container"]:
        return False
    coord = value["coord"]
    return (
        isinstance(coord, str)
        or _valid_safe_integer(coord)
        or (
            isinstance(coord, list)
            and len(coord) == 2
            and all(_valid_safe_integer(entry) for entry in coord)
        )
    )


def _unicode_scalar_string(value: str) -> str | None:
    """Combine valid surrogate pairs and reject every unpaired surrogate."""

    result: list[str] = []
    index = 0
    while index < len(value):
        code_point = ord(value[index])
        if 0xD800 <= code_point <= 0xDBFF:
            if index + 1 >= len(value):
                return None
            low = ord(value[index + 1])
            if not 0xDC00 <= low <= 0xDFFF:
                return None
            result.append(chr(
                0x10000
                + ((code_point - 0xD800) << 10)
                + (low - 0xDC00)
            ))
            index += 2
            continue
        if 0xDC00 <= code_point <= 0xDFFF:
            return None
        result.append(value[index])
        index += 1
    return "".join(result)


def _message_value(value: Any) -> str:
    """Render arbitrary rejected input without leaking lone surrogates."""

    if isinstance(value, str) and _unicode_scalar_string(value) is not None:
        return value
    return ascii(value)


def _reject_unknown(
    value: dict[str, Any],
    allowed: set[str],
    label: str,
) -> list[str]:
    return [
        f"{label} has unknown property {_message_value(key)}"
        for key in value
        if key not in allowed
    ]


def _validate_resolution_input(
    candidate: Any,
    label: str,
    permutation: list[int],
    *,
    action_record: bool = False,
) -> list[str]:
    if not isinstance(candidate, dict):
        return [f"{label} must be an object"]
    allowed = {
        "wireId",
        "canonicalId",
        "payload",
        "x",
        "y",
        "index",
        "boardId",
        "zoneId",
        "seat",
        "targets",
        "submissionId",
        "canonicalCommand",
        "cursor",
        "clientTime",
        "prevChainHash",
        "sig",
        "commit",
        "reveal",
        "verifiedPayload",
    }
    if action_record:
        allowed.update({"kind", "n", "levelIndex", "tick", "hostTime"})
    problems = _reject_unknown(candidate, allowed, label)
    parsed_ids: dict[str, int] = {}
    for field in ("wireId", "canonicalId"):
        value = candidate.get(field)
        match = _ACTION_ID.fullmatch(value) if isinstance(value, str) else None
        action_id = int(match.group(1)) if match else 0
        if not match or not 1 <= action_id <= len(permutation):
            problems.append(
                f"{label} {field} must be within Action 1..{len(permutation)}"
            )
        else:
            parsed_ids[field] = action_id - 1
    if (
        "wireId" in parsed_ids
        and "canonicalId" in parsed_ids
        and permutation[parsed_ids["wireId"]] != parsed_ids["canonicalId"]
    ):
        problems.append(f"{label} action ids contradict the replay permutation")
    for field in ("x", "y", "index"):
        if field in candidate and not _valid_safe_integer(candidate[field]):
            problems.append(f"{label} {field} must be a safe integer")
    for field in ("clientTime",) + (("hostTime",) if action_record else ()):
        if field in candidate and not _valid_non_negative_integer(candidate[field]):
            problems.append(
                f"{label} {field} must be a non-negative safe integer"
            )
    for field in ("boardId", "zoneId", "seat"):
        if field in candidate and (
            not isinstance(candidate[field], str) or not candidate[field]
        ):
            problems.append(f"{label} {field} must be a non-empty string")
    targets = candidate.get("targets")
    if "targets" in candidate:
        if not isinstance(targets, list):
            problems.append(f"{label} targets must be an array")
        else:
            for index, target in enumerate(targets):
                if not _valid_location(target):
                    problems.append(f"{label} target {index} is invalid")
    commit = candidate.get("commit")
    reveal = candidate.get("reveal")
    has_commit = "commit" in candidate
    has_reveal = "reveal" in candidate
    if has_commit and has_reveal:
        problems.append(f"{label} commit and reveal are mutually exclusive")
    if "verifiedPayload" in candidate and not has_reveal:
        problems.append(f"{label} verifiedPayload requires reveal")
    if has_commit:
        if not isinstance(commit, dict):
            problems.append(f"{label} has an invalid commitment envelope")
        else:
            problems.extend(_reject_unknown(
                commit,
                {"commitmentId", "scheme", "hash"},
                f"{label} commit",
            ))
            if (
                not _valid_u32(commit.get("commitmentId"))
                or commit.get("scheme") != _COMMITMENT_SCHEME
                or not isinstance(commit.get("hash"), str)
                or not _LOWER_HASH.fullmatch(commit["hash"])
            ):
                problems.append(f"{label} has an invalid commitment envelope")
    if has_reveal:
        if not isinstance(reveal, dict):
            problems.append(f"{label} has an invalid reveal envelope")
        else:
            problems.extend(_reject_unknown(
                reveal,
                {"commitmentId", "salt", "payload"},
                f"{label} reveal",
            ))
            if (
                not _valid_u32(reveal.get("commitmentId"))
                or not isinstance(reveal.get("salt"), str)
                or not _LOWER_SALT.fullmatch(reveal["salt"])
                or "payload" not in reveal
            ):
                problems.append(f"{label} has an invalid reveal envelope")
    return problems


def _project_record_actions(records: list[Any]) -> list[dict[str, Any]]:
    projected: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        if record.get("kind") == "action":
            projected.append(dict(record))
        elif record.get("kind") == "resolution" and isinstance(
            record.get("inputs"), list
        ):
            for replay_input in record["inputs"]:
                if isinstance(replay_input, dict):
                    projected.append({
                        **replay_input,
                        "kind": "action",
                        "n": len(projected),
                        "levelIndex": record.get("levelIndex"),
                        "tick": record.get("tick"),
                    })
    for index, action in enumerate(projected):
        action["n"] = index
    return projected


def _validate_json_value(value: Any, path: str = "artifact") -> list[str]:
    if value is None or isinstance(value, bool):
        return []
    if isinstance(value, str):
        return (
            []
            if _unicode_scalar_string(value) is not None
            else [f"{path} must not contain unpaired surrogates"]
        )
    if isinstance(value, int):
        return (
            []
            if -_SAFE_INTEGER_MAX <= value <= _SAFE_INTEGER_MAX
            else [f"{path} integer numbers must be within the JavaScript safe range"]
        )
    if isinstance(value, float):
        if not math.isfinite(value):
            return [f"{path} must contain only finite numbers"]
        if value.is_integer() and abs(value) > _SAFE_INTEGER_MAX:
            return [
                f"{path} integer numbers must be within the JavaScript safe range"
            ]
        return []
    if isinstance(value, list):
        return [
            problem
            for index, entry in enumerate(value)
            for problem in _validate_json_value(entry, f"{path}[{index}]")
        ]
    if isinstance(value, dict):
        problems: list[str] = []
        scalar_keys: set[str] = set()
        for key, entry in value.items():
            if not isinstance(key, str):
                problems.append(f"{path} object keys must be strings")
            else:
                scalar_key = _unicode_scalar_string(key)
                if scalar_key is None:
                    problems.append(
                        f"{path} object key must not contain unpaired surrogates"
                    )
                elif scalar_key in scalar_keys:
                    problems.append(
                        f"{path} object keys must be unique Unicode scalar strings"
                    )
                else:
                    scalar_keys.add(scalar_key)
                entry_path = (
                    f"{path}.{scalar_key}"
                    if scalar_key is not None
                    else f"{path}.<invalid-key>"
                )
                problems.extend(_validate_json_value(entry, entry_path))
        return problems
    return [f"{path} must contain only plain JSON values"]


def validate_replay_artifact(value: Any) -> list[str]:
    """Validate a decoded replay independently of product reducer code."""

    if not isinstance(value, dict):
        return ["artifact must be an object"]
    header = value.get("header")
    actions = value.get("actions")
    if not isinstance(header, dict):
        return ["header must be an object"]

    problems: list[str] = []
    problems.extend(_reject_unknown(
        value,
        {"header", "actions", "records"},
        "artifact",
    ))
    problems.extend(_reject_unknown(
        header,
        {
            "kind",
            "format",
            "formatVersion",
            "sessionId",
            "game",
            "seed",
            "seedPolicy",
            "perm",
            "levels",
            "totals",
            "visibility",
            "seatKeys",
            "signaturePolicy",
            "timeoutPolicy",
            "extensions",
        },
        "header",
    ))
    if header.get("kind") != "header":
        problems.append("header.kind must be header")
    if header.get("format") != GAOS_REPLAY_FORMAT_ID:
        problems.append(f"header.format must be {GAOS_REPLAY_FORMAT_ID}")
    if header.get("formatVersion") not in (
        GAOS_REPLAY_LEGACY_FORMAT_VERSION,
        GAOS_REPLAY_UNSIGNED_FORMAT_VERSION,
        GAOS_REPLAY_SIGNED_FORMAT_VERSION,
        GAOS_REPLAY_FORMAT_VERSION,
    ):
        problems.append(
            "header.formatVersion must be "
            f"{GAOS_REPLAY_LEGACY_FORMAT_VERSION}, "
            f"{GAOS_REPLAY_UNSIGNED_FORMAT_VERSION}, "
            f"{GAOS_REPLAY_SIGNED_FORMAT_VERSION}, or "
            f"{GAOS_REPLAY_FORMAT_VERSION}"
        )
    if (
        header.get("formatVersion") == GAOS_REPLAY_LEGACY_FORMAT_VERSION
        and (
            "seatKeys" in header
            or "signaturePolicy" in header
            or "timeoutPolicy" in header
        )
    ):
        problems.append("header integrity reservations require formatVersion 1.1")
    if not isinstance(header.get("sessionId"), str) or not header["sessionId"]:
        problems.append("header.sessionId must be a non-empty string")
    if not _valid_u32(header.get("seed")):
        problems.append("header.seed must be an unsigned 32-bit integer")
    if header.get("seedPolicy") not in ("explicit", GAOS_REPLAY_DERIVED_SEEDS):
        problems.append(
            f"header.seedPolicy must be explicit or {GAOS_REPLAY_DERIVED_SEEDS}"
        )

    permutation = header.get("perm")
    if not _valid_permutation(permutation):
        problems.append("header.perm must be a complete bijection over its declared length")
        permutation = []

    visibility = header.get("visibility")
    if "visibility" in header and (
        not isinstance(visibility, str)
        or (visibility != "full" and not visibility.startswith("seat:"))
        or visibility == "seat:"
    ):
        problems.append("header.visibility must be full or seat:<id>")
    for field in ("signaturePolicy", "timeoutPolicy", "extensions"):
        if field in header and not isinstance(header[field], dict):
            problems.append(f"header.{field} must be an object")
    if _has_v12_integrity_semantics(header.get("formatVersion")):
        has_roster = "seatKeys" in header
        has_policy = "signaturePolicy" in header
        if has_roster != has_policy:
            problems.append(
                "v1.2 seatKeys and signaturePolicy must be declared together"
            )
        if has_policy and isinstance(header["signaturePolicy"], dict):
            problems.extend(_reject_unknown(
                header["signaturePolicy"],
                {"scheme"},
                "header.signaturePolicy",
            ))
            if (
                header["signaturePolicy"].get("scheme")
                != SUBMISSION_SIGNATURE_SCHEME
            ):
                problems.append(
                    "header.signaturePolicy.scheme must be "
                    f"{SUBMISSION_SIGNATURE_SCHEME}"
                )
        if has_roster:
            try:
                submission_roster_hash_v1(header["seatKeys"])
            except (TypeError, ValueError, KeyError) as error:
                problems.append(f"header.seatKeys is invalid: {error}")
        timeout_policy = header.get("timeoutPolicy")
        if timeout_policy is not None:
            if not isinstance(timeout_policy, dict):
                problems.append("header.timeoutPolicy must be an object")
            else:
                problems.extend(_reject_unknown(
                    timeout_policy,
                    {"mode", "windowTicks"},
                    "header.timeoutPolicy",
                ))
                if timeout_policy.get("mode") != "ticks":
                    problems.append("header.timeoutPolicy.mode must be ticks")
                if (
                    not _valid_non_negative_integer(
                        timeout_policy.get("windowTicks")
                    )
                    or timeout_policy.get("windowTicks") == 0
                ):
                    problems.append(
                        "header.timeoutPolicy.windowTicks must be a positive safe integer"
                    )

    game = header.get("game")
    if not isinstance(game, dict):
        problems.append("header.game must be an object")
    else:
        problems.extend(_reject_unknown(
            game,
            {"id", "version", "adapter"},
            "header.game",
        ))
        for field in ("id", "version"):
            if not isinstance(game.get(field), str) or not game[field]:
                problems.append(f"header.game.{field} must be a non-empty string")
        adapter = game.get("adapter")
        if not isinstance(adapter, dict):
            problems.append("header.game.adapter must be an object")
        else:
            problems.extend(_reject_unknown(
                adapter,
                {"id", "version"},
                "header.game.adapter",
            ))
            for field in ("id", "version"):
                if not isinstance(adapter.get(field), str) or not adapter[field]:
                    problems.append(
                        f"header.game.adapter.{field} must be a non-empty string"
                    )

    levels = header.get("levels")
    if not isinstance(levels, list) or not levels:
        problems.append("header.levels must be a non-empty array")
        levels = []
    else:
        seen_ids: set[str] = set()
        for index, level in enumerate(levels):
            if not isinstance(level, dict):
                problems.append(f"level at index {index} must be an object")
                continue
            problems.extend(_reject_unknown(
                level,
                {
                    "index",
                    "id",
                    "version",
                    "seed",
                    "level",
                    "result",
                    "extensions",
                },
                f"level {index}",
            ))
            if not _is_int(level.get("index")) or level.get("index") != index:
                problems.append(f"level at index {index} must declare index {index}")
            level_id = level.get("id")
            if not isinstance(level_id, str) or not level_id:
                problems.append(f"level {index} id must be a non-empty string")
            elif level_id in seen_ids:
                problems.append(f"level {index} duplicates id {_message_value(level_id)}")
            else:
                seen_ids.add(level_id)
            version = level.get("version")
            if "version" in level and (
                isinstance(version, bool)
                or not isinstance(version, (str, int, float))
                or (
                    isinstance(version, float)
                    and not math.isfinite(version)
                )
            ):
                problems.append(f"level {index} version must be a string or number")
            seed = level.get("seed")
            if not _valid_u32(seed):
                problems.append(f"level {index} seed must be an unsigned 32-bit integer")
            elif (
                header.get("seedPolicy") == GAOS_REPLAY_DERIVED_SEEDS
                and _valid_u32(header.get("seed"))
                and seed != run_level_seed(header["seed"], index)
            ):
                problems.append(
                    f"level {index} seed does not match {GAOS_REPLAY_DERIVED_SEEDS}"
                )
            if "level" not in level:
                problems.append(f"level {index} must include level data")
            if "extensions" in level and not isinstance(level["extensions"], dict):
                problems.append(f"level {index} extensions must be an object")
            result = level.get("result")
            if not isinstance(result, dict):
                problems.append(f"level {index} result must be an object")
            else:
                problems.extend(_reject_unknown(
                    result,
                    {"status", "stars", "actionsUsed", "extensions"},
                    f"level {index} result",
                ))
                allowed_statuses = (
                    ("won", "failed", "ended")
                    if header.get("formatVersion") == GAOS_REPLAY_FORMAT_VERSION
                    else ("won", "failed")
                )
                if result.get("status") not in allowed_statuses:
                    suffix = " or ended" if len(allowed_statuses) == 3 else ""
                    problems.append(
                        f"level {index} result.status must be won or failed{suffix}"
                    )
                stars = result.get("stars")
                if "stars" not in result:
                    problems.append(
                        f"level {index} result.stars must be a finite number or null"
                    )
                if result.get("status") == "ended" and stars is not None:
                    problems.append(f"level {index} ended result.stars must be null")
                elif stars is not None and (
                    isinstance(stars, bool)
                    or not isinstance(stars, (int, float))
                    or not math.isfinite(stars)
                ):
                    problems.append(
                        f"level {index} result.stars must be a finite number or null"
                    )
                if not _valid_non_negative_integer(result.get("actionsUsed")):
                    problems.append(
                        f"level {index} result.actionsUsed must be a non-negative safe integer"
                    )
                if (
                    "extensions" in result
                    and not isinstance(result["extensions"], dict)
                ):
                    problems.append(
                        f"level {index} result.extensions must be an object"
                    )

    totals = header.get("totals")
    if not isinstance(totals, dict):
        problems.append("header.totals must be an object")
    else:
        problems.extend(_reject_unknown(
            totals,
            {"totalStars", "totalActionsUsed", "extensions"},
            "header.totals",
        ))
        total_stars = totals.get("totalStars")
        if (
            isinstance(total_stars, bool)
            or not isinstance(total_stars, (int, float))
            or not math.isfinite(total_stars)
        ):
            problems.append("header.totals.totalStars must be a finite number")
        if not _valid_non_negative_integer(totals.get("totalActionsUsed")):
            problems.append(
                "header.totals.totalActionsUsed must be a non-negative safe integer"
            )
        if "extensions" in totals and not isinstance(totals["extensions"], dict):
            problems.append("header.totals.extensions must be an object")

    if not isinstance(actions, list):
        problems.append("actions must be an array")
    else:
        first_number = actions[0].get("n") if actions and isinstance(actions[0], dict) else None
        sequence_base = first_number if first_number in (0, 1) else None
        if actions and sequence_base is None:
            problems.append("action numbering must start at 0 or 1")
        previous_level_index = -1
        level_ticks: dict[int, int] = {}
        for index, action in enumerate(actions):
            if not isinstance(action, dict):
                problems.append(f"action at index {index} must be an object")
                continue
            problems.extend(_reject_unknown(
                action,
                {
                    "kind",
                    "n",
                    "levelIndex",
                    "wireId",
                    "canonicalId",
                    "payload",
                    "x",
                    "y",
                    "index",
                    "boardId",
                    "zoneId",
                    "seat",
                    "targets",
                    "tick",
                    "hostTime",
                    "submissionId",
                    "canonicalCommand",
                    "cursor",
                    "clientTime",
                    "prevChainHash",
                    "sig",
                    "commit",
                    "reveal",
                    "verifiedPayload",
                },
                f"action {_message_value(action.get('n'))}",
            ))
            number = action.get("n")
            if (
                action.get("kind") != "action"
            ):
                problems.append(f"action at index {index} kind must be action")
            if (
                not _valid_safe_integer(number)
                or sequence_base is None
                or number != sequence_base + index
            ):
                problems.append(
                    f"action at index {index} has non-contiguous sequence number {_message_value(number)}"
                )
            level_index = action.get("levelIndex")
            if (
                not _valid_non_negative_integer(level_index)
                or level_index >= len(levels)
            ):
                problems.append(
                    f"action {_message_value(number)} has invalid levelIndex {_message_value(level_index)}"
                )
            elif level_index < previous_level_index:
                problems.append(f"action {_message_value(number)} returns to an earlier level")
            else:
                previous_level_index = level_index

            parsed_ids: dict[str, int] = {}
            for field in ("wireId", "canonicalId"):
                candidate = action.get(field)
                match = _ACTION_ID.fullmatch(candidate) if isinstance(candidate, str) else None
                action_id = int(match.group(1)) if match else 0
                if not match or not 1 <= action_id <= len(permutation):
                    problems.append(
                        f"action {_message_value(number)} {field} must be within Action 1..{len(permutation)}"
                    )
                else:
                    parsed_ids[field] = action_id - 1
            if (
                "wireId" in parsed_ids
                and "canonicalId" in parsed_ids
                and permutation[parsed_ids["wireId"]] != parsed_ids["canonicalId"]
            ):
                problems.append(
                    f"action {_message_value(number)}: wire {action.get('wireId')} to "
                    f"{action.get('canonicalId')} contradicts the replay permutation"
                )

            for field in ("x", "y", "index", "tick"):
                if field in action and not _valid_safe_integer(action[field]):
                    problems.append(f"action {_message_value(number)} {field} must be a safe integer")
            for field in ("hostTime", "clientTime"):
                if (
                    field in action
                    and not _valid_non_negative_integer(action[field])
                ):
                    problems.append(
                        f"action {_message_value(number)} {field} must be a non-negative safe integer"
                    )
            if _has_v12_integrity_semantics(header.get("formatVersion")):
                problems.extend(_validate_v12_integrity_fields(
                    action,
                    f"action {_message_value(number)}",
                ))
            tick = action.get("tick")
            if _valid_safe_integer(tick) and tick < 0:
                problems.append(f"action {_message_value(number)} tick must be non-negative")
            if _valid_non_negative_integer(level_index) and _valid_non_negative_integer(tick):
                previous_tick = level_ticks.get(level_index, 0)
                if tick < previous_tick:
                    problems.append(
                        f"action {_message_value(number)} tick must not precede its level's previous action"
                    )
                else:
                    level_ticks[level_index] = tick
            for field in ("boardId", "zoneId", "seat"):
                if field in action and (
                    not isinstance(action[field], str) or not action[field]
                ):
                    problems.append(f"action {_message_value(number)} {field} must be a non-empty string")
            if "targets" in action:
                if not isinstance(action["targets"], list):
                    problems.append(f"action {_message_value(number)} targets must be an array")
                else:
                    for target_index, target in enumerate(action["targets"]):
                        if not _valid_location(target):
                            problems.append(
                                f"action {_message_value(number)} target {target_index} is invalid"
                            )
            commit = action.get("commit")
            reveal = action.get("reveal")
            has_commit = "commit" in action
            has_reveal = "reveal" in action
            if has_commit and has_reveal:
                problems.append(
                    f"action {_message_value(number)} commit and reveal are mutually exclusive"
                )
            if "verifiedPayload" in action and not has_reveal:
                problems.append(
                    f"action {_message_value(number)} verifiedPayload requires reveal"
                )
            if (
                header.get("formatVersion") == GAOS_REPLAY_LEGACY_FORMAT_VERSION
                and (
                    has_commit
                    or has_reveal
                    or "verifiedPayload" in action
                    or "submissionId" in action
                    or "canonicalCommand" in action
                    or "cursor" in action
                    or "clientTime" in action
                    or "hostTime" in action
                    or "prevChainHash" in action
                    or "sig" in action
                )
            ):
                problems.append(
                    f"action {_message_value(number)} v1.1 fields require formatVersion 1.1"
                )
            if has_commit:
                if isinstance(commit, dict):
                    problems.extend(_reject_unknown(
                        commit,
                        {"commitmentId", "scheme", "hash"},
                        f"action {_message_value(number)} commit",
                    ))
                if (
                    not isinstance(commit, dict)
                    or not _valid_u32(commit.get("commitmentId"))
                    or commit.get("scheme") != _COMMITMENT_SCHEME
                    or not isinstance(commit.get("hash"), str)
                    or not _LOWER_HASH.fullmatch(commit["hash"])
                ):
                    problems.append(
                        f"action {_message_value(number)} has an invalid commitment envelope"
                    )
            if has_reveal:
                if isinstance(reveal, dict):
                    problems.extend(_reject_unknown(
                        reveal,
                        {"commitmentId", "salt", "payload"},
                        f"action {_message_value(number)} reveal",
                    ))
                if (
                    not isinstance(reveal, dict)
                    or not _valid_u32(reveal.get("commitmentId"))
                    or not isinstance(reveal.get("salt"), str)
                    or not _LOWER_SALT.fullmatch(reveal["salt"])
                    or "payload" not in reveal
                ):
                    problems.append(f"action {_message_value(number)} has an invalid reveal envelope")

    records = value.get("records")
    if "records" in value:
        if not _is_grouped_version(header.get("formatVersion")):
            problems.append(
                "records require header.formatVersion "
                f"{GAOS_REPLAY_UNSIGNED_FORMAT_VERSION}, "
                f"{GAOS_REPLAY_SIGNED_FORMAT_VERSION}, or "
                f"{GAOS_REPLAY_FORMAT_VERSION}"
            )
        if not isinstance(records, list):
            problems.append("records must be an array")
        else:
            previous_level_index = -1
            record_ticks: dict[int, int] = {}
            allowed_kinds = {
                "action",
                "resolution",
                "timeout",
                "extension",
                "interest",
                "checkpoint",
                "commit-mismatch",
                "seat-signature",
            }
            common = {"kind", "n", "levelIndex", "hostTime"}
            allowed_by_kind = {
                "action": common | {
                    "wireId",
                    "canonicalId",
                    "payload",
                    "payload",
                    "x",
                    "y",
                    "index",
                    "boardId",
                    "zoneId",
                    "seat",
                    "targets",
                    "tick",
                    "commit",
                    "reveal",
                    "verifiedPayload",
                    "submissionId",
                    "canonicalCommand",
                    "cursor",
                    "clientTime",
                    "prevChainHash",
                    "sig",
                },
                "resolution": common | {"tick", "inputs", "cause", "systemInput"},
                "timeout": common | {
                    "tick",
                    "timeoutId",
                    "windowRef",
                    "participantId",
                    "reason",
                    "timeoutPolicyRef",
                },
                "extension": common | {"lane", "record"},
                "interest": common | {
                    "tick",
                    "cursor",
                    "participantId",
                    "submissionId",
                    "scopeId",
                    "declaration",
                    "canonicalCommand",
                    "clientTime",
                    "prevChainHash",
                    "sig",
                },
                "checkpoint": common | {"tick", "digest"},
                "commit-mismatch": common | {
                    "tick",
                    "participantId",
                    "submissionId",
                    "commitmentId",
                    "scheme",
                    "attemptedReveal",
                    "canonicalCommand",
                    "cursor",
                    "clientTime",
                    "prevChainHash",
                    "sig",
                },
                "seat-signature": common | {
                    "tick",
                    "participantId",
                    "clientTime",
                    "prevChainHash",
                    "sig",
                },
            }
            for index, record in enumerate(records):
                if not isinstance(record, dict):
                    problems.append(f"record at index {index} must be an object")
                    continue
                if not _is_int(record.get("n")) or record.get("n") != index:
                    problems.append(
                        f"record at index {index} must declare sequence number {index}"
                    )
                level_index = record.get("levelIndex")
                if (
                    not _valid_non_negative_integer(level_index)
                    or level_index >= len(levels)
                ):
                    problems.append(
                        f"record {index} has invalid levelIndex {_message_value(level_index)}"
                    )
                elif level_index < previous_level_index:
                    problems.append(f"record {index} returns to an earlier level")
                else:
                    previous_level_index = level_index
                kind = record.get("kind")
                for field in ("hostTime", "clientTime"):
                    if (
                        field in record
                        and not _valid_non_negative_integer(record[field])
                    ):
                        problems.append(
                            f"record {index} {field} must be a non-negative safe integer"
                        )
                if not isinstance(kind, str) or kind not in allowed_kinds:
                    problems.append(f"record {index} has unknown kind {_message_value(kind)}")
                    continue
                problems.extend(_reject_unknown(
                    record,
                    allowed_by_kind[kind],
                    f"record {index}",
                ))
                if kind == "action":
                    problems.extend(_validate_resolution_input(
                        record,
                        f"record {index} action",
                        permutation,
                        action_record=True,
                    ))
                    if _has_v12_integrity_semantics(header.get("formatVersion")):
                        problems.extend(_validate_v12_integrity_fields(
                            record,
                            f"record {index} action",
                        ))
                elif kind == "resolution":
                    if not _valid_non_negative_integer(record.get("tick")):
                        problems.append(
                            f"resolution {index} tick must be a non-negative safe integer"
                        )
                    if not isinstance(record.get("inputs"), list):
                        problems.append(f"resolution {index} inputs must be an array")
                    else:
                        for input_index, replay_input in enumerate(record["inputs"]):
                            problems.extend(_validate_resolution_input(
                                replay_input,
                                f"resolution {index} input {input_index}",
                                permutation,
                            ))
                            if (
                                _has_v12_integrity_semantics(
                                    header.get("formatVersion")
                                )
                                and isinstance(replay_input, dict)
                            ):
                                problems.extend(_validate_v12_integrity_fields(
                                    replay_input,
                                    f"resolution {index} input {input_index}",
                                ))
                    if record.get("cause") not in ("complete", "timeout", "tick"):
                        problems.append(
                            f"resolution {index} cause must be complete, timeout, or tick"
                        )
                    system_input = record.get("systemInput")
                    if record.get("cause") == "timeout":
                        if system_input is None:
                            problems.append(
                                f"resolution {index} timeout cause requires systemInput"
                            )
                        else:
                            problems.extend(_validate_resolution_input(
                                system_input,
                                f"resolution {index} systemInput",
                                permutation,
                            ))
                            if (
                                _has_v12_integrity_semantics(
                                    header.get("formatVersion")
                                )
                                and isinstance(system_input, dict)
                            ):
                                problems.extend(_validate_v12_integrity_fields(
                                    system_input,
                                    f"resolution {index} systemInput",
                                ))
                            if isinstance(record.get("inputs"), list):
                                try:
                                    encoded_system = canonical_json(system_input)
                                    appears = any(
                                        canonical_json(replay_input) == encoded_system
                                        for replay_input in record["inputs"]
                                    )
                                except (TypeError, ValueError):
                                    appears = False
                                if not appears:
                                    problems.append(
                                        f"resolution {index} systemInput must appear in inputs"
                                    )
                    elif "systemInput" in record:
                        problems.append(
                            f"resolution {index} systemInput requires timeout cause"
                        )
                    tick = record.get("tick")
                    if (
                        _valid_non_negative_integer(level_index)
                        and _valid_non_negative_integer(tick)
                    ):
                        previous_tick = record_ticks.get(level_index, 0)
                        if tick < previous_tick:
                            problems.append(
                                f"resolution {index} tick precedes its level's prior record"
                            )
                        else:
                            record_ticks[level_index] = tick
                elif kind == "timeout":
                    if not _valid_non_negative_integer(record.get("tick")):
                        problems.append(
                            f"timeout {index} tick must be a non-negative safe integer"
                        )
                    if (
                        not isinstance(record.get("reason"), str)
                        or not record["reason"]
                    ):
                        problems.append(
                            f"timeout {index} reason must be a non-empty string"
                        )
                    if (
                        not isinstance(record.get("timeoutId"), str)
                        or not record["timeoutId"]
                    ):
                        problems.append(
                            f"timeout {index} timeoutId must be a non-empty string"
                        )
                    if not _valid_non_negative_integer(record.get("windowRef")):
                        problems.append(
                            f"timeout {index} windowRef must be a non-negative safe integer"
                        )
                    participant_id = record.get("participantId")
                    if "participantId" not in record or (
                        participant_id is not None
                        and (
                            not isinstance(participant_id, str)
                            or not participant_id
                        )
                    ):
                        problems.append(
                            f"timeout {index} participantId must be null or a non-empty string"
                        )
                    if "timeoutPolicyRef" in record and (
                        not isinstance(record["timeoutPolicyRef"], str)
                        or not record["timeoutPolicyRef"]
                    ):
                        problems.append(
                            f"timeout {index} timeoutPolicyRef must be a non-empty string"
                        )
                    if _has_v12_integrity_semantics(header.get("formatVersion")):
                        timeout_policy = header.get("timeoutPolicy")
                        if timeout_policy is None:
                            if "timeoutPolicyRef" in record:
                                problems.append(
                                    f"timeout {index} timeoutPolicyRef requires "
                                    "header.timeoutPolicy"
                                )
                        elif record.get("timeoutPolicyRef") != GAOS_TIMEOUT_POLICY_REF:
                            problems.append(
                                f"timeout {index} timeoutPolicyRef must be "
                                f"{GAOS_TIMEOUT_POLICY_REF}"
                            )
                        elif (
                            isinstance(timeout_policy, dict)
                            and _valid_non_negative_integer(
                                timeout_policy.get("windowTicks")
                            )
                            and _valid_non_negative_integer(record.get("tick"))
                            and _valid_non_negative_integer(record.get("windowRef"))
                            and record["tick"]
                            != record["windowRef"] + timeout_policy["windowTicks"]
                        ):
                            problems.append(
                                f"timeout {index} tick must equal "
                                "windowRef + windowTicks"
                            )
                elif kind == "extension":
                    if not isinstance(record.get("lane"), str) or not record["lane"]:
                        problems.append(
                            f"extension {index} lane must be a non-empty string"
                        )
                    if not isinstance(record.get("record"), dict):
                        problems.append(f"extension {index} record must be an object")
                elif kind == "interest":
                    if not _has_v12_integrity_semantics(
                        header.get("formatVersion")
                    ):
                        problems.append(
                            f"interest {index} requires formatVersion "
                            f"{GAOS_REPLAY_SIGNED_FORMAT_VERSION} or "
                            f"{GAOS_REPLAY_FORMAT_VERSION}"
                        )
                    problems.extend(_validate_v12_integrity_fields(
                        record,
                        f"interest {index}",
                    ))
                    if any(
                        field not in record
                        for field in ("clientTime", "prevChainHash", "sig")
                    ):
                        problems.append(
                            f"interest {index} requires clientTime, "
                            "prevChainHash, and sig"
                        )
                    for field in ("tick", "cursor"):
                        if not _valid_non_negative_integer(record.get(field)):
                            problems.append(
                                f"interest {index} {field} must be a "
                                "non-negative safe integer"
                            )
                    for field in ("participantId", "submissionId", "scopeId"):
                        if not isinstance(record.get(field), str) or not record[field]:
                            problems.append(
                                f"interest {index} {field} must be a non-empty string"
                            )
                    if "declaration" not in record:
                        problems.append(f"interest {index} declaration is required")
                    else:
                        try:
                            expected = canonical_json({
                                "kind": "interest",
                                "scopeId": record.get("scopeId"),
                                "declaration": record["declaration"],
                            })
                            if record.get("canonicalCommand") != expected:
                                problems.append(
                                    f"interest {index} canonicalCommand does not "
                                    "match declaration"
                                )
                        except (TypeError, ValueError):
                            problems.append(
                                f"interest {index} declaration must contain plain JSON"
                            )
                elif kind == "checkpoint":
                    if not _valid_non_negative_integer(record.get("tick")):
                        problems.append(
                            f"checkpoint {index} tick must be a non-negative safe integer"
                        )
                    if not _valid_u32(record.get("digest")):
                        problems.append(
                            f"checkpoint {index} digest must be an unsigned 32-bit integer"
                        )
                elif kind == "commit-mismatch":
                    if _has_v12_integrity_semantics(header.get("formatVersion")):
                        problems.extend(_validate_v12_integrity_fields(
                            record,
                            f"commit-mismatch {index}",
                        ))
                    if not _valid_non_negative_integer(record.get("tick")):
                        problems.append(
                            f"commit-mismatch {index} tick must be a non-negative safe integer"
                        )
                    if not _valid_u32(record.get("commitmentId")):
                        problems.append(
                            f"commit-mismatch {index} commitmentId must be an unsigned 32-bit integer"
                        )
                    if record.get("scheme") != _COMMITMENT_SCHEME:
                        problems.append(
                            f"commit-mismatch {index} scheme must be {_COMMITMENT_SCHEME}"
                        )
                    for field in ("participantId", "submissionId"):
                        if (
                            not isinstance(record.get(field), str)
                            or not record[field]
                        ):
                            problems.append(
                                f"commit-mismatch {index} {field} must be a non-empty string"
                            )
                    attempt = record.get("attemptedReveal")
                    if "attemptedReveal" in record:
                        if not isinstance(attempt, dict):
                            problems.append(
                                f"commit-mismatch {index} attemptedReveal is invalid"
                            )
                        else:
                            problems.extend(_reject_unknown(
                                attempt,
                                {"salt", "payload"},
                                f"commit-mismatch {index} attemptedReveal",
                            ))
                            if (
                                not isinstance(attempt.get("salt"), str)
                                or not _LOWER_SALT.fullmatch(attempt["salt"])
                                or "payload" not in attempt
                            ):
                                problems.append(
                                    f"commit-mismatch {index} attemptedReveal is invalid"
                                )
                elif kind == "seat-signature":
                    if not _valid_non_negative_integer(record.get("tick")):
                        problems.append(
                            f"seat-signature {index} tick must be a non-negative safe integer"
                        )
                    if (
                        not isinstance(record.get("participantId"), str)
                        or not record["participantId"]
                    ):
                        problems.append(
                            f"seat-signature {index} participantId must be a non-empty string"
                        )
                    if _has_v12_integrity_semantics(header.get("formatVersion")):
                        if not _valid_non_negative_integer(record.get("clientTime")):
                            problems.append(
                                f"seat-signature {index} clientTime must be a non-negative safe integer"
                            )
                        try:
                            signature_bytes_from_base64(
                                record.get("prevChainHash"),
                                f"seat-signature {index} prevChainHash",
                                32,
                            )
                        except (TypeError, ValueError) as error:
                            problems.append(str(error))
                        try:
                            signature_bytes_from_base64(
                                record.get("sig"),
                                f"seat-signature {index} sig",
                                64,
                            )
                        except (TypeError, ValueError) as error:
                            problems.append(str(error))
            if isinstance(actions, list):
                try:
                    if canonical_json(_project_record_actions(records)) != canonical_json(actions):
                        problems.append(
                            "actions must exactly match the projection of records"
                        )
                except (TypeError, ValueError):
                    problems.append(
                        "actions and records must contain only plain JSON"
                    )

    problems.extend(_validate_json_value(value))
    return problems


def _javascript_number(value: int | float) -> str:
    """Render finite JSON numbers using JSON.stringify-compatible thresholds."""

    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise TypeError("JSON numbers must be finite")
    if value == 0:
        return "0"
    text = repr(value).lower()
    if "e" not in text:
        return text[:-2] if text.endswith(".0") else text

    mantissa, exponent_text = text.split("e")
    exponent = int(exponent_text)
    sign = ""
    if mantissa.startswith("-"):
        sign, mantissa = "-", mantissa[1:]
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    decimal_position = len(whole) + exponent
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        if decimal_position <= 0:
            return sign + "0." + ("0" * -decimal_position) + digits
        if decimal_position >= len(digits):
            return sign + digits + ("0" * (decimal_position - len(digits)))
        return sign + digits[:decimal_position] + "." + digits[decimal_position:]

    normalized = digits[0]
    if len(digits) > 1:
        normalized += "." + digits[1:].rstrip("0")
        normalized = normalized.rstrip(".")
    scientific_exponent = decimal_position - 1
    exponent_sign = "+" if scientific_exponent >= 0 else "-"
    return f"{sign}{normalized}e{exponent_sign}{abs(scientific_exponent)}"


def canonical_json(value: Any) -> str:
    """Return the same key-sorted canonical JSON used by the TypeScript SDK."""

    problems = _validate_json_value(value, "value")
    if problems:
        raise TypeError("; ".join(problems))

    def encode(candidate: Any) -> str:
        if candidate is None:
            return "null"
        if candidate is True:
            return "true"
        if candidate is False:
            return "false"
        if isinstance(candidate, str):
            scalar = _unicode_scalar_string(candidate)
            if scalar is None:
                raise TypeError("JSON strings must not contain unpaired surrogates")
            return json.dumps(scalar, ensure_ascii=False, separators=(",", ":"))
        if isinstance(candidate, (int, float)):
            return _javascript_number(candidate)
        if isinstance(candidate, list):
            return "[" + ",".join(encode(entry) for entry in candidate) + "]"
        return (
            "{"
            + ",".join(
                json.dumps(_unicode_scalar_string(key), ensure_ascii=False)
                + ":"
                + encode(candidate[key])
                for key in sorted(
                    candidate,
                    key=lambda entry: _unicode_scalar_string(entry) or "",
                )
            )
            + "}"
        )

    return encode(value)


def parse_replay_jsonl(jsonl: str) -> dict[str, Any]:
    """Parse and validate one portable replay JSONL artifact."""

    if not isinstance(jsonl, str) or not jsonl.strip():
        raise ReplayFormatError(["JSONL must contain a header line"])
    lines = jsonl.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    parsed: list[Any] = []
    for index, line in enumerate(lines):
        if not line.strip():
            raise ReplayFormatError([f"line {index + 1} must not be blank"])
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise ReplayFormatError(
                [f"line {index + 1} is not valid JSON: {error.msg}"]
            ) from error
    header = parsed[0]
    stream = parsed[1:]
    has_grouped_records = (
        isinstance(header, dict)
        and _is_grouped_version(header.get("formatVersion"))
        and any(
            isinstance(record, dict) and record.get("kind") != "action"
            for record in stream
        )
    )
    actions = _project_record_actions(stream) if has_grouped_records else stream
    artifact = {
        "header": header,
        "actions": actions,
        **({"records": stream} if has_grouped_records else {}),
    }
    problems = validate_replay_artifact(artifact)
    if problems:
        raise ReplayFormatError(problems)
    return artifact


def serialize_replay_jsonl(artifact: dict[str, Any]) -> str:
    """Validate and serialize canonical, trailing-newline replay JSONL."""

    problems = validate_replay_artifact(artifact)
    if problems:
        raise ReplayFormatError(problems)
    stream = artifact.get("records", artifact["actions"])
    records = [artifact["header"], *stream]
    return "\n".join(canonical_json(record) for record in records) + "\n"


def recheck_replay_signatures(artifact: dict[str, Any]) -> dict[str, Any]:
    """Verify RFC-010 signatures and per-seat chains without game code."""

    header = artifact.get("header", {})
    if (
        not _has_v12_integrity_semantics(header.get("formatVersion"))
        or "seatKeys" not in header
        or "signaturePolicy" not in header
    ):
        return {"state": "unsigned", "problems": [], "seats": []}

    problems: list[str] = []
    signature_material = 0
    valid_signatures = 0
    try:
        roster_hash = submission_roster_hash_v1(header["seatKeys"])
    except (TypeError, ValueError, KeyError) as error:
        return {
            "state": "partial",
            "problems": [f"cannot hash seat roster: {error}"],
            "seats": [],
        }
    keys = {entry["id"]: entry for entry in header["seatKeys"]}
    checks: dict[str, dict[str, Any]] = {}
    for seat, key in keys.items():
        checks[seat] = {
            "seat": seat,
            "submissions": 0,
            "validSignatures": 0,
            "chainReproduced": True,
            "policySatisfied": True,
            "chainHead": submission_genesis_hash_v1(
                header["sessionId"],
                seat,
                roster_hash,
            ),
            "firstSubmissionTick": None,
            "submissionPositions": [],
            "attestationPositions": [],
            "chainBroken": False,
            "N": key["signingTier"]["N"],
        }

    items: list[tuple[str, dict[str, Any], int, int, str, int | None]] = []
    for record in artifact.get("records", artifact.get("actions", [])):
        kind = record.get("kind")
        if kind == "resolution":
            for input_index, replay_input in enumerate(record.get("inputs", [])):
                if (
                    isinstance(replay_input.get("seat"), str)
                    and "submissionId" in replay_input
                ):
                    items.append((
                        "submission",
                        replay_input,
                        record["levelIndex"],
                        record["tick"],
                        f"resolution {record['n']} input {input_index}",
                        1 if "commit" in replay_input or "reveal" in replay_input else None,
                    ))
        elif (
            kind == "action"
            and isinstance(record.get("seat"), str)
            and "submissionId" in record
        ):
            items.append((
                "submission",
                record,
                record["levelIndex"],
                record.get("tick", 0),
                f"action {record['n']}",
                1 if "commit" in record or "reveal" in record else None,
            ))
        elif kind == "commit-mismatch":
            items.append((
                "submission",
                record,
                record["levelIndex"],
                record["tick"],
                f"commit-mismatch {record['n']}",
                1,
            ))
        elif kind == "interest":
            items.append((
                "submission",
                record,
                record["levelIndex"],
                record["tick"],
                f"interest {record['n']}",
                2,
            ))
        elif kind == "seat-signature":
            items.append((
                "periodic",
                record,
                record["levelIndex"],
                record["tick"],
                f"seat-signature {record['n']}",
                None,
            ))

    for order, (
        kind,
        value,
        level_index,
        tick,
        label,
        required_tier,
    ) in enumerate(items):
        seat = (
            value.get("participantId")
            if kind == "periodic"
            or value.get("kind") in {"commit-mismatch", "interest"}
            else value.get("seat")
        )
        check = checks.get(seat)
        key = keys.get(seat)
        if check is None or key is None:
            problems.append(f"{label} names seat outside header.seatKeys")
            continue
        if "sig" in value:
            signature_material += 1

        if kind == "periodic":
            if value.get("prevChainHash") != check["chainHead"]:
                check["chainReproduced"] = False
                check["policySatisfied"] = False
                problems.append(
                    f"{label} does not sign seat {seat}'s current chain head"
                )
                continue
            if "clientTime" not in value or "sig" not in value:
                check["policySatisfied"] = False
                problems.append(f"{label} is missing clientTime or sig")
                continue
            valid = verify_ed25519_base64(
                key["publicKey"],
                periodic_signature_preimage_v1({
                    "sessionId": header["sessionId"],
                    "seat": seat,
                    "tick": tick,
                    "clientTime": value["clientTime"],
                    "chainHead": value["prevChainHash"],
                }),
                value["sig"],
            )
            if not valid:
                check["policySatisfied"] = False
                problems.append(f"{label} has an invalid Ed25519 signature")
                continue
            valid_signatures += 1
            check["validSignatures"] += 1
            check["attestationPositions"].append({
                "levelIndex": level_index,
                "tick": tick,
                "order": order,
            })
            continue

        check["submissions"] += 1
        if check["firstSubmissionTick"] is None:
            check["firstSubmissionTick"] = tick
        check["submissionPositions"].append({
            "levelIndex": level_index,
            "tick": tick,
            "order": order,
        })
        chain_fields = (
            "submissionId",
            "canonicalCommand",
            "cursor",
            "clientTime",
            "prevChainHash",
        )
        if not all(field in value for field in chain_fields):
            check["chainBroken"] = True
            check["chainReproduced"] = False
            check["policySatisfied"] = False
            problems.append(f"{label} is missing RFC-010 chain metadata")
            continue
        if (
            check["chainBroken"]
            or value["prevChainHash"] != check["chainHead"]
        ):
            check["chainBroken"] = True
            check["chainReproduced"] = False
            check["policySatisfied"] = False
            problems.append(f"{label} does not reproduce seat {seat}'s chain")
            continue
        try:
            command = json.loads(value["canonicalCommand"])
            if canonical_json(command) != value["canonicalCommand"]:
                raise ValueError("not canonical")
        except (TypeError, ValueError, json.JSONDecodeError):
            check["chainBroken"] = True
            check["chainReproduced"] = False
            check["policySatisfied"] = False
            problems.append(f"{label} canonicalCommand is not canonical JSON")
            continue
        envelope = {
            "sessionId": header["sessionId"],
            "seat": seat,
            "submissionId": value["submissionId"],
            "cursor": value["cursor"],
            "tick": tick,
            "clientTime": value["clientTime"],
            "command": command,
            "prevChainHash": value["prevChainHash"],
        }
        preimage = submission_preimage_v1(envelope)
        check["chainHead"] = submission_chain_hash_v1(envelope)
        if "sig" not in value:
            if required_tier is not None:
                check["policySatisfied"] = False
                problems.append(
                    f"{label} requires a tier-{required_tier} signature"
                )
            continue
        if not verify_ed25519_base64(
            key["publicKey"],
            preimage,
            value["sig"],
        ):
            check["policySatisfied"] = False
            problems.append(f"{label} has an invalid Ed25519 signature")
            continue
        valid_signatures += 1
        check["validSignatures"] += 1
        check["attestationPositions"].append({
            "levelIndex": level_index,
            "tick": tick,
            "order": order,
        })

    for seat, check in checks.items():
        first_tick = check["firstSubmissionTick"]
        if first_tick is None:
            continue
        for submission in check["submissionPositions"]:
            covering = next(
                (
                    candidate
                    for candidate in check["attestationPositions"]
                    if candidate["order"] >= submission["order"]
                ),
                None,
            )
            if covering is None:
                check["policySatisfied"] = False
                problems.append(
                    f"seat {seat} has no signed chain head covering "
                    f"submission at level {submission['levelIndex']} "
                    f"tick {submission['tick']}"
                )
                break
            if covering["levelIndex"] != submission["levelIndex"]:
                check["policySatisfied"] = False
                problems.append(
                    f"seat {seat} crosses a level boundary without "
                    "signing its chain head"
                )
                break
            if covering["tick"] - submission["tick"] > check["N"]:
                check["policySatisfied"] = False
                problems.append(
                    f"seat {seat} exceeds signingTier.N={check['N']} "
                    f"for submission at level {submission['levelIndex']} "
                    f"tick {submission['tick']}"
                )
                break

    seats = [{
        key: value
        for key, value in check.items()
        if key not in {
            "firstSubmissionTick",
            "submissionPositions",
            "attestationPositions",
            "chainBroken",
            "N",
        }
    } for check in checks.values()]
    complete = all(
        seat["chainReproduced"] and seat["policySatisfied"]
        for seat in seats
    )
    if signature_material == 0:
        state = "partial" if any(seat["submissions"] for seat in seats) else "signed"
    elif complete and valid_signatures == signature_material:
        state = "signed"
    else:
        state = "partial"
    return {"state": state, "problems": problems, "seats": seats}
