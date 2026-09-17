# Single-cell embedding and trajectory viewer

Renders millions of single cells from a 2D embedding, lets you select a region
by box or lasso, zoom into it, and ask a chatbot questions about exactly the
cells you selected.

Two displays share one engine:

- **Embedding view** — a UMAP or t-SNE scatter plot, one dot per cell, coloured
  by cell type, tissue, donor or developmental stage. The reference point is
  Figure 1 of *Nicheformer* (Nature Methods 22:2525–2538, 2025), whose UMAP
  panel plots 1,108,759 cells.
- **Trajectory view** — the same point cloud coloured by pseudotime, with a
  monocle3-style principal graph drawn over it: root marker, branch points,
  leaves, and the lineage paths between them.

Both support box and lasso region selection, zoom-to-region, per-cell metadata
on hover, level-of-detail subsampling, and handing the selected subset to a chat
panel.

## Quick start

```bash
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt
npm install

# Build the synthetic datasets (100k UMAP, 1M UMAP, 500k trajectory)
.venv/bin/python -m server.prep --sizes 100000 1000000 --traj-size 500000

# Terminal 1
.venv/bin/python -m uvicorn server.main:app --port 8000
# Terminal 2
npm run dev
```

Open <http://localhost:5173>. Open a specific dataset directly with
`?dataset=sim1m`. Two measurement pages ship alongside it:

- <http://localhost:5173/bench.html> — capacity sweep across 100k to 10M
- <http://localhost:5173/diag.html> — render diagnostics, which configuration
  costs what

## Using it

- **Pan / Box / Lasso** switch the drag mode. Escape cancels a drag in progress.
- **Hover** any cell for its id, cell type, tissue, donor, stage, pseudotime and
  coordinates.
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

### Connecting a real model

Export `ANTHROPIC_API_KEY` in the **server's** environment and restart it:

```bash
ANTHROPIC_API_KEY=... .venv/bin/python -m uvicorn server.main:app --port 8000
```

Without a key the chat panel falls back to an offline adapter that answers from
the selection summary; the badge tooltip says which adapter is live. The key
lives only in the server process — it is never sent to, stored in, or bundled
into the browser.

## How it holds a million points

- **Every column is a typed array.** There is no per-cell object anywhere. An
  array of a million objects costs more time in allocation and GC than the
  entire render loop, and it is the single mistake that caps most scatter plots
  at a hundred thousand points.
- **Points are stored pre-shuffled**, so drawing the first K of them is an
  unbiased uniform sample. That is the whole level-of-detail mechanism, and it
  is also the "lighter version" switch — same code path, no separate mode.
- **Data is chunked at 250,000 points**, and each chunk becomes one deck.gl
  layer fed with binary attributes. A chunk uploads to the GPU once, on
  arrival; later chunks never force it to be re-uploaded.
- **Selection runs in a Web Worker** against a uniform CSR grid index, so a
  lasso over a million cells does not block panning. The gridded result is
  asserted to be exactly equal to brute force, not approximately.
- **The chat context is a summary, not rows.** A selection of 500,000 cells and
  one of 12 produce a context of nearly the same size, so the token cost of a
  question does not scale with the size of the lasso.
- **Points are drawn opaque.** Blending is the most expensive thing a scatter
  plot of this size can ask a tile-based GPU to do; the selection highlight is
  built so it is not needed.

Measured capacity on an Apple M4 is in
[`docs/benchmarks/2026-09-07-capacity.md`](docs/benchmarks/2026-09-07-capacity.md).
The short version:

| points | load | lasso | fps | heap |
|---:|---:|---:|---:|---:|
| 500,000 | 17 ms | 11 ms | 60.7 | 26 MB |
| 1,000,000 | 44 ms | 27 ms | 30.7 | 54 MB |
| 10,000,000 | 628 ms | 363 ms | 5.0 | 964 MB |

The server is nowhere near the constraint — ten million cells transfer and
decode in about a quarter of a second. **Rendering is the wall, and it starts at
about two million.**

The single biggest factor turned out to be alpha blending: at one million
points, turning it off took the frame rate from 12.0 to 38.0 with everything
else held constant, because Apple Silicon is a tile-based GPU and blending a
million overlapping points defeats its hidden-surface removal. Points are
therefore drawn opaque, and the selection highlight dims unselected cells by
darkening their colour rather than by lowering alpha. Translucency is still
available as a toggle, since it does show density — it just costs about 3x.

The level-of-detail budget caps drawn points at **1,000,000** by default, tuned
to that measurement. Selection, metadata and the chat context always use every
loaded cell, never the drawn subsample.

## Your own data

See [`docs/USING_YOUR_DATA.md`](docs/USING_YOUR_DATA.md). Both `.h5ad`
(scanpy/AnnData) and Parquet are supported:

```bash
.venv/bin/python -m server.prep --h5ad cells.h5ad --id mydata --embedding X_umap
```

## Tests

```bash
npx vitest run                      # core logic: 107 tests, no browser needed
.venv/bin/python -m pytest          # server: 90 tests
npx tsc --noEmit                    # types
npx playwright test                 # end to end: 14 tests, real WebGL
npx playwright test --config=bench.config.ts   # capacity sweep + render diagnostics (headed, needs a GPU)
```

## Layout

```
packages/core   data, geometry, selection, colour, context — no DOM, runs in Node
apps/web        deck.gl rendering, interaction, UI, chat panel, benchmark page
server          FastAPI: tile prep, tile serving, chat proxy
docs            design spec, implementation plan, benchmarks
```

`packages/core` deliberately imports nothing from deck.gl and touches no DOM
API, which is why the selection and geometry logic is unit-testable without a
browser. `apps/web` owns everything visual.
