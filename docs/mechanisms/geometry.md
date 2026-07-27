# Geometry, pathfinding, and FOV

The geometry helpers operate on `Cell` values and injected board policy. They
know how to traverse a rectangular grid, but they do not know what walls,
doors, actors, vision modes, or remembered fog mean.

## Cardinal geometry

`manhattanDistance(a, b)` returns orthogonal distance. `CARDINAL_STEPS` uses the
stable order up, down, left, right; breadth-first searches use that order to
break otherwise equal paths unless the caller supplies custom steps.

## Shortest paths

```ts
const path = shortestGridPath({
  width: 8,
  height: 6,
  start: [1, 1],
  goal: [5, 1],
  isBlocked: ([x, y]) => walls.has(`${x},${y}`),
  allowBlockedGoal: false,
});
```

The result excludes `start` and includes `goal`. Breadth-first traversal
guarantees a shortest path under the supplied step set. `allowBlockedGoal`
permits only the final cell to be blocked, which is useful for approaching an
occupied interaction target.

An empty array means either that the start equals the goal or that the goal is
unreachable. Compare the endpoints when the distinction matters.

`nearestReachableCellPath` searches by distance layer and returns both the
chosen goal and its shortest path. It returns the start with an empty path when
the start qualifies, and `undefined` when nothing qualifies. Supply
`compareEqualDistance` whenever product policy, rather than cardinal discovery
order, should choose among equally near cells.

## Lines and line of sight

`bresenhamLine(from, to)` returns discrete line cells excluding the origin and
including the target. The ordering is origin-to-target and is suitable as the
input to [ray traversal](rays.md).

`lineOfSightClear` tests intermediate cells only. Both endpoints remain visible
even if the blocker callback reports them as blocked:

```ts
lineOfSightClear(actor.at, target.at, (cell) => opaque(cell));
```

This endpoint rule lets a wall or actor be seen even though vision does not
continue through it. If the product wants an opaque target to be untargetable,
check the target separately.

## Widening cones

`coneFieldCells` builds cardinal layers from distance `1` through `range`. At
each forward distance, the perpendicular width grows by one cell on each side.
A candidate is included only when:

1. `cellExists` accepts it;
2. `isBlocked` does not reject the candidate itself; and
3. intermediate line of sight is clear.

Blocked cells are omitted rather than included as visible endpoints. This is
intentionally different from `lineOfSightClear`; the product can add visible
blockers separately when its FOV design requires them.

## Building FOV

The SDK provides visibility geometry, not a complete fog-of-war state. A
typical product computes current visibility from rays or cones, then owns:

- which terrain and entities are opaque;
- height, facing, range, lighting, stealth, and special senses;
- whether blockers themselves are visible;
- unioning fields from several observers;
- remembered cells and last-known entity state; and
- redaction of the observation sent to an agent.

Keep current visibility and remembered knowledge separate. Replaying a tick
should recompute the same current field from state; presentation may then merge
it with product-owned memory.

## Determinism checklist

- Keep a stable step order for equal shortest paths.
- Do not derive blocker answers from animation progress or client frame state.
- Normalize dynamic occupancy to the same tick snapshot used by movement.
- Treat all coordinates and board dimensions as integers at the input boundary.

## Zonoid example

Zonoid uses shortest paths for NPC orders and nearest reachable cells for
targeted commands. Its FOV adapter supplies walls, doors, half-walls, actors,
facing, and range to the geometry helpers; the resulting cells are then used
for Inspect visibility, guard sight, and agent observations. The SDK computes
the geometry, while Zonoid owns fog, disguise state, and what is redacted.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/geometry-rays-poster.jpg" aria-label="Focused Zonoid grid geometry and field of view demo board recording">
    <source src="/mechanisms/geometry-rays.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: Look reveals field of view first in an open room, then again among boxes where walls and obstacles block cells.</figcaption>
</figure>
