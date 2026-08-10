"""Single source of truth for the SBG metadata-section schema.

This module loads ``section_catalog.json`` and derives the tables that would
otherwise be hardcoded in each consumer:

  - ``known_summary_keys()`` feeds ``_KNOWN_SUMMARY_KEYS`` in metadata.py
  - ``meta_key_buckets()`` feeds the ``get_all_meta_keys`` buckets in db.py
  - ``section_titles()`` and the non-bindable key sets are served to the
    frontend by routes.py

Pure stdlib (json + pathlib) so it is importable anywhere, including an
environment without ComfyUI.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_CATALOG_PATH = Path(__file__).resolve().parents[1] / "section_catalog.json"


@lru_cache(maxsize=1)
def load_catalog() -> dict[str, Any]:
    with open(_CATALOG_PATH, encoding="utf-8") as f:
        return json.load(f)


def sections() -> list[dict[str, Any]]:
    return load_catalog().get("sections", [])


def known_summary_keys() -> set[str]:
    """Every top-level key the parser is allowed to emit on a summary."""
    keys: set[str] = set()
    for entry in sections():
        keys.update(entry.get("summary_keys", []))
    keys.update(load_catalog().get("flags", []))
    return keys


def meta_key_buckets() -> dict[str, str]:
    """Drives ``db.get_all_meta_keys`` bucketing: array-of-dict sections
    collect item param keys, object sections collect dict keys.
    """
    return {e["key"]: e["kind"] for e in sections()}


def non_bindable_summary_keys() -> set[str]:
    """Top-level summary keys the layout editor must NOT offer as bindable
    field paths: list/object-shaped section keys (their per-item params are
    offered instead) plus the catalog's non_bindable_flags (list- or
    boolean-valued flags that render as noise in a kv field). Served through
    meta_keys so a future list-shaped key only needs a catalog entry, leaving
    no room for the silent [object Object] fields that appear when a hardcoded
    frontend skip is forgotten."""
    keys = {k for k, kind in meta_key_buckets().items() if kind in ("array", "object", "nodes")}
    keys.update(load_catalog().get("non_bindable_flags", []))
    return keys


def non_bindable_element_keys() -> dict[str, list[str]]:
    """Per-element keys inside array sections that the layout editor must not
    offer as bindable fields. These are the internal markers the parser stamps
    on a sampler or lora item for scoping and pairing (stage, role, the node
    label, the loader id), which render as noise or nothing in the panel.
    Served through meta_keys next to non_bindable_summary_keys."""
    return load_catalog().get("non_bindable_element_keys", {})


def search_fields() -> set[str]:
    """The backend search field names the catalog declares.

    Must be a subset of the fields handled by ``search.match_summary``.
    """
    return {e["search_field"] for e in sections() if e.get("search_field")}


def search_alias_map() -> dict[str, str]:
    """Map user-typed names (key, section id, title, aliases) to the backend
    search field.
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


def section_titles() -> dict[str, str]:
    """Default (catalog) section titles, keyed by section_id.

    Served through /config so the frontend can tell a layout-editor retitle
    apart from a section's shipped name (TL.getSectionRenames). The shipped
    default layouts cannot serve this purpose: they are a curated profile
    snapshot and omit sections that only appear in other apps' profiles.
    """
    return {e["section_id"]: e["title"] for e in sections()}


def default_layout(media: str = "image") -> list[dict[str, Any]]:
    """Build the default section profile for a media kind from the catalog."""
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
