# Push chains

Push resolution has two explicit phases: `planPushChain` discovers whether the
entire displacement is legal without mutating the world, then `commitPushChain`
applies an accepted plan in safe deterministic order.

## Planning

```ts
const steps = planPushChain(firstBox, direction, {
  occupied: (cell) => boxes.has(key(cell)),
  destination: (from, delta) => ({
    to: [from[0] + delta[0], from[1] + delta[1]],
  }),
  blocked: ({ to }) => wallAt(to) || actorAt(to),
  skip: (cell) => independentlyMovingBoxes.has(key(cell)),
  maxItems: boxes.size,
});
```

Starting at `start`, the planner follows occupied cells until it reaches free
space, a skipped cell, a blocked destination, or the cycle guard.

- Free space returns the complete ordered plan.
- `skip(cell)` returns the plan accumulated before that cell. It means another
  simultaneous mechanism will vacate that item; it does not move the skipped
  item itself.
- A blocked prepared destination returns `null`, rejecting the whole push.
- `maxItems` is a product-derived cycle guard, not a balance limit.

`destination` may implement more than `from + direction`. It can represent a
portal, squeeze, slide, height transition, or other product mechanic. Optional
metadata is copied into the resulting step and is available during commit.

## All-or-nothing rule

Planning is mutation-free so no prefix of an illegal chain leaks into state:

```ts
if (steps === null) {
  emitBlockedPush();
} else {
  commitPushChain(steps, committer);
}
```

Callbacks used while planning should be reads. If `destination` or `blocked`
mutates the world, later checks no longer describe a single snapshot.

## Commit ordering

State moves are committed farthest-first, vacating destinations before nearer
writes. Arrival and presentation callbacks then run nearest-first after **all**
moves have committed:

```text
plan:       A:1→2, B:2→3
move:       B:2→3, A:1→2
arrival:    A@2, B@3
```

```ts
commitPushChain(steps, {
  move: (step) => moveBox(step.from, step.to, step.metadata),
  arrive: (step) => enqueueArrival(step.to),
});
```

This prevents overwrites while preserving causal near-to-far feedback. Arrival
callbacks should normally enqueue work rather than immediately start a nested
resolution loop; see [arrival rules](arrivals.md) and
[tick settlement](/settlement).

## Product responsibilities

The product owns push eligibility, weight, strength, terrain, destination
transforms, simultaneous skip qualification, sounds, animation, and consequences.
The SDK owns linear traversal, all-or-nothing planning, metadata carriage, and
commit order.

## Zonoid example

In Zonoid’s Object Delivery and Object Usage levels, the player can push boxes
and other solid objects through a line of occupants. The platform’s receiver
policy decides which shapes are pushable and whether the destination is free;
the SDK plans the entire chain first, then commits farthest-to-nearest so a
failed chain leaves every object in place.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/push-chains-poster.jpg" aria-label="Focused Zonoid push chain demo board recording">
    <source src="/mechanisms/push-chains.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: the player pushes a box, and that box pushes a Relic so the full chain commits atomically.</figcaption>
</figure>
