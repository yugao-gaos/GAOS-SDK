# Architecture map

GAOS bridges game development and agent evaluation through one authoritative
reducer. A human-facing client, an autonomous agent, a solver, and a replay
verifier consume the same rules instead of maintaining separate
implementations.

The ownership boundary remains deliberate: reusable behavior belongs in the
SDK; authored meaning, benchmark methodology, and product policy stay with the
integrating game or benchmark.

## Package entry points

| Entry point | Purpose | Runtime assumptions |
| --- | --- | --- |
| package root | GAOS-hosted Arena client and Arena observation types | `fetch` |
| `./protocol` | Generic turn envelopes, cursors, idempotency, simultaneous intents, game registry | JSON-serializable values |
| `./engine` | Game mechanisms, layouts, settlement, solver, replay, scoring, agent environment and tools | Injected world/reducer policy |
| `./agent` | Provider-neutral driver contract and keyed HTTP model drivers | `fetch` and a provider key |
| `./agent-cli` | CLI discovery, launch recipes, MCP configuration, subprocess lifecycle | Node.js |
| Python distribution | Hosted client, Gym-style environment, agent evaluation helpers | Python 3.10+, standard library only at runtime |

Choose the narrowest entry point your integration needs. A deterministic game
engine should not need the hosted Arena adapter; an MCP server should not need
to depend on a model provider.

[Browse the capability map](/capabilities) for supported game shapes, or use
the mechanism matrix below to locate the relevant engine module.

## Mechanism map

| Concern | SDK mechanism | Product supplies |
| --- | --- | --- |
| Locations and layouts | stable container addressing; square, hex, and graph topology | boards, adjacency, terrain and container ids |
| Turn order and lockstep | seat rotation, participation/outcome shapes, canonical input ordering and digests | phases, response policy, snapshots and serialization |
| Information partitions | per-seat reducer views, zone/fog redaction, team sets and leak checks | secret state, visibility rules, memory and spectator delivery |
| Zones and card play | immutable collection transfers, deals, keyword layers, response priority, targets, durations, phases and validation | card identity, rules, costs, legal responses and effects |
| Portals | bounded heterogeneous transit, groups, capacity arbitration and atomic commit order | activation, placement, transformations, occupancy and arrival effects |
| Patterns | maximal run and motif recognition over arbitrary layouts | token meaning, overlap policy, cascades and scoring |
| Movement | simultaneous destinations, footprints, collisions, rotations, swaps, priority | terrain and static-blocker policy |
| Turn consequences | ordered worklist, waves, coalescing, once-only work, deferral, convergence guard, causal trace | job meaning, mutations, stable keys and priorities |
| Propagation | breadth-first once-per-identity chain reactions | neighbors and effects |
| Projectiles and pushes | path advancement, flight passes, atomic push planning and commit order | collision, damage, landing and visuals |
| Gates and triggers | latch/automatic transitions, authored-order one-shot triggering | sources, conditions, effects and persistence |
| Rays and visibility | ordered ray traversal, Bresenham lines, line of sight, cone geometry | blockers, hits, damage and visibility policy |
| Transport | link components, directed proposals, bounded runs and interlocks | power, occupancy and world mutation |
| Decisions | generic behavior-tree traversal and shortest-path search | conditions, leaf actions and traversability |
| Outcomes | star calculation and budget-failure precedence | thresholds and budgets |
| Verification | seeded randomness, solving, portable JSONL envelopes, multi-level transcript re-simulation | reducer registry, levels and action schema |
| Agent episodes | seat-redacted single- or multi-agent turns, frame skip, rewards and versioned transcripts | policies, wait action, reward semantics and hosted execution |

Read the [mechanism reference](/mechanisms/) for detailed contracts, ordering,
examples, edge cases, and product responsibilities.

## One deterministic core

```text
                  product content and policy
                            |
                     TurnReducer adapter
                            |
          +-----------------+-----------------+
          |                 |                 |
       gameplay          solver/replay   AgentEnvironment
          |                                   |
      renderer/API                    tools + model drivers
                                             |
                                       MCP-capable CLIs
```

The reducer adapter prevents local agents, hosted sessions, replay verification,
and ordinary gameplay from drifting into separate rule implementations.

## SDK versus product ownership

### SDK

- deterministic algorithms and ordering;
- reusable mechanism state transitions;
- generic turn and agent lifecycle contracts;
- replay, solver, scoring behavior, tools and integration adapters; and
- provider and CLI extension points.

### Product

- characters, abilities, items, dialogue, levels, objectives and game modes;
- board tokens, numeric tuning, thresholds and reward policy;
- benchmark capability claims, task suites, held-out content, analytics and
  publication methodology;
- prompts, matchmaking, authentication, persistence and anti-cheat rules; and
- rendering, animation, sound, seasonal content and server-only policy.

The SDK may report that a ray stopped at a cell. The product decides whether
that cell is a wall, a shield, a character, or a visual-only effect. The SDK
may settle a trigger in authored order. The product decides what the condition
means and which mutation follows.

## Why this is AI-native

Agent support is part of the engine contract, not a UI automation layer:

1. A seeded reducer produces deterministic observations and outcomes.
2. The environment exposes complete, concrete legal actions.
3. Seat-scoped agents receive only their redacted observation and legal actions.
4. Illegal model output is rejected before reaching the reducer.
5. Every decision produces a versioned `gaos.replay` artifact suitable for
   cross-platform replay.
6. The same cases can be evaluated across local policies, keyed models, or
   MCP-capable CLIs.

That makes agent play reproducible, provider-neutral, headless, and directly
comparable with human or renderer-driven play.
