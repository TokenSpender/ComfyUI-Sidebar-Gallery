from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import quote

from aiohttp import web

import folder_paths
import server

from .config import config_path, load_config, save_config
from .db import IMAGE_EXTS, VIDEO_EXTS
from . import db as media_db
from .metadata import PARSER_VERSION, read_metadata_for_file, guess_mime, sanitize_for_json
from . import schema
from .search import match_item
from .security import AllowedRoot, make_root_id, safe_join

# Two dedicated worker pools, split by latency class, isolate gallery work from
# ComfyUI's shared default executor and from each other (so a long scan or ffmpeg
# job can't head-of-line-block interactive work).
#
# _SCAN_EXECUTOR: minutes-long whole-library work (incremental scans, meta-key
#   aggregation, removed-root purges). 2 workers keeps disk/SQLite contention bounded.
# _IO_EXECUTOR: interactive per-item work (image/video thumbnails, search,
#   new-file processing). 4 workers; ffmpeg is still capped at 2 by _FFMPEG_SEM,
#   so video jobs can never occupy the whole pool.
# The list_all payload build stays on the DEFAULT executor so gallery opens
# never queue behind either pool.
_SCAN_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sbg-scan")
_IO_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sbg-io")
# Response deflate gets its own tiny pool: on _IO_EXECUTOR a finished response's
# compression could queue behind a running ffmpeg job, delaying first byte by
# seconds for millisecond-scale work.
_ZLIB_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sbg-zlib")


routes = server.PromptServer.instance.routes


def _clamped_int(val: Any, fallback: int, lo: int = 64, hi: int = 1024) -> int:
    """Parse a query/body value to an int clamped to [lo, hi]; never raises."""
    try:
        n = int(val)
    except (TypeError, ValueError):
        n = fallback
    return max(lo, min(hi, n))


# Thumbnail cache directory

_THUMB_DIR = Path(__file__).resolve().parents[1] / ".thumbs"
_THUMB_DIR.mkdir(exist_ok=True)

# Sweep temp files left by a hard kill mid-thumbnail-write (never served,
# but they'd accumulate otherwise).
for _stale_tmp in _THUMB_DIR.glob("tmp_*.jpg"):
    try:
        _stale_tmp.unlink()
    except OSError:
        pass

# Thumbnails are content-addressed by path+mtime+size, so a changed or deleted
# file orphans its old thumbnail with no way to map it back. Cap the cache's
# total size and evict the oldest thumbnails over the cap.
_THUMB_CACHE_MAX_BYTES = 3 * 1024 ** 3  # 3 GB


def _gc_thumbs(max_bytes: int = _THUMB_CACHE_MAX_BYTES) -> None:
    try:
        entries = []
        total = 0
        for f in _THUMB_DIR.iterdir():
            if f.suffix != ".jpg" or f.name.startswith("tmp_"):
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, f))
            total += st.st_size
        if total <= max_bytes:
            return
        entries.sort()  # oldest first
        for _mt, size, f in entries:
            if total <= max_bytes:
                break
            try:
                f.unlink()
                total -= size
            except OSError:
                pass
    except Exception:
        pass


# Run off the import thread so a large cache never delays startup.
threading.Thread(target=_gc_thumbs, daemon=True).start()


def _thumb_hash(full_path: str, size: int) -> str:
    """Stable hash key for a thumbnail: based on path + mtime + size."""
    try:
        mtime = os.path.getmtime(full_path)
    except OSError:
        mtime = 0
    return hashlib.md5(f"{full_path}:{mtime}:{size}".encode()).hexdigest()


def _video_thumb_path(full_path: str, size: int = 512) -> Path:
    """Get the cache path for a video thumbnail."""
    return _THUMB_DIR / f"v_{_thumb_hash(full_path, size)}.jpg"


def _image_thumb_path(full_path: str, size: int = 512) -> Path:
    """Get the cache path for an image thumbnail."""
    return _THUMB_DIR / f"i_{_thumb_hash(full_path, size)}.jpg"


def _thumb_url(rid_q: str, rp_q: str, size: int, kind: str, mtime) -> str | None:
    """Content-addressed thumbnail URL. The &v=<mtime> token makes a regenerated
    file (new mtime) resolve to a fresh url, so its immutable-cached thumbnail
    refreshes on its own, with no wholesale client-cache wipe on every db_version
    bump. Millisecond precision so a same-second overwrite still busts the
    browser's immutable cache."""
    v = int((mtime or 0) * 1000)
    if kind == "image":
        return f"/sidebar_gallery/preview?root_id={rid_q}&relpath={rp_q}&size={size}&format=jpeg&v={v}"
    if kind == "video":
        return f"/sidebar_gallery/video_thumb?root_id={rid_q}&relpath={rp_q}&size={size}&v={v}"
    return None


# Cap concurrent ffmpeg thumbnail jobs. During a full reindex the CPU is
# saturated; unbounded parallel ffmpeg spawns then time out en masse, producing
# waves of broken video thumbnails.
_FFMPEG_SEM = threading.Semaphore(2)

# Async-level gate matching _FFMPEG_SEM: acquired BEFORE submitting a video job
# to _IO_EXECUTOR, so excess video requests wait on the event loop (free) instead
# of occupying pool workers while blocked on the threading semaphore. A burst of
# video thumbnails must never starve image thumbs and search of executor slots.
_FFMPEG_GATE = asyncio.Semaphore(2)


async def _video_thumb_off_loop(full, tp, size):
    async with _FFMPEG_GATE:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            _IO_EXECUTOR, lambda: _generate_video_thumbnail(full, tp, size))

# Resolved ffmpeg path, cached after the first lookup.
_FFMPEG_CACHE: list[str | None] = []


def _find_ffmpeg() -> str | None:
    """Locate an ffmpeg binary for video-thumbnail generation.

    Tries PATH and the FFMPEG env var first, then the binary bundled by the
    imageio-ffmpeg dependency (so thumbnails work with no separate install),
    then common system locations. Returns None if nothing is found, in which
    case the caller skips thumbnail generation. Cached after the first lookup.
    """
    if _FFMPEG_CACHE:
        return _FFMPEG_CACHE[0]
    found = shutil.which("ffmpeg") or os.environ.get("FFMPEG")
    if not found:
        try:
            import imageio_ffmpeg
            exe = imageio_ffmpeg.get_ffmpeg_exe()
            if exe and os.path.isfile(exe):
                found = exe
        except Exception:
            pass
    if not found:
        name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        home = os.path.expanduser("~")
        if os.name == "nt":
            candidates = [
                os.path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", name),
                r"C:\ffmpeg\bin\ffmpeg.exe",
                r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            ]
        else:
            candidates = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]
        for c in candidates:
            if c and os.path.isfile(c):
                found = c
                break
    _FFMPEG_CACHE.append(found)
    return found


def _generate_video_thumbnail(full_path: str, out_path: Path, size: int = 512) -> bool:
    """Generate a thumbnail for a video file using ffmpeg.

    Writes to a temp file and renames on success, so a timed-out/killed
    ffmpeg can never leave a partial .jpg that would be served forever.
    """
    if out_path.exists():
        return True
    ffmpeg = _find_ffmpeg()
    if ffmpeg is None:
        return False
    tmp_path = out_path.with_name("tmp_" + out_path.name)
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with _FFMPEG_SEM:
            result = subprocess.run(
                [
                    # -ss BEFORE -i = fast input seeking (jump straight to the
                    # keyframe) instead of decoding 0.5s of video first.
                    ffmpeg, "-y", "-ss", "0.5", "-i", str(full_path),
                    "-vframes", "1",
                    "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease:flags=lanczos",
                    "-q:v", "2",
                    str(tmp_path),
                ],
                capture_output=True, timeout=20,
            )
        ok = result.returncode == 0 and tmp_path.exists() and tmp_path.stat().st_size > 0
        if ok:
            os.replace(tmp_path, out_path)
        return ok and out_path.exists()
    except Exception:
        return False
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass


def _generate_image_thumbnail(full_path: str, out_path: Path, size: int = 512) -> bool:
    """Generate a JPEG thumbnail for an image file using PIL.

    Atomic temp-file + rename, same rationale as the video path.
    """
    if out_path.exists():
        return True
    tmp_path = out_path.with_name("tmp_" + out_path.name)
    try:
        from PIL import Image, ImageOps
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(full_path) as img:
            # Respect EXIF orientation so rotated photos don't render sideways.
            try:
                img = ImageOps.exif_transpose(img)
            except Exception:
                pass
            img = img.convert("RGB")
            img.thumbnail((size, size))
            img.save(str(tmp_path), format="JPEG", quality=85)
        if tmp_path.exists() and tmp_path.stat().st_size > 0:
            os.replace(tmp_path, out_path)
        return out_path.exists()
    except Exception:
        return False
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass


# Root helpers


def _output_root() -> AllowedRoot:
    out = folder_paths.get_output_directory()
    return AllowedRoot(root_id="output", label="Output", path=out)


def _extra_root_id(raw: str) -> tuple[str, str]:
    """Normalize a configured extra-root path and derive its root_id.

    The single derivation for extra-root ids: rows are indexed under these ids
    and the removed-root purge deletes by them, so this normalization must not
    be duplicated (a divergent copy would make the purge silently stop matching)."""
    p = os.path.normpath(os.path.expandvars(os.path.expanduser(raw.strip())))
    return make_root_id("extra", p), p


# Cached roots list. Building it stats every configured extra folder, and a
# stat on an offline network share can block for seconds; doing that per
# request on the event loop would freeze ComfyUI. The cache serves the last
# known list instantly and refreshes off the loop: a config save refreshes
# synchronously in an executor, config-file edits through the file signature,
# and liveness changes through the periodic refresh. The first build runs in
# the scan executor when the deferred parser check triggers it, or blocking
# at import in that check's fallback path.
_ROOTS_TTL_S = 5.0
_roots_cache: dict | None = None  # {"roots": [...], "sig": tuple | None, "ts": float}
_roots_refresh_lock = threading.Lock()


def _config_sig() -> tuple | None:
    """Change signature of the local config file (cheap stat, local disk)."""
    try:
        st = os.stat(config_path())
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _build_roots() -> list[AllowedRoot]:
    """Blocking: reads the config and stats each extra root. Import time and
    executor threads only; request handlers go through _all_roots."""
    cfg = load_config()
    roots = [_output_root()]
    for raw in cfg.extra_roots:
        rid, p = _extra_root_id(raw)
        if os.path.isdir(p):
            roots.append(AllowedRoot(root_id=rid, label=os.path.basename(p) or p, path=p))
    return roots


def _refresh_roots() -> None:
    """Rebuild the cache. Serialized by the lock so a stale build finishing
    late can never overwrite a fresher one."""
    global _roots_cache
    with _roots_refresh_lock:
        sig = _config_sig()  # taken before the build: a write during the
        # build mismatches the next check and triggers another refresh
        roots = _build_roots()
        _roots_cache = {"roots": roots, "sig": sig, "ts": time.monotonic()}


def _schedule_roots_refresh() -> None:
    if _roots_refresh_lock.locked():
        return  # a refresh is already on its way
    _IO_EXECUTOR.submit(_refresh_roots)


def _all_roots() -> list[AllowedRoot]:
    c = _roots_cache
    if c is None:
        _refresh_roots()
        return _roots_cache["roots"]
    if c["sig"] != _config_sig() or time.monotonic() - c["ts"] >= _ROOTS_TTL_S:
        _schedule_roots_refresh()
    return c["roots"]


def _find_root(root_id: str) -> AllowedRoot | None:
    for r in _all_roots():
        if r.root_id == root_id:
            return r
    return None


# DB-backed metadata reader helper

def _read_metadata_for_db(full_path: str) -> dict | None:
    """Read metadata from a file and return only the compact summary dict.

    Stores only the parsed summary (~1-5 KB) and leaves out the full prompt,
    workflow, parsed, and raw_text blobs, which can be 50-200 KB each.
    Returns None if parsing fails entirely."""
    cfg = load_config()
    try:
        md = read_metadata_for_file(
            full_path,
            max_text_chunk_bytes=cfg.max_text_chunk_bytes,
            max_decompressed_text_bytes=cfg.max_decompressed_text_bytes,
        )
        if md.summary:
            return sanitize_for_json(md.summary)
        return None
    except Exception:
        return None



# Config routes


# User settings (disk-backed)

_SETTINGS_FILENAME = "sidebar_gallery_settings.json"


def _settings_path() -> Path:
    """Return the path to the user settings JSON file."""
    return Path(__file__).resolve().parents[1] / _SETTINGS_FILENAME


def _read_settings() -> dict:
    """Read settings from disk. Returns {} if file doesn't exist."""
    p = _settings_path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _write_settings(data: dict) -> None:
    """Write settings to disk atomically."""
    p = _settings_path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


# In-memory settings state. The file is a quarter megabyte dominated by
# layouts; reads answer from memory and writes serialize in the executor. The
# lock makes concurrent per-key posts (the page-hide beacons fire in parallel)
# a safe read-modify-write. An out-of-band edit to the file is picked up
# through the file signature on the next read.
_settings_lock = asyncio.Lock()
_settings_state: dict | None = None
_settings_state_sig: tuple | None = None


def _settings_file_sig() -> tuple | None:
    try:
        st = os.stat(_settings_path())
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


async def _settings_load_locked() -> dict:
    """Return the live settings dict. The caller holds _settings_lock."""
    global _settings_state, _settings_state_sig
    sig = _settings_file_sig()
    if _settings_state is None or sig != _settings_state_sig:
        loop = asyncio.get_running_loop()
        _settings_state = await loop.run_in_executor(_IO_EXECUTOR, _read_settings)
        _settings_state_sig = sig
    return _settings_state


async def _settings_write_locked() -> None:
    """Persist the live dict off the loop. The caller holds _settings_lock."""
    global _settings_state_sig
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(_IO_EXECUTOR, _write_settings, _settings_state)
    _settings_state_sig = _settings_file_sig()


async def _settings_replace_locked(data: dict) -> None:
    global _settings_state
    _settings_state = dict(data)
    await _settings_write_locked()


async def _json_dict_body(request: web.Request):
    """Decode the request body as a JSON object. Returns (dict, None) on
    success and (None, 400 response) otherwise, so a malformed request fails
    itself with a clear error instead of crashing the handler with a
    traceback that aiohttp turns into a 500."""
    try:
        body = await request.json()
    except Exception:
        return None, web.json_response({"error": "Invalid JSON"}, status=400)
    if not isinstance(body, dict):
        return None, web.json_response({"error": "Expected a JSON object"}, status=400)
    return body, None


@routes.get("/sidebar_gallery/settings")
async def get_settings(request: web.Request):
    """Return the full user settings JSON."""
    key = request.query.get("key")
    async with _settings_lock:
        settings = await _settings_load_locked()
        if key:
            # Keys are stored flat (literal), including dotted keys like "SBG.Layouts".
            return web.json_response({"key": key, "value": settings.get(key)})
        # Serialized inside the lock, so the response can never catch a
        # concurrent per-key mutation halfway.
        return web.json_response(settings)


@routes.post("/sidebar_gallery/settings")
async def post_settings(request: web.Request):
    """Update user settings.

    Body can be:
      {"key": "dotted.path", "value": <any>}   set a single key
      {"settings": {full object}}              replace entire settings

    Full replacement requires the explicit "settings" wrapper. The old
    third form, a bare object without "key", made any half-built payload
    (an empty object, a per-key body that lost its key) silently truncate
    every layout, keybinding and colour in the file; the shipped client
    never sent that shape, so it is refused rather than kept.
    """
    body, err = await _json_dict_body(request)
    if err is not None:
        return err

    if "key" in body and "value" in body:
        # Per-key update. Store the key literally (flat) without splitting on
        # dots, so "SBG.Layouts" is a top-level key the client reads back verbatim.
        async with _settings_lock:
            settings = await _settings_load_locked()
            settings[body["key"]] = body["value"]
            await _settings_write_locked()
        return web.json_response({"ok": True, "key": body["key"]})
    elif "settings" in body and isinstance(body["settings"], dict):
        # Full replacement with explicit "settings" key
        async with _settings_lock:
            await _settings_replace_locked(body["settings"])
        return web.json_response({"ok": True, "replaced": True})
    else:
        return web.json_response(
            {"error": "Expected {key, value} or {settings: {...}}"}, status=400)


# Index management



def _mark_parser_version_current():
    media_db.set_meta_value("parser_version", str(PARSER_VERSION))


def _root_parser_key(rid: str) -> str:
    return f"parser_version:{rid}"


def _configured_root_ids() -> set[str]:
    """Ids of every CONFIGURED root, offline ones included. The global parser
    stamp must cover the whole configuration: _all_roots drops folders that
    are offline right now, and a rebuild that never saw a folder must not be
    allowed to declare its rows current."""
    ids = {"output"}
    for raw in load_config().extra_roots:
        ids.add(_extra_root_id(raw)[0])
    return ids


def _maybe_stamp_global_parser_version():
    """Write the global stamp (the cheap startup short-circuit) only when
    every configured root carries the current per-root stamp. An offline
    folder keeps the global mismatch alive, while the per-root stamps let the
    next startup skip the folders already rebuilt instead of redoing the
    whole library until the offline one returns."""
    cur = str(PARSER_VERSION)
    for rid in _configured_root_ids():
        if media_db.get_meta_value(_root_parser_key(rid)) != cur:
            return
    _mark_parser_version_current()


def _start_full_reindex(roots: list[AllowedRoot]) -> bool:
    """Start a background full reindex over the given roots.

    Returns False if one is already running. Each root's parser stamp is
    written as that root completes; the global stamp is written only once
    every configured root (offline ones included) carries the current stamp,
    so an interrupted run resumes where it left off on the next startup and
    an unreachable folder keeps its stale rows flagged for re-extraction.
    """
    # Refuse while any scan runs (full rebuild or a root's first index):
    # full_reindex walks every root, so starting it during a first index of one
    # of them means two concurrent whole-library writers on the same root.
    if media_db.any_scan_running():
        return False

    def _bg_reindex():
        cfg = load_config()
        excluded = set(cfg.excluded_dirs)
        for root in roots:
            # The roots list is a snapshot from before the thread started. A
            # folder the user removes from config mid-run must be skipped:
            # rebuilding it would re-insert rows the purge just deleted, as
            # permanent orphans no endpoint can reach. Membership is
            # re-checked per root so the removal is seen whenever it lands.
            if root.root_id != "output" and root.root_id not in _configured_root_ids():
                logging.getLogger("sbg").info(
                    "SBG: skipping reindex of %s (removed from config)", root.root_id)
                continue
            try:
                media_db.full_reindex(
                    root, _read_metadata_for_db,
                    excluded_dirs=excluded,
                    index_hidden_dirs=cfg.index_hidden_dirs,
                )
                media_db.set_meta_value(_root_parser_key(root.root_id), str(PARSER_VERSION))
            except Exception as e:
                logging.getLogger("sbg").error("Reindex failed for %s: %s", root.root_id, e)
        _maybe_stamp_global_parser_version()

    threading.Thread(target=_bg_reindex, daemon=True).start()
    return True


@routes.post("/sidebar_gallery/rebuild_index")
async def rebuild_index(request: web.Request):
    """Start a full background reindex of all roots.

    Returns immediately. Frontend polls /reindex_progress for status.
    """
    roots = _all_roots()
    if not _start_full_reindex(roots):
        return web.json_response({"status": "already_running",
                                  "progress": media_db.get_progress()})
    return web.json_response({"status": "started", "roots": [r.root_id for r in roots]})


@routes.get("/sidebar_gallery/reindex_progress")
async def reindex_progress(request: web.Request):
    """Return scan/reindex progress, keyed per operation, for the frontend
    progress poller (sbg-core.js):
    {"running": <full rebuild running>, "full": {...}|null, "roots": {rid: {...}}}"""
    return web.json_response(media_db.get_progress())


@routes.get("/sidebar_gallery/config")
async def get_config(request: web.Request):
    cfg = load_config()
    roots = _all_roots()
    return _json_gz(
        {
            "extra_roots": cfg.extra_roots,
            "excluded_dirs": cfg.excluded_dirs,
            "index_hidden_dirs": cfg.index_hidden_dirs,
            "auto_refresh_interval_s": cfg.auto_refresh_interval_s,
            "roots": [{"id": r.root_id, "label": r.label, "path": r.path if r.root_id != "output" else None} for r in roots],
            # Catalog default titles keyed by section_id: lets the frontend
            # recognize layout-editor retitles for search-name resolution.
            "section_titles": schema.section_titles(),
        }
    )


# Strong references to fire-and-forget background tasks (asyncio keeps tasks
# only weakly; unreferenced ones can be garbage-collected before finishing).
_BG_TASKS: set = set()


async def _purge_removed_roots(root_ids: set[str]) -> None:
    """Background purge of roots removed from config: cancel + drain the root's
    in-flight scan first, wait out any full rebuild, then delete the rows
    off-loop. Failures are logged."""
    log = logging.getLogger("sbg")
    loop = asyncio.get_running_loop()
    # A full rebuild cannot be cancelled and would re-insert a purged root's
    # rows as orphans (nothing can list or sweep rows of an unconfigured
    # root). Purging after it ends is always clean: the rebuild worker also
    # skips roots that left the config, and even a root it already rewrote is
    # simply deleted here afterwards. The cap is a safety valve for a stuck
    # progress flag; an hour exceeds any observed rebuild by far.
    waited = 0.0
    while media_db.is_full_reindex_running() and waited < 3600.0:
        await asyncio.sleep(1.0)
        waited += 1.0
    if waited:
        log.info("SBG: purge waited %.0fs for a full rebuild to finish", waited)
    # The config may have changed during the wait: a root the user removed and
    # re-added while the rebuild ran is a live root again and must keep its rows.
    try:
        _still_roots = _configured_root_ids()
    except Exception:
        _still_roots = set()
    for rid in root_ids:
        if rid in _still_roots:
            log.info("SBG: skipping purge for re-added root %s", rid)
            continue
        handle = _inflight_scans.get(rid)
        if handle is not None and not handle.future.done():
            handle.cancel_event.set()
            await _await_scan(handle.future)
        try:
            n = await loop.run_in_executor(_SCAN_EXECUTOR, media_db.delete_root_rows, rid)
            if n:
                log.info("SBG: purged %d indexed row(s) for removed root %s", n, rid)
        except Exception:
            log.warning("SBG: failed to purge rows for removed root %s", rid, exc_info=True)


@routes.post("/sidebar_gallery/config")
async def post_config(request: web.Request):
    data, err = await _json_dict_body(request)
    if err is not None:
        return err

    # save_config stats any newly added root and the roots refresh stats every
    # configured one, so the whole read-save-refresh runs in the executor: a
    # slow share must not stall the event loop, and refreshing here (rather
    # than waiting for the TTL) makes the response's roots list reflect the
    # change the user just made.
    def _apply():
        old = load_config()
        saved = save_config(data)
        _refresh_roots()
        return old, saved

    loop = asyncio.get_running_loop()
    old_cfg, cfg = await loop.run_in_executor(_IO_EXECUTOR, _apply)

    # Purge index rows for extra roots removed from config, so a removed folder
    # does not linger in the index (or re-appear instantly when re-added).
    # Diffing old vs new config (not _all_roots) keeps a temporarily-offline
    # network root's rows intact; only genuinely removed roots are purged.
    # The purge runs as a background task: it first cancels + drains any in-flight
    # scan of the removed root (whose later batches would otherwise re-insert rows
    # after the purge, orphaning them forever), then deletes on a worker thread
    # rather than blocking the event loop on the SQLite DELETE.
    removed_ids = ({_extra_root_id(p)[0] for p in old_cfg.extra_roots}
                   - {_extra_root_id(p)[0] for p in cfg.extra_roots})
    if removed_ids:
        # Keep a strong reference: the event loop holds tasks only weakly, so
        # a bare create_task could be garbage-collected mid-purge.
        task = asyncio.create_task(_purge_removed_roots(removed_ids))
        _BG_TASKS.add(task)
        task.add_done_callback(_BG_TASKS.discard)

    roots = _all_roots()
    return web.json_response(
        {
            "extra_roots": cfg.extra_roots,
            "excluded_dirs": cfg.excluded_dirs,
            "index_hidden_dirs": cfg.index_hidden_dirs,
            "auto_refresh_interval_s": cfg.auto_refresh_interval_s,
            "roots": [{"id": r.root_id, "label": r.label, "path": r.path if r.root_id != "output" else None} for r in roots],
            "section_titles": schema.section_titles(),
        }
    )


# Subfolder listing


@routes.get("/sidebar_gallery/subfolders")
async def get_subfolders(request: web.Request):
    root_id = request.rel_url.query.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    raw_folders = media_db.get_subfolders(root_id)
    # Also add parent folders for full tree
    folders = set(raw_folders)
    for sf in raw_folders:
        parts = sf.split("/")
        for i in range(1, len(parts)):
            folders.add("/".join(parts[:i]))

    sorted_folders = sorted(folders)
    return _json_gz({"subfolders": sorted_folders})



# Full list for client-side caching

# Per-root cooldown for non-forced incremental scans (see list_all).
_last_scan_times: dict[str, float] = {}
_SCAN_COOLDOWN_S = 5.0
# The periodic poll schedules its background scan at the USER'S configured
# auto-refresh interval instead of a hidden constant, so the settings knob
# controls end-to-end freshness (a fixed cadence here would silently cap how
# fast outside changes can be detected, whatever the setting says).
# _SCAN_COOLDOWN_S stays as the floor. When auto-refresh is off (0), any stray
# poll falls back to this lazy cadence instead of scanning per request.
_POLL_SCAN_FALLBACK_S = 60.0

# In-flight incremental scans, keyed by root_id. The gallery's cold start does a
# fast read (rescan=false) immediately followed by a forced reconcile
# (rescan=true); tracking the in-flight scan lets a forced caller await the
# running scan instead of launching a second concurrent whole-library walk.
# Each entry carries the scan future plus a cancel event, so removing a root from
# config can stop its in-flight scan instead of racing it (which would let the
# scan's later batches re-insert orphan rows).
class _ScanHandle:
    __slots__ = ("future", "cancel_event")

    def __init__(self, future: asyncio.Future, cancel_event: threading.Event):
        self.future = future
        self.cancel_event = cancel_event


_inflight_scans: dict[str, _ScanHandle] = {}


def _clear_inflight_scan(fut: asyncio.Future, root_id: str) -> None:
    """Done-callback: drop the tracked handle once its scan finishes, but only if
    it's still the current one for this root, so a newer scan isn't cleared by mistake."""
    handle = _inflight_scans.get(root_id)
    if handle is not None and handle.future is fut:
        _inflight_scans.pop(root_id, None)


def _log_scan_failure(fut: asyncio.Future, root_id: str) -> None:
    """Done-callback: surface a background scan's failure. Several callers
    start a scan without awaiting it (the poll tick, the delta freshen, the
    unforced list), so an unobserved exception would otherwise appear only as
    a stray "exception was never retrieved" traceback at garbage collection,
    and a routine re-scan failing on an already-indexed root would leave no
    trace at all. Retrieving the exception here also covers the awaited
    callers at no cost."""
    if fut.cancelled():
        return
    exc = fut.exception()
    if exc is not None:
        logging.getLogger("sbg").warning(
            "SBG: background scan of %s failed: %s", root_id, exc)


async def _await_scan(fut):
    """Await a scan future, swallowing failures (best-effort: callers fall
    through to whatever the DB has). Returns the ScanResult or None."""
    if fut is None:
        return None
    try:
        return await fut
    except Exception:
        return None


def _maybe_scan(root, force: bool, interval_s: float | None = None):
    """Schedule (or reuse) a cooldown- and inflight-guarded incremental scan for a
    root and return its asyncio future so callers can await it. Returns None when no
    scan runs (a full reindex is in progress, or the root was scanned within the
    cooldown and this isn't a forced call). `interval_s` overrides the cooldown for
    callers with a slower cadence (the periodic poll). Shared by list_all, /poll and
    /list_new so no two callers start concurrent whole-library walks of the same
    root (which fight over the single SQLite writer and cause "database is locked")."""
    root_id = root.root_id
    if media_db.is_full_reindex_running():
        return None
    inflight = _inflight_scans.get(root_id)
    if inflight is not None and not inflight.future.done():
        return inflight.future  # a scan is already running for this root; reuse it
    now = time.time()
    cooldown = _SCAN_COOLDOWN_S if interval_s is None else interval_s
    recently_scanned = (now - _last_scan_times.get(root_id, 0)) < cooldown
    if not force and recently_scanned:
        return None
    _last_scan_times[root_id] = now
    cancel_event = threading.Event()
    loop = asyncio.get_running_loop()

    def _run():
        # Runs in the worker so the config open+parse stays off the event loop.
        _scan_cfg = load_config()
        # A root that never completed an index reports live progress (its first
        # index is long and user-visible); routine re-scans stay silent so the
        # auto-refresh poll never flashes the indicator.
        first_index = media_db.get_meta_value(f"indexed:{root_id}") is None
        # The parser stamp below is earned only when EVERY row was parsed by
        # the current parser, and a missing completion marker alone does not
        # prove that: an interrupted first index leaves rows without the
        # marker, and those rows may predate a parser upgrade. Only a scan
        # that starts from zero rows parses everything itself.
        fresh_root = first_index and media_db.get_count(root_id) == 0
        result = media_db.incremental_scan(
            root,
            read_metadata_fn=_read_metadata_for_db,
            excluded_dirs=set(_scan_cfg.excluded_dirs),
            index_hidden_dirs=_scan_cfg.index_hidden_dirs,
            report_progress=first_index,
            cancel_event=cancel_event,
        )
        # A completed scan of a FRESH root parsed every row with the current
        # parser, so the root earns its parser stamp; without it, a root added
        # after the last rebuild would read as stale on every startup mismatch
        # check and be rebuilt for nothing. Routine re-scans must not stamp:
        # they parse only changed files, so old rows keep old summaries. A
        # resumed partial first index does not stamp either; the startup
        # mismatch check rebuilds it once and stamps it then.
        if fresh_root and result.complete:
            media_db.set_meta_value(_root_parser_key(root_id), str(PARSER_VERSION))
            _maybe_stamp_global_parser_version()
        return result

    scan_future = loop.run_in_executor(_SCAN_EXECUTOR, _run)
    _inflight_scans[root_id] = _ScanHandle(scan_future, cancel_event)
    scan_future.add_done_callback(lambda f, _rid=root_id: _clear_inflight_scan(f, _rid))
    scan_future.add_done_callback(lambda f, _rid=root_id: _log_scan_failure(f, _rid))
    return scan_future


def _build_list_all(root, thumb_size):
    """Read rows for a root and build the list_all payload. Runs in a worker
    thread so the DB read + whole-library item build never block the event loop."""
    root_id = root.root_id
    # Version + rows from one SQLite snapshot: the stamp matches the row set even
    # while a background scan is committing (see get_all_with_version).
    db_version, db_items = media_db.get_all_with_version(root_id)
    rid_q = quote(root_id)
    out_items = []
    for row in db_items:
        relpath = row["relpath"]
        kind = row["kind"]
        rp_q = quote(relpath)

        thumb_url = _thumb_url(rid_q, rp_q, thumb_size, kind, row["mtime"] or row["ctime"])

        item = {
            "root_id": row["root_id"],
            "relpath": relpath,
            "filename": row["filename"],
            "subfolder": row["subfolder"],
            "ext": row["ext"],
            "kind": kind,
            "size": row["size"],
            "mtime": row["ctime"] or row["mtime"],  # Back-compat: default sort field (creation time)
            "ctime": row["ctime"] or row["mtime"],  # File creation time
            "mtime_real": row["mtime"] or row["ctime"],  # File modification time
            "thumb_url": thumb_url,
        }
        # Include dimensions for AR thumbnail layout (only when available)
        w, h = row.get("w"), row.get("h")
        if w and h:
            item["w"] = w
            item["h"] = h
        out_items.append(item)
    first_time = media_db.is_empty()
    return {
        "root": {"id": root.root_id, "label": root.label},
        "total": len(out_items),
        "items": out_items,
        "server_time": time.time(),
        "meta_epoch": media_db.get_meta_epoch(),
        "db_empty": first_time,
        # Per-root version from the same snapshot as the rows above.
        "db_version": db_version,
        "count": len(out_items),
    }


def _json_gz(payload):
    """web.json_response that gzip-compresses large bodies (aiohttp only compresses
    when the client advertises gzip). Applied to the medium endpoints (metadata,
    search, meta_keys); the multi-MB list payloads use the worker-side _encode_json
    path instead, since enable_compression() deflates synchronously on the event
    loop. Not applied to FileResponse (images/video), which is already compressed.
    zlib_executor offloads the deflate for bodies past 16 KB where supported."""
    try:
        # json_response() doesn't forward the zlib kwargs; Response does.
        resp = web.Response(text=json.dumps(payload), content_type="application/json",
                            zlib_executor_size=16 * 1024, zlib_executor=_ZLIB_EXECUTOR)
    except TypeError:  # older aiohttp without the zlib executor kwargs
        resp = web.json_response(payload)
    # The body depends on the client's Accept-Encoding, so caches must key on
    # it; _encoded_response declares the same.
    resp.headers["Vary"] = "Accept-Encoding"
    try:
        if resp.body is not None and len(resp.body) > 1400:
            resp.enable_compression()
    except Exception:
        pass
    return resp


def _encode_json(payload, accept_gzip: bool) -> tuple[bytes, bool]:
    """json.dumps + gzip, meant to run off the event loop (in a worker).
    For a large library's list_all payload (many megabytes), serializing and
    deflating on the loop stalls every websocket update and HTTP request
    ComfyUI serves."""
    body = json.dumps(payload).encode("utf-8")
    if accept_gzip and len(body) > 1400:
        return gzip.compress(body, 6), True
    return body, False


def _encoded_response(body: bytes, gz: bool) -> web.Response:
    headers = {"Vary": "Accept-Encoding"}
    if gz:
        headers["Content-Encoding"] = "gzip"
    return web.Response(body=body, content_type="application/json", headers=headers)


def _accepts_gzip(request: web.Request) -> bool:
    return "gzip" in (request.headers.get("Accept-Encoding") or "").lower()


def _build_list_all_encoded(root, thumb_size, accept_gzip):
    """Worker-side build + encode for /list_all in one executor hop.
    Returns (total_items, body_bytes, is_gzip)."""
    payload = _build_list_all(root, thumb_size)
    body, gz = _encode_json(payload, accept_gzip)
    return payload["total"], body, gz


@routes.get("/sidebar_gallery/list_all")
async def list_all_media(request: web.Request):
    """Return ALL items for a root_id from SQLite DB.

    Metadata is fetched on-demand via /metadata endpoint (cached in IndexedDB).
    On first call (empty DB), triggers incremental scan.
    """
    root_id = request.rel_url.query.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    force = request.rel_url.query.get("rescan") in {"1", "true", "yes"}
    thumb_size = _clamped_int(request.rel_url.query.get("thumb_size"), 512)

    # Read DB immediately for instant gallery display; a forced rescan waits for
    # the scan to finish, a normal call lets it complete in the background. A short
    # cooldown skips redundant background walks when several tabs/remounts hit
    # list_all in quick succession. Scheduling is centralised in _maybe_scan (shared
    # with /poll) so two callers can never launch two concurrent whole-library walks.
    reindexing = media_db.is_full_reindex_running()
    scan_future = _maybe_scan(root, force)
    if force:
        await _await_scan(scan_future)  # wait so the response reflects the rescan

    loop = asyncio.get_running_loop()
    accept_gzip = _accepts_gzip(request)
    total, body, gz = await loop.run_in_executor(
        None, _build_list_all_encoded, root, thumb_size, accept_gzip)

    # First-ever open of a freshly added root: the background scan may not have
    # finished, so a non-forced caller would get an empty list. Wait for that
    # in-flight scan once and rebuild, so opening a new folder fills in.
    if not force and not reindexing and total == 0:
        pending = _inflight_scans.get(root_id)
        if pending is not None and not pending.future.done():
            await _await_scan(pending.future)
            total, body, gz = await loop.run_in_executor(
                None, _build_list_all_encoded, root, thumb_size, accept_gzip)

    return _encoded_response(body, gz)


@routes.get("/sidebar_gallery/poll")
async def poll_changes(request: web.Request) -> web.Response:
    """Cheap change-check for a root: answers from the DB immediately and runs the
    incremental scan in the background, so a periodic tick never pays the
    directory-walk cost (a background scan's version bump is picked up next
    tick). A focus-return poll (`eager=1`) awaits a snappy-cooldown scan so
    returning to the tab reconciles external changes in one round trip."""
    root_id = request.rel_url.query.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)
    eager = request.rel_url.query.get("eager") in {"1", "true", "yes"}
    if eager:
        await _await_scan(_maybe_scan(root, force=False))
    else:
        # Auto-refresh interval as the scan cadence (0 = off, lazy fallback for
        # stray polls), floored at the snappy cooldown.
        refresh_s = float(load_config().auto_refresh_interval_s) or _POLL_SCAN_FALLBACK_S
        _maybe_scan(root, force=False,
                    interval_s=max(_SCAN_COOLDOWN_S, refresh_s))  # fire and forget
    loop = asyncio.get_running_loop()
    # Version/count/epoch each open a short-lived sqlite connection; keep those
    # PRAGMA+SELECT round-trips off the event loop.
    version, count = await loop.run_in_executor(
        None, lambda: (media_db.get_root_version(root_id), media_db.get_count(root_id)))
    return web.json_response({
        # Per-root version + row count. The count is a cheap (indexed COUNT(*))
        # invariant: the client refetches when versions match but its item count
        # differs, self-healing any version stamp recorded against a view that
        # missed an add/delete.
        "db_version": version,
        "count": count,
        # Lets the delta-first client drop stale metadata caches without ever
        # needing a full list_all.
        "meta_epoch": media_db.get_meta_epoch(),
        "reindexing": media_db.is_full_reindex_running(),
        "server_time": time.time(),
    })


# Delta list (new files only)


def _process_new_files(root, root_id: str, files: list, thumb_size: int) -> list[dict]:
    """files[]-form worker: stat each reported file, parse its metadata,
    upsert it, and build its response item. Runs on _IO_EXECUTOR because the
    metadata parse alone can take tens of ms per file."""
    out_items: list[dict] = []
    conn = media_db._get_conn()
    try:
        for f in files:
            fname = f.get("filename", "")
            subfolder = (f.get("subfolder") or "").replace("\\", "/")
            ftype = f.get("type", "output")
            if ftype != "output" and root_id == "output":
                continue

            relpath = f"{subfolder}/{fname}" if subfolder else fname
            try:
                full = safe_join(root.path, relpath)
            except ValueError:
                continue
            if not os.path.isfile(full):
                continue

            ext = os.path.splitext(fname)[1].lower()
            kind = "video" if ext in VIDEO_EXTS else "image"
            try:
                st = os.stat(full)
            except OSError:
                continue

            # Normalize to a path relative to the root. Some save nodes report an
            # absolute subfolder in the `executed` event, which would otherwise be
            # stored as an absolute relpath (breaking filename display and making
            # the next rescan treat it as a stale/duplicate entry).
            relpath = os.path.relpath(full, root.path).replace("\\", "/")
            size = int(st.st_size)
            mtime = float(st.st_mtime)
            ctime = float(st.st_ctime)

            # Read metadata and insert into DB
            meta_dict = _read_metadata_for_db(full)
            meta_json = json.dumps(meta_dict) if meta_dict else None
            media_db.upsert_file(conn, root_id, relpath, ext, kind, size, mtime, meta_json, ctime=ctime)

            rid_q = quote(root.root_id)
            rp_q = quote(relpath)
            thumb_url = _thumb_url(rid_q, rp_q, thumb_size, kind, mtime)
            has_thumb = False

            try:
                tp = (_image_thumb_path(full, thumb_size) if kind == "image"
                      else _video_thumb_path(full, thumb_size))
                has_thumb = tp.exists()
            except Exception:
                pass

            item = {
                "root_id": root_id,
                "relpath": relpath,
                "filename": os.path.basename(relpath),
                "subfolder": os.path.dirname(relpath).replace("\\", "/"),
                "ext": ext,
                "kind": kind,
                "size": size,
                "mtime": ctime,  # Back-compat: default sort field (creation time)
                "ctime": ctime,
                "mtime_real": mtime,
                "thumb_url": thumb_url,
                "has_thumb": has_thumb,
            }
            # Include dimensions for aspect-ratio thumbnail layout so newly
            # generated items don't render as zoomed squares.
            try:
                _w = meta_dict.get("width") if isinstance(meta_dict, dict) else None
                _h = meta_dict.get("height") if isinstance(meta_dict, dict) else None
                if _w and _h:
                    item["w"] = _w
                    item["h"] = _h
            except Exception:
                pass
            out_items.append(item)

        conn.commit()
    finally:
        conn.close()
    return out_items


def _build_since_items(root, thumb_size: int, since: float) -> list[dict]:
    """since-form worker: build response items for every DB row newer than
    `since`. Runs on _IO_EXECUTOR because after a long absence this can be
    thousands of items. The mtime filter runs in SQL (idx_root_mtime), so the
    routine few-item delta reads a few rows instead of dragging the whole
    table (and its metadata json_extract) through Python first."""
    out_items: list[dict] = []
    rid_q = quote(root.root_id)
    for row in media_db.get_rows_since(root.root_id, since):
        relpath = row["relpath"]
        kind = row["kind"]
        rp_q = quote(relpath)
        item = {
            "root_id": row["root_id"],
            "relpath": relpath,
            "filename": row["filename"],
            "subfolder": row["subfolder"],
            "ext": row["ext"],
            "kind": kind,
            "size": row["size"],
            "mtime": row["ctime"] or row["mtime"],  # Back-compat: default sort field (creation time)
            "ctime": row["ctime"] or row["mtime"],
            "mtime_real": row["mtime"] or row["ctime"],
            "thumb_url": _thumb_url(rid_q, rp_q, thumb_size, kind, row["mtime"] or row["ctime"]),
            "has_thumb": False,
        }
        _w, _h = row.get("w"), row.get("h")
        if _w and _h:
            item["w"] = _w
            item["h"] = _h
        out_items.append(item)
    return out_items


@routes.post("/sidebar_gallery/list_new")
async def list_new_media(request: web.Request):
    """Return newly-generated files, insert them into DB with inline metadata."""
    body, err = await _json_dict_body(request)
    if err is not None:
        return err
    root_id = body.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    thumb_size = _clamped_int(body.get("thumb_size"), 512)

    files = body.get("files")  # [{filename, subfolder, type}, ...]
    removed_relpaths: list[str] = []
    stale = False  # since-form only: True when removals can't be answered
    stamp_version: int | None = None
    loop = asyncio.get_running_loop()

    if files and isinstance(files, list):
        # Per-file stat + full metadata parse + upsert is real disk/CPU work, so
        # run it off the event loop.
        out_items = await loop.run_in_executor(
            _IO_EXECUTOR, _process_new_files, root, root_id, files, thumb_size)
    else:
        # Delta fallback (poll-driven reconcile or warm remount). The DB is as
        # fresh as the version bump that triggered the caller.
        since = float(body.get("since", 0))
        known_version = body.get("known_version")
        _maybe_scan(root, force=False)  # background freshen; nothing awaits it
        # The version this response stamps is read BEFORE the removals, so it
        # can never run ahead of the removals snapshot. A bump landing between
        # the two reads is then re-delivered on the next poll; the reverse
        # ordering let a client stamp a version whose removals it never saw
        # and keep a ghost card until a consistency check.
        stamp_version = await loop.run_in_executor(
            None, media_db.get_root_version, root_id)
        # Deletions come from the in-memory removals buffer: deterministic for
        # any version within this process's lifetime. When the client's version
        # predates it, flag the response so the client does one full refetch.
        if isinstance(known_version, int):
            removals = await loop.run_in_executor(
                None, media_db.get_removals_since, root_id, known_version)
            if removals is None:
                stale = True
            else:
                removed_relpaths = removals
        # Return all items newer than `since` from DB (frontend will diff)
        out_items = await loop.run_in_executor(
            _IO_EXECUTOR, _build_since_items, root, thumb_size, since)

    payload = {
        "root": {"id": root.root_id, "label": root.label},
        "new_count": len(out_items),
        "items": out_items,
        # Relpaths deleted since the client's known_version (since-form; the
        # files[] form never deletes). Lets the client reconcile removals
        # through the delta path instead of absorbing them into the version stamp.
        "removed": removed_relpaths,
        # True when removals could not be determined for the client's version:
        # the client must do a full refetch instead of trusting this delta.
        "stale": stale,
        "server_time": time.time(),
        "db_version": stamp_version if stamp_version is not None
        else media_db.get_root_version(root_id),
        "count": media_db.get_count(root_id),
        "meta_epoch": media_db.get_meta_epoch(),
    }
    if len(out_items) > 200:
        # A big delta (long absence) serializes + compresses off-loop like
        # list_all; the typical few-item delta stays on the cheap inline path.
        body_bytes, gz = await loop.run_in_executor(
            _IO_EXECUTOR, _encode_json, payload, _accepts_gzip(request))
        return _encoded_response(body_bytes, gz)
    return _json_gz(payload)


# Metadata


@routes.get("/sidebar_gallery/metadata")
async def get_metadata(request: web.Request):
    cfg = load_config()
    root_id = request.rel_url.query.get("root_id", "output")
    relpath = request.rel_url.query.get("relpath", "")
    summary_only = request.rel_url.query.get("summary_only") in {"1", "true"}
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    relpath_clean = relpath.replace("\\", "/")

    # Fast path: summary_only (DB only, zero disk I/O)
    if summary_only:
        db_row = media_db.get_file(root_id, relpath_clean)
        if db_row and db_row.get("metadata_json"):
            try:
                summary = json.loads(db_row["metadata_json"])
            except Exception:
                summary = {}
            # Gzipped like the endpoint's disk branch: this is the HOT branch
            # (every lightbox navigation and prefetch reads it).
            return _json_gz({
                "file": {
                    "root_id": root_id,
                    "relpath": relpath_clean,
                    "filename": os.path.basename(relpath_clean),
                    "size": db_row["size"] if db_row else 0,
                    "mtime": db_row["mtime"] if db_row else 0,
                },
                "summary": summary,
            })
        # DB has no metadata (new image not yet indexed), so fall through to disk read

    # Full path: read from disk (for Copy Workflow, Raw JSON)
    try:
        full = safe_join(root.path, relpath)
    except ValueError:
        return web.Response(status=400)
    if not os.path.isfile(full):
        return web.Response(status=404)

    st = os.stat(full)
    # Parse off the event loop: a pathological file can make the parser burn
    # seconds of CPU, and on the loop that would freeze every other request
    # and the ComfyUI websocket for the duration.
    loop = asyncio.get_running_loop()
    md = await loop.run_in_executor(
        _IO_EXECUTOR,
        lambda: read_metadata_for_file(
            full,
            max_text_chunk_bytes=cfg.max_text_chunk_bytes,
            max_decompressed_text_bytes=cfg.max_decompressed_text_bytes,
        ),
    )

    # Prefer DB summary if available (already parsed during indexing)
    db_row = media_db.get_file(root_id, relpath_clean)
    summary = md.summary
    if db_row and db_row.get("metadata_json"):
        try:
            summary = json.loads(db_row["metadata_json"])
        except Exception:
            pass

    result = {
        "file": {
            "root_id": root.root_id,
            "relpath": relpath_clean,
            "filename": os.path.basename(relpath_clean),
            "size": int(st.st_size),
            "mtime": float(st.st_mtime),
        },
        "prompt": md.prompt,
        "workflow": md.workflow,
        "summary": summary,
        "parsed": md.parsed,
        "raw_text": md.raw_text,
    }

    # Store parsed metadata back to DB for new/unindexed files (future fast path).
    # Three cases:
    #  - row missing entirely: index it (a real change, bumps the version);
    #  - row exists, parse found metadata: backfill it (real change);
    #  - row exists, parse found nothing: only stamp meta_mtime ("tried, file has
    #    none") without a version bump, and only once, so repeated lightbox views
    #    don't bump the version and trigger a full re-download while browsing.
    # These are sqlite WRITES: run them off the event loop, or a scan holding
    # the write lock would freeze every in-flight request (and the ComfyUI
    # websocket) for up to the busy-wait while this handler blocks on it.
    def _backfill():
        try:
            if not db_row:
                _ext = os.path.splitext(relpath_clean)[1].lower()
                _kind = "video" if _ext in VIDEO_EXTS else "image"
                with media_db._get_conn() as _conn:
                    media_db.upsert_file(_conn, root_id, relpath_clean, _ext, _kind,
                                         int(st.st_size), float(st.st_mtime),
                                         json.dumps(summary) if summary else None,
                                         ctime=float(st.st_ctime))
            elif not db_row.get("metadata_json"):
                if summary:
                    _ext = os.path.splitext(relpath_clean)[1].lower()
                    _kind = "video" if _ext in VIDEO_EXTS else "image"
                    with media_db._get_conn() as _conn:
                        media_db.upsert_file(_conn, root_id, relpath_clean, _ext, _kind,
                                             int(st.st_size), float(st.st_mtime),
                                             json.dumps(summary),
                                             ctime=float(st.st_ctime))
                elif not db_row.get("meta_mtime"):
                    media_db.mark_meta_attempted(root_id, relpath_clean)
        except Exception:
            pass

    await asyncio.get_running_loop().run_in_executor(None, _backfill)

    return _json_gz(sanitize_for_json(result))


@routes.get("/sidebar_gallery/metadata_ondemand")
async def get_metadata_ondemand(request: web.Request):
    """Read metadata on-demand from a file path (e.g. ComfyUI input directory).

    Unlike /metadata, this does NOT require the file to be in an indexed root.
    Used for initial image metadata display.
    """
    cfg = load_config()
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "")
    ftype = request.rel_url.query.get("type", "input")

    if not filename:
        return web.Response(status=400, text="Missing filename")

    # Resolve the file path based on type
    try:
        if ftype == "input":
            base_dir = folder_paths.get_input_directory()
        elif ftype == "output":
            base_dir = folder_paths.get_output_directory()
        elif ftype == "temp":
            base_dir = folder_paths.get_temp_directory()
        else:
            return web.Response(status=400, text="Invalid type")

        if subfolder:
            full = safe_join(base_dir, os.path.join(subfolder, filename))
        else:
            full = safe_join(base_dir, filename)
    except ValueError:
        return web.Response(status=400, text="Invalid path")

    if not os.path.isfile(full):
        return web.Response(status=404, text="File not found")

    try:
        st = os.stat(full)
        # Parse off the event loop (see /metadata): a pathological file must
        # not freeze every other request while it is read.
        loop = asyncio.get_running_loop()
        md = await loop.run_in_executor(
            _IO_EXECUTOR,
            lambda: read_metadata_for_file(
                full,
                max_text_chunk_bytes=cfg.max_text_chunk_bytes,
                max_decompressed_text_bytes=cfg.max_decompressed_text_bytes,
            ),
        )
        result = {
            "file": {
                "filename": filename,
                "subfolder": subfolder,
                # relpath so the Initial Image panel's Path row renders like
                # the indexed-file branch's.
                "relpath": f"{subfolder}/{filename}" if subfolder else filename,
                "type": ftype,
                "size": int(st.st_size),
                "mtime": float(st.st_mtime),
            },
            "summary": md.summary or {},
        }
        return _json_gz(sanitize_for_json(result))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# File serving


@routes.get("/sidebar_gallery/file")
async def get_file(request: web.Request):
    root_id = request.rel_url.query.get("root_id", "output")
    relpath = request.rel_url.query.get("relpath", "")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    try:
        full = safe_join(root.path, relpath)
    except ValueError:
        return web.Response(status=400)
    if not os.path.isfile(full):
        return web.Response(status=404)

    # Strip characters that would break the quoted header value.
    filename = os.path.basename(full).replace('"', "").replace("\r", "").replace("\n", "")
    content_type = guess_mime(full)
    if content_type in {"text/html", "application/xhtml+xml", "text/javascript", "text/css", "image/svg+xml"}:
        content_type = "application/octet-stream"


    # Images get long-lived immutable caching; videos do not. The URL is
    # content-addressed (&v=<mtime ms>), so a regenerated file resolves to a
    # fresh URL and an immutable entry can never mask an updated one, making
    # image revisits, prefetch, and tab-back instant with zero network. Two
    # guards bound the risk:
    #
    # 1. Videos keep "no-cache": a <video> load aborted mid-download can cache a
    #    truncated body, which immutable would then pin forever (the on-disk
    #    file is fine, so &v= never changes to bust it). This is specific to
    #    media/Range requests; a cut-off <img> GET is stored as partial and
    #    resumed. no-cache still stores the video but forces a cheap 304
    #    revalidation so a bad entry can't stick.
    # 2. Images go immutable only when the URL's &v= matches the file's CURRENT
    #    mtime, so a file still flushing to disk (moving mtime) can never cache a
    #    truncated read as immutable. int() here matches fileUrl()'s
    #    Math.floor(mtime * 1000): the same float64, truncated.
    is_image = content_type.startswith("image/")
    try:
        v_matches = request.rel_url.query.get("v", "") == str(int(os.stat(full).st_mtime * 1000))
    except OSError:
        v_matches = False
    cache_control = "public, max-age=31536000, immutable" if (is_image and v_matches) else "no-cache"
    return web.FileResponse(
        full,
        headers={
            "Content-Disposition": f"filename=\"{filename}\"",
            "Content-Type": content_type,
            "Cache-Control": cache_control,
        },
    )


# Image preview (cached thumbnails)


@routes.get("/sidebar_gallery/preview")
async def get_preview(request: web.Request):
    root_id = request.rel_url.query.get("root_id", "")
    relpath = request.rel_url.query.get("relpath", "")
    size = request.rel_url.query.get("size", "256")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    try:
        full = safe_join(root.path, relpath)
    except ValueError:
        return web.Response(status=400)
    if not os.path.isfile(full):
        return web.Response(status=404)

    ext = os.path.splitext(full)[1].lower()
    if ext not in IMAGE_EXTS:
        return web.Response(status=404)

    target = _clamped_int(size, 256)

    # Check disk cache first
    cached = _image_thumb_path(full, target)
    if not cached.exists():
        # Generate on a worker thread so PIL decode/encode never blocks the
        # ComfyUI event loop (matches the list_all_media scan pattern).
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(_IO_EXECUTOR, lambda: _generate_image_thumbnail(full, cached, target))

    if cached.exists():
        return web.FileResponse(
            str(cached),
            headers={
                "Content-Type": "image/jpeg",
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )

    # Fallback: serve original file
    try:
        return web.FileResponse(full)
    except Exception:
        return web.Response(status=500)


# Video thumbnail serving


@routes.get("/sidebar_gallery/video_thumb")
async def get_video_thumb(request: web.Request):
    root_id = request.rel_url.query.get("root_id", "")
    relpath = request.rel_url.query.get("relpath", "")
    size = _clamped_int(request.rel_url.query.get("size"), 256)

    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    try:
        full = safe_join(root.path, relpath)
    except ValueError:
        return web.Response(status=400)
    if not os.path.isfile(full):
        return web.Response(status=404)

    tp = _video_thumb_path(full, size)
    if not tp.exists():
        # ffmpeg can run for up to 20s (see _generate_video_thumbnail's
        # timeout); the async gate queues excess requests on the event loop and
        # the worker thread keeps the loop responsive while ffmpeg runs.
        ok = await _video_thumb_off_loop(full, tp, size)
        if not ok:
            return web.Response(status=404)

    return web.FileResponse(
        str(tp),
        headers={
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# On-demand thumbnail generation


@routes.post("/sidebar_gallery/generate_thumb")
async def generate_thumb(request: web.Request) -> web.Response:
    """Generate a thumbnail on demand and return it."""
    body, err = await _json_dict_body(request)
    if err is not None:
        return err
    root_id = body.get("root_id", "")
    relpath = body.get("relpath", "")
    kind = body.get("kind", "image")
    size = _clamped_int(body.get("size"), 512)

    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    try:
        full = safe_join(root.path, relpath)
    except ValueError:
        return web.Response(status=400)
    if not os.path.isfile(full):
        return web.Response(status=404)

    # Generate off the event loop: ffmpeg/PIL are blocking and the video
    # path can take seconds (see the GET handlers above).
    loop = asyncio.get_running_loop()
    if kind == "video":
        tp = _video_thumb_path(full, size)
        ok = await _video_thumb_off_loop(full, tp, size)
    else:
        tp = _image_thumb_path(full, size)
        ok = await loop.run_in_executor(_IO_EXECUTOR, lambda: _generate_image_thumbnail(full, tp, size))

    if ok and tp.exists():
        return web.FileResponse(
            str(tp),
            headers={
                "Content-Type": "image/jpeg",
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )
    return web.Response(status=500)



# Metadata search (reads from the DB, no in-memory cache needed)




# Search matching lives in server/search.py (match_item / match_summary), a
# pure, unit-tested module decoupled from this ComfyUI-coupled route handler.



@routes.get("/sidebar_gallery/db_version")
async def get_db_version(request: web.Request) -> web.Response:
    """Return a DB version counter: per-root when ?root_id= is given (matches
    the /poll and /list_all stamps), otherwise the global aggregate."""
    root_id = request.rel_url.query.get("root_id")
    if root_id:
        return web.json_response({"version": media_db.get_root_version(root_id)})
    return web.json_response({"version": media_db.get_db_version()})


@routes.get("/sidebar_gallery/status")
async def get_status(request: web.Request) -> web.Response:
    """Return index counts and thumbnail info."""
    roots = _all_roots()
    index_counts: dict[str, int] = {}

    for root in roots:
        index_counts[root.root_id] = media_db.get_count(root.root_id)

    # Thumbnail stats
    thumb_count = 0
    thumb_bytes = 0
    try:
        for f in _THUMB_DIR.iterdir():
            if f.suffix == ".jpg":
                thumb_count += 1
                try:
                    thumb_bytes += f.stat().st_size
                except OSError:
                    pass
    except Exception:
        pass

    # DB file stats
    db_path = str(media_db._DB_PATH)
    db_size_mb = 0.0
    try:
        db_size_mb = round(float(media_db._DB_PATH.stat().st_size) / (1024 * 1024), 2)
    except OSError:
        pass

    return web.json_response({
        "index": {
            "counts": index_counts,
            "db_path": db_path,
            "db_size_mb": db_size_mb,
        },
        "thumbnails": {
            "count": thumb_count,
            "size_mb": round(float(thumb_bytes) / (1024 * 1024), 1),
            "path": str(_THUMB_DIR),
        },
        # Surfaces missing ffmpeg (no video thumbnails without it) so the UI can warn
        # instead of serving broken video thumbnails.
        "ffmpeg_available": _find_ffmpeg() is not None,
    })


def _run_search(root_id, tags, mode, relpaths_filter):
    """CPU-bound metadata scan. Runs in a worker thread (run_in_executor)
    so a full-library search never blocks the ComfyUI event loop."""
    # Read from the DB: all metadata is already stored as JSON
    if relpaths_filter and isinstance(relpaths_filter, list):
        # Delta search: only check specific items (near-instant)
        db_rows = media_db.get_items_with_metadata(root_id, relpaths_filter)
    else:
        db_rows = media_db.get_all_with_metadata(root_id)
    total = len(db_rows)

    matches = []
    scanned = 0

    for row in db_rows:
        scanned += 1
        meta_json = row.get("metadata_json")
        relpath = row.get("relpath", "")

        s = None
        if meta_json:
            try:
                s = json.loads(meta_json)
            except Exception:
                pass

        matched_fields = match_item(s, relpath, tags, mode)
        if matched_fields is not None:
            matches.append({"relpath": relpath, "matched_fields": matched_fields})
    return {"matches": matches, "scanned": scanned, "total": total}


@routes.post("/sidebar_gallery/search")
async def search_metadata(request: web.Request) -> web.Response:
    """Search through metadata stored in SQLite DB using multi-tag AND/OR logic.

    Reads metadata_json from DB rows (zero disk I/O). The scan runs on a worker
    thread so a full-library search never blocks the ComfyUI event loop.
    """
    body, err = await _json_dict_body(request)
    if err is not None:
        return err
    root_id = body.get("root_id", "output")
    tags = body.get("tags", [])
    mode = body.get("mode", "AND").upper()

    # Backwards compatibility check
    if not tags and "value" in body:
        tags = [{"field": body.get("field", "any").lower(), "value": body.get("value", "").lower()}]

    if not tags:
        return web.json_response({"matches": []})

    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    # Optional: filter to specific relpaths (for delta search during active search)
    relpaths_filter = body.get("relpaths")  # list of relpaths to check, or None for full search
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(_IO_EXECUTOR, _run_search, root_id, tags, mode, relpaths_filter)
    return _json_gz(result)


# Theme Presets

_THEMES_DIR = Path(__file__).resolve().parents[1] / "themes"
_THEMES_DIR.mkdir(exist_ok=True)


@routes.get("/sidebar_gallery/presets")
async def _list_presets(request: web.Request) -> web.Response:
    """List all preset JSON files in the themes directory."""
    presets = []
    for f in sorted(_THEMES_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            presets.append({
                "filename": f.name,
                "name": data.get("name", f.stem),
                "created": data.get("created"),
            })
        except Exception:
            presets.append({"filename": f.name, "name": f.stem, "created": None})
    return web.json_response({"presets": presets})


@routes.get("/sidebar_gallery/preset")
async def _get_preset(request: web.Request) -> web.Response:
    """Return the full JSON content of a specific preset file."""
    filename = request.rel_url.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "Missing filename"}, status=400)

    # Sanitize: only allow .json files in the themes dir
    safe = "".join(c for c in filename if c.isalnum() or c in " -_.").strip()
    filepath = _THEMES_DIR / safe
    if not filepath.exists() or filepath.suffix != ".json":
        return web.Response(status=404)

    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/sidebar_gallery/presets")
async def _save_preset(request: web.Request) -> web.Response:
    """Save or delete a preset JSON file."""
    body, err = await _json_dict_body(request)
    if err is not None:
        return err
    action = body.get("action", "save")
    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "Missing preset name"}, status=400)

    # Sanitize filename
    safe_name = "".join(c for c in name if c.isalnum() or c in " -_").strip()
    if not safe_name:
        return web.json_response({"error": "Invalid preset name"}, status=400)

    filepath = _THEMES_DIR / f"{safe_name}.json"

    if action == "delete":
        if filepath.exists():
            filepath.unlink()
        return web.json_response({"ok": True})

    # Save
    data = body.get("data", {})
    data["name"] = name
    if "created" not in data:
        data["created"] = int(time.time() * 1000)
    filepath.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return web.json_response({"ok": True, "filename": f"{safe_name}.json"})


# Layout Editor: all unique metadata keys

@routes.get("/sidebar_gallery/meta_keys")
async def get_meta_keys(request: web.Request):
    """Return all unique metadata section/param keys across indexed files."""
    # Full-library aggregate (cached by db_version in get_all_meta_keys); run off
    # the event loop since the first call after a change re-scans every row.
    loop = asyncio.get_running_loop()
    keys = await loop.run_in_executor(_SCAN_EXECUTOR, media_db.get_all_meta_keys)
    # Decorate a COPY: get_all_meta_keys returns its cached dict, and writing
    # into that would graft these catalog keys onto the shared cache outside
    # its lock.
    keys = dict(keys)
    # Catalog-derived: top-level keys the layout editor must not offer as
    # bindable paths (list/object sections + list/bool flags).
    keys["non_bindable"] = sorted(schema.non_bindable_summary_keys())
    # Per-element keys inside array sections that must not be offered either.
    keys["non_bindable_element"] = schema.non_bindable_element_keys()
    return _json_gz(keys)


# Parser-version reindex
# Summaries are cached per-file in the DB, so a parser upgrade does nothing for
# already-indexed files until they are re-extracted. On startup, if the stored
# parser version doesn't match, kick off a background re-extraction (the gallery
# stays usable). Per-root stamps narrow the work: only roots not yet rebuilt
# under the current parser are walked, so an interrupted run resumes with the
# remaining roots and a folder that was offline during a rebuild is retried by
# itself once it is reachable again.
def _check_parser_version():
    try:
        stored = media_db.get_meta_value("parser_version")
        if stored == str(PARSER_VERSION):
            return
        if not media_db.has_any_files():
            _mark_parser_version_current()
            return
        cur = str(PARSER_VERSION)
        stale = [r for r in _all_roots()
                 if media_db.get_meta_value(_root_parser_key(r.root_id)) != cur]
        if not stale:
            # Every reachable root is already rebuilt; the global stamp is
            # still withheld while a configured folder stays offline.
            _maybe_stamp_global_parser_version()
            return
        if _start_full_reindex(stale):
            logging.getLogger("sbg").info(
                "[SBG] Metadata parser updated (v%s to v%s): re-extracting %d root(s) in the background",
                stored or "?", PARSER_VERSION, len(stale))
    except Exception as e:
        logging.getLogger("sbg").warning("[SBG] Parser-version check failed: %s", e)


async def _run_parser_version_check(_app):
    # The check builds the roots list (a stat per configured extra root) and
    # reads the DB, so it runs in the scan executor: an offline network share
    # must never stall the loop while every startup hook queues behind it.
    await asyncio.get_running_loop().run_in_executor(
        _SCAN_EXECUTOR, _check_parser_version)


def _schedule_parser_version_check():
    """Defer the version check until ComfyUI has loaded every node pack.

    This module imports while custom nodes are still being loaded, and a
    re-extraction started that early parses files against a partially
    populated NODE_CLASS_MAPPINGS: every class from a pack that loads later
    reads as unknown, so link resolution falls back to the legacy path and
    can capture an unrelated upstream literal. The web application starts
    serving only after all packs are loaded, so its startup hook is the
    earliest safe moment. Appending to a started application's hooks raises,
    in which case the check runs immediately, and the registry is complete
    in that situation too.
    """
    try:
        server.PromptServer.instance.app.on_startup.append(_run_parser_version_check)
    except Exception as e:
        # Make the fallback visible: if this fires for any reason other than
        # an already-started application, the check is running before every
        # node pack has loaded and the log line is the only trace.
        logging.getLogger("sbg").warning(
            "[SBG] parser version check could not defer to the startup hook"
            " (%s); running it now", e)
        _check_parser_version()


_schedule_parser_version_check()
