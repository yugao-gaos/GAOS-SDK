# Capabilities

GAOS supplies product-neutral mechanisms and infrastructure around a
product-owned deterministic reducer.

## Capability map

| Area | GAOS supplies | Product supplies |
|---|---|---|
| Ticks | Sequential, simultaneous, response-priority, and fixed-rate execution | Participation, phases, legal actions, and cadence policy |
| Worlds | Square, hex, graph, multi-board, and collection containers | Boards, terrain, adjacency, tokens, and meaning |
| Hidden information | Seat, team, fog, zone, revelation, and spectator projections | Secret state, visibility rules, and memory |
| Resolution | Settlement waves, movement, claims, arrivals, portals, pushes, projectiles, gates, triggers, and transport | Conditions, effects, mutations, and presentation |
| Agents | Single- and multi-agent environments, concrete actions, rewards, drivers, and CLI adapters | Prompts, decision policy, objectives, and hosted execution |
| Sessions | Prepared transitions, canonical inputs, idempotency, reconnect state, and evidence capture | Persistence, transport, matchmaking, and operational policy |
| Verification | Replay, signatures, chains, semantic recheck, and verifier interfaces | Historical reducer, semantic adapter, publication, and trust policy |

## One reducer across people and agents

`TickReducer` accepts zero, one, or many canonically ordered actions per tick.
Its full or seat-redacted views can drive:

- a human renderer;
- `AgentEnvironment` or `MultiAgentEnvironment`;
- an authoritative host;
- deterministic solvers and tests; and
- replay re-simulation.

The product owns the reducer. GAOS keeps its consumers on a common contract.

## Composable game shapes

Games can use one mechanism family or combine several:

- boards, graphs, decks, hands, bags, queues, and slots;
- sequential, simultaneous WEGO, and fixed-rate play;
- cards, targets, durations, response windows, and patterns;
- hidden roles, fog of war, teams, and spectators;
- movement contention, resource claims, portals, chain reactions, projectiles,
  pushes, gates, triggers, transport, and settlement waves; and
- seeded randomness, scoring helpers, behavior trees, and solvers.

Each mechanism owns deterministic ordering and failure semantics. Product
callbacks retain game-specific rules and mutations.

## Verifiable exact runs

`gaos.replay` packages versioned inputs, seeds, results, signatures, and
historical adapter identity. A verifier can check the exact recorded run
without repeating model inference.

Verification remains conditional on historical verifier availability and
independent authorization:

- v0.25 accepts either a pinned adapter or a product-owned,
  content-addressed verifier kit; and
- the product or benchmark authority retains publication, retention, and
  digest-trust policy.

## What GAOS does not provide

GAOS does not prescribe reducers, semantic adapters, characters, cards,
terrain, objectives, score meaning, prompts, held-out content, matchmaking,
hosting, rendering, identity, anti-cheat policy, or leaderboards.

[See architecture and ownership →](/architecture) ·
[Browse every mechanism →](/mechanisms/) ·
[Start building →](/quickstart)
