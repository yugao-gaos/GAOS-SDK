import json
import hashlib
from pathlib import Path

from agilabs_arena.signatures import (
    controller_handoff_preimage_v2,
    periodic_signature_preimage_v2,
    sign_ed25519_base64,
    sign_submission_v2,
    submission_chain_hash_v2,
    submission_epoch_genesis_hash_v2,
    submission_preimage_v2,
    verify_ed25519_base64,
)
from agilabs_arena.dynamic_control import verify_dynamic_control_evidence_v2
from agilabs_arena.replay import canonical_json


VECTORS = json.loads(
    (
        Path(__file__).parents[2]
        / "fixtures/signatures/gaos.submission.ed25519.v2.vectors.json"
    ).read_text()
)


def test_v2_golden_vectors_match_typescript_bytes_and_signatures():
    assert (
        submission_epoch_genesis_hash_v2(VECTORS["genesis"])
        == VECTORS["genesisHash"]
    )
    command = VECTORS["command"]
    preimage = submission_preimage_v2(command["envelope"])
    assert preimage.hex() == command["preimageHex"]
    assert submission_chain_hash_v2(command["envelope"]) == command["chainHash"]
    assert verify_ed25519_base64(
        VECTORS["publicKey"],
        preimage,
        command["signature"],
    )

    handoff = VECTORS["handoff"]
    handoff_preimage = controller_handoff_preimage_v2(handoff["envelope"])
    assert handoff_preimage.hex() == handoff["preimageHex"]
    assert verify_ed25519_base64(
        VECTORS["publicKey"],
        handoff_preimage,
        handoff["outgoingSignature"],
    )


def test_python_offline_verifier_matches_the_dynamic_control_contract():
    seed = bytes.fromhex(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
    )
    public_key = VECTORS["publicKey"]
    genesis_base = {
        "seat": "alpha",
        "epoch": 0,
        "status": "occupied",
        "controller": {
            "controllerId": "human-a",
            "kind": "human",
            "publicKey": public_key,
            "signingTier": {"N": 10},
        },
        "effectiveTransitionRevision": 0,
        "reason": "genesis",
        "authorization": "genesis",
    }
    genesis_epoch = {
        **genesis_base,
        "digest": hashlib.sha256(
            canonical_json(genesis_base).encode()
        ).hexdigest(),
    }
    chain_genesis = submission_epoch_genesis_hash_v2({
        "sessionId": "offline-session",
        "seat": "alpha",
        "epoch": 0,
        "controllerId": "human-a",
        "publicKey": public_key,
        "transitionDigest": genesis_epoch["digest"],
    })
    command = {
        "sessionId": "offline-session",
        "seat": "alpha",
        "epoch": 0,
        "transitionRevision": 0,
        "submissionId": "alpha-0",
        "cursor": 0,
        "tick": 1,
        "clientTime": 1,
        "command": {"move": 1},
        "prevChainHash": chain_genesis,
    }
    chain_head = submission_chain_hash_v2(command)
    handoff = {
        "schema": "gaos.controller-handoff.v2",
        "sessionId": "offline-session",
        "seat": "alpha",
        "outgoingEpoch": 0,
        "outgoingChainHead": chain_head,
        "incomingEpoch": 1,
        "incomingControllerId": "agent-b",
        "incomingPublicKey": public_key,
        "effectiveTransitionRevision": 1,
    }
    handoff_signature = sign_ed25519_base64(
        seed,
        controller_handoff_preimage_v2(handoff),
    )
    epoch_one_base = {
        "seat": "alpha",
        "epoch": 1,
        "status": "occupied",
        "controller": {
            "controllerId": "agent-b",
            "kind": "agent",
            "publicKey": public_key,
            "signingTier": {"N": 10},
        },
        "effectiveTransitionRevision": 1,
        "reason": "transferred",
        "authorization": "controller-handoff",
        "authorizationEvidence": {
            "mode": "controller-handoff",
            "outgoingSignatures": {"alpha": handoff_signature},
            "incomingSignatures": {"alpha": handoff_signature},
        },
        "previousEpochDigest": genesis_epoch["digest"],
        "previousChainHead": chain_head,
    }
    epoch_one = {
        **epoch_one_base,
        "digest": hashlib.sha256(
            canonical_json(epoch_one_base).encode()
        ).hexdigest(),
    }
    epoch_one_genesis = submission_epoch_genesis_hash_v2({
        "sessionId": "offline-session",
        "seat": "alpha",
        "epoch": 1,
        "controllerId": "agent-b",
        "publicKey": public_key,
        "transitionDigest": epoch_one["digest"],
        "previousEpochDigest": genesis_epoch["digest"],
        "previousChainHead": chain_head,
    })
    result = verify_dynamic_control_evidence_v2({
        "format": "gaos.dynamic-control-evidence.v2",
        "sessionId": "offline-session",
        "checkpoint": {
            "format": "gaos.dynamic-control-checkpoint.v2",
            "sessionId": "offline-session",
            "control": {
                "format": "gaos.seat-control",
                "formatVersion": "1.0",
                "sessionId": "offline-session",
                "transitionRevision": 1,
                "seats": ["alpha"],
                "epochs": [genesis_epoch, epoch_one],
            },
            "signatureStates": [{
                "seat": "alpha",
                "epoch": 0,
                "genesisHash": chain_genesis,
                "lastChainHead": chain_head,
                "lastSignedChainHead": chain_head,
                "lastPeriodicTick": 1,
                "lastPeriodicClientTime": 1,
                "lastPeriodicSignature": sign_ed25519_base64(
                    seed,
                    periodic_signature_preimage_v2({
                        "sessionId": "offline-session",
                        "seat": "alpha",
                        "epoch": 0,
                        "tick": 1,
                        "clientTime": 1,
                        "chainHead": chain_head,
                    }),
                ),
            }, {
                "seat": "alpha",
                "epoch": 1,
                "genesisHash": epoch_one_genesis,
                "lastChainHead": epoch_one_genesis,
            }],
        },
        "commands": [{
            "envelope": command,
            "signature": sign_submission_v2(seed, command),
        }],
    })
    assert result["valid"]
    assert result["commandsValid"]
    assert result["controlHistoryValid"]
    assert result["epochs"][1]["authorizationValid"]
    sign_ed25519_base64,
    sign_submission_v2,
