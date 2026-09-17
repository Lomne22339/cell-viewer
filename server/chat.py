"""Chat proxy.

The browser never holds the API key and never talks to Anthropic directly.
It posts a summarised selection here; this module turns that summary into a
prompt, calls the model, and streams the reply back as server-sent events.
"""
from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

DEFAULT_MODEL = "claude-sonnet-5"
MAX_CONTEXT_BYTES = 32_000
MAX_LEVELS_SHOWN = 12
HISTORY_TURNS = 10

SYSTEM_PROMPT = (
    "You are a single-cell genomics analyst embedded in an interactive "
    "embedding viewer. The user has selected a region of a UMAP, t-SNE or "
    "trajectory plot, and you are given a statistical summary of exactly "
    "those cells: how many there are, how they break down by cell type, "
    "tissue, donor and developmental stage, and the distribution of any "
    "continuous values such as pseudotime.\n\n"
    "Answer only from that summary. You do not have the expression matrix, "
    "so if a question needs gene-level data, say so plainly rather than "
    "guessing. Quote the actual counts and percentages you were given. Keep "
    "answers short and concrete; the user is looking at the plot while they "
    "read you."
)


class Turn(BaseModel):
    role: str
    text: str


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    context: dict[str, Any] | None = None
    history: list[Turn] = Field(default_factory=list)


def render_context_as_text(ctx: dict[str, Any] | None) -> str:
    """Python twin of the TypeScript `renderContextAsText`.

    Both sides must describe a selection identically, otherwise testing
    against the browser's mock adapter stops predicting what the real model
    will see.
    """
    if not ctx or not ctx.get("n"):
        return "No cells are currently selected in the viewer."

    n = int(ctx["n"])
    total = int(ctx.get("totalN") or 1)
    bbox = ctx.get("bbox", [0, 0, 0, 0])
    cen = ctx.get("centroid", [0, 0])
    lines = [
        f'Selection from dataset "{ctx.get("datasetId", "?")}" '
        f'({ctx.get("view", "embedding")} view).',
        f"{n:,} cells selected out of {total:,} total ({n / total * 100:.2f}%).",
        f"Region: x {bbox[0]:.2f} to {bbox[2]:.2f}, y {bbox[1]:.2f} to {bbox[3]:.2f}; "
        f"centroid ({cen[0]:.2f}, {cen[1]:.2f}).",
        f'Currently coloured by: {ctx.get("colorBy", "?")}.',
        "",
    ]

    for field, counts in (ctx.get("breakdown") or {}).items():
        levels = sorted(counts.items(), key=lambda kv: -kv[1])
        if not levels:
            continue
        lines.append(f"{field} composition:")
        for label, count in levels[:MAX_LEVELS_SHOWN]:
            lines.append(f"  {label}: {count:,} ({count / n * 100:.1f}%)")
        if len(levels) > MAX_LEVELS_SHOWN:
            lines.append(f"  ... and {len(levels) - MAX_LEVELS_SHOWN} more levels")
        lines.append("")

    for field, s in (ctx.get("numericStats") or {}).items():
        q = s.get("q", [0, 0, 0])
        lines.append(
            f'{field}: min {s["min"]:.3f}, q1 {q[0]:.3f}, median {q[1]:.3f}, '
            f'q3 {q[2]:.3f}, max {s["max"]:.3f}, mean {s["mean"]:.3f}'
        )

    sample = (ctx.get("sampleIds") or [])[:8]
    lines += ["", f"Example cell ids: {', '.join(sample)}"]
    return "\n".join(lines)


async def stream_anthropic(
    system: str, messages: list[dict[str, str]], model: str
) -> AsyncIterator[str]:
    """Streams text deltas from the Messages API. Replaced by a stub in tests."""
    key = os.environ["ANTHROPIC_API_KEY"]
    payload = {
        "model": model,
        "max_tokens": 1024,
        "system": system,
        "messages": messages,
        "stream": True,
    }
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST", "https://api.anthropic.com/v1/messages", json=payload, headers=headers
        ) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode("utf-8", "replace")[:500]
                raise HTTPException(
                    status_code=502, detail=f"model API error {resp.status_code}: {body}"
                )
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                blob = line[6:]
                if blob == "[DONE]":
                    break
                event = json.loads(blob)
                if event.get("type") == "content_block_delta":
                    text = event.get("delta", {}).get("text")
                    if text:
                        yield text


def normalize_messages(history: list[Turn], question: str) -> list[dict[str, str]]:
    """Shape a conversation the way the Messages API requires.

    Two rules have to hold: the first message is from the user, and roles
    alternate. Neither survives naive slicing — trimming a conversation to its
    last ten turns can cut mid-pair and open with the assistant, and a history
    whose final turn is already a user message would be followed by the new
    question as a second user message in a row. Both are rejected by the API,
    so they are fixed here rather than discovered in production.
    """
    messages: list[dict[str, str]] = []
    for turn in history:
        text = (turn.text or "").strip()
        if not text:
            continue
        role = "assistant" if turn.role == "assistant" else "user"
        if not messages and role == "assistant":
            # A conversation cannot open with the assistant.
            continue
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] += "\n\n" + text
        else:
            messages.append({"role": role, "content": text})

    if messages and messages[-1]["role"] == "user":
        messages[-1]["content"] += "\n\n" + question
    else:
        messages.append({"role": "user", "content": question})
    return messages


router = APIRouter(prefix="/api")


@router.get("/chat/status")
def chat_status() -> JSONResponse:
    return JSONResponse({
        "configured": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "model": os.environ.get("CHAT_MODEL", DEFAULT_MODEL),
    })


@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="chat is not configured: set ANTHROPIC_API_KEY in the server environment",
        )
    if req.context is not None and len(json.dumps(req.context)) > MAX_CONTEXT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="selection context too large; it should be a summary, not raw rows",
        )

    model = os.environ.get("CHAT_MODEL", DEFAULT_MODEL)
    question = (
        "Current selection in the viewer:\n\n"
        f"{render_context_as_text(req.context)}\n\n"
        f"Question: {req.question}"
    )
    messages = normalize_messages(req.history[-HISTORY_TURNS:], question)

    async def sse() -> AsyncIterator[bytes]:
        try:
            async for piece in stream_anthropic(SYSTEM_PROMPT, messages, model):
                yield f"data: {json.dumps({'text': piece})}\n\n".encode()
        except HTTPException as exc:
            yield f"data: {json.dumps({'error': exc.detail})}\n\n".encode()
        except Exception as exc:  # noqa: BLE001 - surfaced to the client, not swallowed
            yield f"data: {json.dumps({'error': str(exc)})}\n\n".encode()
        yield b"data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")
