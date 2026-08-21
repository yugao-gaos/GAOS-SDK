# Room agents

GAOS room agents are conversational room presences that may optionally control
a game actor or logical seat. A room can contain a rules guide, referee,
several voiced characters, and player bots without giving every agent the same
authority or observation.

The portable agent API is exported from
`@yugao-gaos/gaos-sdk/room-agent`. Common room messages, events, services,
watchers, and votes are exported from
`@yugao-gaos/gaos-sdk/room-interaction`. The provider-neutral hosting runtime
is exported from `@yugao-gaos/gaos-sdk/room-agent-runtime`. Voice, network,
durable-storage implementations, and model providers remain host-owned.

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
   and channel ID.
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

The router uses FIFO delivery, envelope-ID deduplication, and a default
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
- interruption and stale response cancellation;
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

An `input_requested` event durably changes the run to `waiting_for_input`.
The next input on the same channel continues that run, or a client can echo the
run ID and continuation token for strict correlation. `checkpoint` supplies
product-owned recovery state; `resumeRun()` invokes the driver again with that
checkpoint after a host restart. `cancelRun()` and persisted epoch deadlines
produce replayable terminal states. `replayRun()` returns ordered events without
replaying speech, cues, actions, or provider calls.

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
  input: {
    id: 'final-transcript-19',
    speakerId: 'visitor-7',
    modality: 'speech',
    text: 'What should I carry forward?',
  },
});
```

Input IDs are idempotency keys: a byte-identical retry returns `duplicate`
without interrupting the original turn. A new final input cancels stale model
work and interruptible speech. Non-interruptible speech finishes before the
single speech lane advances. On reconnect, `resume(channelId)` returns the
current runtime state and only that channel's transcript.

Use the companion [presentation cue bridge](./presentation-cues.md) when a
room agent must drive ordered browser, Godot, Unity, or native effects.

The base room-agent requirements and package plan are recorded in
[RFC-021](./rfcs/rfc-021-room-agents.md). Durable runs, progress presentation,
streaming, and continuation are governed by
[RFC-022](./rfcs/rfc-022-durable-agent-runs.md).
