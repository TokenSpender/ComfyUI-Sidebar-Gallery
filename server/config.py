from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _package_root() -> Path:
    return Path(__file__).resolve().parents[1]


CONFIG_FILENAME = "sidebar_gallery_config.json"


@dataclass(frozen=True)
class SidebarGalleryConfig:
    extra_roots: list[str]
    # Folder NAMES (not paths) to skip while scanning, e.g. "thumbnails".
    # Stored lowercased; matched case-insensitively against each directory name.
    excluded_dirs: list[str] = field(default_factory=list)
    # When False (default) the scanner skips folders whose names start with a
    # dot (e.g. ".thumbs"); set True to index hidden folders too.
    index_hidden_dirs: bool = False
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
    """Safely cast a value to int, returning fallback on failure."""
    try:
        return int(val)
    except (ValueError, TypeError):
        return fallback


def _clean_str_list(raw_list: Any, *, lower: bool = False, dedupe: bool = False) -> list[str]:
    """Normalise a raw value into a list of non-empty, trimmed strings.

    Non-strings and blanks are dropped. With ``lower`` each entry is lowercased;
    with ``dedupe`` the first occurrence wins and later duplicates are skipped.
    Returns [] for any non-list input. Shared by load/save so excluded-dir names
    are normalised identically on read and write.
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
    path = _package_root() / CONFIG_FILENAME
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
        default_limit=_safe_int(data.get("default_limit"), cfg.default_limit),
        max_limit=_safe_int(data.get("max_limit"), cfg.max_limit),
        max_text_chunk_bytes=_safe_int(data.get("max_text_chunk_bytes"), cfg.max_text_chunk_bytes),
        max_decompressed_text_bytes=_safe_int(data.get("max_decompressed_text_bytes"), cfg.max_decompressed_text_bytes),
    )


def save_config(data: dict[str, Any]) -> SidebarGalleryConfig:
    cfg = load_config()

    # extra_roots: only NEW entries must pass the isdir check; keep already-saved
    # roots even when their drive is momentarily offline, and preserve the saved
    # list when the key is absent or malformed — editing other settings (e.g. the
    # excluded list) must never silently drop a configured folder.
    extra_roots_in = data.get("extra_roots")
    if isinstance(extra_roots_in, list):
        existing = set(cfg.extra_roots)
        extra_roots: list[str] = []
        for raw in extra_roots_in:
            if not isinstance(raw, str):
                continue
            s = raw.strip()
            if not s:
                continue
            try:
                norm = _normalize_dir(s)
            except Exception:
                continue
            if (norm in existing or os.path.isdir(norm)) and norm not in extra_roots:
                extra_roots.append(norm)
    else:
        extra_roots = list(cfg.extra_roots)

    # Excluded dirs are plain folder NAMES, not paths — no normalisation or isdir
    # check. Lowercased + de-duplicated; saved list preserved if absent/malformed.
    excluded_in = data.get("excluded_dirs")
    if isinstance(excluded_in, list):
        excluded_dirs = _clean_str_list(excluded_in, lower=True, dedupe=True)
    else:
        excluded_dirs = list(cfg.excluded_dirs)

    index_hidden_dirs = data.get("index_hidden_dirs", cfg.index_hidden_dirs)
    if not isinstance(index_hidden_dirs, bool):
        index_hidden_dirs = cfg.index_hidden_dirs

    out = SidebarGalleryConfig(
        extra_roots=extra_roots,
        excluded_dirs=excluded_dirs,
        index_hidden_dirs=index_hidden_dirs,
        default_limit=max(1, _safe_int(data.get("default_limit"), cfg.default_limit)),
        max_limit=max(1, _safe_int(data.get("max_limit"), cfg.max_limit)),
        max_text_chunk_bytes=max(1024, _safe_int(data.get("max_text_chunk_bytes"), cfg.max_text_chunk_bytes)),
        max_decompressed_text_bytes=max(
            1024, _safe_int(data.get("max_decompressed_text_bytes"), cfg.max_decompressed_text_bytes)
        ),
    )

    path = _package_root() / CONFIG_FILENAME
    path.write_text(
        json.dumps(
            {
                "extra_roots": out.extra_roots,
                "excluded_dirs": out.excluded_dirs,
                "index_hidden_dirs": out.index_hidden_dirs,
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

