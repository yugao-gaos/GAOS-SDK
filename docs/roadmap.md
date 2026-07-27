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
`TickView` surface. RFC-013 ecosystem bridges and benchmark integrations
remain future v0.22+ work.

### Stable bridge contracts

Continue hardening the smallest contracts shared by both audiences:

- reducers, observations, and concrete legal actions;
- deterministic seeds and settlement;
- single-agent and multi-agent environments;
- the `agilabs.ticks` v1 protocol boundary; and
- the `gaos.replay` v1.3 evidence format and verifier interface.

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
