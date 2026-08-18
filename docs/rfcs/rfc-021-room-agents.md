# RFC-021 — In-room agents and audience interaction

Status: **implemented contract foundation** · Ships in: **v1.0** · Runtime
integration: staged behind this contract · Depends on:
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

The manifest is explanatory input, not authority. If its prose and reducer
disagree, reducer validation wins.

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

## 6 — Routing and voice ownership

Core routing is explicit. The host chooses the target agent ID or IDs from
mentions, UI focus, proximity, phase policy, or a fallback guide. The SDK does
not run an LLM router and does not cause every registered agent to answer a
broadcast. This keeps activation policy observable and product-owned.

The v1.0 core contract starts at final authenticated text and ends at
provider-neutral utterance text plus voice identity. The optional room runtime
owns:

- hold-to-talk floor control and audio segmentation;
- STT and final-transcript production;
- speaker attribution, presence, reconnect, and text fallback;
- per-agent memory and provider conversations;
- response interruption and stale-response cancellation;
- speech arbitration when several agents are eligible;
- TTS, audio queues, captions, and broadcast delivery; and
- durable operational state and provider usage metadata.

Provider clients, sockets, audio streams, and conversation objects are not
stored in reducer state.

## 7 — v1.0 package boundary

The GAOS package exports the provider-neutral contracts and registry from
`@yugao-gaos/gaos-sdk/room-agent`. It depends only on existing browser-safe
GAOS control and action contracts.

Concrete hosting and voice implementations remain optional packages. The
recommended package family is:

- `@yugao-gaos/gaos-sdk/room-agent` — stable core contract;
- `@yugao-gaos/room-agent-runtime` — room lifecycle and orchestration; and
- provider adapters such as STT, TTS, and model integrations behind runtime
  interfaces.

This is one SDK product with optional packages, not two competing rule or
session SDKs.

## 8 — Delivery plan

### Gate A — v1.0 contract foundation

- [x] Room participant, input, agent, utterance, and turn contracts.
- [x] Versioned product-owned game-agent manifest.
- [x] Multiple-agent registry with explicit per-agent invocation.
- [x] Speech-only agents and actor/seat-bound optional action proposals.
- [x] Cancellation and stale-result rejection on replacement/unregistration.
- [x] Dedicated `./room-agent` export, API report, tests, and documentation.
- [ ] First demo-game adapter declares a manifest and at least two room agents.

### Gate B — generic room runtime

- [ ] Extract the push-to-talk, STT, interruption, TTS, captions, and reconnect
      pipeline from the prior room implementation without sportsbook policy.
- [ ] Persist room-agent registrations, transcript boundaries, and per-agent
      operational memory durably.
- [ ] Implement explicit mention/focus/phase routing and one room speech
      arbiter.
- [ ] Add structured observability for latency, cancellation, provider errors,
      and usage without placing it in game replay.

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

## 9 — Compatibility and security invariants

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

## 10 — Rejected alternatives

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
