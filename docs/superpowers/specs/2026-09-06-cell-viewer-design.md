# Single-Cell Embedding & Trajectory Viewer — Design

Date: 2026-09-06
Status: Approved for planning

## 1. Purpose

A browser-based viewer for single-cell 2D embeddings at a scale that matches
real published datasets. The reference point is Figure 1 of *Nicheformer: a
foundation model for single-cell and spatial omics* (Nature Methods 22:2525–2538,
2025), whose UMAP panel plots n = 1,108,759 cells coloured by modality, organ and
species.

Two displays are required:

1. **Embedding view** — a UMAP/t-SNE scatter plot. Each dot is one cell. The cell
   originally carries a high-dimensional feature vector (order 20,000 genes); the
   viewer only ever receives the 2D projection plus per-cell metadata
   (cell type, tissue, donor, developmental stage).
2. **Trajectory view** — the same point cloud coloured by pseudotime, with a
   monocle3-style principal graph drawn over it, showing developmental ordering.

Both displays must support region selection, zoom-to-region, and handing the
selected subset to a chatbot so a user can ask questions about exactly those
cells.

A secondary, explicit goal: **find the capacity ceiling.** Determine empirically
how many points the browser and the server can sustain, so that subsampling is a
deliberate fallback rather than a permanent crutch.

## 2. Non-goals

- No dimensionality reduction in the browser. UMAP/t-SNE are computed upstream;
  the viewer consumes coordinates.
- No differential expression or other analysis in v1. The server retains a handle
  on the full matrix so this can be added, but it is not built here.
- No user accounts, persistence, or multi-user state.

## 3. Technology decisions

| Concern | Decision | Reason |
|---|---|---|
| Renderer | deck.gl `ScatterplotLayer` on an `OrthographicView` | Proven past 10M points, binary-attribute path avoids per-point JS, ships PathLayer for the trajectory graph and picking for hover |
| Language (client) | TypeScript, bundled by Vite | Typed-array and GPU-buffer code is where off-by-one errors hide; `tsc` catches them. Emits plain JS. |
| Backend | Python + FastAPI | Matches the scanpy/anndata ecosystem the real data lives in; serves binary chunks and proxies the chat call |
| Data at rest | Pre-shuffled binary chunks (`Float32Array`, `Uint16Array`) + JSON sidecars | Zero parse cost beyond `new Float32Array(buf)` |
| Chat | Adapter interface; Claude via server proxy, plus an offline mock | Keeps the API key out of the browser bundle |

## 4. Architecture

```
IP/
  packages/core/                 framework-free, testable, no DOM
    data/schema.ts               CellStore: columnar typed-array container
    data/loader.ts               chunked binary fetch -> CellStore
    index/grid.ts                uniform spatial grid over xy
    select/geometry.ts           point-in-polygon, point-in-rect
    select/worker.ts             Web Worker: runs selection off main thread
    select/store.ts              SelectionStore: state + subscriber bus
    color/palette.ts             categorical palettes + continuous ramps
    color/recolor.ts             code array -> RGBA Uint8Array
    context/build.ts             Selection -> SelectionContext summary
  apps/web/
    views/ScatterCanvas.ts       shared deck.gl canvas (both views use it)
    views/ScatterView.ts         embedding view wiring
    views/TrajectoryView.ts      + principal-graph overlay
    ui/                          Legend, ColorByPicker, LodControl,
                                 SelectionSummary, Toolbar
    chat/adapter.ts              ChatAdapter interface + SelectionContext type
    chat/claude.ts               POST /api/chat adapter
    chat/mock.ts                 offline deterministic adapter
    chat/ChatPanel.ts            UI, subscribes to SelectionStore
    bench/                       capacity harness page
  server/
    main.py                      FastAPI app
    tiles.py                     /api/manifest, /api/chunk
    chat.py                      /api/chat -> Anthropic
    prep.py                      h5ad|parquet -> tiles
    simulate.py                  synthetic generator at arbitrary N
  data/tiles/<dataset>/          generated artifacts
  docs/superpowers/specs/
```

`packages/core` has no DOM and no deck.gl dependency. It is pure data + geometry,
so it is unit-testable in Node without a browser. `apps/web` owns everything
visual. This boundary is the main structural commitment of the design.

## 5. Data model

Columnar. No array of per-cell objects is ever constructed — that single mistake
is what caps most viewers at ~100k points.

```ts
interface CellStore {
  n: number;
  xy: Float32Array;            // length 2n, interleaved [x0,y0,x1,y1,...]
  codes: Map<string, Uint16Array>;   // categorical field -> per-cell level code
  levels: Map<string, string[]>;     // categorical field -> code -> label
  numeric: Map<string, Float32Array>; // e.g. pseudotime
  ids: string[] | null;        // lazily materialised, only for sampled output
  color: Uint8Array;           // length 4n, derived, mutated on recolor
}
```

Cost per 1M cells: `xy` 8 MB, four `Uint16Array` categoricals 8 MB, one numeric
4 MB, `color` 4 MB — roughly 24 MB. 5M cells ≈ 120 MB, which is comfortable.

`ids` is deliberately not eagerly built: one million JS strings costs more than
every typed array combined. It is reconstructed on demand from an index prefix
(`cell_{i}`) or from a sidecar only for the ≤100 sampled ids sent to the chatbot.

### Layout on disk

For dataset `D` with `N` cells and chunk size `C` (default 250,000):

```
data/tiles/D/
  manifest.json          { n, chunkSize, chunks, bounds, fields, levels, graph? }
  xy/000.bin             Float32Array, 2*C values
  xy/001.bin             ...
  codes/cell_type/000.bin  Uint16Array, C values
  codes/tissue/000.bin
  num/pseudotime/000.bin   Float32Array, C values
  graph.json             principal graph, trajectory datasets only
```

**Points are written in pre-shuffled order.** This single property makes level of
detail free: rendering the first K points is an unbiased uniform random sample of
the full dataset. `prep.py` applies one permutation to every column so rows stay
aligned.

### Principal graph (monocle3 shape)

```json
{
  "nodes": [[x, y], ...],
  "edges": [[i, j], ...],
  "root": 17,
  "branchPoints": [17, 42, 88],
  "leaves": [3, 9, 55]
}
```

Node counts are in the hundreds-to-low-thousands, so this is rendered as an
ordinary `PathLayer` (edges) plus a small `ScatterplotLayer` (branch and leaf
markers) with no optimisation required.

## 6. Rendering

### Binary attributes

deck.gl is fed GPU-ready buffers directly, bypassing accessor evaluation:

```ts
new ScatterplotLayer({
  id: `cells-${chunkIndex}`,
  data: { length, attributes: {
    getPosition:  { value: xySlice,    size: 2 },
    getFillColor: { value: colorSlice, size: 4, normalized: true }
  }},
  radiusUnits: 'pixels',
  radiusMinPixels: 0.5,
  getRadius: pointRadius,
  parameters: { depthTest: false }
});
```

### One layer per chunk

Each 250k chunk becomes its own layer. A chunk uploads to the GPU exactly once,
on arrival; chunks that land later do not force re-upload of earlier ones. The
plot therefore fills in progressively during load, and a 5M-point dataset is 20
layers, which deck.gl handles without complaint.

### Level of detail

`renderFraction ∈ (0, 1]` controls how many points of the shuffled order draw.
Because the order is a random permutation, truncation is unbiased sampling.

- **Auto mode**: choose `renderFraction` so the drawn count stays under a target
  budget at the current zoom, and raise it as the viewport narrows (a tighter
  viewport contains fewer points, so a larger fraction costs the same fill rate).
- **Manual mode**: a slider, for a user who explicitly wants the light version.
- Point radius and alpha are also zoom-dependent: small, translucent points when
  zoomed out to keep dense regions readable rather than saturated.

This mechanism *is* the "lighter version" requirement — it is not a separate code
path bolted on later.

### Recolouring

Switching the colour-by field rewrites `color` from the relevant code array in a
Web Worker, then re-uploads. Expected 20–50 ms at 5M. If measurement shows this
is objectionable, the fallback is to upload the `Uint16Array` code as a vertex
attribute and move palette lookup into an injected fragment shader, making
recolour a uniform swap. That optimisation is explicitly deferred until the
benchmark says it is needed.

## 7. Selection

### Interactions

- **Box**: click-drag a rectangle.
- **Lasso**: freehand polygon, closed on pointer-up.
- **Clear**: Escape, or click on empty canvas.

The in-progress shape is drawn as an overlay layer, so it stays in sync with pan
and zoom without per-frame DOM work.

### Spatial index

A uniform grid is built once when loading completes:

```
cellSize chosen so mean occupancy ≈ 32 points/bin
binOf(x, y) -> flat index
counts -> prefix sum -> pointIds (Uint32Array, CSR-style)
```

Build cost is two linear passes and one `Uint32Array(n)` allocation.

### Query

1. Compute the polygon's bounding box.
2. Enumerate the grid bins intersecting that box.
3. For each candidate point, test point-in-polygon by ray casting (or a plain
   rectangle test for box select).

Naive 1M × 100-vertex lasso is roughly 200 ms; restricted to candidate bins it is
expected in the 5–15 ms range for a typical selection. Everything runs in a Web
Worker on transferred typed arrays, so the main thread never stalls and panning
stays smooth during a query.

### Correctness

The gridded query must return exactly the same index set as brute force. This is
asserted by property tests over randomised point clouds and randomised polygons,
including degenerate cases (empty selection, whole-canvas selection,
self-intersecting lasso, collinear vertices, points exactly on an edge). Grid
acceleration is worthless if it silently drops points, so this is a hard gate,
not a smoke test.

### Output and highlight

The worker returns a `Uint32Array` of selected indices plus a `Uint8Array(n)`
mask. The mask drives the highlight: selected points keep full alpha, unselected
are dimmed. The mask is applied by rewriting the alpha channel of `color`, which
avoids a second set of layers.

### Zoom to selection

The selection bounding box is padded and passed to a deck.gl view-state
transition (`FlyToInterpolator` equivalent on `OrthographicView`). Zoom-to-region
and select-region are separate actions on the same selection, so a user can
select, inspect, ask the chatbot, and only then zoom.

## 8. Selection to chatbot

`SelectionStore` is a small observable holding the current selection. The chat
panel subscribes to it. No component reaches into another's internals.

Raw rows are never sent to a model. The selection is summarised:

```ts
interface SelectionContext {
  datasetId: string;
  view: 'embedding' | 'trajectory';
  n: number;
  totalN: number;
  bbox: [number, number, number, number];
  centroid: [number, number];
  breakdown: Record<string, Record<string, number>>;  // field -> label -> count
  numericStats: Record<string, {min:number; max:number; mean:number; q:[number,number,number]}>;
  sampleIds: string[];      // at most 100
  colorBy: string;
}
```

A selection of 500,000 cells and one of 12 cells produce contexts of nearly the
same size, so the token cost of a question does not scale with the selection.

```ts
interface ChatAdapter {
  send(ctx: SelectionContext, question: string, history: Turn[]): AsyncIterable<string>;
}
```

- `MockAdapter` answers deterministically from the context alone. It makes the
  whole selection-to-chat path testable offline with no key and no network.
- `ClaudeAdapter` posts to `/api/chat`. The server injects the API key from its
  environment and calls Anthropic with model `claude-sonnet-5`, streaming the
  response back. The key never enters the client bundle.

Because the server also holds the source file, a later route can answer questions
that need the full feature matrix (marker genes for the selection, for example).
The seam exists; the feature is out of scope for v1.

## 9. Capacity benchmark

A dedicated `/bench` page, because "how many points can we display" is a question
that deserves numbers rather than an opinion.

For each of N ∈ {100k, 500k, 1M, 2M, 5M, 10M}:

| Metric | Method |
|---|---|
| Fetch + decode | `performance.now()` around the chunk pipeline |
| GPU upload | time to first frame after a chunk's layer mounts |
| Steady-state FPS | `requestAnimationFrame` deltas during a scripted pan, reported as p50 and p5 |
| Lasso latency | fixed polygon, median of 10 runs |
| Heap | `performance.memory.usedJSHeapSize` where available |
| Grid build | `performance.now()` around index construction |

Output is a table written to the page and copyable as Markdown. The expected
limiting factor is fill rate from overdraw in dense regions, not point count; the
benchmark is what settles that.

## 10. Error handling

| Failure | Behaviour |
|---|---|
| Chunk fetch fails | Retry three times with backoff; on final failure keep the chunks that did load, render them, and show a non-blocking banner stating how many points are missing |
| WebGL context lost | Listen for `webglcontextlost`, re-create the deck instance and re-upload from the CPU-side typed arrays, which are still intact |
| Selection returns empty | Chat input disabled with an explicit "no cells selected" state, not a silent no-op |
| Chat request fails | Error surfaced in the panel; the selection and conversation history are preserved so the question can be retried |
| Worker crashes | Fall back to a synchronous main-thread query and log it; a slow selection beats a broken one |
| Memory budget exceeded | Before loading, `n × bytesPerCell` is compared against a budget; if over, the loader starts at a reduced `renderFraction` and says so |

## 11. Testing

**Unit (Vitest, `packages/core`, no browser):**
- `select/geometry`: point-in-polygon against known cases and degenerate inputs.
- `index/grid`: gridded query set equals brute-force set, over randomised fuzz.
- `color/recolor`: code array maps to expected RGBA; unknown codes handled.
- `context/build`: breakdown counts sum to `n`; quartiles correct; sample capped
  at 100.
- `data/loader`: chunk assembly places values at correct global offsets, verified
  against a synthetic manifest.

**Integration (Vitest + jsdom or Node):**
- `SelectionStore` notifies subscribers exactly once per change.
- `MockAdapter` round-trips a `SelectionContext` end to end.

**End-to-end (Playwright):**
- Load the 1M synthetic dataset, wait for all chunks, drag a lasso, assert the
  selection count is greater than zero and the chat panel receives a context with
  a matching `n`.
- Switch colour-by and assert the legend changes and no error is thrown.
- Zoom-to-selection changes the view state.

**Server (pytest):**
- `simulate.py` produces aligned columns of the requested length and a valid
  manifest.
- `prep.py` shuffle keeps rows aligned across every column.
- `/api/chunk` returns the correct byte length and content type.
- `/api/chat` with no API key configured returns a clear error rather than a 500.

Development follows TDD: a failing test precedes each unit of behaviour.

## 12. Build order

1. `simulate.py` + `prep.py` + manifest format; generate 100k and 1M datasets.
2. FastAPI serving manifest and chunks.
3. `packages/core`: `CellStore`, loader, palettes, recolor.
4. `ScatterCanvas` rendering the 1M synthetic set with pan and zoom.
5. Grid index, selection geometry, selection worker, `SelectionStore`.
6. Box and lasso interactions, highlight, zoom-to-selection.
7. LOD controller and manual slider.
8. Chat adapter interface, `MockAdapter`, `ChatPanel` wired to `SelectionStore`.
9. `/api/chat` and `ClaudeAdapter`.
10. Trajectory dataset generation with a principal graph; `TrajectoryView`.
11. Benchmark page; run the capacity sweep at 100k through 10M and record results.
12. Real-data ingestion: `.h5ad` and Parquet paths in `prep.py`.

## 13. Open assumptions

- Cell ids follow `cell_{index}` in synthetic data; real datasets supply them in a
  sidecar read only for the sampled subset.
- The chat model is `claude-sonnet-5`, configurable by environment variable.
- Chunk size 250,000 is a starting value; the benchmark may revise it.
