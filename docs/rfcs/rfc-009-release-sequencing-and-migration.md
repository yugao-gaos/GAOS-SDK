# RFC-009 — Release sequencing: what v0.19 must contain so the migrations can happen

Status: **implemented and released — `v0.19.0`, annotated, on `origin`, pointing at `5ddd404`** · Target: scopes v0.19 (final) and v0.20 · Breaking: no

> **Correction (2026-07-26).** An earlier revision of this section claimed
> v0.19 was never tagged and instructed consumers to pin a commit instead.
> **That was wrong** — the tag exists and is annotated. The claim was raised
> by the TabletopLabs migration ([RFC-010 §D4](rfc-010-submission-signatures-and-interest.md))
> and verified against `origin` before being reverted here. **v0.19.0 is a
> real release; pin the tag.**

Current disposition: all v0.19 release gates in §2 are implemented.
`finalizeRunReplay` supplies derived-seed multi-level projection;
`ObservationDelta.acknowledgements` and `.rejections` freeze the reconciliation
identity/order contract with durable transition-watermark recovery; the public
session guide contains the normative host sequence and
crash/ownership rules; v1.1 audit records are explicitly advisory host
attestation with additive RFC-010 integrity slots reserved; and N1–N5 plus
their evidence suites are closed. The final freeze also adopts the
`timeout` API/wire vocabulary, an explicit host clock-or-`'none'` policy with
optional advisory session `hostTime`, and additive RFC-010 `seatKeys`,
`clientTime`, timeout-policy, and periodic-signature reservations.

## 1. Problem

The two consumer migrations are **not** done by the SDK maintainer. Arena
(`agilabs-arena`, pinned at SDK v0.12) and TabletopLabs (on v0.18, no kernel
adoption) are migrated by their own product agents, against a **published
tag**. That inverts the usual ordering question:

> The SDK cannot learn what the consumers need before they migrate, and the
> consumers cannot migrate before the SDK publishes.

The resolution rule this RFC adopts:

**v0.19 must contain everything the migrations *touch*. v0.20 contains what
the migrations *teach*.**

Anything a migrating consumer must build for itself because the SDK lacks it
is a semantics fork — precisely the failure mode RFC-006 exists to prevent
("duplicating it per product would let transcript semantics drift, which
silently breaks cross-product `gaos.replay` verification").

## 2. Pre-implementation blocking analysis

### 2.1 Arena — resolved by multi-level run composition

Arena's scored sessions are **runs**: `init.levels` in the transcript header,
level-to-level advancement (`level_advance`), `recheckRunTranscript`, and
per-level seeds via `runLevelSeed(seed, i)`. Its leaderboard, benchmark, and
paid-board rows are all gated on run recheck.

Before RFC-009, the v0.19 kernel could not express this:

- `finalizeReplay` hardcodes `levelIndex: 0` on every emitted record
  (`src/session.ts:1366, 1378, 1386, 1394, 1402, 1445`);
- the level seed is derived at index 0 only (`src/session.ts:457`);
- the produced artifact always has exactly one level entry.

The replay **format** already supports runs (`ReplayHeader.levels` is an
array, `recheckReplayArtifact` iterates `ReplayLevelRecheck[]`), and RFC-006
§D answer 3 promised "multi-level runs are host composition: N transcripts,
one run-header replay assembled by `finalizeReplay` overloads" — the
composition API did not yet exist.

Consequence if unshipped: Arena hand-writes run assembly (level indexing,
per-level seed derivation, totals, terminal semantics across levels) — the
exact drift risk the kernel was extracted to eliminate, in the consumer whose
proven implementation the kernel was extracted *from*.

**→ Move to v0.19: `finalizeRunReplay(transcripts, options)`** (or a
`finalizeReplay` overload accepting an ordered transcript list) that assigns
`levelIndex` per segment, derives each level seed via `runLevelSeed(runSeed,
i)`, aggregates `ReplayTotals`, and enforces run-terminal semantics. The
kernel stays one-instance-per-level (RFC-006 §D answer 3 unchanged); only the
**projection** learns about runs.

Implemented as `finalizeRunReplay`; its derived-seed, global numbering,
aggregate-total, terminal-order, and whole-run recheck tests are release gates.

### 2.2 TabletopLabs — resolved by the acknowledgement identity/order contract

TTL's server-authoritative mode is: headless DO peer runs the kernel in ticks
mode; clients predict locally and reconcile against per-seat
`ObservationDelta` streams using their existing COW rollback.

`PredictionSession` itself is correctly deferred to v0.20. RFC-006 rev 7
stated the prerequisite: *"the v0.20 design must add an acknowledgement
identity/order contract to `ObservationDelta` (or to a paired authoritative
response) before freezing the construction, rollback, and pending-action
APIs."*

That contract is exactly what a hand-rolled reconcile needs. Without it TTL
must invent its own answer to "which of my pending inputs does this delta
already include, and in what order were they applied" — and when v0.20
freezes a different answer, TTL rewrites reconciliation and every replay it
recorded in between is interpreted differently.

**→ Move to v0.19: the acknowledgement contract only** — per-delta
acknowledgement of `(participantId, submissionId)` accepted through the
delta's `viewRevision`, plus the ordering rule for pending-input replay.
This is additive to `ObservationDelta`, needs no client class, and is the
piece that must be stable *before* anyone writes reconcile code.
`PredictionSession` (the class) stays in v0.20 — see §3.1 for why that is now
an advantage rather than a concession.

Implemented as `ObservationDelta.acknowledgements` plus rejection-only
observation envelopes. RFC-006 rev 10 freezes identity semantics, transition
watermarks, snapshot recovery, and pending replay order.

### 2.3 Both — host obligations must be normative in v0.19

The prepare → **persist** → commit → send discipline (and `abort` on
persistence failure, exactly-once completion) took five review rounds to pin
down and is subtle enough that both hosts will get it wrong unsupervised.
The full **reference adapter + conformance kit** belongs in v0.20 (§3.2), but
v0.19 must ship the obligations as normative prose plus a worked example in
`docs/session-and-integrity.md`: ordering, event-id idempotency, crash
recovery via `rehydrateKernel`, and the `discard`/`retire` ownership rules.

Implemented in the public session guide, including a worked
prepare → persist → commit → publish function and all three crash boundaries.

### 2.4 Both — the v0.19 correctness fixes are migration prerequisites

From `implementation-review-v019-round2.md`:

- **N1/N2 dmath range reduction** is not optional for TTL: its quaternion
  path uses snap angles (60°/90°/180°) — i.e. exactly the multiples of π/2
  where the shipped implementation is ~2.9×10⁵ ulp wrong. Fix the numerics
  and regenerate the fixtures **before** the tag, or the first consumer
  adopts a broken algorithm under a frozen id.
- **N3**: declare `dmath-1` unreleased until the v0.19 tag, so the
  append-only rule starts clean at the tag rather than mid-development.
- **N4** (terminal guard vs receipt idempotency) breaks at-least-once
  transports — both hosts have one.
- **N5** (`deepFreeze` unbounded recursion) is reachable from any
  `commandToAction`.

All five fixes and their regression/evidence suites are closed before the
first `dmath-1` freeze.

## 3. What stays in v0.20 — and why deferral is now correct

### 3.1 `PredictionSession`, extracted rather than designed

The session kernel earned its shape by being extracted from Arena's
production `session-do`, not designed in the abstract. `PredictionSession`
deserves the same discipline: let TTL hand-roll reconcile against the stable
v0.19 acknowledgement contract, then extract the class from a working
implementation. Arena, being turn-paced and server-authoritative, needs no
prediction at all — so TTL is the only source of truth for this API, and
designing it before TTL has run it would be guessing.

### 3.2 Reference host adapter + host conformance kit

Informed by two real migrations rather than by imagination. Third-party
hosts get "prove your host is correct" as a runnable suite — the piece that
makes *"any game can be an arena"* a batteries-included claim.

### 3.3 Observation codec v2 (patch codec) — validate the need during migration

The v1 codec is snapshot-only by review decision. At TTL's tick cadence this
means one full per-seat view per seat per tick (20–30/s). **The migration
should measure this early**; if snapshot cost is prohibitive, the patch codec
(RFC-006 §D4, already designated future work: canonical diff ordering, JSON
Pointer escaping, array semantics, codec versioning, size bounds) becomes the
headline v0.20 item. Do not pre-build it — measure first.

> **Answered (2026-07-26).** TabletopLabs measured it — see
> [RFC-010 §E2](rfc-010-submission-signatures-and-interest.md). At 200
> entities (an ordinary board-game table, not a stress case) a 20 Hz session
> costs 3.86 MiB/s of egress for four seats, and the cost scales with **table
> size** while the actual per-tick delta scales with **activity**. The two
> diverge without bound. §3.3 resolves **in favour of building the patch
> codec** in v0.20.

### 3.4 Also v0.20

- the "one complete path" reference project (existing roadmap top item);
- WASM dmath backend — **still evidence-gated, and now additionally gated on
  N1**: porting the current algorithm would freeze the π/2 defect into two
  backends under a bit-identity claim;
- no timeout naming migration remains: v0.19 freezes `prepareTimeout`,
  `TimeoutInput`, `timeoutId`, record/event kind `timeout`, and resolution
  cause `timeout`.

## 4. Mechanics

**How consumers pin.** `v0.19.0` is annotated, on `origin`, and points at
`5ddd404` — the commit where the contract froze. Pin the **tag**. TabletopLabs
consumes the SDK as an npm `github:` dependency
(`github:yugao-gaos/GAOS-TurnBasedGrid-SDK#v0.19.0`); Arena pins the same tag.
Neither consumes it as a git submodule.

> **npm gotcha, reported by the TabletopLabs migration.** Editing the version
> in `package.json` is *not* sufficient to move the pin: `npm install` reports
> "up to date" and keeps the SHA already resolved in the lockfile.
> Re-resolution must be forced with an explicit spec.

The pin's integrity is mechanically checkable, and a migrating agent should
check rather than trust this paragraph:

```bash
git diff --name-only 5ddd404..<your-pin> -- src python schema   # must be empty
```

Anything printed means the contract moved. **The freeze is the load-bearing
rule here, not the tag** — if the contract moves under two mid-flight
migrations, both rewrite. A patch that legitimately uses the additive-optional
exception (§4.3) will print, which is exactly why such a release must be
announced rather than discovered.

1. **Tag v0.19.0** once §2 items land (run composition, ack contract, host
   obligations doc, N1–N5). Done — `5ddd404`. This is the migration baseline.
2. **Both migrations start on the tag**, independently, by their own agents.
3. **Feedback classification** during migration:
   - *bug or missing detail in a shipped contract* → **v0.19.x patch**,
     strictly additive/non-breaking, released and **announced** so the other
     migration re-pins deliberately rather than discovering the change;
   - *contract shape is wrong* → **v0.20**, never a v0.19.x reshape — both
     consumers are mid-flight against the tag and a moving contract doubles
     their work;
   - *product-side only* → stays in the product.

   Both migrations have now returned findings under this rule; they are
   consolidated in [RFC-010 Part D and Part E](rfc-010-submission-signatures-and-interest.md).
4. **Freeze during migration:** no changes to `SessionKernel`,
   `SessionEvent`, `ObservationDelta`, or the `gaos.replay` v1.1 schema in
   v0.19.x. Additive optional fields are the only exception, and only when a
   migration is blocked without them — RFC-010 §D1–§D3 are the exercised
   cases.
5. **v0.20 opens when both migrations are functionally complete** — not when
   they are perfect. Its scope is then written *from* their findings plus
   §3, and PredictionSession/adapter/codec decisions are made with evidence.

## 5. Answering the sequencing question directly

- **Can the migrations be done on v0.19 alone?** Yes — *after* §2.1 (run
  composition), §2.2 (acknowledgement contract), §2.3 (host obligations
  doc), and §2.4 (the correctness fixes) land in v0.19. Without §2.1 Arena
  is blocked outright; without §2.2 TTL builds reconcile against an
  unpinned contract and rewrites it in v0.20.
- **Is v0.20 ready once the migrations finish?** Its *content* becomes
  decidable, not automatically done. Most of v0.20 is deliberately
  migration-informed (PredictionSession extraction, conformance kit, codec
  decision), so "migrations complete" is the gate that lets v0.20 be scoped
  honestly — followed by the work itself.
- **What is in v0.20?** [RFC-010](rfc-010-submission-signatures-and-interest.md)
  is now the v0.20 document: Part A (signatures) and Part B (interest), plus
  Part E, the migration-derived scope both consumers returned. Part A has
  **zero migration dependency** and is therefore built *in parallel with* the
  migrations rather than after them.
- **What lands before v0.20?** The v0.19.x additive patches in RFC-010 Part D
  — two of them are migration-blocking, so they do not wait.

The cross-language commitment framing checks, deeper crash/delta gates, and
JSC/SpiderMonkey/workerd matrix originally listed here were accelerated into
v0.19 because the final implementation review made them release evidence.

## 6. Decisions

1. `finalizeRunReplay` requires the run seed and rejects any transcript whose
   source header does not use `seedPolicy: 'explicit'` or whose recorded
   per-level seed differs from `runLevelSeed(runSeed, index)`.
2. Acknowledgements live directly on `ObservationDelta` and are ordered
   exactly like the applied reducer input batch. Rejections use the same
   observation stream and are resumable by durable transition watermark.
3. Publish `0.19.0` directly; migration-blocking additive fixes use `0.19.x`.
4. The v0.19 wire vocabulary is `timeout`; `deadline` is not a compatibility
   alias because no tag shipped the superseded spelling.
