# Portals

Portals are authored edges that move entities between heterogeneous
containers. A single bounded plan may cross square, hex, or graph boards and
ordered, bag, or slotted zones.

```ts
const edges: PortalEdge[] = [{
  id: 'embark',
  from: { container: 'hex-map', coord: [2, -1] },
  to: { container: 'garrison', coord: 0 },
  priority: 10,
}];

const plan = planPortalTransits(state, entrants, edges, policy, {
  maxPasses: 8,
  contention: 'priority',
});
```

## Product policy

The SDK owns traversal, ordering, convergence, group atomicity, destination
claims, and plan/commit discipline. The product supplies:

- stable entity identity;
- portal activation and per-entity transit permission;
- whether an ambiguous string destination is a board or zone;
- zone insertion or board placement;
- destination footprints and occupancy checks;
- optional destination capacity; and
- an optional entity transformation.

String coordinates can name either graph nodes or zone slots, so
`destinationKind` resolves that ambiguity. Board exits default to the edge's
destination coordinate. Zone exits require an insertion policy.

## Planning and contention

Planning never mutates product state. It follows active edges until no further
edge applies, a cycle is detected, or `maxPasses` would be exceeded. A visited
`locationKey` set provides explicit cycle detection per entity. Invalid board
placement, blocked occupied cells, or invalid zone insertion are reported
instead of silently dropping an entity.

Entrants may share a `group`; every member is accepted or rejected together.
Destination claims include every occupied board cell or the destination
zone's capacity claim. `all-fail` rejects every group involved in an
over-capacity claim. `priority` accepts whole groups in deterministic order
until capacity is exhausted.

Transit order is:

1. settlement wave;
2. lower edge priority;
3. authored edge order;
4. lower entrant priority; and
5. authored entrant order.

Bidirectional edges retain their authored order. Multi-hop passes advance the
wave and preserve a golden causal trace.

## Portal-aware pathfinding

`withPortalNeighbors` creates an advisory search view by appending eligible
portal destinations to a container-aware `BoardLayout<LocationRef>`:

```ts
const searchable = withPortalNeighbors(worldLayout, {
  state,
  entity: hero,
  edges,
  policy,
});

const path = shortestPath(searchable, {
  start: hero.at,
  goal: throneRoom,
  isBlocked,
});
```

Ordinary layout neighbors stay first. Portal destinations follow the same
priority, authored-edge, and orientation order as portal planning, and
duplicate locations are removed by `locationKey`. The helper shares the
planner's activation, permission, destination adaptation, footprint, and
`canEnter` semantics.

Search captures the supplied state and entity without mutating either one. It
does not reserve capacity, transform an entity, or execute a move. Every portal
step still goes through `planPortalTransits` and `commitPortalTransits`; if
state changes after search, recompute the path or let execution reject the
stale route.

## Atomic commit

`commitPortalTransits` accepts only the exact state identity used for the
plan. The product committer performs all removals and insertions as one
authoritative operation. `transform` runs exactly once for each committed
edge traversal, and arrival callbacks run only after the complete state has
been committed, in deterministic transit order.

That boundary supports information-safe moves: a unit can leave a public
board, become a card, and enter a hidden hand in one state transition. A
seat-scoped observer sees the public departure and updated hand count, never
an intermediate identity frame.

## Composition recipes

| Interaction | Composition |
|---|---|
| Return unit to hand | board-to-zone edge plus `transform` |
| Deploy a card | zone-to-board edge plus `placeOnto` and `occupiesAt` |
| Draw-bag spawn | bag-to-board edge with seeded product selection |
| Garrison or embark | board-to-owner zone edge and capacity |
| Multi-floor dungeon | board-to-board edges across different layouts |
| Open or powered portal | gate/trigger/link state read by `isActive` |
| Toll | resource transaction checked during policy and committed atomically |
| Arrival effects | schedule `resolveArrival` after portal commit |

Draw, discard, tutor, and ordinary moves inside one zone are zone transfers,
not portals. A product may intentionally model one as a portal when authored
edge policy is part of the rule.

## Product responsibilities

- Rebuild the authored edge set deterministically when portals can spawn.
- Use `canEnter` and `capacityAt` against authoritative occupancy.
- Keep transformations pure with respect to planning and perform state writes
  only in the committer.
- Schedule cascades and response windows explicitly after commit.
- Re-derive every seat view from the atomically committed state.
