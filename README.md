# Gaming AGI Open SDK (GAOS)

GAOS stands for **Gaming AGI Open SDK**.

**An open-source, community-driven SDK for building game-as-benchmark arenas
where humans and AI agents compete on equal terms and are evaluated by the same
standards to help advance AGI.**

GAOS is a general-purpose SDK for deterministic, verifiable, agent-compatible
games. Its composable mechanism suite, turn protocol, replay format, and agent
runtime support many game families; grids are one optional spatial module
alongside hex/graph layouts, zones, cards, hidden information, portals, turn
systems, settlement, and multi-agent evaluation.

The repository contains six layers:

- a genre-neutral v1 turn envelope, cursor, retry, and simultaneous-intent
  protocol;
- reference clients and observation types for GAOS-hosted Arena sessions;
- reusable layouts, movement, settlement, turn order, information partitions,
  zones, card composition, portals, pathfinding, pattern matching, lockstep
  re-simulation, scoring, solving, and portable JSONL replay verification
  through the `./engine` package subpath;
- deterministic single- and multi-agent episodes with concrete action
  discovery, frame skip, Gym-style termination, per-seat rewards, transcripts,
  batch evaluation, and portable tools;
- extensible keyed-model drivers for Anthropic, OpenAI, xAI, and OpenRouter;
- reusable launch recipes and a standalone CLI for Claude Code, Ollama-backed
  Claude Code, Codex, Cursor, Grok, OpenCode, and declarative custom agents.

Product content and policy are not included. Characters, cards, abilities,
authored boards/decks/levels, objectives, and seasonal/server rules stay in
the integrating product.

**[Read the documentation](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/)**
or begin with the [quickstart](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/quickstart).
For SDK questions, ideas, and community support, [join the GAOS Discord community](https://discord.gg/vdvUgcqPU).

**Built with GAOS:** [Zonoid](https://zonoid.ai) is the toolkit's first
production game and live reference.

## Built during OpenAI Build Week

The **GAOS SDK is the submitted project**. This standalone repository was
created on July 21, 2026 during OpenAI Build Week, and its complete commit and
release history was produced during the event. The work turned the reusable
mechanism engine, deterministic agent evaluation environment, provider-neutral
drivers, and CLI integrations into an independently installable open-source
toolkit with TypeScript and Python releases.

The pre-existing Zonoid platform is outside the submission scope, but was
central to production. As the game evolved, GAOS generalized its initial
spatial engine into reusable game-mechanism, multiplayer, verification, and
agent capabilities; Zonoid then validated them in a live product. Judges can register at
[zonoid.ai](https://zonoid.ai) and download the game without rebuilding its
platform source. The [GPT-5.6 Sol case study](docs/building-with-gpt-5-6-sol.md)
records Codex's role in extraction, design, implementation, review, publishing,
and agent-play testing.

## Devpost judge guide

GAOS is submitted in the **Developer Tools** category. The copy-ready project
description, URLs, installation details, test instructions, and `/feedback`
Session ID are collected in [DEVPOST.md](DEVPOST.md).

### Public links

- **Source:** https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK
- **Documentation:** https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/
- **Release:** https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.16.0
- **Community:** https://discord.gg/vdvUgcqPU
- **Live game and prebuilt download:** https://zonoid.ai

### Install and test a prebuilt release

The public release artifacts require no repository checkout or GitHub token.

TypeScript / Node.js:

```sh
mkdir gaos-judge
cd gaos-judge
npm init -y
npm install 'https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/download/v0.16.0/yugao-gaos-turn-based-grid-sdk-0.16.0.tgz'
node --input-type=module -e "import { scoreStars } from '@yugao-gaos/turn-based-grid-sdk/engine'; console.log(scoreStars(6, { three: 6, two: 9 }))"
```

The final command prints `3`.

Python:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install 'https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/download/v0.16.0/gaos_turn_based_grid_sdk-0.16.0-py3-none-any.whl'
.venv/bin/python -c "import agilabs_arena; print(agilabs_arena.__name__)"
```

The final command prints `agilabs_arena`. On Windows, use
`.venv\Scripts\python` instead of `.venv/bin/python`.

For the product demonstration, visit [zonoid.ai](https://zonoid.ai), register
with an email address, and download the prebuilt live game.

### Supported platforms

| Surface | Support |
|---|---|
| TypeScript engine, protocol, and agent runtime | ES2022 ESM; Node.js 22 recommended and CI-tested |
| Hosted clients and keyed drivers | ES2022 ESM runtime with standards-compatible `fetch` |
| Agent CLI launchers | Node.js 22; macOS and Linux tested; selected external CLI must be installed |
| Python client and environment | Python 3.10+; Python 3.12 CI-tested |
| Source CI | Ubuntu GitHub Actions; local development also verified on macOS |

### Run the full verification suite

```sh
git clone https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git
cd GAOS-TurnBasedGrid-SDK
npm ci
npm run typecheck
npm test
npm run build
npm run docs:build

python3 -m venv .venv
.venv/bin/python -m pip install build pytest
PYTHONPATH=python .venv/bin/python -m pytest python/tests
.venv/bin/python -m build python
```

Live integration tests use `ARENA_BASE_URL` and skip automatically when a
compatible host is unavailable. The deterministic engine, solver, replay,
agent, and packaging tests run without Zonoid credentials.

### How Codex and GPT-5.6 accelerated the project

Codex with GPT-5.6 Sol was used throughout the production loop:

1. concepting through built-in image generation and editing;
2. translating approved concepts into production work for Seedance video,
   World Labs worlds, and Tripo 3D models;
3. autonomous implementation review, regression discovery, and revision;
4. coding the game and extracting the reusable SDK, including deterministic
   settlement, grid mechanisms, agent environments, drivers, tools, and CLIs;
5. publishing packages, releases, documentation, and presentation websites; and
6. testing through ordinary suites plus LLM play against the same deterministic
   reducer used by human-facing gameplay.

The detailed evidence, key decisions, and human approval boundaries are in
[Building GAOS and Zonoid with GPT-5.6 Sol](docs/building-with-gpt-5-6-sol.md).

## One agent turn

| State | Legal actions | Agent chooses | Deterministic result |
|---|---|---|---|
| `position: 1`<br>`status: playing`<br>`actionsUsed: 1` | `{ id: 'advance' }`<br>`{ id: 'jump', index: 2 }` | `{ id: 'jump', index: 2 }` | `position: 3` → **won**<br>`reward: +3` · `totalReward: 3` · **3★** |

`AgentEnvironment` exposes the product state and concrete legal gameplay
actions. Products may additionally expose semantic `systemActions` such as
Restart; those controls remain separate from hidden, shuffled, or
state-filtered gameplay actions but are valid agent choices. The environment
validates either kind, applies the injected reducer once per recorded tick
(or across the configured frame skip), and returns the scoring result with
transcript-ready metrics.

## More than grids

GAOS supports card-only, board-only, graph, hidden-role, drafting, tactics, and
hybrid games. Mechanism families are optional and composable:

- sequential, simultaneous, response-priority, or high-frequency turns;
- square, axial-hex, graph, multi-board, or no board at all;
- decks, hands, bags, queues, slots, shuffling, drawing, and dealing;
- per-seat hidden information, fog, teams, revelations, and spectators;
- keywords, targeting, durations, phases, patterns, and loadout validation;
- settlement, claims, resources, portals, pushes, projectiles, and transport;
- single/multi-agent environments, solvers, lockstep, and portable replay.

[Browse the complete capability map](docs/capabilities.md).

## Portable benchmark replays

`gaos.replay` v1 is the SDK-owned evidence format shared by game hosts and
benchmark tooling. Its JSONL header pins the game and historical reducer
adapter, run seed, explicit per-level seeds and definitions, per-level results,
and aggregate totals. Following lines are level-indexed `TranscriptAction`
records.

```ts
import {
  createReplayArtifact,
  recheckReplayArtifact,
  serializeReplayJsonl,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const artifact = createReplayArtifact({
  sessionId: 'run-42',
  game: {
    id: 'creator/my-game',
    version: '1.3.0',
    adapter: { id: 'creator/my-game/reducer', version: 'commit:abc123' },
  },
  seed: 42,
  perm: [0, 1],
  levels,
  actions,
});

const jsonl = serializeReplayJsonl(artifact);
const checked = recheckReplayArtifact(artifact, reducerRegistry);
```

Arena runs and TabletopLabs creator games can therefore emit the same
self-identifying artifact and be verified by the same SDK tooling. Existing
single-level `TranscriptHeader` + `TranscriptAction` data lifts through
`transcriptToReplayArtifact`.

## TypeScript

The npm package is published through GitHub Packages. Configure the GitHub npm
registry and authenticate with a token that can read packages:

```ini
@yugao-gaos:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
npm install @yugao-gaos/turn-based-grid-sdk
```

Repositories with GitHub access can instead pin an exact release tag without
configuring the npm registry:

```sh
npm install 'git+https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git#v0.16.0'
```

Use the hosted Arena client:

```ts
import { ArenaClient } from '@yugao-gaos/turn-based-grid-sdk';

const arena = new ArenaClient('https://api.zonoid.ai', process.env.ARENA_API_KEY, {
  timeoutMs: 30_000,
});
const session = await arena.createSession({
  gameMode: 'challenge',
  playMethod: 'human',
  levelId: 'od-l1',
});

const next = await arena.submitAction(session.sessionId, { id: 'Action 4' });
console.log(next.grid);
```

Protocol-only hosts can use the subpath without importing Arena adapter types:

```ts
import {
  GameRegistry,
  collectIntent,
  createIntentWindow,
} from '@yugao-gaos/turn-based-grid-sdk/protocol';
```

Deterministic runtimes can consume the reusable engine without importing the
hosted Arena client:

```ts
import {
  deriveSeatView,
  evaluateBehaviorTree,
  findPatterns,
  planPortalTransits,
  planPushChain,
  planZoneTransfer,
  resolveGateTransition,
  resolveMoves,
  resolveChainReaction,
  runSettlementCascade,
  scoreStars,
  solveLevel,
  stateDigest,
} from '@yugao-gaos/turn-based-grid-sdk/engine';
```

The product supplies its reducer, authored content, legality, effects, and
scoring thresholds. See [Engine boundary](docs/engine.md) for the ownership and
adapter contracts, the [mechanism reference](docs/mechanisms/index.md) for
zones, portals, layouts, and interactions, and [Deterministic turn
settlement](docs/settlement.md) for multi-step same-turn consequence
resolution.

Run an agent locally against any injected deterministic reducer:

```ts
import {
  AgentEnvironment,
  runAgentEpisode,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const environment = new AgentEnvironment({ reducer, level, seed: 42 });
const episode = await runAgentEpisode(
  environment,
  async (turn) => agent.choose(turn.observation, turn.legalActions, turn.systemActions),
);

console.log(episode.transcript.result);
```

See [Agentic play](docs/agentic-play.md) for local, hosted, batch-evaluation,
Python, and tool/MCP integration patterns.

Run a keyed model directly through the reusable driver contract:

```ts
import {
  createKeyedAgentDriver,
  runAgentDriverEpisode,
} from '@yugao-gaos/turn-based-grid-sdk/agent';

const driver = createKeyedAgentDriver('openai', {
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'your-model-id',
  maxHistoryTurns: 8,
  maxRetries: 2,
  timeoutMs: 30_000,
});
const result = await runAgentDriverEpisode(environment, driver);
```

Or use the installed executable. Keys are read from provider environment
variables and are never accepted on the command line:

```sh
gaos-agent drivers
gaos-agent check openai
gaos-agent run openai --module ./environment.mjs --model your-model-id
gaos-agent spawn codex --mcp-url http://127.0.0.1:9000/mcp --prompt "Complete the episode"
OLLAMA_MODEL=qwen3.5 gaos-agent spawn ollama --mcp-url http://127.0.0.1:9000/mcp --prompt "Complete the episode"
```

Node applications can import CLI launch/status APIs from the `./agent-cli`
subpath. The core `./engine` and `./agent` subpaths do not depend on a CLI or a
provider package.

Agent interruption is capability-driven. Keyed drivers implement `interrupt()`
by aborting the active request while retaining completed conversation history.
CLI processes expose the same result contract: resumable recipes continue their
stable session, while runners without safe continuation report `unsupported`.
Products decide when to interrupt; each SDK runner decides how.

## Python

Python wheels and source distributions are attached to each GitHub release.
The distribution is named `gaos-turn-based-grid-sdk`; the stable import name
remains `agilabs_arena` for compatibility with existing integrations.

```sh
pip install gaos_turn_based_grid_sdk-0.16.0-py3-none-any.whl
```

```python
from agilabs_arena import ArenaClient

arena = ArenaClient("https://api.zonoid.ai", api_key="ak_...", timeout=30.0)
session_id, turn = arena.create_session(
    game_mode="challenge",
    play_method="human",
    level_id="od-l1",
)
print(turn.grid)
```

See [the Python guide](python/README.md) for the Gymnasium-style environment
and hosted Arena matchmaking API.

## Protocol boundary

The stable `agilabs.turns` v1 contract owns session cursors, idempotent command
submissions, pending/resolved envelopes, and deterministic collection of
simultaneous intents. It deliberately does not define grids, actions, scoring,
authentication, persistence, or game rules.

See [Protocol v1](docs/protocol-v1.md) for the compatibility contract.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run docs:build

cd python
PYTHONPATH=. python3 -m pytest tests
python3 -m build
```

Live integration tests use `ARENA_BASE_URL` and skip automatically when a
compatible API host is not available.

Use `npm run docs:dev` to work on the documentation locally. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks and [SECURITY.md](SECURITY.md)
for private vulnerability reporting.

## Releases

Package versions follow semantic versioning. A GitHub release with tag
`vX.Y.Z` validates both SDKs, publishes the npm package to GitHub Packages, and
attaches the Python wheel and source distribution to the release.

## License

Licensed under the [Apache License 2.0](LICENSE).
