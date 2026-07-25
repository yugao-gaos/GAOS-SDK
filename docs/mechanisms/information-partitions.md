# Information partitions

v0.14 makes imperfect information an explicit reducer boundary. A reducer may
continue to expose one perfect-information `view(state)`, or add
`viewFor(state, seat)` for the observation that a particular player or agent is
allowed to receive.

```ts
const reducer: TickReducer<Level, State, View> = {
  init,
  advance,
  view: fullView,
  viewFor(state, seat) {
    return deriveSeatView(fullView(state), visibilityPolicies, seat);
  },
};
```

`deriveSeatView` is a conventional adapter for `TickView.zones` and
`TickView.grid`. Products with another observation schema can implement
`viewFor` directly.

## Visibility algebra

The same small algebra is used for zone identity and order:

```ts
type Visibility =
  | { kind: 'public' }
  | { kind: 'seats'; seats: readonly string[] }
  | { kind: 'hidden' };
```

Zone identity and order are independent. This supports four useful cases:

| Identity | Order | Observation |
|---|---|---|
| hidden | hidden or visible | aggregates such as `count` only |
| visible | hidden | entries in canonical identity order |
| visible | visible | authored entries or slots, with `ordered: true` |

Canonical sorting when order is hidden prevents an insertion order from
leaking secret history. Supply `entryKey` when canonical JSON is not the
product's stable identity.

Board policies filter cells, legal target cells, and entities. A hidden entity
may be absent, or replaced by a product-defined presence-only shell. A shell
must not retain identity or other secret fields. Unconfigured zones and boards
remain public.

## Teams and spectators

`teamVisibility(teams, seat)` returns a seat visibility set shared by every
member of that seat's team. Team membership must be deterministic, unique, and
part of authoritative state or content.

`outcomeForTeams` expands a team ranking to the seat-ranked `Outcome`
convention, giving every member the team's rank and optional score. Products
can use the same team declaration for shared resources without making resource
pooling an SDK rule.

`SpectatorVisibilityPolicy` documents the two supported host policies:
public information, or a full view with an optional tick delay. The host owns
spectator buffering and delivery; a spectator is not a player seat and cannot
submit actions.

Use `createInformationRevelation` when a hidden identity becomes visible and
`revelationsForSeat` to filter those records through the same visibility
algebra. The state transition remains authoritative; revelation records give
agents and replay UIs a standardized event surface.

## Leak tests

`assertNoInformationLeak` compares the serialized observation stream for a
baseline state with states that differ only in hidden information:

```ts
assertNoInformationLeak({
  baseline,
  variants: hiddenCardPermutations,
  observe: (state) => turnsForSeat(state, 'north'),
});
```

The default comparison is byte-for-byte JSON. For non-JSON observations,
supply a canonical `serialize` function. Include legal actions, targeting,
terminal outcomes, and the full sequence of observations: all of them can leak
hidden state.

## Agent integration

Configure `AgentEnvironment` with `seat`. The environment uses `viewFor` when
available, enumerates legal actions only from that redacted view, injects the
seat into the reducer submission, and rejects an action naming another seat.
Agent transcript version 1.3 records the redacted initial and per-tick
post-action observations. Multi-agent transcripts retain one
redacted stream per seat and a shared canonical intent batch.

Observation and level snapshots use `structuredClone` by default. Supply
`snapshotObservation` or `snapshotLevel` for values containing functions or
other non-cloneable product data.

## Product responsibilities

- Keep secret state out of every seat-scoped observation and legal-action list.
- Use stable, locale-independent keys for hidden-order canonicalization.
- Treat the full view as privileged data and do not send it to an untrusted
  client before redaction.
- Apply actions to authoritative state; never reconstruct truth from a
  redacted observation.
- In peer-to-peer lockstep, remember that every peer receives full state;
  partitions protect presentation, not against a modified client. Use an
  authoritative resolver for adversarial hidden-information play.
- A practical deployment is one authoritative session object per match (for
  example, a Durable Object). It retains full state and the canonical input
  transcript, applies the reducer, and sends each participant only
  `viewFor(state, seat)`. Clients must never receive secrets merely to redact
  them locally.
- P2P digest agreement plus server replay is useful for correctness disputes,
  but matching digests cannot reveal that a client passively inspected secret
  state before choosing an otherwise legal action.
- Decide fog memory, unknown-entity shell contents, team membership, and
  delayed-spectator storage.
