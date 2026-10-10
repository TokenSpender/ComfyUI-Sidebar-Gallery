from __future__ import annotations

import codecs
import json
import math
import os
import re
import threading
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

from .security import extra_root_path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]

CONFIG_FILENAME = "sidebar_gallery_config.json"

def config_path() -> Path:
    return PACKAGE_ROOT / CONFIG_FILENAME

@dataclass(frozen=True)
class SidebarGalleryConfig:
    extra_roots: tuple[str, ...] = ()
    # Stored lowercased, since a folder name is matched without regard to case.
    excluded_dirs: tuple[str, ...] = ()
    index_hidden_dirs: bool = False
    # Off unless set, since the gallery already checks the disk whenever the
    # page comes back into view and after every ComfyUI run.
    auto_refresh_interval_s: int = 0
    max_text_chunk_bytes: int = 8 * 1024 * 1024
    max_decompressed_text_bytes: int = 16 * 1024 * 1024

CONFIG_PUBLIC_FIELDS = (
    "extra_roots", "excluded_dirs", "index_hidden_dirs", "auto_refresh_interval_s",
)

# The least each text cap may be, since only a hand edit of the file sets them.
# A zero chunk cap would skip every text chunk in a PNG, so no prompt would be
# read at all.
_INT_FLOORS = {
    "max_text_chunk_bytes": 1024,
    "max_decompressed_text_bytes": 1024,
}

# The largest integer a browser reads back exactly. A value past it is ignored
# like any other that is not a number.
_INT_LIMIT = 1 << 53

# A browser timer takes a signed 32-bit delay in milliseconds and fires at once
# past it, so a longer interval would poll without pause.
_REFRESH_MAX_S = 2147483

def _safe_int(val: Any, fallback: int) -> int:
    # A bool passes int(), so true would turn the refresh on at its shortest
    # interval.
    if isinstance(val, bool):
        return fallback
    try:
        n = int(val)
    except (ValueError, TypeError, OverflowError):
        return fallback
    return n if -_INT_LIMIT <= n <= _INT_LIMIT else fallback

def _refresh_interval(val: Any, fallback: int) -> int:
    n = _safe_int(val, fallback)
    return 0 if n <= 0 else min(_REFRESH_MAX_S, max(5, n))

_ON_WORDS = ("true", "yes", "on", "1")
_OFF_WORDS = ("false", "no", "off", "0", "")

def _bool_or(val: Any, fallback: bool) -> bool:
    # A real bool, or what a hand edit means by one. An older version read the
    # value through bool(), so any number but 0 is on, and a word is read for
    # what it says, since bool() reads the string "false" as on.
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val != 0
    if isinstance(val, str):
        word = val.strip().lower()
        if word in _ON_WORDS:
            return True
        if word in _OFF_WORDS:
            return False
    return fallback

def _folder_key(p: str) -> str:
    # Every spelling of one extra folder shares this, letter case included on
    # Windows, where the case does not change the folder.
    return os.path.normcase(os.path.abspath(extra_root_path(p)))

def _unique_folders(paths: list[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    out = []
    for p in paths:
        key = _folder_key(p)
        if key not in seen:
            seen.add(key)
            out.append(p)
    return tuple(out)

def _clean_str_list(raw_list: Any, *, lower: bool = False, dedupe: bool = False) -> list[str]:
    out: list[str] = []
    if not isinstance(raw_list, list):
        return out
    for raw in raw_list:
        if not isinstance(raw, str):
            continue
        s = raw.strip()
        if lower:
            s = s.lower()
        if not s or (dedupe and s in out):
            continue
        out.append(s)
    return out

def file_sig(path: Path) -> tuple | None:
    """What a cached copy of a file is keyed by, so a change on disk is seen
    without reading the file."""
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None

_quarantine_notices: dict[str, str] = {}
_copy_notices: dict[str, str] = {}
# The bytes last copied aside per file, so a second read of the same bytes
# keeps no second copy.
_copied: dict[str, bytes] = {}

def _aside_name(path: Path) -> Path:
    return path.with_name(path.name + ".corrupt-" + time.strftime("%Y%m%d-%H%M%S"))

def quarantine_file(path: Path) -> None:
    """Moves a file that does not parse aside. One that cannot be moved raises
    UnreadableFile, since reading it as empty would let the next save write
    over it."""
    aside = _aside_name(path)
    try:
        path.replace(aside)
    except FileNotFoundError:
        return
    except OSError as e:
        raise UnreadableFile(path, e, "it is damaged and can't be moved aside") from e
    _quarantine_notices[str(path)] = aside.name

def pop_quarantine_notice(path: Path) -> str | None:
    return _quarantine_notices.pop(str(path), None)

def keep_copy(path: Path, raw: bytes) -> None:
    """Keeps the bytes of a file whose reading could be wrong beside it, under
    the name a quarantine would use, and leaves the file in place. A file
    nobody saves over is read again at every start, so a copy of the same
    bytes already beside it is enough. A copy that cannot be written raises
    UnreadableFile, since the next save would write the doubtful reading over
    the only bytes left."""
    if _copied.get(str(path)) == raw:
        return
    try:
        for sibling in path.parent.glob(path.name + ".corrupt-*"):
            if sibling.stat().st_size == len(raw) and sibling.read_bytes() == raw:
                _copied[str(path)] = raw
                return
        aside = _aside_name(path)
        aside.write_bytes(raw)
    except OSError as e:
        raise UnreadableFile(path, e, "its encoding is uncertain and no copy of it can be kept") from e
    _copied[str(path)] = raw
    _copy_notices[str(path)] = aside.name

def pop_copy_notice(path: Path) -> str | None:
    return _copy_notices.pop(str(path), None)

# The ANSI reading is tried on Windows alone, where an editor may still save in
# the codepage. This name for it holds under Python's UTF-8 mode, where the
# locale would answer UTF-8 again.
_ANSI_CODEC = "mbcs" if os.name == "nt" else None

_UTF8_MULTIBYTE = re.compile(rb"[\xC2-\xDF][\x80-\xBF]|[\xE0-\xEF][\x80-\xBF]{2}|[\xF0-\xF4][\x80-\xBF]{3}")

def _is_double_byte(codec: str) -> bool:
    # A CJK codepage spends two bytes on a character, and pairs of those bytes
    # often happen to be valid UTF-8, while a single-byte codepage's letters
    # almost never are.
    try:
        return len("一".encode(codec)) > 1
    except UnicodeEncodeError:
        return False

def _decode_json_text(raw: bytes) -> tuple[str, bool]:
    """The file's text, and whether the reading could be wrong, in which case
    the caller keeps a copy of the bytes.

    A hand-edited file arrives in whatever its editor wrote: a UTF-8 BOM, the
    UTF-16 a PowerShell redirect produces, the OS's ANSI codepage, or the UTF-8
    this extension writes with a byte an ANSI editor put into it. A file from a
    single-byte codepage almost never holds a valid multibyte UTF-8 sequence, and one from
    a CJK codepage fails to decode at least once for every four valid
    sequences, while a damaged UTF-8 file holds a few bad bytes among many
    valid sequences. A small file can sit on the line, so a CJK reading and a
    repaired UTF-8 one each keep a copy."""
    if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return raw.decode("utf-16"), False
    try:
        return raw.decode("utf-8-sig"), False
    except UnicodeDecodeError as e:
        err = e
    valid = len(_UTF8_MULTIBYTE.findall(raw))
    if not valid:
        if not _ANSI_CODEC:
            raise err
        return raw.decode(_ANSI_CODEC), False
    repaired = raw.decode("utf-8-sig", errors="replace")
    if _ANSI_CODEC and _is_double_byte(_ANSI_CODEC):
        bad = repaired.count("�")
        if bad * 4 >= valid:
            return raw.decode(_ANSI_CODEC), True
    return repaired, True

def read_json_file(path: Path) -> Any:
    """A preset, theme or backup file's content, decoded the way the settings
    file is, so one an editor saved again with a BOM or as UTF-16 still reads.
    A reading that had to guess raises ValueError, since the file could then
    hold other text than was saved, and so does nesting too deep for the
    parser, so every caller reads such a file as damaged."""
    text, guessed = _decode_json_text(path.read_bytes())
    if guessed:
        raise ValueError("the file's text could not be read for certain")
    try:
        return parse_json(text)
    except RecursionError as e:
        raise ValueError("the file is nested too deeply to read") from e

def _not_json(constant: str):
    raise ValueError(f"{constant} is not JSON")

def _finite(text: str) -> float:
    value = float(text)
    if math.isinf(value):
        raise ValueError(f"{text} is too large a number")
    return value

def parse_json(text: str) -> Any:
    """json.loads without the NaN and Infinity it lets through and without a
    number too large to hold, since no browser reads those back and an answer
    carrying one cannot be sent."""
    return json.loads(text, parse_constant=_not_json, parse_float=_finite)

def os_reason(err: OSError) -> str:
    """What the OS said, without the full path the error's own text carries."""
    return err.strerror or str(err)

class UnreadableFile(Exception):
    """A file that exists and could not be read, as when another program holds
    it open without read sharing, or one that read wrongly and could not be set
    aside or copied. No caller writes over it. A file that read wrongly is
    `lasting`, since reading the same bytes again meets the same failure."""

    def __init__(self, path: Path, err: OSError, reason: str | None = None) -> None:
        self.reason = reason or os_reason(err)
        self.lasting = reason is not None
        super().__init__(f"{path.name}: {self.reason}")

def read_json_dict(path: Path, parse=parse_json) -> dict | None:
    """The file's object, None when it is absent or was moved aside for not
    parsing, and UnreadableFile when it could not be read, set aside or
    copied."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as e:
        raise UnreadableFile(path, e) from e
    try:
        text, doubtful = _decode_json_text(raw)
        data = parse(text)
    # A decoding or parsing failure is a ValueError, and nesting too deep for
    # the parser is a RecursionError. Anything else is a fault here, and moving
    # the file aside for it would lose the person's settings.
    except (ValueError, RecursionError):
        quarantine_file(path)
        return None
    if not isinstance(data, dict):
        quarantine_file(path)
        return None
    if doubtful:
        keep_copy(path, raw)
    return data

# Windows refuses to replace a file another process holds open, even for
# reading, so the rename waits out a backup tool or an editor over this window.
_REPLACE_RETRY_DELAYS_S = (0.05, 0.1, 0.2, 0.4, 0.8)

def _replace_waiting_for_release(tmp: Path, path: Path) -> None:
    for delay in _REPLACE_RETRY_DELAYS_S:
        try:
            tmp.replace(path)
            return
        except PermissionError:
            time.sleep(delay)
    # The last attempt runs outside the loop so its error reaches the caller.
    tmp.replace(path)

def _fsync_dir(folder: Path) -> None:
    # Windows has no directory handle to sync. Elsewhere this is best effort,
    # since a network or FUSE mount can refuse it after the file has landed.
    if os.name == "nt":
        return
    try:
        fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass

def stage_json(path: Path, data: dict) -> Path:
    """Writes `data` whole to a temporary file beside `path` and answers that
    file, so a caller can move the file it replaces out of the way only once
    the new one is on disk. commit_staged puts it in place."""
    # The pid and thread keep two writers off one temporary file, and
    # sweep_stale_tmp knows a leftover by this name.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        # Half of an emoji is the only text UTF-8 cannot hold. json.dumps puts it
        # inside a string alone, where backslashreplace writes the escape that
        # reads back as the same text.
        with open(tmp, "w", encoding="utf-8", errors="backslashreplace") as f:
            f.write(json.dumps(data, indent=2, ensure_ascii=False))
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        discard_staged(tmp)
        raise
    return tmp

def commit_staged(tmp: Path, path: Path) -> tuple | None:
    """Puts the staged file in place and answers its signature, taken before
    the rename, which keeps the modification time and size, so a writer that
    lands on the path right after cannot be mistaken for this one."""
    sig = file_sig(tmp)
    try:
        _replace_waiting_for_release(tmp, path)
    except Exception:
        discard_staged(tmp)
        raise
    _fsync_dir(path.parent)
    return sig

def discard_staged(tmp: Path) -> None:
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass

def write_json_atomic(path: Path, data: dict) -> tuple | None:
    return commit_staged(stage_json(path, data), path)

def sweep_stale_tmp(folder: Path, suffixes: tuple[str, ...], min_age_s: float = 60.0) -> list[str]:
    """Removes the temporary files stage_json left in `folder` when a process
    stopped mid-write, and answers their names. A file written within
    `min_age_s` is left alone, since another process sharing the folder may
    still be writing it."""
    tmp_name = re.compile("(?:" + "|".join(map(re.escape, suffixes)) + r")\.\d+\.\d+\.tmp$")
    removed: list[str] = []
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return removed
    now = time.time()
    for entry in entries:
        if not tmp_name.search(entry.name):
            continue
        try:
            if not entry.is_file(follow_symlinks=False):
                continue
            if now - entry.stat(follow_symlinks=False).st_mtime < min_age_s:
                continue
            os.unlink(entry.path)
            removed.append(entry.name)
        except OSError:
            pass
    return removed

def _read_config_file() -> dict:
    # Read with the plain parser, since every field below is cleaned as it is
    # taken, so a number JSON cannot hold falls back to its default and the
    # folders beside it are kept.
    return read_json_dict(config_path(), json.loads) or {}

def load_config() -> SidebarGalleryConfig:
    return _config_from(_read_config_file())

def _config_from(data: dict) -> SidebarGalleryConfig:
    defaults = SidebarGalleryConfig()
    return SidebarGalleryConfig(
        extra_roots=_unique_folders(_clean_str_list(data.get("extra_roots"))),
        excluded_dirs=tuple(_clean_str_list(data.get("excluded_dirs"), lower=True, dedupe=True)),
        index_hidden_dirs=_bool_or(data.get("index_hidden_dirs"), defaults.index_hidden_dirs),
        auto_refresh_interval_s=_refresh_interval(
            data.get("auto_refresh_interval_s"), defaults.auto_refresh_interval_s),
        **{name: max(floor, _safe_int(data.get(name), getattr(defaults, name)))
           for name, floor in _INT_FLOORS.items()},
    )

def save_config(data: dict[str, Any]) -> SidebarGalleryConfig:
    return write_config(data)[1]

def write_config(data: dict[str, Any]) -> tuple[tuple[str, ...], SidebarGalleryConfig, tuple | None]:
    """Merges the fields a page sends into the stored config and answers every
    extra folder spelling the file listed before, the config written, and the
    file's signature now. The caller purges the rows of each root id the save
    dropped, and the listed spellings include a second spelling of one folder,
    which the loaded config leaves out while its rows remain under its own id."""
    stored = _read_config_file()
    cfg = _config_from(stored)

    # A save can drop a stored folder and never add one, since a new folder is
    # added by editing the file by hand. A page from an earlier version sends
    # the list it wants kept, and the current one sends the folder to remove,
    # applied to what the file holds so a list drawn before another edit landed
    # cannot drop a folder nobody touched.
    sent = data.get("extra_roots")
    if isinstance(sent, list):
        kept = {_folder_key(p) for p in _clean_str_list(sent)}
        extra_roots = tuple(p for p in cfg.extra_roots if _folder_key(p) in kept)
    else:
        gone = {_folder_key(p) for p in _clean_str_list(data.get("extra_roots_remove"))}
        extra_roots = tuple(p for p in cfg.extra_roots if _folder_key(p) not in gone)

    excluded_in = data.get("excluded_dirs")
    if isinstance(excluded_in, list):
        excluded_dirs = _clean_str_list(excluded_in, lower=True, dedupe=True)
    else:
        # One name added or removed merges into what the file holds, for the
        # same reason.
        add = _clean_str_list(data.get("excluded_dirs_add"), lower=True, dedupe=True)
        remove = set(_clean_str_list(data.get("excluded_dirs_remove"), lower=True))
        excluded_dirs = [d for d in cfg.excluded_dirs if d not in remove]
        excluded_dirs += [d for d in add if d not in excluded_dirs and d not in remove]

    out = replace(
        cfg,
        extra_roots=extra_roots,
        excluded_dirs=tuple(excluded_dirs),
        index_hidden_dirs=_bool_or(data.get("index_hidden_dirs"), cfg.index_hidden_dirs),
        auto_refresh_interval_s=_refresh_interval(
            data.get("auto_refresh_interval_s"), cfg.auto_refresh_interval_s),
    )
    sig = write_json_atomic(config_path(), asdict(out))
    return tuple(_clean_str_list(stored.get("extra_roots"))), out, sig
