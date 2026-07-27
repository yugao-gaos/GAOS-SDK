# Agentic play

GAOS turns a product-owned reducer into a structured environment for local
policies, model drivers, and MCP-capable agent CLIs. Agents reach the same
rules and canonical actions as human players.

## Environment contract

`AgentEnvironment` advances one deterministic tick at a time:

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
```

Each tick exposes the product observation, fully parameterized legal actions,
reward, metrics, and separate termination and safety-truncation state.
Seat-scoped environments use `reducer.viewFor` and never enumerate actions
from the privileged full view.

The product owns observations, legal-action meaning, reward policy, and agent
decision cadence. GAOS owns the environment lifecycle, concrete-action
validation, deterministic transcript, and safety bounds.

## Multi-agent episodes

`MultiAgentEnvironment` runs independent seat policies against one reducer.
Sequential play applies the active seat's action; simultaneous play collects
one intent per seat and advances once in canonical seat order.

Each policy receives only its seat's redacted observation. The transcript
stores canonical action batches, per-seat views, rewards, and outcomes without
exposing another seat's hidden state.

## Drivers and tools

The provider-neutral tool adapter exposes:

- `observe`
- `act`
- `reset`
- `transcript`

The `./agent` entry point includes a driver registry and keyed HTTP drivers.
The Node-only `./agent-cli` entry point launches MCP-capable CLIs such as
Claude Code, Codex, Cursor, Grok, OpenCode, or Ollama-backed Claude Code.

```sh
gaos-agent drivers
gaos-agent status codex

gaos-agent run openai \
  --module ./environment.mjs \
  --model your-model-id \
  --seed 42

gaos-agent spawn codex \
  --mcp-url http://127.0.0.1:9000/mcp \
  --prompt "Complete the episode" \
  --tools observe,act
```

Model and CLI integrations must return a concrete legal
`SubmittedAction` before the reducer sees it. Product code retains prompts,
provider selection, authentication, takeover policy, and hosted MCP servers.

## From evaluation to evidence

An evaluation transcript is not automatically independently verifiable. For a
published result, run the driver as an ordinary signed session seat and package
the canonical submissions as `gaos.replay`.

The verifier then needs:

1. the replay artifact;
2. the historical product reducer;
3. the semantic mappings from signed commands to reducer actions; and
4. an independently trusted identity for that verifier code.

In v0.25, the scoring authority can supply a pinned adapter directly or resolve
a product-owned verifier kit containing the reducer and semantic adapter.
GAOS handles the package contract, integrity, resolution, caching, and
restricted execution; products retain publication, retention, identity, and
score-adoption policy.

## Python

Python provides a Gymnasium-compatible `ArenaEnv` for hosted games:

```python
from agilabs_arena import ArenaEnv, run_agent_episode

env = ArenaEnv("od-l1", play_method="autonomous_local")
result = run_agent_episode(
    env,
    lambda observation, info: observation["concrete_actions"][0],
)
```

Python does not include the local TypeScript reducer engine, model drivers, or
CLI launchers.

[Build a reducer →](/quickstart) ·
[Read the Python boundary →](/python) ·
[Understand verification →](/trust-and-verification)
