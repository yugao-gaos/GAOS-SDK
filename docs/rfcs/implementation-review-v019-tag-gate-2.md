# Tag-gate review 2 — v0.19.0 (B1–B7 verification)

Reviewed: the stable working tree over `c48d67f` (`src/session.ts` 1874 lines,
sha1 `8875356f`). Two independent reviewers, repo untouched, everything
compiled out-of-repo. Health: `tsc --noEmit` clean, 259 passed / 3 skipped.

## Corrections to the previous review

- **CPython exists** (`python/.venv`, uv-managed 3.12.13). `where python`
  returns only the Store alias stub, which misled the earlier reviewers.
  **pytest ran: 56 passed, 4 skipped.** Every Python claim below is executed,
  not transliterated.
- **`python/dist` is already rebuilt** — the wheel and sdist carry the current
  967-line `replay.py`, byte-identical to source. The stale-publish hazard is
  closed.
- **Environment hazard worth recording:** Node v24.11.0 on this machine
  corrupts strings inside `JSON.parse` under load (≈1e-4 per parse,
  deterministic per process, varying across processes: `U+E000` became
  `U+005C`). `--jitless` is stable; CPython is bit-stable. This produced 258
  *false* divergences in a first pass. Any future cross-language harness must
  avoid `JSON.parse` on the JS side or run under `--jitless`.

## Verdict: **not yet.** Four blockers, one of them a decision rather than a patch.

B1, B4, B5, B7 are fully closed with strong evidence. B6 is close enough to
ship. B2 and B3 are each half-closed, and in both cases the *normative text
being frozen now describes behavior the reference implementation does not
have* — which is the one class of defect a freeze makes permanent.

---

## Closed

### B1 · canonical JSON key ordering — VERIFIED-FIXED, provably backward-compatible

`src/protocol.ts:436-446` (`compareUnicodeCodePoints`), wired at `:454`.
16 830 adversarial objects (non-BMP, U+E000–U+FFFF, U+D7FF, combining marks,
NFC/NFD triples, empty key, keys differing only past a surrogate pair)
canonicalised by the compiled TS and by **real CPython**, compared as UTF-8
bytes:

```
compared=16830  agree=16830  rate=100.0000%  divergent=0
HEAD would have failed: objects=16830 changed=3945
```

Backward compatibility is provable, not just measured: default `.sort()` is
UTF-16 code-unit order, which coincides with code-point order on any
surrogate-free string. Measured anyway — 250 000 BMP-only-key objects: **0
changed**; golden fixture and all 7 base artifacts byte-identical HEAD vs
working tree. The new `non-bmp-key-order` vector genuinely flips
(`{"😀",…,""}` vs `{"",…,"😀"}`) and both implementations agree on
its preimage **and** digest. Collation is pinned normatively in RFC-008 §2.

### B7 · Python strictness parity — VERIFIED-FIXED

`_reject_unknown` now applied at all 14 sites including the top-level
`actions` loop, so the v1.0 shape (previously zero strictness) is covered:
**18/18 unknown-property probes agree, 9 of them on v1.0**. Null-vs-absent is
now `key in dict`: **12/12 probes agree**, including the previously
Python-accepted missing `level.result.stars`.

Differential campaign re-run against **real CPython**, 7 base artifacts
including a v1.0 artifact, 3 seeds × 45 007 mutations:

```
seed 24601: agree=44735 rate=99.396% classes=4
seed   777: agree=44733 rate=99.391% classes=4
seed 31337: agree=44727 rate=99.378% classes=4
   (prior review: 98.0%, 25 classes, all Python-accepting)
   excluding the B2 non-safe-integer injections: 99.96%
```

Two of the four remaining classes are B2. The other two share one root cause
(see N3/N4 below).

### B4 · deadline audit record — VERIFIED-FIXED

`session.ts:1250-1257` always constructs the `deadline` event first;
`validateDeadlineAudit` accepts `deadline → rejection`. Verified live: event
kept with `deadlineId`/`windowRef`/`participantId`, forced system action runs
on re-fire, artifact finalizes and rechecks, rehydration byte-identical.
Sub-item: `deadlineId` has no uniqueness constraint anywhere — committing the
same id twice is accepted and both survive as indistinguishable records.

### B5 · canonical event order — VERIFIED-FIXED

Both paths now emit `rejection, checkpoint`; projected `records[]` order
agrees; documented normatively.

### B6 · ingest error taxonomy — substantially fixed

`session.ts:14-15` exports `IntentCollectionError` + `IntentErrorCode`
(identity-checked against `./protocol`). **Both former bare-`TypeError` paths
are now typed**; the only two untyped paths left are *host callbacks throwing
their own errors*, not SDK paths. Arena can write one mapping table from
`./session` alone, `instanceof` + `.code`, no string matching.

Residual (non-blocking, worth a docs table): `SessionConflictErrorCode` is
only `'conflict' | 'unknown_submission'`, so seven distinct 400-class faults
are indistinguishable from the genuine 409.

---

## Blocking

### T1 · The B3 fix rejects honest kernel output (HIGH, one-line)

`replay-format.ts:1326-1333`. Deduping on `canonicalJson(attemptedReveal)` is
not a forgery signal: a seat resubmitting the *same* wrong reveal (distinct
submissionIds, forced by `historicalSubmissionKeys`) is ordinary client
behavior. The kernel accepts it, rehydrates identically, finalizes — and its
own verifier then rejects it:

```
two fumbles, SAME wrong payload (client resend)
  HONEST artifact -> ok=false
  problems :: ["commit-mismatch record 4 duplicates previously recorded evidence"]
  live===rehydrated :: true
```

This is the false-negative class the previous review warned about,
reintroduced as a false positive by its own fix. **Fix: drop
`seenMismatchEvidence`, keep `seenMismatchSubmissionIds`** — that set alone
already rejects the duplicated-record forgery (both problems fired
independently in the evidence).

### T2 · RFC-008 §2 freezes two rules the TypeScript implementation does not have

The normative sentence now reads: *"object keys sorted lexicographically by
Unicode code point…; no insignificant whitespace; non-finite **and
non-JavaScript-safe integer** numbers rejected"*, and §2 elsewhere claims
*"unpaired surrogates are rejected"*. `assertJsonValue`
(`src/protocol.ts:377-426`) checks only `Number.isFinite`, and neither
`canonicalJson` nor `canonical_json` rejects lone surrogates.

**(a) Integers.** Python now rejects non-safe integers (`replay.py:230-235`);
TypeScript silently rounds them. Over 120 000 fuzzed literals the *silent byte
divergence* is genuinely eliminated (**0 cases where both accept with
differing bytes**) — but it was replaced by a one-sided asymmetry, and TS
still corrupts producer data without a diagnostic:

```
{"v":33851962939837821} -> JS OK {"v":33851962939837820}   PY ERR "…JavaScript safe range"
JS accepts / PY rejects : 15835 / 120000       PY accepts / JS rejects : 0
end-to-end: TS serializes level.goal 9007199254740993 -> …992; Python then REJECTS the TS artifact
```

**Trap for the fix:** naively adding `Number.isSafeInteger` to TS would flip
the divergence — float-spelled `1e21`/`1e20` are Python-**accepted** with
matching bytes. The only symmetric options are (i) reject integer-valued
|v| ≥ 2^53 on **both** sides (Python must then also reject float `1e20`/`1e21`),
or (ii) route Python ints through the float renderer and drop the §2 clause.

**(b) Lone surrogates.** TS emits them; Python parses them and then
`serialize_replay_jsonl` produces a `str` that **cannot be UTF-8 encoded** —
an unhandled `UnicodeEncodeError`, not a `ReplayFormatError`, escaping the
documented contract. Enforce in both (`String.prototype.isWellFormed()` /
a surrogate scan in `_validate_json_value`) or drop the claim.

Either way: **the normative text and the reference implementation must agree
before the sentence is frozen.**

### T3 · Python's `bool` is an `int` (MEDIUM, two one-line guards)

`replay.py:373` (`level.get("index") != index`) and `:674`
(`record.get("n") != index`). `False == 0` and `True == 1`, so
`level.index: false` and `record.n: false`/`true` are Python-accepted and
TS-rejected — the only two non-B2 divergence classes left in 135 021
mutations. The JSON Schema sides with TypeScript. Fix: add `_is_int` guards.

### T4 · Decide what the audit lane *means* — a decision, not a patch

The verifier runs **post-session, out of band** (never during play; the
kernel never calls recheck). Its live counterparts — pre-reducer commitment
verification, `validateDeadlineAudit` — are sound. The problem is confined to
what a **forged artifact** can claim to a verifier that did not produce it.

Three rounds of patching this lane have each closed some holes and opened
others. That is a design signal, not an implementation one. The root cause is
structural: **the verifier reconstructs state by replaying recorded inputs,
and a rejected submission never becomes an input**, so nothing in the
reconstructible state constrains an audit record. Concretely, still accepted
today: `submissionId` bound to nothing (any string, including another seat's
real submission); `participantId` reattributable (`red`→`blue` re-verifies
against blue's commitment and reports "verified commit_mismatch: seat blue");
unbounded forged fumbles against an unrevealed commitment (50 injected →
`ok:true`); and silent deletion of every `commit-mismatch` or `deadline`
record (`ok:true`).

Internal-consistency checks (binding to real submission identities, mirroring
`validateDeadlineAudit` in the verifier) raise the bar from "append anything"
to "append something plausible" — they catch bugs, corruption, and lazy
tampering. **They do not authenticate.** A host that controls the artifact can
always construct a consistent story. Only per-submission signatures make the
lane host-independent, and that is a v0.20+ design (seat keys, scheme,
async-vs-sync placement).

**Decision taken (2026-07-25): authentication ships in v0.20 as RFC-010** —
per-submission client signatures over a per-seat hash chain. The v0.19
disposition below is therefore an **interim state with a known end date**,
not the permanent answer.

**Required for v0.19:**

1. **Declare the audit lane advisory**, exactly as `checkpoint.digest`
   already was — `commit-mismatch` and `deadline` records are host
   attestation; `ok` means "replay is consistent", not "the audit records
   are true". Say plainly that a leaderboard gate must not depend on
   unauthenticated records and that third parties should not read them as
   evidence *yet*, and reference RFC-010 as the closing move.
2. **Keep the cheap consistency checks** as bug detection (they catch host
   bugs, corruption, and lazy tampering — they do not authenticate).
3. **Reserve the integrity fields now — this is no longer optional.**
   With signatures landing one minor version later and the schema strictly
   rejecting unknown properties, reserving optional slots on session events,
   replay records, and the header roster (chain link, signature, seat public
   key) is what keeps RFC-010 an *additive* v1.2 change instead of a
   breaking v2. Reserve them unimplemented and unvalidated; RFC-010 gives
   them meaning.

**Hard dependency to record now:** RFC-010 signs over `canonicalJson` output,
so **T2 must be closed before signatures are designed, not just before they
ship**. Signing over a canonical form that differs across languages produces
signatures that verify in one implementation and fail in the other.

---

## Non-blocking

- `deadlineId` uniqueness is unenforced everywhere (kernel, live audit
  validation, portable verifier).
- `historicalSubmissionKeys` still unbounded (500 resolutions with
  `receiptRetention:2` → 1000 keys retained).
- `snapshot(seat)` with no watermark returns the entire rejection history,
  scanning `live.events` linearly — the reconnect payload grows with session
  length.
- Retrying a *rejected* submissionId reports `unknown_submission` / "receipt
  retention has expired" when nothing expired; lands on F2's documented retry
  loop. Wants a distinct `submission_consumed` code.
- Duplicate consecutive checkpoints on a rejection.
- `records` lost across serialize→parse when every record is `kind:'action'`.
- `noteSalt` runs before the `!seat` guard.
- `seedPolicy` guard is projection-only; a level plays fully mis-seeded before
  `finalizeRunReplay` complains.
- `validate_replay_artifact` raises `TypeError` (not a `ReplayFormatError`)
  for a non-hashable `kind` — the only exception site in 135 021 mutants,
  pre-existing at HEAD.
- Schema is now *stricter* than both validators in one case
  (`header.extensions: 0` — neither validator type-checks `extensions`), so
  the "schema never stricter" claim needs qualifying.

## Order of work

1. **T1** — one line; it currently fails honest artifacts.
2. **T2** — pick the symmetric option, then make text and both
   implementations agree. This is the one that the freeze makes permanent.
3. **T3** — two `_is_int` guards.
4. **T4** — write the advisory paragraph (marked interim, pointing at
   RFC-010) and reserve the integrity fields. Reservation is a freeze
   decision: it cannot be made after the tag without a breaking bump.
5. Tag, and start the migrations. RFC-010 (submission signatures + generic
   interest management) is the v0.20 headline; the migrations supply its
   client-side integration evidence.
