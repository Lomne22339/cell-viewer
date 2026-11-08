import json
import re

import numpy as np
import pytest

from server.prep import shuffle_dataset, write_tiles
from server.simulate import SimDataset, simulate_embedding, simulate_trajectory


def _sorted_rows(ds: SimDataset) -> np.ndarray:
    """Every column of every cell as one row, rows sorted.

    Two datasets compare equal here only if they hold the same cells with the
    same value in every column, so a column permuted on its own shows up.
    """
    cols = [ds.xy[:, 0], ds.xy[:, 1]]
    cols += [ds.codes[k] for k in sorted(ds.codes)]
    cols += [ds.numeric[k] for k in sorted(ds.numeric)]
    rows = np.stack([np.asarray(c, dtype=np.float64) for c in cols], axis=1)
    return rows[np.lexsort(rows.T[::-1])]


def _each_column_permuted_alone(ds: SimDataset, rng: np.random.Generator):
    """Copies of `ds` with exactly one column shuffled independently."""
    def perm(a):
        return a[rng.permutation(len(a))]

    yield "y", SimDataset(np.stack([ds.xy[:, 0], perm(ds.xy[:, 1])], axis=1),
                          ds.codes, ds.levels, ds.numeric)
    for k in ds.codes:
        yield k, SimDataset(ds.xy, {**ds.codes, k: perm(ds.codes[k])}, ds.levels, ds.numeric)
    for k in ds.numeric:
        yield k, SimDataset(ds.xy, ds.codes, ds.levels, {**ds.numeric, k: perm(ds.numeric[k])})


def _strict_json(text: str):
    def reject(token):
        raise ValueError(f"non-standard JSON constant {token}")
    return json.loads(text, parse_constant=reject)


def _read_back(root, man) -> SimDataset:
    """Reassemble the written chunks into one dataset."""
    def col(kind, field, dtype):
        return np.concatenate([
            np.fromfile(root / kind / field / f"{c:03d}.bin", dtype=dtype)
            for c in range(man["chunks"])
        ])

    xy = np.concatenate([
        np.fromfile(root / "xy" / f"{c:03d}.bin", dtype=np.float32) for c in range(man["chunks"])
    ]).reshape(-1, 2)
    return SimDataset(
        xy=xy,
        codes={f: col("codes", f, np.uint16) for f in man["categorical"]},
        levels={f: s["levels"] for f, s in man["categorical"].items()},
        numeric={f: col("num", f, np.float32) for f in man["numeric"]},
    )


def test_shuffle_keeps_every_column_aligned():
    """The whole LOD scheme rests on this: if the permutation is applied
    inconsistently, a cell's coordinates get another cell's cell type and
    the plot is silently wrong. Whole rows are compared — x, y, every code
    and every numeric value — so no column can drift on its own."""
    ds = simulate_embedding(5000, seed=3)
    sh = shuffle_dataset(ds, seed=11)
    assert np.array_equal(_sorted_rows(ds), _sorted_rows(sh))
    assert not np.array_equal(ds.xy, sh.xy), "shuffle must actually reorder"
    # The comparison has teeth: permuting any single column alone breaks it.
    rng = np.random.default_rng(0)
    for name, broken in _each_column_permuted_alone(sh, rng):
        assert not np.array_equal(_sorted_rows(ds), _sorted_rows(broken)), name


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


# --- non-finite values -------------------------------------------------------

def _with_bad_values() -> tuple[SimDataset, np.ndarray]:
    ds = simulate_embedding(1000, seed=12)
    xy = ds.xy.copy()
    xy[3, 0] = np.nan
    xy[10, 1] = np.inf
    xy[11, 0] = -np.inf
    xy[500, :] = np.nan
    score = ds.numeric["pseudotime"].copy()
    score[20] = np.nan
    score[21] = np.inf
    score[22] = -np.inf
    keep = np.ones(ds.n, dtype=bool)
    keep[[3, 10, 11, 500]] = False
    bad = SimDataset(
        xy=xy,
        codes=ds.codes,
        levels=ds.levels,
        numeric={"pseudotime": score, "empty": np.full(ds.n, np.nan, dtype=np.float32)},
    )
    return bad, keep


def test_rows_with_non_finite_coordinates_are_dropped_with_a_warning(tmp_path, capsys):
    bad, keep = _with_bad_values()
    man = write_tiles(bad, tmp_path, "unit", chunk_size=300, seed=4)
    assert man["n"] == int(keep.sum()) == 996
    assert man["chunks"] == 4
    assert "dropped 4 " in capsys.readouterr().err

    back = _read_back(tmp_path / "unit", man)
    assert np.isfinite(back.xy).all()
    # The surviving cells keep every column aligned through the drop and the shuffle.
    expected = SimDataset(
        xy=bad.xy[keep],
        codes={k: v[keep] for k, v in bad.codes.items()},
        levels=bad.levels,
        numeric={k: v[keep] for k, v in bad.numeric.items()},
    )
    assert np.array_equal(_sorted_rows(back), _sorted_rows(expected), equal_nan=True)


def test_manifest_is_strict_json_when_values_are_not_finite(tmp_path):
    bad, keep = _with_bad_values()
    man = write_tiles(bad, tmp_path, "unit", chunk_size=300)
    on_disk = _strict_json((tmp_path / "unit" / "manifest.json").read_text())
    assert on_disk == man
    assert all(np.isfinite(man["bounds"]))
    finite = bad.numeric["pseudotime"][keep]
    finite = finite[np.isfinite(finite)]
    assert man["numeric"]["pseudotime"] == {"min": float(finite.min()), "max": float(finite.max())}
    assert man["numeric"]["empty"] == {"min": 0.0, "max": 0.0}


def test_a_dataset_with_no_finite_coordinates_is_rejected(tmp_path):
    ds = simulate_embedding(10, seed=1)
    ds.xy[:] = np.nan
    with pytest.raises(ValueError, match="finite"):
        write_tiles(ds, tmp_path, "unit")


# --- xy dtype and shape --------------------------------------------------------

def test_float64_coordinates_are_written_as_float32(tmp_path):
    ds = simulate_embedding(700, seed=2)
    wide = SimDataset(xy=ds.xy.astype(np.float64), codes=ds.codes,
                      levels=ds.levels, numeric=ds.numeric)
    write_tiles(wide, tmp_path, "f64", chunk_size=1000, seed=3)
    write_tiles(ds, tmp_path, "f32", chunk_size=1000, seed=3)
    chunk = tmp_path / "f64" / "xy" / "000.bin"
    assert chunk.stat().st_size == 700 * 2 * 4
    assert chunk.read_bytes() == (tmp_path / "f32" / "xy" / "000.bin").read_bytes()


@pytest.mark.parametrize("shape", [(50, 3), (50,), (50, 2, 1)])
def test_coordinates_must_be_n_by_2(tmp_path, shape):
    ds = SimDataset(xy=np.zeros(shape, dtype=np.float32))
    with pytest.raises(ValueError, match=r"shape"):
        write_tiles(ds, tmp_path, "unit")


def test_a_column_of_the_wrong_length_is_rejected(tmp_path):
    ds = simulate_embedding(100, seed=1)
    ds.numeric["short"] = np.zeros(99, dtype=np.float32)
    with pytest.raises(ValueError, match="short"):
        write_tiles(ds, tmp_path, "unit")


# --- names that reach the filesystem -------------------------------------------

@pytest.mark.parametrize("bad_id", ["..", ".", "a/b", "sim1m\n", "", "x" * 65, "cell type"])
def test_unsafe_dataset_id_is_rejected(tmp_path, bad_id):
    ds = simulate_embedding(50, seed=1)
    with pytest.raises(ValueError, match="dataset id"):
        write_tiles(ds, tmp_path, bad_id)
    assert list(tmp_path.iterdir()) == [], "nothing may be written for a rejected id"


def test_unsafe_field_names_become_unique_safe_slugs(tmp_path, capsys):
    base = simulate_embedding(400, seed=5)
    ct = base.codes["cell_type"]
    alt = (ct + 1) % len(base.levels["cell_type"])
    ds = SimDataset(
        xy=base.xy,
        codes={
            "cell_type": ct,               # already safe: keeps its name
            "cell type": alt,              # slugs onto "cell_type": collision
            "RNA_snn_res.0.5": base.codes["donor"],
        },
        levels={
            "cell_type": base.levels["cell_type"],
            "cell type": base.levels["cell_type"],
            "RNA_snn_res.0.5": base.levels["donor"],
        },
        numeric={
            "percent.mt": base.numeric["pseudotime"],
            "..": base.numeric["pseudotime"] * 2,
            "a." * 40: base.numeric["pseudotime"] * 3,
        },
    )
    man = write_tiles(ds, tmp_path, "unit", chunk_size=1000)

    assert list(man["categorical"]) == ["cell_type", "cell_type_2", "RNA_snn_res_0_5"]
    long_slug = ("a_" * 32)[:64].rstrip("_")
    assert list(man["numeric"]) == ["percent_mt", "field", long_slug]
    for name in [*man["categorical"], *man["numeric"]]:
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name), name

    err = capsys.readouterr().err
    for old, new in [("cell type", "cell_type_2"), ("RNA_snn_res.0.5", "RNA_snn_res_0_5"),
                     ("percent.mt", "percent_mt"), ("..", "field")]:
        assert f"'{old}' -> '{new}'" in err

    # The renamed directories hold the right columns, not a neighbour's.
    root = tmp_path / "unit"
    assert sorted(p.name for p in (root / "codes").iterdir()) == sorted(man["categorical"])
    assert sorted(p.name for p in (root / "num").iterdir()) == sorted(man["numeric"])
    back = _read_back(root, man)
    assert np.array_equal((back.codes["cell_type"] + 1) % len(base.levels["cell_type"]),
                          back.codes["cell_type_2"])
    assert np.allclose(back.numeric["field"], back.numeric["percent_mt"] * 2)


def test_safe_field_names_are_never_renamed(tmp_path, capsys):
    ds = simulate_embedding(100, seed=1)
    man = write_tiles(ds, tmp_path, "unit")
    assert list(man["categorical"]) == list(ds.codes)
    assert list(man["numeric"]) == list(ds.numeric)
    assert "renamed" not in capsys.readouterr().err


# --- cache version ---------------------------------------------------------------

def test_manifest_version_tracks_the_bytes_written(tmp_path):
    ds = simulate_embedding(1200, seed=4)
    first = write_tiles(ds, tmp_path, "unit", chunk_size=500, seed=1)
    assert re.fullmatch(r"[0-9a-f]{16}", first["version"])

    # Identical bytes give an identical version, so browser caches stay warm.
    assert write_tiles(ds, tmp_path, "unit", chunk_size=500, seed=1)["version"] == first["version"]

    reshuffled = write_tiles(ds, tmp_path, "unit", chunk_size=500, seed=2)
    assert reshuffled["version"] != first["version"]
    on_disk = _strict_json((tmp_path / "unit" / "manifest.json").read_text())
    assert on_disk["version"] == reshuffled["version"]

    # Any column counts, not only the coordinates.
    ds.numeric["pseudotime"][7] += 0.5
    assert write_tiles(ds, tmp_path, "unit", chunk_size=500, seed=1)["version"] != first["version"]


def test_codes_outside_the_level_list_are_rejected(tmp_path):
    """A hand-built dataset whose codes overrun its levels (or are negative, or
    too wide for uint16) would wrap silently and colour cells as the wrong
    population."""
    import pytest

    from server.simulate import SimDataset

    xy = np.zeros((4, 2), dtype=np.float32)
    for codes in (np.array([0, 1, 2, 3]), np.array([0, -1, 0, 0]), np.array([0, 70_000, 0, 0])):
        ds = SimDataset(xy=xy, codes={"kind": codes}, levels={"kind": ["a", "b", "c"]})
        with pytest.raises(ValueError, match="kind"):
            write_tiles(ds, tmp_path, "bad", chunk_size=2)


def test_regenerating_prunes_files_the_new_manifest_does_not_reference(tmp_path):
    """Old field directories, surplus chunks and an old graph would otherwise
    linger on disk after a dataset is rewritten smaller."""
    ds, g = simulate_trajectory(3000, seed=7)
    write_tiles(ds, tmp_path, "unit", chunk_size=1000, graph=g)
    root = tmp_path / "unit"
    assert (root / "graph.json").is_file() and (root / "xy" / "002.bin").is_file()

    small = simulate_embedding(1500, seed=1)
    small.codes = {"cell_type": small.codes["cell_type"]}
    small.levels = {"cell_type": small.levels["cell_type"]}
    small.numeric = {}
    man = write_tiles(small, tmp_path, "unit", chunk_size=1000)

    assert man["chunks"] == 2
    assert not (root / "graph.json").exists()
    assert sorted(p.name for p in (root / "xy").iterdir()) == ["000.bin", "001.bin"]
    assert sorted(p.name for p in (root / "codes").iterdir()) == ["cell_type"]
    assert sorted(p.name for p in (root / "codes" / "cell_type").iterdir()) == ["000.bin", "001.bin"]
    assert not (root / "num").exists() or not any((root / "num").iterdir())


# ------------------------------------------------------------ graph_from_json

def _graph_file(tmp_path, **over):
    body = {"nodes": [[0, 0], [1, 1], [2, 0]], "edges": [[0, 1], [1, 2]], "root": 0,
            "branchPoints": [1], "leaves": [2]}
    body.update(over)
    path = tmp_path / "graph.json"
    path.write_text(json.dumps(body))
    return path


def test_graph_file_round_trips_through_write_tiles(tmp_path):
    from server.prep import graph_from_json

    g = graph_from_json(_graph_file(tmp_path))
    ds, _ = simulate_trajectory(50, seed=1)
    write_tiles(ds, tmp_path, "t", 100, graph=g)
    written = json.loads((tmp_path / "t" / "graph.json").read_text())
    assert written["edges"] == [[0, 1], [1, 2]] and written["root"] == 0 and written["leaves"] == [2]
    assert json.loads((tmp_path / "t" / "manifest.json").read_text())["hasGraph"] is True


@pytest.mark.parametrize(
    "over",
    [
        {"edges": [[0, 3]]},
        {"edges": [[0]]},
        {"root": 9},
        {"leaves": [-1]},
        {"branchPoints": [True]},
        {"nodes": []},
        {"nodes": [[0, 0, 0]]},
    ],
)
def test_graph_file_with_a_bad_index_or_shape_is_rejected(tmp_path, over):
    from server.prep import graph_from_json

    with pytest.raises(ValueError):
        graph_from_json(_graph_file(tmp_path, **over))


def test_graph_file_missing_keys_or_unreadable_is_rejected(tmp_path):
    from server.prep import graph_from_json

    p = tmp_path / "g.json"
    p.write_text('{"nodes": [[0,0]]}')
    with pytest.raises(ValueError, match="missing"):
        graph_from_json(p)
    with pytest.raises(ValueError, match="cannot read"):
        graph_from_json(tmp_path / "nope.json")
