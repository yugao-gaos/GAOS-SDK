# Authoritative sessions and integrity

Version 0.19 adds the optional `./session` entry point for hosts that need a
deterministic, authoritative match loop without coupling game rules to a
database, network, timer, or deployment platform.

## Persist before publish

Every state-changing operation returns a `Prepared` transition:

```ts
import {
  createSessionKernel,
  type Prepared,
} from '@yugao-gaos/turn-based-grid-sdk/session';

const kernel = createSessionKernel({
  sessionId,
  game,
  levelId,
  reducer,
  level,
  seed,
  seedPolicy: 'explicit',
  seats: ['blue', 'red'],
  cadence: { mode: 'turns' },
  commandToAction: (command, context) => ({
    id: command.action,
    seat: context.participantId,
  }),
});

async function persistCommitPublish<TResult>(prepared: Prepared<TResult>) {
  try {
    // Append the complete transition batch atomically. eventId is the
    // idempotency key if this storage call itself is retried.
    await eventStore.appendIdempotent(prepared.events);
  } catch (error) {
    kernel.abort(prepared);
    throw error;
  }

  // A valid prepared transition is completed exactly once.
  kernel.commit(prepared);

  // Publication is downstream of durable state. A send failure is retried or
  // repaired with snapshot(seat); it must never abort the committed state.
  await publishDeltas(prepared.deltas);
  return prepared.result;
}

const receipt = await persistCommitPublish(
  kernel.prepareIngest(submission),
);
```

Preparation operates on an isolated reducer draft. The live state,
observations, cursor, and digest do not change until `commit`. Hosts with
mutable, copy-on-write, pooled, or ECS state supply `stateIsolation.fork`,
`discard`, and optionally `retire`; structured-cloneable state uses the
default strategy.

### Normative host obligations

Hosts must serialize transitions for one kernel and execute this order:

1. call exactly one `prepare*` method;
2. atomically persist every `prepared.events` entry;
3. call `commit(prepared)` exactly once; and
4. only then acknowledge the submitter or publish `prepared.deltas`.

Every event id is derived from
`sessionId + transitionRevision + eventIndex`. Storage must treat an exact
duplicate id and byte-identical event as an idempotent retry, while conflicting
bytes under the same id are fatal corruption. A prepared transition must end
in exactly one `commit` or `abort`. Persistence failure requires `abort`;
delivery failure after commit does not.

Crash recovery always follows the durable log:

- before persistence, nothing happened and the draft is aborted/discarded;
- after persistence but before in-memory commit, restart with
  `rehydrateKernel(options, transcript)`—the persisted transition wins; and
- after commit but before delivery, rehydrate the same log and retransmit or
  send `snapshot(seat)`.

`stateIsolation.discard` owns cleanup for an aborted or stale draft and is
called exactly once. After a successful commit, `stateIsolation.retire` owns
the previous live state and is also called exactly once. Hosts must not retain
or reuse either resource after its ownership callback.

Accepted intents are events even before a simultaneous window is complete.
`rehydrateKernel(options, transcript)` therefore restores pending commands and
idempotency receipts after a crash. A resolution records the complete
canonical input group and replay invokes the reducer exactly once for that
group.

Every seat has an independent `viewRevision`. Resolution increments it even
when the seat's redacted view is unchanged. `snapshot(seat)` is the reconnect
path; v1 observation deltas are either a complete snapshot or an unchanged
marker. Resolution deltas also carry `acknowledgements`, the applied
`(participantId, submissionId)` identities in canonical reducer order.
Host-derived inputs are excluded and reconnect snapshots carry an empty list.

Prediction clients process deltas in increasing `viewRevision` order, apply
the authoritative body, remove exact acknowledged identities from their
pending queue, and replay the remaining pending inputs in original local
enqueue order. A revision gap requires retransmission or snapshot/resync; it
must not be filled by guessing.

The v0.19 kernel bounds future tick targets, catch-up work, retained receipts,
and extension bytes. A participation window admits exactly one unresolved
intent per seat, so there is no multi-entry per-seat buffer. The client-side
`PredictionSession` class remains deferred to v0.20 so it can be extracted
from a working TabletopLabs migration; its acknowledgement contract is stable
in v0.19.

## Multi-level runs

Each kernel remains one level episode. Hosts compose completed episodes with
`finalizeRunReplay`:

```ts
import {
  finalizeRunReplay,
} from '@yugao-gaos/turn-based-grid-sdk/session';

const artifact = finalizeRunReplay(levelTranscripts, {
  seed: runSeed,
  perm,
  visibility: 'full',
});
```

The input list must be non-empty and ordered. Transcript `i` must use
`runLevelSeed(runSeed, i)`; all segments share their session, game/adapter,
and dmath declaration; and every non-final segment must be won. The projection
assigns global action/record numbers and level indices, derives aggregate
totals, and returns an ordinary `gaos.replay` v1.1 artifact for the existing
whole-run verifier.

## Deterministic math

State-path code can import `STATE_MATH` and `createDmath` from `./engine`.
`STATE_MATH` classifies the native constants and operations that are safe for
deterministic state. Implementation-approximated functions such as
`Math.sin`, `Math.cos`, and `Math.atan2` are forbidden there.

```ts
import { createDmath } from '@yugao-gaos/turn-based-grid-sdk/engine';

const dmath = createDmath();
const heading = dmath.atan2(deltaY, deltaX);
const snapped = dmath.roundTo(heading, 6);
```

`dmath-1` exposes `sin`, `cos`, `atan2`, `clamp`, and `roundTo`. It rejects
non-finite inputs and documented out-of-domain values instead of allowing
NaN or infinity into reducer state. The selected algorithm is recorded in a
session replay and must be constructible before re-simulation begins.

| Function | Accepted domain | Accuracy/boundary rule |
| --- | --- | --- |
| `sin`, `cos` | finite `|x| <= 2^30` | at most 1 ulp; preserve the signed-zero sine convention |
| `atan2` | finite `x` and `y` | at most 3 ulp; IEEE signed-zero quadrants |
| `clamp` | finite values, `lo <= hi` | exact endpoint selection |
| `roundTo` | integer decimals `[-15, 15]`, scaled magnitude `< 2^53` | deterministic binary64, half away from zero |

The package publishes exact binary64 vectors at
`fixtures/dmath/dmath-1.vectors.json`. CI runs them in Node, Chromium,
Firefox, WebKit, and workerd. A reproducible 512-bit integer oracle and
constant generator provide accuracy and provenance evidence without calling
native transcendental functions.

## Commit–reveal envelopes

`gaos.commit.sha256.v1` binds a secret payload to the session, seat,
seat-scoped commitment id, and gameplay window. The hash covers length-framed
UTF-8 fields, u64 big-endian counters, raw salt bytes, and canonical JSON
payload bytes.

```ts
import {
  COMMITMENT_SCHEME,
  createCommitmentHash,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const binding = { sessionId, seat: 'red', commitmentId: 0, windowRef: 3 };
const hash = createCommitmentHash(binding, saltHex, hiddenOrder);

const commit = { commitmentId: 0, scheme: COMMITMENT_SCHEME, hash };
const reveal = { commitmentId: 0, salt: saltHex, payload: hiddenOrder };
```

The session layer verifies a reveal before the payload reaches gameplay.
Mismatches remain outside the reducer batch and become independently
verifiable replay audit records. The package includes three complete
preimage-and-hash vectors at
`fixtures/commitment/gaos.commit.sha256.v1.vectors.json`.
Replay recheck results expose non-fatal `diagnostics` for redacted mismatch
records that cannot be independently rechecked and for salt reuse across
distinct commitments. `ok: true` means no demonstrated replay failure; a
consumer claiming independent cryptographic verification must additionally
require `diagnostics.length === 0`.

Live reveal processing reports salt reuse through
`prepared.result.warnings`. It remains non-fatal because session/seat/window
binding keeps commitments distinct, but hosts should surface or log the
warning: salt reuse weakens resistance to offline guessing.

## Finalization

`liveTranscript()` is an append-only durability log, not a portable result.
Once the reducer reports `won` or `failed`, `finalizeReplay(transcript,
options)` projects it into `gaos.replay` v1.1. Deadline, extension, checkpoint,
grouped-resolution, and commitment-mismatch records survive in their portable
lanes.

See [portable replay and verification](/mechanisms/replay) for the JSONL
format and whole-run verifier.
