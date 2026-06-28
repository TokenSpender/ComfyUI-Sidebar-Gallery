"""Single source of truth for the SBG metadata-section schema.

This module loads ``section_catalog.json`` and derives the tables that
would otherwise be hardcoded in six separate places:

  - metadata.py  ``_KNOWN_SUMMARY_KEYS``       -> ``known_summary_keys()``
  - routes.py    ``_match_summary`` field set  -> ``search_fields()``
  - db.py        ``get_all_meta_keys`` buckets -> ``meta_key_buckets()``
  - sbg-translation-layer.js default layout    -> ``default_layout()``
  - sbg-section-registry.js search-name map    -> ``search_alias_map()``
  - sbg-layout-editor.js PATH_GROUPS           -> (derived from ids)

The catalog is the single definition; each consumer derives its tables
from here instead of keeping a hardcoded copy.

Pure stdlib (json + pathlib) so it is importable anywhere, including a
bare test environment without ComfyUI.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_CATALOG_PATH = Path(__file__).resolve().parents[1] / "section_catalog.json"


@lru_cache(maxsize=1)
def load_catalog() -> dict[str, Any]:
    """Load and cache the raw catalog document."""
    with open(_CATALOG_PATH, encoding="utf-8") as f:
        return json.load(f)


def sections() -> list[dict[str, Any]]:
    """Return the list of section entries."""
    return load_catalog().get("sections", [])


def known_summary_keys() -> set[str]:
    """Every top-level key the parser is allowed to emit on a summary.

    Union of each section's ``summary_keys`` plus the catalog ``flags``.
    Mirror of ``metadata._KNOWN_SUMMARY_KEYS``.
    """
    keys: set[str] = set()
    for entry in sections():
        keys.update(entry.get("summary_keys", []))
    keys.update(load_catalog().get("flags", []))
    return keys


def meta_key_buckets() -> dict[str, str]:
    """Map each section's primary summary key -> its kind.

    Used to drive ``db.get_all_meta_keys`` bucketing (array-of-dict
    sections collect item param keys; object sections collect dict keys).
    """
    return {e["key"]: e["kind"] for e in sections()}


def search_fields() -> set[str]:
    """The set of backend search field names the catalog declares.

    Must be a subset of the fields handled by ``routes._match_summary``.
    """
    return {e["search_field"] for e in sections() if e.get("search_field")}


def search_alias_map() -> dict[str, str]:
    """Map user-typed names (id, title, aliases) -> backend search field.

    Replacement for the registry's ``SEARCH_FIELD_ALIASES`` +
    ``getSearchField`` chain.
    """
    out: dict[str, str] = {}
    for e in sections():
        sf = e.get("search_field")
        if not sf:
            continue
        out[e["key"].lower()] = sf
        out[e["section_id"].lower()] = sf
        out[e["title"].lower()] = sf
        for alias in e.get("search_aliases", []):
            out[alias.lower()] = sf
    return out


def default_layout(media: str = "image") -> list[dict[str, Any]]:
    """Build the default section profile for a media kind from the catalog.

    Mirror of TL ``defaultImageLayout`` / ``defaultVideoLayout``. Consumed
    by the front-end in a later stage; provided here so the catalog is the
    single definition.
    """
    layout: list[dict[str, Any]] = []
    for e in sections():
        if media not in e.get("media", ["image", "video"]):
            continue
        d = e.get("default", {})
        params = d.get("params_video") if (media == "video" and d.get("params_video")) else d.get("params", [])
        sec: dict[str, Any] = {
            "id": e["section_id"],
            "title": e["title"],
            "style": d.get("style", "flat"),
            "open": d.get("open", True),
            "params": [dict(p) for p in params],
        }
        if d.get("source"):
            sec["source"] = d["source"]
        if d.get("highlow"):
            sec["highlow"] = True
        layout.append(sec)
    return layout
