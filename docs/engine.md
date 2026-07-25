# Reusable game-mechanism engine

Import the engine through the dedicated package subpath:

```ts
import {
  budgetFailure,
  recheckTranscript,
  resolveMoves,
  scoreStars,
  solveLevel,
} from '@yugao-gaos/turn-based-grid-sdk/engine';
```

This page defines the engine's ownership boundary and composition model. For
the exact rules, examples, edge cases, and integration checklist for every
mechanism, use the [complete mechanism reference](/mechanisms/).

## Ownership boundary

The SDK owns deterministic, product-neutral behavior:

- simultaneous movement collision resolution, including footprints, movement
  chains, rotations, swaps, and priority;
- deterministic multi-wave tick settlement through an explicit consequence
  worklist, including convergence guards, next-tick deferral, and causal traces;
- breadth-first chain reactions, path-projectile advancement, bounded full-flight
  passes, and all-or-nothing push-chain planning/commit ordering;
- latching and automatic gate transitions, including occupancy-safe closing;
- authored-order one-shot triggers with product-owned conditions and effects;
- ordered ray traversal with product-owned collision and terminal policy;
- selector/condition/leaf behavior-tree evaluation over product-owned node
  schemas, conditions, actions, and world state;
- ordered arrival-rule dispatch, neutral multi-resource claim arbitration,
  directed transport proposals/runs, connected link sources, and bounded
  transport/state interlocks, plus product-defined resource balances and atomic
  requirement/effect transactions;
- square, axial-hex, and graph layouts; layout-parameterized pathfinding,
  line-of-sight, and field geometry; and generic keyed movement;
- deterministic sequential tick order, multi-seat participation/outcome
  contracts, maximal run/motif recognition, canonical lockstep input ordering,
  rollback re-simulation, and state digests;
- per-seat observations, independent zone identity/order visibility, board fog,
  team visibility conventions, spectator policy types, and leak assertions;
- ordered, bag, and slotted zones with atomic transfer, shuffle, draw, and deal
  operations; keyword layers, response priority, declarative targets,
  durations, phases, and deck/loadout validation;
- bounded portal transit across heterogeneous containers, including atomic
  groups, destination capacity arbitration, transformations, and arrivals;
- seeded random draws and permutations;
- star scoring and an AI action-limit runtime guardrail;
- breadth-first minimum-action solving over an injected deterministic reducer;
- transcript re-simulation, optional tick gaps, and deterministic per-level run
  seeds;
- provider-neutral seat-aware single- and multi-agent episode lifecycles,
  concrete action validation, per-seat rewards, safety truncation,
  transcripts, and batch evaluation.

The product owns content and policy:

- character, card, token, trait, ability, and loadout identity and meaning;
- game-type registration and the mapping from a game type to rules;
- authored boards, graphs, decks, levels, thresholds, budgets, dialogue, and
  objectives;
- authentication, persistence, matchmaking, seasons, and server-only rules.

The dividing rule is: the SDK implements **how a reusable mechanism behaves**;
the product decides **which content uses it, where it is enabled, and with what
values**.

Tick settlement is described in [Deterministic tick settlement](settlement.md).
One submitted tick may resolve through several same-tick waves before the SDK
returns control to the caller.

Geometry APIs accept callbacks for cell existence and blocking. The SDK owns
the algorithm; the product retains its terrain tokens, traversal capabilities,
projectile collision effects, and visibility policy.

## Reusable mechanisms

The engine subpath ships mechanisms directly. Products inject world access and
effects instead of copying their control flow:

```ts
import {
  advancePathProjectiles,
  arbitrateResourceClaims,
  commitPushChain,
  evaluateBehaviorTree,
  planPushChain,
  proposeDirectedTransport,
  resolveArrival,
  resolveChainReaction,
  resolveFlightPasses,
  resolveGateTransition,
  resolveInterlock,
  resolveLatchedTriggers,
  resolveTransportRun,
  traverseGridRay,
} from '@yugao-gaos/turn-based-grid-sdk/engine';
```

These functions do not assign meaning to tokens. For example,
`resolveChainReaction` guarantees breadth-first, once-per-identity propagation;
the product decides what a node represents, which effects it applies, and which
neighboring nodes it triggers. `advancePathProjectiles` owns one-cell travel
semantics while the product supplies collision decisions and commits damage,
landing, removal, and presentation events.

`planPushChain` is mutation-free. `commitPushChain` then writes farthest-first
and emits arrivals nearest-first, preventing overwrites while retaining causal
animation order. Transport similarly separates reusable directed proposals and
bounded run/interlock behavior from product occupancy, power, and terrain rules.
Gate transitions accept only abstract open/closed state, activation, and
occupancy; products retain their source lookup, board tokens, and visual events.
Latched triggers similarly retain authored order while products provide condition
evaluation, latch persistence, effect application, and presentation payloads.
`traverseGridRay` visits a supplied finite or open-ended cell iterable in order,
numbers steps from one, and distinguishes a callback-requested stop from path
exhaustion. Products retain blocker lookup, collision, damage, mutation, and
presentation policy.

Behavior trees use a typed adapter so the SDK never owns product node types or
actions:

```ts
const order = evaluateBehaviorTree(context, productTree, {
  inspect(node) {
    if ('sel' in node) return { kind: 'selector', children: node.sel };
    if ('if' in node) {
      return {
        kind: 'condition', condition: node.if,
        then: node.then, else: node.else,
      };
    }
    return { kind: 'leaf' };
  },
  test: (ctx, condition) => productConditionHolds(ctx, condition),
  evaluateLeaf: (ctx, node) => productActionFor(ctx, node),
});
```

Selectors return the first non-null result. A condition evaluates only its
chosen branch, and returns null when false without an else branch. Products
retain target selection, order reuse, behavior composition, spawning, and all
world/entity rules.

## Reducer adapter

The solver and replay checker depend on `TickReducer<TLevel, TState>` rather
than a Zonoid registry. A product adapter provides three pure operations:

```ts
interface TickReducer<TLevel, TState> {
  init(level: TLevel, seed: number): TState;
  advance(state: TState, inputs: readonly SubmittedAction[]): TState;
  view(state: TState): TickView;
  viewFor?(state: TState, seat: string): TickView;
}
```

This keeps campaign lookup, level schemas, and character catalogs outside the
SDK while allowing the reusable algorithms to execute the product reducer.
A product may interpret ticks however its rules require. The SDK only advances
ticks; it does not model product-level ticks.

`ActionReducer` is the 0.x compatibility shape for integrations that still
apply one input at a time. New integrations use `TickReducer.advance`, which
accepts zero, one, or many canonically ordered inputs.

The same reducer adapter powers `AgentEnvironment` and
`MultiAgentEnvironment`. A product therefore needs no second gameplay
implementation for agents, hosted sessions, solving, or deterministic replay.

## Scoring configuration

The scoring formula lives here, but the numbers do not:

```ts
scoreStars(actionsUsed, { three: level.stars.three, two: level.stars.two });
```

AI action limits are runtime guardrails independent of product economy. Products
define resources such as energy and compose their costs or grants into actions,
triggers, pickups, and other mechanisms through [resource transactions](mechanisms/resources.md).
