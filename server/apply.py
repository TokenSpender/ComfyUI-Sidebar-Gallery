"""One request for an action that changes several things at once: a preset
load, a restore or its Undo, a theme made from colours. The route holds the
settings lock and the presets lock around these functions, so nothing else
writes between the read and the writes, and it commits the settings itself,
since the settings state belongs to the event loop.

A request names target values, so a key whose stored value already equals its
target is not written. The copy taken first holds what the request then
overwrites, or the whole settings file when the request restores from a whole
copy.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from . import settings_backups, themes
from .config import os_reason
from .presets import FILENAME_REFUSED, NO_LETTER, sanitize_name

logger = logging.getLogger("sbg")

THEME_KEY = "SBG.Theme"
ORDER_KEY = "SBG.ThemeOrder"
_REF = themes.REF_PREFIX


class Refused(Exception):
    def __init__(self, status: int, error: str):
        super().__init__(error)
        self.status = status
        self.payload = {"error": error}


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


_MISSING = object()


def _same(a, b) -> bool:
    if a is _MISSING or b is _MISSING:
        return a is b
    return _canonical(a) == _canonical(b)


def list_delta(stored, add, remove) -> list:
    """Merging on the server keeps two browser tabs editing one list from
    overwriting each other with the copy each read at load."""
    current = [v for v in stored if isinstance(v, str)] if isinstance(stored, list) else []
    dropped = {v for v in remove if isinstance(v, str)}
    merged = [v for v in current if v not in dropped]
    present = set(merged)
    for v in add:
        if isinstance(v, str) and v not in present:
            present.add(v)
            merged.append(v)
    return merged


@dataclass
class Request:
    settings: dict
    deltas: dict
    restore: dict | None
    create: dict | None
    edit: dict | None
    precondition: dict
    backup: dict | None
    carried: frozenset


def _theme_values(values) -> dict:
    """A theme's values as a request sends them: text to set, null or an empty
    string to clear."""
    if not isinstance(values, dict):
        raise Refused(400, "the theme data is missing")
    out = {}
    for k, v in values.items():
        if not themes.fits_key(k) or not (v is None or v == "" or themes.fits_value(v)):
            raise Refused(400, "the theme data is missing")
        out[k] = v or None
    return out


def _theme_ref(ref) -> str:
    if not (isinstance(ref, str) and ref.startswith(_REF) and themes.valid_theme_id(ref[len(_REF):])):
        raise Refused(400, "the theme isn't one this version reads")
    return ref


def parse(body: dict) -> Request:
    settings = body.get("settings", {})
    precondition = body.get("precondition", {})
    carried = body.get("carried", [])
    if not isinstance(settings, dict) or not isinstance(precondition, dict):
        raise Refused(400, "the request isn't one this version reads")
    if not isinstance(carried, list) or not all(isinstance(k, str) for k in carried):
        raise Refused(400, "the request isn't one this version reads")
    deltas = body.get("deltas", {})
    if not isinstance(deltas, dict) or not all(
            isinstance(d, dict) and isinstance(d.get("add", []), list) and isinstance(d.get("remove", []), list)
            for d in deltas.values()):
        raise Refused(400, "the request isn't one this version reads")
    deltas = {k: {"add": d.get("add", []), "remove": d.get("remove", [])} for k, d in deltas.items()}

    restore = body.get("restore")
    if restore is not None:
        if not isinstance(restore, dict):
            raise Refused(400, "the request isn't one this version reads")
        filename = settings_backups.safe_filename(str(restore.get("filename") or ""))
        if not filename:
            raise Refused(400, FILENAME_REFUSED)
        created = restore.get("created")
        if created is not None and (isinstance(created, bool) or not isinstance(created, (int, float))):
            raise Refused(400, "the request isn't one this version reads")
        restore = {"filename": filename, "whole": restore.get("whole") is True, "created": created}

    theme = body.get("theme") or {}
    if not isinstance(theme, dict) or ("create" in theme and "set" in theme):
        raise Refused(400, "the request isn't one this version reads")
    create = edit = None
    if "create" in theme:
        c = theme["create"]
        if not isinstance(c, dict):
            raise Refused(400, "the theme data is missing")
        name = c.get("name")
        if not isinstance(name, str) or not sanitize_name(name.strip()):
            raise Refused(400, NO_LETTER)
        values = _theme_values(c.get("values"))
        fit = c.get("fit", "unique")
        if fit not in themes.TAILS:
            raise Refused(400, "the request isn't one this version reads")
        origin = c.get("origin")
        create = {"name": name.strip(), "values": {k: v for k, v in values.items() if v},
                  "origin": origin if isinstance(origin, str) and origin else None,
                  "select": c.get("select") is True, "tail": themes.TAILS[fit]}
    if "set" in theme:
        s = theme["set"]
        if not isinstance(s, dict):
            raise Refused(400, "the theme data is missing")
        edit = {"ref": _theme_ref(s.get("ref")), "values": _theme_values(s.get("values"))}

    backup = body.get("backup")
    if backup is not None:
        if not isinstance(backup, dict) or not settings_backups.known_cause(backup.get("cause")):
            raise Refused(400, "restart ComfyUI to finish the update")
        backup = {k: str(backup.get(k) or "") for k in ("cause", "title", "subject", "undo_kind")}

    if not settings and not deltas and restore is None and create is None and edit is None:
        raise Refused(400, "the request changes nothing")
    return Request(settings, deltas, restore, create, edit, precondition, backup, frozenset(carried))


def forget_theme(settings: dict, ref: str, changed_key: str, now_ms: int) -> tuple[dict, dict]:
    """The settings once the theme `ref` names is deleted, and what changed: a
    selection naming it is taken off, so the default theme shows, and its place
    in the theme order goes. The selection is what a preset carries, so its
    change dates the Current row, while the order is the library's."""
    after = dict(settings)
    written: dict = {}
    if after.get(THEME_KEY) == ref:
        after.pop(THEME_KEY)
        written[THEME_KEY] = None
        after[changed_key] = now_ms
        written[changed_key] = now_ms
    order = after.get(ORDER_KEY)
    if isinstance(order, list) and ref in order:
        after[ORDER_KEY] = [x for x in order if x != ref]
        written[ORDER_KEY] = after[ORDER_KEY]
    return after, written


def colours_record(themes_dir: Path, ref) -> dict:
    """The colours a copy records for the user theme `ref` names, unknown keys
    included, with that theme beside them. A built-in holds none."""
    found = themes.colors_of(themes_dir, ref)
    if found is None or found[2] is None:
        return {}
    tid, name, values = found
    return {"colors": values, "colors_theme": f"{_REF}{tid}", "colors_theme_name": name}


def colours_target(themes_dir: Path, want) -> dict:
    """Where a whole copy's colours go back: the theme they belong to, and
    whether they change it. A theme this install lacks takes none, and neither
    does a damaged one, whose file name is kept for naming a copy of it."""
    out = {"id": None, "changes": False, "missing": None, "damaged": False, "name": ""}
    if not want:
        return out
    ref, values, name = want
    found = themes.colors_of(themes_dir, ref, name)
    if found is None:
        out["missing"] = ref
        return out
    tid, found_name, held = found
    if held is None:
        out["damaged"] = True
        out["name"] = found_name
        return out
    out["id"] = tid
    out["changes"] = held != values
    return out


def colours_before(themes_dir: Path, settings: dict, changed_ref: str, into: str) -> dict:
    """The colours a whole copy taken before a restore records: those of the
    theme the restore writes into, so Undo puts that theme back whichever theme
    is in use by then."""
    if changed_ref:
        return colours_record(themes_dir, changed_ref)
    return colours_record(themes_dir, into or settings.get(THEME_KEY))


def _read_copy(backups_dir: Path, restore: dict) -> dict:
    doc = settings_backups.read_backup(backups_dir, restore["filename"])
    if doc is None:
        raise Refused(404, settings_backups.UNREAD)
    # The listing named a copy, and a different one under the same name since
    # would put back what the person never saw.
    if restore["created"] is not None and doc.get("created") != restore["created"]:
        raise Refused(409, "the backup changed since the list was read")
    if restore["whole"] and not settings_backups.is_whole(doc):
        raise Refused(400, settings_backups.NOT_WHOLE)
    return doc


@dataclass
class Plan:
    after: dict
    written: dict
    copy: dict | None
    create: dict | None
    edit: dict | None
    replace: dict | None
    answer: dict
    protect: str | None


def plan(req: Request, settings: dict, backups_dir: Path, themes_dir: Path, install_keys, changed_key: str,
         now_ms: int, name_max: int) -> Plan:
    for key, value in req.precondition.items():
        if not _same(settings.get(key, _MISSING), _MISSING if value is None else value):
            raise Refused(409, "the settings changed since this began")

    after = dict(settings)
    answer: dict = {}
    copy_doc = None
    replace = None
    changed_ref = ""
    damaged = None
    # A restore names its copy, which the prune then spares. A restore of only
    # part of it sends the values it puts back as settings, read from the copy
    # the person saw, and the copy here only decides whether the copy taken
    # first is whole.
    if req.restore:
        copy_doc = _read_copy(backups_dir, req.restore)
        if req.restore["whole"]:
            # The copy's own stamp dates the copy and not this change.
            settings_backups.apply_restore(after, copy_doc, keep=(*install_keys, changed_key))
            want = settings_backups.colors_to_restore(copy_doc)
            if want:
                target = colours_target(themes_dir, want)
                # A damaged theme's colours go into a copy of it, which the
                # request's own new theme would leave no room for.
                if target["damaged"] and not req.create:
                    damaged = (want[0], want[1], want[2] or target["name"])
                elif target["missing"] or target["damaged"]:
                    answer["colors_left_out"] = {"ref": want[0], "why": "damaged" if target["damaged"] else "missing", "name": want[2]}
                if target["id"]:
                    answer["colors_theme_id"] = target["id"]
                if target["changes"]:
                    replace = {"tid": target["id"], "values": want[1]}
                    changed_ref = f"{_REF}{target['id']}"

    for key, value in req.settings.items():
        if key in install_keys:
            continue
        if value is None:
            after.pop(key, None)
        else:
            after[key] = value
    for key, d in req.deltas.items():
        if key not in install_keys:
            after[key] = list_delta(after.get(key), d["add"], d["remove"])

    create = None
    if req.create:
        c = req.create
        create = themes.plan_create(themes_dir, c["name"], c["values"], c["origin"], c["tail"], name_max)
        if "refused" in create:
            raise Refused(409, create["refused"])
        tid = create["existing"]["id"] if "existing" in create else create["tid"]
        if c["select"]:
            after[THEME_KEY] = f"{_REF}{tid}"
    elif damaged:
        ref, values, name = damaged
        create = themes.plan_create(themes_dir, name, values, None, themes.TAILS["fork"], name_max)
        if "refused" in create:
            answer["colors_left_out"] = {"ref": ref, "why": "damaged", "name": name}
            create = None
        else:
            had = create.get("existing")
            tid, made = (had["id"], had["doc"]["name"]) if had else (create["tid"], create["name"])
            # The copy stands in for the theme only where the restore puts it in use.
            if after.get(THEME_KEY) == ref:
                after[THEME_KEY] = f"{_REF}{tid}"
            # A copy made by an earlier restore of the same colours is found again
            # and is nothing new to tell.
            if not had:
                answer["colors_copied"] = {"from": name, "into": made}

    edit = None
    edit_ref = req.edit["ref"] if req.edit else ""
    if req.edit:
        values = req.edit["values"]
        edit = themes.plan_edit(themes_dir, edit_ref[len(_REF):], {k: v for k, v in values.items() if v},
                                [k for k, v in values.items() if not v])
        if "refused" in edit:
            answer["colors_left_out"] = {"ref": edit_ref, "why": edit["refused"], "name": ""}
            edit = None
        else:
            answer["colors_theme_id"] = edit["tid"]
            if edit["changed"]:
                changed_ref = edit_ref

    written = {}
    for key in {**settings, **after}:
        if not _same(settings.get(key, _MISSING), after.get(key, _MISSING)):
            written[key] = after.get(key)
    # The page cannot know which keys a whole copy changes, so it names none as
    # carried and a whole restore stamps whenever it writes.
    whole_restore = bool(req.restore and req.restore["whole"])
    if (whole_restore and written) or any(key in req.carried for key in written):
        after[changed_key] = now_ms
        written[changed_key] = now_ms

    copy = None
    themed = bool(replace or (create and "existing" not in create) or (edit and edit["changed"]))
    if req.backup and (written or themed):
        whole = bool(copy_doc and settings_backups.is_whole(copy_doc))
        if whole:
            keys = [k for k in settings if k not in install_keys]
            colours = colours_before(themes_dir, settings, changed_ref, edit_ref)
        else:
            keys = [k for k in written if k != changed_key]
            colours = {}
            if edit and edit["changed"]:
                prior = edit["prior"]
                colours = {"colors": {k: prior[k] for k in edit["changed"] if prior[k]},
                           "colors_absent": [k for k in edit["changed"] if not prior[k]],
                           "colors_theme": edit_ref, "colors_theme_name": edit["name"]}
        if keys or colours:
            cause = req.backup["cause"]
            copy = {"settings": settings, "keys": keys, "cause": cause, "whole": whole,
                    "pinned": cause in settings_backups.PINNED_CAUSES, "title": req.backup["title"],
                    "subject": req.backup["subject"], "undo_kind": req.backup["undo_kind"], **colours}

    return Plan(after, written, copy, create, edit, replace, answer, req.restore["filename"] if req.restore else None)


@dataclass
class Done:
    copy: dict | None = None
    created: Path | None = None
    edited: tuple | None = None
    replaced: tuple | None = None
    theme: dict | None = None


def write_files(p: Plan, backups_dir: Path, themes_dir: Path) -> Done:
    """Writes the copy, unpruned, then the theme. Anything that fails takes
    back what this call wrote before it and answers why nothing changed."""
    done = Done()
    if p.copy:
        try:
            done.copy = settings_backups.snapshot(backups_dir, **p.copy)
        except OSError as e:
            raise Refused(500, f"the backup couldn't be saved ({os_reason(e)}), so nothing changed")
    try:
        if p.create and "existing" in p.create:
            # Marked, so a page whose theme list is stale does not call it new.
            done.theme = {**p.create["existing"], "existing": True}
        elif p.create:
            themes.write_doc(p.create["path"], p.create["doc"], p.create["tid"])
            done.created = p.create["path"]
            done.theme = themes.entry(p.create["path"], p.create["tid"], p.create["doc"])
        if p.edit:
            if p.edit["changed"]:
                themes.write_doc(p.edit["path"], p.edit["doc"], p.edit["tid"])
                done.edited = (p.edit["path"], p.edit["before"], p.edit["tid"])
            done.theme = themes.entry(p.edit["path"], p.edit["tid"], p.edit["doc"])
        if p.replace:
            held = themes.replace_values(themes_dir, p.replace["tid"], p.replace["values"])
            if held is None:
                take_back(done, backups_dir, themes_dir)
                raise Refused(409, "the theme could no longer be written, so nothing changed")
            done.replaced = (p.replace["tid"], held)
    except OSError as e:
        take_back(done, backups_dir, themes_dir)
        raise Refused(500, f"the theme couldn't be saved ({os_reason(e)}), so nothing changed")
    return done


def take_back(done: Done, backups_dir: Path, themes_dir: Path) -> bool:
    """Puts the theme back as it was and drops the copy. When the theme cannot
    be put back the copy stays, since it then holds the only record of the
    colours the theme had, and this answers False."""
    try:
        if done.replaced:
            themes.replace_values(themes_dir, *done.replaced)
        if done.edited:
            path, before, tid = done.edited
            themes.write_doc(path, before, tid)
        if done.created:
            done.created.unlink(missing_ok=True)
    except OSError as e:
        logger.warning("SBG: a theme written for a refused change could not be put back: %s", os_reason(e))
        return False
    if done.copy:
        try:
            settings_backups.drop(backups_dir, done.copy["filename"])
        except OSError as e:
            logger.warning("SBG: the copy taken before a refused change could not be removed: %s", os_reason(e))
    return True
