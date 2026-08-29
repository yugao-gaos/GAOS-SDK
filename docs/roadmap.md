# Roadmap

GAOS is an open-source Game-as-a-Benchmark bridge between game development and
agent evaluation. v1.0 freezes the complete product-neutral bridge for
independent games and benchmarks to share.

Roadmap items describe direction, not a compatibility promise or release date.
Published release notes remain the source of truth for shipped behavior.

## Current focus

### v1.0 — stable complete SDK

v1.0 includes every implemented roadmap item through RFC-022: the canonical
GAOS identity, historical verifier kits, portal-aware paths, one durable
session lifecycle, unified actor control sources, and verifiable benchmark
publication, plus provider-neutral room-agent contracts, runtime orchestration,
durable streamed runs, and presentation cues. The scheduled
neutral-core compatibility aliases are removed;
historical replay v1.0–v1.3 semantics remain stable, while replay v1.4 records
ordered reducer-backed interactions.

### One complete path from game to verified agent run

Provide a small, runnable reference project that demonstrates the entire shared
workflow:

1. define a game or benchmark through one deterministic reducer;
2. play it through a human-facing or scripted client;
3. expose structured observations and concrete legal actions to an agent;
4. run single-agent or multi-agent evaluation;
5. emit a portable `gaos.replay` artifact; and
6. verify that artifact independently.

The v0.21 integrity path signs canonical submissions, chains them per
seat, binds every chain to the roster, and exposes offline TypeScript and
Python verdict tooling. It now also supplies signed named interest scopes,
bounded patch observations, pre-ingest legality, durable checkpoint and
compaction, reference prediction/host adapters, and the recovery seams needed
by Arena and TabletopLabs. Generic infrastructure accepts non-grid
`SessionView` observations while action discovery retains the compatible
`TickView` surface.

### v0.22 — RFC-013 foundations

[RFC-013](/rfcs/rfc-013-ecosystem-bridges-and-benchmark-tooling) is implemented
in v0.22. It ships host and presentation boundaries, controller-epoch
infrastructure, formal research contracts, deterministic benchmark manifest
planning and aggregation, and distinct evidence trust claims.

### RFC-014 compatibility milestone — historical v0.23 target

[RFC-014](/rfcs/rfc-014-interoperability-and-dynamic-control-evidence) is
implemented in the official v0.24 release; no separate v0.23 artifact was
published. The historical v0.23 target adds executable host conformance,
complete host and engine integration guides, cross-language
schemas/clients/golden fixtures, signed handoffs, signature-chain v2, replay
and checkpoint integration, offline verification, product-supplied
external-trust interfaces, and TypeScript/Python parity. Products retain
authority selection, service calls, trust roots, rotation, revocation, and
private-key custody.

### v0.24 — RFC-015 verifiable benchmark publication (implemented)

[RFC-015](/rfcs/rfc-015-verifiable-benchmark-publication) completes the
portable evidence path with the bounded-parallel resumable benchmark
runner, agent backends, reproducible `.gaos-bench` bundle and independent
verifier, remaining qualified research metrics/transforms, and a deployable
neutral leaderboard starter. Benchmark manifests pin product-chosen external
authority policy, and leaderboard verification exposes separate facts instead
of one universal trust flag.

### v0.25 — RFC-016 product-owned historical verifier kits (implemented)

[RFC-016](/rfcs/rfc-016-product-owned-verifier-kits) closes the historical
adapter availability gap without moving game rules into GAOS. Products
explicitly export their reducer and semantic adapter; the SDK standardizes a
reproducible verifier-kit format, SHA-256 identity, optional replay reference,
independent digest authorization, offline cache, and restricted execution.

The replay may identify mirrors, but a submitted artifact cannot authorize the
verifier that judges it. A trusted benchmark manifest, signed product catalog,
or verifier-owned allowlist independently pins the kit digest. Missing or
unavailable product code remains `unverifiable`. GAOS never infers or publishes
a product reducer.

Each roadmap release has one authoritative RFC. A later release may depend on
earlier contracts, but it must not silently absorb unfinished scope from
another RFC.

### v0.26 — canonical GAOS identity and product boundary (implemented)

v0.26 completes the coordinated pre-1.0 rename and architecture cleanup. It
adopts the canonical TypeScript and Python package names, `gaos_sdk` Python
imports, `gaos.ticks` v1 transport identity, and canonical GAOS schema domain.
The root and `./client` surfaces are product-neutral and browser-safe; typed
Arena/Zonoid clients and environments now live in the Zonoid product
repository. Automated architecture checks enforce those dependency
boundaries.

### Historical v0.27 scope — incorporated into v1.0

[RFC-017](/rfcs/rfc-017-portal-aware-pathfinding) composes existing layouts,
portal policy, and breadth-first pathfinding. `withPortalNeighbors` adds
eligible cross-container portal destinations to a
`BoardLayout<LocationRef>` without changing ordinary layout behavior or the
authoritative portal plan/commit boundary.

The helper is additive and advisory. It shares portal orientation,
destination adaptation, footprint, permission, and deterministic ordering
semantics with execution while leaving capacity reservation, contention,
transformation, and state mutation to `planPortalTransits` and
`commitPortalTransits`.

[RFC-018](/rfcs/rfc-018-unified-session-lifecycle) adds one
`create/attach → observe/act → finalize → close` lifecycle for normal,
guided, autonomous, watched, and headless play. The product-neutral client
supports durable attachment and immutable finalization, while `runSession`
supplies presentation-only pacing and per-episode conversation reset policy.

Session-backed benchmarks use that same handle and runner. Benchmark
orchestration still owns canonical planning, bounded parallelism,
checkpoints, scoring, packing, and verification; existing `runEpisode`
adapters remain compatible.

### Historical v0.29 scope — incorporated into v1.0

[RFC-019](/rfcs/rfc-019-unified-actor-control-sources) was implemented for its
historical v0.29 target and ships in v1.0. Behavior-tree, human-input, and
agent-input adapters converge on the same validated `SubmittedAction` path
while actor identity, logical seats, controller authority, and transport
connections remain distinct.

Control-source switching is host-side and additive. The reducer and replay
continue to receive canonical actions rather than rerunning external control
sources, and security-relevant seat handoffs retain controller-epoch checks.

### RFC-020 unified command effects — incorporated into v1.0

[RFC-020](/rfcs/rfc-020-unified-command-effects) unifies reducer-backed
interactions and simultaneous intents behind one product-classified command
path. Interactions preserve the open intent window and gameplay cursor;
accepted intents freeze their canonical action. `gaos.replay` v1.4 records
interactions in order and historical v1.0–v1.3 artifacts keep their original
interpretation.

### RFC-021 in-room agents — incorporated into v1.0

[RFC-021](/rfcs/rfc-021-room-agents) wraps the unified actor-control seam with
conversational room presences. A guide may answer without inventing a game
action; a character, player bot, or referee may carry an optional actor/seat
binding and return an untrusted canonical action proposal. Audience presence
remains separate from seat authority. A companion `./room-interaction` surface
adds explicit privacy-bounded messages and events, agent services, committed
watchers, and deterministic audience polls without creating another authority
path. `./room-agent-runtime` adds final-text routing, authenticated disclosure,
durable store seams, channel-isolated provider work and transcripts,
room-global speech arbitration, captions, and reconnect.
`./presentation-cues` adds ordered host-to-renderer effects and repair.
Provider-specific push-to-talk, STT, TTS, persistence, and networking stay in
host adapters.

### RFC-022 durable room-agent runs — incorporated into v1.0

[RFC-022](/rfcs/rfc-022-durable-agent-runs) extends the room-agent runtime with
provider-neutral long-running work. Atomic input admission, ordered durable
events, checkpoints, progress, streamed assistant output, continuation,
cooperative cancellation, persisted deadlines, replay, and crash recovery
remain host-portable without exposing provider reasoning or weakening the
RFC-021 disclosure and action-authority boundaries.

### Stable bridge contracts

Continue hardening the smallest contracts shared by both audiences:

- reducers, observations, and concrete legal actions;
- deterministic seeds and settlement;
- single-agent and multi-agent environments;
- the `gaos.ticks` v1 protocol boundary; and
- the `gaos.replay` v1.4 evidence format and verifier interface; and
- product-owned historical verifier export and content-addressed kit identity.

### Conformance and portability

Expand cross-platform fixtures and reference implementations beyond the
shipped event-store conformance kit so an integrating product can demonstrate
that it speaks the same protocol and produces the same replay evidence without
depending on Zonoid-specific product behavior.

## Naming migration

The coordinated naming migration is active:

- project: **Game-Agent Open Standard (GAOS)**;
- repository: `GAOS-SDK`;
- TypeScript package: `@yugao-gaos/gaos-sdk`;
- Python distribution: `gaos-sdk`; and
- Python import: `gaos_sdk`.

The repository rename retains GitHub redirects from the former
`GAOS-TurnBasedGrid-SDK` location. Releases through v0.25.0 retain their
original package archive names. v0.26 intentionally adopts the `gaos_sdk`
Python import and `gaos.ticks` wire identifier as breaking changes. Replay
identifiers and the historical `gaos.replay` v1.0–v1.3 formats retain their
interpretation.

## Independent adoption

The long-term measure of the project is not the number of mechanisms in one
repository. It is whether independent creators can build different products on
the same shared contracts. Priorities therefore include:

- standalone reference games and benchmarks;
- reusable conformance tests;
- cross-language replay fixtures;
- clearer extension points for product-owned policy; and
- examples and reports from independent GAOS-compatible projects.

## Product boundary

GAOS will continue to own reusable infrastructure: mechanisms, deterministic
execution, agent surfaces, protocol contracts, and replay interoperability.

Each integrating game or benchmark owns its content, capability claims, scoring
meaning, human analytics, held-out evaluation design, hosting, publication, and
commercial policy. GAOS makes those products faster to build; it does not
define what every product must measure.
