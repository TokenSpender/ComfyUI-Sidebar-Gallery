"""The section and field tables every server module reads, derived from
`section_catalog.json` so none of them hardcodes one."""

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
    return load_catalog()["sections"]

def known_summary_keys() -> set[str]:
    keys: set[str] = set()
    for entry in sections():
        keys.update(entry["summary_keys"])
    keys.update(load_catalog()["flags"])
    return keys

def meta_key_buckets() -> dict[str, str]:
    return {e["key"]: e["kind"] for e in sections()}

def non_bindable_summary_keys() -> set[str]:
    # A list or object section has no single value a field could be bound to.
    keys = {k for k, kind in meta_key_buckets().items() if kind in ("array", "object", "nodes")}
    keys.update(load_catalog()["non_bindable_flags"])
    return keys

def non_bindable_element_keys() -> dict[str, list[str]]:
    return load_catalog()["non_bindable_element_keys"]

# Read for every stored leaf, so it is built once.
@lru_cache(maxsize=1)
def index_exclude_leaf_keys() -> frozenset[str]:
    return frozenset(load_catalog()["search"]["index_exclude_leaf_keys"])

def prose_paths() -> frozenset[str]:
    return frozenset(load_catalog()["search"]["prose_paths"])

def prose_length_threshold() -> int:
    return int(load_catalog()["search"]["prose_length_threshold"])

def plain_exclude_paths() -> frozenset[str]:
    """Paths a term with no prefix never reads. A word in the negative prompt
    names what the image avoids, so only a scoped search reaches it."""
    return frozenset(load_catalog()["search"]["plain_exclude_paths"])

# Read for every tag of every file the matcher reads, so it is built once.
@lru_cache(maxsize=1)
def server_alias_map() -> dict[str, str]:
    out: dict[str, str] = {}
    for e in load_catalog()["search"]["extra_fields"]:
        for a in e.get("server_aliases", []):
            out[a] = e["field"]
    for e in sections():
        if e["search_field"]:
            for a in e.get("server_aliases", []):
                out[a] = e["search_field"]
    return out

def search_schema_payload() -> dict[str, Any]:
    blk = load_catalog()["search"]
    secs: dict[str, Any] = {}
    for e in sections():
        row = {"section_id": e["section_id"], "search_field": e["search_field"],
               "key": e["key"], "kind": e["kind"], "summary_keys": list(e["summary_keys"])}
        if "display_name" in e:
            row["display_name"] = e["display_name"]
        secs[e["title"]] = row
    searchable = [e for e in sections() if e["search_field"]]
    # A section's own spellings come first, then an extra field's, and a
    # section's title takes only a spelling neither claimed.
    resolve: dict[str, str] = {}
    for e in searchable:
        for spelling in [e["search_field"], *e["search_aliases"], *e.get("server_aliases", [])]:
            resolve.setdefault(spelling.lower(), e["search_field"])
    for e in blk["extra_fields"]:
        for spelling in [e["field"], *e["aliases"], *e.get("server_aliases", [])]:
            resolve.setdefault(spelling.lower(), e["field"])
    for e in searchable:
        resolve.setdefault(e["title"].lower(), e["search_field"])
    # The filename is no catalog section, so its search name is added here.
    resolve.setdefault("name", "name")
    reserved = sorted(set(resolve) | {"any"})
    # Where two extra fields list one root, the one listing fewer paths takes
    # it, and a section takes only a root no extra field claimed. An extra
    # field's dotted path claims nothing, since a field reading one key under a
    # root must not capture every other key under it.
    root_fields: dict[str, str] = {}
    for e in sorted(blk["extra_fields"], key=lambda x: len(x["paths"])):
        for pth in e["paths"]:
            if "." not in pth:
                root_fields.setdefault(pth, e["field"])
    for e in searchable:
        for pth in e["search_paths"]:
            root_fields.setdefault(pth.split(".")[0], e["search_field"])
    owners: dict[str, list[str]] = {}
    for e in searchable:
        owners.setdefault(e["search_field"], []).append(e["title"])
    badge_labels = {f: ts[0] for f, ts in owners.items() if len(ts) == 1}
    return {
        "resolve": resolve,
        "sections": secs,
        "prefixes": list(blk["offered_prefixes"]),
        "reserved": reserved,
        "root_fields": root_fields,
        "roots": sorted(known_summary_keys() | set(root_fields)),
        "badge_labels": badge_labels,
        "plain_exclude_paths": sorted(plain_exclude_paths()),
    }
