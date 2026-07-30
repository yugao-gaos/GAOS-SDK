# Python SDK surface

The Python distribution is GAOS's Game-as-a-Benchmark integration surface for
research harnesses. It provides a zero-runtime-dependency hosted client,
provider-neutral evaluation helpers, and portable replay utilities. It targets
Python 3.10 or newer.

## Capability boundary

Python is the research and hosted-integration surface. It can:

- create and control sessions on a protocol-compatible host;
- run duck-typed policies for one episode or a batch;
- parse, validate, and serialize canonical `gaos.replay` JSONL; and
- use synchronous or asynchronous hosted clients.

Python does **not** include the TypeScript mechanism engine, a local
`TickReducer` runtime, replay re-simulation, model-provider drivers, or agent
CLI launchers. Build the game and its authoritative reducer with the
[TypeScript SDK](/quickstart#install-the-typescript-sdk), then use Python when a
research harness needs to control the hosted game or inspect portable evidence.

## Install

Install the v0.26 Python package directly from the tagged repository:

```sh
python -m pip install "git+https://github.com/yugao-gaos/GAOS-SDK.git@v0.26.0#subdirectory=python"
```

The distribution name is `gaos-sdk` and the import name is `gaos_sdk`.

Async applications can use `AsyncSessionClient`, which runs the same validated,
bounded requests in worker threads without blocking the event loop.

## Hosted client

Use `SessionClient` for any host that implements `/v1/sessions`. Its
observations and commands remain opaque:

```python
from gaos_sdk import SessionClient

client = SessionClient("https://host.example")
created = client.create_session({"game": "creator/cards"})
print(created["tick"])
```

The client speaks the `gaos.ticks` v1 envelope on `/v1/sessions`. Commands
carry the session cursor, participant, and a deterministic submission ID:
reuse it for an exact retry and create a new one for each logical control step.

`run_agent_episode` and `evaluate_agent_episodes` accept any duck-typed
environment with Gymnasium-compatible `reset()` and `step()` methods. They do
not provide a product environment, choose a model provider, or define what a
benchmark score means. Product repositories own their typed clients and
environment adapters.

## Exchange portable replay evidence

```python
from gaos_sdk import (
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

For lower-level envelope operations, see the complete
[Python README on GitHub](https://github.com/yugao-gaos/GAOS-SDK/blob/main/python/README.md).
