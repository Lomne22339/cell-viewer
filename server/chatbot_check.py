"""Checks the connection to the lab chatbot, step by step.

    python -m server.chatbot_check              # configuration, reachability, knowledge base
    python -m server.chatbot_check --ask "..."  # and one real question through the same path

It runs the proxy's own code, so a pass here means the Cell Viewer's server can
reach the service and get an answer. It reads CHATBOT_URL, CHATBOT_FAMILY and
CHATBOT_ID from the environment, and never prints the address or the
identifier: only whether each step worked. The answer, when asked for, is the
service's own text and is labelled as such.

Exit status: 0 everything asked for worked; 2 not configured or a bad
argument; 3 the service is unreachable or its knowledge base is not ready; 4
the service could not answer.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

from fastapi import HTTPException

from .chatbot_proxy import ChatbotRequest, chat, load_config, status


def _say(text: str) -> None:
    print(text)


async def _check(question: str | None) -> int:
    if load_config() is None:
        _say("configuration: not configured")
        _say("  Set CHATBOT_URL (http or https), CHATBOT_FAMILY (disease, stress or doc) and")
        _say("  CHATBOT_ID (a sample, job or session id that exists on the service) in the")
        _say("  environment that starts the server.")
        return 2
    _say("configuration: ok")

    report = json.loads((await status()).body)
    reason = report.get("reason")
    if reason == "unreachable":
        _say("service: unreachable (no answer from the chatbot service, or an HTTP error)")
        return 3
    _say("service: reachable")
    if reason == "not_built":
        _say("knowledge base: not built (nothing has been indexed for this identifier yet)")
        return 3
    if reason != "ready":
        _say("knowledge base: the service sent a reply this server could not read")
        return 3
    _say("knowledge base: ready")

    if question is None:
        return 0
    try:
        reply = json.loads((await chat(ChatbotRequest(question=question))).body)
    except HTTPException as exc:
        _say(f"answer: the chatbot service could not answer (HTTP {exc.status_code}: {exc.detail})")
        return 4
    _say("answer, as returned by the chatbot service:")
    _say(reply["answer"])
    if reply.get("blocked"):
        _say("(the service marked this question as blocked)")
    for source in reply.get("sources", []):
        if source.get("source"):
            _say(f"  source: {source['source']}")
    return 0


def run(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Check the connection to the lab chatbot.")
    ap.add_argument("--ask", metavar="QUESTION", help="also send this question and print the answer")
    args = ap.parse_args(argv)
    question = None
    if args.ask is not None:
        question = args.ask.strip()
        if not question:
            _say("--ask needs a question")
            return 2
    return asyncio.run(_check(question))


if __name__ == "__main__":
    sys.exit(run())
