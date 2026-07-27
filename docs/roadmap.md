# Roadmap

GAOS is an open-source Game-as-a-Benchmark bridge between game development and
agent evaluation. The current v0.x line is focused on making that bridge easier
to adopt and stable enough for independent games and benchmarks to share.

Roadmap items describe direction, not a compatibility promise or release date.
Published release notes remain the source of truth for shipped behavior.

## Current focus

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

### Stable bridge contracts

Continue hardening the smallest contracts shared by both audiences:

- reducers, observations, and concrete legal actions;
- deterministic seeds and settlement;
- single-agent and multi-agent environments;
- the `agilabs.ticks` v1 protocol boundary; and
- the `gaos.replay` v1.3 evidence format and verifier interface; and
- product-owned historical verifier export and content-addressed kit identity.

### Conformance and portability

Expand cross-platform fixtures and reference implementations beyond the
shipped event-store conformance kit so an integrating product can demonstrate
that it speaks the same protocol and produces the same replay evidence without
depending on Zonoid-specific product behavior.

## Naming migration

The SDK has grown beyond the grid-oriented scope reflected by its original
identifiers:

- repository: `GAOS-TurnBasedGrid-SDK`;
- TypeScript package: `@yugao-gaos/turn-based-grid-sdk`;
- Python distribution: `gaos-turn-based-grid-sdk`; and
- Python compatibility import: `agilabs_arena`.

These identifiers remain current and supported for now. Renaming only one
surface would fragment installation, documentation, imports, release URLs, and
protocol integrations, so the project will not perform a partial rename.

A future coordinated migration will select neutral names that reflect GAOS as a
bridge for both game developers and interactive-benchmark creators. The
migration plan will cover:

- repository and documentation URLs;
- TypeScript and Python distribution names;
- Python import compatibility;
- CLI names and examples;
- deprecation or forwarding packages where practical; and
- explicit treatment of already-versioned protocol identifiers.

No proposed replacement name is active until it appears in a published
migration guide. Existing users should continue to install and import the
current packages.

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
