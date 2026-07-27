# Quickstart

Build one product-owned reducer, run it for a person or agent, and preserve the
same canonical actions for replay verification.

## Choose your language

| Capability | TypeScript | Python |
|---|---|---|
| Local mechanism engine and reducer runtime | Yes | No |
| Local agent environments and model drivers | Yes | No |
| Hosted Arena client | Yes | Yes |
| Replay parsing and exchange | Yes | Yes |
| Replay re-simulation | Yes | No |
| Gymnasium-compatible hosted environment | No | Yes |

Use TypeScript to build a game or local benchmark runtime. Use Python to control
a compatible hosted game from evaluation code. Python intentionally does not
duplicate the TypeScript mechanism engine.

## Install TypeScript

The package is currently published through GitHub Packages:

```ini
@yugao-gaos:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
npm install @yugao-gaos/turn-based-grid-sdk
```

Or pin the released repository:

```sh
npm install 'git+https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git#v0.25.0'
```

## Build a reducer

The product owns the state, rules, legal actions, and meaning. GAOS defines the
deterministic adapter consumed by play, agents, sessions, and replay:

```ts
import {
  AgentEnvironment,
  type TickReducer,
  type TickView,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

type Level = { goal: number };
type State = { position: number; goal: number };

const reducer: TickReducer<Level, State> = {
  init: (level) => ({ position: 0, goal: level.goal }),
  advance: (state, inputs) => {
    const action = inputs[0];
    if (!action) return state;
    if (action.id !== 'advance') throw new Error('illegal action');
    return { ...state, position: state.position + 1 };
  },
  view: (state): TickView => ({
    actions: [{ id: 'advance', params: 'none' }],
    status: state.position >= state.goal ? 'won' : 'playing',
  }),
};
```

The same `init`, `advance`, and `view` operations can drive a renderer or hosted
session. Imperfect-information products add `viewFor(state, seat)`.

## Run an agent

```ts
const environment = new AgentEnvironment({
  reducer,
  level: { goal: 3 },
  seed: 42,
});

let tick = environment.reset();
while (!tick.done) {
  tick = environment.step(tick.legalActions[0]!);
}

console.log(environment.transcript().result);
```

Agents receive structured observations and concrete legal actions from the same
reducer used by ordinary play. Model drivers, MCP tools, and installed agent
CLIs sit above this environment contract.

## Make the run checkable

For scored sessions, assign each seat an Ed25519 key and record canonical
submissions in a `gaos.replay` artifact. Verification can receive the
product's pinned historical adapter explicitly:

```sh
gaos verify run.gaos-replay.jsonl --adapter ./historical-adapter.mjs
```

The adapter resolves the historical reducer and independently maps signed
commands to reducer actions. Missing historical code produces
`unverifiable`; conflicting evidence produces `rejected`.

v0.25 also lets products export their reducer and semantic adapter as a
content-addressed verifier kit. GAOS provides packing, resolution, caching,
and restricted-execution contracts. Products still own publication and
retention, and an independent policy must authorize the kit digest.

## Choose the next guide

- [Mechanism reference](/mechanisms/) — compose boards, zones, information,
  movement, settlement, randomness, and scoring.
- [Agentic play](/agentic-play) — connect policies, model drivers, or CLIs.
- [Sessions and integrity](/session-and-integrity) — host authoritative play.
- [Python SDK](/python) — control a hosted environment from research code.
- [Trust and verification](/trust-and-verification) — understand verdicts and
  the v0.25 verifier-kit boundary.
