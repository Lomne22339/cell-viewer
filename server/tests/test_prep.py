import json

import numpy as np

from server.prep import shuffle_dataset, write_tiles
from server.simulate import simulate_embedding, simulate_trajectory


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
