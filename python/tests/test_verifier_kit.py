import copy

import pytest

from agilabs_arena.verifier_kit import (
    VERIFIER_KIT_MEDIA_TYPE,
    parse_verifier_kit_manifest,
    parse_verifier_reference,
    verifier_reference_from_replay,
)


def manifest():
    return {
        "schema": "gaos.verifier-kit.v1",
        "game": {"id": "creator/demo", "version": "1.0.0"},
        "adapter": {
            "id": "creator/demo",
            "version": "1.0.0",
            "entrypoint": "adapter.bundle.mjs",
        },
        "runtime": {
            "kind": "node-esm",
            "gaosVersion": "0.25.0",
            "nodeRange": ">=20.3",
        },
        "replayFormats": ["gaos.replay@1.3"],
        "files": [{
            "path": "adapter.bundle.mjs",
            "size": 1,
            "digest": "sha256:" + "0" * 64,
        }],
    }


def reference():
    return {
        "schema": "gaos.verifier-reference.v1",
        "digest": "sha256:" + "1" * 64,
        "mediaType": VERIFIER_KIT_MEDIA_TYPE,
        "size": 2048,
        "mirrors": ["https://example.invalid/demo.gaos-verifier"],
    }


def test_python_parses_verifier_manifest_and_reference():
    assert parse_verifier_kit_manifest(manifest()) == manifest()
    assert parse_verifier_reference(reference()) == reference()
    artifact = {"header": {"extensions": {"gaos.verifier": reference()}}}
    assert verifier_reference_from_replay(artifact) == reference()
    assert verifier_reference_from_replay({"header": {}}) is None


def test_python_rejects_traversal_and_self_declared_shape_changes():
    invalid = copy.deepcopy(manifest())
    invalid["files"][0]["path"] = "../adapter.bundle.mjs"
    with pytest.raises(ValueError, match="paths"):
        parse_verifier_kit_manifest(invalid)

    invalid_reference = reference()
    invalid_reference["trusted"] = True
    with pytest.raises(ValueError, match="unknown or missing"):
        parse_verifier_reference(invalid_reference)
