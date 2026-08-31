# Room agents

GAOS room agents are conversational room presences that may optionally control
a game actor or logical seat. A room can contain a rules guide, referee,
several voiced characters, and player bots without giving every agent the same
authority or observation.

The portable agent API is exported from
`@yugao-gaos/gaos-sdk/room-agent`. Common room messages, events, services,
watchers, and votes are exported from
`@yugao-gaos/gaos-sdk/room-interaction`. The provider-neutral hosting runtime
is exported from `@yugao-gaos/gaos-sdk/room-agent-runtime`. Replaceable
reasoning, speech, and generated-media contracts are exported separately from
`@yugao-gaos/gaos-sdk/experience-providers`; concrete voice, network,
durable-storage, and model implementations remain host-owned.

## Agent roles

| Example | Control binding | Typical observation | Output |
|---|---|---|---|
| Rules guide | none | public/spectator projection | speech only |
| NPC character | actor | product actor projection | speech and optional actor action |
| Player bot | seat | `viewFor(state, seat)` | speech and optional seat action |
| Referee | service-controlled seat | explicitly authorized projection | speech and permitted system/game action |

An agent role and a room participant role are descriptive. Neither grants
command authority. `SeatControlLedger`, the current reducer state, and normal
session admission remain authoritative.

## Hosted turn flow

1. The host authenticates a room participant and obtains final text from chat
   or STT, then calls `RoomAgentRuntime.handleFinalInput` with a stable input ID
   and channel ID plus the authenticated maximum participant-visible
   disclosure. The runtime never infers disclosure from a channel name.
2. The runtime selects one visible agent from an explicit address, participant
   focus, phase rule, or fallback guide.
3. The product context source derives the observation that agent is permitted
   to see and supplies
   the current legal actions plus the game's `GameAgentManifest`.
4. `RoomAgentRegistry.respond` returns `null`, utterances, an optional action
   proposal, or both.
5. The runtime records exact input/output transcript boundaries, publishes
   caption lifecycle events, and serializes utterances through one room speech
   adapter using the registered provider-neutral voice ID.
6. If an action was proposed, the host submits it through its ordinary GAOS
   authority, legality, idempotency, persistence, and commit path.

The registry never applies an action. A model response is untrusted input even
when its descriptor is bound to an actor or seat.

## Rules manifest

The reducer defines authoritative rules, but reducer code and legal-action IDs
are not a player-facing explanation. Products publish a versioned
`GameAgentManifest` alongside the game adapter with rule sections, glossary,
and optional typed knowledge.

Mechanism sections can explain product systems and reference related canonical
action IDs. This is the supported meaning of answering from client/game code:
the product authors and versions explanatory data beside its adapter. The SDK
does not parse deployed TypeScript or model source code at runtime.

The manifest may be shared by several agents. Character-specific secrets
belong in the scoped observation or product knowledge projection supplied to
that invocation, not in a public guide's manifest.

## Common interaction routing

Every routed interaction names one authenticated source and one or more
explicit targets. The envelope also carries a `channelId`, typed payload,
participant-visible disclosure, and root/parent/hop causation. Public,
private, and internal agent channels must use separate provider memories.

| Pattern | Portable mechanism | Host/product responsibility |
|---|---|---|
| Rules Q&A | Manifest + scoped observation + legal actions | Author/version explanations and select the guide |
| NPC conversation | Agent-to-agent message | Resolve private persona, memory, and wake policy |
| Agentic service | Capability-checked request/result | Implement service and redact its data |
| Agentic watcher | Once-per-committed-revision event drafts | Supply a safe committed-state projection |
| Audience vote | Pure eligible-ballot tally and stable tie-break | Own poll lifecycle and narrate/route the result |
| Private help | Participant-scoped disclosure | Authenticate participant and isolate channel memory |

The router uses FIFO delivery within each room/channel lane, permits unrelated
lanes to run concurrently, deduplicates envelope IDs, and applies a default
eight-hop bound for derived exchanges. It never performs semantic LLM routing
or broadcasts to every agent. Agent responses return drafts; the host derives
and enqueues them so source identity and causation cannot be invented by a
driver.

Disclosure can only become narrower as an interaction moves through an agent,
service, or watcher. A private reply stays private even if a model requests a
room audience. A private chain also cannot add a new agent or watcher; the host
must authorize a new root interaction. Internal service and agent messages can
use `none` disclosure.

Services and watchers produce data or events, not reducer mutations. If an
agent decides that an interaction should affect the game, it must return the
same optional actor/seat action proposal described above. The host validates
that proposal normally.

A service call ID is retry-stable only within its original room, agent,
channel, and disclosure boundary. Reuse with a different channel or disclosure
is rejected before a cached result can cross a privacy context.

## Audience interaction

Audience members remain spectators. They can ask questions and participate in
host-owned conversational polls without becoming GAOS seats. The pure vote
resolver snapshots eligible participant and option IDs, rejects duplicate
ballots, and resolves ties by declared option order; the agent narrates the
result rather than tallying it.

If a crowd decision changes the game, open/cast/close belongs in the product
reducer and RFC-020 command path. An authorized service or crowd controller
submits one canonical consequence only after deterministic resolution. Only
the accepted command enters state and replay.

## Voice runtime boundary

The SDK input begins with final authenticated text and its output ends with
utterance text and a provider-neutral voice ID. `RoomAgentRuntime` supplies:

- mention/focus/phase routing;
- per-channel interruption and stale response cancellation;
- one speech arbiter for simultaneous agents;
- exact transcripts partitioned by channel ID;
- provider-neutral speech and caption adapters;
- serializable registration, phase, focus, and reconnect state; and
- operational lifecycle and duration events that deliberately exclude
  transcript text.

The host still owns push-to-talk, STT segmentation, speaker authentication,
the concrete TTS/audio transport, and provider conversation objects. A
`RoomAgentRuntimeStore` adapter persists room state and channel transcripts in
the host's database or Durable Object. A `RoomAgentRuntimeContextSource`
receives only the requested channel transcript and resolves product-owned
model memory, scoped observations, prompts, and legal actions.

`channelId` partitions conversation memory and active provider work;
`disclosure` bounds participant delivery. They are separate security inputs.
A newer input supersedes work only on its own channel. Provider calls on other
channels continue, while their eventual utterances still share the room-global
speech floor. Calling `interrupt()` explicitly remains a room-wide stop.

## Long-running and multi-turn work

For a task that reports progress, streams more than one assistant message, or
pauses for another answer, implement the driver's `run()` method and provide a
durable `RoomAgentRunStore`. This is additive: existing `respond()` drivers and
`handleFinalInput()` keep their original one-turn behavior, while
`handleRunInput()` adapts either kind of driver into a durable run.
The store's `admitRunInput()` transaction commits the input transcript, run,
and retry index together; `commitRunEvent()` similarly commits each event with
its resulting run transition. An exact retry therefore finds the recoverable
run instead of an orphan transcript boundary.

```ts
const runtime = new RoomAgentRuntime({
  roomId: 'room-42',
  registry,
  store,
  runStore: store,
  contextSource: buildScopedContext,
  createId: crypto.randomUUID,
  fallbackAgentId: 'guide',
  runObserver: uiOrCueBridge,
  progressPresenter: optionalProductSpeechPolicy,
});

const execution = runtime.startRun({
  channelId: 'private:visitor-7:guide',
  disclosure: { kind: 'participants', participantIds: ['visitor-7'] },
  input: finalInput,
});

for await (const entry of execution.events) {
  // Forward durable progress or assistant deltas while work is still running.
}
const result = await execution.result;
```

Progress is structured public lifecycle state, not hidden model reasoning.
The SDK does not select a filler style. A product may ignore progress, render
UI only, trigger a prerecorded cue, use deterministic copy, or generate a
short fresh line from the verified progress snapshot. Presenter utterances are
ephemeral by default and therefore do not enter the durable channel transcript
or later model history unless the product explicitly selects `record`.

Drivers that begin provider work before another truthful milestone is
available can opt into a bounded silence ladder with
`waitWithRoomAgentProgress()`. The helper contains no wording and has no
default cadence: the product supplies consecutive delays, converts each rung
into an ordinary structured `progress` event, and leaves its existing
`progressPresenter` to choose text, audio, or no presentation at all.

```ts
const pending = understandVisitor(input, signal);
yield { type: 'progress', progress: { stage: 'understanding' } };
for await (const entry of waitWithRoomAgentProgress(pending, {
  delaysMs: [6_000, 3_000, 6_000],
  signal,
})) {
  if (entry.type === 'progress') {
    yield {
      type: 'progress',
      progress: { stage: 'understanding', current: entry.rung, unit: 'rung' },
    };
  } else {
    understanding = entry.value;
  }
}
```

The first provider result wins immediately, timers are cleared, and abort ends
the ladder silently even when the underlying provider has not settled. A
product can emit an immediate progress event before the helper, as above, then
use the delay list for later silence-based reminders.

An `input_requested` event durably changes the run to `waiting_for_input`.
The next input from the same authenticated speaker on the same channel and
agent continues that run, or a client can echo the run ID and continuation
token for strict correlation. Continuation intersects its new disclosure with
the waiting run's persisted disclosure, so restored checkpoint or transcript
context cannot become more visible. `checkpoint` supplies product-owned
recovery state; `resumeRun()` invokes the driver again with that checkpoint
after a host restart. `cancelRun()` and persisted epoch deadlines produce
replayable terminal states. `replayRun()` returns ordered events without
replaying speech, cues, actions, or provider calls.

When an authenticated input must replace a specifically correlated active run,
the host may supply `supersession: { runId, checkpoint }`. The checkpoint must
be a plain JSON value. The runtime durably cancels that active run before it
atomically admits a new logical run with a cloned initial checkpoint. This is
not a general initial-checkpoint option: a different open run, an unrelated
terminal run, or a strict continuation combined with supersession is rejected.
If the correlated run becomes `waiting_for_input` before cancellation wins,
that authoritative transition is preserved and continued with its existing
checkpoint; the proposed supersession seed is ignored. An exact retry after a
loss between cancellation and admission can recover only from the correlated
run's durable `superseded_by_new_input` cancellation event.

Driver `assistant_output.outputId` values are logical IDs local to an attempt.
The runtime replaces them in journal and live events with opaque delivery IDs
allocated uniquely against all existing output IDs in that run, and adds
runtime-owned `delivery` metadata recording origin, attempt, and logical ID. On
crash recovery, already-closed logical outputs are reconciled but not presented
or recorded again; incomplete prior output remains replayable crash evidence
but is abandoned before the resumed attempt begins streaming. Legacy output
rows without `delivery` metadata are never inferred from their opaque IDs and
therefore are not suppressed.

```ts
import {
  InMemoryRoomAgentRuntimeStore,
  RoomAgentRuntime,
} from '@yugao-gaos/gaos-sdk/room-agent-runtime';

const runtime = new RoomAgentRuntime({
  roomId: 'room-42',
  registry,
  store: new InMemoryRoomAgentRuntimeStore(), // replace in production
  contextSource: buildScopedContext,
  createId: crypto.randomUUID,
  fallbackAgentId: 'guide',
  speech: ttsAdapter,
  captions: captionBroadcaster,
});

await runtime.handleFinalInput({
  channelId: 'private:visitor-7:guide',
  disclosure: { kind: 'participants', participantIds: ['visitor-7'] },
  input: {
    id: 'final-transcript-19',
    speakerId: 'visitor-7',
    modality: 'speech',
    text: 'What should I carry forward?',
  },
});
```

Input IDs are idempotency keys: a byte-identical retry returns `duplicate`
without interrupting the original turn. Reusing an ID with a different
disclosure is rejected. A new final input cancels stale model work and
interruptible speech on the same channel only. Non-interruptible speech
finishes before the room-global speech lane advances. On reconnect,
`resume(channelId)` returns the current runtime state and only that channel's
transcript.

Use the companion [presentation cue bridge](./presentation-cues.md) when a
room agent must drive ordered browser, Godot, Unity, or native effects.

The base room-agent requirements and package plan are recorded in
[RFC-021](./rfcs/rfc-021-room-agents.md). Durable runs, progress presentation,
streaming, and continuation are governed by
[RFC-022](./rfcs/rfc-022-durable-agent-runs.md).
