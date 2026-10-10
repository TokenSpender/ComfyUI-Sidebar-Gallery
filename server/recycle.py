"""Sends a file to the OS recycle bin or trash with the standard library alone,
since the install may not carry a package for it, so the system calls below
are bound by hand."""

from __future__ import annotations

import ctypes
import ctypes.util
import errno
import logging
import os
import sys
from datetime import datetime
from urllib.parse import quote

logger = logging.getLogger("sbg.recycle")

class RecycleUnavailable(Exception):
    """No recycle bin can take this file, so it goes to the gallery's own trash
    folder instead."""

def bin_label() -> str:
    return "the Recycle Bin" if sys.platform == "win32" else "the Trash"

# The gallery's own trash folder, which takes a file when no bin will. The
# media folders, the themes folder and the backups folder each keep one.
TRASH_DIR_NAME = ".sbg-trash"

# Windows refuses to move a file another handle holds open, and a page still
# loading the file holds one through the server's own answer. The bin and the
# trash folder both meet it.
FILE_IN_USE = "the file is open in another program or still loading in the gallery"

def claim_free_name(wanted: str) -> str:
    """Creates an empty file at `wanted`, or at its first free numbered
    spelling, and answers its path. Creating the file is what claims the name,
    so two moves racing for one free name cannot both be given it."""
    stem, ext = os.path.splitext(wanted)
    dest, n = wanted, 2
    while True:
        try:
            os.close(os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL))
            return dest
        except FileExistsError:
            dest = f"{stem} ({n}){ext}"
            n += 1

def send_to_bin(path: str) -> None:
    """Raises RecycleUnavailable when no bin will take the file and OSError
    when an attempt to bin it failed, so a caller can tell a fallback from a
    failure."""
    if sys.platform == "win32":
        _windows(path)
    elif sys.platform == "darwin":
        _macos(path)
    else:
        _freedesktop(path)

_FO_DELETE = 3
_FOF_SILENT = 0x0004
_FOF_NOCONFIRMATION = 0x0010
_FOF_ALLOWUNDO = 0x0040
_FOF_NOERRORUI = 0x0400
_ERROR_SHARING_VIOLATION = 32

MAX_PATH = 260

def _windows(path: str) -> None:
    from ctypes import wintypes

    full = os.path.abspath(path)
    # The shell erases where the letter in the path it is handed has no bin, as
    # a substituted drive letter has none, so it is handed the folder with each
    # junction and substituted letter resolved. The name stays as written,
    # since resolving it would follow a file that is itself a link.
    try:
        target = os.path.join(os.path.realpath(os.path.dirname(full)), os.path.basename(full))
    except OSError as e:
        raise RecycleUnavailable(f"the file's folder cannot be resolved: {e}") from e
    # The shell erases a network file and a path this long outright instead of
    # binning it.
    if target.startswith("\\\\"):
        raise RecycleUnavailable("a network path has no Recycle Bin")
    if len(target) >= MAX_PATH:
        raise RecycleUnavailable("the path is too long for the Recycle Bin")

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", wintypes.WORD),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", wintypes.LPVOID),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = _FO_DELETE
    # The field holds a null separated list, so the trailing null ends the entry
    # and the conversion to LPCWSTR adds the one that ends the list.
    op.pFrom = target + "\0"
    op.pTo = None
    # The server has no window to ask from, so the shell is told to ask nothing.
    op.fFlags = _FOF_ALLOWUNDO | _FOF_NOCONFIRMATION | _FOF_SILENT | _FOF_NOERRORUI
    code = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if code or op.fAnyOperationsAborted:
        logger.warning("SBG: the Recycle Bin refused %s with code %s", full, code)
    if code == _ERROR_SHARING_VIOLATION:
        raise OSError(FILE_IN_USE)
    if code or op.fAnyOperationsAborted:
        raise OSError("the Recycle Bin refused the file")

def _macos_library(name: str, fallback_path: str):
    # find_library comes back empty for a framework that lives only in the dyld
    # shared cache, which dyld still resolves by its absolute path.
    for candidate in (ctypes.util.find_library(name), fallback_path):
        if not candidate:
            continue
        try:
            return ctypes.cdll.LoadLibrary(candidate)
        except OSError:
            continue
    return None

def _macos(path: str) -> None:
    # Nothing has moved until the Trash answers, so any failure to reach it
    # sends the file to the gallery's folder instead of failing the delete.
    try:
        _macos_trash(path)
    except RecycleUnavailable:
        raise
    except Exception as e:
        raise RecycleUnavailable(f"the Trash could not be reached: {e}") from e

def _macos_trash(path: str) -> None:
    objc = _macos_library("objc", "/usr/lib/libobjc.dylib")
    foundation = _macos_library("Foundation", "/System/Library/Frameworks/Foundation.framework/Foundation")
    if objc is None or foundation is None:
        raise RecycleUnavailable("the Objective-C runtime is not available")
    objc.objc_getClass.restype = ctypes.c_void_p
    objc.objc_getClass.argtypes = [ctypes.c_char_p]
    objc.sel_registerName.restype = ctypes.c_void_p
    objc.sel_registerName.argtypes = [ctypes.c_char_p]
    objc.objc_autoreleasePoolPush.restype = ctypes.c_void_p
    objc.objc_autoreleasePoolPush.argtypes = []
    objc.objc_autoreleasePoolPop.restype = None
    objc.objc_autoreleasePoolPop.argtypes = [ctypes.c_void_p]

    # objc_msgSend is variadic, so every signature gets its own prototype.
    def send(restype, *argtypes):
        return ctypes.CFUNCTYPE(restype, ctypes.c_void_p, ctypes.c_void_p, *argtypes)(("objc_msgSend", objc))

    cls, sel = objc.objc_getClass, objc.sel_registerName
    pool = objc.objc_autoreleasePoolPush()
    try:
        ns_path = send(ctypes.c_void_p, ctypes.c_char_p)(
            cls(b"NSString"), sel(b"stringWithUTF8String:"), os.fsencode(os.path.abspath(path)))
        if not ns_path:
            raise RecycleUnavailable("the path is not valid UTF-8")
        url = send(ctypes.c_void_p, ctypes.c_void_p)(cls(b"NSURL"), sel(b"fileURLWithPath:"), ns_path)
        manager = send(ctypes.c_void_p)(cls(b"NSFileManager"), sel(b"defaultManager"))
        if not url or not manager:
            raise RecycleUnavailable("Foundation gave no file manager")
        error = ctypes.c_void_p(None)
        ok = send(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
            manager, sel(b"trashItemAtURL:resultingItemURL:error:"), url, None, ctypes.byref(error))
        if not ok:
            raise RecycleUnavailable("the Trash refused the file")
    finally:
        objc.objc_autoreleasePoolPop(pool)

def _freedesktop(path: str) -> None:
    """Moves the file into a trash folder in the freedesktop layout: a `files`
    folder holding the file itself and an `info` folder holding one
    `.trashinfo` record per trashed file. The record's Path is absolute in the
    home trash and relative to the top of the volume in a trash that lives on
    the volume itself."""
    full = os.path.abspath(path)
    data_home = os.environ.get("XDG_DATA_HOME") or ""
    # The specification says to ignore a relative XDG_DATA_HOME.
    if not os.path.isabs(data_home):
        data_home = os.path.expanduser("~/.local/share")
    home_trash = os.path.join(data_home, "Trash")
    try:
        # The home trash may not exist yet, so its volume is taken from the
        # nearest parent that does.
        if os.lstat(_nearest_existing(home_trash)).st_dev == os.lstat(full).st_dev:
            trash_dir, recorded = home_trash, full
        else:
            top = _mount_top(full)
            uid = os.getuid() if hasattr(os, "getuid") else 0
            trash_dir, recorded = os.path.join(top, f".Trash-{uid}"), os.path.relpath(full, top)
        files_dir = os.path.join(trash_dir, "files")
        info_dir = os.path.join(trash_dir, "info")
        os.makedirs(files_dir, mode=0o700, exist_ok=True)
        os.makedirs(info_dir, mode=0o700, exist_ok=True)
        info_path, dest = _claim_trash_name(info_dir, files_dir, os.path.basename(full))
    except OSError as e:
        raise RecycleUnavailable(f"no trash folder can take the file: {e}") from e

    try:
        with open(info_path, "w", encoding="utf-8") as f:
            f.write("[Trash Info]\n")
            # Quoted as bytes, so a name the filesystem holds in a form that is
            # not valid UTF-8 still records.
            f.write(f"Path={quote(os.fsencode(recorded))}\n")
            f.write(f"DeletionDate={datetime.now().strftime('%Y-%m-%dT%H:%M:%S')}\n")
        os.rename(full, dest)
    except OSError as e:
        try:
            os.remove(info_path)
        except OSError:
            pass
        # A move across filesystems would be a copy, which a crash can leave
        # half done with the original already gone.
        if e.errno == errno.EXDEV:
            raise RecycleUnavailable("the trash folder for this volume is on another filesystem") from e
        raise

def _claim_trash_name(info_dir: str, files_dir: str, basename: str) -> tuple[str, str]:
    """Takes a name no file in `files` holds by creating its record
    exclusively, so a delete running at the same time cannot take it."""
    stem, ext = os.path.splitext(basename)
    n = 1
    while True:
        name = basename if n == 1 else f"{stem} ({n}){ext}"
        n += 1
        dest = os.path.join(files_dir, name)
        if os.path.lexists(dest):
            continue
        info_path = os.path.join(info_dir, name + ".trashinfo")
        try:
            os.close(os.open(info_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        except FileExistsError:
            continue
        return info_path, dest

def _nearest_existing(path: str) -> str:
    cur = path
    while not os.path.exists(cur):
        parent = os.path.dirname(cur)
        if parent == cur:
            return cur
        cur = parent
    return cur

def _mount_top(path: str) -> str:
    cur = os.path.dirname(path)
    dev = os.lstat(cur).st_dev
    while True:
        parent = os.path.dirname(cur)
        if parent == cur:
            return cur
        try:
            if os.lstat(parent).st_dev != dev:
                return cur
        except OSError:
            return cur
        cur = parent
