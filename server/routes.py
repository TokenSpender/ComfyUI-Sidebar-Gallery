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

from .config import load_config, save_config
from .db import IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, MESH_EXTS
from . import db as media_db
from .metadata import PARSER_VERSION, read_metadata_for_file, guess_mime, sanitize_for_json
from .search import match_summary
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


routes = server.PromptServer.instance.routes


def _clamped_int(val: Any, fallback: int, lo: int = 64, hi: int = 1024) -> int:
    """Parse a query/body value to an int clamped to [lo, hi]; never raises."""
    try:
        n = int(val)
    except (TypeError, ValueError):
        n = fallback
    return max(lo, min(hi, n))


# ── Thumbnail cache directory ─────────────────────────────────────────

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
    if kind == "audio":
        return f"/sidebar_gallery/audio_waveform?root_id={rid_q}&relpath={rp_q}&size={size}&v={v}"
    if kind == "mesh":
        return f"/sidebar_gallery/mesh_thumb?root_id={rid_q}&relpath={rp_q}&size={size}&v={v}"
    return None


# Cap concurrent ffmpeg thumbnail jobs. During a full reindex the CPU is
# saturated; unbounded parallel ffmpeg spawns then time out en masse, producing
# waves of broken video thumbnails.
_FFMPEG_SEM = threading.Semaphore(2)

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


# ── Root helpers ──────────────────────────────────────────────────────


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


def _all_roots() -> list[AllowedRoot]:
    cfg = load_config()
    roots = [_output_root()]
    for raw in cfg.extra_roots:
        rid, p = _extra_root_id(raw)
        if os.path.isdir(p):
            roots.append(AllowedRoot(root_id=rid, label=os.path.basename(p) or p, path=p))
    return roots


def _find_root(root_id: str) -> AllowedRoot | None:
    for r in _all_roots():
        if r.root_id == root_id:
            return r
    return None


# ── DB-backed metadata reader helper ──────────────────────────────────

def _read_metadata_for_db(full_path: str) -> dict | None:
    """Read metadata from a file and return only the compact summary dict.

    Stores only the parsed summary (~1-5 KB), not the full prompt, workflow,
    parsed, or raw_text blobs which can be 50-200 KB each.
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



# ── Config routes ─────────────────────────────────────────────────────


# ── User settings (disk-backed) ──────────────────────────────────────

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


@routes.get("/sidebar_gallery/settings")
async def get_settings(request: web.Request):
    """Return the full user settings JSON."""
    key = request.query.get("key")
    settings = _read_settings()
    if key:
        # Keys are stored flat (literal), including dotted keys like "SBG.Layouts".
        return web.json_response({"key": key, "value": settings.get(key)})
    return web.json_response(settings)


@routes.post("/sidebar_gallery/settings")
async def post_settings(request: web.Request):
    """Update user settings.

    Body can be:
      {"key": "dotted.path", "value": <any>}   set a single key
      {"settings": {full object}}              replace entire settings
      {full object without "key"}              replace entire settings
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    if "key" in body and "value" in body:
        # Per-key update. Store the key literally (flat), not split on dots, so
        # "SBG.Layouts" is a top-level key the client reads back verbatim.
        settings = _read_settings()
        settings[body["key"]] = body["value"]
        _write_settings(settings)
        return web.json_response({"ok": True, "key": body["key"]})
    elif "settings" in body and isinstance(body["settings"], dict):
        # Full replacement with explicit "settings" key
        _write_settings(body["settings"])
        return web.json_response({"ok": True, "replaced": True})
    elif isinstance(body, dict) and "key" not in body:
        # Full replacement (the body IS the settings object)
        _write_settings(body)
        return web.json_response({"ok": True, "replaced": True})
    else:
        return web.json_response({"error": "Expected {key, value} or full settings object"}, status=400)


# ── Index management ──────────────────────────────────────────────────



def _mark_parser_version_current():
    media_db.set_meta_value("parser_version", str(PARSER_VERSION))


def _start_full_reindex(roots: list[AllowedRoot]) -> bool:
    """Start a background full reindex over the given roots.

    Returns False if one is already running. The stored parser version is
    written only after EVERY root reindexed successfully, so an interrupted
    run is retried on the next startup.
    """
    # Refuse while any scan runs (full rebuild or a root's first index):
    # full_reindex walks every root, so starting it during a first index of one
    # of them means two concurrent whole-library writers on the same root.
    if media_db.any_scan_running():
        return False

    def _bg_reindex():
        cfg = load_config()
        excluded = set(cfg.excluded_dirs)
        ok = True
        for root in roots:
            try:
                media_db.full_reindex(
                    root, _read_metadata_for_db,
                    excluded_dirs=excluded,
                    index_hidden_dirs=cfg.index_hidden_dirs,
                )
            except Exception as e:
                ok = False
                logging.getLogger("sbg").error("Reindex failed for %s: %s", root.root_id, e)
        if ok:
            _mark_parser_version_current()

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
    return web.json_response(
        {
            "extra_roots": cfg.extra_roots,
            "excluded_dirs": cfg.excluded_dirs,
            "index_hidden_dirs": cfg.index_hidden_dirs,
            "auto_refresh_interval_s": cfg.auto_refresh_interval_s,
            "roots": [{"id": r.root_id, "label": r.label, "path": r.path if r.root_id != "output" else None} for r in roots],
        }
    )


# Strong references to fire-and-forget background tasks (asyncio keeps tasks
# only weakly; unreferenced ones can be garbage-collected before finishing).
_BG_TASKS: set = set()


async def _purge_removed_roots(root_ids: set[str]) -> None:
    """Background purge of roots removed from config: cancel + drain the root's
    in-flight scan first, then delete its rows off-loop. Failures are logged."""
    log = logging.getLogger("sbg")
    loop = asyncio.get_running_loop()
    for rid in root_ids:
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
    data = await request.json()
    old_cfg = load_config()
    cfg = save_config(data if isinstance(data, dict) else {})

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
        }
    )


# ── Subfolder listing ─────────────────────────────────────────────────


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
    return web.json_response({"subfolders": sorted_folders})



# ── Full list for client-side caching ─────────────────────────────────

# Per-root cooldown for non-forced incremental scans (see list_all).
_last_scan_times: dict[str, float] = {}
_SCAN_COOLDOWN_S = 5.0

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


async def _await_scan(fut):
    """Await a scan future, swallowing failures (best-effort: callers fall
    through to whatever the DB has). Returns the ScanResult or None."""
    if fut is None:
        return None
    try:
        return await fut
    except Exception:
        return None


def _maybe_scan(root, force: bool):
    """Schedule (or reuse) a cooldown- and inflight-guarded incremental scan for a
    root and return its asyncio future so callers can await it. Returns None when no
    scan runs (a full reindex is in progress, or the root was scanned within the
    cooldown and this isn't a forced call). Shared by list_all, /poll and /list_new
    so no two callers start concurrent whole-library walks of the same root
    (which fight over the single SQLite writer and cause "database is locked")."""
    root_id = root.root_id
    if media_db.is_full_reindex_running():
        return None
    inflight = _inflight_scans.get(root_id)
    if inflight is not None and not inflight.future.done():
        return inflight.future  # a scan is already running for this root; reuse it
    now = time.time()
    recently_scanned = (now - _last_scan_times.get(root_id, 0)) < _SCAN_COOLDOWN_S
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
        report_progress = media_db.get_meta_value(f"indexed:{root_id}") is None
        return media_db.incremental_scan(
            root,
            read_metadata_fn=_read_metadata_for_db,
            excluded_dirs=set(_scan_cfg.excluded_dirs),
            index_hidden_dirs=_scan_cfg.index_hidden_dirs,
            report_progress=report_progress,
            cancel_event=cancel_event,
        )

    scan_future = loop.run_in_executor(_SCAN_EXECUTOR, _run)
    _inflight_scans[root_id] = _ScanHandle(scan_future, cancel_event)
    scan_future.add_done_callback(lambda f, _rid=root_id: _clear_inflight_scan(f, _rid))
    return scan_future


def _build_list_all(root, thumb_size):
    """Read rows for a root and build the list_all payload. Runs in a worker
    thread so the DB read + ~29k-item build never block the event loop."""
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
                            zlib_executor_size=16 * 1024, zlib_executor=_IO_EXECUTOR)
    except TypeError:  # older aiohttp without the zlib executor kwargs
        resp = web.json_response(payload)
    try:
        if resp.body is not None and len(resp.body) > 1400:
            resp.enable_compression()
    except Exception:
        pass
    return resp


def _encode_json(payload, accept_gzip: bool) -> tuple[bytes, bool]:
    """json.dumps + gzip, meant to run off the event loop (in a worker).
    For the ~13MB list_all payload, serializing and deflating on the loop
    stalls every websocket update and HTTP request ComfyUI serves."""
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
    """Cheap change-check for a root. Runs the same cooldown/inflight-guarded
    incremental scan as list_all (so external adds/deletes/renames get written to the
    DB, bumping db_version), then returns the post-scan version. The frontend polls
    this and only refetches the full list when db_version differs from its snapshot."""
    root_id = request.rel_url.query.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)
    await _await_scan(_maybe_scan(root, force=False))  # returned version reflects this scan
    return web.json_response({
        # Per-root version + row count. The count is a cheap (indexed COUNT(*))
        # invariant: the client refetches when versions match but its item count
        # differs, self-healing any version stamp recorded against a view that
        # missed an add/delete.
        "db_version": media_db.get_root_version(root_id),
        "count": media_db.get_count(root_id),
        "reindexing": media_db.is_full_reindex_running(),
        "server_time": time.time(),
    })


# ── Delta list (new files only) ───────────────────────────────────────


def _process_new_files(root, root_id: str, files: list, thumb_size: int) -> list[dict]:
    """files[]-form worker: stat each reported file, parse its metadata,
    upsert it, and build its response item. Runs on _IO_EXECUTOR - the
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
            kind = "video" if ext in VIDEO_EXTS else ("audio" if ext in AUDIO_EXTS else ("mesh" if ext in MESH_EXTS else "image"))
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
    `since`. Runs on _IO_EXECUTOR - after a long absence this can be
    thousands of items."""
    out_items: list[dict] = []
    rid_q = quote(root.root_id)
    for row in media_db.get_all(root.root_id):
        if row["mtime"] <= since:
            continue
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
    body = await request.json()
    root_id = body.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    thumb_size = _clamped_int(body.get("thumb_size"), 512)

    files = body.get("files")  # [{filename, subfolder, type}, ...]
    removed_relpaths: list[str] = []  # filled by the since-form's scan
    loop = asyncio.get_running_loop()

    if files and isinstance(files, list):
        # Per-file stat + full metadata parse + upsert is real disk/CPU work, so
        # run it off the event loop.
        out_items = await loop.run_in_executor(
            _IO_EXECUTOR, _process_new_files, root, root_id, files, thumb_size)
    else:
        # Fallback: incremental scan through _maybe_scan (force), so it inherits
        # the inflight-dedupe and full-reindex gating rather than starting an
        # unguarded whole-library walk.
        since = float(body.get("since", 0))
        scan_result = await _await_scan(_maybe_scan(root, force=True))
        if scan_result is not None and scan_result.removed:
            # Deletions this scan reconciled: hand them to the client so the delta
            # path removes them instead of absorbing them into the version stamp
            # (which would leave ghost cards in the grid).
            removed_relpaths = list(scan_result.removed)
        # Return all items newer than `since` from DB (frontend will diff)
        out_items = await loop.run_in_executor(
            _IO_EXECUTOR, _build_since_items, root, thumb_size, since)

    payload = {
        "root": {"id": root.root_id, "label": root.label},
        "new_count": len(out_items),
        "items": out_items,
        # Relpaths the backing scan deleted (since-form; the files[] form
        # never deletes). Lets the client reconcile removals through the
        # delta path instead of absorbing them into the version stamp.
        "removed": removed_relpaths,
        "server_time": time.time(),
        "db_version": media_db.get_root_version(root_id),
        "count": media_db.get_count(root_id),
    }
    if len(out_items) > 200:
        # A big delta (long absence) serializes + compresses off-loop like
        # list_all; the typical few-item delta stays on the cheap inline path.
        body_bytes, gz = await loop.run_in_executor(
            _IO_EXECUTOR, _encode_json, payload, _accepts_gzip(request))
        return _encoded_response(body_bytes, gz)
    return _json_gz(payload)


# ── Metadata ──────────────────────────────────────────────────────────


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

    # ── Fast path: summary_only (DB only, zero disk I/O) ──────────
    if summary_only:
        db_row = media_db.get_file(root_id, relpath_clean)
        if db_row and db_row.get("metadata_json"):
            try:
                summary = json.loads(db_row["metadata_json"])
            except Exception:
                summary = {}
            return web.json_response({
                "file": {
                    "root_id": root_id,
                    "relpath": relpath_clean,
                    "size": db_row["size"] if db_row else 0,
                    "mtime": db_row["mtime"] if db_row else 0,
                },
                "summary": summary,
            })
        # DB has no metadata (new image not yet indexed) → fall through to disk read

    # ── Full path: read from disk (for Copy Workflow, Raw JSON) ────
    try:
        full = safe_join(root.path, relpath)
    except ValueError:
        return web.Response(status=400)
    if not os.path.isfile(full):
        return web.Response(status=404)

    st = os.stat(full)
    md = read_metadata_for_file(
        full,
        max_text_chunk_bytes=cfg.max_text_chunk_bytes,
        max_decompressed_text_bytes=cfg.max_decompressed_text_bytes,
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
        md = read_metadata_for_file(
            full,
            max_text_chunk_bytes=cfg.max_text_chunk_bytes,
            max_decompressed_text_bytes=cfg.max_decompressed_text_bytes,
        )
        result = {
            "file": {
                "filename": filename,
                "subfolder": subfolder,
                "type": ftype,
                "size": int(st.st_size),
                "mtime": float(st.st_mtime),
            },
            "summary": md.summary or {},
        }
        return _json_gz(sanitize_for_json(result))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── File serving ──────────────────────────────────────────────────────


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

    return web.FileResponse(
        full,
        headers={
            "Content-Disposition": f"filename=\"{filename}\"",
            "Content-Type": content_type,
            # Do not send "immutable" for these originals. Media loads get aborted
            # mid-download often (the lightbox cancels a <video> on cross-fade,
            # navigation, or retry), and an immutable-cached truncated body would
            # be served forever, even in a fresh tab. "no-cache" still lets the
            # browser store the file but forces a cheap ETag/Last-Modified
            # revalidation before reuse, so a bad/partial entry can never get
            # pinned. The client still appends &v=<mtime> so a regenerated file is
            # fetched fresh.
            "Cache-Control": "no-cache",
        },
    )


# ── Image preview (cached thumbnails) ─────────────────────────────────


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


# ── Video thumbnail serving ──────────────────────────────────────────


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
        # timeout) and is throttled by _FFMPEG_SEM, so run it on a worker
        # thread to keep the event loop responsive while it works/queues.
        loop = asyncio.get_running_loop()
        ok = await loop.run_in_executor(_IO_EXECUTOR, lambda: _generate_video_thumbnail(full, tp, size))
        if not ok:
            return web.Response(status=404)

    return web.FileResponse(
        str(tp),
        headers={
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# ── On-demand thumbnail generation ────────────────────────────────────


@routes.post("/sidebar_gallery/generate_thumb")
async def generate_thumb(request: web.Request) -> web.Response:
    """Generate a thumbnail on demand and return it."""
    body = await request.json()
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

    # Generate off the event loop - ffmpeg/PIL are blocking and the video
    # path can take seconds (see the GET handlers above).
    loop = asyncio.get_running_loop()
    if kind == "video":
        tp = _video_thumb_path(full, size)
        ok = await loop.run_in_executor(_IO_EXECUTOR, lambda: _generate_video_thumbnail(full, tp, size))
    elif kind == "audio":
        tp = _audio_waveform_path(full, size)
        ok = await loop.run_in_executor(_IO_EXECUTOR, lambda: _generate_audio_waveform(full, tp, size))
    elif kind == "mesh":
        tp = _mesh_thumb_path(full, size)
        ok = await loop.run_in_executor(_IO_EXECUTOR, lambda: _generate_mesh_thumbnail(full, tp, size))
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


# ── Audio waveform thumbnail ─────────────────────────────────────────

def _audio_waveform_path(full_path: str, size: int = 512) -> Path:
    return _THUMB_DIR / f"a_{_thumb_hash(full_path, size)}.jpg"

def _generate_audio_waveform(full_path: str, out_path: Path, size: int = 256) -> bool:
    """Generate a waveform visualization thumbnail for an audio file."""
    if out_path.exists():
        return True
    try:
        bars = 40
        bar_w = max(1, size // bars)
        img_w = bar_w * bars
        img_h = size // 2
        import random
        random.seed(hash(full_path))
        amplitudes = [random.uniform(0.15, 0.95) for _ in range(bars)]

        from PIL import Image, ImageDraw
        img = Image.new("RGB", (img_w, img_h), (30, 30, 40))
        draw = ImageDraw.Draw(img)
        max_amp = max(amplitudes) if amplitudes else 1
        for i, amp in enumerate(amplitudes):
            h = max(2, int((amp / max(max_amp, 0.01)) * img_h * 0.8))
            x = i * bar_w
            y_top = (img_h - h) // 2
            draw.rectangle([x + 1, y_top, x + bar_w - 2, y_top + h], fill=(124, 106, 239))

        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = out_path.with_suffix(".tmp")
        img.save(str(tmp), "JPEG", quality=85)
        tmp.rename(out_path)
        return True
    except Exception as e:
        logger.warning("SBG: audio waveform failed for %s: %s", full_path, e)
        return False

@routes.get("/sidebar_gallery/audio_waveform")
async def get_audio_waveform(request: web.Request):
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
    tp = _audio_waveform_path(full, size)
    if not tp.exists():
        loop = asyncio.get_running_loop()
        ok = await loop.run_in_executor(_IO_EXECUTOR, lambda: _generate_audio_waveform(full, tp, size))
        if not ok:
            return web.Response(status=404)
    return web.FileResponse(str(tp), headers={"Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable"})


# ── 3D/Mesh thumbnail ────────────────────────────────────────────────

def _mesh_thumb_path(full_path: str, size: int = 512) -> Path:
    return _THUMB_DIR / f"m_{_thumb_hash(full_path, size)}.jpg"

def _generate_mesh_thumbnail(full_path: str, out_path: Path, size: int = 256) -> bool:
    """Generate a static thumbnail for a 3D/mesh file using trimesh."""
    if out_path.exists():
        return True
    try:
        from PIL import Image, ImageDraw
        img = Image.new("RGB", (size, size), (30, 30, 40))
        draw = ImageDraw.Draw(img)
        # Draw a 3D box icon placeholder
        cx, cy = size // 2, size // 2
        s = size // 4
        # Isometric box
        draw.polygon([(cx, cy - s), (cx + s, cy - s // 2), (cx, cy), (cx - s, cy - s // 2)], fill=(80, 70, 120), outline=(124, 106, 239))
        draw.polygon([(cx, cy), (cx + s, cy - s // 2), (cx + s, cy + s // 2), (cx, cy + s)], fill=(60, 55, 100), outline=(124, 106, 239))
        draw.polygon([(cx, cy), (cx - s, cy - s // 2), (cx - s, cy + s // 2), (cx, cy + s)], fill=(50, 45, 85), outline=(124, 106, 239))
        ext = os.path.splitext(full_path)[1].upper().lstrip(".")
        draw.text((cx - len(ext) * 4, cy + s + 8), ext, fill=(180, 170, 220))

        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = out_path.with_suffix(".tmp")
        img.save(str(tmp), "JPEG", quality=85)
        tmp.rename(out_path)
        return True
    except Exception as e:
        logger.warning("SBG: mesh thumbnail failed for %s: %s", full_path, e)
        return False

@routes.get("/sidebar_gallery/mesh_thumb")
async def get_mesh_thumb(request: web.Request):
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
    tp = _mesh_thumb_path(full, size)
    if not tp.exists():
        loop = asyncio.get_running_loop()
        ok = await loop.run_in_executor(_IO_EXECUTOR, lambda: _generate_mesh_thumbnail(full, tp, size))
        if not ok:
            return web.Response(status=404)
    return web.FileResponse(str(tp), headers={"Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable"})


# ── Delete file ───────────────────────────────────────────────────────

@routes.post("/sidebar_gallery/delete_file")
async def delete_file(request: web.Request):
    """Delete a file from disk and remove it from the index."""
    body = await request.json()
    root_id = body.get("root_id", "")
    relpath = body.get("relpath", "")
    root = _find_root(root_id)
    if root is None:
        return web.json_response({"error": "root not found"}, status=404)
    try:
        full = safe_join(root.path, relpath)
    except ValueError:
        return web.json_response({"error": "invalid path"}, status=400)
    if not os.path.isfile(full):
        return web.json_response({"error": "file not found"}, status=404)
    try:
        os.remove(full)
    except OSError as e:
        return web.json_response({"error": str(e)}, status=500)
    try:
        conn = media_db._get_conn()
        conn.execute("DELETE FROM media_files WHERE root_id=? AND relpath=?", (root_id, relpath))
        conn.commit()
    except Exception:
        pass
    return web.json_response({"ok": True})


# ── Metadata search (reads from DB - no in-memory cache needed) ──────




# Search matching lives in server/search.py as match_summary(), a pure,
# unit-tested module decoupled from this ComfyUI-coupled route handler.



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
        # Surfaces the "no ffmpeg -> no video thumbnails" case so the UI can warn
        # instead of serving broken video thumbnails.
        "ffmpeg_available": _find_ffmpeg() is not None,
    })


def _run_search(root_id, tags, mode, relpaths_filter):
    """CPU-bound metadata scan. Runs in a worker thread (run_in_executor)
    so a full-library search never blocks the ComfyUI event loop."""
    # Read from DB - all metadata is already stored as JSON
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
                
        # Tag evaluation tracker
        file_matched_fields = []
        tag_checks = []

        for tag in tags:
            field = tag.get("field", "any").lower()
            value = tag.get("value", "").lower()
            is_exclude = tag.get("exclude", False)

            if not value and field == "any" and not is_exclude:
                tag_checks.append(True)
                continue

            tag_matched_fields = []
            
            # Check parsed Metadata JSON dict
            if s:
                tag_matched_fields = match_summary(s, field, value)
                
            # Fallback string check against filename
            if not tag_matched_fields and field == "any" and value and value in relpath.lower():
                fn_count = relpath.lower().count(value)
                tag_matched_fields = [{"field": "filename", "count": fn_count}]

            if is_exclude:
                # Exclude tag: file passes if term is NOT found
                tag_checks.append(len(tag_matched_fields) == 0)
            else:
                if tag_matched_fields:
                    file_matched_fields.extend(tag_matched_fields)
                    tag_checks.append(True)
                else:
                    tag_checks.append(False)

        # Compound Check Array Result based on Mode string
        is_match = False
        if mode == "AND":
            is_match = all(tag_checks)
        else:
            is_match = any(tag_checks)

        if is_match and file_matched_fields:
            matches.append({"relpath": relpath, "matched_fields": file_matched_fields})
        elif is_match and not file_matched_fields:
            # edgecase where tags were fully empty strings
            matches.append({"relpath": relpath, "matched_fields": [{"field": "any", "count": 1}]})
    return {"matches": matches, "scanned": scanned, "total": total}


@routes.post("/sidebar_gallery/search")
async def search_metadata(request: web.Request) -> web.Response:
    """Search through metadata stored in SQLite DB using multi-tag AND/OR logic.

    Reads metadata_json from DB rows (zero disk I/O). The scan runs on a worker
    thread so a full-library search never blocks the ComfyUI event loop.
    """
    body = await request.json()
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


# ── Theme Presets ──────────────────────────────────────────────────────

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
    body = await request.json()
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


# ── Layout Editor: all unique metadata keys ─────────────────────────────

@routes.get("/sidebar_gallery/meta_keys")
async def get_meta_keys(request: web.Request):
    """Return all unique metadata section/param keys across indexed files."""
    # Full-library aggregate (cached by db_version in get_all_meta_keys); run off
    # the event loop since the first call after a change re-scans every row.
    loop = asyncio.get_running_loop()
    keys = await loop.run_in_executor(_SCAN_EXECUTOR, media_db.get_all_meta_keys)
    return _json_gz(keys)


# ── Parser-version reindex ────────────────────────────────────────────
# Summaries are cached per-file in the DB, so a parser upgrade does nothing for
# already-indexed files until they are re-extracted. On startup, if the stored
# parser version doesn't match, kick off a background re-extraction (the gallery
# stays usable; _start_full_reindex writes the new version only after a fully
# successful run, so an interrupted reindex retries next boot).
def _check_parser_version():
    try:
        stored = media_db.get_meta_value("parser_version")
        if stored == str(PARSER_VERSION):
            return
        if not media_db.has_any_files():
            _mark_parser_version_current()
            return
        if _start_full_reindex(_all_roots()):
            logging.getLogger("sbg").info(
                "[SBG] Metadata parser updated (v%s -> v%s): re-extracting metadata in the background",
                stored or "?", PARSER_VERSION)
    except Exception as e:
        logging.getLogger("sbg").warning("[SBG] Parser-version check failed: %s", e)


_check_parser_version()
