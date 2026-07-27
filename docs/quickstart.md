# Quickstart

GAOS gives game developers and Game-as-a-Benchmark creators the same starting
point: one reducer that can power human play, agent play, and replay
verification.

- **Building a game?** Start with the mechanism family closest to your game,
  then wrap the finished reducer with `AgentEnvironment` when you want an AI
  player, solver, tournament, or evaluation.
- **Building a Game-as-a-Benchmark product?** Start with the environment
  contract and use the mechanism suite to create deeper interactive tasks
  without building a game runtime from scratch.

You can also use the TypeScript engine by itself or connect either language to
a protocol-compatible host. All paths converge on the same deterministic game
contract, but the two distributions intentionally expose different scopes.

The current repository and package names remain in use until the coordinated
[naming roadmap](/roadmap) is ready.

## Choose your language

| Capability | TypeScript SDK | Python SDK |
| --- | --- | --- |
| Hosted Arena client | Yes | Yes |
| Local mechanism engine and `TickReducer` runtime | Yes | No |
| Local single- and multi-agent environments | Yes | No local engine; hosted `ArenaEnv` and generic evaluation helpers |
| Portable replay parse, validation, and serialization | Yes | Yes |
| Replay re-simulation through a pinned reducer | Yes | No |
| Model-provider drivers and agent CLI launchers | Yes | No |
| Gymnasium-compatible environment API | No | Yes, without a Gymnasium runtime dependency |

Choose **TypeScript** to build a game, local benchmark runtime, solver, or
provider-integrated agent loop. Choose **Python** to control a compatible
hosted game from research and evaluation code, or to exchange portable replay
artifacts. The Python distribution does not contain a second implementation of
the TypeScript mechanism engine.

[Start with the Python SDK surface →](/python)

## Install the TypeScript SDK

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
npm install 'git+https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git#v0.20.0'
```

## Choose the narrowest entry point

```ts
// Hosted Arena adapter and public wire types
import { ArenaClient } from '@yugao-gaos/turn-based-grid-sdk';

// Product-neutral tick protocol
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
| Sequential or simultaneous multiplayer | [Ticks and lockstep](/mechanisms/ticks-and-lockstep) |
| Hybrid board/zone game | [Portals](/mechanisms/portals) |
| Game-as-a-Benchmark evaluation or tournament | [Agentic play](/agentic-play) and [portable replay](/mechanisms/replay) |

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

## Build a runnable reducer

Implement three deterministic operations: initialize state, advance one tick,
and project a tick view. Imperfect-information games may additionally project
a view for one seat.

```ts
import {
  AgentEnvironment,
  runAgentEpisode,
  type TickReducer,
  type TickView,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

type Level = { goal: number };
type State = { position: number; goal: number; actionsUsed: number };

const reducer: TickReducer<Level, State> = {
  init: (level) => ({
    position: 0,
    goal: level.goal,
    actionsUsed: 0,
  }),
  advance: (state, inputs) => {
    const action = inputs[0];
    if (!action) return state;
    if (action.id !== 'advance') throw new Error('illegal action');
    return {
      ...state,
      position: state.position + 1,
      actionsUsed: state.actionsUsed + 1,
    };
  },
  view: (state): TickView => ({
    actions: [{ id: 'advance', params: 'none' }],
    status: state.position >= state.goal ? 'won' : 'playing',
    hud: { actionsUsed: state.actionsUsed },
  }),
};

const environment = new AgentEnvironment({
  reducer,
  level: { goal: 3 },
  seed: 42,
});

const episode = await runAgentEpisode(
  environment,
  (tick) => tick.legalActions[0]!,
);
console.log(episode.transcript.result);
```

This example is complete: the same `reducer.init`, `reducer.apply`, and
`reducer.view` calls can power a human renderer without
`AgentEnvironment`. Action definitions are expanded into fully parameterized
legal actions before an agent chooses. For imperfect information, add
`viewFor(state, seat)` and pass a `seat` to the environment. Continue with
[information partitions](/mechanisms/information-partitions) and
[Agentic play](/agentic-play).

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

For exact retry after a restart, persist the session binding and reuse the
original submission ID. The [tick protocol v1 guide](/protocol-v1) covers
cursors, idempotency, pending envelopes, timeouts, and low-level transport
behavior.

## Sign and verify a run offline

For a scored run, generate one Ed25519 key per seat, put the public keys in
`SessionKernelOptions.seatKeys`, and set:

```ts
signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' }
```

Before submitting a command, construct its exact envelope and attach the
result:

```ts
const envelope = {
  sessionId,
  seat,
  submissionId,
  cursor: kernel.cursor(),
  tick: kernel.tick(),
  clientTime: Date.now(),
  command,
  prevChainHash: chainHead,
};

submission.clientTime = envelope.clientTime;
submission.prevChainHash = envelope.prevChainHash;
submission.sig = await signSubmissionV1(privateKey, envelope);
chainHead = submissionChainHashV1(envelope);
```

Persist the envelope and new chain head so an exact transport retry reuses
both. After terminal gameplay, `finalizeReplay` emits v1.2. Export a small
adapter module whose default export resolves the historical reducer and whose
`semanticAdapterForLevel` export supplies the matching historical
`commandToAction` function, then run:

```sh
gaos verify run.gaos-replay.jsonl --adapter ./historical-adapter.mjs
```

The command prints `trusted` only when replay, signatures, chains, the
declared periodic policy, and command-to-action reconstruction all check. It
uses no service or network. See
[trust and verification](/trust-and-verification) for complete imports,
periodic signatures, Python, key handling, and limits.

## Next steps

- Learn [which layer owns each API](/architecture).
- Browse the [complete mechanism reference](/mechanisms/).
- Integrate [same-tick recursive settlement](/settlement).
- Connect [model drivers, tools, and agent CLIs](/agentic-play).
- Publish [signed evidence anyone can verify](/trust-and-verification).
- Use the [Python SDK and Gymnasium-compatible environment API](/python).
