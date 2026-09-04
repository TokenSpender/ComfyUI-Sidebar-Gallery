from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _package_root() -> Path:
    return Path(__file__).resolve().parents[1]


CONFIG_FILENAME = "sidebar_gallery_config.json"


def config_path() -> Path:
    return _package_root() / CONFIG_FILENAME


@dataclass(frozen=True)
class SidebarGalleryConfig:
    extra_roots: list[str]
    # Names of folders to skip while scanning, e.g. "thumbnails". Stored
    # lowercased; matched case-insensitively against each directory name.
    excluded_dirs: list[str] = field(default_factory=list)
    # When False the scanner skips folders whose names start with a dot,
    # e.g. ".thumbs".
    index_hidden_dirs: bool = False
    # Seconds between background polls for external file changes
    # (delete/move/rename) while the gallery is open. 0 disables polling.
    auto_refresh_interval_s: int = 15
    default_limit: int = 120
    max_limit: int = 500
    max_text_chunk_bytes: int = 8 * 1024 * 1024
    max_decompressed_text_bytes: int = 16 * 1024 * 1024

    @staticmethod
    def defaults() -> "SidebarGalleryConfig":
        return SidebarGalleryConfig(extra_roots=[])


def _normalize_dir(p: str) -> str:
    p = os.path.expandvars(os.path.expanduser(p.strip()))
    p = os.path.normpath(p)
    return os.path.abspath(p)


def _safe_int(val: Any, fallback: int) -> int:
    try:
        return int(val)
    except (ValueError, TypeError):
        return fallback


def _norm_refresh_interval(n: int) -> int:
    """Auto-refresh interval: 0 (timer off) or at least 5 seconds. The
    frontend enforces the same 5s floor; normalising here keeps the stored
    config, the settings UI, and the actual polling in agreement."""
    return 0 if n <= 0 else max(5, n)


def _clean_str_list(raw_list: Any, *, lower: bool = False, dedupe: bool = False) -> list[str]:
    """Normalise a raw value into a list of non-empty, trimmed strings.

    Returns [] for any non-list input; ``dedupe`` keeps the first occurrence.
    Shared by load/save so excluded-dir names are normalised identically on
    read and write.
    """
    out: list[str] = []
    if not isinstance(raw_list, list):
        return out
    for raw in raw_list:
        if not isinstance(raw, str):
            continue
        s = raw.strip()
        if lower:
            s = s.lower()
        if not s or (dedupe and s in out):
            continue
        out.append(s)
    return out


def load_config() -> SidebarGalleryConfig:
    path = config_path()
    if not path.exists():
        return SidebarGalleryConfig.defaults()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return SidebarGalleryConfig.defaults()
    if not isinstance(data, dict):
        return SidebarGalleryConfig.defaults()

    extra_roots = _clean_str_list(data.get("extra_roots"))
    excluded_dirs = _clean_str_list(data.get("excluded_dirs"), lower=True, dedupe=True)

    cfg = SidebarGalleryConfig.defaults()
    return SidebarGalleryConfig(
        extra_roots=extra_roots,
        excluded_dirs=excluded_dirs,
        index_hidden_dirs=bool(data.get("index_hidden_dirs", False)),
        auto_refresh_interval_s=_norm_refresh_interval(
            _safe_int(data.get("auto_refresh_interval_s"), cfg.auto_refresh_interval_s)),
        default_limit=_safe_int(data.get("default_limit"), cfg.default_limit),
        max_limit=_safe_int(data.get("max_limit"), cfg.max_limit),
        max_text_chunk_bytes=_safe_int(data.get("max_text_chunk_bytes"), cfg.max_text_chunk_bytes),
        max_decompressed_text_bytes=_safe_int(data.get("max_decompressed_text_bytes"), cfg.max_decompressed_text_bytes),
    )


def save_config(data: dict[str, Any]) -> SidebarGalleryConfig:
    cfg = load_config()

    # A submitted list can only keep or drop roots the file already holds.
    # New roots can only be added by manually editing the file.
    extra_roots_in = data.get("extra_roots")
    if isinstance(extra_roots_in, list):
        existing = {_normalize_dir(p): p for p in cfg.extra_roots}
        extra_roots: list[str] = []
        for raw in extra_roots_in:
            if not isinstance(raw, str):
                continue
            try:
                norm = _normalize_dir(raw)
            except Exception:
                continue
            kept = existing.get(norm)
            if kept is not None and kept not in extra_roots:
                extra_roots.append(kept)
    else:
        extra_roots = list(cfg.extra_roots)

    # Excluded dirs are plain folder names, so there is no path normalisation
    # or isdir check. The saved list is preserved when the key is absent or
    # malformed.
    excluded_in = data.get("excluded_dirs")
    if isinstance(excluded_in, list):
        excluded_dirs = _clean_str_list(excluded_in, lower=True, dedupe=True)
    else:
        excluded_dirs = list(cfg.excluded_dirs)

    index_hidden_dirs = data.get("index_hidden_dirs", cfg.index_hidden_dirs)
    if not isinstance(index_hidden_dirs, bool):
        index_hidden_dirs = cfg.index_hidden_dirs

    auto_refresh_interval_s = _norm_refresh_interval(
        _safe_int(data.get("auto_refresh_interval_s"), cfg.auto_refresh_interval_s))

    out = SidebarGalleryConfig(
        extra_roots=extra_roots,
        excluded_dirs=excluded_dirs,
        index_hidden_dirs=index_hidden_dirs,
        auto_refresh_interval_s=auto_refresh_interval_s,
        default_limit=max(1, _safe_int(data.get("default_limit"), cfg.default_limit)),
        max_limit=max(1, _safe_int(data.get("max_limit"), cfg.max_limit)),
        max_text_chunk_bytes=max(1024, _safe_int(data.get("max_text_chunk_bytes"), cfg.max_text_chunk_bytes)),
        max_decompressed_text_bytes=max(
            1024, _safe_int(data.get("max_decompressed_text_bytes"), cfg.max_decompressed_text_bytes)
        ),
    )

    config_path().write_text(
        json.dumps(
            {
                "extra_roots": out.extra_roots,
                "excluded_dirs": out.excluded_dirs,
                "index_hidden_dirs": out.index_hidden_dirs,
                "auto_refresh_interval_s": out.auto_refresh_interval_s,
                "default_limit": out.default_limit,
                "max_limit": out.max_limit,
                "max_text_chunk_bytes": out.max_text_chunk_bytes,
                "max_decompressed_text_bytes": out.max_decompressed_text_bytes,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return out

