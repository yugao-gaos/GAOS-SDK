# Mechanism reference

The `./engine` package is a set of deterministic, product-neutral building
blocks for Game-as-a-Benchmark products and standalone games. Each page in
this section describes one mechanism family: the state it expects, the
ordering it guarantees, the policy the product must inject, and the edge cases
an integration should test.

No board is required. Card-only and hidden-role games can use zones,
information partitions, tick order, response windows, agents, and replay
without importing geometry. Spatial games can choose square, axial-hex, or
graph layouts, and hybrid games can connect boards and zones through portals.

[Start with the capability map →](/capabilities)

Established mechanism pages also include focused **Zonoid examples**. Zonoid
is the first production consumer of this engine: its universal reducer
supplies authored content and presentation policy while the SDK supplies the
deterministic algorithms.

## How the pieces fit together

```text
submitted action
    │
    ├─ reducer validates product rules
    │
    ├─ simultaneous movement / push / transport proposal
    │
    └─ settlement waves
          ├─ arrival rules
          ├─ resource claims
          ├─ gates and triggers
          ├─ projectiles, rays, and chain reactions
          └─ linked-state interlocks
                 │
                 └─ stable tick view, score, transcript
```

The SDK does not prescribe that exact pipeline. A product composes only the
mechanisms it needs and explicitly schedules their causal relationships through
the [settlement kernel](/settlement).

## Pages

| Family | What the SDK guarantees |
|---|---|
| [Tick model](grid-model.md) | Neutral action shapes, observations, and the reducer boundary |
| [Locations and layouts](locations-and-layouts.md) | Cross-container addressing, square/hex/graph layouts, and keyed movement |
| [Ticks and lockstep](ticks-and-lockstep.md) | Participation, outcomes, canonical tick inputs, and state digests |
| [Information partitions](information-partitions.md) | Per-seat views, independent identity/order visibility, board fog, teams, and leak tests |
| [Zones and card play](zones-and-card-play.md) | Atomic collection transfers, dealing, keywords, priority, targets, durations, phases, and deck validation |
| [Portals](portals.md) | Bounded atomic transit across heterogeneous boards and zones |
| [Pattern matching](patterns.md) | Deterministic maximal runs and product-defined lattice motifs |
| [Simultaneous movement](movement.md) | Collision, priority, footprints, chains, rotations, and swaps |
| [Geometry and FOV](geometry.md) | Layout paths, nearest reachable cells, lines, sight, and fields |
| [Tick settlement](/settlement) | Multi-wave consequence scheduling, duplicate policy, traces, and limits |
| [Chain reactions](chain-reactions.md) | Breadth-first, once-per-identity propagation |
| [Projectiles and flight](projectiles.md) | Snapshot-safe microsteps and bounded full-flight passes |
| [Push chains](push-chains.md) | Mutation-free planning and safe commit order |
| [Arrival rules](arrivals.md) | Stable dispatch of tile-entry effects |
| [Resource claims](resource-claims.md) | Neutral all-fail or priority arbitration for contested resources |
| [Resource transactions](resources.md) | Product-defined balances and atomic requirements/effects |
| [Gates](gates.md) | Latching and occupancy-safe automatic transitions |
| [Latched triggers](triggers.md) | Authored-order, one-shot conditions and effects |
| [Rays](rays.md) | Ordered traversal with explicit stop or exhaustion |
| [Behavior trees](behavior-trees.md) | Product-schema-neutral selectors, conditions, and leaves |
| [Transport and interlocks](transport.md) | Directed proposals, repeated passes, linked components, and stabilization |
| [Deterministic randomness](randomness.md) | Seeded streams, event-keyed rolls, and permutations |
| [Scoring and budgets](scoring.md) | Threshold scoring, failure precedence, and threshold suggestions |
| [Solver](solver.md) | Breadth-first minimum-action search over an injected reducer |
| [Portable replay and verification](replay.md) | Cross-platform JSONL evidence, transcript permutation checks, and multi-level deterministic re-simulation |
| [Fixed-rate ticks](/high-frequency) | Tick fast paths, sparse inputs, rollback, digests, and multi-agent orchestration |

## Product integration showcases

These focused boards show how Zonoid composes several SDK mechanisms into
player-facing interactions while retaining the normal game UI.

### [Simultaneous movement](/mechanisms/simultaneous-movement.mp4)

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/simultaneous-movement-poster.jpg" aria-label="Zonoid simultaneous movement product integration recording">
    <source src="/mechanisms/simultaneous-movement.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Multiple rival NPCs and the player resolve their movement together from the same tick snapshot.</figcaption>
</figure>

### [NPC conversation](/mechanisms/npc-conversation.mp4)

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/npc-conversation-poster.jpg" aria-label="Zonoid NPC conversation product integration recording">
    <source src="/mechanisms/npc-conversation.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>The player starts a conversation and selects a dialogue response through Zonoid’s normal interaction UI.</figcaption>
</figure>

### [Rival battle](/mechanisms/rival-battle.mp4)

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/rival-battle-poster.jpg" aria-label="Zonoid rival battle product integration recording">
    <source src="/mechanisms/rival-battle.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>The player and a rival exchange actions in a focused battle board with health and equipment visible.</figcaption>
</figure>

## Shared conventions

- **Stable identities are data.** Entity, job, trigger, claim, and rule ids must
  be stable across replay.
- **Lower priority values run first.** Where priorities tie, the documented
  stable input or id order decides the result.
- **Bounds are authored.** Maximum steps, passes, reactions, nodes, and cycles
  are safety limits supplied by the product; they are not balance rules chosen
  by the SDK.
- **Callbacks own meaning.** Tokens, terrain, damage, abilities, objectives,
  animation events, and persistence stay in the product.
- **Determinism includes ordering.** Do not feed unordered database results or
  locale-dependent comparisons into a mechanism without normalizing them.

Import all mechanisms from the dedicated subpath:

```ts
import {
  resolveMoves,
  runSettlementCascade,
  shortestGridPath,
} from '@yugao-gaos/turn-based-grid-sdk/engine';
```
