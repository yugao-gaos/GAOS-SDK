import copy
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
    GAOS_REPLAY_UNSIGNED_FORMAT_VERSION,
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
ENDED_FIXTURE = (
    Path(__file__).parents[2]
    / "fixtures"
    / "replay"
    / "gaos-replay-v1.3-ended.golden.jsonl"
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

def test_v13_ended_fixture_round_trips_and_conforms_to_schema():
    jsonl = ENDED_FIXTURE.read_text(encoding="utf-8")
    artifact = parse_replay_jsonl(jsonl)

    assert artifact["header"]["formatVersion"] == GAOS_REPLAY_FORMAT_VERSION
    assert artifact["header"]["levels"][0]["result"] == {
        "status": "ended",
        "stars": None,
        "actionsUsed": 1,
    }
    assert validate_replay_artifact(artifact) == []
    assert serialize_replay_jsonl(artifact) == jsonl

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(artifact)

    legacy = copy.deepcopy(artifact)
    legacy["header"]["formatVersion"] = GAOS_REPLAY_UNSIGNED_FORMAT_VERSION
    assert any(
        "result.status must be won or failed" in problem
        for problem in validate_replay_artifact(legacy)
    )


def test_v11_grouped_resolution_round_trips_and_projects_actions():
    legacy = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    header = {**legacy["header"], "formatVersion": GAOS_REPLAY_UNSIGNED_FORMAT_VERSION}
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
    ("input_patch", "cause", "expected"),
    [
        (
            {"wireId": "Action 3", "canonicalId": "Action 3"},
            "complete",
            "must be within Action 1..2",
        ),
        (
            {"verifiedPayload": {"amount": 1}},
            "complete",
            "verifiedPayload requires reveal",
        ),
        ({}, "timeout", "timeout cause requires systemInput"),
    ],
)
def test_v11_grouped_resolution_rejects_malformed_inputs(
    input_patch, cause, expected
):
    legacy = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    header = {**legacy["header"], "formatVersion": GAOS_REPLAY_UNSIGNED_FORMAT_VERSION}
    source = legacy["actions"][0]
    replay_input = {
        key: value
        for key, value in source.items()
        if key not in ("kind", "n", "levelIndex", "tick")
    }
    replay_input.update(input_patch)
    resolution = {
        "kind": "resolution",
        "n": 0,
        "levelIndex": 0,
        "tick": 0,
        "inputs": [replay_input],
        "cause": cause,
    }
    jsonl = canonical_json(header) + "\n" + canonical_json(resolution) + "\n"

    with pytest.raises(ReplayFormatError, match=expected):
        parse_replay_jsonl(jsonl)


def test_v11_records_and_actions_must_have_an_exact_projection():
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["formatVersion"] = GAOS_REPLAY_UNSIGNED_FORMAT_VERSION
    artifact["records"] = []

    problems = "\n".join(validate_replay_artifact(artifact))
    assert "actions must exactly match the projection of records" in problems
    with pytest.raises(ReplayFormatError, match="exactly match"):
        serialize_replay_jsonl(artifact)


def test_schema_rejects_v11_commitment_and_timeout_shape_errors():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    legacy = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact = {
        "header": {
            **legacy["header"],
            "formatVersion": GAOS_REPLAY_UNSIGNED_FORMAT_VERSION,
        },
        "actions": [{
            **legacy["actions"][0],
            "verifiedPayload": {"amount": 1},
        }],
        "records": [{
            "kind": "resolution",
            "n": 0,
            "levelIndex": 0,
            "tick": 0,
            "inputs": [],
            "cause": "timeout",
        }],
    }

    errors = list(validator.iter_errors(artifact))
    assert errors
    assert any(error.absolute_path for error in errors)

    legacy_with_commitment = parse_replay_jsonl(
        FIXTURE.read_text(encoding="utf-8")
    )
    legacy_with_commitment["actions"][0]["commit"] = {
        "commitmentId": 0,
        "scheme": "gaos.commit.sha256.v1",
        "hash": "00" * 32,
    }
    assert list(validator.iter_errors(legacy_with_commitment))


def test_rfc010_reservation_slots_round_trip_without_v11_semantics():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["formatVersion"] = GAOS_REPLAY_UNSIGNED_FORMAT_VERSION
    artifact["header"]["seatKeys"] = [{
        "id": "red",
        "publicKey": "reserved-key",
        "alg": "reserved-algorithm",
    }]
    artifact["header"]["signaturePolicy"] = {"scheme": "reserved", "N": 8}
    artifact["header"]["timeoutPolicy"] = {"mode": "ticks", "maximum": 90}
    artifact["actions"][0].update({
        "submissionId": "reserved-submission",
        "canonicalCommand": '{"move":1}',
        "cursor": 0,
        "clientTime": 1_785_032_000_000,
        "prevChainHash": "reserved-chain-link",
        "sig": "reserved-signature",
    })

    assert validate_replay_artifact(artifact) == []
    validator.validate(artifact)
    assert parse_replay_jsonl(serialize_replay_jsonl(artifact)) == artifact

    periodic = copy.deepcopy(artifact)
    periodic["actions"] = []
    periodic["records"] = [{
        "kind": "seat-signature",
        "n": 0,
        "levelIndex": 0,
        "tick": 12,
        "participantId": "red",
        "clientTime": 1_785_032_000_000,
        "prevChainHash": "reserved-chain-link",
        "sig": "reserved-periodic-signature",
        "hostTime": 1_785_032_000_100,
    }]
    assert validate_replay_artifact(periodic) == []
    validator.validate(periodic)
    assert parse_replay_jsonl(serialize_replay_jsonl(periodic)) == periodic

    artifact["header"]["formatVersion"] = GAOS_REPLAY_LEGACY_FORMAT_VERSION
    assert validate_replay_artifact(artifact)
    assert list(validator.iter_errors(artifact))


def test_python_validator_matches_json_integer_numbers_and_reports_safely():
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["formatVersion"] = GAOS_REPLAY_UNSIGNED_FORMAT_VERSION
    artifact["actions"] = []
    artifact["records"] = [{
        "kind": "seat-signature",
        "n": 0.0,
        "levelIndex": 0.0,
        "tick": 0.0,
        "participantId": "red",
    }]
    assert validate_replay_artifact(artifact) == []

    artifact["records"][0]["kind"] = []
    problems = validate_replay_artifact(artifact)
    assert any("unknown kind" in problem for problem in problems)

    artifact["records"][0]["kind"] = "\ud800"
    encoded = json.dumps(
        validate_replay_artifact(artifact),
        ensure_ascii=False,
    ).encode("utf-8")
    assert encoded


def test_timeout_participant_id_is_required_even_when_null_is_allowed():
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["formatVersion"] = GAOS_REPLAY_UNSIGNED_FORMAT_VERSION
    artifact["actions"] = []
    artifact["records"] = [{
        "kind": "timeout",
        "n": 0,
        "levelIndex": 0,
        "tick": 0,
        "timeoutId": "turn-0",
        "windowRef": 0,
        "participantId": None,
        "reason": "elapsed",
    }]
    assert validate_replay_artifact(artifact) == []

    del artifact["records"][0]["participantId"]
    assert (
        "timeout 0 participantId must be null or a non-empty string"
        in validate_replay_artifact(artifact)
    )


def test_validators_require_extension_slots_to_be_objects():
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["extensions"] = []
    artifact["header"]["totals"]["extensions"] = []
    artifact["header"]["levels"][0]["extensions"] = []
    artifact["header"]["levels"][0]["result"]["extensions"] = []

    problems = "\n".join(validate_replay_artifact(artifact))
    assert "header.extensions must be an object" in problems
    assert "header.totals.extensions must be an object" in problems
    assert "level 0 extensions must be an object" in problems
    assert "level 0 result.extensions must be an object" in problems


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (-1.25, "-1.25"),
    ],
)
def test_canonical_numbers_match_json_stringify(value, expected):
    assert canonical_json(value) == expected


@pytest.mark.parametrize(
    "literal",
    [
        "9007199254740993",
        "1000000000000000000000",
        "-9007199254740993",
        "1e20",
        "1e21",
    ],
)
def test_rejects_integer_literals_outside_the_javascript_safe_range(literal):
    value = json.loads('{"value":' + literal + "}")
    with pytest.raises(TypeError, match="JavaScript safe range"):
        canonical_json(value)


@pytest.mark.parametrize(
    "value",
    [
        "\ud800",
        "\udfff",
        {"\ud800": True},
    ],
)
def test_rejects_unpaired_surrogates(value):
    with pytest.raises(TypeError, match="unpaired surrogates"):
        canonical_json(value)


def test_accepts_equivalent_scalar_and_surrogate_pair_strings():
    scalar = "\U0001f600"
    surrogate_pair = "\ud83d\ude00"
    assert canonical_json(scalar) == canonical_json(surrogate_pair)


def test_validation_detects_tampering_and_foreign_formats():
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["levels"][0]["seed"] += 1
    assert "seed does not match" in "\n".join(validate_replay_artifact(artifact))

    foreign = FIXTURE.read_text(encoding="utf-8").replace(
        '"format":"gaos.replay"', '"format":"vendor.replay"'
    )
    with pytest.raises(ReplayFormatError, match=r"header\.format must be gaos\.replay"):
        parse_replay_jsonl(foreign)


@pytest.mark.parametrize(
    ("mutation", "expected"),
    [
        (lambda value: value.update({"foreign": True}), "artifact has unknown property foreign"),
        (
            lambda value: value["header"].update({"foreign": True}),
            "header has unknown property foreign",
        ),
        (
            lambda value: value["header"]["game"].update({"foreign": True}),
            "header.game has unknown property foreign",
        ),
        (
            lambda value: value["header"]["levels"][0].update({"foreign": True}),
            "level 0 has unknown property foreign",
        ),
        (
            lambda value: value["actions"][0].update({"foreign": True}),
            "action 0 has unknown property foreign",
        ),
        (
            lambda value: value["header"]["levels"][0]["result"].pop("stars"),
            "result.stars must be a finite number or null",
        ),
        (
            lambda value: value["actions"][0].update({"commit": None}),
            "invalid commitment envelope",
        ),
        (
            lambda value: value["header"].update({"visibility": None}),
            "header.visibility must be full or seat:<id>",
        ),
    ],
)
def test_python_validator_matches_strict_unknown_and_null_semantics(
    mutation, expected
):
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    mutation(artifact)
    assert expected in "\n".join(validate_replay_artifact(artifact))


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value["header"]["levels"][0].update({"index": False}),
        lambda value: value["actions"][0].update({"n": False}),
    ],
)
def test_python_rejects_boolean_sequence_numbers(mutation):
    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    mutation(artifact)
    assert validate_replay_artifact(artifact)


def test_python_rejects_boolean_v11_record_sequence_number():
    legacy = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    header = {**legacy["header"], "formatVersion": GAOS_REPLAY_UNSIGNED_FORMAT_VERSION}
    replay_input = {
        key: value
        for key, value in legacy["actions"][0].items()
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
    artifact = parse_replay_jsonl(
        canonical_json(header) + "\n" + canonical_json(resolution) + "\n"
    )
    artifact["records"][0]["n"] = False
    assert "must declare sequence number 0" in "\n".join(
        validate_replay_artifact(artifact)
    )


def test_rejects_blank_lines_and_non_finite_extension_values():
    with pytest.raises(ReplayFormatError, match="line 2 must not be blank"):
        parse_replay_jsonl('{"kind":"header"}\n\n{"kind":"action"}\n')

    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["extensions"] = {"invalid": float("nan")}
    with pytest.raises(ReplayFormatError, match="finite"):
        serialize_replay_jsonl(artifact)

    artifact = parse_replay_jsonl(FIXTURE.read_text(encoding="utf-8"))
    artifact["header"]["levels"][0]["level"]["goal"] = 1e20
    with pytest.raises(ReplayFormatError, match="JavaScript safe range"):
        serialize_replay_jsonl(artifact)

    surrogate_jsonl = FIXTURE.read_text(encoding="utf-8").replace(
        '"sessionId":"run-42"',
        '"sessionId":"\\ud800"',
    )
    with pytest.raises(ReplayFormatError, match="unpaired surrogates"):
        parse_replay_jsonl(surrogate_jsonl)
