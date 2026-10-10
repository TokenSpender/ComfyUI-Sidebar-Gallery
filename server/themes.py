"""Theme files, written only here. A request names a theme by its id, the one
inside its file whenever the file holds one it can use, and an edit names the
colours it sets and clears, so it leaves every field and colour it did not name
as the file holds it. A restore is the one write that replaces a theme's whole
colour map.

Every function that reads or writes the folder runs while the routes hold the
presets lock, except ensure_ids, which runs at start before any request. That
lock is what keeps the two maps below consistent with the files.
"""
from __future__ import annotations

import logging
import re
import secrets
import time
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING

from .config import os_reason, read_json_file, write_json_atomic
from .presets import THEME_FILE_SUFFIX, file_stem, listed_filename, move_conflict, sanitize_name

# TypeGuard arrived in Python 3.10 and the extension also runs on 3.9, so only
# the type checker imports it.
if TYPE_CHECKING:
    from typing import TypeGuard

logger = logging.getLogger("sbg")

THEME_FILE_KIND = "sbg-theme"
# A file holding a higher version is changed and copied like any other, since a
# later version only adds to what a theme file stores and never reshapes it.
THEME_FILE_VERSION = 2
IDENTITY_FIELDS = ("id", "origin")

_ID = re.compile(r"[0-9a-f]{16}")
_KEY_MAX = 128
_VALUE_MAX = 256
_COUNTS_KEPT = 1024

# The id each file answered to when last listed or written, keyed by file name.
# It is the id a file is known by when its own cannot be used: it holds none,
# holds one another file kept, could not be written, or has turned unreadable,
# so a theme whose file is damaged while the server runs keeps its id and is
# told apart from one that is gone. A readable file's own id wins over it, and
# a restart forgets it.
_held_ids: dict[str, str] = {}
# The highest change count taken from each tab for each theme, so a change that
# arrives after a newer one from the same tab is not applied over it.
_last_counts: dict[tuple[str, str], int] = {}

NOT_FOUND = "the theme is no longer there"
DAMAGED = "the theme file is damaged"
EXISTS = "a theme with that name exists"
NO_FREE_NAME = "no free name for the theme fits its folder"
_NAMES_TRIED = 1000
# The tail a new theme's name takes when the server picks it: none for a theme
# of its own, and " (copy)" for a copy of another theme.
TAILS = {"unique": "", "fork": " (copy)"}


def new_theme_id(taken=()) -> str:
    while True:
        fresh = secrets.token_hex(8)
        if fresh not in taken:
            return fresh


def valid_theme_id(value) -> TypeGuard[str]:
    return isinstance(value, str) and bool(_ID.fullmatch(value))


def _doc_of(path: Path) -> dict | None:
    try:
        doc = read_json_file(path)
    except Exception:
        return None
    return doc if isinstance(doc, dict) else None


def _read_all(dirpath: Path) -> list[tuple[Path, dict | None]]:
    return [(path, _doc_of(path)) for path in sorted(dirpath.glob(f"*{THEME_FILE_SUFFIX}"))]


def _not_found(dirpath: Path, body: dict) -> tuple[int, dict]:
    """The answer for an id no file answers to. The page names the file it last
    knew the theme by, and a file there that cannot be read is the theme, still
    there, as after a restart forgets the id a damaged file answered to. The
    name chooses only this answer and never which file is written."""
    name = listed_filename(body.get("filename"), THEME_FILE_SUFFIX)
    path = dirpath / name if name else None
    if path is not None and path.is_file() and _doc_of(path) is None:
        return 500, {"error": DAMAGED}
    return 404, {"error": NOT_FOUND}


def _assign(files: list[tuple[Path, dict | None]]) -> dict[Path, str]:
    """The id each file answers to. A valid id in a file is its own, and of two
    files holding one, the older `created` keeps it, ties going to the file
    name. Every other file answers to a held id."""
    def age(item):
        created = item[1].get("created") if item[1] else None
        ok = isinstance(created, (int, float)) and not isinstance(created, bool)
        return (created if ok else float("inf"), item[0].name)

    names = {p.name for p, _ in files}
    for gone in [n for n in _held_ids if n not in names]:
        del _held_ids[gone]
    ids: dict[Path, str] = {}
    taken: set[str] = set()
    for path, doc in sorted(files, key=age):
        own = doc.get("id") if doc else None
        if valid_theme_id(own) and own not in taken:
            ids[path] = own
            taken.add(own)
            _held_ids[path.name] = own
    for path, _ in files:
        if path in ids:
            continue
        held = _held_ids.get(path.name)
        if not held or held in taken:
            held = new_theme_id(taken)
            _held_ids[path.name] = held
        ids[path] = held
        taken.add(held)
    return ids


def ensure_ids(dirpath: Path) -> list[str]:
    """Writes its id into every readable file that answers to a held one, at
    start. Answers the names written. A file that cannot be written keeps its
    held id for as long as the server runs, and is logged."""
    files = _read_all(dirpath)
    ids = _assign(files)
    given = []
    for path, doc in files:
        if doc is None or doc.get("id") == ids[path]:
            continue
        # One file must not stop the start, or the gallery fails to load.
        try:
            write_json_atomic(path, {**doc, "id": ids[path]})
        except Exception as e:
            logger.warning("SBG: %s keeps its id only until the server restarts, since its file could not be written: %s", path.name, e)
            continue
        given.append(path.name)
    return given


def listing(dirpath: Path) -> list[dict]:
    files = _read_all(dirpath)
    ids = _assign(files)
    return [{"id": ids[p], "filename": p.name, "doc": doc, "readable": doc is not None} for p, doc in files]


def find(dirpath: Path, tid) -> tuple[Path, dict | None] | None:
    if not valid_theme_id(tid):
        return None
    files = _read_all(dirpath)
    ids = _assign(files)
    for path, doc in files:
        if ids[path] == tid:
            return path, doc
    return None


def entry(path: Path, tid: str, doc: dict) -> dict:
    return {"ok": True, "id": tid, "filename": path.name, "doc": {**doc, "id": tid}}


def write_doc(path: Path, doc: dict, tid: str) -> None:
    write_json_atomic(path, {**doc, "id": tid})
    _held_ids[path.name] = tid


def _clean_change(body: dict) -> tuple[dict, list] | None:
    set_ = body.get("set", {})
    clear = body.get("clear", [])
    if not isinstance(set_, dict) or not isinstance(clear, list):
        return None
    if not all(_fits(k, _KEY_MAX) and _fits(v, _VALUE_MAX) for k, v in set_.items()):
        return None
    if not all(_fits(k, _KEY_MAX) for k in clear):
        return None
    return set_, clear


def _fits(text, most: int) -> bool:
    return isinstance(text, str) and 0 < len(text) <= most


def fits_key(text) -> bool:
    return _fits(text, _KEY_MAX)


def fits_value(text) -> bool:
    return _fits(text, _VALUE_MAX)


def change(dirpath: Path, body: dict) -> tuple[int, dict]:
    """A change whose count is not above the last one taken from its tab for
    this theme is not applied, and the answer then carries the colours as they
    are."""
    parsed = _clean_change(body)
    if parsed is None:
        return 400, {"error": "the change isn't one this version reads"}
    set_, clear = parsed
    tab = body.get("tab")
    count = body.get("count")
    if not (isinstance(tab, str) and 0 < len(tab) <= 64 and isinstance(count, int) and not isinstance(count, bool)):
        return 400, {"error": "the change carries no count"}
    hit = find(dirpath, body.get("id"))
    if hit is None:
        return _not_found(dirpath, body)
    path, doc = hit
    if doc is None:
        return 500, {"error": DAMAGED}
    tid = body["id"]
    if count <= _last_counts.get((tab, tid), -1):
        return 200, {**entry(path, tid, doc), "stale": True}
    held = doc.get("values")
    values = {k: v for k, v in held.items() if k not in clear} if isinstance(held, dict) else {}
    values.update(set_)
    out = {**doc, "values": values}
    try:
        write_doc(path, out, tid)
    except OSError as e:
        return 500, {"error": os_reason(e)}
    # Kept in the order last used, and the oldest let go past the cap, since
    # every page load is a tab of its own. A tab whose count is let go has
    # been idle the longest, and only a change it sent before its newest one
    # could then land.
    _last_counts.pop((tab, tid), None)
    _last_counts[(tab, tid)] = count
    while len(_last_counts) > _COUNTS_KEPT:
        del _last_counts[next(iter(_last_counts))]
    return 200, entry(path, tid, out)


def _new_doc(name: str, values: dict, extra: dict | None = None) -> dict:
    doc = {"kind": THEME_FILE_KIND, "version": THEME_FILE_VERSION, "name": name,
           "created": int(time.time() * 1000), "values": values}
    if extra:
        doc.update(extra)
    return doc


def _place(dirpath: Path, name: str) -> Path:
    return dirpath / f"{file_stem(name, dirpath, THEME_FILE_SUFFIX)}{THEME_FILE_SUFFIX}"


def _tries(dirpath: Path, base: str, tail: str, most: int) -> Iterator[tuple[str, Path]]:
    """Each name built from `base` and `tail`, then the same with a number,
    cut to `most` characters, with the file it lands on. A long file name is
    cut to what the OS takes, which would drop what was added and land every
    try on one file, so the base gives way until the file name keeps it. The
    tries end where a name would be cut to what was added alone."""
    for n in range(1, _NAMES_TRIED + 1):
        # The number goes inside the tail's brackets, or in brackets of its own,
        # as a preset's does.
        end = tail if n == 1 else f"{tail[:-1]} {n})" if tail else f" ({n})"
        keep = sanitize_name(end)
        room = most
        name = _fit(base, end, room)
        target = _place(dirpath, name)
        while keep and not target.stem.endswith(keep):
            if room <= len(end) + 1:
                return
            room -= 1
            name = _fit(base, end, room)
            target = _place(dirpath, name)
        yield name, target


def _free_name(dirpath: Path, base: str, tail: str, most: int) -> tuple[str, Path] | None:
    return next(((name, target) for name, target in _tries(dirpath, base, tail, most) if not target.exists()), None)


def _tail(body: dict) -> str | None:
    fit = body.get("fit")
    return TAILS.get(fit) if isinstance(fit, str) else None


def create(dirpath: Path, name: str, body: dict, most: int) -> tuple[int, dict]:
    """A new theme from the colours the page sends, or from a theme file being
    imported (`doc`), whose fields it keeps apart from what says which theme it
    is on another install. The id an imported file brings is kept when no theme
    here holds it, so a preset shared with that theme still finds it. The name
    is fitted as `plan_create` fits it."""
    tail = _tail(body)
    if tail is None:
        return 400, {"error": "the request isn't one this version reads"}
    raw = body.get("doc")
    if raw is None:
        values = body.get("values")
        if not isinstance(values, dict) or not all(_fits(k, _KEY_MAX) and _fits(v, _VALUE_MAX) for k, v in values.items()):
            return 400, {"error": "the theme data is missing"}
        plan = plan_create(dirpath, name, values, body.get("origin"), tail, most)
    else:
        if not isinstance(raw, dict) or not isinstance(raw.get("values", {}), dict):
            return 400, {"error": "the theme data is missing"}
        doc = {k: v for k, v in raw.items() if k not in IDENTITY_FIELDS}
        doc.setdefault("kind", THEME_FILE_KIND)
        doc.setdefault("created", int(time.time() * 1000))
        plan = _plan_name(dirpath, name, doc.get("values"), tail, most)
        if "path" in plan:
            held = {e["id"] for e in listing(dirpath)}
            brought = raw.get("id")
            doc["name"] = plan["name"]
            plan.update(doc=doc, tid=brought if valid_theme_id(brought) and brought not in held else new_theme_id(held))
    if "existing" in plan:
        return 200, plan["existing"]
    if "refused" in plan:
        return 409, {"error": plan["refused"]}
    try:
        write_doc(plan["path"], plan["doc"], plan["tid"])
    except OSError as e:
        return 500, {"error": os_reason(e)}
    return 200, entry(plan["path"], plan["tid"], plan["doc"])


def _fit(base: str, end: str, most: int) -> str:
    return "".join(list(base)[:max(0, most - len(end))]).rstrip() + end


def _plan_name(dirpath: Path, base: str, values, tail: str, most: int) -> dict:
    """Where a new theme of `values` goes: the first name built from `base` and
    `tail`, then the same with a number, whose file is free, cut to `most`
    characters. When the first name's file already holds a theme of that name
    and those values, as when the same theme is made or imported again, the
    answer is that theme instead. `refused` answers why no name could be found."""
    first = next(_tries(dirpath, base, tail, most), None)
    if first is None:
        return {"refused": NO_FREE_NAME}
    name, path = first
    if path.exists():
        existing = _holding(dirpath, path, name, values)
        if existing:
            return {"existing": existing}
    free = _free_name(dirpath, base, tail, most)
    if free is None:
        return {"refused": NO_FREE_NAME}
    return {"name": free[0], "path": free[1]}


def plan_create(dirpath: Path, base: str, values: dict, origin, tail: str, most: int) -> dict:
    """A new theme of `values` named as `_plan_name` names it, with its file,
    document and id, worked out without writing."""
    plan = _plan_name(dirpath, base, values, tail, most)
    if "path" in plan:
        plan["doc"] = _new_doc(plan["name"], dict(values), {"origin": origin} if isinstance(origin, str) and origin else None)
        plan["tid"] = new_theme_id({e["id"] for e in listing(dirpath)})
    return plan


def plan_edit(dirpath: Path, tid, set_: dict, clear: list) -> dict:
    """An edit of a user theme's values, worked out without writing: the file,
    its document after the edit, and what each named value held before. A theme
    that cannot take it answers `refused` with why."""
    hit = find(dirpath, tid)
    if hit is None:
        return {"refused": "missing"}
    path, doc = hit
    if doc is None:
        return {"refused": "damaged"}
    held = doc.get("values")
    if not isinstance(held, dict):
        held = {}
    values = {k: v for k, v in held.items() if k not in clear}
    values.update(set_)
    prior = {k: held.get(k) for k in [*set_, *clear]}
    changed = [k for k in prior if values.get(k) != prior[k]]
    return {"path": path, "doc": {**doc, "values": values}, "before": doc, "tid": tid, "prior": prior,
            "changed": changed, "name": str(doc.get("name") or "")}


def _holding(dirpath: Path, target: Path, name: str, values) -> dict | None:
    for e in listing(dirpath):
        if e["filename"] == target.name and e["doc"] and e["doc"].get("name") == name and e["doc"].get("values") == values:
            return entry(target, e["id"], e["doc"])
    return None


def copy(dirpath: Path, name: str, body: dict, most: int) -> tuple[int, dict]:
    """A new theme holding every colour of another, known to this version or
    not, and none of its identity, named as `fit` asks."""
    tail = _tail(body)
    if tail is None:
        return 400, {"error": "the request isn't one this version reads"}
    hit = find(dirpath, body.get("id"))
    if hit is None:
        return _not_found(dirpath, body)
    _, src = hit
    if src is None:
        return 500, {"error": DAMAGED}
    free = _free_name(dirpath, name, tail, most)
    if free is None:
        return 409, {"error": NO_FREE_NAME}
    name, target = free
    doc = {k: v for k, v in src.items() if k not in IDENTITY_FIELDS}
    doc.update({"name": name, "created": int(time.time() * 1000)})
    tid = new_theme_id({e["id"] for e in listing(dirpath)})
    try:
        write_doc(target, doc, tid)
    except OSError as e:
        return 500, {"error": os_reason(e)}
    return 200, entry(target, tid, doc)


def rename(dirpath: Path, name: str, body: dict) -> tuple[int, dict]:
    """Moves a theme to the file its new name takes. Its id goes with it, so
    every reference to it still finds it."""
    hit = find(dirpath, body.get("id"))
    if hit is None:
        return _not_found(dirpath, body)
    current, doc = hit
    if doc is None:
        return 500, {"error": DAMAGED}
    tid = body["id"]
    target = _place(dirpath, name)
    if move_conflict(current, target):
        return 409, {"error": EXISTS}
    out = {**doc, "name": name}
    try:
        write_doc(target, out, tid)
    except OSError as e:
        return 500, {"error": os_reason(e)}
    # The theme is already whole under its new name, and a binned copy would
    # come back as a second theme when restored.
    # Two files holding one id would give the id to whichever sorts first, so an
    # old file that stays takes the new one back with it.
    if current != target:
        try:
            current.unlink(missing_ok=True)
        except OSError as e:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                return 500, {"error": f"the theme's old file couldn't be removed ({os_reason(e)}), and it is now under both names"}
            return 500, {"error": f"the theme keeps its old name, since its old file couldn't be removed ({os_reason(e)})"}
    return 200, entry(target, tid, out)


REF_PREFIX = "theme:"


def colors_of(dirpath: Path, ref, stored_name=None) -> tuple[str, str, dict | None] | None:
    """The user theme a stored reference means: its own theme when this install
    has it, else the first readable user theme carrying the name stored beside
    it, else a damaged file of that name. Answers its id, name and colours, or
    None for a built-in or a theme found none of these ways. A file that cannot
    be read answers None for the colours and its file's name for the name, so a
    restore treats the theme as damaged instead of looking for another."""
    if not (isinstance(ref, str) and ref.startswith(REF_PREFIX)):
        return None
    entries = listing(dirpath)
    tid = ref[len(REF_PREFIX):]
    hit = next((e for e in entries if e["id"] == tid), None)
    name = stored_name.strip() if isinstance(stored_name, str) else ""
    if hit is None and name:
        hit = next((e for e in entries if e["doc"] is not None and e["doc"].get("name") == name), None)
    # A restart gives a damaged file a new id, and its file name is then what
    # still ties it to the stored name.
    if hit is None and name:
        hit = next((e for e in entries if e["doc"] is None and e["filename"] == _place(dirpath, name).name), None)
    if hit is None:
        return None
    doc = hit["doc"]
    if doc is None:
        return hit["id"], Path(hit["filename"]).stem, None
    held = doc.get("values")
    return hit["id"], str(doc.get("name") or ""), dict(held) if isinstance(held, dict) else {}


def replace_values(dirpath: Path, tid: str, values: dict) -> dict | None:
    """Writes `values` as the theme's whole colour map, answering the map it
    held so a caller can put it back, or None when the theme is gone or cannot
    be read."""
    hit = find(dirpath, tid)
    if hit is None:
        return None
    path, doc = hit
    if doc is None:
        return None
    held = doc.get("values")
    write_doc(path, {**doc, "values": dict(values)}, tid)
    return dict(held) if isinstance(held, dict) else {}


def forget(tid: str) -> None:
    for key in [k for k in _last_counts if k[1] == tid]:
        del _last_counts[key]
