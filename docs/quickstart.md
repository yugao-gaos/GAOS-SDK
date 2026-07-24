# Quickstart

GAOS gives game developers and interactive-benchmark creators the same starting
point: one reducer that can power human play, agent play, and replay
verification.

- **Building a game?** Start with the mechanism family closest to your game,
  then wrap the finished reducer with `AgentEnvironment` when you want an AI
  player, solver, tournament, or evaluation.
- **Building a benchmark?** Start with the environment contract and use the
  mechanism suite to create deeper interactive tasks without building a game
  runtime from scratch.

You can also use the engine by itself or connect to a GAOS-hosted game. All
paths come from the same package and converge on the same deterministic core.

The current repository and package names remain in use until the coordinated
[naming roadmap](/roadmap) is ready.

## Install TypeScript

The package is published through GitHub Packages. Add a project or user
`.npmrc`, then authenticate with a GitHub token that has `read:packages`:

```ini
@yugao-gaos:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
npm install @yugao-gaos/turn-based-grid-sdk
```

You can also pin a repository release without configuring the package registry:

```sh
npm install 'git+https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git#v0.17.0'
```

## Choose the narrowest entry point

```ts
// Hosted Arena adapter and public wire types
import { ArenaClient } from '@yugao-gaos/turn-based-grid-sdk';

// Product-neutral turn protocol
import { GameRegistry } from '@yugao-gaos/turn-based-grid-sdk/protocol';

// Deterministic mechanics and agent environment
import { resolveMoves } from '@yugao-gaos/turn-based-grid-sdk/engine';

// Keyed model drivers
import { createKeyedAgentDriver } from '@yugao-gaos/turn-based-grid-sdk/agent';

// Node-only CLI launch and status helpers
import { spawnCliAgent } from '@yugao-gaos/turn-based-grid-sdk/agent-cli';
```

The engine and agent entry points do not import a renderer. The engine also
does not depend on any model provider or CLI package.

## Choose a game shape

| You are building | Start with |
| --- | --- |
| Card, drafting, or inventory game | [Zones and card play](/mechanisms/zones-and-card-play) |
| Hidden-role or fog-of-war game | [Information partitions](/mechanisms/information-partitions) |
| Square, hex, graph, or multi-board game | [Locations and layouts](/mechanisms/locations-and-layouts) |
| Sequential or simultaneous multiplayer | [Turn order and lockstep](/mechanisms/turn-order-and-lockstep) |
| Hybrid board/zone game | [Portals](/mechanisms/portals) |
| Agent benchmark or tournament | [Agentic play](/agentic-play) and [portable replay](/mechanisms/replay) |

The [complete capability map](/capabilities) shows which mechanism families
compose without requiring a board.

## Use zones without a board

This two-seat deal uses only collection and information mechanisms:

```ts
import {
  createZone,
  dealRoundRobin,
  deck,
  defineZones,
  hand,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const zones = defineZones({
  deck: createZone(deck(), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']),
  'hand:north': createZone(hand('north')),
  'hand:south': createZone(hand('south')),
});

const dealt = dealRoundRobin(zones, {
  from: 'deck',
  to: ['hand:north', 'hand:south'],
  count: 2,
  seed: 42,
});

if (!dealt.ok) throw new Error(dealt.message);
console.log(dealt.dealt);
```

The shuffle and deal order replay exactly from seed `42`. Seat-view helpers can
show each hand only to its owner while preserving the public card counts.

## Resolve spatial contention

Movement intents qualify together. Static board policy remains an injected
callback:

```ts
import { resolveMoves } from '@yugao-gaos/turn-based-grid-sdk/engine';

const result = resolveMoves(
  [
    { id: 'alpha', from: [0, 0], to: [1, 0], priority: 0 },
    { id: 'beta', from: [2, 0], to: [1, 0], priority: 1 },
  ],
  (x, y) => x < 0 || y < 0,
);

console.log(result.get('alpha')); // [1, 0]
console.log(result.get('beta'));  // [2, 0]
```

For multi-wave consequences, use [`runSettlementCascade`](/settlement). For
the detailed mechanism catalog, ordering rules, edge cases, and product adapter
boundaries, see the [mechanism reference](/mechanisms/).

## Make your reducer agent-ready

Implement three deterministic operations: initialize state, apply an action,
and project a turn view. Imperfect-information games may additionally project
a view for one seat.

```ts
import {
  AgentEnvironment,
  type TurnReducer,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const reducer: TurnReducer<MyLevel, MyState, MyView> = {
  init: (level, seed) => createState(level, seed),
  apply: (state, action) => applyAction(state, action),
  view: (state) => observeState(state),
  viewFor: (state, seat) => observeStateForSeat(state, seat),
};

const environment = new AgentEnvironment({
  reducer,
  level,
  seed: 42,
  seat: 'north',
});

let turn = environment.reset();
while (!turn.done) {
  turn = environment.step(await choose(turn.observation, turn.legalActions));
}

console.log(environment.transcript());
```

`MyView` extends the SDK's `TurnView`; its action definitions are expanded
into fully parameterized legal actions before an agent chooses. Continue with
[information partitions](/mechanisms/information-partitions) and
[Agentic play](/agentic-play). Perfect-information games may omit both
`viewFor` and `seat`.

## Connect to a hosted Arena

```ts
import { ArenaClient } from '@yugao-gaos/turn-based-grid-sdk';

const arena = new ArenaClient(
  'https://api.zonoid.ai',
  process.env.ARENA_API_KEY,
  { timeoutMs: 30_000 },
);

const session = await arena.createSession({
  gameMode: 'challenge',
  playMethod: 'human',
  levelId: 'od-l1',
});

const next = await arena.submitAction(session.sessionId, { id: 'Action 4' });
console.log(next.grid);
```

Persist `session.binding` before a request that may need an exact retry. After
a process restart, call `restoreSessionBinding(binding)` and reuse the original
`submissionId`; `getSessionBinding(sessionId)` returns the latest JSON-safe
snapshot. To prevent an old retry key from being paired with a newly fetched
cursor, a fresh client requires either the original `cursor` or a restored
binding when `submissionId` is explicit.

Requests time out after 30 seconds by default; set `timeoutMs: 0` to disable
that bound. The third argument can also inject `fetch` or a shared
`AbortSignal`. Dynamic path segments are URL-encoded, and API errors expose the
HTTP status plus the raw `responseBody` when an upstream returns non-JSON
diagnostics.

## Next steps

- Learn [which layer owns each API](/architecture).
- Browse the [complete mechanism reference](/mechanisms/).
- Integrate [same-turn recursive settlement](/settlement).
- Connect [model drivers, tools, and agent CLIs](/agentic-play).
- Use the [Python client and Gym-style environment](/python).
