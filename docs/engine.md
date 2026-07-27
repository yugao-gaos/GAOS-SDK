# Reusable mechanism engine

The `./engine` entry point provides deterministic, product-neutral algorithms
that a product can compose inside its own reducer.

```ts
import {
  resolveMoves,
  runSettlementCascade,
  solveLevel,
} from '@yugao-gaos/turn-based-grid-sdk/engine';
```

## Boundary

GAOS mechanisms own:

- canonical ordering and deterministic failure behavior;
- mutation-free planning and explicit commit order;
- convergence bounds and causal traces; and
- reusable state transitions over injected product data.

The product owns:

- its reducer and semantic adapter;
- game entities, rules content, conditions, and effects;
- legal actions, observations, scoring meaning, and tuning; and
- persistence, rendering, hosting, and publication policy.

A mechanism may report that a ray stopped or a movement claim lost. The product
decides whether the cause represents a wall, character, shield, cost, or visual
event.

## Mechanism families

The engine includes:

- square, hex, graph, and collection layouts;
- zones, cards, information partitions, teams, and spectators;
- simultaneous movement, resource claims, portals, and arrivals;
- settlement waves, chain reactions, projectiles, pushes, gates, triggers,
  rays, and transport;
- seeded randomness, scoring helpers, behavior trees, and solving; and
- agent environments, transcript re-simulation, and replay helpers.

Use the [mechanism reference](/mechanisms/) for the contract, example, edge
cases, and product responsibilities of each family.

## Reducer adapter

Infrastructure depends on `TickReducer`, not on a product registry:

```ts
interface TickReducer<TLevel, TState, TView extends SessionView> {
  init(level: TLevel, seed: number): TState;
  advance(state: TState, inputs: readonly SubmittedAction[]): TState;
  view(state: TState): TView;
  viewFor?(state: TState, seat: string): TView;
}
```

The product may interpret a tick as a turn, simultaneous intent window, or
fixed-rate step. The SDK advances the reducer without assigning product-level
meaning.

The same adapter can power ordinary play, `AgentEnvironment`, authoritative
sessions, solvers, and replay re-simulation. This is how GAOS avoids a separate
agent or verification rules engine while leaving the rules themselves under
product ownership.

## Historical verification

Published evidence must remain connected to the reducer version that produced
it. v0.25 verifiers can load an explicitly supplied historical adapter or a
product-owned, content-addressed verifier kit containing the historical
reducer and semantic mappings.

GAOS standardizes kit identity and execution. The product still decides
whether to publish the code and how long to retain it, and an independent
policy decides whether to trust its digest.

[See the full ownership map →](/architecture) ·
[Build a reducer →](/quickstart) ·
[Browse mechanisms →](/mechanisms/)
