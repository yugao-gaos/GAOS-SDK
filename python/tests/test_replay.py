import hashlib
import json
import struct
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from agilabs_arena import (
    GAOS_REPLAY_DERIVED_SEEDS,
    GAOS_REPLAY_FORMAT_ID,
    GAOS_REPLAY_LEGACY_FORMAT_VERSION,
    GAOS_REPLAY_FORMAT_VERSION,
    ReplayFormatError,
    canonical_json,
    parse_replay_jsonl,
    run_level_seed,
    serialize_replay_jsonl,
    validate_replay_artifact,
)


FIXTURE = (
    Path(__file__).parents[2]
    / "fixtures"
    / "replay"
    / "gaos-replay-v1.golden.jsonl"
)
SCHEMA = (
    Path(__file__).parents[2]
    / "schemas"
    / "gaos.replay-v1.schema.json"
)
COMMITMENT_FIXTURE = (
    Path(__file__).parents[2]
    / "fixtures"
    / "commitment"
    / "gaos.commit.sha256.v1.vectors.json"
)


def test_commitment_vectors_match_python_framing_and_sha256():
    def frame(value):
        return struct.pack(">I", len(value)) + value

    vectors = json.loads(COMMITMENT_FIXTURE.read_text(encoding="utf-8"))
    for vector in vectors:
        binding = vector["binding"]
        preimage = b"".join([
            frame(b"gaos.commit.sha256.v1"),
            frame(binding["sessionId"].encode("utf-8")),
            frame(binding["seat"].encode("utf-8")),
            struct.pack(">Q", binding["commitmentId"]),
            struct.pack(">Q", binding["windowRef"]),
            frame(bytes.fromhex(vector["salt"])),
            frame(canonical_json(vector["payload"]).encode("utf-8")),
        ])
        assert preimage.hex() == vector["preimageHex"], vector["name"]
        assert hashlib.sha256(preimage).hexdigest() == vector["hash"], vector["name"]


def test_golden_fixture_round_trips_with_typescript_canonical_bytes():
    jsonl = FIXTURE.read_text(encoding="utf-8")
    artifact = parse_replay_jsonl(jsonl)

    assert artifact["header"]["format"] == GAOS_REPLAY_FORMAT_ID
    assert artifact["header"]["formatVersion"] == GAOS_REPLAY_LEGACY_FORMAT_VERSION
    assert artifact["header"]["seedPolicy"] == GAOS_REPLAY_DERIVED_SEEDS
    assert artifact["header"]["levels"][0]["seed"] == run_level_seed(42, 0)
    assert serialize_replay_jsonl(artifact) == jsonl


def test_golden_fixture_conforms_to_published_json_schema():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(
        parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    )


def test_v11_grouped_resolution_round_trips_and_projects_actions():
    legacy = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    header = {**legacy["header"], "formatVersion": GAOS_REPLAY_FORMAT_VERSION}
    action = legacy["actions"][0]
    replay_input = {
        key: value
        for key, value in action.items()
        if key not in ("kind", "n", "levelIndex", "tick")
    }
    resolution = {
        "kind": "resolution",
        "n": 0,
        "levelIndex": 0,
        "tick": 0,
        "inputs": [replay_input],
        "cause": "complete",
    }
    jsonl = canonical_json(header) + "\n" + canonical_json(resolution) + "\n"
    artifact = parse_replay_jsonl(jsonl)

    assert artifact["records"] == [resolution]
    assert artifact["actions"][0]["canonicalId"] == action["canonicalId"]
    assert serialize_replay_jsonl(artifact) == jsonl


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (-1.25, "-1.25"),
    ],
)
def test_canonical_numbers_match_json_stringify(value, expected):
    assert canonical_json(value) == expected


def test_validation_detects_tampering_and_foreign_formats():
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["levels"][0]["seed"] += 1
    assert "seed does not match" in "\n".join(validate_replay_artifact(artifact))

    foreign = FIXTURE.read_text(encoding="utf-8").replace(
        '"format":"gaos.replay"', '"format":"vendor.replay"'
    )
    with pytest.raises(ReplayFormatError, match=r"header\.format must be gaos\.replay"):
        parse_replay_jsonl(foreign)


def test_rejects_blank_lines_and_non_finite_extension_values():
    with pytest.raises(ReplayFormatError, match="line 2 must not be blank"):
        parse_replay_jsonl('{"kind":"header"}\n\n{"kind":"action"}\n')

    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["extensions"] = {"invalid": float("nan")}
    with pytest.raises(ReplayFormatError, match="finite"):
        serialize_replay_jsonl(artifact)
