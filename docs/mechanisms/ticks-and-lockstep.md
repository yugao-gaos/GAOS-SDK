# Ticks and lockstep

A tick is the SDK's deterministic simulation boundary. Products own scheduling
and higher-level concepts such as player turns, phases, and rounds.

## Participation and outcomes

`TickView.participation` explicitly distinguishes:

```ts
{ mode: 'sequential', activeSeat: 'north' }
{ mode: 'simultaneous', seats: ['north', 'south'] }
```

Multi-seat games may report `outcome: { kind: 'ongoing' }` or a decided
ranking. Rankings use ascending rank and may include a per-seat score; tied
seats share a rank.

## Deterministic lockstep

`LockstepInput` groups authored actions by integer tick and seat.
`canonicalizeLockstepInputs` orders groups by tick and then by lexical seat id,
while preserving the action order inside each group. `resimulate` starts from
a supplied rollback snapshot and applies that canonical stream:

```ts
const state = resimulate(reducer, rollbackSnapshot, inputs, {
  applyEmptyTick: (state, tick) => advanceScheduledSystems(state, tick),
});
```

Canonical `TickReducer` implementations receive an empty input batch for each
missing tick. The `applyEmptyTick` option supports older action-at-a-time
reducers. A supplied action may omit `seat` and receive its group seat; a
conflicting seat is rejected. Every canonical input at one tick is committed
as one batch.

`stateDigest(state)` provides a compact deterministic FNV-1a digest over JSON
by default. For authoritative networking, provide a canonical serializer that
sorts unordered maps and excludes presentation-only data. Compare digests only
between compatible reducer, content, serializer, and numeric-runtime versions.

Time is input: wall clocks, frame duration, and scheduler timing must not alter
reducer state unless converted to an explicit tick action or deterministic
state value. Mint ids from deterministic counters or seeded streams, not
process randomness. Avoid engine-dependent transcendental floating-point math
in cross-runtime lockstep, or quantize its result before it reaches state.
