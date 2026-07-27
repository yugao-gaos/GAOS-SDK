# RFC — `./session`: the authoritative session kernel (optional subpath)

Status: **implemented (rev 10, v0.19.0, 2026-07-25)** · Target: v0.19 · Breaking: no
(new subpath; requires the gaos.replay v1.1 format bump, which lands first)

Current disposition (rev 10, 2026-07-25): §§1–6 are the sole normative
text except the `PredictionSession` class sketch in §3.2, which is deferred to
v0.20. Rev 10 makes rejection notices durable observation envelopes,
adds transition-watermark snapshot recovery, and makes every accepted
submission identity permanently single-use. Rev 9 adds deterministic
per-seat rejection notices, pins
`viewRevision(seat) === cursor()`, validates timeout audit context, and makes
accepted submission IDs permanently non-reapplicable after receipt eviction.
Rev 8 adds the stable v0.19 acknowledgement identity/order contract
and the multi-level `finalizeRunReplay` projection required by RFC-009.
Rev 5 resolves the fourth review: §3.1 adds SessionStateIsolation
(fork/discard/retire) so mutable/COW reducers are first-class in prepared
transitions — the kernel never assumes fresh-state reducers (§J) — and rev 6
adds the exactly-once abort/retire lifecycle (§L). Earlier
revisions: completed options contract (G1), opaque Prepared payload (G2),
transitionRevision separated from the gameplay cursor (G3), live/finalized
transcript split, snapshot-first deltas, durable intent receipts. The
commitment envelope lives in RFC-008. Review/revision history: §§C–L.

Final design review (2026-07-25): **approved for implementation**, with
`gaos.replay` v1.1 and the transactional/crash-recovery suites as merge gates.
See §M.

Implementation evidence (2026-07-25): `src/session.ts`,
`src/engine/replay-format.ts`, and `test/session.test.ts` cover the prepared
lifecycle, mutable-state isolation, durable partial windows, rehydration,
atomic grouped replay, timeouts, checkpoints, observation revisions,
acknowledgement ordering, multi-level run composition, and bounded tick
catch-up.

Fifth review (2026-07-25): mutable/COW isolation is resolved, but the host
cannot explicitly abort an opaque prepared transition after persistence
failure because the public API exposes only `commit`. See §K.

Fourth review (2026-07-25): G1 and G3 are resolved, but G2 relies on an
immutability rule the SDK does not impose. Mutable/COW reducer isolation must
be specified before design approval; see §I.

## 1. Motivation

Two production consumers already run the same architecture at different
cadences:

- **Arena (`agilabs-arena`)**: one Durable Object per session
  (`packages/worker/src/session-do.ts`) — single writer holding the
  server-generated seed, full game state, an append-only transcript, and the
  SDK intent window; it validates/orders submissions, advances the
  deterministic reducer exactly once per resolution, and derives per-seat
  observations (`observe`/`observeAll`). Turn-paced.
- **TabletopLabs** (planned `split/server-authoritative` resolver mode): a
  headless full-state peer (also a DO) running the same deterministic World
  from the same input log; clients receive only interest-managed, per-seat
  view streams and reconcile local predictions against them. Tick-paced.

The kernel of both is identical: **ingest inputs → canonically order →
advance the deterministic simulation → append transcript → derive per-seat
observations → emit view deltas**. Because the SDK's A.3 unified model
already establishes that sequential, simultaneous, and fixed-cadence play are
one intent-collection model, one kernel parameterized by cadence is the
architecturally honest implementation — and duplicating it per product would
let transcript semantics drift, which silently breaks cross-product
`gaos.replay` verification.

Mission argument: third-party hosts that want to run GAOS games as benchmark
arenas need exactly this piece to be correct (input ordering, anti-cheat
transcript, honest per-seat observation). Shipping it makes "any game can be
an arena" a batteries-included claim.

## 2. Boundary

The kernel is **synchronous, deterministic, IO-free logic** (effects are
returned, never performed — §F-E2). It owns:

- input ingestion with idempotent-submission and cursor semantics (reusing
  `./protocol`: `collectIntent`, `createIntentWindow`,
  `validateIntentSubmission`, envelopes);
- canonical ordering (`canonicalizeLockstepInputs`) and cadence policy
  (sequential window / simultaneous window with timeouts-as-inputs / fixed
  tick rate via `createTickRate`);
- advancing an injected `Reducer` (`TickReducer.advance` preferred;
  `ActionReducer` compat) exactly once per resolution — never sequential
  re-application that would introduce arrival-order bias;
- transcript append in `gaos.replay` records (header, actions, tick fields);
- per-seat observation derivation (`viewFor` / `deriveSeatView`) and
  **observation delta records** (new, §3.3);
- digest checkpoints (`stateDigest`) for client reconciliation checks.

The kernel never owns: sockets/HTTP, storage, wall clocks (time arrives as
injected timeout inputs, per the A.5 time-as-input rule), auth/identity
(hosts map credentials → seat before ingestion), matchmaking, billing,
hibernation strategy. Those live in **host adapters**.

Placement: new subpath `./session`. It may depend on `./engine` and
`./protocol`. After the prepared-transition decision (§F-E2) the kernel has
NO injected IO and no async edge: it is synchronous deterministic logic that
returns effect descriptions (events, deltas) for the host to execute, and is
unit-testable without any adapter.

## 3. Contracts (sketch)

### 3.1 Kernel

```ts
export interface SessionKernelOptions<
  TLevel,
  TState,
  TCommand extends JsonValue,
  TView extends TickView<unknown, unknown>,
> {
  sessionId: string;
  game: ReplayGameRef;
  levelId: string;
  levelVersion?: string | number;
  reducer: Reducer<TLevel, TState, TView>;
  level: TLevel;
  seed: number;                        // host-generated, never client-supplied
  seedPolicy: ReplaySeedPolicy;
  seats: readonly string[];
  cadence:
    | { mode: 'turns' }                                  // resolve per collection window
    | { mode: 'ticks'; rate: TickRate };                 // fixed-rate; empty ticks are cheap
  /**
   * Explicit host clock policy. Providers return UTC epoch milliseconds:
   * `Date.now()` is suitable; monotonic `performance.now()` is not.
   * `'none'` omits event timestamps for reproducible transcripts.
   */
  hostTime: (() => number) | 'none';
  /** Pure mapping from protocol commands to reducer actions. */
  commandToAction(command: TCommand, context: CommandContext): SubmittedAction;
  dmath?: Dmath;                       // RFC-007 immutable context, recorded in the header
  limits?: SessionLimits;              // §D-Q6 bounds
  /** §I: required for mutable/COW reducers; see SessionStateIsolation. */
  stateIsolation?: SessionStateIsolation<TState>;
}

/**
 * State isolation for prepared transitions (§I). The SDK reducer contract
 * requires determinism, NOT persistent immutability — in-place mutation with
 * COW rollback is a documented, supported reducer style. The kernel
 * therefore never assumes fresh-state reducers:
 *  - absent `stateIsolation`: the kernel applies a documented default
 *    (`structuredClone`) valid only for structured-cloneable state; reducers
 *    whose state is not cloneable or that mutate external structures MUST
 *    supply `fork`;
 *  - `prepareAdvance` runs the reducer ONLY against the isolated draft;
 *  - `commit` publishes the prepared draft; persistence failure or a stale
 *    prepared transition invokes `discard`;
 *  - preparing never changes live observations, digests, or caller-held
 *    state references.
 */
export interface SessionStateIsolation<TState> {
  /** Isolated draft: mutating it must not affect `state` or live kernel views. */
  fork(state: TState): TState;
  /** Cleanup for discarded drafts (COW snapshots, pooled buffers, ECS handles). */
  discard?(draft: TState): void;
  /** §K: called exactly once with the PREVIOUS live state after a successful
   *  commit publishes its draft. Absent ⇒ retirement is product-managed
   *  (no-op). Makes external-resource ownership explicit for COW/ECS. */
  retire?(previous: TState): void;
}
// `perm` moved to FinalizeOptions (§D-Q5). Extension records enter via
// prepareExtension below, never via constructor options.

export interface SessionKernel<TCommand, TView> {
  /**
   * Prepared-transition model (§F-E2): prepare is pure and side-effect-free
   * on kernel state; the host persists `events` durably, THEN commits.
   * A prepared transition is single-use, revision-bound, and discardable.
   * Deltas and acknowledgements are sent only after durable commit.
   */
  prepareIngest(submission: CommandSubmission<TCommand>): Prepared<IngestReceipt>;
  prepareAdvance(target?: number): Prepared<AdvanceSummary<TView>>;
  prepareTimeout(
    timeout: TimeoutInput,
    forcedInput: SubmittedAction,
  ): Prepared<AdvanceSummary<TView>>;
  /** Structurally non-gameplay lane (§D answer 2); recorded, never reduced. */
  prepareExtension(lane: string, record: JsonObject): Prepared<void>;
  commit(prepared: Prepared<unknown>): void;
  /** §K: exactly-once completion — every prepared transition ends in ONE
   *  commit or ONE abort. abort leaves live state and transitionRevision
   *  unchanged and calls stateIsolation.discard on the draft. Persistence
   *  failure REQUIRES abort. A stale prepared passed to commit is
   *  auto-aborted before the typed error is thrown (no second host call).
   *  abort is idempotent after an automatic or explicit abort. Double
   *  commit, commit-after-abort, abort-after-commit, and foreign values
   *  throw typed lifecycle errors without re-running cleanup. */
  abort(prepared: Prepared<unknown>): void;

  observe(seat: string): TView;
  observeAll(): Readonly<Record<string, TView>>;
  cursor(): number;
  tick(): number;
  viewRevision(seat: string): number;
  snapshot(
    seat: string,
    afterTransitionRevision?: number,
  ): ObservationDelta;                                  // reconnect/late-join path
  sessionHeader(): SessionHeader;
  liveTranscript(): SessionTranscript;                   // append-only event log
  digest(): number;
}

declare const preparedTransition: unique symbol;

export interface Prepared<TResult> {
  /** §G3: transition counter, advances on EVERY committed transition. */
  readonly baseTransitionRevision: number;
  readonly nextTransitionRevision: number;
  readonly events: readonly SessionEvent[];
  readonly deltas: readonly ObservationDelta[];
  readonly result: TResult;
  /** Package-private computed next state (reducer state, window, receipts,
   *  transcript cursor, observations, digests). Hosts persist `events` but
   *  cannot construct or modify a valid prepared transition. */
  readonly [preparedTransition]: PreparedState;
}

export interface AdvanceSummary<TView> {
  resolutions: number;
  partial: boolean;
  cursor: number;
  tick: number;
  digest: number;
  deltas: readonly ObservationDelta<TView>[];
  /** One routable identity notice per destination seat for each rejection. */
  rejections: readonly ObservationRejectionNotice[];
  warnings: readonly SessionWarning[];
}

export interface ObservationRejectionNotice {
  seat: string;
  transitionRevision: number;
  tick: number;
  participantId: string;
  submissionId: string;
  code: 'commit_mismatch';
}
// Event ids: `sessionId + transitionRevision + eventIndex` (storage-retry
// idempotent). The gameplay window cursor is a SEPARATE counter recorded on
// events that need it; rehydration restores both (§G3).

/** Finalization is a pure projection at a terminal result (see §D1). */
export function finalizeReplay(t: SessionTranscript, o: FinalizeOptions): ReplayArtifact<unknown>;
/** Ordered one-level transcripts become one derived-seed run (§3.5). */
export function finalizeRunReplay(
  transcripts: readonly SessionTranscript[],
  options: FinalizeRunOptions,
): ReplayArtifact<unknown>;
```

Determinism rules (contractual): ingestion order never affects outcomes —
only canonical order does; `advance` in ticks mode may fast-forward many
empty ticks in one call (event-driven hosts batch on message/alarm arrival,
which is how a DO avoids wall-clock ticking).

`prepareTimeout` accepts a non-empty timeout ID and reason (`elapsed`,
`disconnect`, or a product-defined string) for the current open tick. A named
participant must belong to and still be awaiting input in that window; its
forced input is normalized to that seat and cannot name another.
A window-wide timeout (`participantId: null`) cannot carry a seat-specific
system action. Timeout system inputs cannot carry commitment/reveal
verification fields. Finalization rejects any timeout audit event that does
not immediately match either its recorded timeout resolution or a
same-transition rejection. A successful timeout must match the window
reference, participant, and system input. A rejected timeout records
`timeout`, then `rejection`, then `checkpoint`; its forced input was not
applied.

In v0.19 these timeout and commitment-rejection audit records are advisory
host attestation. Live pre-reducer verification remains authoritative for
gameplay, but portable replay consistency does not authenticate audit
authorship or completeness. Leaderboard policy must not rely on the audit
lane until RFC-010 supplies signed chained submissions.

`SessionKernelOptions.hostTime` makes the host's choice explicit: a provider
returns UTC epoch milliseconds (`() => Date.now()`), while `'none'` omits
`SessionEvent.hostTime` and keeps transcripts reproducible from seed and
inputs. The kernel never reads a clock itself; a provider returning
`null`/`undefined` is invalid rather than a fallback. `performance.now()` is
the wrong source because it is monotonic process-relative time, not epoch
time.

When present, `hostTime` is advisory. It is never reducer input,
signature-preimage material, or part of semantic input-to-transcript
equivalence. Rehydration preserves recorded values exactly and accepts
timestamp-free events. Replay projection is opt-in through
`FinalizeOptions.includeHostTime`; verification ignores the value. Ordering
is always `tick`, `cursor`, and `transitionRevision`, never `hostTime`,
because wall clocks can move backwards after NTP or manual correction.

`IntentCollectionError` and its `IntentErrorCode` union are re-exported from
`./session`, so a host can map protocol ingest failures without reaching into
a second package subpath. Session conflicts and advance failures retain their
own exported typed classes.

### 3.2 Client companion (informative; deferred to v0.20)

`PredictionSession` is deliberately not part of the v0.19 implementation.
The acknowledgement identity/order contract it needs is now normative in
§3.3. The class remains deferred so v0.20 can extract its construction,
rollback, and pending-action API from TabletopLabs' working migration rather
than design those pieces speculatively. The sketch below records direction
only and is not normative.

```ts
export interface PredictionSession<TView> {
  /** Record a local input optimistically and return the predicted view. */
  predict(action: SubmittedAction): TView;
  /** Apply an authoritative per-seat delta; returns corrections to replay. */
  reconcile(delta: ObservationDelta): ReconcileResult<TView>;  // rolled-back? reapplied pending?
  pending(): readonly SubmittedAction[];
}
```

Reducer-shaped hosts get rollback-by-resimulation for free (`resimulate`).
Hosts with mutable state (TabletopLabs' ECS) implement `reconcile` over
their own rollback machinery; the contract only fixes the delta format and
the pending-input replay discipline.

### 3.3 Observation deltas (new wire records)

```ts
export interface ObservationDelta {
  seat: string;
  transitionRevision: number; // durable resume watermark
  viewRevision: number;    // monotonic per seat; advances on EVERY resolution
  tick: number;
  codec: 'v1';             // v1 is snapshot-only; patch codecs are future, negotiated
  acknowledgements: readonly {
    participantId: string;
    submissionId: string;
  }[];
  rejections: readonly ObservationRejectionNotice[];
  body:
    | { kind: 'snapshot'; view: TickView<unknown, unknown> }
    | { kind: 'unchanged' };
  /** Canonical-JSON FNV-1a digest — DIAGNOSTIC ONLY (not auth/anti-cheat). */
  viewDigest: number;
}
```

The kernel computes deltas from successive `viewFor` outputs — products never
hand-write redaction on the wire. `acknowledgements` contains every user input
applied by the resolution that produced this `viewRevision`, in exact
canonical reducer-input order. Host-derived inputs with a null submission id
are excluded. Every seat delta for one resolution carries the same identities;
the identities acknowledge ordering, not visibility of action payloads.
`snapshot(seat, afterTransitionRevision)` applies no new input and therefore
carries an empty acknowledgement list. It includes every durable rejection
notice after the supplied transition watermark; omitting the watermark means
zero and therefore replays all rejection identities. Duplicate rejection
notices are harmless because submission identities are permanently
single-use.

At every observable kernel state, `viewRevision(seat) === cursor()` for every
declared seat. Ingest, rejection, and extension transitions advance neither;
each resolution advances both by one. This equality is the stable bridge from
an `IngestReceipt.cursor` to the authoritative revision used after snapshot
resynchronization.

A rejected input creates one rejection-only `ObservationDelta` per destination
seat. Its `transitionRevision` advances to the durable rejection transition,
while its `viewRevision` remains equal to the unchanged gameplay cursor; the
body is `unchanged`, acknowledgements are empty, and `rejections` contains the
exact rejected identity. `AdvanceSummary.rejections` exposes the same notices
as a convenience. After durable commit the host publishes `prepared.deltas`
normally. A client removes the exact `(participantId, submissionId)` from
pending and records the transition watermark. If delivery fails, the host
retries the prepared delta or supplies
`snapshot(seat, lastTransitionRevision)`, which reconstructs missed notices
from durable rejection events. Rejection notices are therefore part of the
frozen v0.19 reconciliation contract, not an out-of-band product convention.

Clients consume observation envelopes in increasing `transitionRevision`
order and resolution bodies in increasing `viewRevision` order. Multiple
resolution bodies prepared in one transition are ordered by `viewRevision`;
a rejection-only envelope may share the current `viewRevision`. For each
envelope clients apply any newer authoritative body, remove pending
submissions whose
exact `(participantId, submissionId)` identity appears in
`acknowledgements` or `rejections`, then replay the remaining pending inputs
in their original local enqueue order. Duplicate identities are harmless. A
view-revision gap requires retransmission or snapshot/resync; clients must not
guess the missing acknowledgement order.

### 3.4 Host obligations (adapter interface withdrawn — §D2/§F-E2)

The kernel returns effects; it never performs IO. The host contract, in
order, per transition: (1) `prepare*`; (2) persist `prepared.events` durably
(event ids `sessionId + transitionRevision + eventIndex` make storage
retries idempotent, §G3); (3) `commit(prepared)`; (4) send `prepared.deltas`
and acknowledge the submitter. On persistence failure: call
`abort(prepared)` — kernel state never advanced, the draft is discarded via
`stateIsolation.discard`, exactly once. On successful commit the previous
live state is retired via `stateIsolation.retire` (absent ⇒
product-managed). On crash between persist and commit: rehydrate via
`rehydrateKernel(transcript)`; the persisted events win. Wall clocks never
enter the kernel — timeouts are ingested inputs (§F-E3).

### 3.5 Multi-level run projection

One kernel still owns exactly one level episode. `finalizeRunReplay` composes
an ordered, non-empty list of terminal level transcripts into one
`gaos.replay` v1.1 run:

- `FinalizeRunOptions.seed` is the run seed, and transcript `i` must record
  exactly `runLevelSeed(runSeed, i)` with `seedPolicy: 'explicit'` (a segment
  that already declares derived-seed policy would otherwise be derived twice);
- all segments must share `sessionId`, game/adapter identity, and dmath
  declaration;
- every non-final segment must end `won`; a failed segment terminates the run;
- action and record sequence numbers are reassigned globally and each record
  receives its ordered `levelIndex`; and
- `createReplayArtifact` derives per-level seeds and aggregate totals, keeping
  the format's existing validation and recheck path authoritative.

Independently seeded transcripts are rejected rather than silently assembled
under derived-seed semantics.

## 4. Extraction plan (from Arena's session-do)

Kernel-bound (pure) pieces, extracted with their tests:

- single-writer resolution loop; seed holding; perm shuffle application;
- intent-window lifecycle incl. timeout-as-pass (`timeoutIntent` becomes an
  injected timeout input);
- idempotency semantics: duplicate `submissionId` + identical command →
  stored resolution; conflicting retry → conflict result (the HTTP 202/200/409
  mapping stays in the worker adapter);
- `observe`/`observeAll`; transcript JSONL append (already `gaos.replay`).

Stays Arena-side (adapter): HTTP routes, owner binding (`x-arena-owner`),
R2 persistence, matchmaking, arena-policy timers/alarms, and the
`agilabs.arena` controlRevision substep — the last one motivates a generic
**extension-lane hook** in the kernel (product-defined side-channel records
that bypass gameplay ordering but land in the transcript).

Migration is opportunistic: the kernel is extracted to match session-do's
proven behavior (golden tests ported first); Arena swaps its DO onto the
kernel when convenient, not as a launch condition.

## 5. TabletopLabs adoption path (first new consumer)

1. New resolver mode in the module manifest (working name
   `server-authoritative`, now with a real implementation strategy): a
   headless DO peer runs the same deterministic World via the kernel in
   ticks mode.
2. Clients subscribe to their seat's `ObservationDelta` stream; local COW
   rollback is repurposed as the `reconcile` implementation (prediction →
   correction), replacing peer-to-peer resimulation in this mode.
3. Full-state P2P lockstep (`deterministic` mode) remains the default for
   casual play; the kernel mode is opt-in for hidden-information /
   competitive sessions.
4. Trust framing (documented): this is server-authoritative in trust terms —
   the DO is platform infrastructure; what the kernel adds is that the
   "server" needs zero bespoke game logic and its full transcript is
   replay-auditable after the session.

## 6. Test plan

- Kernel golden tests ported from session-do behavior (idempotency,
  conflict, window timeout, single-resolution guarantee).
- Cadence equivalence: the same input log resolved in turns mode and in
  ticks mode (one intent per tick) produces identical transcripts.
- Delta stream: for every seat, applying the delta stream from tick 0
  reproduces `observe(seat)` exactly (bit-identical), including across a
  simulated missed-delta → snapshot recovery.
- Leak check: assemble all deltas ever sent to seat A; assert no field ever
  contained data outside A's partition (reuses `assertNoInformationLeak`).
- End-to-end: two PredictionSessions + one kernel over an in-memory adapter
  play a hidden-hand game; predictions diverge and reconcile; final
  transcript passes `recheckReplayArtifact`.

## 7. Open questions

1. Extension lane semantics (Arena's controlRevision generalized): ordered
   with gameplay or parallel-but-recorded? Proposal: parallel-but-recorded,
   product opts into ordering.
2. Delta encoding: JSON Patch vs product-pluggable codec. Proposal: JSON
   Patch default, codec injectable, `viewDigest` makes either safe.
3. Presentation-layer streams (TabletopLabs' continuous physics poses) are
   out of kernel scope — hosts may run a parallel unverified cosmetic
   stream; document the split so nobody routes gameplay through it.

---

# §B — Companion: commitment envelope in `gaos.replay` (small, independent)

Player-authored secrets (simultaneous hidden orders, face-down choices)
should be commit–reveal even in full-state P2P mode. The format belongs in
the SDK because transcripts must verify across products.

- `SubmittedAction` gains optional `commit?: { hash: string; scheme: string }`
  and `reveal?: { salt: string; payload: JsonValue; commitTick: number }`.
- Verification helper (pure, hash function injected — engine stays
  zero-dependency): `verifyReveal(commit, reveal, hash)` returns a typed
  verdict; `recheckReplayArtifact` gains an optional hook that fails the
  replay when a reveal contradicts its commitment.
- Key/salt generation, hashing (SHA-256 via WebCrypto), and WHEN to commit
  remain product policy; the async hashing happens client-side before
  submission, never inside a reducer.

This closes hidden-info class 1 for P2P mode; classes 2–3 route to the
session kernel above.

---

# §C — Review notes and requested revisions (2026-07-25)

## Disposition

Approve the architectural direction: a product-neutral, single-writer session
kernel is the right shared boundary for authoritative turn and tick hosts.
Request revision before implementation. The current proposal assumes replay
and protocol capabilities that v0.18 does not yet provide.

## Required revisions

### 1. Separate the live session log from the finalized replay artifact

`transcript(): ReplayArtifact<unknown>` cannot be "always current" under the
current `gaos.replay` contract: every level requires a terminal `won` or
`failed` result, and every post-header record is a `ReplayAction`.

Introduce two explicit concepts:

- an append-only `SessionTranscript` containing typed session events while a
  game is ongoing; and
- a finalized `ReplayArtifact` produced when a terminal result is available.

Define the event union needed by the kernel. At minimum it must decide how to
represent action batches, empty/timeout resolutions, extension-lane records,
commit/reveal records, and checkpoints. If these become portable
`gaos.replay` records, update the JSON schema and bump the replay format
version; the v1 schema rejects unknown action properties and record kinds.

The verifier must also preserve the kernel's atomicity guarantee. The current
replay checker applies each action serially. Actions belonging to one
simultaneous window or tick must be grouped and passed to `advance` or
`applyIntents` exactly once during verification.

### 2. Complete and align the kernel API

- Replace the undefined `IntentSubmission` name with the existing
  `CommandSubmission<TCommand>` contract, or define an explicit session-owned
  submission type and its mapping to protocol commands.
- Add the generic command/state types needed by `ingest`, `advance`, and
  replay construction. `SessionKernelOptions` currently declares `TState`
  but not the command accepted by the protocol boundary.
- Add `sessionId`, game/adapter identity, level identity/version, replay seed
  policy, and any other data required to construct the replay header.
- Choose one effect boundary. Either inject `SessionHostAdapter` into the
  kernel or have pure kernel methods return transport/persistence effects for
  the host to execute. The current sketch declares an adapter but never
  supplies it.
- Expose the current cursor/revision and tick so a host can form submissions,
  reconnect clients, request snapshots, and schedule the next alarm.
- Specify `advance` precisely: inclusive or exclusive target tick, behavior
  for stale targets, maximum catch-up work, empty tick handling, and the
  turns-mode behavior when `target` is supplied.
- Define timeout input types and replay semantics. A host observing a wall
  clock and deciding that a timeout elapsed is an external input; the
  resulting timeout/pass must be durably ordered with gameplay.

`ActionReducer` compatibility must be described as limited: it cannot advance
an empty tick and cannot resolve multiple inputs atomically unless it provides
`applyIntents`.

### 3. Specify durable idempotency and receipt retention

The existing protocol makes exact retries idempotent inside one unresolved
intent window. The RFC additionally promises that an exact retry can return a
stored resolution after the reducer has advanced.

Define:

- the receipt key (for example session + participant + submission ID);
- whether the original cursor and canonical command are included in conflict
  detection;
- how the receipt, transcript event, state transition, and next window are
  committed atomically;
- retention/eviction limits and behavior after eviction; and
- restart recovery requirements for the host adapter.

### 4. Make observation delivery a versioned protocol

Use a monotonically increasing seat-view revision in addition to simulation
ticks. Ticks alone do not identify every snapshot, resend, or product
extension update.

For the first implementation, prefer a snapshot-only codec. JSON Patch can be
added after defining canonical diff ordering, JSON Pointer escaping,
array-operation semantics, prototype-path protection, codec versioning, and
maximum patch size. The snapshot fallback remains mandatory.

Define digest serialization and purpose. The current `stateDigest` default is
JSON serialization plus 32-bit FNV-1a. That is suitable for inexpensive
desync detection, not security, authentication, or anti-cheat proof. View
digests should use canonical JSON and state explicitly whether collisions are
only a diagnostic risk.

`PredictionSession` also needs construction/state contracts: authoritative
revision, local snapshot or reducer state, pending-action identity and order,
rollback limit, and behavior when reconciliation cannot reach the supplied
base revision.

### 5. Move the commitment envelope to a dedicated RFC

The commitment change is not independent of replay versioning and is larger
than adding two optional `SubmittedAction` fields. Current replay projection
would discard the fields, and the strict replay schema would reject them.

A dedicated proposal must pin:

- canonical payload bytes, salt encoding, hash encoding, and scheme version;
- domain separation and binding to session, seat, commitment ID, and intended
  tick/window so commitments cannot be replayed in another context;
- how a reveal references one commitment when several exist at the same tick;
- reducer and legality semantics before and after reveal;
- redaction and publication timing; and
- sync/async verification. WebCrypto hashing is asynchronous while the
  current replay checker is synchronous.

`commitTick` should be derived from or checked against transcript position,
not trusted as an unbound value supplied by the revealer.

## Questions to resolve

1. Are timeout, extension-lane, and commit/reveal entries portable replay
   records, host-private session records, or two representations with an
   explicit finalization mapping?
2. Is the extension lane ordered relative to gameplay? "Parallel but
   recorded" is not sufficient for deterministic replay unless it is proven
   unable to affect reducer state, legality, observations, or results.
3. Does one kernel instance represent exactly one level, one multi-level run,
   or either? This determines replay finalization, seed derivation, and reset
   behavior.
4. Must all seats receive exactly one delta per resolution, including an
   unchanged-view marker, or may unchanged views be omitted? If omitted, what
   advances the seat-view cursor?
5. Is `perm` part of generic session policy or specifically an Arena adapter
   concern? If generic, define how arbitrary action IDs map to the existing
   `Action N` replay representation.
6. What is the maximum accepted future target tick and buffered submission
   count? The kernel needs deterministic resource bounds so a malformed
   request cannot force unbounded catch-up or memory growth.

---

# §D — Revision 2: author response and revised normative text

All five required revisions **accepted**. Supersedes conflicting text above.

## D1. Live session log vs finalized replay artifact — split adopted

Two explicit concepts:

```ts
/** Append-only while the session is live. Host-persistable record by record. */
export type SessionEvent =
  | { kind: 'resolution'; tick: number; viewRevision: number;
      inputs: readonly CanonicalInput[] }          // one advance/applyIntents call
  | { kind: 'timeout'; tick: number; timeoutId: string; reason: string }
  | { kind: 'extension'; tick: number; lane: string; record: JsonObject }
  | { kind: 'checkpoint'; tick: number; digest: number };

export interface SessionTranscript {
  header: SessionHeader;                 // sessionId, game ref, level id/version,
                                         // seed + policy, cadence, seats, dmath algorithm
  events: readonly SessionEvent[];
}

/** Only at a terminal result. Pure projection, no new information. */
export function finalizeReplay(
  transcript: SessionTranscript,
  options: FinalizeOptions,              // perm mapping, extensions, visibility
): ReplayArtifact<unknown>;
```

- Verifier atomicity: finalization groups each `resolution`'s inputs so the
  checker calls `advance`/`applyIntents` **exactly once per resolution** —
  this requires the replay format to represent input groups, so this RFC now
  explicitly depends on a **`gaos.replay` version bump (v1.1)**: grouped
  actions + the new record kinds (timeout, extension, checkpoint) with a
  strict schema. Format work lands first, kernel second.
- Answers §C-Q1: two representations with an explicit finalization mapping.
  SessionEvents are host-private; only the v1.1-portable subset survives
  projection, deterministically.

## D2. Kernel API completed

- `IntentSubmission` is replaced by the existing protocol
  `CommandSubmission<TCommand>`; the kernel is generic over `TCommand` and
  maps commands to `SubmittedAction` via an injected, pure
  `commandToAction` adapter (declared in `SessionKernelOptions`).
- `SessionKernelOptions` gains: `sessionId`, `game: ReplayGameRef`,
  `levelId`/`levelVersion`, `seedPolicy`, `dmath?: Dmath` (RFC-007 R3),
  `limits` (D3/D6-Q6), `commandToAction`.
- **Effect boundary decision: pure returns, no injected adapter.** Kernel
  methods return effect descriptions; the host executes them:

```ts
ingest(submission): { receipt: IngestReceipt; events: SessionEvent[] };
advance(target?): {
  resolutions: SessionEvent[];
  deltas: ObservationDelta[];            // per seat, per revision
  digest: number;
};
```

  `SessionHostAdapter` is withdrawn. This makes the kernel synchronous,
  transactional from the host's perspective (persist events THEN send
  deltas), and trivially testable.
- Exposed state: `cursor()`, `tick()`, `viewRevision(seat)`,
  `snapshot(seat)` (for reconnect), `sessionHeader()`.
- `advance(target)` semantics pinned: ticks mode — target is inclusive and
  monotonic. `target - tick()` is the number of future ticks beyond the
  current open tick and is capped by `limits.maxFutureTicks`; the current tick
  itself is not "future". One call resolves at most `maxCatchUpTicks`
  inclusive ticks, returning `partial: true` when the host must loop. A stale
  target throws. Turns mode forbids `target` and resolves at most one window.
- Timeouts: hosts submit
  `TimeoutInput { timeoutId, tick, participantId?, reason, timeoutPolicyRef? }`
  as ordinary
  ingested inputs — durably ordered with gameplay, recorded as `timeout`
  events (time-as-input doctrine, now in the event union).
- `ActionReducer` support is documented as **degraded**: no empty-tick
  advancement, no atomic multi-input resolution without `applyIntents`;
  ticks-mode kernels require a `TickReducer`.

## D3. Durable idempotency receipts

- Receipt key: `sessionId + participantId + submissionId`.
- Conflict detection includes the canonical command bytes and the cursor the
  submission targeted; same key + different content → `conflict`.
- Atomicity contract: `ingest`/`advance` return receipt + events together;
  the host MUST persist the returned events before acknowledging the
  submitter (documented host obligation — the pure-return design makes this
  possible; an injected-adapter design could not order it).
- Retention: `limits.receiptRetention` (default: receipts for the last 64
  resolutions per seat). After eviction, a retried key returns
  `unknown_submission` — never silent re-application. Bounded receipt
  storage may forget the original response, but an O(1) historical index
  rebuilt from append-only `intent-accepted` events permanently reserves every
  accepted identity, including submissions later rejected before gameplay.
  A corrected command must use a fresh submission ID.
- Restart recovery: kernel state = `SessionTranscript` replay; hosts rebuild
  by feeding persisted events to `rehydrateKernel(transcript)`; receipts
  within the retention window are reconstructed from `resolution` events.

## D4. Observation protocol versioned; snapshot-first

- `ObservationDelta` gains `viewRevision` (monotonic per seat, incremented
  every resolution including unchanged views — unchanged emits
  `{ kind: 'unchanged', viewRevision }`, answering §C-Q4: cursors always
  advance, cheaply).
- **v1 codec is snapshot-only** (`{ snapshot }` or `{ unchanged }`); JSON
  Patch deferred to a versioned codec negotiation with the canonicalization
  work the review lists. `codec: 'v1'` field present from day one.
- Digests: canonical-JSON serialization, documented as **diagnostic only**
  (32-bit FNV collision odds stated; not authentication, not anti-cheat
  proof — anti-cheat remains transcript replay).
- `PredictionSession` construction contract added: base `viewRevision` +
  snapshot, ordered pending actions with client-assigned ids, `rollbackLimit`,
  and the failure mode: if reconciliation cannot reach the delta's base
  revision it surfaces `resync_required` and the host requests `snapshot(seat)`.

## D5. Commitment envelope: moved to RFC-008

§B is withdrawn from this RFC. RFC-008 covers the full list from §C.5
(canonical payload bytes, domain separation, commitment references,
pre/post-reveal legality, redaction timing, sync verification, and
`commitTick` derived from transcript position). The session kernel treats
commit/reveal as opaque submissions until RFC-008 lands.

## Answers to §C questions

1. **Q1:** two representations + explicit finalization mapping (D1).
2. **Q2 (extension lane):** the lane is **structurally non-gameplay**: the
   kernel never passes extension records to the reducer, they carry no
   `SubmittedAction`, and observation derivation cannot read them. Anything
   that affects state/legality/observations must be a submission. Under that
   construction "parallel but recorded" is provably safe; products wanting
   ordered extensions submit them as gameplay.
3. **Q3:** one kernel instance = **one level episode**. Multi-level runs are
   host composition: N transcripts, one run-header replay assembled by
   `finalizeReplay` overloads using the existing `runLevelSeed` derivation.
4. **Q4:** every resolution emits exactly one delta per seat (possibly
   `unchanged`) — see D4.
5. **Q5 (`perm`):** an Arena-adapter concern. The kernel operates on
   canonical ids only; `FinalizeOptions.perm` applies the wire mapping at
   projection time, keeping the `Action N` representation a replay-format
   concern.
6. **Q6 (bounds):** `limits = { maxFutureTicks (default 2× tick rate),
   maxCatchUpTicks (default 600), receiptRetention, maxExtensionBytes }`.
   The collector admits exactly one unresolved intent per participating seat,
   so there is no multi-entry per-seat buffer and no separate buffer limit.
   `maxFutureTicks` measures only the distance ahead of the current open tick:
   a target exactly `maxFutureTicks` ahead is valid and resolves the current
   tick plus that many future ticks, subject to the per-call catch-up cap.
   Violations use typed errors and never trigger unbounded work.

---

# §E — Second review after Revision 2 (2026-07-25)

## Disposition

Revision 2 substantively accepts the original review. The live/finalized
transcript split, completed public API, snapshot-first observation protocol,
bounded resource policy, and RFC-008 extraction resolve the architectural
objections.

Conditionally approve RFC-006 after the three corrections below. They concern
crash consistency and replay completeness and should be resolved before
implementation, not deferred to host adapters.

## Follow-up corrections required

### E1. Persist accepted intents before a window resolves

The revised `SessionEvent` union records a completed `resolution`, but it has
no record for an accepted intent in a still-open collection window. This
creates a crash-consistency hole:

1. seat A submits;
2. `ingest` accepts and buffers the command;
3. seat B has not submitted, so no `resolution` exists;
4. the host crashes and rehydrates from `SessionTranscript`; and
5. seat A's accepted command and receipt are absent.

This contradicts D3's statement that kernel state is reconstructed from the
transcript and weakens exact-retry behavior for pending submissions.

Add a durable event such as:

```ts
type SessionEvent =
  | {
      kind: 'intent-accepted';
      tick: number;
      revision: number;
      participantId: string;
      submissionId: string;
      command: JsonValue;
      canonicalCommand: string;
    }
  | {
      kind: 'resolution';
      tick: number;
      inputs: readonly CanonicalInput[];
    }
  // ...
```

Alternatively, persist an explicit window snapshot, but the append-only
accepted-intent event is easier to audit and replay. Resolution must reference
or consume the accepted events without duplicating ambiguous receipt state.
Rehydration tests must cover a crash after every accepted seat, including the
last seat before resolution persistence.

### E2. Define transactional kernel-state publication

"Pure returns" describes effects but does not yet say whether `ingest` and
`advance` mutate the in-memory kernel before the host persists those effects.
If persistence fails after a mutating call, the process may continue from
state that has never been durably recorded.

Adopt one explicit model:

- immutable transition:

  ```ts
  transition(input): {
    next: SessionKernelState;
    events: readonly SessionEvent[];
    deltas: readonly ObservationDelta[];
  };
  ```

  The host persists `events`, then publishes `next` and sends `deltas`; or

- prepared transition:

  ```ts
  const prepared = kernel.prepare(input);
  await persist(prepared.events);
  kernel.commit(prepared);
  ```

  A prepared transition is single-use, revision-bound, and discardable on
  persistence failure.

In either model, deltas and acknowledgements are sent only after durable
commit. Specify behavior for duplicate persistence, failure after persistence
but before in-memory commit, and host restart. Event identifiers must make
storage retries idempotent.

### E3. Make timeout-to-reducer mapping replayable

The original `TimeoutInput { timeoutId, tick }` sketch and corresponding
timeout event did
not identify the affected participant/window or the canonical timeout/pass
input supplied to the reducer. A replay verifier cannot reconstruct gameplay
from `timeoutId` alone without relying on unrecorded product policy.

The transcript must either:

- record the fully derived canonical system input in the associated
  `resolution`; or
- define a versioned, pure `timeoutToAction(context, timeout)` adapter
  selected by the recorded game adapter.

Record enough context to validate that the timeout applied to the expected
open window and participant. Prefer the first option: the timeout event
records why the resolution occurred, while the resolution event records
exactly what the reducer consumed.

## Editorial integration request

After E1–E3 are accepted, fold §D's adopted contracts into §§2–6 and replace
the original sketches that they supersede. Keep §§C–E as design history if
useful, but the document should expose one unambiguous normative API to an
implementer reading from the top.

---

# §F — Revision 3: response to second review (E1–E3)

All three corrections **accepted**; adopted contracts below and folded into §3.

## E1 accepted: durable accepted-intent events

`SessionEvent` gains the accepted-intent record exactly as proposed:

```ts
| { kind: 'intent-accepted'; tick: number; revision: number;
    participantId: string; submissionId: string;
    command: JsonValue; canonicalCommand: string }
```

- A `resolution` event **consumes** prior accepted intents by listing their
  `(participantId, submissionId)` pairs; the canonical inputs it records must
  be derivable from the consumed events (verified in tests). No separate
  receipt store exists — receipts ARE the accepted-intent events within the
  retention window, which closes the D3/rehydration inconsistency.
- Rehydration test matrix: crash after each seat's acceptance in a partially
  filled window, including after the final seat but before resolution
  persistence; exact retry of a pending submission after rehydration returns
  the original receipt.

## E2 accepted: prepared-transition publication model

Adopted the `prepare/commit` variant (folded into §3.1): prepare is pure,
single-use, revision-bound; host persists events, then commits, then sends.
Chosen over the immutable-transition variant because kernels hold large
product state — prepared transitions avoid mandating structural sharing while
achieving the same durability ordering. Specified behaviors:

- duplicate persistence: event ids (`sessionId + revision + seq`) make
  storage retries idempotent;
- failure after persist, before commit: rehydrate from transcript — the
  persisted events are authoritative; in-memory state is disposable;
- commit of a stale/foreign `Prepared` throws (`revision` mismatch);
- acknowledgements and deltas are post-commit only.

## E3 accepted: timeouts resolve to recorded canonical inputs

First option adopted: the `timeout` event records **why** (timeoutId,
reason, windowRef, affected participant, and optional timeout-policy
reference); the subsequent `resolution` event records
**what** — the fully derived canonical system input (e.g. the concrete
timeout/pass `SubmittedAction`) that the reducer consumed. Replay verifies
gameplay entirely from `resolution` events; `timeout` events are audit
context and must match the open window/participant they claim (checked at
finalization). If a pending commitment mismatch prevents resolution, the
timeout still survives immediately before the rejection and no forced input
is claimed as consumed. No unrecorded product policy participates in replay.

The `timeout` event shape becomes:

```ts
| { kind: 'timeout'; tick: number; timeoutId: string;
    windowRef: number; participantId: string | null; reason: string;
    timeoutPolicyRef?: string }
```

## Editorial consolidation

§3 now exposes the adopted API (prepared transitions, completed options,
snapshot-only versioned deltas, host obligations); superseded rev-1 sketches
were replaced in place. §§C–E retained as design history.

---

# §G — Third review after Revision 3 (2026-07-25)

## Disposition

Revision 3 resolves E1–E3: accepted intents are durable, timeout resolutions
record the exact reducer input, and host ordering around persistence is now
explicit.

Request one more revision before approval. The prose accepts the completed
contracts, but the normative TypeScript in §3 does not yet encode all of
them, and two identifiers currently conflate gameplay and persistence
revisions.

## Corrections required

### G1. Put the completed options contract in §3.1

The normative `SessionKernelOptions` still shows the rev-1 fields and omits
the fields accepted in §D2. It also lacks the `TCommand` generic used by
`SessionKernel`.

Replace it with one self-contained contract along these lines:

```ts
export interface SessionKernelOptions<
  TLevel,
  TState,
  TCommand extends JsonValue,
  TView extends TickView<unknown, unknown>,
> {
  sessionId: string;
  game: ReplayGameRef;
  levelId: string;
  levelVersion?: string | number;
  reducer: Reducer<TLevel, TState, TView>;
  level: TLevel;
  seed: number;
  seedPolicy: ReplaySeedPolicy;
  seats: readonly string[];
  cadence:
    | { mode: 'turns' }
    | { mode: 'ticks'; rate: TickRate };
  commandToAction(command: TCommand, context: CommandContext): SubmittedAction;
  dmath?: Dmath;
  limits?: SessionLimits;
}
```

Remove `perm` from kernel options as agreed in §D-Q5; it belongs in
`FinalizeOptions`. Replace the old "extensions appended verbatim" field with
an explicit extension-event API or omit it until that API is specified.

Also update §2: the kernel has no injected IO or async adapter edge after the
prepared-transition decision. It is synchronous deterministic logic returning
effect descriptions.

### G2. Make a prepared transition carry its commit payload

The displayed `Prepared<TResult>` contains only revision, events, deltas, and
result. A side-effect-free `prepare*` cannot later make `commit(prepared)`
publish the computed next reducer/window/view state unless the prepared value
also carries an opaque transition payload. Retaining that payload in a
kernel-owned pending map would itself mutate kernel state during `prepare`.

Add a private/opaque field to the public contract:

```ts
declare const preparedTransition: unique symbol;

export interface Prepared<TResult> {
  readonly baseTransitionRevision: number;
  readonly nextTransitionRevision: number;
  readonly events: readonly SessionEvent[];
  readonly deltas: readonly ObservationDelta[];
  readonly result: TResult;
  readonly [preparedTransition]: PreparedState;
}
```

`PreparedState` is package-private and contains the next reducer state,
intent window, receipts, transcript cursor, observations, and digests needed
by `commit`. The host may persist the public events but cannot construct or
modify a valid prepared transition.

Specify whether preparing a large mutable product state clones it, runs the
reducer against an isolated draft, or requires a product snapshot hook.
"Pure prepare" must mean no mutation observable through the live kernel or
the caller's existing state references.

### G3. Separate transition revision from gameplay cursor

An intent window's protocol revision does not advance each time another seat
is accepted. If event IDs use `sessionId + revision + seq`, two separate
accepted-intent transitions in the same window can collide.

Define two counters:

- `cursor()` / gameplay revision: identifies the unresolved protocol window
  and advances on resolution; and
- `transitionRevision`: advances on every committed prepared transition,
  including each accepted intent, rejection, timeout, and resolution.

Use `sessionId + transitionRevision + eventIndex` for event IDs and stale
prepared-transition checks. Record the gameplay cursor separately on events
that need it. Rehydration must restore both counters.

### Editorial status request

After G1–G3 are integrated, replace the old top-level "revision requested"
and conditional-review banners with one current status, while retaining
§§C–G as design history. The RFC should have a single obvious disposition.

---

# §H — Revision 4: response to third review (G1–G3)

All three corrections **accepted** and folded into §§2–3.

- **G1:** §3.1 now carries the completed `SessionKernelOptions` (sessionId,
  game ref, level identity, seed policy, `TCommand` generic +
  `commandToAction`, `dmath`, `limits`). `perm` removed from kernel options
  (lives in `FinalizeOptions`); the "extensions appended verbatim" field is
  replaced by an explicit `prepareExtension(lane, record)` API whose records
  are structurally non-gameplay (§D answer 2). §2 corrected: the kernel has
  no injected IO or async edge — synchronous logic returning effect
  descriptions.
- **G2:** `Prepared` now carries a package-private, symbol-branded
  `PreparedState` payload (next reducer state, window, receipts, transcript
  cursor, observations, digests), so `prepare*` computes without mutating the
  live kernel and `commit` publishes without recomputation. Purity
  semantics: the kernel never clones product state; it relies on the
  reducer-purity contract already required by the SDK — `advance`/`apply`
  return fresh state and must not mutate their input. "Pure prepare" is
  therefore observable-purity: no change through the live kernel or any
  state reference the caller already holds. A reducer that mutates its input
  violates the existing reducer contract, not a new kernel rule.
- **G3:** two counters adopted — the gameplay window `cursor()` (advances on
  resolution) and `transitionRevision` (advances on every committed
  transition: accepted intent, rejection, timeout, extension, resolution).
  Event ids are `sessionId + transitionRevision + eventIndex`; stale-Prepared
  checks use `baseTransitionRevision`; rehydration restores both counters.

Cross-RFC note (RFC-008 §10.3): the `SessionEvent` union additionally gains

```ts
| { kind: 'rejection'; code: 'commit_mismatch'; tick: number;
    participantId: string; submissionId: string;
    commitmentId: number; scheme: 'gaos.commit.sha256.v1' }
```

recorded outside the reducer input batch, surviving `finalizeReplay` as a
v1.1 audit record, with ids under the same `transitionRevision` scheme.

---

# §I — Fourth review after Revision 4 (2026-07-25)

## Disposition

G1 and G3 are resolved. The normative options are complete, the effect
boundary is coherent, and transition identity is correctly separated from
the gameplay cursor.

Revision requested on G2. The adopted prepared-state explanation assumes
`advance`/`apply` return fresh state and never mutate their input, but that is
not an existing SDK reducer contract:

- `docs/mechanisms/grid-model.md` states that determinism, not persistent
  immutability, is required; and
- `docs/high-frequency.md` explicitly permits in-place mutation with
  copy-on-write rollback deltas.

This matters directly to the proposed TabletopLabs consumer. Calling a mutable
reducer during `prepareAdvance` can mutate the live kernel state before
persistence, violating the central prepared-transition guarantee.

## Required correction: explicit state isolation

Do not silently narrow `Reducer` to immutable implementations. Add a
state-isolation strategy to session options or require an equivalent reducer
capability:

```ts
export interface SessionStateIsolation<TState> {
  /**
   * Produce an isolated draft. Mutating the draft must not change `state` or
   * any value observable through the live kernel.
   */
  fork(state: TState): TState;

  /**
   * Optional product cleanup when a prepared transition is discarded.
   * Useful for COW snapshots, pooled buffers, and ECS rollback handles.
   */
  discard?(draft: TState): void;
}

export interface SessionKernelOptions<...> {
  // ...
  stateIsolation?: SessionStateIsolation<TState>;
}
```

Contract:

- when `stateIsolation` is absent, the kernel may use a documented default
  clone only for supported JSON-like state, or the reducer must explicitly
  declare immutable-state behavior;
- mutable/COW reducers supply `fork`, which may use a structural clone,
  snapshot handle, COW root, or product-specific draft;
- `prepareAdvance` runs the reducer only against the isolated draft;
- `commit` publishes the prepared draft;
- persistence failure or stale prepared transitions invoke `discard`;
- preparing one transition never changes live observations, digests, or
  caller-held state references; and
- tests use a deliberately in-place-mutating reducer to prove prepare,
  discard, commit, and crash-rehydrate behavior.

If the SDK prefers two explicit kernel factories—immutable reducer versus
isolated mutable reducer—that is also acceptable. What is not acceptable is
claiming fresh-state reducer behavior as an existing universal requirement.

## Approval condition

RFC-006 can be marked design-approved once mutable reducer isolation is part
of the normative contract and the prepared-transition tests cover both
immutable and in-place/COW reducers.

---

# §J — Revision 5: response to fourth review (G2 state isolation)

**Accepted in full.** The review is correct that rev 4 overclaimed: the SDK
reducer contract requires determinism, not persistent immutability
(`grid-model.md`; `high-frequency.md` explicitly permits in-place mutation
with COW rollback), and the first tick-mode consumer — TabletopLabs — is
exactly such a mutable-state host. Claiming fresh-state behavior as a
universal requirement would have broken the central prepared-transition
guarantee for the very consumer the kernel exists to serve.

Adopted, folded into §3.1:

- `SessionStateIsolation<TState>` (`fork` + optional `discard`) exactly as
  proposed, as a kernel option rather than dual factories — one kernel type,
  isolation strategy injected, keeps host code monomorphic.
- Default behavior when absent: documented `structuredClone` fallback, valid
  only for structured-cloneable state; reducers with non-cloneable or
  externally-referenced state MUST supply `fork` (constructor-time
  validation attempts a probe clone and throws with guidance otherwise).
- `prepareAdvance`/`prepareIngest` touch ONLY the forked draft;
  `commit` publishes the draft; failure/stale paths call `discard`.
- TabletopLabs consumer note: `fork` maps naturally onto its existing
  world-snapshot/COW machinery; `discard` releases the snapshot handle.
- Test plan addition (approval condition): the prepared-transition suite
  runs twice — once with an immutable reducer, once with a deliberately
  in-place-mutating reducer — covering prepare, discard, commit, and
  crash-rehydrate; live observations/digests are asserted unchanged after a
  discarded prepare.

Cross-RFC (008 third review §12.1): the `rejection` record in the
`SessionEvent` union carries `attemptedReveal: { salt, payload }` so replay
can independently recompute the mismatch; seat-scoped projections may redact
it and must then report recorded-but-not-independently-recheckable status.
The 65,536-byte payload bound applies to rejected attempts.

---

# §K — Fifth review after Revision 5 (2026-07-25)

## Disposition

The state-isolation correction is accepted. `structuredClone` supplies a
documented default, product `fork` supports COW/ECS state, and the required
mutable-reducer tests protect observable prepare purity.

One prepared-transition lifecycle operation is still missing from the
normative interface.

## Required correction: explicit abort/dispose

The host obligations say that a persistence failure discards the prepared
transition, and `SessionStateIsolation.discard` may need to release COW
snapshots, pooled buffers, or ECS handles. But `PreparedState` is opaque and
`SessionKernel` exposes only:

```ts
commit(prepared: Prepared<unknown>): void;
```

The host therefore has no supported way to trigger cleanup after persistence
failure.

Add:

```ts
export interface SessionKernel<TCommand, TView> {
  // ...
  commit(prepared: Prepared<unknown>): void;
  abort(prepared: Prepared<unknown>): void;
}
```

Lifecycle rules:

- every prepared transition is completed exactly once by `commit` or `abort`;
- `abort` leaves live kernel state and transition revision unchanged and calls
  `stateIsolation.discard` for the isolated draft;
- persistence failure requires `abort`;
- a stale prepared transition passed to `commit` is automatically aborted
  before throwing, or the caller must be able to call `abort` afterward—the
  RFC must choose one rule;
- abort after an automatic or explicit abort is idempotent; double commit,
  commit-after-abort, abort-after-commit, and foreign prepared values throw
  typed lifecycle errors without invoking cleanup twice; and
- tests cover explicit abort, persistence failure, competing prepares from one
  base revision, and exactly-once cleanup.

Also define cleanup for the formerly live state after successful publication
when product isolation owns external resources. This may be an optional
`retire?(previous: TState)` hook, or the RFC may state that successful-state
retirement is product-managed. The ownership rule must be explicit for the
COW/ECS use case.

## Approval condition

RFC-006 can be marked design-approved once the opaque prepared-transition API
has an explicit, exactly-once abort path and successful-state resource
ownership is documented.

---

# §L — Revision 6: response to fifth review (abort/dispose)

**Accepted.** Folded into §3.1 and §3.4:

- `abort(prepared)` added to the kernel interface with exactly-once
  completion semantics: every prepared transition ends in exactly one
  `commit` or one `abort`; `abort` leaves live state and
  `transitionRevision` unchanged and invokes `stateIsolation.discard` on
  the draft; persistence failure requires `abort`.
- **Stale-commit rule chosen:** a stale prepared transition passed to
  `commit` is **automatically aborted before the typed error is thrown** —
  hosts never need a second call on that path, and error-path draft leaks
  are impossible by construction. Abort after an automatic or explicit abort
  is idempotent. Double commit, commit-after-abort, abort-after-commit, and
  foreign prepared values throw typed lifecycle errors without invoking
  cleanup twice (the prepared value carries an internal completion flag).
- **Successful-state retirement made explicit:**
  `SessionStateIsolation.retire?(previous)` is called exactly once with the
  previous live state after a successful commit publishes its draft; when
  absent, retirement is product-managed (documented no-op). This closes the
  COW/ECS ownership question: TabletopLabs' adapter releases the previous
  world snapshot handle in `retire`, the discarded-draft handle in
  `discard`.
- Test plan additions (approval condition): explicit abort; persistence
  failure → abort; competing prepares from one base revision (second
  commit auto-aborts and throws); exactly-once cleanup asserted via
  discard/retire call-count spies; all run for both the immutable and the
  in-place-mutating reducer variants.

---

# §M — Final design review (2026-07-25)

## Disposition: approved for implementation

Revision 6 satisfies the final approval condition. The session kernel now has
a coherent, implementable boundary:

- live session events are distinct from finalized replay artifacts;
- simultaneous inputs remain atomic through live execution and replay;
- accepted intents and receipts survive partial-window crashes;
- gameplay cursors and persistence transition revisions are distinct;
- prepared transitions are persist-before-publish and carry opaque next state;
- immutable, structured-cloneable, mutable, and COW/ECS reducer state all have
  explicit isolation behavior;
- commit, abort, discard, and previous-state retirement have exactly-once
  ownership rules;
- timeouts record both their audit cause and exact canonical reducer input;
- observations are revisioned, snapshot-first, and seat-scoped;
- extension records are structurally non-gameplay; and
- RFC-008 mismatch records survive as recomputable but advisory full-replay
  audit events; authentication is deferred to RFC-010.

This is design approval. Implementation merge remains gated on:

1. `gaos.replay` v1.1 grouped-resolution and audit-record schema/verifier work
   landing first;
2. golden ports of Arena idempotency, timeout, conflict, and exactly-once
   resolution behavior;
3. crash testing after every accepted intent and between event persistence,
   commit, delta delivery, and acknowledgement;
4. prepared-transition lifecycle tests covering commit, explicit abort,
   stale auto-abort, foreign/double completion, discard, and retire;
5. the same lifecycle suite against immutable and deliberately mutating/COW
   reducers;
6. atomic simultaneous replay and cadence-equivalence tests;
7. per-seat snapshot/revision recovery and information-leak tests; and
8. deterministic resource-bound tests for future inputs, buffering, receipt
   retention, and catch-up.

Any implementation shortcut that mutates live state before durable event
persistence, applies simultaneous inputs serially, or reconstructs pending
intents from memory rather than the transcript violates the approved design.
