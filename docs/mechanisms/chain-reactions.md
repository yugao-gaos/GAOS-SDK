# Chain reactions

`resolveChainReaction` resolves connected reactions breadth-first within one
logical tick. It is appropriate for explosions, signal propagation, collapsing
tiles, spreading status, or any causal graph where each stable node identity
must activate at most once.

## Contract

```ts
const result = resolveChainReaction(world, initialNodes, {
  key: (node) => node.id,
  maxReactions: world.reactiveNodes.size,
  react(state, node, context) {
    applyEffect(state, node);
    return newlyTriggeredNeighbors(state, node);
  },
});
```

The `react` callback mutates product state and returns the nodes triggered by
that mutation. Its context contains a zero-based global `step` and the
zero-based breadth-first `wave`.

## Ordering

- Seed nodes run in wave 0 in seed-array order.
- Nodes discovered while resolving a wave run in the following wave.
- Discovery order is retained within each later wave.
- A stable key runs at most once across the complete cascade, including seeds.

```text
seeds: A, B
wave 0: A, B
         │  └─ discovers D
         └──── discovers C
wave 1: C, D
```

If two parents discover the same key, only the first scheduled instance runs.
This is identity deduplication, not object-reference deduplication.

## Result and safety bound

The result is a specialized settlement result containing the mutated state,
step and wave counts, a causal trace, and any deferred work. Chain reactions do
not defer nodes themselves, but the common result shape makes traces compatible
with the [settlement kernel](/settlement).

`maxReactions` must be a positive upper bound on distinct activations. Exceeding
it throws `SettlementLimitError`; it does not return a partial success. Derive
the bound from the product world, such as the number of reactive entities,
instead of using an arbitrary large constant.

## Product responsibilities

The SDK does not decide adjacency, damage, immunity, destruction, event payloads,
or whether a changed node should trigger again under a new state. Encode the
latter in the node key: use one stable object id for once-per-tick behavior, or
include a product-owned phase/version when distinct activations are legitimate.

The `react` callback should return neighbors in a stable order. Iterating an
unordered external collection can make same-wave effects differ between runs.

## Zonoid example

Zonoid uses the chain-reaction primitive for same-tick effect propagation. A
laser or explosive battery can create a seed effect, then the platform’s
callback applies damage or destruction and returns newly affected entities.
The SDK guarantees breadth-first ordering and once-per-identity activation;
Zonoid supplies shields, immunity, damage, and presentation events.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/chain-reactions-poster.jpg" aria-label="Focused Zonoid chain reaction demo board recording">
    <source src="/mechanisms/chain-reactions.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: one shot detonates the first target and propagates a deterministically ordered explosion chain.</figcaption>
</figure>
