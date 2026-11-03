# Cell Viewer

A GPU-accelerated scatter plot for single-cell embeddings (UMAP, t-SNE) and
developmental trajectories, built to stay interactive with one to ten million
cells in the browser.

Pan and zoom the whole dataset, select cells with a box or a lasso, filter by
category from the legend, inspect a single cell, compare a magnified region
against the full plot, link the selection to an anatomical figure, and ask a
chat assistant questions about exactly the cells you selected.

> **New here?** The illustrated guide in [`docs/cell-viewer-guide.pdf`](docs/cell-viewer-guide.pdf) explains every part of the screen with labeled screenshots, how the code works, and how to change it, in plain English.

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using the viewer](#using-the-viewer)
- [Loading your own data](#loading-your-own-data)
- [Chat assistant](#chat-assistant)
- [Adding an organ](#adding-an-organ)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Deployment](#deployment)
- [Performance](#performance)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

## Features

- **Two displays on one engine.** The *embedding view* shows one dot per cell,
  colored by cell type, tissue, donor, stage or any other field. The
  *trajectory view* colors the same point cloud by pseudotime and draws a
  monocle3-style principal graph over it, with the root, branch points, leaves
  and the lineage paths between them.
- **Region selection.** Box and lasso selection run in a Web Worker against a
  grid index, so selecting over a million cells never blocks panning. Results
  are exactly equal to a brute-force scan.
- **Click to inspect.** Click any cell for a pinned card with its id, source
  row, annotations and coordinates. There is no hover tooltip.
- **Legend filter.** Works like Plotly's legend: click to hide a category,
  double-click to isolate one, search long lists, and keep filters active while
  you recolor.
- **Trajectory neighbors.** Click a node of the principal graph to highlight
  its closest nodes, measured along the trajectory or in the embedding.
- **Foreground inset.** A floating panel that shows a magnified region with
  connector lines to its origin, a whole-dataset overview, the anatomy figure,
  or an image you supply.
- **Segmented anatomy.** Body, heart, brain, liver and pancreas figures shaded
  by where the cells in scope come from, linked to the selection in both
  directions. Organs are data, so adding one is a single file.
- **Four background themes.** Black, white, grey and light yellow. The whole
  interface follows, and the choice is remembered.
- **Level of detail.** Datasets larger than the render budget are drawn as an
  unbiased random subsample, while selection, metadata and the chat context
  always use every loaded cell.
- **Chat about the selection.** Sends a statistical summary of the selected
  cells, never raw rows, to a Claude-backed assistant. An offline adapter takes
  over when no API key is set.
- **Bring your own data.** Ingest `.h5ad` (scanpy/AnnData) or Parquet files
  with one command.

## Requirements

| Tool | Version | Used for |
|---|---|---|
| Node.js | 18 or newer | Vite dev server and production build |
| Python | 3.12 or newer | Tile preparation and the API server |
| Browser | Any with WebGL 2 | Rendering (deck.gl 9) |

## Quick start

```bash
# 1. Install dependencies
python3 -m venv .venv                          # or: uv venv --python 3.13 .venv
.venv/bin/pip install -r server/requirements.txt
npm install

# 2. Generate the synthetic datasets (100k and 1M UMAP, 500k trajectory,
#    300k multi-organ atlas)
.venv/bin/python -m server.prep --sizes 100000 1000000 --traj-size 500000 --atlas-size 300000

# 3. Start the API (terminal 1)
.venv/bin/python -m uvicorn server.main:app --port 8000 --env-file .env

# 4. Start the web app (terminal 2)
npm run dev
```

Open <http://localhost:5173>. When 5173 is busy Vite moves to the next port, and
that works just as well, because the page reaches the API through Vite's `/api`
proxy. If the API is not running yet, the page says so and opens by itself
once the server answers.

Open a specific dataset with `?dataset=sim1m`, or pin a theme with
`?theme=white`. The anatomy gallery, a page showing every organ model with one
color per segment, is at <http://localhost:5173/anatomy.html>.

The generated datasets are:

| Id | Cells | Kind | Fields |
|---|---:|---|---|
| `sim100k` | 100,000 | embedding | cell_type, tissue, donor, stage, pseudotime |
| `sim1m` | 1,000,000 | embedding | cell_type, tissue, donor, stage, pseudotime |
| `traj500k` | 500,000 | trajectory | cell_type, tissue, donor, stage, pseudotime, principal graph |
| `atlas300k` | 300,000 | embedding | cell_type, tissue, anatomical_region, donor, stage, pseudotime |

## Using the viewer

### Navigation and selection

| Control | What it does |
|---|---|
| **Pan** | Drag to pan, scroll to zoom. |
| **Box** / **Lasso** | Drag to select a rectangle or a freehand region. Press `Esc` to cancel a drag in progress. |
| **Zoom to selection** | Frames the selected region. |
| **Clear** | Drops the selection. |
| **Reset view** | Returns to the full extent of the data. |
| **Click** a cell | Opens a pinned card with its id, source row, annotations and coordinates. `Esc`, the close button, or a click on empty space dismisses it. |

The details card appears only on click and stays where you put it while the
pointer moves. Cells hidden by a legend filter can be neither selected nor
clicked.

### Legend and filters

The legend lists every level of the field you color by, with its cell count.

- **Click** a category to hide or show it.
- **Double-click** a category (or press *only* on hover) to show just that
  category. Double-click again to show everything.
- **Show all** and **Hide all** act on the whole list, and a search box appears
  once the list is long.
- Filters stay in force when you color by another field and appear as removable
  chips, so "only T cells, colored by tissue" works.

### Coloring

**Color by** switches between categorical fields and continuous ones such as
pseudotime. Continuous fields use a color ramp (viridis by default), and categorical
palettes adapt to the active background so every color stays legible.

### Trajectory view

Open a trajectory dataset from the view switcher in the top bar. Click any node
of the principal graph to highlight the nodes closest to it. They are numbered
by rank and joined by the trajectory between them.

- **Closest nodes** sets how many to highlight (1 to 20).
- **Distance measured** chooses *along trajectory* (the sum of edge lengths) or
  *in embedding* (straight-line distance).
- **Show trajectory** toggles the graph, and **Label root and branches** adds
  labels to it.

### Inset

**Inset** in the toolbar opens a floating panel with four modes:

- **Zoom** shows a magnified region, marked on the plot by a dashed rectangle
  you can drag and resize, with connector lines joining the mark to the panel.
- **Overview** shows the whole dataset with the main viewport outlined. Click or
  drag in it to move the main view.
- **Anatomy** hosts the segmented organ figure.
- **Image** shows a picture you pick or drop onto the panel, such as a
  histology section. It stays in the page and is never uploaded.

### Anatomy

The anatomy panel shades the body, heart, brain, liver or pancreas by where the
cells in scope come from: the selection if there is one, otherwise all visible
cells.

- Click a region to select its cells. Shift-click to add more regions.
- Double-click the heart, brain, liver or pancreas in the body figure to open
  that organ. A breadcrumb leads back out.
- The **Region field** selector overrides the automatic choice of which
  annotation field to match against the organ's regions.
- **Show in plot** opens a copy of the figure in the inset over the plot, on the
  same organ and field. **Clear region selection** drops a selection made by
  clicking regions.

### Themes

The **Background** picker in the top right switches between black, white, grey
and light yellow. The choice is stored in the browser, and `?theme=white`,
`grey`, `yellow` or `black` overrides it for a single link.

### Level of detail

**Auto detail** subsamples when a dataset is larger than the render budget
(one million points by default). Untick it to set the fraction by hand with the
slider. Data is stored pre-shuffled, so drawing the first *K* points is an
unbiased random sample rather than a corner of the plot. **Translucent points**
turns on alpha blending to show density, at about four times the frame cost.

## Loading your own data

The viewer never computes a dimensionality reduction. It consumes coordinates
you have already produced with UMAP, t-SNE or anything else, plus the per-cell
annotations you want to color and select by.

### From an `.h5ad` file (scanpy / AnnData)

```bash
.venv/bin/python -m server.prep --h5ad path/to/cells.h5ad --id mydata --embedding X_umap
```

- `--embedding` names a key in `adata.obsm` holding an `(n, 2)` array. `X_umap`
  and `X_tsne` are the usual ones. A 50-column `X_pca` is rejected with the
  available keys listed in the error; slice it to two columns or compute a 2D
  embedding first.
- Categorical columns in `adata.obs` become color-by fields. Numeric columns
  become continuous fields, and a column named `pseudotime` is what the
  trajectory view colors by.
- Cell names (`adata.obs_names`, usually barcodes) are kept as cell ids along
  with each cell's row number, so a clicked cell can be found again in your
  AnnData.

### From Parquet

```bash
.venv/bin/python -m server.prep --parquet path/to/cells.parquet --id mydata
```

The file needs `x` and `y` columns. A column named `cell_id`, `barcode` or
`obs_names` (the first one present, in that order) supplies the cell ids and is
not treated as a field. Name a different one with `--id-column`. Every other
column is classified as categorical or numeric by dtype.

### Choosing columns and what prep fixes for you

- `--obs-fields cell_type,tissue` and `--numeric-fields pseudotime` choose
  exactly which columns to keep, comma or space separated.
- When columns are auto-detected, a text column with more than 65,535 distinct
  values (such as a join id) is skipped with a warning. A column you name
  explicitly fails loudly instead, because a wrapped 16-bit code would color the
  plot with plausible-looking nonsense.
- Field names are made URL-safe: `percent.mt` becomes `percent_mt` and
  `cell type` becomes `cell_type`, with `_2` added on a clash. The renames are
  printed.
- Cells with a missing or infinite coordinate are dropped, and the count is
  printed. Missing numeric values are kept, and color ranges are computed over
  finite values only.
- Dataset ids may contain letters, digits, `_` and `-`, up to 64 characters.
- Rewriting a dataset removes the fields and chunks it no longer has. Its
  manifest `version` changes whenever any byte does, so browsers never mix
  cached chunks from two versions.

No server restart is needed: it lists whatever is in the tiles directory, so the
new dataset appears in the switcher on the next page load. Open it directly with
`http://localhost:5173/?dataset=mydata`.

### Trajectories

A principal graph is a JSON file next to the dataset's tiles:

```json
{
  "nodes": [[x, y], ...],
  "edges": [[i, j], ...],
  "root": 17,
  "branchPoints": [17, 42, 88],
  "leaves": [3, 9, 55]
}
```

To attach a graph exported from monocle3, save it as
`data/tiles/<id>/graph.json` and set `"hasGraph": true` in that dataset's
`manifest.json`. The viewer merges the edge list into polylines itself, so edges
can be in any order.

### Anatomy matching

The anatomy panel matches categorical levels to organ regions by name.

- **Body:** a field such as `tissue` or `organ` with values like `lung`, `liver`
  or `peripheral blood`.
- **Heart, brain, liver, pancreas:** a field such as `anatomical_region` with
  values like `left ventricle`, `hippocampus`, `liver: caudate lobe` or
  `pancreas: tail`.

Matching ignores case, punctuation, underscores and accents, and understands
`organ: region` qualifiers and simple plurals.

### Preparation options

```text
python -m server.prep [--out DIR] [--chunk-size N] [--seed N]
                      [--sizes N [N ...]] [--traj-size N] [--atlas-size N]
                      [--h5ad FILE | --parquet FILE] [--id ID] [--embedding KEY]
                      [--obs-fields F [F ...]] [--numeric-fields F [F ...]]
                      [--id-column COLUMN]
```

| Option | Default | Meaning |
|---|---|---|
| `--out` | `data/tiles` | Output directory for tiles. |
| `--chunk-size` | `250000` | Points per chunk. Smaller chunks fill in more smoothly on a slow connection, larger ones mean fewer requests. |
| `--seed` | `0` | Seed for the shuffle and the synthetic generators. |
| `--sizes` | `100000 1000000` | Synthetic embedding sizes to generate. |
| `--traj-size` | `500000` | Synthetic trajectory size. |
| `--atlas-size` | `0` | Synthetic multi-organ atlas size. `0` skips it. |
| `--h5ad`, `--parquet` | none | Ingest a file instead of simulating. |
| `--id` | none | Dataset id for an ingested file. |
| `--embedding` | `X_umap` | Key in `adata.obsm` for `.h5ad` input. |

### What the browser downloads

Color is derived in the browser, not transferred. Per million cells with four
categorical fields and one numeric field:

| Column | Bytes |
|---|---:|
| Coordinates (`float32` x 2) | 8 MB |
| Four categorical codes (`uint16`) | 8 MB |
| One numeric field (`float32`) | 4 MB |
| **Total** | **20 MB** |

## Chat assistant

The chat panel sends a statistical summary of the selected cells (counts,
breakdowns by field, distributions of continuous values) together with your
question, and streams the answer back. The summary is capped at 32 KB, so a
selection of 500,000 cells and one of 12 cost nearly the same to ask about.

To connect a model, set the key in the **server's** environment:

```bash
ANTHROPIC_API_KEY=sk-ant-... .venv/bin/python -m uvicorn server.main:app --port 8000
```

or put it in `.env` and start the server with `--env-file .env`. Without a key
the panel falls back to an offline adapter that answers from the summary alone,
and the badge tooltip says which adapter is live.

The key is read only by the server process. It is never sent to, stored in or
bundled into the browser, and the browser talks only to `/api/chat`.

## Adding an organ

Organs are data. The viewer ships five (body, heart, brain, liver, pancreas),
and adding another takes one model file and one registry line. No view,
matching, statistics or selection code changes.

**1. Write the model** at `packages/core/src/anatomy/models/kidney.ts`:

```ts
import type { OrganModel } from '../types';

export const kidney: OrganModel = {
  id: 'kidney',
  label: 'Kidney',
  view: 'coronal section',
  viewBox: [0, 0, 200, 240],
  // Fields to prefer when several match equally well.
  fieldHints: ['anatomical_region', 'region', 'kidney_region'],
  // Names of the organ itself. Needed whenever a region name also exists in
  // another organ, since the brainstem has a medulla too.
  organAliases: ['kidney', 'renal'],
  segments: [
    {
      id: 'cortex',
      label: 'Renal cortex',
      aliases: ['cortex', 'renal cortex', 'kidney cortex'],
      path: 'M...Z'
    },
    { id: 'medulla', label: 'Renal medulla', aliases: ['medulla', 'renal pyramid'], path: 'M...Z' },
    { id: 'pelvis', label: 'Renal pelvis', aliases: ['renal pelvis', 'pelvis'], path: 'M...Z' }
  ],
  decor: [{ kind: 'vessel', path: 'M...' }]
};
```

| Field | Meaning |
|---|---|
| `organAliases` | Names of the organ as a whole (`kidney`, `renal`), not of its regions. Set it on every single-organ model. A qualified label such as `brain: medulla` reaches a region only when the qualifier is one of these names, and the panel uses them to find the field that says which cells come from this organ. Leave it out only for a model of no single organ, like the whole body. |
| `segments[].path` | SVG path data inside the `viewBox`. Several subpaths are fine. |
| `segments[].aliases` | Dataset labels that mean this region. |
| `segments[].deep` | A structure seen through the surface, such as the hippocampus. Drawn dashed, on top, and allowed to overlap other segments. |
| `segments[].drillDown` | Set on a body segment to open another organ on double-click. |
| `decor` | Outlines, vessels and surface details. Never clickable and never counted. |

Colors never go in the model. The view applies the theme and the heat scale.

**2. Register it** in `packages/core/src/anatomy/models/index.ts` by importing
the model and appending it to `BUILTIN_MODELS`. To make the body figure open it,
set `drillDown: 'kidney'` on the body's `kidney` segment.

**3. Check it** by opening <http://localhost:5173/anatomy.html>, where each
segment is drawn in its own color so gaps and mislabeled regions are obvious.
Registration rejects a model with no segments, duplicate segment ids, an alias
claimed by two segments, malformed path data and paths outside the `viewBox`.

A dataset lights up the organ when one of its categorical fields has levels
matching the aliases, typically an `anatomical_region` or `region` column.
`server/simulate.py` shows how the synthetic atlas annotates heart chambers,
brain regions, liver lobes and pancreas parts.

## Configuration

### Server environment variables

Set these in the shell or in `.env` (start the server with `--env-file .env`).

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Enables the chat assistant. Server-side only. |
| `CHAT_MODEL` | `claude-sonnet-5` | Model used for chat requests. |
| `TILES_DIR` | `data/tiles` | Directory holding the generated datasets. |
| `CORS_ORIGINS` | unset | Comma-separated extra origins allowed by CORS. Any localhost port is always allowed. |

### Web environment variables

| Variable | Default | Meaning |
|---|---|---|
| `API_TARGET` | `http://localhost:8000` | Where the Vite dev server proxies `/api`. |
| `VITE_API` | empty (same origin) | Point the built page at a separate API host instead. |

## HTTP API

All routes live under `/api`. Dataset ids and field names are validated against
`[A-Za-z0-9_-]{1,64}` before they touch the filesystem.

| Method and path | Returns |
|---|---|
| `GET /api/datasets` | `{"datasets": [ids]}` for every directory in the tiles folder. |
| `GET /api/dataset/{id}/manifest` | Dataset metadata: cell count, chunking, bounds, fields and levels, ranges, `version`. |
| `GET /api/dataset/{id}/graph` | The principal graph JSON. `404` when the dataset has none. |
| `GET /api/dataset/{id}/cell/{index}?v=` | The cell's source row and id. `409` when `v` no longer matches the manifest version. |
| `GET /api/dataset/{id}/chunk/xy/{chunk}` | Binary `float32` coordinate pairs. |
| `GET /api/dataset/{id}/chunk/codes/{field}/{chunk}` | Binary `uint16` category codes. |
| `GET /api/dataset/{id}/chunk/num/{field}/{chunk}` | Binary `float32` values. |
| `GET /api/chat/status` | `{"configured": bool, "model": str}`. |
| `POST /api/chat` | Server-sent events streaming `{"text": ...}` frames, then `[DONE]`. |

Chunks are served with `Cache-Control: public, max-age=31536000, immutable`.
That is safe because the page requests them as `...?v=<manifest version>`, and
the version changes whenever the bytes do.

## Deployment

The production build is a static bundle that the API server can serve itself, so
one process on one origin is a complete deployment.

```bash
npm run build                                   # writes dist/
.venv/bin/python -m server.prep --out data/tiles ...   # or copy prepared tiles in
.venv/bin/python -m uvicorn server.main:app --host 0.0.0.0 --port 8000 --env-file .env
```

When `dist/` exists, FastAPI mounts it at `/` after the API routes, so the page
and the API share an origin and no CORS configuration is needed. Notes:

- Put a reverse proxy such as nginx or Caddy in front for TLS. Disable response
  buffering for `/api/chat` so streamed answers arrive as they are produced.
- Tiles are plain files, so `data/tiles` can live on a mounted volume. Point
  `TILES_DIR` at it.
- Serving the page from a different origin than the API needs `VITE_API` at
  build time and the page's origin in `CORS_ORIGINS`.
- Keep `.env` out of version control. It is already in `.gitignore`.

## Performance

Measured on an Apple M4 through ANGLE/Metal, Chromium headed, with a canvas of
about 1440 x 420 pixels and a three-second scripted pan. `lasso` is a 60-vertex polygon over the
whole dataset.

| Points | Load | fps | Lasso | Heap |
|---:|---:|---:|---:|---:|
| 100,000 | 21 ms | 59.3 | 1.8 ms | 14 MB |
| 500,000 | 17 ms | 60.7 | 11 ms | 26 MB |
| 1,000,000 | 44 ms | 30.7 | 27 ms | 54 MB |
| 2,000,000 | 63 ms | 18.0 | 55 ms | 102 MB |
| 5,000,000 | 146 ms | 6.7 | 289 ms | 462 MB |
| 10,000,000 | 628 ms | 5.0 | 363 ms | 964 MB |

The server is not the constraint: ten million cells transfer and decode in under
a second. Rendering is the limit, and it starts at about two million points. The
default budget of one million drawn points keeps panning smooth, and the detail
slider lowers it for weaker GPUs.

### Design decisions behind these numbers

- **Every column is a typed array.** There is no per-cell object anywhere. An
  array of a million objects costs more in allocation and garbage collection
  than the whole render loop.
- **Points are drawn opaque.** Alpha blending a million overlapping points
  defeats the hidden-surface removal of tile-based GPUs. Turning it off took one
  million points from 12.0 to 38.0 fps in isolation. Selection therefore dims
  cells by blending their color toward the background instead of lowering alpha,
  and filtered-out cells are culled in the vertex shader.
- **Data is stored pre-shuffled and chunked at 250,000 points.** The first *K*
  points are an unbiased sample, which is the whole level-of-detail mechanism.
  Each chunk becomes one deck.gl layer fed with binary attributes and uploads to
  the GPU once, on arrival.
- **Point layers are not pickable.** A picking pass would re-render every point
  on every pointer move. Clicks are answered by the selection worker's grid
  index instead.
- **Selection runs in a Web Worker** against a uniform CSR grid, and the result
  is asserted to equal a brute-force scan exactly.
- **The chat context is a summary, not rows**, so token cost does not scale with
  the size of the selection.

## Architecture

```text
Browser                                                  Server (FastAPI)
+--------------------------------------------+          +-------------------------+
| apps/web: deck.gl canvas, panels, inset,   |  /api    | tiles.py   binary chunks|
|           anatomy view, chat panel         |<-------->| chat.py    Claude proxy |
|                    |                       |          | main.py    app + static |
| packages/core: data, index, select, color, |          +------------+------------+
|   filter, graph, inset, anatomy, theme     |                       |
|   (no DOM, no deck.gl; runs in Node)       |          data/tiles/<id>/  chunks, manifest
+--------------------------------------------+          ^
                                                        | server/prep.py, simulate.py
```

```text
apps/web/                  Browser application (Vite, TypeScript, deck.gl)
  index.html               Main page
  anatomy.html             Organ gallery page
  src/
    main.ts                Startup, dataset switcher, wiring
    views/                 Scatter canvas, embedding view, trajectory view, graph layers
    ui/                    Legend, toolbar, info card, theme picker, level-of-detail controls
    anatomy/               Anatomy panel, figure renderer, gallery
    inset/                 Foreground inset controller
    interact/              Click and lasso/box capture
    chat/                  Chat panel and the Claude-backed adapter
    theme.ts               Theme persistence and CSS custom properties
packages/core/src/         Pure logic, importable from Node
  data/                    Manifest, loader, column store
  index/                   Grid index
  select/                  Region and nearest-point queries, worker, selection store
  color/                   Palettes, recoloring, default fields
  filter/                  Category filter state
  graph/                   Principal-graph paths, neighbors, labels
  inset/                   Inset geometry
  anatomy/                 Organ models, registry, matcher, path parser, statistics
  theme/                   Theme definitions
  render/                  Level-of-detail policy
  context/                 Selection summary for chat
  chat/                    Adapter interface and offline mock
server/
  main.py                  App factory, CORS, static serving
  tiles.py                 Dataset and chunk routes
  chat.py                  Chat proxy and request shaping
  prep.py                  Tiling and ingestion (CLI)
  simulate.py              Synthetic dataset generators
  names.py                 Validation for ids and field names
data/tiles/                Generated datasets (git-ignored)
docs/                      Illustrated guide (PDF)
```

`packages/core` imports nothing from deck.gl and touches no DOM API, which is
why selection and geometry logic runs in Node. `apps/web` owns everything
visual.

## Development

```bash
npm run dev          # Vite dev server on :5173 with the /api proxy
npm run typecheck    # tsc --noEmit
npm run build        # typecheck, then build to dist/
npm run preview      # serve the production build locally
```

Run the API alongside it with `uvicorn server.main:app --reload --port 8000`.
Generated tiles live in `data/tiles/` and are git-ignored.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The page says the data server is not running. | Start the API (step 3 of the quick start). The page reconnects by itself. |
| "No dataset named ..." on the status line. | The `?dataset=` id does not exist. The message lists the ones that do. |
| The dataset list is empty. | No tiles yet. Run `server.prep`, and check `TILES_DIR`. |
| `--embedding` is rejected for an `.h5ad`. | The `obsm` key is not two-dimensional. Pick `X_umap`, `X_tsne`, or a 2-column slice. |
| A column is skipped or rejected during prep. | It has more than 65,535 distinct values. Drop it or bin it. |
| The plot is slow at several million points. | Keep **Auto detail** on, or lower the fraction. Rendering, not data transfer, is the limit. |
| Chat answers from the selection summary only. | No `ANTHROPIC_API_KEY` is set, so the offline adapter is active. |
| A blank canvas. | The browser has no WebGL 2 support or it is disabled. |
