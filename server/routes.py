from __future__ import annotations

import asyncio
import contextlib
import functools
import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import quote

from aiohttp import web

import folder_paths
import server

from .config import (CONFIG_PUBLIC_FIELDS, PACKAGE_ROOT, SidebarGalleryConfig, UnreadableFile, commit_staged,
                     config_path, discard_staged, file_sig, load_config, os_reason, parse_json,
                     pop_copy_notice, pop_quarantine_notice, read_json_dict, read_json_file, sweep_stale_tmp,
                     write_config, write_json_atomic)
from .media_av import open_media
from .media_types import ALL_MEDIA_EXTS, AUDIO_EXTS, IMAGE_EXTS, kind_from_ext
from . import db as media_db
from . import recycle
from .metadata import MetadataResult, PARSER_VERSION, read_metadata_for_file, guess_mime, sanitize_for_json
from .presets import (
    FILENAME_REFUSED, NO_LETTER, THEME_FILE_SUFFIX, OldFileKept, discard_file, downgraded_from, extension_version,
    json_filename, move_conflict, file_stem, rename_preset, sanitize_name, stage_preset,
    without_layout_bodies, install_layout_digests,
)
from . import apply
from . import schema
from . import settings_backups
from . import themes
from .gate import run_gated
from .loop_only import assert_on_loop, bind_loop
from .search import match_item, search_indexed, search_indexed_supported
from .security import AllowedRoot, extra_root_path, make_root_id, safe_join

# Split by latency class, so a minutes-long scan cannot queue ahead of interactive work.
_SCAN_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sbg-scan")
_IO_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sbg-io")

routes = server.PromptServer.instance.routes
logger = logging.getLogger("sbg")

def _clamped_int(val: Any, fallback: int) -> int:
    try:
        n = int(val)
    except (TypeError, ValueError, OverflowError):
        n = fallback
    return max(64, min(1024, n))

_THUMB_DIR = PACKAGE_ROOT / ".thumbs"

def _prepare_thumb_dir() -> None:
    _THUMB_DIR.mkdir(exist_ok=True)
    for stale in _THUMB_DIR.glob("tmp_*"):
        try:
            stale.unlink()
        except OSError:
            pass

_THUMB_CACHE_MAX_BYTES = 3 * 1024 ** 3

def _gc_thumbs() -> None:
    try:
        entries = []
        total = 0
        with os.scandir(_THUMB_DIR) as scan:
            for entry in scan:
                name = entry.name
                if (os.path.splitext(name)[1] not in (".jpg", ".json")
                        or name.startswith("tmp_")):
                    continue
                try:
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                entries.append((st.st_mtime, st.st_size, Path(entry.path)))
                total += st.st_size
        if total <= _THUMB_CACHE_MAX_BYTES:
            return
        entries.sort()
        for _mt, size, f in entries:
            if total <= _THUMB_CACHE_MAX_BYTES:
                break
            try:
                f.unlink()
                total -= size
            except OSError:
                pass
    except Exception:
        # A failure here must not end the thread that calls this on a loop.
        pass

_THUMB_GC_INTERVAL_S = 15 * 60

def _thumb_gc_loop() -> None:
    while True:
        _gc_thumbs()
        time.sleep(_THUMB_GC_INTERVAL_S)

def _thumb_hash(full_path: str, size: int) -> str:
    try:
        mtime = os.path.getmtime(full_path)
    except OSError:
        mtime = 0
    return hashlib.md5(f"{full_path}:{mtime}:{size}".encode()).hexdigest()

def _video_thumb_path(full_path: str, size: int) -> Path:
    return _THUMB_DIR / f"v_{_thumb_hash(full_path, size)}.jpg"

def _image_thumb_path(full_path: str, size: int) -> Path:
    return _THUMB_DIR / f"i_{_thumb_hash(full_path, size)}.jpg"

def _audio_thumb_path(full_path: str, size: int) -> Path:
    return _THUMB_DIR / f"aw_{_thumb_hash(full_path, size)}.jpg"

def _cached_thumb(path: Path) -> bool | None:
    """True for a thumbnail on disk, False for the empty file a decode that
    cannot succeed leaves as its mark, and None when neither is there yet."""
    try:
        return path.stat().st_size > 0
    except OSError:
        return None

_IMMUTABLE = "public, max-age=31536000, immutable"

def _thumb_response(path: Path, content_type: str = "image/jpeg") -> web.FileResponse:
    return web.FileResponse(str(path), headers={"Content-Type": content_type, "Cache-Control": _IMMUTABLE})

def _thumb_url(rid_q: str, rp_q: str, size: int, kind: str, mtime) -> str | None:
    # No thumbnail route reads v. It gives a rewritten file a URL the browser has not cached.
    v = int((mtime or 0) * 1000)
    if kind == "image":
        return f"/sidebar_gallery/preview?root_id={rid_q}&relpath={rp_q}&size={size}&format=jpeg&v={v}"
    if kind == "video":
        return f"/sidebar_gallery/video_thumb?root_id={rid_q}&relpath={rp_q}&size={size}&v={v}"
    if kind == "audio":
        return f"/sidebar_gallery/audio_thumb?root_id={rid_q}&relpath={rp_q}&size={size}&v={v}"
    return None

def _client_item(root_id, relpath, ext, kind, size, mtime, ctime, thumb_size,
                 rid_q, *, filename=None, subfolder=None, w=None, h=None):
    sort_time = ctime or mtime
    real = mtime or ctime
    item = {
        "root_id": root_id,
        "relpath": relpath,
        "filename": os.path.basename(relpath) if filename is None else filename,
        "subfolder": (os.path.dirname(relpath).replace("\\", "/")
                      if subfolder is None else subfolder),
        "ext": ext,
        "kind": kind,
        "size": size,
        "mtime": sort_time,
        "ctime": sort_time,
        "mtime_real": real,
        "thumb_url": _thumb_url(rid_q, quote(relpath), thumb_size, kind, real),
    }
    if w and h:
        item["w"] = w
        item["h"] = h
    return item

def _row_item(row: dict, thumb_size: int, rid_q: str) -> dict:
    return _client_item(row["root_id"], row["relpath"], row["ext"], row["kind"],
                        row["size"], row["mtime"], row["ctime"], thumb_size, rid_q,
                        filename=row["filename"], subfolder=row["subfolder"],
                        w=row.get("w"), h=row.get("h"))

# Video and audio decodes hold at most two of the IO pool's four workers, and
# one waiting for a slot waits on the loop instead of in a worker.
_MEDIA_DECODE_GATE = asyncio.Semaphore(2)

_gen_locks: dict[str, tuple[threading.Lock, int]] = {}
_gen_locks_guard = threading.Lock()

@contextlib.contextmanager
def _gen_lock(out_path: Path):
    key = str(out_path)
    with _gen_locks_guard:
        entry = _gen_locks.get(key)
        lock, users = entry if entry else (threading.Lock(), 0)
        _gen_locks[key] = (lock, users + 1)
    try:
        with lock:
            yield
    finally:
        with _gen_locks_guard:
            lock, users = _gen_locks[key]
            if users > 1:
                _gen_locks[key] = (lock, users - 1)
            else:
                del _gen_locks[key]

def _replace_from_temp(out_path: Path, write) -> bool:
    tmp_path = out_path.with_name(f"tmp_{threading.get_ident()}_{out_path.name}")
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        write(tmp_path)
        if tmp_path.exists() and tmp_path.stat().st_size > 0:
            os.replace(tmp_path, out_path)
        return out_path.exists()
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass

def _frame_image(frame, size: int):
    scale = min(size / frame.width, size / frame.height, 1.0)
    nw = max(1, round(frame.width * scale))
    nh = max(1, round(frame.height * scale))
    try:
        small = frame.reformat(width=nw, height=nh, format="rgb24", interpolation="LANCZOS")
    except Exception:
        small = frame.reformat(width=nw, height=nh, format="rgb24")
    return small.to_image()

def _generate_video_thumbnail(full_path: str, out_path: Path, size: int) -> bool:
    with _gen_lock(out_path):
        ready = _cached_thumb(out_path)
        if ready is not None:
            return ready
        try:
            import av
            from PIL import Image
        except Exception:
            return False
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open_media(full_path) as container:
                vstreams = container.streams.video
                if not vstreams:
                    out_path.touch()
                    return False
                stream = vstreams[0]
                stream.thread_type = "AUTO"
                try:
                    container.seek(int(0.5 * av.time_base), backward=True)
                except Exception:
                    pass
                frame = None
                for walked, cand in enumerate(container.decode(stream)):
                    frame = cand
                    if cand.time is not None and cand.time >= 0.5:
                        break
                    # A stream whose frames carry no time never meets the check above, so the walk is capped.
                    if walked >= 240:
                        break
                if frame is None:
                    out_path.touch()
                    return False
                img = _frame_image(frame, size)
                rot = round((getattr(frame, "rotation", 0) or 0) / 90) * 90 % 360
                if rot:
                    img = img.transpose(getattr(Image, f"ROTATE_{rot}"))
            return _replace_from_temp(out_path, lambda tmp: img.save(str(tmp), format="JPEG", quality=85))
        except Exception as exc:
            _mark_decoder_failure(exc, out_path)
            return False

_WAVEFORM_MAX_FRAMES = 400_000

def _collect_audio_peaks(container, buckets: int):
    import numpy as np

    astreams = container.streams.audio
    if not astreams:
        return None
    frame_peaks = []
    frame_samples = []
    for frame in container.decode(astreams[0]):
        arr = frame.to_ndarray()
        if not arr.size:
            continue
        arr = np.abs(arr.astype(np.float32))
        fmt = (frame.format.name or "")
        if "s16" in fmt:
            arr /= 32768.0
        elif "s32" in fmt:
            arr /= 2147483648.0
        elif fmt.startswith("u8"):
            arr = np.abs(arr - 128.0) / 128.0
        frame_peaks.append(float(arr.max()))
        n = int(frame.samples or 0)
        if not n:
            # A packed format arrives as one row of samples times channels.
            ch = max(1, int(getattr(getattr(frame, "layout", None), "nb_channels", 1) or 1))
            n = arr.shape[-1] // ch if arr.shape[0] == 1 else arr.shape[-1]
        frame_samples.append(max(1, n))
        if len(frame_peaks) >= _WAVEFORM_MAX_FRAMES:
            break
    if not frame_peaks:
        return None

    total = float(sum(frame_samples))
    levels = [0.0] * buckets
    pos = 0.0
    for peak, n in zip(frame_peaks, frame_samples):
        a = int(pos / total * buckets)
        pos += n
        b = int(pos / total * buckets)
        for i in range(max(0, a), min(buckets, b + 1)):
            if peak > levels[i]:
                levels[i] = peak
    top = max(levels)
    if top > 0:
        levels = [lvl / top for lvl in levels]
    return [round(lvl, 4) for lvl in levels]

def _waveform_image(container, size: int):
    from PIL import Image, ImageDraw

    bars = max(48, min(160, size // 4))
    levels = _collect_audio_peaks(container, bars)
    if levels is None:
        return None

    img = Image.new("RGB", (size, size), (24, 24, 32))
    draw = ImageDraw.Draw(img)
    bar_w = size / bars
    mid = size / 2
    for i, lvl in enumerate(levels):
        half = max(1.0, lvl * (size * 0.30))
        x0 = i * bar_w + bar_w * 0.18
        x1 = (i + 1) * bar_w - bar_w * 0.18
        draw.rectangle([x0, mid - half, x1, mid + half], fill=(142, 152, 196))
    return img

_AUDIO_PEAK_BUCKETS = 240

def _audio_peaks_path(full_path: str) -> Path:
    return _THUMB_DIR / f"awp_{_thumb_hash(full_path, _AUDIO_PEAK_BUCKETS)}.json"

def _mark_decoder_failure(exc: BaseException, out_path: Path) -> None:
    # An empty file marks a decode that cannot succeed, so it is not tried again
    # on every request. An error that is also an OS error can be transient and leaves no mark.
    try:
        import av
        if isinstance(exc, av.FFmpegError) and not isinstance(exc, OSError):
            out_path.touch()
    except Exception:
        pass

def _generate_audio_peaks(full_path: str, out_path: Path) -> bool:
    with _gen_lock(out_path):
        ready = _cached_thumb(out_path)
        if ready is not None:
            return ready
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open_media(full_path) as container:
                has_art = bool(container.streams.video)
                levels = _collect_audio_peaks(container, _AUDIO_PEAK_BUCKETS)
            if levels is None:
                out_path.touch()
                return False
            return _replace_from_temp(out_path, lambda tmp: tmp.write_text(json.dumps({"peaks": levels, "art": has_art}), encoding="utf-8"))
        except Exception as exc:
            _mark_decoder_failure(exc, out_path)
            return False

async def _serve_decoded(query, exts: frozenset[str] | None, out_path_of, generate,
                         content_type: str = "image/jpeg") -> web.StreamResponse:
    def _locate():
        _, full = _media_path(query, exts)
        out = out_path_of(full)
        return full, out, _cached_thumb(out)

    loop = asyncio.get_running_loop()
    full, out, ready = await loop.run_in_executor(_IO_EXECUTOR, _locate)
    if ready is None:
        ready = await run_gated(_MEDIA_DECODE_GATE, _IO_EXECUTOR, lambda: generate(full, out))
    if not ready:
        return web.Response(status=404)
    return _thumb_response(out, content_type)

@routes.get("/sidebar_gallery/audio_peaks")
async def get_audio_peaks(request: web.Request):
    return await _serve_decoded(request.rel_url.query, AUDIO_EXTS, _audio_peaks_path,
                                _generate_audio_peaks, "application/json")

def _generate_audio_thumbnail(full_path: str, out_path: Path, size: int) -> bool:
    with _gen_lock(out_path):
        ready = _cached_thumb(out_path)
        if ready is not None:
            return ready
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            img = None
            with open_media(full_path) as container:
                vstreams = container.streams.video
                had_art_streams = bool(vstreams)
                if vstreams:
                    frame = next(container.decode(vstreams[0]), None)
                    if frame is not None:
                        img = _frame_image(frame, size)
                else:
                    img = _waveform_image(container, size)
            if img is None and had_art_streams:
                with open_media(full_path) as container:
                    img = _waveform_image(container, size)
            if img is None:
                out_path.touch()
                return False
            return _replace_from_temp(out_path, lambda tmp: img.save(str(tmp), format="JPEG", quality=85))
        except Exception as exc:
            _mark_decoder_failure(exc, out_path)
            return False

def _generate_image_thumbnail(full_path: str, out_path: Path, size: int) -> bool:
    if out_path.exists():
        return True
    with _gen_lock(out_path):
        if out_path.exists():
            return True
        try:
            from PIL import Image, ImageOps
            with Image.open(full_path) as img:
                try:
                    img = ImageOps.exif_transpose(img)
                except Exception:
                    pass
                img = img.convert("RGB")
                img.thumbnail((size, size))
                return _replace_from_temp(out_path, lambda tmp: img.save(str(tmp), format="JPEG", quality=85))
        except Exception:
            return False

def _output_root() -> AllowedRoot:
    out = folder_paths.get_output_directory()
    return AllowedRoot(root_id="output", label="Output", path=out)

def _extra_root_id(raw: str) -> tuple[str, str]:
    p = extra_root_path(raw)
    return make_root_id(p), p

_ROOTS_TTL_S = 5.0

class _Roots(NamedTuple):
    roots: list[AllowedRoot]
    sig: tuple | None
    built_at: float

_roots_cache: _Roots | None = None
_roots_refresh_lock = threading.Lock()
_roots_refresh_queued = False

def _config_sig() -> tuple | None:
    return file_sig(config_path())

_config_cache: tuple | None = None
# Set when the parser check found no config read yet, or found the rebuild's
# slot held, so `_hand_over_parser_check` runs it again.
_parser_check_owed = False

def _config_or_last_good(reread: bool = False) -> tuple[SidebarGalleryConfig, str | None, bool]:
    """The config, the reason the file cannot be read or None, and whether the
    defaults answered because no config has been read yet. While the file cannot
    be read the last config read stands in. A lasting failure is remembered
    against the file's signature, since a rebuild asks once per file, so only a
    change to the file or `reread` reads it again."""
    global _config_cache
    sig = _config_sig()
    cached = _config_cache
    if cached is not None and cached[0] == sig and not (reread and cached[2]):
        return cached[1], cached[2], cached[3]
    try:
        cfg = load_config()
    except UnreadableFile as e:
        last, defaults = (SidebarGalleryConfig(), True) if cached is None else (cached[1], cached[3])
        if e.lasting:
            if cached is None or cached[0] != sig or not cached[2]:
                logger.warning("SBG: The folder settings file can't be read, since %s: %s", e.reason, e.__cause__)
            _config_cache = (sig, last, e.reason, defaults)
        return last, e.reason, defaults
    _remember_config(sig, cfg)
    return cfg, None, False

def _hand_over_parser_check() -> None:
    """Runs a parser check left owed, at a moment it may now succeed: a config
    read landing, a scan ending, or a rebuild or search index build letting go
    of the slot."""
    global _parser_check_owed
    if _parser_check_owed:
        # Handed to the scan pool instead of run here, since this reader can be
        # the roots refresh holding the roots lock, which the check takes.
        _parser_check_owed = False
        _SCAN_EXECUTOR.submit(_check_parser_version)

def _remember_config(sig: tuple | None, cfg: SidebarGalleryConfig) -> None:
    global _config_cache
    _config_cache = (sig, cfg, None, False)
    _hand_over_parser_check()

def _cached_config() -> SidebarGalleryConfig:
    return _config_or_last_good()[0]

def _config_for_scan() -> SidebarGalleryConfig | None:
    """None while the file cannot be read and no config has been read yet,
    since the defaults would index folders the real config excludes."""
    cfg, unreadable, defaults = _config_or_last_good()
    if defaults:
        logger.warning(
            "SBG: no scan until the folder settings file can be read: %s", unreadable)
        return None
    return cfg

# A stat of an offline network share can block for seconds, so callers read the
# cached list through _all_roots.
def _build_roots(cfg: SidebarGalleryConfig) -> list[AllowedRoot]:
    roots = [_output_root()]
    for raw in cfg.extra_roots:
        rid, p = _extra_root_id(raw)
        if os.path.isdir(p):
            roots.append(AllowedRoot(root_id=rid, label=os.path.basename(p) or p, path=p))
    return roots

def _refresh_roots() -> _Roots:
    global _roots_cache, _roots_refresh_queued
    with _roots_refresh_lock:
        # Cleared before the file is read, so a change that lands during this
        # refresh queues the next one.
        _roots_refresh_queued = False
        sig = _config_sig()
        # A list built while the file could not be read keeps the file's
        # signature too, so it is rebuilt as it ages instead of on every call.
        _roots_cache = _Roots(_build_roots(_cached_config()), sig, time.monotonic())
        return _roots_cache

def _schedule_roots_refresh() -> None:
    global _roots_refresh_queued
    # One waits at a time, however many calls find the list stale while the pool is busy.
    if _roots_refresh_queued:
        return
    _roots_refresh_queued = True
    _IO_EXECUTOR.submit(_refresh_roots)

def _all_roots() -> list[AllowedRoot]:
    c = _roots_cache
    if c is None:
        return _refresh_roots().roots
    if c.sig != _config_sig() or time.monotonic() - c.built_at >= _ROOTS_TTL_S:
        _schedule_roots_refresh()
    return c.roots

def _find_root(root_id: str) -> AllowedRoot | None:
    for r in _all_roots():
        if r.root_id == root_id:
            return r
    return None

def _media_path(query, exts: frozenset[str] | None = None) -> tuple[AllowedRoot, str]:
    """Stating the path can block as long as an offline network folder takes to
    time out, so every caller runs this on the IO pool."""
    root = _find_root(query.get("root_id", "output"))
    if root is None:
        raise web.HTTPNotFound()
    try:
        full = safe_join(root.path, query.get("relpath", ""))
    except ValueError:
        raise web.HTTPBadRequest()
    if not os.path.isfile(full) or (exts is not None and os.path.splitext(full)[1].lower() not in exts):
        raise web.HTTPNotFound()
    return root, full

def _read_metadata_or_empty(full: str, cfg, label: str) -> MetadataResult:
    try:
        return read_metadata_for_file(
            full,
            max_text_chunk_bytes=cfg.max_text_chunk_bytes,
            max_decompressed_text_bytes=cfg.max_decompressed_text_bytes,
        )
    except Exception as exc:
        logger.warning("SBG: metadata parse failed for %s: %s", label, exc)
        return MetadataResult(prompt=None, workflow=None, parsed={}, raw_text={}, summary={})

def _read_metadata_for_db(full_path: str) -> dict | None:
    summary = _read_metadata_or_empty(full_path, _cached_config(), full_path).summary
    return sanitize_for_json(summary) if summary else None

_SETTINGS_FILENAME = "sidebar_gallery_settings.json"

def _settings_path() -> Path:
    return PACKAGE_ROOT / _SETTINGS_FILENAME

def _read_settings() -> dict:
    """A file set aside for not parsing is replaced on disk by one stamped with
    this version, so the next start does not read the settings written since
    as an older version's. A replacement that cannot be written leaves the
    file missing."""
    path = _settings_path()
    existed = path.exists()
    found = read_json_dict(path)
    if found is not None or not existed:
        return found or {}
    version = extension_version()
    if not version:
        return {}
    fresh = {_SAVED_BY_KEY: version}
    try:
        write_json_atomic(path, fresh)
    except OSError as e:
        logger.warning("SBG: The settings file set aside was not replaced: %s", e)
        return {}
    return fresh

def _write_settings(data: dict) -> tuple | None:
    return write_json_atomic(_settings_path(), data)

_settings_lock = asyncio.Lock()
_settings_state: dict | None = None
_settings_state_sig: tuple | None = None

def _settings_file_sig() -> tuple | None:
    return file_sig(_settings_path())

async def _settings_load_locked() -> dict:
    global _settings_state, _settings_state_sig
    assert_on_loop("_settings_state")
    sig = _settings_file_sig()
    if _settings_state is None or sig != _settings_state_sig:
        loop = asyncio.get_running_loop()
        _settings_state = await loop.run_in_executor(_IO_EXECUTOR, _read_settings)
        _settings_state_sig = sig
    return _settings_state

async def _settings_commit_locked(data: dict) -> None:
    global _settings_state, _settings_state_sig
    assert_on_loop("_settings_state")
    loop = asyncio.get_running_loop()
    sig = await loop.run_in_executor(_IO_EXECUTOR, _write_settings, data)
    _settings_state = data
    _settings_state_sig = sig

class _BadBody(Exception):
    """Carries an error response out of body parsing, which the same-origin
    wrapper turns back into that response."""

    def __init__(self, response: web.Response):
        super().__init__(response.reason)
        self.response = response

async def _json_dict_body(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json(loads=parse_json)
    except Exception:
        raise _BadBody(web.json_response({"error": "Invalid JSON"}, status=400))
    if not isinstance(body, dict):
        raise _BadBody(web.json_response({"error": "Expected a JSON object"}, status=400))
    return body

def _body_float(body: dict, key: str, fallback: float) -> float:
    try:
        return float(body.get(key, fallback))
    except (TypeError, ValueError, OverflowError):
        return fallback

def _body_number(body: dict, key: str) -> float | None:
    val = body.get(key)
    return val if isinstance(val, (int, float)) and not isinstance(val, bool) else None

def _body_str(body: dict, key: str, fallback: str = "") -> str:
    val = body.get(key, fallback)
    return val if isinstance(val, str) else fallback

# A browser states an Origin on a cross-site post, so a request carrying none is not refused.
def _cross_origin(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return False
    host = request.headers.get("Host", "")
    origin_host = origin.split("://", 1)[1] if "://" in origin else origin
    return bool(host) and origin_host.lower() != host.lower()

# Every route that changes state carries this, so a page on another site cannot
# post to it through the browser.
def _same_origin_only(handler):
    @functools.wraps(handler)
    async def wrapper(request: web.Request):
        if _cross_origin(request):
            logger.warning(
                "SBG: refused a %s from origin %s, which does not match host %s",
                request.path, request.headers.get("Origin"), request.headers.get("Host"))
            return web.json_response({"error": "Cross-origin request refused"}, status=403)
        try:
            return await handler(request)
        except _BadBody as bad:
            return bad.response
    return wrapper

# Without this a full disk or a file held open answers a bare 500 the page can
# only show as a status code. Off Windows, a folder spelling holding half of an
# emoji fails the lookup of the variable or user it names, and sending it again
# cannot help, so that is a 400.
def _write_failures_answered(handler):
    @functools.wraps(handler)
    async def wrapper(request: web.Request):
        try:
            return await handler(request)
        except UnicodeError:
            return web.json_response({"error": "the text holds a character this system can't look up"}, status=400)
        except OSError as e:
            logger.warning("SBG: %s could not write its file: %s", request.path, e)
            return web.json_response({"error": os_reason(e)}, status=500)
    return wrapper

# The index helpers raise on a failed read, since an empty answer can decide
# whether a rebuild runs. This turns the raise into a message the page can show,
# with a 503 since a busy index can answer next time.
def _index_reads_answered(handler):
    @functools.wraps(handler)
    async def wrapper(request: web.Request):
        try:
            return await handler(request)
        except sqlite3.Error as e:
            logger.warning("SBG: %s could not read the index: %s", request.path, e)
            return web.json_response({"error": f"the gallery's index couldn't be read ({e})"}, status=503)
    return wrapper

@routes.get("/sidebar_gallery/settings")
async def get_settings(request: web.Request):
    async with _settings_lock:
        try:
            settings = await _settings_load_locked()
        except UnreadableFile as e:
            return _settings_unreadable(e)
        resp = await _json_answer(settings)
        aside = pop_quarantine_notice(_settings_path())
        if aside:
            resp.headers["X-SBG-Settings-Quarantined"] = aside
        copied = pop_copy_notice(_settings_path())
        if copied:
            resp.headers["X-SBG-Settings-Copied"] = copied
        return resp

@routes.post("/sidebar_gallery/settings")
@_same_origin_only
@_write_failures_answered
async def post_settings(request: web.Request):
    body = await _json_dict_body(request)
    key = body.get("key")
    if "key" in body and not isinstance(key, str):
        return web.json_response({"error": "the setting's name isn't text"}, status=400)

    try:
        # A request sent from a closing page carries both shapes, the delta for a
        # server that merges and the whole value for an older one, so the delta
        # is read first.
        if "key" in body and ("add" in body or "remove" in body):
            add = body.get("add", [])
            remove = body.get("remove", [])
            if not isinstance(add, list) or not isinstance(remove, list):
                return web.json_response({"error": "add and remove must be lists"}, status=400)
            async with _settings_lock:
                settings = await _settings_load_locked()
                merged = apply.list_delta(settings.get(key), add, remove)
                await _settings_commit_locked({**settings, key: merged})
            return web.json_response({"ok": True, "key": key, "value": merged})
        elif "key" in body and "value" in body:
            async with _settings_lock:
                settings = dict(await _settings_load_locked())
                if body["value"] is None:
                    settings.pop(key, None)
                else:
                    settings[key] = body["value"]
                await _settings_commit_locked(settings)
            return web.json_response({"ok": True, "key": key})
        else:
            return web.json_response({"error": "Expected {key, value} or {key, add/remove}"}, status=400)
    except UnreadableFile as e:
        return _settings_unreadable(e)

def _settings_unreadable(err: UnreadableFile) -> web.Response:
    """Nothing is written over a file whose content is unknown, and a 503 tells
    the browser to keep its change and send it again."""
    return web.json_response({"error": f"the settings file can't be read ({err.reason})"}, status=503)

def _backups_dir() -> Path:
    return PACKAGE_ROOT / settings_backups.BACKUPS_DIRNAME

# The browser shows each reason after "Couldn't ...:", so each names a cause.
_THEME_GONE = "the theme is no longer there"
_UNKNOWN_ACTION = "restart ComfyUI to finish the update"

_FILE_ACTIONS = ("save", "rename", "delete", "pin")

# The extension version that last ran against the settings file, which no browser reads or writes.
_SAVED_BY_KEY = "_sbg_saved_by"
# Set when the file was last used by a newer version, and cleared by the browser
# once it has shown the notice.
_DOWNGRADED_FROM_KEY = "SBG._downgradedFrom"
# Keys that record the install instead of anything the person chose, so no copy
# takes them and no restore puts them back.
_INSTALL_KEYS = (_SAVED_BY_KEY, _DOWNGRADED_FROM_KEY)
# When what a preset carries last changed, which the browser writes on every such
# change and the Presets tab's Current row shows.
_CHANGED_KEY = "SBG.SettingsChanged"

async def _pin_settings_before_new_version() -> None:
    new = extension_version()
    if not new:
        return
    async with _settings_lock:
        try:
            settings = await _settings_load_locked()
        except UnreadableFile as e:
            logger.warning("SBG: Settings not pinned, the file could not be read: %s", e)
            return
        old = settings.get(_SAVED_BY_KEY)
        if old == new:
            return
        loop = asyncio.get_running_loop()
        back = downgraded_from(old, new)
        keys = [k for k in settings if k not in _INSTALL_KEYS]
        stamped = {**settings, _SAVED_BY_KEY: new}
        if keys:
            cause = f"before-{new}-from-{old or 'unknown'}"
            # This copy is taken at start-up with no page asking for it, so the
            # row's title is written here.
            title = f"Before going back to v{new}" if back else f"Before updating to v{new}"
            async with _presets_lock:
                colours = await loop.run_in_executor(
                    _IO_EXECUTOR, apply.colours_record, _THEMES_DIR, settings.get(apply.THEME_KEY))
            await loop.run_in_executor(_IO_EXECUTOR, functools.partial(
                settings_backups.snapshot, _backups_dir(), settings, keys, cause, pinned=True, whole=True, title=title,
                **colours))
            logger.info("SBG: Settings pinned before first run of %s", new)
            # A version from before this key never wrote it, so the file's own
            # time stands in.
            if _CHANGED_KEY not in settings:
                try:
                    stamped[_CHANGED_KEY] = int(_settings_path().stat().st_mtime * 1000)
                except OSError:
                    pass
        if back:
            stamped[_DOWNGRADED_FROM_KEY] = back
            logger.info("SBG: Settings were last used by %s, which is newer than %s", back, new)
        await _settings_commit_locked(stamped)

@routes.get("/sidebar_gallery/settings_backups")
async def get_settings_backups(request: web.Request):
    loop = asyncio.get_running_loop()
    rows = await loop.run_in_executor(_IO_EXECUTOR, settings_backups.list_backups, _backups_dir())
    return await _json_answer({"backups": rows, "ring_size": settings_backups.RING_SIZE, **await _install_digests()})

async def _install_digests() -> dict:
    """This install's layouts digested from the settings file, for a listing
    whose closed rows compare a stored preset's or copy's layout digests with
    them, or why they could not be taken."""
    async with _settings_lock:
        try:
            settings = await _settings_load_locked()
        except UnreadableFile as e:
            return {"layout_digests": None, "layout_digests_error": e.reason}
    loop = asyncio.get_running_loop()
    try:
        digests = await loop.run_in_executor(_IO_EXECUTOR, install_layout_digests, settings)
    except RecursionError:
        return {"layout_digests": None, "layout_digests_error": "a layout is nested too deep to compare"}
    return {"layout_digests": digests}

@routes.post("/sidebar_gallery/settings_backups")
@_same_origin_only
@_write_failures_answered
async def post_settings_backups(request: web.Request):
    body = await _json_dict_body(request)
    action = _body_str(body, "action")
    loop = asyncio.get_running_loop()
    if action not in ("read", "pin", "delete"):
        return web.json_response({"error": _UNKNOWN_ACTION}, status=400)

    # A delete takes any name the listing can show, a file put in the folder by
    # hand included. Every other action reads the file, so it takes only the
    # names read_backup reads.
    raw_name = _body_str(body, "filename")
    filename = json_filename(raw_name) if action == "delete" else settings_backups.safe_filename(raw_name)
    if not filename:
        return web.json_response({"error": FILENAME_REFUSED}, status=400)

    if action == "read":
        doc = await loop.run_in_executor(_IO_EXECUTOR, settings_backups.read_backup, _backups_dir(), filename)
        if doc is None:
            return web.json_response({"error": settings_backups.UNREAD}, status=404)
        return await _json_answer({"ok": True, "doc": doc})

    if action == "pin":
        row = await loop.run_in_executor(
            _IO_EXECUTOR, settings_backups.set_pinned, _backups_dir(), filename, bool(body.get("pinned")))
        if row is None:
            return web.json_response({"error": settings_backups.UNREAD}, status=404)
        return web.json_response({"ok": True, "backup": row})

    try:
        where = await loop.run_in_executor(
            _IO_EXECUTOR, settings_backups.discard, _backups_dir(), filename, _discard_sync)
    except OSError as e:
        return _discard_failed(_backups_dir() / filename, e)
    return web.json_response({"ok": True, "where": where})

@routes.post("/sidebar_gallery/apply")
@_same_origin_only
@_write_failures_answered
async def post_apply(request: web.Request):
    body = await _json_dict_body(request)
    loop = asyncio.get_running_loop()
    try:
        req = apply.parse(body)
        async with _settings_lock:
            try:
                settings = await _settings_load_locked()
            except UnreadableFile as e:
                return _settings_unreadable(e)
            async with _presets_lock:
                plan = await loop.run_in_executor(_IO_EXECUTOR, functools.partial(
                    apply.plan, req, settings, _backups_dir(), _THEMES_DIR, _INSTALL_KEYS, _CHANGED_KEY,
                    int(time.time() * 1000), _PRESET_NAME_MAX))
                done = await loop.run_in_executor(_IO_EXECUTOR, apply.write_files, plan, _backups_dir(), _THEMES_DIR)
                if plan.written:
                    try:
                        await _settings_commit_locked(plan.after)
                    except OSError as e:
                        if await loop.run_in_executor(_IO_EXECUTOR, apply.take_back, done, _backups_dir(), _THEMES_DIR):
                            return web.json_response({"error": f"the settings couldn't be saved ({os_reason(e)}), so nothing changed"}, status=500)
                        await loop.run_in_executor(_IO_EXECUTOR, functools.partial(
                            settings_backups.prune, _backups_dir(), protect=plan.protect))
                        return web.json_response({"error": f"the settings couldn't be saved ({os_reason(e)}), and the theme "
                                                  "kept its new colors, since they couldn't be taken off again"}, status=500)
                if done.copy:
                    await loop.run_in_executor(_IO_EXECUTOR, functools.partial(
                        settings_backups.prune, _backups_dir(), protect=plan.protect))
    except apply.Refused as r:
        return web.json_response(r.payload, status=r.status)
    return await _json_answer({"ok": True, "written": plan.written, "backup": done.copy, "theme": done.theme, **plan.answer})

def _mark_parser_version_current():
    media_db.set_meta_value("parser_version", str(PARSER_VERSION))

def _root_parser_key(rid: str) -> str:
    return media_db.root_meta_key("parser_version", rid)

# Every configured root, an offline folder included, while _all_roots lists only the folders that resolve.
def _configured_root_ids() -> set[str]:
    ids = {"output"}
    for raw in _cached_config().extra_roots:
        ids.add(_extra_root_id(raw)[0])
    return ids

# The startup check reads the global stamp, so it lands only once every configured root is current.
def _maybe_stamp_global_parser_version():
    cur = str(PARSER_VERSION)
    for rid in _configured_root_ids():
        if media_db.get_meta_value(_root_parser_key(rid)) != cur:
            return
    _mark_parser_version_current()

def _start_full_reindex(roots: list[AllowedRoot]) -> bool:
    # The progress entries hold only scans that report progress, so the running
    # scans are checked too. A scan checks for a rebuild and takes its entry under
    # this lock, so checking and claiming under it keeps the two from both
    # starting.
    with _inflight_scans_lock:
        if any(not h.future.done() for h in _inflight_scans.values()):
            return False
        token = media_db.claim_full_reindex()
    if token is None:
        return False

    def _bg_reindex():
        failed: str | None = None
        try:
            cfg = _config_for_scan()
            if cfg is None:
                raise RuntimeError("the folder settings file could not be read, so nothing was rebuilt")
            excluded = set(cfg.excluded_dirs)
            for root in roots:
                # The list was taken before this thread started, and a folder
                # dropped since would have its purged rows written back.
                if root.root_id != "output" and root.root_id not in _configured_root_ids():
                    logger.info(
                        "SBG: skipping reindex of %s (removed from config)", root.root_id)
                    continue
                try:
                    unlisted: list[str] = []
                    media_db.full_reindex(
                        root, _read_metadata_for_db,
                        excluded_dirs=excluded,
                        index_hidden_dirs=cfg.index_hidden_dirs,
                        token=token,
                        unlisted=unlisted,
                    )
                    # The stamp says this parser read every file under the root,
                    # so a pass that could not read a folder or a file leaves the
                    # root stale for the startup check to find.
                    if unlisted:
                        logger.info(
                            "SBG: %s keeps its old parser stamp, since a folder or a file "
                            "could not be read this pass", root.root_id)
                    else:
                        media_db.set_meta_value(_root_parser_key(root.root_id), str(PARSER_VERSION))
                except Exception as e:
                    failed = str(e)
                    logger.error("SBG: reindex failed for %s: %s", root.root_id, e)
            try:
                _maybe_stamp_global_parser_version()
            except sqlite3.Error as e:
                failed = str(e)
                logger.error(
                    "SBG: reindex finished, but the index could not be read to stamp the parser version: %s", e)
        except Exception as e:
            failed = str(e)
            logger.error("SBG: reindex failed before any folder was read: %s", e)
        finally:
            media_db.release_full_reindex(token, "error" if failed else "done", failed)
            _hand_over_parser_check()

    threading.Thread(target=_bg_reindex, daemon=True).start()
    return True

@routes.post("/sidebar_gallery/rebuild_index")
@_same_origin_only
async def rebuild_index(request: web.Request):
    started = _start_full_reindex(_all_roots())
    return web.json_response({"status": "started" if started else "already_running"})

_PROGRESS_PUSH_MIN_S = 0.4
_progress_push_lock = threading.Lock()
_last_progress_push = 0.0

def _push_progress(final: bool) -> None:
    global _last_progress_push
    now = time.monotonic()
    with _progress_push_lock:
        if not final and now - _last_progress_push < _PROGRESS_PUSH_MIN_S:
            return
        _last_progress_push = now
    try:
        server.PromptServer.instance.send_sync("sbg.progress", media_db.get_progress())
    except Exception:
        logger.debug("SBG: progress push failed", exc_info=True)

@routes.get("/sidebar_gallery/reindex_progress")
async def reindex_progress(request: web.Request):
    return web.json_response(media_db.get_progress())

def _config_payload(cfg, quarantined: str | None = None, unreadable: str | None = None,
                    copied: str | None = None, config_read: bool = True) -> dict:
    return {
        **{name: getattr(cfg, name) for name in CONFIG_PUBLIC_FIELDS},
        "roots": [{"id": r.root_id, "label": r.label, "path": r.path if r.root_id != "output" else None}
                  for r in _all_roots()],
        "config_path": str(config_path()),
        "search_schema": schema.search_schema_payload(),
        "quarantined": quarantined,
        "unreadable": unreadable,
        "copied": copied,
        # False when the folder fields are the defaults, since no config has been read yet.
        "config_read": config_read,
    }

@routes.get("/sidebar_gallery/config")
async def get_config(request: web.Request):
    # A file that cannot be read still answers, with the last config read and the
    # reason, since the gallery's first load waits on this for the search schema
    # as well as the folders. `reread` lets the Try again button read a file
    # remembered as unreadable.
    def _answer() -> bytes:
        cfg, unreadable, defaults = _config_or_last_good(reread=True)
        return _encode_json(_config_payload(
            cfg, pop_quarantine_notice(config_path()), unreadable,
            pop_copy_notice(config_path()), config_read=not defaults))

    loop = asyncio.get_running_loop()
    return _encoded_response(await loop.run_in_executor(_IO_EXECUTOR, _answer))

_BG_TASKS: set = set()

# A task nothing holds a reference to can be collected while it is still running.
def _keep_task(task) -> None:
    assert_on_loop("_BG_TASKS")
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)

_PURGE_TRIES = 5
_PURGE_RETRY_S = 30

async def _purge_removed_roots(root_ids: set[str]) -> None:
    loop = asyncio.get_running_loop()
    waited = 0.0
    # A rebuild cannot be cancelled and can write back the rows this purge
    # deletes, so the purge waits for it.
    while media_db.is_full_reindex_running():
        await asyncio.sleep(1.0)
        waited += 1.0
    if waited:
        logger.info("SBG: purge waited %.0fs for a full rebuild to finish", waited)
    still_roots = await loop.run_in_executor(_IO_EXECUTOR, _configured_root_ids)
    for rid in root_ids:
        if rid in still_roots:
            logger.info("SBG: skipping purge for re-added root %s", rid)
            continue
        with _inflight_scans_lock:
            handle = _inflight_scans.get(rid)
        if handle is not None and not handle.future.done():
            handle.cancel_event.set()
            await _await_scan(handle.future)
        # A search index build does not hold a purge back, and its last step
        # holds the write lock, so a busy index is asked again a little later.
        for attempt in range(_PURGE_TRIES):
            try:
                n = await loop.run_in_executor(_IO_EXECUTOR, media_db.delete_root_rows, rid)
                if n:
                    logger.info("SBG: purged %d indexed row(s) for removed root %s", n, rid)
                break
            except sqlite3.OperationalError:
                if attempt + 1 == _PURGE_TRIES:
                    logger.warning("SBG: failed to purge rows for removed root %s", rid, exc_info=True)
                    break
                await asyncio.sleep(_PURGE_RETRY_S)
                if rid in await loop.run_in_executor(_IO_EXECUTOR, _configured_root_ids):
                    logger.info("SBG: skipping purge for re-added root %s", rid)
                    break
            except Exception:
                logger.warning("SBG: failed to purge rows for removed root %s", rid, exc_info=True)
                break

_config_lock = asyncio.Lock()

@routes.post("/sidebar_gallery/config")
@_same_origin_only
@_write_failures_answered
async def post_config(request: web.Request):
    data = await _json_dict_body(request)
    for key in ("excluded_dirs_add", "excluded_dirs_remove", "extra_roots_remove"):
        if key in data and not isinstance(data[key], list):
            return web.json_response({"error": f"{key} must be a list"}, status=400)

    def _apply():
        listed, saved, sig = write_config(data)
        # Remembered under the signature the write left, so a file another program
        # holds right after the save still answers with what was saved.
        _remember_config(sig, saved)
        _refresh_roots()
        return listed, saved

    loop = asyncio.get_running_loop()
    try:
        async with _config_lock:
            listed, cfg = await loop.run_in_executor(_IO_EXECUTOR, _apply)
    except UnreadableFile as e:
        return web.json_response(
            {"error": f"the folder settings file can't be read ({e.reason}), so nothing was changed"},
            status=503)

    # Diffed against the folders the file listed instead of _all_roots, so a root
    # that is only offline keeps its rows.
    removed_ids = ({_extra_root_id(p)[0] for p in listed}
                   - {_extra_root_id(p)[0] for p in cfg.extra_roots})
    if removed_ids:
        task = asyncio.create_task(_purge_removed_roots(removed_ids))
        _keep_task(task)

    return await _json_answer(_config_payload(cfg))

@routes.get("/sidebar_gallery/subfolders")
@_index_reads_answered
async def get_subfolders(request: web.Request):
    root_id = request.rel_url.query.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    def _build():
        raw_folders = media_db.get_subfolders(root_id)
        folders = set(raw_folders)
        for sf in raw_folders:
            parts = sf.split("/")
            for i in range(1, len(parts)):
                folders.add("/".join(parts[:i]))
        return sorted(folders)

    loop = asyncio.get_running_loop()
    sorted_folders = await loop.run_in_executor(_IO_EXECUTOR, _build)
    return await _json_answer({"subfolders": sorted_folders})

_last_scan_times: dict[str, float] = {}
_SCAN_COOLDOWN_S = 5.0
_POLL_SCAN_FALLBACK_S = 60.0

class _ScanHandle:
    __slots__ = ("future", "cancel_event")

    def __init__(self, future: asyncio.Future, cancel_event: threading.Event):
        self.future = future
        self.cancel_event = cancel_event

_inflight_scans: dict[str, _ScanHandle] = {}
_inflight_scans_lock = threading.Lock()

def _clear_inflight_scan(fut: asyncio.Future, root_id: str) -> None:
    with _inflight_scans_lock:
        handle = _inflight_scans.get(root_id)
        if handle is not None and handle.future is fut:
            _inflight_scans.pop(root_id, None)
    _hand_over_parser_check()

def _log_scan_failure(fut: asyncio.Future, root_id: str) -> None:
    if fut.cancelled():
        return
    exc = fut.exception()
    if exc is not None:
        logger.warning(
            "SBG: background scan of %s failed: %s", root_id, exc)

def _forget_scan_that_waited(fut: asyncio.Future, root_id: str) -> None:
    # A scan that answered nothing waited for the config, so the next poll tries
    # again instead of sitting out the cooldown.
    if fut.cancelled() or fut.exception() is not None or fut.result() is not None:
        return
    assert_on_loop("_last_scan_times")
    _last_scan_times.pop(root_id, None)

async def _await_scan(fut):
    if fut is None:
        return None
    try:
        return await fut
    except Exception:
        return None

def _maybe_scan(root, force: bool, interval_s: float | None = None):
    root_id = root.root_id
    cancel_event = threading.Event()

    def _run():
        _scan_cfg = _config_for_scan()
        if _scan_cfg is None:
            return None
        first_index = media_db.get_meta_value(media_db.root_meta_key("indexed", root_id)) is None
        # An interrupted first index leaves rows and no marker, so only a scan that
        # started from no rows has read them all with this parser.
        fresh_root = first_index and media_db.get_count(root_id) == 0
        result = media_db.incremental_scan(
            root,
            read_metadata_fn=_read_metadata_for_db,
            excluded_dirs=set(_scan_cfg.excluded_dirs),
            index_hidden_dirs=_scan_cfg.index_hidden_dirs,
            # Only a first index reports progress, so a rescan from a poll never
            # flashes the progress line.
            report_progress=first_index,
            cancel_event=cancel_event,
        )
        if fresh_root and result.complete:
            media_db.set_meta_value(_root_parser_key(root_id), str(PARSER_VERSION))
            _maybe_stamp_global_parser_version()
        return result

    loop = asyncio.get_running_loop()
    # Held from the rebuild check to the entry, since a rebuild checks this table
    # under the same lock.
    with _inflight_scans_lock:
        if media_db.is_full_reindex_running():
            return None
        inflight = _inflight_scans.get(root_id)
        if inflight is not None and not inflight.future.done():
            return inflight.future
        now = time.time()
        cooldown = _SCAN_COOLDOWN_S if interval_s is None else interval_s
        assert_on_loop("_last_scan_times")
        if not force and (now - _last_scan_times.get(root_id, 0)) < cooldown:
            return None
        _last_scan_times[root_id] = now
        scan_future = loop.run_in_executor(_SCAN_EXECUTOR, _run)
        _inflight_scans[root_id] = _ScanHandle(scan_future, cancel_event)
    scan_future.add_done_callback(lambda f, _rid=root_id: _clear_inflight_scan(f, _rid))
    scan_future.add_done_callback(lambda f, _rid=root_id: _log_scan_failure(f, _rid))
    scan_future.add_done_callback(lambda f, _rid=root_id: _forget_scan_that_waited(f, _rid))
    return scan_future

# A row is stamped when its write runs and shows to a reader only once its batch
# commits, which can be the 30 seconds a writer waits for the write lock later.
# So the time a page takes as its cursor is read before the rows are and stands
# this far behind, and the page drops a row it already holds.
_COMMIT_LAG_S = 40.0

def _cursor_now() -> float:
    return time.time() - _COMMIT_LAG_S

def _build_list_all(root, thumb_size):
    root_id = root.root_id
    cursor = _cursor_now()
    db_version, db_items = media_db.get_all_with_version(root_id)
    rid_q = quote(root_id)
    return {
        "items": [_row_item(row, thumb_size, rid_q) for row in db_items],
        "server_time": cursor,
        "meta_epoch": media_db.get_meta_epoch(),
        "db_version": db_version,
    }

# Below about one network packet, compressing costs more than it saves.
_COMPRESS_MIN_BYTES = 1400

def _encode_json(payload) -> bytes:
    # Python writes a bare NaN or Infinity by default, which no browser parses,
    # so one raises here instead.
    return json.dumps(payload, allow_nan=False).encode("utf-8")

# aiohttp compresses on the IO pool as it sends. ComfyUI's response compression
# option turns the same compression on for every JSON answer, and turning it on
# twice changes nothing. A body compressed here by hand would be compressed a
# second time.
def _encoded_response(body: bytes) -> web.Response:
    resp = web.Response(body=body, content_type="application/json", headers={"Vary": "Accept-Encoding"},
                        zlib_executor_size=0, zlib_executor=_IO_EXECUTOR)
    if len(body) > _COMPRESS_MIN_BYTES:
        resp.enable_compression()
    return resp

async def _json_answer(payload) -> web.Response:
    loop = asyncio.get_running_loop()
    return _encoded_response(await loop.run_in_executor(_IO_EXECUTOR, _encode_json, payload))

def _build_list_all_encoded(root, thumb_size):
    payload = _build_list_all(root, thumb_size)
    return len(payload["items"]), _encode_json(payload)

@routes.get("/sidebar_gallery/list_all")
@_index_reads_answered
async def list_all_media(request: web.Request):
    root_id = request.rel_url.query.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    force = request.rel_url.query.get("rescan") in {"1", "true", "yes"}
    thumb_size = _clamped_int(request.rel_url.query.get("thumb_size"), 512)

    scan_future = _maybe_scan(root, force)
    if force:
        await _await_scan(scan_future)

    loop = asyncio.get_running_loop()
    total, body = await loop.run_in_executor(_IO_EXECUTOR, _build_list_all_encoded, root, thumb_size)

    # An empty list while a first scan is still running would read as an empty
    # folder, so the reply waits for it.
    if not force and total == 0 and scan_future is not None and not scan_future.done():
        await _await_scan(scan_future)
        total, body = await loop.run_in_executor(_IO_EXECUTOR, _build_list_all_encoded, root, thumb_size)

    return _encoded_response(body)

@routes.get("/sidebar_gallery/poll")
@_index_reads_answered
async def poll_changes(request: web.Request) -> web.Response:
    root_id = request.rel_url.query.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)
    eager = request.rel_url.query.get("eager") in {"1", "true", "yes"}
    loop = asyncio.get_running_loop()
    if eager:
        await _await_scan(_maybe_scan(root, force=False))
    else:
        refresh_s = await loop.run_in_executor(_IO_EXECUTOR, lambda: _cached_config().auto_refresh_interval_s)
        _maybe_scan(root, force=False,
                    interval_s=max(_SCAN_COOLDOWN_S, float(refresh_s) or _POLL_SCAN_FALLBACK_S))
    version, count = await loop.run_in_executor(
        _IO_EXECUTOR, lambda: (media_db.get_root_version(root_id), media_db.get_count(root_id)))
    return web.json_response({
        "db_version": version,
        "count": count,
        "meta_epoch": media_db.get_meta_epoch(),
        "reindexing": media_db.is_full_reindex_running(),
    })

def _process_new_files(root, root_id: str, files: list, thumb_size: int) -> list[dict]:
    cfg = _config_for_scan()
    if cfg is None:
        return []
    excluded = set(cfg.excluded_dirs)
    found = []
    for f in files:
        # Each entry is a finished run's own report of a file it wrote, which a
        # custom node can fill with anything.
        if not isinstance(f, dict):
            continue
        fname = _body_str(f, "filename")
        subfolder = _body_str(f, "subfolder").replace("\\", "/")
        ftype = f.get("type", "output")
        # A file the run wrote to the input or temp folder does not resolve under the Output root.
        if ftype != "output" and root_id == "output":
            continue

        relpath = f"{subfolder}/{fname}" if subfolder else fname
        if not media_db.storable_name(relpath):
            logger.warning(
                "SBG: generated file %r is left out of the index, since its name "
                "is not valid UTF-8 and cannot be stored", relpath)
            continue
        try:
            full = safe_join(root.path, relpath)
        except ValueError:
            continue
        if not os.path.isfile(full):
            continue

        ext = os.path.splitext(fname)[1].lower()
        if ext not in ALL_MEDIA_EXTS:
            continue
        # A run can write into an excluded folder, and a card the count leaves out
        # would make every poll disagree and fetch the whole list again.
        if media_db.path_excluded(relpath, excluded, not cfg.index_hidden_dirs):
            continue
        try:
            st = os.stat(full)
        except OSError:
            continue
        relpath = os.path.relpath(full, root.path).replace("\\", "/")
        found.append((relpath, ext, st, _read_metadata_for_db(full)))

    out_items: list[dict] = []
    # Every file is read before the first row is written, since that write opens
    # the transaction and holding it through the reads would block every other writer.
    with media_db.connect() as conn:
        for relpath, ext, st, meta_dict in found:
            kind = kind_from_ext(ext)
            size, mtime, ctime = int(st.st_size), float(st.st_mtime), float(st.st_ctime)
            media_db.upsert_file(conn, root_id, relpath, ext, kind, size, mtime,
                                 json.dumps(meta_dict) if meta_dict else None, ctime=ctime)
            # ComfyUI numbers a new file after the highest one there, so a run can
            # reuse the name of a file deleted outside the gallery, whose row is
            # hidden. The file is on disk again, so the mark is lifted here instead
            # of at the next scan.
            media_db.clear_missing_mark(conn, root_id, relpath)
            out_items.append(_client_item(
                root_id, relpath, ext, kind, size, mtime, ctime, thumb_size,
                quote(root.root_id), w=meta_dict.get("width") if meta_dict else None,
                h=meta_dict.get("height") if meta_dict else None))
    return out_items

def _build_since_items(root, thumb_size: int, since: float) -> list[dict]:
    rid_q = quote(root.root_id)
    return [_row_item(row, thumb_size, rid_q) for row in media_db.get_rows_since(root.root_id, since)]

# Two body shapes: `files` as a finished run reports them, or `since` with
# `known_version` for the delta.
@routes.post("/sidebar_gallery/list_new")
@_same_origin_only
@_index_reads_answered
async def list_new_media(request: web.Request):
    body = await _json_dict_body(request)
    root_id = body.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    thumb_size = _clamped_int(body.get("thumb_size"), 512)

    files = body.get("files")
    removed_relpaths: list[str] = []
    stale = False
    stamp_version: int | None = None
    loop = asyncio.get_running_loop()
    cursor = _cursor_now()

    if files and isinstance(files, list):
        if root_id != "output":
            # Output-typed files belong to the Output root. They are dropped with a
            # 200, since an error sends the caller back for this root's whole list.
            kept = [f for f in files if not (isinstance(f, dict) and f.get("type", "output") == "output")]
            if len(kept) < len(files):
                logger.warning(
                    "SBG: %d generated file(s) asked about against root %s were left out, since "
                    "output-typed files resolve under the Output root only", len(files) - len(kept), root_id)
            files = kept
        out_items = await loop.run_in_executor(
            _IO_EXECUTOR, _process_new_files, root, root_id, files, thumb_size) if files else []
    else:
        since = _body_float(body, "since", 0)
        known_version = body.get("known_version")
        _maybe_scan(root, force=False)
        # Read before the removals, so a client never stamps a version whose
        # removals it has not seen.
        stamp_version = await loop.run_in_executor(
            _IO_EXECUTOR, media_db.get_root_version, root_id)
        if isinstance(known_version, int):
            removals = await loop.run_in_executor(
                _IO_EXECUTOR, media_db.get_removals_since, root_id, known_version)
            if removals is None:
                # A known_version older than the removal log reaches cannot be
                # answered with a delta, so the caller fetches the whole list again.
                stale = True
            else:
                removed_relpaths = removals
        out_items = await loop.run_in_executor(
            _IO_EXECUTOR, _build_since_items, root, thumb_size, since)

    def _tail_counts():
        version = stamp_version if stamp_version is not None else media_db.get_root_version(root_id)
        return version, media_db.get_count(root_id)

    tail_version, tail_count = await loop.run_in_executor(_IO_EXECUTOR, _tail_counts)

    return await _json_answer({
        "items": out_items,
        "removed": removed_relpaths,
        "stale": stale,
        "server_time": cursor,
        "db_version": tail_version,
        "count": tail_count,
        "meta_epoch": media_db.get_meta_epoch(),
    })

def _backfill(root_id: str, stored_rel: str, full: str, st: os.stat_result, db_row: dict | None, summary: dict) -> None:
    """Stores the metadata a request read for a file the scan has not reached,
    or whose stored summary is empty, so search and the next request see it."""
    try:
        if db_row and (db_row.get("metadata_json") or db_row.get("missing_since")):
            return
        if not db_row or summary:
            ext = os.path.splitext(stored_rel)[1].lower()
            if ext not in ALL_MEDIA_EXTS:
                return
            # A file system that folds letter case opens the file under any
            # spelling, so a new row is made only when the file and every folder
            # on its way are spelled as their folders list them.
            if not db_row:
                path = full
                for _ in stored_rel.split("/"):
                    path, name = os.path.split(path)
                    if name not in os.listdir(path):
                        return
            with media_db.connect() as conn:
                media_db.upsert_file(conn, root_id, stored_rel, ext, kind_from_ext(ext),
                                     int(st.st_size), float(st.st_mtime),
                                     json.dumps(summary) if summary else None,
                                     ctime=float(st.st_ctime))
        elif not db_row.get("meta_mtime"):
            media_db.mark_meta_attempted(root_id, stored_rel)
    except Exception as e:
        logger.warning(
            "SBG: the metadata read for %s was not stored in the index: %s", stored_rel, e)

def _metadata_answer(query) -> bytes:
    root_id = query.get("root_id", "output")
    relpath_clean = query.get("relpath", "").replace("\\", "/")
    root = _find_root(root_id)
    if root is None:
        raise web.HTTPNotFound()
    file_fields = {"root_id": root_id, "relpath": relpath_clean, "filename": os.path.basename(relpath_clean)}

    db_row = None
    summary_only = query.get("summary_only") in {"1", "true"}
    if summary_only:
        db_row = media_db.get_file(root_id, relpath_clean)
        # A hidden row keeps its summary so it can come back whole, and answering
        # from it would open the lightbox's metadata panel over a file that is not
        # there. The full read answers 404 for it too.
        if db_row and db_row.get("missing_since"):
            raise web.HTTPNotFound()
        if db_row and db_row.get("metadata_json"):
            try:
                summary = sanitize_for_json(json.loads(db_row["metadata_json"]))
            except Exception:
                summary = {}
            return _encode_json({"file": {**file_fields, "size": db_row["size"], "mtime": db_row["mtime"]},
                                 "summary": summary})

    _, full = _media_path(query)
    try:
        st = os.stat(full)
    except FileNotFoundError:
        # A delete can land between the check in _media_path and this stat.
        raise web.HTTPNotFound()
    md = _read_metadata_or_empty(full, _cached_config(), relpath_clean)

    # The request's spelling can differ from the file's, as ./a.png or a//b.png
    # does, and a row stored under it would be a second row for one file.
    stored_rel = os.path.relpath(full, root.path).replace("\\", "/")
    if not summary_only or stored_rel != relpath_clean:
        db_row = media_db.get_file(root_id, stored_rel)
    summary = sanitize_for_json(md.summary)
    # The indexed summary wins over the fresh parse, since search matches against the indexed copy.
    if db_row and db_row.get("metadata_json"):
        try:
            summary = json.loads(db_row["metadata_json"])
        except Exception:
            pass
    _backfill(root_id, stored_rel, full, st, db_row, summary)
    return _encode_json(sanitize_for_json({
        "file": {**file_fields, "size": int(st.st_size), "mtime": float(st.st_mtime)},
        "prompt": md.prompt,
        "workflow": md.workflow,
        "summary": summary,
        "parsed": md.parsed,
    }))

@routes.get("/sidebar_gallery/metadata")
@_index_reads_answered
async def get_metadata(request: web.Request):
    loop = asyncio.get_running_loop()
    return _encoded_response(await loop.run_in_executor(_IO_EXECUTOR, _metadata_answer, request.rel_url.query))

@routes.get("/sidebar_gallery/metadata_ondemand")
async def get_metadata_ondemand(request: web.Request):
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "")
    ftype = request.rel_url.query.get("type", "input")
    folders = {"input": folder_paths.get_input_directory, "output": folder_paths.get_output_directory,
               "temp": folder_paths.get_temp_directory}
    if not filename or ftype not in folders:
        return web.Response(status=400)
    relpath = f"{subfolder}/{filename}" if subfolder else filename

    def _answer() -> bytes:
        try:
            full = safe_join(folders[ftype](), os.path.join(subfolder, filename))
        except ValueError:
            raise web.HTTPBadRequest()
        if not os.path.isfile(full):
            raise web.HTTPNotFound()
        st = os.stat(full)
        md = _read_metadata_or_empty(full, _cached_config(), relpath)
        return _encode_json(sanitize_for_json({
            "file": {
                "filename": filename,
                "subfolder": subfolder,
                "relpath": relpath,
                "type": ftype,
                "size": int(st.st_size),
                "mtime": float(st.st_mtime),
            },
            "summary": md.summary or {},
        }))

    loop = asyncio.get_running_loop()
    try:
        body = await loop.run_in_executor(_IO_EXECUTOR, _answer)
    except FileNotFoundError:
        return web.Response(status=404)
    except OSError as e:
        return web.json_response({"error": os_reason(e)}, status=500)
    return _encoded_response(body)

@routes.get("/sidebar_gallery/file")
async def get_file(request: web.Request):
    query = request.rel_url.query

    def _locate():
        _, full = _media_path(query)
        # The long cache is offered only while v matches the file's modification
        # time, so a rewrite at the same path is fetched again.
        try:
            v_matches = query.get("v", "") == str(int(os.stat(full).st_mtime * 1000))
        except OSError:
            v_matches = False
        return full, v_matches

    loop = asyncio.get_running_loop()
    full, v_matches = await loop.run_in_executor(_IO_EXECUTOR, _locate)
    filename = os.path.basename(full).replace('"', "").replace("\r", "").replace("\n", "")
    ext = os.path.splitext(full)[1].lower()
    # An allow list, since the guess comes partly from the OS type table and a
    # deny list would miss a synonym.
    content_type = guess_mime(full) if ext in ALL_MEDIA_EXTS else "application/octet-stream"
    cache_control = _IMMUTABLE if (content_type.startswith("image/") and v_matches) else "no-cache"
    return web.FileResponse(
        full,
        headers={
            "Content-Disposition": f"inline; filename=\"{filename}\"",
            "Content-Type": content_type,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": cache_control,
        },
    )

@routes.get("/sidebar_gallery/preview")
async def get_preview(request: web.Request):
    query = request.rel_url.query
    size = _clamped_int(query.get("size"), 256)

    def _thumbnail():
        _, full = _media_path(query, IMAGE_EXTS)
        out = _image_thumb_path(full, size)
        ready = _cached_thumb(out)
        return full, out, _generate_image_thumbnail(full, out, size) if ready is None else ready

    loop = asyncio.get_running_loop()
    full, out, ready = await loop.run_in_executor(_IO_EXECUTOR, _thumbnail)
    # A picture no thumbnail can be made from is sent whole.
    return _thumb_response(out) if ready else web.FileResponse(full)

@routes.get("/sidebar_gallery/video_thumb")
async def get_video_thumb(request: web.Request):
    size = _clamped_int(request.rel_url.query.get("size"), 256)
    return await _serve_decoded(request.rel_url.query, None, lambda full: _video_thumb_path(full, size),
                                lambda full, out: _generate_video_thumbnail(full, out, size))

@routes.get("/sidebar_gallery/audio_thumb")
async def get_audio_thumb(request: web.Request):
    size = _clamped_int(request.rel_url.query.get("size"), 256)
    return await _serve_decoded(request.rel_url.query, AUDIO_EXTS, lambda full: _audio_thumb_path(full, size),
                                lambda full, out: _generate_audio_thumbnail(full, out, size))

def _moved_to(where: str) -> str:
    return recycle.bin_label() if where == "bin" else "the gallery's trash folder"

@routes.post("/sidebar_gallery/delete")
@_same_origin_only
async def delete_media(request: web.Request) -> web.Response:
    """Moves the file to the OS recycle bin, or into its own root's trash
    folder when no bin can be reached for it."""
    body = await _json_dict_body(request)
    root = _find_root(_body_str(body, "root_id"))
    if root is None:
        return web.json_response({"error": "the gallery has no such folder"}, status=404)
    relpath = _body_str(body, "relpath")
    loop = asyncio.get_running_loop()
    try:
        where, trashed_to = await loop.run_in_executor(
            _IO_EXECUTOR, functools.partial(media_db.trash_file, root.path, root.root_id, relpath,
                                            expect_mtime=_body_number(body, "mtime"),
                                            expect_size=_body_number(body, "size")))
    except ValueError:
        return web.json_response({"error": "the path leads outside its folder"}, status=400)
    except media_db.FileChanged:
        return web.json_response({"error": "the file changed since its card was drawn, so nothing moved. "
                                           "Refresh the gallery and try again"}, status=409)
    except FileNotFoundError:
        # The file has no shown row by then, so `gone` lets the page remove its
        # card as it would after a delete.
        return web.json_response({"error": "the file is already gone", "gone": True}, status=404)
    except LookupError:
        return web.json_response({"error": "the file isn't in the gallery's index"}, status=404)
    except media_db.PathTooLong:
        return web.json_response(
            {"error": "this Windows install can't open a path this long, so the "
                      "gallery can't reach the file. Turning on long path support "
                      "or shortening the folder names lets it through"}, status=409)
    except sqlite3.Error as e:
        logger.warning(
            "SBG: could not delete %s in %s, since the index could not be used: %s", relpath, root.root_id, e)
        return web.json_response({"error": "the gallery's index is unavailable, so nothing moved"}, status=500)
    except OSError as e:
        logger.warning(
            "SBG: could not delete %s in %s: %s", relpath, root.root_id, e)
        return web.json_response({"error": os_reason(e)}, status=500)
    label = _moved_to(where)
    logger.info(
        "SBG: moved %s in %s to %s", relpath, root.root_id, trashed_to or label)
    return web.json_response({"ok": True, "where": label})

@routes.get("/sidebar_gallery/db_version")
@_index_reads_answered
async def get_db_version(request: web.Request) -> web.Response:
    root_id = request.rel_url.query.get("root_id")
    if root_id:
        return web.json_response({"version": media_db.get_root_version(root_id)})
    return web.json_response({"version": media_db.get_db_version()})

def _thumb_cache_usage() -> dict:
    count = 0
    total = 0
    try:
        with os.scandir(_THUMB_DIR) as entries:
            for entry in entries:
                if os.path.splitext(entry.name)[1] not in (".jpg", ".json"):
                    continue
                count += 1
                try:
                    total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    pass
    except Exception:
        pass
    return {"count": count, "size_mb": round(float(total) / (1024 * 1024), 1), "path": str(_THUMB_DIR)}

def _index_usage(roots) -> dict:
    counts: dict[str, int] = {}
    last_scans: dict[str, float] = {}
    for root in roots:
        counts[root.root_id] = media_db.get_count(root.root_id)
        last = media_db.get_last_scan(root.root_id)
        if last is not None:
            last_scans[root.root_id] = last
    return {
        "counts": counts,
        "kinds": media_db.get_kind_counts(),
        "total": sum(counts.values()),
        "last_scan": last_scans,
        "db_path": str(media_db.DB_PATH),
        "db_size_mb": round(float(media_db.index_size_bytes()) / (1024 * 1024), 2),
        # Rows whose files were absent when the scan last looked, kept but not
        # shown until a rebuild past the grace period deletes them.
        "hidden": media_db.get_hidden_count(),
    }

@routes.get("/sidebar_gallery/status")
@_index_reads_answered
async def get_status(request: web.Request) -> web.Response:
    roots = _all_roots()
    loop = asyncio.get_running_loop()
    index, thumbnails = await asyncio.gather(
        loop.run_in_executor(_IO_EXECUTOR, _index_usage, roots),
        loop.run_in_executor(_IO_EXECUTOR, _thumb_cache_usage),
    )
    return web.json_response({"index": index, "thumbnails": thumbnails})

# The matcher over the stored summaries takes whatever the search index cannot
# answer.
def _run_search(root_id, tags, mode, relpaths_filter):
    if relpaths_filter is None and search_indexed_supported(tags):
        with media_db.facts_snapshot() as conn:
            matches = search_indexed(conn, root_id, tags, mode) if conn else None
        if matches is not None:
            return {"matches": matches, "scanned": media_db.get_count(root_id)}
    if relpaths_filter is not None:
        db_rows = media_db.get_items_with_metadata(root_id, relpaths_filter)
    else:
        db_rows = media_db.get_all_with_metadata(root_id)

    matches = []
    for row in db_rows:
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
    return {"matches": matches, "scanned": len(db_rows)}

@routes.post("/sidebar_gallery/search")
@_same_origin_only
@_index_reads_answered
async def search_metadata(request: web.Request) -> web.Response:
    body = await _json_dict_body(request)
    root_id = body.get("root_id", "output")
    tags = body.get("tags")
    mode = _body_str(body, "mode", "AND").upper()

    if not tags:
        return web.json_response({"matches": []})
    if not isinstance(tags, list) or not all(isinstance(t, dict) for t in tags):
        return web.Response(status=400)

    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    relpaths_filter = body.get("relpaths")
    # A non-string item would fail to bind, which the index decorator would
    # answer as an unreadable index.
    if relpaths_filter is not None and (not isinstance(relpaths_filter, list)
                                        or not all(isinstance(p, str) for p in relpaths_filter)):
        return web.Response(status=400)
    loop = asyncio.get_running_loop()
    return _encoded_response(await loop.run_in_executor(
        _IO_EXECUTOR, lambda: _encode_json(_run_search(root_id, tags, mode, relpaths_filter))))

_THEMES_DIR = PACKAGE_ROOT / "themes"

# Presets and themes share one folder, so every read or write of a theme that a
# request makes and every save, rename or delete of a preset takes this lock.
# Where both locks are held, this one is taken inside _settings_lock.
_presets_lock = asyncio.Lock()
# The limit on the name a person types. The file name built from it is cut
# further where the OS needs it, which file_stem does.
_PRESET_NAME_MAX = 120

def _presets_listing() -> list[dict]:
    presets = []
    for f in sorted(_THEMES_DIR.glob("*.json")):
        try:
            data = read_json_file(f)
            presets.append({
                "filename": f.name,
                "name": str(data.get("name") or "").strip() or f.stem,
                "created": data.get("created"),
                "pinned": data.get("pinned") is True,
                "doc": without_layout_bodies(data),
                "readable": True,
            })
        except Exception:
            presets.append({"filename": f.name, "name": f.stem, "created": None, "doc": None, "readable": False})
    return presets

@routes.get("/sidebar_gallery/presets")
async def list_presets(request: web.Request) -> web.Response:
    loop = asyncio.get_running_loop()
    presets, version = await loop.run_in_executor(_IO_EXECUTOR, lambda: (_presets_listing(), extension_version()))
    return await _json_answer({"presets": presets, "version": version, "name_max": _PRESET_NAME_MAX, **await _install_digests()})

def _read_preset_file(filepath: Path):
    try:
        return read_json_file(filepath)
    except FileNotFoundError:
        return None

@routes.get("/sidebar_gallery/preset")
async def get_preset(request: web.Request) -> web.Response:
    filename = json_filename(request.rel_url.query.get("filename", ""))
    if not filename:
        return web.json_response({"error": FILENAME_REFUSED}, status=400)
    loop = asyncio.get_running_loop()
    try:
        data = await loop.run_in_executor(_IO_EXECUTOR, _read_preset_file, _THEMES_DIR / filename)
    except ValueError:
        return web.json_response({"error": "the file is damaged"}, status=500)
    except OSError as e:
        return web.json_response({"error": os_reason(e)}, status=500)
    if data is None:
        return web.Response(status=404)
    return await _json_answer(data)

@routes.post("/sidebar_gallery/presets")
@_same_origin_only
async def post_presets(request: web.Request) -> web.Response:
    body = await _json_dict_body(request)
    action = body.get("action", "save")
    if action not in _FILE_ACTIONS:
        return web.json_response({"error": _UNKNOWN_ACTION}, status=400)
    # Delete, rename and pin take the file the listing named, since two display
    # names can sanitize to one filename.
    filename = None
    if action in ("delete", "rename", "pin") and _body_str(body, "filename"):
        filename = json_filename(_body_str(body, "filename"))
        if not filename:
            return web.json_response({"error": FILENAME_REFUSED}, status=400)
    if action == "pin" and filename is None:
        return web.json_response({"error": FILENAME_REFUSED}, status=400)

    name = _body_str(body, "name").strip()
    if action not in ("delete", "pin") or filename is None:
        if not name:
            return web.json_response({"error": "the name is empty"}, status=400)
        if not sanitize_name(name):
            return web.json_response({"error": NO_LETTER}, status=400)
        if len(name) > _PRESET_NAME_MAX and action != "delete":
            return web.json_response(
                {"error": f"the name is longer than {_PRESET_NAME_MAX} characters"}, status=400)

    loop = asyncio.get_running_loop()
    async with _presets_lock:
        status, payload = await loop.run_in_executor(_IO_EXECUTOR, _preset_action, action, name, filename, body)
    return web.json_response(payload, status=status)

def _preset_action(action: str, name: str, filename: str | None, body: dict) -> tuple[int, dict]:
    filepath = _THEMES_DIR / (file_stem(name, _THEMES_DIR, ".json") + ".json")

    if action == "delete":
        if filename:
            filepath = _THEMES_DIR / filename
        try:
            return 200, {"ok": True, "where": _discard_sync(filepath)}
        except OSError as e:
            return _discard_failed_payload(filepath, e)

    if action == "pin":
        if not filename:
            return 400, {"error": FILENAME_REFUSED}
        return _pin_preset(_THEMES_DIR / filename, body.get("created"), bool(body.get("pinned")))

    if action == "rename":
        current = _THEMES_DIR / filename if filename else None
        if current is None or not current.exists():
            return 404, {"error": "the preset is no longer there"}
        conflict = move_conflict(current, filepath)
        if conflict:
            return 409, {"error": "conflict", "existing": conflict if isinstance(conflict, str) else None}
        try:
            rename_preset(current, filepath, name)
        except ValueError:
            return 500, {"error": "the file is damaged"}
        except OldFileKept as e:
            return _old_file_kept("preset", e)
        except OSError as e:
            return 500, {"error": os_reason(e)}
        return 200, {"ok": True, "filename": filepath.name}

    data = body.get("data")
    if not isinstance(data, dict):
        return 400, {"error": "the preset data is missing"}
    # A save onto a file that is already there asks first, even when that file
    # holds the same display name, since the save replaces what it held. The old
    # file goes to the bin only once the new one is staged, so a save that fails
    # before then leaves it in place, and one that fails after leaves it in the
    # bin.
    conflict = move_conflict(None, filepath)
    if conflict and not body.get("force"):
        return 409, {"error": "conflict", "existing": conflict if isinstance(conflict, str) else None, "filename": filepath.name}
    # The pin belongs to the file, so a save keeps the pin of the preset it
    # replaces and brings none of its own.
    data.pop("pinned", None)
    if conflict and _pinned(filepath):
        data["pinned"] = True
    try:
        staged = stage_preset(filepath, data, name)
    except OSError as e:
        return 500, {"error": os_reason(e)}
    if conflict:
        try:
            _discard_sync(filepath)
        except OSError as e:
            discard_staged(staged)
            return _discard_failed_payload(filepath, e)
    try:
        commit_staged(staged, filepath)
    except OSError as e:
        return 500, {"error": os_reason(e)}
    return 200, {"ok": True, "filename": filepath.name}

def _pinned(filepath: Path) -> bool:
    try:
        data = read_json_file(filepath)
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("pinned") is True

def _pin_preset(filepath: Path, created, pinned: bool) -> tuple[int, dict]:
    """The pin is written into the preset's own file, under the name the
    listing gave and only while the file holds the preset it listed. Letting
    go of it takes the field out, so the file reads as it did before."""
    try:
        data = read_json_file(filepath)
    except FileNotFoundError:
        return 404, {"error": "the preset is no longer there"}
    except ValueError:
        return 500, {"error": "the file is damaged"}
    except OSError as e:
        return 500, {"error": os_reason(e)}
    if not isinstance(data, dict):
        return 500, {"error": "the file is damaged"}
    if created is not None and data.get("created") != created:
        return 409, {"error": "the preset changed since the list was read"}
    if pinned:
        data["pinned"] = True
    else:
        data.pop("pinned", None)
    try:
        write_json_atomic(filepath, data)
    except OSError as e:
        return 500, {"error": os_reason(e)}
    return 200, {"ok": True, "pinned": pinned}

def _old_file_kept(kind: str, err: OSError) -> tuple[int, dict]:
    return 500, {"error": f"the {kind} was saved under its new name, but its old file couldn't be removed ({os_reason(err)})"}

def _discard_failed_payload(path: Path, err: OSError) -> tuple[int, dict]:
    logger.warning("SBG: could not move %s: %s", path.name, err)
    return 500, {"error": os_reason(err)}

def _discard_sync(path: Path) -> str | None:
    if not path.exists():
        return None
    where, dest = discard_file(path)
    label = _moved_to(where)
    logger.info("SBG: moved %s to %s", path.name, dest or label)
    return label

def _discard_failed(path: Path, err: OSError) -> web.Response:
    status, payload = _discard_failed_payload(path, err)
    return web.json_response(payload, status=status)

async def _discard(path: Path) -> str | None:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_IO_EXECUTOR, _discard_sync, path)

@routes.get("/sidebar_gallery/themes")
async def list_themes(request: web.Request) -> web.Response:
    loop = asyncio.get_running_loop()
    async with _presets_lock:
        listed = await loop.run_in_executor(_IO_EXECUTOR, themes.listing, _THEMES_DIR)
    return await _json_answer({"themes": listed, "name_max": _PRESET_NAME_MAX, "version": themes.THEME_FILE_VERSION})

_THEME_NAMED_ACTIONS = {"create": themes.create, "copy": themes.copy, "rename": themes.rename}

@routes.post("/sidebar_gallery/themes")
@_same_origin_only
@_write_failures_answered
async def post_themes(request: web.Request) -> web.Response:
    body = await _json_dict_body(request)
    action = body.get("action")
    loop = asyncio.get_running_loop()

    if action == "change":
        async with _presets_lock:
            status, payload = await loop.run_in_executor(_IO_EXECUTOR, themes.change, _THEMES_DIR, body)
        return web.json_response(payload, status=status)

    # A delete also takes the theme off the selection and out of the order, in
    # the same request, so no tab writes them after it from its own copy. A
    # settings file that cannot be read keeps both, and the theme still goes.
    if action == "delete":
        async with _settings_lock:
            try:
                settings = await _settings_load_locked()
            except UnreadableFile:
                settings = None
            async with _presets_lock:
                hit = await loop.run_in_executor(_IO_EXECUTOR, themes.find, _THEMES_DIR, body.get("id"))
                if hit is None:
                    return web.json_response({"error": _THEME_GONE}, status=404)
                target = hit[0]
                try:
                    where = await _discard(target)
                except OSError as e:
                    return _discard_failed(target, e)
                themes.forget(body["id"])
            if where is None:
                return web.json_response({"error": _THEME_GONE}, status=404)
            written: dict = {}
            if settings is not None:
                after, written = apply.forget_theme(settings, f"{themes.REF_PREFIX}{body['id']}", _CHANGED_KEY, int(time.time() * 1000))
                if written:
                    try:
                        await _settings_commit_locked(after)
                    except OSError as e:
                        logger.warning("SBG: a deleted theme is still the selection or in the order, since the settings couldn't be saved: %s", os_reason(e))
                        written = {}
        return web.json_response({"ok": True, "where": where, "written": written})

    act = _THEME_NAMED_ACTIONS.get(action) if isinstance(action, str) else None
    if act is None:
        return web.json_response({"error": _UNKNOWN_ACTION}, status=400)
    name = _body_str(body, "name").strip()
    if not name or not sanitize_name(name):
        return web.json_response({"error": NO_LETTER}, status=400)
    # A new theme's name is fitted to the limit, so only a rename is refused
    # for its length.
    if action == "rename":
        if len(name) > _PRESET_NAME_MAX:
            return web.json_response({"error": f"the name is longer than {_PRESET_NAME_MAX} characters"}, status=400)
        work = functools.partial(act, _THEMES_DIR, name, body)
    else:
        work = functools.partial(act, _THEMES_DIR, name, body, most=_PRESET_NAME_MAX)
    async with _presets_lock:
        status, payload = await loop.run_in_executor(_IO_EXECUTOR, work)
    return web.json_response(payload, status=status)

@routes.get("/sidebar_gallery/meta_keys")
@_index_reads_answered
async def get_meta_keys(request: web.Request):
    loop = asyncio.get_running_loop()
    keys = await loop.run_in_executor(_IO_EXECUTOR, media_db.get_all_meta_keys)
    # A copy, since get_all_meta_keys hands back its cached dict.
    keys = dict(keys)
    keys["non_bindable"] = sorted(schema.non_bindable_summary_keys())
    keys["non_bindable_element"] = schema.non_bindable_element_keys()
    return await _json_answer(keys)

# A scan parses a file again only when it changes, so a parser change reaches
# the other indexed files only through this rebuild.
def _check_parser_version():
    global _parser_check_owed
    try:
        stored = media_db.get_meta_value("parser_version")
        if stored == str(PARSER_VERSION):
            return
        if not media_db.has_any_files():
            _mark_parser_version_current()
            return
        # Only Output is known until the file has been read, and a stamp taken
        # from it alone would pass over every extra folder. The first read that
        # lands runs this again.
        if _config_for_scan() is None:
            _parser_check_owed = True
            return
        cur = str(PARSER_VERSION)
        stale = [r for r in _all_roots()
                 if media_db.get_meta_value(_root_parser_key(r.root_id)) != cur]
        if not stale:
            _maybe_stamp_global_parser_version()
            return
        if _start_full_reindex(stale):
            logger.info(
                "SBG: Metadata parser updated (v%s to v%s): re-extracting %d root(s) in the background",
                stored or "?", PARSER_VERSION, len(stale))
        else:
            # A scan or a build holds the slot, and asks again once it lets go.
            _parser_check_owed = True
    except sqlite3.Error as e:
        logger.warning(
            "SBG: The index could not be read, so the parser version check left its "
            "stamp as it stands and started no rebuild: %s", e)
    except Exception as e:
        logger.warning("SBG: Parser-version check failed: %s", e)

# The first of this module's code to run on the server's loop, so the loop-only
# checks learn their loop here.
async def _on_server_start(_app):
    bind_loop(asyncio.get_running_loop())
    try:
        await _pin_settings_before_new_version()
    except Exception as e:
        logger.warning("SBG: Settings pin before a new version failed: %s", e)
    await asyncio.get_running_loop().run_in_executor(
        _SCAN_EXECUTOR, _check_parser_version)
    task = asyncio.get_running_loop().create_task(_ensure_facts_index())
    _keep_task(task)

_FACTS_OTHER_TRIES = 3
_FACTS_OTHER_WAIT_S = 600

async def _ensure_facts_index():
    loop = asyncio.get_running_loop()
    # A database locked or failing now may not be later, so a failed read or build
    # is tried again instead of leaving search on the matcher until a restart.
    # Any other failure may repeat, and each try reads every summary in the index,
    # so it is tried a few more times, far apart.
    other_failures = 0
    while True:
        try:
            if await loop.run_in_executor(_IO_EXECUTOR, media_db.facts_ready):
                return
            # Claimed under the scan lock for the reason `_start_full_reindex`
            # gives. A rebuild takes the same claim, so it and this build cannot
            # both hold it.
            token = None
            with _inflight_scans_lock:
                if not any(not h.future.done() for h in _inflight_scans.values()):
                    token = media_db.claim_full_reindex("facts")
            if token is not None:
                result = await loop.run_in_executor(
                    _SCAN_EXECUTOR, media_db.facts_rebuild_run, token)
                _hand_over_parser_check()
                if result.get("complete"):
                    logger.info(
                        "SBG: Search index built: %s facts over %s paths in %.1fs",
                        f"{result.get('facts', 0):,}", f"{result.get('paths', 0):,}",
                        result.get("seconds", 0))
                    return
        except sqlite3.Error as e:
            logger.warning("SBG: The search index could not be built this time, trying again shortly: %s", e)
        except Exception:
            other_failures += 1
            if other_failures >= _FACTS_OTHER_TRIES:
                logger.exception("SBG: The search index could not be built, and search uses the "
                                 "slower reader until ComfyUI restarts")
                return
            logger.exception("SBG: The search index could not be built this time, trying again later")
            await asyncio.sleep(_FACTS_OTHER_WAIT_S)
            continue
        await asyncio.sleep(15)

# Everything this module does beyond registering its routes, so importing it opens
# no database and starts no thread.
def init() -> None:
    media_db.init_db()
    media_db.set_progress_listener(_push_progress)
    _prepare_thumb_dir()
    _THEMES_DIR.mkdir(exist_ok=True)
    for name in themes.ensure_ids(_THEMES_DIR):
        logger.info("SBG: Theme %s given its permanent id", name)
    for folder in (_settings_path().parent, _THEMES_DIR, _backups_dir()):
        for name in sweep_stale_tmp(folder, (".json", THEME_FILE_SUFFIX)):
            logger.info("SBG: Removed %s, left by a save that was cut short", name)
    threading.Thread(target=_thumb_gc_loop, daemon=True).start()
    _schedule_roots_refresh()
    # Deferred to the startup hook, so every node pack is loaded before the parser
    # reads the node registry.
    server.PromptServer.instance.app.on_startup.append(_on_server_start)
