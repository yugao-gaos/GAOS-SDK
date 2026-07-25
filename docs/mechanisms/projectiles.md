# Projectiles and full-flight movement

The projectile helpers separate one-cell collision decisions from repeated
same-tick flight. They do not define damage, terrain tokens, paths, relay
behavior, or visual events.

## One projectile pass

`advancePathProjectiles` snapshots the supplied projectile collection, then
visits each projectile once:

```ts
advancePathProjectiles(activeProjectiles, {
  next: (projectile) => projectile.path[projectile.pathIndex],
  collide: (projectile, cell) => collisionPolicy(world, projectile, cell),
  advance: (projectile, cell) => moveOneCell(world, projectile, cell),
  land: (projectile) => landAtCurrentCell(world, projectile),
  consume: (projectile) => removeProjectile(world, projectile),
});
```

`next` returns the next path cell or `undefined` when the path is exhausted.
For a real next cell, `collide` chooses exactly one action:

| Action | Callback | Intended meaning |
|---|---|---|
| `advance` | `advance(projectile, next)` | Commit one-cell movement |
| `land` | `land(projectile)` | Stop at the current resting position |
| `consume` | `consume(projectile)` | Apply/remove without resting |

Path exhaustion calls `land` directly. Because iteration uses a snapshot,
removing a projectile from the live collection cannot skip the next projectile
in the pass. Projectiles created during callbacks wait until a later pass.

The return value is `true` when at least one snapshotted projectile was
processed, even if every one landed or was consumed. It is `false` only for an
empty input snapshot.

## Full same-tick flight

`resolveFlightPasses` repeats product-owned microsteps while `active(state)` is
true:

```ts
const flight = resolveFlightPasses(world, {
  maxPasses: board.width + board.height,
  active: (state) => state.projectiles.length > 0,
  beforePass: (state, pass) => applyRelayRedirects(state, pass),
  advancePass: (state, pass) => advanceAllProjectiles(state, pass),
});
```

Pass indices start at zero. `beforePass`, when supplied, runs immediately before
each `advancePass`, allowing a relay or redirect created by the previous pass to
affect the next microstep.

The result reports `passes` and `completed`. When the authored positive
`maxPasses` limit is reached while `active` remains true, `completed` is false
and the authoritative state stays airborne; the SDK does not force a landing.

## Integration order

A common composition is:

1. snapshot currently active projectiles;
2. resolve one microstep for every projectile;
3. enqueue collisions, landings, arrivals, and removals;
4. allow relays or switches to update;
5. run the next pass only if flight remains active.

Use [tick settlement](/settlement) when these consequences can create more
same-tick work. Keep presentation events separate from collision policy so a
replay reaches the same state without running animation code.

## Edge cases to test

- empty active collection;
- exhausted path at the beginning of a pass;
- collection removal during iteration;
- a collision that consumes rather than lands;
- a relay that changes the next path segment; and
- a flight that remains active at the pass bound.

## Zonoid example

Zonoid uses full-flight movement for thrown Relics, batteries, and bat swings.
The platform supplies each path and its collision policy: a thrown object can
cross a half-wall, stop at a solid blocker, land on a receiver, or damage a
unit. The SDK performs snapshot-safe passes; Zonoid applies the resulting
pickup, damage, relay, and visual events.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/projectiles-poster.jpg" aria-label="Focused Zonoid projectile demo board recording">
    <source src="/mechanisms/projectiles.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: the player picks up a Relic and throws it across the room along a bounded flight path.</figcaption>
</figure>
