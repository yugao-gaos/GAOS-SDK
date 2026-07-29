# Locations and board layouts

v0.13 separates the identity of a place from the geometry used to reach it.
This lets one game combine square boards, axial-hex boards, territory graphs,
and future zones without inventing a second transport or replay vocabulary.

## Cross-container locations

`LocationRef` addresses a coordinate inside a named container:

```ts
import { locationKey, type LocationRef } from '@yugao-gaos/sdk/engine';

const cell: LocationRef = { container: 'surface', coord: [3, 2] };
const territory: LocationRef = { container: 'world-map', coord: 'north-reach' };

locationKey(cell);      // stable Map/transcript key
locationKey(territory);
```

Coordinates may be `[x, y]` cells, graph-node strings, or numeric indices.
`locationKey` tags those forms, so a string such as `"1,2"` cannot collide
with the cell `[1, 2]`.

## Layout contract

Every board layout supplies deterministic neighbors, distance, line tracing,
containment, and cell keys:

```ts
interface BoardLayout<TCell> {
  neighbors(cell: TCell): readonly TCell[];
  distance(a: TCell, b: TCell): number;
  line(from: TCell, to: TCell): readonly TCell[];
  contains(cell: TCell): boolean;
  key(cell: TCell): string;
}
```

Neighbor order is observable behavior: pathfinding uses it to choose among
equally short routes.

## Shipped layouts

### Square

```ts
const square = createSquareLayout({ width: 12, height: 8 });
```

The default neighbor order follows `CARDINAL_STEPS`. Pass `steps` to add
diagonal or product-specific moves. Distance remains Manhattan distance and
lines use the existing Bresenham implementation.

### Axial hex

```ts
const hex = createHexAxialLayout({
  contains: ([q, r]) => axialDistanceFromOrigin(q, r) <= 5,
});
```

Hex coordinates use `[q, r]`. Neighbors are clockwise, distance uses cube
distance, and lines use cube interpolation with deterministic lower-key
tie-breaking.

### Directed graph

```ts
const graph = createGraphLayout({
  nodes: ['dock', 'market', 'keep'],
  edges: {
    dock: ['market'],
    market: ['keep', 'dock'],
    keep: [],
  },
});
```

Graph edges are directed. BFS visits each adjacency list in authored order.
`distance` returns `Infinity` when no directed route exists; `line` returns the
chosen shortest path.

## Layout-parameterized geometry

`shortestPath`, `nearestReachablePath`, and `lineOfSight` work with any
`BoardLayout<TCell>`. `fieldCells` filters an authored candidate list by
distance, line of sight, and an optional product-owned shape predicate:

```ts
const visible = fieldCells(hex, {
  from: actor.at,
  candidates: authoredArc,
  range: 4,
  blocksSight: (cell) => terrainAt(cell).opaque,
  includes: (cell, distance) => isInsideFacingArc(actor, cell, distance),
});
```

The candidate list owns presentation or shape order. The SDK owns stable
deduplication, range checks, and line-of-sight filtering.

## Keyed movement

Use `resolveKeyedMoves` when cells are not square coordinates or when a mover's
occupied shape is not rectangular:

```ts
const result = resolveKeyedMoves(
  [
    { id: 'scout', from: 'dock', to: 'market', priority: 0 },
    { id: 'guard', from: 'keep', to: 'market', priority: 1 },
  ],
  {
    key: (node) => node,
    isStaticBlocked: (node) => closedTerritories.has(node),
  },
);
```

`occupies(at)` can return any non-empty cell set for multi-cell hex or graph
pieces. Contention, swap consent, blocked-chain reversion, rotations, and
stable priority tie-breaking match `resolveMoves`. The square resolver now
delegates to the keyed engine; `rectFootprint(width, height)` bridges its
rectangular convenience shape.
