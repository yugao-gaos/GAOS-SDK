# Implementation review — RFC-010 completion (`52fa4a1`)

Reviewed at `52fa4a1` against RFC-010 Parts A–E. Health: `tsc --noEmit` clean,
vitest **277 passed / 3 skipped**, pytest **72 passed / 4 skipped**.

**Verdict: ship v0.20.** Every item is implemented, the two things I expected
to be wrong turned out to be right, and **v0.20 is a drop-in upgrade from
v0.19.0** — no required option was added, `observationCodec` defaults to `'v1'`,
and everything else is optional or additive on return types. One real finding
remains (a test gap in D5) plus two open items; nothing blocks the release.

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

### 1 — WITHDRAWN · "No v0.19.x line" — v0.20 is a drop-in, so no patch line is needed

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

**v0.20 is therefore a drop-in upgrade from v0.19.0**, and the freeze's purpose
is satisfied by that fact rather than by a version number. A v0.19.1 would
protect nobody from anything and would cost a maintained branch, a second
cherry-pick target, and a narrowed `origin` union.

**Ship v0.20.** Consumers re-pin `#v0.19.0` → `#v0.20.0` and get the
migration-blocking fixes with no code change on their side.

*Lesson for RFC-009 §4.3: its patch-vs-v0.20 classification tacitly assumed
v0.20 would be a reshaping release. It came out additive, so the two branches
of that rule collapsed into one. The rule should be restated in terms of the
observable question — "does a pinned consumer have to change code?" — not in
terms of which release the change lands in.*

### 2 — MEDIUM · D5's test asserts the artifact *builds*, not that it is *correct*

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

**Fix:** recheck the produced artifact and assert `totalStars` /
`totalActionsUsed` against hand-computed values for a run with a failed
non-final level.

### 3 — WITHDRAWN · D1's `'interest'` union value

Raised only as a consequence of finding 1: if D1 shipped in a v0.19.1 without
Part B, `origin: 'interest'` would be a union member that could never occur.
With no v0.19.1, D1 and Part B ship together and the value is always reachable.
No change needed.

### 4 — LOW · §A3's open items are still open, with the code now shipped

Unchanged from the previous review: key rotation mid-session, seat
reassignment, and lost keys carry *proposals* in §A3 ("forbid in v1", "a
reassignment is a new session") but nothing implements or documents them —
confirmed by grep across `src/` and the trust docs. Part A is now built around
a roster whose lifecycle rules are undecided. Either enforce the proposals or
write them down as host obligations before calling Part A done.

### 5 — INFO · `historicalSubmissionKeys` grows for the session's lifetime

An add-only unbounded `Set` (`:757`). This is the cost of the
already-shipped "accepted submission IDs remain permanently non-reusable"
property, not a regression, and it is load-bearing for finding-1-adjacent
correctness (see the F7 note above). Worth one line in the host obligations
doc so operators sizing long sessions know it is per-submission memory.

### 6 — INFO · Commit hygiene

1 826 lines across the kernel, the JSON Schema, the Python package, and eight
docs, under a single-line message with no body. Every prior gate in this series
carried its rationale in the commit. Not a defect; it does mean the next
reviewer re-derives intent that the author already had.

---

## Recommendation

**Release v0.20.** No patch line, no cherry-picks, no maintained branch. Both
consumers re-pin `#v0.19.0` → `#v0.20.0` and get all four migration-blocking
fixes with no code change on their side.

Do finding 2 first — it is a short test and it covers the assertion D5's whole
justification rests on. Findings 4 (roster lifecycle) and 5 (unbounded
`historicalSubmissionKeys`) are documentation and can ride the same release.

Nothing implemented needs reworking. The source is in good shape, and F7 is
better than the RFC asked for.
