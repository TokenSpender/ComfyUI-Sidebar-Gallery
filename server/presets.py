from __future__ import annotations

import functools
import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from . import recycle
from .config import PACKAGE_ROOT, read_json_file, stage_json, write_json_atomic

# The preset listing globs every .json in the themes folder, so a theme ends in
# a suffix of its own to stay out of that list.
THEME_FILE_SUFFIX = ".sbgtheme"

@functools.cache
def extension_version() -> str | None:
    """The version running. The first call is made at start and every later
    one answers what it read, so the preset listing and a new preset carry
    the running version whatever an update has since put on disk."""
    try:
        text = (PACKAGE_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        return None
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return m.group(1) if m else None

def version_tuple(text) -> tuple[int, ...] | None:
    if not isinstance(text, str):
        return None
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", text.strip())
    return tuple(int(x) for x in m.groups()) if m else None

def downgraded_from(stored, running) -> str | None:
    a = version_tuple(stored)
    b = version_tuple(running)
    return stored.strip() if a and b and a > b else None

# The browser shows each reason after "Couldn't ...:", so each names a cause.
NO_LETTER = "the name holds no letter or digit"
FILENAME_REFUSED = "the file name isn't one this folder uses"

def sanitize_name(name: str) -> str:
    return "".join(c for c in name if c.isalnum() or c in " -_").strip()

# Windows opens a device for these names whatever the suffix, so a preset or a
# theme named one is stored under the name and an underscore, unless a file of
# that name is already there, as Windows 11 allows.
_DEVICE_NAME = re.compile(r"CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]", re.IGNORECASE)

# The longest file name a filesystem takes, and what the temporary write's
# tail of a process and a thread number may add to it.
_FILE_NAME_MAX = 255
_TMP_TAIL_MAX = 32

def file_stem(name: str, folder: Path, suffix: str) -> str:
    """The file name a display name is stored under, without its suffix:
    sanitize_name cut to what the OS takes in `folder`. The display name is
    never cut, so a name of any script saves, and two long names can share a
    stem and meet as a conflict. A name whose uncut file is already there
    keeps it, so a preset stored under its uncut name is found instead of
    saved a second time."""
    stem = sanitize_name(name)
    if _DEVICE_NAME.fullmatch(stem) and not os.path.isfile(folder / (stem + suffix)):
        stem += "_"
    if os.path.exists(folder / (stem + suffix)):
        return stem
    room = _FILE_NAME_MAX - len(suffix) - _TMP_TAIL_MAX
    # Windows counts UTF-16 units where others count bytes, and refuses a whole
    # path past 259 unless long paths are switched on.
    codec, width = ("utf-16-le", 2) if os.name == "nt" else ("utf-8", 1)
    if os.name == "nt":
        by_path = 259 - len(str(folder)) - 1 - len(suffix) - _TMP_TAIL_MAX
        # A folder too deep for any name is left for the OS to answer.
        if 0 < by_path < room:
            room = by_path
    return stem.encode(codec)[:room * width].decode(codec, "ignore").strip()

# A character no Windows filename may hold, or one that names a path. Elsewhere
# the Windows ones are ordinary characters a listed file can hold, so only a
# separator or a control character is refused there.
_NOT_IN_A_WINDOWS_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_NOT_IN_A_FILENAME = re.compile(r'[\\/\x00-\x1f]')

def _refused_in_a_filename(name: str) -> bool:
    return bool((_NOT_IN_A_WINDOWS_FILENAME if os.name == "nt" else _NOT_IN_A_FILENAME).search(name))

def listed_filename(filename, suffix: str) -> str:
    """The name when it names a `suffix` file directly inside a folder, else an
    empty string. A listed file is asked for by its name on disk, parentheses
    and all, so a name that fails is refused instead of rewritten into one that
    may belong to another file. The suffix matches in any case, the way the
    listing's glob matches it on Windows."""
    name = str(filename or "")
    if not name.lower().endswith(suffix) or name.lower() == suffix or _refused_in_a_filename(name):
        return ""
    return name

def json_filename(filename) -> str:
    return listed_filename(filename, ".json")

def stored_name(filepath: Path) -> str | None:
    try:
        data = read_json_file(filepath)
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(data, dict):
        return None
    name = data.get("name")
    return name if isinstance(name, str) else None

def move_conflict(current: Path | None, target: Path):
    """Whether a file landing on `target` collides, moved from `current`
    or new when that is None. Any occupied path other than the mover's own
    collides, since writing there replaces what that file held. False when it
    does not collide, the stored name when the file holds one, and True when it
    holds none."""
    if current is not None and current == target:
        return False
    if not target.exists():
        return False
    existing = stored_name(target)
    return existing if existing else True

def discard_file(path: Path) -> tuple[str, Path | None]:
    """Moves a preset, theme or backup file to the OS bin, or into a trash
    folder beside it when there is no bin, and answers which took it with the
    path in the folder. The listings glob the folder's own files, so the trash
    folder never shows as a preset, a theme or a backup."""
    try:
        recycle.send_to_bin(str(path))
        return "bin", None
    except recycle.RecycleUnavailable as why:
        logging.getLogger("sbg").info(
            "SBG: %s goes to the trash folder beside it, since %s", path.name, why)
    trash = path.parent / recycle.TRASH_DIR_NAME
    trash.mkdir(exist_ok=True)
    dest = Path(recycle.claim_free_name(str(trash / path.name)))
    try:
        path.replace(dest)
    except OSError:
        # dest is the empty file the claim made, so removing it takes nothing.
        dest.unlink(missing_ok=True)
        raise
    return "folder", dest

def _digest_value(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: _digest_value(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_digest_value(x) for x in v]
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v

def layout_digest(profile: Any) -> str:
    """The presets and backups listings carry this for each stored layout and
    for this install's own, so a closed row on the Presets tab compares them
    without the listing carrying the stored body. The digest is of the JSON
    value with keys sorted and a float that is a whole number read as that
    integer, since a browser writes 1.0 as 1 and negative zero as 0."""
    text = json.dumps(_digest_value(profile), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha1(text.encode("ascii")).hexdigest()

def install_layout_digests(settings: dict) -> dict:
    """This install's layout profiles as the page reads them from the settings
    file, the keys the index lists or, with no index, the single map an older
    version wrote, each digested as a listed preset's are, so a closed row
    compares the two. A profile that is not a list has no digest."""
    index = settings.get("SBG.LayoutsIndex")
    if isinstance(index, list):
        profiles = {k: settings.get(f"SBG.Layouts.{k}") for k in index if isinstance(k, str)}
        profiles = {k: v for k, v in profiles.items() if isinstance(v, list)}
    else:
        held = settings.get("SBG.Layouts")
        profiles = held if isinstance(held, dict) else {}
    return {str(k): (layout_digest(v) if isinstance(v, list) else None) for k, v in profiles.items()}

def without_layout_bodies(data: dict) -> dict:
    """A copy of a preset with every layout profile's body replaced by its
    digest, for the listing the Presets tab draws its rows from, since a body
    is most of a preset's weight and no closed row shows one."""
    out = dict(data)
    layouts = out.get("layouts")
    if isinstance(layouts, dict):
        out["layouts"] = {k: ({"d": layout_digest(v)} if isinstance(v, list) else v) for k, v in layouts.items()}
    return out

def stage_preset(filepath: Path, data: dict, name: str) -> Path:
    data["name"] = name
    if "created" not in data:
        data["created"] = int(time.time() * 1000)
    return stage_json(filepath, data)

class OldFileKept(OSError):
    """The preset is saved under its new name and its old file could not be
    removed, so the rename happened and left a second file behind."""

def rename_preset(current: Path, target: Path, name: str) -> None:
    """Puts a preset under a new display name, keeping everything else it
    holds. Two display names can sanitize to one filename, so the file may stay
    where it is. Where it moves, the old file is unlinked instead of binned,
    since the preset is already whole under the new name and a binned copy
    would come back as a second preset under the old one."""
    data = read_json_file(current)
    if not isinstance(data, dict):
        raise ValueError("the file does not hold a preset")
    data["name"] = name
    write_json_atomic(target, data)
    if current != target:
        try:
            current.unlink(missing_ok=True)
        except OSError as e:
            raise OldFileKept(e.errno, e.strerror) from e
