import json

import pytest
from fastapi.testclient import TestClient

from server.chat import render_context_as_text
from server.main import create_app

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


def test_render_context_handles_no_selection():
    assert "no cells" in render_context_as_text(None).lower()


def test_render_context_truncates_long_level_lists():
    ctx = dict(CTX, breakdown={"donor": {f"donor_{i}": 10 for i in range(400)}})
    text = render_context_as_text(ctx)
    assert len(text.splitlines()) < 60
    assert "more levels" in text


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
