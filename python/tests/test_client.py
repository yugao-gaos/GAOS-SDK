import asyncio
import io
import json
import urllib.error
import urllib.request

import pytest

from gaos_sdk import (
    AsyncSessionClient,
    IllegalActionRejected,
    ProtocolMismatchError,
    SessionClient,
    create_session_attach_receipt,
    parse_session_binding,
    parse_tick_result,
    verify_session_attach_receipt_chain,
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


def test_public_json_route_reuses_auth_json_validation_and_error_mapping(
    monkeypatch,
):
    seen = []
    responses = [
        io.BytesIO(json.dumps({"room": "ready"}).encode()),
        urllib.error.HTTPError(
            "https://example.test/v1/arena/control",
            422,
            "Unprocessable Entity",
            {},
            io.BytesIO(b'{"error":"stale control","code":"stale_control"}'),
        ),
    ]

    def open_request(request, **kwargs):
        seen.append((request, kwargs))
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(urllib.request, "urlopen", open_request)
    client = SessionClient(
        "https://example.test",
        api_key="secret",
        timeout=4,
        max_response_bytes=128,
    )
    assert client.request_json(
        "POST",
        "/v1/arena/control",
        {"revision": 3},
    ) == {"room": "ready"}
    request, options = seen[0]
    assert request.full_url == "https://example.test/v1/arena/control"
    assert request.method == "POST"
    assert request.get_header("Authorization") == "Bearer secret"
    assert json.loads(request.data) == {"revision": 3}
    assert options["timeout"] == 4

    with pytest.raises(IllegalActionRejected) as rejected:
        client.request_json("GET", "/v1/arena/control")
    assert rejected.value.code == "stale_control"


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", "/v1/arena/room", None),
        ("get", "/v1/arena/room", None),
        ("GET", "v1/arena/room", None),
        ("GET", "//other.test/room", None),
        ("GET", "/v1/../admin", None),
        ("GET", "/v1/%2e%2e/admin", None),
        ("GET", "/v1/arena/room#fragment", None),
        ("GET", "/v1/arena/room", {}),
        ("DELETE", "/v1/arena/room", {}),
    ],
)
def test_public_json_route_rejects_unsafe_or_ambiguous_requests(
    method,
    path,
    body,
):
    with pytest.raises(ValueError):
        SessionClient().request_json(method, path, body)


def test_public_json_route_preserves_response_limit(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: io.BytesIO(b'{"too":"large"}'),
    )
    client = SessionClient(max_response_bytes=4)
    with pytest.raises(ProtocolMismatchError, match="exceeds 4 bytes"):
        client.request_json("GET", "/v1/arena/room")


def test_public_json_route_rejects_non_json_post_body():
    with pytest.raises(ProtocolMismatchError, match="plain JSON"):
        SessionClient().request_json("POST", "/v1/arena/room", object())


def test_async_client_exposes_public_json_route():
    async def run():
        client = AsyncSessionClient("https://example.test")
        client.sync_client._call = lambda method, path, body=None: {
            "method": method,
            "path": path,
            "body": body,
        }
        return await client.request_json(
            "POST",
            "/v1/arena/presence",
            {"connected": True},
        )

    assert asyncio.run(run()) == {
        "method": "POST",
        "path": "/v1/arena/presence",
        "body": {"connected": True},
    }


def test_attaches_finalizes_and_verifies_receipts():
    client = SessionClient("https://example.test")
    receipt = create_session_attach_receipt({
        "sessionId": "session-1",
        "requestId": "attach-1",
        "sequence": 0,
        "revision": 3,
        "transcriptDigest": "transcript-3",
        "stateDigest": "state-3",
    })
    responses = [
        {
            "sessionId": "session-1",
            "tick": {"state": 3},
            "binding": {
                "protocol": "gaos.ticks",
                "protocolVersion": "1.0",
                "sessionId": "session-1",
                "tickId": "session-1:3",
                "revision": 3,
                "participantId": "player",
            },
            "receipt": receipt,
        },
        {
            "sessionId": "session-1",
            "status": "finalized",
            "outcome": {"score": 3},
        },
    ]
    requests = []

    def call(method, path, body=None):
        requests.append((method, path, body))
        return responses.pop(0)

    client._call = call
    attached = client.attach_session(
        "session-1",
        {"requestId": "attach-1"},
    )
    result = client.finalize_session(
        "session-1",
        {"requestId": "finish-1"},
    )

    assert attached["binding"]["revision"] == 3
    assert result["outcome"] == {"score": 3}
    assert verify_session_attach_receipt_chain([receipt]) == {
        "valid": True,
        "problems": [],
    }
    assert [request[:2] for request in requests] == [
        ("POST", "/v1/sessions/session-1/attach"),
        ("POST", "/v1/sessions/session-1/finalize"),
    ]


def test_validates_client_limits():
    with pytest.raises(ValueError, match="timeout"):
        SessionClient(timeout=0)
    with pytest.raises(ValueError, match="max_response_bytes"):
        SessionClient(max_response_bytes=0)
