from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from aiohttp import web

import folder_paths
import server

from .config import load_config, save_config
from .db import IMAGE_EXTS, VIDEO_EXTS
from . import db as media_db
from .metadata import PARSER_VERSION, read_metadata_for_file, guess_mime, sanitize_for_json
from .search import match_summary
from .security import AllowedRoot, make_root_id, safe_join


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
# file orphans its old thumbnail with no way to map it back. Rather than leak
# forever, cap the cache's total size and evict the oldest thumbnails over the cap.
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
    file (new mtime) resolve to a FRESH url, so its immutable-cached thumbnail
    refreshes on its own — no wholesale client-cache wipe on every db_version bump.
    Millisecond precision so a same-second overwrite of a fixed-name file (the
    on-disk thumb hash already keys on full-precision mtime) still busts the
    browser's immutable cache."""
    v = int((mtime or 0) * 1000)
    if kind == "image":
        return f"/sidebar_gallery/preview?root_id={rid_q}&relpath={rp_q}&size={size}&format=jpeg&v={v}"
    if kind == "video":
        return f"/sidebar_gallery/video_thumb?root_id={rid_q}&relpath={rp_q}&size={size}&v={v}"
    return None


# Cap concurrent ffmpeg thumbnail jobs. During a full reindex the CPU is
# saturated; unbounded parallel ffmpeg spawns then time out en masse, which
# is what produced waves of "broken" video thumbnails after a rebuild.
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


def _all_roots() -> list[AllowedRoot]:
    cfg = load_config()
    roots = [_output_root()]
    for raw in cfg.extra_roots:
        p = os.path.normpath(os.path.expandvars(os.path.expanduser(raw.strip())))
        if os.path.isdir(p):
            rid = make_root_id("extra", p)
            roots.append(AllowedRoot(root_id=rid, label=os.path.basename(p) or p, path=p))
    return roots


def _find_root(root_id: str) -> AllowedRoot | None:
    for r in _all_roots():
        if r.root_id == root_id:
            return r
    return None


# ── DB-backed metadata reader helper ──────────────────────────────────

def _read_metadata_for_db(full_path: str) -> dict | None:
    """Read metadata from a file and return ONLY the compact summary dict.
    
    Stores only the parsed summary (~1-5 KB) — NOT the full prompt, workflow,
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
      {"key": "dotted.path", "value": <any>}  — set a single key
      {"settings": {full object}}              — replace entire settings
      {full object without "key"}              — replace entire settings
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    if "key" in body and "value" in body:
        # Per-key update. Store the key LITERALLY (flat) — do not split on dots,
        # so "SBG.Layouts" is a top-level key the client reads back verbatim.
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
    progress = media_db.get_reindex_progress()
    if progress.get("running"):
        return False

    def _bg_reindex():
        ok = True
        for root in roots:
            try:
                media_db.full_reindex(root, _read_metadata_for_db)
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
                                  "progress": media_db.get_reindex_progress()})
    return web.json_response({"status": "started", "roots": [r.root_id for r in roots]})


@routes.get("/sidebar_gallery/reindex_progress")
async def reindex_progress(request: web.Request):
    """Return background reindex progress."""
    return web.json_response(media_db.get_reindex_progress())


@routes.get("/sidebar_gallery/config")
async def get_config(request: web.Request):
    cfg = load_config()
    roots = _all_roots()
    return web.json_response(
        {
            "extra_roots": cfg.extra_roots,
            "roots": [{"id": r.root_id, "label": r.label, "path": r.path if r.root_id != "output" else None} for r in roots],
        }
    )


@routes.post("/sidebar_gallery/config")
async def post_config(request: web.Request):
    data = await request.json()
    cfg = save_config(data if isinstance(data, dict) else {})
    roots = _all_roots()
    return web.json_response(
        {
            "extra_roots": cfg.extra_roots,
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
# (rescan=true). Without this, the first call kicks off a background scan and the
# second starts a *second* concurrent whole-library walk — doubling disk/SQLite
# contention and starving on-demand thumbnail generation for the newest files. A
# forced caller now awaits the running scan instead of launching another.
_inflight_scans: dict[str, asyncio.Future] = {}


def _clear_inflight_scan(fut: asyncio.Future, root_id: str) -> None:
    """Done-callback: drop the tracked future once it finishes — but only if it's
    still the current one for this root, so a newer scan isn't cleared by mistake."""
    if _inflight_scans.get(root_id) is fut:
        _inflight_scans.pop(root_id, None)


def _build_list_all(root, thumb_size):
    """Read rows for a root and build the list_all payload. Runs in a worker
    thread so the DB read + ~29k-item build never block the event loop."""
    root_id = root.root_id
    db_items = media_db.get_all(root_id)
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
        "db_version": media_db.get_db_version(),
    }


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

    # Read DB immediately for instant gallery display.
    # If rescan requested, wait for scan to complete first to ensure fresh data.
    # A short cooldown skips redundant background walks when several tabs /
    # remounts hit list_all in quick succession (forced rescans always run).
    # While a full reindex runs, skip scans entirely — two whole-library
    # writers fight over the SQLite write lock ("database is locked").
    reindexing = media_db.get_reindex_progress().get("running")
    now = time.time()
    recently_scanned = (now - _last_scan_times.get(root_id, 0)) < _SCAN_COOLDOWN_S
    inflight = _inflight_scans.get(root_id)
    inflight_running = inflight is not None and not inflight.done()
    if not reindexing:
        if inflight_running:
            # A scan for this root is already running — don't start a second walk.
            # A forced caller still needs fresh data, so wait for the running one.
            if force:
                try:
                    await inflight
                except Exception:
                    pass  # best-effort; fall through to whatever the DB has
        elif force or not recently_scanned:
            _last_scan_times[root_id] = now
            loop = asyncio.get_running_loop()
            scan_future = loop.run_in_executor(None, lambda: media_db.incremental_scan(root, read_metadata_fn=_read_metadata_for_db))
            _inflight_scans[root_id] = scan_future
            scan_future.add_done_callback(lambda f, _rid=root_id: _clear_inflight_scan(f, _rid))
            if force:
                await scan_future  # Wait for scan to finish before reading DB

    loop = asyncio.get_running_loop()
    payload = await loop.run_in_executor(None, _build_list_all, root, thumb_size)

    # First-ever open of a freshly added root: the background scan we kicked off
    # may not have finished, so a non-forced caller would get an empty list. Wait
    # for that in-flight scan once and rebuild, so opening a new folder fills in.
    if not force and not reindexing and not payload["items"]:
        pending = _inflight_scans.get(root_id)
        if pending is not None and not pending.done():
            try:
                await pending
            except Exception:
                pass
            payload = await loop.run_in_executor(None, _build_list_all, root, thumb_size)

    return web.json_response(payload)


# ── Delta list (new files only) ───────────────────────────────────────


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
    out_items = []

    if files and isinstance(files, list):
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

                # Normalize to a path RELATIVE to the root. Some save nodes report an
                # absolute subfolder in the `executed` event, which would otherwise be
                # stored as an absolute relpath (breaks relpath filename display and
                # makes the next rescan treat it as a stale/duplicate entry).
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

                if kind == "image":
                    try:
                        tp = _image_thumb_path(full, thumb_size)
                        has_thumb = tp.exists()
                    except Exception:
                        pass
                elif kind == "video":
                    try:
                        tp = _video_thumb_path(full, thumb_size)
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
    else:
        # Fallback: incremental scan
        since = float(body.get("since", 0))
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: media_db.incremental_scan(root, read_metadata_fn=_read_metadata_for_db))
        # Return all items from DB (frontend will diff)
        db_items = media_db.get_all(root_id)
        for row in db_items:
            if row["mtime"] > since:
                relpath = row["relpath"]
                kind = row["kind"]
                rid_q = quote(root.root_id)
                rp_q = quote(relpath)
                thumb_url = _thumb_url(rid_q, rp_q, thumb_size, kind, row["mtime"] or row["ctime"])
                has_thumb = False
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
                    "thumb_url": thumb_url,
                    "has_thumb": has_thumb,
                }
                _w, _h = row.get("w"), row.get("h")
                if _w and _h:
                    item["w"] = _w
                    item["h"] = _h
                out_items.append(item)

    return web.json_response(
        {
            "root": {"id": root.root_id, "label": root.label},
            "new_count": len(out_items),
            "items": out_items,
            "server_time": time.time(),
        }
    )


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

    # Store parsed metadata back to DB for new/unindexed files (future fast path)
    if not db_row or not db_row.get("metadata_json"):
        try:
            _ext = os.path.splitext(relpath_clean)[1].lower()
            _kind = "video" if _ext in VIDEO_EXTS else "image"
            with media_db._get_conn() as _conn:
                media_db.upsert_file(_conn, root_id, relpath_clean, _ext, _kind,
                                     int(st.st_size), float(st.st_mtime),
                                     json.dumps(summary) if summary else None,
                                     ctime=float(st.st_ctime))
        except Exception:
            pass

    return web.json_response(sanitize_for_json(result))


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
        return web.json_response(sanitize_for_json(result))
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
            # Do NOT send "Cache-Control: ...immutable" for these originals.
            # immutable tells the browser to reuse the cached response forever
            # without ever revalidating. Media loads get aborted mid-download all
            # the time here (the lightbox cancels a <video> when you cross-fade,
            # navigate, or it retries; longer clips are likeliest to be cut off),
            # and Firefox then caches that TRUNCATED body and — because it is
            # immutable — keeps serving the undecodable copy forever, even in a
            # fresh tab. Only a cache-bypassing reload recovered it. ComfyUI's own
            # /view sends no Cache-Control and never hit this, so we match it:
            # "no-cache" still lets the browser store the file but forces a cheap
            # ETag/Last-Modified revalidation before reuse, so a bad/partial entry
            # can never get pinned. The client still appends &v=<mtime> so a
            # regenerated file is fetched fresh.
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
        await loop.run_in_executor(None, lambda: _generate_image_thumbnail(full, cached, target))

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
        ok = await loop.run_in_executor(None, lambda: _generate_video_thumbnail(full, tp, size))
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

    # Generate off the event loop — ffmpeg/PIL are blocking and the video
    # path can take seconds (see the GET handlers above).
    loop = asyncio.get_running_loop()
    if kind == "video":
        tp = _video_thumb_path(full, size)
        ok = await loop.run_in_executor(None, lambda: _generate_video_thumbnail(full, tp, size))
    else:
        tp = _image_thumb_path(full, size)
        ok = await loop.run_in_executor(None, lambda: _generate_image_thumbnail(full, tp, size))

    if ok and tp.exists():
        return web.FileResponse(
            str(tp),
            headers={
                "Content-Type": "image/jpeg",
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )
    return web.Response(status=500)



# ── Metadata search (reads from DB — no in-memory cache needed) ──────




# Search matching now lives in server/search.py as match_summary() — a pure,
# unit-tested module (tests/test_search.py) decoupled from this ComfyUI-coupled
# route handler. Imported above. (An AST comparison guarded the verbatim move.)



@routes.get("/sidebar_gallery/db_version")
async def get_db_version(request: web.Request) -> web.Response:
    """Return the current DB version counter (lightweight, no DB I/O)."""
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
    })


def _run_search(root_id, tags, mode, relpaths_filter):
    """CPU-bound metadata scan. Runs in a worker thread (run_in_executor)
    so a full-library search never blocks the ComfyUI event loop."""
    # Read from DB — all metadata is already stored as JSON
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
    result = await loop.run_in_executor(None, _run_search, root_id, tags, mode, relpaths_filter)
    return web.json_response(result)


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
    keys = await loop.run_in_executor(None, media_db.get_all_meta_keys)
    return web.json_response(keys)


# ── Parser-version reindex ────────────────────────────────────────────
# Summaries are cached per-file in the DB, so a parser upgrade does nothing
# for already-indexed files until they are re-extracted. On startup, if the
# stored parser version doesn't match, kick off a background re-extraction
# (the gallery stays usable; _start_full_reindex writes the new version only
# after a fully successful run, so an interrupted reindex retries next boot).
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
