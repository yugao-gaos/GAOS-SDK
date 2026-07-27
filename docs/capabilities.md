# Capabilities

GAOS is a general-purpose Game-as-a-Benchmark SDK for deterministic,
verifiable, agent-playable games. A game can use one mechanism family by itself
or combine several through a product-owned `TickReducer`. Card games, drafting
games, hidden-role games, abstract graph games, tactics games, simulations, and
hybrids use the same reducer, agent, and replay contracts.

## Capability map

| Domain | SDK-owned capabilities | Example game shapes |
| --- | --- | --- |
| Tick execution | Zero-, one-, or multi-input ticks, simultaneous intent collection, response priority, phases, fixed-rate lockstep | Turn-based products, WEGO strategy, reaction stacks, realtime tactics |
| Boards and locations | Square, axial-hex, graph, multi-board, paths, lines, fields, keyed footprints | Tactics, territory maps, node networks, dungeon rooms |
| Zones and collections | Ordered decks, hidden hands, bags, queues, sparse slots, atomic transfer, shuffle, draw, deal | Card games, drafting, inventories, production queues, worker placement |
| Information | Per-seat observations, hidden identity/order, fog, shells, teams, revelations, spectators, leak assertions | Hidden cards, fog of war, social deduction, team games |
| Composition | Keywords, targets, durations, phases, response windows, patterns, deck/loadout validation | Trading-card effects, buffs, interrupts, set collection, squad building |
| Resolution | Settlement waves, movement contention, resource claims, arrivals, portals, pushes, projectiles, transport, gates, triggers | Chain reactions, simultaneous movement, hybrid board/zone transit |
| Agents | Single- and multi-agent environments, legal-action expansion, rewards, batch evaluation, model drivers, CLI launchers | Model evaluation, self-play, tournaments, regression agents |
| Verification | Seeded randomness, solver, state digests, resimulation, portable JSONL replay, multi-level recheck | Benchmarks, leaderboards, dispute verification, reproducible bug reports |
| Integration | Genre-neutral tick protocol, retry-safe cursors, participation windows, TypeScript and Python clients | Local play, hosted sessions, P2P plus verifier, authoritative matches |

## Tick execution

GAOS does not require one cadence.

- **Sequential:** a product exposes one active seat for a tick.
- **Simultaneous:** collect one intent per participating seat, then apply a
  canonical atomic batch without request-arrival bias.
- **Response priority:** open a response window, rotate priority, collect
  passes or reactions, and unwind pending work deterministically.
- **High frequency:** record sparse tick inputs, resimulate omitted empty
  ticks, and digest canonical state.

The product decides which seats may act and which actions are legal. The SDK
owns tick execution, canonical ordering, and replay rules.

## Containers, not just grids

`LocationRef` addresses a place inside any named container. That container can
be a board, graph, deck, hand, bag, queue, or authored slot row.

### Spatial containers

- bounded square layouts;
- axial-hex layouts;
- directed or undirected graph layouts;
- multiple boards in one state;
- generic keyed pathfinding, line of sight, fields, and footprints.

### Collection containers

- LIFO/FIFO/any-index ordered zones;
- unordered seeded bags;
- sparse named slots;
- hidden or seat-visible identity and order;
- atomic planning and commit for transfers, draws, deals, and arrivals.

### Hybrid containers

Portals move entities across heterogeneous containers—for example, a token can
leave a hex board, enter a hidden bag, then emerge on a graph node. Capacity,
group movement, transformations, cycles, and arrivals resolve atomically.

## Cards, zones, and collections

The zone primitive is intentionally lower-level than a card-game framework.
Products compose it with:

- layered static, granted, and suppressed keywords;
- declarative targets across boards and zones;
- round/phase/counter durations;
- explicit phase hooks;
- nested response windows and LIFO resolution;
- deterministic shuffle, draw, round-robin deal, and batch deal;
- structured deck, squad, and loadout validation;
- maximal-run and authored-motif pattern recognition.

A card-only game imports no geometry or movement code. A tactics game can use
the same mechanisms for inventories, action decks, status effects, and
overwatch responses.

## Hidden information and multiplayer

`viewFor(state, seat)` is the trust boundary for player and agent observations.
Helpers support independent identity and order visibility, board fog/shells,
teams, revelations, spectators, and conventional leak tests.

Deployment depends on the secrecy requirement:

- Perfect-information games can use local or optimistic P2P lockstep and
  escalate divergent transcripts to a verifier.
- Hidden-information games require an authoritative resolver that retains
  secrets and sends each participant only its redacted view.

Deterministic P2P agreement provides integrity evidence; it cannot provide
confidentiality when every peer possesses the secret state.

## Deterministic resolution

The settlement kernel and focused mechanisms cover:

- multi-wave consequence worklists with convergence guards and causal traces;
- simultaneous keyed movement, swaps, collisions, priorities, and footprints;
- resource claims and atomic resource transactions;
- arrivals, gates, triggers, rays, projectiles, pushes, transport, and
  interlocks;
- breadth-first chain reactions;
- bounded portal traversal and destination contention;
- product-schema-neutral behavior trees.

Each mechanism receives product callbacks for meaning and mutation. GAOS owns
ordering and failure semantics; the game owns rules content and presentation.

## Agents and Game-as-a-Benchmark

`AgentEnvironment` and `MultiAgentEnvironment` expose concrete legal actions
from the same reducer used by ordinary play. They support seat-redacted views,
per-seat rewards, safety truncation, batch evaluation, provider
drivers, portable tools, and CLI-backed agents.

The `gaos.replay` JSONL envelope then packages the evidence:

- game and historical reducer-adapter identity;
- pinned levels and explicit per-level seeds;
- canonical level-indexed actions;
- recorded results and aggregate totals;
- strict parsing, canonical serialization, and whole-run recheck.

This allows a creator-platform game and a hosted Arena run to be verified by
the same SDK tooling.

## What remains product-owned

GAOS does not prescribe characters, cards, terrain, objectives, scoring
meaning, legal-action policy, prompts, matchmaking, persistence, rendering,
animation, seasons, or content distribution. It also does not make secret
state safe on an untrusted peer.

The boundary is consistent:

> The SDK defines how a reusable mechanism behaves. The product decides where
> it is used, what it means, and how it is presented.

Continue with the [architecture map](/architecture), the
[mechanism reference](/mechanisms/), or the [quickstart](/quickstart).
