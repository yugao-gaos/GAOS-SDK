# GAOS Turn-Based Grid Toolkit for Python

Gymnasium-style client for the AgiLabs Arena session API — the environment
wrapper for the hosted Arena API.
Zero runtime dependencies; duck-type-compatible with Gymnasium and
`verifiers`-style harnesses.

## Portable replay

The Python package reads and writes the same canonical `gaos.replay` v1 JSONL
bytes as the TypeScript engine:

```python
from agilabs_arena import parse_replay_jsonl, serialize_replay_jsonl

with open("run.gaos-replay.jsonl", encoding="utf-8") as source:
    artifact = parse_replay_jsonl(source.read())

canonical_bytes = serialize_replay_jsonl(artifact)
```

`validate_replay_artifact` performs transport-level checks without executing
game code. Reducer re-simulation remains product-owned; select the historical
adapter declared in `artifact["header"]["game"]["adapter"]`.

The client speaks the stable `agilabs.turns` v1 envelope on `/v1/sessions`.
Each command carries the session cursor, participant, and a deterministic
`submissionId`: stable for an exact retry, new for each logical control
substep. Solo Arena sessions still feel synchronous;
`submit_action()` transparently polls a bounded number of times when a
multiplayer host returns a `202` pending envelope. Use `submit_intent()` and
`get_turn_envelope()` when integrating a non-grid game with opaque command and
observation shapes.

Hosted live Arena play is explicit and seat-authenticated:

```python
from agilabs_arena import ArenaClient

client = ArenaClient("https://api.zonoid.ai", api_key="ak_...", timeout=30.0)
catalog = client.arena_catalog()  # stable map summaries + curated team ids
ticket = client.join_arena_queue(
    "arena-s1-1",
    "playerbot-mica",
    request_id="keep-this-id-for-retries",
)
while ticket["state"] in ("waiting", "matching"):
    ticket = client.arena_queue_ticket(ticket["queueId"], ticket["ticketId"])

room = client.connect_arena_match(ticket["matchId"])
result = client.submit_arena_intent(ticket["matchId"], {"id": "Action 8"})
client.heartbeat_arena_match(ticket["matchId"])  # at least every five seconds
```

For an exact retry after a restart, persist
`client.get_session_binding(session_id)`, restore it with
`restore_session_binding(binding)`, and reuse the original `submission_id`.
`submit_intent(..., cursor=original_cursor)` also accepts an explicit original
cursor. A fresh client rejects an explicit retry key if it would otherwise
have to fetch and silently pair it with a newer cursor.

Hosted Arena observations include a seat-local `controlRevision`. The client
remembers it and automatically sends the `agilabs.arena` extension plus a new
deterministic submission id for each targeting or conversation substep. A free
control step can therefore return `kind="turn"` at the same world `revision`;
only a committed intent returns `pending` while the opponent is still choosing.

`room["outcome"]` is authoritative: a disconnect/idle forfeit can complete the
network room while its nested last resolved game turn still says `playing`.
The hosted preview is disabled unless the operator configures the Arena adapter
and map; it does not consume the future paid Arena-ticket economy.

Async harnesses can use `AsyncArenaClient` and await the corresponding client
methods. It delegates blocking standard-library HTTP work through
`asyncio.to_thread`, preserving the same validation and response-size limits.
Calls on one async client are serialized because the underlying cursor bindings
are mutable. Cancelling an awaiting task cannot stop an already-running
standard-library HTTP thread; configure `timeout` to bound that work.

```python
from agilabs_arena import ArenaEnv

env = ArenaEnv("od-l1", base_url="http://localhost:8899", play_method="human")
obs, info = env.reset()
print(obs["grid"])          # text grid — row per line, token per cell
print(obs["legal_actions"]) # ["Action 2", "Action 4", "Action 8", "Action 9"] …

obs, reward, terminated, truncated, info = env.step("Action 4")
```

- **Observation** = exactly the wire payload: `grid` text, `narrative`,
  generic `legal_actions`, `carrying`, `energy_left`, interaction `mode`,
  targeting metadata, and dialogue/portrait metadata. What each action does
  is not documented anywhere in the observation — inferring it is the task.
- **Reward** = stars (1–3) on the terminal winning turn, else 0.
- **Scored sessions** use a full-game run: call
  `ArenaClient.create_session(game_id="object-delivery",
  play_method="autonomous_scored")`. They get a per-session shuffled action-id
  mapping; local/dev methods keep canonical ids.

Run the integration tests against a compatible Arena API with local unscored
sessions enabled:

```sh
cd python
PYTHONPATH=. python3 -m pytest tests              # skips if no server
PYTHONPATH=. python3 examples/random_agent.py od-l1   # or pip install -e . first
```
