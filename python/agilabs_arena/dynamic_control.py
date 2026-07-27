"""Offline RFC-014 dynamic-controller evidence verification."""

from __future__ import annotations

import hashlib
from typing import Any

from .replay import canonical_json
from .signatures import (
    controller_handoff_preimage_v2,
    submission_chain_hash_v2,
    submission_epoch_genesis_hash_v2,
    submission_preimage_v2,
    verify_ed25519_base64,
)


DYNAMIC_CONTROL_EVIDENCE_FORMAT = "gaos.dynamic-control-evidence.v2"


def _epoch_digest(epoch: dict[str, Any]) -> str:
    value = {key: item for key, item in epoch.items() if key != "digest"}
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def verify_dynamic_control_evidence_v2(
    evidence: dict[str, Any],
) -> dict[str, Any]:
    """Verify controller history, handoffs, exact-revision keys, and chains."""

    reasons: list[str] = []
    if evidence.get("format") != DYNAMIC_CONTROL_EVIDENCE_FORMAT:
        return {
            "valid": False,
            "commandsValid": False,
            "controlHistoryValid": False,
            "epochs": [],
            "reasons": ["unsupported dynamic-control evidence format"],
        }
    control = evidence.get("control", {})
    session_id = evidence.get("sessionId")
    if session_id != control.get("sessionId"):
        reasons.append("control history belongs to a different session")
    seats = control.get("seats")
    raw_epochs = control.get("epochs")
    history: dict[str, list[dict[str, Any]]] = {}
    control_valid = (
        isinstance(session_id, str)
        and bool(session_id)
        and isinstance(seats, list)
        and len(seats) == len(set(seats))
        and isinstance(raw_epochs, list)
    )
    if control_valid:
        for seat in seats:
            epochs = sorted(
                (epoch for epoch in raw_epochs if epoch.get("seat") == seat),
                key=lambda epoch: epoch.get("epoch", -1),
            )
            if not epochs:
                reasons.append(f"missing epoch history for {seat}")
                control_valid = False
                continue
            for index, epoch in enumerate(epochs):
                previous = epochs[index - 1] if index else None
                if (
                    epoch.get("epoch") != index
                    or epoch.get("digest") != _epoch_digest(epoch)
                    or (
                        previous is not None
                        and (
                            epoch.get("previousEpochDigest")
                            != previous.get("digest")
                            or epoch.get("effectiveTransitionRevision", 0)
                            <= previous.get("effectiveTransitionRevision", 0)
                        )
                    )
                ):
                    reasons.append(f"invalid epoch continuity for {seat}")
                    control_valid = False
            history[seat] = epochs
        if any(epoch.get("seat") not in set(seats) for epoch in raw_epochs):
            reasons.append("epoch belongs to an undeclared logical seat")
            control_valid = False
    else:
        reasons.append("invalid seat-control checkpoint")

    epoch_facts: list[dict[str, Any]] = []
    for seat, epochs in history.items():
        for index, epoch in enumerate(epochs):
            fact_reasons: list[str] = []
            authorization_valid = True
            authorization = epoch.get("authorization")
            if authorization == "controller-handoff":
                previous = epochs[index - 1] if index else None
                controller = epoch.get("controller", {})
                authorization_evidence = epoch.get("authorizationEvidence", {})
                if (
                    previous is None
                    or epoch.get("status") != "occupied"
                    or not epoch.get("previousChainHead")
                    or not controller.get("publicKey")
                    or authorization_evidence.get("mode") != "controller-handoff"
                    or not previous.get("controller", {}).get("publicKey")
                ):
                    authorization_valid = False
                    fact_reasons.append(
                        "handoff is missing keys, chain head, or signatures"
                    )
                else:
                    handoff = {
                        "schema": "gaos.controller-handoff.v2",
                        "sessionId": session_id,
                        "seat": seat,
                        "outgoingEpoch": index - 1,
                        "outgoingChainHead": epoch["previousChainHead"],
                        "incomingEpoch": index,
                        "incomingControllerId": controller["controllerId"],
                        "incomingPublicKey": controller["publicKey"],
                        "effectiveTransitionRevision": epoch[
                            "effectiveTransitionRevision"
                        ],
                    }
                    preimage = controller_handoff_preimage_v2(handoff)
                    outgoing = authorization_evidence.get(
                        "outgoingSignatures", {}
                    ).get(seat)
                    incoming = authorization_evidence.get(
                        "incomingSignatures", {}
                    ).get(seat)
                    if not outgoing or not verify_ed25519_base64(
                        previous["controller"]["publicKey"],
                        preimage,
                        outgoing,
                    ):
                        authorization_valid = False
                        fact_reasons.append(
                            "outgoing handoff signature is invalid"
                        )
                    if not incoming or not verify_ed25519_base64(
                        controller["publicKey"],
                        preimage,
                        incoming,
                    ):
                        authorization_valid = False
                        fact_reasons.append(
                            "incoming handoff acceptance is invalid"
                        )
            elif (
                authorization == "host-policy"
                and epoch.get("authorizationEvidence", {}).get("mode")
                != "host-policy"
            ):
                authorization_valid = False
                fact_reasons.append(
                    "host-policy transition is not explicitly identified"
                )
            epoch_facts.append({
                "seat": seat,
                "epoch": index,
                "authorization": authorization,
                "authorizationValid": authorization_valid,
                "unsignedTail": False,
                "reasons": fact_reasons,
            })

    commands_valid = control_valid
    command_heads: dict[str, str] = {}
    command_counts: dict[str, int] = {}
    for signed in sorted(
        evidence.get("commands", []),
        key=lambda item: item.get("envelope", {}).get("cursor", -1),
    ):
        try:
            envelope = signed["envelope"]
            if envelope["sessionId"] != session_id:
                raise ValueError("signed command belongs to a different session")
            epochs = history[envelope["seat"]]
            active = next((
                epoch
                for epoch in reversed(epochs)
                if epoch["effectiveTransitionRevision"]
                <= envelope["transitionRevision"]
            ), None)
            if (
                active is None
                or active["epoch"] != envelope["epoch"]
                or active.get("status") != "occupied"
                or not active.get("controller", {}).get("publicKey")
            ):
                raise ValueError("controller epoch is inactive for logical seat")
            key = f'{active["seat"]}:{active["epoch"]}'
            genesis = {
                "sessionId": session_id,
                "seat": active["seat"],
                "epoch": active["epoch"],
                "controllerId": active["controller"]["controllerId"],
                "publicKey": active["controller"]["publicKey"],
                "transitionDigest": active["digest"],
            }
            for field in ("previousEpochDigest", "previousChainHead"):
                if field in active:
                    genesis[field] = active[field]
            expected = command_heads.get(
                key,
                submission_epoch_genesis_hash_v2(genesis),
            )
            if envelope["prevChainHash"] != expected:
                raise ValueError(
                    "signed command does not continue its epoch chain"
                )
            if not verify_ed25519_base64(
                active["controller"]["publicKey"],
                submission_preimage_v2(envelope),
                signed["signature"],
            ):
                raise ValueError("signed command signature is invalid")
            command_heads[key] = submission_chain_hash_v2(envelope)
            command_counts[key] = command_counts.get(key, 0) + 1
        except (KeyError, TypeError, ValueError) as error:
            commands_valid = False
            reasons.append(str(error))

    for fact in epoch_facts:
        key = f'{fact["seat"]}:{fact["epoch"]}'
        epochs = history[fact["seat"]]
        next_epoch = (
            epochs[fact["epoch"] + 1]
            if fact["epoch"] + 1 < len(epochs)
            else None
        )
        fact["unsignedTail"] = (
            command_counts.get(key, 0) > 0
            and next_epoch is not None
            and next_epoch.get("previousChainHead") != command_heads.get(key)
        )
        if fact["unsignedTail"]:
            fact["reasons"].append(
                "epoch has an unsigned or incompletely closed tail"
            )
        if fact["authorization"] == "host-policy":
            fact["reasons"].append(
                "epoch was authorized by declared host policy"
            )
    control_history_valid = (
        control_valid
        and all(fact["authorizationValid"] for fact in epoch_facts)
    )
    return {
        "valid": not reasons and commands_valid and control_history_valid,
        "commandsValid": commands_valid,
        "controlHistoryValid": control_history_valid,
        "epochs": epoch_facts,
        "reasons": reasons,
    }
