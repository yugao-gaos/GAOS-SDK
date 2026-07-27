# Authoritative sessions and integrity

Version 0.19 added the optional `./session` entry point for hosts that need a
deterministic, authoritative match loop without coupling game rules to a
database, network, timer, or deployment platform.

Version 0.20 adds the migration-informed completion: pre-ingest legality,
named interest scopes, bounded patch delivery, explicit repair envelopes,
product action payloads, generic non-grid session views, and host
recovery/inspection helpers.

Version 0.21 makes that path durable for long-running rooms: integrity-checked
checkpoint/restore/compaction, explicit reconnect retention floors, a
prediction reconciler, a reference host adapter and event-store conformance
kit, tick-deadline inspection, and portable `ended` results.

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
  `rehydrateKernel(options, transcript)`; the persisted transition wins; and
- after commit but before delivery, rehydrate the same log and retransmit or
  send `snapshot(seat, lastTransitionRevision)`.

`stateIsolation.discard` owns cleanup for an aborted or stale draft and is
called exactly once. After a successful commit, `stateIsolation.retire` owns
the previous live state and is also called exactly once. Hosts must not retain
or reuse either resource after its ownership callback.

The `./session-host` entry point packages the same sequence for hosts that do
not need a custom coordinator:

```ts
import {
  InMemorySessionEventStore,
  SessionKernelHost,
  runEventStoreConformance,
} from '@yugao-gaos/turn-based-grid-sdk/session-host';

const store = new InMemorySessionEventStore();
const host = new SessionKernelHost(kernel, store, publishDeltas);
await host.ingest(submission);

const results = await runEventStoreConformance(() => productEventStore());
if (results.some(({ passed }) => !passed)) {
  throw new Error('event store is not GAOS-conformant');
}
```

`SessionKernelHost` serializes operations per kernel. A persistence failure
aborts the prepared draft. Once persistence succeeds it commits exactly once;
a publication failure remains in an ordered queue and `retryPublish()` retries
it without rerunning the reducer or rewriting history. The event store's
`persist(events)` operation must be atomic for each prepared batch. The
conformance kit proves byte-identical retry and rejection of conflicting bytes
under a reused event id; products still test their own transaction, crash, and
delivery boundaries.

Accepted intents are events even before a simultaneous window is complete.
`rehydrateKernel(options, transcript)` therefore restores pending commands and
idempotency receipts after a crash. A resolution records the complete
canonical input group and replay invokes the reducer exactly once for that
group.

Hosts may store events without duplicating the derived header:
`sessionHeaderFor(options)` constructs it without running `reducer.init`, and
`rehydrateKernel(options, events)` accepts the durable event array directly.
`awaitingSeats()` reports the current participation gap. Duplicate ingest
receipts include `resolved`, so hosts do not infer lifecycle state from receipt
retention or cursor arithmetic.

Every seat has an independent `viewRevision`. Resolution increments it even
when the seat's redacted view is unchanged. Every observation envelope also
carries the durable `transitionRevision` watermark. `snapshot(seat,
afterTransitionRevision)` is the reconnect path. `origin: 'snapshot'`
distinguishes repair from ordinary resolution; absence remains readable as
`resolution` for compatibility. Resolution deltas also carry
`acknowledgements`, the applied
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

`PredictionSession` is the reference implementation of that contract:

```ts
import {
  PredictionSession,
} from '@yugao-gaos/turn-based-grid-sdk/session';

const prediction = new PredictionSession({
  initial: { view, transitionRevision, viewRevision },
  applyPending: (current, pending) =>
    optimisticReducer(current, pending.command),
});

const optimisticView = prediction.predict({
  participantId: seat,
  submissionId,
  command,
});
const reconciled = prediction.reconcile(authoritativeDelta);
if (reconciled.status === 'resync_required') {
  requestSnapshot();
}
```

Acknowledgements and rejections settle the exact submission identity. All
remaining commands are reapplied in original enqueue order. A transition gap,
a patch without a base, an invalid patch, or a digest mismatch returns
`resync_required`; the class never fabricates an intermediate view. A snapshot
can establish the initial base or recover after a gap.

### Checkpoint, restore, and compaction

`checkpoint()` returns a frozen `gaos.kernel-checkpoint` v1 object containing
the session header, reducer-state encoding, cursor/tick/transition watermarks,
open intent window, receipts, views and revisions, commitments, interest
scopes, identity state, and a canonical SHA-256 `integrityDigest`. The default
codec accepts JSON reducer state. Non-JSON state supplies a stable,
versioned `checkpointCodec`:

```ts
const options = {
  // normal SessionKernelOptions...
  checkpointCodec: {
    id: 'example.world',
    version: '1',
    encode: (state) => encodeWorld(state),
    decode: (value) => decodeWorld(value),
  },
  limits: {
    checkpointInterval: 600,
    maxOpenCommitmentsPerSeat: 64,
  },
};

const checkpoint = kernel.checkpoint();
await checkpointStore.put(checkpoint);

const restored = rehydrateKernelFromCheckpoint(
  options,
  checkpoint,
  eventsStrictlyAfter(checkpoint.watermark.transitionRevision),
);
```

Restore checks the header, codec identity, integrity and state digests,
watermarks, event ids, and contiguous transition tail. Tail events at or
before the checkpoint watermark are rejected. Checkpoint cadence records
audit events; it does not itself persist a recoverable checkpoint, so the host
must call and durably store `checkpoint()`.

Compaction has a deliberately explicit two-store contract. Before calling it,
the host must durably commit the exact checkpoint and copy every permanent
gameplay submission id, interest command, and commitment-salt identity into a
canonical history index. Supply synchronous `historyLookup` callbacks backed
by a preloaded cache or preflighted durable answer, then confirm both writes:

```ts
kernel.compact(checkpoint, {
  checkpointDigest: checkpoint.integrityDigest,
  checkpointDurablyCommitted: true,
  historyDurablyCommitted: true,
});
```

Compaction discards the in-memory event prefix and migrated identity
tombstones, removes revealed commitments, and advances `retentionFloor()`.
It does not delete the host's full event log. Independent replay verification
still requires that complete canonical history. After compaction,
`snapshot(seat, oldTransitionRevision)` returns `resync_required` when the
requested watermark predates the floor; request a current snapshot and reset
the client's authoritative base.

### Patch delivery and interest scopes

Every v0.20+ session emits observation codec v2. Its default adaptive strategy
uses deterministic, bounded JSON patches only when they beat a snapshot by the
configured `minReduction`. After a probe falls back, that interest scope emits
snapshots for `patchBackoffTicks` changed observations before probing again.
Repeated failures double that window up to `maxPatchBackoffTicks`; a successful
half-open probe resets it. Set `patchStrategy: 'never'` to skip diffing entirely
while retaining the same v2 envelope:

```ts
observationCodec: {
  version: 'v2',
  patchStrategy: 'adaptive', // or 'never'
  patchBackoffTicks: 8,
  maxPatchBackoffTicks: 32,
  minReduction: 4,
  maxOperations: 2_048,
  maxBytes: 65_536,
}
```

Arrays are replaced atomically; JSON Pointer escaping is normative;
prototype-bearing paths are rejected. Operation and byte bounds are enforced
during the walk and fall back to a complete v2 snapshot. Clients reconstruct
every `patch`, `snapshot`, or `unchanged` body with `applyObservationDelta`,
which checks `viewDigest`. The snapshot-only v1 negotiation path was removed
before release.

### Tuning observation delivery: what each option costs and buys

Every option above is product-owned; the SDK picks defaults that suit a small
table and gets out of the way. The defaults are **not** right for every shape,
and the trade they make is always the same one: **CPU against bandwidth.**

| Option | Default | Raise / enable it to | Cost of doing so |
|---|---|---|---|
| `patchStrategy` | `'adaptive'` | `'never'` gives predictable, lower CPU and no diff walk | Full snapshot bytes every changed tick; lean on transport compression |
| `minReduction` | `4` | Higher = patch only on a decisive win, less wasted diffing | More snapshots, more bytes |
| `patchBackoffTicks` | `8` | Higher = give up on patching faster after a loss | Slower to notice the view became patch-friendly again |
| `maxPatchBackoffTicks` | `32` | Higher = stay backed off longer | Longer to recover after a transient burst of churn |
| `maxOperations` | `2048` | Lower = abandon expensive walks sooner | Large-but-genuine patches degrade to snapshots |
| `maxBytes` | `65536` | Lower = reject large patches earlier | Same |

#### Measured effects

Synthetic table, one desktop, 20 Hz, 4 seats, uncompressed unless stated.
Reproduce with `npm run observations:benchmark`. Treat these as *shape*, not as
your numbers. Run it against your own views. Per-run variance is roughly
±20 %, so read ratios rather than absolute milliseconds.

"Budget" is the share of one 20 Hz tick (50 ms) spent encoding for all four
seats.

| entities | changed/tick | snapshot budget | adaptive budget | egress: snapshot → adaptive |
|---|---|---|---|---|
| 50 | 1–5 | ~4.5 % | ~11.7 % | 0.288 → 0.007 MiB/s |
| 50 | 20–all | ~4.6 % | **~4.8 %** (backed off) | 0.288 → 0.043 MiB/s |
| 200 | 1–20 | ~16 % | ~32 % | 1.157 → 0.007–0.015 MiB/s |
| 200 | all | ~15.5 % | **~16.2 %** (backed off) | 1.158 → 0.132 MiB/s |
| 500 | 1–20 | ~39 % | **70–77 %** | 2.930 → 0.007–0.015 MiB/s |
| 500 | all | ~39 % | **~41 %** (backed off) | 2.931 → 0.293 MiB/s |

Three things this table is saying:

1. **The circuit breaker does its job.** Wherever patches stop paying
   (`changed = all`), adaptive converges to within ~5 % of snapshot CPU. You do
   not need to tune anything for the wholesale-churn case.
2. **Patching is close to free on small tables and expensive on large ones.**
   At 50 entities the whole delivery path is noise. At 500 it is the dominant
   per-tick cost.
3. **The expensive cells are the ones where patching is *winning*.** At 500
   entities with 1–20 changes the patch is a 200–400× bandwidth win, and it
   costs ~2× the CPU. Backoff never fires there because nothing is going
   wrong; see the caveat below.

#### Choosing

- **Small tables (tens of entities):** keep the defaults. Both paths are
  negligible and adaptive is a large bandwidth win for no meaningful cost.
- **Medium (~200):** keep the defaults. Roughly 2× CPU for roughly 100×
  bandwidth is a good trade at 16 % → 32 % of budget.
- **Large (500+) and CPU-bound:** consider `patchStrategy: 'never'` plus
  transport compression. Adaptive sits at 70–77 % of a 20 Hz budget *on a fast
  desktop*, and a constrained isolate is materially slower. Snapshot-only with
  zlib level 1 costs ~39 % of budget and still delivers 2.93 → 0.293 MiB/s.
- **Large and bandwidth-bound:** stay adaptive. Two orders of magnitude of
  egress is worth 2× encode CPU if egress is what you are paying for.

Measure before choosing. The crossover depends on your view shape, and a rich
ECS component set moves it.

#### Caveat: backoff is byte-aware, not CPU-aware

The circuit breaker reacts to a patch **losing on bytes**. A patch that wins
decisively on bytes never backs off, however much CPU it costs. This is why
the 500-entity / few-changes cells stay at 70–77 % of budget rather than
converging like the `all`-changed cells do.

This is deliberate: paying ~2× CPU for ~300× bandwidth is usually right, and
the opposite bargain (7 % fewer bytes for 5× the CPU) is what `minReduction`
already prevents. But nothing weighs the two automatically, so **a large table
with light per-tick churn is the one shape you must decide for yourself.** For
that shape, `patchStrategy: 'never'` plus compression is often the better
default, and no amount of backoff tuning will discover that for you.

#### Transport compression

This is not an SDK concern; it belongs to your WebSocket stack. However, it
interacts directly with the choice above, so measure it before adding a codec. In the
synthetic benchmark zlib level 1 takes a 500-entity snapshot from 38,420 to
3,839 bytes for ~0.10 ms/seat, while level 6 reaches 3,361 bytes for ~0.57
ms/seat: **12 % more compression for roughly 5× the CPU.** Since CPU is the
binding constraint in every large-table case above, **prefer level 1**. These
synchronous zlib numbers expose the trade; they are not a substitute for
measuring your actual stack, which may compress on another thread or reuse a
context across messages (both of which improve on these figures).


Cached seat and scope views are derived immutable values. Prepared drafts share
them copy-on-write and replace references after a resolution, avoiding
full-graph clones. This is internal only: `observe`, `snapshot`, interest
declaration results, and prepared deltas remain isolated from caller mutation.

An interest policy receives the already partitioned seat view and may only
remove structure. The kernel checks that invariant before publishing:

```ts
const kernel = createSessionKernel({
  // ...
  seatKeys,
  signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
  interest: {
    narrowView: (partitionedView, { declaration }) =>
      selectInterest(partitionedView, declaration),
  },
});

const prepared = kernel.prepareInterest(signedScopeSubmission);
```

Scopes are named by `(seat, scopeId)`; the compatibility default is one scope
named by the seat. A scope change is a signed tier-2 durable transition that
does not reach the reducer or advance the gameplay cursor. Its delta carries
the declaration, scope id, and a snapshot at the current `viewRevision`.
Subsequent resolutions emit one stream per scope. `observe` and `snapshot`
accept an optional scope id.

Reducers may implement `validateCommand(state, seat, action)`. It runs before
an intent is persisted; a throw becomes `IntentCollectionError` and cannot
wedge a participation window. Reducer views must be canonically encodable:
construction fails fast for a bad initial view, while later failures are
classified as `SessionAdvanceError('invalid_view')`.

Session, replay, lockstep, interest, and observation delivery require only
`SessionView`: lifecycle plus optional participation/outcome metadata.
`TickView extends SessionView` remains the action-discovery compatibility
shape used by agents and solvers. A reducer whose observation has no
`actions`, `hud`, `grid`, or `zones` extends `SessionView` directly and supplies
the pure deterministic counter:

```ts
const reducer = {
  // init, advance, view...
  replayMetrics: (state) => ({ actionsUsed: state.acceptedCommands }),
};
```

Existing `TickView` reducers need no change; when `replayMetrics` is absent,
the SDK reads `view.hud.actionsUsed`. The explicit seam prevents products with
ECS or other non-grid observations from manufacturing empty action lists or a
fake HUD merely to use authoritative sessions and portable replay.

Chooser focus, an open dialogue, highlighted targets, and cancellation are
host/UI state. They must not mutate reducer state or advance `cursor` or
`viewRevision`. Confirming a choice constructs a normal command and enters
through `prepareIngest`; only its deterministic resolution changes simulation
state. Any purported UI state that affects legality, RNG, turn order,
authoritative observations, or later results is simulation input and must be
recorded as an action.

The kernel bounds future tick targets, catch-up work, retained receipts,
extension bytes, checkpoint cadence, and open commitments per seat. A
participation window admits exactly one unresolved intent per seat, so there
is no multi-entry per-seat buffer. For
`timeoutPolicy: { mode: 'ticks', windowTicks: N }`, `nextDeadline()` returns
the open tick plus `N` while the window is incomplete and `undefined` once it
is complete or when no tick-bounded policy exists. The accessor is scheduling
information; the host still owns the timer and calls `prepareTimeout`.

Receipt retention bounds stored responses, not idempotency. Once a submission
identity has been accepted, reusing it at any later cursor returns
`unknown_submission` even after its receipt has been evicted or its command
was rejected before gameplay. A corrected command uses a fresh submission ID.
Before compaction, the kernel retains one idempotency key per accepted
gameplay or interest submission. After compaction, the configured
`historyLookup` must answer those identities permanently. Receipt eviction and
compaction never permit a submission id to be reused.

### Fixed seats and live occupancy

The declared `seats` list and any signing roster are immutable for the session.
Reducer participation is a non-empty subset of those declared seats and must
not be derived from who is currently connected or occupying a chair.
Construction-time and transition-time validation errors report both declared
and supplied sets in canonical lexical order, including whether the supplied
set was empty or contained undeclared seats.

Occupancy, driver assignment, reconnect, kick, claim, and human/bot
substitution are product state or host authentication state. If they affect
legality, RNG, turn order, authoritative observations, or results, encode the
change as an ordinary deterministic input. Spectators receive observation
delivery and are not action-capable kernel seats. See
[high-frequency sessions](/high-frequency) and
[information partitions](/mechanisms/information-partitions).

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
  advancePolicy: 'play-all-levels',
});
```

The input list must be non-empty and ordered. Transcript `i` must use
`runLevelSeed(runSeed, i)` and record that concrete seed with
`seedPolicy: 'explicit'`; all segments share their session, game/adapter,
and dmath declaration. The default `win-to-advance` policy requires every
non-final segment to be won; `play-all-levels` permits scored runs that
continue after losses. The projection
assigns global action/record numbers and level indices, derives aggregate
totals, and returns `gaos.replay` v1.3. A shared signing roster and policy
retain the v1.2 signature and chain construction within the v1.3 envelope.

`SubmittedAction.payload` carries arbitrary JSON product input through the
live transcript and portable replay without borrowing commitment verification
fields.

Each level kernel deliberately starts its cursor at zero. A host exposing one
monotonic run revision keeps a `revisionBase`: add it to outbound cursor/view
revisions and subtract it from inbound revisions before constructing the local
submission. Validate the translated `tickId` rather than silently repairing a
mismatch. After a level, advance the base by that episode's final cursor.
This translation is transport state; portable replay retains per-level ticks
and assigns the ordered `levelIndex`.

### Durable event sizing

`SessionEvent` is the durable representation, not a compact in-memory trace.
The Arena migration measured roughly 815 bytes per simple turn before storage
framing. Hosts with per-value limits must append or chunk events rather than
store an unbounded transcript as one value. Repeated event ids, canonical
commands, and consumed identities are intentionally self-describing evidence;
transport compression or a product-owned compact index may reduce storage, but
recovery must reproduce the exact event stream.

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
not treat this lane as evidence. In v1.2+, RFC-010 submission signatures and
per-seat chains authenticate signed commit/reveal authorship and make
fabrication, reattribution, deletion, and reordering detectable. They can
constrain timeout position in ticks mode; they cannot prove wall-clock
earliness, and turns-mode positional checks degrade.

For a signed timeout lane, configure a versioned pure
`timeoutToAction(context, timeout)` function. The kernel derives the system
input from it, and the offline verifier calls the historical function again.
A mismatch rejects the artifact; an unavailable function prevents a
`trusted` verdict. A tick-bounded header policy has the exact shape
`{ mode: 'ticks', windowTicks: N }`; its timeout records use
`timeoutPolicyRef: 'header.timeoutPolicy'` and must occur at
`windowRef + N`.
Before that tick, an incomplete policy-bound window remains open; at or past
the deadline, `prepareAdvance` refuses to suppress the timeout and requires
`prepareTimeout`. A complete window may still resolve early.

The v0.19 unsigned reservation remains compatible: without a signing roster,
`timeoutPolicy` is an opaque canonical JSON object and a non-empty
`timeoutPolicyRef` is preserved without assigning positional semantics.
Supplying `seatKeys` and `signaturePolicy` opts into the strict signed policy
shape above.

Live reveal processing reports salt reuse through
`prepared.result.warnings`. It remains non-fatal because session/seat/window
binding keeps commitments distinct, but hosts should surface or log the
warning: salt reuse weakens resistance to offline guessing.

## Finalization

`liveTranscript()` is an append-only durability log, not a portable result.
Once the reducer reports `won`, `failed`, or `ended`,
`finalizeReplay(transcript, options)` projects it into `gaos.replay` v1.3. A
kernel configured with `seatKeys` and
`signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' }` retains the signed
v1.2 construction within that v1.3 artifact. An `ended` result exports with
`stars: null`; older replay versions cannot encode it.
Timeout, extension, checkpoint, grouped-resolution, commitment-mismatch, and
periodic `seat-signature` records survive in their portable lanes.

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

The strict v1.1 replay schema continues to round-trip the RFC-010 `seatKeys`,
signature/timeout-policy, periodic `seat-signature`, `clientTime`,
canonical-command, cursor, chain-link, and signature reservations without
interpreting them. V1.2 validates and verifies those fields. Chained
submissions require `clientTime`; a fully unsigned legacy submission is the
only timestamp-free form.

`prepareSeatSignature({ participantId, tick, clientTime, prevChainHash, sig })`
records a periodic chain-head signature as an ordered non-gameplay
transition. It is allowed after terminal gameplay so a client can attest the
final tail. Persist its event before `commit()` like every other prepared
transition. The host records these bytes but need not verify them on the tick
path.

See [portable replay and verification](/mechanisms/replay) for the JSONL
format and whole-run verifier, and
[trust and verification](/trust-and-verification) for signing adoption.
