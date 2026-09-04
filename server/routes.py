from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import os
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
from .db import ALL_MEDIA_EXTS, IMAGE_EXTS, kind_from_ext
from . import db as media_db
from .metadata import PARSER_VERSION, read_metadata_for_file, guess_mime, sanitize_for_json
from . import schema
from .search import match_item
from .security import AllowedRoot, make_root_id, safe_join

# Two dedicated worker pools, split by latency class, isolate gallery work from
# ComfyUI's shared default executor and from each other (so a long scan or video
# decode can't head-of-line-block interactive work).
#
# _SCAN_EXECUTOR: minutes-long whole-library work (incremental scans, meta-key
#   aggregation, removed-root purges). 2 workers keeps disk/SQLite contention bounded.
# _IO_EXECUTOR: interactive per-item work (image/video/audio thumbnails,
#   search, new-file processing). 4 workers. Video and audio DECODE jobs
#   share the two-slot _MEDIA_DECODE_GATE before they are ever submitted, so
#   decode work can never occupy more than half the pool.
# The list_all payload build stays on the DEFAULT executor so gallery opens
# never queue behind either pool.
_SCAN_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sbg-scan")
_IO_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sbg-io")
# Response deflate gets its own tiny pool: on _IO_EXECUTOR a finished response's
# compression could queue behind a running video decode, delaying first byte by
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

# Sweep temp files left by a hard kill mid-write (never served, but they'd
# accumulate otherwise).
for _stale_tmp in _THUMB_DIR.glob("tmp_*"):
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
            if f.suffix not in (".jpg", ".json") or f.name.startswith("tmp_"):
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
    try:
        mtime = os.path.getmtime(full_path)
    except OSError:
        mtime = 0
    return hashlib.md5(f"{full_path}:{mtime}:{size}".encode()).hexdigest()


def _video_thumb_path(full_path: str, size: int = 512) -> Path:
    return _THUMB_DIR / f"v_{_thumb_hash(full_path, size)}.jpg"


def _image_thumb_path(full_path: str, size: int = 512) -> Path:
    return _THUMB_DIR / f"i_{_thumb_hash(full_path, size)}.jpg"


# The "aw" prefix supersedes the earlier "a" scheme so stale zero-byte
# no-art markers cannot pin these files to 404.
def _audio_thumb_path(full_path: str, size: int = 512) -> Path:
    return _THUMB_DIR / f"aw_{_thumb_hash(full_path, size)}.jpg"


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
        return f"/sidebar_gallery/audio_thumb?root_id={rid_q}&relpath={rp_q}&size={size}&v={v}"
    return None


def _client_item(root_id, relpath, ext, kind, size, mtime, ctime, thumb_size,
                 rid_q, *, filename=None, subfolder=None, w=None, h=None,
                 has_thumb=None):
    """The wire shape the list endpoints return for one file. Callers differ
    only in `has_thumb`: list_all omits it, the delta forms send it.

    Back-compat: `mtime` doubles as the default sort field and carries the
    CREATION time (some file managers update the real mtime on viewing);
    `mtime_real` carries the true modification time and drives the
    content-addressed thumb/file URLs. filename/subfolder are derived from
    relpath when absent; DB-backed callers pass the stored columns so the
    whole-library build skips the per-row derivation."""
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
    if has_thumb is not None:
        item["has_thumb"] = has_thumb
    # Dimensions drive the aspect-ratio thumbnail layout.
    if w and h:
        item["w"] = w
        item["h"] = h
    return item


# Acquired BEFORE submitting to _IO_EXECUTOR so queued decode jobs wait on
# the event loop instead of holding pool workers. Shared by video thumbnails
# and the audio thumbnail/peaks generators.
_MEDIA_DECODE_GATE = asyncio.Semaphore(2)


async def _video_thumb_off_loop(full, tp, size):
    async with _MEDIA_DECODE_GATE:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            _IO_EXECUTOR, lambda: _generate_video_thumbnail(full, tp, size))


def _generate_video_thumbnail(full_path: str, out_path: Path, size: int = 512) -> bool:
    """Atomic temp-file + rename, same rationale as the image path. Returns
    False on any failure; the caller then shows the video-file icon."""
    if out_path.exists():
        return True
    try:
        import av
        from PIL import Image
    except Exception:
        return False
    # Concurrent generations of one file must not share a temp path.
    tmp_path = out_path.with_name(f"tmp_{threading.get_ident()}_{out_path.name}")
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with av.open(full_path) as container:
            vstreams = container.streams.video
            if not vstreams:
                return False
            stream = vstreams[0]
            # The slice-threading default gains nothing on one-slice-per-frame
            # streams.
            stream.thread_type = "AUTO"
            # av.time_base is ticks per second; the backward seek lands on the
            # keyframe at or before 0.5s.
            try:
                container.seek(int(0.5 * av.time_base), backward=True)
            except Exception:
                pass
            frame = None
            for walked, cand in enumerate(container.decode(stream)):
                frame = cand
                if cand.time is not None and cand.time >= 0.5:
                    break
                # Bounds the walk when frames carry no timestamps.
                if walked >= 240:
                    break
            if frame is None:
                return False
            # Scale in swscale so a full-resolution frame never reaches Python.
            scale = min(size / frame.width, size / frame.height)
            nw = max(1, round(frame.width * scale))
            nh = max(1, round(frame.height * scale))
            try:
                small = frame.reformat(width=nw, height=nh, format="rgb24",
                                       interpolation="LANCZOS")
            except Exception:
                small = frame.reformat(width=nw, height=nh, format="rgb24")
            img = small.to_image()
            # Rotate after scaling; the square target box keeps the fit valid.
            rot = round((getattr(frame, "rotation", 0) or 0) / 90) * 90 % 360
            if rot:
                img = img.transpose(getattr(Image, f"ROTATE_{rot}"))
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


# Frame cap for waveform decoding that bounds the walk on damaged or endless
# streams while covering hours of ordinary audio.
_WAVEFORM_MAX_FRAMES = 400_000

# One generation per output artifact at a time. A second request for the same
# artifact waits on the mutex inside its worker (bounded to one parked worker
# by the shared gate) rather than decoding the file again.
_audio_gen_locks: dict[str, threading.Lock] = {}
_audio_gen_locks_guard = threading.Lock()
_AUDIO_GEN_LOCKS_PRUNE_AT = 1024


def _audio_gen_lock(out_path: Path) -> threading.Lock:
    with _audio_gen_locks_guard:
        if len(_audio_gen_locks) > _AUDIO_GEN_LOCKS_PRUNE_AT:
            for key in list(_audio_gen_locks):
                lk = _audio_gen_locks[key]
                if lk.acquire(blocking=False):
                    lk.release()
                    del _audio_gen_locks[key]
        return _audio_gen_locks.setdefault(str(out_path), threading.Lock())


async def _audio_job_off_loop(fn):
    async with _MEDIA_DECODE_GATE:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(_IO_EXECUTOR, fn)


def _collect_audio_peaks(container, buckets: int):
    """Per-bucket peak levels in [0, 1] from the container's decoded samples,
    or None when there is no decodable audio. Buckets divide the SAMPLE axis.
    A frame spanning several buckets fills each of them, so a clip with fewer
    frames than buckets still yields a dense envelope."""
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
            # Packed layouts flatten to (1, samples * channels), so the raw
            # width overcounts by the channel count.
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
    """Peak-bar waveform image from the container's decoded samples, or None
    when there is no decodable audio. Square canvas with the bars in a middle
    band, so the card's cover-fit never crops the ends off."""
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
    """Settle undecodable media to the nothing-renderable marker so it is not
    re-decoded on every view. IO-flavored errors (locked or vanishing files)
    stay retryable."""
    try:
        import av
        if isinstance(exc, av.FFmpegError) and not isinstance(exc, OSError):
            out_path.touch()
    except Exception:
        pass


def _generate_audio_peaks(full_path: str, out_path: Path) -> None:
    """Write the player's waveform payload of peak levels plus whether the file
    carries embedded art (which the client shows on the stage). A zero-byte
    marker records undecodable audio."""
    with _audio_gen_lock(out_path):
        if out_path.exists():
            return
        try:
            import av
        except Exception:
            return
        tmp_path = out_path.with_name(f"tmp_{threading.get_ident()}_{out_path.name}")
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with av.open(full_path, metadata_errors="replace") as container:
                has_art = bool(container.streams.video)
                levels = _collect_audio_peaks(container, _AUDIO_PEAK_BUCKETS)
            if levels is None:
                out_path.touch()
                return
            tmp_path.write_text(json.dumps({"peaks": levels, "art": has_art}), encoding="utf-8")
            os.replace(tmp_path, out_path)
        except Exception as exc:
            _mark_decoder_failure(exc, out_path)
        finally:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass


@routes.get("/sidebar_gallery/audio_peaks")
async def get_audio_peaks(request: web.Request):
    root_id = request.rel_url.query.get("root_id", "")
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
    # Any-extension requests would decode arbitrary media in full (a video's
    # audio track included), so only indexed audio kinds are served.
    if kind_from_ext(os.path.splitext(full)[1].lower()) != "audio":
        return web.Response(status=404)

    pp = _audio_peaks_path(full)
    if not pp.exists():
        await _audio_job_off_loop(lambda: _generate_audio_peaks(full, pp))
    try:
        if not (pp.exists() and pp.stat().st_size > 0):
            return web.Response(status=404)
    except OSError:
        return web.Response(status=404)

    return web.FileResponse(
        str(pp),
        headers={
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


def _generate_audio_thumbnail(full_path: str, out_path: Path, size: int = 512) -> bool:
    """Render embedded cover art (an attached picture stream) as the thumbnail,
    or a waveform drawn from the decoded samples when there is no art. A
    zero-byte marker at out_path records "nothing renderable", so later views
    skip reopening the container. The serving side treats an empty file as
    absent. Atomic temp-file + rename, same rationale as the video path."""
    with _audio_gen_lock(out_path):
        if out_path.exists():
            try:
                return out_path.stat().st_size > 0
            except OSError:
                return False
        try:
            import av
        except Exception:
            return False
        # Concurrent generations of one file must not share a temp path.
        tmp_path = out_path.with_name(f"tmp_{threading.get_ident()}_{out_path.name}")
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            img = None
            had_art_streams = False
            with av.open(full_path, metadata_errors="replace") as container:
                vstreams = container.streams.video
                had_art_streams = bool(vstreams)
                if vstreams:
                    frame = next(container.decode(vstreams[0]), None)
                    if frame is not None:
                        scale = min(size / frame.width, size / frame.height, 1.0)
                        nw = max(1, round(frame.width * scale))
                        nh = max(1, round(frame.height * scale))
                        try:
                            small = frame.reformat(width=nw, height=nh, format="rgb24",
                                                   interpolation="LANCZOS")
                        except Exception:
                            small = frame.reformat(width=nw, height=nh, format="rgb24")
                        img = small.to_image()
                else:
                    img = _waveform_image(container, size)
            if img is None and had_art_streams:
                # A declared art stream that yields no frame (truncated art)
                # still deserves the waveform. Reopen since the art decode
                # advanced the demuxer.
                with av.open(full_path, metadata_errors="replace") as container:
                    img = _waveform_image(container, size)
            if img is None:
                out_path.touch()
                return False
            img.save(str(tmp_path), format="JPEG", quality=85)
            if tmp_path.exists() and tmp_path.stat().st_size > 0:
                os.replace(tmp_path, out_path)
            return out_path.exists()
        except Exception as exc:
            _mark_decoder_failure(exc, out_path)
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
    # Concurrent generations of one file must not share a temp path.
    tmp_path = out_path.with_name(f"tmp_{threading.get_ident()}_{out_path.name}")
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
    """The single derivation for extra-root ids: rows are indexed under these ids
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
    """Return only the compact summary dict, leaving out the much larger
    prompt, workflow, parsed, and raw_text blobs so the index stays small.
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
    return Path(__file__).resolve().parents[1] / _SETTINGS_FILENAME


def _read_settings() -> dict:
    """Returns {} when the file is missing, unreadable, or not a JSON object."""
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


# In-memory settings state. The file is large and dominated by stored
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
        # Store the key literally (flat) without splitting on dots, so
        # "SBG.Layouts" is a top-level key the client reads back verbatim.
        async with _settings_lock:
            settings = await _settings_load_locked()
            settings[body["key"]] = body["value"]
            await _settings_write_locked()
        return web.json_response({"ok": True, "key": body["key"]})
    elif "settings" in body and isinstance(body["settings"], dict):
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
    """Returns False if one is already running. Each root's parser stamp is
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
    """Returns immediately. The frontend polls /reindex_progress for status."""
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


def _config_payload(cfg) -> dict:
    """The /config response body, shared by GET and POST so a new field can
    never appear in one handler's response and silently miss the other's."""
    return {
        "extra_roots": cfg.extra_roots,
        "excluded_dirs": cfg.excluded_dirs,
        "index_hidden_dirs": cfg.index_hidden_dirs,
        "auto_refresh_interval_s": cfg.auto_refresh_interval_s,
        "roots": [{"id": r.root_id, "label": r.label, "path": r.path if r.root_id != "output" else None}
                  for r in _all_roots()],
        # Where a folder gets added.
        "config_path": str(config_path()),
        # Catalog default titles keyed by section_id: lets the frontend
        # recognize layout-editor retitles for search-name resolution.
        "section_titles": schema.section_titles(),
    }


@routes.get("/sidebar_gallery/config")
async def get_config(request: web.Request):
    return _json_gz(_config_payload(load_config()))


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
    # progress flag.
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
    # Diffing old config against new, rather than _all_roots, keeps a
    # temporarily-offline network root's rows intact.
    # The purge runs as a background task: it first cancels + drains any in-flight
    # scan of the removed root (whose later batches would otherwise re-insert rows
    # after the purge, orphaning them forever), then deletes on a worker thread
    # rather than blocking the event loop on the SQLite DELETE.
    removed_ids = ({_extra_root_id(p)[0] for p in old_cfg.extra_roots}
                   - {_extra_root_id(p)[0] for p in cfg.extra_roots})
    if removed_ids:
        task = asyncio.create_task(_purge_removed_roots(removed_ids))
        _BG_TASKS.add(task)
        task.add_done_callback(_BG_TASKS.discard)

    return web.json_response(_config_payload(cfg))


# Subfolder listing


@routes.get("/sidebar_gallery/subfolders")
async def get_subfolders(request: web.Request):
    root_id = request.rel_url.query.get("root_id", "output")
    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    raw_folders = media_db.get_subfolders(root_id)
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
    """Clears the tracked handle only while it is still the current one for this
    root, so a newer scan is not dropped by mistake."""
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
        return inflight.future
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
    """Runs in a worker thread so the DB read and whole-library item build
    never block the event loop."""
    root_id = root.root_id
    # Version + rows from one SQLite snapshot: the stamp matches the row set even
    # while a background scan is committing (see get_all_with_version).
    db_version, db_items = media_db.get_all_with_version(root_id)
    rid_q = quote(root_id)
    out_items = [
        _client_item(row["root_id"], row["relpath"], row["ext"], row["kind"],
                     row["size"], row["mtime"], row["ctime"], thumb_size, rid_q,
                     filename=row["filename"], subfolder=row["subfolder"],
                     w=row.get("w"), h=row.get("h"))
        for row in db_items
    ]
    first_time = not media_db.has_any_files()
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
    For a large library's list_all payload, serializing and
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
    """The payload carries no metadata: the client fetches that per item from
    /metadata and caches it in IndexedDB."""
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
        await _await_scan(scan_future)

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
                    interval_s=max(_SCAN_COOLDOWN_S, refresh_s))
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
    """The files[] form's worker. Runs on _IO_EXECUTOR because the per-file
    stat, metadata parse and upsert are blocking disk and CPU work."""
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
            # The executed event can deliver output types the gallery does not
            # index (3D formats among others). The scanner filters these, so
            # the delta path must too, or they become permanent rows with dead
            # thumbnails.
            if ext not in ALL_MEDIA_EXTS:
                continue
            kind = kind_from_ext(ext)
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

            meta_dict = _read_metadata_for_db(full)
            meta_json = json.dumps(meta_dict) if meta_dict else None
            media_db.upsert_file(conn, root_id, relpath, ext, kind, size, mtime, meta_json, ctime=ctime)

            has_thumb = False
            try:
                if kind == "image":
                    has_thumb = _image_thumb_path(full, thumb_size).exists()
                elif kind == "video":
                    has_thumb = _video_thumb_path(full, thumb_size).exists()
                elif kind == "audio":
                    _tp = _audio_thumb_path(full, thumb_size)
                    has_thumb = _tp.exists() and _tp.stat().st_size > 0
            except Exception:
                pass

            _w = meta_dict.get("width") if isinstance(meta_dict, dict) else None
            _h = meta_dict.get("height") if isinstance(meta_dict, dict) else None
            out_items.append(_client_item(
                root_id, relpath, ext, kind, size, mtime, ctime, thumb_size,
                quote(root.root_id), w=_w, h=_h, has_thumb=has_thumb))

        conn.commit()
    finally:
        conn.close()
    return out_items


def _build_since_items(root, thumb_size: int, since: float) -> list[dict]:
    """The since form's worker. Runs on _IO_EXECUTOR because a long absence
    makes this a large build. The mtime filter runs in SQL (idx_root_mtime), so the
    routine few-item delta reads a few rows instead of dragging the whole
    table (and its metadata json_extract) through Python first."""
    rid_q = quote(root.root_id)
    return [
        _client_item(row["root_id"], row["relpath"], row["ext"], row["kind"],
                     row["size"], row["mtime"], row["ctime"], thumb_size, rid_q,
                     filename=row["filename"], subfolder=row["subfolder"],
                     w=row.get("w"), h=row.get("h"), has_thumb=False)
        for row in media_db.get_rows_since(root.root_id, since)
    ]


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
        _maybe_scan(root, force=False)
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

    # Fast path: answered from the DB with no disk read.
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
            if db_row and db_row.get("metadata_json"):
                return
            if not db_row or summary:
                _ext = os.path.splitext(relpath_clean)[1].lower()
                # Same gate as the scanner and the delta path. An unindexed
                # extension must never gain a row, or it lists as a dead card
                # until a scan sweeps it.
                if _ext not in ALL_MEDIA_EXTS:
                    return
                _kind = kind_from_ext(_ext)
                with media_db._get_conn() as _conn:
                    media_db.upsert_file(_conn, root_id, relpath_clean, _ext, _kind,
                                         int(st.st_size), float(st.st_mtime),
                                         json.dumps(summary) if summary else None,
                                         ctime=float(st.st_ctime))
            elif not db_row.get("meta_mtime"):
                media_db.mark_meta_attempted(root_id, relpath_clean)
        except Exception:
            pass

    await asyncio.get_running_loop().run_in_executor(None, _backfill)

    return _json_gz(sanitize_for_json(result))


@routes.get("/sidebar_gallery/metadata_ondemand")
async def get_metadata_ondemand(request: web.Request):
    """Unlike /metadata, this does NOT require the file to be in an indexed
    root: it resolves ComfyUI's own input, output, or temp directory by `type`,
    which is what lets the Initial Image panel read an input file.
    """
    cfg = load_config()
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "")
    ftype = request.rel_url.query.get("type", "input")

    if not filename:
        return web.Response(status=400, text="Missing filename")

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

    cached = _image_thumb_path(full, target)
    if not cached.exists():
        # Generate on a worker thread so PIL decode/encode never blocks the
        # ComfyUI event loop.
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


@routes.get("/sidebar_gallery/audio_thumb")
async def get_audio_thumb(request: web.Request):
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

    if kind_from_ext(os.path.splitext(full)[1].lower()) != "audio":
        return web.Response(status=404)

    tp = _audio_thumb_path(full, size)
    if not tp.exists():
        await _audio_job_off_loop(lambda: _generate_audio_thumbnail(full, tp, size))
    try:
        if not (tp.exists() and tp.stat().st_size > 0):
            return web.Response(status=404)
    except OSError:
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
    body, err = await _json_dict_body(request)
    if err is not None:
        return err
    root_id = body.get("root_id", "")
    relpath = body.get("relpath", "")
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

    kind = kind_from_ext(os.path.splitext(full)[1].lower())
    if kind not in ("image", "video", "audio"):
        return web.Response(status=404)

    # Generate off the event loop: decoding and PIL are blocking and the
    # video path can take seconds (see the GET handlers above).
    loop = asyncio.get_running_loop()
    if kind == "video":
        tp = _video_thumb_path(full, size)
        ok = await _video_thumb_off_loop(full, tp, size)
    elif kind == "audio":
        tp = _audio_thumb_path(full, size)
        await _audio_job_off_loop(lambda: _generate_audio_thumbnail(full, tp, size))
        try:
            if not (tp.exists() and tp.stat().st_size > 0):
                return web.Response(status=404)
        except OSError:
            return web.Response(status=404)
        ok = True
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




# Search matching lives in server/search.py (match_item / match_summary), kept
# pure and decoupled from this ComfyUI-coupled route handler.



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
    roots = _all_roots()
    index_counts: dict[str, int] = {}

    for root in roots:
        index_counts[root.root_id] = media_db.get_count(root.root_id)

    thumb_count = 0
    thumb_bytes = 0
    try:
        for f in _THUMB_DIR.iterdir():
            if f.suffix in (".jpg", ".json"):
                thumb_count += 1
                try:
                    thumb_bytes += f.stat().st_size
                except OSError:
                    pass
    except Exception:
        pass

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
    if relpaths_filter and isinstance(relpaths_filter, list):
        db_rows = media_db.get_items_with_metadata(root_id, relpaths_filter)
    else:
        db_rows = media_db.get_all_with_metadata(root_id)
    total = len(db_rows)

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
    # scanned stays in the wire shape for the frontend's status line.
    return {"matches": matches, "scanned": total, "total": total}


@routes.post("/sidebar_gallery/search")
async def search_metadata(request: web.Request) -> web.Response:
    """Multi-tag AND/OR matching over the metadata_json already stored in the
    DB rows, so a search costs no disk read."""
    body, err = await _json_dict_body(request)
    if err is not None:
        return err
    root_id = body.get("root_id", "output")
    tags = body.get("tags", [])
    mode = body.get("mode", "AND").upper()

    # Legacy single-tag body shape.
    if not tags and "value" in body:
        tags = [{"field": body.get("field", "any").lower(), "value": body.get("value", "").lower()}]

    if not tags:
        return web.json_response({"matches": []})

    root = _find_root(root_id)
    if root is None:
        return web.Response(status=404)

    relpaths_filter = body.get("relpaths")  # list of relpaths to check, or None for full search
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(_IO_EXECUTOR, _run_search, root_id, tags, mode, relpaths_filter)
    return _json_gz(result)


# Theme Presets

_THEMES_DIR = Path(__file__).resolve().parents[1] / "themes"
_THEMES_DIR.mkdir(exist_ok=True)


@routes.get("/sidebar_gallery/presets")
async def _list_presets(request: web.Request) -> web.Response:
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

    safe_name = "".join(c for c in name if c.isalnum() or c in " -_").strip()
    if not safe_name:
        return web.json_response({"error": "Invalid preset name"}, status=400)

    filepath = _THEMES_DIR / f"{safe_name}.json"

    if action == "delete":
        if filepath.exists():
            filepath.unlink()
        return web.json_response({"ok": True})

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
