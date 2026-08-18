# Room agents

GAOS room agents are conversational room presences that may optionally control
a game actor or logical seat. A room can contain a rules guide, referee,
several voiced characters, and player bots without giving every agent the same
authority or observation.

The portable agent API is exported from
`@yugao-gaos/gaos-sdk/room-agent`. Common room messages, events, services,
watchers, and votes are exported from
`@yugao-gaos/gaos-sdk/room-interaction`. Voice, network, persistence, and model
providers remain host-owned runtime concerns.

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
   or STT.
2. Product routing selects one agent ID from an explicit mention, interaction
   focus, world context, phase rule, or fallback guide.
3. The host derives the observation that agent is permitted to see and supplies
   the current legal actions plus the game's `GameAgentManifest`.
4. `RoomAgentRegistry.respond` returns `null`, utterances, an optional action
   proposal, or both.
5. The host captions and synthesizes utterances using the registered voice.
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
utterance text and a provider-neutral voice ID. A room runtime layers on:

- push-to-talk and speaker attribution;
- STT segmentation and text fallback;
- mention/focus/phase routing;
- per-agent conversation memory;
- interruption and stale response cancellation;
- one speech arbiter for simultaneous agents;
- TTS, captions, audio queues, and reconnect; and
- durable operational state and observability.

The governing requirements, release gates, and package plan are recorded in
[RFC-021](./rfcs/rfc-021-room-agents.md).
