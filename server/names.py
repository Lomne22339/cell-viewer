"""Names that become URL path segments and directory names; ids and fields share one rule."""
from __future__ import annotations

import re

#: `\A` and `\Z` rather than `^` and `$`: `$` also matches before a trailing newline. Callers should
#: still use `fullmatch`.
SAFE_NAME = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")

MAX_NAME = 64
_UNSAFE_RUN = re.compile(r"[^A-Za-z0-9_-]+")
_UNDERSCORE_RUN = re.compile(r"_{2,}")


def is_safe(name: str) -> bool:
    return SAFE_NAME.fullmatch(name) is not None


def slug(name: str) -> str:
    s = _UNDERSCORE_RUN.sub("_", _UNSAFE_RUN.sub("_", name)).strip("_")
    return s[:MAX_NAME].rstrip("_") or "field"


def safe_field_names(names: list[str]) -> list[str]:
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
