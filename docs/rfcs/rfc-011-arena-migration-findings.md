# RFC-011 — Arena's open asks of the SDK

Status: **implemented in v0.21 — A1/A2 shipped; A3/A4 were already
documented in v0.20; A5 requests no SDK change** · Target: v0.21 for A1/A2 ·
Breaking: no (error ordering and additive error structure) · Depends on:
RFC-006, RFC-009, RFC-010

> This is the Arena consumer's live return channel, reopened after the v0.20
> integration. The previous edition (nine v0.19 findings) was consolidated into
> RFC-010 Parts D and E and retired — **all nine shipped in v0.20** and are not
> repeated here.
>
> Two items below were briefly filed directly as RFC-010 D6/D7; those entries
> now point here so there is one authoritative copy. Consolidate this document
> the same way when it is accepted.

**Arena's status:** every non-Arena session (Story/Challenge/Escape,
single-level and multi-level runs) runs on the session kernel and `/submit`
emits a portable `gaos.replay` artifact that `recheckReplayArtifact` verifies
clean — including the run shape that `advancePolicy` unblocked. Hosted Arena
PvP does not; see A5. Nothing below blocks Arena. Each item is a workaround
Arena currently carries that the contract could absorb.

Every claim is cited at `v0.20.0` and was re-verified against the released tag,
not against memory of writing the workaround.

---

## A1 — `validateCommand` runs before cursor validation, inverting error precedence

*Class: ordering bug in a v0.20 addition. Previously RFC-010 D6.*

`prepareIngest` orders its checks:

1. receipt / duplicate short-circuit — `src/session.ts:1334`
2. **`validateCommand`** — `src/session.ts:1425`
3. **`collectIntent`** (protocol, session, tickId, revision, participant) — `src/session.ts:1444`

Step 1 is correctly first: an exact retry must replay rather than be
re-validated. Steps 2 and 3 are inverted. A submission carrying a **stale
cursor** *and* a command that is not playable in current state reports the
legality failure — because legality is evaluated against **current** state the
stale client never saw.

That is the wrong answer. A client at an old cursor is not sending an illegal
command; it is sending one that was legal when it looked, and its real problem
is that it is behind. `stale_tick` tells it to re-read and retry. It is also
**unstable**: the same stale retry reports a different error depending on what
other seats did meanwhile, because legality is state-dependent and cursor
validity is not.

Arena held this precedence explicitly before the migration — its own comment
read *"Stable cursor errors take precedence over game-specific command decoding
and today's legal-command set."* Adopting `validateCommand` silently inverted
it, turning a `409 stale_tick` into a `400`; an existing regression test caught
it.

**Accepted v0.21 contract.** The stable wire submission must be validated
before *all* game-owned or live-state-dependent interpretation, not only before
`validateCommand`. After the existing exact-receipt path, `prepareIngest` must
establish protocol, session, `tickId`, revision, participant, submission-id,
and JSON validity before it:

1. calls `commandToAction`;
2. checks the mapped action against live commitment/reveal state; or
3. calls `validateCommand`.

Calling `validateIntentSubmission` before those steps, then calling
`collectIntent` after legality succeeds, is one compatible implementation.
Calling the pure `collectIntent` early and retaining its result is another.
The important contract is the error precedence, not which helper enforces it.
Exact committed retries retain their current idempotent receipt behavior.

Regression coverage must include a stale submission for which:

- `commandToAction` throws;
- commitment/reveal validation would fail against current state; and
- `validateCommand` rejects.

All three must report `stale_tick`.

Arena reorders host-side in `kernelIngestError` until this lands; that
workaround should become deletable.

---

## A2 — a `validateCommand` rejection is only recoverable by parsing its message

*Class: ergonomics on the same v0.20 addition. Previously RFC-010 D7.*

`prepareIngest` flattens every `validateCommand` failure into one string
(`src/session.ts:1433-1439`):

```ts
} catch (error) {
  throw new IntentCollectionError(
    'invalid_submission',
    `command rejected by reducer (${error instanceof Error ? error.message : String(error)})`,
  );
}
```

Two things are lost. The **error object** — `IntentCollectionError`'s
constructor is `(code, message)` with no `cause`, so a product that throws a
domain error such as `IllegalActionError` cannot recover it. And the
**distinction from unrelated failures** — `invalid_submission` is also what
malformed JSON, an unpaired surrogate, and an out-of-safe-range integer
produce, so the code alone cannot separate "your command is not playable" from
"your submission is malformed."

Those are different client answers. Arena returns 422 for an unplayable action
and 400 for a bad one, and the only way it can tell them apart today is to
regex the SDK's own wrapper prose:

```ts
if (err.code === 'invalid_submission' && err.message.includes('rejected by reducer')) {
  const detail = /\(([\s\S]*)\)$/.exec(err.message)?.[1] ?? err.message;
  return json({ error: detail }, detail.startsWith('unknown action ') ? 400 : 422);
}
```

A host parsing a library's error prose to recover structure the library had and
discarded. It breaks silently if the wording is ever reworded, and nothing in
the type system says so.

**Accepted v0.21 contract.** Ship both additive pieces:

1. Add `illegal_command` to `IntentErrorCode`; every `validateCommand`
   rejection uses it.
2. Preserve the thrown value as `cause` on `IntentCollectionError`.

The code provides stable transport classification while `cause` preserves a
product's finer distinction, such as malformed action versus currently
unplayable action. Tests must assert the code without matching SDK prose and
must assert object identity for an `Error` cause and value preservation for a
non-`Error` thrown value.

---

## A3 — resolved in v0.20: multi-level cursor rebasing

*Class: documentation. Carried over from the v0.19 return (F8 → RFC-010 E6);
**already resolved in the released `v0.20.0` tag**.*

One kernel per level is right (RFC-006 §D answer 3), and `finalizeRunReplay`
composes the episodes. But each episode's kernel counts `cursor()` from zero
while the protocol revision a client holds must keep climbing across the whole
run, and nothing reconciles the two.

Arena carries a `revisionBase` — the summed cursors of finished episodes —
adding it on the way out and subtracting it on the way in, including rewriting
`tickId` so a mismatched one still fails validation rather than being silently
repaired. It works and the wire contract is unchanged, but it is fiddly, it is
security-adjacent (cursor validation), and every host composing runs will
re-derive it.

`docs/session-and-integrity.md` documents this exact `revisionBase` translation
in the multi-level run section: add the base outbound, subtract it inbound,
validate translated `tickId`, and advance the base by the completed episode's
cursor. That was the preferred documentation resolution. No `initialCursor`
option is requested for v0.21.

---

## A4 — resolved in v0.20: durable event sizing

*Class: documentation. Carried over (F3 → RFC-010 E5); **already resolved in
the released `v0.20.0` tag**.*

Measured on Arena's Durable Object, turns cadence, one seat,
single-parameter commands:

| Event kind | Per turn | Bytes |
|---|---|---|
| `intent-accepted` | 1 | 271 |
| `resolution` | 1 | 392 |
| `checkpoint` | 1 | 152 |
| **total** | | **~815** |

Roughly 30% is recomputable from the header plus position: `eventId` repeats
the session id (a 36-char UUID in Arena) in **every** event, ~150 B/turn at
three events per turn; `canonicalCommand` duplicates `command` as an escaped
string; `consumed` duplicates `inputs[].participantId`/`submissionId`.

Consequence for a host: Cloudflare Durable Objects cap one stored value at
128 KiB, and Arena's shipped content reaches 375 actions for one level and
760–1305 for one game-type run. A naive "store the transcript in one value"
host dies at ~159 actions — well inside real content. Arena's fix is host-side
(one key per level episode, 64-event chunks); the SDK does not need to know
about the cap.

`docs/session-and-integrity.md` now states that `SessionEvent` is the durable
representation, records the measured ~815 bytes per simple turn, and tells
hosts with per-value limits to append or chunk rather than store one unbounded
value. It deliberately keeps recovery based on the exact self-describing event
stream. A compact persistence form is not part of v0.21; RFC-012 §2 separately
addresses bounded *live* state and checkpoint recovery.

---

## A5 — not a defect: why hosted Arena PvP is still not on the kernel

Recorded so it is not mistaken for an unfinished migration.

v0.20 answered the seat-local-transition question (RFC-010 E4) by classifying
Arena's chooser and dialogue navigation as **host/UI state**, with confirmed
choices becoming ordinary SDK actions — rather than adding a kernel transition
that changes state without advancing the shared cursor. That is a defensible
resolution and Arena does not dispute it.

It is, however, a **product change to the Arena reducer**: modal state
currently lives inside kernel-owned game state, reached through
`reducer.prepareIntent`, which mutates state outside any resolution. Moving it
out is Arena-side work with its own observation and client consequences, not
part of an SDK integration. Until then Arena runs two loops and the hosted PvP
transcript is not kernel-produced.

No SDK action is requested here.

---

## Summary

| # | Ask | Class | Arena's current workaround |
|---|---|---|---|
| A1 | game-owned checks run before stable cursor validation | **v0.21 accepted** | re-checks the cursor on reducer rejection |
| A2 | reducer rejection loses its error type and code | **v0.21 accepted** | regexes the SDK's wrapper message |
| A3 | run cursor rebasing | **resolved in v0.20 docs** | follows documented `revisionBase` pattern |
| A4 | durable event size | **resolved in v0.20 docs** | follows documented chunking guidance |
| A5 | seat-local state — resolved, product-side | none | two loops |

A1 and A2 are one v0.21 change and land together. A3 and A4 require no v0.21
work. A5 remains explanatory only.
