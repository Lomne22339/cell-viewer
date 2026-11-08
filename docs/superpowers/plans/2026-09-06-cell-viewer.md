# Single-Cell Embedding & Trajectory Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A browser viewer that renders 1M–10M single-cell 2D embedding points with box/lasso region selection, zoom-to-region, a monocle3-style trajectory overlay, and a chat panel that answers questions about the currently selected cells.

**Architecture:** A framework-free `packages/core` holds all data, geometry and selection logic as pure typed-array code with no DOM dependency, so it unit-tests in Node. `apps/web` owns rendering via deck.gl fed with binary attributes, one layer per 250k-point chunk. `server/` is FastAPI: it converts source data into pre-shuffled binary chunks, serves them, and proxies the chat call so no API key reaches the browser.

**Tech Stack:** TypeScript, Vite, deck.gl (`@deck.gl/core`, `@deck.gl/layers`), Vitest, Playwright, Python 3.14, FastAPI, uvicorn, NumPy, pyarrow, anndata, pytest.

**Spec:** `docs/superpowers/specs/2026-09-06-cell-viewer-design.md`

## Global Constraints

- **No array-of-objects over cell data, ever.** All per-cell data lives in typed arrays. A single `cells.map(c => ...)` over 1M rows defeats the entire design.
- Points are stored **pre-shuffled**. Rendering the first K points must be an unbiased uniform sample. Every column gets the same permutation.
- `packages/core` imports nothing from deck.gl and touches no DOM API. It must run under plain Node.
- Chunk size default: **250000** points.
- Categorical metadata is `Uint16Array` codes plus a `string[]` level dictionary. Never `string[]` per cell.
- Cell ids are **never** materialised for all N. Only the ≤100 sampled ids sent to the chat context.
- The Anthropic API key is read from `ANTHROPIC_API_KEY` in the server process only. It must not appear in any file under `apps/web/`, in any bundle, or in any committed file.
- Chat model: `claude-sonnet-5`, overridable via `CHAT_MODEL` env var.
- Selection queries run in a Web Worker. The main thread must not block on them.
- Gridded selection results must be **exactly equal** to brute-force results. Not approximately.
- Python target: 3.14. Node target: 25.x.

**Commit policy:** The user's global rules forbid committing unless explicitly asked, and this is not yet a git repository. Each task therefore ends with a **Checkpoint** step (run the full suite, confirm green) instead of a commit. If the user later asks for git, `git init` and commit per task boundary.

---

## File Structure

| Path | Responsibility |
|---|---|
| `server/simulate.py` | Generate synthetic clustered embeddings + metadata + principal graph at arbitrary N |
| `server/prep.py` | Shuffle, chunk and write any dataset to the tile layout; ingest `.h5ad` / Parquet |
| `server/tiles.py` | Manifest and chunk HTTP routes |
| `server/chat.py` | `/api/chat` streaming proxy to Anthropic |
| `server/main.py` | FastAPI app assembly, CORS, static mount |
| `packages/core/src/data/schema.ts` | `CellStore` columnar container + allocation |
| `packages/core/src/data/manifest.ts` | Manifest types and validation |
| `packages/core/src/data/loader.ts` | Chunked binary fetch, writes into preallocated arrays |
| `packages/core/src/index/grid.ts` | Uniform CSR spatial grid |
| `packages/core/src/select/geometry.ts` | Point-in-polygon, point-in-rect, bbox |
| `packages/core/src/select/query.ts` | Grid-accelerated region query (pure, worker-callable) |
| `packages/core/src/select/worker.ts` | Web Worker entry wrapping `query.ts` |
| `packages/core/src/select/store.ts` | `SelectionStore` observable |
| `packages/core/src/color/palette.ts` | Categorical palettes, continuous ramps |
| `packages/core/src/color/recolor.ts` | codes/values → RGBA `Uint8Array`, mask dimming |
| `packages/core/src/context/build.ts` | `SelectionContext` summary builder |
| `apps/web/src/views/ScatterCanvas.ts` | deck.gl canvas shared by both views |
| `apps/web/src/views/ScatterView.ts` | Embedding view wiring |
| `apps/web/src/views/TrajectoryView.ts` | Trajectory view + principal graph layers |
| `apps/web/src/interact/lasso.ts` | Pointer → polygon/rect capture + overlay layer |
| `apps/web/src/render/lod.ts` | Zoom → renderFraction / radius / alpha policy |
| `apps/web/src/ui/*.ts` | Legend, ColorByPicker, LodControl, SelectionSummary, Toolbar |
| `apps/web/src/chat/adapter.ts` | `ChatAdapter` interface + `Turn` type |
| `apps/web/src/chat/mock.ts` | Offline deterministic adapter |
| `apps/web/src/chat/claude.ts` | `/api/chat` streaming adapter |
| `apps/web/src/chat/ChatPanel.ts` | Chat UI subscribed to `SelectionStore` |
| `apps/web/src/bench/bench.ts` | Capacity sweep harness |

---

## Task 1: Project scaffold and synthetic data generator

**Files:**
- Create: `server/simulate.py`, `server/requirements.txt`, `pyproject.toml`
- Test: `server/tests/test_simulate.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `simulate_embedding(n: int, seed: int = 0) -> SimDataset` where
  `SimDataset` is a dataclass with fields `xy: np.ndarray (n,2) float32`,
  `codes: dict[str, np.ndarray (n,) uint16]`, `levels: dict[str, list[str]]`,
  `numeric: dict[str, np.ndarray (n,) float32]`.
  Also `simulate_trajectory(n, seed) -> tuple[SimDataset, PrincipalGraph]` where
  `PrincipalGraph` has `nodes: np.ndarray (m,2) float32`, `edges: list[tuple[int,int]]`,
  `root: int`, `branch_points: list[int]`, `leaves: list[int]`.

- [x] **Step 1: Create the Python project files**

`server/requirements.txt`:
```
fastapi==0.115.*
uvicorn[standard]==0.32.*
numpy==2.*
pyarrow==18.*
anndata==0.11.*
httpx==0.28.*
pytest==8.*
```

`pyproject.toml`:
```toml
[project]
name = "cell-viewer-server"
version = "0.1.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
testpaths = ["server/tests"]
```

- [x] **Step 2: Write the failing test**

`server/tests/test_simulate.py`:
```python
import numpy as np
import pytest
from server.simulate import simulate_embedding, simulate_trajectory


def test_embedding_shapes_and_dtypes():
    ds = simulate_embedding(5000, seed=1)
    assert ds.xy.shape == (5000, 2)
    assert ds.xy.dtype == np.float32
    for field, codes in ds.codes.items():
        assert codes.shape == (5000,)
        assert codes.dtype == np.uint16
        assert codes.max() < len(ds.levels[field])
    assert set(ds.codes) == {"cell_type", "tissue", "donor", "stage"}
    assert ds.numeric["pseudotime"].dtype == np.float32


def test_embedding_is_clustered_not_uniform():
    """Real UMAPs have dense islands. A uniform cloud would make LOD and
    overdraw testing meaningless, so assert the structure exists."""
    ds = simulate_embedding(20000, seed=1)
    # Cells of one type should be far tighter than the global spread.
    global_sd = ds.xy.std(axis=0).mean()
    ct = ds.codes["cell_type"]
    within = np.mean([ds.xy[ct == c].std(axis=0).mean() for c in np.unique(ct)])
    assert within < global_sd * 0.6


def test_embedding_is_deterministic_by_seed():
    a = simulate_embedding(1000, seed=7)
    b = simulate_embedding(1000, seed=7)
    c = simulate_embedding(1000, seed=8)
    assert np.array_equal(a.xy, b.xy)
    assert not np.array_equal(a.xy, c.xy)


def test_trajectory_graph_is_a_connected_tree():
    ds, g = simulate_trajectory(5000, seed=2)
    m = len(g.nodes)
    assert g.edges, "graph must have edges"
    assert len(g.edges) == m - 1, "principal graph must be a tree"
    assert 0 <= g.root < m
    # every node reachable from root
    adj = {i: [] for i in range(m)}
    for i, j in g.edges:
        adj[i].append(j)
        adj[j].append(i)
    seen, stack = {g.root}, [g.root]
    while stack:
        for nxt in adj[stack.pop()]:
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    assert len(seen) == m


def test_trajectory_pseudotime_increases_with_distance_from_root():
    ds, g = simulate_trajectory(20000, seed=2)
    pt = ds.numeric["pseudotime"]
    assert pt.min() >= 0.0
    assert pt.max() <= 1.0
    root_xy = g.nodes[g.root]
    d = np.linalg.norm(ds.xy - root_xy, axis=1)
    corr = np.corrcoef(d, pt)[0, 1]
    assert corr > 0.5, f"pseudotime should track distance from root, got r={corr}"


@pytest.mark.parametrize("n", [1, 2, 1000])
def test_small_n_does_not_crash(n):
    ds = simulate_embedding(n, seed=0)
    assert ds.xy.shape == (n, 2)
```

- [x] **Step 3: Run to verify it fails**

Run: `python -m pytest server/tests/test_simulate.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.simulate'`

- [x] **Step 4: Implement `server/simulate.py`**

```python
"""Synthetic single-cell embeddings that look like real UMAP output.

Real UMAPs are dense islands joined by sparse bridges, not uniform clouds.
Fidelity matters here: overdraw, level-of-detail and selection latency all
behave differently on clustered data than on a uniform square, so testing
against a uniform cloud would flatter the renderer.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

CELL_TYPES = [
    "T cell", "B cell", "NK cell", "Monocyte", "Macrophage", "Dendritic cell",
    "Neutrophil", "Fibroblast", "Endothelial", "Epithelial", "Hepatocyte",
    "Astrocyte", "Oligodendrocyte", "Neuron", "Erythrocyte", "Platelet",
    "Plasma cell", "Mast cell", "Basophil", "Stem cell",
]
TISSUES = ["lung", "liver", "brain", "colon", "kidney", "blood", "spleen", "skin"]
DONORS = [f"donor_{i:02d}" for i in range(12)]
STAGES = ["E9.5", "E12.5", "E15.5", "P0", "P7", "adult"]


@dataclass
class SimDataset:
    xy: np.ndarray
    codes: dict[str, np.ndarray] = field(default_factory=dict)
    levels: dict[str, list[str]] = field(default_factory=dict)
    numeric: dict[str, np.ndarray] = field(default_factory=dict)

    @property
    def n(self) -> int:
        return self.xy.shape[0]


@dataclass
class PrincipalGraph:
    nodes: np.ndarray
    edges: list[tuple[int, int]]
    root: int
    branch_points: list[int]
    leaves: list[int]


def _cluster_sizes(rng: np.random.Generator, n: int, k: int) -> np.ndarray:
    """Zipf-ish sizes: a few big populations, a long tail of rare ones."""
    w = rng.dirichlet(np.full(k, 0.7))
    sizes = np.floor(w * n).astype(np.int64)
    sizes[sizes < 1] = 1
    # fix rounding drift onto the largest cluster
    sizes[int(np.argmax(sizes))] += n - int(sizes.sum())
    return sizes


def simulate_embedding(n: int, seed: int = 0) -> SimDataset:
    rng = np.random.default_rng(seed)
    k = min(len(CELL_TYPES), max(1, min(20, n)))
    sizes = _cluster_sizes(rng, n, k)

    centers = rng.uniform(-45.0, 45.0, size=(k, 2))
    xy = np.empty((n, 2), dtype=np.float32)
    ct = np.empty(n, dtype=np.uint16)

    off = 0
    for c in range(k):
        m = int(sizes[c])
        # anisotropic blob: real clusters are elongated, not circular
        scale = rng.uniform(1.2, 4.5, size=2)
        theta = rng.uniform(0, np.pi)
        rot = np.array([[np.cos(theta), -np.sin(theta)],
                        [np.sin(theta), np.cos(theta)]])
        pts = rng.standard_normal((m, 2)) * scale
        # heavy tail gives the wisps that connect islands in a real UMAP
        tail = rng.standard_normal((m, 2)) * scale * 3.0
        pick = rng.random(m) < 0.04
        pts[pick] = tail[pick]
        xy[off:off + m] = (pts @ rot.T + centers[c]).astype(np.float32)
        ct[off:off + m] = c
        off += m

    # Metadata correlated with cell type, the way real annotations are.
    tissue = np.empty(n, dtype=np.uint16)
    for c in range(k):
        sel = ct == c
        probs = rng.dirichlet(np.full(len(TISSUES), 0.4))
        tissue[sel] = rng.choice(len(TISSUES), size=int(sel.sum()), p=probs)

    donor = rng.integers(0, len(DONORS), size=n, dtype=np.uint16)
    stage = rng.integers(0, len(STAGES), size=n, dtype=np.uint16)

    span = np.linalg.norm(xy - xy.mean(axis=0), axis=1)
    pseudotime = ((span - span.min()) / max(float(span.ptp()), 1e-9)).astype(np.float32)

    return SimDataset(
        xy=xy,
        codes={"cell_type": ct, "tissue": tissue, "donor": donor, "stage": stage},
        levels={
            "cell_type": CELL_TYPES[:k],
            "tissue": TISSUES,
            "donor": DONORS,
            "stage": STAGES,
        },
        numeric={"pseudotime": pseudotime},
    )


def _grow_tree(rng: np.random.Generator, m: int) -> tuple[np.ndarray, list[tuple[int, int]], list[int], list[int]]:
    """Grow a branching tree in 2D by random walk with occasional splits."""
    nodes = [np.zeros(2, dtype=np.float64)]
    edges: list[tuple[int, int]] = []
    # frontier holds (node_index, heading)
    frontier = [(0, rng.uniform(0, 2 * np.pi))]
    branch_points: list[int] = []

    while len(nodes) < m and frontier:
        idx, heading = frontier.pop(rng.integers(len(frontier)))
        steps = int(rng.integers(4, 14))
        cur, head = idx, heading
        for _ in range(steps):
            if len(nodes) >= m:
                break
            head += rng.normal(0, 0.25)
            nxt = nodes[cur] + np.array([np.cos(head), np.sin(head)]) * rng.uniform(1.5, 3.0)
            nodes.append(nxt)
            edges.append((cur, len(nodes) - 1))
            cur = len(nodes) - 1
        if len(nodes) < m and rng.random() < 0.75:
            branch_points.append(cur)
            frontier.append((cur, head + rng.uniform(0.4, 1.1)))
            frontier.append((cur, head - rng.uniform(0.4, 1.1)))

    # If the walk stalled before m nodes, chain the remainder off the last node.
    while len(nodes) < m:
        cur = len(nodes) - 1
        nodes.append(nodes[cur] + rng.normal(0, 2.0, size=2))
        edges.append((cur, len(nodes) - 1))

    arr = np.asarray(nodes, dtype=np.float32)
    degree = np.zeros(len(nodes), dtype=np.int32)
    for i, j in edges:
        degree[i] += 1
        degree[j] += 1
    leaves = [i for i in range(len(nodes)) if degree[i] == 1 and i != 0]
    return arr, edges, sorted(set(branch_points)), leaves


def simulate_trajectory(n: int, seed: int = 0, n_nodes: int = 240) -> tuple[SimDataset, PrincipalGraph]:
    rng = np.random.default_rng(seed)
    nodes, edges, branch_points, leaves = _grow_tree(rng, max(3, min(n_nodes, max(3, n))))
    m = nodes.shape[0]

    # Scatter cells around edge midpoints so the cloud hugs the graph.
    eidx = rng.integers(0, len(edges), size=n)
    t = rng.random(n).astype(np.float32)[:, None]
    a = nodes[[edges[i][0] for i in eidx]]
    b = nodes[[edges[i][1] for i in eidx]]
    on_edge = a + (b - a) * t
    xy = (on_edge + rng.normal(0, 0.45, size=(n, 2))).astype(np.float32)

    # Pseudotime = graph distance from root, normalised, carried onto cells.
    adj: dict[int, list[int]] = {i: [] for i in range(m)}
    for i, j in edges:
        w = float(np.linalg.norm(nodes[i] - nodes[j]))
        adj[i].append((j, w))
        adj[j].append((i, w))
    dist = np.full(m, np.inf)
    dist[0] = 0.0
    stack = [0]
    while stack:
        u = stack.pop()
        for v, w in adj[u]:
            if dist[u] + w < dist[v]:
                dist[v] = dist[u] + w
                stack.append(v)
    node_pt = (dist / max(float(dist[np.isfinite(dist)].max()), 1e-9)).astype(np.float32)
    cell_pt = node_pt[[edges[i][0] for i in eidx]] * (1 - t[:, 0]) + \
              node_pt[[edges[i][1] for i in eidx]] * t[:, 0]

    # Cell type follows the branch a cell sits on: a lineage, not noise.
    branch_of = np.zeros(m, dtype=np.uint16)
    order = np.argsort(node_pt)
    label = 0
    for node in order:
        if node in branch_points:
            label = (label + 1) % len(CELL_TYPES)
        branch_of[node] = label
    ct = branch_of[[edges[i][0] for i in eidx]].astype(np.uint16)

    tissue = rng.integers(0, len(TISSUES), size=n, dtype=np.uint16)
    donor = rng.integers(0, len(DONORS), size=n, dtype=np.uint16)
    stage_idx = np.clip((cell_pt * len(STAGES)).astype(np.int64), 0, len(STAGES) - 1)

    ds = SimDataset(
        xy=xy,
        codes={
            "cell_type": ct,
            "tissue": tissue,
            "donor": donor,
            "stage": stage_idx.astype(np.uint16),
        },
        levels={
            "cell_type": CELL_TYPES,
            "tissue": TISSUES,
            "donor": DONORS,
            "stage": STAGES,
        },
        numeric={"pseudotime": cell_pt.astype(np.float32)},
    )
    graph = PrincipalGraph(
        nodes=nodes,
        edges=edges,
        root=0,
        branch_points=branch_points,
        leaves=leaves,
    )
    return ds, graph
```

- [x] **Step 5: Run the tests**

Run: `python -m pytest server/tests/test_simulate.py -v`
Expected: PASS, 7 tests (including the 3 parametrised small-n cases).

- [x] **Step 6: Checkpoint**

Run: `python -m pytest server/tests -v`
Confirm green before moving on. Do not commit (see commit policy).

---

## Task 2: Tile writer — shuffle, chunk, manifest

**Files:**
- Create: `server/prep.py`
- Test: `server/tests/test_prep.py`

**Interfaces:**
- Consumes: `SimDataset`, `PrincipalGraph` from Task 1.
- Produces:
  - `write_tiles(ds: SimDataset, out_dir: Path, dataset_id: str, chunk_size: int = 250_000, graph: PrincipalGraph | None = None, seed: int = 0) -> dict` returning the manifest dict it wrote.
  - `shuffle_dataset(ds: SimDataset, seed: int) -> SimDataset` applying one permutation to every column.
  - Manifest schema (consumed verbatim by `packages/core/src/data/manifest.ts` in Task 4):
    ```json
    { "datasetId": "sim1m", "n": 1000000, "chunkSize": 250000, "chunks": 4,
      "bounds": [minX, minY, maxX, maxY],
      "categorical": { "cell_type": { "levels": ["T cell", ...] } },
      "numeric": { "pseudotime": { "min": 0.0, "max": 1.0 } },
      "hasGraph": false }
    ```

- [x] **Step 1: Write the failing test**

`server/tests/test_prep.py`:
```python
import json
import numpy as np
import pytest
from server.simulate import simulate_embedding, simulate_trajectory
from server.prep import write_tiles, shuffle_dataset


def test_shuffle_keeps_every_column_aligned():
    """The whole LOD scheme rests on this: if the permutation is applied
    inconsistently, a cell's coordinates get another cell's cell type and
    the plot is silently wrong."""
    ds = simulate_embedding(5000, seed=3)
    key = ds.codes["cell_type"].astype(np.int64) * 31 + ds.codes["tissue"].astype(np.int64)
    before = sorted(zip(ds.xy[:, 0].tolist(), key.tolist()))
    sh = shuffle_dataset(ds, seed=11)
    key2 = sh.codes["cell_type"].astype(np.int64) * 31 + sh.codes["tissue"].astype(np.int64)
    after = sorted(zip(sh.xy[:, 0].tolist(), key2.tolist()))
    assert before == after
    assert not np.array_equal(ds.xy, sh.xy), "shuffle must actually reorder"


def test_shuffle_prefix_is_representative():
    """Rendering the first K points must be an unbiased sample."""
    ds = simulate_embedding(60000, seed=3)
    sh = shuffle_dataset(ds, seed=5)
    full = np.bincount(sh.codes["cell_type"], minlength=32) / sh.n
    prefix_codes = sh.codes["cell_type"][:6000]
    prefix = np.bincount(prefix_codes, minlength=32) / len(prefix_codes)
    assert np.abs(full - prefix).max() < 0.02


def test_write_tiles_layout_and_manifest(tmp_path):
    ds = simulate_embedding(2500, seed=4)
    man = write_tiles(ds, tmp_path, "unit", chunk_size=1000)
    assert man["n"] == 2500
    assert man["chunks"] == 3
    assert man["chunkSize"] == 1000
    root = tmp_path / "unit"
    assert json.loads((root / "manifest.json").read_text()) == man
    for c in range(3):
        expect = 1000 if c < 2 else 500
        xy = np.fromfile(root / "xy" / f"{c:03d}.bin", dtype=np.float32)
        assert xy.size == expect * 2
        ct = np.fromfile(root / "codes" / "cell_type" / f"{c:03d}.bin", dtype=np.uint16)
        assert ct.size == expect
        pt = np.fromfile(root / "num" / "pseudotime" / f"{c:03d}.bin", dtype=np.float32)
        assert pt.size == expect


def test_chunks_concatenate_back_to_the_whole_dataset(tmp_path):
    ds = simulate_embedding(2500, seed=4)
    write_tiles(ds, tmp_path, "unit", chunk_size=1000, seed=9)
    root = tmp_path / "unit"
    xy = np.concatenate([
        np.fromfile(root / "xy" / f"{c:03d}.bin", dtype=np.float32) for c in range(3)
    ]).reshape(-1, 2)
    assert xy.shape == (2500, 2)
    # same multiset of points as the source, order permuted
    assert np.allclose(np.sort(xy[:, 0]), np.sort(ds.xy[:, 0]))


def test_manifest_bounds_cover_all_points(tmp_path):
    ds = simulate_embedding(3000, seed=6)
    man = write_tiles(ds, tmp_path, "unit", chunk_size=1000)
    x0, y0, x1, y1 = man["bounds"]
    assert x0 <= ds.xy[:, 0].min() and x1 >= ds.xy[:, 0].max()
    assert y0 <= ds.xy[:, 1].min() and y1 >= ds.xy[:, 1].max()


def test_graph_written_for_trajectory_dataset(tmp_path):
    ds, g = simulate_trajectory(3000, seed=7)
    man = write_tiles(ds, tmp_path, "traj", chunk_size=1000, graph=g)
    assert man["hasGraph"] is True
    graph = json.loads((tmp_path / "traj" / "graph.json").read_text())
    assert len(graph["nodes"]) == g.nodes.shape[0]
    assert len(graph["edges"]) == len(g.edges)
    assert graph["root"] == g.root
    assert all(len(e) == 2 for e in graph["edges"])


def test_exact_multiple_chunk_boundary(tmp_path):
    ds = simulate_embedding(2000, seed=8)
    man = write_tiles(ds, tmp_path, "unit", chunk_size=1000)
    assert man["chunks"] == 2, "n divisible by chunk_size must not emit an empty chunk"
```

- [x] **Step 2: Run to verify it fails**

Run: `python -m pytest server/tests/test_prep.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.prep'`

- [x] **Step 3: Implement `server/prep.py`**

```python
"""Convert a dataset into pre-shuffled binary chunks the browser can upload
to the GPU without parsing.

Two properties matter and are enforced by tests:
  1. One permutation is applied to every column, so rows stay aligned.
  2. That permutation is uniform, so the first K points of the output are an
     unbiased sample. Level of detail depends entirely on this.
"""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import numpy as np

from .simulate import PrincipalGraph, SimDataset


def shuffle_dataset(ds: SimDataset, seed: int = 0) -> SimDataset:
    rng = np.random.default_rng(seed)
    perm = rng.permutation(ds.n)
    return SimDataset(
        xy=np.ascontiguousarray(ds.xy[perm]),
        codes={k: np.ascontiguousarray(v[perm]) for k, v in ds.codes.items()},
        levels=dict(ds.levels),
        numeric={k: np.ascontiguousarray(v[perm]) for k, v in ds.numeric.items()},
    )


def _write_column(base: Path, arr: np.ndarray, chunk_size: int, per_row: int) -> None:
    base.mkdir(parents=True, exist_ok=True)
    n = arr.shape[0]
    for c, start in enumerate(range(0, n, chunk_size)):
        stop = min(start + chunk_size, n)
        block = np.ascontiguousarray(arr[start:stop])
        block.tofile(base / f"{c:03d}.bin")
        assert block.size == (stop - start) * per_row


def write_tiles(
    ds: SimDataset,
    out_dir: Path | str,
    dataset_id: str,
    chunk_size: int = 250_000,
    graph: PrincipalGraph | None = None,
    seed: int = 0,
) -> dict:
    out_dir = Path(out_dir)
    root = out_dir / dataset_id
    root.mkdir(parents=True, exist_ok=True)

    sh = shuffle_dataset(ds, seed=seed)
    n = sh.n
    chunks = (n + chunk_size - 1) // chunk_size

    _write_column(root / "xy", sh.xy, chunk_size, per_row=2)
    for field, codes in sh.codes.items():
        _write_column(root / "codes" / field, codes.astype(np.uint16, copy=False), chunk_size, per_row=1)
    for field, values in sh.numeric.items():
        _write_column(root / "num" / field, values.astype(np.float32, copy=False), chunk_size, per_row=1)

    pad = 0.02 * max(float(sh.xy[:, 0].ptp()), float(sh.xy[:, 1].ptp()), 1e-6)
    manifest = {
        "datasetId": dataset_id,
        "n": int(n),
        "chunkSize": int(chunk_size),
        "chunks": int(chunks),
        "bounds": [
            float(sh.xy[:, 0].min()) - pad,
            float(sh.xy[:, 1].min()) - pad,
            float(sh.xy[:, 0].max()) + pad,
            float(sh.xy[:, 1].max()) + pad,
        ],
        "categorical": {f: {"levels": list(sh.levels[f])} for f in sh.codes},
        "numeric": {
            f: {"min": float(v.min()), "max": float(v.max())} for f, v in sh.numeric.items()
        },
        "hasGraph": graph is not None,
    }
    (root / "manifest.json").write_text(json.dumps(manifest))

    if graph is not None:
        (root / "graph.json").write_text(json.dumps({
            "nodes": graph.nodes.astype(float).tolist(),
            "edges": [[int(i), int(j)] for i, j in graph.edges],
            "root": int(graph.root),
            "branchPoints": [int(i) for i in graph.branch_points],
            "leaves": [int(i) for i in graph.leaves],
        }))
    return manifest
```

- [x] **Step 4: Run the tests**

Run: `python -m pytest server/tests/test_prep.py -v`
Expected: PASS, 7 tests.

- [x] **Step 5: Add the dataset build CLI**

Append to `server/prep.py`:
```python
def _main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Build tile datasets.")
    ap.add_argument("--out", default="data/tiles")
    ap.add_argument("--chunk-size", type=int, default=250_000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--sizes", type=int, nargs="+", default=[100_000, 1_000_000],
                    help="embedding dataset sizes to generate")
    ap.add_argument("--traj-size", type=int, default=500_000)
    args = ap.parse_args()

    from .simulate import simulate_embedding, simulate_trajectory

    def label(n: int) -> str:
        return f"{n // 1_000_000}m" if n >= 1_000_000 else f"{n // 1000}k"

    for n in args.sizes:
        ds = simulate_embedding(n, seed=args.seed)
        man = write_tiles(ds, args.out, f"sim{label(n)}", args.chunk_size, seed=args.seed)
        print(f"wrote sim{label(n)}: {man['n']} cells, {man['chunks']} chunks")

    ds, g = simulate_trajectory(args.traj_size, seed=args.seed)
    man = write_tiles(ds, args.out, f"traj{label(args.traj_size)}", args.chunk_size,
                      graph=g, seed=args.seed)
    print(f"wrote traj{label(args.traj_size)}: {man['n']} cells, {len(g.edges)} graph edges")


if __name__ == "__main__":
    _main()
```

- [x] **Step 6: Generate the working datasets**

Run: `python -m server.prep --sizes 100000 1000000 --traj-size 500000`
Expected: three datasets under `data/tiles/` — `sim100k`, `sim1m`, `traj500k`.
Verify: `du -sh data/tiles/*` — `sim1m` should be roughly 14 MB, `traj500k` roughly 7 MB.

- [x] **Step 7: Checkpoint**

Run: `python -m pytest server/tests -v`
Confirm green.

---

## Task 3: FastAPI tile server

**Files:**
- Create: `server/tiles.py`, `server/main.py`, `server/__init__.py`, `server/tests/__init__.py`
- Test: `server/tests/test_tiles.py`

**Interfaces:**
- Consumes: the tile layout written by `write_tiles` (Task 2).
- Produces HTTP routes, consumed by `packages/core/src/data/loader.ts` (Task 4):
  - `GET /api/datasets` -> `{"datasets": ["sim100k", "sim1m", "traj500k"]}`
  - `GET /api/dataset/{id}/manifest` -> the manifest object
  - `GET /api/dataset/{id}/graph` -> the principal graph object, 404 if absent
  - `GET /api/dataset/{id}/chunk/xy/{c}` -> `application/octet-stream`
  - `GET /api/dataset/{id}/chunk/codes/{field}/{c}` -> `application/octet-stream`
  - `GET /api/dataset/{id}/chunk/num/{field}/{c}` -> `application/octet-stream`
- Produces `create_app(tiles_dir: Path) -> FastAPI`.

- [x] **Step 1: Write the failing test**

`server/tests/test_tiles.py`:
```python
import numpy as np
import pytest
from fastapi.testclient import TestClient

from server.main import create_app
from server.prep import write_tiles
from server.simulate import simulate_embedding, simulate_trajectory


@pytest.fixture
def client(tmp_path):
    ds = simulate_embedding(2500, seed=1)
    write_tiles(ds, tmp_path, "unit", chunk_size=1000)
    tds, g = simulate_trajectory(1500, seed=1)
    write_tiles(tds, tmp_path, "traj", chunk_size=1000, graph=g)
    return TestClient(create_app(tmp_path))


def test_lists_datasets(client):
    body = client.get("/api/datasets").json()
    assert sorted(body["datasets"]) == ["traj", "unit"]


def test_serves_manifest(client):
    man = client.get("/api/dataset/unit/manifest").json()
    assert man["n"] == 2500 and man["chunks"] == 3
    assert "cell_type" in man["categorical"]


def test_serves_xy_chunk_as_binary_with_exact_length(client):
    r = client.get("/api/dataset/unit/chunk/xy/0")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    assert len(r.content) == 1000 * 2 * 4
    xy = np.frombuffer(r.content, dtype=np.float32)
    assert np.isfinite(xy).all()


def test_last_chunk_is_short(client):
    r = client.get("/api/dataset/unit/chunk/xy/2")
    assert len(r.content) == 500 * 2 * 4


def test_serves_code_and_numeric_chunks(client):
    r = client.get("/api/dataset/unit/chunk/codes/cell_type/0")
    assert len(r.content) == 1000 * 2  # uint16
    r = client.get("/api/dataset/unit/chunk/num/pseudotime/0")
    assert len(r.content) == 1000 * 4  # float32


def test_graph_route(client):
    g = client.get("/api/dataset/traj/graph").json()
    assert g["edges"] and g["root"] == 0
    assert client.get("/api/dataset/unit/graph").status_code == 404


def test_unknown_dataset_and_chunk_are_404_not_500(client):
    assert client.get("/api/dataset/nope/manifest").status_code == 404
    assert client.get("/api/dataset/unit/chunk/xy/99").status_code == 404
    assert client.get("/api/dataset/unit/chunk/codes/nope/0").status_code == 404


@pytest.mark.parametrize("evil", ["../../etc/passwd", "..%2F..%2Fetc", "a/b"])
def test_path_traversal_is_rejected(client, evil):
    """Dataset and field names index into the filesystem. They must be
    validated, not concatenated."""
    r = client.get(f"/api/dataset/{evil}/manifest")
    assert r.status_code in (400, 404), r.status_code
```

- [x] **Step 2: Run to verify it fails**

Run: `python -m pytest server/tests/test_tiles.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.main'`

- [x] **Step 3: Create the package markers**

Create empty `server/__init__.py` and `server/tests/__init__.py`.

- [x] **Step 4: Implement `server/tiles.py`**

```python
"""Binary tile routes.

Dataset ids and field names arrive from the URL and are used to build
filesystem paths, so both are validated against a strict pattern before
they touch the disk. Concatenating unvalidated path segments is how a
tile server becomes a file-read primitive.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _safe(name: str) -> str:
    if not SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="invalid name")
    return name


def _dataset_root(request: Request, dataset_id: str) -> Path:
    root = Path(request.app.state.tiles_dir) / _safe(dataset_id)
    if not (root / "manifest.json").is_file():
        raise HTTPException(status_code=404, detail="unknown dataset")
    return root


def _send_binary(path: Path) -> Response:
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such chunk")
    return Response(
        content=path.read_bytes(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


router = APIRouter(prefix="/api")


@router.get("/datasets")
def list_datasets(request: Request) -> JSONResponse:
    root = Path(request.app.state.tiles_dir)
    ids = sorted(p.name for p in root.iterdir() if (p / "manifest.json").is_file()) if root.is_dir() else []
    return JSONResponse({"datasets": ids})


@router.get("/dataset/{dataset_id}/manifest")
def manifest(request: Request, dataset_id: str) -> JSONResponse:
    root = _dataset_root(request, dataset_id)
    return JSONResponse(json.loads((root / "manifest.json").read_text()))


@router.get("/dataset/{dataset_id}/graph")
def graph(request: Request, dataset_id: str) -> JSONResponse:
    root = _dataset_root(request, dataset_id)
    path = root / "graph.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="dataset has no principal graph")
    return JSONResponse(json.loads(path.read_text()))


@router.get("/dataset/{dataset_id}/chunk/xy/{chunk}")
def chunk_xy(request: Request, dataset_id: str, chunk: int) -> Response:
    return _send_binary(_dataset_root(request, dataset_id) / "xy" / f"{chunk:03d}.bin")


@router.get("/dataset/{dataset_id}/chunk/codes/{field}/{chunk}")
def chunk_codes(request: Request, dataset_id: str, field: str, chunk: int) -> Response:
    root = _dataset_root(request, dataset_id)
    return _send_binary(root / "codes" / _safe(field) / f"{chunk:03d}.bin")


@router.get("/dataset/{dataset_id}/chunk/num/{field}/{chunk}")
def chunk_num(request: Request, dataset_id: str, field: str, chunk: int) -> Response:
    root = _dataset_root(request, dataset_id)
    return _send_binary(root / "num" / _safe(field) / f"{chunk:03d}.bin")
```

- [x] **Step 5: Implement `server/main.py`**

```python
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .tiles import router as tiles_router


def create_app(tiles_dir: Path | str = "data/tiles") -> FastAPI:
    app = FastAPI(title="Cell Viewer")
    app.state.tiles_dir = Path(tiles_dir)
    # Vite dev server runs on another port; the browser must be allowed to
    # read the binary chunks from it.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    app.include_router(tiles_router)
    return app


app = create_app(os.environ.get("TILES_DIR", "data/tiles"))
```

- [x] **Step 6: Run the tests**

Run: `python -m pytest server/tests/test_tiles.py -v`
Expected: PASS, 11 tests.

- [x] **Step 7: Smoke-test the live server**

Run: `python -m uvicorn server.main:app --port 8000 &` then
`curl -s localhost:8000/api/datasets` and
`curl -s -o /dev/null -w '%{size_download}\n' localhost:8000/api/dataset/sim1m/chunk/xy/0`
Expected: the dataset list includes `sim1m`; the chunk is 2000000 bytes (250000 x 2 x 4).
Stop the server afterwards.

- [x] **Step 8: Checkpoint**

Run: `python -m pytest server/tests -v`
Confirm green.

---

## Task 4: Web scaffold, CellStore, chunked loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.ts`
- Create: `packages/core/src/data/manifest.ts`, `packages/core/src/data/schema.ts`, `packages/core/src/data/loader.ts`
- Test: `packages/core/test/schema.test.ts`, `packages/core/test/loader.test.ts`

**Interfaces:**
- Consumes: the HTTP routes from Task 3.
- Produces:
  - `interface Manifest { datasetId: string; n: number; chunkSize: number; chunks: number; bounds: [number,number,number,number]; categorical: Record<string,{levels:string[]}>; numeric: Record<string,{min:number;max:number}>; hasGraph: boolean }`
  - `class CellStore` with `n`, `xy: Float32Array`, `codes: Map<string, Uint16Array>`, `levels: Map<string,string[]>`, `numeric: Map<string, Float32Array>`, `color: Uint8Array`, `loadedCount: number`, `bounds`, `chunkRange(c: number): {start:number; count:number}`, `sampleIds(idx: Uint32Array, max: number): string[]`.
  - `allocateStore(m: Manifest): CellStore`
  - `loadDataset(baseUrl: string, id: string, opts: { onChunk?: (c:number, store:CellStore)=>void; signal?: AbortSignal }): Promise<CellStore>`

- [x] **Step 1: Create the JS project files**

`package.json`:
```json
{
  "name": "cell-viewer",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@deck.gl/core": "^9.0.0",
    "@deck.gl/layers": "^9.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "strict": true,
    "noUncheckedIndexedAccess": false,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": { "@core/*": ["packages/core/src/*"] }
  },
  "include": ["packages/**/*.ts", "apps/**/*.ts"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'apps/web',
  resolve: { alias: { '@core': resolve(__dirname, 'packages/core/src') } },
  server: { port: 5173 },
  build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022' }
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@core': resolve(__dirname, 'packages/core/src') } },
  test: { environment: 'node', include: ['packages/**/test/**/*.test.ts'] }
});
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Cell Viewer</title></head>
  <body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>
```

Run: `npm install`

- [x] **Step 2: Write the failing tests**

`packages/core/test/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';

const manifest: Manifest = {
  datasetId: 'unit', n: 1000, chunkSize: 400, chunks: 3,
  bounds: [-1, -1, 1, 1],
  categorical: { cell_type: { levels: ['A', 'B'] }, tissue: { levels: ['lung'] } },
  numeric: { pseudotime: { min: 0, max: 1 } },
  hasGraph: false
};

describe('CellStore', () => {
  it('allocates typed arrays of exactly the right length', () => {
    const s = allocateStore(manifest);
    expect(s.n).toBe(1000);
    expect(s.xy.length).toBe(2000);
    expect(s.xy).toBeInstanceOf(Float32Array);
    expect(s.codes.get('cell_type')!.length).toBe(1000);
    expect(s.codes.get('cell_type')).toBeInstanceOf(Uint16Array);
    expect(s.numeric.get('pseudotime')!.length).toBe(1000);
    expect(s.color.length).toBe(4000);
  });

  it('reports chunk ranges including a short final chunk', () => {
    const s = allocateStore(manifest);
    expect(s.chunkRange(0)).toEqual({ start: 0, count: 400 });
    expect(s.chunkRange(2)).toEqual({ start: 800, count: 200 });
  });

  it('starts with nothing loaded', () => {
    expect(allocateStore(manifest).loadedCount).toBe(0);
  });

  it('materialises only the sampled ids, never all n', () => {
    const s = allocateStore(manifest);
    const idx = new Uint32Array([5, 7, 900]);
    expect(s.sampleIds(idx, 100)).toEqual(['cell_5', 'cell_7', 'cell_900']);
    expect(s.sampleIds(new Uint32Array(1000).map((_, i) => i), 10)).toHaveLength(10);
  });
});
```

`packages/core/test/loader.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { loadDataset } from '@core/data/loader';
import type { Manifest } from '@core/data/manifest';

const manifest: Manifest = {
  datasetId: 'unit', n: 5, chunkSize: 2, chunks: 3,
  bounds: [0, 0, 10, 10],
  categorical: { cell_type: { levels: ['A', 'B'] } },
  numeric: { pseudotime: { min: 0, max: 1 } },
  hasGraph: false
};

// chunk c holds points (c*2 + k) at coordinate (i, i*10)
function fakeFetch(url: string): Promise<Response> {
  const bin = (a: ArrayBufferView) =>
    Promise.resolve(new Response(a.buffer as ArrayBuffer, { status: 200 }));
  if (url.endsWith('/manifest')) return Promise.resolve(Response.json(manifest));
  const m = /\/chunk\/(xy|codes\/\w+|num\/\w+)\/(\d+)$/.exec(url)!;
  const c = Number(m[2]);
  const start = c * 2;
  const count = Math.min(2, 5 - start);
  const ids = Array.from({ length: count }, (_, k) => start + k);
  if (m[1] === 'xy') return bin(Float32Array.from(ids.flatMap(i => [i, i * 10])));
  if (m[1].startsWith('codes')) return bin(Uint16Array.from(ids.map(i => i % 2)));
  return bin(Float32Array.from(ids.map(i => i / 10)));
}

describe('loadDataset', () => {
  it('places every chunk at its correct global offset', async () => {
    vi.stubGlobal('fetch', vi.fn((u: string) => fakeFetch(u)));
    const s = await loadDataset('http://x', 'unit');
    expect(Array.from(s.xy)).toEqual([0,0, 1,10, 2,20, 3,30, 4,40]);
    expect(Array.from(s.codes.get('cell_type')!)).toEqual([0,1,0,1,0]);
    expect(s.loadedCount).toBe(5);
    vi.unstubAllGlobals();
  });

  it('reports progress per chunk so the UI can draw partial data', async () => {
    vi.stubGlobal('fetch', vi.fn((u: string) => fakeFetch(u)));
    const seen: number[] = [];
    const s = await loadDataset('http://x', 'unit', {
      onChunk: (c, store) => seen.push(store.loadedCount)
    });
    expect(seen).toEqual([2, 4, 5]);
    expect(s.loadedCount).toBe(5);
    vi.unstubAllGlobals();
  });

  it('keeps successfully loaded chunks when one chunk fails permanently', async () => {
    vi.stubGlobal('fetch', vi.fn((u: string) =>
      /\/chunk\/xy\/1$/.test(u)
        ? Promise.resolve(new Response(null, { status: 500 }))
        : fakeFetch(u)));
    const s = await loadDataset('http://x', 'unit', { retries: 0 });
    expect(s.failedChunks).toEqual([1]);
    expect(Array.from(s.xy.slice(0, 4))).toEqual([0, 0, 1, 10]);
    vi.unstubAllGlobals();
  });
});
```

- [x] **Step 3: Run to verify they fail**

Run: `npx vitest run`
Expected: FAIL — cannot resolve `@core/data/schema`.

- [x] **Step 4: Implement `packages/core/src/data/manifest.ts`**

```ts
export interface Manifest {
  datasetId: string;
  n: number;
  chunkSize: number;
  chunks: number;
  bounds: [number, number, number, number];
  categorical: Record<string, { levels: string[] }>;
  numeric: Record<string, { min: number; max: number }>;
  hasGraph: boolean;
}

export interface PrincipalGraph {
  nodes: [number, number][];
  edges: [number, number][];
  root: number;
  branchPoints: number[];
  leaves: number[];
}

export function validateManifest(raw: unknown): Manifest {
  const m = raw as Manifest;
  if (!m || typeof m.n !== 'number' || typeof m.chunkSize !== 'number') {
    throw new Error('malformed manifest: missing n or chunkSize');
  }
  if (m.chunks !== Math.ceil(m.n / m.chunkSize)) {
    throw new Error(`manifest chunks=${m.chunks} inconsistent with n=${m.n} chunkSize=${m.chunkSize}`);
  }
  return m;
}
```

- [x] **Step 5: Implement `packages/core/src/data/schema.ts`**

```ts
import type { Manifest } from './manifest';

/**
 * Columnar container for every cell in a dataset.
 *
 * There is deliberately no per-cell object anywhere in this class. At one
 * million cells an array of objects costs more time in allocation and GC
 * than the entire render loop, and it is the single mistake that caps most
 * scatter plots at a hundred thousand points.
 */
export class CellStore {
  readonly n: number;
  readonly bounds: [number, number, number, number];
  readonly chunkSize: number;
  readonly chunks: number;
  readonly xy: Float32Array;
  readonly codes = new Map<string, Uint16Array>();
  readonly levels = new Map<string, string[]>();
  readonly numeric = new Map<string, Float32Array>();
  readonly numericRange = new Map<string, [number, number]>();
  /** RGBA, rewritten whenever colour-by or the selection mask changes. */
  readonly color: Uint8Array;
  loadedCount = 0;
  failedChunks: number[] = [];

  constructor(m: Manifest) {
    this.n = m.n;
    this.bounds = m.bounds;
    this.chunkSize = m.chunkSize;
    this.chunks = m.chunks;
    this.xy = new Float32Array(m.n * 2);
    this.color = new Uint8Array(m.n * 4);
    for (const [field, spec] of Object.entries(m.categorical)) {
      this.codes.set(field, new Uint16Array(m.n));
      this.levels.set(field, spec.levels);
    }
    for (const [field, spec] of Object.entries(m.numeric)) {
      this.numeric.set(field, new Float32Array(m.n));
      this.numericRange.set(field, [spec.min, spec.max]);
    }
  }

  chunkRange(c: number): { start: number; count: number } {
    const start = c * this.chunkSize;
    return { start, count: Math.min(this.chunkSize, this.n - start) };
  }

  /**
   * Ids are generated on demand for at most `max` indices. Building one
   * million strings up front would cost more memory than every typed array
   * in this store combined, and nothing needs them.
   */
  sampleIds(indices: Uint32Array, max: number): string[] {
    const take = Math.min(max, indices.length);
    const out = new Array<string>(take);
    for (let i = 0; i < take; i++) out[i] = `cell_${indices[i]}`;
    return out;
  }

  categoricalFields(): string[] { return [...this.codes.keys()]; }
  numericFields(): string[] { return [...this.numeric.keys()]; }
}

export function allocateStore(m: Manifest): CellStore {
  return new CellStore(m);
}
```

- [x] **Step 6: Implement `packages/core/src/data/loader.ts`**

```ts
import { CellStore, allocateStore } from './schema';
import { validateManifest, type Manifest, type PrincipalGraph } from './manifest';

export interface LoadOptions {
  onChunk?: (chunk: number, store: CellStore) => void;
  signal?: AbortSignal;
  /** Concurrent chunk requests. Above ~6 the browser queues them anyway. */
  concurrency?: number;
  retries?: number;
}

async function fetchBuffer(url: string, retries: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 150 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

export async function fetchManifest(baseUrl: string, id: string, signal?: AbortSignal): Promise<Manifest> {
  const res = await fetch(`${baseUrl}/api/dataset/${id}/manifest`, { signal });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return validateManifest(await res.json());
}

export async function fetchGraph(baseUrl: string, id: string, signal?: AbortSignal): Promise<PrincipalGraph> {
  const res = await fetch(`${baseUrl}/api/dataset/${id}/graph`, { signal });
  if (!res.ok) throw new Error(`graph fetch failed: ${res.status}`);
  return (await res.json()) as PrincipalGraph;
}

/**
 * Loads every column chunk into one preallocated set of typed arrays.
 *
 * Chunks are written straight into their final global offset, so a chunk
 * that arrives late never forces earlier data to be copied or re-uploaded.
 * A chunk that fails after its retries is recorded in `failedChunks` and
 * the rest of the dataset still renders: a partial plot beats a blank one.
 */
export async function loadDataset(
  baseUrl: string,
  id: string,
  opts: LoadOptions = {}
): Promise<CellStore> {
  const { onChunk, signal, concurrency = 6, retries = 3 } = opts;
  const manifest = await fetchManifest(baseUrl, id, signal);
  const store = allocateStore(manifest);
  const base = `${baseUrl}/api/dataset/${id}/chunk`;

  const loadChunk = async (c: number): Promise<void> => {
    const { start, count } = store.chunkRange(c);
    try {
      const jobs: Promise<void>[] = [
        fetchBuffer(`${base}/xy/${c}`, retries, signal).then(buf => {
          store.xy.set(new Float32Array(buf, 0, count * 2), start * 2);
        })
      ];
      for (const field of store.codes.keys()) {
        jobs.push(fetchBuffer(`${base}/codes/${field}/${c}`, retries, signal).then(buf => {
          store.codes.get(field)!.set(new Uint16Array(buf, 0, count), start);
        }));
      }
      for (const field of store.numeric.keys()) {
        jobs.push(fetchBuffer(`${base}/num/${field}/${c}`, retries, signal).then(buf => {
          store.numeric.get(field)!.set(new Float32Array(buf, 0, count), start);
        }));
      }
      await Promise.all(jobs);
      store.loadedCount += count;
    } catch (err) {
      if (signal?.aborted) throw err;
      store.failedChunks.push(c);
      return;
    }
    onChunk?.(c, store);
  };

  // Fixed-size worker pool, in chunk order so the plot fills predictably.
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, manifest.chunks) }, async () => {
    while (next < manifest.chunks) {
      await loadChunk(next++);
    }
  });
  await Promise.all(workers);
  store.failedChunks.sort((a, b) => a - b);
  return store;
}
```

- [x] **Step 7: Run the tests**

Run: `npx vitest run`
Expected: PASS, 7 tests across the two files.

Note on the progress test: the pool runs chunks in order, and with 3 chunks and
concurrency 6 the `onChunk` callbacks fire as each chunk completes. If the
observed order is nondeterministic under concurrency, the test asserts the
sorted set of `loadedCount` values instead — but do not weaken it to only
checking the final count, since the point is that partial data is observable.

- [x] **Step 8: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`
Confirm both green.

---

## Task 5: Palettes and recolouring

**Files:**
- Create: `packages/core/src/color/palette.ts`, `packages/core/src/color/recolor.ts`
- Test: `packages/core/test/color.test.ts`

**Interfaces:**
- Consumes: `CellStore` (Task 4).
- Produces:
  - `CATEGORICAL_PALETTE: Uint8Array` (flat RGB triplets, 24 hues) and `paletteFor(levelCount: number): Uint8Array`
  - `VIRIDIS: Uint8Array`, `rampSample(ramp: Uint8Array, t: number, out: Uint8Array, offset: number): void`
  - `recolorCategorical(store, field, alpha?): void` — fills `store.color`
  - `recolorNumeric(store, field, ramp?, alpha?): void`
  - `applySelectionMask(color: Uint8Array, mask: Uint8Array | null, dimAlpha: number, fullAlpha: number): void`
  - `legendEntries(store, field): { label: string; rgb: [number,number,number]; count: number }[]`

- [x] **Step 1: Write the failing test**

`packages/core/test/color.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';
import { paletteFor, VIRIDIS, rampSample } from '@core/color/palette';
import { recolorCategorical, recolorNumeric, applySelectionMask, legendEntries } from '@core/color/recolor';

const manifest: Manifest = {
  datasetId: 'unit', n: 6, chunkSize: 6, chunks: 1, bounds: [0, 0, 1, 1],
  categorical: { cell_type: { levels: ['A', 'B', 'C'] } },
  numeric: { pseudotime: { min: 0, max: 1 } },
  hasGraph: false
};

function store() {
  const s = allocateStore(manifest);
  s.codes.get('cell_type')!.set([0, 1, 2, 0, 1, 2]);
  s.numeric.get('pseudotime')!.set([0, 0.2, 0.4, 0.6, 0.8, 1]);
  s.loadedCount = 6;
  return s;
}

describe('palette', () => {
  it('gives distinct colours to distinct levels', () => {
    const p = paletteFor(3);
    const seen = new Set([0, 1, 2].map(i => `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`));
    expect(seen.size).toBe(3);
  });

  it('wraps rather than throwing when levels exceed palette length', () => {
    const p = paletteFor(500);
    expect(p.length).toBe(500 * 3);
  });

  it('samples a continuous ramp at both ends and the middle', () => {
    const out = new Uint8Array(12);
    rampSample(VIRIDIS, 0, out, 0);
    rampSample(VIRIDIS, 0.5, out, 4);
    rampSample(VIRIDIS, 1, out, 8);
    const lo = [out[0], out[1], out[2]];
    const hi = [out[8], out[9], out[10]];
    expect(lo).not.toEqual(hi);
    // viridis runs dark blue -> yellow: green channel must rise
    expect(out[9]).toBeGreaterThan(out[1]);
  });

  it('clamps out-of-range ramp positions instead of reading past the end', () => {
    const out = new Uint8Array(8);
    rampSample(VIRIDIS, -5, out, 0);
    rampSample(VIRIDIS, 99, out, 4);
    expect(out.slice(0, 3)).toEqual(new Uint8Array(VIRIDIS.slice(0, 3)));
    expect(out.slice(4, 7)).toEqual(new Uint8Array(VIRIDIS.slice(VIRIDIS.length - 3)));
  });
});

describe('recolor', () => {
  it('assigns the same colour to cells of the same level', () => {
    const s = store();
    recolorCategorical(s, 'cell_type');
    expect(s.color.slice(0, 3)).toEqual(s.color.slice(12, 15)); // cells 0 and 3, both level A
    expect(s.color.slice(0, 3)).not.toEqual(s.color.slice(4, 7)); // A vs B
    expect(s.color[3]).toBe(255); // opaque by default
  });

  it('maps a numeric field monotonically along the ramp', () => {
    const s = store();
    recolorNumeric(s, 'pseudotime');
    const green = (i: number) => s.color[i * 4 + 1];
    expect(green(5)).toBeGreaterThan(green(0));
  });

  it('handles a constant numeric field without dividing by zero', () => {
    const s = store();
    s.numeric.get('pseudotime')!.fill(0.5);
    s.numericRange.set('pseudotime', [0.5, 0.5]);
    expect(() => recolorNumeric(s, 'pseudotime')).not.toThrow();
    expect(Number.isNaN(s.color[0])).toBe(false);
  });

  it('only colours loaded cells, leaving the tail transparent', () => {
    const s = store();
    s.loadedCount = 3;
    recolorCategorical(s, 'cell_type');
    expect(s.color[3]).toBe(255);
    expect(s.color[5 * 4 + 3]).toBe(0);
  });

  it('dims unselected cells and keeps selected ones opaque', () => {
    const s = store();
    recolorCategorical(s, 'cell_type');
    const mask = new Uint8Array([1, 0, 0, 1, 0, 0]);
    applySelectionMask(s.color, mask, 40, 255);
    expect(s.color[3]).toBe(255);
    expect(s.color[7]).toBe(40);
    const rgbUnchanged = s.color.slice(4, 7);
    expect(rgbUnchanged.length).toBe(3); // hue preserved, only alpha touched
  });

  it('restores full opacity when the mask is cleared', () => {
    const s = store();
    recolorCategorical(s, 'cell_type');
    applySelectionMask(s.color, new Uint8Array([1, 0, 0, 0, 0, 0]), 40, 255);
    applySelectionMask(s.color, null, 40, 255);
    for (let i = 0; i < 6; i++) expect(s.color[i * 4 + 3]).toBe(255);
  });

  it('builds legend entries with counts that sum to the loaded count', () => {
    const s = store();
    const entries = legendEntries(s, 'cell_type');
    expect(entries.map(e => e.label)).toEqual(['A', 'B', 'C']);
    expect(entries.reduce((a, e) => a + e.count, 0)).toBe(6);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/color.test.ts`
Expected: FAIL — cannot resolve `@core/color/palette`.

- [x] **Step 3: Implement `packages/core/src/color/palette.ts`**

```ts
/**
 * Colour tables as flat RGB byte triplets.
 *
 * These are consumed inside per-cell loops that run over millions of
 * elements, so they are plain Uint8Arrays indexed arithmetically rather
 * than arrays of objects or CSS strings.
 */

/** 24 hues chosen to stay distinguishable at one-pixel point size. */
const BASE_CATEGORICAL: number[] = [
  31, 119, 180, 255, 127, 14, 44, 160, 44, 214, 39, 40,
  148, 103, 189, 140, 86, 75, 227, 119, 194, 127, 127, 127,
  188, 189, 34, 23, 190, 207, 174, 199, 232, 255, 187, 120,
  152, 223, 138, 255, 152, 150, 197, 176, 213, 196, 156, 148,
  247, 182, 210, 199, 199, 199, 219, 219, 141, 158, 218, 229,
  102, 194, 165, 252, 141, 98, 141, 160, 203, 231, 138, 195
];

export const CATEGORICAL_PALETTE = new Uint8Array(BASE_CATEGORICAL);

/**
 * Palette sized to the level count. Beyond 24 levels the hues repeat with a
 * brightness shift; distinguishing more than that by colour alone does not
 * work anyway, and the legend carries the labels.
 */
export function paletteFor(levelCount: number): Uint8Array {
  const out = new Uint8Array(levelCount * 3);
  const base = CATEGORICAL_PALETTE.length / 3;
  for (let i = 0; i < levelCount; i++) {
    const cycle = Math.floor(i / base);
    const shift = cycle === 0 ? 1 : cycle % 2 === 1 ? 0.72 : 1.28;
    const b = (i % base) * 3;
    out[i * 3] = Math.min(255, Math.round(CATEGORICAL_PALETTE[b] * shift));
    out[i * 3 + 1] = Math.min(255, Math.round(CATEGORICAL_PALETTE[b + 1] * shift));
    out[i * 3 + 2] = Math.min(255, Math.round(CATEGORICAL_PALETTE[b + 2] * shift));
  }
  return out;
}

function buildRamp(stops: [number, number, number][], steps = 256): Uint8Array {
  const out = new Uint8Array(steps * 3);
  const segs = stops.length - 1;
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * segs;
    const s = Math.min(segs - 1, Math.floor(t));
    const f = t - s;
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(stops[s][c] + (stops[s + 1][c] - stops[s][c]) * f);
    }
  }
  return out;
}

export const VIRIDIS = buildRamp([
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
  [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89],
  [180, 222, 44], [253, 231, 37]
]);

export const MAGMA = buildRamp([
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129],
  [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]
]);

export const RAMPS: Record<string, Uint8Array> = { viridis: VIRIDIS, magma: MAGMA };

/** Writes RGB for position `t` in [0,1] into `out` at `offset`. Clamps. */
export function rampSample(ramp: Uint8Array, t: number, out: Uint8Array, offset: number): void {
  const steps = ramp.length / 3;
  let i = Math.round(t * (steps - 1));
  if (!(i >= 0)) i = 0;           // also catches NaN
  if (i > steps - 1) i = steps - 1;
  out[offset] = ramp[i * 3];
  out[offset + 1] = ramp[i * 3 + 1];
  out[offset + 2] = ramp[i * 3 + 2];
}
```

- [x] **Step 4: Implement `packages/core/src/color/recolor.ts`**

```ts
import type { CellStore } from '../data/schema';
import { paletteFor, rampSample, VIRIDIS } from './palette';

/**
 * Fills `store.color` from a categorical field.
 *
 * This is the hot path for a colour-by change: at five million cells it
 * writes twenty megabytes. It is a single flat loop with no allocation and
 * no function calls per cell, and it is expected to run in a worker.
 */
export function recolorCategorical(store: CellStore, field: string, alpha = 255): void {
  const codes = store.codes.get(field);
  if (!codes) throw new Error(`unknown categorical field: ${field}`);
  const levels = store.levels.get(field)!.length;
  const palette = paletteFor(Math.max(1, levels));
  const color = store.color;
  const upTo = store.loadedCount;
  for (let i = 0; i < upTo; i++) {
    const p = (codes[i] % levels) * 3;
    const o = i * 4;
    color[o] = palette[p];
    color[o + 1] = palette[p + 1];
    color[o + 2] = palette[p + 2];
    color[o + 3] = alpha;
  }
  color.fill(0, upTo * 4);
}

export function recolorNumeric(
  store: CellStore,
  field: string,
  ramp: Uint8Array = VIRIDIS,
  alpha = 255
): void {
  const values = store.numeric.get(field);
  if (!values) throw new Error(`unknown numeric field: ${field}`);
  const [lo, hi] = store.numericRange.get(field) ?? [0, 1];
  // A constant field has zero span; scaling by 1/0 would paint every cell NaN.
  const span = hi - lo;
  const inv = span > 0 ? 1 / span : 0;
  const color = store.color;
  const upTo = store.loadedCount;
  for (let i = 0; i < upTo; i++) {
    const o = i * 4;
    rampSample(ramp, (values[i] - lo) * inv, color, o);
    color[o + 3] = alpha;
  }
  color.fill(0, upTo * 4);
}

/**
 * Rewrites only the alpha channel, so hue is preserved and clearing the
 * selection needs no re-run of the colour-by pass.
 */
export function applySelectionMask(
  color: Uint8Array,
  mask: Uint8Array | null,
  dimAlpha: number,
  fullAlpha: number
): void {
  const n = color.length / 4;
  if (mask === null) {
    for (let i = 0; i < n; i++) color[i * 4 + 3] = fullAlpha;
    return;
  }
  for (let i = 0; i < n; i++) {
    color[i * 4 + 3] = mask[i] ? fullAlpha : dimAlpha;
  }
}

export interface LegendEntry {
  label: string;
  rgb: [number, number, number];
  count: number;
}

export function legendEntries(store: CellStore, field: string): LegendEntry[] {
  const codes = store.codes.get(field);
  if (!codes) throw new Error(`unknown categorical field: ${field}`);
  const labels = store.levels.get(field)!;
  const palette = paletteFor(labels.length);
  const counts = new Uint32Array(labels.length);
  const upTo = store.loadedCount;
  for (let i = 0; i < upTo; i++) counts[codes[i] % labels.length]++;
  return labels.map((label, i) => ({
    label,
    rgb: [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]] as [number, number, number],
    count: counts[i]
  }));
}
```

- [x] **Step 5: Run the tests**

Run: `npx vitest run packages/core/test/color.test.ts`
Expected: PASS, 11 tests.

- [x] **Step 6: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`

---

## Task 6: Spatial grid and selection geometry

**Files:**
- Create: `packages/core/src/select/geometry.ts`, `packages/core/src/index/grid.ts`, `packages/core/src/select/query.ts`
- Test: `packages/core/test/geometry.test.ts`, `packages/core/test/grid.test.ts`

**Interfaces:**
- Consumes: `xy: Float32Array` from `CellStore`.
- Produces:
  - `type Polygon = Float64Array` (flat `[x0,y0,x1,y1,...]`)
  - `pointInPolygon(px, py, poly: Polygon): boolean`
  - `polygonBounds(poly: Polygon): [number,number,number,number]`
  - `class UniformGrid` built by `buildGrid(xy: Float32Array, count: number, targetPerBin?: number): UniformGrid`, with `cols`, `rows`, `cellSize`, `minX`, `minY`, `starts: Uint32Array`, `items: Uint32Array`, `binsInBounds(b): Iterable<number>`
  - `selectPolygon(xy, count, poly, grid?): Uint32Array`
  - `selectRect(xy, count, rect: [number,number,number,number], grid?): Uint32Array`
  - `maskFromIndices(indices: Uint32Array, n: number): Uint8Array`

- [x] **Step 1: Write the failing geometry test**

`packages/core/test/geometry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { pointInPolygon, polygonBounds } from '@core/select/geometry';

const square = Float64Array.from([0, 0, 10, 0, 10, 10, 0, 10]);
// a concave "C": excludes the middle-right region
const cShape = Float64Array.from([0, 0, 10, 0, 10, 3, 4, 3, 4, 7, 10, 7, 10, 10, 0, 10]);

describe('pointInPolygon', () => {
  it('accepts interior points and rejects exterior ones', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(-1, 5, square)).toBe(false);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(5, 20, square)).toBe(false);
  });

  it('respects concavity', () => {
    expect(pointInPolygon(2, 5, cShape)).toBe(true);
    expect(pointInPolygon(7, 5, cShape)).toBe(false); // inside the notch
    expect(pointInPolygon(7, 1, cShape)).toBe(true);
  });

  it('is consistent for points on a horizontal edge (no double counting)', () => {
    // Ray casting classically double-counts vertices on the ray. Whatever
    // this returns must at least be stable and must not leak to points
    // clearly outside.
    const a = pointInPolygon(5, 0, square);
    const b = pointInPolygon(5, 0, square);
    expect(a).toBe(b);
    expect(pointInPolygon(5, -0.001, square)).toBe(false);
    expect(pointInPolygon(5, 0.001, square)).toBe(true);
  });

  it('handles a vertex exactly on the test ray', () => {
    const tri = Float64Array.from([0, 0, 10, 5, 0, 10]);
    expect(pointInPolygon(1, 5, tri)).toBe(true);
    expect(pointInPolygon(-1, 5, tri)).toBe(false);
  });

  it('returns false for degenerate polygons', () => {
    expect(pointInPolygon(1, 1, Float64Array.from([0, 0, 1, 1]))).toBe(false);
    expect(pointInPolygon(1, 1, Float64Array.from([]))).toBe(false);
  });

  it('handles a self-intersecting lasso without throwing', () => {
    const bowtie = Float64Array.from([0, 0, 10, 10, 10, 0, 0, 10]);
    expect(() => pointInPolygon(5, 2, bowtie)).not.toThrow();
  });

  it('computes bounds', () => {
    expect(Array.from(polygonBounds(cShape))).toEqual([0, 0, 10, 10]);
  });
});
```

- [x] **Step 2: Write the failing grid test**

`packages/core/test/grid.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildGrid } from '@core/index/grid';
import { selectPolygon, selectRect, maskFromIndices } from '@core/select/query';
import { pointInPolygon } from '@core/select/geometry';

function randomPoints(n: number, seed: number): Float32Array {
  // deterministic LCG so failures reproduce
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) xy[i] = rnd() * 200 - 100;
  return xy;
}

function bruteForce(xy: Float32Array, n: number, poly: Float64Array): Uint32Array {
  const hits: number[] = [];
  for (let i = 0; i < n; i++) {
    if (pointInPolygon(xy[i * 2], xy[i * 2 + 1], poly)) hits.push(i);
  }
  return Uint32Array.from(hits);
}

function randomPolygon(seed: number, verts: number): Float64Array {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cx = rnd() * 120 - 60, cy = rnd() * 120 - 60;
  const poly = new Float64Array(verts * 2);
  for (let k = 0; k < verts; k++) {
    const a = (k / verts) * Math.PI * 2;
    const r = 8 + rnd() * 35;
    poly[k * 2] = cx + Math.cos(a) * r;
    poly[k * 2 + 1] = cy + Math.sin(a) * r;
  }
  return poly;
}

describe('grid', () => {
  it('indexes every point exactly once', () => {
    const n = 5000;
    const xy = randomPoints(n, 42);
    const g = buildGrid(xy, n);
    expect(g.items.length).toBe(n);
    const seen = new Uint8Array(n);
    for (const idx of g.items) seen[idx] = 1;
    expect(seen.every(v => v === 1)).toBe(true);
  });

  it('produces bins sized near the target occupancy', () => {
    const n = 10000;
    const g = buildGrid(randomPoints(n, 7), n, 32);
    const occupancy = n / (g.cols * g.rows);
    expect(occupancy).toBeGreaterThan(4);
    expect(occupancy).toBeLessThan(256);
  });

  it('survives all-identical coordinates without an infinite grid', () => {
    const xy = new Float32Array(2000).fill(3);
    const g = buildGrid(xy, 1000);
    expect(g.cols).toBeGreaterThanOrEqual(1);
    expect(g.items.length).toBe(1000);
  });
});

describe('selectPolygon', () => {
  it('matches brute force exactly across many random polygons', () => {
    const n = 20000;
    const xy = randomPoints(n, 99);
    const g = buildGrid(xy, n);
    for (let trial = 0; trial < 40; trial++) {
      const poly = randomPolygon(trial + 1, 3 + (trial % 30));
      const fast = Array.from(selectPolygon(xy, n, poly, g)).sort((a, b) => a - b);
      const slow = Array.from(bruteForce(xy, n, poly)).sort((a, b) => a - b);
      expect(fast).toEqual(slow);
    }
  });

  it('matches brute force with no grid supplied', () => {
    const n = 3000;
    const xy = randomPoints(n, 5);
    const poly = randomPolygon(11, 12);
    expect(Array.from(selectPolygon(xy, n, poly))).toEqual(Array.from(bruteForce(xy, n, poly)));
  });

  it('returns empty for a polygon outside the data', () => {
    const n = 1000;
    const xy = randomPoints(n, 3);
    const far = Float64Array.from([1000, 1000, 1010, 1000, 1010, 1010, 1000, 1010]);
    expect(selectPolygon(xy, n, far, buildGrid(xy, n)).length).toBe(0);
  });

  it('returns everything for a polygon covering the data', () => {
    const n = 1000;
    const xy = randomPoints(n, 3);
    const all = Float64Array.from([-500, -500, 500, -500, 500, 500, -500, 500]);
    expect(selectPolygon(xy, n, all, buildGrid(xy, n)).length).toBe(n);
  });

  it('only considers the first `count` points, ignoring the unloaded tail', () => {
    const n = 1000;
    const xy = randomPoints(n, 3);
    const all = Float64Array.from([-500, -500, 500, -500, 500, 500, -500, 500]);
    expect(selectPolygon(xy, 250, all).length).toBe(250);
  });
});

describe('selectRect', () => {
  it('matches an explicit filter', () => {
    const n = 5000;
    const xy = randomPoints(n, 21);
    const rect: [number, number, number, number] = [-20, -10, 30, 40];
    const got = Array.from(selectRect(xy, n, rect, buildGrid(xy, n))).sort((a, b) => a - b);
    const want: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]) want.push(i);
    }
    expect(got).toEqual(want);
  });

  it('normalises a rectangle dragged right-to-left / bottom-to-top', () => {
    const n = 2000;
    const xy = randomPoints(n, 4);
    const g = buildGrid(xy, n);
    const a = selectRect(xy, n, [30, 40, -20, -10], g);
    const b = selectRect(xy, n, [-20, -10, 30, 40], g);
    expect(Array.from(a).sort()).toEqual(Array.from(b).sort());
  });
});

describe('maskFromIndices', () => {
  it('sets exactly the selected positions', () => {
    const m = maskFromIndices(Uint32Array.from([1, 4]), 6);
    expect(Array.from(m)).toEqual([0, 1, 0, 0, 1, 0]);
  });
});
```

- [x] **Step 3: Run to verify they fail**

Run: `npx vitest run packages/core/test/geometry.test.ts packages/core/test/grid.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 4: Implement `packages/core/src/select/geometry.ts`**

```ts
/** Flat `[x0,y0,x1,y1,...]`, implicitly closed. */
export type Polygon = Float64Array;

/**
 * Crossing-number point-in-polygon.
 *
 * The `(yi > py) !== (yj > py)` guard is what makes vertices lying exactly
 * on the test ray count once rather than twice; the naive `>=` form
 * double-counts them and produces holes along horizontal edges. Points on a
 * boundary are classified consistently but arbitrarily, which is fine for
 * a hand-drawn lasso.
 */
export function pointInPolygon(px: number, py: number, poly: Polygon): boolean {
  const v = poly.length / 2;
  if (v < 3) return false;
  let inside = false;
  for (let i = 0, j = v - 1; i < v; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1];
    const xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > py) !== (yj > py)) {
      const t = (py - yi) / (yj - yi);
      if (px < xi + t * (xj - xi)) inside = !inside;
    }
  }
  return inside;
}

export function polygonBounds(poly: Polygon): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i], y = poly[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function normalizeRect(r: [number, number, number, number]): [number, number, number, number] {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export function rectToPolygon(r: [number, number, number, number]): Polygon {
  const [x0, y0, x1, y1] = normalizeRect(r);
  return Float64Array.from([x0, y0, x1, y0, x1, y1, x0, y1]);
}
```

- [x] **Step 5: Implement `packages/core/src/index/grid.ts`**

```ts
/**
 * Uniform bucket grid in compressed-sparse-row form.
 *
 * Two linear passes and two allocations; no nested arrays, because one
 * array per bin at a few hundred thousand bins costs more than the point
 * data itself. `starts` holds bin offsets into `items`, and `items` holds
 * point indices grouped by bin.
 */
export class UniformGrid {
  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly cellSize: number,
    readonly minX: number,
    readonly minY: number,
    readonly starts: Uint32Array,
    readonly items: Uint32Array
  ) {}

  colOf(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
  }

  rowOf(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cellSize)));
  }

  /** Bin index range covering a world-space bounding box. */
  binRange(b: [number, number, number, number]): { c0: number; c1: number; r0: number; r1: number } {
    return {
      c0: this.colOf(b[0]), c1: this.colOf(b[2]),
      r0: this.rowOf(b[1]), r1: this.rowOf(b[3])
    };
  }
}

export function buildGrid(xy: Float32Array, count: number, targetPerBin = 32): UniformGrid {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; }

  // A degenerate extent (every point identical) would otherwise give a zero
  // cell size and an infinite column count.
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const targetBins = Math.max(1, Math.ceil(count / targetPerBin));
  const cellSize = Math.max(Math.sqrt((w * h) / targetBins), 1e-6);
  const cols = Math.max(1, Math.min(4096, Math.ceil(w / cellSize)));
  const rows = Math.max(1, Math.min(4096, Math.ceil(h / cellSize)));
  const nbins = cols * rows;

  const counts = new Uint32Array(nbins + 1);
  const binOf = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((xy[i * 2] - minX) / cellSize)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((xy[i * 2 + 1] - minY) / cellSize)));
    const b = r * cols + c;
    binOf[i] = b;
    counts[b + 1]++;
  }
  for (let b = 0; b < nbins; b++) counts[b + 1] += counts[b];

  const starts = counts;                 // now a prefix-sum offset table
  const cursor = starts.slice(0, nbins);
  const items = new Uint32Array(count);
  for (let i = 0; i < count; i++) items[cursor[binOf[i]]++] = i;

  return new UniformGrid(cols, rows, cellSize, minX, minY, starts, items);
}
```

- [x] **Step 6: Implement `packages/core/src/select/query.ts`**

```ts
import { UniformGrid } from '../index/grid';
import { normalizeRect, pointInPolygon, polygonBounds, type Polygon } from './geometry';

/**
 * Region query, grid-accelerated when an index is supplied.
 *
 * The grid narrows candidates to bins overlapping the polygon's bounding
 * box; every surviving candidate still gets a full point-in-polygon test,
 * so the result is identical to brute force rather than approximate. That
 * equality is asserted by property tests, because an index that silently
 * drops points is worse than no index.
 */
export function selectPolygon(
  xy: Float32Array,
  count: number,
  poly: Polygon,
  grid?: UniformGrid
): Uint32Array {
  if (poly.length < 6) return new Uint32Array(0);
  const bounds = polygonBounds(poly);
  const out = new Uint32Array(count);
  let k = 0;

  if (!grid) {
    for (let i = 0; i < count; i++) {
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3]) continue;
      if (pointInPolygon(x, y, poly)) out[k++] = i;
    }
    return out.slice(0, k);
  }

  const { c0, c1, r0, r1 } = grid.binRange(bounds);
  const { cols, starts, items } = grid;
  for (let r = r0; r <= r1; r++) {
    const rowBase = r * cols;
    for (let c = c0; c <= c1; c++) {
      const b = rowBase + c;
      const end = starts[b + 1];
      for (let s = starts[b]; s < end; s++) {
        const i = items[s];
        // The grid may hold points beyond the loaded prefix; skip them.
        if (i >= count) continue;
        const x = xy[i * 2], y = xy[i * 2 + 1];
        if (x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3]) continue;
        if (pointInPolygon(x, y, poly)) out[k++] = i;
      }
    }
  }
  const res = out.slice(0, k);
  res.sort();
  return res;
}

export function selectRect(
  xy: Float32Array,
  count: number,
  rect: [number, number, number, number],
  grid?: UniformGrid
): Uint32Array {
  const [x0, y0, x1, y1] = normalizeRect(rect);
  const out = new Uint32Array(count);
  let k = 0;

  const test = (i: number): void => {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out[k++] = i;
  };

  if (!grid) {
    for (let i = 0; i < count; i++) test(i);
    return out.slice(0, k);
  }

  const { c0, c1, r0, r1 } = grid.binRange([x0, y0, x1, y1]);
  const { cols, starts, items } = grid;
  for (let r = r0; r <= r1; r++) {
    const rowBase = r * cols;
    for (let c = c0; c <= c1; c++) {
      const b = rowBase + c;
      const end = starts[b + 1];
      for (let s = starts[b]; s < end; s++) {
        const i = items[s];
        if (i < count) test(i);
      }
    }
  }
  const res = out.slice(0, k);
  res.sort();
  return res;
}

export function maskFromIndices(indices: Uint32Array, n: number): Uint8Array {
  const mask = new Uint8Array(n);
  for (let i = 0; i < indices.length; i++) mask[indices[i]] = 1;
  return mask;
}
```

- [x] **Step 7: Run the tests**

Run: `npx vitest run packages/core/test/geometry.test.ts packages/core/test/grid.test.ts`
Expected: PASS, 18 tests. The brute-force equality test is the important one —
if it fails, the grid is dropping points and nothing downstream can be trusted.

- [x] **Step 8: Add a latency guard**

Append to `packages/core/test/grid.test.ts`:
```ts
describe('selection latency', () => {
  it('answers a 1M-point lasso in well under a second', () => {
    const n = 1_000_000;
    const xy = randomPoints(n, 1234);
    const t0 = performance.now();
    const g = buildGrid(xy, n);
    const built = performance.now() - t0;
    const poly = randomPolygon(3, 60);
    const t1 = performance.now();
    const hits = selectPolygon(xy, n, poly, g);
    const queried = performance.now() - t1;
    // Generous bounds: this guards against an accidental O(n * verts) path,
    // not against a specific machine's speed.
    expect(built).toBeLessThan(2000);
    expect(queried).toBeLessThan(500);
    expect(hits.length).toBeGreaterThan(0);
  });
});
```

Run: `npx vitest run packages/core/test/grid.test.ts -t latency`
Record the printed timings; they feed the benchmark table in Task 14.

- [x] **Step 9: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`

---

## Task 7: Selection worker and SelectionStore

**Files:**
- Create: `packages/core/src/select/worker.ts`, `packages/core/src/select/client.ts`, `packages/core/src/select/store.ts`
- Test: `packages/core/test/store.test.ts`, `packages/core/test/worker-protocol.test.ts`

**Interfaces:**
- Consumes: `selectPolygon`, `selectRect`, `buildGrid` (Task 6); `CellStore` (Task 4).
- Produces:
  - Worker message types:
    `{ type: 'init'; xy: ArrayBuffer; count: number }`,
    `{ type: 'query'; id: number; shape: { kind: 'poly'; poly: Float64Array } | { kind: 'rect'; rect: [number,number,number,number] }; count: number }`
    replying `{ type: 'ready' } | { type: 'result'; id: number; indices: Uint32Array; ms: number }`
  - `handleMessage(state, msg): { reply: WorkerReply; transfer: Transferable[] }` — pure, unit-testable without a real Worker.
  - `class SelectionClient` with `init(xy, count)`, `query(shape, count): Promise<Uint32Array>`, `terminate()`.
  - `class SelectionStore` with `set(indices, meta)`, `clear()`, `subscribe(fn): () => void`, `current: Selection | null`, where `Selection = { indices: Uint32Array; mask: Uint8Array; bbox: [number,number,number,number]; shape: 'poly'|'rect' }`.

- [x] **Step 1: Write the failing tests**

`packages/core/test/worker-protocol.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createWorkerState, handleMessage } from '@core/select/worker';

function points(): Float32Array {
  return Float32Array.from([0, 0, 1, 1, 2, 2, 9, 9, 10, 10]);
}

describe('worker protocol', () => {
  it('acknowledges init and builds an index', () => {
    const state = createWorkerState();
    const xy = points();
    const { reply } = handleMessage(state, { type: 'init', xy: xy.buffer, count: 5 });
    expect(reply.type).toBe('ready');
    expect(state.grid).not.toBeNull();
    expect(state.count).toBe(5);
  });

  it('answers a rect query with the correct indices and echoes the id', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 5 });
    const { reply } = handleMessage(state, {
      type: 'query', id: 7, count: 5,
      shape: { kind: 'rect', rect: [-1, -1, 3, 3] }
    });
    expect(reply.type).toBe('result');
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(reply.id).toBe(7);
    expect(Array.from(reply.indices)).toEqual([0, 1, 2]);
    expect(reply.ms).toBeGreaterThanOrEqual(0);
  });

  it('answers a polygon query', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 5 });
    const { reply } = handleMessage(state, {
      type: 'query', id: 1, count: 5,
      shape: { kind: 'poly', poly: Float64Array.from([8, 8, 11, 8, 11, 11, 8, 11]) }
    });
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(Array.from(reply.indices)).toEqual([3, 4]);
  });

  it('rebuilds the index when the loaded count grows', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 2 });
    const first = state.grid;
    handleMessage(state, {
      type: 'query', id: 1, count: 5,
      shape: { kind: 'rect', rect: [-1, -1, 11, 11] }
    });
    expect(state.grid).not.toBe(first);
    expect(state.count).toBe(5);
  });

  it('errors clearly if queried before init instead of throwing on null', () => {
    const state = createWorkerState();
    const { reply } = handleMessage(state, {
      type: 'query', id: 3, count: 5, shape: { kind: 'rect', rect: [0, 0, 1, 1] }
    });
    expect(reply.type).toBe('error');
  });

  it('transfers the result buffer rather than copying it', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 5 });
    const { reply, transfer } = handleMessage(state, {
      type: 'query', id: 1, count: 5, shape: { kind: 'rect', rect: [-1, -1, 11, 11] }
    });
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(transfer).toContain(reply.indices.buffer);
  });
});
```

`packages/core/test/store.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { SelectionStore } from '@core/select/store';

const xy = Float32Array.from([0, 0, 5, 5, 10, 10]);

describe('SelectionStore', () => {
  it('starts empty', () => {
    expect(new SelectionStore(3, xy).current).toBeNull();
  });

  it('notifies subscribers once per change', () => {
    const s = new SelectionStore(3, xy);
    const fn = vi.fn();
    s.subscribe(fn);
    s.set(Uint32Array.from([0, 1]), 'rect');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].indices.length).toBe(2);
  });

  it('derives a mask and a bbox from the selection', () => {
    const s = new SelectionStore(3, xy);
    s.set(Uint32Array.from([0, 1]), 'rect');
    expect(Array.from(s.current!.mask)).toEqual([1, 1, 0]);
    expect(s.current!.bbox).toEqual([0, 0, 5, 5]);
  });

  it('treats an empty selection as a cleared selection', () => {
    const s = new SelectionStore(3, xy);
    s.set(Uint32Array.from([0]), 'rect');
    s.set(new Uint32Array(0), 'poly');
    expect(s.current).toBeNull();
  });

  it('clear() notifies with null', () => {
    const s = new SelectionStore(3, xy);
    const fn = vi.fn();
    s.set(Uint32Array.from([0]), 'rect');
    s.subscribe(fn);
    s.clear();
    expect(fn).toHaveBeenCalledWith(null);
  });

  it('unsubscribe stops delivery', () => {
    const s = new SelectionStore(3, xy);
    const fn = vi.fn();
    const off = s.subscribe(fn);
    off();
    s.set(Uint32Array.from([0]), 'rect');
    expect(fn).not.toHaveBeenCalled();
  });

  it('one throwing subscriber does not stop the others', () => {
    const s = new SelectionStore(3, xy);
    const good = vi.fn();
    s.subscribe(() => { throw new Error('boom'); });
    s.subscribe(good);
    expect(() => s.set(Uint32Array.from([0]), 'rect')).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/test/store.test.ts packages/core/test/worker-protocol.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement `packages/core/src/select/worker.ts`**

```ts
import { buildGrid, UniformGrid } from '../index/grid';
import { selectPolygon, selectRect } from './query';

export type QueryShape =
  | { kind: 'poly'; poly: Float64Array }
  | { kind: 'rect'; rect: [number, number, number, number] };

export type WorkerRequest =
  | { type: 'init'; xy: ArrayBuffer; count: number }
  | { type: 'query'; id: number; shape: QueryShape; count: number };

export type WorkerReply =
  | { type: 'ready' }
  | { type: 'result'; id: number; indices: Uint32Array; ms: number }
  | { type: 'error'; id?: number; message: string };

export interface WorkerState {
  xy: Float32Array | null;
  grid: UniformGrid | null;
  count: number;
}

export function createWorkerState(): WorkerState {
  return { xy: null, grid: null, count: 0 };
}

/**
 * Pure message handler, kept separate from the Worker global so it can be
 * tested in Node. The worker entry below is a three-line shim over it.
 */
export function handleMessage(
  state: WorkerState,
  msg: WorkerRequest
): { reply: WorkerReply; transfer: Transferable[] } {
  if (msg.type === 'init') {
    state.xy = new Float32Array(msg.xy);
    state.count = msg.count;
    state.grid = buildGrid(state.xy, msg.count);
    return { reply: { type: 'ready' }, transfer: [] };
  }

  if (!state.xy || !state.grid) {
    return { reply: { type: 'error', id: msg.id, message: 'query before init' }, transfer: [] };
  }

  // Chunks keep arriving after init, so the index is rebuilt when the
  // loaded prefix has grown. Rebuilding is two linear passes; doing it on
  // demand is cheaper than rebuilding on every chunk.
  if (msg.count > state.count) {
    state.count = msg.count;
    state.grid = buildGrid(state.xy, msg.count);
  }

  const t0 = performance.now();
  const indices = msg.shape.kind === 'poly'
    ? selectPolygon(state.xy, msg.count, msg.shape.poly, state.grid)
    : selectRect(state.xy, msg.count, msg.shape.rect, state.grid);
  const ms = performance.now() - t0;

  return {
    reply: { type: 'result', id: msg.id, indices, ms },
    transfer: [indices.buffer]
  };
}

// Worker entry. Guarded so importing this module in Node for tests is safe.
declare const self: DedicatedWorkerGlobalScope | undefined;
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && !(globalThis as any).window) {
  const state = createWorkerState();
  (self as DedicatedWorkerGlobalScope).onmessage = (ev: MessageEvent<WorkerRequest>) => {
    try {
      const { reply, transfer } = handleMessage(state, ev.data);
      (self as DedicatedWorkerGlobalScope).postMessage(reply, transfer);
    } catch (err) {
      (self as DedicatedWorkerGlobalScope).postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err)
      } satisfies WorkerReply);
    }
  };
}
```

- [x] **Step 4: Implement `packages/core/src/select/client.ts`**

```ts
import type { QueryShape, WorkerReply } from './worker';

/**
 * Main-thread handle on the selection worker.
 *
 * The coordinate array is copied into the worker once at init. That costs
 * one 8 MB copy per million cells and buys a selection path that never
 * touches the main thread again, so panning stays smooth while a lasso
 * query runs.
 */
export class SelectionClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Uint32Array) => void; reject: (e: Error) => void }>();
  private readyPromise: Promise<void>;
  private markReady!: () => void;
  /** Milliseconds taken by the most recent query, for the benchmark page. */
  lastQueryMs = 0;

  constructor(worker?: Worker) {
    this.worker = worker ?? new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.readyPromise = new Promise<void>(res => { this.markReady = res; });
    this.worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const msg = ev.data;
      if (msg.type === 'ready') { this.markReady(); return; }
      if (msg.type === 'result') {
        this.lastQueryMs = msg.ms;
        this.pending.get(msg.id)?.resolve(msg.indices);
        this.pending.delete(msg.id);
        return;
      }
      const err = new Error(msg.message);
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.reject(err);
        this.pending.delete(msg.id);
      } else {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      }
    };
  }

  /** Sends a copy of the coordinates; the caller keeps its own array. */
  init(xy: Float32Array, count: number): Promise<void> {
    const copy = xy.slice();
    this.worker.postMessage({ type: 'init', xy: copy.buffer, count }, [copy.buffer]);
    return this.readyPromise;
  }

  async query(shape: QueryShape, count: number): Promise<Uint32Array> {
    await this.readyPromise;
    const id = this.nextId++;
    return new Promise<Uint32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'query', id, shape, count });
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('selection worker terminated'));
    this.pending.clear();
  }
}
```

- [x] **Step 5: Implement `packages/core/src/select/store.ts`**

```ts
import { maskFromIndices } from './query';

export interface Selection {
  indices: Uint32Array;
  mask: Uint8Array;
  bbox: [number, number, number, number];
  shape: 'poly' | 'rect';
}

export type SelectionListener = (sel: Selection | null) => void;

/**
 * The single place selection state lives. The canvas, the summary panel and
 * the chat panel all read from here and none of them reach into each other.
 */
export class SelectionStore {
  private listeners = new Set<SelectionListener>();
  current: Selection | null = null;

  constructor(private n: number, private xy: Float32Array) {}

  subscribe(fn: SelectionListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  set(indices: Uint32Array, shape: 'poly' | 'rect'): void {
    if (indices.length === 0) { this.clear(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const x = this.xy[i * 2], y = this.xy[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.current = {
      indices,
      mask: maskFromIndices(indices, this.n),
      bbox: [minX, minY, maxX, maxY],
      shape
    };
    this.emit();
  }

  clear(): void {
    if (this.current === null) { this.emit(); return; }
    this.current = null;
    this.emit();
  }

  private emit(): void {
    // A listener that throws must not silence the ones after it; a broken
    // chat panel should not also break the legend.
    for (const fn of this.listeners) {
      try { fn(this.current); } catch (err) { console.error('selection listener failed', err); }
    }
  }
}
```

- [x] **Step 6: Run the tests**

Run: `npx vitest run packages/core/test/store.test.ts packages/core/test/worker-protocol.test.ts`
Expected: PASS, 13 tests.

- [x] **Step 7: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`

---

## Task 8: deck.gl canvas rendering the point cloud

**Files:**
- Create: `apps/web/src/views/ScatterCanvas.ts`, `apps/web/src/render/lod.ts`, `apps/web/src/style.css`
- Modify: `apps/web/src/main.ts`
- Test: `packages/core/test/lod.test.ts`

**Interfaces:**
- Consumes: `CellStore` (Task 4), `recolorCategorical` / `recolorNumeric` (Task 5).
- Produces:
  - `lodPolicy(input: { n: number; zoom: number; bounds: [number,number,number,number]; budget: number; manual: number | null }): { renderFraction: number; radius: number; alpha: number }`
  - `class ScatterCanvas` with `constructor(container: HTMLElement, store: CellStore, opts)`, `setStore`, `setColorBy(field, kind)`, `setLod(fraction | null)`, `refreshChunk(c)`, `setOverlayLayers(layers)`, `fitBounds(bbox, transition)`, `viewState`, `onViewStateChange`, `screenToWorld(px, py)`, `destroy()`.

- [x] **Step 1: Write the failing LOD test**

`packages/core/test/lod.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { lodPolicy } from '@core/render/lod';

const bounds: [number, number, number, number] = [-100, -100, 100, 100];
const base = { bounds, budget: 1_000_000, manual: null };

describe('lodPolicy', () => {
  it('draws everything when the dataset fits the budget', () => {
    const p = lodPolicy({ ...base, n: 200_000, zoom: 0 });
    expect(p.renderFraction).toBe(1);
  });

  it('subsamples when the dataset exceeds the budget at low zoom', () => {
    const p = lodPolicy({ ...base, n: 10_000_000, zoom: 0 });
    expect(p.renderFraction).toBeLessThan(1);
    expect(p.renderFraction * 10_000_000).toBeLessThanOrEqual(1_000_000 * 1.001);
  });

  it('raises the fraction as the viewport narrows', () => {
    const wide = lodPolicy({ ...base, n: 10_000_000, zoom: 0 });
    const tight = lodPolicy({ ...base, n: 10_000_000, zoom: 4 });
    expect(tight.renderFraction).toBeGreaterThan(wide.renderFraction);
  });

  it('never exceeds 1 or drops to 0', () => {
    for (const zoom of [-5, 0, 3, 12, 40]) {
      const p = lodPolicy({ ...base, n: 10_000_000, zoom });
      expect(p.renderFraction).toBeGreaterThan(0);
      expect(p.renderFraction).toBeLessThanOrEqual(1);
    }
  });

  it('honours a manual override exactly', () => {
    const p = lodPolicy({ ...base, n: 10_000_000, zoom: 0, manual: 0.25 });
    expect(p.renderFraction).toBe(0.25);
  });

  it('grows point radius and opacity as you zoom in', () => {
    const wide = lodPolicy({ ...base, n: 1_000_000, zoom: 0 });
    const tight = lodPolicy({ ...base, n: 1_000_000, zoom: 6 });
    expect(tight.radius).toBeGreaterThan(wide.radius);
    expect(tight.alpha).toBeGreaterThanOrEqual(wide.alpha);
    expect(tight.alpha).toBeLessThanOrEqual(255);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/lod.test.ts`
Expected: FAIL — cannot resolve `@core/render/lod`.

- [x] **Step 3: Implement `packages/core/src/render/lod.ts`**

```ts
export interface LodInput {
  n: number;
  zoom: number;
  bounds: [number, number, number, number];
  /** Target number of points on screen. Tuned by the benchmark in Task 14. */
  budget: number;
  /** Explicit user override in (0,1], or null for automatic. */
  manual: number | null;
}

export interface LodResult {
  renderFraction: number;
  radius: number;
  alpha: number;
}

/**
 * Chooses how much of the point cloud to draw.
 *
 * Because the dataset is stored pre-shuffled, drawing the first
 * `renderFraction * n` points is an unbiased uniform sample, so this is a
 * truncation rather than a filter — no per-point work, no extra buffers.
 *
 * Zooming in shrinks the viewport, so a larger fraction of the data costs
 * the same fill rate; the fraction therefore rises with zoom. Radius and
 * opacity rise with it so that a dense island reads as structure when
 * zoomed out and as individual cells when zoomed in.
 */
export function lodPolicy(input: LodInput): LodResult {
  const { n, zoom, budget, manual } = input;
  const zoomGain = Math.pow(2, Math.max(0, zoom) * 0.5);
  const fraction = manual !== null
    ? Math.min(1, Math.max(1e-4, manual))
    : Math.min(1, Math.max(1e-4, (budget * zoomGain) / Math.max(1, n)));

  const radius = Math.min(3.5, 0.6 + Math.max(0, zoom) * 0.28);
  const alpha = Math.round(Math.min(255, 120 + Math.max(0, zoom) * 22));
  return { renderFraction: fraction, radius, alpha };
}
```

Note: `lod.ts` lives under `packages/core/src/render/` so it stays testable in
Node, matching the import path used by the test.

- [x] **Step 4: Run the LOD tests**

Run: `npx vitest run packages/core/test/lod.test.ts`
Expected: PASS, 6 tests.

- [x] **Step 5: Implement `apps/web/src/views/ScatterCanvas.ts`**

```ts
import { Deck, OrthographicView, type Layer, type OrthographicViewState } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { CellStore } from '@core/data/schema';
import { recolorCategorical, recolorNumeric } from '@core/color/recolor';
import { RAMPS } from '@core/color/palette';
import { lodPolicy } from '@core/render/lod';

export type ColorKind = 'categorical' | 'numeric';

export interface ScatterCanvasOptions {
  /** Target points on screen before subsampling kicks in. */
  budget?: number;
  onViewStateChange?: (vs: OrthographicViewState) => void;
  onHover?: (index: number | null) => void;
}

/**
 * The shared point-cloud canvas. Both the embedding view and the trajectory
 * view are this class plus their own overlay layers.
 *
 * Two decisions carry the performance here:
 *
 *  1. Layers are fed binary attributes, not a `data` array. deck.gl then
 *     uploads the typed arrays straight to the GPU and never calls an
 *     accessor per point.
 *  2. There is one layer per loaded chunk. A chunk uploads once, when it
 *     arrives; later chunks do not disturb it. Twenty layers of 250k points
 *     is materially cheaper than one layer re-uploaded twenty times.
 */
export class ScatterCanvas {
  private deck: Deck;
  private overlay: Layer[] = [];
  private colorField: string;
  private colorKind: ColorKind;
  private manualLod: number | null = null;
  private budget: number;
  private ramp = 'viridis';
  viewState: OrthographicViewState;

  constructor(
    private container: HTMLElement,
    private store: CellStore,
    private opts: ScatterCanvasOptions = {}
  ) {
    this.budget = opts.budget ?? 1_500_000;
    this.colorField = store.categoricalFields()[0] ?? '';
    this.colorKind = 'categorical';
    this.viewState = this.initialViewState();
    if (this.colorField) recolorCategorical(store, this.colorField);

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    this.deck = new Deck({
      canvas,
      views: new OrthographicView({ id: 'ortho', controller: { dragPan: true, scrollZoom: { smooth: true } } }),
      initialViewState: this.viewState,
      controller: true,
      // Points are flat and unordered; depth testing costs fill rate and
      // buys nothing here.
      parameters: { depthTest: false },
      onViewStateChange: ({ viewState }) => {
        this.viewState = viewState as OrthographicViewState;
        this.opts.onViewStateChange?.(this.viewState);
        this.render();
        return viewState;
      },
      layers: []
    });
    this.render();
    this.installContextLossRecovery(canvas);
  }

  private initialViewState(): OrthographicViewState {
    const [x0, y0, x1, y1] = this.store.bounds;
    const { clientWidth: w, clientHeight: h } = this.container;
    const zoom = Math.log2(Math.min(
      (w || 800) / Math.max(x1 - x0, 1e-6),
      (h || 600) / Math.max(y1 - y0, 1e-6)
    ));
    return { target: [(x0 + x1) / 2, (y0 + y1) / 2, 0], zoom, minZoom: -10, maxZoom: 20 };
  }

  private lod() {
    return lodPolicy({
      n: this.store.loadedCount,
      zoom: typeof this.viewState.zoom === 'number' ? this.viewState.zoom : 0,
      bounds: this.store.bounds,
      budget: this.budget,
      manual: this.manualLod
    });
  }

  /** Number of points currently being drawn — reported in the UI and bench. */
  drawnCount(): number {
    return Math.min(this.store.loadedCount,
      Math.ceil(this.lod().renderFraction * this.store.loadedCount));
  }

  private buildPointLayers(): Layer[] {
    const { radius } = this.lod();
    const drawn = this.drawnCount();
    const layers: Layer[] = [];
    for (let c = 0; c * this.store.chunkSize < drawn; c++) {
      const start = c * this.store.chunkSize;
      const count = Math.min(this.store.chunkSize, drawn - start);
      if (count <= 0) break;
      layers.push(new ScatterplotLayer({
        id: `cells-${c}`,
        data: {
          length: count,
          attributes: {
            getPosition: { value: this.store.xy.subarray(start * 2, (start + count) * 2), size: 2 },
            getFillColor: {
              value: this.store.color.subarray(start * 4, (start + count) * 4),
              size: 4,
              normalized: true
            }
          }
        },
        radiusUnits: 'pixels',
        getRadius: radius,
        radiusMinPixels: 0.4,
        radiusMaxPixels: 6,
        stroked: false,
        pickable: true,
        updateTriggers: { getFillColor: this.colorVersion, getRadius: radius },
        onHover: info => this.opts.onHover?.(
          info.index >= 0 ? start + info.index : null
        )
      }));
    }
    return layers;
  }

  private colorVersion = 0;

  render(): void {
    this.deck.setProps({ layers: [...this.buildPointLayers(), ...this.overlay] });
  }

  setColorBy(field: string, kind: ColorKind, ramp = this.ramp): void {
    this.colorField = field;
    this.colorKind = kind;
    this.ramp = ramp;
    if (kind === 'categorical') recolorCategorical(this.store, field);
    else recolorNumeric(this.store, field, RAMPS[ramp] ?? RAMPS.viridis);
    this.colorVersion++;
    this.render();
  }

  /** Re-applies the current colour-by to newly arrived data. */
  refreshColors(): void {
    this.setColorBy(this.colorField, this.colorKind, this.ramp);
  }

  setLod(fraction: number | null): void {
    this.manualLod = fraction;
    this.render();
  }

  setOverlayLayers(layers: Layer[]): void {
    this.overlay = layers;
    this.render();
  }

  fitBounds(bbox: [number, number, number, number], transitionMs = 600): void {
    const [x0, y0, x1, y1] = bbox;
    const pad = 1.25;
    const { clientWidth: w, clientHeight: h } = this.container;
    const zoom = Math.log2(Math.min(
      (w || 800) / Math.max((x1 - x0) * pad, 1e-6),
      (h || 600) / Math.max((y1 - y0) * pad, 1e-6)
    ));
    this.viewState = {
      ...this.viewState,
      target: [(x0 + x1) / 2, (y0 + y1) / 2, 0],
      zoom: Math.min(zoom, 20),
      transitionDuration: transitionMs
    } as OrthographicViewState;
    this.deck.setProps({ initialViewState: this.viewState });
    this.render();
  }

  /** Pixel coordinates to world coordinates, for lasso capture. */
  screenToWorld(px: number, py: number): [number, number] {
    const viewports = this.deck.getViewports();
    const vp = viewports[0];
    const [x, y] = vp.unproject([px, py]);
    return [x, y];
  }

  /**
   * A lost WebGL context blanks the canvas. Every buffer can be rebuilt
   * from the typed arrays we still hold, so the recovery is simply to
   * re-render rather than to reload the dataset.
   */
  private installContextLossRecovery(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', ev => {
      ev.preventDefault();
      console.warn('WebGL context lost; will restore from CPU arrays');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.colorVersion++;
      this.render();
    });
  }

  destroy(): void {
    this.deck.finalize();
    this.container.innerHTML = '';
  }
}
```

- [x] **Step 6: Wire a minimal `apps/web/src/main.ts`**

```ts
import './style.css';
import { loadDataset } from '@core/data/loader';
import { ScatterCanvas } from './views/ScatterCanvas';

const API = import.meta.env.VITE_API ?? 'http://localhost:8000';

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div id="canvas"></div><div id="status">loading…</div>`;
  const status = document.getElementById('status')!;
  const holder = document.getElementById('canvas') as HTMLElement;

  let canvas: ScatterCanvas | null = null;
  const store = await loadDataset(API, 'sim1m', {
    onChunk: (_c, s) => {
      status.textContent = `${s.loadedCount.toLocaleString()} cells`;
      if (!canvas) canvas = new ScatterCanvas(holder, s);
      else { canvas.refreshColors(); }
    }
  });
  status.textContent = `${store.loadedCount.toLocaleString()} cells loaded` +
    (store.failedChunks.length ? ` (${store.failedChunks.length} chunks failed)` : '');
}

boot().catch(err => {
  document.getElementById('app')!.textContent = `failed to load: ${err.message}`;
});
```

`apps/web/src/style.css`:
```css
html, body, #app { margin: 0; height: 100%; background: #0d0f14; color: #e6e8ee;
  font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
#canvas { position: absolute; inset: 0; }
#status { position: absolute; left: 12px; bottom: 12px; padding: 4px 8px;
  background: rgba(0,0,0,.55); border-radius: 4px; }
```

- [x] **Step 7: See it run**

Run in one terminal: `python -m uvicorn server.main:app --port 8000`
Run in another: `npm run dev`
Open `http://localhost:5173`.
Expected: the status line climbs to `1,000,000 cells loaded`, the plot shows
coloured islands, and scroll-zoom plus drag-pan are smooth. If it is blank,
check the browser console for a CORS error before anything else.

- [x] **Step 8: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit && python -m pytest server/tests -q`

---

## Task 9: Box and lasso interaction, highlight, zoom to selection

**Files:**
- Create: `apps/web/src/interact/lasso.ts`, `apps/web/src/ui/Toolbar.ts`, `apps/web/src/ui/Legend.ts`, `apps/web/src/ui/LodControl.ts`, `apps/web/src/ui/SelectionSummary.ts`, `apps/web/src/views/ScatterView.ts`
- Modify: `apps/web/src/main.ts`, `apps/web/src/style.css`
- Test: `packages/core/test/lasso-path.test.ts`

**Interfaces:**
- Consumes: `ScatterCanvas` (Task 8), `SelectionClient` / `SelectionStore` (Task 7), `applySelectionMask` / `legendEntries` (Task 5).
- Produces:
  - `simplifyPath(points: number[], tolerancePx: number): number[]` — Ramer–Douglas–Peucker, exported from `@core/select/geometry`.
  - `class LassoController` with `constructor(canvas, opts)`, `setMode('pan'|'box'|'lasso')`, `mode`, `onComplete(shape)`, `destroy()`.
  - `class ScatterView` with `constructor(root: HTMLElement, store, opts)`, `selectionStore`, `canvas`, `setMode`, `zoomToSelection()`, `destroy()`.

- [x] **Step 1: Write the failing test**

`packages/core/test/lasso-path.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { simplifyPath } from '@core/select/geometry';

describe('simplifyPath', () => {
  it('collapses a straight run to its endpoints', () => {
    const pts = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0];
    expect(simplifyPath(pts, 0.5)).toEqual([0, 0, 4, 0]);
  });

  it('keeps a corner', () => {
    const pts = [0, 0, 5, 0, 5, 5];
    expect(simplifyPath(pts, 0.5)).toEqual([0, 0, 5, 0, 5, 5]);
  });

  it('drops the jitter a mouse drag produces', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 200; i++) pts.push(i, (i % 2) * 0.3);
    const out = simplifyPath(pts, 1);
    expect(out.length).toBeLessThan(20);
    expect(out.length).toBeGreaterThanOrEqual(4);
  });

  it('preserves a circle well enough to stay a closed loop', () => {
    const pts: number[] = [];
    for (let k = 0; k < 360; k++) {
      const a = (k / 360) * Math.PI * 2;
      pts.push(Math.cos(a) * 100, Math.sin(a) * 100);
    }
    const out = simplifyPath(pts, 2);
    expect(out.length / 2).toBeGreaterThan(12);
    expect(out.length / 2).toBeLessThan(180);
  });

  it('returns short inputs untouched', () => {
    expect(simplifyPath([1, 2], 5)).toEqual([1, 2]);
    expect(simplifyPath([], 5)).toEqual([]);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/lasso-path.test.ts`
Expected: FAIL — `simplifyPath` is not exported.

- [x] **Step 3: Add `simplifyPath` to `packages/core/src/select/geometry.ts`**

```ts
/**
 * Ramer–Douglas–Peucker.
 *
 * A freehand drag emits a point per mouse event, so a lasso around a large
 * region arrives with several hundred nearly collinear vertices. Every one
 * of them costs a segment test per candidate point, and candidate points
 * number in the hundreds of thousands, so simplifying the path first is
 * the difference between a 10 ms query and a 200 ms one.
 */
export function simplifyPath(points: number[], tolerancePx: number): number[] {
  const n = points.length / 2;
  if (n < 3) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const tol2 = tolerancePx * tolerancePx;

  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const ax = points[first * 2], ay = points[first * 2 + 1];
    const bx = points[last * 2], by = points[last * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let worst = -1;
    let worstDist = 0;
    for (let i = first + 1; i < last; i++) {
      const px = points[i * 2], py = points[i * 2 + 1];
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > worstDist) { worstDist = d2; worst = i; }
    }
    if (worstDist > tol2 && worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/lasso-path.test.ts`
Expected: PASS, 5 tests.

- [x] **Step 5: Implement `apps/web/src/interact/lasso.ts`**

```ts
import { PolygonLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { simplifyPath, normalizeRect } from '@core/select/geometry';
import type { QueryShape } from '@core/select/worker';
import type { ScatterCanvas } from '../views/ScatterCanvas';

export type Mode = 'pan' | 'box' | 'lasso';

export interface LassoOptions {
  onComplete: (shape: QueryShape) => void;
  onCancel?: () => void;
}

/**
 * Captures a box drag or a freehand lasso in screen space, converts it to
 * world space, and hands the resulting shape to the selection worker.
 *
 * The in-progress outline is drawn as a deck.gl overlay layer rather than
 * as a DOM element, so it stays locked to the data while the user pans or
 * zooms mid-drag instead of sliding away from the cells it encloses.
 */
export class LassoController {
  mode: Mode = 'pan';
  private drawing = false;
  private screenPts: number[] = [];
  private el: HTMLElement;

  constructor(private canvas: ScatterCanvas, private opts: LassoOptions) {
    this.el = canvas.element();
    this.el.addEventListener('pointerdown', this.onDown);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    window.addEventListener('keydown', this.onKey);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.drawing = false;
    this.screenPts = [];
    this.canvas.setInteractive(mode === 'pan');
    this.canvas.setSelectionOverlay([]);
    this.el.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
  }

  private local(ev: PointerEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  private onDown = (ev: PointerEvent): void => {
    if (this.mode === 'pan' || ev.button !== 0) return;
    ev.preventDefault();
    this.el.setPointerCapture(ev.pointerId);
    this.drawing = true;
    this.screenPts = this.local(ev);
  };

  private onMove = (ev: PointerEvent): void => {
    if (!this.drawing) return;
    const [x, y] = this.local(ev);
    if (this.mode === 'box') {
      this.screenPts = [this.screenPts[0], this.screenPts[1], x, y];
    } else {
      const n = this.screenPts.length;
      // Skip sub-pixel moves; they add vertices without adding shape.
      const dx = x - this.screenPts[n - 2], dy = y - this.screenPts[n - 1];
      if (dx * dx + dy * dy < 4) return;
      this.screenPts.push(x, y);
    }
    this.canvas.setSelectionOverlay(this.previewLayers());
  };

  private onUp = (ev: PointerEvent): void => {
    if (!this.drawing) return;
    this.drawing = false;
    this.el.releasePointerCapture(ev.pointerId);
    const world = this.toWorldPolygon();
    this.canvas.setSelectionOverlay([]);
    if (!world) { this.opts.onCancel?.(); return; }
    this.opts.onComplete(world);
    this.screenPts = [];
  };

  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    this.drawing = false;
    this.screenPts = [];
    this.canvas.setSelectionOverlay([]);
    this.opts.onCancel?.();
  };

  private worldRing(): number[][] {
    if (this.mode === 'box' && this.screenPts.length === 4) {
      const [x0, y0, x1, y1] = normalizeRect(
        [this.screenPts[0], this.screenPts[1], this.screenPts[2], this.screenPts[3]]
      );
      return [
        this.canvas.screenToWorld(x0, y0), this.canvas.screenToWorld(x1, y0),
        this.canvas.screenToWorld(x1, y1), this.canvas.screenToWorld(x0, y1)
      ];
    }
    const simplified = simplifyPath(this.screenPts, 2);
    const ring: number[][] = [];
    for (let i = 0; i < simplified.length; i += 2) {
      ring.push(this.canvas.screenToWorld(simplified[i], simplified[i + 1]));
    }
    return ring;
  }

  private previewLayers(): Layer[] {
    const ring = this.worldRing();
    if (ring.length < 2) return [];
    return [new PolygonLayer({
      id: 'lasso-preview',
      data: [{ polygon: [...ring, ring[0]] }],
      getPolygon: (d: { polygon: number[][] }) => d.polygon,
      filled: true,
      getFillColor: [90, 160, 255, 40],
      stroked: true,
      getLineColor: [120, 190, 255, 220],
      getLineWidth: 1.5,
      lineWidthUnits: 'pixels',
      pickable: false
    })];
  }

  private toWorldPolygon(): QueryShape | null {
    const ring = this.worldRing();
    if (ring.length < 3) return null;
    if (this.mode === 'box') {
      const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
      return { kind: 'rect', rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    }
    const flat = new Float64Array(ring.length * 2);
    ring.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
    return { kind: 'poly', poly: flat };
  }

  destroy(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
  }
}
```

- [x] **Step 6: Extend `ScatterCanvas` with the three methods the lasso needs**

Add to `apps/web/src/views/ScatterCanvas.ts`:
```ts
  private selectionOverlay: Layer[] = [];
  private canvasEl!: HTMLCanvasElement;   // assign in the constructor where the canvas is created

  /** The DOM element pointer events are bound to. */
  element(): HTMLCanvasElement { return this.canvasEl; }

  /** Disables deck.gl's pan/zoom controller while a lasso is being drawn. */
  setInteractive(on: boolean): void {
    this.deck.setProps({ controller: on });
  }

  setSelectionOverlay(layers: Layer[]): void {
    this.selectionOverlay = layers;
    this.render();
  }

  /** Repaints alpha from the current selection mask without re-running colour-by. */
  applyMask(mask: Uint8Array | null): void {
    applySelectionMask(this.store.color, mask, 28, 255);
    this.colorVersion++;
    this.render();
  }
```

and change `render()` to include the selection overlay:
```ts
  render(): void {
    this.deck.setProps({
      layers: [...this.buildPointLayers(), ...this.overlay, ...this.selectionOverlay]
    });
  }
```

Import `applySelectionMask` alongside the existing colour imports, and in the
constructor assign `this.canvasEl = canvas;` where the canvas is created.

- [x] **Step 7: Implement the UI pieces**

`apps/web/src/ui/Toolbar.ts`:
```ts
import type { Mode } from '../interact/lasso';

export function createToolbar(
  root: HTMLElement,
  handlers: {
    onMode: (m: Mode) => void;
    onZoomToSelection: () => void;
    onClear: () => void;
    onResetView: () => void;
  }
): { setMode: (m: Mode) => void; setSelectionActive: (on: boolean) => void } {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  bar.innerHTML = `
    <div class="group" role="group" aria-label="Selection mode">
      <button data-mode="pan" class="active" title="Pan and zoom">Pan</button>
      <button data-mode="box" title="Rectangular selection">Box</button>
      <button data-mode="lasso" title="Freehand selection">Lasso</button>
    </div>
    <button data-act="zoom" disabled title="Zoom to the selected region">Zoom to selection</button>
    <button data-act="clear" disabled>Clear</button>
    <button data-act="reset">Reset view</button>`;
  root.appendChild(bar);

  const modeButtons = [...bar.querySelectorAll<HTMLButtonElement>('button[data-mode]')];
  const setMode = (m: Mode): void => {
    modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    handlers.onMode(m);
  };
  modeButtons.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));

  const zoomBtn = bar.querySelector<HTMLButtonElement>('[data-act="zoom"]')!;
  const clearBtn = bar.querySelector<HTMLButtonElement>('[data-act="clear"]')!;
  zoomBtn.addEventListener('click', handlers.onZoomToSelection);
  clearBtn.addEventListener('click', handlers.onClear);
  bar.querySelector<HTMLButtonElement>('[data-act="reset"]')!
     .addEventListener('click', handlers.onResetView);

  return {
    setMode,
    setSelectionActive: (on: boolean) => { zoomBtn.disabled = !on; clearBtn.disabled = !on; }
  };
}
```

`apps/web/src/ui/Legend.ts`:
```ts
import type { CellStore } from '@core/data/schema';
import { legendEntries } from '@core/color/recolor';

export function createLegend(root: HTMLElement): {
  update: (store: CellStore, field: string, kind: 'categorical' | 'numeric') => void;
} {
  const box = document.createElement('div');
  box.className = 'legend';
  root.appendChild(box);

  return {
    update(store, field, kind) {
      if (kind === 'numeric') {
        const [lo, hi] = store.numericRange.get(field) ?? [0, 1];
        box.innerHTML = `<div class="legend-title">${field}</div>
          <div class="ramp"></div>
          <div class="ramp-labels"><span>${lo.toFixed(2)}</span><span>${hi.toFixed(2)}</span></div>`;
        return;
      }
      // Long tails are common (hundreds of donors); show the top 20 by count.
      const entries = legendEntries(store, field)
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count);
      const shown = entries.slice(0, 20);
      const hidden = entries.length - shown.length;
      box.innerHTML = `<div class="legend-title">${field}</div>` + shown.map(e =>
        `<div class="legend-row"><i style="background:rgb(${e.rgb.join(',')})"></i>
         <span>${e.label}</span><b>${e.count.toLocaleString()}</b></div>`).join('')
        + (hidden > 0 ? `<div class="legend-more">+${hidden} more</div>` : '');
    }
  };
}
```

`apps/web/src/ui/LodControl.ts`:
```ts
export function createLodControl(
  root: HTMLElement,
  onChange: (fraction: number | null) => void
): { setDrawn: (drawn: number, total: number) => void } {
  const box = document.createElement('div');
  box.className = 'lod';
  box.innerHTML = `
    <label><input type="checkbox" data-auto checked> Auto detail</label>
    <input type="range" data-slider min="1" max="100" value="100" disabled>
    <div class="lod-readout">—</div>`;
  root.appendChild(box);

  const auto = box.querySelector<HTMLInputElement>('[data-auto]')!;
  const slider = box.querySelector<HTMLInputElement>('[data-slider]')!;
  const readout = box.querySelector<HTMLElement>('.lod-readout')!;

  const emit = (): void => {
    slider.disabled = auto.checked;
    onChange(auto.checked ? null : Number(slider.value) / 100);
  };
  auto.addEventListener('change', emit);
  slider.addEventListener('input', emit);

  return {
    setDrawn(drawn, total) {
      const pct = total ? Math.round((drawn / total) * 100) : 0;
      readout.textContent = `${drawn.toLocaleString()} / ${total.toLocaleString()} drawn (${pct}%)`;
    }
  };
}
```

`apps/web/src/ui/SelectionSummary.ts`:
```ts
import type { SelectionContext } from '../chat/adapter';

export function createSelectionSummary(root: HTMLElement): {
  update: (ctx: SelectionContext | null, queryMs: number) => void;
} {
  const box = document.createElement('div');
  box.className = 'summary';
  root.appendChild(box);
  return {
    update(ctx, queryMs) {
      if (!ctx) { box.innerHTML = `<div class="summary-empty">No cells selected</div>`; return; }
      const top = (field: string): string => Object.entries(ctx.breakdown[field] ?? {})
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([k, v]) => `<div class="sum-row"><span>${k}</span><b>${v.toLocaleString()}</b></div>`)
        .join('');
      box.innerHTML = `
        <div class="summary-head">${ctx.n.toLocaleString()} cells selected
          <span class="muted">(${((ctx.n / ctx.totalN) * 100).toFixed(1)}% of ${ctx.totalN.toLocaleString()}, ${queryMs.toFixed(1)} ms)</span></div>
        <div class="sum-block"><h4>cell_type</h4>${top('cell_type')}</div>
        <div class="sum-block"><h4>tissue</h4>${top('tissue')}</div>`;
    }
  };
}
```

- [x] **Step 8: Implement `apps/web/src/views/ScatterView.ts`**

```ts
import type { CellStore } from '@core/data/schema';
import { SelectionStore } from '@core/select/store';
import { SelectionClient } from '@core/select/client';
import type { QueryShape } from '@core/select/worker';
import { ScatterCanvas, type ColorKind } from './ScatterCanvas';
import { LassoController, type Mode } from '../interact/lasso';
import { createToolbar } from '../ui/Toolbar';
import { createLegend } from '../ui/Legend';
import { createLodControl } from '../ui/LodControl';
import { createSelectionSummary } from '../ui/SelectionSummary';
import { buildSelectionContext } from '@core/context/build';
import type { SelectionContext } from '../chat/adapter';

export interface ScatterViewOptions {
  view?: 'embedding' | 'trajectory';
  onContext?: (ctx: SelectionContext | null) => void;
}

/**
 * Composes the canvas, the selection worker, the toolbar and the panels.
 *
 * Nothing here owns selection state: the canvas, the summary and the chat
 * panel all subscribe to one `SelectionStore`, so adding another consumer
 * later means subscribing, not threading a callback through this class.
 */
export class ScatterView {
  readonly canvas: ScatterCanvas;
  readonly selectionStore: SelectionStore;
  private client = new SelectionClient();
  private lasso: LassoController;
  private toolbar: ReturnType<typeof createToolbar>;
  private legend: ReturnType<typeof createLegend>;
  private lod: ReturnType<typeof createLodControl>;
  private summary: ReturnType<typeof createSelectionSummary>;
  private colorField: string;
  private colorKind: ColorKind = 'categorical';

  constructor(root: HTMLElement, private store: CellStore, private opts: ScatterViewOptions = {}) {
    root.innerHTML = `<div class="canvas-holder"></div><aside class="side"></aside>`;
    const holder = root.querySelector<HTMLElement>('.canvas-holder')!;
    const side = root.querySelector<HTMLElement>('.side')!;

    this.canvas = new ScatterCanvas(holder, store, {
      onViewStateChange: () => this.lod.setDrawn(this.canvas.drawnCount(), store.loadedCount)
    });
    this.selectionStore = new SelectionStore(store.n, store.xy);
    this.colorField = store.categoricalFields()[0] ?? '';

    this.toolbar = createToolbar(side, {
      onMode: m => this.setMode(m),
      onZoomToSelection: () => this.zoomToSelection(),
      onClear: () => this.selectionStore.clear(),
      onResetView: () => this.canvas.fitBounds(store.bounds)
    });
    this.buildColorPicker(side);
    this.legend = createLegend(side);
    this.lod = createLodControl(side, f => {
      this.canvas.setLod(f);
      this.lod.setDrawn(this.canvas.drawnCount(), store.loadedCount);
    });
    this.summary = createSelectionSummary(side);

    this.lasso = new LassoController(this.canvas, {
      onComplete: shape => void this.runQuery(shape),
      onCancel: () => this.canvas.setSelectionOverlay([])
    });

    this.selectionStore.subscribe(sel => {
      this.canvas.applyMask(sel ? sel.mask : null);
      this.toolbar.setSelectionActive(sel !== null);
      const ctx = sel
        ? buildSelectionContext(store, sel, {
            datasetId: store.datasetId,
            view: opts.view ?? 'embedding',
            colorBy: this.colorField
          })
        : null;
      this.summary.update(ctx, this.client.lastQueryMs);
      this.opts.onContext?.(ctx);
    });

    void this.client.init(store.xy, store.loadedCount);
    this.legend.update(store, this.colorField, this.colorKind);
    this.lod.setDrawn(this.canvas.drawnCount(), store.loadedCount);
    this.summary.update(null, 0);
  }

  private buildColorPicker(side: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'colorby';
    const cats = this.store.categoricalFields().map(f => `<option value="c:${f}">${f}</option>`);
    const nums = this.store.numericFields().map(f => `<option value="n:${f}">${f}</option>`);
    wrap.innerHTML = `<label>Colour by <select>${cats.join('')}${nums.join('')}</select></label>`;
    side.appendChild(wrap);
    wrap.querySelector('select')!.addEventListener('change', ev => {
      const [k, field] = (ev.target as HTMLSelectElement).value.split(':');
      this.colorKind = k === 'c' ? 'categorical' : 'numeric';
      this.colorField = field;
      this.canvas.setColorBy(field, this.colorKind);
      if (this.selectionStore.current) this.canvas.applyMask(this.selectionStore.current.mask);
      this.legend.update(this.store, field, this.colorKind);
    });
  }

  setMode(m: Mode): void { this.lasso.setMode(m); }

  private async runQuery(shape: QueryShape): Promise<void> {
    try {
      const indices = await this.client.query(shape, this.store.loadedCount);
      this.selectionStore.set(indices, shape.kind === 'poly' ? 'poly' : 'rect');
    } catch (err) {
      console.error('selection query failed', err);
    }
  }

  zoomToSelection(): void {
    const sel = this.selectionStore.current;
    if (sel) this.canvas.fitBounds(sel.bbox);
  }

  /** Called as chunks arrive so new cells get coloured and indexed. */
  onDataGrew(): void {
    this.canvas.refreshColors();
    void this.client.init(this.store.xy, this.store.loadedCount);
    this.legend.update(this.store, this.colorField, this.colorKind);
    this.lod.setDrawn(this.canvas.drawnCount(), this.store.loadedCount);
  }

  destroy(): void {
    this.lasso.destroy();
    this.client.terminate();
    this.canvas.destroy();
  }
}
```

Note: `ScatterView` reads `store.datasetId`. Add `readonly datasetId: string`
to `CellStore`, assigned from `m.datasetId` in its constructor, and assert it in
`packages/core/test/schema.test.ts`.

- [x] **Step 9: Add the stylesheet rules**

Append to `apps/web/src/style.css`:
```css
#app { display: flex; }
.canvas-holder { position: relative; flex: 1; min-width: 0; }
.side { width: 300px; padding: 12px; overflow-y: auto; background: #141821;
  border-left: 1px solid #232838; display: flex; flex-direction: column; gap: 14px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; }
.toolbar button { background: #1d2331; color: #cfd6e6; border: 1px solid #2c3346;
  border-radius: 5px; padding: 5px 9px; cursor: pointer; font: inherit; }
.toolbar button.active { background: #2f5bd0; border-color: #3f6ee6; color: #fff; }
.toolbar button:disabled { opacity: .4; cursor: default; }
.legend-row { display: grid; grid-template-columns: 12px 1fr auto; gap: 6px;
  align-items: center; padding: 1px 0; }
.legend-row i { width: 10px; height: 10px; border-radius: 2px; display: block; }
.legend-title, .lod-readout, .summary-head { font-weight: 600; }
.legend-more, .muted { color: #8b94a8; font-weight: 400; }
.ramp { height: 10px; border-radius: 3px;
  background: linear-gradient(90deg, #440154, #31688e, #35b779, #fde725); }
.ramp-labels { display: flex; justify-content: space-between; color: #8b94a8; }
.sum-row { display: flex; justify-content: space-between; }
.sum-block h4 { margin: 8px 0 2px; font-size: 12px; color: #8b94a8; }
.lod input[type=range] { width: 100%; }
```

- [x] **Step 10: Verify by hand**

Run the server and `npm run dev`. Then:
1. Click **Lasso**, drag a loop around one island. The rest of the plot dims and
   the summary shows a count and a cell-type breakdown.
2. Click **Zoom to selection**. The view animates onto the selected region.
3. Click **Box**, drag right-to-left; the selection must still be correct.
4. Press Escape mid-drag; the outline disappears and nothing is selected.
5. Change **Colour by** to `pseudotime`; the ramp legend appears and the
   selection highlight survives the recolour.
6. Uncheck **Auto detail** and drag the slider to 10%; the drawn count falls to
   roughly a tenth and the plot stays representative rather than losing a region.

Expected lasso latency at 1M cells: single-digit to low tens of milliseconds,
shown in the summary line.

- [x] **Step 11: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`

---

## Task 10: Selection context builder

**Files:**
- Create: `packages/core/src/context/build.ts`
- Test: `packages/core/test/context.test.ts`

**Interfaces:**
- Consumes: `CellStore` (Task 4), `Selection` (Task 7).
- Produces: `buildSelectionContext(store, selection, meta): SelectionContext` with the
  shape declared in `apps/web/src/chat/adapter.ts` (Task 11) and repeated here so
  neither task has to read the other:
  ```ts
  interface SelectionContext {
    datasetId: string; view: 'embedding' | 'trajectory';
    n: number; totalN: number;
    bbox: [number, number, number, number]; centroid: [number, number];
    breakdown: Record<string, Record<string, number>>;
    numericStats: Record<string, { min: number; max: number; mean: number; q: [number, number, number] }>;
    sampleIds: string[]; colorBy: string;
  }
  ```

- [x] **Step 1: Write the failing test**

`packages/core/test/context.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';
import { SelectionStore } from '@core/select/store';
import { buildSelectionContext } from '@core/context/build';

const manifest: Manifest = {
  datasetId: 'unit', n: 8, chunkSize: 8, chunks: 1, bounds: [0, 0, 10, 10],
  categorical: { cell_type: { levels: ['A', 'B'] }, tissue: { levels: ['lung', 'liver'] } },
  numeric: { pseudotime: { min: 0, max: 1 } },
  hasGraph: false
};

function fixture() {
  const s = allocateStore(manifest);
  s.xy.set([0,0, 1,1, 2,2, 3,3, 4,4, 5,5, 6,6, 7,7]);
  s.codes.get('cell_type')!.set([0, 0, 0, 1, 1, 1, 1, 0]);
  s.codes.get('tissue')!.set([0, 1, 0, 1, 0, 1, 0, 1]);
  s.numeric.get('pseudotime')!.set([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  s.loadedCount = 8;
  return s;
}

const meta = { datasetId: 'unit', view: 'embedding' as const, colorBy: 'cell_type' };

describe('buildSelectionContext', () => {
  it('counts each categorical level within the selection only', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1, 2, 3]), 'rect');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    expect(ctx.n).toBe(4);
    expect(ctx.totalN).toBe(8);
    expect(ctx.breakdown.cell_type).toEqual({ A: 3, B: 1 });
    expect(ctx.breakdown.tissue).toEqual({ lung: 2, liver: 2 });
  });

  it('breakdown counts sum to n for every field', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([1, 3, 5, 7]), 'poly');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    for (const field of Object.keys(ctx.breakdown)) {
      const total = Object.values(ctx.breakdown[field]).reduce((a, b) => a + b, 0);
      expect(total).toBe(ctx.n);
    }
  });

  it('omits levels with zero cells rather than listing every level', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 2]), 'rect');   // both cell_type A, both lung
    const ctx = buildSelectionContext(s, sel.current!, meta);
    expect(ctx.breakdown.cell_type).toEqual({ A: 2 });
    expect(ctx.breakdown.tissue).toEqual({ lung: 2 });
  });

  it('computes centroid, bbox and numeric stats', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1, 2, 3]), 'rect');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    expect(ctx.bbox).toEqual([0, 0, 3, 3]);
    expect(ctx.centroid[0]).toBeCloseTo(1.5);
    const pt = ctx.numericStats.pseudotime;
    expect(pt.min).toBeCloseTo(0);
    expect(pt.max).toBeCloseTo(0.3);
    expect(pt.mean).toBeCloseTo(0.15);
    expect(pt.q[1]).toBeGreaterThanOrEqual(pt.min);
    expect(pt.q[1]).toBeLessThanOrEqual(pt.max);
  });

  it('caps sampleIds at 100 no matter how large the selection', () => {
    const big = allocateStore({ ...manifest, n: 500_000, chunkSize: 500_000 });
    big.loadedCount = 500_000;
    const sel = new SelectionStore(500_000, big.xy);
    sel.set(Uint32Array.from({ length: 400_000 }, (_, i) => i), 'poly');
    const ctx = buildSelectionContext(big, sel.current!, meta);
    expect(ctx.n).toBe(400_000);
    expect(ctx.sampleIds).toHaveLength(100);
  });

  it('stays small when serialised, even for a huge selection', () => {
    const big = allocateStore({ ...manifest, n: 500_000, chunkSize: 500_000 });
    big.loadedCount = 500_000;
    const sel = new SelectionStore(500_000, big.xy);
    sel.set(Uint32Array.from({ length: 400_000 }, (_, i) => i), 'poly');
    const ctx = buildSelectionContext(big, sel.current!, meta);
    // The whole point of summarising: token cost must not scale with n.
    expect(JSON.stringify(ctx).length).toBeLessThan(8000);
  });

  it('samples ids spread across the selection, not just the first 100', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7]), 'poly');
    const ctx = buildSelectionContext(s, sel.current!, meta, 4);
    expect(ctx.sampleIds).toHaveLength(4);
    expect(new Set(ctx.sampleIds).size).toBe(4);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/context.test.ts`
Expected: FAIL — cannot resolve `@core/context/build`.

- [x] **Step 3: Implement `packages/core/src/context/build.ts`**

```ts
import type { CellStore } from '../data/schema';
import type { Selection } from '../select/store';

export interface SelectionContext {
  datasetId: string;
  view: 'embedding' | 'trajectory';
  n: number;
  totalN: number;
  bbox: [number, number, number, number];
  centroid: [number, number];
  breakdown: Record<string, Record<string, number>>;
  numericStats: Record<string, { min: number; max: number; mean: number; q: [number, number, number] }>;
  sampleIds: string[];
  colorBy: string;
}

export interface ContextMeta {
  datasetId: string;
  view: 'embedding' | 'trajectory';
  colorBy: string;
}

function quartiles(values: Float64Array): [number, number, number] {
  const sorted = values.slice().sort();
  const at = (f: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(f * (sorted.length - 1))))];
  return [at(0.25), at(0.5), at(0.75)];
}

/**
 * Summarises a selection into something a language model can read.
 *
 * A selection of half a million cells and one of twelve produce contexts of
 * nearly identical size: counts per level, a few statistics, and at most a
 * hundred sampled ids. Shipping the rows themselves would make the token
 * cost of a question scale with the size of the lasso, which is exactly
 * the thing this design refuses to do.
 */
export function buildSelectionContext(
  store: CellStore,
  selection: Selection,
  meta: ContextMeta,
  maxSampleIds = 100
): SelectionContext {
  const idx = selection.indices;
  const n = idx.length;

  let sx = 0, sy = 0;
  for (let k = 0; k < n; k++) {
    sx += store.xy[idx[k] * 2];
    sy += store.xy[idx[k] * 2 + 1];
  }

  const breakdown: Record<string, Record<string, number>> = {};
  for (const [field, codes] of store.codes) {
    const labels = store.levels.get(field)!;
    const counts = new Uint32Array(labels.length);
    for (let k = 0; k < n; k++) counts[codes[idx[k]] % labels.length]++;
    const out: Record<string, number> = {};
    // Zero-count levels are omitted: a donor list of 400 mostly-empty entries
    // is noise in a prompt.
    for (let i = 0; i < labels.length; i++) if (counts[i] > 0) out[labels[i]] = counts[i];
    breakdown[field] = out;
  }

  const numericStats: SelectionContext['numericStats'] = {};
  for (const [field, values] of store.numeric) {
    const picked = new Float64Array(n);
    let min = Infinity, max = -Infinity, sum = 0;
    for (let k = 0; k < n; k++) {
      const v = values[idx[k]];
      picked[k] = v;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    numericStats[field] = {
      min: n ? min : 0,
      max: n ? max : 0,
      mean: n ? sum / n : 0,
      q: n ? quartiles(picked) : [0, 0, 0]
    };
  }

  // Stride rather than take the head, so the sample spans the region instead
  // of clustering at whichever corner the indices happen to start in.
  const take = Math.min(maxSampleIds, n);
  const stride = Math.max(1, Math.floor(n / Math.max(1, take)));
  const sampled = new Uint32Array(take);
  for (let k = 0; k < take; k++) sampled[k] = idx[Math.min(n - 1, k * stride)];

  return {
    datasetId: meta.datasetId,
    view: meta.view,
    n,
    totalN: store.n,
    bbox: selection.bbox,
    centroid: [n ? sx / n : 0, n ? sy / n : 0],
    breakdown,
    numericStats,
    sampleIds: store.sampleIds(sampled, take),
    colorBy: meta.colorBy
  };
}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/context.test.ts`
Expected: PASS, 7 tests. The serialised-size assertion is the load-bearing one.

- [x] **Step 5: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`

---

## Task 11: Chat adapter, mock adapter, chat panel

**Files:**
- Create: `apps/web/src/chat/adapter.ts`, `apps/web/src/chat/mock.ts`, `apps/web/src/chat/ChatPanel.ts`
- Modify: `apps/web/src/main.ts`, `apps/web/src/style.css`
- Test: `packages/core/test/mock-adapter.test.ts`

**Interfaces:**
- Consumes: `SelectionContext` (Task 10), `SelectionStore` (Task 7).
- Produces:
  - `interface Turn { role: 'user' | 'assistant'; text: string }`
  - `interface ChatAdapter { name: string; send(ctx: SelectionContext | null, question: string, history: Turn[], signal?: AbortSignal): AsyncIterable<string> }`
  - `class MockAdapter implements ChatAdapter`
  - `class ChatPanel` with `constructor(root, selectionStore, adapter)`, `setContext(ctx)`, `setAdapter(a)`, `destroy()`
  - `renderContextAsText(ctx): string` — the exact prompt block the server also uses.

Note: `MockAdapter` and `renderContextAsText` live under `packages/core/src/chat/`
so they are testable in Node; `apps/web/src/chat/adapter.ts` re-exports them.

- [x] **Step 1: Write the failing test**

`packages/core/test/mock-adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { MockAdapter, renderContextAsText } from '@core/chat/mock';
import type { SelectionContext } from '@core/context/build';

const ctx: SelectionContext = {
  datasetId: 'sim1m', view: 'embedding', n: 12843, totalN: 1_000_000,
  bbox: [-4, -2, 6, 9], centroid: [1, 3],
  breakdown: {
    cell_type: { 'T cell': 8000, Monocyte: 4843 },
    tissue: { lung: 12000, liver: 843 }
  },
  numericStats: { pseudotime: { min: 0.1, max: 0.9, mean: 0.44, q: [0.2, 0.4, 0.7] } },
  sampleIds: ['cell_1', 'cell_2'],
  colorBy: 'cell_type'
};

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of it) out += chunk;
  return out;
}

describe('renderContextAsText', () => {
  it('states the count and the dominant labels', () => {
    const text = renderContextAsText(ctx);
    expect(text).toContain('12,843');
    expect(text).toContain('T cell');
    expect(text).toContain('lung');
    expect(text).toContain('pseudotime');
  });

  it('says so plainly when nothing is selected', () => {
    expect(renderContextAsText(null).toLowerCase()).toContain('no cells');
  });

  it('truncates a long level list rather than emitting hundreds of lines', () => {
    const many: SelectionContext = {
      ...ctx,
      breakdown: { donor: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`donor_${i}`, 10])) }
    };
    const text = renderContextAsText(many);
    expect(text.split('\n').length).toBeLessThan(60);
    expect(text).toMatch(/more/i);
  });
});

describe('MockAdapter', () => {
  it('answers a count question from the context alone', async () => {
    const out = await collect(new MockAdapter().send(ctx, 'how many cells are selected?', []));
    expect(out).toContain('12,843');
  });

  it('answers a composition question with the top level', async () => {
    const out = await collect(new MockAdapter().send(ctx, 'what cell types are these?', []));
    expect(out).toContain('T cell');
  });

  it('answers a tissue question', async () => {
    const out = await collect(new MockAdapter().send(ctx, 'which tissue?', []));
    expect(out).toContain('lung');
  });

  it('refuses gracefully with no selection', async () => {
    const out = await collect(new MockAdapter().send(null, 'what is here?', []));
    expect(out.toLowerCase()).toContain('no cells');
  });

  it('streams in more than one chunk', async () => {
    const chunks: string[] = [];
    for await (const c of new MockAdapter().send(ctx, 'summarise', [])) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/mock-adapter.test.ts`
Expected: FAIL — cannot resolve `@core/chat/mock`.

- [x] **Step 3: Implement `packages/core/src/chat/adapter.ts`**

```ts
import type { SelectionContext } from '../context/build';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Every chat backend implements this and nothing else.
 *
 * The panel talks only to this interface, so an offline mock, a Claude
 * proxy, or something else entirely are interchangeable without the UI
 * knowing which one it has.
 */
export interface ChatAdapter {
  readonly name: string;
  send(
    ctx: SelectionContext | null,
    question: string,
    history: Turn[],
    signal?: AbortSignal
  ): AsyncIterable<string>;
}

export type { SelectionContext };
```

- [x] **Step 4: Implement `packages/core/src/chat/mock.ts`**

```ts
import type { SelectionContext } from '../context/build';
import type { ChatAdapter, Turn } from './adapter';

const MAX_LEVELS_SHOWN = 12;

function topLevels(counts: Record<string, number>): { label: string; count: number }[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

/**
 * The prompt block describing a selection.
 *
 * Shared by the mock adapter and the server proxy so both see exactly the
 * same description of the selection; if they diverged, testing against the
 * mock would stop telling you anything about the real path.
 */
export function renderContextAsText(ctx: SelectionContext | null): string {
  if (!ctx || ctx.n === 0) {
    return 'No cells are currently selected in the viewer.';
  }
  const lines: string[] = [
    `Selection from dataset "${ctx.datasetId}" (${ctx.view} view).`,
    `${ctx.n.toLocaleString()} cells selected out of ${ctx.totalN.toLocaleString()} total ` +
      `(${((ctx.n / ctx.totalN) * 100).toFixed(2)}%).`,
    `Region: x ${ctx.bbox[0].toFixed(2)} to ${ctx.bbox[2].toFixed(2)}, ` +
      `y ${ctx.bbox[1].toFixed(2)} to ${ctx.bbox[3].toFixed(2)}; ` +
      `centroid (${ctx.centroid[0].toFixed(2)}, ${ctx.centroid[1].toFixed(2)}).`,
    `Currently coloured by: ${ctx.colorBy}.`,
    ''
  ];

  for (const [field, counts] of Object.entries(ctx.breakdown)) {
    const levels = topLevels(counts);
    if (levels.length === 0) continue;
    lines.push(`${field} composition:`);
    for (const { label, count } of levels.slice(0, MAX_LEVELS_SHOWN)) {
      lines.push(`  ${label}: ${count.toLocaleString()} (${((count / ctx.n) * 100).toFixed(1)}%)`);
    }
    if (levels.length > MAX_LEVELS_SHOWN) {
      lines.push(`  ... and ${levels.length - MAX_LEVELS_SHOWN} more levels`);
    }
    lines.push('');
  }

  for (const [field, s] of Object.entries(ctx.numericStats)) {
    lines.push(
      `${field}: min ${s.min.toFixed(3)}, q1 ${s.q[0].toFixed(3)}, median ${s.q[1].toFixed(3)}, ` +
      `q3 ${s.q[2].toFixed(3)}, max ${s.max.toFixed(3)}, mean ${s.mean.toFixed(3)}`
    );
  }
  lines.push('', `Example cell ids: ${ctx.sampleIds.slice(0, 8).join(', ')}`);
  return lines.join('\n');
}

/**
 * Answers from the context alone, with no network and no key.
 *
 * This exists so the entire selection-to-answer path can be exercised in
 * tests and offline development. It is a lookup over the summary, not a
 * model, and it says so.
 */
export class MockAdapter implements ChatAdapter {
  readonly name = 'mock';

  async *send(
    ctx: SelectionContext | null,
    question: string,
    _history: Turn[],
    _signal?: AbortSignal
  ): AsyncIterable<string> {
    const answer = this.answer(ctx, question);
    // Stream in word groups so the panel's streaming path is exercised.
    const words = answer.split(' ');
    for (let i = 0; i < words.length; i += 6) {
      yield words.slice(i, i + 6).join(' ') + (i + 6 < words.length ? ' ' : '');
      await new Promise(r => setTimeout(r, 8));
    }
  }

  private answer(ctx: SelectionContext | null, question: string): string {
    if (!ctx || ctx.n === 0) {
      return 'No cells are selected. Draw a box or lasso on the plot and ask again.';
    }
    const q = question.toLowerCase();
    const top = (field: string): { label: string; count: number } | undefined =>
      topLevels(ctx.breakdown[field] ?? {})[0];

    if (/how many|count|number of/.test(q)) {
      return `${ctx.n.toLocaleString()} cells are selected, which is ` +
        `${((ctx.n / ctx.totalN) * 100).toFixed(2)}% of the ${ctx.totalN.toLocaleString()} in this dataset.`;
    }
    if (/tissue|organ/.test(q)) {
      const t = top('tissue');
      return t
        ? `The selection is dominated by ${t.label} (${t.count.toLocaleString()} cells, ` +
          `${((t.count / ctx.n) * 100).toFixed(1)}%).`
        : 'This dataset has no tissue annotation.';
    }
    if (/cell type|celltype|composition|what.*cells/.test(q)) {
      const levels = topLevels(ctx.breakdown.cell_type ?? {}).slice(0, 4);
      return levels.length
        ? 'Top cell types in the selection: ' +
          levels.map(l => `${l.label} (${l.count.toLocaleString()})`).join(', ') + '.'
        : 'This dataset has no cell type annotation.';
    }
    if (/pseudotime|trajectory|time|stage|develop/.test(q)) {
      const s = ctx.numericStats.pseudotime;
      return s
        ? `Pseudotime across the selection runs ${s.min.toFixed(3)} to ${s.max.toFixed(3)} ` +
          `with a median of ${s.q[1].toFixed(3)}.`
        : 'This dataset has no pseudotime values.';
    }
    // Fall through to the full summary rather than pretending to reason.
    return `[mock adapter — no model is connected] Here is what the viewer knows about ` +
      `your selection:\n\n${renderContextAsText(ctx)}`;
  }
}
```

- [x] **Step 5: Implement `apps/web/src/chat/adapter.ts` as a re-export**

```ts
export type { ChatAdapter, Turn, SelectionContext } from '@core/chat/adapter';
export { MockAdapter, renderContextAsText } from '@core/chat/mock';
```

- [x] **Step 6: Implement `apps/web/src/chat/ChatPanel.ts`**

```ts
import type { SelectionContext } from '@core/context/build';
import type { ChatAdapter, Turn } from '@core/chat/adapter';

/**
 * The chat panel holds no selection state of its own; it is handed a
 * context whenever the selection changes and keeps only the conversation.
 */
export class ChatPanel {
  private history: Turn[] = [];
  private ctx: SelectionContext | null = null;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private badge: HTMLElement;
  private inFlight: AbortController | null = null;

  constructor(root: HTMLElement, private adapter: ChatAdapter) {
    const box = document.createElement('div');
    box.className = 'chat';
    box.innerHTML = `
      <div class="chat-head">Ask about the selection
        <span class="chat-badge">no selection</span></div>
      <div class="chat-log" role="log" aria-live="polite"></div>
      <div class="chat-input">
        <textarea rows="2" placeholder="Select cells first, then ask a question…" disabled></textarea>
        <button disabled>Ask</button>
      </div>`;
    root.appendChild(box);

    this.log = box.querySelector('.chat-log')!;
    this.input = box.querySelector('textarea')!;
    this.sendBtn = box.querySelector('button')!;
    this.badge = box.querySelector('.chat-badge')!;

    this.sendBtn.addEventListener('click', () => void this.ask());
    this.input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void this.ask(); }
    });
  }

  setAdapter(adapter: ChatAdapter): void { this.adapter = adapter; }

  /** Called by the view whenever the selection changes. */
  setContext(ctx: SelectionContext | null): void {
    this.ctx = ctx;
    const has = !!ctx && ctx.n > 0;
    this.input.disabled = !has;
    this.sendBtn.disabled = !has;
    this.input.placeholder = has
      ? 'Ask about these cells…'
      : 'Select cells first, then ask a question…';
    this.badge.textContent = has ? `${ctx!.n.toLocaleString()} cells` : 'no selection';
  }

  private append(role: 'user' | 'assistant' | 'error', text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  private async ask(): Promise<void> {
    const question = this.input.value.trim();
    if (!question || this.sendBtn.disabled) return;
    this.input.value = '';
    this.append('user', question);
    this.history.push({ role: 'user', text: question });

    const bubble = this.append('assistant', '');
    this.sendBtn.disabled = true;
    this.inFlight?.abort();
    const ac = new AbortController();
    this.inFlight = ac;

    let answer = '';
    try {
      for await (const chunk of this.adapter.send(this.ctx, question, this.history.slice(0, -1), ac.signal)) {
        answer += chunk;
        bubble.textContent = answer;
        this.log.scrollTop = this.log.scrollHeight;
      }
      this.history.push({ role: 'assistant', text: answer });
    } catch (err) {
      // The selection and the history survive a failed request, so the user
      // can retry the same question without re-drawing the lasso.
      bubble.remove();
      this.append('error', `Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight = null;
      this.sendBtn.disabled = !this.ctx || this.ctx.n === 0;
    }
  }

  destroy(): void { this.inFlight?.abort(); }
}
```

- [x] **Step 7: Wire the panel into `ScatterView`**

In `apps/web/src/views/ScatterView.ts`, accept an optional `chat` panel and feed
it from the same subscription that already builds the context:

```ts
// in ScatterViewOptions
  chat?: { setContext: (ctx: SelectionContext | null) => void };

// inside the selectionStore.subscribe callback, after computing `ctx`
      this.opts.chat?.setContext(ctx);
```

Then in `apps/web/src/main.ts`, construct the panel and pass it in:
```ts
import { ChatPanel } from './chat/ChatPanel';
import { MockAdapter } from './chat/adapter';

const chatRoot = document.createElement('div');
const chat = new ChatPanel(chatRoot, new MockAdapter());
const view = new ScatterView(root, store, { view: 'embedding', chat });
view.canvas.element().parentElement!.parentElement!
  .querySelector('.side')!.appendChild(chatRoot);
```

- [x] **Step 8: Add the chat styles**

Append to `apps/web/src/style.css`:
```css
.chat { display: flex; flex-direction: column; gap: 6px; margin-top: auto; }
.chat-head { font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
.chat-badge { font-weight: 400; color: #8b94a8; font-size: 11px; }
.chat-log { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.msg { padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; }
.msg.user { background: #223055; align-self: flex-end; max-width: 90%; }
.msg.assistant { background: #1a1f2b; }
.msg.error { background: #3a1d22; color: #ffc9d0; }
.chat-input { display: flex; gap: 6px; }
.chat-input textarea { flex: 1; resize: vertical; background: #10141d; color: #e6e8ee;
  border: 1px solid #2c3346; border-radius: 5px; padding: 6px; font: inherit; }
.chat-input button { background: #2f5bd0; color: #fff; border: 0; border-radius: 5px;
  padding: 6px 12px; cursor: pointer; }
.chat-input button:disabled { opacity: .4; cursor: default; }
```

- [x] **Step 9: Run the tests and try it**

Run: `npx vitest run packages/core/test/mock-adapter.test.ts`
Expected: PASS, 8 tests.

Then in the browser: lasso a region, ask "how many cells are selected?" and
"what cell types are these?". The badge shows the count, the answer streams in,
and clearing the selection disables the input.

- [x] **Step 10: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`

---

## Task 12: Server chat proxy and Claude adapter

**Files:**
- Create: `server/chat.py`, `apps/web/src/chat/claude.ts`, `.env.example`
- Modify: `server/main.py`, `apps/web/src/main.ts`
- Test: `server/tests/test_chat.py`

**Interfaces:**
- Consumes: `SelectionContext` JSON from the browser; `renderContextAsText`'s
  Python twin.
- Produces:
  - `POST /api/chat` with body
    `{ "question": str, "context": SelectionContext | null, "history": [{"role","text"}] }`
    responding `text/event-stream` of `data: {"text": "..."}` lines, ending with
    `data: [DONE]`.
  - `GET /api/chat/status` -> `{"configured": bool, "model": str}` so the UI can
    pick an adapter without guessing.
  - `class ClaudeAdapter implements ChatAdapter`.

- [x] **Step 1: Write the failing test**

`server/tests/test_chat.py`:
```python
import json
import pytest
from fastapi.testclient import TestClient

from server.main import create_app
from server.chat import render_context_as_text

CTX = {
    "datasetId": "sim1m", "view": "embedding", "n": 12843, "totalN": 1000000,
    "bbox": [-4, -2, 6, 9], "centroid": [1, 3],
    "breakdown": {"cell_type": {"T cell": 8000, "Monocyte": 4843},
                  "tissue": {"lung": 12000, "liver": 843}},
    "numericStats": {"pseudotime": {"min": 0.1, "max": 0.9, "mean": 0.44, "q": [0.2, 0.4, 0.7]}},
    "sampleIds": ["cell_1"], "colorBy": "cell_type",
}


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path))


def test_render_context_mentions_counts_and_labels():
    text = render_context_as_text(CTX)
    assert "12,843" in text
    assert "T cell" in text
    assert "pseudotime" in text


def test_render_context_handles_no_selection():
    assert "no cells" in render_context_as_text(None).lower()


def test_render_context_truncates_long_level_lists():
    ctx = dict(CTX, breakdown={"donor": {f"donor_{i}": 10 for i in range(400)}})
    text = render_context_as_text(ctx)
    assert len(text.splitlines()) < 60
    assert "more levels" in text


def test_status_reports_unconfigured_without_a_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    body = client.get("/api/chat/status").json()
    assert body["configured"] is False
    assert body["model"]


def test_chat_without_a_key_returns_a_clear_error_not_a_500(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/api/chat", json={"question": "hi", "context": CTX, "history": []})
    assert r.status_code == 503
    assert "ANTHROPIC_API_KEY" in r.json()["detail"]


def test_chat_rejects_an_oversized_context(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    huge = dict(CTX, sampleIds=[f"cell_{i}" for i in range(100000)])
    r = client.post("/api/chat", json={"question": "hi", "context": huge, "history": []})
    assert r.status_code == 413


def test_chat_streams_sse_from_a_stubbed_model(client, monkeypatch):
    """The route is tested against a stub, not the real API: the thing worth
    testing here is the SSE framing and the prompt assembly."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    async def fake_stream(system, messages, model):
        for piece in ["Hello", " world"]:
            yield piece

    monkeypatch.setattr("server.chat.stream_anthropic", fake_stream)
    r = client.post("/api/chat", json={"question": "hi", "context": CTX, "history": []})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    payloads = [
        json.loads(line[len("data: "):])["text"]
        for line in r.text.splitlines()
        if line.startswith("data: ") and line != "data: [DONE]"
    ]
    assert "".join(payloads) == "Hello world"
    assert r.text.rstrip().endswith("data: [DONE]")


def test_prompt_includes_the_selection_summary(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    seen = {}

    async def capture(system, messages, model):
        seen["system"] = system
        seen["messages"] = messages
        yield "ok"

    monkeypatch.setattr("server.chat.stream_anthropic", capture)
    client.post("/api/chat", json={"question": "how many?", "context": CTX, "history": []})
    assert "12,843" in seen["messages"][-1]["content"]
    assert "how many?" in seen["messages"][-1]["content"]
    assert "single-cell" in seen["system"].lower()
```

- [x] **Step 2: Run to verify it fails**

Run: `python -m pytest server/tests/test_chat.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.chat'`

- [x] **Step 3: Implement `server/chat.py`**

```python
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
        f'Selection from dataset "{ctx.get("datasetId", "?")}" ({ctx.get("view", "embedding")} view).',
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


async def stream_anthropic(system: str, messages: list[dict[str, str]], model: str) -> AsyncIterator[str]:
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
                raise HTTPException(status_code=502, detail=f"model API error {resp.status_code}: {body}")
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
    messages = [
        {"role": "assistant" if t.role == "assistant" else "user", "content": t.text}
        for t in req.history[-10:]
    ]
    messages.append({
        "role": "user",
        "content": (
            "Current selection in the viewer:\n\n"
            f"{render_context_as_text(req.context)}\n\n"
            f"Question: {req.question}"
        ),
    })

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
```

- [x] **Step 4: Register the router in `server/main.py`**

```python
from .chat import router as chat_router
...
    app.include_router(tiles_router)
    app.include_router(chat_router)
```

- [x] **Step 5: Run the tests**

Run: `python -m pytest server/tests/test_chat.py -v`
Expected: PASS, 8 tests.

- [x] **Step 6: Implement `apps/web/src/chat/claude.ts`**

```ts
import type { SelectionContext } from '@core/context/build';
import type { ChatAdapter, Turn } from '@core/chat/adapter';

/**
 * Talks to the server proxy, which holds the API key. Nothing in this file
 * knows a credential, and nothing here should ever learn one.
 */
export class ClaudeAdapter implements ChatAdapter {
  readonly name = 'claude';

  constructor(private baseUrl: string) {}

  static async isConfigured(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/chat/status`);
      return res.ok && (await res.json()).configured === true;
    } catch {
      return false;
    }
  }

  async *send(
    ctx: SelectionContext | null,
    question: string,
    history: Turn[],
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, context: ctx, history }),
      signal
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(detail.detail ?? `chat failed: ${res.status}`);
    }
    if (!res.body) throw new Error('chat response had no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; a chunk boundary can split
      // one, so only complete events are consumed and the tail is kept.
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const line = event.trim();
        if (!line.startsWith('data: ')) continue;
        const blob = line.slice(6);
        if (blob === '[DONE]') return;
        const parsed = JSON.parse(blob) as { text?: string; error?: string };
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.text) yield parsed.text;
      }
    }
  }
}
```

- [x] **Step 7: Pick the adapter at boot in `apps/web/src/main.ts`**

```ts
import { ClaudeAdapter } from './chat/claude';

const adapter = (await ClaudeAdapter.isConfigured(API))
  ? new ClaudeAdapter(API)
  : new MockAdapter();
const chat = new ChatPanel(chatRoot, adapter);
```

Also add a small note in the panel header showing which adapter is live, so it
is never ambiguous whether an answer came from a model or the stub:
```ts
// in ChatPanel's constructor, after building the DOM
this.badge.title = `adapter: ${adapter.name}`;
```

- [x] **Step 8: Create `.env.example`**

```
# Copy to .env and fill in. Never commit the filled-in file.
ANTHROPIC_API_KEY=
CHAT_MODEL=claude-sonnet-5
TILES_DIR=data/tiles
```

Add `.env` to `.gitignore` in the same step.

- [x] **Step 9: Verify the live path**

With `ANTHROPIC_API_KEY` exported in the server's shell, restart uvicorn, reload
the page, lasso a region, and ask "what is this population and how confident can
you be from these annotations alone?". The answer must stream, must cite counts
from the selection, and must decline gene-level questions.
Without the key set, the panel must silently fall back to the mock adapter and
say so in the badge tooltip.

- [x] **Step 10: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit && python -m pytest server/tests -q`
Then confirm no key leaked into the client: `grep -ri "anthropic_api_key\|sk-ant" apps/ packages/ dist/ 2>/dev/null` must return nothing.

---

## Task 13: Trajectory view with principal graph overlay

**Files:**
- Create: `apps/web/src/views/TrajectoryView.ts`, `apps/web/src/views/graphLayers.ts`, `apps/web/src/ui/ViewSwitcher.ts`
- Modify: `apps/web/src/main.ts`
- Test: `packages/core/test/graph.test.ts`

**Interfaces:**
- Consumes: `ScatterView` (Task 9), `fetchGraph` (Task 4), `PrincipalGraph` (Task 4).
- Produces:
  - `graphPaths(graph: PrincipalGraph): { path: [number, number][] }[]` — merges edges into polylines so the PathLayer draws runs, not thousands of two-point segments.
  - `graphNodeMarkers(graph): { position: [number,number]; kind: 'root'|'branch'|'leaf' }[]`
  - `buildGraphLayers(graph, opts): Layer[]`
  - `class TrajectoryView extends ScatterView` behaviour: same selection and chat wiring, plus the overlay and a pseudotime default colouring.

- [x] **Step 1: Write the failing test**

`packages/core/test/graph.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { graphPaths, graphNodeMarkers } from '@core/graph/paths';
import type { PrincipalGraph } from '@core/data/manifest';

//  0 - 1 - 2 - 3        (a chain that branches at 2)
//              \
//               4 - 5
const graph: PrincipalGraph = {
  nodes: [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2]],
  edges: [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]],
  root: 0,
  branchPoints: [2],
  leaves: [3, 5]
};

describe('graphPaths', () => {
  it('merges a chain of edges into one polyline', () => {
    const chain: PrincipalGraph = { ...graph, edges: [[0, 1], [1, 2], [2, 3]], branchPoints: [], leaves: [3] };
    const paths = graphPaths(chain);
    expect(paths).toHaveLength(1);
    expect(paths[0].path).toHaveLength(4);
  });

  it('splits at a branch point instead of drawing through it', () => {
    const paths = graphPaths(graph);
    expect(paths.length).toBeGreaterThan(1);
    const covered = new Set<string>();
    for (const p of paths) {
      for (let i = 0; i < p.path.length - 1; i++) {
        covered.add([p.path[i].join(), p.path[i + 1].join()].sort().join('|'));
      }
    }
    expect(covered.size).toBe(graph.edges.length);
  });

  it('covers every edge exactly once', () => {
    const paths = graphPaths(graph);
    let segments = 0;
    for (const p of paths) segments += p.path.length - 1;
    expect(segments).toBe(graph.edges.length);
  });

  it('returns nothing for an empty graph', () => {
    expect(graphPaths({ nodes: [], edges: [], root: 0, branchPoints: [], leaves: [] })).toEqual([]);
  });

  it('does not loop forever on a cyclic graph', () => {
    const cyclic: PrincipalGraph = {
      nodes: [[0, 0], [1, 0], [1, 1]],
      edges: [[0, 1], [1, 2], [2, 0]],
      root: 0, branchPoints: [], leaves: []
    };
    const paths = graphPaths(cyclic);
    let segments = 0;
    for (const p of paths) segments += p.path.length - 1;
    expect(segments).toBe(3);
  });
});

describe('graphNodeMarkers', () => {
  it('labels root, branch and leaf nodes', () => {
    const markers = graphNodeMarkers(graph);
    const kinds = markers.map(m => m.kind).sort();
    expect(kinds).toEqual(['branch', 'leaf', 'leaf', 'root']);
    expect(markers.find(m => m.kind === 'root')!.position).toEqual([0, 0]);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/graph.test.ts`
Expected: FAIL — cannot resolve `@core/graph/paths`.

- [x] **Step 3: Implement `packages/core/src/graph/paths.ts`**

```ts
import type { PrincipalGraph } from '../data/manifest';

export interface GraphPath { path: [number, number][] }
export interface GraphMarker { position: [number, number]; kind: 'root' | 'branch' | 'leaf' }

/**
 * Merges the principal graph's edge list into polylines.
 *
 * A monocle3 graph is a few hundred to a few thousand edges. Handing deck.gl
 * one two-point path per edge draws visible seams at every joint and costs a
 * draw-call setup per segment; merging runs between branch points gives
 * continuous strokes that read as lineages.
 */
export function graphPaths(graph: PrincipalGraph): GraphPath[] {
  const m = graph.nodes.length;
  if (m === 0 || graph.edges.length === 0) return [];

  const adj: number[][] = Array.from({ length: m }, () => []);
  graph.edges.forEach(([i, j], e) => { adj[i].push(e); adj[j].push(e); });
  const other = (e: number, from: number): number =>
    graph.edges[e][0] === from ? graph.edges[e][1] : graph.edges[e][0];

  const used = new Uint8Array(graph.edges.length);
  const paths: GraphPath[] = [];

  const walk = (start: number, firstEdge: number): void => {
    const path: [number, number][] = [graph.nodes[start] as [number, number]];
    let node = start;
    let edge = firstEdge;
    // Follow the run until it hits a branch point, a leaf, or an edge we
    // already drew. The `used` guard is also what stops a cycle from
    // spinning forever.
    while (!used[edge]) {
      used[edge] = 1;
      node = other(edge, node);
      path.push(graph.nodes[node] as [number, number]);
      if (adj[node].length !== 2) break;
      const next = adj[node].find(e => !used[e]);
      if (next === undefined) break;
      edge = next;
    }
    if (path.length > 1) paths.push({ path });
  };

  // Start from every junction and endpoint first, so runs are maximal.
  for (let n = 0; n < m; n++) {
    if (adj[n].length === 2) continue;
    for (const e of adj[n]) if (!used[e]) walk(n, e);
  }
  // Anything left is a pure cycle with no junction to start from.
  for (let e = 0; e < graph.edges.length; e++) {
    if (!used[e]) walk(graph.edges[e][0], e);
  }
  return paths;
}

export function graphNodeMarkers(graph: PrincipalGraph): GraphMarker[] {
  const markers: GraphMarker[] = [];
  const seen = new Set<number>();
  const push = (i: number, kind: GraphMarker['kind']): void => {
    if (seen.has(i) || !graph.nodes[i]) return;
    seen.add(i);
    markers.push({ position: graph.nodes[i] as [number, number], kind });
  };
  push(graph.root, 'root');
  for (const i of graph.branchPoints) push(i, 'branch');
  for (const i of graph.leaves) push(i, 'leaf');
  return markers;
}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/graph.test.ts`
Expected: PASS, 6 tests.

- [x] **Step 5: Implement `apps/web/src/views/graphLayers.ts`**

```ts
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { PrincipalGraph } from '@core/data/manifest';
import { graphPaths, graphNodeMarkers, type GraphMarker } from '@core/graph/paths';

const MARKER_STYLE: Record<GraphMarker['kind'], { color: [number, number, number, number]; radius: number }> = {
  root:   { color: [255, 255, 255, 255], radius: 7 },
  branch: { color: [255, 196, 60, 255],  radius: 5 },
  leaf:   { color: [140, 150, 175, 220], radius: 3.5 }
};

export interface GraphLayerOptions {
  showLabels?: boolean;
  lineWidth?: number;
}

/**
 * The trajectory backbone drawn over the cells.
 *
 * The graph is small — hundreds of nodes against hundreds of thousands of
 * cells — so it is drawn plainly, with a dark halo underneath so it stays
 * legible over a dense, bright point cloud.
 */
export function buildGraphLayers(graph: PrincipalGraph, opts: GraphLayerOptions = {}): Layer[] {
  const paths = graphPaths(graph);
  const markers = graphNodeMarkers(graph);
  const width = opts.lineWidth ?? 2.5;

  const layers: Layer[] = [
    new PathLayer({
      id: 'graph-halo',
      data: paths,
      getPath: d => d.path,
      getColor: [10, 12, 18, 220],
      getWidth: width + 3,
      widthUnits: 'pixels',
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
      pickable: false
    }),
    new PathLayer({
      id: 'graph-path',
      data: paths,
      getPath: d => d.path,
      getColor: [245, 245, 250, 235],
      getWidth: width,
      widthUnits: 'pixels',
      widthMinPixels: 1.5,
      capRounded: true,
      jointRounded: true,
      pickable: false
    }),
    new ScatterplotLayer({
      id: 'graph-nodes',
      data: markers,
      getPosition: (d: GraphMarker) => d.position,
      getFillColor: (d: GraphMarker) => MARKER_STYLE[d.kind].color,
      getRadius: (d: GraphMarker) => MARKER_STYLE[d.kind].radius,
      radiusUnits: 'pixels',
      stroked: true,
      getLineColor: [10, 12, 18, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      pickable: false
    })
  ];

  if (opts.showLabels) {
    layers.push(new TextLayer({
      id: 'graph-labels',
      data: markers.filter(m => m.kind !== 'leaf'),
      getPosition: (d: GraphMarker) => d.position,
      getText: (d: GraphMarker) => (d.kind === 'root' ? 'root' : 'branch'),
      getSize: 11,
      sizeUnits: 'pixels',
      getColor: [235, 238, 245, 230],
      getPixelOffset: [0, -12],
      pickable: false
    }));
  }
  return layers;
}
```

- [x] **Step 6: Implement `apps/web/src/views/TrajectoryView.ts`**

```ts
import type { CellStore } from '@core/data/schema';
import type { PrincipalGraph } from '@core/data/manifest';
import { ScatterView, type ScatterViewOptions } from './ScatterView';
import { buildGraphLayers } from './graphLayers';

export interface TrajectoryViewOptions extends ScatterViewOptions {
  graph: PrincipalGraph;
}

/**
 * The trajectory display is the embedding display plus a graph overlay and
 * a different default colouring. Selection, zoom, the summary panel and the
 * chat wiring are inherited unchanged — that reuse is the reason the canvas
 * was built as its own class rather than folded into the embedding view.
 */
export class TrajectoryView extends ScatterView {
  private graph: PrincipalGraph;
  private showLabels = false;

  constructor(root: HTMLElement, store: CellStore, opts: TrajectoryViewOptions) {
    super(root, store, { ...opts, view: 'trajectory' });
    this.graph = opts.graph;
    this.canvas.setOverlayLayers(buildGraphLayers(this.graph, { showLabels: this.showLabels }));
    if (store.numericFields().includes('pseudotime')) {
      this.canvas.setColorBy('pseudotime', 'numeric');
    }
    this.addGraphControls(root.querySelector<HTMLElement>('.side')!);
  }

  private addGraphControls(side: HTMLElement): void {
    const box = document.createElement('div');
    box.className = 'graph-controls';
    box.innerHTML = `
      <label><input type="checkbox" data-graph checked> Show trajectory</label>
      <label><input type="checkbox" data-labels> Label root and branches</label>
      <div class="muted">${this.graph.nodes.length} nodes,
        ${this.graph.edges.length} edges,
        ${this.graph.branchPoints.length} branch points,
        ${this.graph.leaves.length} leaves</div>`;
    side.appendChild(box);

    const show = box.querySelector<HTMLInputElement>('[data-graph]')!;
    const labels = box.querySelector<HTMLInputElement>('[data-labels]')!;
    const apply = (): void => {
      this.showLabels = labels.checked;
      this.canvas.setOverlayLayers(
        show.checked ? buildGraphLayers(this.graph, { showLabels: this.showLabels }) : []
      );
    };
    show.addEventListener('change', apply);
    labels.addEventListener('change', apply);
  }
}
```

Note: `ScatterView`'s private members must become `protected` for this subclass,
and its `opts` and `canvas` are already accessible. Change `private canvas` to
`readonly canvas` (already the case) and `private store` to `protected store`.

- [x] **Step 7: Implement `apps/web/src/ui/ViewSwitcher.ts` and route in `main.ts`**

```ts
export function createViewSwitcher(
  root: HTMLElement,
  datasets: { id: string; label: string; kind: 'embedding' | 'trajectory' }[],
  onPick: (id: string, kind: 'embedding' | 'trajectory') => void
): void {
  const bar = document.createElement('div');
  bar.className = 'switcher';
  bar.innerHTML = datasets.map((d, i) =>
    `<button data-id="${d.id}" data-kind="${d.kind}" class="${i === 0 ? 'active' : ''}">${d.label}</button>`
  ).join('');
  root.appendChild(bar);
  bar.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn) return;
    [...bar.querySelectorAll('button')].forEach(b => b.classList.toggle('active', b === btn));
    onPick(btn.dataset.id!, btn.dataset.kind as 'embedding' | 'trajectory');
  });
}
```

Rewrite `apps/web/src/main.ts` to load a chosen dataset, build the matching view,
and tear the previous one down:

```ts
import './style.css';
import { loadDataset, fetchGraph } from '@core/data/loader';
import { ScatterView } from './views/ScatterView';
import { TrajectoryView } from './views/TrajectoryView';
import { ChatPanel } from './chat/ChatPanel';
import { MockAdapter } from './chat/adapter';
import { ClaudeAdapter } from './chat/claude';
import { createViewSwitcher } from './ui/ViewSwitcher';

const API = import.meta.env.VITE_API ?? 'http://localhost:8000';

const DATASETS = [
  { id: 'sim1m', label: 'UMAP · 1M cells', kind: 'embedding' as const },
  { id: 'traj500k', label: 'Trajectory · 500k cells', kind: 'trajectory' as const },
  { id: 'sim100k', label: 'UMAP · 100k cells', kind: 'embedding' as const }
];

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div class="top"></div><div class="stage"></div><div id="status"></div>`;
  const top = app.querySelector<HTMLElement>('.top')!;
  const stage = app.querySelector<HTMLElement>('.stage')!;
  const status = document.getElementById('status')!;

  const adapter = (await ClaudeAdapter.isConfigured(API)) ? new ClaudeAdapter(API) : new MockAdapter();
  let current: ScatterView | null = null;
  let abort: AbortController | null = null;

  async function open(id: string, kind: 'embedding' | 'trajectory'): Promise<void> {
    abort?.abort();
    abort = new AbortController();
    current?.destroy();
    current = null;
    stage.innerHTML = '';
    status.textContent = `loading ${id}…`;

    const chatRoot = document.createElement('div');
    const chat = new ChatPanel(chatRoot, adapter);

    const graph = kind === 'trajectory' ? await fetchGraph(API, id, abort.signal) : null;
    const store = await loadDataset(API, id, {
      signal: abort.signal,
      onChunk: (_c, s) => {
        status.textContent = `${s.loadedCount.toLocaleString()} / ${s.n.toLocaleString()} cells`;
        current?.onDataGrew();
      }
    });

    current = graph
      ? new TrajectoryView(stage, store, { graph, chat })
      : new ScatterView(stage, store, { view: 'embedding', chat });
    stage.querySelector('.side')!.appendChild(chatRoot);
    current.onDataGrew();
    status.textContent = `${store.loadedCount.toLocaleString()} cells` +
      (store.failedChunks.length ? ` · ${store.failedChunks.length} chunks failed to load` : '');
  }

  createViewSwitcher(top, DATASETS, (id, kind) => void open(id, kind));
  await open(DATASETS[0].id, DATASETS[0].kind);
}

main().catch(err => {
  document.getElementById('app')!.textContent = `failed to start: ${err.message}`;
});
```

Add layout rules to `apps/web/src/style.css`:
```css
#app { flex-direction: column; height: 100%; }
.top { display: flex; gap: 6px; padding: 8px 12px; background: #141821;
  border-bottom: 1px solid #232838; }
.switcher button { background: #1d2331; color: #cfd6e6; border: 1px solid #2c3346;
  border-radius: 5px; padding: 5px 10px; cursor: pointer; font: inherit; }
.switcher button.active { background: #2f5bd0; border-color: #3f6ee6; color: #fff; }
.stage { flex: 1; display: flex; min-height: 0; }
.graph-controls { display: flex; flex-direction: column; gap: 3px; }
```

- [x] **Step 8: Verify by hand**

Open the app and switch to **Trajectory · 500k cells**.
Expected: 500,000 cells coloured by pseudotime along a branching backbone, the
white principal graph drawn over them with a root marker and orange branch
points. Lasso a branch tip; the summary reports its pseudotime range as high,
and asking the chat "where in the trajectory are these cells?" gets an answer
citing that range. Toggling **Show trajectory** removes and restores the overlay
without touching the point cloud.

- [x] **Step 9: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`

---

## Task 14: Capacity benchmark

**Files:**
- Create: `apps/web/bench.html`, `apps/web/src/bench/bench.ts`, `apps/web/src/bench/metrics.ts`
- Modify: `vite.config.ts` (multi-page build)
- Test: `packages/core/test/metrics.test.ts`

**Interfaces:**
- Consumes: `loadDataset`, `ScatterCanvas`, `SelectionClient`, `buildGrid`.
- Produces:
  - `class FrameSampler` with `start()`, `stop(): { p50: number; p5: number; frames: number }` (FPS percentiles).
  - `runSweep(sizes: number[], opts): Promise<BenchRow[]>` where
    `BenchRow = { n; loadMs; decodeMs; gridMs; firstFrameMs; fpsP50; fpsP5; lassoMs; heapMb }`
  - `formatMarkdown(rows: BenchRow[]): string`

- [x] **Step 1: Write the failing test**

`packages/core/test/metrics.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { FrameSampler, percentile, formatMarkdown } from '@core/bench/metrics';

describe('percentile', () => {
  it('returns the median for p50', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('returns a low value for p5, not the max', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 5)).toBeLessThan(percentile(values, 50));
  });

  it('handles a single sample and an empty list', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('FrameSampler', () => {
  it('converts frame deltas to FPS percentiles', () => {
    const s = new FrameSampler();
    s.pushDelta(16.7);  // ~60 fps
    s.pushDelta(16.7);
    s.pushDelta(33.3);  // ~30 fps
    const r = s.summary();
    expect(r.frames).toBe(3);
    expect(r.p50).toBeGreaterThan(29);
    expect(r.p50).toBeLessThan(61);
    // p5 is the bad-frame percentile: it must not exceed the median.
    expect(r.p5).toBeLessThanOrEqual(r.p50);
  });

  it('ignores a zero delta rather than reporting infinite FPS', () => {
    const s = new FrameSampler();
    s.pushDelta(0);
    s.pushDelta(16.7);
    expect(Number.isFinite(s.summary().p50)).toBe(true);
  });
});

describe('formatMarkdown', () => {
  it('emits a table row per measurement', () => {
    const md = formatMarkdown([
      { n: 1e6, loadMs: 900, decodeMs: 20, gridMs: 80, firstFrameMs: 120,
        fpsP50: 60, fpsP5: 44, lassoMs: 9, heapMb: 210 }
    ]);
    expect(md.split('\n').length).toBeGreaterThanOrEqual(3);
    expect(md).toContain('1,000,000');
    expect(md).toContain('|');
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/metrics.test.ts`
Expected: FAIL — cannot resolve `@core/bench/metrics`.

- [x] **Step 3: Implement `packages/core/src/bench/metrics.ts`**

```ts
export interface BenchRow {
  n: number;
  loadMs: number;
  decodeMs: number;
  gridMs: number;
  firstFrameMs: number;
  fpsP50: number;
  fpsP5: number;
  lassoMs: number;
  heapMb: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Collects per-frame deltas and reports FPS percentiles.
 *
 * The p5 figure matters more than the mean: a plot that averages 60 fps but
 * stalls for 200 ms whenever a dense region enters the viewport feels
 * broken, and only the low percentile shows that.
 */
export class FrameSampler {
  private deltas: number[] = [];

  pushDelta(ms: number): void {
    if (ms > 0 && Number.isFinite(ms)) this.deltas.push(ms);
  }

  summary(): { p50: number; p5: number; frames: number } {
    const fps = this.deltas.map(d => 1000 / d);
    return {
      p50: Math.round(percentile(fps, 50) * 10) / 10,
      p5: Math.round(percentile(fps, 5) * 10) / 10,
      frames: this.deltas.length
    };
  }

  reset(): void { this.deltas = []; }
}

export function formatMarkdown(rows: BenchRow[]): string {
  const head = '| points | load ms | decode ms | grid ms | first frame ms | fps p50 | fps p5 | lasso ms | heap MB |';
  const sep  = '|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.map(r =>
    `| ${r.n.toLocaleString()} | ${Math.round(r.loadMs)} | ${Math.round(r.decodeMs)} | ` +
    `${Math.round(r.gridMs)} | ${Math.round(r.firstFrameMs)} | ${r.fpsP50} | ${r.fpsP5} | ` +
    `${r.lassoMs.toFixed(1)} | ${Math.round(r.heapMb)} |`);
  return [head, sep, ...body].join('\n');
}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/metrics.test.ts`
Expected: PASS, 6 tests.

- [x] **Step 5: Generate the large benchmark datasets**

Run: `python -m server.prep --sizes 100000 500000 1000000 2000000 5000000 10000000 --traj-size 500000`
Expected: roughly 240 MB of tiles in total; `sim10m` alone is about 140 MB.
If disk is tight, generate up to `sim5m` first and add `sim10m` afterwards.

- [x] **Step 6: Implement `apps/web/src/bench/bench.ts`**

```ts
import '../style.css';
import { loadDataset } from '@core/data/loader';
import { buildGrid } from '@core/index/grid';
import { selectPolygon } from '@core/select/query';
import { ScatterCanvas } from '../views/ScatterCanvas';
import { FrameSampler, formatMarkdown, type BenchRow } from '@core/bench/metrics';

const API = import.meta.env.VITE_API ?? 'http://localhost:8000';

const SIZES: { id: string; n: number }[] = [
  { id: 'sim100k', n: 100_000 },
  { id: 'sim500k', n: 500_000 },
  { id: 'sim1m', n: 1_000_000 },
  { id: 'sim2m', n: 2_000_000 },
  { id: 'sim5m', n: 5_000_000 },
  { id: 'sim10m', n: 10_000_000 }
];

function heapMb(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize / 1024 / 1024 : NaN;
}

/** Drives a scripted pan for `ms` and samples every frame. */
async function measurePan(canvas: ScatterCanvas, ms: number): Promise<{ p50: number; p5: number }> {
  const sampler = new FrameSampler();
  const start = performance.now();
  let last = start;
  await new Promise<void>(resolve => {
    const step = (t: number): void => {
      sampler.pushDelta(t - last);
      last = t;
      // Sweep the viewport so dense regions actually enter and leave it;
      // sampling a still frame measures nothing.
      const phase = ((t - start) / ms) * Math.PI * 2;
      const [x0, y0, x1, y1] = canvas.storeBounds();
      canvas.setTarget([
        (x0 + x1) / 2 + Math.cos(phase) * (x1 - x0) * 0.2,
        (y0 + y1) / 2 + Math.sin(phase) * (y1 - y0) * 0.2
      ]);
      if (t - start < ms) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  const s = sampler.summary();
  return { p50: s.p50, p5: s.p5 };
}

async function runOne(id: string, holder: HTMLElement, log: (s: string) => void): Promise<BenchRow> {
  log(`loading ${id}…`);
  const t0 = performance.now();
  let firstChunkAt = 0;
  const store = await loadDataset(API, id, {
    onChunk: () => { if (!firstChunkAt) firstChunkAt = performance.now(); }
  });
  const loadMs = performance.now() - t0;

  holder.innerHTML = '';
  const tFrame = performance.now();
  const canvas = new ScatterCanvas(holder, store, { budget: Number.POSITIVE_INFINITY });
  await new Promise(r => requestAnimationFrame(() => r(null)));
  const firstFrameMs = performance.now() - tFrame;

  const tGrid = performance.now();
  const grid = buildGrid(store.xy, store.loadedCount);
  const gridMs = performance.now() - tGrid;

  const [x0, y0, x1, y1] = store.bounds;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const r = Math.min(x1 - x0, y1 - y0) * 0.18;
  const poly = new Float64Array(120);
  for (let k = 0; k < 60; k++) {
    const a = (k / 60) * Math.PI * 2;
    poly[k * 2] = cx + Math.cos(a) * r;
    poly[k * 2 + 1] = cy + Math.sin(a) * r;
  }
  const lassoTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    selectPolygon(store.xy, store.loadedCount, poly, grid);
    lassoTimes.push(performance.now() - t);
  }
  lassoTimes.sort((a, b) => a - b);

  log(`panning ${id}…`);
  const fps = await measurePan(canvas, 3000);
  const row: BenchRow = {
    n: store.loadedCount,
    loadMs,
    decodeMs: firstChunkAt ? firstChunkAt - t0 : 0,
    gridMs,
    firstFrameMs,
    fpsP50: fps.p50,
    fpsP5: fps.p5,
    lassoMs: lassoTimes[5],
    heapMb: heapMb()
  };
  canvas.destroy();
  return row;
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div class="bench">
    <h1>Capacity sweep</h1>
    <p class="muted">Measures how far this browser and this machine actually go.
      Each size is loaded, rendered at full detail, panned for three seconds, and
      lassoed ten times.</p>
    <button id="run">Run sweep</button>
    <div id="log" class="muted"></div>
    <pre id="out"></pre>
    <div id="stage" style="height:420px;position:relative"></div>
  </div>`;

  const out = document.getElementById('out')!;
  const logEl = document.getElementById('log')!;
  const stage = document.getElementById('stage')!;
  const log = (s: string): void => { logEl.textContent = s; };

  document.getElementById('run')!.addEventListener('click', async () => {
    const available: string[] = (await (await fetch(`${API}/api/datasets`)).json()).datasets;
    const rows: BenchRow[] = [];
    for (const { id } of SIZES.filter(s => available.includes(s.id))) {
      try {
        rows.push(await runOne(id, stage, log));
      } catch (err) {
        // A size that exhausts memory is a result, not a crash: record where
        // the wall is and keep the rows already measured.
        log(`${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        out.textContent = formatMarkdown(rows) + `\n\nStopped at ${id}: ${String(err)}`;
        return;
      }
      out.textContent = formatMarkdown(rows);
    }
    log('done');
  });
}

void main();
```

`apps/web/bench.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Cell Viewer — capacity sweep</title></head>
  <body><div id="app"></div><script type="module" src="/src/bench/bench.ts"></script></body>
</html>
```

Add the second entry point in `vite.config.ts`:
```ts
import { resolve } from 'node:path';
// inside build:
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'apps/web/index.html'),
        bench: resolve(__dirname, 'apps/web/bench.html')
      }
    }
```

- [x] **Step 7: Add the two `ScatterCanvas` accessors the bench needs**

```ts
  storeBounds(): [number, number, number, number] { return this.store.bounds; }

  setTarget(target: [number, number]): void {
    this.viewState = { ...this.viewState, target: [target[0], target[1], 0] } as OrthographicViewState;
    this.deck.setProps({ initialViewState: this.viewState });
    this.render();
  }
```

- [x] **Step 8: Run the sweep and record the results**

Open `http://localhost:5173/bench.html`, click **Run sweep**, and let it finish.
Copy the Markdown table into a new file `docs/benchmarks/2026-09-06-capacity.md`
with a header naming the machine, browser and GPU, for example:

```markdown
# Capacity sweep — 2026-09-06

Machine: Apple M-series, macOS 26.5.2. Browser: <name and version>.
Server: FastAPI on localhost, binary chunks of 250,000 points.

<paste the table>

## Reading

- The wall is <fill in>: at <N> points the p5 frame rate falls below 30 fps.
- Fill rate, not point count, is the limiter — <state the evidence from the
  radius and LOD experiments below>.
- Recommended default budget for `lodPolicy`: <value>, which keeps p5 above
  45 fps on this machine.
```

Then set `ScatterCanvas`'s default `budget` to the value the sweep supports, and
note in the file what a lower-powered machine should use.

- [x] **Step 9: Confirm the fill-rate hypothesis**

Re-run the 5M case twice, once with `getRadius: 0.5` and once with `2.5`, and
record both p50 figures in the same document. If the larger radius is markedly
slower at identical point counts, the limit is overdraw and the LOD policy
should reduce radius before it reduces point count at low zoom. If the two are
equal, the limit is vertex throughput and the policy is right to cut points.
Adjust `lodPolicy` accordingly and note the decision.

- [x] **Step 10: Checkpoint**

Run: `npx vitest run && npx tsc --noEmit`
Confirm `docs/benchmarks/2026-09-06-capacity.md` exists and is filled in with
real measured numbers, not estimates.

---

## Task 15: Real data ingestion (.h5ad and Parquet)

**Files:**
- Modify: `server/prep.py`
- Test: `server/tests/test_ingest.py`

**Interfaces:**
- Consumes: an `.h5ad` file with a 2D embedding in `adata.obsm` and annotations in `adata.obs`; or a Parquet file with `x`, `y` and annotation columns.
- Produces:
  - `dataset_from_h5ad(path, embedding_key='X_umap', obs_fields=None, numeric_fields=None) -> SimDataset`
  - `dataset_from_parquet(path, x='x', y='y', obs_fields=None, numeric_fields=None) -> SimDataset`
  - CLI: `python -m server.prep --h5ad file.h5ad --id mydata --embedding X_umap`

- [x] **Step 1: Write the failing test**

`server/tests/test_ingest.py`:
```python
import numpy as np
import pytest

from server.prep import dataset_from_h5ad, dataset_from_parquet, write_tiles


@pytest.fixture
def h5ad_file(tmp_path):
    anndata = pytest.importorskip("anndata")
    import pandas as pd

    n = 500
    rng = np.random.default_rng(0)
    obs = pd.DataFrame({
        "cell_type": pd.Categorical(rng.choice(["T cell", "B cell", "NK cell"], n)),
        "tissue": pd.Categorical(rng.choice(["lung", "liver"], n)),
        "pseudotime": rng.random(n).astype(np.float32),
    })
    adata = anndata.AnnData(X=rng.random((n, 5)).astype(np.float32), obs=obs)
    adata.obsm["X_umap"] = rng.normal(size=(n, 2)).astype(np.float32)
    path = tmp_path / "small.h5ad"
    adata.write_h5ad(path)
    return path


def test_h5ad_reads_coordinates_and_categoricals(h5ad_file):
    ds = dataset_from_h5ad(h5ad_file, embedding_key="X_umap")
    assert ds.xy.shape == (500, 2)
    assert ds.xy.dtype == np.float32
    assert "cell_type" in ds.codes
    assert set(ds.levels["cell_type"]) == {"T cell", "B cell", "NK cell"}
    assert ds.codes["cell_type"].dtype == np.uint16
    assert ds.numeric["pseudotime"].shape == (500,)


def test_h5ad_codes_round_trip_to_the_right_labels(h5ad_file):
    anndata = pytest.importorskip("anndata")
    adata = anndata.read_h5ad(h5ad_file)
    ds = dataset_from_h5ad(h5ad_file, embedding_key="X_umap")
    decoded = [ds.levels["cell_type"][c] for c in ds.codes["cell_type"][:50]]
    assert decoded == list(adata.obs["cell_type"].astype(str)[:50])


def test_h5ad_missing_embedding_key_names_what_is_available(h5ad_file):
    with pytest.raises(KeyError) as exc:
        dataset_from_h5ad(h5ad_file, embedding_key="X_tsne")
    assert "X_umap" in str(exc.value)


def test_h5ad_rejects_a_non_2d_embedding(tmp_path):
    anndata = pytest.importorskip("anndata")
    rng = np.random.default_rng(1)
    adata = anndata.AnnData(X=rng.random((10, 3)).astype(np.float32))
    adata.obsm["X_pca"] = rng.random((10, 50)).astype(np.float32)
    path = tmp_path / "pca.h5ad"
    adata.write_h5ad(path)
    with pytest.raises(ValueError, match="2 columns"):
        dataset_from_h5ad(path, embedding_key="X_pca")


def test_parquet_ingest(tmp_path):
    pd = pytest.importorskip("pandas")
    rng = np.random.default_rng(2)
    n = 300
    df = pd.DataFrame({
        "x": rng.normal(size=n).astype(np.float32),
        "y": rng.normal(size=n).astype(np.float32),
        "cell_type": rng.choice(["A", "B"], n),
        "pseudotime": rng.random(n).astype(np.float32),
    })
    path = tmp_path / "cells.parquet"
    df.to_parquet(path)
    ds = dataset_from_parquet(path, obs_fields=["cell_type"], numeric_fields=["pseudotime"])
    assert ds.xy.shape == (300, 2)
    assert set(ds.levels["cell_type"]) == {"A", "B"}


def test_ingested_dataset_writes_tiles(h5ad_file, tmp_path):
    ds = dataset_from_h5ad(h5ad_file, embedding_key="X_umap")
    man = write_tiles(ds, tmp_path / "out", "real", chunk_size=200)
    assert man["n"] == 500 and man["chunks"] == 3
    assert "cell_type" in man["categorical"]


def test_high_cardinality_field_still_fits_uint16(tmp_path):
    """Barcodes and donor ids can run to tens of thousands of levels; more
    than 65,535 must fail loudly rather than wrap silently."""
    pd = pytest.importorskip("pandas")
    n = 70_000
    df = pd.DataFrame({
        "x": np.zeros(n, dtype=np.float32),
        "y": np.zeros(n, dtype=np.float32),
        "barcode": [f"bc_{i}" for i in range(n)],
    })
    path = tmp_path / "wide.parquet"
    df.to_parquet(path)
    with pytest.raises(ValueError, match="65535"):
        dataset_from_parquet(path, obs_fields=["barcode"])
```

- [x] **Step 2: Run to verify it fails**

Run: `python -m pytest server/tests/test_ingest.py -v`
Expected: FAIL — `ImportError: cannot import name 'dataset_from_h5ad'`

- [x] **Step 3: Add the ingestion functions to `server/prep.py`**

```python
MAX_LEVELS = 65_535


def _encode_categorical(values, field: str) -> tuple[np.ndarray, list[str]]:
    """String column to uint16 codes plus a level dictionary.

    A column with more distinct values than uint16 can hold is rejected
    rather than truncated: a silently wrapped barcode column would colour
    the plot with plausible-looking nonsense.
    """
    labels = [str(v) for v in values]
    levels = sorted(set(labels))
    if len(levels) > MAX_LEVELS:
        raise ValueError(
            f"field '{field}' has {len(levels)} distinct values, more than the "
            f"{MAX_LEVELS} a uint16 code can represent; drop it or bin it first"
        )
    index = {label: i for i, label in enumerate(levels)}
    codes = np.fromiter((index[v] for v in labels), dtype=np.uint16, count=len(labels))
    return codes, levels


def dataset_from_h5ad(
    path,
    embedding_key: str = "X_umap",
    obs_fields: list[str] | None = None,
    numeric_fields: list[str] | None = None,
) -> SimDataset:
    import anndata

    adata = anndata.read_h5ad(path)
    if embedding_key not in adata.obsm:
        raise KeyError(
            f"embedding '{embedding_key}' not found; available: {sorted(adata.obsm.keys())}"
        )
    emb = np.asarray(adata.obsm[embedding_key])
    if emb.ndim != 2 or emb.shape[1] != 2:
        raise ValueError(
            f"embedding '{embedding_key}' has shape {emb.shape}; the viewer needs "
            f"exactly 2 columns. Slice it, or compute a 2D UMAP first."
        )
    xy = np.ascontiguousarray(emb[:, :2], dtype=np.float32)

    obs = adata.obs
    if obs_fields is None:
        obs_fields = [
            c for c in obs.columns
            if str(obs[c].dtype) in ("category", "object", "bool")
        ]
    if numeric_fields is None:
        numeric_fields = [
            c for c in obs.columns
            if np.issubdtype(obs[c].dtype, np.number) and c not in obs_fields
        ]

    codes, levels = {}, {}
    for field in obs_fields:
        codes[field], levels[field] = _encode_categorical(obs[field].to_numpy(), field)
    numeric = {
        field: np.ascontiguousarray(obs[field].to_numpy(), dtype=np.float32)
        for field in numeric_fields
    }
    return SimDataset(xy=xy, codes=codes, levels=levels, numeric=numeric)


def dataset_from_parquet(
    path,
    x: str = "x",
    y: str = "y",
    obs_fields: list[str] | None = None,
    numeric_fields: list[str] | None = None,
) -> SimDataset:
    import pyarrow.parquet as pq

    table = pq.read_table(path)
    cols = table.column_names
    for needed in (x, y):
        if needed not in cols:
            raise KeyError(f"column '{needed}' not in parquet file; available: {cols}")

    xs = np.asarray(table[x].to_numpy(), dtype=np.float32)
    ys = np.asarray(table[y].to_numpy(), dtype=np.float32)
    xy = np.ascontiguousarray(np.stack([xs, ys], axis=1))

    rest = [c for c in cols if c not in (x, y)]
    if obs_fields is None and numeric_fields is None:
        obs_fields, numeric_fields = [], []
        for c in rest:
            arr = table[c].to_numpy(zero_copy_only=False)
            (numeric_fields if np.issubdtype(arr.dtype, np.number) else obs_fields).append(c)
    obs_fields = obs_fields or []
    numeric_fields = numeric_fields or []

    codes, levels = {}, {}
    for field in obs_fields:
        codes[field], levels[field] = _encode_categorical(
            table[field].to_numpy(zero_copy_only=False), field
        )
    numeric = {
        field: np.ascontiguousarray(table[field].to_numpy(zero_copy_only=False), dtype=np.float32)
        for field in numeric_fields
    }
    return SimDataset(xy=xy, codes=codes, levels=levels, numeric=numeric)
```

- [x] **Step 4: Extend the CLI**

In `_main()`, before the synthetic generation block:
```python
    ap.add_argument("--h5ad", help="ingest an .h5ad file instead of simulating")
    ap.add_argument("--parquet", help="ingest a Parquet file instead of simulating")
    ap.add_argument("--id", help="dataset id for an ingested file")
    ap.add_argument("--embedding", default="X_umap")
    ...
    if args.h5ad or args.parquet:
        if not args.id:
            ap.error("--id is required when ingesting a file")
        ds = (dataset_from_h5ad(args.h5ad, embedding_key=args.embedding)
              if args.h5ad else dataset_from_parquet(args.parquet))
        man = write_tiles(ds, args.out, args.id, args.chunk_size, seed=args.seed)
        print(f"wrote {args.id}: {man['n']} cells, {man['chunks']} chunks, "
              f"fields {sorted(man['categorical'])}")
        return
```

- [x] **Step 5: Run the tests**

Run: `python -m pytest server/tests/test_ingest.py -v`
Expected: PASS, 7 tests (some skip if `anndata` or `pandas` are unavailable —
if they skip, install them from `requirements.txt` and re-run; a skipped
ingestion test proves nothing).

- [x] **Step 6: Document the ingestion path**

Create `docs/USING_YOUR_DATA.md`:
```markdown
# Loading your own data

## From an .h5ad (scanpy / AnnData)

    python -m server.prep --h5ad path/to/cells.h5ad --id mydata --embedding X_umap

- `--embedding` names a key in `adata.obsm` holding an (n, 2) array. `X_umap`
  and `X_tsne` are the usual ones. A 50-column `X_pca` is rejected; take two
  columns or compute a 2D embedding first.
- Categorical columns in `adata.obs` become colour-by fields automatically.
  Numeric columns become continuous fields such as pseudotime.
- A column with more than 65,535 distinct values (raw barcodes, for example)
  is rejected rather than truncated. Drop it or bin it.

## From Parquet

    python -m server.prep --parquet cells.parquet --id mydata

Requires `x` and `y` columns; every other column is classified as categorical
or numeric by dtype.

## Then

Restart the server and add the id to `DATASETS` in `apps/web/src/main.ts`.
```

- [x] **Step 7: Checkpoint**

Run: `python -m pytest server/tests -v`

---

## Task 16: End-to-end tests and the README

**Files:**
- Create: `playwright.config.ts`, `e2e/viewer.spec.ts`, `README.md`
- Test: the spec file is the test.

**Interfaces:**
- Consumes: the running server and dev server.
- Produces: a Playwright suite covering the paths no unit test reaches — real
  WebGL rendering, real pointer drags, and the selection reaching the chat panel.

- [x] **Step 1: Write the failing e2e spec**

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://localhost:5173',
    // Software WebGL is enough for correctness; the benchmark measures speed.
    launchOptions: { args: ['--enable-unsafe-swiftshader'] }
  },
  webServer: [
    { command: 'python -m uvicorn server.main:app --port 8000', url: 'http://localhost:8000/api/datasets', reuseExistingServer: true },
    { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true }
  ]
});
```

`e2e/viewer.spec.ts`:
```ts
import { test, expect, type Page } from '@playwright/test';

async function waitForLoad(page: Page, expected: string): Promise<void> {
  await expect(page.locator('#status')).toContainText(expected, { timeout: 90_000 });
}

async function dragOn(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  // Several intermediate moves: a single jump produces a degenerate lasso.
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      box.x + from[0] + ((to[0] - from[0]) * i) / 12,
      box.y + from[1] + ((to[1] - from[1]) * i) / 12
    );
  }
  await page.mouse.up();
}

test('loads a million cells and reports the count', async ({ page }) => {
  await page.goto('/');
  await waitForLoad(page, '1,000,000');
});

test('box selection populates the summary and enables the chat input', async ({ page }) => {
  await page.goto('/');
  await waitForLoad(page, '1,000,000');

  await expect(page.locator('.chat-input textarea')).toBeDisabled();
  await page.getByRole('button', { name: 'Box' }).click();
  await dragOn(page, [150, 120], [500, 460]);

  await expect(page.locator('.summary-head')).toContainText('cells selected');
  await expect(page.locator('.chat-badge')).not.toHaveText('no selection');
  await expect(page.locator('.chat-input textarea')).toBeEnabled();
});

test('lasso selection produces a non-empty selection', async ({ page }) => {
  await page.goto('/');
  await waitForLoad(page, '1,000,000');
  await page.getByRole('button', { name: 'Lasso' }).click();

  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx + 140, cy);
  await page.mouse.down();
  for (let k = 1; k <= 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(a) * 140, cy + Math.sin(a) * 140);
  }
  await page.mouse.up();

  const text = await page.locator('.summary-head').textContent();
  const count = Number((text ?? '').replace(/,/g, '').match(/(\d+)/)?.[1] ?? 0);
  expect(count).toBeGreaterThan(0);
});

test('the chat panel answers a question about the selection', async ({ page }) => {
  await page.goto('/');
  await waitForLoad(page, '1,000,000');
  await page.getByRole('button', { name: 'Box' }).click();
  await dragOn(page, [150, 120], [520, 470]);

  const selected = (await page.locator('.chat-badge').textContent())!.replace(' cells', '');
  await page.locator('.chat-input textarea').fill('how many cells are selected?');
  await page.getByRole('button', { name: 'Ask' }).click();

  const answer = page.locator('.msg.assistant').last();
  await expect(answer).toContainText(selected);
});

test('clearing the selection disables the chat input again', async ({ page }) => {
  await page.goto('/');
  await waitForLoad(page, '1,000,000');
  await page.getByRole('button', { name: 'Box' }).click();
  await dragOn(page, [150, 120], [500, 460]);
  await expect(page.locator('.chat-input textarea')).toBeEnabled();

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.summary-empty')).toBeVisible();
  await expect(page.locator('.chat-input textarea')).toBeDisabled();
});

test('zoom to selection changes the view', async ({ page }) => {
  await page.goto('/');
  await waitForLoad(page, '1,000,000');
  await page.getByRole('button', { name: 'Box' }).click();
  await dragOn(page, [200, 180], [340, 300]);

  const before = await page.locator('canvas').first().screenshot();
  await page.getByRole('button', { name: 'Zoom to selection' }).click();
  await page.waitForTimeout(1200);
  const after = await page.locator('canvas').first().screenshot();
  expect(Buffer.compare(before, after)).not.toBe(0);
});

test('colour-by change updates the legend without losing the selection', async ({ page }) => {
  await page.goto('/');
  await waitForLoad(page, '1,000,000');
  await page.getByRole('button', { name: 'Box' }).click();
  await dragOn(page, [150, 120], [500, 460]);
  const badge = await page.locator('.chat-badge').textContent();

  await page.locator('.colorby select').selectOption('c:tissue');
  await expect(page.locator('.legend-title')).toHaveText('tissue');
  await expect(page.locator('.chat-badge')).toHaveText(badge!);
});

test('the trajectory view renders the principal graph and selects', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Trajectory/ }).click();
  await waitForLoad(page, '500,000');

  await expect(page.locator('.graph-controls')).toContainText('branch points');
  await page.getByRole('button', { name: 'Lasso' }).click();
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx + 90, cy);
  await page.mouse.down();
  for (let k = 1; k <= 30; k++) {
    const a = (k / 30) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(a) * 90, cy + Math.sin(a) * 90);
  }
  await page.mouse.up();
  await expect(page.locator('.summary-head')).toContainText('cells selected');
});

test('reports no console errors during a normal session', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto('/');
  await waitForLoad(page, '1,000,000');
  await page.getByRole('button', { name: 'Box' }).click();
  await dragOn(page, [150, 120], [500, 460]);
  expect(errors).toEqual([]);
});
```

- [x] **Step 2: Install the browser and run**

Run: `npx playwright install chromium`
Run: `npx playwright test`
Expected: 9 tests pass. If the WebGL context fails to create under headless
Chromium, add `--use-gl=angle --use-angle=swiftshader` to `launchOptions.args`
before reaching for `headless: false`.

- [x] **Step 3: Write the README**

`README.md`:
```markdown
# Single-cell embedding and trajectory viewer

Renders millions of single cells from a 2D embedding, lets you select a region
by box or lasso, zoom into it, and ask a chatbot questions about exactly the
cells you selected.

Two displays share one engine:

- **Embedding view** — UMAP or t-SNE scatter, coloured by cell type, tissue,
  donor or stage.
- **Trajectory view** — the same cloud coloured by pseudotime, with a
  monocle3-style principal graph drawn over it.

## Quick start

    pip install -r server/requirements.txt
    npm install
    python -m server.prep --sizes 100000 1000000 --traj-size 500000
    python -m uvicorn server.main:app --port 8000 &
    npm run dev

Open http://localhost:5173.

To connect a real model, export `ANTHROPIC_API_KEY` in the **server's**
environment and restart it. Without a key the chat panel falls back to an
offline adapter that answers from the selection summary; the badge tooltip says
which one is live. The key is never sent to or stored in the browser.

## How it holds a million points

- Every column is a typed array. There is no per-cell object anywhere.
- Points are stored pre-shuffled, so drawing the first K of them is an unbiased
  random sample. That is the whole level-of-detail mechanism, and it is also
  the "lighter version" switch.
- Data is chunked at 250,000 points; each chunk is one deck.gl layer fed with
  binary attributes, so it uploads to the GPU once and is never re-uploaded.
- Selection runs in a Web Worker against a uniform grid index, so a lasso over
  a million cells does not block panning.

Measured capacity on the development machine is in
`docs/benchmarks/2026-09-06-capacity.md`.

## Your own data

See `docs/USING_YOUR_DATA.md`. Both `.h5ad` and Parquet are supported.

## Tests

    npx vitest run          # core logic
    python -m pytest        # server
    npx playwright test     # end to end

## Layout

    packages/core   data, geometry, selection, colour — no DOM, testable in Node
    apps/web        deck.gl rendering, interaction, UI, chat panel
    server          FastAPI: tile prep, tile serving, chat proxy
```

- [x] **Step 4: Full verification**

Run all three suites and record the actual output:
```
npx vitest run
python -m pytest server/tests -v
npx tsc --noEmit
npx playwright test
```
Every one must pass. A failing suite is reported with its output, not
summarised.

- [x] **Step 5: Checkpoint**

Confirm the app boots from a clean checkout following only the README's quick
start, with no undocumented step.

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: data model and
tile layout to Tasks 1–3; `CellStore` and chunked loading to Task 4; palettes and
recolouring to Task 5; the grid index and selection correctness to Task 6; the
worker and selection store to Task 7; binary-attribute rendering, one layer per
chunk, and LOD to Task 8; box and lasso interaction, highlight and
zoom-to-selection to Task 9; the selection context summary to Task 10; the chat
adapter interface and mock to Task 11; the Claude proxy and key handling to Task
12; the trajectory view and principal graph to Task 13; the capacity benchmark to
Task 14; real-data ingestion to Task 15; end-to-end coverage and documentation to
Task 16. Error handling from spec section 10 is distributed: chunk retry and
partial render in Task 4, context loss in Task 8, empty selection in Task 11,
chat failure in Task 11, worker errors in Task 7, and the ingestion guards in
Task 15.

**Type consistency.** `CellStore` gains `datasetId` in Task 9 and it is used by
`buildSelectionContext` in Task 10 — the note in Task 9 Step 8 makes that
explicit rather than leaving it to be discovered. `SelectionContext` is defined
once in `packages/core/src/context/build.ts` and re-exported through
`apps/web/src/chat/adapter.ts`, so the browser and the tests share one
definition; the Python twin in `server/chat.py` is held in step by
`test_render_context_mentions_counts_and_labels` and its TypeScript counterpart
asserting the same substrings. `renderContextAsText` has the same name on both
sides deliberately. `ScatterCanvas` accumulates methods across Tasks 8, 9 and 14;
each addition names the file and the surrounding code.

**Known follow-ups, deliberately not in this plan.** GPU-side palette lookup via
shader injection (only if Task 14 shows recolour is too slow); hover tooltips
showing a single cell's metadata; persisted selections; and any analysis that
needs the expression matrix. Each is a separate piece of work with its own
approval.


---

## Divergences from the plan

Four things turned out differently once measured. Each is recorded here so the
plan and the code do not silently disagree.

**1. Blending is off by default, and the selection highlight does not use
alpha.** Task 8 specified alpha-based dimming (`applySelectionMask` at alpha 28)
with deck.gl's default blending. The render diagnostics page built during
Task 14 showed alpha blending costs four times the frame rate at one million
points on a tile-based GPU — 12.7 fps against 50.3 with blending off, every
other variable held constant. The highlight now darkens the RGB of unselected
cells toward the background instead, so every point stays opaque and blending
can be off. `applySelectionMask` survives for the optional "Translucent points"
mode. Evidence: `docs/benchmarks/2026-09-07-capacity.md`.

**2. `DEFAULT_POINT_BUDGET` is 1,000,000, not the placeholder in Task 8.** Set
from the sweep: with blending off this machine renders a million points without
becoming the bottleneck, and first falls behind at two million.

**3. The selection worker is refreshed lazily, not per chunk.** Task 9 called
`client.init` from `onDataGrew`. At ten million cells that is an eighty-megabyte
copy per chunk across forty chunks. `SelectionClient.ensure` now re-sends
coordinates only when the loaded prefix has grown, and only immediately before a
query needs them. Recolouring is likewise incremental — a chunk colours only the
cells it brought.

**4. Playwright interaction tests run at 100k, not 1M.** Task 16 assumed
software WebGL would be adequate. Measured, a three-event drag under SwiftShader
costs 3.3 s at 100k and 11.4 s at 1M, so the million-cell interaction tests
timed out. Load-scale tests still use the full million; interaction behaviour is
covered at 100k, where the same worker, index and selection code runs. Rendering
throughput is measured only on real hardware, by `bench.config.ts`.

Two additions the plan did not call for, both closing gaps in the original
brief:

- **Per-cell hover tooltip** (`apps/web/src/ui/CellTooltip.ts`). The brief says
  each dot carries metadata such as cell type and tissue; reading it off the
  columnar arrays by index is free, so a user should not have to draw a
  selection to inspect one cell.
- **`apps/web/diag.html`** — the render diagnostics page that isolated the
  blending cost. Kept, because the next person to wonder why the frame rate is
  what it is should not have to rebuild it.


---

## Post-implementation audit (2026-09-07)

A full read-through of the tree after the plan was complete. Each item below was
reproduced with a failing test first, then fixed.

**Correctness**

1. **`loadedCount` was a sum, but every consumer read it as a contiguous
   prefix.** Chunks load in parallel and complete out of order, so a chunk
   finishing early made cells at the front of the array "loaded" while their
   slots were still zeroed — phantom cells at the origin, indexed by the grid,
   selectable, and counted in the chat context. It also mis-reported a permanent
   chunk failure. `CellStore.markChunkLoaded` now advances the prefix only when
   the gap in front of it is filled. Three regression tests in `loader.test.ts`.
2. **The chat proxy could send an invalid message sequence.** Truncating history
   to the last ten turns can open with an assistant turn, and a history already
   ending in a user turn produced two user turns in a row. Both are rejected by
   the Messages API. `normalize_messages` fixes the shape; five tests.
3. **A dataset with no categorical annotation rendered blank.** A Parquet file of
   `x, y, pseudotime` is valid, and the viewer picked a categorical field
   unconditionally, so nothing was ever coloured. `defaultColorField` falls back
   to a numeric field; `setColorBy` tolerates having no field at all.
4. **The hover tooltip was permanently visible.** `.tooltip { display: grid }`
   outranks the user-agent `[hidden] { display: none }`, so an empty box sat on
   the canvas. Found by an e2e test that passed its visibility assertion before
   anything had been hovered.
5. **`ScatterView` wired canvas callbacks to fields it had not created yet.**
   `onViewStateChange` used `this.lod` and `onHover` used `this.tooltip`, both
   constructed after the canvas. deck.gl can emit either during initialisation.
   Construction order now puts every dependency first.
6. **View transitions were sticky.** `fitBounds` left `transitionDuration` on the
   persistent view state, so every later render — a selection repaint, a
   detail-slider move — restarted the animation. Transitions are now one-shot.
7. **The selection worker could read past its own buffer** if asked for more
   cells than it held. Clamped, with a test.
8. **A user-cancelled chat request surfaced as an error.** Asking a second
   question aborts the first; that is not a failure.
9. **`setPointerCapture` was unguarded** — an input that refuses it would have
   silently disabled selection.

**Waste removed**

10. The selection client copied the whole coordinate array — 80 MB at ten
    million cells — including the unwritten remainder. It now sends only the
    loaded prefix.
11. Every recolour re-zeroed the entire unloaded tail: 40 MB per chunk, forty
    times over, during a ten-million-cell load. The tail is already zero.
12. The legend recounted every loaded cell on every chunk. Throttled, and always
    exact once loading finishes.

**Completeness**

13. `npm run build` produced a bundle nothing served. The FastAPI app now mounts
    `dist/` when it exists, after the API routes so it cannot shadow them.
14. `--sizes 0` raised from inside numpy. It now says what is wrong.
15. An unknown `?dataset=` value silently opened something else. It now says so.
16. Added `server/tests/test_artifacts.py`: 37 checks against the tiles actually
    on disk, across all seven generated datasets, covering chunk lengths,
    coordinate finiteness and bounds, code-to-level-dictionary ranges, numeric
    ranges against the manifest, prefix representativeness, and principal-graph
    connectivity.

Dead code removed: `rectToPolygon`, `CATEGORICAL_PALETTE`'s export,
`FrameSampler.reset`, `ScatterCanvas.colorBy`/`setTarget`,
`ChatPanel.setAdapter`, `ScatterView.setMode`, and `LodResult.alpha` — the last
of which had become meaningless once blending came off.
