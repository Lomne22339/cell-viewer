# Cell Viewer

A browser-based viewer for single-cell data. It draws millions of cells from a
2D embedding (UMAP or t-SNE) or a trajectory on the GPU, lets you select cells
by box or lasso, and links what you select to an anatomical figure and to a
chatbot. It is built to hold one to ten million cells. TypeScript, Vite and
deck.gl run in the browser; FastAPI and NumPy run on the server.

**Contents:**
[Features](#features) ·
[Organ View](#organ-view) ·
[Differentiation Protocol Creator](#differentiation-protocol-creator) ·
[Chatbot architecture](#chatbot-architecture) ·
[Setup](#setup) ·
[Configuration](#configuration) ·
[Using it](#using-it) ·
[Your own data](#your-own-data) ·
[Architecture](#architecture) ·
[Tests](#tests) ·
[Known limitations](#known-limitations)

## Features

Three modes sit in the top bar.

| Mode | URL | What it is |
|---|---|---|
| **Datasets** | `/` | The core viewer: embedding and trajectory views of a chosen dataset |
| **Organ view** | `/?mode=organ` | A body with heart, brain and liver; pick a part and see its cells in a linked UMAP and trajectory |
| **Protocol creator** | `/?mode=protocol` | A trajectory map, a pathway graph and a recipe chat that trace a lineage back to the stem cell |

Datasets mode has two displays that share one engine:

- **Embedding view**: a UMAP or t-SNE scatter plot, one dot per cell, coloured
  by cell type, tissue, donor or developmental stage.
- **Trajectory view**: the same point cloud coloured by pseudotime, with a
  monocle3-style principal graph drawn over it: root marker, branch points,
  leaves and the lineage paths between them.

Both support box and lasso selection, zoom to region, per-cell metadata on
click, a Plotly-style legend filter, four background themes (black, white, grey,
light yellow), a foreground zoom inset, a segmented anatomy figure (body, heart,
brain, liver, pancreas) linked to the selection, level-of-detail subsampling,
and handing the selected subset to a chat panel.

## Organ View

A human body figure with the **heart, brain and liver** joined by connector
lines to one card each. Open it with the **Organ view** button, or
`/?mode=organ` (add `&organ=heart` to open an organ directly).

- **Maximise an organ.** Click its card. The organ fills the screen: its
  segmented figure, its **UMAP** and its **trajectory** side by side, with a
  rail of the body and the three organs to switch between them. On a narrow
  window the panels stack.
- **Select parts.** Click a part of the figure (left ventricle, frontal lobe,
  right lobe, ...). The cells from that part are selected in **both** plots. A
  box or lasso on either plot selects the same cells in the other and shades the
  figure. Parts with no cells say "no data".
- **Why the plots stay in sync.** Each organ has two datasets that hold the same
  cells in the same order, so a selection is one list of cell indices applied to
  both. Selection state still lives in each view's own selection store; the link
  only passes it on.
- **Reuse.** The plots are the same `ScatterView` and `TrajectoryView` as in
  Datasets mode, and the figures are the same anatomy models.
- **The shipped organ data is synthetic.** `server/organs.py` simulates 30,000
  cells per organ, and the view labels them "Synthetic demo data". Nothing in
  them is biology. To replace them with real data, follow
  [`docs/ORGAN_DATA.md`](docs/ORGAN_DATA.md); to check a pair, run
  `npx vite-node scripts/check-organ-data.ts`.

## Differentiation Protocol Creator

Open it with the **Protocol creator** button or `/?mode=protocol`. Three panels
work from one shared state:

| Panel | Shows |
|---|---|
| **Trajectory map** | The cells on a trajectory, with the principal graph. The traced lineage is drawn over it. |
| **Pathway graph** | The differentiation tree of milestones, from the stem cell to the terminal cell types, laid out by day. |
| **Recipe maker** | A chat that answers with a recipe for the chosen lineage. |

- **Trace a lineage.** Click a milestone on the map or on the graph, or choose a
  timepoint. The path from the **stem cell** to that milestone is highlighted in
  every panel, and the recipe maker is told the same path.
- **Expand any panel.** Each panel has an expand button. The expanded panel
  fills the area and the other two stay on screen as thumbnails; click a
  thumbnail to expand it instead, or press Escape to go back. Box and lasso
  selection on the map are available when the map is expanded.
- **Recipe maker.** If the lab chatbot service is configured and ready, the
  header reads "chatbot service" and answers come from it. Otherwise it runs a
  labelled **offline demo** that lists the traced milestones with their
  invented factors and markers.
- **The data is synthetic.** The tree is derived deterministically from a
  trajectory graph. Milestones, factors, markers and recipes are placeholders,
  and every answer opens with a "Synthetic demo data" notice. They are not
  experimental recommendations.

## Chatbot architecture

There are two separate chats.

```
Dashboard chat   browser -- /api/chat ----------------------> Cell Viewer server --> Anthropic API (optional)
                 sends a summary of the selected cells; an offline adapter answers when there is no key

Recipe Maker     browser -- /api/chatbot/status, /chat -----> Cell Viewer server --> lab ChatBotService --> Ollama
                 sends the question only; an offline demo answers when the service is unavailable
```

- The browser only ever talks to the Cell Viewer server. The service address,
  the family and the identifier live in the server's environment and never reach
  the page. The service's own error text is hidden, because it can name server
  paths.
- `server/chatbot_proxy.py` forwards one question to one chat route of the lab
  ChatBotService (`doc`, `disease` or `stress` family). It exposes no build or
  upload route. It maps the service's 409 (knowledge base not built), 422, 500,
  timeouts and connection failures to fixed messages, and treats errors written
  into an HTTP 200 answer as errors.
- The browser adapter is `ServiceAdapter` (`packages/core/src/chat/service.ts`).
  The Recipe Maker uses it only when `GET /api/chatbot/status` reports the
  chatbot ready, and otherwise uses the offline demo.
- The dashboard chat keeps its selection-aware behaviour. It is **not** routed
  through the lab service, because that service takes a question and nothing
  else.
- `python -m server.chatbot_check [--ask "..."]` checks configuration,
  reachability and knowledge base, and with `--ask` sends one real question
  through the same code path. Exit status 0 means it worked.

Lab configuration, what must exist on the service side, and the verification
status are in [`docs/CHATBOT_INTEGRATION.md`](docs/CHATBOT_INTEGRATION.md).
**The connection to the real lab service has not been verified live** (see
[Known limitations](#known-limitations)).

## Setup

Needs **Python 3.12+** and **Node.js 18+**.

**Linux / macOS**

```bash
python3 -m venv .venv            # or: uv venv --python 3.13 .venv
.venv/bin/pip install -r server/requirements.txt
npm install

# Build the synthetic datasets: 100k and 1M UMAP, 500k trajectory, 300k multi-organ
# atlas, and the Organ View's heart, brain and liver at 30k cells each
.venv/bin/python -m server.prep --sizes 100000 1000000 --traj-size 500000 --atlas-size 300000 --organ-size 30000

# Terminal 1: backend
.venv/bin/python -m uvicorn server.main:app --port 8000
# Terminal 2: frontend
npm run dev
```

**Windows (PowerShell)**

```powershell
py -3 -m venv .venv_win
.\.venv_win\Scripts\python.exe -m pip install -r server\requirements.txt
npm install

.\.venv_win\Scripts\python.exe -m server.prep --sizes 100000 1000000 --traj-size 500000 --atlas-size 300000 --organ-size 30000

# Terminal 1: backend
.\.venv_win\Scripts\python.exe -m uvicorn server.main:app --port 8000
# Terminal 2: frontend
npm run dev
```

Open <http://localhost:5173>. When 5173 is busy Vite moves to 5174, and that
works just as well, because the page reaches the API through Vite's `/api` proxy
(`API_TARGET`, default `http://localhost:8000`). If the API is not running yet
the page says so and opens by itself once the server answers. Open a specific
dataset with `?dataset=sim1m`. Extra pages: `/bench.html` (capacity sweep),
`/diag.html` (render diagnostics) and `/anatomy.html` (gallery of the organ
models, one colour per segment).

Generated data goes to `data/tiles/` and is git-ignored. For a quick start use
smaller sizes, for example `--sizes 100000 --traj-size 100000 --organ-size 30000`.

## Configuration

The server reads its **process environment only**. It does not load a `.env`
file, so copying `.env.example` to `.env` has no effect by itself. Set the
variables in the shell that starts uvicorn (PowerShell: `$env:NAME = 'value'`;
bash: `export NAME=value`).

| Variable | Used for | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Dashboard chat with Claude. Stays in the server; never sent to the browser. | unset: offline chat |
| `CHAT_MODEL` | Model for the dashboard chat | see `.env.example` |
| `TILES_DIR` | Where the server reads datasets | `data/tiles` |
| `CHATBOT_URL` | Lab ChatBotService base URL, `http://<host>:8101` (not the Ollama address) | unset |
| `CHATBOT_FAMILY` | `doc`, `disease` or `stress` | unset |
| `CHATBOT_ID` | Sample, job or session id that exists on the service | unset |
| `API_TARGET` | Where Vite proxies `/api` | `http://localhost:8000` |
| `VITE_API` | Point the page at a separate API host | same origin |
| `CORS_ORIGINS` | Extra allowed origins (any localhost port is already allowed) | none |
| `PYTHON` | Interpreter Playwright uses to start the API | the venv for your platform |

The three `CHATBOT_*` variables are all-or-nothing. If any is missing or
invalid, the lab integration stays off and the Recipe Maker uses its offline
demo. Without `ANTHROPIC_API_KEY` the dashboard chat uses an offline adapter
that answers from the selection summary; the badge tooltip says which adapter is
live.

## Using it

- **Pan / Box / Lasso** switch the drag mode. Escape cancels a drag in progress.
- **Click** any cell for a pinned card with its id, cell type, tissue, donor,
  stage, pseudotime and coordinates. Moving the pointer does nothing; Escape,
  × or a click on empty space closes the card.
- **Background** (top right) switches between black, white, grey and light
  yellow (solarised). The whole interface follows, and the choice is
  remembered. `?theme=white` pins one from the URL.
- **Legend** works like Plotly's: click a category to hide it, double-click
  (or hover and press *only*) to show only that category, double-click again
  to show everything. Every level is listed and searchable. Filters stay in
  force when you colour by another field, and appear as removable chips.
  Hidden cells cannot be selected or clicked.
- **Trajectory nodes**: click any node of the principal graph to highlight its
  closest nodes. They are numbered by rank and joined by the trajectory between
  them. Choose how many (1–20) and whether distance is measured along the
  trajectory or in the embedding.
- **Inset** opens a foreground panel. *Zoom* shows a magnified region, marked
  on the plot by a dashed rectangle you can drag and resize, with connector
  lines to the panel. *Overview* shows the whole dataset; click it to move
  the main view. *Anatomy* shows the organ figure.
- **Anatomy** shades the body, heart, brain, liver or pancreas by where the
  cells in scope come from: the selection if there is one, otherwise all
  visible cells. Click a region to select its cells; shift-click to add
  regions. Double-click the heart, brain, liver or pancreas in the body to
  open that organ. See [`docs/ADDING_AN_ORGAN.md`](docs/ADDING_AN_ORGAN.md).
- **Zoom to selection** frames the selected region; **Clear** drops the
  selection.
- **Colour by** switches between categorical fields and continuous ones such as
  pseudotime.
- **Auto detail** subsamples when a dataset is larger than the render budget;
  uncheck it to drive the fraction by hand. This is the "lighter version" —
  because the data is stored pre-shuffled, drawing the first K points is an
  unbiased random sample rather than a corner of the plot.
- **Translucent points** trades about 4x the frame time for density shading.
- **Ask about the selection** sends a summary of the selected cells to the chat
  panel.

## Your own data

See [`docs/USING_YOUR_DATA.md`](docs/USING_YOUR_DATA.md) for ordinary datasets.
Both `.h5ad` (scanpy/AnnData) and Parquet are supported:

```bash
.venv/bin/python -m server.prep --h5ad cells.h5ad --id mydata --embedding X_umap
```

### Organ datasets

The Organ View reads two datasets per organ (`organ-<organ>-umap` and
`organ-<organ>-traj`, for heart, brain and liver) that hold the same cells in
the same order. [`docs/ORGAN_DATA.md`](docs/ORGAN_DATA.md) is the full guide:
accepted formats, required columns, cell identifiers and matching rules, the
region values each figure accepts, the directory layout, how to replace the
synthetic data, and the validation rules. A runnable synthetic example is in
[`docs/examples/make_organ_example.py`](docs/examples/make_organ_example.py).

```bash
# check every organ in data/tiles (exit 0 usable, 1 error, 2 bad arguments)
npx vite-node scripts/check-organ-data.ts
npx vite-node scripts/check-organ-data.ts data/tiles heart
# attach a principal graph when ingesting a trajectory
.venv/bin/python -m server.prep --parquet heart_traj.parquet --id organ-heart-traj --id-column cell_id --graph heart_graph.json
```

## Architecture

```
packages/core   pure logic, no DOM and no deck.gl: data, index, select, color, graph, filter,
                inset, anatomy, theme, organ, protocol, chat. Runs in Node and is unit-tested there.
apps/web        deck.gl canvas and views, UI panels, chat panel, anatomy view, Organ View,
                Protocol Creator, benchmark pages
server          FastAPI: tile prep and serving (prep.py, tiles.py), synthetic data (simulate.py,
                organs.py), dashboard chat (chat.py), lab chatbot proxy (chatbot_proxy.py) and
                its checker (chatbot_check.py)
e2e             Playwright specs
scripts         visual-check.mjs (screenshots), check-organ-data.ts (organ data validation)
docs            guides, benchmarks, design notes, screenshots
```

`packages/core` deliberately imports nothing from deck.gl and touches no DOM
API, which is why the selection and geometry logic is unit-testable without a
browser. `apps/web` owns everything visual. The rules the code follows are in
[`CLAUDE.md`](CLAUDE.md): no per-cell objects, opaque non-pickable points,
selection state only in `SelectionStore`, and the API key never reaching the
browser.

### How it holds a million points

- **Every column is a typed array.** There is no per-cell object anywhere. An
  array of a million objects costs more time in allocation and GC than the
  entire render loop.
- **Points are stored pre-shuffled**, so drawing the first K of them is an
  unbiased uniform sample. That is the whole level-of-detail mechanism.
- **Data is chunked at 250,000 points**, and each chunk becomes one deck.gl
  layer fed with binary attributes. A chunk uploads to the GPU once.
- **Selection runs in a Web Worker** against a uniform grid index, so a lasso
  over a million cells does not block panning. The gridded result is asserted to
  equal brute force exactly.
- **The chat context is a summary, not rows.** The token cost of a question does
  not scale with the size of the lasso.
- **Points are drawn opaque.** Blending is the most expensive thing a scatter
  plot of this size can ask a tile-based GPU to do.

Measured capacity on an Apple M4 is in
[`docs/benchmarks/2026-09-07-capacity.md`](docs/benchmarks/2026-09-07-capacity.md):

| points | load | lasso | fps | heap |
|---:|---:|---:|---:|---:|
| 500,000 | 17 ms | 11 ms | 60.7 | 26 MB |
| 1,000,000 | 44 ms | 27 ms | 30.7 | 54 MB |
| 10,000,000 | 628 ms | 363 ms | 5.0 | 964 MB |

Rendering is the wall, and it starts at about two million points. The
level-of-detail budget caps drawn points at 1,000,000 by default. Selection,
metadata and the chat context always use every loaded cell.

## Tests

```bash
npx tsc --noEmit                    # types, must be 0 errors
npx vitest run                      # core unit tests, Node only
.venv/bin/python -m pytest -q       # server tests
npx playwright test                 # end to end with software WebGL; starts both servers
node scripts/visual-check.mjs       # screenshots of every theme and feature -> test-results/visual/
npx playwright test --config=bench.config.ts   # capacity sweep (headed, needs a GPU)
```

On Windows use `.\.venv_win\Scripts\python.exe -m pytest -q` for the server
tests. Playwright starts the API with `$PYTHON` if set, otherwise the venv for
your platform, and reuses servers already running on ports 8000 and 5173.
Dedicated specs: `e2e/organ.spec.ts` (Organ View), `e2e/protocol.spec.ts`
(Protocol Creator), `e2e/chatbot-ui.spec.ts` (Recipe Maker with mocked server
responses) and `e2e/memory.spec.ts` (teardown leaks).

**Latest verified results** (Windows 11, Intel Core i5-13500H, headless Chromium
with software WebGL, 2026-11-08):

| Check | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| Vitest | 565 passed (29 files) |
| pytest | 438 passed, 1 failed |
| Playwright | 73 passed of 73 (27.7 min) |

The one pytest failure is `test_cell_route.py::test_a_regenerated_dataset_is_picked_up`,
a Windows file-locking `PermissionError` that also occurs on the pre-change
baseline. Two Playwright tests (`feedback.spec.ts` "opens a zoom inset" and
`viewer.spec.ts` "selecting on the trajectory") have been intermittently slow or
unstable under software WebGL; both passed in this run.

## Repository contents

Not committed, by design: virtual environments, `node_modules`, generated
datasets (`data/tiles/`, rebuilt with `server.prep`), build output, test
artefacts, local environment files and local tool state. Private project
correspondence and feedback documents are also left out. `.env.example` is
committed and holds names only, never values.

## Known limitations

- **The live lab chatbot connection is unverified.** The proxy, the adapter, the
  checker and the Recipe Maker's behaviour are tested against a mocked upstream
  and against an unreachable port. No request has reached the real ChatBotService
  or the lab's Ollama server, which were not reachable from the development
  machine. Only `python -m server.chatbot_check --ask "..."` run on a machine
  with access, a service address and an existing knowledge-base id proves it. See
  [`docs/CHATBOT_INTEGRATION.md`](docs/CHATBOT_INTEGRATION.md).
- **Organ and protocol data are synthetic.** Both the Organ View datasets and
  the Protocol Creator's tree, factors and recipes are placeholders, labelled as
  such. Real organ data must follow [`docs/ORGAN_DATA.md`](docs/ORGAN_DATA.md).
- The Organ View covers heart, brain and liver only; the dataset ids are fixed.
- The dashboard chat is not routed through the lab chatbot service.
- Performance numbers were measured on an Apple M4 GPU (capacity table) or with
  software WebGL (test timings), not on lab hardware.
- A small heap growth of about 0.45 MB per view rebuild remains inside deck.gl.
- The project has no `LICENSE` file yet; the repository owner has to choose one.
