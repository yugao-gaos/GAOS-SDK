# Architecture and ownership

GAOS surrounds a product-owned deterministic reducer with reusable game,
agent, session, evidence, and verification infrastructure.

```text
                 product content and policy
                            │
                product-owned TickReducer
                            │
       ┌──────────────┬─────┴─────┬──────────────┐
       │              │           │              │
   human play    agent play   sessions      run evidence
                                              │
                                    historical verifier
```

The reducer is not supplied by GAOS. The SDK defines the contract through
which a product's rules reach each consumer.

## Ownership boundary

| Product owns | GAOS owns |
|---|---|
| Reducer and semantic adapter | Reducer, environment, session, replay, and verifier contracts |
| Characters, cards, terrain, levels, objectives, and game modes | Product-neutral mechanisms and deterministic ordering |
| Legal-action and observation meaning | Concrete-action expansion and seat-scoped environment lifecycle |
| Tasks, rewards, score meaning, held-out content, and capability claims | Transcript, evidence, signature, and verification formats |
| Rendering, hosting, persistence, matchmaking, identity, and anti-cheat policy | Prepared session transitions, canonical inputs, and reconnect evidence |
| Whether and how long historical verifier code is published | Verifier-kit export, identity, resolution, cache, and execution interfaces |
| Which verifier digests are trusted | Integrity and authorization result reporting |

The rule is simple: **the product defines meaning; GAOS standardizes reusable
behavior and evidence around it.**

## One reducer, several consumers

`TickReducer<TLevel, TState, TView>` provides deterministic operations:

```ts
interface TickReducer<TLevel, TState, TView extends SessionView> {
  init(level: TLevel, seed: number): TState;
  advance(state: TState, inputs: readonly SubmittedAction[]): TState;
  view(state: TState): TView;
  viewFor?(state: TState, seat: string): TView;
}
```

The same adapter can power:

- a renderer or hosted API;
- `AgentEnvironment` and `MultiAgentEnvironment`;
- deterministic solvers and regression tests;
- authoritative `SessionKernel` transitions; and
- replay re-simulation.

Products may compose GAOS mechanisms inside `advance`, but the product still
owns the final reducer and its rules.

## Verifiable evidence

GAOS records canonical reducer inputs and results in portable replay artifacts.
Signed submissions add seat-key authorship and per-seat chain evidence. A
verifier then resolves the appropriate historical reducer and semantic adapter,
re-simulates the run, and reports separate integrity, authorization, semantic,
and adoption facts.

The replay cannot authorize the verifier it names. A benchmark manifest,
product catalog, or verifier-owned allowlist obtained independently must pin
the accepted digest.

v0.25 supports both directly supplied pinned adapters and product-owned
verifier kits: content-addressed packages exported by the product and handled
through GAOS packing, inspection, discovery, caching, and restricted-execution
contracts.

## Package entry points

| Entry point | Purpose |
|---|---|
| package root | Hosted Arena client and wire types |
| `./protocol` | Product-neutral tick protocol |
| `./engine` | Mechanisms, reducers, agents, solvers, and replay |
| `./session` | Authoritative transitions and evidence capture |
| `./agent` | Provider-neutral and keyed model drivers |
| `./agent-cli` | MCP-capable CLI launch integration |
| Python distribution | Hosted client, evaluation helpers, and replay exchange |

TypeScript contains the local mechanism engine and replay re-simulation.
Python is the hosted and research integration surface; it does not duplicate
the TypeScript reducer runtime.

[Explore capabilities →](/capabilities) ·
[Read the mechanism reference →](/mechanisms/) ·
[Understand verification →](/trust-and-verification)
