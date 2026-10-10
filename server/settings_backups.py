from __future__ import annotations

import re
import threading
import time
from pathlib import Path

from .config import read_json_file, write_json_atomic
from .presets import layout_digest

# Every copy is one flat shape:
#   `keys`: the settings it holds
#   `absent`: the settings that were unset
#   `colors`: a theme's colours
#   `colors_absent`: the covered colours that were unset
#   `colors_theme`: the theme the colours belong to
#   `colors_theme_name`: that theme's name, which finds it when its id is gone
# Theme colours sit in `keys` only in a copy taken while the settings still held
# them, before a start of this version moved them into the theme.
BACKUP_FORMAT = "sbg-settings-backup"
BACKUP_VERSION = 1
RING_SIZE = 5
# The words a copy's `cause` begins with, one per kind of copy. A later
# version reads them to tell copies apart, so they are part of the format.
CAUSES = ("before-", "before-restore", "preset-load-", "layouts-from-older-version",
          "colours-from-older-version")
# A copy taken before applying what an older version changed is the only copy of
# what it replaces, so it is written pinned.
PINNED_CAUSES = ("layouts-from-older-version", "colours-from-older-version")
_LAYOUT_PREFIX = "SBG.Layouts."
_LAYOUT_MAP = "SBG.Layouts"
BACKUPS_DIRNAME = "backups"

UNREAD = "the backup can't be read"
NOT_WHOLE = "Only a copy of the whole settings file is put back here"

# The names the ring writes. A copy put in the folder by hand is never pruned.
_RING_NAME = re.compile(r"(?!.*\.\.)\d{8}-\d{6}-\d{3}-[A-Za-z0-9._-]+\.json")

# Writing a copy, pinning one and pruning the ring each read the folder and
# then change it, and two browser tabs reach them on different IO threads.
# Unguarded, a prune that listed the folder before another thread pinned a
# copy would delete the copy that thread had been told to keep.
_LOCK = threading.RLock()

def safe_cause(cause: str) -> str:
    tag = re.sub(r"[^A-Za-z0-9._-]+", "-", str(cause or ""))
    # The cause becomes part of the filename, and safe_filename refuses a run
    # of dots when the backup is read back.
    tag = re.sub(r"\.{2,}", ".", tag).strip("-.")
    return (tag or "snapshot")[:60].rstrip("-.") or "snapshot"

def known_cause(cause) -> bool:
    return isinstance(cause, str) and any(cause.startswith(c) for c in CAUSES)

def _store(dirpath: Path, doc: dict, cause: str) -> dict:
    with _LOCK:
        path = _free_path(dirpath, doc["created"], cause)
        write_json_atomic(path, doc)
        return _row(path, doc)


def drop(dirpath: Path, filename: str) -> None:
    """Takes back a copy written for work that was then refused, so the refusal
    leaves the folder as it was."""
    with _LOCK:
        (dirpath / filename).unlink(missing_ok=True)

def _free_path(dirpath: Path, created: int, cause: str) -> Path:
    dirpath.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(created / 1000))
    return _unused(dirpath, f"{stamp}-{created % 1000:03d}-{safe_cause(cause)}")

def _unused(dirpath: Path, base: str) -> Path:
    path = dirpath / f"{base}.json"
    n = 1
    while path.exists():
        n += 1
        path = dirpath / f"{base}-{n}.json"
    return path

def snapshot(dirpath: Path, settings: dict, keys, cause: str, pinned: bool = False, whole: bool = False,
             title: str = "", undo_kind: str = "", subject: str = "",
             colors: dict | None = None, colors_absent=(), colors_theme: str = "", colors_theme_name: str = "") -> dict:
    """A requested key that is not set right now goes into `absent`, so
    restoring the copy unsets it again instead of leaving whatever value it has
    by then. `title` is the sentence the row shows, written by whoever takes
    the copy, since only they know what it is for. `colors` are written only
    with the theme they belong to, and a whole copy writes them even when
    empty, since restoring it replaces that theme's whole map. Nothing is
    pruned here, since the apply route prunes once its work lands and a pinned
    copy takes no place in the ring."""
    values = {}
    absent = []
    for k in keys:
        if k in settings:
            values[k] = settings[k]
        else:
            absent.append(k)
    doc = {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "created": int(time.time() * 1000),
        "cause": str(cause),
        "title": str(title),
        "pinned": bool(pinned),
        "whole": bool(whole),
        "keys": values,
        "absent": absent,
    }
    if undo_kind:
        doc["undo_kind"] = str(undo_kind)
    if subject:
        doc["subject"] = str(subject)
    if colors_theme and (colors or colors_absent or (whole and colors is not None)):
        doc["colors"] = dict(colors or {})
        doc["colors_absent"] = [k for k in colors_absent if isinstance(k, str)]
        doc["colors_theme"] = str(colors_theme)
        if colors_theme_name:
            doc["colors_theme_name"] = str(colors_theme_name)
    return _store(dirpath, doc, cause)

def set_pinned(dirpath: Path, filename: str, pinned: bool) -> dict | None:
    """The pin lives in the document alone, since the prune never deletes a
    copy it cannot read. Nothing is pruned here, so a copy that stops being
    kept leaves the ring as every other copy does, when newer ones arrive,
    instead of vanishing under the unpin."""
    with _LOCK:
        doc = read_backup(dirpath, filename)
        if doc is None:
            return None
        doc["pinned"] = bool(pinned)
        path = dirpath / filename
        write_json_atomic(path, doc)
        return _row(path, doc)

def discard(dirpath: Path, filename: str, move):
    """Runs `move` on a copy under the lock the pin takes, so a pin that read
    the copy before a delete cannot write it back after."""
    with _LOCK:
        return move(dirpath / filename)

def prune(dirpath: Path, keep: int = RING_SIZE, protect: str | None = None) -> list[str]:
    """Only a copy whose body says it is not pinned is ever deleted, so one
    that cannot be read stays for the person to look at."""
    with _LOCK:
        rows = [r for r in list_backups(dirpath, _RING_NAME) if r["readable"] and not r["pinned"]]
        removed = []
        for row in rows[keep:]:
            if row["filename"] == protect:
                continue
            try:
                (dirpath / row["filename"]).unlink()
                removed.append(row["filename"])
            except OSError:
                pass
        return removed

# Each copy's row while its file is unchanged, by path, so a new copy's prune
# reads only what changed since the last listing, and the whole copies kept at
# each version's first start, one more with every release, are read once.
_ROWS: dict[str, tuple[int, int, dict]] = {}

def _listed_row_locked(path: Path) -> dict:
    try:
        st = path.stat()
        seen = (st.st_mtime_ns, st.st_size)
    except OSError:
        seen = None
    hit = _ROWS.get(str(path))
    if seen and hit and hit[:2] == seen:
        return hit[2]
    doc = read_backup(path.parent, path.name)
    row = None
    if doc is not None:
        # A layout can parse and still nest too deep for its digest to be taken.
        try:
            row = _row(path, doc)
        except RecursionError:
            row = None
    row = row or {"filename": path.name, "created": None, "pinned": False, "readable": False}
    if seen:
        _ROWS[str(path)] = (*seen, row)
    return row

def list_backups(dirpath: Path, named: re.Pattern | None = None) -> list[dict]:
    """Every copy in the folder, or only those whose file name matches
    `named`, which spares the prune reading the copies it can never drop."""
    if not dirpath.is_dir():
        return []
    with _LOCK:
        paths = [p for p in dirpath.glob("*.json") if not named or named.fullmatch(p.name)]
        rows = [_listed_row_locked(p) for p in paths]
        if named is None:
            listed = {str(p) for p in paths}
            for key in [k for k in _ROWS if Path(k).parent == dirpath and k not in listed]:
                del _ROWS[key]
    # A copy that cannot be read has no date, so it sorts last.
    rows.sort(key=lambda r: (r["created"] or 0, r["filename"]), reverse=True)
    return rows

def read_backup(dirpath: Path, filename: str) -> dict | None:
    if not safe_filename(filename):
        return None
    try:
        doc = read_json_file(dirpath / filename)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("format") != BACKUP_FORMAT:
        return None
    if not isinstance(doc.get("keys"), dict) or not isinstance(doc.get("absent"), list):
        return None
    if "colors" in doc and not (isinstance(doc["colors"], dict) and isinstance(doc.get("colors_absent", []), list)):
        return None
    return doc

def safe_filename(filename: str) -> str:
    """The name only when it names a file directly inside the folder, since it
    comes from a request and callers join it onto the backups folder."""
    name = str(filename or "")
    return name if re.fullmatch(r"[A-Za-z0-9._-]+\.json", name) and ".." not in name else ""

def is_whole(doc: dict) -> bool:
    # Only an explicit true, since a copy read as whole drops every key it
    # lacks on restore.
    return doc.get("whole") is True and bool(doc.get("keys"))

def apply_restore(settings: dict, doc: dict, keep=()) -> None:
    """A whole backup stands for the settings file entire, so restoring one also
    drops the keys it does not carry. `keep` names keys left as they are, the
    install's record of which version last ran among them, since a copy taken
    at a version's first start holds the older version's stamp and putting it
    back would make the next start take the same copy again."""
    values = dict(doc.get("keys") or {})
    if is_whole(doc):
        for k in list(settings.keys()):
            if k not in values and k not in keep:
                settings.pop(k)
    for k, v in values.items():
        if k not in keep:
            settings[k] = v
    for k in doc.get("absent") or []:
        if isinstance(k, str) and k not in keep:
            settings.pop(k, None)

def colors_to_restore(doc: dict) -> tuple[str, dict, str] | None:
    """The theme a whole copy's colours go back into, the colours that theme
    then holds, and the name stored for the theme, which finds it when its id
    is gone. None for a copy that carries none."""
    ref = doc.get("colors_theme")
    if not (isinstance(ref, str) and ref and isinstance(doc.get("colors"), dict)):
        return None
    name = doc.get("colors_theme_name")
    return (ref, {k: v for k, v in doc["colors"].items() if isinstance(k, str) and isinstance(v, str)},
            name if isinstance(name, str) else "")

def _thin(doc: dict) -> dict:
    """The copy with each layout's body replaced by its digest, for the
    listing, which no closed row needs a body for."""
    keys = doc.get("keys")
    if not isinstance(keys, dict):
        return doc
    out = {}
    for k, v in keys.items():
        if k.startswith(_LAYOUT_PREFIX) and isinstance(v, list):
            out[k] = {"d": layout_digest(v)}
        elif k == _LAYOUT_MAP and isinstance(v, dict):
            out[k] = {name: ({"d": layout_digest(p)} if isinstance(p, list) else p) for name, p in v.items()}
        else:
            out[k] = v
    return {**doc, "keys": out}

def _row(path: Path, doc: dict) -> dict:
    created = doc.get("created")
    whole = is_whole(doc)
    return {
        "filename": path.name,
        # A copy is a file the person can edit, so anything that is not a date
        # is left out instead of breaking the sort the whole list goes through.
        "created": created if isinstance(created, (int, float)) and not isinstance(created, bool) else None,
        "title": str(doc.get("title") or ""),
        "subject": str(doc.get("subject") or ""),
        "undo_kind": str(doc.get("undo_kind") or ""),
        "pinned": bool(doc.get("pinned")),
        "whole": whole,
        # The read action answers with the layout bodies this leaves out.
        "doc": _thin(doc),
        "readable": True,
    }
