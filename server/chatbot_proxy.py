"""Proxy to the separate ChatBotService (RAG over Ollama).

The browser never learns where that service lives, which family of it is in
use, or which sample it answers for: all three come from the server's
environment, and the browser sees only whether the chatbot is usable. The
service has no authentication and trusts the identifier it is given as a
directory name, so this module is the only door to it and keeps that door
narrow. It forwards a single question to a single chat route. It never
exposes the service's build or upload routes, and it never lets a request
choose the family or identifier.

Configuration, read on every request so a restart is not needed to change it:

    CHATBOT_URL     base URL of the service, http or https
    CHATBOT_FAMILY  `disease`, `stress` or `doc`
    CHATBOT_ID      the sample, job or session id, checked with SAFE_NAME

If any of the three is missing or invalid the integration is disabled, and
the existing selection-aware `/api/chat` is not affected either way.
"""
from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StringConstraints

from .names import is_safe

logger = logging.getLogger("cell_viewer.chatbot")

FAMILIES = ("disease", "stress", "doc")

#: family -> (chat route, status route), with `{id}` filled from CHATBOT_ID.
_ROUTES = {
    "disease": ("/chat/{id}", "/build/{id}/status"),
    "stress": ("/stress/chat/{id}", "/stress/build/{id}/status"),
    "doc": ("/doc/chat/{id}", "/doc/build/{id}/status"),
}

#: The service rejects longer questions with a 422 of its own.
MAX_QUESTION = 700
#: Ollama's own limit in the service is 180 s, so this must outlast it.
CHAT_TIMEOUT = httpx.Timeout(200.0, connect=5.0)
STATUS_TIMEOUT = httpx.Timeout(5.0)
#: A reply larger than this is not a chat answer.
MAX_REPLY_BYTES = 2_000_000
MAX_SOURCES = 8
MAX_SOURCE_CHARS = 300

#: The service writes failures into `answer` and still answers 200. These are
#: the forms it uses (chat_final.py and doc_chat.py).
_SOFT_ERROR_PREFIX = "[Error"
_SOFT_ERROR_EXACT = {"[No response from LLM]"}


@dataclass(frozen=True)
class ChatbotConfig:
    base: str
    family: str
    ident: str

    def chat_path(self) -> str:
        return _ROUTES[self.family][0].format(id=self.ident)

    def status_path(self) -> str:
        return _ROUTES[self.family][1].format(id=self.ident)


def _clean_base(url: str) -> str | None:
    """`url` without a trailing slash, or None unless it is a plain http(s) address."""
    try:
        parts = urlsplit(url.strip())
        parts.port  # noqa: B018 - raises ValueError for a malformed port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    # Credentials, a query or a fragment have no place in a base address.
    if parts.username or parts.password or parts.query or parts.fragment:
        return None
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


def load_config() -> ChatbotConfig | None:
    """The configuration, or None when the integration is off or misconfigured.

    A misconfiguration is logged by setting name only, never by value, so the
    log does not become a second place the address is written down.
    """
    url = os.environ.get("CHATBOT_URL", "").strip()
    family = os.environ.get("CHATBOT_FAMILY", "").strip()
    ident = os.environ.get("CHATBOT_ID", "")
    if not (url or family or ident):
        return None
    base = _clean_base(url) if url else None
    problems = [
        name
        for name, good in (
            ("CHATBOT_URL", base is not None),
            ("CHATBOT_FAMILY", family in FAMILIES),
            # fullmatch via is_safe: a trailing newline must not pass.
            ("CHATBOT_ID", is_safe(ident)),
        )
        if not good
    ]
    if problems:
        logger.warning("chatbot disabled: invalid or missing %s", ", ".join(problems))
        return None
    return ChatbotConfig(base=base, family=family, ident=ident)  # type: ignore[arg-type]


def make_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    """The HTTP client for the service. Tests replace this with a mock transport.

    Redirects are not followed: the service never redirects, and following one
    would let a misbehaving host steer this server to an address of its choice.
    """
    return httpx.AsyncClient(timeout=timeout, follow_redirects=False)


class UpstreamTimeout(Exception):
    pass


class UpstreamUnreachable(Exception):
    pass


class UpstreamTooLarge(Exception):
    pass


async def _call(
    cfg: ChatbotConfig, method: str, path: str, timeout: httpx.Timeout, payload: dict[str, Any] | None = None
) -> tuple[int, Any]:
    """One request to the service: its status code and its body parsed as JSON.

    The body is None when it is not JSON. The size cap is enforced while
    streaming, so an oversized reply is dropped rather than held in memory.
    """
    try:
        async with make_client(timeout) as client:
            async with client.stream(method, cfg.base + path, json=payload) as resp:
                size = 0
                chunks: list[bytes] = []
                async for piece in resp.aiter_bytes():
                    size += len(piece)
                    if size > MAX_REPLY_BYTES:
                        raise UpstreamTooLarge()
                    chunks.append(piece)
                status = resp.status_code
    except httpx.TimeoutException as exc:
        raise UpstreamTimeout() from exc
    except httpx.HTTPError as exc:
        raise UpstreamUnreachable() from exc
    try:
        return status, json.loads(b"".join(chunks))
    except ValueError:
        return status, None


class ChatbotRequest(BaseModel):
    # Only the question is forwarded. The service's API has no field for the
    # selection context, and any other field the browser sends is ignored.
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_QUESTION)]


router = APIRouter(prefix="/api/chatbot")


@router.get("/status")
async def status() -> JSONResponse:
    """Whether the chatbot is usable. Never carries the address, family or id."""
    cfg = load_config()
    if cfg is None:
        return JSONResponse({"configured": False, "ready": False, "reason": "not_configured"})
    try:
        code, body = await _call(cfg, "GET", cfg.status_path(), STATUS_TIMEOUT)
    except (UpstreamTimeout, UpstreamUnreachable, UpstreamTooLarge):
        return JSONResponse({"configured": True, "ready": False, "reason": "unreachable"})
    if not 200 <= code < 300:
        return JSONResponse({"configured": True, "ready": False, "reason": "unreachable"})
    ready = body.get("rag_ready") if isinstance(body, dict) else None
    if ready is True:
        return JSONResponse({"configured": True, "ready": True, "reason": "ready"})
    if ready is False:
        return JSONResponse({"configured": True, "ready": False, "reason": "not_built"})
    return JSONResponse({"configured": True, "ready": False, "reason": "bad_reply"})


def _is_soft_error(answer: str) -> bool:
    text = answer.strip()
    return not text or text.startswith(_SOFT_ERROR_PREFIX) or text in _SOFT_ERROR_EXACT


def _sources(chunks: Any) -> list[dict[str, Any]]:
    """The service's retrieved chunks, reduced to short text, a label and a score."""
    out: list[dict[str, Any]] = []
    if not isinstance(chunks, list):
        return out
    for chunk in chunks:
        if not isinstance(chunk, dict) or not isinstance(chunk.get("text"), str):
            continue
        item: dict[str, Any] = {"text": chunk["text"][:MAX_SOURCE_CHARS]}
        label = chunk.get("source") or chunk.get("type")
        if isinstance(label, str) and label:
            item["source"] = label
        score = chunk.get("score")
        if isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score):
            item["score"] = score
        out.append(item)
        if len(out) == MAX_SOURCES:
            break
    return out


@router.post("/chat")
async def chat(req: ChatbotRequest) -> JSONResponse:
    cfg = load_config()
    if cfg is None:
        raise HTTPException(status_code=503, detail="chatbot service is not configured")
    try:
        code, body = await _call(cfg, "POST", cfg.chat_path(), CHAT_TIMEOUT, {"query": req.question})
    except UpstreamTimeout:
        raise HTTPException(status_code=504, detail="the chatbot service took too long to answer")
    except (UpstreamUnreachable, UpstreamTooLarge):
        raise HTTPException(status_code=502, detail="the chatbot service could not be reached")

    # Upstream detail text can name server paths, so it is logged here and
    # never forwarded: the browser gets a fixed message per failure.
    if code == 409:
        raise HTTPException(status_code=409, detail="the chatbot knowledge base is not built yet")
    if not 200 <= code < 300:
        logger.warning("chatbot service answered HTTP %s (%s)", code, cfg.family)
        raise HTTPException(status_code=502, detail="the chatbot service could not answer")
    if not isinstance(body, dict) or body.get("status") != "ok" or not isinstance(body.get("answer"), str):
        logger.warning("chatbot service sent a malformed or failed reply (%s)", cfg.family)
        raise HTTPException(status_code=502, detail="the chatbot service could not answer")
    answer = body["answer"]
    if _is_soft_error(answer):
        logger.warning("chatbot service reported an error inside its answer (%s)", cfg.family)
        raise HTTPException(status_code=502, detail="the chatbot service could not answer")
    return JSONResponse(
        {"answer": answer, "blocked": body.get("blocked") is True, "sources": _sources(body.get("chunks"))}
    )
