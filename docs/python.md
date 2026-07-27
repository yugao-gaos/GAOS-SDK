# Python SDK surface

The Python distribution is GAOS's Game-as-a-Benchmark integration surface for
research harnesses. It provides a zero-runtime-dependency hosted client, a
Gymnasium-compatible environment API, provider-neutral evaluation helpers, and
portable replay utilities. It targets Python 3.10 or newer and does not require
Gymnasium at runtime.

## Capability boundary

Python is the research and hosted-integration surface. It can:

- create and control sessions on a protocol-compatible host;
- expose a hosted session through Gymnasium-compatible `reset()` and `step()`;
- run duck-typed policies for one episode or a batch;
- parse, validate, and serialize canonical `gaos.replay` JSONL; and
- use synchronous or asynchronous hosted clients.

Python does **not** include the TypeScript mechanism engine, a local
`TickReducer` runtime, replay re-simulation, model-provider drivers, or agent
CLI launchers. Build the game and its authoritative reducer with the
[TypeScript SDK](/quickstart#install-the-typescript-sdk), then use Python when a
research harness needs to control the hosted game or inspect portable evidence.

## Install from a release

Python wheels and source distributions are attached to each GitHub release.
Install the current wheel directly:

```sh
python -m pip install "https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/download/v0.25.0/gaos_turn_based_grid_sdk-0.25.0-py3-none-any.whl"
```

For a different release, replace both `0.25.0` occurrences with the same
version. The distribution is named `gaos-turn-based-grid-sdk`; the stable
import name remains `agilabs_arena` for compatibility. The
[naming roadmap](/roadmap) describes the future coordinated rename.

Async applications can use `AsyncArenaClient`, which runs the same validated,
bounded requests in worker threads without blocking the event loop. The
existing synchronous `ArenaClient` API remains unchanged.

## Hosted client

```python
from agilabs_arena import ArenaClient

arena = ArenaClient("https://api.zonoid.ai", api_key="ak_...", timeout=30.0)
session_id, tick = arena.create_session(
    game_mode="challenge",
    play_method="human",
    level_id="od-l1",
)
print(tick.grid)
```

The client speaks the `agilabs.ticks` v1 envelope on `/v1/sessions`. Commands
carry the session cursor, participant, and a deterministic submission ID:
reuse it for an exact retry and create a new one for each logical control step.
`play_method="human"` is intentional in this example: it shows direct hosted
control for a person or application. Use `autonomous_local` for an agent
evaluation.

## Gymnasium-compatible environment API

```python
from agilabs_arena import ArenaEnv

env = ArenaEnv(
    "od-l1",
    base_url="http://localhost:8899",
    play_method="autonomous_local",
)
observation, info = env.reset()
print(observation["grid"])
print(observation["concrete_actions"])

observation, reward, terminated, truncated, info = env.step(
    observation["concrete_actions"][0]
)
```

The observation includes both action definitions and fully parameterized
`concrete_actions`. Rewards are terminal stars, or zero before completion.

## Evaluate an agent

```python
from agilabs_arena import ArenaEnv, run_agent_episode

env = ArenaEnv("od-l1", play_method="autonomous_local")
result = run_agent_episode(
    env,
    lambda observation, info: observation["concrete_actions"][0],
)
```

`run_agent_episode` and `evaluate_agent_episodes` accept any duck-typed
environment with Gymnasium-compatible `reset()` and `step()` methods. They do
not choose a model provider or define what a benchmark score means.

## Exchange portable replay evidence

```python
from agilabs_arena import (
    parse_replay_jsonl,
    serialize_replay_jsonl,
    validate_replay_artifact,
)

with open("run.gaos-replay.jsonl", encoding="utf-8") as source:
    artifact = parse_replay_jsonl(source.read())

errors = validate_replay_artifact(artifact)
if errors:
    raise ValueError(errors)

canonical_jsonl = serialize_replay_jsonl(artifact)
```

Validation checks the replay envelope, schema, sequence, digests, and canonical
transport representation. It does not execute the game. Full rechecking
requires the pinned historical reducer and authored content. Use the
TypeScript `gaos verify` adapter contract or provide a Python
`recheck_replay(artifact)` adapter whose result includes semantic
command/timeout binding facts for signed evidence. See
[portable replay and verification](/mechanisms/replay).

For matchmaking, control revision, and lower-level envelope operations, see
the complete [Python README on GitHub](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/blob/main/python/README.md).
