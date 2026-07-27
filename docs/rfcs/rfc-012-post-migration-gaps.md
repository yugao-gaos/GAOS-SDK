# RFC-012 — SDK gaps after the TabletopLabs migration completed

Status: **proposed (2026-07-26)** · Target: v0.21 · Breaking: no (all items additive) ·
Depends on: RFC-006, RFC-009 · Source: the completed TabletopLabs migration and its authoritative host

The TabletopLabs migration is **done**: reducer adapter, host adapter, client
reconciler, and a Cloudflare Durable Object host running the kernel in ticks
mode, merged and green. This RFC is what running it surfaced, scoped to
changes the SDK should make.

An earlier draft of this RFC reported findings against the v0.19 baseline.
**v0.20.0 adopted most of it** — recorded in §0 so the loop is visibly closed.
§1–§7 are what remains, re-derived against the released v0.20.0 (`f40b07e`).

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

## 1 — An open-ended session cannot be finalized

**Additive. Blocks replay export for tick-paced products.**

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

`outcome` does not provide an escape. `outcome: { kind: 'decided', ranking }`
exists and is the honest way to say "this session concluded without a winner",
but the guard reads `terminal.result.status`, which is derived from
`SessionView.status` — so `outcome` never reaches the decision.

**Requested**, in preference order:

1. A terminal status that means concluded-without-a-result — `'ended'` (or
   `'abandoned'`) added to `SessionView['status']`. Additive to a union;
   existing reducers never produce it and existing readers that switch on
   `won`/`failed` need a default they should already have.
2. Failing that, let `outcome.kind === 'decided'` satisfy the terminal guard,
   so a product can conclude a session through the multi-seat vocabulary that
   already exists.
3. Failing both, an explicit `finalizeReplay(transcript, { nonTerminal: true })`
   that records the transcript as ended-without-outcome, so the artifact says
   what happened instead of asserting something false.

## 2 — Bound the live transcript, and rehydrate from a checkpoint

**v0.21. Hard ceiling on session length. Unchanged from the earlier draft; not addressed by v0.20.0.**

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

A contributing detail: `checkpoint` is emitted on **every** resolution. At
20 Hz that doubles the log to carry a digest whose value is periodic
verification, not per-tick provenance.

**Requested**, in value order:

1. **Rehydrate from a checkpoint plus a tail** rather than from genesis. The
   kernel already emits digests and hosts already persist them; what is
   missing is an entry point accepting `(state snapshot, events after it)`.
   This removes the unbounded restart cost.
2. **Let the host compact the live transcript** behind a durable watermark —
   the host has already persisted those events, so the in-memory copy is a
   cache. `truncateLiveTranscript(beforeTransitionRevision)` or similar.
3. **Make checkpoint cadence a `SessionLimits` option** instead of every
   resolution.

A host cannot work around any of this: `liveTranscript()` is read-only and the
kernel owns the array.

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

**v0.21. Promised for v0.20 (RFC-009 §3.1); not shipped.**

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

## 4 — Ship the reference host adapter and conformance kit

**v0.21. Promised for v0.20 (RFC-009 §3.2); not shipped.**

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

## 5 — Expose the advance deadline

**Additive. Partially addressed in v0.20.0.**

With a tick-bounded `timeoutPolicy`, `prepareAdvance` throws `not_ready` once
an open window passes its deadline, resolvable only by `prepareTimeout`. The
throw shipped; the discoverability half did not.

`SessionAdvanceError` carries `code` and `message` only. The deadline is
computed inside the kernel and appears in an error string. A host cannot
schedule a timeout it cannot see coming, so it can only learn the deadline by
hitting it — which for a tick loop means a terminal state reached by
accident rather than one scheduled for.

**Requested.** A `deadline` field on `SessionAdvanceError`, or a
`nextDeadline()` accessor on the kernel. Related: the normative host
obligations should state that a ticks-mode host escalates `not_ready` to
`prepareTimeout`, with the worked loop — the same treatment
`persist → commit → publish` received.

## 6 — State the intended answer for seat lifecycle

**v0.21. Design question, not a defect.**

`options.seats` is fixed at construction; there is no `addSeat`, `removeSeat`,
or `setSeats`. That fits Arena, where a match begins with its roster. It does
not fit a tabletop session, where the seat lifecycle is live: claim, release,
swap, spectate, kick, reconnect.

We bridge it by declaring the full roster up front and modelling occupancy as
product state inside the reducer, with participation as a session constant.
That works. The cost is that the transcript records a session whose
participants never changed while the real ones changed repeatedly, and per-seat
observations are derived for seats nobody occupies.

We are **not** asking for mutable seats. We are asking for the intended answer
to be stated normatively: is occupancy in scope for the kernel, or is "declare
the roster, model occupancy in the reducer" the design? It is not obvious, and
it is the kind of question two consumers answer differently and diverge on.

## 7 — Report both seat sets in the participation error

**Diagnostics. Minor. Unchanged from the earlier draft.**

```
TypeError: reducer participation must name one or more declared session seats
```

The invariant is right; the reporting is not. It fires at advance time
although the seat set is fixed at construction, and it names neither the
declared set nor the supplied one, so the reader cannot tell which side is
wrong.

Concretely: our reducer derived participation from *occupied* seats. An
authoritative room starts with zero occupied and fills as players arrive, so
it threw on the first tick, before anyone could sit. The fix was ours —
participation is a session constant — but the message pointed at neither set.

Include both. Optionally validate at construction where the reducer's
participation is statically knowable.

---

## Compatibility

Every item is additive: one union member on `SessionView['status']` (§1), new
entry points for compaction and checkpoint rehydration (§2), two new shipped
modules (§3, §4), one field or accessor (§5), documentation (§6), and an error
message (§7). No change to `SessionKernel`, `SessionEvent`,
`ObservationDelta`, or the `gaos.replay` schema.

## Out of scope

Nothing here asks to reshape a contract. `TickView` versus `SessionView` was
resolved by v0.20 and needs no further change. Nothing is requested for
`./agent`, `./agent-cli`, or the Arena client surface, which TabletopLabs does
not consume.

## Evidence

Every item came from building and running the host, not from reading the spec.
§1 from tracing what a finished tabletop session could export; §2 from
measuring a room at tick cadence; §3 and §4 from having written both pieces by
hand; §5 from a tick loop that could not schedule around a deadline it could
not read; §7 from a room that threw before its first player sat down.

Arena has reported against v0.20 (RFC-011). One item cross-checks: its A4 and
this §2 are the same wall approached from the durable and in-memory sides
respectively, by two consumers at different cadences. The rest are disjoint —
Arena's A1/A2 (`validateCommand` precedence and rejection typing) and A3 (run
cursor rebasing) are surfaces TabletopLabs does not touch, and nothing in
RFC-011 bears on seat lifecycle.

So §6 is still uncorroborated and should wait. §1, §3, §4, and §5 are
single-consumer findings — though §3 and §4 are less "findings" than delivery
of work v0.20 was scheduled to contain.
