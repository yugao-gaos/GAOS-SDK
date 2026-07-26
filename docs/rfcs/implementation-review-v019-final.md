# Release-gate review — v0.19.0 (final)

Reviewed: `c48d67f` against RFC-009 §2 release gates, the round-2 defect list,
and the RFC-006/007/008 normative contracts. Method: two independent
reviewers, repo untouched, compiled to out-of-repo builds and driven from
standalone scripts. The dmath reviewer built its **own** 400/560-bit BigInt
oracle (Machin π, half-angle atan — deliberately different algorithms from
the shipped one) and cross-checked the repo's oracle rather than trusting it.
Health: `tsc --noEmit` clean; 256 passed / 3 skipped.

## Verdict

**dmath: SAFE to freeze `dmath-1` at the tag.**
**Session kernel: two contract defects must land before the tag.**

Everything RFC-009 §2 named as a gate is genuinely implemented and verified —
run composition is correct and end-to-end recheckable, the acknowledgement
identity/order contract matches its normative text, host obligations are
normative with a worked example and all three crash boundaries, N1–N4 are
closed. No regressions: 22/22 previously-green kernel contracts still pass,
live≡rehydrated at 7 distinct crash boundaries. This is a materially better
release than round 2 reviewed.

The two remaining items are blocking **only because of the freeze**: both
consumers migrate in parallel against the tag, both defects sit in a
consumer's core loop, and both are contract-shape changes that RFC-009 §4
forbids fixing in a 0.19.x patch.

---

## Must land before the tag

### F1 · A fully verified `commit-mismatch` still lands in `problems`

`src/engine/replay-format.ts:1336-1339`. Same honest session, two
visibilities:

```
full artifact (with attemptedReveal) → ok:false  problems:["commit_mismatch: seat red, commitmentId 0"]
redacted (attemptedReveal removed)   → ok:true   diagnostics:["recorded but not independently recheckable"]
```

An honest player who fumbles one reveal produces a run that fails recheck and
is **indistinguishable from a forgery**, while **withholding the evidence
makes the same run pass**. Arena's leaderboard, benchmark, and paid-board
rows are all gated on `ok`. The only workaround is regex-matching an
unversioned problem string — the semantics fork RFC-006 exists to prevent.

Fix: a verified mismatch belongs in `diagnostics`; `problems` stays for
artifacts that are actually inconsistent (the matching-hash case already
does this correctly).

### F2 · The acknowledgement contract has no rejection signal

`src/session.ts:916` returns `deltas: []` on the rejection path; no delta, no
acknowledgement, and `viewRevision` does not advance (the cursor watermark
stalls with it).

```
rejection advance events  :: checkpoint,rejection
rejection advance deltas  :: []
viewRevision after rejection :: unchanged
```

TabletopLabs' entire migration is a hand-rolled reconcile against this
contract. A rejected submission is invisible in the per-seat stream, so the
client can never drop it from pending — the entry leaks forever, and the host
must invent an out-of-band channel. RFC-009 §2.2 moved this contract into
v0.19 *specifically* so TTL would not have to invent an answer that v0.20
then contradicts; this is the one case it still leaves them to invent.

Fix: additive (a `rejections` field alongside `acknowledgements`, or a
per-seat rejection notice) — but it changes `ObservationDelta`, which §4
freezes at the tag.

---

## Should land before the tag (cheap, and freeze-shaped)

### S1 · "at most 1 ulp" is a metric equivocation (docs)

Both accuracy tables (`docs/session-and-integrity.md:164`,
`docs/rfcs/rfc-007-deterministic-math.md:115-116`) state a flat "at most
1 ulp". Independently measured:

| metric | sin, \|x\| ≤ 2π | cos, \|x\| ≤ 2π | atan2 |
|---|---|---|---|
| bit-distance to correctly-rounded (what the tests assert) | 1 | 1 | 3 |
| real error \|computed − exact\| / ulp (classical) | 1.303 | **1.437** | 2.818 |

The claim is true under bit-distance and false under the classical
definition. Two product teams will read the flat number. Restate in the
RFC-007 §8-R2 per-range form **and name the metric**, e.g. `|x| ≤ 2π: ≤1 ulp
bit-distance (≤1.5 ulp real error); |x| ≤ 2^30: ≤2 ulp`. This also closes the
round-2 per-range-table merge blocker, which is still open verbatim.

Root cause of the ~1.44 floor: `reduceTrigFixed` returns the reduced argument
as a single double, discarding the residual; fdlibm returns a double-double
`(r, c)`. The 0.5-ulp rounding of `r` is amplified up to 2× across binade
boundaries (worst near `r ≈ 0.5236`). **Structural fix needs `dmath-2` and is
correctly post-tag work** — but note the shipped assertion
(`test/dmath-commitment.test.ts:65`, `≤1`) has only ~0.06 ulp of margin, so
it is a latent CI flake, not a proof. Consider widening it to the §8-R2
`≤2` for the full domain while documenting the observed max of 1.

### S2 · Pin `viewRevision(seat) === cursor()` as a normative invariant

Verified to hold at every observed point (init, ingest, 1 tick, 5-tick
catch-up, deadline, extension). It is the **only** mechanism by which a
client can map `IngestReceipt.cursor` to a delta revision after a
`snapshot(seat)` resync — without it, a client that misses a delta cannot
recompute its pending set at all. Undocumented and untested today; if it
is not pinned, TTL either never finds it or builds on it unsafely, and
v0.20 could break it silently.

### S3 · Guard `finalizeRunReplay` against derived-`seedPolicy` segments

`src/session.ts:482-484` derives the kernel's own level seed at a hardcoded
index 0. A host that builds level *i* with `seed: runLevelSeed(runSeed, i)`
and `seedPolicy: 'gaos.run-level-seed.v1'` initialises the reducer with
`runLevelSeed(runLevelSeed(runSeed,i), 0)` while the header records the outer
value — and `finalizeRunReplay` accepts it with no guard, producing a run
that verifies against the wrong seed or fails opaquely. One line: require
`transcript.header.seedPolicy === 'explicit'`.

### S4 · One error taxonomy for ingest

`./session` exports `PreparedTransitionError`, `SessionAdvanceError`,
`SessionConflictError`, but the 409-class errors also arrive as
`IntentCollectionError` from `./protocol` (`conflicting_intent`,
`stale_tick`, `unknown_participant`, `wrong_session`), which `./session` does
not re-export. No shared base, no union `.code`. Arena writes an HTTP
202/200/409 mapping table either way; making it a public contract stops the
two products writing two different ones.

---

## Fine as 0.19.x additive patches

1. **N5 residue** — `deepFreeze` is fixed (iterative + `WeakSet` + 100k cap;
   cycles and 200k-wide graphs handled), but `actionCopy`'s `structuredClone`
   (`src/session.ts:381-383`) still stack-overflows at ~5 000 depth, *before*
   `deepFreeze` runs, with an untyped `RangeError`. No state corruption or
   draft leak. The documented 100k-object cap is misleading at that depth.
2. **Serialization deduplication — the highest-leverage change for TTL.**
   Measured at 20 Hz, 4 seats: **99–100 % of per-tick kernel cost is
   serialization, not the game** (reducer + `viewFor` = 0.04–0.08 ms).
   `resolveOnce` does 3 `canonicalJson` + 2 `structuredClone` per seat per
   tick; `digestState` re-serializes all seat views; `makePrepared`
   `structuredClone`s the deltas twice plus two `deepFreeze` passes.

   | entities | B/delta/seat/tick | MB/seat/10 min | ms/tick | % of 30 Hz budget |
   |---|---|---|---|---|
   | 40 | 4 401 | 50.4 | 7.95 | 24 % |
   | 60 | 6 439 | 73.7 | 12.07 | 36 % |
   | 80 | 8 475 | 97.0 | 15.50 | 47 % |

   On a fast desktop. A Cloudflare DO isolate is materially slower.
3. `ReplayLevelResult.extensions` / `ReplayTotals.extensions` have no writer
   in `FinalizeOptions`/`FinalizeRunOptions` (Arena needs them for scores and
   benchmark facts). Post-projection hand-patching validates and rechecks, so
   Arena is unblocked meanwhile.
4. No `level_advance`-equivalent record kind; Arena re-expresses it as a
   `levelIndex` transition or an extension record.
5. `finalizeRunReplay` rejects runs that repeat a level id
   (`replay-format.ts:509-513`) — fine if intended, but Arena retries levels;
   document or relax. Differing seat rosters across segments are accepted
   with no check.
6. Document that `viewFor` redaction must **omit** keys rather than set
   `undefined` — otherwise `canonicalJson` throws inside `resolveOnce`.
7. `generate-dmath-evidence.mjs` prints derived coefficients and constants but
   never asserts equality with `src/engine/dmath.ts`. Three lines closes the
   drift gap.
8. Delete `test/dmath-commitment.test.ts:38-42`
   (`toBeCloseTo(Math.sin(value), 14)`). It is no longer the accuracy gate,
   but **it is why N1 escaped**: at `sin(π) ≈ 1.2e-16`, a 285 703-ulp error is
   ~7e-27 absolute, which `toBeCloseTo(_, 14)` passes trivially. Leaving it
   invites someone to mistake it for coverage.
9. `liveTranscript()` is a full O(n) deep clone per call; persist
   `prepared.events` instead. No incremental accessor.

---

## Verified clean (evidence highlights)

**dmath N1/N2/N3 — root-cause fixed, not papered over.** The 2-term π/2 split
is gone entirely; everything outside `[-π/4, π/4]` now routes through the
256-bit Payne–Hanek reduction.

```
sin(π)  ulp 0    sin(2π) ulp 0    cos(π/2) ulp 0        (round 2: ~285 703)
dense sweep ±1500 doubles around k·π/2, k=1..8, ±  (~24 000 pts): max ulp 0
all 35 frozen vectors: bits == implementation == independent oracle
the two previously-wrong vectors: ulpErr 71 426 → 0 and 142 851 → 0
independent oracle vs shipped oracle: 0 disagreements / 956 comparisons
both 256-bit constants reproduced bit-for-bit from an independent 600-bit π
```

**Cross-runtime bit-identity — executed live, not just wired.**

```
chromium 151.0.7922.34 · firefox 153.0 · webkit 26.5 · workerd 1.20260724.1
→ all four pass the frozen dmath-1 vectors
```
(V8 / SpiderMonkey / JavaScriptCore / workerd — the RFC-007 §5 matrix,
in CI via the `dmath-runtimes` job.)

**`dmath-1` freeze status (N3).** RFC-007 §13 + `releases.md` +
`version-history.md` declare it a release candidate until the v0.19 tag; no
`v0.19.0` tag exists yet and dmath first appeared in unreleased `a01fe7b`.
**No published SDK ever shipped `dmath-1`**, so the regenerated fixtures
cannot invalidate any replay in the wild — exposure is limited to pre-fix dev
builds. The append-only rule starts clean at the tag.

**`finalizeRunReplay`** — derived seeds enforced with rejection, per-segment
`levelIndex`, global contiguous numbering accepted by the validator,
aggregate totals, all-segments-terminal with only the final one permitted to
fail, and a real 3-level run (extension record, deadline-resolved level,
failed final) rechecks `ok` and round-trips through JSONL.

**Acknowledgements** — identity is exactly `(participantId, submissionId)`,
present on every delta including `unchanged` bodies, host-derived deadline
inputs correctly excluded, and ordering is canonical reducer-input order
(sorted seats), *not* arrival order — matching RFC-006 rev 8 verbatim. With a
complete stream a client computes its pending set exactly at every revision.

**Round-2 P2 list** — `prepareExtension` terminal guard and
`try/catch → discardDraft`, `Prepared.deltas` deep-frozen and unaliased,
`maxBufferedSubmissionsPerSeat` removed with RFC §D-Q6 amended,
`maxFutureTicks` resolved by specification, checkpoint now emitted on the
rejection path with matching digest, `RecheckResult`'s 4th key documented in
the release notes, duplicate `kind:'action'` problem strings fixed. Only F1
remains open from that list.

**Python cross-language** — `python/tests/test_replay.py:42-59` reconstructs
the RFC-008 preimage in pure Python (`struct.pack(">I")` framing, `">Q"`
counters, raw salt bytes, `canonical_json`) and asserts preimage hex + SHA-256
for all published vectors. Could not execute here (no CPython), but the
identical assertions were reproduced against the same fixtures and
cross-checked with the TypeScript implementation: 3/3 vectors match on both
preimage and digest.

---

## Suggested order

1. **F1 + F2** — both small, both freeze-shaped, both in a consumer's core
   loop. Nothing else blocks the tag.
2. **S1–S4** — documentation and one-liners; cheap now, awkward later.
3. **Tag `v0.19.0`.** Both migrations start against it; RFC-009 §4 classification
   applies from that moment.
4. 0.19.x additive patches, with **item 2 (serialization dedup) first** —
   it is TTL's tick budget and needs no contract change.
