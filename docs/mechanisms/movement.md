# Simultaneous movement

`resolveMoves` resolves a snapshot of movement intents together. It supports
ordinary actors, multi-cell footprints, movement chains, rotations, contested
destinations, and explicitly permitted head-on swaps.

## Input

```ts
interface Mover {
  id: string;
  from: Cell;
  to: Cell;
  priority: number;
  footprint?: { width: number; height: number };
  swapOk?: string[];
}
```

Each id must be unique. Lower priority values win contested destinations; equal
priorities preserve mover input order. A missing footprint means `1 × 1`.
Larger rectangular footprints extend right and down from the mover's top-left
anchor.

`isStaticBlocked(x, y, moverId)` reports terrain, board bounds, and other hard
blockers. It **must not** report any mover passed in the same call. Dynamic
occupancy is resolved from the shared snapshot.

## Resolution rules

The resolver starts with every proposed destination, then monotonically reverts
illegal movers to their origin until no result changes:

1. A mover whose target footprint touches a static blocker reverts.
2. A mover targeting any cell occupied by a now-stationary mover reverts.
3. A two-way head-on swap reverts both movers unless either mover lists the
   other in `swapOk`.
4. When moving footprints overlap at their destinations, the lowest priority
   wins and every rival reverts.
5. Reversions can block a movement chain, so the checks repeat to a fixed point.

Longer rotations remain legal because every occupied cell is vacated within the
same snapshot:

```text
A → B's cell
B → C's cell
C → A's cell       allowed
```

A two-cycle is treated differently because head-on swaps are frequently a
gameplay rule rather than an incidental rotation.

## Example

```ts
const finalCells = resolveMoves([
  { id: 'scout', from: [1, 1], to: [2, 1], priority: 0 },
  { id: 'guard', from: [3, 1], to: [2, 1], priority: 5 },
], (x, y) => terrain[y]?.[x] === '#');

finalCells.get('scout'); // [2, 1]
finalCells.get('guard'); // [3, 1]
```

The function returns a new `Map<id, Cell>`. It does not mutate the product
world and it does not emit collision or arrival events. Commit the returned
positions as one batch, then enqueue arrivals or other consequences through
the [settlement kernel](/settlement).

## Important boundaries

- Movement distance is not restricted. Validate adjacency, speed, teleporting,
  and terrain capability before calling the resolver.
- Priority is arbitration data, not initiative policy. The product assigns it.
- Rectangular footprint dimensions are trusted; validate positive dimensions
  at the content boundary.
- The resolver does not push occupants. Use [push chains](push-chains.md) to
  plan explicit displacement.
- Presentation should animate from the submitted snapshot to the returned map,
  not replay the internal reversion loop.

## Tests worth keeping

Cover at least: a legal rotation, a blocked chain that fully reverts, contested
destinations, both swap consent states, equal-priority input ordering, a
multi-cell footprint, and an out-of-bounds target reported as static blocked.

## Zonoid example

Zonoid turns player movement, NPC orders, box pushes, and conveyor proposals
into one movement snapshot. The platform validates each action and supplies
walls, doors, footprints, and priorities; the SDK resolves the batch so an
actor cannot win by arriving earlier in an iteration. Positions are committed
before Zonoid runs pickups, doors, damage, and other arrivals.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/movement-poster.jpg" aria-label="Focused Zonoid movement demo board recording">
    <source src="/mechanisms/movement.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: the player walks through an otherwise empty room while each move resolves on the grid.</figcaption>
</figure>
