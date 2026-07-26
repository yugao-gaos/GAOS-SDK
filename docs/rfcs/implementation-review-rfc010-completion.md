# Implementation review — RFC-010 completion (`52fa4a1`)

> **Post-review disposition (2026-07-26).** The implementation follow-up closes
> the D5 end-to-end test gap, documents immutable roster/key lifecycle and the
> lifetime idempotency index, preserves the v0.19 opaque timeout reservation,
> and resolves E1/E4. E1 is the additive `SessionView`/`TickView` split plus
> `replayMetrics`; Arena confirmed E4 chooser/dialogue navigation is UI-only
> and confirmation produces a normal SDK action. The original review is kept
> below as review history, but its unconditional “drop-in” and “ship now”
> wording is superseded. A later pre-release decision makes observation codec
> v2 mandatory, so observation delivery is now intentionally breaking; see
> Round 4. RFC-010 §C4 still requires both product repins and signed artifact
> adoption before tagging.

Reviewed at `52fa4a1` against RFC-010 Parts A–E. Health: `tsc --noEmit` clean,
vitest **277 passed / 3 skipped**, pytest **72 passed / 4 skipped**.

**Verdict at that commit: ship the resolved v0.20 scope.** Every then-resolved
implementation item was present, the two things I expected to be wrong turned
out to be right, and the default runtime path remained compatible with
v0.19.0—no required option was added and `observationCodec` defaults to `'v1'`.
One real finding remained (a test gap in D5), while E1 and E4 were still
explicit design holds.

*Findings 1 and 3 were raised in the first pass and are withdrawn below, with
the reasoning that was wrong left in place rather than deleted.*

---

## Verified implemented

| Item | Evidence |
|---|---|
| **D1** origin discriminator | `origin?: 'resolution' \| 'snapshot' \| 'interest'` (`session.ts:335`), set at `:1540`, `:1620` (resolution) and `:2246` (snapshot) |
| **D2** product payload | `payload?: JsonValue` (`contracts.ts:20`), projected through `replayInput` with `structuredClone` (`session.ts:2538`) — the clone is right, it prevents aliasing a caller's object into the artifact |
| **D3** `./session` re-exports | `export { createTickRate } from './engine/index.js'` (`:17`) plus type blocks at `:18`, `:24` — the actual sharp edge is covered, not just the types |
| **D5** advance policy | `advancePolicy?: 'win-to-advance' \| 'play-all-levels'` (`:437`), gate consults `(options.advancePolicy ?? 'win-to-advance')` (`:2905`) |
| **E3a** legality seam | `validateCommand?` on `ReducerBase` (`contracts.ts:134`), called in `prepareIngest` **before** the intent is recorded (`session.ts:1270`) |
| **E6** accessors | `awaitingSeats()` (`:568`, `:2203`), `sessionHeaderFor()` (`:705`, used by both constructor `:881` and rehydrate `:2525`) |
| **F8** cursor rebasing | documented as the `revisionBase` pattern (`docs/session-and-integrity.md:223`) — RFC-011's preferred option (a) |
| **Part B** interest lane | `scopeId` throughout, `interest` record kind, signed scope declarations |
| **E2/E5** patch codec | new `src/observation-codec.ts`, `createJsonPatch`/`applyJsonPatch` re-exported |

**Back-compatibility holds.** `fixtures/replay/` is byte-untouched
`5ddd404..HEAD`, and the schema gates `interest` records *out* of
`formatVersion 1.1` via an explicit `if/then` — so v1.0/v1.1 artifacts still
validate. Cross-language confirmed by pytest.

### Credit where I expected a defect

**F7 is correctly fixed, not relocated.** `resolved: existing.cursor <
this.live.cursor` (`:1195`) is the *same comparison Arena used host-side*, so
my first read was that the guess had merely been moved into the kernel and
given an authoritative name. It has not. The case Arena said was
indistinguishable — "resolved long ago" vs "receipt retention evicted it" — is
now a **distinct typed error**: `SessionConflictError('unknown_submission',
'receipt retention has expired')` (`:1207–1213`), backed by tombstones *and* an
unbounded permanent `historicalSubmissionKeys` set (`:757`, add-only). So the
three states are genuinely separable and the host no longer infers anything.

---

## Findings

### 1 — WITHDRAWN · "No v0.19.x line" — no maintained patch line is needed

*This review originally raised the absence of a `v0.19.x` branch as a HIGH
finding: D1/D2/D3/D5 were classified as baseline-line fixes, three of them
migration-blocking, yet only obtainable by adopting all of unreleased v0.20.*

**Withdrawn — the reasoning was from policy rather than from the code.**
RFC-009 §4.4's freeze exists to stop a *moving contract* from doubling the work
of two mid-flight migrations. Checking whether the contract actually moved for
a consumer pinned at `v0.19.0`:

- **`observationCodec` defaults to `'v1'`** (`src/session.ts:850–851`): a
  consumer that does not opt in keeps `codec: 'v1'` and snapshot bodies. The
  `'v1' | 'v2'` widening never emits v2 unaskedly.
- **`SessionKernelOptions` gained no required field.** Its mandatory set is
  unchanged from v0.19: `sessionId`, `game`, `levelId`, `reducer`, `level`,
  `seed`, `seedPolicy`, `seats`, `hostTime`.
- Everything else is optional (`interest?`, `seatKeys?`, `signaturePolicy?`,
  `validateCommand?`, `advancePolicy?`, `payload?`, `origin?`) or additive on
  **return** types (`resolved`, `awaitingSeats()`), which callers ignore at no
  cost.
- v1.0/v1.1 artifacts still parse; the golden fixture is byte-untouched.

The default runtime path is therefore compatible with v0.19.0, and a
maintained patch line would add little value. The follow-up also restores the
v0.19 behavior of unsigned opaque `timeoutPolicy` declarations and references.
This does not prove zero source changes for every TypeScript consumer:
`ObservationDelta.codec` and `SessionEvent` are widened unions, so exhaustive
switches must be checked by the actual product builds.

Consumers re-pin `#v0.19.0` → the v0.20 release candidate and run their own
typecheck/integration suites before the tag. No separate v0.19.x branch is
required.

*Lesson for RFC-009 §4.3: its patch-vs-v0.20 classification tacitly assumed
v0.20 would be a reshaping release. It came out additive, so the two branches
of that rule collapsed into one. The rule should be restated in terms of the
observable question — "does a pinned consumer have to change code?" — not in
terms of which release the change lands in.*

### 2 — RESOLVED · D5 now rechecks the artifact and aggregate totals

`test/rfc010-completion.test.ts:410–458` keeps the ladder default
(`.toThrow(/must be won/)`) and asserts the policy projects
(`.header.levels).toHaveLength(2)`). It stops there.

RFC-010 §D5 (from Arena's change list) asked for a case asserting a failed
non-final level projects **and rechecks clean with correct aggregate totals**.
Neither is tested — `recheckReplayArtifact` is not imported in the file at all
(only `recheckReplaySignatures`).

This is the assertion that matters most, because the aggregate totals *are*
D5's entire justification: the argument for the change was that the verifier
already handles this correctly — a failed level contributes zero stars while
its `actionsUsed` still counts, which is Arena's *total stars, then total
turns* ranking. **If that aggregation were wrong for a failed non-final level,
Arena's paid ranking would be silently wrong and this test would still pass.**

The follow-up rechecks the produced artifact and asserts hand-computed
`totalStars` / `totalActionsUsed` for two failed levels. It also asserts the
independently replayed totals and statuses.

### 3 — WITHDRAWN · D1's `'interest'` union value

Raised only as a consequence of finding 1: if D1 shipped in a v0.19.1 without
Part B, `origin: 'interest'` would be a union member that could never occur.
With no v0.19.1, D1 and Part B ship together and the value is always reachable.
No change needed.

### 4 — RESOLVED · §A3 roster lifecycle is now a host obligation

The trust documentation now fixes the v1 rule: the roster is immutable; key
rotation or seat reassignment starts a new session; a lost private key cannot
be replaced in-session; unsigned continuation is product policy and loses a
complete trusted chain. Spectators need no key, while bots occupying seats do.

### 5 — RESOLVED (documentation) · `historicalSubmissionKeys` grows for the session's lifetime

The session guide now states that `receiptRetention` does not bound the
lifetime idempotency index and that hosts must budget one retained key per
accepted gameplay or interest submission.

### 6 — INFO · Commit hygiene

1 826 lines across the kernel, the JSON Schema, the Python package, and eight
docs, under a single-line message with no body. Every prior gate in this series
carried its rationale in the commit. Not a defect; it does mean the next
reviewer re-derives intent that the author already had.

---

## Recommendation

No patch line, cherry-picks, or maintained branch are needed. The repository
implementation and documentation findings are closed. Before tagging, Arena
and TabletopLabs must re-pin the release candidate, run their real integration
suites, adopt client-side signing, and produce locally verified trusted
artifacts as required by RFC-010 §C4.

---

# Round 2 — review of `76776ab`

Health: `tsc --noEmit` clean, vitest **279 passed / 3 skipped**, pytest
**72 passed / 4 skipped**. `test/session.test.ts` was **not modified** and still
passes, which is direct evidence the v0.19 reducer contract still compiles and
runs unchanged.

## My "drop-in" claim was too strong, and the implementer was right to qualify it

The follow-up amended this review's unconditional *"no code change on their
side"* wording. **That correction is right and I accept it.** Verified: since
`v0.19.0` the `SessionEvent` `kind` union gained **`interest`, `patch`, and
`seat-signature`**, and `ObservationDelta.codec` widened `'v1'` → `'v1' | 'v2'`.

A widened union in a *return* type is runtime-compatible but **not
source-compatible**: any TypeScript consumer with an exhaustive `switch` and a
`never`-typed default fails to compile on upgrade. I conflated runtime
compatibility with source compatibility. The accurate statement is: **the
default runtime path is unchanged; the type surface is not strictly
source-compatible.**

## Resolved, verified

- **Finding 2 — D5 test gap. Properly closed.** The test now asserts header
  totals (`{ totalStars: 0, totalActionsUsed: 2 }`), rechecks the artifact with
  `recheckReplayArtifact`, asserts `checked.ok === true`, and asserts the
  independently replayed aggregate *including* `statuses: ['failed','failed']`.
  That verifies the claim D5's rationale rests on — a failed level contributes
  zero stars while its `actionsUsed` still counts — rather than only that the
  projection builds. The ladder default is retained.
- **Finding 4 — roster lifecycle.** Now a stated host obligation
  (`docs/trust-and-verification.md:69–70`): the roster is immutable for the life
  of a v1 session; rotation or reassignment starts a new session with a new
  roster and new chain genesis. Matches §A3's proposal exactly.
- **Finding 5 — idempotency index growth.** Documented for operators sizing
  long-running sessions (`docs/session-and-integrity.md:218`).

## New finding

### R2-1 — MEDIUM · The union-widening hazard is diagnosed internally and invisible to consumers

The follow-up correctly identified the exhaustive-switch hazard **in this
review file** — an internal document. It is **not** in the consumer-facing
release notes. Verified: `docs/releases.md` gained the `SessionView` split, the
E4 disposition, and the tag-gate obligations, but nothing about new
`SessionEvent` kinds or the widened `codec`; grep across `docs/` finds no
consumer-facing mention of either.

This is the **only thing in v0.20 that can break a consumer's build**, both
consumers are TypeScript, and both are about to re-pin. Diagnosing it and then
not telling the people who will hit it is the gap.

**Fix:** a short migration note in the v0.20 release notes — new `kind` values
`interest` / `patch` / `seat-signature`, `codec` now `'v1' | 'v2'`, exhaustive
switches need a new arm, runtime behaviour unchanged when `observationCodec` is
left at its `'v1'` default.

## Notes, not findings

- **E1 was implemented despite an explicit hold, and that is defensible.** This
  review recommended holding `TickView` for a second consumer's voice, on the
  grounds that one consumer satisfying a contract vacuously is a smell rather
  than proof of a shape problem. The implementation went ahead on one voice —
  but what it did is the *minimal* response: extract `SessionView`, make
  `TickView extends SessionView`, widen the generic bound while keeping
  `TickView` as the default, and add an optional `replayMetrics?`. It **removes
  the forced vacuity without designing a new contract**, so it commits to
  nothing that a second voice could invalidate. Accepted.
- **E4 closed the right way, and without touching the kernel.** Arena answered
  the diagnostic question this review asked them to answer first: chooser and
  dialogue navigation are **UI-only**, and confirmation enters the kernel as an
  ordinary SDK action. That is direction (2) of §E4 — *if it affects the
  simulation, determinism already requires it in the transcript, so it was
  never seat-local* — and it means the RFC-006 `viewRevision(seat) === cursor()`
  invariant never had to be reopened. Asking the question saved the design.

## Verdict

**Ship, after R2-1.** It is a paragraph in the release notes, and it is the one
thing standing between a re-pinning consumer and a red build. Everything else
this review raised is resolved and verified.

---

# Round 3 — mandatory observation codec v2

The product owners accepted an intentional pre-1.0 observation-wire break:
Arena and TabletopLabs are both early enough to migrate together, so v0.20
does not carry the snapshot-only v1 emission path.

This supersedes Round 2's recommendation to describe an unchanged v1 default:

- `ObservationDelta.codec` is now exactly `'v2'`;
- `body` remains `patch | snapshot | unchanged`, so bounded snapshot fallback
  is still mandatory;
- `observationCodec` is optional bounds configuration for v2, not negotiation;
- clients reconstruct through `applyObservationDelta`; and
- the release notes explicitly tell exhaustive consumers that `interest` and
  `seat-signature` are new durable event kinds. `patch` is an observation body
  kind, correcting Round 2's accidental classification of it as a
  `SessionEvent.kind`.

**Disposition:** accepted for the v0.20 release candidate. Both product repins
must exercise patch application and snapshot fallback before tagging.

---

# Round 3 — the CPU arm, measured (`scripts/benchmark-observation-codec.mjs`)

The byte-only benchmark could not settle RFC-009 §3.3, because it timed what v2
*spends* without timing what it *saves*. The extended benchmark adds a v1 arm,
a deflate column, and an activity sweep. Desktop, Node, synthetic view,
20 Hz × 4 seats.

## v2 costs more CPU than v1 in every single case

| entities | changed | CPU v1 | CPU v2 | ratio | tick budget v1 → v2 |
|---|---|---|---|---|---|
| 200 | 1 | 1.20 ms | 2.47 ms | **2.06×** | 9.6 % → 19.7 % |
| 200 | 5 | 1.27 ms | 2.77 ms | **2.18×** | 10.2 % → 22.1 % |
| 200 | 20 | 1.37 ms | 2.36 ms | **1.72×** | 11.0 % → 18.9 % |
| 200 | all | 0.98 ms | 5.75 ms | **5.85×** | 7.9 % → 46.0 % |
| 500 | 1 | 2.61 ms | 5.73 ms | **2.20×** | 20.9 % → 45.8 % |
| 500 | all | 2.81 ms | **15.02 ms** | **5.35×** | 22.4 % → **120.2 %** |

**At 500 entities with everything moving, v2 encoding alone exceeds a 20 Hz
tick budget on a fast desktop.** A Cloudflare DO isolate is materially slower.
The v1 path in the same cell costs 22 %.

This is the answer to §3.3, and it is the opposite of what the byte table
implied: **we traded bandwidth for CPU, and CPU was the measured bottleneck.**

## Transport compression alone solves the bandwidth problem, at lower CPU

Deflate on the *v1 snapshot* at 200 entities: 15,170 → **1,539 bytes, 9.9× for
free.** Per room that is 1.157 → **0.117 MiB/s**, which is already viable —
achieved with no codec, and with the *cheaper* CPU path.

| 200 entities, 5 changed | room egress | CPU/seat/tick |
|---|---|---|
| v1 raw | 1.157 MiB/s | 1.27 ms |
| **v1 + deflate** | **0.117 MiB/s** | **1.27 ms** |
| v2 raw | 0.030 MiB/s | 2.77 ms |
| v2 + deflate | 0.009 MiB/s | 2.77 ms |

v2 still wins on bytes — but against v1+deflate the remaining win is 0.108
MiB/s, bought with **2.2× the CPU on the constrained resource**.

## Defect — the fallback rule has no CPU term

`fellBack: false` at 500/all: the patch is 35,514 B against a 38,420 B
snapshot, so it is *technically* smaller and the codec ships it — **after
spending 15.02 ms instead of 2.81 ms to save 7 % of the bytes.** The rule is a
pure byte comparison (`patch < snapshot`), so it will always take a marginal
byte win at any CPU price.

**Fix:** require a margin, not merely "smaller" — fall back unless the patch is
at least ~2–4× smaller. That single change removes the pathological cells from
the table.

## This revises my own advice

Two turns ago I endorsed forcing v2 and deprecating v1, partly on the argument
that *nobody opts into an optional performance flag*. The measurement says v2
is **not strictly a win** — it is a trade, and it goes the wrong way on the
resource that binds. Removing the v1 emission path removed the cheaper option.

**Recommended:**

1. **Restore v1 as an emission mode.** Keep v2 the default if you like, but a
   500-entity tick-paced product needs the cheap path available.
2. **Fix the fallback margin** (above) — cheapest fix, largest effect.
3. **Enable transport compression and treat it as the primary bandwidth
   answer.** It is ~10×, free, and CPU-neutral for us.
4. **Re-measure on TabletopLabs' real views before finalising**, since these are
   synthetic.

## Caveats

Synthetic view, not TTL's real ECS components. Per-message deflate with no
context takeover — permessage-deflate with a shared window does better on a
repetitive stream, which strengthens the compression case rather than weakening
it. `canonicalJson` here is uncached, while the kernel now caches canonical
seat views, which makes v1's real cost *lower* than measured and v2 look worse
still. The robust result across all of these is the **v2/v1 ratio**, which is
above 1 in every cell.

---

# Round 4 — one v2 wire, adaptive patch CPU

Round 3 correctly found that unconditional patch probing is a CPU regression,
but restoring a second wire version was not required to recover the cheaper
path. Snapshot versus patch is a body-selection policy inside the v2 envelope,
not a reason for protocol negotiation.

The v0.20 disposition is therefore:

- `ObservationDelta.codec` remains exactly `'v2'`;
- `patchStrategy: 'never'` emits v2 snapshots without walking a diff;
- the default `adaptive` strategy backs off for eight changed observations
  after a probe loses, then probes again;
- operation and canonical-byte limits abandon the diff during the walk;
- the patch-size decision reuses the scoped view's cached canonical form; and
- a successful patch no longer pays for an unused full snapshot clone.

The benchmark now names the actual choices—snapshot, adaptive probe, and
adaptive steady state—and keeps raw/deflated bandwidth beside CPU. This
supersedes Round 3's recommendation to restore v1 while preserving its measured
finding: patching is worthwhile for sparse changes, and repeated patch probes
are not worthwhile for high-churn views.

On the same 20 Hz × 4-seat synthetic run, 500 entities/all-changing now measure
32.1% of the tick budget for snapshots, 88.1% for the occasional adaptive
probe, and 38.3% in adaptive steady state. The previous repeated-probe path
exceeded the whole tick budget. At 500 entities/one change, adaptive retains
the intended trade: 1.86× snapshot CPU for 314.8× fewer raw bytes.
