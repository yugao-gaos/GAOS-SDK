import asyncio

import pytest

from gaos_sdk import (
    AsyncSessionClient,
    ProtocolMismatchError,
    SessionClient,
    parse_session_binding,
    parse_tick_result,
)


def envelope(kind="tick", revision=0, tick=None, **extra):
    return {
        "protocol": "gaos.ticks",
        "protocolVersion": "1.0",
        "kind": kind,
        "sessionId": "session-1",
        "tickId": f"session-1:{revision}",
        "revision": revision,
        "tick": {"state": revision} if tick is None else tick,
        **extra,
    }


def test_preserves_opaque_non_grid_observations():
    client = SessionClient("https://example.test")
    response = envelope(tick={
        "hand": ["ace", "queen"],
        "legalCommands": [{"id": "play", "card": "ace"}],
    })
    client._call = lambda method, path, body=None: response

    result = client.create_session({"game": "cards"}, participant_id="north")

    assert result["tick"]["hand"] == ["ace", "queen"]
    assert client.get_session_binding("session-1")["participantId"] == "north"


def test_submits_opaque_command_against_remembered_cursor():
    client = SessionClient("https://example.test")
    requests = []
    responses = [envelope(), envelope(revision=1, tick={"node": "b"})]

    def call(method, path, body=None):
        requests.append((method, path, body))
        return responses.pop(0)

    client._call = call
    client.create_session({"game": "graph"})
    result = client.submit_intent("session-1", {"traverse": "b"})

    assert result["tick"] == {"node": "b"}
    assert requests[1][2]["command"] == {"traverse": "b"}
    assert requests[1][2]["submissionId"] == "player:session-1:0"


def test_requires_original_cursor_for_explicit_retry():
    client = SessionClient("https://example.test")
    with pytest.raises(ProtocolMismatchError, match="original cursor"):
        client.submit_intent(
            "session-1",
            {"move": "north"},
            submission_id="retry-1",
        )


def test_restores_validated_session_binding():
    client = SessionClient()
    binding = client.restore_session_binding({
        "protocol": "gaos.ticks",
        "protocolVersion": "1.0",
        "sessionId": "session-1",
        "tickId": "opaque-token",
        "revision": 4,
        "participantId": "north",
    })
    assert binding == parse_session_binding(binding)


@pytest.mark.parametrize(
    "change",
    [
        {"protocol": "other"},
        {"sessionId": ""},
        {"tickId": ""},
        {"revision": -1},
        {"tick": float("nan")},
    ],
)
def test_rejects_invalid_envelopes(change):
    with pytest.raises(ProtocolMismatchError):
        parse_tick_result({**envelope(), **change})


def test_validates_pending_participant_sets():
    pending = envelope(
        "pending",
        submittedParticipants=["north"],
        awaitingParticipants=["south"],
        acceptedParticipantId="north",
    )
    assert parse_tick_result(pending)["kind"] == "pending"
    with pytest.raises(ProtocolMismatchError, match="disjoint"):
        parse_tick_result({**pending, "awaitingParticipants": ["north"]})
    with pytest.raises(ProtocolMismatchError, match="unique"):
        parse_tick_result({
            **pending,
            "submittedParticipants": ["north", "north"],
        })


def test_rejects_non_json_requests_and_commands():
    client = SessionClient()
    cycle = {}
    cycle["self"] = cycle
    with pytest.raises(ProtocolMismatchError, match="cycles"):
        client.create_session(cycle)

    client._call = lambda method, path, body=None: envelope()
    client.create_session({"game": "cards"})
    with pytest.raises(ProtocolMismatchError, match="plain JSON"):
        client.submit_intent("session-1", object())


def test_async_client_exposes_generic_session_surface():
    async def run():
        client = AsyncSessionClient("https://example.test")
        client.sync_client._call = (
            lambda method, path, body=None: envelope(tick={"board": [1, 2]})
        )
        return await client.create_session({"game": "board"})

    assert asyncio.run(run())["tick"] == {"board": [1, 2]}


def test_validates_client_limits():
    with pytest.raises(ValueError, match="timeout"):
        SessionClient(timeout=0)
    with pytest.raises(ValueError, match="max_response_bytes"):
        SessionClient(max_response_bytes=0)
