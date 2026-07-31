# RFC-017 — Portal-aware pathfinding

Status: **implemented** · Target: v0.27 · Compatibility: additive layout helper ·
Depends on:
[RFC-002](rfc-002-locations-and-layouts.md),
[RFC-005](rfc-005-portals.md)

## 1 — Problem

`shortestPath` traverses only the values returned by `BoardLayout.neighbors`.
Portal planning separately supports directed and bidirectional transit across
boards, graphs, and zones. A product can therefore find a path to a portal
entrance and execute the portal, but the SDK does not currently let the same
path search continue through that portal to a destination in another
container.

Products can build this behavior themselves, but each integration would need
to repeat portal orientation, activation, permission, destination adaptation,
and deterministic ordering.

## 2 — Decision

An eligible portal destination is an additional neighbor of its entrance.
Portal-aware pathfinding reuses the existing breadth-first search; it does not
introduce a second pathfinding algorithm.

- A directed edge adds `from → to`.
- An edge with `bidirectional: true` also adds `to → from`.
- A portal traversal has a path cost of one, like any other neighbor step.
- Inactive, denied, invalid, or blocked portal destinations are omitted.
- Normal neighbors remain first and retain their authored order. Portal
  neighbors follow in portal priority, authored-edge, and orientation order,
  matching portal planning.
- Duplicate destinations are returned once, preserving first discovery.

The path continues to contain `LocationRef` values. The container is therefore
part of cell identity, and equal coordinates in different containers do not
collide.

## 3 — API

```ts
interface PortalNeighborLayoutOptions<TState, TEntity> {
  state: TState;
  entity: TEntity;
  edges: readonly PortalEdge[];
  policy: PortalPolicy<TState, TEntity>;
}

function withPortalNeighbors<TState, TEntity>(
  layout: BoardLayout<LocationRef>,
  options: PortalNeighborLayoutOptions<TState, TEntity>,
): BoardLayout<LocationRef>;
```

The product supplies a container-aware base layout whose normal `neighbors`,
`contains`, `key`, `distance`, and `line` behavior covers the locations it
wants to search. The returned layout delegates every operation except
`neighbors`. Its `neighbors` result appends destinations from portal edges
whose entrance matches the queried `LocationRef` and whose current policy
allows traversal.

```ts
const searchable = withPortalNeighbors(worldLayout, {
  state,
  entity: hero,
  edges: portals,
  policy: portalPolicy,
});

const path = shortestPath(searchable, {
  start: { container: 'floor-1', coord: [1, 2] },
  goal: { container: 'floor-2', coord: [8, 4] },
  isBlocked,
});
```

The helper uses the same destination adaptation rules as
`planPortalTransits`, including `placeOnto`, zone insertion, footprints, and
`canEnter`. These rules are shared with the planner rather than reimplemented.

## 4 — Search and execution boundary

A discovered path is advisory. Search reads one state snapshot and does not
reserve destination capacity, arbitrate simultaneous entrants, apply entity
transformations, or mutate state. Portal steps must still pass through
`planPortalTransits` and `commitPortalTransits` when executed.

This preserves the existing atomicity boundary: a portal that closes, becomes
occupied, loses capacity, or changes permission after search can reject
execution. Products should then recompute the path from the new state.

The v1 helper is unweighted. Products that need movement costs other than one
remain responsible for a weighted graph policy; changing `shortestPath` from
breadth-first search is out of scope.

## 5 — Determinism

The wrapper captures the supplied state and entity for one search view. It
does not mutate either value. Portal eligibility and destination callbacks are
evaluated deterministically in the same oriented-edge order used by portal
planning.

`locationKey` identifies entrances and destinations. The helper validates
edges and adapted destinations consistently with the portal planner and
rejects malformed input rather than silently producing a different graph.

## 6 — Release gate

RFC-017 is complete when tests establish:

1. a shortest path crosses a directed portal only from `from` to `to`;
2. a bidirectional portal is searchable in both directions;
3. inactive and denied portals are not neighbors;
4. board-to-board and heterogeneous adapted destinations retain container
   identity;
5. ordinary-neighbor and portal ordering produces stable equal-length paths;
6. blocked or invalid destinations are excluded;
7. duplicate portal destinations are deduplicated deterministically;
8. cycle-containing portal graphs terminate under the existing BFS visited
   set; and
9. path discovery does not mutate state or replace execution-time portal
   planning.

## 7 — Compatibility and out of scope

The API is additive. Existing layouts, `shortestPath`,
`nearestReachablePath`, portal planning, and portal commit behavior do not
change unless a caller explicitly wraps a layout.

RFC-017 does not add weighted paths, capacity reservations, contention
prediction, speculative transformation state, automatic movement or portal
commit, cross-turn route persistence, or presentation metadata. A product may
identify portal steps by comparing consecutive locations with its eligible
portal edges.
