# Tag-gate review — v0.19.0 (F1/F2/S1–S4 verification)

Reviewed: the uncommitted working tree over `c48d67f` (`src/session.ts`
sha1 `54879d8b`, 1851 lines — it was edited mid-review and settled there).
Two independent reviewers; repo untouched; everything compiled out-of-repo and
driven from standalone scripts, plus 100 000 differential mutations across the
TypeScript validator, the JSON Schema, and a line-by-line transliteration of
the Python validator. Health: `tsc --noEmit` clean, 259 passed / 3 skipped.

## Verdict: **not safe to tag.** Seven items, three of them load-bearing.

The fixes that landed are real and several exceed what was asked. F2 in
particular is stronger than the RFC proposed: rejections became first-class
per-seat observation envelopes with a durable notice log and
`snapshot(seat, afterTransitionRevision)` recovery, proven by a hand-rolled
reconcile client that computes an exact pending set at every revision,
including across a dropped delta. F1, S1, S2, S3 are all verified fixed. No
regressions: 15/15 independent kernel contracts, live≡rehydrated at 7 crash
boundaries including after a rejection, all 35 dmath vectors bit-exact, NIST
SHA-256 clean.

But the freeze is the point. Three of the seven blockers are in the two
things v0.19 freezes hardest — the **cross-language canonical form** and the
**audit semantics** — and they are not detectable after the fact.

---

## Blocking

### B1 · HIGH · Canonical JSON key order diverges between TypeScript and Python

`src/protocol.ts:441` sorts with `Object.keys().sort()` — UTF-16 code-unit
order. `python/agilabs_arena/replay.py:802` sorts with `sorted()` — code-point
order. They disagree whenever an object mixes a non-BMP key with a key in
U+E000–U+FFFF:

```
JS      Object.keys().sort() → ["😀","�"]  → {"😀":1,"�":2}
Python  sorted()             → ["�","😀"]  → {"�":2,"😀":1}
```

This is not a cosmetic difference. `canonicalJson` is framed directly into the
**commitment preimage** (`commitmentPreimageV1`) and is the replay
serializer, so an emoji-keyed reveal payload or level object produces a
**different hash and different JSONL bytes** in the two implementations.

The architecture's load-bearing claim is that the *format* — not the language
— is the interop boundary. A canonical form that is not deterministic across
languages is not a canonical form. RFC-008 §2 and §11 say "sorted keys"
without naming the collation; no fixture covers a non-BMP key.

Fix: pin the collation normatively (code-point order is the natural choice
and matches Python), conform the JS side, and add a non-BMP-key vector to
`fixtures/commitment/`.

### B2 · HIGH · Canonical JSON number rendering diverges for large integers

`replay.py:744-745` renders Python's arbitrary-precision ints via `str()`;
JavaScript parses every JSON number to binary64:

```
JSON literal 1000000000000000000000 → JS "1e+21"            | Python "1000000000000000000000"
JSON literal 9007199254740993       → JS "9007199254740992" | Python "9007199254740993"
```

Any integer ≥ 1e21 or > 2^53 anywhere in `level`, `extensions`,
`extension.record`, `reveal.payload`, or `verifiedPayload` yields different
canonical bytes, hence different digests and a non-byte-exact cross-language
round trip. `test_replay.py:187-201` exercises only the *float* path, so the
int path is untested. Fix: reject non-safe integers in `_validate_json_value`
(or route ints through the float renderer) and add int-literal cases.

### B3 · MEDIUM-HIGH · The F1 fix converts false positives into false negatives

Moving a verified `commit-mismatch` out of `problems` was correct, but
`recheckGroupedLevel` (`replay-format.ts:1317-1362`) never checks
`commitment.revealed`, never dedupes `(participantId, commitmentId)`, and
never binds `record.tick` or `record.submissionId` to anything. Executed
against an honest artifact — all four now recheck `ok:true`:

```
commit-mismatch moved AFTER the successful reveal   → ok:true "verified commit_mismatch"
commit-mismatch duplicated 5×                       → ok:true, 5 diagnostics
commit-mismatch tick rewritten to 999               → ok:true
commit-mismatch submissionId → nonexistent          → ok:true
```

At HEAD these landed in `problems` as a *side effect of the bug being fixed*.
A forged run can now claim unbounded "verified" fumbles against an
already-consumed commitment and still pass. Fix is small and contract-shaped
(hence pre-freeze): reject when `commitment.revealed`, and dedupe on
`(participantId, commitmentId, canonicalJson(attemptedReveal))`.

### B4 · MEDIUM · `prepareDeadline` drops the deadline audit record when a rejection coincides

`src/session.ts:1237-1244`: on the rejection branch `rawEvents` is
`[rejection]` — the `kind:'deadline'` event is never constructed, so
`deadlineId` vanishes from the transcript and the forced system action never
runs, while `prepareDeadline` still returns a committable `Prepared` with
`resolutions: 0`.

```
deadline audit event kept?                 :: false
deadlineId "alpha-timeout-1" in transcript :: false
SAME deadlineId accepted again             :: deadline,resolution,checkpoint
```

Reachable whenever one seat has a pending reveal and the host fires a timeout
for another — i.e. TabletopLabs' main loop in any commit/reveal game. This
breaks the E3 audit contract (the deadline event records *why* a resolution
occurred). Fix: always emit the `deadline` event, then the rejection, and
relax `validateDeadlineAudit` (`session.ts:1605`) to accept
`deadline → rejection`.

### B5 · MEDIUM · Same rejection, two canonical event orders

`prepareAdvance` deliberately reorders so the checkpoint precedes the
rejection (`session.ts:1160-1165`); `prepareDeadline` never got the mirror:

```
prepareAdvance  rejection :: checkpoint,rejection
prepareDeadline rejection :: rejection,checkpoint
```

One logical transition, two byte orders in the transcript and therefore in
the projected `records[]`. Freeze-shaped by definition.

### B6 · MEDIUM · S4 (ingest error taxonomy) is untouched — and now worse

`prepareIngest` itself now constructs `IntentCollectionError`
(`session.ts:664`, `:670`), a class `./session` imports but does not
re-export. Full enumeration of what a host can receive from `prepareIngest`:
**18 paths, 9 of them classes `./session` does not export**, and 2 are bare
`TypeError` with no `.code` at all (Arena must map those to 400, not 409).

Arena cannot write one mapping table from `./session` — it must reach into
`./protocol` for `instanceof` — and both products will write different ones.
Still a three-line fix: re-export `IntentCollectionError` and its code union,
or add a shared `SessionIngestError` base.

### B7 · MEDIUM · Python is materially looser than TypeScript

60 000 differential mutations: **98.0 % agreement, 25 divergence classes,
every one Python-accepting.** Two root causes:

- `_reject_unknown` is called **only inside the `records` block**. The
  top-level `actions` loop and every header / level / totals / game object
  have no unknown-property rejection. Since **v1.0 is the shape with no
  `records`**, Python enforces *zero* strictness on v1.0 artifacts —
  a v1.0 replay stuffed with foreign fields parses clean in Python and is
  rejected by TypeScript.
- `d.get(k) is not None` vs TypeScript's `!== undefined`: an explicit JSON
  `null` silently disables the check for `records`, `attemptedReveal`,
  `commit`, `reveal`, `targets`, `visibility`, `version`; a **missing**
  `level.result.stars` also passes Python while both the TS validator and
  the JSON Schema require it.

Until this closes, Python must not be advertised as an equivalent second
implementation — which matters because cross-language verification is the
evidence for the format-as-boundary claim.

---

## Operational: the Python suite has never been executed

Neither reviewer could run pytest — this machine has no CPython, only the
Microsoft Store execution-alias stub. **Every Python claim in this review
rests on a line-by-line transliteration plus code reading.** Run
`python -m pytest python/tests` on a real interpreter before the tag.

Related, and easy to trip over at publish time: the built distributables in
the working tree are **pre-fix** —
`python/dist/gaos_turn_based_grid_sdk-0.19.0-py3-none-any.whl` contains a
635-line `replay.py` with none of the +287 lines (and a stale
`__pycache__/replay.cpython-312.pyc`). `python/dist/` is gitignored so
nothing ships from git, but `twine upload dist/*` at tag time without a
rebuild would publish the pre-fix Python. Rebuild as part of the release
procedure.

---

## Non-blocking (0.19.x or documentation)

- **`checkpoint.digest` is never rechecked** — forging it, or deleting every
  checkpoint record and renumbering, both still recheck `ok:true`. A portable
  verifier cannot reconstruct `digestState` without `viewFor`, so this may be
  unavoidable — but then document it as advisory-only, because
  `docs/releases.md` currently presents the rejection-path checkpoint as an
  integrity property.
- **`(seat, viewRevision)` is no longer a unique envelope key** (a
  rejection envelope reuses the current revision, by design). S2
  simultaneously pins `viewRevision === cursor()`, which makes that pair the
  most natural client dedupe key — and it now silently drops rejections. Add
  an explicit "key on `transitionRevision`, not `viewRevision`" warning.
- **`historicalSubmissionKeys` grows without bound** (`session.ts:464`) —
  ~48 000 retained keys at 20 Hz × 4 seats × 10 min in a DO isolate. It is
  the unbounded per-session structure `receiptRetention` exists to avoid.
- An honest rejection emits **two byte-identical consecutive checkpoints**.
- `records` is lost across serialize→parse when every record is
  `kind:'action'` (`hasV11Records` requires a non-action record). Byte round
  trip still holds; structural round trip is lossy for that shape.
- `noteSalt` runs before the `!seat` guard, poisoning salt-reuse diagnostics
  for hand-built artifacts.
- Rejected-identity retry reports `'receipt retention has expired'` when
  nothing expired.
- The seedPolicy guard sits at the projection boundary, not construction —
  a host plays an entire level mis-seeded and only learns at finalize.
- JSON Schema is never *stricter* than the validator (good), but a v1.0
  action carrying commitment fields is schema-accepted and validator-rejected
  — the one cheaply expressible drift.
- `rfc-007:459-461` still says "≤ 1 ulp on |x| ≤ 2π" without naming the
  metric, though the normative tables now do.
- dmath: the new `≤1` bit-distance assertion for |x| ≤ 2π holds over 104 011
  measured points but has **0.115 ulp of headroom** (max real error 1.3846
  for cos; the cliff is 1.5). It is a fixed-seed 512-point sample of what is
  now a *documented normative bound*. Structural fix (double-double residual
  from the reduction) is correctly `dmath-2`/post-tag.

## Verified clean (highlights)

**F2** — per-seat rejection envelopes, no payload leak (opponent sees
identity metadata only; salt and payload stay in the transcript), exact
pending-set computation across a rejection and across a dropped delta via
`snapshot(seat, afterTransitionRevision)`.
**F1** — all three visibilities correct on real kernel-produced single-level
*and* multi-level artifacts, through a JSONL round trip: verified-differs →
`ok:true` + diagnostic; redacted → `ok:true` + "not independently
recheckable"; forged-matching → `ok:false` + problem.
**S1** — both accuracy tables now name the metric with per-range bounds; the
dead `toBeCloseTo(Math.sin(...))` assertions are deleted.
**S2** — invariant stated normatively and holds at 15/15 observations across
both cadences, including after a rejection (no dedicated test, though).
**S3** — verified against a compiled pre-fix tree: the mis-seeded run that
silently rechecked `ok:true` is now rejected.
**Schema** — the four new constraints agree exactly with the validator; the
schema is never stricter, so nothing the validator accepts can be
schema-rejected.
**Bonus, not on any list**: `replayInput` now inverts `perm` correctly
(`session.ts:1577-1583`), fixing a real pre-existing bug where every
non-identity permutation produced "contradicts the replay permutation".

## Order of work

1. **B1, B2** — canonical form. Everything else can be patched later; this
   cannot, because it is what the tag freezes.
2. **B3** — one-liner, restores the audit property the F1 fix removed.
3. **B4, B5** — the deadline path; both one-liners, both freeze-shaped.
4. **B6** — three lines, saves both consumers from writing divergent tables.
5. **B7** + run pytest on a real interpreter + rebuild `python/dist`.
6. Then tag, and start the migrations.
