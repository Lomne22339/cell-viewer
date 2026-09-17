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
    tds, g = simulate_trajectory(n, seed=0)
    assert tds.xy.shape == (n, 2)


def test_zero_or_negative_n_is_rejected_clearly():
    """A bad --sizes argument should say what is wrong, not raise from numpy."""
    for n in (0, -5):
        with pytest.raises(ValueError, match="at least 1"):
            simulate_embedding(n)
        with pytest.raises(ValueError, match="at least 1"):
            simulate_trajectory(n)
