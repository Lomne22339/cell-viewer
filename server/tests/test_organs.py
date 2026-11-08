"""Synthetic organ datasets for the Organ View: a UMAP and a trajectory per organ.

The two datasets of an organ describe the same cells in the same order, so a
selection made in one is the same selection in the other by index alone. Every
value here is invented, and the manifest says so.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from server.names import SAFE_NAME
from server.organs import ORGAN_VIEW_ORGANS, build_organ_tiles, organ_dataset_ids, simulate_organ
from server.prep import write_tiles
from server.simulate import ATLAS_ORGANS, STAGES

REPO = Path(__file__).resolve().parents[2]
N = 3000


def test_the_three_organs_are_the_ones_with_detailed_figures():
    assert ORGAN_VIEW_ORGANS == ("heart", "brain", "liver")
    for organ in ORGAN_VIEW_ORGANS:
        assert ATLAS_ORGANS[organ]["regions"], f"{organ} has no regions to select"


def test_dataset_ids_are_safe_and_distinct():
    seen = set()
    for organ in ORGAN_VIEW_ORGANS:
        ids = organ_dataset_ids(organ)
        assert set(ids) == {"umap", "trajectory"}
        for ds_id in ids.values():
            assert SAFE_NAME.fullmatch(ds_id)
            assert ds_id.startswith("organ-")
            assert ds_id not in seen
            seen.add(ds_id)
    assert organ_dataset_ids("heart") == {"umap": "organ-heart-umap", "trajectory": "organ-heart-traj"}


def test_an_unknown_organ_is_refused():
    with pytest.raises(ValueError, match="organ"):
        organ_dataset_ids("spleen")
    with pytest.raises(ValueError, match="organ"):
        simulate_organ("spleen", 100)
    with pytest.raises(ValueError, match="at least"):
        simulate_organ("heart", 3)


@pytest.mark.parametrize("organ", ORGAN_VIEW_ORGANS)
class TestPair:
    def test_both_datasets_hold_the_same_cells_in_the_same_order(self, organ):
        umap, traj, _ = simulate_organ(organ, N, seed=1)
        assert umap.n == traj.n == N
        assert umap.codes.keys() == traj.codes.keys()
        for field in umap.codes:
            assert np.array_equal(umap.codes[field], traj.codes[field]), field
            assert umap.levels[field] == traj.levels[field]
        assert umap.numeric.keys() == traj.numeric.keys()
        for field in umap.numeric:
            assert np.array_equal(umap.numeric[field], traj.numeric[field]), field
        assert np.array_equal(umap.ids, traj.ids)
        assert not np.array_equal(umap.xy, traj.xy)

    def test_regions_and_types_are_the_ones_the_figure_recognises(self, organ):
        umap, _, _ = simulate_organ(organ, N, seed=1)
        spec = ATLAS_ORGANS[organ]
        assert umap.levels["anatomical_region"] == spec["regions"]
        assert umap.levels["cell_type"] == spec["types"]
        assert umap.levels["tissue"] == [organ]
        # Every region has cells, or its part of the figure could select nothing.
        used = np.unique(umap.codes["anatomical_region"])
        assert used.tolist() == list(range(len(spec["regions"])))

    def test_it_is_deterministic_and_seeded(self, organ):
        a = simulate_organ(organ, 800, seed=4)
        b = simulate_organ(organ, 800, seed=4)
        c = simulate_organ(organ, 800, seed=5)
        assert np.array_equal(a[0].xy, b[0].xy) and np.array_equal(a[1].xy, b[1].xy)
        assert np.array_equal(a[2].nodes, b[2].nodes)
        assert not np.array_equal(a[0].xy, c[0].xy)

    def test_the_umap_separates_regions(self, organ):
        umap, _, _ = simulate_organ(organ, N, seed=2)
        region = umap.codes["anatomical_region"]
        k = len(umap.levels["anatomical_region"])
        centres = np.stack([umap.xy[region == r].mean(axis=0) for r in range(k)])
        own, other = [], []
        for r in range(k):
            pts = umap.xy[region == r]
            d = np.linalg.norm(pts[:, None, :] - centres[None, :, :], axis=2)
            own.append(d[:, r].mean())
            d[:, r] = np.inf
            other.append(d.min(axis=1).mean())
        assert all(o < x for o, x in zip(own, other))

    def test_each_region_occupies_its_own_stretch_of_the_trajectory(self, organ):
        _, traj, graph = simulate_organ(organ, N, seed=3)
        region = traj.codes["anatomical_region"]
        k = len(traj.levels["anatomical_region"])
        d = np.linalg.norm(traj.xy[:, None, :] - graph.nodes[None, :, :], axis=2)
        node = d.argmin(axis=1)
        purity = []
        for n in np.unique(node):
            counts = np.bincount(region[node == n], minlength=k)
            purity.append(counts.max() / counts.sum())
        assert np.mean(purity) >= 0.75

    def test_the_graph_is_a_rooted_tree_with_fates(self, organ):
        _, traj, graph = simulate_organ(organ, N, seed=3)
        m = len(graph.nodes)
        assert m >= 20
        assert len(graph.edges) == m - 1
        assert graph.root == 0
        assert len(graph.leaves) >= 2
        assert traj.xy.shape == (N, 2)

    def test_pseudotime_and_stage_agree(self, organ):
        umap, _, _ = simulate_organ(organ, N, seed=3)
        pt = umap.numeric["pseudotime"]
        assert pt.min() >= 0 and pt.max() <= 1
        assert pt.max() - pt.min() > 0.5
        expected = np.clip((pt * len(STAGES)).astype(np.int64), 0, len(STAGES) - 1)
        assert np.array_equal(umap.codes["stage"], expected.astype(np.uint16))


class TestTiles:
    def test_write_tiles_records_extra_metadata_and_it_moves_the_version(self, tmp_path):
        umap, _, _ = simulate_organ("heart", 500, seed=0)
        a = write_tiles(umap, tmp_path, "t-a", chunk_size=200)
        assert "meta" not in a
        b = write_tiles(umap, tmp_path, "t-b", chunk_size=200, extra={"synthetic": True, "organ": "heart"})
        assert b["meta"] == {"synthetic": True, "organ": "heart"}
        assert a["version"] != b["version"]

    def test_the_pair_is_written_aligned_after_the_shuffle(self, tmp_path):
        mans = build_organ_tiles(tmp_path, 700, chunk_size=300, seed=0)
        assert set(mans) == set(ORGAN_VIEW_ORGANS)
        for organ in ORGAN_VIEW_ORGANS:
            ids = organ_dataset_ids(organ)
            u, t = mans[organ]["umap"], mans[organ]["trajectory"]
            assert u["datasetId"] == ids["umap"] and t["datasetId"] == ids["trajectory"]
            assert u["hasGraph"] is False and t["hasGraph"] is True
            for man, kind in ((u, "umap"), (t, "trajectory")):
                assert man["meta"] == {"synthetic": True, "organ": organ, "kind": kind}
                assert man["n"] == 700
            ru, rt = tmp_path / ids["umap"], tmp_path / ids["trajectory"]
            assert (ru / "graph.json").exists() is False and (rt / "graph.json").exists()
            # The same permutation: ids and every categorical column line up cell for cell.
            assert np.array_equal(np.load(ru / "cells" / "ids.npy"), np.load(rt / "cells" / "ids.npy"))
            assert np.array_equal(np.load(ru / "cells" / "rows.npy"), np.load(rt / "cells" / "rows.npy"))
            for field in u["categorical"]:
                for c in range(u["chunks"]):
                    a = (ru / "codes" / field / f"{c:03d}.bin").read_bytes()
                    b = (rt / "codes" / field / f"{c:03d}.bin").read_bytes()
                    assert a == b, (organ, field, c)
            assert (ru / "xy" / "000.bin").read_bytes() != (rt / "xy" / "000.bin").read_bytes()

    def test_the_cli_builds_organ_pairs_and_says_they_are_synthetic(self, tmp_path):
        run = subprocess.run(
            [sys.executable, "-m", "server.prep", "--out", str(tmp_path), "--sizes", "--traj-size", "0",
             "--organ-size", "400", "--chunk-size", "250"],
            cwd=REPO, capture_output=True, text=True, check=False,
        )
        assert run.returncode == 0, run.stderr
        assert "synthetic" in run.stdout.lower()
        for organ in ORGAN_VIEW_ORGANS:
            for ds_id in organ_dataset_ids(organ).values():
                man = json.loads((tmp_path / ds_id / "manifest.json").read_text())
                assert man["meta"]["synthetic"] is True
        # Nothing else was generated by the same command.
        assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
            ds for o in ORGAN_VIEW_ORGANS for ds in organ_dataset_ids(o).values()
        )

    def test_the_default_run_does_not_build_organs(self, tmp_path):
        run = subprocess.run(
            [sys.executable, "-m", "server.prep", "--out", str(tmp_path), "--sizes", "300", "--traj-size", "0"],
            cwd=REPO, capture_output=True, text=True, check=False,
        )
        assert run.returncode == 0, run.stderr
        assert not any(p.name.startswith("organ-") for p in tmp_path.iterdir())
