# RFC-011 — Arena migration findings against the baseline

Status: **proposed — raised by the Arena migration (2026-07-26)** · Target:
F1 additive on the baseline line then an announced re-pin; F2/F3 v0.20 ·
Breaking: no · Depends on: RFC-006, RFC-009

> RFC-009 §5 defines v0.20 as *what the migrations teach*. This is the Arena
> migration's return channel. Each finding below states which RFC-009 §3 class
> it falls into, because that decides whether it lands on the baseline line or
> waits for v0.20.
>
> Findings are recorded here rather than patched directly: the baseline is
> pinned by two mid-flight migrations, so the SDK maintainer owns the change
> and the re-pin announcement.

Arena's migration status at the time of writing: the session loop for every
non-Arena session (Story/Challenge/Escape, single-level and multi-level runs)
runs on the kernel. Hosted Arena PvP does not — see F4. Portable replay
projection is blocked on F1.

**Peer document:** RFC-012 is the TabletopLabs return channel. The two are
independent and mostly disjoint — F1, F2, and F4 have no RFC-012 counterpart.
F3 and RFC-012's T6 are the same family (representation cost) measured on
different axes: T6 measures per-tick observation snapshot cost, F3 measures
per-resolution durable event cost. Scope them together.

---

## F1 — `finalizeRunReplay` rejects runs whose non-final levels were lost

**Class: bug or missing detail in a shipped contract → additive commit on the
baseline line, then an announced re-pin.** This one blocks a migration.

### Problem

```ts
// src/session.ts:2023 (at ab02f39)
if (levelIndex < transcripts.length - 1 && level.result.status !== 'won') {
  throw new TypeError(`run transcript ${levelIndex} must be won before another level`);
}
```

Arena's scored runs advance through **failed** levels. This is the product's
defining run shape, not an edge case:

> "when a level is won/**failed** rolls the same session to the next level …
> The run ends when the last level resolves. This makes the paid board's
> ranking — **total stars, then total turns across the set** — computable from
> one transcript."
> — `agilabs-arena/docs/game-tech-stack.md` §1

A partly-failed run is therefore the *ordinary* outcome of a paid ticket. Under
the current gate it cannot be projected into a portable artifact at all, so
Arena still writes its own transcript format at `/submit` — the divergence
RFC-009 §2.1 moved run composition into the baseline to prevent, in the
consumer whose `session-do` the kernel was extracted from.

### The gate is the only part of the stack that disagrees

Every reference at `ab02f39`:

- **Format admits it.** `status` is an unconstrained `won | failed` enum at
  every level index, with no positional rule —
  `src/engine/replay-format.ts:657`, `python/agilabs_arena/replay.py:513`,
  `schemas/gaos.replay-v1.schema.json:103`.
- **Verifier admits it.** `recheckReplayArtifact` re-simulates each segment
  independently and aggregates
  (`src/engine/replay-format.ts:~1717`):
  ```ts
  totalStars += result.replayed.status === 'won' ? (result.replayed.stars ?? 0) : 0;
  totalActionsUsed += result.replayed.actionsUsed;
  ```
  A failed level contributes zero stars while its `actionsUsed` still counts —
  which *is* Arena's ranking, already implemented. `createReplayArtifact`
  derives header totals by the same rule (`replay-format.ts:419`).

So the artifact would round-trip, validate, and recheck correctly today. Only
the projection refuses to build it. The gate encodes a *product* assumption
("a run is a survival ladder") inside a *format* projection whose own verifier
does not share it.

### Proposal

```ts
export interface FinalizeRunOptions extends FinalizeOptions {
  seed: number;
  /**
   * How a non-final level may end.
   *
   * `'win-to-advance'` (default) — a run is a ladder: losing ends it, so any
   * non-final segment that is not `won` is a malformed run.
   * `'play-all-levels'` — a run is a fixed pinned set played to the end and
   * scored on aggregate; a non-final level may end `failed`.
   */
  advancePolicy?: 'win-to-advance' | 'play-all-levels';
}
```

```ts
if (
  (options.advancePolicy ?? 'win-to-advance') === 'win-to-advance'
  && levelIndex < transcripts.length - 1
  && level.result.status !== 'won'
) {
  throw new TypeError(`run transcript ${levelIndex} must be won before another level`);
}
```

Every other run check is unchanged and still enforced under both policies:
shared session/game/dmath/timeout-policy headers, `seedPolicy: 'explicit'`,
per-segment `runLevelSeed(runSeed, i)` derivation, global renumbering, terminal
validity.

**Why a policy field rather than dropping the gate.** Dropping it silently
accepts a malformed ladder run — a real host-bug class for products whose runs
*do* end on a loss. The two shapes are both legitimate and indistinguishable
from the transcripts alone, so the host declares which one it composed.

### Alternatives rejected

1. **Change Arena so a failed level ends the run** — changes paid ranking and
   contradicts the documented product contract.
2. **Hand-roll run assembly in Arena** — re-creates the level indexing, seed
   derivation, and totals duplication RFC-009 §2.1 exists to prevent.
3. **Defer to v0.20** — leaves the blocked consumer writing a non-portable
   artifact for the whole v0.20 window.
4. **Infer the policy from the transcripts** — a legitimate loss-terminated run
   and a buggy ladder run are indistinguishable.

### Change list

| File | Change |
|---|---|
| `src/session.ts` | `FinalizeRunOptions.advancePolicy`; gate consults it (~2023) |
| `test/session.test.ts` | keep the `/must be won/` assertion as the default-policy case (~532); add a `'play-all-levels'` case asserting a failed non-final level projects AND rechecks clean with correct aggregate totals |
| `docs/session-and-integrity.md` | line 160 states "every non-final segment must be won" unconditionally; qualify it |
| `docs/rfcs/rfc-009-...md` | §2.1: note run composition shipped ladder-only, corrected here |

No Python, schema, or fixture change.

---

## F2 — A non-canonicalisable view takes down a committed transition with an untyped `TypeError`

**Class: bug in a shipped contract (error taxonomy + fail-fast), v0.20 unless a
consumer is blocked.** Arena can work around it host-side; the SDK behaviour is
still wrong.

### Problem

The baseline tightened `canonicalJson` to reject unpaired surrogates and
out-of-safe-range integers (`src/protocol.ts`, v0.18.0..ab02f39). On the
**command** path that tightening is correctly classified — `prepareIngest`
wraps it:

```ts
try { canonicalCommand = canonicalJson(submission.command); }
catch (error) { throw new IntentCollectionError('invalid_submission', ...); }
```

On the **view** path it is not. `viewDigest(view)` → `canonicalJson(view)` runs
during resolution, and a reducer view containing authored text with an unpaired
surrogate throws a bare `TypeError: value.narrative must not contain unpaired
surrogates` out of `prepareAdvance`.

Two things make this worse than a normal error:

1. **It is not classified.** Hosts map `IntentCollectionError`,
   `SessionConflictError`, and `SessionAdvanceError` to status codes. This
   arrives as a raw `TypeError`, indistinguishable from a host bug, so it
   surfaces as a 500.
2. **It fires after the intent is durably committed.** The ingest transition
   succeeded and the participation window is full, so every retry re-enters the
   same failing resolution. The session is **wedged, not merely errored** — no
   input can ever resolve it.

Reproduced end-to-end against Arena's DO: `/init` returns **201** (construction
never canonicalises the initial view), and the **first** `/actions` throws. The
failure is therefore invisible at the point where the level enters the system
and only appears once someone plays it.

### Proposal

1. **Fail fast at construction.** `createSessionKernel` (and `rehydrateKernel`)
   should canonicalise the initial view once and reject a non-encodable one,
   the same way the constructor already probes `stateIsolation.fork`
   cloneability. A level that can never produce a digestible view should fail
   at construction, not at turn one.
2. **Classify the resolution-path failure.** Wrap the digest/canonicalisation
   failure in a typed error — either the existing `SessionAdvanceError` with a
   new code (`invalid_view`) or a peer class — so hosts can return a
   deterministic 4xx/5xx instead of guessing.
3. **Document the obligation.** `docs/session-and-integrity.md` should state
   that reducer views must be canonically encodable (no unpaired surrogates, no
   integers outside the JS safe range), because the digest and delta paths
   canonicalise them. This obligation is currently implicit and is new relative
   to v0.16/v0.17 consumers, who never had their views canonicalised.

Point 1 alone converts an unrecoverable mid-session wedge into a clean startup
rejection, and is the part worth doing even if 2 and 3 slip.

---

## F3 — Durable event size: measured host cost, per RFC-009 §3.3

**Class: product-side mitigation, SDK-side sizing feedback.** RFC-009 §3.3 asked
the migrations to *measure* representation cost early rather than pre-build an
optimisation. These are the measurements.

### Measurements

Arena, turns cadence, one seat, single-parameter commands, measured off the
Durable Object's stored record:

| Event kind | Per turn | Bytes | Note |
|---|---|---|---|
| `intent-accepted` | 1 | 271 | |
| `resolution` | 1 | 392 | |
| `checkpoint` | 1 | 152 | |
| **total** | | **~815** | ~818 B including the enclosing record's escaping |

Context: Cloudflare Durable Objects cap a single stored value at **128 KiB**.
Arena's shipped content reaches **375** actions for one level and **760–1305**
actions for one game-type scored run. A naive "store the transcript in one
value" host design therefore dies at roughly 159 actions — well inside real
content. (Arena's fix is host-side: one storage key per level episode plus
chunking. It is not the SDK's job to know about the 128 KiB cap.)

### What is derivable rather than essential

Roughly 30% of each turn's bytes is recomputable from the header plus position:

- **`eventId` repeats the `sessionId` in every event.** The id is
  `sessionId + ':' + transitionRevision + ':' + index`, and `sessionId` is a
  36-char UUID in Arena. At 3 events per turn that is ~150 B/turn of a constant
  already present in `SessionHeader`.
- **`canonicalCommand` duplicates `command`** as an escaped string (~35 B here,
  more for parameterised commands). It is `canonicalJson(command)` — derivable
  on rehydrate.
- **`consumed` duplicates `inputs[].participantId`/`submissionId`** (~60 B per
  resolution); `inputs` already carries both.

### Proposal (v0.20, evidence-gated exactly as §3.3 intends)

Not a wire-format change and not urgent. Worth considering for v0.20:

1. Document that `SessionEvent` is the **durable** representation and state its
   expected size per resolution, so hosts size storage before they design it.
   This is the cheapest item and would have caught Arena's design error.
2. Consider a documented compact persistence form — events minus the fields
   above, rehydrated by recomputation — for hosts with per-value limits. The
   in-memory and projection shapes need not change.

Recording this here because it is the same family of question §3.3 flagged for
the observation codec, answered with numbers from a real migration.

---

## F4 — Not a defect: hosted Arena PvP cannot adopt the kernel

Recorded so v0.20 scoping knows why one of Arena's two loops is still
hand-rolled, and so it is not mistaken for migration laziness.

Arena's free `controlRevision` substep calls `reducer.prepareIntent`, which
mutates game state **outside any resolution** (opening a talk target chooser,
cancelling a dialogue). The kernel owns state and exposes no host-driven
transition that is not a reducer resolution — `prepareExtension` records a lane
entry but changes nothing. Routing these through `prepareIngest`/`prepareAdvance`
would make each modal keystroke a world turn requiring every seat to submit,
which changes the game.

This is exactly what RFC-006 §4 anticipated when it left the substep Arena-side
and named a generic **extension-lane hook** as the seam, and what §7 Q1 left
open ("ordered with gameplay or parallel-but-recorded?"). Arena is now a
concrete answer to that question: it needs *ordered-with-gameplay, state-changing,
seat-local* transitions that do not advance the shared cursor. If v0.20 designs
the extension lane, this is the use case to design against.

Until then Arena runs two loops, and the hosted PvP transcript is not
kernel-produced.

---

## Summary for v0.20 scoping

| # | Finding | Class | Lands |
|---|---|---|---|
| F1 | `finalizeRunReplay` ladder-only terminal rule | blocks a migration | baseline line + announced re-pin |
| F2 | Non-canonicalisable view wedges a committed transition | shipped-contract bug | v0.20 (fail-fast part is cheap) |
| F3 | Durable event size, 30% derivable | measured feedback | v0.20, documentation first |
| F4 | Extension lane must carry state, not just records | open question answered | v0.20 design input |

## Re-pin mechanics for F1

Per RFC-009 §3 this lands as a strictly non-breaking additive commit on the
baseline line, followed by an **explicit, announced re-pin** so the
TabletopLabs migration moves deliberately rather than discovering the change.
The freeze check stays the acceptance criterion:

```bash
git diff --name-only 5ddd404..<new-pin> -- src python schema
```

It will now legitimately print `src/session.ts`. The freeze rule permits that
as the additive-field exception, so the announcement must say so explicitly
rather than let the check read as a violation — which is the reason to prefer
one such commit over a habit of them.

## Consumer follow-up once re-pinned

`SessionDO.submitKernelSession` switches to `finalizeSession(...)` with
`advancePolicy: 'play-all-levels'` for runs, and `recheckStored` in
`packages/worker/src/index.ts` switches to `parseReplayJsonl` +
`recheckReplayArtifact`, keeping the legacy branch for artifacts already in R2.
Every input both need is already stored.
