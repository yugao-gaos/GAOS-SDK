# Implementation review — RFC-010 completion (`52fa4a1`)

Reviewed at `52fa4a1` against RFC-010 Parts A–E. Health: `tsc --noEmit` clean,
vitest **277 passed / 3 skipped**, pytest **72 passed / 4 skipped**.

**Verdict: the code is good; the *delivery* is not.** Every item is
implemented and the two things I expected to be wrong turned out to be right.
One blocking finding, and it is not in the source.

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

### 1 — HIGH · The v0.19.x line does not exist, so the blocking fixes cannot be delivered

**This is the one that matters, and it is a release-mechanics defect rather
than a code defect.**

D1, D2, D3, and D5 were classified under RFC-009 §4.3 as *additive fixes on the
baseline line*, three of them **migration-blocking**. They are instead sitting
on `main` at `0.20.0-dev`, stacked on top of the signature layer, the interest
lane, the patch codec, and a replay schema advanced to **v1.2**. Verified:

- no `v0.19.x` branch exists (`git branch -a` — only `main` and stale feature
  branches);
- `docs/releases.md` has exactly two current sections, `v0.20.0 (unreleased)`
  and `v0.19.0` — there is **no v0.19.1**, and none of the four fixes is listed
  as shipping anywhere a consumer can pin.

Both consumers are pinned at `#v0.19.0`. The only way either gets its
unblocking fix today is to adopt the whole of unreleased v0.20 — **precisely
the moving contract under two mid-flight migrations that RFC-009 §4.4's freeze
exists to prevent.** The freeze was honoured in the source (everything is
additive and optional) and then bypassed by the packaging.

**Fix:** branch `v0.19.x` from the `v0.19.0` tag, cherry-pick the four D items,
release **v0.19.1**, and announce the re-pin. The freeze check
(`git diff --name-only 5ddd404..v0.19.1 -- src python schema`) will
legitimately print `src/session.ts` — the announcement must say so explicitly,
per RFC-010 §D5's re-pin note.

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

### 3 — LOW-MEDIUM · D1's union carries a value that cannot occur in v0.19.x

`origin?: 'resolution' | 'snapshot' | 'interest'` — `'interest'` belongs to
Part B, which is v0.20. If D1 ships in v0.19.1 (finding 1), consumers get a
union member that can never appear in that release and must write dead
handling for it. Narrow the union to `'resolution' | 'snapshot'` on the
`v0.19.x` branch; keep the third value on `main`.

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

**Hold the v0.20 line and cut v0.19.1 first.** Findings 2 and 3 are small and
belong on the `v0.19.x` branch alongside the cherry-picks, so they cost
nothing extra if done in the same pass. Nothing here requires reworking what
was implemented — the source is in good shape, and F7 in particular is better
than the RFC asked for.
