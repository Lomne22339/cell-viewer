"""Writes a tiny, invented heart example in the formats the Organ View reads.

    .venv/bin/python docs/examples/make_organ_example.py OUT_DIR

creates in OUT_DIR:

    heart_umap.parquet   one row per cell: cell_id, x, y, anatomical_region, cell_type
    heart_traj.parquet   the SAME cells in the SAME order, with trajectory x, y
                         and a numeric pseudotime column
    heart_graph.json     the trajectory's principal graph

Everything is random. It exists to show the shape of the files, and to let
`docs/ORGAN_DATA.md` be followed end to end. It is not biology.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REGIONS = ["right atrium", "left atrium", "right ventricle", "left ventricle", "interventricular septum", "apex"]
TYPES = ["Cardiomyocyte", "Cardiac fibroblast", "Endothelial cell", "Pericyte"]
N = 600


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(0)
    # The columns that must match between the two files, written once.
    cells = pd.DataFrame({
        "cell_id": [f"heart_{i:05d}" for i in range(N)],          # unique, same order in both files
        "anatomical_region": rng.choice(REGIONS, size=N),          # one of the figure's part names
        "cell_type": rng.choice(TYPES, size=N),
    })
    angle = 2 * np.pi * np.array([REGIONS.index(r) for r in cells["anatomical_region"]]) / len(REGIONS)
    umap = pd.concat([cells, pd.DataFrame({
        "x": 10 * np.cos(angle) + rng.normal(0, 1, N),
        "y": 10 * np.sin(angle) + rng.normal(0, 1, N),
    })], axis=1)
    t = rng.random(N)
    traj = pd.concat([cells, pd.DataFrame({
        "x": 20 * t + rng.normal(0, 0.5, N),
        "y": 5 * np.sin(6 * t) + rng.normal(0, 0.5, N),
        "pseudotime": t.astype("float32"),
    })], axis=1)
    umap.to_parquet(out / "heart_umap.parquet", index=False)
    traj.to_parquet(out / "heart_traj.parquet", index=False)

    # A principal graph along the same curve: a line of 6 nodes with one branch.
    xs = np.linspace(0, 20, 6)
    nodes = [[float(x), float(5 * np.sin(6 * x / 20))] for x in xs] + [[15.0, -4.0]]
    graph = {
        "nodes": nodes,
        "edges": [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [3, 6]],
        "root": 0,
        "branchPoints": [3],
        "leaves": [5, 6],
    }
    (out / "heart_graph.json").write_text(json.dumps(graph))
    print(f"wrote {N} cells and a graph to {out}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
