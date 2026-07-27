# Ecosystem bridges and benchmark contracts

v0.22 begins the staged implementation of
[RFC-013](/rfcs/rfc-013-ecosystem-bridges-and-benchmark-tooling). The release
ships portable boundaries that independent hosts, renderers, games, and
benchmark products can implement without moving their policy into GAOS.

## One host lifecycle

Every direct host or transport adapter maps to the same lifecycle:

```text
authenticate
  → assign or resume a controller epoch for a fixed logical seat
  → validate a canonical command
  → prepare → persist → commit
  → publish a seat-scoped observation or repair
  → checkpoint / reconnect / terminate
  → finalize portable replay evidence
```

`SessionHostDriver` is the transport-neutral contract. One serialized lane per
session, conflict-detecting idempotency, persistence before publication,
explicit timeout escalation, seat-scoped delivery, revision-based repair, and
complete durable evidence are normative. Sockets, authentication, matchmaking,
storage, presence, and server allocation are host-owned.

Nakama and Colyseus are direct hosts when their authoritative TypeScript
runtime can execute the SDK and required cryptography. A plain Node
HTTP/WebSocket service is the reference composition. Photon Fusion is a
transport or authoritative-hosting choice whose integration must name the
actual state authority.

Photon Quantum is an alternate simulation core. Either GAOS is the simulation
authority, or the integration emits explicitly external evidence over
confirmed inputs, pinned simulation identity, frame digests, and results. It
must never describe an external simulation as a native GAOS replay.

`RFC013_HOST_CONFORMANCE_SCENARIOS` lists the shared scenario identifiers that
adapters use alongside the shipped event-store conformance runner.

## Presentation boundary

`PresentationFrame<TView, TEvent>` separates a durable seat-scoped `view` from
transient deterministic cues. Every event has an identity stable across retry
and reconnect. `presentationFrameFromObservation` deduplicates those
identities, carries the durable transition revision, and suppresses old cues
on a repair snapshot.

The `gaos.presentation-frame-v1` schema and golden JSON fixture are the first
cross-language source of truth. Unity projects stable entity ids into
GameObjects, Godot into nodes, and Unreal into Actors/UObjects. Those
projections, animation queues, WebSockets, Blueprint events, art, input, and
native replication remain engine-owned.

## Stable seats and controller epochs

`SeatControlLedger` records authority independently from gameplay and
connection state:

- the logical seat set is fixed at genesis;
- epochs are consecutive and have digest continuity;
- vacancy is explicit;
- a new controller or key starts a new epoch;
- same-controller, same-key reconnect resumes the epoch;
- multi-seat swaps are prepared and committed atomically;
- stale epochs and controller ids are rejected;
- host-policy and controller-handoff transitions remain distinguishable; and
- checkpoints validate complete per-seat continuity when rehydrated.

The v0.22 ledger preserves claimed handoff signature material but does not
reinterpret the v1 submission signature scheme. Cryptographic v2 handoff
verification, replay evidence integration, and TypeScript/Python golden
vectors remain a later RFC-013 Stage B delivery.

## Research and benchmark primitives

The engine exports `GameDescriptor`, `GameObserver`, `Policy`, explicit
`ChanceOutcome`, distribution validators, deterministic selection, policy
entropy, and Wilson win-rate intervals. Descriptors are machine-readable
claims; conformance remains the evidence for those claims.

The root package exports the `gaos.benchmark-manifest` v1 contract, structural
validation, deterministic task/seed/episode planning, and complete deterministic
aggregation. The SDK owns these mechanics. A benchmark owns tasks, scores,
weights, held-out content, eligibility, resource policy, and publication.

Evidence verification, organizer reproduction, open implementation, model
identity attestation, and hidden-test compliance remain five distinct claims.
`EvidenceTrustClaims` keeps them separate; no single checkmark implies all.

Runner resume/packing, portable submission verification, generated engine
clients, complete hosting guides, and the neutral deployable leaderboard are
later staged v0.22+ deliveries.
