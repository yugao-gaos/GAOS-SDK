import asyncio
import io
import time
import urllib.error

import pytest

from agilabs_arena import (
    ArenaAPIError,
    ArenaClient,
    ArenaEnv,
    AsyncArenaClient,
    ProtocolMismatchError,
    Tick,
    parse_tick_result,
)


OBSERVATION = {
    "tickNumber": 0,
    "controlRevision": 0,
    "narrative": None,
    "grid": "@ .",
    "visualEvents": [],
    "actions": [{"id": "Action 1", "params": "none"}],
    "status": "playing",
    "hud": {"actionsUsed": 0, "maxActions": 4, "carrying": None},
}


def envelope(kind="tick", revision=0, **extra):
    return {
        "protocol": "agilabs.ticks",
        "protocolVersion": "1.0",
        "kind": kind,
        "sessionId": "s1",
        "tickId": f"s1:{revision}",
        "revision": revision,
        "tick": {**OBSERVATION, "tickNumber": revision},
        **extra,
    }


def test_tick_native_transport():
    assert parse_tick_result(envelope())["kind"] == "tick"


def test_rejects_unversioned_tick_shape():
    with pytest.raises(ProtocolMismatchError):
        parse_tick_result(OBSERVATION)
    with pytest.raises(ProtocolMismatchError):
        parse_tick_result({**envelope(), "sessionId": ""})
    with pytest.raises(ProtocolMismatchError):
        parse_tick_result({**envelope(), "tickId": ""})
    with pytest.raises(ProtocolMismatchError):
        parse_tick_result({**envelope(), "revision": -1})
    with pytest.raises(ProtocolMismatchError, match="extensions"):
        parse_tick_result({**envelope(), "extensions": 7})


def test_pending_participants_are_unique_disjoint_and_accepted_is_submitted():
    pending = envelope(
        "pending",
        tickId="opaque-tick-token",
        submittedParticipants=["north"],
        awaitingParticipants=["south"],
        acceptedParticipantId="north",
    )
    assert parse_tick_result(pending)["tickId"] == "opaque-tick-token"
    with pytest.raises(ProtocolMismatchError, match="unique"):
        parse_tick_result({**pending, "submittedParticipants": ["north", "north"]})
    with pytest.raises(ProtocolMismatchError, match="disjoint"):
        parse_tick_result({**pending, "awaitingParticipants": ["north"]})
    with pytest.raises(ProtocolMismatchError, match="must await"):
        parse_tick_result({**pending, "awaitingParticipants": []})
    with pytest.raises(ProtocolMismatchError, match="must be submitted"):
        parse_tick_result({**pending, "acceptedParticipantId": "south"})
    with pytest.raises(ProtocolMismatchError, match="must be submitted"):
        parse_tick_result({**pending, "acceptedParticipantId": None})


def test_tick_retains_unit_integrity_and_character_metadata():
    unit = {
        "id": "hacker",
        "team": "player",
        "at": [1, 2],
        "hp": 2,
        "maxHp": 2,
        "character": "hacker",
        "cast": "hacker",
        "controlMode": "direct",
        "abilities": ["hack_drone", "remote_control"],
        "statuses": [
            {"kind": "shield_field", "phase": "active", "remaining": 1, "capacity": 2}
        ],
    }
    character = {key: value for key, value in unit.items() if key not in {"hp", "maxHp"}}

    tick = Tick.from_json({
        **OBSERVATION,
        "hud": {
            **OBSERVATION["hud"],
            "units": [unit],
            "characters": [character],
            "arenaOutcome": "draw",
            "mode": "dialogue",
            "targetableCells": [[1, 2]],
            "actionTargeting": {"Action 6": {"targetableCells": [[1, 2]]}},
            "dialogueOptions": [{"index": 0, "text": "Hold position."}],
            "talkingTo": {
                "id": "hacker",
                "at": [1, 2],
                "character": "hacker",
                "emotion": "focused",
                "speaker": "npc",
            },
            "dialogueSpeaker": "npc",
            "dialogueEmotion": "focused",
        },
    })

    assert tick.units == [unit]
    assert tick.characters == [character]
    assert tick.arena_outcome == "draw"
    assert tick.control_revision == 0
    assert tick.mode == "dialogue"
    assert tick.targetable_cells == [[1, 2]]
    assert tick.dialogue_options == [{"index": 0, "text": "Hold position."}]
    assert tick.talking_to["character"] == "hacker"
    assert tick.dialogue_speaker == "npc"
    assert tick.dialogue_emotion == "focused"
    assert Tick.from_json(OBSERVATION).units == []
    assert Tick.from_json(OBSERVATION).characters == []
    assert Tick.from_json(OBSERVATION).arena_outcome is None


def test_wraps_commands_and_polls_a_pending_tick_once():
    responses = [
        envelope(),
        envelope(
            "pending",
            submittedParticipants=["player"],
            awaitingParticipants=["remote"],
        ),
        envelope(revision=1),
    ]
    calls = []
    client = ArenaClient("https://example.test")

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return responses.pop(0)

    client._call = fake_call  # type: ignore[method-assign]
    session_id, _ = client.create_session(level_id="test", play_method="human")
    tick = client.submit_action(
        session_id,
        "Action 1",
        submission_id="request-1",
        poll_interval=0,
        max_poll_attempts=1,
    )
    assert tick.tick_number == 1
    assert calls[1][1] == "/v1/sessions/s1/actions"
    assert calls[1][2] == {
        "protocol": "agilabs.ticks",
        "protocolVersion": "1.0",
        "sessionId": "s1",
        "tickId": "s1:0",
        "revision": 0,
        "participantId": "player",
        "submissionId": "request-1",
        "command": {"id": "Action 1"},
    }
    assert calls[2][1] == "/v1/sessions/s1/tick"


def test_explicit_empty_participants_is_not_silently_changed_to_solo():
    calls = []
    client = ArenaClient("https://example.test")

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return envelope()

    client._call = fake_call  # type: ignore[method-assign]
    client.create_session(level_id="test", play_method="human", participants=[])
    assert calls[0][2]["participants"] == []


def test_preserves_stable_conflict_codes(monkeypatch):
    response = io.BytesIO(b'{"error":"expected a newer cursor","code":"stale_turn"}')

    def fail(_request, **_kwargs):
        raise urllib.error.HTTPError(
            "https://example.test/v1/sessions/s1/tick",
            409,
            "Conflict",
            {},
            response,
        )

    monkeypatch.setattr("urllib.request.urlopen", fail)
    with pytest.raises(ArenaAPIError) as caught:
        ArenaClient("https://example.test").get_tick_envelope("s1")
    assert caught.value.status == 409
    assert caught.value.code == "stale_turn"


def test_configures_timeout_quotes_paths_and_preserves_non_json_error(monkeypatch):
    def fail(request, **kwargs):
        assert request.full_url.endswith("/v1/sessions/room%2Fwith%20space/tick")
        assert kwargs["timeout"] == 4.5
        raise urllib.error.HTTPError(
            request.full_url,
            502,
            "Bad Gateway",
            {},
            io.BytesIO(b"upstream unavailable"),
        )

    monkeypatch.setattr("urllib.request.urlopen", fail)
    with pytest.raises(ArenaAPIError) as caught:
        ArenaClient("https://example.test", timeout=4.5).get_tick_envelope("room/with space")
    assert caught.value.status == 502
    assert caught.value.error == "upstream unavailable"
    assert caught.value.body == "upstream unavailable"


def test_normalizes_non_json_success_and_caps_response_bytes(monkeypatch):
    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: io.BytesIO(b"not-json"))
    with pytest.raises(ProtocolMismatchError, match="not valid JSON"):
        ArenaClient("https://example.test").arena_catalog()

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: io.BytesIO(b"12345"))
    with pytest.raises(ProtocolMismatchError, match="exceeds 4 bytes"):
        ArenaClient("https://example.test", max_response_bytes=4).arena_catalog()
    with pytest.raises(ValueError, match="max_response_bytes"):
        ArenaClient(max_response_bytes=0)


def test_rejects_non_finite_and_huge_json_numbers_portably(monkeypatch):
    for payload in (b"NaN", b"Infinity", b"1e1000000", b"1" * 5000):
        monkeypatch.setattr(
            "urllib.request.urlopen", lambda *_args, value=payload, **_kwargs: io.BytesIO(value)
        )
        with pytest.raises(ProtocolMismatchError):
            ArenaClient("https://example.test").arena_catalog()

    client = ArenaClient("https://example.test")
    with pytest.raises(ProtocolMismatchError, match="finite"):
        client._call("POST", "/test", {"bad": float("nan")})
    with pytest.raises(ProtocolMismatchError, match="finite"):
        client._call("POST", "/test", {"bad": 10**400})


def test_async_client_runs_sync_requests_off_the_event_loop():
    client = AsyncArenaClient("https://example.test")
    client.sync_client.get_tick_envelope = lambda session_id: {"sessionId": session_id}  # type: ignore[method-assign]
    assert asyncio.run(client.get_tick_envelope("s1")) == {"sessionId": "s1"}
    assert ArenaEnv("level-1").play_method == "autonomous_local"


def test_async_client_serializes_mutable_binding_operations():
    client = AsyncArenaClient("https://example.test")
    active = 0
    maximum = 0

    def fake_get(session_id):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        time.sleep(0.01)
        active -= 1
        return {"sessionId": session_id}

    client.sync_client.get_tick_envelope = fake_get  # type: ignore[method-assign]

    async def run_both():
        return await asyncio.gather(
            client.get_tick_envelope("s1"),
            client.get_tick_envelope("s2"),
        )

    assert asyncio.run(run_both()) == [{"sessionId": "s1"}, {"sessionId": "s2"}]
    assert maximum == 1


def test_async_client_keeps_serialization_after_cancellation():
    client = AsyncArenaClient("https://example.test")
    active = 0
    maximum = 0

    def fake_get(session_id):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        time.sleep(0.03)
        active -= 1
        return {"sessionId": session_id}

    client.sync_client.get_tick_envelope = fake_get  # type: ignore[method-assign]

    async def cancel_then_call():
        first = asyncio.create_task(client.get_tick_envelope("s1"))
        await asyncio.sleep(0.005)
        first.cancel()
        second = asyncio.create_task(client.get_tick_envelope("s2"))
        with pytest.raises(asyncio.CancelledError):
            await first
        assert await second == {"sessionId": "s2"}

    asyncio.run(cancel_then_call())
    assert maximum == 1


def test_discovers_hosted_arena_catalog():
    calls = []
    client = ArenaClient("https://example.test")
    catalog = {
        "maps": [{"id": "arena-s1-1", "gameId": "arena", "version": 1, "name": "Arena Exhibition"}],
        "teams": [{"id": "playerbot-mica", "name": "Playerbot + MICA", "members": []}],
    }

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return catalog

    client._call = fake_call  # type: ignore[method-assign]
    assert client.arena_catalog() == catalog
    assert calls == [("GET", "/v1/arena/maps", None)]


def test_arena_single_match_queue_tick_presence_and_room_outcome():
    def match_envelope(kind="tick", **extra):
        out = envelope(kind, **extra)
        out["sessionId"] = "m1"
        out["tickId"] = "m1:0"
        return out

    resolved_tick = match_envelope(revision=1)
    resolved_tick["tickId"] = "m1:1"
    resolved_tick["tick"]["tickNumber"] = 1
    active = {
        "matchId": "m1",
        "sessionId": "m1",
        "status": "active",
        "participantId": "north",
        "readyDeadline": 120_000,
        "tickDeadline": 30_000,
        "expiresAt": None,
        "participants": [
            {"participantId": "north", "claimed": True, "connected": True, "reconnectDeadline": None},
            {"participantId": "south", "claimed": True, "connected": True, "reconnectDeadline": None},
        ],
        "outcome": None,
        "tick": match_envelope(),
    }
    disconnected = {
        **active,
        "participants": [
            {
                "participantId": "north",
                "claimed": True,
                "connected": False,
                "reconnectDeadline": 20_000,
            },
            {"participantId": "south", "claimed": True, "connected": True, "reconnectDeadline": None},
        ],
        "tick": resolved_tick,
    }
    completed = {
        **disconnected,
        "status": "completed",
        "outcome": {"winner": "north", "loser": "south", "reason": "disconnect"},
        # Network policy ended the room; its last reducer tick remains playing.
        "tick": resolved_tick,
    }
    responses = [
        {
            "queueId": "global.open",
            "ticketId": "request_1",
            "state": "waiting",
            "joinedAt": 0,
            "expiresAt": 1,
            "mapId": "arena-s1-1",
            "teamId": "playerbot-mica",
            "matchId": None,
            "participantId": None,
        },
        {
            "queueId": "global.open",
            "ticketId": "request_1",
            "state": "matched",
            "joinedAt": 0,
            "expiresAt": 1,
            "mapId": "arena-s1-1",
            "teamId": "playerbot-mica",
            "matchId": "m1",
            "participantId": "north",
        },
        active,
        match_envelope(
            "pending",
            submittedParticipants=["north"],
            awaitingParticipants=["south"],
        ),
        resolved_tick,
        {**active, "tick": resolved_tick},
        disconnected,
        completed,
    ]
    calls = []
    client = ArenaClient("https://example.test", "ak_player")

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return responses.pop(0)

    client._call = fake_call  # type: ignore[method-assign]
    client.join_arena_queue("arena-s1-1", "playerbot-mica", request_id="request_1")
    ticket = client.arena_queue_ticket("global.open", "request_1")
    assert ticket["state"] == "matched"
    assert ticket["matchId"] == "m1"
    client.connect_arena_match("m1")
    pending = client.submit_arena_intent("m1", {"id": "Action 1"}, "north-0")
    assert pending["kind"] == "pending"
    resolved = client.get_arena_tick_envelope("m1")
    assert resolved["kind"] == "tick"
    assert resolved["revision"] == 1
    client.heartbeat_arena_match("m1")
    disconnected_room = client.disconnect_arena_match("m1")
    assert disconnected_room["participants"][0]["connected"] is False
    assert disconnected_room["participants"][0]["reconnectDeadline"] == 20_000
    room = client.get_arena_room("m1")
    assert room["outcome"] == {"winner": "north", "loser": "south", "reason": "disconnect"}
    assert room["tick"]["tick"]["status"] == "playing"
    assert [call[1] for call in calls] == [
        "/v1/arena/matchmaking",
        "/v1/arena/matchmaking/global.open/request_1",
        "/v1/arena/matches/m1/presence",
        "/v1/arena/matches/m1/actions",
        "/v1/arena/matches/m1/tick",
        "/v1/arena/matches/m1/presence",
        "/v1/arena/matches/m1/presence",
        "/v1/arena/matches/m1",
    ]
    assert calls[3][2] == {
        "protocol": "agilabs.ticks",
        "protocolVersion": "1.0",
        "sessionId": "m1",
        "tickId": "m1:0",
        "revision": 0,
        "participantId": "north",
        "submissionId": "north-0",
        "command": {"id": "Action 1"},
        "extensions": {"agilabs.arena": {"controlRevision": 0}},
    }
    assert calls[0][2] == {
        "mapId": "arena-s1-1",
        "teamId": "playerbot-mica",
        "requestId": "request_1",
    }
    assert calls[2][2] == {"connected": True}
    assert calls[5][2] == {"connected": True}
    assert calls[6][2] == {"connected": False}


def test_strictly_validates_arena_room_metadata():
    room_tick = envelope()
    room_tick["sessionId"] = "m1"
    room_tick["tickId"] = "m1:0"
    valid = {
        "matchId": "m1",
        "sessionId": "m1",
        "status": "active",
        "participantId": "north",
        "readyDeadline": 120_000,
        "tickDeadline": 30_000,
        "expiresAt": None,
        "participants": [
            {"participantId": "north", "claimed": True, "connected": True, "reconnectDeadline": None}
        ],
        "outcome": None,
        "tick": room_tick,
    }
    client = ArenaClient("https://example.test")
    for invalid in (
        {**valid, "status": "unknown"},
        {**valid, "readyDeadline": float("nan")},
        {**valid, "participants": [{"participantId": "north", "claimed": "yes", "connected": True, "reconnectDeadline": None}]},
        {**valid, "participantId": "south"},
        {**valid, "outcome": {"winner": "north", "loser": None, "reason": "timeout"}},
        {**valid, "outcome": {"winner": "south", "loser": None, "reason": "game"}},
    ):
        with pytest.raises(ProtocolMismatchError, match="room fields"):
            client._parse_arena_room(invalid, "m1")
        assert client.get_session_binding("m1") is None


def test_cancels_waiting_arena_ticket():
    waiting = {
        "queueId": "global.open",
        "ticketId": "request_2",
        "state": "waiting",
        "joinedAt": 0,
        "expiresAt": 1,
        "mapId": "arena-s1-1",
        "teamId": "fixer-overseer",
        "matchId": None,
        "participantId": None,
    }
    responses = [waiting, {**waiting, "state": "cancelled"}]
    calls = []
    client = ArenaClient("https://example.test", "ak_player")

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return responses.pop(0)

    client._call = fake_call  # type: ignore[method-assign]
    client.join_arena_queue("arena-s1-1", "fixer-overseer", request_id="request_2")
    cancelled = client.cancel_arena_queue_ticket("global.open", "request_2")
    assert cancelled["state"] == "cancelled"
    assert calls[1] == (
        "DELETE",
        "/v1/arena/matchmaking/global.open/request_2",
        None,
    )


def test_arena_tick_poll_does_not_invent_a_solo_seat_binding():
    tick = {**envelope(), "sessionId": "m1", "tickId": "m1:0"}
    room = {
        "matchId": "m1",
        "sessionId": "m1",
        "status": "active",
        "participantId": "south",
        "readyDeadline": 120_000,
        "tickDeadline": 30_000,
        "expiresAt": None,
        "participants": [
            {"participantId": "south", "claimed": True, "connected": True, "reconnectDeadline": None}
        ],
        "outcome": None,
        "tick": tick,
    }
    pending = {
        **tick,
        "kind": "pending",
        "submittedParticipants": ["south"],
        "awaitingParticipants": ["north"],
    }
    responses = [tick, room, pending]
    calls = []
    client = ArenaClient("https://example.test", "ak_player")

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return responses.pop(0)

    client._call = fake_call  # type: ignore[method-assign]
    client.get_arena_tick_envelope("m1")
    client.submit_arena_intent("m1", {"id": "Action 8"}, "south-0")

    assert [call[1] for call in calls] == [
        "/v1/arena/matches/m1/tick",
        "/v1/arena/matches/m1",
        "/v1/arena/matches/m1/actions",
    ]
    assert calls[2][2]["participantId"] == "south"


def test_arena_same_world_control_steps_get_distinct_retry_keys():
    def match_envelope(control_revision):
        value = envelope()
        value["sessionId"] = "m1"
        value["tickId"] = "m1:0"
        value["tick"] = {**OBSERVATION, "controlRevision": control_revision}
        return value

    active = {
        "matchId": "m1",
        "sessionId": "m1",
        "status": "active",
        "participantId": "north",
        "readyDeadline": 120_000,
        "tickDeadline": 30_000,
        "expiresAt": None,
        "participants": [
            {"participantId": "north", "claimed": True, "connected": True, "reconnectDeadline": None}
        ],
        "outcome": None,
        "tick": match_envelope(0),
    }
    responses = [active, match_envelope(1), match_envelope(2)]
    calls = []
    client = ArenaClient("https://example.test", "ak_player")

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return responses.pop(0)

    client._call = fake_call  # type: ignore[method-assign]
    client.connect_arena_match("m1")
    client.submit_arena_intent("m1", {"id": "Action 6"})
    client.submit_arena_intent("m1", {"id": "Action 7", "index": 0})

    assert calls[1][2]["submissionId"] == "north:m1:0:control:0"
    assert calls[1][2]["extensions"] == {
        "agilabs.arena": {"controlRevision": 0}
    }
    assert calls[2][2]["submissionId"] == "north:m1:0:control:1"
    assert calls[2][2]["extensions"] == {
        "agilabs.arena": {"controlRevision": 1}
    }
    with pytest.raises(ProtocolMismatchError):
        client.submit_arena_intent(
            "m1", {"id": "Action 8"}, control_revision=9_007_199_254_740_992
        )


def test_persists_and_restores_original_binding_for_exact_retry():
    calls = []
    client = ArenaClient("https://example.test")
    binding = {
        "protocol": "agilabs.ticks",
        "protocolVersion": "1.0",
        "sessionId": "s1",
        "tickId": "s1:0",
        "revision": 0,
        "participantId": "player",
    }
    assert client.restore_session_binding(binding) == binding
    assert client.get_session_binding("s1") == binding

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return envelope(revision=1)

    client._call = fake_call  # type: ignore[method-assign]
    client.submit_intent("s1", {"id": "Action 1"}, submission_id="retry-revision-0")
    assert calls[0][2]["tickId"] == "s1:0"
    assert calls[0][2]["revision"] == 0
    with pytest.raises(ProtocolMismatchError):
        client.restore_session_binding({**binding, "revision": -1})


def test_restored_arena_binding_overrides_observed_cursor_for_retry():
    calls = []
    client = ArenaClient("https://example.test")

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        result = envelope(revision=5 if len(calls) == 1 else 1)
        result["sessionId"] = "m1"
        result["tickId"] = "m1:5" if len(calls) == 1 else "m1:1"
        result["tick"] = {**OBSERVATION, "controlRevision": 5 if len(calls) == 1 else 1}
        return result

    client._call = fake_call  # type: ignore[method-assign]
    client.get_arena_tick_envelope("m1")
    client.restore_session_binding({
        "protocol": "agilabs.ticks", "protocolVersion": "1.0",
        "sessionId": "m1", "tickId": "m1:0", "revision": 0,
        "participantId": "north", "controlRevision": 0,
    })
    client.submit_arena_intent("m1", {"id": "Action 1"}, submission_id="retry-0")

    assert calls[1][2]["tickId"] == "m1:0"
    assert calls[1][2]["revision"] == 0
    assert calls[1][2]["extensions"] == {
        "agilabs.arena": {"controlRevision": 0}
    }


def test_explicit_retry_key_never_fetches_a_newer_cursor():
    client = ArenaClient("https://example.test")
    called = False

    def fake_call(method, path, body=None):
        nonlocal called
        called = True
        return envelope(revision=1)

    client._call = fake_call  # type: ignore[method-assign]
    with pytest.raises(ProtocolMismatchError, match="original cursor"):
        client.submit_intent("s1", {"id": "Action 1"}, submission_id="retry-revision-0")
    assert called is False


def test_python_commands_and_extensions_require_plain_json():
    with pytest.raises(ProtocolMismatchError, match="finite"):
        parse_tick_result({**envelope(), "extensions": {"bad": float("nan")}})
    client = ArenaClient("https://example.test")
    client.restore_session_binding({
        "protocol": "agilabs.ticks", "protocolVersion": "1.0",
        "sessionId": "s1", "tickId": "s1:0", "revision": 0,
        "participantId": "player",
    })
    with pytest.raises(ProtocolMismatchError, match="finite"):
        client.submit_intent("s1", {"bad": float("nan")})
