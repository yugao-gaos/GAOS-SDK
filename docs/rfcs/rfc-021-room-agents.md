# RFC-021 — In-room agents and audience interaction

Status: **implemented provider-neutral contract and runtime** · Ships in:
**v1.0** · Provider integration: host-owned · Depends on:
[RFC-003](rfc-003-information-partitions.md),
[RFC-006](rfc-006-session-kernel.md),
[RFC-013](rfc-013-ecosystem-bridges-and-benchmark-tooling.md),
[RFC-019](rfc-019-unified-actor-control-sources.md), and
[RFC-020](rfc-020-unified-command-effects.md)

## 1 — Goal

GAOS games may place one or more conversational agents in a hosted room. An
agent may explain the game, perform a character, referee play, or participate
in a product-defined game mechanism. Players and non-playing audience members
may address those agents by text or through a host-owned push-to-talk,
speech-to-text, and text-to-speech pipeline.

This RFC makes room agents a first-class GAOS feature without creating a
second game SDK and without treating speech as reducer input.

## 2 — Decision

A room agent is a host-side conversational presence with an optional
`ControlSubject` binding:

- an unbound guide or host may speak but cannot propose a game action;
- an actor-bound character uses the RFC-019 NPC/actor seam;
- a seat-bound bot or referee uses the existing logical-seat authority seam;
- any proposed action remains untrusted until the ordinary GAOS host validates
  and admits it; and
- room speech, model memory, audio, and provider state never enter reducer
  state or portable replay merely because an agent produced them.

The room layer wraps the actor-control seam. It does not replace it:

```text
participant PTT/text
        │
        ▼
host STT + authenticated speaker
        │
        ▼
explicit room-agent routing ──────┐
        │                         │
        ▼                         ▼
  speech-only output       optional action proposal
        │                         │
        ▼                         ▼
host TTS/captions        control/authority validation
                                  │
                                  ▼
                              reducer/replay
```

## 3 — Relationship to NPCs and existing agents

GAOS does not define `NPC` as an SDK entity type. RFC-019 deliberately models
a neutral product actor and a replaceable behavior-tree, human, or agent
control source. `NPC` and `player` are product roles or presentation.

Room agents reuse that distinction. A character can be bound to
`{ kind: 'actor', actorId, seat? }`; a player bot can be bound to
`{ kind: 'seat', seat }`; a guide needs neither. Several room agents may be
registered at once and addressed independently.

The existing “NPC conversation” recording shows authored dialogue selected
through the product UI. It is not a model conversation or voice runtime. A
game may use both: the room agent performs or explains the character, while a
game-significant dialogue choice remains an ordinary validated command.

The existing `AgentDriver` remains action-oriented: every `AgentDecision`
contains a canonical action. It is not weakened to accommodate speech-only
turns. `RoomAgentDriver` is the companion conversational boundary and may
return utterances, one optional action, or `null`.

## 4 — Rules and observations

The authoritative rules remain the product's `GameDefinition` or reducer.
Legal commands show what can happen now, but they are not enough to explain
the game's terminology, intent, or rationale. A product therefore supplies a
versioned `GameAgentManifest` alongside its game adapter. It contains authored
rule sections, an optional glossary, and optional typed knowledge.

The manifest is explanatory input, not authority. Rule sections describe
player-facing rules; optional mechanism sections describe product-authored
systems and may reference the canonical action IDs they explain. The product
exports this data beside the implementing adapter and checks its game ID and
version when registering the game. The SDK does not inspect bundled client
source at runtime. If manifest prose and reducer behavior disagree, reducer
validation wins.

Every invocation also receives a host-supplied observation. The host must
choose the appropriate projection:

- public or delayed spectator view for an audience-facing guide;
- `viewFor(state, seat)` for a seat-bound agent; or
- a product-owned actor projection no more privileged than the authorizing
  seat for an actor-bound character.

A behavior tree or model running inside the host receives no automatic right
to full state.

## 5 — Audience semantics

Room presence and command authority are separate. `RoomParticipant.role` and
its optional seat are descriptive input from the authenticated host; they do
not change `SeatControlLedger` and do not authorize a command.

An audience member is a spectator by default. They may speak to room agents,
receive public responses, and take part in host-owned polls without becoming a
logical seat. If crowd activity affects gameplay, the product must define a
deterministic mechanism. A typical host aggregates the poll, then submits one
canonical command through a predeclared service or crowd seat. The accepted
effect is validated and replayed like any other game consequence.

Dynamic audience members must not be represented as dynamically created game
seats. GAOS session rosters remain fixed.

## 6 — Common room interactions

`RoomInteractionEnvelope` is the common operational message shape around the
room-agent registry. It carries an authenticated source, explicit targets, a
room and channel, a typed payload, maximum participant-visible disclosure, and
root/parent/hop causation. Producers return drafts; the router alone assigns
IDs and derives causation.

Endpoints are participants, agents, services, or watchers. Payloads are:

- messages for participant-to-agent, agent-to-agent, and generated speech;
- typed events for committed watcher output and vote results;
- correlated service requests; and
- correlated service results.

This supports six v1.0 patterns without making the router a workflow engine:

1. A guide answers rules and mechanism questions from the versioned manifest,
   its scoped observation, and current legal actions.
2. Character agents exchange explicitly targeted messages; product persona is
   resolved privately by each driver from its stable `personaId`.
3. An agent invokes only services named by its descriptor. Services return
   data, never reducer mutations or action proposals.
4. A watcher receives a host-supplied projection after a committed transition
   and emits typed event drafts once per room revision.
5. A pure resolver tallies eligible participant ballots, rejects duplicates,
   and applies an explicit deterministic tie-break before publishing a result
   event for an agent to narrate.
6. A participant and agent use a private channel whose response disclosure
   cannot widen beyond that participant set.

The router uses a FIFO delivery queue, rejects unknown or implicit targets,
deduplicates envelope IDs, and bounds derived chains to eight hops by default.
Products should also set a per-root emission budget in the host when fan-out
is possible. Drivers do not recursively dispatch from inside delivery; they
return drafts for the host to derive and enqueue.

`channelId` is an isolation boundary, not only a delivery label. Provider
memory for a public room, a private participant-to-agent thread, and an
internal agent-to-agent exchange must remain separate. Effective disclosure
is the intersection of parent disclosure, agent visibility, product policy,
and requested output audience. An utterance, service result, or watcher event
may narrow visibility but never widen it. Watchers only receive an explicit
redacted committed-state projection; they do not wildcard-read room traffic.
Derived source identity must be one of the parent's delivered targets. A
non-public chain cannot add a new agent or watcher; the host must start a new
explicitly authorized root when product policy permits that disclosure.

## 7 — Routing and voice ownership

Core routing is explicit. The host chooses the target agent ID or IDs from
mentions, UI focus, proximity, phase policy, or a fallback guide. The SDK does
not run an LLM router and does not cause every registered agent to answer a
broadcast. This keeps activation policy observable and product-owned.

The v1.0 runtime starts at final authenticated text and ends at
provider-neutral utterance text plus voice identity. It owns:

- explicit mention/focus/phase/fallback routing;
- exact transcript boundaries partitioned by channel ID;
- response interruption and stale-response cancellation;
- speech arbitration when several agents are eligible;
- speech and caption adapter invocation;
- serializable registration, focus, phase, and reconnect state; and
- text-free operational lifecycle events.

The host owns hold-to-talk floor control, audio segmentation, STT and final
transcript production, authenticated speaker presence, concrete TTS/audio
delivery, the durable store implementation, and provider conversation objects.
The runtime supplies the selected channel transcript to the product context
source so private and public model memory cannot be mixed by default.

Provider clients, sockets, audio streams, and conversation objects are not
stored in reducer state.

## 8 — v1.0 package boundary

The GAOS package exports the agent registry and driver contracts from
`@yugao-gaos/gaos-sdk/room-agent`, and the operational envelope, router,
services, watchers, and vote resolver from
`@yugao-gaos/gaos-sdk/room-interaction`. Both are browser-safe and
provider-neutral. The same package exports the orchestration state machine from
`@yugao-gaos/gaos-sdk/room-agent-runtime`.

The package family is:

- `@yugao-gaos/gaos-sdk/room-agent` — stable core contract;
- `@yugao-gaos/gaos-sdk/room-interaction` — stable routing and interaction
  mechanisms;
- `@yugao-gaos/gaos-sdk/room-agent-runtime` — stable room lifecycle and
  orchestration; and
- provider adapters such as STT, TTS, and model integrations behind runtime
  interfaces.

This is one SDK product with optional packages, not two competing rule or
session SDKs.

## 9 — Delivery plan

### Gate A — v1.0 contract foundation

- [x] Room participant, input, agent, utterance, and turn contracts.
- [x] Versioned product-owned game-agent manifest.
- [x] Multiple-agent registry with explicit per-agent invocation.
- [x] Speech-only agents and actor/seat-bound optional action proposals.
- [x] Cancellation and stale-result rejection on replacement/unregistration.
- [x] Dedicated `./room-agent` export, API report, tests, and documentation.
- [x] Common explicit interaction envelope with privacy and causation guards.
- [x] Agent-to-agent messages and private participant channels.
- [x] Capability-checked agent services and committed-transition watchers.
- [x] Pure deterministic audience-vote resolution.
- [x] Dedicated `./room-interaction` export, API report, tests, and docs.
- [ ] First demo-game adapter declares a manifest and at least two room agents.

### Gate B — generic room runtime

- [x] Define host adapter seams for final transcripts, speech, captions, and
      reconnect without provider or product policy.
- [x] Persist room-agent registrations and exact transcript boundaries through
      a host store, partitioned by channel ID.
- [x] Implement explicit mention/focus/phase routing and one room speech
      arbiter.
- [x] Add structured text-free lifecycle observability for duration,
      completion, cancellation, provider errors, and reconnect without replay.
- [x] Add retry-safe input ingestion, stale-turn cancellation, caption
      lifecycle, serializable state, and reconnect tests.

### Gate C — game-mechanism validation

- [ ] A guide answers a rules question from public state without an action.
- [ ] Two character agents coexist and retain separate identity, memory, and
      voice.
- [ ] One character proposes an actor-scoped action that passes normal game
      validation and appears in replay.
- [ ] A malformed model action is rejected by ordinary authority and command
      checks.
- [ ] Audience voting produces no game mutation until an authorized aggregated
      command is accepted.

The v1.0 release candidate may freeze the core API after Gate A. The feature is
production-ready only for a concrete host after that host also passes Gates B
and C.

## 10 — Compatibility and security invariants

1. `AgentDriver`, `ControlSource`, reducer, session, and replay formats retain
   their current meaning.
2. A room-agent registration or role is not an authorization credential.
3. An unbound room agent cannot return an action proposal.
4. An action that names a conflicting seat is rejected before handoff.
5. The room-agent registry never submits, commits, or applies an action.
6. The host revalidates every proposal against current state, participation,
   controller epoch, command schema, and idempotency rules.
7. Speech-only turns do not invent `wait`, `talk`, or other reducer actions.
8. Full state, hidden observations, raw provider responses, and secrets do not
   become audience-visible through a default projection.
9. Replacing or unregistering an agent aborts and discards its in-flight turn.
10. Runtime voice/provider packages cannot become dependencies of the
    browser-safe SDK root.
11. Every interaction has explicit targets; there is no implicit all-agent
    broadcast.
12. Derived interactions and utterances can only narrow participant-visible
    disclosure.
13. Services, watchers, participant roles, and vote results grant no game
    authority.
14. Watchers observe committed projections, not draft transitions or arbitrary
    private traffic.
15. Provider memory is partitioned by channel so delivery clamping cannot leak
    facts retained from a more privileged thread.

## 11 — Rejected alternatives

### Make every room agent an NPC

Rejected. A guide or moderator may have no in-world actor and no game
authority. NPC is one optional binding.

### Make every audience member a seat

Rejected. Audience presence is dynamic and potentially unbounded, while GAOS
seat rosters and evidence identities are fixed for a session.

### Make `AgentDecision.action` optional

Rejected. It would weaken an established action-oriented API. The companion
room-agent driver expresses speech-only turns without changing agent episode
semantics.

### Put STT, TTS, or model providers in the core SDK

Rejected. Provider and transport dependencies would violate the portable
browser/edge boundary and force games that do not use voice to install them.

### Treat agent speech as replay input

Rejected by default. Speech is presentation and operational state. A game may
define an explicit deterministic dialogue or crowd command when spoken content
has authoritative consequences.

### Let a model route, tally votes, or mutate game state

Rejected. Routing targets are product-owned, votes are resolved by a pure
deterministic function, and gameplay consequences remain canonical commands
admitted through the existing authority boundary.

### Parse client source to answer questions

Rejected. Runtime source is bundler-dependent, may expose secrets, and cannot
establish authority. Products publish versioned explanatory manifests beside
the code they implement.
