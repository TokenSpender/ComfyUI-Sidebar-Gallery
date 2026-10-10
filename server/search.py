from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from . import schema

_NODES = "workflow_nodes"
_NODE_TITLE = "workflow_nodes.title"
_NODE_PARAMS = "workflow_nodes.params."
_NEGATIVE = "negative_prompt"
_SAMPLERS = "samplers"
# initial_image repeats the first of initial_images where the list exists, so
# a plain term reads it only for a file carrying no list.
_SINGLE_IMAGE = "initial_image"
_IMAGE_LIST = "initial_images"

def storable(text: str) -> str:
    # Half of an emoji, as a node that cut a prompt through one leaves, comes
    # back from the stored JSON as a lone surrogate, which cannot be bound. It
    # goes in as the replacement character, so the rest of the text is indexed,
    # and a search value pasted from such text is bound the same way.
    return text if text.isascii() else text.encode("utf-8", "surrogatepass").decode("utf-8", "replace")

def _count_hits(haystack: str, needle: str) -> int:
    # Called once a match is established, so a key that matched with no
    # occurrence in its value still counts as one hit.
    if needle and needle in haystack:
        return haystack.count(needle)
    return 1

def summary_rows(obj: Any, prefix: str = "", ord_: int = 0,
                 depth: int = 0) -> list[tuple[str, int, Any]]:
    """Every leaf below `obj` as the search index stores it: its dotted path,
    its position in the nearest list, and its value. A list does not extend
    the path, so every item of one list shares one path."""
    excluded = schema.index_exclude_leaf_keys()
    out: list[tuple[str, int, Any]] = []
    if isinstance(obj, (dict, list)):
        if depth <= 12:
            _walk(obj, prefix, ord_, depth, excluded, out)
    elif (obj is not None and obj != "" and depth <= 12
          and prefix.rpartition(".")[2] not in excluded):
        out.append((prefix, ord_, obj))
    return out

# The matcher walks every file it is given, so a leaf is kept where its
# container is walked instead of costing a call of its own.
def _walk(obj: dict | list, prefix: str, ord_: int, depth: int,
          excluded: frozenset[str], out: list) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, (dict, list)):
                if depth < 12:
                    _walk(v, path, ord_, depth + 1, excluded, out)
            elif (v is not None and v != "" and depth < 12 and k not in excluded
                  and ("." not in k or k.rpartition(".")[2] not in excluded)):
                out.append((path, ord_, v))
    else:
        leaf_kept = prefix.rpartition(".")[2] not in excluded
        for i, v in enumerate(obj):
            if isinstance(v, (dict, list)):
                if depth < 12:
                    _walk(v, prefix, i, depth + 1, excluded, out)
            elif v is not None and v != "" and depth < 12 and leaf_kept:
                out.append((prefix, i, v))

def _rows_under(s: dict, root: str) -> list[tuple[str, int, Any]]:
    return summary_rows(s[root], root, 0, 1) if root in s else []

_NEG_PIECE_MIN = 20
# The parser writes an embedding by its name alone, so the node's own spelling
# is read without the prefix.
_EMBEDDING_PREFIX = re.compile(r"embedding:\s*")

def _is_negative_text(param: str, negative: str) -> bool:
    """Whether a node setting holds the negative prompt, whole or as a long
    piece of it, since a workflow keeps that text on the node that encodes it
    as well as in the summary. A short setting counts only as the whole
    prompt, or a value such as a step count would match by chance."""
    p = _EMBEDDING_PREFIX.sub("", str(param).lower()).strip()
    n = _EMBEDDING_PREFIX.sub("", str(negative).lower()).strip()
    if not p or not n:
        return False
    return p == n or (len(p) >= _NEG_PIECE_MIN and p in n)

@lru_cache(maxsize=1)
def _field_spec() -> dict[str, dict]:
    # Per field: paths are exact fact paths with the badge and counting rule of
    # each, prefixes are roots whose key names are searchable too, presence
    # answers a tag with no value, and plain is the badge a plain term gives
    # the field's paths where it differs from the field's own.
    cat = schema.load_catalog()
    spec: dict[str, dict] = {}

    def ensure(field: str) -> dict:
        return spec.setdefault(field, {"paths": [], "prefixes": [], "presence": [], "plain": None})

    for sec in cat["sections"]:
        field = sec["search_field"]
        if not field:
            continue
        e = ensure(field)
        paths = sec["search_paths"]
        badges = sec.get("search_badges") or [field] * len(paths)
        e["presence"] += zip(paths, badges)
        if sec["search_keys"]:
            e["prefixes"] += zip(paths, badges)
        elif "search_value_paths" in sec:
            e["paths"] += [(p, field, sec["search_count"]) for p in sec["search_value_paths"]]
        else:
            e["paths"] += [(p, b, sec["search_count"]) for p, b in zip(paths, badges)]

    for extra in cat["search"]["extra_fields"]:
        field = extra["field"]
        e = ensure(field)
        badges = extra.get("badges") or [field] * len(extra["paths"])
        e["paths"] += [(p, b, extra["count"]) for p, b in zip(extra["paths"], badges)]
        # Presence asks about the container, the segment before the first dot,
        # since an entry can exist while the value key is missing.
        if "presence_paths" in extra:
            e["presence"] += [(p, field) for p in extra["presence_paths"]]
        else:
            e["presence"] += [(p.split(".", 1)[0], b) for p, b in zip(extra["paths"], badges)]
        e["plain"] = extra.get("plain_badge")
    return spec

@lru_cache(maxsize=1)
def _plain_plan() -> dict:
    # A plain term reads what the fields read, each path under the badge its
    # field gives it, and the first field in the catalog's order takes a path
    # two fields read. A root no field reads is read whole under "any".
    exact: dict[str, tuple[str, bool]] = {}
    prefixes: dict[str, str] = {}
    for e in _field_spec().values():
        for p, badge, rule in e["paths"]:
            exact.setdefault(p, (e["plain"] or badge, rule == "entries"))
        for root, badge in e["prefixes"]:
            prefixes.setdefault(root, badge)
    excluded = schema.plain_exclude_paths()
    return {
        "exact": exact,
        "prefixes": prefixes,
        "roots": frozenset(p.split(".", 1)[0] for p in exact) | frozenset(prefixes),
        "excluded": excluded,
        "key_excluded": frozenset(schema.load_catalog()["search"]["any_key_exclude_paths"]) | excluded,
    }

@lru_cache(maxsize=4096)
def _plain_path(path: str) -> tuple[str, bool, bool, str | None]:
    """How a plain term reads one stored path: its badge, whether its value is
    read, whether a value counts once instead of per occurrence, and the key
    name it reads, in lower case, where it reads one."""
    plan = _plain_plan()
    root = path.split(".", 1)[0]
    entries = False
    read = True
    if path in plan["exact"]:
        badge, entries = plan["exact"][path]
    elif root in plan["prefixes"]:
        badge = plan["prefixes"][root]
    else:
        # A root some field reads is read only at that field's paths.
        badge = "any"
        read = root not in plan["roots"]
    if path == _SINGLE_IMAGE:
        return badge, False, entries, None
    value_read = read and path not in plan["excluded"]
    if root == _NODES:
        # What the panel shows of a node, its title and its settings.
        value_read = path == _NODE_TITLE or path.startswith(_NODE_PARAMS)
    # A key-searchable root credits the names nested under it, and a root no
    # field reads credits every name.
    key_read = path not in plan["key_excluded"] and (
        "." in path if root in plan["prefixes"] else root not in plan["roots"])
    return badge, value_read, entries, path.rpartition(".")[2].lower() if key_read else None

@lru_cache(maxsize=1)
def _badge_ranks() -> dict[str, int]:
    ranks: dict[str, int] = {}
    for e in _field_spec().values():
        for badge in [b for _p, b in e["presence"]] + [b for _p, b, _r in e["paths"]]:
            ranks.setdefault(badge, len(ranks))
    for name in ("any", "filename", "name"):
        ranks.setdefault(name, len(ranks))
    return ranks

def order_badges(fields: list[dict]) -> list[dict]:
    """One badge per field, counts summed, in the catalog's order of fields
    with node badges after them by name. Both engines answer through this,
    since a card shows only its first badges and a newly arrived file is
    judged by the other engine."""
    merged: dict[str, dict] = {}
    for f in fields:
        prev = merged.get(f["field"])
        if prev is None:
            merged[f["field"]] = dict(f)
        else:
            prev["count"] += f["count"]
    ranks = _badge_ranks()
    return sorted(merged.values(), key=lambda f: (
        (0, ranks[f["field"]], "") if f["field"] in ranks else (1, 0, f["field"].casefold())))

def _name_hits(relpath: str, value: str) -> int:
    # Every stored relpath separates its folders with "/".
    name = relpath.rsplit("/", 1)[-1].lower()
    if value not in name:
        return 0
    return name.count(value) if value else 1

def _bump(hits: dict, key: Any, n: int) -> None:
    if n:
        hits[key] = hits.get(key, 0) + n

def match_item(s: dict | None, relpath: str, tags: list[dict], mode: str) -> list[dict] | None:
    file_matched_fields: list[dict] = []
    tag_checks: list[bool] = []

    for tag in tags:
        field = str(tag.get("field") or "any").lower()
        field = schema.server_alias_map().get(field, field)
        value = str(tag.get("value") or "").lower()
        is_exclude = tag.get("exclude", False)

        if not value and field == "any" and not is_exclude:
            tag_checks.append(True)
            continue

        tag_matched_fields: list[dict] = []

        if field == "name":
            n = _name_hits(relpath, value)
            if n:
                tag_matched_fields = [{"field": "name", "count": n}]
        elif s:
            tag_matched_fields = match_summary(s, field, value, tag.get("node_classes"),
                                               tag.get("key_paths"), tag.get("node_path"))

        if not tag_matched_fields and field == "any" and value and value in relpath.lower():
            tag_matched_fields = [{"field": "filename", "count": relpath.lower().count(value)}]

        if is_exclude:
            tag_checks.append(len(tag_matched_fields) == 0)
        else:
            if tag_matched_fields:
                file_matched_fields.extend(tag_matched_fields)
                tag_checks.append(True)
            else:
                tag_checks.append(False)

    is_match = all(tag_checks) if mode == "AND" else any(tag_checks)
    if not is_match:
        return None
    return order_badges(file_matched_fields)

def _workflow_node_hits(s: dict, value: str, node_classes: list | None,
                        node_path: str | None = None) -> list[tuple[str, int]]:
    wanted = {str(c).lower() for c in node_classes} if node_classes else None
    nodes = s.get(_NODES, [])
    out: list[tuple[str, int]] = []
    if not isinstance(nodes, list):
        return out
    lowered_path = str(node_path or "").lower()
    for node in nodes:
        if not isinstance(node, dict):
            continue
        param_prefix = None
        if wanted is not None:
            ct = str(node.get("class_type") or "").lower()
            ti = str(node.get("title") or "").lower()
            if ct not in wanted and ti not in wanted:
                continue
            if lowered_path:
                # A class name can itself contain dots, so of the listed names
                # this node carries, the longest that starts the path wins and
                # what follows it names a param.
                best = ""
                for c in node_classes or []:
                    cl = str(c).lower()
                    if cl not in (ct, ti) or len(cl) <= len(best):
                        continue
                    if lowered_path == cl or lowered_path.startswith(cl + "."):
                        best = cl
                if not best:
                    continue
                if lowered_path == best:
                    param_prefix = None
                else:
                    param_prefix = lowered_path[len(best) + 1:]
        node_display = node.get("title") or node.get("class_type") or "Node"
        count = 0
        # A tag naming one setting reads that setting's value alone, so the
        # node's name counts only at class scope.
        if value and param_prefix is None and value in node_display.lower():
            count += 1
        params = node.get("params", {})
        if isinstance(params, dict):
            if param_prefix is None:
                for k, v in params.items():
                    sv = str(v).lower()
                    if value in k.lower() or value in sv:
                        count += _count_hits(sv, value)
            else:
                for k, sv in _flat_params(params):
                    if k != param_prefix and not k.startswith(param_prefix + "."):
                        continue
                    if not value or value in sv:
                        count += _count_hits(sv, value)
        # A node carrying no params still counts once for a presence query,
        # while a tag naming a param needs that param to exist.
        if not value and param_prefix is None:
            count = 1
        if count:
            out.append((node_display, count))
    return out

def _flat_params(params: dict, prefix: str = ""):
    for k, v in params.items():
        key = (prefix + "." if prefix else "") + str(k).lower()
        if isinstance(v, dict):
            yield from _flat_params(v, key)
        else:
            yield key, str(v).lower()

def _scoped_hits(s: dict, e: dict, value: str) -> dict[str, int]:
    hits: dict[str, int] = {}
    if not value:
        for container, badge in e["presence"]:
            if any(path == container or path.startswith(container + ".")
                   for path, _o, _v in _rows_under(s, container.split(".", 1)[0])):
                hits[badge] = 1
        return hits
    for p, badge, rule in e["paths"]:
        for path, _o, raw in _rows_under(s, p.split(".", 1)[0]):
            text = str(raw).lower()
            if path == p and value in text:
                _bump(hits, badge, 1 if rule == "entries" else text.count(value))
    for root, badge in e["prefixes"]:
        if root == _SAMPLERS:
            _bump(hits, badge, _sampler_entry_hits(s.get(root), value, frozenset()))
            continue
        for path, _o, raw in _rows_under(s, root):
            text = str(raw).lower()
            if value in text:
                _bump(hits, badge, text.count(value))
            elif value in path.rsplit(".", 1)[-1].lower():
                _bump(hits, badge, 1)
    return hits

def _sampler_entry_hits(entries: Any, value: str, skipped: frozenset[str]) -> int:
    # A sampler entry scores its first key whose name or value holds the term,
    # where the search index scores every key, so the two engines give a
    # Sampling badge different counts.
    n = 0
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        for k, v in entry.items():
            if k in skipped:
                continue
            text = str(v).lower()
            if value in k.lower() or value in text:
                n += _count_hits(text, value)
                break
    return n

def _unread_root_hits(obj: Any, value: str, read_roots: frozenset[str], is_root: bool = False) -> int:
    # A container's printed form holds everything beneath it, so it scores its
    # key name alone and the recursion counts the leaves. The search index
    # stores no container, so there a list's key name scores only through an
    # item whose value misses.
    n = 0
    if isinstance(obj, dict):
        for k, v in obj.items():
            if is_root and (k in read_roots or (k == _SINGLE_IMAGE and _IMAGE_LIST in obj)):
                continue
            if isinstance(v, (dict, list)):
                if value in k.lower():
                    n += 1
            else:
                text = str(v).lower()
                if value in k.lower() or value in text:
                    n += _count_hits(text, value)
            n += _unread_root_hits(v, value, read_roots)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                n += _unread_root_hits(item, value, read_roots)
            elif value in str(item).lower():
                n += _count_hits(str(item).lower(), value)
    return n

def _plain_hits(s: dict, value: str) -> dict[str, int]:
    plan = _plain_plan()
    hits: dict[str, int] = {}
    # A key name counts once for every path it names, and only through a row
    # whose value does not hold the term.
    keyed: dict[str, set[str]] = {}
    for root, sub in s.items():
        if root == _NODES or root not in plan["roots"]:
            continue
        for path, _o, raw in summary_rows(sub, root, 0, 1):
            if root == _SAMPLERS and path not in plan["exact"]:
                continue
            badge, value_read, entries, key_name = _plain_path(path)
            text = str(raw).lower()
            if value in text:
                if value_read:
                    _bump(hits, badge, 1 if entries else text.count(value))
            elif key_name is not None and value in key_name:
                keyed.setdefault(badge, set()).add(path)
    for badge, paths in keyed.items():
        _bump(hits, badge, len(paths))
    # A sampler key another field reads, the sampler name, scores under that
    # field alone.
    _bump(hits, plan["prefixes"][_SAMPLERS], _sampler_entry_hits(
        s.get(_SAMPLERS), value,
        frozenset(p.split(".", 1)[1] for p in plan["exact"] if p.startswith(_SAMPLERS + "."))))
    _bump(hits, "any", _unread_root_hits(s, value, plan["roots"], True))

    # A node setting holding the negative prompt is skipped, as the plain term
    # skips the negative prompt in the summary.
    negatives = [str(raw).lower() for path, _o, raw in _rows_under(s, _NEGATIVE) if path == _NEGATIVE]
    nodes = s.get(_NODES)
    for i, node in enumerate(nodes if isinstance(nodes, list) else []):
        if not isinstance(node, dict):
            continue
        n = 0
        title_hit = False
        keyed_paths: set[str] = set()
        for path, _o, raw in summary_rows(node, _NODES, i, 2):
            _badge, value_read, entries, key_name = _plain_path(path)
            text = str(raw).lower()
            if value not in text:
                if key_name is not None and value in key_name:
                    keyed_paths.add(path)
            elif not value_read:
                continue
            elif path == _NODE_TITLE:
                title_hit = True
            elif not any(_is_negative_text(text, neg) for neg in negatives):
                n += 1 if entries else text.count(value)
        n += title_hit + len(keyed_paths)
        _bump(hits, str(node.get("title") or node.get("class_type") or "Node"), n)
    return hits

def _key_hits(obj: Any, field: str, value: str) -> int:
    # A matching key's whole value is read once, so a key nested under one of
    # its own name is not counted twice.
    n = 0
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() == field:
                text = str(v).lower()
                if value in text:
                    n += _count_hits(text, value)
            else:
                n += _key_hits(v, field, value)
    elif isinstance(obj, list):
        for item in obj:
            n += _key_hits(item, field, value)
    return n

def match_summary(s: dict, field: str, value: str, node_classes: list | None = None,
                  key_paths: list | None = None, node_path: str | None = None) -> list[dict]:
    if key_paths:
        count = 0
        for p in map(str, key_paths):
            for path, _o, raw in _rows_under(s, p.split(".", 1)[0]):
                if (path == p or path.startswith(p + ".")) and value in str(raw).lower():
                    count += 1
        if node_classes:
            count += sum(n for _d, n in _workflow_node_hits(s, value, node_classes, node_path))
        return [{"field": field, "count": count if value else 1}] if count else []

    spec = _field_spec()
    hits: dict[str, int] = {}
    if field == "any":
        hits = _plain_hits(s, value)
    elif field == _NODES:
        for display, n in _workflow_node_hits(s, value, node_classes, node_path):
            _bump(hits, display, n)
    elif field in spec:
        hits = _scoped_hits(s, spec[field], value)
    else:
        # A field no search reads names a workflow node by its class or its
        # title, and failing that a key of that name.
        for display, n in _workflow_node_hits(s, value, [field]):
            _bump(hits, display, n)
        if not hits:
            _bump(hits, field, _key_hits(s, field.lower(), value))
    return [{"field": f, "count": n if value else 1} for f, n in hits.items()]

def _add_hit(hits: dict, fid: int, badge: str, n: int) -> None:
    if not n:
        return
    per_file = hits.setdefault(fid, {})
    per_file[badge] = per_file.get(badge, 0) + n

def _occurrences(col: str) -> str:
    return f"(length({col}) - length(replace({col}, :v, ''))) / length(:v)"

def _root_ids(conn, root_id: str) -> set[int]:
    # A fact's file_id is the media_files rowid. Hidden rows keep their facts,
    # so hiding a file or bringing it back needs no rebuild of the search
    # index, and they are dropped here instead, where a fact becomes a result.
    return {fid for (fid,) in conn.execute(
        "SELECT rowid FROM media_files WHERE root_id = ? AND missing_since IS NULL", (root_id,))}

def _root_files(conn, root_id: str) -> dict[int, str]:
    return dict(conn.execute(
        "SELECT rowid, relpath FROM media_files "
        "WHERE root_id = ? AND missing_since IS NULL", (root_id,)))

def _files_by_id(conn, ids) -> dict[int, str]:
    _id_table(conn, "_files", ids)
    return dict(conn.execute(
        "SELECT m.rowid, m.relpath FROM _files t CROSS JOIN media_files m ON m.rowid = t.id"))

def _hits_for_paths(conn, path_rows: list, value: str, hits: dict) -> None:
    # A long value, and every value under a prose root, sits in prose instead
    # of facts, so each query here and below reads both tables.
    for path_id, badge, rule in path_rows:
        fact_n = "1" if rule == "entries" else _occurrences("v.text")
        prose_n = "1" if rule == "entries" else _occurrences("body")
        for q in (f"SELECT f.file_id, SUM({fact_n}) FROM facts f JOIN vals v ON v.val_id = f.val_id "
                  "WHERE f.path_id = :p AND instr(v.text, :v) > 0 GROUP BY f.file_id",
                  f"SELECT file_id, SUM({prose_n}) FROM prose "
                  "WHERE path_id = :p AND instr(body, :v) > 0 GROUP BY file_id"):
            for fid, n in conn.execute(q, {"p": path_id, "v": value}):
                _add_hit(hits, fid, badge, int(n or 0))

def _fill_scoped(conn, roots) -> bool:
    pids = {pid for r in roots for pid, _path in _paths_by_prefix(conn, str(r))}
    _id_table(conn, "_scoped", pids)
    return bool(pids)

def _files_in_scoped(conn) -> set[int]:
    fids = {fid for (fid,) in conn.execute(
        "SELECT DISTINCT f.file_id FROM _scoped t CROSS JOIN facts f ON f.path_id = t.id")}
    fids.update(fid for (fid,) in conn.execute(
        "SELECT DISTINCT p.file_id FROM _scoped t "
        "CROSS JOIN prose p INDEXED BY idx_prose_p ON p.path_id = t.id"))
    return fids

def _path_scoped_hits(conn, field: str, value: str, key_paths: list) -> dict:
    hits: dict[int, dict[str, int]] = {}
    if not _fill_scoped(conn, key_paths):
        return hits
    if not value:
        return {fid: {field: 1} for fid in _files_in_scoped(conn)}
    fact_q = ("SELECT f.file_id, COUNT(*) FROM _scoped t "
              "CROSS JOIN facts f ON f.path_id = t.id "
              "JOIN vals v ON v.val_id = f.val_id "
              "WHERE instr(v.text, ?) > 0 GROUP BY f.file_id")
    prose_q = ("SELECT p.file_id, COUNT(*) FROM _scoped t "
               "CROSS JOIN prose p INDEXED BY idx_prose_p ON p.path_id = t.id "
               "WHERE instr(p.body, ?) > 0 GROUP BY p.file_id")
    for q in (fact_q, prose_q):
        for fid, n in conn.execute(q, (value,)):
            _add_hit(hits, fid, field, int(n or 0))
    return hits

def _entry_hits_for_prefix(conn, path_ids: list, key_matched: list, value: str,
                           badge: str, hits: dict) -> None:
    if not path_ids:
        return
    _id_table(conn, "_prefix", path_ids)
    if key_matched:
        _id_table(conn, "_keyed", key_matched)
        keyed = "f.path_id IN (SELECT id FROM _keyed)"
        fact_q = ("SELECT f.file_id, "
                  "SUM(CASE WHEN instr(v.text, :v) > 0 THEN " + _occurrences("v.text") + " ELSE 0 END), "
                  "SUM(CASE WHEN instr(v.text, :v) = 0 AND " + keyed + " THEN 1 ELSE 0 END) "
                  "FROM _prefix t CROSS JOIN facts f ON f.path_id = t.id "
                  "JOIN vals v ON v.val_id = f.val_id "
                  "WHERE instr(v.text, :v) > 0 OR " + keyed + " "
                  "GROUP BY f.file_id")
        prose_keyed = keyed.replace("f.path_id", "p.path_id")
        prose_q = ("SELECT p.file_id, "
                   "SUM(CASE WHEN instr(p.body, :v) > 0 THEN " + _occurrences("p.body") + " ELSE 0 END), "
                   "SUM(CASE WHEN instr(p.body, :v) = 0 AND " + prose_keyed + " THEN 1 ELSE 0 END) "
                   "FROM _prefix t CROSS JOIN prose p INDEXED BY idx_prose_p ON p.path_id = t.id "
                   "WHERE instr(p.body, :v) > 0 OR " + prose_keyed + " "
                   "GROUP BY p.file_id")
    else:
        fact_q = ("SELECT f.file_id, SUM(" + _occurrences("v.text") + "), 0 "
                  "FROM _prefix t CROSS JOIN facts f ON f.path_id = t.id "
                  "JOIN vals v ON v.val_id = f.val_id "
                  "WHERE instr(v.text, :v) > 0 GROUP BY f.file_id")
        prose_q = ("SELECT p.file_id, SUM(" + _occurrences("p.body") + "), 0 "
                   "FROM _prefix t CROSS JOIN prose p INDEXED BY idx_prose_p ON p.path_id = t.id "
                   "WHERE instr(p.body, :v) > 0 GROUP BY p.file_id")
    for q in (fact_q, prose_q):
        for fid, occ, keyed_n in conn.execute(q, {"v": value}):
            _add_hit(hits, fid, badge, int(occ or 0) + int(keyed_n or 0))

def _id_table(conn, name: str, ids) -> None:
    # A statement holds a bounded number of bound values, so an id list of any
    # length goes through a temp table. The table has no statistics, so a query
    # names it first in a CROSS JOIN and pins prose to its path index, or the
    # planner may walk the whole of facts or prose. A later call refills the
    # same name, so a query reading it is read to the end before the next call.
    conn.execute(f"CREATE TEMP TABLE IF NOT EXISTS {name}(id INTEGER PRIMARY KEY)")
    conn.execute(f"DELETE FROM {name}")
    conn.executemany(f"INSERT OR IGNORE INTO {name} VALUES (?)", ((i,) for i in ids))

def _paths_by_prefix(conn, root: str) -> list[tuple[int, str]]:
    # A range instead of LIKE, which ignores letter case where `match_item`
    # matches a key exactly. "/" sorts right after ".", so the range holds
    # every path below the root and nothing else, with nothing to escape.
    return list(conn.execute(
        "SELECT path_id, path FROM paths WHERE path = ? OR (path >= ? AND path < ?)",
        (root, root + ".", root + "/")))

def search_indexed_supported(tags: list[dict]) -> bool:
    # A tag the index cannot answer sends the whole search to match_item over
    # the stored summaries.
    spec = _field_spec()
    for tag in tags:
        field = str(tag.get("field") or "any").lower()
        field = schema.server_alias_map().get(field, field)
        if tag.get("node_classes") or tag.get("node_path"):
            return False
        if tag.get("key_paths"):
            continue
        if field in ("any", "name"):
            continue
        if field == _NODES:
            return False
        if field not in spec or (not spec[field]["paths"] and not spec[field]["prefixes"]):
            return False
    return True

def _tag_hits_indexed(conn, tag: dict, files: dict | None) -> dict:
    spec = _field_spec()
    field = str(tag.get("field") or "any").lower()
    field = schema.server_alias_map().get(field, field)
    value = str(tag.get("value") or "").lower()
    hits: dict[int, dict[str, int]] = {}

    if field == "name":
        for fid, rel in (files or {}).items():
            n = _name_hits(rel, value)
            if n:
                hits[fid] = {"name": n}
        return hits

    if tag.get("key_paths"):
        return _path_scoped_hits(conn, field, value, tag["key_paths"])

    if field == "any":
        return _any_hits_indexed(conn, value, files or {})

    e = spec[field]
    if not value:
        containers: dict[str, list[str]] = {}
        for container, badge in e["presence"]:
            containers.setdefault(badge, []).append(container)
        for badge, roots in containers.items():
            if _fill_scoped(conn, roots):
                for fid in _files_in_scoped(conn):
                    hits.setdefault(fid, {})[badge] = 1
        return hits

    path_rows = []
    for p, badge, rule in e["paths"]:
        row = conn.execute("SELECT path_id FROM paths WHERE path = ?", (p,)).fetchone()
        if row:
            path_rows.append((row[0], badge, rule))
    _hits_for_paths(conn, path_rows, value, hits)

    for root, badge in e["prefixes"]:
        rows = _paths_by_prefix(conn, root)
        keyed = [pid for pid, path in rows if value in path.rsplit(".", 1)[-1].lower()]
        _entry_hits_for_prefix(conn, [pid for pid, _ in rows], keyed, value, badge, hits)
    return hits

def _any_hits_indexed(conn, value: str, files: dict) -> dict:
    hits: dict[int, dict[str, int]] = {}
    if not value:
        return hits
    paths = list(conn.execute("SELECT path_id, path FROM paths"))
    rows, key_pids, wf_key_pids = [], [], []
    for pid, path in paths:
        badge, value_read, entries, key_name = _plain_path(path)
        wf = path.split(".", 1)[0] == _NODES
        rows.append((pid, badge, wf, value_read, path == _NODE_TITLE,
                     path.startswith(_NODE_PARAMS), entries))
        if key_name is not None and value in key_name:
            (wf_key_pids if wf else key_pids).append(pid)
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS _badges"
                 "(path_id INTEGER PRIMARY KEY, badge TEXT, wf INTEGER, value_ok INTEGER,"
                 " title INTEGER, par INTEGER, ent INTEGER)")
    conn.execute("DELETE FROM _badges")
    conn.executemany("INSERT INTO _badges VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    wf_nodes: dict[tuple[int, int], int] = {}

    conn.execute("CREATE TEMP TABLE IF NOT EXISTS _mv(val_id INTEGER PRIMARY KEY)")
    conn.execute("DELETE FROM _mv")
    # The matching values are gathered first and the join below is pinned to
    # start from them, since the planner holds no statistics for them and
    # would otherwise read every value again.
    conn.execute("INSERT INTO _mv SELECT val_id FROM vals WHERE instr(text, ?) > 0",
                 (value,))

    # A node setting holding the file's negative prompt is left out, as
    # `match_item` leaves it out. SQL calls the matcher's own function, so the
    # two cannot fold letter case or trim space differently.
    conn.create_function("sbg_is_negative", 2, _is_negative_text, deterministic=True)
    neg_pid = next((pid for pid, path in paths if path == _NEGATIVE), -1)
    neg_fact = ("EXISTS (SELECT 1 FROM facts n JOIN vals nv ON nv.val_id = n.val_id "
                "WHERE n.file_id = {f} AND n.path_id = :neg AND sbg_is_negative({t}, nv.text)) "
                "OR EXISTS (SELECT 1 FROM prose n WHERE n.file_id = {f} AND n.path_id = :neg "
                "AND sbg_is_negative({t}, n.body))")
    args = {"v": value, "neg": neg_pid}

    q = ("SELECT f.file_id, b.wf, b.badge, f.ord, "
         "SUM(CASE WHEN b.title = 1 THEN 0 WHEN b.ent = 1 THEN 1 ELSE "
         + _occurrences("v.text") + " END), MAX(b.title) "
         "FROM _mv m CROSS JOIN vals v ON v.val_id = m.val_id "
         "CROSS JOIN facts f ON f.val_id = m.val_id "
         "CROSS JOIN _badges b ON b.path_id = f.path_id "
         "WHERE b.value_ok = 1 AND NOT (b.par = 1 AND ("
         + neg_fact.format(f="f.file_id", t="v.text") + ")) "
         "GROUP BY f.file_id, b.wf, b.badge, f.ord")
    for fid, wf, b, o, occ, t_hit in conn.execute(q, args):
        n = int(occ or 0) + (1 if t_hit else 0)
        if wf:
            _bump(wf_nodes, (fid, o), n)
        else:
            _add_hit(hits, fid, b, n)

    q = ("SELECT p.file_id, b.wf, b.badge, p.ord, "
         "CASE WHEN b.title = 1 OR b.ent = 1 THEN 1 ELSE " + _occurrences("p.body") + " END "
         "FROM prose p JOIN _badges b ON b.path_id = p.path_id "
         "WHERE b.value_ok = 1 AND instr(p.body, :v) > 0 AND NOT (b.par = 1 AND ("
         + neg_fact.format(f="p.file_id", t="p.body") + "))")
    for fid, wf, b, o, n in conn.execute(q, args):
        if wf:
            _bump(wf_nodes, (fid, o), int(n))
        else:
            _add_hit(hits, fid, b, int(n))

    # A key name counts once per file for every path it names, wherever the
    # path's rows are stored, and only through a row whose value missed.
    keyed_rows = ("SELECT f.file_id, f.ord, f.path_id FROM _keyed t "
                  "CROSS JOIN facts f ON f.path_id = t.id "
                  "WHERE f.val_id NOT IN (SELECT val_id FROM _mv) "
                  "UNION ALL SELECT p.file_id, p.ord, p.path_id FROM _keyed t "
                  "CROSS JOIN prose p INDEXED BY idx_prose_p ON p.path_id = t.id "
                  "WHERE instr(p.body, :v) = 0")
    if key_pids:
        _id_table(conn, "_keyed", key_pids)
        q = ("SELECT k.file_id, b.badge, COUNT(DISTINCT k.path_id) FROM (" + keyed_rows + ") k "
             "JOIN _badges b ON b.path_id = k.path_id GROUP BY k.file_id, b.badge")
        for fid, b, n in conn.execute(q, args):
            _add_hit(hits, fid, b, int(n))
    if wf_key_pids:
        _id_table(conn, "_keyed", wf_key_pids)
        q = ("SELECT k.file_id, k.ord, COUNT(DISTINCT k.path_id) FROM (" + keyed_rows + ") k "
             "GROUP BY k.file_id, k.ord")
        for fid, o, n in conn.execute(q, args):
            _bump(wf_nodes, (fid, o), int(n))

    single = next((pid for pid, path in paths if path == _SINGLE_IMAGE), None)
    if single is not None:
        badge = _plain_path(_SINGLE_IMAGE)[0]
        no_list = "f.file_id NOT IN (SELECT file_id FROM facts WHERE path_id = :list)"
        args = {"v": value, "single": single,
                "list": next((pid for pid, path in paths if path == _IMAGE_LIST), -1)}
        q = ("SELECT f.file_id, SUM(" + _occurrences("v.text") + ") "
             "FROM facts f JOIN vals v ON v.val_id = f.val_id "
             "WHERE f.path_id = :single AND f.val_id IN (SELECT val_id FROM _mv) "
             "AND " + no_list + " GROUP BY f.file_id")
        for fid, n in conn.execute(q, args):
            _add_hit(hits, fid, badge, int(n or 0))
        if value in _SINGLE_IMAGE:
            q = ("SELECT f.file_id FROM facts f WHERE f.path_id = :single "
                 "AND f.val_id NOT IN (SELECT val_id FROM _mv) AND " + no_list)
            for (fid,) in conn.execute(q, args):
                _add_hit(hits, fid, badge, 1)

    wf_nodes = {k: n for k, n in wf_nodes.items() if n and k[0] in files}
    if wf_nodes:
        for fid, display, n in _resolve_node_displays(conn, wf_nodes):
            _add_hit(hits, fid, display, n)

    for fid, rel in files.items():
        if fid not in hits and value in rel.lower():
            hits[fid] = {"filename": rel.lower().count(value)}
    return hits

def _resolve_node_displays(conn, wf_nodes: dict) -> list[tuple[int, str, int]]:
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS _nodes"
                 "(file_id INTEGER, ord INTEGER, PRIMARY KEY (file_id, ord)) WITHOUT ROWID")
    conn.execute("DELETE FROM _nodes")
    conn.executemany("INSERT INTO _nodes VALUES (?, ?)", wf_nodes)
    display = {(fid, o): disp for fid, o, disp in conn.execute(
        "SELECT t.file_id, t.ord, n.display FROM _nodes t "
        "CROSS JOIN node_names n ON n.file_id = t.file_id AND n.ord = t.ord")}
    return [(fid, display.get((fid, o), "Node"), n) for (fid, o), n in wf_nodes.items()]

def _reads_names(tag: dict) -> bool:
    field = str(tag.get("field") or "any").lower()
    field = schema.server_alias_map().get(field, field)
    if field == "name":
        return True
    return field == "any" and bool(str(tag.get("value") or "")) and not tag.get("key_paths")

def _bindable(v: Any) -> Any:
    if isinstance(v, str):
        return storable(v)
    if isinstance(v, list):
        return [storable(x) if isinstance(x, str) else x for x in v]
    return v

def search_indexed(conn, root_id: str, tags: list[dict], mode: str) -> list[dict]:
    tags = [{k: _bindable(v) for k, v in t.items()} for t in tags]
    files = _root_files(conn, root_id) if any(map(_reads_names, tags)) else None
    universe = set(files) if files is not None else _root_ids(conn, root_id)
    per_tag, excludes = [], []
    empty_any_pass = 0
    for tag in tags:
        field = str(tag.get("field") or "any").lower()
        value = str(tag.get("value") or "").lower()
        if not value and field == "any" and not tag.get("exclude"):
            empty_any_pass += 1
            continue
        h = _tag_hits_indexed(conn, tag, files)
        (excludes if tag.get("exclude") else per_tag).append(h)

    checks = [set(h) for h in per_tag] + [universe - set(h) for h in excludes]
    # A tag with no field and no value matches every file, which in OR mode
    # means the whole root and in AND mode constrains nothing.
    if empty_any_pass and mode != "AND":
        checks.append(universe)
    if not checks:
        selected = universe
    elif mode == "AND":
        selected = set.intersection(*checks)
    else:
        selected = set.union(*checks)
    # The fact queries span every root, so the result is confined to this one.
    selected &= universe
    if files is None:
        files = _files_by_id(conn, selected)

    return [{"relpath": files[fid],
             "matched_fields": order_badges([{"field": b, "count": n}
                                             for h in per_tag for b, n in h.get(fid, {}).items()])}
            for fid in selected]
