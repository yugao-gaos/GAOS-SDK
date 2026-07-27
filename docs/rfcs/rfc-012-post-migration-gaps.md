# RFC-012 — SDK gaps after the TabletopLabs migration completed

Status: **implemented in v0.21 (2026-07-26)** · Target: v0.21 ·
Compatibility: §1 requires an explicit replay-format evolution; the remaining
items are additive APIs, modules, diagnostics, or documentation · Depends on:
RFC-006, RFC-009 · Source: the completed TabletopLabs migration and its
authoritative host

The TabletopLabs migration is **done**: reducer adapter, host adapter, client
reconciler, and a Cloudflare Durable Object host running the kernel in ticks
mode, merged and green. This RFC is what running it surfaced, scoped to
changes the SDK should make.

An earlier draft of this RFC reported findings against the v0.19 baseline.
**v0.20.0 adopted most of it** — recorded in §0 so the loop is visibly closed.
§1–§7 are what remains, re-derived against the released `v0.20.0` tag
(`de29cdc`).

§1 and §2 are the two that matter, and they compound: together they make
portable replay — the capability RFC-006 §1 gives as the reason the kernel was
extracted at all — unreachable for a tick-paced, open-ended product.

---

## 0 — What v0.20.0 resolved

| Earlier ask | v0.20.0 |
| --- | --- |
| `origin` discriminator on `ObservationDelta` | shipped (`resolution` / `snapshot` / `interest`) |
| `payload` on `SubmittedAction`, projected through replay | shipped |
| `./session` re-exports of the types its API is written in | shipped |
| Widen `timeoutPolicy` back to accept `JsonObject` | shipped |
| Patch codec, with the measurement that justified it | shipped as observation codec v2 |

Two of these were correctness fixes, not conveniences. `origin` removed a
client-side inference that had no sound derivation; `payload` restored replay
recheckability. Both are confirmed working in the migration's test suite.

A note on judgement, since this RFC is otherwise a list of complaints: codec
v2's `minReduction` default of 4 — with the measured rationale in the doc
comment that a 7 %-smaller patch cost 15.02 ms against a snapshot's 2.81 ms —
is a better call than the pure byte comparison we would have written.

---

## 1 — Give open-ended sessions a replayable terminal state

**Replay-contract change. Blocks honest replay export for tick-paced,
open-ended products.**

`finalizeReplay` rejects any transcript whose last resolution is still
`playing` (`src/session.ts:2824`):

```ts
if (!terminal || terminal.result.status === 'playing') {
  throw new SessionAdvanceError('terminal', 'only a terminal transcript can be finalized');
}
```

`SessionView.status` is `'playing' | 'won' | 'failed'`. That is a complete
vocabulary for a level or a match. It has no term for what a tabletop session
actually does, which is **end** — players stop, the room closes, nobody won.

So a TabletopLabs session can be finalized only by having its status
projection claim `won` or `failed` for a session that merely stopped.

That is worse than not exporting at all. v0.20's headline is third-party
verifiable signed evidence with `trusted` / `unverifiable` / `rejected`
verdicts; putting a fabricated outcome inside a signed artifact corrupts
precisely the property the signatures exist to establish. A verifier would
return `trusted` for a claim the product invented.

`outcome` does not provide an escape. It is not stored in `SessionEvent`, so
`finalizeReplay`, which receives only a transcript, cannot use it to recover a
terminal meaning. Nor can `{ nonTerminal: true }` honestly solve the problem
inside the current replay schema: `ReplayLevelResult.status`, the JSON Schema,
the TypeScript and Python validators, and recheck all accept only `won` or
`failed`.

**Accepted design direction for v0.21.**

1. Add `'ended'` to `SessionView.status` and the resolution result stored in
   `SessionEvent`.
2. Add `'ended'` to `ReplayLevelResult.status` in a new replay format version
   (provisionally `gaos.replay` v1.3). Existing v1.1/v1.2 artifacts and their
   strict parsers remain unchanged.
3. Update the packaged JSON Schema, TypeScript validator/rechecker, Python
   validator, fixtures, documentation, and cross-language golden tests
   together.
4. Define `stars` as `null` for `ended`; `actionsUsed` remains the reducer's
   replay metric. Aggregate star totals continue to count only `won` levels.
5. Require the terminal transition to be reducer-replayable. A product ends
   the room through an ordinary or host-derived deterministic action whose
   replay produces `status: 'ended'`; finalization must not invent the status
   from an out-of-band room close.

Adding a union member can break exhaustive TypeScript switches even though old
reducers never emit it. That source-compatibility impact and the new wire
version must be called out in the v0.21 migration notes.

## 2 — Bound live kernel state, and rehydrate from a checkpoint

**v0.21. Session-length ceiling. Not addressed by v0.20.0.**

`KernelState.events` grows for the life of the session and is never trimmed —
no truncation, compaction, or windowing anywhere in `src/session.ts`
(the only writes are `src/session.ts:1232` and `:2656`). `rehydrateKernel`
replays the whole log, so restart cost is linear in session age, unbounded.

Measured on our host at 20 Hz, empty ticks, a one-entity world:

| | measured |
| --- | --- |
| events per tick | 2.0 (one `resolution` + one `checkpoint`) |
| retained bytes per tick | 286 B |
| **projected 1 h @ 20 Hz** | **144,000 events, 19.7 MiB retained in memory** |
| rehydrate, 200 ticks | 19 ms → ~7 s per hour of history, growing linearly |

A real table with player input is strictly worse. For a Durable Object — the
deployment RFC-006 §1 names for TabletopLabs — that is a memory ceiling of a
few hours per room and a restart cost that grows until eviction cannot
rehydrate inside a request. `SessionLimits` bounds `maxCatchUpTicks`,
`receiptRetention`, and `maxExtensionBytes`; the one thing that grows every
tick is unbounded.

A contributing detail: a normal one-tick `prepareAdvance` emits one
`checkpoint` after its resolution. A catch-up call can cover multiple
resolutions with one checkpoint, so the precise current cadence is
per successful advance/timeout transition that resolves work, not inherently
per individual resolution.

Retention is also on the hot path. `forkLive()` copies the complete events
array for every prepared transition. Without compaction, preparation cost
therefore grows with session age and total work becomes quadratic even before
restart cost is considered.

### 2.1 A checkpoint is more than the current digest

The current checkpoint digest covers cursor, tick, and canonical seat views.
It does **not** serialize or authenticate the reducer state, open intent
window, transition revision, receipts/tombstones, permanent submission
identities, commitments, used salts, interest declarations, view revisions, or
rejection-delivery history. Two hidden reducer states may also project the same
seat views. The existing digest alone is not a recovery snapshot.

Define a versioned `KernelCheckpoint` contract that contains or can restore
every simulation and protocol field needed to continue exactly. State that
cannot be represented as portable JSON needs an explicit product-provided
checkpoint codec, separate from `SessionStateIsolation.fork`. The checkpoint
must bind:

- the exact session header;
- its transition-revision, cursor, and tick watermark;
- the serialized reducer state and current intent window;
- retry/idempotency, commitment/reveal, interest, and observation revision
  state needed after the watermark; and
- a canonical integrity digest over the checkpoint payload, not merely its
  projected views.

`rehydrateKernelFromCheckpoint(options, checkpoint, tail)` must reject a header
mismatch, a non-contiguous tail, an event at or before the checkpoint
watermark, and a final digest mismatch. Restoring from a host checkpoint is a
runtime recovery optimization, not independent verification: portable replay
recheck still begins from the reducer's pinned initial state and the complete
durable record stream.

### 2.2 Compaction needs protocol watermarks

Add a compaction entry point only after a checkpoint is durably committed.
Compaction removes the in-memory event prefix; it does not authorize deleting
the durable evidence needed by `finalizeReplay` or independent recheck.

The current `snapshot(seat, afterTransitionRevision)` scans retained events for
rejection notices. A compaction API must therefore do one of the following:

- retain the bounded rejection information needed by supported client
  watermarks; or
- expose a retention floor and return an explicit `resync_required` result
  when a caller asks from before it.

Silently returning a full view without omitted rejection notices is not
acceptable. The reference host and `PredictionSession` must use the same
retention-floor rule.

### 2.3 Bound all session-age state, not only `events`

Event compaction alone does not prove a hard session-length ceiling.
`historicalSubmissionKeys`, interest command history, commitments, and used
salts also require an audit. Any exact permanent-membership guarantee that
cannot be represented in bounded memory needs a host-backed lookup/preflight
contract or an explicitly bounded protocol rule; it must not be silently
dropped during checkpoint restore.

### 2.4 Checkpoint cadence

Add a positive `checkpointInterval` to `SessionLimits`, measured in resolved
ticks, with the current effective cadence as the compatibility default. A
forced checkpoint must be available before compaction and orderly shutdown.
Catch-up transitions emit a checkpoint when they cross the interval rather
than one checkpoint per internal resolution.

Acceptance evidence must show:

- restore equivalence for reducer state, observations, cursor/tick, open
  intents, receipts, commitments, interests, and rejections;
- corruption and non-contiguous-tail rejection;
- exact duplicate/conflict behavior across a checkpoint;
- portable finalization from the separately retained complete durable log; and
- bounded prepare latency and memory after repeated compaction in a multi-hour
  20 Hz run.

**Corroborated independently by Arena (RFC-011 A4), and the two do not
overlap.** A4 measures the *durable* representation — ~815 B per turn, ~30 %
recomputable, against a 128 KiB Durable Object value cap. This §2 is about the
*in-memory* log: how many events accumulate and what rehydration costs. Both
consumers hit event-log size from opposite directions, which is about as
strong a signal as this RFC process can produce.

The distinction that matters for the fix: **Arena's host-side remedy does not
generalize to tick cadence.** Arena chunks across storage keys, which works
because its event count is bounded by content — 375 actions for a level,
760–1305 for a run. A tabletop session's count is bounded by wall-clock
instead, so there is no chunk count that suffices and no natural end to chunk
toward. Documentation of durable size (A4's proposal) fully closes A4 and does
not close §2; §2 needs the compaction and checkpoint-rehydration entry points.

**Interaction with §1.** These are independent blockers on the same
capability. Even with a terminal status, a session long enough to be worth
recording cannot hold its own transcript; even with compaction, an open-ended
session cannot finalize what it held. Fixing one without the other leaves
portable replay unreachable for this product shape.

## 3 — Ship `PredictionSession`; the extraction source now exists

**Accepted for v0.21. Promised for v0.20 (RFC-009 §3.1); not shipped.**

RFC-009 §3.1 deferred `PredictionSession` deliberately and correctly:

> let TTL hand-roll reconcile against the stable v0.19 acknowledgement
> contract, then extract the class from a working implementation. … TTL is the
> only source of truth for this API, and designing it before TTL has run it
> would be guessing.

That reconcile now exists, is tested, and has survived a codec migration:
`src/net/session/ObservationReconciler.ts` in the TabletopLabs repo. The gate
has passed and nothing shipped in v0.20.0.

The parts worth extracting are the ones that were not obvious from the spec:

- settling **acknowledged and rejected** identities from pending, since a
  rejected submission will never land and must not be replayed;
- replaying the remainder in **original local enqueue order**, not arrival
  order and not any order the server implied;
- gap detection keyed on `origin`, now that the envelope states provenance;
- folding codec-v2 bodies through `applyObservationDelta` while retaining the
  previous view as the patch base — and treating a patch that arrives with no
  base as a resync rather than an error, which happens whenever a stream
  starts mid-session.

That last one is a trap worth encoding in the shipped class: a client that
reads `body.view` directly still typechecks against v2 and silently drops
every patch, diverging with no error.

Extraction must bring focused tests for acknowledgement/rejection settlement,
enqueue-order replay, transition gaps, snapshot recovery, patch-without-base
recovery, and digest mismatch. The public API and package export are frozen
from that evidence, not copied wholesale from product-specific networking
code.

## 4 — Ship the reference host adapter and conformance kit

**Accepted for v0.21. Promised for v0.20 (RFC-009 §3.2); not shipped.**

`dist/` exports `.`, `./protocol`, `./engine`, `./session`, `./agent`,
`./agent-cli`, and fixtures. There is no host adapter and no conformance kit,
so every host still reimplements from prose:

- `prepare → persist → commit → publish`, with transitions serialized per
  kernel so two callers cannot hold open prepared transitions at once;
- `eventId` idempotency **with conflict detection** — a duplicate id carrying
  byte-identical data is a retry, the same id with different bytes is
  corruption and must throw.

The second is the dangerous one. The natural implementation — `put` and move
on — silently accepts a rewritten history as a retry, and nothing downstream
notices. It is exactly the failure a conformance kit exists to catch.

RFC-009 §2.3 already argued these are "subtle enough that both hosts will get
it wrong unsupervised". That is still true, and there is now a second
implementation to check the extracted shape against:
`src/net/session/SessionKernelHost.ts` and `worker/src/eventStore.ts`.

The kit must exercise every crash boundary, stale prepared transitions,
byte-identical event retries, conflicting event reuse, and publish retry after
durable commit. RFC-012 §2 checkpoint/compaction behavior joins the kit if both
ship in the same release.

## 5 — Expose the advance deadline

**Accepted for v0.21 as documentation plus a convenience accessor.**

With a tick-bounded `timeoutPolicy`, `prepareAdvance` throws `not_ready` once
an open window passes its deadline, resolvable only by `prepareTimeout`. The
throw shipped; the discoverability half did not.

The deadline is already derivable: the host supplied
`timeoutPolicy.windowTicks`, and the kernel exposes both `tick()` and
`sessionHeader()`. For the open window it is `tick() + windowTicks`. The gap is
therefore discoverability and duplicated host arithmetic, not inaccessible
state.

Ship a `nextDeadline(): number | undefined` accessor on `SessionKernel`.
It returns `undefined` when no tick-bounded timeout policy applies or the
current window is already complete. A field on `SessionAdvanceError` is not a
substitute because it becomes available only after the host has reached the
deadline.

The normative host obligations must also show the ticks-mode loop: schedule
against `nextDeadline()`, and escalate a deadline `not_ready` result to
`prepareTimeout` through the same persist → commit → publish discipline.

## 6 — Consolidate the already-intended seat lifecycle answer

**Resolved design; v0.21 documentation consolidation only.**

`options.seats` is fixed at construction; there is no `addSeat`, `removeSeat`,
or `setSeats`. That fits Arena, where a match begins with its roster. It does
not fit a tabletop session, where the seat lifecycle is live: claim, release,
swap, spectate, kick, reconnect.

We bridge it by declaring the full roster up front and modelling occupancy as
product state inside the reducer, with participation as a session constant.
That works. The cost is that the transcript records a session whose
participants never changed while the real ones changed repeatedly, and per-seat
observations are derived for seats nobody occupies.

Existing guidance already supplies the answer:

- `docs/high-frequency.md` models disconnect, rejoin, and human/bot
  substitution as host events represented by ordinary deterministic inputs;
- `docs/mechanisms/information-partitions.md` states that a spectator is not a
  player seat and cannot submit; and
- `docs/trust-and-verification.md` makes a signed v1 roster immutable for the
  session.

For v0.21, consolidate and cross-link that rule in
`docs/session-and-integrity.md`: declared kernel seats and the signing roster
are fixed; live occupancy, driver assignment, reconnect, kick, and claim state
are product state or host authentication state; spectators use observation
delivery rather than action-capable seats. No mutable-seat kernel API is
requested.

## 7 — Report both seat sets in the participation error

**Accepted v0.21 diagnostic.**

```
TypeError: reducer participation must name one or more declared session seats
```

The invariant is right; the reporting is not. Initial participation is already
validated during kernel construction, and participation derived from later
views is validated after resolution. In either location, the message names
neither the declared set nor the supplied one, so the reader cannot tell which
side is wrong.

Concretely: our reducer derived participation from *occupied* seats. An
authoritative room starts with zero occupied and fills as players arrive, so
it threw on the first tick, before anyone could sit. The fix was ours —
participation is a session constant — but the message pointed at neither set.

Include both sets in canonical lexical order and identify whether the supplied
set was empty or contained undeclared seats. Retain construction-time
validation for the initial view and transition-time validation for later views.

---

## Compatibility

Compatibility is item-specific:

- §1 changes `SessionView`, `SessionEvent`, `ReplayLevelResult`, and the
  portable schema under a new replay format version. Existing v1.1/v1.2
  artifacts and validators remain supported unchanged.
- §2 adds checkpoint, restore, compaction, retention-floor, and cadence
  contracts. Existing genesis rehydration remains supported.
- §3 and §4 add public modules and conformance fixtures.
- §5 adds a kernel accessor and documentation.
- §6 is documentation only.
- §7 changes diagnostic prose only.

The v0.21 migration notes must call out exhaustive status switches and the new
replay version. No existing transcript or artifact is silently reinterpreted.

## Out of scope

`TickView` versus `SessionView` was resolved by v0.20 and needs no further
change. Nothing is requested for `./agent`, `./agent-cli`, or the Arena client
surface, which TabletopLabs does not consume. Mutable kernel seats remain out
of scope. Checkpoint restore is not a shortcut for independent replay
verification.

## Evidence

Every original item came from building and running the host, not from reading
the spec. §1 came from tracing what a finished tabletop session could export;
§2 from measuring a room at tick cadence; §3 and §4 from having written both
pieces by hand; §5 from duplicated deadline scheduling logic; and §7 from a
room whose participation was empty before its first player sat down.

Arena has reported against v0.20 (RFC-011). Its resolved A4 and this §2 are the
same wall approached from the durable and in-memory sides respectively, by two
consumers at different cadences. RFC-011 A1/A2 (`prepareIngest` precedence and
rejection typing) remain disjoint TabletopLabs surfaces.

The v0.21 disposition is therefore: §1 proceeds with an explicit replay-format
change; §2 proceeds only with the full checkpoint and compaction invariants
above; §3/§4 are accepted delivery work; §5 is an accessor plus docs; §6
consolidates existing guidance; and §7 is a diagnostic improvement.
