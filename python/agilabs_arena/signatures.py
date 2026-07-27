"""RFC-010 submission framing, hash chains, and synchronous Ed25519 checks."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any


SUBMISSION_SIGNATURE_SCHEME = "gaos.submission.ed25519.v1"
SUBMISSION_SIGNATURE_SCHEME_V2 = "gaos.submission.ed25519.v2"
SUBMISSION_SIGNATURE_ALGORITHM = "Ed25519"
_DOMAIN_TAG = SUBMISSION_SIGNATURE_SCHEME.encode()
_PERIODIC_DOMAIN_TAG = f"{SUBMISSION_SIGNATURE_SCHEME}.periodic".encode()
_MAX_TEXT_BYTES = 65_536
_SAFE_INTEGER_MAX = (1 << 53) - 1


def _utf8(value: str, label: str) -> bytes:
    if not isinstance(value, str):
        raise TypeError(f"{label} must be a string")
    try:
        result = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise TypeError(f"{label} must not contain unpaired surrogates") from error
    if not result:
        raise ValueError(f"{label} must be non-empty")
    if len(result) > _MAX_TEXT_BYTES:
        raise ValueError(f"{label} exceeds {_MAX_TEXT_BYTES} UTF-8 bytes")
    return result


def _u64(value: int, label: str) -> bytes:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= _SAFE_INTEGER_MAX
    ):
        raise ValueError(f"{label} must be a non-negative safe integer")
    return value.to_bytes(8, "big")


def _frame(value: bytes) -> bytes:
    if len(value) > 0xFFFF_FFFF:
        raise ValueError("framed value is too large")
    return len(value).to_bytes(4, "big") + value


def signature_bytes_to_base64(value: bytes) -> str:
    """Encode canonical padded RFC 4648 base64."""

    return base64.b64encode(value).decode("ascii")


def signature_bytes_from_base64(
    value: str,
    label: str,
    expected_length: int,
) -> bytes:
    """Decode canonical padded base64 with an exact byte length."""

    if not isinstance(value, str):
        raise TypeError(f"{label} must be canonical padded base64")
    try:
        result = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise TypeError(f"{label} must be canonical padded base64") from error
    if (
        len(result) != expected_length
        or signature_bytes_to_base64(result) != value
    ):
        raise ValueError(f"{label} must decode to exactly {expected_length} bytes")
    return result


def canonical_submission_command_v1(command: Any) -> bytes:
    """Canonical command bytes used by the v1 signing envelope."""

    from .replay import canonical_json

    result = canonical_json(command).encode("utf-8")
    if len(result) > _MAX_TEXT_BYTES:
        raise ValueError(
            f"command exceeds {_MAX_TEXT_BYTES} canonical UTF-8 bytes"
        )
    return result


def submission_preimage_v1(envelope: dict[str, Any]) -> bytes:
    """Build the byte-exact RFC-010 submission signature preimage."""

    return b"".join((
        _frame(_DOMAIN_TAG),
        _frame(_utf8(envelope["sessionId"], "sessionId")),
        _frame(_utf8(envelope["seat"], "seat")),
        _frame(_utf8(envelope["submissionId"], "submissionId")),
        _u64(envelope["cursor"], "cursor"),
        _u64(envelope["tick"], "tick"),
        _u64(envelope["clientTime"], "clientTime"),
        _frame(canonical_submission_command_v1(envelope["command"])),
        _frame(signature_bytes_from_base64(
            envelope["prevChainHash"],
            "prevChainHash",
            32,
        )),
    ))


def submission_chain_hash_v1(envelope: dict[str, Any]) -> str:
    """Hash a canonical submission into the next per-seat chain head."""

    return signature_bytes_to_base64(
        hashlib.sha256(submission_preimage_v1(envelope)).digest()
    )


def submission_roster_hash_v1(seat_keys: list[dict[str, Any]]) -> str:
    """Order-independent SHA-256 hash of a complete RFC-010 seat roster."""

    from .replay import canonical_json

    if not isinstance(seat_keys, list) or not seat_keys:
        raise TypeError("seatKeys must be a non-empty array")
    ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, entry in enumerate(seat_keys):
        if not isinstance(entry, dict) or set(entry) != {
            "id",
            "publicKey",
            "alg",
            "signingTier",
        }:
            raise TypeError(f"seatKeys[{index}] must be an exact roster object")
        seat_id = entry["id"]
        _utf8(seat_id, f"seatKeys[{index}].id")
        if seat_id in ids:
            raise TypeError(f"seatKeys contains duplicate id {seat_id}")
        ids.add(seat_id)
        signature_bytes_from_base64(
            entry["publicKey"],
            f"seatKeys[{index}].publicKey",
            32,
        )
        if entry["alg"] != SUBMISSION_SIGNATURE_ALGORITHM:
            raise TypeError(
                f"seatKeys[{index}].alg must be {SUBMISSION_SIGNATURE_ALGORITHM}"
            )
        tier = entry["signingTier"]
        if (
            not isinstance(tier, dict)
            or set(tier) != {"N"}
            or isinstance(tier["N"], bool)
            or not isinstance(tier["N"], int)
            or not 1 <= tier["N"] <= _SAFE_INTEGER_MAX
        ):
            raise ValueError(
                f"seatKeys[{index}].signingTier.N must be a positive safe integer"
            )
        normalized.append({
            "id": seat_id,
            "publicKey": entry["publicKey"],
            "alg": entry["alg"],
            "signingTier": {"N": tier["N"]},
        })
    normalized.sort(key=lambda entry: tuple(ord(char) for char in entry["id"]))
    return signature_bytes_to_base64(hashlib.sha256(
        canonical_json(normalized).encode("utf-8")
    ).digest())


def submission_genesis_hash_v1(
    session_id: str,
    seat: str,
    roster_hash: str,
) -> str:
    """Return the roster-bound first expected chain link for one seat."""

    preimage = b"".join((
        _frame(_DOMAIN_TAG),
        _frame(_utf8(session_id, "sessionId")),
        _frame(_utf8(seat, "seat")),
        _frame(signature_bytes_from_base64(roster_hash, "rosterHash", 32)),
    ))
    return signature_bytes_to_base64(hashlib.sha256(preimage).digest())


def periodic_signature_preimage_v1(envelope: dict[str, Any]) -> bytes:
    """Build the domain-separated periodic chain-head signature preimage."""

    return b"".join((
        _frame(_PERIODIC_DOMAIN_TAG),
        _frame(_utf8(envelope["sessionId"], "sessionId")),
        _frame(_utf8(envelope["seat"], "seat")),
        _u64(envelope["tick"], "tick"),
        _u64(envelope["clientTime"], "clientTime"),
        _frame(signature_bytes_from_base64(
            envelope["chainHead"],
            "chainHead",
            32,
        )),
    ))


_P = (1 << 255) - 19
_L = (1 << 252) + 27742317777372353535851937790883648493


def _mod(value: int) -> int:
    return value % _P


_D = _mod(-121665 * pow(121666, _P - 2, _P))
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)
_IDENTITY = (0, 1, 1, 0)
_Point = tuple[int, int, int, int]


def _point_add(left: _Point, right: _Point) -> _Point:
    x1, y1, z1, t1 = left
    x2, y2, z2, t2 = right
    a = _mod((y1 - x1) * (y2 - x2))
    b = _mod((y1 + x1) * (y2 + x2))
    c = _mod(2 * _D * t1 * t2)
    d = _mod(2 * z1 * z2)
    e, f, g, h = b - a, d - c, d + c, b + a
    return (_mod(e * f), _mod(g * h), _mod(f * g), _mod(e * h))


def _point_double(point: _Point) -> _Point:
    x, y, z, _ = point
    a = _mod(x * x)
    b = _mod(y * y)
    c = _mod(2 * z * z)
    d = _mod(-a)
    e = _mod((x + y) * (x + y) - a - b)
    g, f, h = d + b, d + b - c, d - b
    return (_mod(e * f), _mod(g * h), _mod(f * g), _mod(e * h))


def _scalar_multiply(point: _Point, scalar: int) -> _Point:
    result = _IDENTITY
    addend = point
    while scalar > 0:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_double(addend)
        scalar >>= 1
    return result


def _decode_point(value: bytes) -> _Point | None:
    if len(value) != 32:
        return None
    encoded = bytearray(value)
    sign = encoded[31] >> 7
    encoded[31] &= 0x7F
    y = int.from_bytes(encoded, "little")
    if y >= _P:
        return None
    y2 = _mod(y * y)
    u = _mod(y2 - 1)
    v = _mod(_D * y2 + 1)
    v3 = _mod(v * v * v)
    v7 = _mod(v3 * v3 * v)
    x = _mod(u * v3 * pow(_mod(u * v7), (_P - 5) // 8, _P))
    if _mod(v * x * x - u):
        x = _mod(x * _SQRT_M1)
    if _mod(v * x * x - u) or (x == 0 and sign):
        return None
    if (x & 1) != sign:
        x = _P - x
    return (x, y, 1, _mod(x * y))


_BASE_POINT = _decode_point(bytes([0x58, *([0x66] * 31)]))
assert _BASE_POINT is not None


def _points_equal(left: _Point, right: _Point) -> bool:
    return (
        _mod(left[0] * right[2] - right[0] * left[2]) == 0
        and _mod(left[1] * right[2] - right[1] * left[2]) == 0
    )


def _in_prime_order_subgroup(point: _Point) -> bool:
    return (
        not _points_equal(point, _IDENTITY)
        and _points_equal(_scalar_multiply(point, _L), _IDENTITY)
    )


def _encode_point(point: _Point) -> bytes:
    inverse_z = pow(point[2], _P - 2, _P)
    x = _mod(point[0] * inverse_z)
    y = _mod(point[1] * inverse_z)
    encoded = bytearray(y.to_bytes(32, "little"))
    encoded[31] |= (x & 1) << 7
    return bytes(encoded)


def ed25519_public_key_from_seed(seed: bytes) -> bytes:
    """Derive the RFC 8032 public key for one 32-byte private seed."""

    if len(seed) != 32:
        raise ValueError("Ed25519 private seed must contain exactly 32 bytes")
    expanded = bytearray(hashlib.sha512(seed).digest())
    expanded[0] &= 248
    expanded[31] &= 63
    expanded[31] |= 64
    scalar = int.from_bytes(expanded[:32], "little")
    return _encode_point(_scalar_multiply(_BASE_POINT, scalar))


def sign_ed25519(seed: bytes, message: bytes) -> bytes:
    """Deterministically sign bytes from a 32-byte RFC 8032 private seed."""

    if len(seed) != 32:
        raise ValueError("Ed25519 private seed must contain exactly 32 bytes")
    expanded = bytearray(hashlib.sha512(seed).digest())
    expanded[0] &= 248
    expanded[31] &= 63
    expanded[31] |= 64
    scalar = int.from_bytes(expanded[:32], "little")
    public_key = _encode_point(_scalar_multiply(_BASE_POINT, scalar))
    nonce = int.from_bytes(
        hashlib.sha512(bytes(expanded[32:]) + message).digest(),
        "little",
    ) % _L
    encoded_r = _encode_point(_scalar_multiply(_BASE_POINT, nonce))
    challenge = int.from_bytes(
        hashlib.sha512(encoded_r + public_key + message).digest(),
        "little",
    ) % _L
    encoded_s = ((nonce + challenge * scalar) % _L).to_bytes(32, "little")
    return encoded_r + encoded_s


def sign_ed25519_base64(seed: bytes, message: bytes) -> str:
    """Sign bytes and return the replay's canonical padded base64."""

    return signature_bytes_to_base64(sign_ed25519(seed, message))


def sign_submission_v1(seed: bytes, envelope: dict[str, Any]) -> str:
    """Sign one RFC-010 submission envelope from a private seed."""

    return sign_ed25519_base64(seed, submission_preimage_v1(envelope))


def sign_periodic_chain_head_v1(
    seed: bytes,
    envelope: dict[str, Any],
) -> str:
    """Sign one RFC-010 periodic chain-head checkpoint."""

    return sign_ed25519_base64(seed, periodic_signature_preimage_v1(envelope))


def verify_ed25519(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """Synchronously verify a strict RFC 8032 Ed25519 signature."""

    if len(public_key) != 32 or len(signature) != 64:
        return False
    r_bytes = signature[:32]
    scalar = int.from_bytes(signature[32:], "little")
    if scalar >= _L:
        return False
    public_point = _decode_point(public_key)
    r_point = _decode_point(r_bytes)
    if (
        public_point is None
        or r_point is None
        or not _in_prime_order_subgroup(public_point)
        or not _in_prime_order_subgroup(r_point)
    ):
        return False
    challenge = int.from_bytes(
        hashlib.sha512(r_bytes + public_key + message).digest(),
        "little",
    ) % _L
    return _points_equal(
        _scalar_multiply(_BASE_POINT, scalar),
        _point_add(r_point, _scalar_multiply(public_point, challenge)),
    )


def verify_ed25519_base64(
    public_key: str,
    message: bytes,
    signature: str,
) -> bool:
    """Verify canonical base64 Ed25519 material without raising."""

    try:
        return verify_ed25519(
            signature_bytes_from_base64(public_key, "publicKey", 32),
            message,
            signature_bytes_from_base64(signature, "sig", 64),
        )
    except (TypeError, ValueError):
        return False


def _canonical_v2_preimage(domain: str, value: dict[str, Any]) -> bytes:
    from .replay import canonical_json

    return f"{domain}\n{canonical_json(value)}".encode("utf-8")


def _assert_v2_digest(value: str, label: str, allow_hex: bool = False) -> None:
    if (
        allow_hex
        and isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    ):
        return
    signature_bytes_from_base64(value, label, 32)


def submission_epoch_genesis_hash_v2(genesis: dict[str, Any]) -> str:
    """First chain head for one dynamic controller epoch."""

    _u64(genesis["epoch"], "epoch")
    for label in ("sessionId", "seat", "controllerId"):
        _utf8(genesis[label], label)
    signature_bytes_from_base64(genesis["publicKey"], "publicKey", 32)
    _assert_v2_digest(genesis["transitionDigest"], "transitionDigest", True)
    if "previousEpochDigest" in genesis:
        _assert_v2_digest(
            genesis["previousEpochDigest"],
            "previousEpochDigest",
            True,
        )
    if "previousChainHead" in genesis:
        _assert_v2_digest(genesis["previousChainHead"], "previousChainHead")
    return signature_bytes_to_base64(hashlib.sha256(_canonical_v2_preimage(
        f"{SUBMISSION_SIGNATURE_SCHEME_V2}.genesis",
        genesis,
    )).digest())


def submission_preimage_v2(envelope: dict[str, Any]) -> bytes:
    """Canonical command preimage bound to a controller epoch and revision."""

    for label in (
        "epoch",
        "transitionRevision",
        "cursor",
        "tick",
        "clientTime",
    ):
        _u64(envelope[label], label)
    for label in ("sessionId", "seat", "submissionId"):
        _utf8(envelope[label], label)
    _assert_v2_digest(envelope["prevChainHash"], "prevChainHash")
    return _canonical_v2_preimage(
        f"{SUBMISSION_SIGNATURE_SCHEME_V2}.command",
        envelope,
    )


def submission_chain_hash_v2(envelope: dict[str, Any]) -> str:
    """Hash one v2 command into the next epoch-local chain head."""

    return signature_bytes_to_base64(
        hashlib.sha256(submission_preimage_v2(envelope)).digest()
    )

def periodic_signature_preimage_v2(envelope: dict[str, Any]) -> bytes:
    """Canonical signed checkpoint of one dynamic-controller chain prefix."""

    for label in ("epoch", "tick", "clientTime"):
        _u64(envelope[label], label)
    for label in ("sessionId", "seat"):
        _utf8(envelope[label], label)
    _assert_v2_digest(envelope["chainHead"], "chainHead")
    return _canonical_v2_preimage(
        f"{SUBMISSION_SIGNATURE_SCHEME_V2}.periodic",
        envelope,
    )


def controller_handoff_preimage_v2(handoff: dict[str, Any]) -> bytes:
    """Canonical voluntary handoff preimage signed by both controllers."""

    if handoff.get("schema") != "gaos.controller-handoff.v2":
        raise TypeError("unsupported controller handoff schema")
    _u64(handoff["outgoingEpoch"], "outgoingEpoch")
    _u64(handoff["incomingEpoch"], "incomingEpoch")
    _u64(
        handoff["effectiveTransitionRevision"],
        "effectiveTransitionRevision",
    )
    if handoff["incomingEpoch"] != handoff["outgoingEpoch"] + 1:
        raise TypeError("handoff epochs must be consecutive")
    _assert_v2_digest(handoff["outgoingChainHead"], "outgoingChainHead")
    signature_bytes_from_base64(
        handoff["incomingPublicKey"],
        "incomingPublicKey",
        32,
    )
    return _canonical_v2_preimage(
        f"{SUBMISSION_SIGNATURE_SCHEME_V2}.handoff",
        handoff,
    )


def sign_submission_v2(seed: bytes, envelope: dict[str, Any]) -> str:
    """Sign one dynamic-controller submission."""

    return sign_ed25519_base64(seed, submission_preimage_v2(envelope))
