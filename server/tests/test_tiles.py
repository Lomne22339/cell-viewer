import numpy as np
import pytest
from fastapi.testclient import TestClient

from server.main import create_app
from server.prep import write_tiles
from server.simulate import simulate_embedding, simulate_trajectory


@pytest.fixture
def client(tmp_path):
    ds = simulate_embedding(2500, seed=1)
    write_tiles(ds, tmp_path, "unit", chunk_size=1000)
    tds, g = simulate_trajectory(1500, seed=1)
    write_tiles(tds, tmp_path, "traj", chunk_size=1000, graph=g)
    # No bundle: these tests are about the API surface.
    return TestClient(create_app(tmp_path, dist_dir=tmp_path / 'no-dist'))


def test_lists_datasets(client):
    body = client.get("/api/datasets").json()
    assert sorted(body["datasets"]) == ["traj", "unit"]


def test_serves_manifest(client):
    man = client.get("/api/dataset/unit/manifest").json()
    assert man["n"] == 2500 and man["chunks"] == 3
    assert "cell_type" in man["categorical"]


def test_serves_xy_chunk_as_binary_with_exact_length(client):
    r = client.get("/api/dataset/unit/chunk/xy/0")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    assert len(r.content) == 1000 * 2 * 4
    xy = np.frombuffer(r.content, dtype=np.float32)
    assert np.isfinite(xy).all()


def test_last_chunk_is_short(client):
    r = client.get("/api/dataset/unit/chunk/xy/2")
    assert len(r.content) == 500 * 2 * 4


def test_serves_code_and_numeric_chunks(client):
    r = client.get("/api/dataset/unit/chunk/codes/cell_type/0")
    assert len(r.content) == 1000 * 2  # uint16
    r = client.get("/api/dataset/unit/chunk/num/pseudotime/0")
    assert len(r.content) == 1000 * 4  # float32


def test_graph_route(client):
    g = client.get("/api/dataset/traj/graph").json()
    assert g["edges"] and g["root"] == 0
    assert client.get("/api/dataset/unit/graph").status_code == 404


def test_unknown_dataset_and_chunk_are_404_not_500(client):
    assert client.get("/api/dataset/nope/manifest").status_code == 404
    assert client.get("/api/dataset/unit/chunk/xy/99").status_code == 404
    assert client.get("/api/dataset/unit/chunk/codes/nope/0").status_code == 404


@pytest.mark.parametrize("evil", ["../../etc/passwd", "..%2F..%2Fetc", "a/b"])
def test_path_traversal_is_rejected(client, evil):
    """Dataset and field names index into the filesystem. They must be
    validated, not concatenated."""
    r = client.get(f"/api/dataset/{evil}/manifest")
    assert r.status_code in (400, 404), r.status_code


def test_a_built_bundle_is_served_without_shadowing_the_api(tmp_path):
    """`npm run build` plus this server should be a complete deployment."""
    ds = simulate_embedding(100, seed=1)
    write_tiles(ds, tmp_path, "unit", chunk_size=100)
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>app</title>")

    client = TestClient(create_app(tmp_path, dist_dir=dist))
    # The mount is last, so /api still resolves.
    assert client.get("/api/datasets").json()["datasets"] == ["unit"]
    assert client.get("/api/dataset/unit/manifest").json()["n"] == 100
    assert len(client.get("/api/dataset/unit/chunk/xy/0").content) == 100 * 2 * 4
    # And the page is served at the root.
    assert "<title>app</title>" in client.get("/").text


def test_no_bundle_means_no_root_route(tmp_path):
    client = TestClient(create_app(tmp_path, dist_dir=tmp_path / "absent"))
    assert client.get("/").status_code == 404
    assert client.get("/api/datasets").status_code == 200
