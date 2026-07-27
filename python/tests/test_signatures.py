import json
from pathlib import Path

from jsonschema import Draft202012Validator

from agilabs_arena import (
    GAOS_REPLAY_FORMAT_VERSION,
    GAOS_REPLAY_SIGNED_FORMAT_VERSION,
    SUBMISSION_SIGNATURE_ALGORITHM,
    SUBMISSION_SIGNATURE_SCHEME,
    canonical_json,
    ed25519_public_key_from_seed,
    sign_ed25519,
    sign_submission_v1,
    signature_bytes_to_base64,
    submission_chain_hash_v1,
    submission_genesis_hash_v1,
    submission_preimage_v1,
    submission_roster_hash_v1,
    recheck_replay_signatures,
    validate_replay_artifact,
    verify_ed25519,
    verify_ed25519_base64,
)
from agilabs_arena.verify import verify_replay


def test_rfc_8032_vectors() -> None:
    vectors = [
        (
            "d75a980182b10ab7d54bfed3c964073a"
            "0ee172f3daa62325af021a68f707511a",
            "",
            "e5564300c360ac729086e2cc806e828a"
            "84877f1eb8e5d974d873e06522490155"
            "5fb8821590a33bacc61e39701cf9b46b"
            "d25bf5f0595bbe24655141438e7a100b",
        ),
        (
            "3d4017c3e843895a92b70aa74d1b7ebc"
            "9c982ccf2ec4968cc0cd55f12af4660c",
            "72",
            "92a009a9f0d4cab8720e820b5f642540"
            "a2b27b5416503f8fb3762223ebdb69da"
            "085ac1e43e15996e458f3613d0f11d8c"
            "387b2eaeb4302aeeb00d291612bb0c00",
        ),
    ]
    for public_key, message, signature in vectors:
        assert verify_ed25519(
            bytes.fromhex(public_key),
            bytes.fromhex(message),
            bytes.fromhex(signature),
        )
        tampered = bytearray.fromhex(signature)
        tampered[0] ^= 1
        assert not verify_ed25519(
            bytes.fromhex(public_key),
            bytes.fromhex(message),
            bytes(tampered),
        )
    seed = bytes.fromhex(
        "9d61b19deffd5a60ba844af492ec2cc4"
        "4449c5697b326919703bac031cae7f60"
    )
    assert ed25519_public_key_from_seed(seed).hex() == vectors[0][0]
    assert sign_ed25519(seed, b"").hex() == vectors[0][2]
    assert not verify_ed25519(
        bytes([1, *([0] * 31)]),
        b"",
        bytes(64),
    )


def test_framing_and_roster_are_deterministic() -> None:
    public_key = signature_bytes_to_base64(bytes(range(32)))
    seats = [
        {
            "id": "zulu",
            "publicKey": public_key,
            "alg": SUBMISSION_SIGNATURE_ALGORITHM,
            "signingTier": {"N": 100},
        },
        {
            "id": "alpha",
            "publicKey": public_key,
            "alg": SUBMISSION_SIGNATURE_ALGORITHM,
            "signingTier": {"N": 10},
        },
    ]
    roster_hash = submission_roster_hash_v1(seats)
    assert submission_roster_hash_v1(list(reversed(seats))) == roster_hash
    genesis = submission_genesis_hash_v1("session-1", "alpha", roster_hash)
    envelope = {
        "sessionId": "session-1",
        "seat": "alpha",
        "submissionId": "alpha-1",
        "cursor": 0,
        "tick": 0,
        "clientTime": 1_785_032_000_000,
        "command": {"move": "😀", "amount": 1},
        "prevChainHash": genesis,
    }
    reordered = {**envelope, "command": {"amount": 1, "move": "😀"}}
    assert submission_preimage_v1(envelope) == submission_preimage_v1(reordered)
    assert submission_chain_hash_v1(envelope) != genesis
    assert (
        submission_genesis_hash_v1("session-2", "alpha", roster_hash)
        != genesis
    )


def test_published_submission_vectors_match_typescript() -> None:
    fixture = json.loads((
        Path(__file__).parents[2]
        / "fixtures"
        / "signatures"
        / "gaos.submission.ed25519.v1.vectors.json"
    ).read_text(encoding="utf-8"))
    assert submission_roster_hash_v1(fixture["roster"]) == fixture["rosterHash"]
    for vector in fixture["vectors"]:
        preimage = submission_preimage_v1(vector["envelope"])
        assert preimage.hex() == vector["preimageHex"]
        assert submission_chain_hash_v1(vector["envelope"]) == vector["chainHash"]
        assert verify_ed25519_base64(
            vector["publicKey"],
            preimage,
            vector["signature"],
        )
        assert sign_submission_v1(
            bytes.fromhex(
                "9d61b19deffd5a60ba844af492ec2cc4"
                "4449c5697b326919703bac031cae7f60"
            ),
            vector["envelope"],
        ) == vector["signature"]


def test_signed_v12_artifact_rechecks_cross_runtime_vectors() -> None:
    fixture = json.loads((
        Path(__file__).parents[2]
        / "fixtures"
        / "signatures"
        / "gaos.submission.ed25519.v1.vectors.json"
    ).read_text(encoding="utf-8"))
    actions = []
    records = []
    for index, vector in enumerate(fixture["vectors"]):
        envelope = vector["envelope"]
        replay_input = {
            "wireId": "Action 1",
            "canonicalId": "Action 1",
            "payload": {"vector": index},
            "seat": envelope["seat"],
            "submissionId": envelope["submissionId"],
            "canonicalCommand": canonical_json(envelope["command"]),
            "cursor": envelope["cursor"],
            "clientTime": envelope["clientTime"],
            "prevChainHash": envelope["prevChainHash"],
            "sig": vector["signature"],
        }
        actions.append({
            "kind": "action",
            "n": index,
            "levelIndex": 0,
            "tick": envelope["tick"],
            **replay_input,
        })
        records.append({
            "kind": "resolution",
            "n": index,
            "levelIndex": 0,
            "tick": envelope["tick"],
            "inputs": [replay_input],
            "cause": "complete",
        })
    artifact = {
        "header": {
            "kind": "header",
            "format": "gaos.replay",
            "formatVersion": GAOS_REPLAY_FORMAT_VERSION,
            "sessionId": "vector-session",
            "game": {
                "id": "signature-vectors",
                "version": "1",
                "adapter": {"id": "signature-vectors", "version": "1"},
            },
            "seed": 1,
            "seedPolicy": "explicit",
            "perm": [0],
            "levels": [{
                "index": 0,
                "id": "one",
                "seed": 1,
                "level": {},
                "result": {
                    "status": "won",
                    "stars": 1,
                    "actionsUsed": 3,
                },
            }],
            "totals": {"totalStars": 1, "totalActionsUsed": 3},
            "seatKeys": fixture["roster"],
            "signaturePolicy": {"scheme": SUBMISSION_SIGNATURE_SCHEME},
        },
        "actions": actions,
        "records": records,
    }
    assert validate_replay_artifact(artifact) == []
    schema = json.loads((
        Path(__file__).parents[2]
        / "schemas"
        / "gaos.replay-v1.schema.json"
    ).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(artifact)
    checked = recheck_replay_signatures(artifact)
    assert checked["state"] == "signed"
    assert checked["problems"] == []
    v12 = json.loads(json.dumps(artifact))
    v12["header"]["formatVersion"] = GAOS_REPLAY_SIGNED_FORMAT_VERSION
    assert validate_replay_artifact(v12) == []
    assert recheck_replay_signatures(v12)["state"] == "signed"
    assert verify_replay(
        artifact,
        lambda _: {"ok": True, "problems": []},
    )["verdict"] == "unverifiable"
    assert verify_replay(
        artifact,
        lambda _: {
            "ok": True,
            "problems": [],
            "semantics": {
                "submissions": "verified",
                "timeouts": "not_applicable",
                "problems": [],
            },
        },
    )["verdict"] == "trusted"
    assert verify_replay(
        artifact,
        lambda _: {
            "ok": True,
            "problems": [],
            "semantics": {
                "submissions": "failed",
                "timeouts": "not_applicable",
                "problems": ["mapped action differs"],
            },
        },
    )["verdict"] == "rejected"

    legacy_submission = json.loads(json.dumps(artifact))
    for candidate in (
        legacy_submission["actions"][0],
        legacy_submission["records"][0]["inputs"][0],
    ):
        candidate.pop("clientTime")
        candidate.pop("prevChainHash")
        candidate.pop("sig")
    assert validate_replay_artifact(legacy_submission) == []
    Draft202012Validator(schema).validate(legacy_submission)
    assert recheck_replay_signatures(legacy_submission)["state"] == "partial"

    tampered = json.loads(json.dumps(artifact))
    tampered["records"][1]["inputs"][0]["canonicalCommand"] = '{"other":1}'
    assert recheck_replay_signatures(tampered)["state"] == "partial"


def test_signed_interest_record_is_tier_two_chain_material() -> None:
    seed = bytes.fromhex(
        "9d61b19deffd5a60ba844af492ec2cc4"
        "4449c5697b326919703bac031cae7f60"
    )
    public_key = signature_bytes_to_base64(ed25519_public_key_from_seed(seed))
    roster = [{
        "id": "alpha",
        "publicKey": public_key,
        "alg": SUBMISSION_SIGNATURE_ALGORITHM,
        "signingTier": {"N": 10},
    }]
    declaration = {"entityIds": ["entity-3"]}
    command = {
        "kind": "interest",
        "scopeId": "phone",
        "declaration": declaration,
    }
    envelope = {
        "sessionId": "interest-session",
        "seat": "alpha",
        "submissionId": "interest-1",
        "cursor": 0,
        "tick": 0,
        "clientTime": 1,
        "command": command,
        "prevChainHash": submission_genesis_hash_v1(
            "interest-session",
            "alpha",
            submission_roster_hash_v1(roster),
        ),
    }
    artifact = {
        "header": {
            "kind": "header",
            "format": "gaos.replay",
            "formatVersion": GAOS_REPLAY_FORMAT_VERSION,
            "sessionId": "interest-session",
            "game": {
                "id": "interest",
                "version": "1",
                "adapter": {"id": "interest", "version": "1"},
            },
            "seed": 1,
            "seedPolicy": "explicit",
            "perm": [],
            "levels": [{
                "index": 0,
                "id": "one",
                "seed": 1,
                "level": {},
                "result": {"status": "won", "stars": 0, "actionsUsed": 0},
            }],
            "totals": {"totalStars": 0, "totalActionsUsed": 0},
            "seatKeys": roster,
            "signaturePolicy": {"scheme": SUBMISSION_SIGNATURE_SCHEME},
        },
        "actions": [],
        "records": [{
            "kind": "interest",
            "n": 0,
            "levelIndex": 0,
            "tick": 0,
            "cursor": 0,
            "participantId": "alpha",
            "submissionId": "interest-1",
            "scopeId": "phone",
            "declaration": declaration,
            "canonicalCommand": canonical_json(command),
            "clientTime": 1,
            "prevChainHash": envelope["prevChainHash"],
            "sig": sign_submission_v1(seed, envelope),
        }],
    }
    assert validate_replay_artifact(artifact) == []
    schema = json.loads((
        Path(__file__).parents[2]
        / "schemas"
        / "gaos.replay-v1.schema.json"
    ).read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(artifact)
    assert recheck_replay_signatures(artifact)["state"] == "signed"
    stripped = json.loads(json.dumps(artifact))
    stripped["records"][0].pop("sig")
    assert any(
        "requires clientTime, prevChainHash, and sig" in problem
        for problem in validate_replay_artifact(stripped)
    )
