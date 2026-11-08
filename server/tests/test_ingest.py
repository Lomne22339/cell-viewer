import json

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


def test_parquet_autodetects_column_kinds(tmp_path):
    pd = pytest.importorskip("pandas")
    rng = np.random.default_rng(3)
    n = 200
    df = pd.DataFrame({
        "x": rng.normal(size=n).astype(np.float32),
        "y": rng.normal(size=n).astype(np.float32),
        "cell_type": rng.choice(["A", "B", "C"], n),
        "pseudotime": rng.random(n).astype(np.float32),
    })
    path = tmp_path / "auto.parquet"
    df.to_parquet(path)
    ds = dataset_from_parquet(path)
    assert "cell_type" in ds.codes
    assert "pseudotime" in ds.numeric


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


# --- non-finite values, end to end -----------------------------------------------

def _strict_json(text: str):
    def reject(token):
        raise ValueError(f"non-standard JSON constant {token}")
    return json.loads(text, parse_constant=reject)


def _frame_with_bad_values(pd, n: int = 300):
    rng = np.random.default_rng(4)
    x = rng.normal(size=n)
    y = rng.normal(size=n)
    x[5], y[6], x[7] = np.nan, np.inf, -np.inf
    score = rng.random(n)
    score[10], score[11], score[12] = np.nan, np.inf, -np.inf
    return pd.DataFrame({
        "x": x, "y": y,
        "cell_type": rng.choice(["A", "B"], n),
        "score": score,
    })


def _ingest_bad(kind: str, tmp_path):
    pd = pytest.importorskip("pandas")
    df = _frame_with_bad_values(pd)
    if kind == "parquet":
        path = tmp_path / "bad.parquet"
        df.to_parquet(path)
        return dataset_from_parquet(path)
    anndata = pytest.importorskip("anndata")
    obs = df[["cell_type", "score"]].copy()
    obs["cell_type"] = pd.Categorical(obs["cell_type"])
    obs.index = [f"c{i}" for i in range(len(df))]
    adata = anndata.AnnData(X=np.zeros((len(df), 1), dtype=np.float32), obs=obs)
    adata.obsm["X_umap"] = df[["x", "y"]].to_numpy()
    path = tmp_path / "bad.h5ad"
    adata.write_h5ad(path)
    return dataset_from_h5ad(path)


@pytest.mark.parametrize("kind", ["h5ad", "parquet"])
def test_non_finite_input_gives_strict_json_and_a_served_manifest(kind, tmp_path, capsys):
    from fastapi.testclient import TestClient

    from server.main import create_app

    ds = _ingest_bad(kind, tmp_path)
    out = tmp_path / "tiles"
    write_tiles(ds, out, "bad", chunk_size=100)
    assert "dropped 3 " in capsys.readouterr().err

    man = _strict_json((out / "bad" / "manifest.json").read_text())
    assert man["n"] == 297
    assert man["numeric"]["score"]["min"] >= 0.0 and man["numeric"]["score"]["max"] <= 1.0

    client = TestClient(create_app(out, dist_dir=tmp_path / "no-dist"))
    r = client.get("/api/dataset/bad/manifest")
    assert r.status_code == 200
    assert r.json() == man
    xy = np.concatenate([
        np.frombuffer(client.get(f"/api/dataset/bad/chunk/xy/{c}").content, dtype=np.float32)
        for c in range(man["chunks"])
    ])
    assert xy.size == 297 * 2 and np.isfinite(xy).all()


# --- high-cardinality columns ----------------------------------------------------

def _barcodes(n: int) -> list[str]:
    return [f"bc_{i}" for i in range(n)]


def test_parquet_autodetect_skips_a_column_with_too_many_levels(tmp_path, capsys):
    # Not named `barcode`: in a Parquet file that name marks the cell id
    # column, which is never a field (see test_cell_ids.py).
    pd = pytest.importorskip("pandas")
    n = 70_000
    rng = np.random.default_rng(5)
    df = pd.DataFrame({
        "x": rng.normal(size=n).astype(np.float32),
        "y": rng.normal(size=n).astype(np.float32),
        "clonotype": _barcodes(n),
        "cell_type": rng.choice(["A", "B"], n),
        "score": rng.random(n).astype(np.float32),
    })
    path = tmp_path / "wide.parquet"
    df.to_parquet(path)
    ds = dataset_from_parquet(path)
    assert set(ds.codes) == {"cell_type"}
    assert set(ds.numeric) == {"score"}
    err = capsys.readouterr().err
    assert "clonotype" in err and "70000" in err


def test_h5ad_autodetect_skips_a_column_with_too_many_levels(tmp_path, capsys):
    anndata = pytest.importorskip("anndata")
    import pandas as pd

    n = 70_000
    rng = np.random.default_rng(6)
    obs = pd.DataFrame({
        "barcode": _barcodes(n),
        "cell_type": pd.Categorical(rng.choice(["A", "B"], n)),
        "score": rng.random(n).astype(np.float32),
    }, index=[f"c{i}" for i in range(n)])
    adata = anndata.AnnData(X=np.zeros((n, 1), dtype=np.float32), obs=obs)
    adata.obsm["X_umap"] = rng.normal(size=(n, 2)).astype(np.float32)
    path = tmp_path / "wide.h5ad"
    adata.write_h5ad(path)

    ds = dataset_from_h5ad(path)
    assert set(ds.codes) == {"cell_type"}
    assert set(ds.numeric) == {"score"}
    assert "barcode" in capsys.readouterr().err

    # Asking for it by name is a mistake worth stopping for.
    with pytest.raises(ValueError, match="65535"):
        dataset_from_h5ad(path, obs_fields=["barcode", "cell_type"])


def test_parquet_field_lists_are_each_autodetected_when_omitted(tmp_path):
    """Matching the h5ad reader: naming only the numeric fields still
    auto-detects the categorical ones, and vice versa."""
    pd = pytest.importorskip("pandas")
    rng = np.random.default_rng(7)
    n = 100
    df = pd.DataFrame({
        "x": rng.normal(size=n), "y": rng.normal(size=n),
        "cell_type": rng.choice(["A", "B"], n), "tissue": rng.choice(["lung", "gut"], n),
        "score": rng.random(n), "depth": rng.random(n),
    })
    path = tmp_path / "cells.parquet"
    df.to_parquet(path)
    only_num = dataset_from_parquet(path, numeric_fields=["score"])
    assert set(only_num.codes) == {"cell_type", "tissue"}
    assert set(only_num.numeric) == {"score"}
    only_obs = dataset_from_parquet(path, obs_fields=["tissue"])
    assert set(only_obs.codes) == {"tissue"}
    assert set(only_obs.numeric) == {"score", "depth"}


@pytest.mark.parametrize("kind", ["h5ad", "parquet"])
def test_a_missing_requested_field_names_what_is_available(kind, h5ad_file, tmp_path):
    pd = pytest.importorskip("pandas")
    if kind == "h5ad":
        path, read = h5ad_file, dataset_from_h5ad
    else:
        path, read = tmp_path / "c.parquet", dataset_from_parquet
        pd.DataFrame({"x": [0.0], "y": [0.0], "cell_type": ["A"], "pseudotime": [0.5]}).to_parquet(path)
    with pytest.raises(KeyError, match="cell_type"):
        read(path, obs_fields=["celltype"])
    with pytest.raises(KeyError, match="pseudotime"):
        read(path, numeric_fields=["pseudo_time"])
