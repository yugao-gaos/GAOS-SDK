# Resource-claim arbitration

`arbitrateResourceClaims` resolves actions that were independently legal in a
shared snapshot but cannot all consume or mutate the same resource. Examples
include two actors taking one pickup, overlapping beams consuming a cell, or a
flight and placement both reserving the same destination.

## Arbitration policies

```ts
const result = arbitrateResourceClaims([
  { id: 'take:a', resources: ['pickup:2,1'], claim: actionA },
  { id: 'take:b', resources: ['pickup:2,1'], claim: actionB },
  { id: 'safe', resources: ['pickup:8,1'], claim: actionC },
]);
```

The default `all-fail` policy makes every claim sharing **any** resource with
another claim contested in full. In this example only `safe` is accepted.

For a multi-resource claim, conflict on one resource contests the whole action:

```text
beam claims [cell:4, cell:5]
flight claims [cell:5]
→ both actions are contested
```

This avoids partial execution of an atomic action.

Pass `{ mode: 'priority' }` to accept claims in lower numeric `priority`
order, breaking ties by authored input order. A multi-resource claim is
accepted only when every resource is still unclaimed, so arbitration never
partially commits an action. Claims rejected by an earlier winner appear in
`contested`. The product chooses the policy explicitly for draft picks or
other winner-takes-resource rules. Portals apply the same policy shape while
adding destination capacity.

## Result ordering

The result contains:

- `accepted`, preserving input claim order;
- `contested`, also preserving input claim order; and
- `conflicts`, a map whose resource keys are inserted in lexical order and
  whose claim-id arrays preserve discovery order.

Duplicate resources inside one claim are deduplicated and do not cause a
self-conflict. Duplicate claim ids throw because trace identity would otherwise
be ambiguous. A claim with no resources is accepted.

## Snapshot discipline

Qualify all candidate actions against the same pre-commit snapshot, build their
complete resource sets, arbitrate once, then commit only `accepted`. Do not
remove resources as claims are enumerated; that would turn the result into
input-order priority.

```ts
const arbitration = arbitrateResourceClaims(qualified);
for (const { claim } of arbitration.accepted) commit(claim);
for (const conflict of arbitration.contested) emitCollision(conflict);
```

## Product responsibilities

The product defines resource identity, claim priority, and what a
contested action means. It may fail, bounce, wait, refund, or enqueue a
different effect. Random winner selection remains product policy: derive the
priorities from a recorded seed before arbitration.

## Zonoid example

Zonoid qualifies pickups, throws, landings, bat flights, and overlapping
effects against one pre-commit world snapshot. If two independent intents claim
the same Relic, destination, or flight cell, the platform passes both claims to
the SDK and accepts neither. This keeps simultaneous ticks fair; Zonoid then
emits the appropriate bounce, collision, or no-op event.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/resource-claims-poster.jpg" aria-label="Focused Zonoid resource claim demo board recording">
    <source src="/mechanisms/resource-claims.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: the player and rival claim one battery simultaneously; only the winning claim receives and uses it.</figcaption>
</figure>
