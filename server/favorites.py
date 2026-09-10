from __future__ import annotations

import json
import os
import threading
from pathlib import Path


FAVORITES_FILENAME = "sidebar_gallery_favorites.json"

_lock = threading.RLock()


def _package_root() -> Path:
    return Path(__file__).resolve().parents[1]


def favorites_path() -> Path:
    return _package_root() / FAVORITES_FILENAME


def read_favorites() -> dict[str, dict[str, bool]]:
    try:
        favorites = json.loads(favorites_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(favorites, dict):
        return {}

    sanitized: dict[str, dict[str, bool]] = {}
    for root_id, entries in favorites.items():
        if not isinstance(root_id, str) or not isinstance(entries, dict):
            continue
        sanitized[root_id] = {
            relpath: True for relpath in entries if isinstance(relpath, str)
        }
    return sanitized


def write_favorites(favorites: dict[str, dict[str, bool]]) -> None:
    path = favorites_path()
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(favorites, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    os.replace(temporary_path, path)


def list_for_root(root_id: str) -> list[str]:
    with _lock:
        return list(read_favorites().get(root_id, {}).keys())


def set_favorite(root_id: str, relpath: str, starred: bool) -> int:
    with _lock:
        favorites = read_favorites()
        entries = favorites.setdefault(root_id, {})
        if starred and relpath not in entries:
            entries[relpath] = True
            write_favorites(favorites)
        elif not starred and relpath in entries:
            del entries[relpath]
            if not entries:
                del favorites[root_id]
            write_favorites(favorites)
        return favorites_version()


def favorites_version() -> int:
    try:
        return os.stat(favorites_path()).st_mtime_ns
    except OSError:
        return 0
