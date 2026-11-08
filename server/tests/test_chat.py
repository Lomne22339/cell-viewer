import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from server.chat import (
    MAX_HISTORY_CHARS,
    Turn,
    render_context_as_text,
    stream_anthropic,
    trim_history,
)
from server.main import create_app

# Written by the TypeScript renderer; see packages/core/test/mock-adapter.test.ts.
GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "packages/core/test/fixtures/render-context.json").read_text()
)

CTX = {
    "datasetId": "sim1m", "view": "embedding", "n": 12843, "totalN": 1000000,
    "bbox": [-4, -2, 6, 9], "centroid": [1, 3],
    "breakdown": {"cell_type": {"T cell": 8000, "Monocyte": 4843},
                  "tissue": {"lung": 12000, "liver": 843}},
    "numericStats": {"pseudotime": {"min": 0.1, "max": 0.9, "mean": 0.44, "q": [0.2, 0.4, 0.7]}},
    "sampleIds": ["cell_1"], "colorBy": "cell_type",
}


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path))


def test_render_context_mentions_counts_and_labels():
    text = render_context_as_text(CTX)
    assert "12,843" in text
    assert "T cell" in text
    assert "pseudotime" in text


def test_render_context_states_an_active_legend_filter():
    """Mirrors the TypeScript renderer exactly, so the mock predicts the model's prompt."""
    ctx = dict(CTX, visibleN=200000, hidden={"cell_type": ["B cell", "NK cell"]})
    text = render_context_as_text(ctx)
    assert "12,843 cells selected out of 200,000 visible (1,000,000 total; 6.42% of visible)" in text
    assert "Legend filter hides cell_type: B cell, NK cell." in text


def test_render_context_handles_no_selection():
    assert "no cells" in render_context_as_text(None).lower()


def test_render_context_truncates_long_level_lists():
    ctx = dict(CTX, breakdown={"donor": {f"donor_{i}": 10 for i in range(400)}})
    text = render_context_as_text(ctx)
    assert len(text.splitlines()) < 60
    assert "more levels" in text


@pytest.mark.parametrize("case", GOLDEN, ids=[c["name"] for c in GOLDEN])
def test_render_context_matches_the_typescript_renderer_byte_for_byte(case):
    assert render_context_as_text(case["context"]) == case["expected"]


def test_golden_cases_cover_the_known_disagreements():
    names = {c["name"] for c in GOLDEN}
    assert {"ties", "share-tie", "filtered", "filtered-to-zero", "long-tail",
            "null-stats", "no-selection"} <= names


def test_render_context_counts_levels_the_browser_left_out():
    donors = {f"donor_{i}": 100 - i for i in range(50)}
    text = render_context_as_text(dict(CTX, breakdown={"donor": donors}, omittedLevels={"donor": 4950}))
    assert "  ... and 4988 more levels" in text


def test_render_context_prints_n_a_for_nan_and_infinite_stats():
    stats = {"x": {"min": float("nan"), "max": float("inf"), "mean": float("-inf"),
                   "q": [float("nan"), 0.5, None]}}
    text = render_context_as_text(dict(CTX, numericStats=stats))
    assert "x: min n/a, q1 n/a, median 0.500, q3 n/a, max n/a, mean n/a" in text


@pytest.mark.parametrize("ctx", [
    dict(CTX, bbox=None),
    dict(CTX, bbox=[1]),
    dict(CTX, bbox="nope", centroid=None),
    {k: v for k, v in CTX.items() if k not in ("bbox", "centroid", "totalN")},
    dict(CTX, totalN=0),
    dict(CTX, totalN=None, visibleN=None),
    dict(CTX, visibleN="lots"),
    dict(CTX, numericStats={"x": None, "y": {"q": None}, "z": {"min": "a", "q": [1, "b"]}}),
    dict(CTX, numericStats=[1, 2]),
    dict(CTX, breakdown={"f": None, "g": {"a": None, "b": "7", "c": 3, "d": 10 ** 400}}),
    dict(CTX, breakdown=None, omittedLevels={"f": None}),
    dict(CTX, omittedLevels="x"),
    dict(CTX, hidden={"f": None, "g": [None, 1, "x"]}),
    dict(CTX, hidden=["f"]),
    dict(CTX, sampleIds=None),
    dict(CTX, sampleIds=[1, None, "cell_3"]),
    dict(CTX, datasetId=None, view=None, colorBy=None),
    dict(CTX, n="12843"),
    dict(CTX, n=float("nan")),
    dict(CTX, centroid=[10 ** 400, float("nan")]),
    {"n": 3},
    [],
    "not a context",
])
def test_render_context_never_raises_on_a_malformed_context(ctx):
    text = render_context_as_text(ctx)
    assert isinstance(text, str) and text


def test_render_context_returns_what_it_can_from_a_malformed_context():
    text = render_context_as_text(dict(CTX, bbox=[1.5], centroid=None, numericStats={"x": None}))
    assert "Region: x 1.50 to n/a, y n/a to n/a; centroid (n/a, n/a)." in text
    assert "x: min n/a" in text
    assert "T cell: 8,000" in text


def test_render_context_treats_zero_visible_cells_as_a_count_not_a_gap():
    text = render_context_as_text(dict(CTX, n=5, visibleN=0))
    assert "5 cells selected out of 0 visible (1,000,000 total; 500.00% of visible)." in text


def test_chat_route_turns_a_rendering_failure_into_a_422(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    async def never(system, messages, model):
        raise AssertionError("the model must not be called")
        yield ""  # pragma: no cover

    monkeypatch.setattr("server.chat.stream_anthropic", never)
    for exc in (ValueError("bad bbox"), TypeError("bad stats")):
        def boom(ctx, exc=exc):
            raise exc

        monkeypatch.setattr("server.chat.render_context_as_text", boom)
        r = client.post("/api/chat", json={"question": "hi", "context": CTX, "history": []})
        assert r.status_code == 422
        assert str(exc) in r.json()["detail"]


def test_turn_text_is_capped():
    Turn(role="user", text="x" * 20_000)
    with pytest.raises(ValueError):
        Turn(role="user", text="x" * 20_001)


def test_chat_route_rejects_an_oversized_turn(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    history = [{"role": "user", "text": "x" * 20_001}]
    r = client.post("/api/chat", json={"question": "q", "context": CTX, "history": history})
    assert r.status_code == 422


def test_trim_history_drops_the_oldest_turns_beyond_the_budget():
    assert MAX_HISTORY_CHARS == 60_000
    turns = [Turn(role="user" if i % 2 == 0 else "assistant", text=str(i) * 15_000) for i in range(6)]
    kept = trim_history(turns)
    # Four turns of 15,000 fill the budget exactly; the two oldest go.
    assert [t.text[0] for t in kept] == ["2", "3", "4", "5"]
    assert sum(len(t.text) for t in kept) <= MAX_HISTORY_CHARS
    assert trim_history([]) == []
    assert trim_history(turns[:2]) == turns[:2]


def test_chat_route_sends_at_most_the_history_budget(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    seen = {}

    async def capture(system, messages, model):
        seen["messages"] = messages
        yield "ok"

    monkeypatch.setattr("server.chat.stream_anthropic", capture)
    history = [{"role": "user" if i % 2 == 0 else "assistant", "text": chr(97 + i) * 19_000}
               for i in range(10)]
    client.post("/api/chat", json={"question": "q", "context": None, "history": history})
    msgs = seen["messages"]
    assert msgs[0]["role"] == "user"
    sent = "".join(m["content"] for m in msgs)
    # Only the newest turns that fit in 60,000 characters are sent, and the
    # newest is always among them.
    assert "j" * 19_000 in sent
    assert "g" * 19_000 not in sent
    assert len(sent) < MAX_HISTORY_CHARS + 1_000


def _sse(*events: dict) -> bytes:
    return "".join(
        f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events
    ).encode()


_DELTA = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hel"}}
_OVERLOADED = {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _stub_anthropic(monkeypatch, body: bytes) -> None:
    """Routes stream_anthropic's HTTP client to a canned SSE body."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/messages"
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(
        "server.chat.httpx.AsyncClient",
        lambda *a, **kw: _REAL_ASYNC_CLIENT(*a, transport=httpx.MockTransport(handler), **kw),
    )


def test_stream_anthropic_raises_on_an_error_event(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    _stub_anthropic(monkeypatch, _sse(_DELTA, _OVERLOADED, _DELTA))

    async def collect(into: list) -> None:
        async for piece in stream_anthropic("s", [{"role": "user", "content": "q"}], "m"):
            into.append(piece)

    seen: list = []
    with pytest.raises(HTTPException) as info:
        asyncio.run(collect(seen))
    assert seen == ["Hel"]
    assert "Overloaded" in str(info.value.detail)
    # Without an error event the stream ends normally.
    _stub_anthropic(monkeypatch, _sse(_DELTA, {"type": "message_stop"}))
    clean: list = []
    asyncio.run(collect(clean))
    assert clean == ["Hel"]


def test_chat_route_forwards_a_mid_stream_model_error(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    _stub_anthropic(monkeypatch, _sse(_DELTA, _OVERLOADED))
    r = client.post("/api/chat", json={"question": "hi", "context": CTX, "history": []})
    frames = [line[len("data: "):] for line in r.text.splitlines() if line.startswith("data: ")]
    assert frames[-1] == "[DONE]"
    payloads = [json.loads(f) for f in frames[:-1]]
    assert payloads[0] == {"text": "Hel"}
    assert "Overloaded" in payloads[1]["error"]


def test_status_reports_unconfigured_without_a_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    body = client.get("/api/chat/status").json()
    assert body["configured"] is False
    assert body["model"]


def test_chat_without_a_key_returns_a_clear_error_not_a_500(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/api/chat", json={"question": "hi", "context": CTX, "history": []})
    assert r.status_code == 503
    assert "ANTHROPIC_API_KEY" in r.json()["detail"]


def test_chat_rejects_an_oversized_context(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    huge = dict(CTX, sampleIds=[f"cell_{i}" for i in range(100000)])
    r = client.post("/api/chat", json={"question": "hi", "context": huge, "history": []})
    assert r.status_code == 413


def test_chat_streams_sse_from_a_stubbed_model(client, monkeypatch):
    """The route is tested against a stub, not the real API: the thing worth
    testing here is the SSE framing and the prompt assembly."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    async def fake_stream(system, messages, model):
        for piece in ["Hello", " world"]:
            yield piece

    monkeypatch.setattr("server.chat.stream_anthropic", fake_stream)
    r = client.post("/api/chat", json={"question": "hi", "context": CTX, "history": []})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    payloads = [
        json.loads(line[len("data: "):])["text"]
        for line in r.text.splitlines()
        if line.startswith("data: ") and line != "data: [DONE]"
    ]
    assert "".join(payloads) == "Hello world"
    assert r.text.rstrip().endswith("data: [DONE]")


def test_prompt_includes_the_selection_summary(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    seen = {}

    async def capture(system, messages, model):
        seen["system"] = system
        seen["messages"] = messages
        yield "ok"

    monkeypatch.setattr("server.chat.stream_anthropic", capture)
    client.post("/api/chat", json={"question": "how many?", "context": CTX, "history": []})
    assert "12,843" in seen["messages"][-1]["content"]
    assert "how many?" in seen["messages"][-1]["content"]
    assert "single-cell" in seen["system"].lower()


class _Turn:
    def __init__(self, role: str, text: str) -> None:
        self.role = role
        self.text = text


def test_normalize_opens_with_the_user_even_after_truncation():
    from server.chat import normalize_messages

    # Slicing a long conversation can cut mid-pair and leave the assistant first.
    history = [_Turn("assistant", "a1"), _Turn("user", "u1"), _Turn("assistant", "a2")]
    msgs = normalize_messages(history, "q")
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == "u1"
    assert msgs[-1]["content"].endswith("q")


def test_normalize_never_emits_two_turns_of_the_same_role():
    from server.chat import normalize_messages

    history = [_Turn("user", "u1"), _Turn("user", "u2"), _Turn("assistant", "a1"),
               _Turn("user", "u3")]
    msgs = normalize_messages(history, "q")
    roles = [m["role"] for m in msgs]
    assert roles[0] == "user"
    assert all(a != b for a, b in zip(roles, roles[1:])), roles
    # The trailing user turn absorbs the new question rather than doubling up.
    assert msgs[-1]["content"] == "u3\n\nq"


def test_normalize_handles_an_empty_history():
    from server.chat import normalize_messages

    msgs = normalize_messages([], "q")
    assert msgs == [{"role": "user", "content": "q"}]


def test_normalize_drops_blank_turns():
    from server.chat import normalize_messages

    msgs = normalize_messages([_Turn("user", "   "), _Turn("assistant", "")], "q")
    assert msgs == [{"role": "user", "content": "q"}]


def test_chat_route_sends_a_valid_message_sequence(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    seen = {}

    async def capture(system, messages, model):
        seen["messages"] = messages
        yield "ok"

    monkeypatch.setattr("server.chat.stream_anthropic", capture)
    history = [{"role": "user" if i % 2 == 0 else "assistant", "text": f"t{i}"}
               for i in range(11)]
    client.post("/api/chat", json={"question": "q", "context": CTX, "history": history})
    roles = [m["role"] for m in seen["messages"]]
    assert roles[0] == "user", roles
    assert all(a != b for a, b in zip(roles, roles[1:])), roles
