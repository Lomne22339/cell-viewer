"""The connection checker: what an operator runs to see whether the lab chatbot is really reachable.

Tested against a mocked upstream, so these prove the checker reports each state
correctly. They say nothing about the lab server itself; only running the
checker against it does.
"""
import httpx
import pytest

from server.chatbot_check import run

_REAL_ASYNC_CLIENT = httpx.AsyncClient
URL = "http://chatbot.invalid:8101"
SECRET_ID = "session_secret_7"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("CHATBOT_URL", "CHATBOT_FAMILY", "CHATBOT_ID"):
        monkeypatch.delenv(name, raising=False)


def configure(monkeypatch, family="doc"):
    monkeypatch.setenv("CHATBOT_URL", URL)
    monkeypatch.setenv("CHATBOT_FAMILY", family)
    monkeypatch.setenv("CHATBOT_ID", SECRET_ID)


def upstream(monkeypatch, handler):
    calls = []

    def wrapped(request):
        calls.append(request)
        return handler(request)

    monkeypatch.setattr(
        "server.chatbot_proxy.make_client",
        lambda timeout: _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(wrapped), timeout=timeout),
    )
    return calls


def ready(request):
    if request.url.path.endswith("/status"):
        return httpx.Response(200, json={"rag_ready": True})
    return httpx.Response(200, json={"status": "ok", "answer": "Add factor X on day 2.", "chunks": []})


def test_not_configured_says_which_settings_to_make_and_exits_2(monkeypatch, capsys):
    calls = upstream(monkeypatch, ready)
    assert run([]) == 2
    out = capsys.readouterr().out
    for name in ("CHATBOT_URL", "CHATBOT_FAMILY", "CHATBOT_ID"):
        assert name in out
    assert calls == []


def test_an_invalid_setting_is_treated_as_not_configured(monkeypatch, capsys):
    configure(monkeypatch, family="admin")
    calls = upstream(monkeypatch, ready)
    assert run([]) == 2
    assert calls == []
    assert "not configured" in capsys.readouterr().out.lower()


def test_a_ready_service_exits_0_without_asking_anything(monkeypatch, capsys):
    configure(monkeypatch)
    calls = upstream(monkeypatch, ready)
    assert run([]) == 0
    out = capsys.readouterr().out.lower()
    assert "reachable" in out and "ready" in out
    assert all(c.method == "GET" for c in calls)


@pytest.mark.parametrize("boom", [httpx.ConnectError("refused"), httpx.ReadTimeout("slow")])
def test_an_unreachable_service_exits_3(monkeypatch, capsys, boom):
    configure(monkeypatch)

    def handler(request):
        raise boom

    upstream(monkeypatch, handler)
    assert run([]) == 3
    assert "unreachable" in capsys.readouterr().out.lower()


def test_a_knowledge_base_that_is_not_built_exits_3_and_does_not_ask(monkeypatch, capsys):
    configure(monkeypatch)
    calls = upstream(monkeypatch, lambda r: httpx.Response(200, json={"rag_ready": False}))
    assert run(["--ask", "hello"]) == 3
    assert "not built" in capsys.readouterr().out.lower()
    assert all(c.method == "GET" for c in calls)


def test_asking_sends_the_question_and_prints_the_answer_as_the_services(monkeypatch, capsys):
    configure(monkeypatch)
    calls = upstream(monkeypatch, ready)
    assert run(["--ask", "How do I start?"]) == 0
    out = capsys.readouterr().out
    assert "Add factor X on day 2." in out
    posts = [c for c in calls if c.method == "POST"]
    assert len(posts) == 1 and posts[0].read() == b'{"query":"How do I start?"}'


def test_a_failed_answer_exits_4_with_the_fixed_message(monkeypatch, capsys):
    configure(monkeypatch)

    def handler(request):
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"rag_ready": True})
        return httpx.Response(500, json={"detail": "trace at /app/project/x"})

    upstream(monkeypatch, handler)
    assert run(["--ask", "q"]) == 4
    out = capsys.readouterr().out
    assert "could not answer" in out.lower()
    assert "/app/project" not in out


def test_an_error_written_into_the_answer_is_a_failure_not_an_answer(monkeypatch, capsys):
    configure(monkeypatch)

    def handler(request):
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"rag_ready": True})
        return httpx.Response(200, json={"status": "ok", "answer": "[Error: Cannot connect to Ollama.]", "chunks": []})

    upstream(monkeypatch, handler)
    assert run(["--ask", "q"]) == 4
    assert "Ollama" not in capsys.readouterr().out


@pytest.mark.parametrize("args", [[], ["--ask", "q"]])
def test_it_never_prints_the_address_or_the_identifier(monkeypatch, capsys, args):
    configure(monkeypatch)
    upstream(monkeypatch, ready)
    run(args)
    out = capsys.readouterr()
    for secret in (URL, "chatbot.invalid", "8101", SECRET_ID):
        assert secret not in out.out and secret not in out.err


def test_an_empty_question_is_refused_before_any_request(monkeypatch, capsys):
    configure(monkeypatch)
    calls = upstream(monkeypatch, ready)
    assert run(["--ask", "   "]) == 2
    assert calls == []
