"""Names that become URL path segments and directory names.

Dataset ids and field names are both served under `/api/dataset/...` and
stored as directories under the tile root, so they share one rule. The tile
routes reject anything else; the tile writer refuses unsafe dataset ids and
renames unsafe field names, so everything it writes can actually be served.
"""
from __future__ import annotations

import re

#: `\A` and `\Z` rather than `^` and `$`: `$` also matches before a trailing
#: newline, so `"sim1m\n"` would pass a `.match` check. Callers should still
#: use `fullmatch`, but the anchors keep `.match` honest too.
SAFE_NAME = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")

MAX_NAME = 64
_UNSAFE_RUN = re.compile(r"[^A-Za-z0-9_-]+")
_UNDERSCORE_RUN = re.compile(r"_{2,}")


def is_safe(name: str) -> bool:
    return SAFE_NAME.fullmatch(name) is not None


def slug(name: str) -> str:
    """A safe stand-in for an unsafe name: `percent.mt` becomes `percent_mt`.

    Runs of unsafe characters become one underscore, repeated underscores
    collapse, and underscores left at either end are dropped, so `% mito`
    reads `mito` rather than `_mito`. A name with nothing usable in it, such
    as `..`, becomes `field`.
    """
    s = _UNDERSCORE_RUN.sub("_", _UNSAFE_RUN.sub("_", name)).strip("_")
    return s[:MAX_NAME].rstrip("_") or "field"


def safe_field_names(names: list[str]) -> list[str]:
    """Safe, unique names for `names`, in the same order.

    Names that are already safe keep their spelling, so a real `cell_type`
    column is never displaced by a `cell type` column that slugs onto it;
    the newcomer gets `cell_type_2` instead. A name that appears twice is
    kept twice: categorical and numeric fields live in separate directories,
    and renaming a valid name would change established output.
    """
    taken = {n for n in names if is_safe(n)}
    out: list[str] = []
    for name in names:
        if is_safe(name):
            out.append(name)
            continue
        base = slug(name)
        candidate, i = base, 2
        while candidate in taken:
            suffix = f"_{i}"
            candidate = base[: MAX_NAME - len(suffix)] + suffix
            i += 1
        taken.add(candidate)
        out.append(candidate)
    return out
