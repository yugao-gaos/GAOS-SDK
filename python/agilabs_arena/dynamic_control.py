"""Offline RFC-014 dynamic-controller evidence verification."""

from __future__ import annotations

import hashlib
from typing import Any

from .replay import canonical_json
from .signatures import (
    controller_handoff_preimage_v2,
    periodic_signature_preimage_v2,
    signature_bytes_from_base64,
    submission_chain_hash_v2,
    submission_epoch_genesis_hash_v2,
    submission_preimage_v2,
    verify_ed25519_base64,
)


DYNAMIC_CONTROL_EVIDENCE_FORMAT = "gaos.dynamic-control-evidence.v2"


def _epoch_digest(epoch: dict[str, Any]) -> str:
    value = {key: item for key, item in epoch.items() if key != "digest"}
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()

def _verify_periodic(
    public_key: str,
    envelope: dict[str, Any],
    signature: str,
) -> bool:
    try:
        return verify_ed25519_base64(
            public_key,
            periodic_signature_preimage_v2(envelope),
            signature,
        )
    except (KeyError, TypeError, ValueError):
        return False


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
    checkpoint = evidence.get("checkpoint", {})
    control = checkpoint.get("control", {})
    session_id = evidence.get("sessionId")
    if (
        checkpoint.get("format") != "gaos.dynamic-control-checkpoint.v2"
        or checkpoint.get("sessionId") != session_id
    ):
        reasons.append("invalid dynamic-control checkpoint")
    if session_id != control.get("sessionId"):
        reasons.append("control history belongs to a different session")
    seats = control.get("seats")
    raw_epochs = control.get("epochs")
    history: dict[str, list[dict[str, Any]]] = {}
    transition_revision = control.get("transitionRevision")
    control_valid = (
        control.get("format") == "gaos.seat-control"
        and control.get("formatVersion") == "1.0"
        and
        isinstance(session_id, str)
        and bool(session_id)
        and isinstance(seats, list)
        and bool(seats)
        and all(isinstance(seat, str) and seat for seat in seats)
        and len(seats) == len(set(seats))
        and isinstance(raw_epochs, list)
        and isinstance(transition_revision, int)
        and not isinstance(transition_revision, bool)
        and transition_revision >= 0
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
                    or epoch.get("status") not in ("occupied", "vacant")
                    or (
                        epoch.get("status") == "occupied"
                        and (
                            not isinstance(epoch.get("controller"), dict)
                            or not epoch["controller"].get("controllerId")
                            or epoch["controller"].get("kind")
                            not in ("human", "agent", "service")
                            or (
                                "publicKey" in epoch["controller"]
                                and not _valid_public_key(
                                    epoch["controller"]["publicKey"]
                                )
                            )
                            or (
                                "signingTier" in epoch["controller"]
                                and not _valid_signing_tier(
                                    epoch["controller"]["signingTier"]
                                )
                            )
                        )
                    )
                    or (
                        epoch.get("status") == "vacant"
                        and "controller" in epoch
                    )
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
                if index == 0 and (
                    epoch.get("reason") != "genesis"
                    or epoch.get("authorization") != "genesis"
                    or epoch.get("effectiveTransitionRevision") != 0
                    or "previousEpochDigest" in epoch
                    or "previousChainHead" in epoch
                    or "authorizationEvidence" in epoch
                ):
                    reasons.append(f"invalid genesis epoch for {seat}")
                    control_valid = False
                if index > 0:
                    authorization = epoch.get("authorizationEvidence", {})
                    mode = epoch.get("authorization")
                    invalid_handoff = (
                        mode == "controller-handoff"
                        and (
                            authorization.get("mode") != mode
                            or not authorization.get(
                                "outgoingSignatures", {}
                            ).get(seat)
                            or (
                                epoch.get("status") == "occupied"
                                and not authorization.get(
                                    "incomingSignatures", {}
                                ).get(seat)
                            )
                            or not epoch.get("previousChainHead")
                        )
                    )
                    invalid_policy = (
                        mode == "host-policy"
                        and (
                            authorization.get("mode") != mode
                            or not isinstance(
                                authorization.get("policy"), str
                            )
                            or not authorization["policy"]
                        )
                    )
                    if (
                        epoch.get("reason") in ("genesis", "reconnected")
                        or mode not in ("controller-handoff", "host-policy")
                        or invalid_handoff
                        or invalid_policy
                    ):
                        reasons.append(
                            f"invalid epoch authorization for {seat}"
                        )
                        control_valid = False
            history[seat] = epochs
        if any(epoch.get("seat") not in set(seats) for epoch in raw_epochs):
            reasons.append("epoch belongs to an undeclared logical seat")
            control_valid = False
        revisions = {
            epoch.get("effectiveTransitionRevision")
            for epoch in raw_epochs
            if epoch.get("effectiveTransitionRevision", 0) > 0
        }
        if revisions != set(range(1, transition_revision + 1)):
            reasons.append("seat-control transition revisions are incomplete")
            control_valid = False
        for revision in revisions:
            atomic = [
                epoch for epoch in raw_epochs
                if epoch.get("effectiveTransitionRevision") == revision
            ]
            if len({
                canonical_json({
                    "authorization": epoch.get("authorization"),
                    "evidence": epoch.get("authorizationEvidence"),
                })
                for epoch in atomic
            }) != 1:
                reasons.append(
                    f"conflicting atomic authorization at revision {revision}"
                )
                control_valid = False
        prepared = control.get("prepared", [])
        if not isinstance(prepared, list) or len(prepared) > 1:
            reasons.append(
                "checkpoint may contain at most one prepared transition"
            )
            control_valid = False
        elif prepared:
            pending = prepared[0]
            pending_epochs = pending.get("epochs")
            if (
                pending.get("baseTransitionRevision") != transition_revision
                or pending.get("nextTransitionRevision")
                != transition_revision + 1
                or not isinstance(pending_epochs, list)
                or not pending_epochs
                or len({epoch.get("seat") for epoch in pending_epochs})
                != len(pending_epochs)
            ):
                reasons.append("invalid prepared seat-control transition")
                control_valid = False
            else:
                for epoch in pending_epochs:
                    prior = history.get(epoch.get("seat"), [])
                    previous = prior[-1] if prior else None
                    authorization = epoch.get("authorizationEvidence", {})
                    mode = epoch.get("authorization")
                    valid_status = (
                        epoch.get("status") == "vacant"
                        and "controller" not in epoch
                    ) or (
                        epoch.get("status") == "occupied"
                        and isinstance(epoch.get("controller"), dict)
                        and bool(epoch["controller"].get("controllerId"))
                        and epoch["controller"].get("kind")
                        in ("human", "agent", "service")
                        and _valid_public_key(
                            epoch["controller"].get("publicKey")
                        )
                        and _valid_signing_tier(
                            epoch["controller"].get("signingTier")
                        )
                    )
                    valid_auth = (
                        mode == "host-policy"
                        and authorization.get("mode") == mode
                        and bool(authorization.get("policy"))
                    ) or (
                        mode == "controller-handoff"
                        and authorization.get("mode") == mode
                        and bool(authorization.get(
                            "outgoingSignatures", {}
                        ).get(epoch.get("seat")))
                        and (
                            epoch.get("status") == "vacant"
                            or bool(authorization.get(
                                "incomingSignatures", {}
                            ).get(epoch.get("seat")))
                        )
                        and bool(epoch.get("previousChainHead"))
                    )
                    if (
                        previous is None
                        or epoch.get("epoch") != previous.get("epoch") + 1
                        or epoch.get("effectiveTransitionRevision")
                        != transition_revision + 1
                        or epoch.get("previousEpochDigest")
                        != previous.get("digest")
                        or epoch.get("digest") != _epoch_digest(epoch)
                        or epoch.get("reason") in ("genesis", "reconnected")
                        or not valid_status
                        or not valid_auth
                    ):
                        reasons.append(
                            f"invalid prepared epoch for {epoch.get('seat')}"
                        )
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
    reconstructed_heads: dict[str, set[str]] = {}
    command_counts: dict[str, int] = {}
    signature_states: dict[str, dict[str, Any]] = {}
    raw_states = checkpoint.get("signatureStates")
    if not isinstance(raw_states, list):
        reasons.append("signatureStates must be an array")
        commands_valid = False
        raw_states = []
    for state in raw_states:
        key = f'{state.get("seat")}:{state.get("epoch")}'
        if key in signature_states:
            reasons.append(f"duplicate signature state for {key}")
            commands_valid = False
        signature_states[key] = state
    expected_keys: set[str] = set()
    for seat, epochs in history.items():
        for epoch in epochs:
            key = f'{seat}:{epoch["epoch"]}'
            expected_keys.add(key)
            state = signature_states.get(key)
            if (
                epoch.get("status") == "occupied"
                and (
                    not epoch.get("controller", {}).get("publicKey")
                    or not _valid_signing_tier(
                        epoch.get("controller", {}).get("signingTier")
                    )
                )
            ):
                reasons.append(
                    f"occupied dynamic-control epoch is missing signing policy for {key}"
                )
                commands_valid = False
            if state is None and epoch.get("status") == "occupied":
                reasons.append(f"missing signature state for {key}")
                commands_valid = False
                continue
            if (
                epoch.get("status") == "occupied"
                and epoch.get("controller", {}).get("publicKey")
            ):
                genesis = {
                    "sessionId": session_id,
                    "seat": seat,
                    "epoch": epoch["epoch"],
                    "controllerId": epoch["controller"]["controllerId"],
                    "publicKey": epoch["controller"]["publicKey"],
                    "transitionDigest": epoch["digest"],
                }
                for field in ("previousEpochDigest", "previousChainHead"):
                    if field in epoch:
                        genesis[field] = epoch[field]
                try:
                    genesis_hash = submission_epoch_genesis_hash_v2(genesis)
                except (KeyError, TypeError, ValueError) as error:
                    reasons.append(str(error))
                    commands_valid = False
                    continue
                command_heads[key] = genesis_hash
                reconstructed_heads[key] = {genesis_hash}
                if state.get("genesisHash") != genesis_hash:
                    reasons.append(
                        f"signature state genesis does not match {key}"
                    )
                    commands_valid = False
    for key in signature_states.keys() - expected_keys:
        reasons.append(f"signature state belongs to unknown epoch {key}")
        commands_valid = False
    raw_commands = evidence.get("commands")
    if not isinstance(raw_commands, list):
        reasons.append("commands must be an array")
        commands_valid = False
        raw_commands = []
    ordered_commands = sorted(
        raw_commands,
        key=lambda item: item.get("envelope", {}).get("cursor", -1),
    )
    cursors = [
        signed.get("envelope", {}).get("cursor")
        for signed in ordered_commands
    ]
    if len(cursors) != len(set(cursors)):
        reasons.append("signed commands contain duplicate cursors")
        commands_valid = False
    for signed in ordered_commands:
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
            expected = command_heads.get(key)
            if expected is None:
                raise ValueError(
                    "signed command references an epoch without signature state"
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
            reconstructed_heads.setdefault(key, set()).add(command_heads[key])
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
        epoch = epochs[fact["epoch"]]
        state = signature_states.get(key)
        computed_head = command_heads.get(key)
        if (
            state is not None
            and computed_head is not None
            and state.get("lastChainHead") != computed_head
        ):
            reasons.append(f"checkpoint chain head does not match {key}")
            commands_valid = False
        periodic_fields = (
            "lastSignedChainHead",
            "lastPeriodicTick",
            "lastPeriodicClientTime",
            "lastPeriodicSignature",
        )
        has_periodic = state is not None and any(
            field in state for field in periodic_fields
        )
        if has_periodic:
            periodic_valid = (
                all(field in state for field in periodic_fields)
                and state["lastSignedChainHead"]
                in reconstructed_heads.get(key, set())
                and bool(epoch.get("controller", {}).get("publicKey"))
                and _verify_periodic(
                    epoch["controller"]["publicKey"],
                    {
                        "sessionId": session_id,
                        "seat": fact["seat"],
                        "epoch": fact["epoch"],
                        "tick": state["lastPeriodicTick"],
                        "clientTime": state["lastPeriodicClientTime"],
                        "chainHead": state["lastSignedChainHead"],
                    },
                    state["lastPeriodicSignature"],
                )
            )
            if not periodic_valid:
                reasons.append(
                    f"periodic signature state is invalid for {key}"
                )
                commands_valid = False
        fact["unsignedTail"] = (
            state is not None
            and state.get("lastSignedChainHead") is not None
            and state.get("lastSignedChainHead") != state.get("lastChainHead")
        )
        if (
            next_epoch is not None
            and next_epoch.get("authorization") == "controller-handoff"
            and (
                computed_head is None
                or next_epoch.get("previousChainHead") != computed_head
            )
        ):
            reasons.append(
                f"voluntary handoff does not continue exact chain head for {key}"
            )
            commands_valid = False
            fact["unsignedTail"] = True
        elif (
            next_epoch is not None
            and next_epoch.get("authorization") == "host-policy"
            and next_epoch.get("previousChainHead") != computed_head
        ):
            fact["unsignedTail"] = True
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


def _valid_public_key(value: Any) -> bool:
    try:
        signature_bytes_from_base64(value, "controller.publicKey", 32)
        return True
    except (TypeError, ValueError):
        return False


def _valid_signing_tier(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"N"}
        and isinstance(value["N"], int)
        and not isinstance(value["N"], bool)
        and 0 < value["N"] <= (1 << 53) - 1
    )
