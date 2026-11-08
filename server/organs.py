"""Synthetic organ datasets for the Organ View.

Each organ gets two datasets that describe the same cells in the same order:
a UMAP, where cells cluster by anatomical region, and a trajectory, where each
region is its own stretch of a branching tree. Because the cells correspond
index for index, a part of the organ selected in either view is the same set of
cells in the other, with no lookup between them. They are written with one
shuffle seed, so the alignment survives the tile writer's permutation.

Everything here is invented: the regions and cell types are the ones the organ
figures recognise (from `ATLAS_ORGANS`), but which cells sit where, and every
embedding coordinate, is random. The manifests say `synthetic`, and the viewer
shows that wherever it draws them. They stand in for organ data that has not
been supplied, and must never be read as a biological result.
"""
from __future__ import annotations

import zlib
from pathlib import Path

import numpy as np

from .prep import write_tiles
from .simulate import (
    ATLAS_ORGANS,
    DONORS,
    STAGES,
    PrincipalGraph,
    SimDataset,
    _grow_tree,
    synthetic_ids,
)

#: The organs the Organ View shows: the ones with a detailed figure and regions.
ORGAN_VIEW_ORGANS = ("heart", "brain", "liver")

MIN_CELLS = 20
#: Share of a region's cells that sit on the region's own stretch of the tree.
ON_LINEAGE = 0.92
GRAPH_NODES = 80


def organ_dataset_ids(organ: str) -> dict[str, str]:
    """The tile ids of an organ's UMAP and trajectory datasets."""
    if organ not in ORGAN_VIEW_ORGANS:
        raise ValueError(f"unknown organ {organ!r}; the Organ View has {', '.join(ORGAN_VIEW_ORGANS)}")
    return {"umap": f"organ-{organ}-umap", "trajectory": f"organ-{organ}-traj"}


def _tree_order(nodes: int, edges: list[tuple[int, int]]) -> tuple[list[tuple[int, int]], list[int]]:
    """Edges (parent, child) in depth-first order from the root, and each node's parent."""
    children: list[list[int]] = [[] for _ in range(nodes)]
    parent = [-1] * nodes
    for a, b in edges:
        children[a].append(b)
        parent[b] = a
    order: list[tuple[int, int]] = []
    stack = [0]
    while stack:
        at = stack.pop()
        for c in reversed(sorted(children[at])):
            stack.append(c)
        if at != 0:
            order.append((parent[at], at))
    return order, parent


def simulate_organ(
    organ: str, n: int, seed: int = 0, n_nodes: int = GRAPH_NODES
) -> tuple[SimDataset, SimDataset, PrincipalGraph]:
    """An organ's UMAP dataset, its trajectory dataset and the trajectory's graph."""
    organ_dataset_ids(organ)  # validates the name
    if n < MIN_CELLS:
        raise ValueError(f"an organ needs at least {MIN_CELLS} cells, got {n}")
    spec = ATLAS_ORGANS[organ]
    regions: list[str] = list(spec["regions"])
    types: list[str] = list(spec["types"])
    k_regions, k_types = len(regions), len(types)
    rng = np.random.default_rng([seed, zlib.crc32(organ.encode())])

    for _ in range(20):
        nodes, edges, branch_points, leaves = _grow_tree(rng, n_nodes)
        if len(leaves) >= 3:
            break
    m = int(nodes.shape[0])
    order, parent = _tree_order(m, edges)
    groups = np.array_split(np.arange(len(order)), k_regions)

    # Distance from the root along the tree, then scaled to pseudotime in [0, 1].
    dist = np.zeros(m)
    for a, b in order:
        dist[b] = dist[a] + float(np.linalg.norm(nodes[a] - nodes[b]))
    node_pt = dist / max(float(dist.max()), 1e-9)

    # Regions first; the first few cells are fixed so every region has some.
    weights = rng.dirichlet(np.full(k_regions, 6.0))
    region = rng.choice(k_regions, size=n, p=weights)
    region[:k_regions] = np.arange(k_regions)

    # Each cell sits on an edge of its region's stretch of the tree, mostly.
    order_a = np.array([a for a, _ in order])
    order_b = np.array([b for _, b in order])
    edge = np.empty(n, dtype=np.int64)
    for r in range(k_regions):
        idx = np.flatnonzero(region == r)
        edge[idx] = rng.choice(groups[r], size=idx.size)
    stray = rng.random(n) > ON_LINEAGE
    edge[stray] = rng.integers(0, len(order), size=int(stray.sum()))
    t = rng.random(n)
    a, b = order_a[edge], order_b[edge]
    traj_xy = (nodes[a] + (nodes[b] - nodes[a]) * t[:, None] + rng.normal(0, 0.45, size=(n, 2))).astype(np.float32)
    pseudotime = np.clip(node_pt[a] * (1 - t) + node_pt[b] * t, 0.0, 1.0).astype(np.float32)

    # Cell types: each region has one dominant type and a scatter of the rest.
    cell_type = np.empty(n, dtype=np.uint16)
    for r in range(k_regions):
        alpha = np.full(k_types, 0.6)
        alpha[r % k_types] += 5.0
        idx = np.flatnonzero(region == r)
        cell_type[idx] = rng.choice(k_types, size=idx.size, p=rng.dirichlet(alpha))

    # The UMAP: a cluster per region on a ring, sub-clustered by type.
    angle = 2 * np.pi * np.arange(k_regions) / k_regions
    centres = 12.0 * np.stack([np.cos(angle), np.sin(angle)], axis=1) + rng.normal(0, 0.6, size=(k_regions, 2))
    type_offset = rng.normal(0, 2.2, size=(k_types, 2))
    umap_xy = (centres[region] + type_offset[cell_type] + rng.normal(0, 1.1, size=(n, 2))).astype(np.float32)

    stage = np.clip((pseudotime * len(STAGES)).astype(np.int64), 0, len(STAGES) - 1).astype(np.uint16)
    codes = {
        "cell_type": cell_type,
        "tissue": np.zeros(n, dtype=np.uint16),
        "anatomical_region": region.astype(np.uint16),
        "donor": rng.integers(0, len(DONORS), size=n).astype(np.uint16),
        "stage": stage,
    }
    levels = {
        "cell_type": types,
        "tissue": [organ],
        "anatomical_region": regions,
        "donor": list(DONORS),
        "stage": list(STAGES),
    }

    def dataset(xy: np.ndarray) -> SimDataset:
        return SimDataset(
            xy=xy,
            codes={f: v.copy() for f, v in codes.items()},
            levels={f: list(v) for f, v in levels.items()},
            numeric={"pseudotime": pseudotime.copy()},
            ids=synthetic_ids(n),
        )

    graph = PrincipalGraph(nodes=nodes, edges=edges, root=0, branch_points=branch_points, leaves=leaves)
    return dataset(umap_xy), dataset(traj_xy), graph


def build_organ_tiles(
    out_dir: Path | str, n: int, chunk_size: int = 250_000, seed: int = 0
) -> dict[str, dict[str, dict]]:
    """Writes the UMAP and trajectory tiles of every Organ View organ.

    Both datasets of an organ use the same shuffle seed, which is what keeps
    their cells aligned on disk. Returns each organ's two manifests.
    """
    out: dict[str, dict[str, dict]] = {}
    for organ in ORGAN_VIEW_ORGANS:
        ids = organ_dataset_ids(organ)
        umap, traj, graph = simulate_organ(organ, n, seed=seed)
        meta = {"synthetic": True, "organ": organ}
        out[organ] = {
            "umap": write_tiles(
                umap, out_dir, ids["umap"], chunk_size, seed=seed, extra={**meta, "kind": "umap"}
            ),
            "trajectory": write_tiles(
                traj, out_dir, ids["trajectory"], chunk_size, graph=graph, seed=seed,
                extra={**meta, "kind": "trajectory"},
            ),
        }
    return out
