# GAOS tick protocol v1

The stable protocol coordinates ticks without imposing a particular game's
state, observation, or command shape. Values crossing the wire must be JSON
serializable.

## Resolved ticks

A resolved envelope contains:

- `protocol: "agilabs.ticks"`
- `protocolVersion: "1.0"`
- `kind: "tick"`
- `sessionId`, `tickId`, and monotonic `revision`
- a game-owned `tick` observation

Only resolved envelopes advance a renderer or agent.

## Pending ticks

A simultaneous host can accept one participant's committed intent before the
other participants have submitted. It returns `kind: "pending"` with:

- the same unresolved cursor;
- the last resolved observation;
- submitted and awaited participant lists; and
- the accepted participant when applicable.

A pending envelope acknowledges an intent but does not advance the world.

## Commands and retries

Every command submission binds the command to the current `sessionId`,
`tickId`, and `revision`. It also includes:

- a portable participant ID matching `[A-Za-z0-9_.:@-]{1,128}`;
- a caller-generated `submissionId`; and
- a game-owned `command` value.

Reuse the same `submissionId` for an exact retry. Use a new ID for a new
logical control step. A host rejects stale cursors and conflicting retries.

A session using RFC-010 may also carry `clientTime`, `prevChainHash`, and
`sig`. These fields authenticate the canonical command plus the existing
session/seat/id/cursor/tick fields; they do not change collection or reducer
semantics. A chained submission carries both `clientTime` and
`prevChainHash`; `sig` is present for direct tier-1 or periodic-policy
attestation. Exact retries reuse the identical signed bytes.
[Trust and verification](/trust-and-verification) defines the scheme and
threat boundary.

## Simultaneous resolution

The protocol collector stores one intent per participant without mutating its
input window. Once complete, it returns intents in canonical ASCII participant
order rather than network arrival order. The game resolves that complete batch
once; the collector never approximates simultaneous play by applying commands
serially.

The host is responsible for atomically committing the resolution, its retry
receipt, and the next intent window.

`createParticipationIntentWindow` maps the engine participation descriptor to
the protocol collector: sequential participation creates a one-seat eligible
set, while simultaneous participation includes every declared seat. This is
the same intent-collection model used by response windows and multi-agent
episodes.

## Game definitions

`GameDefinition` is an optional host-side seam for deterministic games. A game
owns its configuration, state, observation, command, and legal-command types.
It supplies state creation, participant enumeration, observation, legality,
and complete-batch `resolveTick` resolution.

`GameRegistry` is instance-local and permits multiple explicit versions of a
game to coexist in one host process.

## Host responsibilities

Participant IDs identify seats, not credentials. Authentication,
authorization, persistence, timeout policy, reconnect behavior, rate limits,
scoring, and replay retention belong to the host.

This hosted HTTP-style envelope is not a high-frequency lockstep transport.
Realtime products bring their own WebRTC, relay, or socket layer and use the
engine's canonical tick inputs, rollback re-simulation, and state digests
directly.

## Compatibility promise

The v1 compatibility boundary covers:

- envelope metadata and cursor semantics;
- resolved versus pending behavior;
- command idempotency and conflict behavior; and
- deterministic complete-batch intent collection.

Additive metadata may appear under `extensions`. Game-specific observations,
commands, endpoints, and policies are not frozen by protocol v1. A breaking
change to the generic fields or behavior requires a new protocol version.
