# Tick model and reducer contract

The SDK uses a genre-neutral reducer and tick-view vocabulary. It does not
define terrain tokens, card schemas, level files, or a complete world state.
Products expose those concepts through the generic contracts.

::: tip Coordinates are optional
Card-only, hidden-role, drafting, and other non-spatial games can skip the
coordinate compatibility section and start at [Reducer boundary](#reducer-boundary).
They still use the same tick, solver, agent, and replay contracts.
:::

## Coordinates

`Cell` is a mutable TypeScript tuple in `[x, y]` order:

```ts
type Cell = [number, number];
```

The built-in cardinal vectors assume screen-style coordinates: `x` grows to
the right and `y` grows downward.

```ts
CARDINAL_VECTORS.up    // [ 0, -1]
CARDINAL_VECTORS.down  // [ 0,  1]
CARDINAL_VECTORS.left  // [-1,  0]
CARDINAL_VECTORS.right // [ 1,  0]
```

Square boards used by the legacy geometry helpers are zero-based rectangles:
`0 <= x < width` and `0 <= y < height`. Movement itself has no board size; its
`isStaticBlocked` callback must reject out-of-bounds cells.

For square, axial-hex, graph, and multi-board games, use
[locations and layouts](locations-and-layouts.md).

Treat cells stored in state as values. Copy a tuple before retaining it if a
product might mutate the original array.

## Reducer boundary

Reusable solving, replay, and agent execution consume the same adapter:

```ts
interface TickReducer<TLevel, TState, TView extends TickView> {
  init(level: TLevel, seed: number): TState;
  advance(state: TState, inputs: readonly SubmittedAction[]): TState;
  view(state: TState): TView;
  viewFor?(state: TState, seat: string): TView;
}
```

- `init` must create the same initial state for the same level and seed.
- `advance` resolves exactly one tick from zero, one, or many canonical inputs.
  It should throw for an illegal submission.
- `view` exposes the complete or single-seat observation and legal-action
  surface needed by SDK consumers.
- `viewFor` optionally derives the observation authorized for one seat. See
  [information partitions](information-partitions.md).

The reducer contract requires determinism, not persistent immutability.
High-frequency products may mutate in place with copy-on-write rollback
deltas. When using the solver, however, `advance` must not corrupt its input:
several sibling actions are explored from the same parent. Return an
independent state, use persistent data structures, or snapshot before mutation.

An empty-intent tick should use a near-free path and advance only scheduled
systems whose explicit boundary is crossed. Wall-clock time is never implicit
state input; see [fixed-rate ticks](/high-frequency).

## Actions

An action definition declares one of four parameter shapes:

| `params` | Submission | Values are discovered from |
|---|---|---|
| `none` | `{ id }` | No additional data |
| `index` | `{ id, index, zoneId? }` | Items, dialogue options, points of interest, and product zones |
| `xy` | `{ id, x, y, boardId? }` | Per-action targets, then the shared target list |
| `targets` | `{ id, targets }` | A complete non-truncated `targetChoices[targetSpecId]` set |

```ts
const action: SubmittedAction = {
  id: 'Action 4',
  x: 3,
  y: 2,
  boardId: 'arena',
};
```

Multi-seat hosts may attach `seat` to any submission. Action ids in the reducer
are canonical. A hosted protocol may permute their
wire labels for an agent; [replay verification](replay.md) checks that mapping
before re-simulation.

## Tick observations

`TickView` provides:

- legal action definitions;
- status: `playing`, `won`, or `failed`;
- an optional star result;
- `hud.actionsUsed`; and
- optional indexed choices;
- optional sequential or simultaneous `participation`;
- optional multi-seat `outcome`, including rankings and ties;
- optional `activeSeat` as sequential compatibility sugar;
- optional partition-filtered `zones`; and
- optional spatial targeting under `grid`, either for one implicit board or a
  record keyed by board id; and
- optional declarative target-choice sets, including an explicit truncation
  marker.

Products may extend the view with a board, entities, inventory, objectives,
events, or any other observation. Generic SDK algorithms ignore those extra
fields unless a supplied callback uses them.

## Product invariants

Before connecting a reducer, test these properties:

1. Equal `(level, seed, action sequence)` inputs produce equal visible results.
2. Every action advertised by `view` is accepted by `apply` for that state.
3. Illegal or stale actions are rejected rather than silently reinterpreted.
4. Terminal states do not advertise actions that continue scored play.
5. State used for solver deduplication excludes presentation-only volatility.

The SDK owns the adapter shape. The product continues to own state layout,
validation, rules, content, serialization, and authoritative persistence.

## Zonoid example

Zonoid implements one universal `TickReducer` for Object Delivery, Object
Usage, Signal Language, The Breach, Intelligence Lies, and Jailbreak Protocol.
The reducer initializes a product `World`, applies the canonical move/use/talk/
inspect actions, and exposes a redacted `TickView`; the same adapter is used by
human play, agents, the solver, and replay verification.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/grid-model-poster.jpg" aria-label="Focused Zonoid grid model demo board recording">
    <source src="/mechanisms/grid-model.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: a simple room shows the discrete grid, its walls, and the player occupying one cell.</figcaption>
</figure>
