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
