"""Integrity checks against the tiles actually on disk.

The unit tests verify the writer; these verify the artifacts a browser will
really be served, including the large ones. They skip if the datasets have not
been generated.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

TILES = Path(__file__).resolve().parents[2] / "data" / "tiles"


def _datasets() -> list[Path]:
    if not TILES.is_dir():
        return []
    return sorted(p for p in TILES.iterdir() if (p / "manifest.json").is_file())


DATASETS = _datasets()
pytestmark = pytest.mark.skipif(
    not DATASETS, reason="no tiles generated; run python -m server.prep"
)


@pytest.mark.parametrize("root", DATASETS, ids=lambda p: p.name)
def test_every_chunk_has_the_length_the_manifest_implies(root: Path):
    man = json.loads((root / "manifest.json").read_text())
    n, size, chunks = man["n"], man["chunkSize"], man["chunks"]
    assert chunks == -(-n // size)

    total = 0
    for c in range(chunks):
        expect = min(size, n - c * size)
        total += expect
        xy = np.fromfile(root / "xy" / f"{c:03d}.bin", dtype=np.float32)
        assert xy.size == expect * 2, f"{root.name} chunk {c} xy"
        for field in man["categorical"]:
            arr = np.fromfile(root / "codes" / field / f"{c:03d}.bin", dtype=np.uint16)
            assert arr.size == expect, f"{root.name} chunk {c} {field}"
        for field in man["numeric"]:
            arr = np.fromfile(root / "num" / field / f"{c:03d}.bin", dtype=np.float32)
            assert arr.size == expect, f"{root.name} chunk {c} {field}"
    assert total == n


@pytest.mark.parametrize("root", DATASETS, ids=lambda p: p.name)
def test_coordinates_are_finite_and_inside_the_declared_bounds(root: Path):
    man = json.loads((root / "manifest.json").read_text())
    x0, y0, x1, y1 = man["bounds"]
    for c in range(man["chunks"]):
        xy = np.fromfile(root / "xy" / f"{c:03d}.bin", dtype=np.float32).reshape(-1, 2)
        assert np.isfinite(xy).all(), f"{root.name} chunk {c} has non-finite coordinates"
        assert xy[:, 0].min() >= x0 and xy[:, 0].max() <= x1
        assert xy[:, 1].min() >= y0 and xy[:, 1].max() <= y1


@pytest.mark.parametrize("root", DATASETS, ids=lambda p: p.name)
def test_codes_index_inside_their_level_dictionary(root: Path):
    """An out-of-range code would colour a cell as the wrong population."""
    man = json.loads((root / "manifest.json").read_text())
    for field, spec in man["categorical"].items():
        levels = len(spec["levels"])
        assert levels > 0
        for c in range(man["chunks"]):
            arr = np.fromfile(root / "codes" / field / f"{c:03d}.bin", dtype=np.uint16)
            assert arr.max(initial=0) < levels, f"{root.name}.{field} chunk {c}"


@pytest.mark.parametrize("root", DATASETS, ids=lambda p: p.name)
def test_numeric_values_match_the_declared_range(root: Path):
    man = json.loads((root / "manifest.json").read_text())
    for field, spec in man["numeric"].items():
        lo = hi = None
        for c in range(man["chunks"]):
            arr = np.fromfile(root / "num" / field / f"{c:03d}.bin", dtype=np.float32)
            assert np.isfinite(arr).all()
            lo = arr.min() if lo is None else min(lo, arr.min())
            hi = arr.max() if hi is None else max(hi, arr.max())
        assert lo == pytest.approx(spec["min"], abs=1e-5)
        assert hi == pytest.approx(spec["max"], abs=1e-5)


@pytest.mark.parametrize("root", DATASETS, ids=lambda p: p.name)
def test_the_shuffle_left_a_representative_prefix(root: Path):
    """Level of detail draws a prefix, so a prefix must look like the whole."""
    man = json.loads((root / "manifest.json").read_text())
    field = next(iter(man["categorical"]), None)
    if field is None or man["n"] < 10_000:
        pytest.skip("needs a categorical field and enough cells")
    levels = len(man["categorical"][field]["levels"])

    full = np.zeros(levels, dtype=np.int64)
    for c in range(man["chunks"]):
        arr = np.fromfile(root / "codes" / field / f"{c:03d}.bin", dtype=np.uint16)
        full += np.bincount(arr, minlength=levels)
    first = np.fromfile(root / "codes" / field / "000.bin", dtype=np.uint16)
    prefix = np.bincount(first[: max(1, len(first) // 10)], minlength=levels)

    full_frac = full / full.sum()
    prefix_frac = prefix / prefix.sum()
    assert np.abs(full_frac - prefix_frac).max() < 0.05, "prefix is not representative"


@pytest.mark.parametrize(
    "root", [p for p in DATASETS if (p / "graph.json").is_file()], ids=lambda p: p.name
)
def test_principal_graph_indices_are_in_range_and_connected(root: Path):
    graph = json.loads((root / "graph.json").read_text())
    m = len(graph["nodes"])
    assert m > 0
    assert all(len(node) == 2 for node in graph["nodes"])
    for i, j in graph["edges"]:
        assert 0 <= i < m and 0 <= j < m, "edge references a node that does not exist"
    for key in ("branchPoints", "leaves"):
        assert all(0 <= i < m for i in graph[key])
    assert 0 <= graph["root"] < m

    adj: dict[int, list[int]] = {i: [] for i in range(m)}
    for i, j in graph["edges"]:
        adj[i].append(j)
        adj[j].append(i)
    seen, stack = {graph["root"]}, [graph["root"]]
    while stack:
        for nxt in adj[stack.pop()]:
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    assert len(seen) == m, "the graph is not fully reachable from its root"


def test_manifest_hasgraph_matches_what_is_on_disk():
    for root in DATASETS:
        man = json.loads((root / "manifest.json").read_text())
        assert man["hasGraph"] == (root / "graph.json").is_file(), root.name
