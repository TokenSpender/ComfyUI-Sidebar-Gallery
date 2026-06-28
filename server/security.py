from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class AllowedRoot:
    root_id: str
    label: str
    path: str


def _norm_abs(p: str) -> str:
    return os.path.abspath(os.path.normpath(p))


def make_root_id(prefix: str, path: str) -> str:
    # Short stable-ish ID; used only as a lookup key, not as a secret.
    import hashlib

    h = hashlib.sha1(path.encode("utf-8", errors="ignore")).hexdigest()[:10]
    return f"{prefix}_{h}"


def safe_join(root_path: str, relpath: str) -> str:
    if not isinstance(relpath, str):
        raise ValueError("Invalid path")
    if relpath.startswith(("/", "\\")) or ".." in relpath.replace("\\", "/").split("/"):
        raise ValueError("Invalid path")

    root_abs = _norm_abs(root_path)
    full = _norm_abs(os.path.join(root_abs, relpath))
    if os.path.commonpath([full, root_abs]) != root_abs:
        raise ValueError("Path escapes root")

    # Symlink-aware check: resolve real targets so a symlink INSIDE the root that
    # points outside it can't be used to escape (the lexical check above does not
    # follow links). Compared against realpath(root) so a legitimately symlinked
    # root (e.g. StabilityMatrix junctions) still validates. We still RETURN the
    # lexical `full`, so thumbnail cache keys and displayed filenames are unchanged.
    #
    # IMPORTANT: os.path.realpath() can RAISE on Windows when a path crosses a
    # junction/mount point that the Redirection Guard mitigation deems "untrusted"
    # (WinError 448). That trust is per-process and can be absent on a fresh start
    # or lapse intermittently, which would otherwise turn EVERY file request into
    # an unhandled OSError -> HTTP 500 (and hit HEVC playback hardest, since it
    # fires far more range requests). The lexical commonpath check above has
    # already proven the path doesn't escape the root textually, so if realpath is
    # unavailable we fall back to trusting that (the pre-hardening behaviour)
    # instead of denying the file. The link-escape hardening still applies whenever
    # realpath succeeds.
    try:
        root_real = os.path.realpath(root_abs)
        full_real = os.path.realpath(full)
        within = os.path.commonpath([full_real, root_real]) == root_real
    except OSError:
        within = True  # realpath blocked (e.g. untrusted junction) -> rely on lexical check
    except ValueError:
        within = False  # different drives -> cannot be inside the root
    if not within:
        raise ValueError("Path escapes root")
    return full

