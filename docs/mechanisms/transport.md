# Directed transport and interlocks

The transport module covers four related operations: creating movement intents
from directed cells, repeating same-tick movement passes, propagating sources
across connected components, and stabilizing movement with linked state.

## Directed movement proposals

`proposeDirectedTransport` converts eligible occupants into ordinary `Mover`
intents:

```ts
const proposals = proposeDirectedTransport(occupants, {
  directionAt: (cell) => conveyors.get(key(cell))?.direction,
  activeAt: (cell) => conveyors.get(key(cell))?.powered ?? false,
  canEnter: (occupant, to) => transportTerrainAllows(occupant, to),
});

const positions = resolveMoves(proposals, isStaticBlocked);
```

Occupants are considered in input order. An occupant is skipped when its cell
has no direction, its optional active check fails, or its optional destination
check fails. Footprint, priority, and swap consent are carried into the movement
intent.

Proposal does not inspect other occupants or commit movement. Resolve all
proposals together with [simultaneous movement](movement.md).

## Repeated transport passes

`resolveTransportRun` calls a product-owned simultaneous `step` until it reports
zero moves or reaches `maxPasses`:

```ts
const run = resolveTransportRun(world, {
  maxPasses: board.width * board.height,
  step(state, pass) {
    const movers = proposeForPass(state, pass);
    return resolveAndCommit(state, movers);
  },
});
```

`passes` counts passes that moved at least one occupant; the final zero-move
probe is not counted. `moves` is the sum returned by all moving passes.
`completed` is false when the last permitted pass still moved something. The
non-negative pass bound is a safety limit, not conveyor speed or tick balance.

## Linked components

`buildLinkedComponentSources` fans each incoming link source across every
connected member reachable from its target. Products inject:

- stable node keys;
- neighbor enumeration;
- component membership; and
- optionally, stable source identity for deduplication.

Only reachable members are returned. Neighbor order controls traversal/map
insertion order; link input order controls source order. With `sourceKey`, equal
source identities deduplicate even when represented by different objects.
Without it, deduplication uses reference/value equality through `includes`.

This helper maps topology only. It does not decide whether multiple sources
combine as OR, AND, count, power level, or priority.

## Transport/state interlock

Transport can change occupancy that changes a switch, which changes power, which
allows more transport. `resolveInterlock` runs these phases together:

```ts
const result = resolveInterlock(world, {
  maxCycles: 8,
  settle: (state, cycle) => settleTransport(state, cycle),
  update: (state, cycle) => recomputeLinkedState(state, cycle),
});
```

Each cycle calls `settle` first, then `update`. Returning false from `update`
means no linked state changed and produces `stabilized: true`. If every update
through the positive cycle bound requests another pass, the final result has
`stabilized: false`; state is retained for diagnosis rather than rolled back.

## Product responsibilities

The product owns terrain, power, directions, eligibility, flying immunity,
occupancy snapshots, commit/events, source logic, and convergence conditions.
The SDK owns proposal shape, bounded pass control, component fan-out, and the
settle/update phase order.

## Zonoid example

Zonoid belts are directed transport cells. The platform maps each connected
belt run to its switch or powered-plug sources, proposes eligible actors,
Relics, and batteries, and resolves each pass through the same movement core as
walking. `resolveInterlock` handles the feedback loop when belt occupancy
changes a switch or plug state; the board’s belt-cell count supplies the bound.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/transport-poster.jpg" aria-label="Focused Zonoid transport demo board recording">
    <source src="/mechanisms/transport.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: a conveyor belt transports a box automatically through bounded, directed movement passes.</figcaption>
</figure>
