# Tag-gate review 4 — v0.19.0 (F1–F6 verification, final)

Reviewed: `6f2cd9b` ("Close v0.19 final tag gate"), tree clean. Two
independent reviewers, repo untouched, compiled out-of-repo, driven against
**real CPython** (`python/.venv` 3.12.13). Health: `tsc --noEmit` clean ·
vitest **260 passed / 3 skipped** · pytest **66 passed / 4 skipped**.

## Verdict

**All six freeze items (F1–F6) are verified. One blocker remains — found
independently by both reviewers — plus F7, agreed separately.** Fix those and
tag.

---

## Verified

**F1 · `abort()` idempotency.** `session.ts:1429-1434` returns silently when
already aborted; still throws for `'committed'` and `'foreign'`. Cleanup runs
exactly once across repeated aborts (discard counts held at 1). RFC-006 §K
updated to match.

**F2 · `seats` collision.** Reservation renamed to **`seatKeys`**, agreed in
TS (`replay-format.ts:122`), JSON Schema (`:183`) and Python (`replay.py:366`).
The old `header.seats` is now rejected by all three. `SessionHeader.seats`
remains the only `seats` in the session surface.

**F3(a) · tier-3 signature carrier.** Reserved as a new record kind
**`seat-signature`**, declared in all three layers and ignored by
`projectRecordActions`, so it is additive to the `actions ≡ projection(records)`
invariant. Proven with artifacts carrying signatures attached to no
submission: TS accept, byte-identical round trip, `recheck ok:true`, Python
accept, Schema accept. Every previously-rejected carrier is still rejected
(sig on checkpoint/resolution/timeout records, top-level `signatures`,
`header.signatures`).

**F3(b) · `timeoutPolicy`.** Better than reserved — it is live-projected.
`SessionKernelOptions.timeoutPolicy` is validated at construction,
`prepareTimeout` accepts `timeoutPolicyRef`, and both finalizers emit them.
v1.0 artifacts carrying it are rejected at all three layers.

**F3(c) · documentation correction.** All four documents now state the
precise claim: RFC-010 *authenticates authorship in both lanes* and can
constrain timeout position in ticks mode; wall-clock earliness stays outside
artifact verification; turns-mode positional checks degrade.

**F4 · `deadline` → `timeout`.** Complete, with no half-rename: API,
SessionEvent kind, record kind, `cause`, `validateTimeoutAudit`, plus the new
`reason` field (any non-empty string; `'elapsed'`/`'disconnect'` are
convention, not an enum, at every layer). Old names are now rejected
**symmetrically** — a genuine `38225ae`-produced artifact fed to HEAD
produces identical problem strings from TS and Python, and fails the schema.

Byte impact measured across six real sessions built from identical inputs on
both builds: plain, commit/reveal-with-fumble, extension, and the 3-level run
are **byte-identical**; only the timeout-containing artifacts differ. Note the
timeout record was **structurally reshaped**, not merely renamed — the old
composite `reason: "turn-0:blue"` is decomposed into `timeoutId` +
`participantId` + `reason`, with `windowRef` added. That is the improvement
RFC-010 §A9c.5 asked for, but it is a larger wire change than the item title
suggested.

**F5 · `hostTime`.** On every `SessionEvent`; never reaches the reducer
(instrumented and confirmed); excluded from canonical bytes and not projected
unless `includeHostTime`; replay ignores it (rewriting every value to `1`
still rechecks `ok:true`); `live === rehydrated` holds with and without
stripping it. Shipped tests correctly split: input→transcript assertions use
`withoutHostTimes`, pure rehydration equality includes it.

**F6 · mandatory `clientTime`.** RFC-010 §A5.2 states every required
property (mandatory in the preimage, downgrade-vector rationale,
recorded-never-validated, scoped to signed submissions, UTC ms, privacy
note), and §A7 closes the loop. Reserved at all three layers on actions,
resolution inputs, `systemInput`, `commit-mismatch`, and `seat-signature`.
Bonus: the "zero plumbing" item is now closed for `clientTime`/
`prevChainHash`/`sig` — they flow live→portable end to end.

**Cross-language parity: 99.9909 %** (was 98.66 %). 87,810 mutants over seven
real artifacts including a v1.0 artifact and a fully reservation-decorated
one, real CPython vs the TS validator, with `--jitless` consensus. Both
previously-known divergence classes are gone (`_is_int` integer-valued
floats; bare `TypeError` on a non-hashable `kind`). One class remains — D1.

**Canonical form: byte-identical to `38225ae` in both languages.** 4,502-case
probe (integers incl. the float-spelled `1e20`/`1e21` trap, surrogates in
values/keys/nested, 4,466 key-ordering cases): `HEAD-TS === BASE-TS` 4502/4502,
`HEAD-TS === HEAD-PY` 4502/4502. Golden fixture and all four commitment
vectors unchanged, both languages; the `non-bmp-key-order` digest that
diverged at `c48d67f` is now `85d605ea…` in both.

**Previously-flagged bugs closed.** The Python lone-surrogate error-message
bug (52,824 artifacts validated, 0 unencodable strings, 0 throws);
`prepareIngest(null)` now typed; JSON Schema `extensions` drift fixed at all
four slots (24/24 agreement).

---

## Blocking

### D1 · `timeout.participantId`: required in TS + Schema, optional in Python

**Found independently by both reviewers.** Introduced by the F4 rename, on a
wire-format record this tag freezes.

```
same artifact, participantId key deleted from the timeout record:
  TS     : ["timeout 0 participantId must be null or a non-empty string"]
  Schema : REJECT (required: participantId)
  Python : []            ← ACCEPTS
```

`python/agilabs_arena/replay.py:951-957` uses `record.get("participantId")`,
which collapses *absent* and explicit `null` into `None`. TS
(`replay-format.ts:1198`) rejects `undefined`; the schema lists the field as
required.

This matters beyond the asymmetry: RFC-010 §A9c.2's misattribution argument
depends on a timeout **naming a seat**. A Python-side verifier (Arena) would
accept a timeout record that omits it.

```python
if "participantId" not in record:
    problems.append(f"timeout {index} participantId must be null or a non-empty string")
else:
    participant_id = record["participantId"]
    if participant_id is not None and (not isinstance(participant_id, str) or not participant_id):
        problems.append(...)
```

### F7 · `hostTime` must not default to `Date.now()` (agreed separately)

`src/session.ts:669` is `this.options.hostTime?.() ?? Date.now()`, which
contradicts RFC-006 §2's own normative text: *"The kernel never owns:
sockets/HTTP, storage, **wall clocks**."* It is the single place where the
kernel reaches into the environment, and it silently gives a host that
configures no clock a non-reproducible transcript.

Adopted design — make the choice explicit, allow "no clock":

```ts
hostTime: (() => number) | 'none'    // required, no default
```

Production hosts write `() => Date.now()` (which **is** UTC epoch ms —
`Date.now()` is timezone-independent by definition; there is no
`Date.utcNow()`). Deterministic contexts write `'none'`, omitting the field
entirely so transcripts are byte-reproducible from (seed, inputs). No
`Date.now()` remains inside the kernel.

Ship with it:

1. The option's doc comment states **UTC epoch milliseconds** normatively and
   names `performance.now()` as the wrong answer (monotonic, not epoch).
2. **Timestamps are never used for ordering** — `Date.now()` is not
   monotonic (NTP or manual adjustment moves it backwards). Ordering is
   `tick` / `cursor` / `transitionRevision`. Without this stated, someone
   will sort by `hostTime` and it will work until the first clock correction.
3. RFC-010 §A5.2 gains: `clientTime` and `hostTime` share an epoch, so they
   are mutually checkable — clock-skew detection and network-delay bounds,
   a small strengthening of §A9c.4.
4. Optional: a **diagnostic** (not a rejection) for values that are
   implausible as epoch ms — cheaply catches the `performance.now()` mistake
   without blocking test fixtures that use small constants.

`SessionKernelOptions` is a TypeScript type, not wire format, so this is a
source-level break — and there are **zero consumers today**. After the tag
both teams have written kernel construction code and both pay.

D5 reinforces it: a provider returning `null`/`undefined` also silently falls
back to the wall clock, so "clock unavailable" currently becomes "use the
wall clock".

---

## Should land in the same pass

- **D3 · `prepareExtension` accepts a non-object `record`** (`session.ts:1374-1397`
  validates `lane` only). The transition commits live, and then
  `finalizeReplay` throws `extension 0 record must be a JSON object` — **the
  entire run becomes unprojectable**. A data-loss shape; pre-existing, but
  one `isRecord` guard.
- **D2 · `prepareTimeout` escapes as a bare `TypeError`** for a null/undefined
  `timeout` or `forcedInput`, inconsistent with the `prepareIngest` hardening
  landed in this same pass — on a brand-new API two teams will build against.
  `finalizeReplay(null, …)` / `finalizeRunReplay(null, …)` are the same class.
- **D4 · `rehydrateKernel(options, null)` silently returns a fresh kernel**
  instead of throwing. `rehydrateKernel(opts, await load(id))` with a missing
  record silently starts a new session at revision 0.
- **`ReplaySeatIntegrityReservation` is not re-exported from `./engine`** —
  it is the element type of the freshly renamed `ReplayHeader.seatKeys`, so
  an RFC-010 v1.2 producer cannot name it from the public entry point. The
  reservation is only half-usable without it.
- **RFC-006 §L contradicts §K and the shipped behaviour**, still listing
  "double abort" among the throwing cases. A migrating team reading §L will
  code for an exception that never comes.

## Release-note items (both are migration hazards)

1. **`SessionEventBase.hostTime` is now required.** `rehydrateKernel` throws
   for any event lacking it, so **every persisted pre-v0.19 transcript is
   unrehydratable**. Not currently in `docs/releases.md` alongside the
   `seedPolicy: 'explicit'` note.
2. **`abort()` is now idempotent** after an automatic or explicit abort — a
   contract change this tag freezes, absent from the release notes.

## Carried to v0.20 (not freeze-blocking)

- No live-lane `seat-signature` `SessionEvent` kind yet; the portable carrier
  is reserved and provably sufficient, and `SessionEvent` is host-side, so
  v0.20 adds it additively.
- `replayInput` still does not project `submissionId` / `canonicalCommand` /
  `cursor` (`session.ts:1683`), so a v1.2 verifier cannot yet reconstruct the
  §A5 preimage from a kernel artifact. Slots exist; plumbing is v0.20.
- RFC-010 §A9c.3 spells the policy `{ mode:'ticks', windowTicks: N }` while
  the SDK's test emits `{ mode:'ticks', maxTicks: 90 }`. The slot is an
  opaque `JsonObject` at every layer so nothing is frozen — reconcile before
  v0.20 defines semantics.
- `try/finally { abort() }` after a *successful* commit still throws
  `already_completed`, masking the original outcome in the `finally`. Worth
  a sentence in the session guide, which currently demonstrates only the
  persist-failure shape.
- Doc prose still says "deadline" where it now means the renamed mechanism:
  `appendix-a-coverage-and-high-frequency.md:115,129,229`,
  `rfc-004-zones-and-card-play.md:119`, `high-frequency.md:35,88`.

## Order

1. **D1** — one condition; blocks the freeze.
2. **F7** — the option change plus its three documentation clauses.
3. D3, D2, D4, the `ReplaySeatIntegrityReservation` export, the RFC-006 §L
   correction.
4. Both release-note items.
5. Tag `v0.19.0`; start the migrations.

---

# Re-gate (verified at `3064f1f`)

`tsc --noEmit` clean · vitest 262 passed / 3 skipped · pytest 67 passed / 4
skipped. Canonical form provably untouched: `src/protocol.ts`, the JSON
Schema, and both fixture sets are **identical** `e22ec4b..HEAD`; the only
changed sources are `src/session.ts`, one re-export line in
`src/engine/index.ts`, and the six-line D1 hunk in `replay.py`. Empirically
23/23 byte-identical TS vs real CPython (integers incl. the `1e20`/`1e21`
trap, surrogates in values and keys, code-point ordering across the
surrogate boundary `{"￿":1,"𐀀":3,"😀":2}`), golden fixture and all four
commitment vectors matching in both languages.

## Closed

**D1** — tri-layer agreement on a real `prepareTimeout` artifact: absent
rejected by TS, Schema and Python with the *identical* message; explicit
`null` accepted by all three; empty/non-string rejected. Differential
campaign over 25,200 mutants and 7 corpora: **100.000000 % verdict
agreement, zero divergence classes** (was 99.9909 %). Remaining differences
are message text only (10.4 %), never accept/reject.

**F7** (a)–(g) — required at type and runtime with no silent default;
`'none'` omits the field and makes transcripts byte-reproducible across runs;
provider values validated; **D5 closed** (`() => null`/`undefined` now throw
instead of falling back to the wall clock); **no `Date.now()` left in
executable code**; `live === rehydrated` under both policies; docs carry all
three clauses including *"Never sort by `hostTime`… durable ordering is
`tick`, `cursor`, then `transitionRevision`."*

**D2, D3**, and the `ReplaySeatIntegrityReservation` re-export. Full
regression battery green across 50 checks, including F1 abort idempotency
after a *failed* commit, P0-1 atomicity on both paths, watermark rejection
recovery with no payload leak, four-way checkpoint digest equality, both
reducer styles, run replay with `seedPolicy` enforcement, crash-rehydrate at
every boundary, and the T1 honest-vs-forged matrix.

**Release notes: 3 of 4 present, and the fourth is correctly obsolete.** F7
made `SessionEventBase.hostTime` *optional* and rehydration accepts
timestamp-free events, so "pre-v0.19 transcripts are unrehydratable" no
longer exists — verified empirically. The fix removed the migration hazard
rather than documenting it.

## Remaining — three one-line guards, all the same class

Unvalidated input on public entry points; the pass hardened `prepareIngest`,
`prepareTimeout` and `prepareExtension` but left three siblings.

1. **N1 · `rehydrateKernel(options, undefined)` silently returns a fresh
   kernel** (`src/session.ts:614`). D4 was fixed for `null` only, and
   `undefined` is the *more* common store-miss value —
   `Map.get(miss)`, `await load(id)`. A host resuming a session it failed to
   load silently starts a new one at revision 0. Guard in `rehydrateKernel`
   itself (`:1707`), leaving the constructor's optional path for
   `createSessionKernel`. **Severity: medium-high — silent data loss.**
2. **N2 · `finalizeRunReplay` validates the array but not its elements**
   (`:1958-1963`): `[null]` → `Cannot read properties of null (reading
   'header')`, `['x']` → an error naming the *wrong* property.
3. **N3 · Kernel constructors unguarded against a bad `options`**
   (`:517`): `createSessionKernel(null)` → `Cannot read properties of null
   (reading 'seed')`; `[]`/`'x'` → a misleading `RangeError: seed must be an
   unsigned 32-bit integer`. This is the **first call every migrating team
   makes**.

Trivial: `docs/releases.md:60-62` says timestamp-free events rehydrate "with
`hostTime: 'none'`" — they rehydrate under *any* policy (`hostTime` is not in
the header). Drop the qualifier.

**Verdict: hold for the three guards, then tag.** Both actual blockers are
closed and the format is frozen-clean; what remains is one class of
one-liners on the entry points the migrations touch first.
