# RFC-013 — Ecosystem bridges, dynamic seat control, and verifiable benchmark tooling

Status: **proposed for staged v0.22+ delivery** · Target: v0.22 and later ·
Compatibility: additive APIs plus a new evidence/signature format for dynamic
seat control; existing sessions and artifacts remain supported · Depends on:
RFC-006, RFC-010, RFC-012

GAOS has a deliberate boundary: it owns deterministic game logic, execution,
agent-facing environments, and portable evidence. It does not own networking,
matchmaking, rendering, model training, benchmark meaning, or a universal
leaderboard.

That boundary is correct, but independent adoption still requires bridges into
the systems that own those surrounding responsibilities. The SDK also needs
formal seat-control and research contracts where independently implemented
versions would otherwise produce incompatible evidence.

This RFC proposes five related additions:

1. hosting and transport integration contracts;
2. presentation projections and engine-client fixtures;
3. dynamic controller occupancy over stable logical seats;
4. formal game, chance, observation, information-state, and policy descriptors;
5. neutral benchmark, submission, verification, and leaderboard tooling.

The proposal is intentionally staged. It defines boundaries and acceptance
criteria before choosing exact package names or promising that every item ships
in one release.

---

## 1 — Preserve the product boundary

The SDK continues to own:

- pure deterministic reducers and canonical input ordering;
- sequential, simultaneous, and fixed-tick execution;
- prepared persist-before-publish session transitions;
- per-seat observations and information-leak checks;
- agent environments and concrete legal actions;
- ordered seat-control authority and its evidence consequences;
- replay, signatures, evidence packaging, and offline verification;
- reusable, product-neutral game mechanisms.

Integrating products and services continue to own:

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

---

## 2 — Hosting and transport bridges

### 2.1 One normative host lifecycle

Every hosting guide should map its platform onto one lifecycle:

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

The normative bridge is a small host-driver contract around the session
kernel. It does not prescribe sockets or storage:

```ts
interface SessionHostDriver<TCommand, TView> {
  create(input: HostCreateInput): Promise<HostedSession<TCommand, TView>>;
  control(sessionId: string, input: HostSeatControl): Promise<void>;
  ingest(sessionId: string, input: HostSubmission<TCommand>): Promise<void>;
  advance(sessionId: string, tick: number): Promise<void>;
  snapshot(sessionId: string, seat: string, afterRevision?: number):
    Promise<HostObservation<TView>>;
  terminate(sessionId: string, reason: string): Promise<HostArtifact>;
}
```

The exact public shape remains an implementation decision. The required
semantics do not:

- one serialized transition lane per session;
- conflict-detecting idempotency;
- persist before publish;
- explicit timeout escalation;
- stable logical seats and ordered controller epochs;
- seat-scoped observation delivery;
- repair from an acknowledged revision;
- replay finalization from the complete durable evidence stream.

RFC-012 checkpoint and compaction contracts join this lifecycle once shipped.

### 2.2 Classify integrations before documenting them

Integration documentation must identify which of three categories applies.

#### Direct host

The platform can execute the GAOS TypeScript core inside its authoritative
match runtime. Its match lifecycle invokes the host driver directly.

The first direct-host guides should cover:

- a TypeScript authoritative match runtime with authentication, matchmaking,
  presence, storage, and fixed-rate match callbacks;
- a Node.js room server with authoritative state and generated engine clients;
- a minimal Node.js HTTP/WebSocket reference host.

Nakama and Colyseus are the initial named guides in these categories. Each
guide must identify runtime restrictions, supported cryptography, persistence
behavior, and whether the full evidence stack can execute in-process.

#### Transport or orchestration layer

The platform moves inputs and observations or allocates authoritative server
processes, but the GAOS kernel runs in a separate Node.js process or service.

The guide must specify:

- command and observation envelopes;
- seat identity propagation;
- ordering and retry behavior;
- backpressure and maximum payload assumptions;
- reconnect and repair flow;
- which process owns durable evidence.

#### Alternate simulation core

Some platforms already own deterministic simulation, input synchronization,
prediction, rollback, and verified frames. Running an independent GAOS reducer
beside that simulation would create two authorities.

Photon Quantum belongs in this category. Its guide must present two honest
options:

1. use GAOS as the simulation core and choose a transport that does not replace
   it; or
2. use the external simulation core and implement a GAOS-compatible evidence
   adapter over confirmed inputs, pinned simulation identity, frame digests,
   and final results.

The second option does not claim that a GAOS reducer reproduced the run unless
it actually did. Its artifact and verifier must distinguish native GAOS replay
from externally adapted evidence.

Photon Fusion belongs primarily in the transport and authoritative-hosting
discussion. A headless engine server or sidecar may carry GAOS commands and
views, but the guide must name the actual state authority and avoid duplicated
simulation.

### 2.3 Host conformance kit

The SDK should ship transport-neutral conformance scenarios for:

- byte-identical retry versus conflicting event reuse;
- crash before persistence, after persistence, and after commit;
- publish retry after durable commit;
- stale prepared transition rejection;
- timeout transition handling;
- acknowledgement, rejection, and reconnect repair;
- observation patch without a base snapshot;
- dropout, drop-in, reconnect, substitution, transfer, and atomic seat swap;
- rejection of a command signed by an inactive controller epoch;
- checkpoint restore and retention-floor behavior;
- artifact finalization and independent verification.

Adapters pass the same fixtures regardless of their networking or storage
technology.

---

## 3 — Presentation projections and engine clients

GAOS should not ship a renderer. It should ship the stable data boundary from
which a renderer can be built.

### 3.1 Presentation frame

A presentation projection separates durable state from transient cues:

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
client does not repeat an animation or sound.

### 3.2 Cross-language client surface

The SDK should publish:

- JSON Schema for commands, receipts, snapshots, patches, presentation frames,
  and replay references;
- generated or hand-maintained TypeScript, C#, C++, and GDScript-compatible
  data types;
- golden fixtures decoded by every supported language;
- a portable client state machine for snapshot, patch, acknowledgement,
  rejection, digest mismatch, and repair;
- examples that project stable entity identities into engine-native objects.

Initial rendering guides should cover:

- Unity: C# client, GameObject projection, animation queue, and reconnect;
- Godot: GDScript and C# clients, scene/node projection, and WebSocket use;
- Unreal Engine: C++ client, Actor/UObject projection, Blueprint events, and
  the boundary with native replication.

The examples render one shared reference game. They do not create a general UI
framework or prescribe art, camera, animation, or input architecture.

---

## 4 — Dynamic seat control

Turn order, per-seat stages, lifecycle conditions, undo policy, and reducer
composition remain product-owned. GAOS standardizes only their externally
observable participation, legal-action, replay, and evidence consequences.

Mid-game control changes cross that boundary. A verifier must know which key
was authorized to submit for a seat at each point in the run. Independent
hosts cannot invent different answers without producing incompatible evidence.

### 4.1 Stable seat, changing controller

This RFC distinguishes:

- **logical seat** — stable game identity declared when the kernel is created;
- **controller** — a human, agent, or service currently authorized to submit
  for a logical seat;
- **connection** — host-owned transport state, never kernel identity;
- **participation** — reducer-projected game policy describing which logical
  seats may act.

The logical seat set remains fixed for this proposal. Controllers may become
vacant, reconnect, be replaced, or transfer between those seats at any
transition boundary.

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

Names are provisional. The invariants are not:

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

### 4.3 Ordered non-gameplay transition

The kernel should expose a prepared seat-control transition, provisionally:

```ts
kernel.prepareSeatControl({
  changes: readonly SeatControlChange[],
  authorization: SeatControlAuthorization,
});
```

It follows the same prepare → persist → commit → publish discipline as other
session transitions. It advances `transitionRevision`, is retained in
checkpoint and replay evidence, and is applied atomically.

Changing command authority does not by itself call the reducer, advance the
gameplay cursor, or change the seat's observation. If vacancy, replacement, or
transfer affects game state, the product represents that effect with an
ordinary deterministic command. Examples include auto-wait, elimination,
entity transfer, pause, or enabling an AI driver.

This separation keeps nondeterministic connection state out of the reducer
while making command authority auditable.

### 4.4 Dropout, drop-in, and reconnect

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

### 4.5 Handoff authorization

Control changes have two distinguishable authorization modes.

#### Controller-authorized handoff

When the outgoing controller is available, it signs a handoff over:

- session and logical seat;
- outgoing epoch and its latest chain head;
- incoming epoch number, controller id, and public key;
- effective transition revision.

The incoming controller signs acceptance of the same handoff. This proves
continuity between the two controller epochs without claiming who either
controller is in the real world.

#### Host-policy transition

Abrupt dropout, moderation, timeout, or recovery may make outgoing consent
impossible. The host may revoke, vacate, or reassign the seat under declared
product policy. The transition is recorded as `host-policy`, not presented as
a controller-authorized handoff.

An auditor can therefore distinguish voluntary transfer from authoritative
replacement. Whether a host-policy replacement is acceptable for a scored run
is benchmark or product policy. The record proves only which authority schedule
the artifact declares and which epoch keys authored later commands. It does not
prove that a disconnect occurred, that the host followed its external account
policy, or that replacement was justified. Those remain host assertions.

### 4.6 Signature-chain evolution

RFC-010 binds one immutable seat-key roster into every v1 chain genesis. That
construction cannot authenticate a replacement key. Existing v1 artifacts
remain unchanged.

Dynamic control requires a new append-only signature scheme. Its exact domain
tag is an implementation decision; provisionally it is
`gaos.submission.ed25519.v2`.

Each controller epoch begins a new per-seat chain whose genesis binds:

- session and logical seat;
- epoch number and controller key;
- canonical seat-control transition digest;
- previous epoch digest;
- the last authenticated chain head from the previous epoch, when available.

An abrupt dropout may leave an unsigned tail after the previous periodic
signature. That tail is reported with the existing partial-evidence semantics;
it does not invalidate a correctly authorized replacement epoch.

The verifier must:

- resolve every signed command against the epoch active at its revision;
- reject signatures from a future, expired, or different-seat epoch;
- validate handoff and acceptance signatures when authorization claims them;
- identify host-policy transitions explicitly;
- verify epoch ordering and cross-epoch digest continuity;
- report unsigned or incompletely closed epoch tails without hiding them.

The evidence format must include the complete control history needed for this
check. A new format version is required; no v1.2 artifact is reinterpreted.

### 4.7 Checkpoint, recovery, and observation delivery

RFC-012 checkpoints must retain:

- the current epoch for every logical seat;
- controller keys and signing tiers;
- epoch and transition digests;
- the last chain head and periodic signature state;
- any prepared atomic multi-seat control change.

Rehydration must reject missing, duplicated, non-consecutive, or conflicting
epochs. Observation delivery remains scoped to logical seats. The host binds a
connection to the currently authorized controller and one or more seat scopes;
changing connections alone does not alter evidence.

### 4.8 Acceptance evidence

The conformance suite must cover:

- disconnect and same-key reconnect without an epoch change;
- explicit vacancy followed by a new human controller;
- human-to-agent and agent-to-human substitution;
- voluntary signed transfer;
- host-policy revocation and replacement;
- atomic two-seat swap;
- command at the exact revision before and after a handoff;
- stale outgoing-controller and premature incoming-controller rejection;
- incomplete periodic-signature tail at abrupt dropout;
- checkpoint and rehydrate across several epochs;
- TypeScript/Python verification parity and golden signature vectors.

RFC-012 §6 remains the v0.21 baseline: fixed seats and product-managed
occupancy. This section supersedes its future direction only when the new
control and evidence formats ship.

---

## 5 — Formal game and research contracts

GAOS should make game capabilities machine-readable without becoming an
algorithm or training framework.

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
starts. They also provide stable discovery metadata for benchmarks and game
registries. A descriptor describes a contract; it does not prove the
implementation satisfies it. Conformance tests provide that evidence.

### 5.2 Explicit chance

Seeded randomness remains the ordinary replay mechanism. Games that need exact
analysis may additionally expose explicit chance outcomes:

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

This enables exact tree search and probability analysis without requiring every
game to enumerate chance.

### 5.3 Observation and information state

`viewFor(state, seat)` remains the current seat observation. Imperfect-
information research may also need a perfect-recall information state.

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

### 5.4 Policy distribution

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
deterministic sampling from the episode seed.

### 5.5 Metrics and transforms

Ship research metrics in an optional package, beginning with broadly applicable
ones:

- win rate and confidence interval;
- head-to-head payoff matrix;
- action efficiency and invalid-action rate;
- policy entropy;
- rating-system adapters.

Best response, exploitability, equilibrium, and other formal metrics may follow
only when the game descriptor and policy contract establish their
preconditions.

Potential game transforms include simultaneous-to-sequential commitment form,
repeated games, start-from-state, cooperative centralized policy views, and
utility normalization. Transforms are lower priority than descriptors, chance,
observers, and conformance.

---

## 6 — Neutral benchmark toolkit

The SDK should make a benchmark easy to define and verify without defining what
the benchmark measures.

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

Example:

```yaml
benchmark:
  id: example-strategy
  version: 1.0.0
  adapter: sha256:...
tasks:
  - id: map-small
    seeds: [101, 102, 103]
    episodes: 3
    maxSteps: 500
scoring:
  plugin: ./score.mjs
  aggregation: weighted-mean
submission:
  requireSignedSeats: true
  requireCompleteCoverage: true
```

The SDK validates and executes the manifest. The benchmark product owns task
selection, score meaning, weights, held-out content, and eligibility.

### 6.2 Runner

The runner should support:

- sequential and bounded parallel execution;
- deterministic task and seed scheduling;
- local, provider-backed, and CLI agents;
- single-agent and multi-agent episodes;
- token, cost, step, and wall-clock observations;
- explicit invalid-action and timeout policy;
- checkpoints and resume;
- per-episode portable replay evidence;
- deterministic per-task and aggregate scoring.

Proposed CLI workflow:

```bash
gaos benchmark init
gaos benchmark run benchmark.yaml --agent ./agent.mjs
gaos benchmark resume ./runs/run-id
gaos benchmark pack ./runs/run-id
gaos benchmark verify submission.gaos-bench
```

Wall-clock and model-cost fields are operational observations unless a separate
trusted authority attests them.

### 6.3 Portable submission bundle

```text
submission.gaos-bench/
├── manifest.json
├── submission.json
├── episodes/
│   ├── task-a-seed-101.gaos-replay.jsonl
│   └── task-a-seed-102.gaos-replay.jsonl
├── scores.json
├── verification.json
└── README.md
```

Verification must:

1. validate manifest, game, adapter, and schema identities;
2. replay every included episode;
3. reconstruct terminal outcomes and replay metrics;
4. recompute per-task scores;
5. recompute aggregate scores;
6. verify submission chains when required;
7. reject missing or duplicate required episodes;
8. emit one machine-readable verdict with per-episode facts.

### 6.4 Do not overload “verified”

Leaderboard and submission tooling must represent distinct claims:

| Claim | Meaning | GAOS can establish directly |
|---|---|---|
| Evidence verified | Recorded inputs reproduce the recorded outcomes and scores | yes |
| Organizer reproduced | An organizer reran the submitted agent | no |
| Open implementation | Source for the agent strategy is public | metadata only |
| Model identity attested | A trusted party establishes which model produced outputs | no |
| Hidden-test compliant | A trusted operator establishes that evaluation content was withheld | no |

An entry may display several labels. No single checkmark may imply all five.

---

## 7 — Leaderboard starter, not an official leaderboard

GAOS should provide a deployable reference template containing:

- a static leaderboard frontend;
- submission and artifact metadata API;
- object-storage interface for evidence bundles;
- verifier worker queue;
- SQLite and PostgreSQL-compatible schema;
- benchmark-version and modality filters;
- aggregate and per-task score tables;
- uncertainty or error-bar fields;
- artifact download and local-verification instructions;
- the distinct trust labels from §6.4.

Minimum entry shape:

```ts
interface LeaderboardEntry {
  benchmarkId: string;
  benchmarkVersion: string;
  submissionId: string;
  agentName: string;
  modelClaim?: string;
  strategyName?: string;
  modality: string;
  aggregateScore: number;
  taskScores: Record<string, number>;
  uncertainty?: number;
  artifactDigest: string;
  evidenceVerdict: 'trusted' | 'unverifiable' | 'rejected';
  reproduced: boolean;
  openSourceUrl?: string;
}
```

The template does not create an official GAOS ranking. A product instantiates
it with an explicit benchmark manifest, governance policy, submission rules,
and scoring interpretation.

---

## 8 — Delivery sequence

### Stage A — Documentation and fixtures

1. Publish the generic host lifecycle.
2. Publish direct-host guides for Nakama, Colyseus, and plain WebSocket/HTTP.
3. Publish the Quantum and Fusion composition boundary.
4. Publish Unity, Godot, and Unreal presentation guides.
5. Add cross-language protocol fixtures and host conformance scenarios.

### Stage B — Dynamic seat control

1. Seat-control epochs and prepared atomic transitions.
2. Dropout, drop-in, reconnect, substitution, and transfer flows.
3. Handoff authorization and the next signature scheme.
4. Replay, checkpoint, verifier, and cross-language conformance support.

### Stage C — Research contracts

1. `GameDescriptor`.
2. Explicit chance.
3. Observer and information-state contracts.
4. Policy distributions.
5. Optional metrics and transforms.

### Stage D — Benchmark tooling

1. Manifest schema and validation.
2. Runner, resume, and deterministic aggregation.
3. Portable submission bundle and verifier.
4. Neutral leaderboard starter.

Each stage may ship independently after its public contracts and conformance
fixtures are stable.

---

## 9 — Compatibility and versioning

Host, presentation, research, and benchmark contracts are additive. Dynamic
seat control adds APIs but requires a new signature construction and evidence
format. Existing reducers, agent environments, fixed-roster sessions, and
replay artifacts remain valid and retain their existing interpretation.

New wire objects require explicit schema ids and versions. Generated
cross-language clients must preserve unknown optional fields during compatible
minor evolution where practical. A native-GAOS evidence bundle and an
externally adapted evidence bundle must never share an ambiguous format id.

Package names, CLI spellings, and exact type names in this RFC are provisional
until their implementation review. Normative invariants and ownership
boundaries are the accepted design content.

---

## 10 — Out of scope

This RFC does not add:

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

The intended result is narrower: make GAOS straightforward to host and render,
make mid-game controller changes auditable, describe games precisely enough
for research tooling, and let independent benchmark products publish scores
backed by replayable evidence.
