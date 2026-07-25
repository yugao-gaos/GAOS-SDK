# Zones and card play

Zones model ordered and unordered collections without assigning meaning to
their entries. Cards, draw bags, queues, inventories, production tracks, and
unit loadouts all use the same immutable state and transfer operations.

## Configuration

A zone has four independent policy axes:

- `access`: `lifo`, `fifo`, `anyIndex`, or `slots`;
- `order`: `ordered`, `bag`, or `sparse`;
- separate identity and order visibility policies; and
- optional capacity, slot keys, and seat ownership.

The `deck`, `hand`, `queue`, `bag`, `slotRow`, and `discard` helpers are
configuration presets only. Mechanisms never branch on a preset name.

```ts
const zones = defineZones({
  deck: createZone(deck(), ['c1', 'c2', 'c3']),
  north: createZone(hand('north')),
  discard: createZone(discard()),
});
```

List storage is canonical bottom-to-top. A bag also retains a canonical
internal list so seeded draws replay, but its visibility policy hides that
order. A slotted zone stores declared keys with either an entry id or `null`.
Zone definitions reject invalid access/order pairs, duplicate entries, excess
capacity, and undeclared slots.

## Atomic transfers and arrivals

Multi-entry moves use a plan/commit boundary:

```ts
const plan = planZoneTransfer(zones, {
  entries: ['c3', 'c2'],
  from: { container: 'deck', coord: 2 },
  to: { container: 'north', coord: 0 },
  insert: 'top',
});

if (plan.ok) {
  const committed = commitZoneTransfer(zones, plan, {
    arrive: (arrival, completeZones) => {
      // Schedule product-owned arrival rules from the complete new state.
    },
  });
}
```

Planning is mutation-free. Access rules, source membership, destination
capacity, slot availability, and global entry uniqueness are checked before a
result exists. A failed plan returns the original collection unchanged.
Commit rejects a plan made from another zone version. Arrival callbacks run
only after the entire immutable result exists, so observers never see an
entry removed without its destination count being updated.

`shuffleZone` accepts an explicit seed and only shuffles ordered list zones.
`drawFromZone` removes the top of an ordered zone or performs a seeded sample
from a bag. `dealRoundRobin` and `dealBatches` compose deterministic shuffle,
draw, and transfer behavior; the source cannot also be a destination.

## Card composition helpers

The zone primitive is accompanied by reusable composition algorithms:

- `KeywordRegistry` and `resolveKeywordLayers` order effects by layer,
  registration order, acquisition time, source id, and authored active order;
- response windows rotate seat priority, reset consecutive passes after a
  response, treat timeout and wait as explicit passes, close after all seats
  pass consecutively, and expose a LIFO unwind;
- `TargetSpec` and `enumerateTargetChoices` enumerate bounded concrete target
  tuples and report truncation explicitly;
- durations advance only on explicit phase, tick, or round boundaries, with
  simultaneous expiries returned in authored order;
- the optional phase runner emits exit, cycle-complete, and enter events in
  deterministic order; and
- `validateDeck` applies pure size, copies, tag, and faction constraints to
  decks, squads, or loadouts and returns structured violations.

`ActionDefinition.params: 'targets'` references a `targetSpecId`.
`TickView.targetChoices` carries the already-enumerated choices and whether
the product cap truncated them. Generic action enumeration refuses truncated
sets because a solver or agent must never mistake a partial legal surface for
the complete one.

Costs remain resource transactions. Draft picks remain ordinary simultaneous
intents whose contested resource claims use either all-fail or priority
arbitration. These are compositions of existing mechanisms, not card-only
systems.

## Observation and security

`TickView.zones` always exposes a count. It exposes identities, order, or slots
only when the seat's independent policies allow them. Hidden list order is
canonicalized before observation so insertion history cannot leak.

Use `assertNoInformationLeak` with permutations of deck order, bag order, and
opponent hands. This checks observations and should also cover legal actions
and target choices. A public replay may record a revelation created with
`createInformationRevelation`; authoritative state remains the source of truth.

## Product responsibilities

- Mint stable entry ids using counters or seeded draws.
- Keep card definitions, keyword meaning, costs, legality, and effects in the
  product reducer.
- Pick explicit seeds for shuffle, bag draw, and dealing.
- Decide whether a response or arrival opens a nested priority window.
- Keep conventional draw/discard/tutor moves as zone transfers; use a portal
  only when an authored edge adds activation, transformation, or transit
  policy.
