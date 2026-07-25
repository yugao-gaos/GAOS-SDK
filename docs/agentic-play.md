# Agentic play

The SDK is agent-playable because agents can discover and operate a deterministic
environment without a renderer, a particular model provider, or product-owned
control code.

## Environment contract

`AgentEnvironment` wraps any injected `TickReducer`. Each `step()` advances
exactly one tick and returns:

- the complete product observation, or the configured seat's redacted view;
- action definitions and fully parameterized concrete legal actions;
- the last reward and cumulative episode metrics;
- separate `terminated` and `truncated` flags;
- the seed, tick count, score, budget usage, and termination reason.

```ts
import { AgentEnvironment } from '@yugao-gaos/turn-based-grid-sdk/engine';

const env = new AgentEnvironment({
  reducer,
  level,
  seed: 42,
  seat: 'north',
  maxTicks: 1_000,
});

let tick = env.reset();
while (!tick.done) {
  const action = await chooseAction(tick.observation, tick.legalActions);
  tick = env.step(action);
}

const transcript = env.transcript();
```

When `seat` is configured, the environment calls `reducer.viewFor` when that
method exists, derives legal actions from the returned view, attaches the seat
to reducer submissions, and rejects an explicit conflicting seat. It never
uses the full view to enumerate a seat's legal actions.

Levels and observations are snapshotted with `structuredClone` so later caller
mutations cannot rewrite a transcript. Products with non-cloneable values can
supply `snapshotLevel` and `snapshotObservation` in the environment options.
Transcript version 1.3 includes the seat, the redacted initial observation,
and the redacted observation following every applied tick. A product that
wants a lower agent decision cadence holds or repeats actions in its own
policy loop; the SDK does not define that product behavior.

Products may inject reward shaping and custom action enumeration. The default
reward is terminal stars, or `1` for a win without stars. For a decided
multi-seat outcome it uses that seat's score when present, otherwise `1` for
rank one and `0` for another rank. Reducer failure or a decided outcome is a
normal termination; reaching `maxTicks` is a safety truncation.

## Multi-agent episodes

`MultiAgentEnvironment` runs independent seat policies against one reducer.
Sequential participation applies the active seat's non-wait action and gives
other seats the configured legal `wait`. Simultaneous participation collects
one intent per seat and calls `reducer.advance` exactly once with canonical
lexical seat ordering.

Each policy receives only its seat's `viewFor` observation and concrete legal
actions. `runMultiAgentEpisode` solicits policies concurrently; a missing
policy contributes `wait`. The shared transcript stores redacted per-seat
observations, canonical batches, and per-seat rewards/outcomes so an arena can
replay and compare model-vs-model episodes without exposing another seat's
hidden state.

## Evaluation

`runAgentEpisode` accepts synchronous or asynchronous policies.
`evaluateAgentEpisodes` runs a deterministic case list and reports wins,
failures, truncations, mean reward, and mean ticks.

```ts
const result = await evaluateAgentEpisodes(
  cases,
  ({ level, seed }) => new AgentEnvironment({ reducer, level, seed }),
  (tick) => myAgent(tick.observation, tick.legalActions),
);
```

## Tool and MCP adapters

`createAgentToolAdapter(environment)` exposes four provider-neutral operations:

- `observe`
- `act`
- `reset`
- `transcript`

The adapter includes JSON input schemas and has no MCP, OpenAI, Anthropic, or
other provider dependency. An MCP server or model tool API can register the
definitions and forward calls to `adapter.call(name, input)`.

## Keyed model drivers

The `./agent` subpath includes a provider-neutral `AgentDriver` contract and
an extensible `AgentDriverRegistry`. `runAgentDriverEpisode` connects any
driver to `AgentEnvironment`, records each decision, and returns the normal
deterministic transcript.

```ts
import {
  AgentDriverRegistry,
  createKeyedAgentDriver,
  runAgentDriverEpisode,
} from '@yugao-gaos/turn-based-grid-sdk/agent';

const driver = createKeyedAgentDriver('anthropic', {
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'your-model-id',
  maxHistoryTurns: 8,
  maxRetries: 2,
  timeoutMs: 30_000,
});

const registry = new AgentDriverRegistry([driver]);
const result = await runAgentDriverEpisode(
  environment,
  registry.require('anthropic'),
  { guidance: ['Prefer the shortest winning route.'] },
);
```

Built-in keyed providers are Anthropic, OpenAI, xAI, and OpenRouter. The
OpenAI-compatible driver also accepts a custom base URL and headers. Provider
registries can add or replace definitions without changing the episode loop.
Provider calls use `fetch`, so tests can inject an offline implementation.
Completed conversation history is bounded (eight exchanges by default), and HTTP
429/5xx responses receive two abortable exponential-backoff retries. Both
limits and the delay implementation are configurable. Model requests and API
key checks have a 30-second deadline by default; `timeoutMs: 0` disables it.
Caller cancellation, driver interruption, retry waits, and the deadline share
one abort lifecycle.

Model responses are parsed into the same `SubmittedAction` contract and
must exactly match a concrete legal action before the reducer sees them. API
keys are held only by driver instances, are redacted from request failures,
and are not written to transcripts.

## Installed agent CLIs

The Node-only `./agent-cli` subpath owns reusable recipes for MCP-capable agent
CLIs:

- Claude Code
- Ollama + Claude Code
- Codex CLI
- Cursor CLI
- Grok CLI
- OpenCode CLI

The Ollama recipe uses Ollama's official `launch claude` integration: Ollama
hosts the selected local model while Claude Code supplies the headless MCP
agent loop. Install both Ollama and Claude Code, then select a model with
`OLLAMA_MODEL` (default `qwen3.5`):

```sh
OLLAMA_MODEL=qwen3.5 gaos-agent spawn ollama \
  --mcp-url http://127.0.0.1:9000/mcp \
  --prompt "Complete the episode" \
  --tools observe,act
```

The launch is keyless for local models. `ollama run` is intentionally not used
because it is an interactive model prompt, not an MCP agent runtime.

It can resolve executables, run non-token-consuming auth probes, build MCP
configuration, parse transcript streams, and spawn each CLI in a temporary
working directory. Product code supplies the MCP URL, prompt, server name,
and allowed tool names:

```ts
import {
  createDefaultCliAgentRegistry,
  inspectCliAgent,
  spawnCliAgent,
} from '@yugao-gaos/turn-based-grid-sdk/agent-cli';

const spec = createDefaultCliAgentRegistry().require('codex');
console.log(await inspectCliAgent(spec));

const process = spawnCliAgent(spec, {
  mcpUrl: 'http://127.0.0.1:9000/mcp',
  prompt: 'Complete this environment using observe and act.',
  serverName: 'game',
  toolNames: ['observe', 'act'],
});

const exit = await process.completion;
```

CLI configuration files are restricted to the temporary directory and are
removed after exit. A caller can register another `CliAgentSpec`, or set
`GAOS_AGENT_CLIS` to a JSON object with this shape:

```json
{
  "my-agent": {
    "label": "My Agent",
    "bin": "my-agent",
    "args": ["--mcp", "{mcpUrl}", "--prompt", "{prompt}"],
    "files": { ".agent/config.json": "{\"server\":\"{serverName}\"}" }
  }
}
```

Supported placeholders are `{mcpUrl}`, `{prompt}`, `{serverName}`, and
`{allowedTools}`.

## `gaos-agent` executable

The npm package installs `gaos-agent`:

```sh
# Discover and inspect integrations.
gaos-agent drivers
gaos-agent status codex

# Validate a key without making a model call.
export OPENAI_API_KEY=...
gaos-agent check openai

# Run a keyed episode. The module exports createEnvironment({ seed }).
gaos-agent run openai \
  --module ./environment.mjs \
  --model your-model-id \
  --seed 42

# Launch an already-authenticated CLI against any product-owned MCP server.
gaos-agent spawn codex \
  --mcp-url http://127.0.0.1:9000/mcp \
  --prompt "Complete the episode" \
  --tools observe,act
```

Keys are read only from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`,
or `OPENROUTER_API_KEY`. The command intentionally has no API-key argument.
An environment module is ordinary ESM:

```js
import { AgentEnvironment } from '@yugao-gaos/turn-based-grid-sdk/engine';
import { level, reducer } from './my-game.js';

export function createEnvironment({ seed }) {
  return new AgentEnvironment({ reducer, level, seed });
}
```

## Python

`ArenaEnv` exposes a Gymnasium-compatible environment API without requiring
Gymnasium at runtime. It includes `action_definitions` and
`concrete_actions`, and accepts a concrete action object directly:

```python
from agilabs_arena import ArenaEnv, run_agent_episode

env = ArenaEnv("od-l1", play_method="autonomous_local")
result = run_agent_episode(
    env,
    lambda observation, info: observation["concrete_actions"][0],
)
```

`run_agent_episode` and `evaluate_agent_episodes` accept any duck-typed
environment with Gymnasium-compatible `reset()` and `step()` methods, not only
`ArenaEnv`. Python does not include the local TypeScript mechanism engine,
reducer runtime, model drivers, or CLI launchers; see the
[language capability matrix](/quickstart#choose-your-language).

## Evaluation actions versus semantic actions

The environment does not require semantic action names. A product can expose
descriptions for ordinary development while using opaque or permuted ids for
evaluations. In both modes the SDK surfaces only actions that are legal in the
current observation.

## Product boundary

The SDK owns the agent loop, driver contracts, provider transport, CLI launch
mechanics, and deterministic interfaces. Products retain their prompts,
levels, characters, abilities, objectives, reward policy, hosted session
policy, coach rooms, human takeover, anti-cheat rules, authentication, and
leaderboards.
