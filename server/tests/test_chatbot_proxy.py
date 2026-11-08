"""The proxy to the separate ChatBotService, tested against a mocked upstream.

Nothing here opens a socket: `make_client` is replaced with an `httpx.AsyncClient`
over a `MockTransport`, so these tests describe the contract with the service
without needing its host, a sample id, or Ollama.
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from server.main import create_app

_REAL_ASYNC_CLIENT = httpx.AsyncClient

URL = "http://chatbot.invalid:8101"
ENV = ("CHATBOT_URL", "CHATBOT_FAMILY", "CHATBOT_ID")
CHAT_PATH = {"disease": "/chat/s1", "stress": "/stress/chat/s1", "doc": "/doc/chat/s1"}
STATUS_PATH = {
    "disease": "/build/s1/status",
    "stress": "/stress/build/s1/status",
    "doc": "/doc/build/s1/status",
}


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path))


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)


def configure(monkeypatch, family="doc", ident="s1", url=URL):
    monkeypatch.setenv("CHATBOT_URL", url)
    monkeypatch.setenv("CHATBOT_FAMILY", family)
    monkeypatch.setenv("CHATBOT_ID", ident)


def upstream(monkeypatch, handler):
    """Replaces the proxy's HTTP client with one answering from `handler`."""
    calls: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    monkeypatch.setattr(
        "server.chatbot_proxy.make_client",
        lambda timeout: _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(wrapped), timeout=timeout),
    )
    return calls


def ok_answer(text="Add CHIR99021 on day 0."):
    return httpx.Response(200, json={"status": "ok", "answer": text, "chunks": []})


def ask(client, question="How do I start?", **extra):
    return client.post("/api/chatbot/chat", json={"question": question, **extra})


# ---------------------------------------------------------------- disabled


def test_it_is_disabled_when_nothing_is_configured(client, monkeypatch):
    calls = upstream(monkeypatch, lambda r: ok_answer())
    body = client.get("/api/chatbot/status").json()
    assert body["configured"] is False
    assert body["ready"] is False
    assert ask(client).status_code == 503
    assert calls == []


@pytest.mark.parametrize("missing", ENV)
def test_it_is_disabled_when_any_one_setting_is_missing(client, monkeypatch, missing):
    configure(monkeypatch)
    monkeypatch.delenv(missing)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    assert client.get("/api/chatbot/status").json()["configured"] is False
    assert ask(client).status_code == 503
    assert calls == []


@pytest.mark.parametrize("family", ["", "Doc", "docs", "admin", "doc/../x"])
def test_it_rejects_an_unknown_family(client, monkeypatch, family):
    configure(monkeypatch, family=family)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    assert client.get("/api/chatbot/status").json()["configured"] is False
    assert ask(client).status_code == 503
    assert calls == []


@pytest.mark.parametrize("ident", ["../etc", "a/b", "a\\b", "..", "a\n", "a b", "x" * 65, "é", ""])
def test_it_rejects_an_identifier_that_fails_safe_name(client, monkeypatch, ident):
    configure(monkeypatch, ident=ident)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    assert client.get("/api/chatbot/status").json()["configured"] is False
    assert ask(client).status_code == 503
    assert calls == []


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "ftp://host", "javascript:alert(1)", "http://", "chatbot:8101", "//host", "not a url"]
)
def test_it_rejects_a_service_url_that_is_not_http(client, monkeypatch, url):
    configure(monkeypatch, url=url)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    assert client.get("/api/chatbot/status").json()["configured"] is False
    assert ask(client).status_code == 503
    assert calls == []


def test_a_trailing_slash_on_the_url_is_tolerated(client, monkeypatch):
    configure(monkeypatch, url=URL + "/")
    calls = upstream(monkeypatch, lambda r: ok_answer())
    assert ask(client).status_code == 200
    assert str(calls[0].url) == URL + CHAT_PATH["doc"]


# ----------------------------------------------------------------- status


@pytest.mark.parametrize("family", ["disease", "stress", "doc"])
def test_status_asks_the_family_status_route(client, monkeypatch, family):
    configure(monkeypatch, family=family)
    calls = upstream(monkeypatch, lambda r: httpx.Response(200, json={"rag_ready": True}))
    body = client.get("/api/chatbot/status").json()
    assert body == {"configured": True, "ready": True, "reason": "ready"}
    assert [(c.method, c.url.path) for c in calls] == [("GET", STATUS_PATH[family])]


def test_status_says_when_the_knowledge_base_is_not_built(client, monkeypatch):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: httpx.Response(200, json={"rag_ready": False}))
    body = client.get("/api/chatbot/status").json()
    assert body["configured"] is True
    assert body["ready"] is False
    assert body["reason"] == "not_built"


@pytest.mark.parametrize(
    "boom",
    [httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), httpx.ConnectTimeout("slow")],
)
def test_status_reports_unreachable_without_failing(client, monkeypatch, boom):
    configure(monkeypatch)

    def handler(request):
        raise boom

    upstream(monkeypatch, handler)
    res = client.get("/api/chatbot/status")
    assert res.status_code == 200
    assert res.json() == {"configured": True, "ready": False, "reason": "unreachable"}


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="boom"),
        httpx.Response(302, headers={"location": "http://elsewhere.invalid/"}),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json=["rag_ready"]),
        httpx.Response(200, json={"rag_ready": "yes"}),
    ],
)
def test_status_treats_anything_but_a_clean_true_as_not_ready(client, monkeypatch, response):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: response)
    body = client.get("/api/chatbot/status").json()
    assert body["configured"] is True
    assert body["ready"] is False


def test_status_never_reveals_the_service_address_or_identifier(client, monkeypatch):
    configure(monkeypatch, ident="secret_sample_7", url="http://10.9.8.7:8101")
    upstream(monkeypatch, lambda r: httpx.Response(200, json={"rag_ready": True}))
    text = client.get("/api/chatbot/status").text
    for secret in ("10.9.8.7", "8101", "secret_sample_7"):
        assert secret not in text


# ------------------------------------------------------------------- chat


@pytest.mark.parametrize("family", ["disease", "stress", "doc"])
def test_chat_posts_the_question_to_the_family_route(client, monkeypatch, family):
    configure(monkeypatch, family=family)
    calls = upstream(monkeypatch, lambda r: ok_answer("Use Activin A."))
    res = ask(client, "Which factors?")
    assert res.status_code == 200
    assert res.json() == {"answer": "Use Activin A.", "blocked": False, "sources": []}
    assert len(calls) == 1
    assert (calls[0].method, calls[0].url.path) == ("POST", CHAT_PATH[family])
    assert calls[0].read() == b'{"query":"Which factors?"}'


def test_chat_ignores_browser_context_and_history_and_forwards_only_the_question(client, monkeypatch):
    configure(monkeypatch)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    res = ask(client, "hi", context={"n": 5}, history=[{"role": "user", "text": "x"}])
    assert res.status_code == 200
    assert calls[0].read() == b'{"query":"hi"}'


def test_chat_trims_the_question_but_keeps_its_content(client, monkeypatch):
    configure(monkeypatch)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    ask(client, "  padded  ")
    assert calls[0].read() == b'{"query":"padded"}'


@pytest.mark.parametrize("question", ["", "   ", "x" * 701])
def test_chat_rejects_a_question_outside_the_services_limits(client, monkeypatch, question):
    configure(monkeypatch)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    assert ask(client, question).status_code == 422
    assert calls == []


def test_chat_accepts_a_question_of_exactly_700_characters(client, monkeypatch):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: ok_answer())
    assert ask(client, "x" * 700).status_code == 200


def test_chat_rejects_a_missing_or_non_string_question(client, monkeypatch):
    configure(monkeypatch)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    assert client.post("/api/chatbot/chat", json={}).status_code == 422
    assert client.post("/api/chatbot/chat", json={"question": 5}).status_code == 422
    assert calls == []


def test_chat_returns_the_services_sources_trimmed(client, monkeypatch):
    configure(monkeypatch)
    chunks = [
        {"text": "a" * 900, "source": "protocol.pdf", "score": 0.91},
        {"text": "b", "type": "cell_summary", "score": 0.5},
        "junk",
        {"text": 7},
    ]
    upstream(monkeypatch, lambda r: httpx.Response(200, json={"status": "ok", "answer": "x", "chunks": chunks}))
    sources = ask(client).json()["sources"]
    assert [s["source"] for s in sources] == ["protocol.pdf", "cell_summary"]
    assert len(sources[0]["text"]) == 300
    assert sources[0]["score"] == 0.91


def test_chat_passes_through_a_blocked_reply(client, monkeypatch):
    configure(monkeypatch)
    upstream(
        monkeypatch,
        lambda r: httpx.Response(200, json={"status": "ok", "answer": "Out of scope.", "chunks": [], "blocked": True}),
    )
    assert ask(client).json() == {"answer": "Out of scope.", "blocked": True, "sources": []}


# ------------------------------------------------------- upstream failures

LEAKY = "No results at /app/project/Disease_pred_results_updated/s1 (192.168.2.228)"


def test_chat_409_says_the_knowledge_base_is_not_built(client, monkeypatch):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: httpx.Response(409, json={"detail": LEAKY}))
    res = ask(client)
    assert res.status_code == 409
    assert "not built" in res.json()["detail"]
    assert "/app/project" not in res.text and "192.168" not in res.text


@pytest.mark.parametrize("code", [404, 422, 500, 502, 503])
def test_chat_other_upstream_errors_become_a_502_without_leaking_detail(client, monkeypatch, code):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: httpx.Response(code, json={"detail": LEAKY}))
    res = ask(client)
    assert res.status_code == 502
    assert "/app/project" not in res.text and "192.168" not in res.text


def test_chat_a_redirect_is_not_followed(client, monkeypatch):
    configure(monkeypatch)
    calls = upstream(monkeypatch, lambda r: httpx.Response(307, headers={"location": "http://evil.invalid/"}))
    assert ask(client).status_code == 502
    assert len(calls) == 1


def test_chat_a_timeout_is_a_504(client, monkeypatch):
    configure(monkeypatch)

    def handler(request):
        raise httpx.ReadTimeout("slow")

    upstream(monkeypatch, handler)
    res = ask(client)
    assert res.status_code == 504
    assert "invalid" not in res.text


@pytest.mark.parametrize("boom", [httpx.ConnectError("refused"), httpx.RemoteProtocolError("reset")])
def test_chat_an_unreachable_service_is_a_502(client, monkeypatch, boom):
    configure(monkeypatch)

    def handler(request):
        raise boom

    upstream(monkeypatch, handler)
    res = ask(client)
    assert res.status_code == 502
    assert "chatbot.invalid" not in res.text


# ----------------------------------------------------------- soft failures


@pytest.mark.parametrize(
    "answer",
    [
        "[Error: Cannot connect to Ollama. Is it running on localhost:11434?]",
        "[Error: Ollama timed out after 180s.]",
        "[Error: No response field returned by Ollama.]",
        "  [Error: padded]",
        "[No response from LLM]",
        "",
        "   ",
    ],
)
def test_chat_an_error_written_into_the_answer_is_an_error_not_an_answer(client, monkeypatch, answer):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: httpx.Response(200, json={"status": "ok", "answer": answer, "chunks": []}))
    res = ask(client)
    assert res.status_code == 502
    assert "localhost:11434" not in res.text


def test_chat_a_status_other_than_ok_is_an_error(client, monkeypatch):
    configure(monkeypatch)
    upstream(
        monkeypatch,
        lambda r: httpx.Response(
            200, json={"status": "error", "answer": "RAG store not found at /app/project/x", "chunks": []}
        ),
    )
    res = ask(client)
    assert res.status_code == 502
    assert "/app/project" not in res.text


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="<html>proxy error</html>"),
        httpx.Response(200, json=["not", "an", "object"]),
        httpx.Response(200, json={"status": "ok"}),
        httpx.Response(200, json={"status": "ok", "answer": 42}),
        httpx.Response(200, json={"status": "ok", "answer": None}),
    ],
)
def test_chat_a_malformed_reply_is_a_502(client, monkeypatch, response):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: response)
    assert ask(client).status_code == 502


def test_chat_an_oversized_reply_is_refused(client, monkeypatch):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: httpx.Response(200, content=b'{"answer":"' + b"a" * 3_000_000 + b'"}'))
    assert ask(client).status_code == 502


# ------------------------------------------------------------ surface area


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/api/chatbot/build"),
        ("POST", "/api/chatbot/build/s1"),
        ("POST", "/api/chatbot/doc/build/s1"),
        ("POST", "/api/chatbot/stress/build/s1"),
        ("GET", "/api/chatbot/health"),
        ("GET", "/api/chatbot/chat/s1"),
        ("POST", "/api/chatbot/chat/s1"),
    ],
)
def test_no_build_or_upload_route_is_exposed(client, monkeypatch, method, path):
    configure(monkeypatch)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    res = client.request(method, path, files={"files": ("a.txt", b"x")} if "build" in path else None)
    assert res.status_code in (404, 405)
    assert calls == []


def test_the_identifier_comes_from_the_environment_never_the_request(client, monkeypatch):
    configure(monkeypatch)
    calls = upstream(monkeypatch, lambda r: ok_answer())
    ask(client, session_id="other", sample_id="other", id="other", family="disease")
    assert calls[0].url.path == CHAT_PATH["doc"]


def test_the_existing_chat_routes_are_untouched(client, monkeypatch):
    configure(monkeypatch)
    upstream(monkeypatch, lambda r: ok_answer())
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    res = client.get("/api/chat/status")
    assert res.status_code == 200
    assert res.json()["configured"] is False
    assert client.post("/api/chat", json={"question": "hi"}).status_code == 503


# ------------------------------------------------- shapes from the real service
# These bodies are copied from the response models and return statements in
# ChatBotService (main.py, chat_final.py, stress_chat.py, doc_chat.py), so a
# change in how the proxy reads them is caught without the service running.

REAL_REPLY = {
    "disease": {
        "status": "ok", "sample_id": "s1", "answer": "Plasma cells are raised.", "blocked": False,
        "chunks": [{"text": "cluster 3 ...", "score": 0.812, "type": "cell_summary"}],
    },
    "stress": {
        "status": "ok", "job_id": "s1", "answer": "Heat shock genes rise.",
        "chunks": [{"text": "HSPA1A ...", "score": 0.5, "type": "marker_genes"}],
    },
    "doc": {
        "status": "ok", "session_id": "s1", "answer": "Add CHIR99021.",
        "chunks": [{"text": "Day 0 ...", "source": "protocol.pdf", "score": 0.77}],
    },
}


@pytest.mark.parametrize("family", ["disease", "stress", "doc"])
def test_it_reads_each_real_reply_shape(client, monkeypatch, family):
    configure(monkeypatch, family=family)
    upstream(monkeypatch, lambda r: httpx.Response(200, json=REAL_REPLY[family]))
    body = ask(client).json()
    assert body["answer"] == REAL_REPLY[family]["answer"]
    assert body["blocked"] is False
    # The disease and stress services label a chunk by `type`, the doc service by `source`.
    label = REAL_REPLY[family]["chunks"][0]
    assert body["sources"][0]["source"] == label.get("source", label.get("type"))
    assert body["sources"][0]["score"] == label["score"]


@pytest.mark.parametrize("family", ["disease", "stress", "doc"])
def test_status_reads_the_real_status_shape(client, monkeypatch, family):
    configure(monkeypatch, family=family)
    id_key = {"disease": "sample_id", "stress": "job_id", "doc": "session_id"}[family]
    upstream(monkeypatch, lambda r: httpx.Response(200, json={id_key: "s1", "rag_ready": True, "n_chunks": 12}))
    assert client.get("/api/chatbot/status").json() == {"configured": True, "ready": True, "reason": "ready"}


def test_a_stress_error_status_with_http_200_is_an_error(client, monkeypatch):
    # stress_chat.py returns {"status": "error", ...} for a failed embedding.
    configure(monkeypatch, family="stress")
    upstream(monkeypatch, lambda r: httpx.Response(
        200, json={"status": "error", "job_id": "s1", "answer": "Query embedding failed: x", "chunks": []}))
    assert ask(client).status_code == 502
