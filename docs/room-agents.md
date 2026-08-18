# Room agents

GAOS room agents are conversational room presences that may optionally control
a game actor or logical seat. A room can contain a rules guide, referee,
several voiced characters, and player bots without giving every agent the same
authority or observation.

The portable API is exported from `@yugao-gaos/gaos-sdk/room-agent`. Voice,
network, persistence, and model providers remain host-owned runtime concerns.

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

The manifest may be shared by several agents. Character-specific secrets
belong in the scoped observation or product knowledge projection supplied to
that invocation, not in a public guide's manifest.

## Audience interaction

Audience members remain spectators. They can ask questions and participate in
host-owned polls without becoming GAOS seats. If a crowd decision changes the
game, the product defines that consequence as a command and an authorized
service or crowd controller submits the aggregate. Only the accepted command
enters reducer state and replay.

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
