"""`GET /api/dataset/{id}/cell/{index}`: a shuffled index back to the cell's
own name and its row in the source file.

The browser only knows a cell by its position in the shuffled chunks; this
route is how a clicked cell is traced back to the user's AnnData or Parquet.
"""
from __future__ import annotations

import shutil

import numpy as np
import pytest
from fastapi.testclient import TestClient

from server.main import create_app
from server.prep import write_tiles
from server.simulate import simulate_embedding


def _client(tiles) -> TestClient:
    return TestClient(create_app(tiles, dist_dir=tiles / "no-dist"))


def _src(root, man) -> np.ndarray:
    """The traced source row of every shuffled cell, read from the chunks."""
    return np.concatenate([
        np.fromfile(root / "num" / "src" / f"{c:03d}.bin", dtype=np.float32)
        for c in range(man["chunks"])
    ]).astype(np.int64)


@pytest.fixture
def written(tmp_path):
    ds = simulate_embedding(2500, seed=1)
    ds.numeric["src"] = np.arange(ds.n, dtype=np.float32)
    man = write_tiles(ds, tmp_path, "unit", chunk_size=1000)
    return tmp_path, man


def test_returns_the_source_row_and_id_of_a_shuffled_cell(written):
    tiles, man = written
    src = _src(tiles / "unit", man)
    client = _client(tiles)
    for i in (0, 1, 999, 1000, 2499):
        r = client.get(f"/api/dataset/unit/cell/{i}")
        assert r.status_code == 200
        assert r.json() == {"index": i, "row": int(src[i]), "id": f"cell-{int(src[i]):07d}"}


@pytest.mark.parametrize("index", [2500, 2501, 10**12, -1])
def test_an_index_outside_the_dataset_is_404(written, index):
    tiles, _ = written
    assert _client(tiles).get(f"/api/dataset/unit/cell/{index}").status_code == 404


def test_a_non_integer_index_is_rejected(written):
    tiles, _ = written
    assert _client(tiles).get("/api/dataset/unit/cell/abc").status_code == 422


def test_dataset_names_are_validated(written):
    tiles, _ = written
    client = _client(tiles)
    assert client.get("/api/dataset/nope/cell/0").status_code == 404
    assert client.get("/api/dataset/%2E%2E/cell/0").status_code == 400
    assert client.get("/api/dataset/unit%0A/cell/0").status_code == 400


def test_tiles_written_before_cell_ids_degrade_to_nulls(written):
    """Older tiles have no `cells/` directory. The card can still show the
    index, so the answer is nulls rather than an error."""
    tiles, _ = written
    shutil.rmtree(tiles / "unit" / "cells")
    client = _client(tiles)
    r = client.get("/api/dataset/unit/cell/5")
    assert r.status_code == 200
    assert r.json() == {"index": 5, "row": None, "id": None}
    assert client.get("/api/dataset/unit/cell/2500").status_code == 404


def test_a_dataset_without_ids_still_reports_the_source_row(tmp_path):
    ds = simulate_embedding(300, seed=2)
    ds.ids = None
    ds.numeric["src"] = np.arange(ds.n, dtype=np.float32)
    man = write_tiles(ds, tmp_path, "anon", chunk_size=100)
    src = _src(tmp_path / "anon", man)
    body = _client(tmp_path).get("/api/dataset/anon/cell/42").json()
    assert body == {"index": 42, "row": int(src[42]), "id": None}


def test_non_ascii_ids_are_decoded(tmp_path):
    ds = simulate_embedding(50, seed=3)
    ds.ids = np.array([f"細胞-café-🧬-{i}" for i in range(ds.n)])
    ds.numeric["src"] = np.arange(ds.n, dtype=np.float32)
    man = write_tiles(ds, tmp_path, "intl", chunk_size=20)
    src = _src(tmp_path / "intl", man)
    body = _client(tmp_path).get("/api/dataset/intl/cell/7").json()
    assert body["id"] == f"細胞-café-🧬-{src[7]}"


def test_a_regenerated_dataset_is_picked_up(tmp_path):
    """Opened arrays are cached by manifest version, so new tiles under the
    same id are read afresh rather than served from the old mapping."""
    ds = simulate_embedding(300, seed=2)
    write_tiles(ds, tmp_path, "unit", seed=1)
    client = _client(tmp_path)
    first = client.get("/api/dataset/unit/cell/0").json()

    ds.ids = np.array([f"new-{i}" for i in range(ds.n)])
    write_tiles(ds, tmp_path, "unit", seed=1)
    second = client.get("/api/dataset/unit/cell/0").json()
    assert second["row"] == first["row"]
    assert second["id"] == f"new-{first['row']}"


def test_lookups_map_the_arrays_rather_than_reading_them(written):
    """One lookup must not read a 20 MB id file into memory."""
    from server.tiles import _open_column

    tiles, man = written
    for name in ("rows.npy", "ids.npy"):
        arr = _open_column(str(tiles / "unit" / "cells" / name), man["version"])
        assert isinstance(arr, np.memmap), name


def test_a_matching_version_is_answered(written):
    tiles, man = written
    r = _client(tiles).get(f"/api/dataset/unit/cell/0?v={man['version']}")
    assert r.status_code == 200


def test_a_stale_version_is_a_conflict_not_another_cell(written):
    # A page still holding the old chunks after the dataset was regenerated
    # must not be told the name of whichever cell now sits at that index.
    tiles, _ = written
    r = _client(tiles).get("/api/dataset/unit/cell/0?v=0000000000000000")
    assert r.status_code == 409
