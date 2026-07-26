# Tag-gate review 3 — v0.19.0 (final)

Reviewed: `38225ae` ("Merge v0.19 tag-gate fixes"), working tree clean. Two
independent reviewers, repo untouched, everything compiled out-of-repo and
driven from standalone scripts against **real CPython** (`python/.venv`,
3.12.13). Health: `tsc --noEmit` clean · vitest **260 passed / 3 skipped** ·
pytest **64 passed / 4 skipped**.

Process note: the artifact was rewritten and self-committed *during* the
review. Both reviewers re-based on `38225ae` and re-ran; that commit is what
a tag would freeze, and it has been stable since. The findings below are
against it.

## Verdict

**All four tag-gate blockers (T1–T4) are verified closed, and the canonical
form is safe to freeze.** Six freeze-shaped items remain: two one-liners
(F1, F2), a reservation gap (F3), the `deadline`→`timeout` rename (F4,
wire format so now or never), host timestamps plus their reservation (F5),
and the mandatory `clientTime` decision (F6) — plus one live bug worth
fixing in the same pass.

---

## Verified closed

### T1 · commit-mismatch dedupe — both directions, after three revisions

`seenMismatchEvidence` is gone; only `seenMismatchSubmissionIds` remains
(`replay-format.ts:1236`, checked at `:1389-1397`). Salt reuse was demoted to
a **diagnostic** (`:1425-1428`), so it never flips `ok`.

Honest cases (real kernel sessions) — all `ok:true`, `problems: []`:
two and three fumbles with the *same* wrong payload under distinct
submissionIds; the same payload and commitment across different ticks; two
seats fumbling identical payloads (with and without a shared salt).
`live === rehydrated` throughout.

Forgeries — all still rejected: verbatim duplicate (same submissionId),
record moved after the successful reveal, `tick` rewritten, `commitmentId`
rewritten, record appended after the commitment was revealed.

The false-positive regression is fixed without reopening the false negatives
it was introduced to close. `submissionId` remains unbound, reattribution and
fabrication against an unrevealed commitment remain accepted, and deletion
remains silent — all four **as T4's advisory disposition says they must be**,
closable only by RFC-010.

### T2 · canonical form — symmetric, and the trap did not materialise

This is the foundation RFC-010 signs over, so it is the most consequential
green light.

**Integers.** They took the symmetric option: TypeScript gained
`Number.isSafeInteger` **and** Python gained the integer-valued-*float* rule
(`replay.py:277-280`), so `1e20`/`1e21` are rejected by both. The
opposite-direction asymmetry the review warned about — TS rejecting
float-spelled values Python accepts — **does not exist**.

```
120,000 fuzzed literals:  BOTH_OK_SAME 63291 · BOTH_REJECT 56709
                          JS_ACCEPT_PY_REJECT 0 · PY_ACCEPT_JS_REJECT 0
                          BOTH_OK_DIFFERENT_BYTES 0
end-to-end, level.goal = 9007199254740993:
  c48d67f  TS ACCEPTED, emitted …992 (silent corruption); PY then ACCEPTED it
  38225ae  TS REJECTED (typed) · PY REJECTED (typed)
```

**Unpaired surrogates.** Both reject, in values and in keys, nested at any
depth; valid pairs still accepted with identical bytes. The
`UnicodeEncodeError` escape is closed end-to-end — validation now fires
before serialisation, so Python "never reaches encode".

**Key ordering.** 100 % agreement over an adversarial corpus plus 20,000
fuzzed key sets (56 + 20,000 cases, compared as UTF-8 bytes). Worth
recording that this fix was catching a **live** bug, not a hypothetical one:
at `c48d67f` the new `non-bmp-key-order` vector produced a genuine
cross-language **digest divergence** (`85d605ea…` vs `bc9be31f…`).

**Freeze safety.** The only canonical-output change is TS key order, and only
for objects mixing non-BMP keys with U+E000–U+FFFF keys — exactly the
payloads that were already diverging. 49,569 ordinary BMP/safe-integer
objects: **0 changed**, both languages. Golden fixture and all four
commitment vectors (preimage *and* digest): unchanged, both languages, both
revisions.

**Mutation campaign.** 45,000 mutants across 7 real artifacts including a
v1.0 artifact: **98.66 %**, down from 4 divergence classes to 2. Both T2
classes are gone, and both survivors are **pre-existing** (verified by
replaying identical mutants through the pre-fix validators, where agreement
was 91.38 %) — the fix additionally **eliminated** a 3,318-case class.

### T3 · Python `bool` is `int` — fixed

`replay.py:441` and `:761` now guard with `_is_int`. Zero of the 454
remaining divergences involve a bool.

### T4 · advisory disposition and reserved slots

**Advisory** is stated normatively in four documents (RFC-008 §4 normative
body, `docs/mechanisms/replay.md`, `docs/session-and-integrity.md`,
`docs/releases.md`) with all three required properties: `ok` means replay
consistency and **not** record truth; a scoring gate MUST NOT depend on
unauthenticated v1.1 audit records; RFC-010 named as the closing move.

**Reservations** exist at all three layers (TS validator, JSON Schema,
Python) and were tested with 10 constructed v1.2-shaped artifacts:

| | TS validate | recheck | Schema | Python | round-trip |
|---|---|---|---|---|---|
| header roster + `signaturePolicy` | ACCEPT | ok | ACCEPT | ACCEPT | byte-identical |
| resolution-input `sig`/`prevChainHash` | ACCEPT | ok | ACCEPT | ACCEPT | byte-identical |
| commit-mismatch signed material | ACCEPT | ok | ACCEPT | ACCEPT | byte-identical |
| full RFC-010-shaped artifact | ACCEPT | ok | ACCEPT | ACCEPT | byte-identical |
| v1.0 header carrying a roster | REJECT | — | REJECT | REJECT | — |
| `sig` on a checkpoint / resolution record | REJECT | — | REJECT | REJECT | — |

**Answer to the critical question: strict unknown-property rejection does not
block a v1.2 producer** for anything RFC-010 §A7 enumerates. No reserved key
is emitted in any current artifact; decorating live events with reserved
fields changes no output byte.

### Regressions — 49/50 plus the full T2 battery

Prepared-transition lifecycle, commitment atomicity on rejection with
`live === rehydrated` on both the advance and deadline paths, F2 rejection
envelopes with exact pending-set reconstruction and no payload leak, S2
`viewRevision === cursor` at 9 observable states, checkpoint/summary/kernel/
rehydrated digest equality, state isolation for both reducer styles,
`finalizeRunReplay` 3-level run with byte-identical JSONL round trip,
crash-rehydrate at 11 boundaries, B4 deadline audit retention, B5 event-order
parity. Plus NIST SHA-256, commitment framing, all 35 dmath-1 vectors
bit-exact (`dmath.ts` diff is empty), v1.0 back-compat.

---

## Must land before the tag

### F1 · `abort()` throws after a failed `commit()` — one line

`src/session.ts:1328-1338` sets `completion = 'aborted'` *before* throwing
`stale`; `abort()` then rejects with `already_completed`. The canonical host
pattern double-throws:

```
commit threw :: stale             "prepared base revision 1 does not match live revision 2"
abort  threw :: already_completed "prepared transition was already aborted"
```

Both migrating teams will write `try commit / catch → abort` or a
`try/finally` wrapper. Make `abort()` idempotent when
`completion === 'aborted'` (keep throwing for `'committed'` and `'foreign'`).
This is a contract the tag freezes.

### F2 · `seats` name collision — one rename

`SessionHeader.seats: readonly string[]` (the live seat list, used by
`validateDeadlineAudit:1637`) versus `ReplayHeader.seats?:
ReplaySeatIntegrityReservation[]` (the RFC-010 key roster). Same name,
different type, different meaning. Rename the reservation (`seatKeys` /
`roster`) or the ambiguity is frozen.

### F3 · Reservation gaps for RFC-010 — see RFC-010 §A9c

1. **Tier-3 periodic signatures have no home.** They attach to no
   submission, and every plausible carrier is rejected today: a new
   `seat-signature` record kind, a top-level `signatures` key, a `header`
   field, a `sig` on a deadline record. Pick one and reserve it.
2. **`timeoutPolicy` on the header** plus a policy reference on the
   `deadline` record — required for the deadline-position checks that RFC-010
   §A9c.3 can otherwise not add additively.
3. **Correct the documentation claim.** The docs promise RFC-010 closes both
   the `commit-mismatch` and `deadline` lanes. Per RFC-010 §A9c that is
   imprecise: signatures close authorship in both lanes and, in ticks mode,
   constrain deadline position — but **wall-clock earliness stays outside
   artifact verification**, and in turns mode positional checks degrade.
   Two teams read the v0.19 wording before v0.20 ships, so the correction
   belongs in this freeze.

### F4 · Rename `deadline` → `timeout` — wire format, so now or never

Decided 2026-07-25; rationale and the full table in RFC-010 §A9d.
`deadline` reads as a **game concept**, while the mechanism is narrower: the
host substitutes an input for a seat that did not respond. RFC-006’s
`durations` is the turn-counted game-rule mechanism; conflating them would
implement a rule as infrastructure. `timeout` is the right width — a broader
name like `forcedInput` invites the opposite misuse (scripted NPC moves,
admin actions).

Renames: `prepareDeadline`→`prepareTimeout`, `DeadlineInput`/`deadlineId`
→`TimeoutInput`/`timeoutId`, SessionEvent and replay record kind
`deadline`→`timeout`, `cause: 'deadline'`→`'timeout'`,
`validateDeadlineAudit`→`validateTimeoutAudit`, plus a new
`reason: 'elapsed' | 'disconnect' | <product>` field.

The record kind and the `cause` value are **wire format**: renaming after
the tag is a `gaos.replay` v2 break. This is the largest pre-tag change
(TypeScript, Python, JSON Schema, docs, tests) and needs a full regression
run — but the alternative is freezing a name that misleads every reader for
the life of v1.

### F5 · `hostTime` on session events + an advisory time reservation

RFC-010 §A9e. Add `hostTime` (UTC ms) to `SessionEvent` — host-side, not
wire format, near-zero cost, and it is what operations actually needs
(correlating the transcript with host logs by `eventId`). **Reserve** an
advisory time slot on replay records; do not emit it (projection opt-in via
`FinalizeOptions`, off by default — the host already owns its clock).

Four constraints, all contractual: never a reducer input; never inside a
signature preimage or any canonical byte comparison used for equivalence;
ignored entirely by replay verification; documented advisory in the same
terms as `checkpoint.digest`.

⚠️ Knock-on for the migrating teams: `live === rehydrated` compares
canonical transcript bytes. Rehydration reproduces `hostTime` (it is
recorded), but **any assertion of the form “replaying these inputs yields
this transcript” must exclude it**. Write it into the contract or both
consumers will trip over it.

### F6 · Mandatory `clientTime` in the RFC-010 envelope

RFC-010 §A5.2. Not a v0.19 code change, but a **v0.19 reservation and
documentation** decision: the signing preimage carries a required
`clientTime`, because an *optional* evidence field is a downgrade vector — a
colluding or lazy host requests submissions without timestamps and the
evidence vanishes silently. Mandatory means the only way to have no
timestamp is to have no signature, which is already visible as
`partial`/`unsigned`.

Recorded but never validated for correctness (client clocks are wrong;
rejecting on implausible absolute time would lock out players). Its use is
cross-seat relative intervals, which upgrades RFC-010 §A9c.4 from
“unclosable” to “bounded weak evidence”. Still weak by construction:
clients can misreport, and a colluding client removes the constraint.

---

## Should fix in the same pass (not freeze-shaped)

- **Python error strings can embed a raw lone surrogate**
  (`replay.py:574, 582, 763, 771, 779`). The artifact is correctly rejected,
  but the resulting message cannot be UTF-8 encoded — the same
  `UnicodeEncodeError` class T2(b) just closed, relocated to the error
  reporter. Any service logging `problems` as UTF-8 JSON raises. Use
  `!r`/`ascii()` or omit the value.
- **`_is_int` rejects integer-valued floats** (`replay.py:48`): JSON `0.0`
  is Python-rejected and TS-accepted (454/45,000 mutants). Pre-existing, and
  *widened by one field* by the T3 fix. **Not a canonical-form defect** —
  both sides canonicalise `0.0 → 0` identically, so it cannot produce
  divergent RFC-010 signatures; it produces divergent accept/reject. Align
  with `_validate_json_value:277`, which already accepts `1.0`.
- **`validate_replay_artifact` raises bare `TypeError`** for a non-hashable
  `kind` (`replay.py:779`, 149/45,000) instead of `ReplayFormatError`.
- **`prepareIngest(null)`** escapes as a bare `TypeError`; every other
  malformed shape is now correctly typed. Arena's mapping table needs a
  documented fallback, or guard with `isRecord(submission)`.
- **JSON Schema is stricter than both validators on `extensions`** at four
  slots (header, totals, each level, each level result) — not only
  `header.extensions` as previously documented.
- Error-message asymmetry: TS says "integer numbers must be…", Python says
  "integers must be…" for `int`. Breaks cross-language problem-list
  comparison.

## Carried forward, unchanged (advisory-covered or non-blocking)

`deadlineId` uniqueness unenforced; `snapshot(seat)` without a watermark
returns the whole rejection history; `historicalSubmissionKeys` unbounded and
reports "receipt retention has expired" for a *consumed* id; the portable
verifier performs no deadline-audit validation; `validateDeadlineAudit`
accepts a reattributed coincident rejection; live-lane RFC-010 reservations
are not projected into the portable slots (zero plumbing — note it in
RFC-010 §A7 so it is not discovered late).

## Migration note for the release announcement

`finalizeRunReplay` now **requires** every level transcript to declare
`seedPolicy: 'explicit'` (`src/session.ts:1825-1829`). `c48d67f` accepted
`'gaos.run-level-seed.v1'`. This is the intended S3 fix, but it breaks any
host that constructs run-level kernels with the derived policy — call it out
explicitly.

## Order

1. F1, F2 — two one-liners.
1b. F4 — the rename; largest change, needs a full regression run.
2. F3 — reservations plus the documentation correction; only doable at the
   freeze.
3. The Python surrogate-in-message fix (a live bug for anyone logging
   problems).
4. Tag `v0.19.0`, announce the `seedPolicy` change, start the migrations.
