# RFC-013 — Ecosystem bridges, game semantics, and verifiable benchmark tooling

Status: **proposed for staged v0.22+ delivery** · Target: v0.22 and later ·
Compatibility: additive contracts, packages, fixtures, templates, and
documentation · Depends on: RFC-006, RFC-010, RFC-012

GAOS has a deliberate boundary: it owns deterministic game logic, execution,
agent-facing environments, and portable evidence. It does not own networking,
matchmaking, rendering, model training, benchmark meaning, or a universal
leaderboard.

That boundary is correct, but independent adoption still requires bridges into
the systems that own those surrounding responsibilities. The SDK also needs a
small set of higher-level game and research contracts so integrations do not
rebuild common control flow or invent incompatible descriptions of the same
game.

This RFC proposes five related additions:

1. hosting and transport integration contracts;
2. presentation projections and engine-client fixtures;
3. reusable turn, stage, lifecycle, branching, and extension mechanisms;
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
- replay, signatures, evidence packaging, and offline verification;
- reusable, product-neutral game mechanisms.

Integrating products and services continue to own:

- authentication, accounts, presence, lobbies, and matchmaking;
- socket transport, relay, topology, server allocation, and autoscaling;
- storage engines and operational retention policy;
- rendering, animation, audio, input devices, and editor tooling;
- model inference, training, prompts, and experiment tracking;
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
assign a declared seat and submission identity
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
- fixed signing roster and product-owned live occupancy;
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
- fixed roster and live occupancy separation;
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

## 4 — Higher-level game orchestration

GAOS reducers can already express the following behavior. The gap is reusable,
tested control flow that prevents each game from implementing it differently.

### 4.1 Turn policy

Add an optional deterministic turn controller supporting:

- authored and dynamic seat order;
- forward, reverse, reset, continue, and once-only traversal;
- skip and removal policy;
- round and traversal counters;
- minimum and maximum accepted actions;
- explicit and conditional completion;
- deterministic next-seat selection.

```ts
interface TurnPolicy<TState> {
  activeSeats(state: TState): readonly string[];
  canAct(state: TState, seat: string): boolean;
  next(state: TState, result: TurnResult): TurnTransition;
  minActions?: number;
  maxActions?: number;
}
```

This mechanism composes with, rather than replaces, the reducer's
`Participation` projection.

### 4.2 Per-seat stages and reaction windows

Add named per-seat stages with:

- stage-specific legal-action namespaces;
- independent minimum and maximum action counts;
- all-seat, other-seat, and act-once presets;
- deterministic stage entry and completion;
- sequential, simultaneous, and priority-window composition;
- observable stage state without leaking private legal actions.

This supports reactions, interrupts, bidding, drafting, simultaneous planning,
and asymmetric subturns without product-specific orchestration loops.

### 4.3 Lifecycle controller

Expand the existing phase primitive with optional declarative:

- `endIf` conditions for turn, phase, and game boundaries;
- dynamic next-phase selection;
- enter and exit hooks;
- strict hook and condition evaluation order;
- emitted boundary events;
- convergence guards for chained automatic transitions.

The lifecycle controller remains deterministic and synchronous. Product code
defines the conditions and effects.

### 4.4 Evidence-safe undo and branching

Undo semantics depend on evidence state:

- local casual sessions may use an ordinary bounded undo/redo stack;
- authoritative unsigned sessions may permit a host-policy rewind;
- signed sessions represent an accepted undo as an explicit canonical action
  or create a new transcript branch;
- finalized evidence is immutable.

A branch binds:

- parent artifact or transcript digest;
- branch point;
- reason and authorizing identity;
- new canonical action sequence.

No API may silently delete or rewrite an already signed submission.

### 4.5 Deterministic extension hooks

Define a constrained extension lifecycle for:

- pre-validation;
- pre-advance;
- post-advance;
- observation projection;
- replay metadata;
- conformance assertions.

Extensions may not use wall-clock time, unrecorded randomness, network I/O, or
untracked mutation inside deterministic hooks. The conformance kit should run
the same input twice and reject extensions whose state, observations, events,
or evidence differ.

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

### Stage B — Logic ergonomics

1. Turn policy.
2. Per-seat stages and reaction windows.
3. Lifecycle controller.
4. Evidence-safe branching.
5. Deterministic extension hooks.

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

The proposal is additive. Existing reducers, agent environments, sessions, and
replay artifacts remain valid.

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
- mutable signed history.

The intended result is narrower: make GAOS straightforward to host and render,
reduce repeated deterministic game-control code, describe games precisely
enough for research tooling, and let independent benchmark products publish
scores backed by replayable evidence.
