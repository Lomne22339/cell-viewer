"""Chat proxy: the API key stays here; the browser only posts a selection summary."""
from __future__ import annotations

import json
import math
import os
from decimal import ROUND_HALF_UP, Context, Decimal
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

DEFAULT_MODEL = "claude-sonnet-5"
MAX_CONTEXT_BYTES = 32_000
MAX_LEVELS_SHOWN = 12
HISTORY_TURNS = 10
MAX_TURN_CHARS = 20_000
MAX_HISTORY_CHARS = 60_000

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
    text: str = Field(max_length=MAX_TURN_CHARS)


def trim_history(history: list[Turn], budget: int = MAX_HISTORY_CHARS) -> list[Turn]:
    kept: list[Turn] = []
    total = 0
    for turn in reversed(history):
        total += len(turn.text or "")
        if total > budget:
            break
        kept.append(turn)
    kept.reverse()
    return kept


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    context: dict[str, Any] | None = None
    history: list[Turn] = Field(default_factory=list)


# Enough digits for any double below 1e21 at three decimals, so quantize never loses precision.
_DECIMAL = Context(prec=60, rounding=ROUND_HALF_UP)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _finite(value: Any) -> bool:
    """A real, finite number. A huge int counts as infinite, as JSON.parse would make it."""
    if not _is_number(value):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _to_fixed(value: Any, digits: int) -> str:
    """JavaScript's `toFixed`, character for character (ties round away from zero)."""
    if not _finite(value):
        return "n/a"
    x = float(value)
    if abs(x) >= 1e21:
        # toFixed gives up here and prints the shortest round-trip form, as repr does.
        return repr(x)
    if x == 0:
        x = 0.0  # toFixed prints negative zero without its sign
    quantum = Decimal(1).scaleb(-digits)
    return format(Decimal(x).quantize(quantum, rounding=ROUND_HALF_UP, context=_DECIMAL), "f")


def _percent(part: float, whole: float, digits: int) -> str:
    try:
        return _to_fixed(part / whole * 100, digits)
    except ZeroDivisionError:
        return "n/a"


def _js_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _grouped(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value:,}" if _finite(value) else _js_str(value)


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list:
    return value if isinstance(value, (list, tuple)) else []


def _at(seq: list, i: int) -> Any:
    return seq[i] if i < len(seq) else None


def render_context_as_text(ctx: dict[str, Any] | None) -> str:
    """Python twin of the TypeScript `renderContextAsText`: keep the two in step."""
    if not isinstance(ctx, dict) or not _finite(ctx.get("n")) or not ctx["n"] > 0:
        return "No cells are currently selected in the viewer."

    n = ctx["n"]
    total = ctx["totalN"] if _finite(ctx.get("totalN")) else 0
    # Presence, not truthiness: a legend filter can leave zero cells visible.
    visible = ctx.get("visibleN")
    if visible is None or not _finite(visible):
        visible = total
    bbox = _list(ctx.get("bbox"))
    cen = _list(ctx.get("centroid"))
    if visible < total:
        share = (
            f"{_grouped(n)} cells selected out of {_grouped(visible)} visible "
            f"({_grouped(total)} total; {_percent(n, max(1, visible), 2)}% of visible)."
        )
    else:
        share = f"{_grouped(n)} cells selected out of {_grouped(total)} total ({_percent(n, total, 2)}%)."
    lines = [
        f'Selection from dataset "{_js_str(ctx.get("datasetId"), "?")}" '
        f'({_js_str(ctx.get("view"), "embedding")} view).',
        share,
        f"Region: x {_to_fixed(_at(bbox, 0), 2)} to {_to_fixed(_at(bbox, 2), 2)}, "
        f"y {_to_fixed(_at(bbox, 1), 2)} to {_to_fixed(_at(bbox, 3), 2)}; "
        f"centroid ({_to_fixed(_at(cen, 0), 2)}, {_to_fixed(_at(cen, 1), 2)}).",
        f'Currently colored by: {_js_str(ctx.get("colorBy"), "?")}.',
    ]
    for field, labels in _dict(ctx.get("hidden")).items():
        labels = _list(labels)
        if not labels:
            continue
        shown = ", ".join(_js_str(x) for x in labels[:MAX_LEVELS_SHOWN])
        more = f" and {len(labels) - MAX_LEVELS_SHOWN} more" if len(labels) > MAX_LEVELS_SHOWN else ""
        lines.append(f"Legend filter hides {field}: {shown}{more}.")
    lines.append("")

    omitted_by_field = _dict(ctx.get("omittedLevels"))
    for field, counts in _dict(ctx.get("breakdown")).items():
        levels = sorted(
            ((label, count) for label, count in _dict(counts).items() if _finite(count)),
            key=lambda kv: -kv[1],
        )
        if not levels:
            continue
        lines.append(f"{field} composition:")
        for label, count in levels[:MAX_LEVELS_SHOWN]:
            lines.append(f"  {label}: {_grouped(count)} ({_percent(count, n, 1)}%)")
        omitted = omitted_by_field.get(field)
        more = max(0, len(levels) - MAX_LEVELS_SHOWN) + (omitted if _finite(omitted) else 0)
        if more > 0:
            lines.append(f"  ... and {_js_str(more)} more levels")
        lines.append("")

    for field, stats in _dict(ctx.get("numericStats")).items():
        s = _dict(stats)
        q = _list(s.get("q"))
        lines.append(
            f'{field}: min {_to_fixed(s.get("min"), 3)}, q1 {_to_fixed(_at(q, 0), 3)}, '
            f'median {_to_fixed(_at(q, 1), 3)}, q3 {_to_fixed(_at(q, 2), 3)}, '
            f'max {_to_fixed(s.get("max"), 3)}, mean {_to_fixed(s.get("mean"), 3)}'
        )

    sample = _list(ctx.get("sampleIds"))[:8]
    lines += ["", f"Example cell ids: {', '.join(_js_str(x) for x in sample)}"]
    return "\n".join(lines)


async def stream_anthropic(
    system: str, messages: list[dict[str, str]], model: str
) -> AsyncIterator[str]:
    """Streams text deltas from the Messages API; an `error` event mid-stream raises."""
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
                if not isinstance(event, dict):
                    continue
                if event.get("type") == "error":
                    err = event.get("error")
                    reason = (
                        f'{err.get("type", "error")}: {err.get("message", "")}'
                        if isinstance(err, dict) else str(err)
                    )
                    raise HTTPException(status_code=502, detail=f"model API error: {reason}")
                if event.get("type") == "content_block_delta":
                    text = event.get("delta", {}).get("text")
                    if text:
                        yield text


def normalize_messages(history: list[Turn], question: str) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for turn in history:
        text = (turn.text or "").strip()
        if not text:
            continue
        role = "assistant" if turn.role == "assistant" else "user"
        if not messages and role == "assistant":
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
    try:
        summary = render_context_as_text(req.context)
    except (ValueError, TypeError) as exc:
        # Backstop: an unreadable context is the client's error (422), not a 500.
        raise HTTPException(status_code=422, detail=f"malformed selection context: {exc}") from exc
    question = (
        "Current selection in the viewer:\n\n"
        f"{summary}\n\n"
        f"Question: {req.question}"
    )
    messages = normalize_messages(trim_history(req.history[-HISTORY_TURNS:]), question)

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
