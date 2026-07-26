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
  // UTC epoch milliseconds. Use `hostTime: 'none'` for no event timestamps.
  hostTime: () => Date.now(),
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
  // repaired with snapshot(seat, lastTransitionRevision); it must never
  // abort the committed state.
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
  send `snapshot(seat, lastTransitionRevision)`.

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
when the seat's redacted view is unchanged. Every observation envelope also
carries the durable `transitionRevision` watermark. `snapshot(seat,
afterTransitionRevision)` is the reconnect
path; v1 observation deltas are either a complete snapshot or an unchanged
marker. Resolution deltas also carry `acknowledgements`, the applied
`(participantId, submissionId)` identities in canonical reducer order.
Host-derived inputs are excluded and reconnect snapshots carry an empty list.
At every observable state, `viewRevision(seat) === cursor()` for every seat.

Rejected inputs do not advance gameplay or `viewRevision`. They produce a
rejection-only unchanged envelope per seat at the new `transitionRevision`,
with the rejected `(participantId, submissionId)` and `commit_mismatch` code
in `rejections`; `AdvanceSummary.rejections` exposes the same notices as a
convenience. Publish `prepared.deltas` only after durable commit. Clients
remove rejected identities just as they remove applied acknowledgements and
persist the transition watermark. After delivery failure or restart,
`snapshot(seat, lastTransitionRevision)` reconstructs missed rejection notices
from the durable log.

Prediction clients process envelopes in increasing `transitionRevision` order
and newer resolution bodies in increasing `viewRevision` order. They apply
the authoritative body, remove exact acknowledged or rejected identities
from pending, and replay the remainder in original local enqueue order.
A view-revision gap requires retransmission or snapshot/resync; it must not
be filled by guessing.

The v0.19 kernel bounds future tick targets, catch-up work, retained receipts,
and extension bytes. A participation window admits exactly one unresolved
intent per seat, so there is no multi-entry per-seat buffer. The client-side
`PredictionSession` class remains deferred to v0.20 so it can be extracted
from a working TabletopLabs migration; its acknowledgement contract is stable
in v0.19.

Receipt retention bounds stored responses, not idempotency. Once a submission
identity has been accepted, reusing it at any later cursor returns
`unknown_submission` even after its receipt has been evicted or its command
was rejected before gameplay. A corrected command uses a fresh submission ID.

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
`runLevelSeed(runSeed, i)` and record that concrete seed with
`seedPolicy: 'explicit'`; all segments share their session, game/adapter,
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
| `sin`, `cos` | finite `|x| <= 2^30` | `|x| <= 2π`: <= 1 ulp bit-distance (evidence <= 1.5 ulp real error); full domain: <= 2 ulp bit-distance; preserve the signed-zero sine convention |
| `atan2` | finite `x` and `y` | <= 3 ulp bit-distance (evidence <= 2.818 ulp real error); IEEE signed-zero quadrants |
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
Mismatches remain outside the reducer batch and become recomputable replay
audit records. The package includes four complete
preimage-and-hash vectors at
`fixtures/commitment/gaos.commit.sha256.v1.vectors.json`.
Replay recheck results expose non-fatal `diagnostics` for both recomputed
mismatch records and redacted records that cannot be recomputed, plus salt
reuse across distinct commitments. `ok: true` means no demonstrated replay
inconsistency.

In v1.1, timeout and commitment-mismatch records remain unauthenticated host
attestation. Rechecking proves only that recorded values form a consistent
story; it cannot prove authorship or prevent a host from fabricating,
reattributing, or deleting audit records. Leaderboards and third parties must
not treat this lane as evidence until RFC-010's v1.2 submission signatures
and per-seat chains are implemented. Those signatures authenticate
authorship in both lanes and can constrain timeout position in ticks mode;
they cannot prove wall-clock earliness, and turns-mode positional checks
degrade.

Live reveal processing reports salt reuse through
`prepared.result.warnings`. It remains non-fatal because session/seat/window
binding keeps commitments distinct, but hosts should surface or log the
warning: salt reuse weakens resistance to offline guessing.

## Finalization

`liveTranscript()` is an append-only durability log, not a portable result.
Once the reducer reports `won` or `failed`, `finalizeReplay(transcript,
options)` projects it into `gaos.replay` v1.1. Timeout, extension, checkpoint,
grouped-resolution, and commitment-mismatch records survive in their portable
lanes.

A timeout that encounters an already-pending commitment rejection is still
auditable: the committed event order is `timeout`, `rejection`, then
`checkpoint`. Ordinary advance rejection uses `rejection`, then `checkpoint`,
so every rejection precedes its transition checkpoint. The forced timeout
input is not recorded as applied when the pending rejection prevents reducer
execution.

Hosts may import `IntentCollectionError` and its `IntentErrorCode` union from
the `./session` subpath alongside `SessionConflictError` and
`SessionAdvanceError`; malformed protocol commands are normalized to that
public ingest taxonomy.

Hosts must explicitly choose `hostTime: (() => number) | 'none'`.
A provider returns UTC epoch milliseconds: `() => Date.now()` is correct;
`performance.now()` is process-relative and therefore wrong. `'none'` omits
the field for byte-reproducible transcripts. The kernel never reads a clock
or falls back when a provider returns `null`/`undefined`.

When present, `SessionEvent.hostTime` is advisory correlation data.
Rehydration preserves it, while timestamp-free persisted events remain valid.
It is never reducer input or signature-preimage material. Semantic
input-to-transcript comparisons exclude it; persistence/rehydration equality
includes any recorded value. `FinalizeOptions.includeHostTime` projects it
into replay records, off by default, and the verifier ignores it. Never sort
by `hostTime`: wall clocks can move backwards. Durable ordering is `tick`,
`cursor`, then `transitionRevision`.

The strict v1.1 replay schema reserves the RFC-010 `seatKeys`,
signature/timeout-policy, periodic `seat-signature`, `clientTime`,
canonical-command, cursor, chain-link, and signature slots. They round-trip
today but have no v1.1 verification semantics. Future signed submissions
require `clientTime`; unsigned submissions are the only timestamp-free form.

See [portable replay and verification](/mechanisms/replay) for the JSONL
format and whole-run verifier.
