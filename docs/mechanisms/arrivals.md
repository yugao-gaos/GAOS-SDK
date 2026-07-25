# Arrival rules

`resolveArrival` dispatches every eligible effect caused by entering or coming
to rest on a cell. The arrival payload and world state are product-defined, so
the same mechanism can handle pickups, transforms, hazards, checkpoints,
teleports, or objective zones.

## Rule shape

```ts
interface ArrivalRule<TState, TArrival, TEvent> {
  id: string;
  priority?: number;
  applies?(state: TState, arrival: TArrival): boolean;
  apply(state: TState, arrival: TArrival, events: TEvent[]): void;
}
```

`applies` is optional; without it, the rule always runs. `apply` may mutate the
state and append product events to the shared output array.

## Ordering and visibility

Rules are copied and sorted by ascending priority, defaulting to zero, then by
stable lexical id. The input array is not reordered.

Conditions are evaluated immediately before their rule runs. This means a
later rule sees state mutations and events produced by earlier rules in the
same arrival:

```ts
const applied = resolveArrival(world, { actorId, cell }, rules, events);
// applied contains rule ids in actual execution order
```

All eligible rules run; this is not a first-match dispatch. Use explicit
priorities and conditions when one rule should make another ineligible.

## Integration

An arrival normally follows a committed state move:

1. movement, push, transport, or landing commits positions;
2. one arrival job is enqueued for each resting entity;
3. `resolveArrival` evaluates rules against the committed state;
4. rule effects enqueue any further same-tick consequences.

Using the [settlement kernel](/settlement) prevents an arrival-triggered
teleport, pickup, gate update, or second movement from starting an uncontrolled
nested reducer call.

## Product responsibilities

- Supply unique stable rule ids. The helper does not reject duplicates.
- Decide whether movement through a cell counts as arrival or only resting does.
- Decide how many arrival jobs an entity may receive in one tick.
- Keep product event ordering deterministic inside each rule.
- Prevent cycles using settlement identities or explicit next-tick deferral.

The returned id list is useful for tests and traces, but product state and
events remain the authoritative effect results.

## Zonoid example

Zonoid uses arrival dispatch after movement, throws, bat flights, and conveyor
passes. The platform registers rules for picking up a Relic or battery, landing
on a matching shape exit, entering an objective cell, and resolving a battery
or plug interaction. The SDK orders those rules; Zonoid decides which token is
consumed, which objective changes, and which visual event is emitted.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/arrivals-poster.jpg" aria-label="Focused Zonoid arrivals demo board recording">
    <source src="/mechanisms/arrivals.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: the player picks up a Relic, then reaches the exit so each cell-entry effect resolves after movement.</figcaption>
</figure>
