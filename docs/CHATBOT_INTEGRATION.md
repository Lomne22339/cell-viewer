# Connecting the Cell Viewer to the lab chatbot

The Recipe Maker in the Differentiation Protocol Creator can answer through
the lab's ChatBotService (a FastAPI service distributed as `ChatBotService.zip`).
This page says what is built, what is verified, and what must be provided.

**Status: the integration is built and tested against mocked responses. It has
not been run against the real lab service**, because the service address, a
valid identifier and a network route to the lab were not available when this was
written. Until it is, the Recipe Maker uses an offline demo and says so.

## How it fits together

```
browser ──/api/chatbot/status, /api/chatbot/chat──▶ Cell Viewer server ──▶ ChatBotService ──▶ Ollama (lab GPU server)
```

- The browser only ever talks to the Cell Viewer server. It never learns the
  service address, the family or the identifier, and never calls Ollama.
- `server/chatbot_proxy.py` forwards one question to one chat route, chosen from
  the server's environment. It does not expose the service's build or upload
  routes, and it hides the service's error text (which can name server paths).
- The browser adapter is `packages/core/src/chat/service.ts` (`ServiceAdapter`).
  The Recipe Maker uses it when `GET /api/chatbot/status` says the chatbot is
  ready, and otherwise uses a clearly labelled offline demo.
- The dashboard's selection chat (`/api/chat`) is **not** connected to the lab
  service. The service takes a question and nothing else, so it cannot carry the
  selected cells. That chat is unchanged.

## What the server needs

Set these in the environment that starts the server (the server does not read a
`.env` file by itself). All three are required; if any is missing or invalid
the integration stays off.

| Variable | Meaning |
|---|---|
| `CHATBOT_URL` | Base address of the ChatBotService, `http://<ChatBotService-host>:8101`. The compose file publishes 8101 and starts uvicorn on it (the Dockerfile's `EXPOSE 8099` is stale and unused). Never the Ollama address (`:11434`). |
| `CHATBOT_FAMILY` | `doc`, `disease` or `stress`. |
| `CHATBOT_ID` | The sample, job or session id that exists on the service for that family. Letters, digits, `_` and `-`, at most 64 characters. |

Which family fits the Recipe Maker: **`doc`**. It answers from documents that
were uploaded and indexed (PDF, TXT, CSV, MD), which is what protocol text
would be. `disease` and `stress` answer from specific pipeline result files and
only make sense with those results. No identifier is assumed: one has to be
given by whoever runs the service.

The proxy never calls the service's `GET /health`: that reply contains the
Ollama address and the results folders. Reachability is judged from the family's
own `.../status` route instead.

## What has to exist on the lab side

1. The ChatBotService running and reachable from the machine running the Cell
   Viewer server (its host and port, and any VPN or lab-network access).
2. The service able to reach its Ollama server, with the model it is configured
   for pulled (`llama3:latest` by default; `nomic-embed-text` also for `stress`).
3. A built knowledge base for the identifier. For `doc` that means protocol
   documents uploaded through the service's own `POST /doc/build/{session_id}`.
   This is deliberately not available through the Cell Viewer server.

## Checking the connection

From the project folder, in the environment that will run the server (PowerShell):

```powershell
$env:CHATBOT_URL    = 'http://<service-host>:8101'
$env:CHATBOT_FAMILY = 'doc'
$env:CHATBOT_ID     = '<an id that exists on the service>'
.\.venv_win\Scripts\python.exe -m server.chatbot_check
.\.venv_win\Scripts\python.exe -m server.chatbot_check --ask "What is the first step?"
```

It prints which step works (configuration, reachability, knowledge base) and,
with `--ask`, the service's answer. It never prints the address or identifier.
Exit status: 0 worked, 2 not configured, 3 unreachable or knowledge base not
ready, 4 the service could not answer. Only an `--ask` that prints an answer
proves the lab language model responded.

Then start the server in the same shell and open the Protocol creator. The
Recipe Maker's header changes from "offline demo" to "chatbot service".

## What has been verified, and how

| Claim | Evidence |
|---|---|
| The proxy validates configuration, forwards only the question, maps 409/422/500/502/503/504 and soft failures, hides upstream detail, and exposes no build route | `server/tests/test_chatbot_proxy.py`, against a mocked upstream |
| The checker reports each state correctly and never prints the address | `server/tests/test_chatbot_check.py`, mocked upstream |
| The page chooses the service when ready, falls back to the offline demo otherwise, shows answers, sources and every error, and recovers | `e2e/chatbot-ui.spec.ts`, mocked browser responses |
| An unreachable service is handled end to end | Run for real against a server configured with a port where nothing listens: status `unreachable`, chat 502, checker exit 3, Recipe Maker on the offline demo |
| The lab server answered a question | **Not verified.** The lab's Ollama (192.168.2.228:11434) did not answer from the development machine (192.168.0.101, a different network), and the FastAPI service address is not recorded anywhere in the project |

## If the real service answers oddly

The service reports some failures as an ordinary answer (for example
`[Error: Cannot connect to Ollama...]` with HTTP 200). The proxy turns those
into errors rather than showing them as answers. If a legitimate answer ever
begins with `[Error`, that check (`_is_soft_error` in `server/chatbot_proxy.py`)
is the place to look.
