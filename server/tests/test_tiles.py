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


@pytest.mark.parametrize("url", [
    "/api/dataset/%2E%2E/manifest",
    "/api/dataset/%2E%2E/graph",
    "/api/dataset/%2E%2E/chunk/xy/0",
    "/api/dataset/unit/chunk/codes/%2E%2E/0",
    "/api/dataset/unit/chunk/num/%2E%2E/0",
    "/api/dataset/sim1m%0A/manifest",
    "/api/dataset/unit%0A/manifest",
    "/api/dataset/unit/chunk/codes/cell_type%0A/0",
    "/api/dataset/unit/chunk/num/pseudotime%0A/0",
])
def test_path_traversal_is_rejected(client, url):
    """Dataset and field names index into the filesystem. They must be
    validated, not concatenated.

    Each of these reaches a handler with a single path segment of `..` or a
    name with a trailing newline, so only the name check can answer 400. A
    looser assertion (400 or 404) would also pass with the check removed,
    because the filesystem lookup then simply misses."""
    r = client.get(url)
    assert r.status_code == 400, (url, r.status_code)


@pytest.mark.parametrize("evil", ["../../etc/passwd", "..%2F..%2Fetc", "a/b"])
def test_names_with_slashes_never_match_a_route(client, evil):
    assert client.get(f"/api/dataset/{evil}/manifest").status_code == 404


def test_safe_name_matches_the_whole_string():
    from server.tiles import SAFE_NAME

    assert SAFE_NAME.fullmatch("sim1m")
    assert SAFE_NAME.fullmatch("a" * 64)
    for bad in ["sim1m\n", "..", "", "a" * 65, "a.b", "a b", "a/b"]:
        assert not SAFE_NAME.fullmatch(bad), repr(bad)
        # Even a caller using .match must not be fooled by a trailing newline.
        assert not SAFE_NAME.match(bad), repr(bad)


def test_manifest_carries_a_version(client):
    man = client.get("/api/dataset/unit/manifest").json()
    assert isinstance(man["version"], str) and len(man["version"]) == 16


def test_chunk_routes_ignore_the_cache_busting_query(client):
    """The browser appends ?v=<manifest version>; the route must serve the
    same immutable bytes whatever the query says."""
    plain = client.get("/api/dataset/unit/chunk/xy/0")
    for url in ["/api/dataset/unit/chunk/xy/0?v=0123456789abcdef",
                "/api/dataset/unit/chunk/codes/cell_type/0?v=x",
                "/api/dataset/unit/chunk/num/pseudotime/0?v=x&other=1"]:
        r = client.get(url)
        assert r.status_code == 200, url
        assert "immutable" in r.headers["cache-control"]
    assert client.get("/api/dataset/unit/chunk/xy/0?v=abc").content == plain.content


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


@pytest.mark.parametrize(
    "origin",
    ["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5199", "http://localhost:4173"],
)
def test_cors_allows_a_dev_server_on_any_local_port(client, origin):
    """Vite moves to 5174 when 5173 is busy; a page on that port must still be
    allowed to read the API, or it can only show "Failed to fetch"."""
    r = client.get("/api/datasets", headers={"Origin": origin})
    assert r.headers.get("access-control-allow-origin") == origin


@pytest.mark.parametrize("origin", ["http://evil.example", "http://localhost.evil.example", "https://localhost:5173.evil.example"])
def test_cors_still_refuses_other_sites(client, origin):
    r = client.get("/api/datasets", headers={"Origin": origin})
    assert "access-control-allow-origin" not in r.headers
