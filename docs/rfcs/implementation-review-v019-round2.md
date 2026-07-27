# Implementation review — v0.19 round 2 (fix verification)

Reviewed: `0490304` (merged `fb9f8af`) against the round-1 report
(`implementation-review-v019.md`). Method: both reviewers compiled the
pre-fix (`08bc9dc`) and post-fix (`HEAD`) sources into separate out-of-repo
builds and ran the **same repros** against both; one reviewer additionally
built an independent 512-bit BigInt fixed-point oracle (Machin π + Taylor,
no native transcendentals) to measure dmath accuracy. Repo untouched.
Health: `tsc --noEmit` clean, 249 passed / 3 skipped (was 237/240).

## Verdict

**Session kernel: fixes verified, ship-quality after two small corrections.**
**dmath: NOT ready — the accuracy gate is now demonstrably failing, not merely
untested, and the new fixtures freeze incorrect values.**

Every round-1 defect is verified fixed by executable repro. No regressions in
previously-passing contracts. New-test quality confirmed: running HEAD's
`test/session.test.ts` against pre-fix `src/` fails 4 of 6 new tests — they
are genuine end-to-end regression tests, not decoration.

| Round-1 item | Verdict |
|---|---|
| P0-1 commitment bookkeeping atomicity | **VERIFIED-FIXED** (scratch maps, merge-on-success; live≡rehydrated byte-identical; offender can retry with the *same* submissionId) |
| P0-2 `finalizeReplay` systemInput | **VERIFIED-FIXED** (explicit `systemInput` on the resolution event) |
| P1-3 checkpoint digest | **VERIFIED-FIXED** (`transitionRevision` dropped from digest; checkpoint = summary = kernel = rehydrated) |
| P1-4 terminal guards | **VERIFIED-FIXED** for advance/ingest/deadline; `prepareExtension` still unguarded |
| P1-5 redacted-mismatch reporting | **VERIFIED-FIXED** (`RecheckResult.diagnostics`) |
| P1-6 unknown-property rejection | **VERIFIED-FIXED** (27/27 probes rejected, no gaps; v1.0 back-compat holds) |
| P1-7 salt-reuse warning | **VERIFIED-FIXED** (non-fatal, cross-level, no false positives) |
| All P2 items | **VERIFIED-FIXED** (fork-handle discard, typed `unknown_submission`, `maxFutureTicks`, catch-up 600, deep-frozen events, `2**256`, roundTo boundary, backend capture, windowRef single source) |
| PredictionSession | **Re-scoped to v0.20** with a substantive reason (needs an acknowledgement identity/order contract first) — accepted |

---

## P0 (new) — dmath numerics must be fixed BEFORE `dmath-1` is frozen

### N1 · HIGH · Catastrophic cancellation at ordinary angles

Independent oracle measurement of the shipped implementation:

```
max sin ulp err = 1.2605 (x = 191.888…)     max cos ulp err = 1.3257 (x = 921039136.09)
|x| <= 2pi: max sin ulp = 1.1599, max cos ulp = 1.2218   [RFC-007 §3 target: <= 1 ulp]
max atan2 ulp err = 2.5556                  [no documented atan2 target exists]

sin(3.141592653589793)  = 1.224646799076922e-16   true 1.2246467991473532e-16   ulp err 285703
sin(6.283185307179586)  = -2.449293598153844e-16  true -2.4492935982947064e-16  ulp err 285703
cos(1.5707963267948966) = 6.12323399538461e-17    true 6.123233995736766e-17    ulp err 285703
```

Cause: the fast path (`dmath.ts:181-185`) uses a 2-term π/2 split
(`PIO2_1`/`PIO2_1T`); fdlibm's third term is absent, so the reduced argument
loses ~11 significant digits near multiples of π/2.

This is not the documented "huge angle precision cliff" (RFC-007 §6-Q1) —
**π, π/2 and 2π are the most ordinary inputs a game can supply** (a half
turn, a quarter turn). The RFC promises ≤1 ulp on |x| ≤ 2π; the shipped
implementation misses that target on the whole range and misses it by five
orders of magnitude at the three most likely arguments in the range.

Fix: add the third π/2 term (fdlibm `pio2_2`/`pio2_2t`) or full Payne–Hanek
for the reduced path, then re-measure against the oracle.

### N2 · HIGH · New fixture vectors freeze incorrect values

`fixtures/dmath/dmath-1.vectors.json` gained near-π vectors — which pin the
**wrong** results produced by N1:

```
sin(3.1415926535897927) fixture 3cc469898cc40000 = 5.665538897577548e-16
                        correct                  = 5.66553889764798e-16   (relDiff 1.24e-11)
sin(3.1415926535897936) same class                                        (relDiff 2.19e-11)
```

Because golden vectors are the freeze mechanism, fixing N1 changes them —
and under the RFC's own append-only rule that would require `dmath-2`.
**Order of operations matters: fix the numerics first, then freeze.**

### N3 · MEDIUM (process) · `roundTo` was changed in place inside frozen `dmath-1`

RFC-007 §12: *"If those tests expose an algorithm change, assign a new
append-only algorithm ID rather than editing `dmath-1`."* The round-1
`roundTo` correction is numerically right but changes results for ~0.37% of
inputs, far beyond the documented tie boundary:

```
292,619 sampled inputs → 1,080 behavior changes vs pre-fix
  roundTo(-6.435315244726107, 15): old -6.435315244726108 → new -6.435315244726107
  roundTo(8095.146193127485, 12):  old 8095.146193127486  → new 8095.146193127485
```

Mitigation available: **v0.19 is unreleased, so `dmath-1` has no published
consumers.** Declare `dmath-1` unreleased-until-v0.19-ships (a one-line
statement in RFC-007 §3 and the release notes), land N1+N3 together, and the
append-only rule starts clean at the tag. Otherwise bump to `dmath-2`.

---

## P1 — session kernel corrections (both reviewers, independently)

### N4 · MEDIUM · Terminal guard breaks receipt idempotency (RFC-006 §F-E1/§D3)

`session.ts:613-616` sits **before** the existing-receipt short-circuit
(`:619-632`), so an at-least-once transport re-delivering an
already-accepted submission after the final resolution now hard-errors:

```
PRE : exact duplicate retry after terminal → "duplicate"  (correct)
HEAD: → SessionAdvanceError(terminal): session is already terminal
```

Fix: move the terminal check **after** the `existing` duplicate branch
(keep it before the eviction/preview/collect path).

### N5 · MEDIUM · `deepFreeze` is unbounded and non-reentrant

`session.ts:363-369` (called `:586`). `SubmittedAction` is never
JSON-validated (`structuredClone` only), so a `commandToAction` returning a
self-referential or very deep object crashes the kernel:

```
HEAD: advance → RangeError: Maximum call stack size exceeded   (PRE: OK)
```

Fix: iterative worklist with a `WeakSet` of visited nodes and/or a depth cap.

### N6 · LOW-MEDIUM · Pre-fix transcripts are no longer finalizable

`finalizeReplay` now emits `systemInput` only from `event.systemInput`, and
the v1.1 schema makes it mandatory for `cause: 'deadline'`:

```
legacy transcript → ReplayFormatError: resolution 1 deadline cause requires systemInput
```

Mitigating: v0.19 is unreleased, so no such transcripts exist outside dev
trees. Either accept and note it, or fall back to the last
`participantId !== null && submissionId === null` input when absent.

## P2 — cleanups

- `prepareExtension` still lacks the terminal guard the three siblings gained
  (`session.ts:1062-1077`), and has no `try/catch` → `discardDraft` on throw.
- `Prepared.deltas` remain shallow-frozen and aliased into the result
  (`:591`, `:1005`) — the `events` immutability fix was not applied to them.
  Kernel state is not corruptible through them; contract asymmetry only.
- `maxBufferedSubmissionsPerSeat` is unreachable at any value ≥2
  (`collectIntent` raises `conflicting_intent` first) and at 1 it *masks*
  that protocol error (`:688-697`). Count across unresolved windows, or drop
  it and amend RFC §D-Q6.
- `maxFutureTicks` off-by-one (`:959-965`): `target - tick > max` admits
  `=== max`, so the default 2×rate resolves rate×2+1 ticks.
- A live `commit_mismatch` advance publishes **no checkpoint** (the
  reorder branch at `:992-998` is unreachable because a rejection always
  breaks on loop iteration 0) — desync detection has a hole at exactly the
  interesting moment. Consider emitting a checkpoint on the rejection path.
- `RecheckResult` gained a 4th key — a structural-equality break for
  consumers; call it out in the release notes even though the release is
  labelled non-breaking.
- A fully redacted mismatch artifact still rechecks `ok: true`
  (`replay-format.ts:1309-1312`); `ok`-only consumers cannot distinguish
  "re-verified" from "took the host's word". Consider `recheckable: false`
  or a documented rule to gate on `diagnostics.length === 0`.
- A *fully verified* `commit-mismatch` still lands in `problems`
  (`replay-format.ts:1335-1338`), so an honest transcript rechecks
  `ok: false` — indistinguishable from a corrupt artifact. With
  `diagnostics` now available, move it there.
- Duplicate problem strings for `kind: 'action'` records
  (`replay-format.ts:943-944`).

## Remaining merge gates

**RFC-007 (all still open):** accuracy oracle still compares against native
`Math.sin/cos/atan2` — the very functions the RFC forbids as a reference
(`test/dmath-commitment.test.ts:32-36`); no ulp bounds asserted; coefficients
are still Taylor reciprocals with no generation script (`scripts/` has one
unrelated file, repo-wide `minimax|sollya|remez` → 0 hits); CI is
ubuntu + Node 20.3/22 only, no JSC/SpiderMonkey/workerd matrix; the contract
table in `docs/session-and-integrity.md` still has no per-range accuracy
column (RFC-007 §3 calls that a merge blocker); fixture gaps remain
(no `atan2` denormal/near-π vectors, no published `roundTo` tie-boundary or
±0 vector).

**RFC-008:** tamper matrix, NIST/WebCrypto/block-boundary vectors, and the
dmath-abort test all **landed and verify**. Still open: unrevealed-commitment
redacted finalization has no test (behavior verified correct by hand);
no cross-language (Python) commitment vector run; the salt-reuse warning
exists only in the replay verifier, not the live kernel (RFC-008 §9-A2 says
"within a session").

**RFC-006:** cadence equivalence, delta-stream reproduction, and the
leak check now exist but are shallow (one ready window; every delta is a
`snapshot` so the `unchanged` reconstruction path is never exercised; the
leak check is a single `toContain` on one seat). Crash-rehydrate is a
2-point ingest-only loop — no crash-after-rejection, crash-mid-catch-up, or
crash-after-deadline. Receipt-eviction → `unknown_submission` and
`buffer_limit` have no test at all. No test asserts any error `.code`. No
test asserts the `cursor === tick` invariant that the windowRef unification
now silently depends on.

## Suggested order

1. **N1 + N2 + N3 together** (fix range reduction → re-measure with an oracle
   → regenerate fixtures → declare `dmath-1` unreleased). Do this before any
   tag, or the frozen id ships wrong.
2. N4, N5 (both small, both have repros).
3. N6 decision, P2 cleanups.
4. RFC-007 merge gates (oracle + provenance + cross-runtime) — these are
   what would have caught N1 automatically.
5. Deepen the RFC-006 shallow gates.
