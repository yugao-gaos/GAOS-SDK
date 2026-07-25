# Latched triggers

`resolveLatchedTriggers` evaluates authored one-shot triggers in array order.
The product supplies its own condition and effect schemas, state persistence,
and presentation events.

## Resolution sequence

For each trigger:

1. skip it when `isLatched(state, id)` is true;
2. evaluate `conditionMet` against the current state;
3. persist the latch **before** effects run;
4. apply every effect in authored array order; and
5. append the id to the returned fired list.

Latching first prevents an effect that causes nested or later trigger
evaluation from firing the same trigger again.

```ts
const fired = resolveLatchedTriggers(world, level.triggers, {
  isLatched: (state, id) => state.firedTriggerIds.has(id),
  conditionMet: (state, condition) => evaluateCondition(state, condition),
  latch: (state, id) => state.firedTriggerIds.add(id),
  applyEffect: (state, effect, trigger) => applyEffect(state, effect, trigger.id),
});
```

## Authored-order semantics

Later trigger conditions observe state changes from earlier triggers in the
same pass. This makes authored order part of the rules, not merely presentation.
If triggers must qualify simultaneously, snapshot their condition results in
the product before calling the helper or model them as separate settlement jobs.

Effects within one trigger also run sequentially. Keep the effect array stable
across serialization and avoid object-key enumeration as implicit author order.

## Persistence and identities

The helper stores no internal latch set. `latch` must update the same state
observed by `isLatched`, and that state must survive save/load and replay when
the trigger is meant to be permanently one-shot. Trigger ids should be unique
within that persistence scope.

## Product responsibilities

Conditions, effects, trigger reset policy, scopes, spawning, dialogue, rewards,
and visual events remain product-owned. When effects cause more same-tick work,
enqueue it through [tick settlement](/settlement) instead of recursively
calling the entire trigger pass.

## Zonoid example

Zonoid levels can author one-shot board events such as “switch pressed,” “plug
powered,” “agent reached this cell,” “evidence collected,” or “tick reached.”
The platform evaluates those conditions and applies feature-cell rewrites such
as opening a wall or unlocking an exit; the SDK latches the event before its
effects, so replay and nested settlement cannot fire it twice.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/triggers-poster.jpg" aria-label="Focused Zonoid trigger demo board recording">
    <source src="/mechanisms/triggers.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: the player steps on, off, and back onto a switch to show that its one-shot trigger fires only once.</figcaption>
</figure>
