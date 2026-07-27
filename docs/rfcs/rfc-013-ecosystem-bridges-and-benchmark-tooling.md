# RFC-013 — Ecosystem and benchmark foundations

Status: **implemented in v0.22.0** · Target: v0.22 ·
Compatibility: additive APIs; existing sessions and artifacts remain supported ·
Depends on: RFC-006, RFC-010, RFC-012 ·
Continued by: [RFC-014](rfc-014-interoperability-and-dynamic-control-evidence.md)
and [RFC-015](rfc-015-verifiable-benchmark-publication.md)

## 1 — Purpose

GAOS has a deliberate boundary: it owns deterministic game logic, execution,
agent-facing environments, and portable evidence. It does not own networking,
matchmaking, rendering, model training, benchmark meaning, or a universal
leaderboard.

v0.22 establishes the portable contracts on which later ecosystem and
benchmark work depends:

1. a transport-neutral host lifecycle and presentation frame;
2. auditable controller epochs over stable logical seats;
3. formal game, chance, observation, information-state, and policy
   descriptors;
4. deterministic benchmark manifests, episode planning, aggregation, and
   distinct trust claims.

RFC-014 adds interoperability and cryptographic dynamic-control evidence as a
historical v0.23 compatibility milestone, and RFC-015 adds the executable
benchmark and publication path. Both are incorporated into the official
v0.24 release. Those RFCs inherit the product boundary below rather than
redefining it.

## 2 — Product boundary

The SDK owns:

- pure deterministic reducers and canonical input ordering;
- sequential, simultaneous, and fixed-tick execution;
- prepared persist-before-publish session transitions;
- per-seat observations and information-leak checks;
- agent environments and concrete legal actions;
- ordered seat-control authority and its evidence consequences;
- replay, signatures, evidence packaging, and offline verification;
- reusable, product-neutral game mechanisms.

Integrating products and services own:

- authentication, accounts, presence, lobbies, and matchmaking;
- socket transport, relay, topology, server allocation, and autoscaling;
- storage engines and operational retention policy;
- rendering, animation, audio, input devices, and editor tooling;
- model inference, training, prompts, and experiment tracking;
- turn order, stages, lifecycle conditions, undo policy, and reducer
  composition;
- join eligibility, disconnect grace periods, vacancy gameplay effects, and
  account-to-controller identity;
- benchmark tasks, scoring meaning, held-out content, eligibility, and
  publication policy;
- seasons, rankings, moderation, and commercial rules.

An integration guide may show how those responsibilities compose. It must not
move them into the GAOS core.

## 3 — Hosting and presentation foundations

### 3.1 Normative host lifecycle

Every host maps its platform onto one lifecycle:

```text
authenticate connection
        ↓
assign or resume a controller epoch for a declared seat
        ↓
receive and validate a canonical command
        ↓
prepare → persist → commit
        ↓
publish a seat-scoped observation or repair
        ↓
checkpoint / reconnect / terminate
        ↓
finalize portable replay evidence
```

`SessionHostDriver` is the transport-neutral contract around the session
kernel. Its required semantics are:

- one serialized transition lane per session;
- conflict-detecting idempotency;
- persist before publish;
- explicit timeout escalation;
- stable logical seats and ordered controller epochs;
- seat-scoped observation delivery;
- repair from an acknowledged revision;
- replay finalization from the complete durable evidence stream.

The contract does not prescribe sockets, authentication, matchmaking, storage,
presence, or server allocation. RFC-012 checkpoint and compaction contracts
join this lifecycle. RFC-014 defines the executable host conformance kit and
the platform-specific composition guides.

### 3.2 Presentation frame

GAOS does not ship a renderer. It ships a stable projection boundary:

```ts
interface PresentationFrame<TView, TEvent> {
  tick: number;
  transitionRevision: number;
  view: TView;
  events: readonly TEvent[];
  stateDigest?: string;
  repair?: boolean;
}
```

- `view` is the current seat-scoped state.
- `events` are deterministic presentation hints such as move, reveal, attack,
  score, spawn, and removal.
- `transitionRevision` drives acknowledgement and repair.
- `stateDigest` supports diagnostics and lockstep comparison.
- `repair` tells the client to reconcile durable state without replaying old
  presentation cues.

Presentation-event identities must be stable across retry and reconnect so a
client does not repeat an animation or sound. v0.22 ships the
`gaos.presentation-frame-v1` schema and golden fixture. RFC-014 builds the
cross-language client surface on this contract.

## 4 — Stable seats and controller epochs

Turn order, per-seat stages, lifecycle conditions, undo policy, and reducer
composition remain product-owned. GAOS standardizes only their externally
observable participation, legal-action, replay, and evidence consequences.

### 4.1 Stable seat, changing controller

The contracts distinguish:

- **logical seat** — stable game identity declared when the kernel is created;
- **controller** — a human, agent, or service currently authorized to submit
  for a logical seat;
- **connection** — host-owned transport state, never kernel identity;
- **participation** — reducer-projected game policy describing which logical
  seats may act.

The logical seat set remains fixed. Controllers may become vacant, reconnect,
be replaced, or transfer between seats at a transition boundary.

Adding or removing logical seats changes the game shape, observation
partitions, and potentially utility semantics. Products that need variable
player count may declare a maximum stable seat set and make seats dormant
through reducer state and `Participation`. A mutable kernel seat set is a
separate future design.

### 4.2 Seat-control epochs

Each period of authority is a versioned epoch:

```ts
type SeatControllerKind = 'human' | 'agent' | 'service';

interface SeatController {
  controllerId: string;
  kind: SeatControllerKind;
  publicKey?: string;
  signingTier?: SubmissionSigningTier;
}

interface SeatControlEpoch {
  seat: string;
  epoch: number;
  status: 'occupied' | 'vacant';
  controller?: SeatController;
  effectiveTransitionRevision: number;
  reason:
    | 'genesis'
    | 'released'
    | 'disconnected'
    | 'reconnected'
    | 'substituted'
    | 'transferred'
    | 'revoked';
  authorization: 'genesis' | 'controller-handoff' | 'host-policy';
  previousEpochDigest?: string;
}
```

The invariants are:

- epochs are consecutive per seat and never overlap;
- at most one controller is authoritative for one seat at a revision;
- a new key or controller always starts a new epoch;
- reconnecting the same controller with the same key does not require a new
  epoch;
- vacancy is explicit, not inferred from missing commands;
- a multi-seat transfer or swap commits atomically;
- `controllerId` is opaque product identity and proves no real-world identity;
- every accepted command names or unambiguously resolves to its active epoch.

A product may intentionally allow one agent to control several seats. GAOS
does not impose controller uniqueness across seats.

### 4.3 Ordered non-gameplay transitions

`SeatControlLedger.prepareSeatControl` follows the same
prepare → persist → commit → publish discipline as other session transitions.
It advances `transitionRevision`, is retained in checkpoint evidence, and
applies multi-seat changes atomically.

Changing command authority does not by itself call the reducer, advance the
gameplay cursor, or change the seat's observation. If vacancy, replacement, or
transfer affects game state, the product represents that effect with an
ordinary deterministic command. Examples include auto-wait, elimination,
entity transfer, pause, or enabling an AI driver.

This separation keeps nondeterministic connection state out of the reducer
while making command authority auditable.

### 4.4 Dropout, drop-in, reconnect, and authorization labels

A transport disconnect alone does not determine game policy:

1. The host may retain the controller epoch during a grace period.
2. Reconnection with the same controller and key resumes that epoch.
3. When policy revokes control, the host commits a vacant or replacement
   epoch.
4. A bot or replacement human starts a new epoch.
5. A later returning player starts another epoch unless the previous epoch was
   never revoked.

The product decides the grace period, eligibility, whether play pauses, and
what gameplay command follows. The evidence records the chosen authority
transition and any resulting gameplay command separately.

Control records distinguish `controller-handoff` from `host-policy`.
The ledger requires outgoing and incoming signature material for a claimed
controller handoff and preserves that material with digest continuity.
Host-policy changes instead record the declared policy. v0.22 does not
cryptographically verify either claim or reinterpret the RFC-010 v1 signature
scheme. RFC-014 defines signed handoffs, signature v2, replay integration, and
offline verification.

Checkpoint rehydration must reject missing, duplicated, non-consecutive, or
conflicting epochs. Observation delivery remains scoped to logical seats. The
host binds a connection to the currently authorized controller and one or more
seat scopes; changing connections alone does not alter evidence.

## 5 — Formal game and research contracts

GAOS makes game capabilities machine-readable without becoming an algorithm or
training framework.

### 5.1 Game descriptor

```ts
interface GameDescriptor {
  id: string;
  version: string;
  dynamics: 'sequential' | 'simultaneous' | 'mixed';
  chance: 'none' | 'explicit' | 'sampled';
  information: 'perfect' | 'imperfect';
  utility: 'zero-sum' | 'constant-sum' | 'general-sum' | 'identical';
  rewards: 'terminal' | 'incremental';
  minPlayers: number;
  maxPlayers: number;
  minUtility?: number;
  maxUtility?: number;
  maxEpisodeLength?: number;
}
```

Descriptors let tooling reject incompatible metrics or algorithms before a run
starts and provide stable discovery metadata. A descriptor describes a
contract; it does not prove the implementation satisfies it. Conformance tests
provide that evidence.

### 5.2 Explicit chance

Seeded randomness remains the ordinary replay mechanism. Games that need exact
analysis may expose explicit chance outcomes:

```ts
interface ChanceOutcome {
  action: SubmittedAction;
  probability: number;
}
```

An optional `chanceOutcomes(state)` contract must:

- return a finite canonically ordered distribution;
- use non-negative finite probabilities summing to one within a declared
  tolerance;
- apply each outcome deterministically;
- identify chance separately from a human or agent seat.

### 5.3 Observation and information state

`viewFor(state, seat)` remains the current seat observation. Imperfect-
information research may also expose a perfect-recall information state:

```ts
interface GameObserver<TState, TObservation, TInformationState> {
  observe(state: TState, seat: string): TObservation;
  informationState?(history: GameHistory, seat: string): TInformationState;
  publicObservation?(state: TState): unknown;
  privateObservation?(state: TState, seat: string): unknown;
}
```

The contract must define:

- whether observations are Markov or history-dependent;
- whether the information state has perfect recall;
- how public and private components factor;
- stable string or tensor encodings when supplied;
- conformance tests for indistinguishable hidden states and information leaks.

### 5.4 Policy distribution and shipped metrics

Agent drivers may continue returning one action. An optional policy contract
returns a distribution over concrete legal actions:

```ts
interface Policy<TObservation> {
  distribution(
    observation: TObservation,
    legalActions: readonly SubmittedAction[],
  ): Promise<readonly {
    action: SubmittedAction;
    probability: number;
  }[]>;
}
```

The environment validates normalization, legality, duplicate actions, and
deterministic sampling from the episode seed. v0.22 also ships policy entropy
and win-rate confidence intervals. RFC-015 defines the remaining metrics and
transforms.

## 6 — Neutral benchmark foundations

### 6.1 Benchmark manifest

A versioned manifest identifies:

- benchmark id and version;
- pinned game and adapter identity;
- tasks and seed plan;
- episode count and maximum steps;
- observation modalities;
- agent interface;
- scoring plugin and aggregation rule;
- signing requirements;
- required task coverage;
- resource or token budgets when applicable.

The SDK validates the manifest, deterministically expands its task/seed/episode
plan, and deterministically aggregates complete task scores. The benchmark
product owns task selection, score meaning, weights, held-out content,
eligibility, and publication policy.

### 6.2 Trust claims

Tooling must represent distinct claims:

| Claim | Meaning | GAOS can establish directly |
|---|---|---|
| Evidence verified | Recorded inputs reproduce the recorded outcomes and scores | yes |
| Organizer reproduced | An organizer reran the submitted agent | no |
| Open implementation | Source for the agent strategy is public | metadata only |
| Model identity attested | A trusted party establishes which model produced outputs | no |
| Hidden-test compliant | A trusted operator establishes that evaluation content was withheld | no |

An entry may display several labels. No single checkmark may imply all five.
RFC-015 applies these claims to portable submissions and the leaderboard
starter.

## 7 — Compatibility and versioning

The v0.22 host, presentation, research, seat-control-ledger, and benchmark
contracts are additive. Existing reducers, agent environments, fixed-roster
sessions, and replay artifacts remain valid and retain their existing
interpretation.

New wire objects require explicit schema ids and versions. Exact package names
and CLI spellings proposed by later RFCs remain provisional until their
implementation review. Normative invariants and ownership boundaries are the
accepted design content.

## 8 — Out of scope

RFC-013 does not add:

- accounts, lobbies, matchmaking, or a hosted multiplayer service;
- a renderer, editor extension, animation system, or asset pipeline;
- a second simulation authority beside a reducer;
- a general reinforcement-learning or model-training framework;
- a built-in catalogue of research algorithms;
- an official benchmark, universal score, or official leaderboard;
- proof of model identity, prompt secrecy, wall-clock fairness, or held-out
  content;
- SDK-owned turn order, per-seat stages, lifecycle conditions, undo policy, or
  generic reducer middleware;
- adding or removing logical kernel seats after session creation;
- mutable signed history.

The result is a stable v0.22 foundation. RFC-014 and RFC-015 complete the
roadmapped interoperability, evidence, execution, and publication layers
without expanding this boundary.
