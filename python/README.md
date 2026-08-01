# GAOS deterministic game SDK for Python

Product-neutral hosted sessions, provider-neutral evaluation helpers, and
portable replay tools. The package has zero runtime dependencies.

This Python distribution does not contain the TypeScript mechanism engine,
local `TickReducer` runtime, replay re-simulation, model-provider drivers, or
agent CLI launchers. It is the research and hosted-integration surface for a
game whose authoritative reducer runs in a compatible host.

## Portable replay

The Python package reads and writes the same canonical `gaos.replay` v1 JSONL
bytes as the TypeScript engine:

```python
from gaos_sdk import parse_replay_jsonl, serialize_replay_jsonl

with open("run.gaos-replay.jsonl", encoding="utf-8") as source:
    artifact = parse_replay_jsonl(source.read())

canonical_bytes = serialize_replay_jsonl(artifact)
```

`validate_replay_artifact` performs transport-level checks without executing
game code. Canonical object keys use Unicode code-point order, unpaired
surrogates are rejected, and every integer-valued replay number must remain
within the JavaScript safe range so Python produces the same bytes as
TypeScript. Reducer re-simulation requires the TypeScript engine plus the
product-owned historical adapter declared in
`artifact["header"]["game"]["adapter"]`.

`gaos.replay` v1.3 retains zero-dependency Ed25519 signing and synchronous
verification. Python matches the TypeScript complete-preimage fixture:

```python
from gaos_sdk import (
    ed25519_public_key_from_seed,
    sign_submission_v1,
    submission_chain_hash_v1,
)

public_key = ed25519_public_key_from_seed(private_seed)
sig = sign_submission_v1(private_seed, envelope)
chain_head = submission_chain_hash_v1(envelope)
```

`recheck_replay_signatures(artifact)` reports the per-seat chain and signing
policy facts. To compose those facts with a product-owned Python replay
adapter, export `recheck_replay(artifact)` from a module and run:

```sh
gaos-verify run.gaos-replay.jsonl --adapter ./historical_adapter.py
```

The verdict is `trusted`, `unverifiable`, or `rejected`; an unsigned v1.0/v1.1
artifact is `unverifiable`, not broken.

For signed evidence, the adapter's replay check also reports
`semantics.submissions` and `semantics.timeouts` as `verified`,
`unavailable`, `not_applicable`, or `failed`. Missing historical
command/timeout mappings make an otherwise consistent signed artifact
`unverifiable`; a mapping mismatch is `rejected`.

`SessionClient` speaks the stable `gaos.ticks` v1 envelope on `/v1/sessions`
without interpreting the game-owned observation:

```python
from gaos_sdk import SessionClient

client = SessionClient("https://host.example")
created = client.create_session({"game": "creator/cards"})
print(created["tick"])
```

`parse_tick_result()` and `get_tick_envelope()` deliberately preserve the
unchanged v1 `tickId`/`tick` JSON fields without interpreting product payloads.
Each command carries the session cursor, participant, and a deterministic
`submissionId`: stable for an exact retry, new for each logical control
step. Use `submit_intent()` and `get_tick_envelope()` with opaque command and
observation shapes.

Attachable sessions resume at their current durable head:

```python
attached = client.attach_session(
    session_id,
    {"requestId": "attach-2026-07-31"},
)
result = client.finalize_session(
    session_id,
    {"requestId": "finalize-2026-07-31"},
)
```

`create_session_attach_receipt()` constructs canonical portable receipts and
`verify_session_attach_receipt_chain()` independently checks their digest
links and monotonic revisions. Attachment never accepts an older cursor as a
rollback target; host authorization and exact-retry enforcement remain
authoritative.

For an exact retry after a restart, persist
`client.get_session_binding(session_id)`, restore it with
`restore_session_binding(binding)`, and reuse the original `submission_id`.
`submit_intent(..., cursor=original_cursor)` also accepts an explicit original
cursor. A fresh client rejects an explicit retry key if it would otherwise
have to fetch and silently pair it with a newer cursor.

Async harnesses can use `AsyncSessionClient` and await the corresponding client
methods. It delegates blocking standard-library HTTP work through
`asyncio.to_thread`, preserving the same validation and response-size limits.
Calls on one async client are serialized because the underlying cursor bindings
are mutable. Cancelling an awaiting task cannot stop an already-running
standard-library HTTP thread; configure `timeout` to bound that work.

Product adapters can reuse the same transport for small host-specific JSON
routes without reaching into private client methods:

```python
room = client.request_json("GET", f"/v1/arena/rooms/{room_id}")
await async_client.request_json(
    "POST",
    f"/v1/arena/rooms/{room_id}/presence",
    {"connected": True},
)
```

`request_json()` accepts only uppercase `GET`, `POST`, and `DELETE`, requires a
same-origin `/...` path without traversal or fragments, and permits request
bodies only for `POST`. Responses remain product-owned JSON, while bearer
authentication, timeout, response-size limits, JSON safety checks,
`GaosAPIError`, and `IllegalActionRejected` are identical to the standard
session methods. Build path segments with `urllib.parse.quote(value, safe="")`;
do not pass absolute URLs.

Product repositories own typed observations, matchmaking, convenience
methods, rewards, and Gymnasium-style environments. Run the product-neutral
suite with:

```sh
cd python
PYTHONPATH=. python3 -m pytest tests
```
