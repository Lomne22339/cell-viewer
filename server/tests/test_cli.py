"""The ingestion CLI, exercised as a user would actually run it.

The unit tests cover `dataset_from_h5ad` directly; this covers the thing a
person types, including argument wiring and the on-disk result.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

REPO = Path(__file__).resolve().parents[2]


def _write_h5ad(path: Path, n: int = 400) -> None:
    anndata = pytest.importorskip("anndata")
    import pandas as pd

    rng = np.random.default_rng(0)
    obs = pd.DataFrame({
        "cell_type": pd.Categorical(rng.choice(["T cell", "B cell"], n)),
        "tissue": pd.Categorical(rng.choice(["lung", "liver"], n)),
        "pseudotime": rng.random(n).astype(np.float32),
    })
    adata = anndata.AnnData(X=rng.random((n, 4)).astype(np.float32), obs=obs)
    adata.obsm["X_umap"] = rng.normal(size=(n, 2)).astype(np.float32)
    adata.write_h5ad(path)


def _run(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "server.prep", *args],
        cwd=cwd, capture_output=True, text=True, check=False,
    )


def test_cli_ingests_an_h5ad_into_servable_tiles(tmp_path):
    src = tmp_path / "cells.h5ad"
    _write_h5ad(src)
    out = tmp_path / "tiles"

    proc = _run("--h5ad", str(src), "--id", "mydata", "--out", str(out),
                "--chunk-size", "150", cwd=REPO)
    assert proc.returncode == 0, proc.stderr
    assert "wrote mydata" in proc.stdout

    manifest = json.loads((out / "mydata" / "manifest.json").read_text())
    assert manifest["n"] == 400
    assert manifest["chunks"] == 3
    assert set(manifest["categorical"]) == {"cell_type", "tissue"}
    assert "pseudotime" in manifest["numeric"]

    # The bytes must be exactly what the browser expects to reinterpret.
    xy = np.fromfile(out / "mydata" / "xy" / "000.bin", dtype=np.float32)
    assert xy.size == 150 * 2


def test_cli_serves_what_it_ingested(tmp_path):
    from fastapi.testclient import TestClient

    from server.main import create_app

    src = tmp_path / "cells.h5ad"
    _write_h5ad(src)
    out = tmp_path / "tiles"
    assert _run("--h5ad", str(src), "--id", "mydata", "--out", str(out),
                "--chunk-size", "150", cwd=REPO).returncode == 0

    client = TestClient(create_app(out))
    assert client.get("/api/datasets").json()["datasets"] == ["mydata"]
    man = client.get("/api/dataset/mydata/manifest").json()
    assert man["n"] == 400
    body = client.get("/api/dataset/mydata/chunk/xy/2").content
    assert len(body) == 100 * 2 * 4  # final short chunk


def test_cli_requires_an_id_when_ingesting(tmp_path):
    src = tmp_path / "cells.h5ad"
    _write_h5ad(src)
    proc = _run("--h5ad", str(src), cwd=REPO)
    assert proc.returncode != 0
    assert "--id is required" in proc.stderr


def test_cli_generates_simulated_datasets(tmp_path):
    out = tmp_path / "tiles"
    proc = _run("--sizes", "2000", "--traj-size", "1000", "--out", str(out),
                "--chunk-size", "800", cwd=REPO)
    assert proc.returncode == 0, proc.stderr
    assert (out / "sim2k" / "manifest.json").is_file()
    assert (out / "traj1k" / "graph.json").is_file()
    graph = json.loads((out / "traj1k" / "graph.json").read_text())
    assert graph["edges"] and "root" in graph


# --- dataset size labels ---------------------------------------------------------

@pytest.mark.parametrize("n, label", [
    (100_000, "100k"), (1_000_000, "1m"), (500_000, "500k"), (300_000, "300k"),
    (2_000, "2k"), (10_000_000, "10m"),
    (1_500_000, "1500k"), (500, "500"), (1_234, "1234"), (2_500_001, "2500001"),
])
def test_size_labels_are_exact(n, label):
    from server.prep import dataset_label

    assert dataset_label(n) == label


def test_size_labels_never_collide():
    from server.prep import dataset_label

    sizes = [1, 999, 1000, 1001, 1500, 999_999, 1_000_000, 1_000_001, 1_500_000, 2_000_000]
    assert len({dataset_label(n) for n in sizes}) == len(sizes)


def test_cli_writes_exactly_labelled_sizes(tmp_path):
    out = tmp_path / "tiles"
    proc = _run("--sizes", "1500", "500", "--traj-size", "0", "--out", str(out), cwd=REPO)
    assert proc.returncode == 0, proc.stderr
    assert json.loads((out / "sim1500" / "manifest.json").read_text())["n"] == 1500
    assert json.loads((out / "sim500" / "manifest.json").read_text())["n"] == 500


def test_cli_refuses_sizes_whose_ids_collide(tmp_path):
    out = tmp_path / "tiles"
    proc = _run("--sizes", "1000", "1000", "--traj-size", "0", "--out", str(out), cwd=REPO)
    assert proc.returncode != 0
    assert "sim1k" in proc.stderr
    assert not out.exists(), "nothing may be written before the collision is reported"


# --- ingest field selection ------------------------------------------------------

def _write_parquet(path: Path, n: int = 300, wide: str | None = None) -> None:
    """`wide` names an extra column with a distinct value per cell. Named
    `barcode` it is the Parquet id convention, so it becomes the cell ids
    unless asked for as a field; any other name is an ordinary column."""
    pd = pytest.importorskip("pandas")
    rng = np.random.default_rng(1)
    cols = {
        "x": rng.normal(size=n).astype(np.float32),
        "y": rng.normal(size=n).astype(np.float32),
        "cell type": rng.choice(["A", "B"], n),
        "tissue": rng.choice(["lung", "gut"], n),
        "donor": rng.choice(["d1", "d2"], n),
        "score": rng.random(n).astype(np.float32),
        "percent.mt": rng.random(n).astype(np.float32),
    }
    if wide:
        cols[wide] = [f"bc_{i}" for i in range(n)]
    pd.DataFrame(cols).to_parquet(path)


def test_cli_h5ad_field_flags_select_columns(tmp_path):
    src = tmp_path / "cells.h5ad"
    _write_h5ad(src)
    out = tmp_path / "tiles"
    proc = _run("--h5ad", str(src), "--id", "picked", "--out", str(out),
                "--obs-fields", "tissue", "--numeric-fields", "pseudotime", cwd=REPO)
    assert proc.returncode == 0, proc.stderr
    man = json.loads((out / "picked" / "manifest.json").read_text())
    assert set(man["categorical"]) == {"tissue"}
    assert set(man["numeric"]) == {"pseudotime"}


@pytest.mark.parametrize("obs_args", [
    ["cell type,tissue"],            # comma separated, one argument
    ["cell type, tissue"],           # comma and space
    ["cell type", "tissue"],         # separate arguments
])
def test_cli_parquet_field_flags_accept_commas_or_separate_arguments(tmp_path, obs_args):
    src = tmp_path / "cells.parquet"
    _write_parquet(src)
    out = tmp_path / "tiles"
    proc = _run("--parquet", str(src), "--id", "picked", "--out", str(out),
                "--obs-fields", *obs_args, "--numeric-fields", "score,percent.mt", cwd=REPO)
    assert proc.returncode == 0, proc.stderr
    man = json.loads((out / "picked" / "manifest.json").read_text())
    # Unsafe names arrive slugged; the flags take the names as they are in the file.
    assert set(man["categorical"]) == {"cell_type", "tissue"}
    assert set(man["numeric"]) == {"score", "percent_mt"}
    assert "'cell type' -> 'cell_type'" in proc.stderr


def test_cli_autodetect_skips_a_high_cardinality_column(tmp_path):
    src = tmp_path / "wide.parquet"
    _write_parquet(src, n=70_000, wide="clonotype")
    out = tmp_path / "tiles"
    proc = _run("--parquet", str(src), "--id", "wide", "--out", str(out), cwd=REPO)
    assert proc.returncode == 0, proc.stderr
    assert "clonotype" in proc.stderr
    man = json.loads((out / "wide" / "manifest.json").read_text())
    assert "clonotype" not in man["categorical"]
    assert {"cell_type", "tissue", "donor"} <= set(man["categorical"])


def test_cli_explicit_high_cardinality_column_fails_cleanly(tmp_path):
    src = tmp_path / "wide.parquet"
    _write_parquet(src, n=70_000, wide="barcode")
    out = tmp_path / "tiles"
    # Asking for `barcode` as a field outranks the id convention, so it is
    # encoded, and its 70,000 levels are an error.
    proc = _run("--parquet", str(src), "--id", "wide", "--out", str(out),
                "--obs-fields", "barcode", cwd=REPO)
    assert proc.returncode != 0
    assert "65535" in proc.stderr
    assert "Traceback" not in proc.stderr
    assert not (out / "wide" / "manifest.json").exists()


def test_cli_field_flags_need_a_file_to_ingest(tmp_path):
    proc = _run("--sizes", "100", "--obs-fields", "cell_type", "--out", str(tmp_path), cwd=REPO)
    assert proc.returncode != 0
    assert "--obs-fields" in proc.stderr


def test_cli_rejects_an_unsafe_dataset_id(tmp_path):
    src = tmp_path / "cells.h5ad"
    _write_h5ad(src)
    out = tmp_path / "tiles"
    proc = _run("--h5ad", str(src), "--id", "../escape", "--out", str(out), cwd=REPO)
    assert proc.returncode != 0
    assert "dataset id" in proc.stderr
    assert "Traceback" not in proc.stderr
    assert not (tmp_path / "escape").exists()
