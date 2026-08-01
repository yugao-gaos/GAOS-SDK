# RFC-020 — Unified command effects

Status: **implemented** · Ships in: v1.0 · Compatibility: additive command API and
`gaos.replay` v1.4, followed by deprecation of the separate control-transition
lane · Depends on:
[RFC-006](rfc-006-session-kernel.md),
[RFC-010](rfc-010-submission-signatures-and-interest.md),
[RFC-016](rfc-016-product-owned-verifier-kits.md),
[RFC-018](rfc-018-unified-session-lifecycle.md)

## 1 — Problem

The session kernel currently exposes two submission paths for participant
input:

- `prepareIngest(CommandSubmission)` accepts a command into the open intent
  window for later resolution; and
- `prepareControlTransition(ControlTransitionInput)` immediately changes
  deterministic reducer state and observations without advancing the gameplay
  tick, cursor, or intent window.

The second path correctly gives durable, idempotent, crash-recoverable
semantics to modal acknowledgement, ready state, loadout selection, target
selection, dialogue navigation, and similar interaction state. Its separate
public contract is nevertheless the wrong abstraction.

From a participant's perspective both inputs are commands. Their difference is
not their transport shape or origin; it is their authoritative effect:

- an **interaction** updates deterministic interaction state immediately but
  does not enter or resolve the intent window; or
- an **intent** reserves the participant's input in the current window for
  atomic world resolution.

Requiring a host to choose the SDK method before product interpretation causes
three problems:

1. Products may need to run game logic speculatively, catch a sentinel error,
   and call a second SDK method when the first classification was wrong.
2. The two paths have separate identifiers, receipts, history lookups, and
   replay treatment even though they originate from the same participant
   command stream.
3. A finalized portable replay currently omits `control-transition` events.
   Full session rehydration restores them, but an independent verifier cannot
   reconstruct interaction state, control revisions, or later
   interaction-dependent command legality.

Calling the second path a **UI transition** would also put presentation into
the deterministic protocol. The same command may originate from a graphical
UI, accessibility device, CLI, headless agent, or timeout policy. Visual
animation, focus, hover, and rendering are not authoritative state and do not
belong in a replay.

## 2 — Decision

GAOS standardizes one participant **command** submission path. A product-owned,
deterministic classifier interprets each valid command and returns exactly one
of two effects:

```ts
type CommandEffect<TState> =
  | {
      kind: 'interaction';
      state: TState;
    }
  | {
      kind: 'intent';
      action: SubmittedAction;
    };
```

The terms have the following normative meanings:

- **command** — the product-defined value submitted by a participant;
- **interaction** — a deterministic, turn-neutral state change that neither
  occupies an intent slot nor triggers resolution;
- **intent** — an accepted canonical action reserved in the current intent
  window;
- **resolution** — one atomic reducer advancement over the window's collected
  intents; and
- **observation** — a seat-scoped view of authoritative state before or after
  any committed transition.

The participant-facing cycle is:

```text
observe
   ↓
command
   ├── interaction → observe again at the same tick and cursor
   └── intent      → collect → resolve → observe at the next tick and cursor
```

Interactions are optional and repeatable:

```text
observe → interact → observe → interact → observe → intend → resolve → observe
```

`interaction` is a protocol classification, not a presentation classification.
An interaction may update reducer-backed dialogue, targeting, readiness, or
selection state. A visual-only change remains product presentation state and
MUST NOT enter this API.

## 3 — Authoritative classification

The product adapter, not the client, determines the command effect.

A command schema may contain a product-defined hint or discriminant, but the
SDK MUST treat it as untrusted command content. The host MUST NOT route a
command to interaction semantics solely because the participant labels it
`interaction`, `control`, `ui`, or an equivalent value. Otherwise a malicious
or buggy participant could bypass simultaneous intent collection.

The additive session option is:

```ts
interface CommandEffectContext {
  sessionId: string;
  participantId: string;
  submissionId: string;
  cursor: number;
  tick: number;
}

type ClassifyCommand<TState, TCommand extends JsonValue> = (
  state: TState,
  command: TCommand,
  context: CommandEffectContext,
) => CommandEffect<TState>;

interface ClassifiedCommandOptions<
  TLevel,
  TState,
  TCommand extends JsonValue,
  TView extends SessionView,
> {
  classifyCommand: ClassifyCommand<TState, TCommand>;
  commandToAction?: never;
}
```

The implementation adds this as one arm of the session options contract.
Existing options with `commandToAction` form the legacy arm and remain valid;
they classify every accepted command as an intent. A session MUST configure
exactly one authoritative command adapter. This makes the v1.1 API additive
rather than turning `classifyCommand` into a new requirement for existing
callers.

`classifyCommand` is synchronous, deterministic, and side-effect-free outside
its returned state. It runs against the kernel's isolated draft. Products with
mutable or copy-on-write state remain subject to RFC-006
`SessionStateIsolation`.

For an interaction result, `state` is the complete next reducer state. For an
intent result, `action` is the canonical action frozen into the current
window. Classification MUST NOT mutate the input state when it returns an
intent.

The SDK validates stable protocol facts—protocol version, session, tick ID,
cursor, participant, submission identity, and JSON validity—before calling
product classification. Exact durable retries short-circuit before
classification. This preserves RFC-011's error precedence: a stale command is
stale regardless of how current product state would classify it.

## 4 — Kernel API

The new prepared-transition entry point is:

```ts
type CommandReceipt =
  | {
      status: 'accepted' | 'duplicate';
      effect: 'interaction';
      participantId: string;
      submissionId: string;
      transitionRevision: number;
      cursor: number;
      tick: number;
    }
  | {
      status: 'accepted' | 'duplicate';
      effect: 'intent';
      participantId: string;
      submissionId: string;
      cursor: number;
      tick: number;
      submittedParticipants: readonly string[];
      awaitingParticipants: readonly string[];
      resolved: boolean;
    };

interface SessionKernel<TCommand extends JsonValue, TView> {
  prepareCommand(
    submission: CommandSubmission<TCommand>,
  ): Prepared<CommandReceipt, TView>;
}

interface SessionKernelHost<TCommand extends JsonValue, TView> {
  command(
    submission: CommandSubmission<TCommand>,
  ): Promise<CommandReceipt>;
}

interface SessionClient {
  submitCommand<TCommand, TObservation>(
    sessionId: string,
    command: TCommand,
    options?: SubmitCommandOptions,
  ): Promise<TickResult<TObservation>>;
}
```

`prepareCommand` follows the existing RFC-006 publication model:

```text
prepareCommand → persist prepared.events → commit → publish prepared.deltas
```

Preparation never changes live kernel state. Every prepared value is completed
exactly once by `commit` or `abort`.

`SessionKernelHost.command` serializes persistence and publication exactly as
its existing `ingest` and `control` operations do. `SessionClient.submitCommand`
replaces `submitIntent` as the accurately named low-level client operation.
The RFC-018 `SessionHandle.act` method remains the participant-facing
convenience operation and may return an observation at the same tick when the
accepted command was an interaction. Runners MUST continue observing and
acting until the session becomes terminal; they MUST NOT assume every
successful `act` advances the cursor.

## 5 — Interaction semantics

An accepted interaction:

- increments `transitionRevision`;
- increments affected seat view revisions and emits observation deltas with
  `origin: 'interaction'`;
- preserves the gameplay `tick` and `cursor`;
- preserves every already-collected intent byte-for-byte;
- does not occupy the participant's intent slot;
- does not make the intent window ready;
- does not call the world reducer's `advance`, `applyIntents`, or compatibility
  action fold; and
- does not alter timeout accounting unless an explicit timeout policy consumes
  an interaction as its own recorded input.

An interaction MAY change deterministic state used to validate or formulate a
later command. It MUST be **window-safe**: it may not change the identity,
ordering, or meaning of an already-accepted intent, change the participant set
of the open window, or make arrival order affect world resolution.

The SDK can enforce preservation of the window and participant set. Products
are responsible for the semantic part of window safety and MUST cover it with
conformance tests whenever interactions are enabled during a partial
simultaneous window.

Interaction is not synonymous with seat-local or private. An interaction may
produce observations for multiple seats when the product rules make its
effect public. Information partitioning remains reducer- and
interest-policy-owned.

## 6 — Intent semantics

An accepted intent:

- freezes the classifier's canonical `SubmittedAction`;
- occupies exactly one participant slot in the open intent window;
- emits an `intent-accepted` live event;
- preserves the existing simultaneous ordering, commitment, signature, and
  timeout rules; and
- changes world state only when a later resolution consumes the window.

The SDK MUST NOT call `classifyCommand` again at resolution. Reclassification
against later state could change an accepted intent after intervening
interactions or make simultaneous arrival order observable. Resolution uses
the canonical action frozen at acceptance.

An interaction by a participant that already has a pending intent does not
replace, cancel, or edit that intent. Products that support intent replacement
or withdrawal need an explicit future protocol operation with its own
authorization, ordering, and replay semantics.

## 7 — Identity, retry, and signing

Both command effects share the existing seat-scoped `submissionId` namespace.
The same `(participantId, submissionId)` MUST NOT be used once as an
interaction and once as an intent.

An exact retry returns the original effect and a `duplicate` receipt without
calling product classification again, appending another event, or changing
state. Reuse with different canonical command bytes is a conflict.

History lookup and checkpoints therefore retain one command identity record:

```ts
interface SessionHistoryLookup {
  command(
    participantId: string,
    submissionId: string,
  ): {
    canonicalCommand: string;
    effect: 'interaction' | 'intent';
  } | undefined;
}
```

Signed sessions sign the command envelope before effect classification. The
durable event records the authoritative effect chosen by the pinned adapter.
Changing an event's effect after signing changes replay semantics and MUST fail
verification even though the participant did not sign the derived effect
field directly.

## 8 — Live events and recovery

The live transcript keeps distinct effect events because they have different
state-machine consequences:

```ts
type SessionEvent =
  | {
      kind: 'interaction';
      tick: number;
      cursor: number;
      participantId: string;
      submissionId: string;
      command: JsonValue;
      canonicalCommand: string;
      // Integrity fields omitted.
    }
  | {
      kind: 'intent-accepted';
      tick: number;
      revision: number;
      participantId: string;
      submissionId: string;
      command: JsonValue;
      canonicalCommand: string;
      action: SubmittedAction;
      // Integrity fields omitted.
    }
  | {
      kind: 'resolution';
      // Existing grouped-resolution fields.
    };
```

Recovery replays these events in log order. An interaction invokes the pinned
classifier and requires an `interaction` result; the canonical next state is
adopted without advancing the window. At the original acceptance point, an
`intent-accepted` event invokes the pinned classifier, requires an `intent`
result equal to its recorded canonical action, and restores that recorded
action to the window. It is never reclassified later at resolution.

Recovery rejects:

- an interaction event that classifies as an intent;
- an interaction at a different tick or cursor from the reconstructed head;
- an intent event whose recorded action contradicts its signed/canonical
  command under the pinned adapter;
- reuse of a submission identity across effects; and
- any interaction that changes the reconstructed open window.

## 9 — Portable replay and verifier kits

`gaos.replay` v1.4 adds an ordered interaction record:

```ts
interface ReplayInteraction {
  kind: 'interaction';
  n: number;
  levelIndex: number;
  tick: number;
  cursor: number;
  participantId: string;
  submissionId: string;
  command: JsonValue;
  canonicalCommand: string;
  clientTime?: number;
  prevChainHash?: string;
  sig?: string;
  hostTime?: number;
}
```

`finalizeReplay` and `finalizeRunReplay` MUST preserve every interaction in
its original order relative to resolutions, timeouts, interest declarations,
and integrity records. They MUST NOT project visual presentation cues.

Replay verification starts from the pinned level and seed, then processes the
ordered record stream:

1. interaction records are reclassified and applied without advancing tick,
   cursor, or an intent window;
2. resolution records apply their recorded canonical action groups atomically;
3. the verifier compares recorded outcomes, replay metrics, signatures,
   semantic evidence, and aggregate totals as before.

The verifier MUST fail if an interaction classifies as an intent, changes
tick/cursor semantics, or cannot be interpreted by the pinned historical
adapter.

RFC-016 verifier kits must therefore resolve a versioned **session adapter**
in addition to the reducer whenever a replay contains interactions:

```ts
interface ReplaySessionAdapter<
  TState = unknown,
  TCommand extends JsonValue = JsonValue,
> {
  classifyCommand: ClassifyCommand<TState, TCommand>;
}

interface ReplayImplementation<TLevel = unknown> {
  reducer: Reducer<TLevel, unknown, SessionView>;
  session?: ReplaySessionAdapter;
}
```

The exact exported resolver shape may be refined during implementation, but
the ownership boundary is normative: the product owns command meaning; the
SDK owns ordered replay and verification; the content-addressed verifier kit
pins both.

A v1.4 artifact containing interactions is not independently verifiable with
only a world reducer. Missing historical interaction logic is a verification
failure, not permission to skip those records.

## 10 — Compatibility and migration

The implementation ships additively in v1.0:

1. Add `classifyCommand`, `prepareCommand`, unified receipts, interaction
   events, `SessionKernelHost.command`, `SessionClient.submitCommand`,
   checkpoint support, and replay v1.4.
2. Retain `commandToAction`, `applyControlTransition`, `prepareIngest`, and
   `prepareControlTransition` as compatibility APIs. Retain host `ingest` /
   `control` and client `submitIntent` as deprecated forwarding operations.
3. Provide an SDK adapter that maps the legacy intent lane to
   `{ kind: 'intent', action }` and the legacy control lane to
   `{ kind: 'interaction', state }`.
4. Deprecate the separate public lanes only after the unified path passes the
   conformance suite and at least one production consumer has migrated.
5. Preserve parsing and verification of historical replay versions with their
   original semantics. Never reinterpret an older artifact as v1.4.

Legacy `control-transition` live events remain readable for checkpoint and
session recovery. New unified sessions emit `interaction`. A migration tool
may losslessly map a legacy control event to an interaction event only when
the original adapter identity and canonical command bytes are available.
Historical durable logs are not rewritten in place.

This RFC does not require a product migration in the SDK implementation
change. Products migrate after the SDK release and remove their dual-lane
routing only after their historical verifier kit contains the matching
session adapter.

## 11 — First-consumer validation

Arena/Zonoid is the intended first production consumer after SDK
implementation.

Its current adapter attempts a control transition and uses a product sentinel
to redirect world commands into ordinary intent ingestion. Migration replaces
that flow with one command submission whose product classifier returns:

- `interaction` for reducer-backed modal, dialogue, targeting, cancel, ready,
  and timeout-normalization transitions that do not produce a world intent;
  or
- `intent` with the canonical world action when the command participates in
  simultaneous resolution.

The Arena migration is explicitly out of scope for implementing this RFC in
the SDK repository. It begins only after the SDK API, replay format, verifier
support, and conformance tests ship.

## 12 — Rejected alternatives

### 12.1 Trust a client `effect` field

Rejected. It lets a participant choose whether a command bypasses resolution.
A field may be a decoding hint, but the authoritative adapter must classify
the command.

### 12.2 Name the effect `ui`

Rejected. GUI is one possible input and presentation surface. Headless agents,
CLIs, devices, and host policies can produce the same deterministic effect.
Visual-only state remains outside the SDK.

### 12.3 Keep two public submission methods

Rejected as the long-term model. It forces hosts to classify before entering
the kernel and duplicates identity, retry, and audit semantics.

### 12.4 Convert every interaction into an intent

Rejected. It would consume a simultaneous slot and advance the world for
dialogue navigation, target browsing, cancellation, or readiness changes,
changing game semantics and introducing artificial turns.

### 12.5 Omit interactions from portable replay

Rejected. Reducer-backed interaction state may affect later command legality,
control revisions, observations, and final state. Session recovery and
independent verification must agree.

### 12.6 Reclassify intents at resolution

Rejected. State may have changed since acceptance, and arrival order would
then affect command meaning. The canonical action is frozen when the intent is
accepted.

## 13 — Conformance plan

Implementation is complete only when automated tests prove:

1. one command API accepts both interaction and intent effects;
2. stable protocol and cursor failures precede product classification;
3. exact retries preserve the original effect without a second classifier
   call;
4. conflicting bytes under a reused submission ID fail across both effects;
5. an interaction preserves tick, cursor, participant set, and every pending
   intent byte-for-byte;
6. an interaction updates deterministic state, observations,
   `transitionRevision`, and view revisions exactly once;
7. an intent freezes its canonical action at acceptance and is not
   reclassified at resolution;
8. simultaneous resolution remains independent of submission arrival order;
9. prepare, abort, commit, crash recovery, and checkpoint-tail recovery work
   with immutable and deliberately mutable reducers;
10. signed interaction and intent commands retain chain continuity and reject
    effect tampering;
11. `finalizeReplay` and `finalizeRunReplay` preserve interaction ordering;
12. the v1.4 verifier reapplies interactions and rejects omission,
    reordering, reclassification, or adapter mismatch;
13. historical replay versions and legacy control-transition logs retain
    their original behavior; and
14. the high-level session runner tolerates multiple same-tick observations
    before an intent and resolution.

## 14 — Acceptance criteria

This RFC was accepted for the v1.0 release with:

- `interaction`, `intent`, and `resolution` are the accepted protocol terms;
- classification is product-owned and reducer/adapter-authoritative;
- one submission identity namespace spans both effects;
- an accepted intent freezes its canonical action;
- interaction window-safety is normative;
- portable replay includes interactions and pins their historical adapter;
- the compatibility period and replay versioning policy are sufficient; and
- product migration remains a follow-up after the SDK implementation ships.
