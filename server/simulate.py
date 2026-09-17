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
        return int(self.xy.shape[0])


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
    # Fix rounding drift onto the largest cluster so the total is exactly n.
    while sizes.sum() > n:
        biggest = int(np.argmax(sizes))
        sizes[biggest] -= 1
    sizes[int(np.argmax(sizes))] += n - int(sizes.sum())
    return sizes


def simulate_embedding(n: int, seed: int = 0) -> SimDataset:
    if n < 1:
        raise ValueError(f"n must be at least 1, got {n}")
    rng = np.random.default_rng(seed)
    k = max(1, min(len(CELL_TYPES), n))
    sizes = _cluster_sizes(rng, n, k)

    centers = rng.uniform(-45.0, 45.0, size=(k, 2))
    xy = np.empty((n, 2), dtype=np.float32)
    ct = np.empty(n, dtype=np.uint16)

    off = 0
    for c in range(k):
        m = int(sizes[c])
        if m <= 0:
            continue
        # Anisotropic blob: real clusters are elongated, not circular.
        scale = rng.uniform(1.2, 4.5, size=2)
        theta = rng.uniform(0, np.pi)
        rot = np.array([[np.cos(theta), -np.sin(theta)],
                        [np.sin(theta), np.cos(theta)]])
        pts = rng.standard_normal((m, 2)) * scale
        # A heavy tail gives the wisps that connect islands in a real UMAP.
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
        count = int(sel.sum())
        if count == 0:
            continue
        probs = rng.dirichlet(np.full(len(TISSUES), 0.4))
        tissue[sel] = rng.choice(len(TISSUES), size=count, p=probs).astype(np.uint16)

    donor = rng.integers(0, len(DONORS), size=n).astype(np.uint16)
    stage = rng.integers(0, len(STAGES), size=n).astype(np.uint16)

    span = np.linalg.norm(xy - xy.mean(axis=0), axis=1)
    span_range = float(np.ptp(span))
    pseudotime = ((span - span.min()) / max(span_range, 1e-9)).astype(np.float32)

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


def _grow_tree(
    rng: np.random.Generator, m: int
) -> tuple[np.ndarray, list[tuple[int, int]], list[int], list[int]]:
    """Grow a branching tree in 2D by random walk with occasional splits."""
    nodes: list[np.ndarray] = [np.zeros(2, dtype=np.float64)]
    edges: list[tuple[int, int]] = []
    frontier: list[tuple[int, float]] = [(0, float(rng.uniform(0, 2 * np.pi)))]
    branch_points: list[int] = []

    while len(nodes) < m and frontier:
        idx, heading = frontier.pop(int(rng.integers(len(frontier))))
        steps = int(rng.integers(4, 14))
        cur, head = idx, heading
        for _ in range(steps):
            if len(nodes) >= m:
                break
            head += float(rng.normal(0, 0.25))
            nxt = nodes[cur] + np.array([np.cos(head), np.sin(head)]) * rng.uniform(1.5, 3.0)
            nodes.append(nxt)
            edges.append((cur, len(nodes) - 1))
            cur = len(nodes) - 1
        if len(nodes) < m and rng.random() < 0.75:
            branch_points.append(cur)
            frontier.append((cur, head + float(rng.uniform(0.4, 1.1))))
            frontier.append((cur, head - float(rng.uniform(0.4, 1.1))))

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
    # Only keep branch points that really ended up with degree > 2.
    branch_points = sorted({i for i in branch_points if degree[i] > 2})
    return arr, edges, branch_points, leaves


def simulate_trajectory(
    n: int, seed: int = 0, n_nodes: int = 240
) -> tuple[SimDataset, PrincipalGraph]:
    if n < 1:
        raise ValueError(f"n must be at least 1, got {n}")
    rng = np.random.default_rng(seed)
    m_target = max(3, min(n_nodes, max(3, n)))
    nodes, edges, branch_points, leaves = _grow_tree(rng, m_target)
    m = int(nodes.shape[0])

    # Scatter cells along edges so the cloud hugs the graph.
    eidx = rng.integers(0, len(edges), size=n)
    t = rng.random(n).astype(np.float32)
    ea = np.array([edges[i][0] for i in eidx])
    eb = np.array([edges[i][1] for i in eidx])
    a = nodes[ea]
    b = nodes[eb]
    on_edge = a + (b - a) * t[:, None]
    xy = (on_edge + rng.normal(0, 0.45, size=(n, 2))).astype(np.float32)

    # Pseudotime = graph distance from the root, normalised, carried onto cells.
    adj: dict[int, list[tuple[int, float]]] = {i: [] for i in range(m)}
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
    finite = dist[np.isfinite(dist)]
    node_pt = (dist / max(float(finite.max()) if finite.size else 1.0, 1e-9)).astype(np.float32)
    node_pt = np.clip(node_pt, 0.0, 1.0)
    cell_pt = np.clip(node_pt[ea] * (1 - t) + node_pt[eb] * t, 0.0, 1.0)

    # Cell type follows the branch a cell sits on: a lineage, not noise.
    branch_of = np.zeros(m, dtype=np.uint16)
    branch_set = set(branch_points)
    label = 0
    for node in np.argsort(node_pt):
        if int(node) in branch_set:
            label = (label + 1) % len(CELL_TYPES)
        branch_of[node] = label
    ct = branch_of[ea].astype(np.uint16)

    tissue = rng.integers(0, len(TISSUES), size=n).astype(np.uint16)
    donor = rng.integers(0, len(DONORS), size=n).astype(np.uint16)
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
