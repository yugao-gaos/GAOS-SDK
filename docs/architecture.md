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
| package root | Browser-safe GAOS protocol and product-neutral `SessionClient` |
| `./protocol` | Product-neutral tick protocol |
| `./client` | Product-neutral hosted-session client, unified handles, attachment receipts, and finalization |
| `./engine` | Mechanisms, reducers, agents, solvers, and replay |
| `./session` | Authoritative transitions and evidence capture |
| `./session-host` | Transport-neutral durable host lifecycle |
| `./ecosystem` | Host conformance and presentation bridge contracts |
| `./seat-control` | Stable-seat authority and controller epochs |
| `./control` | Behavior-tree, human-input, and agent-input control sources |
| `./room-agent` | Multiple conversational room agents, audience input, rules manifests, and optional actor/seat action proposals |
| `./room-agent-runtime` | Provider-neutral final-text routing, channel transcripts, cancellation, speech arbitration, captions, and reconnect state |
| `./room-interaction` | Explicit room messages/events, privacy-bounded routing, agent services, committed watchers, and deterministic audience votes |
| `./presentation-cues` | Ordered, retry-safe host-to-renderer cues with acknowledgement, replay repair, and emergency interruption |
| `./benchmark` | Benchmark manifests, session-backed execution, planning, bundles, and aggregation |
| `./evidence` | Dynamic-control and external-attestation verification |
| `./presentation-client` | Retry-safe presentation state |
| `./leaderboard` | Neutral leaderboard service boundaries |
| `./verifier-kit` | Node-only verifier-kit packing, inspection, cache, and resolution |
| `./container-verifier-runner` | Node-only Docker/Podman restricted runner |
| `./agent` | Provider-neutral and keyed model drivers plus the common session runner |
| `./agent-cli` | MCP-capable CLI launch integration |
| Python `SessionClient` | Product-neutral hosted sessions with opaque observations and commands |
| Python replay and verification APIs | Portable evidence exchange and verification |

TypeScript contains the local mechanism engine and replay re-simulation.
Python is the hosted and research integration surface; it does not duplicate
the TypeScript reducer runtime.

The root and `./client` entry points must remain browser- and edge-safe.
Product adapters live with their products and depend on GAOS; GAOS never
depends on a product. Zonoid owns its typed observations, matchmaking,
leaderboards, convenience endpoints, and Python environment in the Zonoid
repository.

## Contract identity

GAOS uses three identity shapes:

| Contract kind | Identity rule | Example |
|---|---|---|
| Standalone JSON schema | Major version is embedded in `schema`; do not add a duplicate `schemaVersion` | `gaos.benchmark-manifest.v1` |
| Serialized family with compatible minor versions | Stable `format` plus `formatVersion` | `gaos.replay` + `1.3` |
| Negotiated wire protocol | Stable `protocol` plus `protocolVersion` | `gaos.ticks` + `1.0` |

Every published JSON Schema uses
`https://yugao-gaos.github.io/GAOS-SDK/schemas/<filename>` as its canonical
`$id`. The documentation build publishes those exact source files at that
location, and `npm run architecture:check` prevents identifier drift,
dependency cycles, internal barrel imports, product leakage into the generic
root, and Node built-ins entering the browser-safe surface.

[Explore capabilities →](/capabilities) ·
[Read the mechanism reference →](/mechanisms/) ·
[Understand verification →](/trust-and-verification)
