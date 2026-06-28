from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _package_root() -> Path:
    return Path(__file__).resolve().parents[1]


CONFIG_FILENAME = "sidebar_gallery_config.json"


@dataclass(frozen=True)
class SidebarGalleryConfig:
    extra_roots: list[str]
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


def load_config() -> SidebarGalleryConfig:
    path = _package_root() / CONFIG_FILENAME
    if not path.exists():
        return SidebarGalleryConfig.defaults()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return SidebarGalleryConfig.defaults()

    extra_roots = []
    for raw in data.get("extra_roots", []) or []:
        if not isinstance(raw, str):
            continue
        s = raw.strip()
        if not s:
            continue
        extra_roots.append(s)

    cfg = SidebarGalleryConfig.defaults()
    return SidebarGalleryConfig(
        extra_roots=extra_roots,
        default_limit=_safe_int(data.get("default_limit"), cfg.default_limit),
        max_limit=_safe_int(data.get("max_limit"), cfg.max_limit),
        max_text_chunk_bytes=_safe_int(data.get("max_text_chunk_bytes"), cfg.max_text_chunk_bytes),
        max_decompressed_text_bytes=_safe_int(data.get("max_decompressed_text_bytes"), cfg.max_decompressed_text_bytes),
    )


def save_config(data: dict[str, Any]) -> SidebarGalleryConfig:
    cfg = load_config()

    extra_roots_in = data.get("extra_roots", cfg.extra_roots)
    extra_roots: list[str] = []
    if isinstance(extra_roots_in, list):
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
            if os.path.isdir(norm):
                extra_roots.append(norm)

    out = SidebarGalleryConfig(
        extra_roots=extra_roots,
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

