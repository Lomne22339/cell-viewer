"""Cell identity through simulation, ingest and the tile writer.

The cell card shows a clicked cell's own name, so the name a cell had in its
source file (an AnnData obs_name, a Parquet barcode) has to survive the drop
of unplottable cells and the shuffle, and stay on the same row as that cell's
coordinates and codes. Each test traces cells by a numeric column `src` that
holds the source row, so any misalignment shows up as a mismatch.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from server.prep import dataset_from_h5ad, dataset_from_parquet, shuffle_dataset, write_tiles
from server.simulate import (
    SimDataset,
    _id_width,
    simulate_atlas,
    simulate_embedding,
    simulate_trajectory,
    synthetic_ids,
)

REPO = Path(__file__).resolve().parents[2]
NON_ASCII = ["café", "細胞", "🧬", "Ünïcødé", "AAACCTGAGAAGGCCT-1"]


def _traced(n: int = 3000, seed: int = 5) -> SimDataset:
    """A simulated dataset whose numeric column `src` is each cell's source row."""
    ds = simulate_embedding(n, seed=seed)
    ds.numeric["src"] = np.arange(n, dtype=np.float32)
    return ds


def _column(root: Path, man: dict, kind: str, field: str, dtype) -> np.ndarray:
    return np.concatenate([
        np.fromfile(root / kind / field / f"{c:03d}.bin", dtype=dtype)
        for c in range(man["chunks"])
    ])


def _xy(root: Path, man: dict) -> np.ndarray:
    return np.concatenate([
        np.fromfile(root / "xy" / f"{c:03d}.bin", dtype=np.float32)
        for c in range(man["chunks"])
    ]).reshape(-1, 2)


def _cells(root: Path) -> tuple[np.ndarray, list[str] | None]:
    """rows.npy as written, and ids.npy decoded, or None when absent."""
    rows = np.load(root / "cells" / "rows.npy")
    path = root / "cells" / "ids.npy"
    ids = [b.decode("utf-8") for b in np.load(path).tolist()] if path.exists() else None
    return rows, ids


# --- simulators --------------------------------------------------------------------

@pytest.mark.parametrize("make", [
    simulate_embedding,
    lambda n, seed: simulate_trajectory(n, seed=seed)[0],
    simulate_atlas,
], ids=["embedding", "trajectory", "atlas"])
def test_simulators_name_cells_in_generation_order(make):
    ds = make(1500, seed=2)
    assert ds.ids.shape == (1500,)
    assert ds.ids[0] == "cell-0000000"
    assert ds.ids[1499] == "cell-0001499"
    assert len(set(ds.ids.tolist())) == 1500


def test_synthetic_ids_widen_only_when_seven_digits_run_out():
    assert synthetic_ids(3).tolist() == ["cell-0000000", "cell-0000001", "cell-0000002"]
    assert _id_width(1) == 7
    assert _id_width(10_000_000) == 7, "cell-9999999 is the last seven-digit id"
    assert _id_width(10_000_001) == 8
    assert _id_width(123_456_789) == 9


def test_ids_do_not_change_what_the_simulators_draw():
    """The ids are derived from n alone and consume no randomness, so the
    coordinates and codes for a seed are what they were before ids existed."""
    a = simulate_embedding(2000, seed=9)
    b = simulate_embedding(2000, seed=9)
    assert np.array_equal(a.xy, b.xy)
    assert np.array_equal(a.ids, b.ids)


# --- shuffle -----------------------------------------------------------------------

def test_shuffle_permutes_ids_and_source_rows_with_every_other_column():
    ds = _traced()
    ds.source_rows = np.arange(ds.n)
    sh = shuffle_dataset(ds, seed=7)
    assert not np.array_equal(sh.source_rows, ds.source_rows), "shuffle must reorder"
    assert np.array_equal(sh.ids, ds.ids[sh.source_rows])
    assert np.array_equal(sh.xy, ds.xy[sh.source_rows])
    assert np.array_equal(sh.codes["cell_type"], ds.codes["cell_type"][sh.source_rows])
    assert np.array_equal(sh.numeric["src"], sh.source_rows.astype(np.float32))


def test_shuffle_without_ids_is_the_same_permutation():
    """ids ride along without drawing from the generator, so a dataset with
    and without them is shuffled identically."""
    ds = simulate_embedding(2000, seed=1)
    bare = SimDataset(ds.xy, ds.codes, ds.levels, ds.numeric)
    with_ids, without = shuffle_dataset(ds, seed=3), shuffle_dataset(bare, seed=3)
    assert np.array_equal(with_ids.xy, without.xy)
    assert without.ids is None and without.source_rows is None


# --- write_tiles -------------------------------------------------------------------

def test_written_ids_and_rows_stay_aligned_with_the_chunks(tmp_path):
    ds = _traced()
    man = write_tiles(ds, tmp_path, "unit", chunk_size=1000, seed=3)
    root = tmp_path / "unit"
    rows, ids = _cells(root)

    assert man["cellIds"] is True
    assert rows.dtype == np.uint32 and rows.shape == (3000,)
    assert not np.array_equal(rows, np.arange(3000)), "the shuffle must reorder"
    assert np.array_equal(rows, _column(root, man, "num", "src", np.float32).astype(np.uint32))
    assert ids == [f"cell-{r:07d}" for r in rows]
    assert np.array_equal(_xy(root, man), ds.xy[rows])
    assert np.array_equal(_column(root, man, "codes", "cell_type", np.uint16),
                          ds.codes["cell_type"][rows])


def test_cells_directory_holds_exactly_ids_and_rows(tmp_path):
    """np.save appends `.npy` to a path without it; the atomic tmp-and-rename
    must still land on exactly these two names and leave nothing behind."""
    write_tiles(simulate_embedding(500, seed=1), tmp_path, "unit")
    names = sorted(p.name for p in (tmp_path / "unit" / "cells").iterdir())
    assert names == ["ids.npy", "rows.npy"]


def test_dropped_cells_take_their_ids_and_rows_with_them(tmp_path, capsys):
    ds = _traced(1000)
    dropped = [3, 10, 500, 999]
    ds.xy[3, 0] = np.nan
    ds.xy[10, 1] = np.inf
    ds.xy[500] = np.nan
    ds.xy[999, 0] = -np.inf
    man = write_tiles(ds, tmp_path, "unit", chunk_size=300, seed=4)
    assert man["n"] == 996
    assert "dropped 4 " in capsys.readouterr().err

    root = tmp_path / "unit"
    rows, ids = _cells(root)
    # Rows count from the input before anything was dropped, not after.
    assert np.array_equal(np.sort(rows), np.setdiff1d(np.arange(1000), dropped))
    assert ids == [f"cell-{r:07d}" for r in rows]
    assert np.array_equal(rows, _column(root, man, "num", "src", np.float32).astype(np.uint32))


def test_non_ascii_ids_round_trip(tmp_path):
    ds = _traced(200)
    names = np.array([f"{NON_ASCII[i % len(NON_ASCII)]}#{i}" for i in range(200)])
    ds.ids = names
    write_tiles(ds, tmp_path, "unit", chunk_size=64)

    raw = np.load(tmp_path / "unit" / "cells" / "ids.npy")
    assert raw.dtype.kind == "S", "fixed-width bytes, never a pickled object array"
    assert raw.dtype.itemsize == max(len(s.encode("utf-8")) for s in names)
    rows, ids = _cells(tmp_path / "unit")
    assert ids == [names[r] for r in rows]


def test_version_moves_when_only_an_id_changes(tmp_path):
    ds = simulate_embedding(1200, seed=4)
    first = write_tiles(ds, tmp_path, "unit", chunk_size=500, seed=1)["version"]
    assert write_tiles(ds, tmp_path, "unit", chunk_size=500, seed=1)["version"] == first

    ds.ids = ds.ids.copy()
    ds.ids[7] = "cell-9999999"  # same width, so only the bytes differ
    assert write_tiles(ds, tmp_path, "unit", chunk_size=500, seed=1)["version"] != first


def test_regenerating_without_ids_removes_the_stale_id_file(tmp_path):
    ds = simulate_embedding(800, seed=2)
    write_tiles(ds, tmp_path, "unit")
    cells = tmp_path / "unit" / "cells"
    assert (cells / "ids.npy").is_file()

    ds.ids = None
    man = write_tiles(ds, tmp_path, "unit")
    assert man["cellIds"] is False
    assert sorted(p.name for p in cells.iterdir()) == ["rows.npy"]


def test_ids_of_the_wrong_length_are_rejected(tmp_path):
    ds = simulate_embedding(100, seed=1)
    ds.ids = ds.ids[:99]
    with pytest.raises(ValueError, match="cell ids"):
        write_tiles(ds, tmp_path, "unit")


# --- h5ad --------------------------------------------------------------------------

@pytest.fixture
def named_h5ad(tmp_path):
    anndata = pytest.importorskip("anndata")
    import pandas as pd

    n = 300
    rng = np.random.default_rng(0)
    names = [f"{NON_ASCII[i % len(NON_ASCII)]}-{i}" for i in range(n)]
    obs = pd.DataFrame({
        "cell_type": pd.Categorical(rng.choice(["T cell", "B cell"], n)),
        "src": np.arange(n, dtype=np.float32),
    }, index=names)
    adata = anndata.AnnData(X=np.zeros((n, 1), dtype=np.float32), obs=obs)
    adata.obsm["X_umap"] = rng.normal(size=(n, 2)).astype(np.float32)
    path = tmp_path / "named.h5ad"
    adata.write_h5ad(path)
    return path, names


def test_h5ad_obs_names_become_ids_and_not_fields(named_h5ad, tmp_path):
    path, names = named_h5ad
    ds = dataset_from_h5ad(path)
    assert ds.ids.tolist() == names
    assert set(ds.codes) == {"cell_type"}
    assert set(ds.numeric) == {"src"}

    man = write_tiles(ds, tmp_path / "out", "named", chunk_size=128)
    root = tmp_path / "out" / "named"
    rows, ids = _cells(root)
    assert man["cellIds"] is True
    assert ids == [names[r] for r in rows]
    assert np.array_equal(rows, _column(root, man, "num", "src", np.float32).astype(np.uint32))


# --- parquet -----------------------------------------------------------------------

def _parquet(path: Path, n: int = 120, **extra) -> Path:
    pd = pytest.importorskip("pandas")
    rng = np.random.default_rng(3)
    pd.DataFrame({
        "x": rng.normal(size=n),
        "y": rng.normal(size=n),
        "cell_type": rng.choice(["A", "B"], n),
        "src": np.arange(n, dtype=np.float32),
        **extra,
    }).to_parquet(path)
    return path


def _names(prefix: str, n: int = 120) -> list[str]:
    return [f"{prefix}{i}" for i in range(n)]


@pytest.mark.parametrize("column", ["cell_id", "barcode", "obs_names"])
def test_parquet_picks_up_a_conventional_id_column(tmp_path, column):
    path = _parquet(tmp_path / "c.parquet", **{column: _names("c")})
    ds = dataset_from_parquet(path)
    assert ds.ids.tolist() == _names("c")
    assert column not in ds.codes and column not in ds.numeric
    assert set(ds.codes) == {"cell_type"} and set(ds.numeric) == {"src"}


def test_parquet_prefers_cell_id_then_barcode_then_obs_names(tmp_path):
    """Only the chosen column becomes the ids; the candidates that lost to
    `cell_id` are ordinary string columns and are auto-detected as fields."""
    path = _parquet(tmp_path / "c.parquet", obs_names=_names("o"),
                    barcode=[f"bc{i % 3}" for i in range(120)], cell_id=_names("c"))
    ds = dataset_from_parquet(path)
    assert ds.ids.tolist() == _names("c")
    assert "cell_id" not in ds.codes
    assert {"barcode", "obs_names"} <= set(ds.codes)

    path = _parquet(tmp_path / "b.parquet", obs_names=_names("o"), barcode=_names("b"))
    assert dataset_from_parquet(path).ids.tolist() == _names("b")


def test_parquet_without_an_id_column_has_no_ids(tmp_path):
    ds = dataset_from_parquet(_parquet(tmp_path / "c.parquet"))
    assert ds.ids is None
    man = write_tiles(ds, tmp_path / "out", "anon")
    assert man["cellIds"] is False
    assert sorted(p.name for p in (tmp_path / "out" / "anon" / "cells").iterdir()) == ["rows.npy"]


def test_parquet_integer_cell_id_becomes_strings_not_a_numeric_field(tmp_path):
    path = _parquet(tmp_path / "c.parquet", cell_id=np.arange(1000, 1120))
    ds = dataset_from_parquet(path)
    assert ds.ids.tolist() == [str(i) for i in range(1000, 1120)]
    assert set(ds.numeric) == {"src"}


def test_parquet_missing_ids_become_empty_strings(tmp_path):
    names = _names("c")
    names[4] = None
    ds = dataset_from_parquet(_parquet(tmp_path / "c.parquet", cell_id=names))
    assert ds.ids[4] == "" and ds.ids[5] == "c5"


def test_parquet_explicit_id_column(tmp_path):
    path = _parquet(tmp_path / "c.parquet", name=_names("n"), barcode=_names("b"))
    ds = dataset_from_parquet(path, id_column="name")
    assert ds.ids.tolist() == _names("n")
    assert "name" not in ds.codes and "name" not in ds.numeric
    # The convention is only a default: `barcode` is no longer the id column,
    # so it is auto-detected like any other string column (and skipped or not
    # by its level count, here 120 levels, which fits).
    assert "barcode" in ds.codes


def test_parquet_missing_explicit_id_column_names_what_is_available(tmp_path):
    path = _parquet(tmp_path / "c.parquet")
    with pytest.raises(KeyError, match="cell_type"):
        dataset_from_parquet(path, id_column="cellid")


@pytest.mark.parametrize("fields", [{"obs_fields": ["name"]}, {"numeric_fields": ["name"]}])
def test_parquet_explicit_id_column_cannot_also_be_a_field(tmp_path, fields):
    path = _parquet(tmp_path / "c.parquet", name=_names("n"))
    with pytest.raises(ValueError, match="name"):
        dataset_from_parquet(path, id_column="name", **fields)


def test_parquet_a_column_named_as_a_field_is_not_taken_as_ids(tmp_path):
    """Asking for `barcode` as a field is explicit; picking it as the id
    column is only a convention, so the explicit request wins."""
    path = _parquet(tmp_path / "c.parquet", barcode=[f"bc{i % 4}" for i in range(120)])
    ds = dataset_from_parquet(path, obs_fields=["barcode"])
    assert ds.ids is None
    assert "barcode" in ds.codes


# --- CLI ---------------------------------------------------------------------------

def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "server.prep", *args],
        cwd=REPO, capture_output=True, text=True, check=False,
    )


def test_cli_id_column_flag(tmp_path):
    src = _parquet(tmp_path / "c.parquet", name=_names("n"), cell_id=_names("c"))
    out = tmp_path / "tiles"
    proc = _run("--parquet", str(src), "--id", "named", "--out", str(out),
                "--id-column", "name", "--chunk-size", "50")
    assert proc.returncode == 0, proc.stderr

    root = out / "named"
    man = json.loads((root / "manifest.json").read_text())
    assert man["cellIds"] is True
    assert "name" not in man["categorical"]
    rows, ids = _cells(root)
    assert ids == [f"n{r}" for r in rows]
    assert np.array_equal(rows, _column(root, man, "num", "src", np.float32).astype(np.uint32))


def test_cli_uses_a_cell_id_column_by_default(tmp_path):
    src = _parquet(tmp_path / "c.parquet", cell_id=_names("c"))
    out = tmp_path / "tiles"
    assert _run("--parquet", str(src), "--id", "auto", "--out", str(out)).returncode == 0
    man = json.loads((out / "auto" / "manifest.json").read_text())
    assert man["cellIds"] is True and "cell_id" not in man["categorical"]
    rows, ids = _cells(out / "auto")
    assert ids == [f"c{r}" for r in rows]


@pytest.mark.parametrize("source", [["--h5ad", "cells.h5ad", "--id", "x"], ["--sizes", "100"]])
def test_cli_id_column_applies_only_to_parquet(tmp_path, source):
    proc = _run(*source, "--id-column", "name", "--out", str(tmp_path / "tiles"))
    assert proc.returncode != 0
    assert "--id-column" in proc.stderr
    assert not (tmp_path / "tiles").exists()
