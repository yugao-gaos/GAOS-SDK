# Implementation review — v0.19 (RFC-006/007/008)

Reviewed: commit `a01fe7b` (merged `08bc9dc`) against the design-approved
RFCs. Method: two independent reviewers (session kernel; dmath + commitment +
replay v1.1), contract-by-contract verification with executable repros for
every suspected defect; repro scripts ran against a fresh compile, repo
untouched. Baseline health: `tsc --noEmit` clean, 237/240 tests green.

**Verdict: substantially contract-faithful — most hard-won review contracts
are correctly implemented — but NOT merge-ready.** One HIGH defect
(independently reproduced by both reviewers), one shared MEDIUM-HIGH audit
corruption, several unmet merge gates, and one normative feature missing
entirely.

## What verified clean (highlights)

- Prepared-transition lifecycle: exactly-once commit/abort, stale-commit
  auto-abort, typed lifecycle errors without double cleanup — PASS with
  tests (session.ts:275-288, 540-554, 981-1005).
- SessionStateIsolation fork/discard/retire incl. constructor probe — PASS;
  retire spy-tested.
- transitionRevision vs cursor separation, event ids, rehydration of both
  counters — PASS.
- ObservationDelta shape/monotonicity/unchanged markers/snapshot path — PASS.
- Commitment framing **byte-verified by hand**: domain-tag framing, u64-BE
  counters, raw-salt preimage, NFC-vs-NFD code-point distinction, windowRef
  safe-integer bound — all exact (commitment.ts:96-172).
- Sync SHA-256 externally checked against NIST vectors ("", "abc", 448-bit,
  1M×'a') — correct.
- Replay v1.1: grouped inputs applied via ONE advanceTick per resolution;
  v1.0 fixture parses and byte-round-trips; unconstructible dmath algorithm
  aborts recheck before simulation.
- Determinism scans clean in all new code (no wall clock, no ambient RNG,
  sorted-seat intent order).

## Defects (ranked; fix P0 before any consumer adopts)

### P0-1 · HIGH · Rejection path bricks the session and breaks rehydration equivalence

`mapIntents` (session.ts:687-735) mutates draft commitment bookkeeping
(registrations, `nextCommitmentIds`, `revealed`) per intent BEFORE the batch
is known to verify. On a `commit_mismatch` rejection, `resolveOnce`
(:765-771) commits those partial mutations while the already-processed
seats' intents stay pending. Confirmed live repro: alpha commits, zulu
reveals a mismatch → every subsequent `prepareAdvance` throws
`SessionConflictError: commitmentId 0 must be 1` forever — even after the
offender retries honestly. Rehydration replays the rejection as an intent
deletion only, so a rehydrated kernel DOES advance — live and rehydrated
state diverge, exactly the class the RFC bans. Trigger condition is common:
any committer sorting before a mismatching revealer in one simultaneous
window (batch order is sorted-seat, protocol.ts:256).
**Fix:** two-phase `mapIntents` — verify the whole batch against scratch
maps; merge side effects into the draft only when no rejection occurred
(or snapshot/restore the three structures on the rejection branch). Add the
end-to-end test: live rejection → continue playing → finalize → recheck →
rehydrate-equivalence.

### P0-2 · MEDIUM-HIGH · `finalizeReplay` records the wrong `systemInput`

Projection takes `event.inputs[0]` (session.ts:1253-1255) but `resolveOnce`
appends forced deadline inputs LAST (:762-763). Repro: deadline window with
one collected intent → the participant's action is recorded as the canonical
system input instead of the host's timeout action; schema validation cannot
catch it (membership check only). This corrupts the E3 audit contract.
**Fix:** mark the forced input explicitly on the resolution event (or select
`participantId === null && submissionId === null`); test a deadline
resolution with mixed participant + system inputs.

### P1 (should fix in the same pass)

- **P1-3** Checkpoint digests never match `kernel.digest()`: `digestState`
  includes `transitionRevision` (session.ts:1060) but runs before
  `makePrepared` bumps it (:520). Checkpoint-based desync detection can
  never succeed (repro: 416651337 vs 1709933558). Fix: exclude the
  persistence counter from the digest, or compute after assignment.
- **P1-4** `prepareDeadline` (and `prepareIngest`) lack the terminal guard
  that `prepareAdvance` has (:854-857): a late host deadline advances past
  terminal and poisons the transcript (grouped verifier then rejects it).
- **P1-5** Redacted `commit-mismatch` records recheck `ok:true` silently
  (replay-format.ts:1103-1106). RFC-008 §4 requires reporting
  recorded-but-not-independently-recheckable; `RecheckResult` needs a
  non-fatal diagnostics channel — which also unblocks **P1-7** (salt-reuse
  warning, currently absent entirely).
- **P1-6** Strict schema rejects unknown record KINDS but not unknown
  PROPERTIES (replay-format.ts:398-863) — contradicts the frozen-format
  rule (RFC-006:379). Fix: per-kind key allowlists.

### P2 (cleanups)

- Rejected submission leaves a stale `accepted` receipt; exact retry says
  `duplicate` while the window still waits — submission silently poisoned
  (session.ts:559-575, 766-769).
- Original fork handle escapes `discard` when a fresh-state reducer replaces
  `draft.reducerState` (session.ts:527/772) — leaky for resource-owning
  `fork` + fresh-state reducer combos; retain and discard the original fork.
- `unknown_submission` is message text, not a typed code (session.ts:290-297).
- RFC limits `maxFutureTicks`/`maxBufferedSubmissionsPerSeat` unimplemented;
  `maxCatchUpTicks` default 256 vs RFC 600 — implement or amend the RFC.
- Rehydrated tombstone eviction order can diverge from live (session.ts:1184
  vs 838-846).
- `Prepared.events` share references with the live transcript and are only
  shallow-frozen (session.ts:521, 533) — deep-freeze or clone.
- `2 ** 256` in dmath.ts:96 — the `**` operator is implementation-approximated
  by spec; use `Number(1n << 256n)` in the module that defines the whitelist.
- `roundTo(0.49999999999999994, 0) === 1` — deterministic but violates the
  documented half-away-from-zero rule via `floor(x + 0.5)` double rounding;
  post-correct the boundary.
- Custom `DmathBackend` methods are read per call from an unfrozen caller
  object (dmath.ts:309-319) — capture method references at construction.
- `windowRef` dual provenance: live binds to `cursor`, replay binds to
  `resolution.tick` (session.ts:698 vs replay-format.ts:1026) — equal today
  by lockstep coincidence; pick one recorded source.
- Cosmetic: misindent at session.ts:851; checkpoint ordered after rejection
  in one prepare.

## Normative feature missing

**`PredictionSession` (RFC-006 §3.2) is not implemented at all** — no
`predict/reconcile/pending` anywhere in `src/`. Either implement it in
v0.19 or explicitly re-scope it to v0.20 in the RFC disposition; silence
leaves the client-companion contract dangling for consumers (TabletopLabs'
reconcile implementation depends on its delta/ordering discipline).

## Unmet merge gates (from the RFC approval conditions)

1. dmath accuracy oracle: only `toBeCloseTo(Math.sin…)` — testing against
   the very functions the RFC forbids; a high-precision reference with
   documented ulp bounds is the stated gate.
2. Coefficient provenance: kernels are Taylor reciprocals, not the
   documented-script minimax the RFC records (no generation script in repo).
3. Cross-runtime golden vectors: CI is Node/V8 only; JSC/SpiderMonkey/workerd
   runs are the stated matrix.
4. Cadence-equivalence test (turns vs ticks → identical transcripts): absent.
5. Delta-stream reproduction + leak-check tests: absent (no session test
   uses viewFor/hidden info at all).
6. Crash-rehydrate matrix: one crash point tested; per-seat matrix absent.
7. Tamper matrix: only wrong-payload tested; wrong salt/window/seat/
   cross-session missing. WebCrypto/NIST vectors not in-suite; no
   block-boundary padding cases.
8. Immutable-reducer variant of the lifecycle suite (§L) absent.
9. Fixture gaps: no denormals or near-π multiples in dmath vectors; v1.0
   commitment-field rejection untested; dmath-abort recheck untested.

## Suggested order of work

1. P0-1, P0-2 with their end-to-end tests (both have ready repros).
2. Diagnostics channel on `RecheckResult` → P1-5 + P1-7 together.
3. P1-3, P1-4, P1-6.
4. Decide PredictionSession scope (implement or re-scope).
5. Merge-gate test debt (items 4–9), then the dmath numerical gates (1–3)
   before v0.19 is tagged.
