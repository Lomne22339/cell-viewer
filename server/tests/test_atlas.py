"""The synthetic multi-organ atlas behind the segmented-anatomy view."""
import numpy as np
import pytest

from server.simulate import ATLAS_ORGANS, simulate_atlas


def labels(ds, field):
    return np.asarray(ds.levels[field])[ds.codes[field]]


def test_atlas_shapes_fields_and_dtypes():
    ds = simulate_atlas(20_000, seed=1)
    assert ds.xy.shape == (20_000, 2) and ds.xy.dtype == np.float32
    assert set(ds.codes) == {"cell_type", "tissue", "anatomical_region", "donor", "stage"}
    for field, codes in ds.codes.items():
        assert codes.dtype == np.uint16
        assert codes.max() < len(ds.levels[field])
    assert np.isfinite(ds.xy).all()


def test_every_organ_is_present_and_named_like_the_body_model():
    ds = simulate_atlas(50_000, seed=2)
    present = set(labels(ds, "tissue"))
    assert present == set(ATLAS_ORGANS)
    # The body model's aliases (packages/core/src/anatomy/models/body.ts) cover these.
    for organ in ("brain", "heart", "lung", "liver", "pancreas", "kidney", "blood", "skin"):
        assert organ in present


def test_regions_belong_to_their_organ():
    """A heart chamber on a liver cell would light up the wrong figure."""
    ds = simulate_atlas(40_000, seed=3)
    tissue = labels(ds, "tissue")
    region = labels(ds, "anatomical_region")
    for organ, spec in ATLAS_ORGANS.items():
        allowed = set(spec["regions"]) if spec["regions"] else {organ}
        got = set(region[tissue == organ])
        assert got <= allowed, organ
        if spec["regions"]:
            assert len(got) == len(allowed), f"{organ}: every region should be sampled"


def test_detailed_organs_use_labels_the_organ_models_recognise():
    assert ATLAS_ORGANS["heart"]["regions"] == [
        "right atrium", "left atrium", "right ventricle", "left ventricle",
        "interventricular septum", "apex",
    ]
    assert "hippocampus" in ATLAS_ORGANS["brain"]["regions"]
    assert all(r.startswith("liver: ") for r in ATLAS_ORGANS["liver"]["regions"])
    assert all(r.startswith("pancreas: ") for r in ATLAS_ORGANS["pancreas"]["regions"])


def test_cell_types_are_organ_specific():
    ds = simulate_atlas(30_000, seed=4)
    tissue = labels(ds, "tissue")
    ct = labels(ds, "cell_type")
    assert "Cardiomyocyte" in set(ct[tissue == "heart"])
    assert "Cardiomyocyte" not in set(ct[tissue == "brain"])
    assert "Beta cell" in set(ct[tissue == "pancreas"])


def test_organs_form_separate_islands():
    """Clicking an organ should select a coherent island, so a cell's nearest
    neighbours must almost always come from the same organ."""
    ds = simulate_atlas(30_000, seed=5)
    tissue = ds.codes["tissue"]
    rng = np.random.default_rng(0)
    probe = rng.choice(ds.n, size=1500, replace=False)
    d = ((ds.xy[probe, None, :] - ds.xy[None, :, :]) ** 2).sum(axis=2)
    d[np.arange(len(probe)), probe] = np.inf
    nearest = np.argpartition(d, 10, axis=1)[:, :10]
    purity = (tissue[nearest] == tissue[probe][:, None]).mean()
    assert purity > 0.99, f"neighbour purity {purity:.3f}"


def test_deterministic_by_seed_and_rejects_bad_n():
    a = simulate_atlas(2000, seed=7)
    b = simulate_atlas(2000, seed=7)
    assert np.array_equal(a.xy, b.xy)
    with pytest.raises(ValueError, match="at least 1"):
        simulate_atlas(0)


@pytest.mark.parametrize("n", [1, 5, 999])
def test_small_atlas_does_not_crash(n):
    assert simulate_atlas(n, seed=0).xy.shape == (n, 2)
