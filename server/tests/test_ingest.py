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
