"""Persistent SQLite index for Sidebar Gallery.

Stores file info + full metadata JSON so the gallery never needs
network calls for metadata. Supports incremental mtime-based scans
and full background reindexing.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .schema import meta_key_buckets
from .security import AllowedRoot, safe_join

logger = logging.getLogger("sbg.db")

_DB_PATH = Path(__file__).resolve().parents[1] / "sidebar_gallery_cache.db"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma", ".opus", ".aiff"}
MESH_EXTS = {".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".3ds", ".dae", ".spz", ".splat", ".ksplat"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS | MESH_EXTS

def _kind_from_ext(ext: str) -> str:
    """Derive media kind from file extension."""
    if ext in VIDEO_EXTS: return "video"
    if ext in AUDIO_EXTS: return "audio"
    if ext in MESH_EXTS: return "mesh"
    return "image"

# Parallel metadata reads during a full reindex. Opening + parsing each file is the
# slow part on a network share; reading a batch concurrently overlaps that I/O. Kept
# modest so a background rebuild never floods the box.
_REINDEX_META_WORKERS = 4

# Database version counters - one per root plus a global aggregate, bumped only
# when a write materially changes a row (insert, real update, delete). The
# per-root counters live in sbg_meta ("root_version:<root_id>") and are
# incremented on the writer's own connection, so a bump commits atomically with
# the row change it describes: a crash can never persist rows whose bump was
# lost, and a rolled-back write rolls its bump back with it.
# The poll/list contract uses the per-root counters so writes to one root don't
# force clients viewing another root to re-download their list. The in-memory
# global below only invalidates the meta-keys aggregate cache cheaply; it is
# persisted alongside each bump and restored in init_db.
_db_version = 0
_versions_lock = threading.Lock()

# Metadata epoch - increments only when metadata is fully re-extracted (a reindex),
# not on every write. Kept in memory (mirrors _db_version) so the list_all hot path
# reads it without opening a fresh SQLite connection per request; persisted in
# sbg_meta and restored in init_db so it survives a restart.
_meta_epoch = 0

# Cached result of get_all_meta_keys() - a full scan of every row is too slow to
# repeat per request, so the aggregate is recomputed only when _db_version changes.
# The lock serializes concurrent callers (each runs in a run_in_executor worker
# thread) so they don't both run the scan and race on the module-global cache.
_meta_keys_cache: dict | None = None
_meta_keys_cache_ver = -1
_meta_keys_lock = threading.Lock()

def get_db_version() -> int:
    """Current global version counter (memory read; persisted with every bump).
    Only meaningful as a cache-invalidation signal for the meta-keys aggregate;
    the poll/list contract uses the per-root counters instead."""
    return _db_version

def get_root_version(root_id: str) -> int:
    """Persisted per-root version counter (single-row indexed SELECT).

    Read from sbg_meta rather than any in-memory mirror: the counter is
    incremented inside the writer's transaction, so it can never run ahead of
    committed rows. An in-memory copy could (e.g. after a rollback), putting
    pollers into a permanent refetch loop."""
    v = get_meta_value(f"root_version:{root_id}")
    try:
        return int(v) if v is not None else 0
    except (TypeError, ValueError):
        return 0

def _bump_version(conn: sqlite3.Connection, root_id: str) -> None:
    """Record a material change to a root, on the CALLER'S connection so the
    bump commits (or rolls back) atomically with the write that caused it."""
    global _db_version
    conn.execute(
        "INSERT INTO sbg_meta(key, value) VALUES(?, '1') "
        "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        (f"root_version:{root_id}",),
    )
    with _versions_lock:
        _db_version += 1
        conn.execute(
            "INSERT INTO sbg_meta(key, value) VALUES('db_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(_db_version),),
        )


def get_meta_value(key: str) -> str | None:
    """Read a value from the sbg_meta key/value table (None if absent)."""
    try:
        with _get_conn() as conn:
            row = conn.execute("SELECT value FROM sbg_meta WHERE key = ?", (key,)).fetchone()
            return row["value"] if row else None
    except Exception:
        return None


def set_meta_value(key: str, value: str) -> None:
    """Write a value to the sbg_meta key/value table (best-effort)."""
    try:
        with _get_conn() as conn:
            conn.execute(
                "INSERT INTO sbg_meta(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)),
            )
    except Exception:
        pass


def delete_meta_value(key: str) -> None:
    """Remove a key from the sbg_meta table (best-effort)."""
    try:
        with _get_conn() as conn:
            conn.execute("DELETE FROM sbg_meta WHERE key = ?", (key,))
    except Exception:
        pass


def get_meta_epoch() -> int:
    """Epoch that increments when metadata is fully re-extracted (a reindex).
    A reindex rewrites every row's metadata_json without changing file mtimes,
    so the client's per-item mtime check can't see it; clients drop cached
    metadata when this changes. A plain db_version bump must not, or the
    lightbox would re-fetch metadata on every navigation.

    Served from the in-memory counter (no DB connection); read on every
    list_all, a hot path."""
    return _meta_epoch


def bump_meta_epoch() -> None:
    global _meta_epoch
    _meta_epoch += 1
    set_meta_value("meta_epoch", str(_meta_epoch))


def has_any_files() -> bool:
    """True if at least one media file is indexed."""
    try:
        with _get_conn() as conn:
            return conn.execute("SELECT 1 FROM media_files LIMIT 1").fetchone() is not None
    except Exception:
        return False


# ── Connection management ──────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    """Open a new SQLite connection with WAL mode.

    Per-call, not thread-local or pooled. Callers either close it explicitly
    (long scans) or rely on GC after a short `with conn:` block. WAL mode plus
    the 30s busy timeout make concurrent use safe.
    """
    conn = sqlite3.connect(str(_DB_PATH), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-8000")  # 8 MB cache
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create tables and indexes if they don't exist."""
    with _get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS media_files (
                root_id      TEXT    NOT NULL,
                relpath      TEXT    NOT NULL,
                filename     TEXT    NOT NULL,
                subfolder    TEXT    NOT NULL DEFAULT '',
                ext          TEXT    NOT NULL,
                kind         TEXT    NOT NULL,
                size         INTEGER NOT NULL,
                mtime        REAL    NOT NULL,
                ctime        REAL    DEFAULT 0,
                metadata_json TEXT,
                meta_mtime   REAL    DEFAULT 0,
                PRIMARY KEY (root_id, relpath)
            );
            CREATE INDEX IF NOT EXISTS idx_root_mtime
                ON media_files(root_id, mtime DESC);
            CREATE INDEX IF NOT EXISTS idx_root_subfolder
                ON media_files(root_id, subfolder);
            CREATE TABLE IF NOT EXISTS sbg_meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        """)
        # Migration: add ctime column if missing (existing DBs)
        try:
            conn.execute("SELECT ctime FROM media_files LIMIT 1")
        except sqlite3.OperationalError:
            conn.execute("ALTER TABLE media_files ADD COLUMN ctime REAL DEFAULT 0")
            # Backfill: set ctime = mtime for existing rows until real ctime is read from the filesystem
            conn.execute("UPDATE media_files SET ctime = mtime WHERE ctime = 0 OR ctime IS NULL")
            conn.commit()
        # Create ctime index (safe to run whether column was just added or already existed)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_root_ctime ON media_files(root_id, ctime DESC)")
        conn.commit()
        # Restore the persisted DB version counter (survives server restarts).
        try:
            row = conn.execute("SELECT value FROM sbg_meta WHERE key = 'db_version'").fetchone()
            if row and row["value"] is not None:
                global _db_version
                _db_version = int(row["value"])
        except Exception:
            pass
        # Seed per-root version counters from the global counter for any root
        # that lacks one, so an unchanged root still compares equal on the first
        # reopen (no refetch storm) while a real change compares different.
        try:
            conn.execute(
                "INSERT OR IGNORE INTO sbg_meta(key, value) "
                "SELECT DISTINCT 'root_version:' || root_id, ? FROM media_files",
                (str(_db_version),),
            )
            conn.commit()
        except Exception:
            pass
        # Restore the metadata epoch too (read on every list_all; kept in memory).
        try:
            row = conn.execute("SELECT value FROM sbg_meta WHERE key = 'meta_epoch'").fetchone()
            if row and row["value"] is not None:
                global _meta_epoch
                _meta_epoch = int(row["value"])
        except Exception:
            pass
    _migrate_trim_node_text_bloat()


# Per-node text cap for the one-time bloat-trim migration (mirrors metadata._NODE_TEXT_MAX).
_MIGRATION_NODE_TEXT_CAP = 4000


def _migrate_trim_node_text_bloat() -> None:
    """One-time cleanup: an uncapped 'show'-node text override could store a huge
    blob (600KB+ JSON) into a single workflow_nodes entry, ballooning the DB and
    making search take tens of seconds. Trim any oversized node-param string in
    already-indexed rows so search is fast again without a full reindex. Idempotent
    via PRAGMA user_version (runs once). Best-effort: any failure is swallowed."""
    try:
        with _get_conn() as conn:
            if conn.execute("PRAGMA user_version").fetchone()[0] >= 1:
                return
            cap = _MIGRATION_NODE_TEXT_CAP
            # Only inspect suspiciously-large rows (a normal summary is a few KB).
            rows = conn.execute(
                "SELECT root_id, relpath, metadata_json FROM media_files "
                "WHERE metadata_json IS NOT NULL AND LENGTH(metadata_json) > 12000"
            ).fetchall()
            trimmed = 0
            for r in rows:
                try:
                    s = json.loads(r["metadata_json"])
                except Exception:
                    continue
                changed = False
                for e in (s.get("workflow_nodes") or []):
                    if not isinstance(e, dict):
                        continue
                    p = e.get("params")
                    if isinstance(p, dict):
                        for k, v in list(p.items()):
                            if isinstance(v, str) and len(v) > cap:
                                p[k] = v[:cap] + "…"
                                changed = True
                if changed:
                    conn.execute(
                        "UPDATE media_files SET metadata_json=? WHERE root_id=? AND relpath=?",
                        (json.dumps(s, ensure_ascii=False), r["root_id"], r["relpath"]),
                    )
                    trimmed += 1
            conn.execute("PRAGMA user_version = 1")
            conn.commit()
        if trimmed:
            logger.info(
                "SBG: trimmed oversized node text in %d row(s) - search speed restored. "
                "Disk space is reclaimed on the next VACUUM.", trimmed,
            )
    except Exception as exc:  # never block startup on this cleanup
        logger.warning("SBG: node-text bloat-trim migration skipped: %s", exc)


# ── Core CRUD ──────────────────────────────────────────────────────────

def upsert_file(
    conn: sqlite3.Connection,
    root_id: str,
    relpath: str,
    ext: str,
    kind: str,
    size: int,
    mtime: float,
    metadata_json: str | None = None,
    ctime: float = 0,
):
    """Insert or update a single file record."""
    filename = os.path.basename(relpath)
    subfolder = os.path.dirname(relpath).replace("\\", "/")
    # The DO UPDATE ... WHERE clauses make an upsert that changes nothing a
    # true no-op (rowcount 0), so routine rescans over an unchanged library and
    # repeated backfills of the same row don't bump the version counters; a bump
    # means the client's cached view is really stale. meta_mtime (a
    # "when was metadata extracted" stamp, time.time() on every call) is
    # excluded from the comparison or nothing would ever be a no-op; it only
    # refreshes when the row materially changes.
    if metadata_json is not None:
        cur = conn.execute(
            """INSERT INTO media_files
                   (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime, metadata_json, meta_mtime)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, relpath) DO UPDATE SET
                   size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime,
                   metadata_json=excluded.metadata_json, meta_mtime=excluded.meta_mtime
               WHERE excluded.size IS NOT media_files.size
                  OR excluded.mtime IS NOT media_files.mtime
                  OR excluded.ctime IS NOT media_files.ctime
                  OR excluded.metadata_json IS NOT media_files.metadata_json""",
            (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime, metadata_json, time.time()),
        )
    else:
        cur = conn.execute(
            """INSERT INTO media_files
                   (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, relpath) DO UPDATE SET
                   size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime
               WHERE excluded.size IS NOT media_files.size
                  OR excluded.mtime IS NOT media_files.mtime
                  OR excluded.ctime IS NOT media_files.ctime""",
            (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime),
        )
    if cur.rowcount:
        _bump_version(conn, root_id)


def get_all(root_id: str) -> list[dict]:
    """Return all files for a root, sorted by ctime desc (creation time).
    
    Uses ctime instead of mtime for sort order to prevent files from
    jumping to the top when merely viewed in File Explorer (which can
    update mtime on Windows).
    
    Includes extracted width/height from metadata for AR thumbnail support.
    """
    with _get_conn() as conn:
        rows = conn.execute(
            """SELECT root_id, relpath, filename, subfolder, ext, kind,
                      size, mtime, ctime,
                      json_extract(metadata_json, '$.width') as w,
                      json_extract(metadata_json, '$.height') as h
               FROM media_files
               WHERE root_id = ?
               ORDER BY ctime DESC, relpath DESC""",
            (root_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_all_with_version(root_id: str) -> tuple[int, list[dict]]:
    """Return (root_version, rows) read inside one transaction.

    WAL gives both reads a single snapshot, so the version provably matches the
    row set. Without this, a concurrently-committing scan could produce a
    payload of pre-scan rows stamped with a post-scan version; the client's
    version gate would then treat the missing rows as already-seen and never
    fetch them (files invisible until an unrelated change)."""
    conn = _get_conn()
    try:
        conn.isolation_level = None  # manual transaction control
        conn.execute("BEGIN")
        try:
            row = conn.execute(
                "SELECT value FROM sbg_meta WHERE key = ?",
                (f"root_version:{root_id}",),
            ).fetchone()
            try:
                version = int(row["value"]) if row and row["value"] is not None else 0
            except (TypeError, ValueError):
                version = 0
            rows = conn.execute(
                """SELECT root_id, relpath, filename, subfolder, ext, kind,
                          size, mtime, ctime,
                          json_extract(metadata_json, '$.width') as w,
                          json_extract(metadata_json, '$.height') as h
                   FROM media_files
                   WHERE root_id = ?
                   ORDER BY ctime DESC, relpath DESC""",
                (root_id,),
            ).fetchall()
        finally:
            conn.execute("COMMIT")
    finally:
        conn.close()
    return version, [dict(r) for r in rows]


def mark_meta_attempted(root_id: str, relpath: str) -> None:
    """Stamp meta_mtime on a row whose metadata parse found nothing, without
    bumping any version counter (nothing user-visible changed). Lets the
    /metadata backfill distinguish "never tried" from "tried, file has no
    metadata" so metadata-less files aren't re-parsed and re-upserted on every
    lightbox view (which would bump the version and trigger a full client
    refetch on the next poll)."""
    try:
        with _get_conn() as conn:
            conn.execute(
                "UPDATE media_files SET meta_mtime = ? "
                "WHERE root_id = ? AND relpath = ? AND metadata_json IS NULL",
                (time.time(), root_id, relpath),
            )
    except Exception:
        pass  # best-effort; worst case the parse repeats once more


def get_all_with_metadata(root_id: str) -> list[dict]:
    """Return files with metadata_json, for search."""
    with _get_conn() as conn:
        rows = conn.execute(
            """SELECT root_id, relpath, metadata_json
               FROM media_files
               WHERE root_id = ?
               ORDER BY mtime DESC, relpath DESC""",
            (root_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_items_with_metadata(root_id: str, relpaths: list[str]) -> list[dict]:
    """Return metadata for specific relpaths only (for delta search)."""
    if not relpaths:
        return []
    with _get_conn() as conn:
        placeholders = ",".join("?" for _ in relpaths)
        rows = conn.execute(
            f"""SELECT root_id, relpath, metadata_json
               FROM media_files
               WHERE root_id = ? AND relpath IN ({placeholders})""",
            [root_id] + relpaths,
        ).fetchall()
    return [dict(r) for r in rows]


def get_file(root_id: str, relpath: str) -> dict | None:
    """Return a single file record or None."""
    with _get_conn() as conn:
        row = conn.execute(
            """SELECT root_id, relpath, filename, subfolder, ext, kind,
                      size, mtime, ctime, metadata_json, meta_mtime
               FROM media_files
               WHERE root_id = ? AND relpath = ?""",
            (root_id, relpath),
        ).fetchone()
    return dict(row) if row else None


def get_subfolders(root_id: str) -> list[str]:
    """Return distinct non-empty subfolder paths for a root."""
    with _get_conn() as conn:
        rows = conn.execute(
            """SELECT DISTINCT subfolder FROM media_files
               WHERE root_id = ? AND subfolder != ''
               ORDER BY subfolder""",
            (root_id,),
        ).fetchall()
    return [r["subfolder"] for r in rows]


def get_count(root_id: str) -> int:
    """Return the number of indexed files for a root."""
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM media_files WHERE root_id = ?",
            (root_id,),
        ).fetchone()
    return row["cnt"] if row else 0


def delete_file(conn: sqlite3.Connection, root_id: str, relpath: str):
    """Delete a single file record (requires existing connection)."""
    cur = conn.execute(
        "DELETE FROM media_files WHERE root_id = ? AND relpath = ?",
        (root_id, relpath),
    )
    if cur.rowcount:
        _bump_version(conn, root_id)


def delete_root_rows(root_id: str) -> int:
    """Delete ALL indexed rows for a root, used when a folder is removed from
    config so it doesn't linger in the index. Returns the number of rows removed."""
    conn = _get_conn()
    try:
        cur = conn.execute("DELETE FROM media_files WHERE root_id = ?", (root_id,))
        n = cur.rowcount
        if n:
            _bump_version(conn, root_id)
        # The root is gone from config: clear its per-root bookkeeping so a
        # re-added folder starts fresh (first-index progress included).
        conn.execute("DELETE FROM sbg_meta WHERE key IN (?, ?)",
                     (f"root_version:{root_id}", f"indexed:{root_id}"))
        conn.commit()
        _mtimes_cache.pop(root_id, None)
        return n
    finally:
        conn.close()


# ── Scan support: results, error counters, progress registry ──────────

@dataclass
class ScanResult:
    """Outcome of an incremental scan. `removed` feeds /list_new's delta
    response so clients can reconcile deletions without a full refetch.
    `complete=False` means the scan was cancelled or enumeration was partial
    and the deletion sweep was skipped (nothing was wrongly deleted)."""
    total: int = 0
    changed: int = 0
    added: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    complete: bool = True


class _ScanErrors:
    """Mutable enumeration-error counters filled by _iter_media_files."""
    __slots__ = ("dir_errors", "file_errors")

    def __init__(self):
        self.dir_errors = 0
        self.file_errors = 0


# One progress entry per operation: a full rebuild under _FULL_KEY, a root's
# first index under its root_id. Ownership tokens make late or concurrent
# writers harmless: an operation can only update the entry it began, so a
# first-index scan can't clobber a running full rebuild's progress.
_FULL_KEY = "__full__"
_scan_progress: dict[str, dict] = {}
_scan_progress_lock = threading.Lock()
_progress_token = 0


def begin_progress(key: str, root_id: str | None = None) -> int:
    """Claim a progress entry; returns the ownership token."""
    global _progress_token
    with _scan_progress_lock:
        _progress_token += 1
        token = _progress_token
        _scan_progress[key] = {
            "running": True, "root_id": root_id or key, "total": 0, "done": 0,
            "phase": "scanning", "error": None, "_token": token,
        }
        return token


def update_progress(key: str, token: int, **fields) -> None:
    with _scan_progress_lock:
        entry = _scan_progress.get(key)
        if entry is None or entry.get("_token") != token:
            return  # stale owner: a newer operation took over this key
        entry.update(fields)


def end_progress(key: str, token: int, phase: str, error: str | None = None) -> None:
    """Finish an entry with an honest final phase ("done" or "error"). The
    entry stays visible (running=False) so pollers can observe completion."""
    with _scan_progress_lock:
        entry = _scan_progress.get(key)
        if entry is None or entry.get("_token") != token:
            return
        entry.update({"running": False, "phase": phase, "error": error})


def is_full_reindex_running() -> bool:
    entry = _scan_progress.get(_FULL_KEY)
    return bool(entry and entry.get("running"))


def any_scan_running() -> bool:
    with _scan_progress_lock:
        return any(e.get("running") for e in _scan_progress.values())


def get_progress() -> dict:
    """Snapshot of all scan/reindex progress:
    {"running": <full reindex running>, "full": {...}|None, "roots": {rid: {...}}}
    Entries keep their final done/error state until a new operation reuses
    their key, so pollers can observe how an operation ended."""
    with _scan_progress_lock:
        full = _scan_progress.get(_FULL_KEY)
        roots = {
            k: {kk: vv for kk, vv in e.items() if kk != "_token"}
            for k, e in _scan_progress.items() if k != _FULL_KEY
        }
        return {
            "running": bool(full and full.get("running")),
            "full": ({kk: vv for kk, vv in full.items() if kk != "_token"} if full else None),
            "roots": roots,
        }


# ── Incremental scan (fast) ───────────────────────────────────────────

def _filter_scan_dirs(dirnames: list[str], excluded: set[str], *, skip_hidden: bool = True) -> None:
    """Prune the os.walk subtree in place so the scanner skips whole folders.

    Reassigning ``dirnames`` with a slice is what tells os.walk (topdown=True,
    the default) not to descend into those directories. When ``skip_hidden`` is
    True (default) hidden ``.``-prefixed folders (e.g. a ``.thumbs`` cache that
    would otherwise duplicate images) are skipped; user-configured excluded
    folder names are always skipped (compared lowercased).
    """
    dirnames[:] = [
        d for d in dirnames
        if not (skip_hidden and d.startswith(".")) and d.lower() not in excluded
    ]


def _iter_media_files(base_abs, excluded, skip_hidden, errors: _ScanErrors | None = None):
    """Yield (rel, ext, kind, size, mtime, ctime) for every media file under
    base_abs, using os.scandir so DirEntry.stat() reuses the directory listing
    (no extra per-file stat syscall on Windows, the big win on network shares).
    Mirrors os.walk + _filter_scan_dirs directory pruning.

    OSErrors are swallowed (a scan must survive a locked folder) but counted
    into `errors`: a directory that fails to list means the enumeration is
    incomplete, and callers must not treat its missing files as deletions. This
    guard prevents a flaky network share from mass-purging indexed rows."""
    stack = [base_abs]
    while stack:
        dirpath = stack.pop()
        try:
            with os.scandir(dirpath) as it:
                entries = list(it)
        except OSError:
            if errors is not None:
                errors.dir_errors += 1
            continue
        subdirs = []
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    subdirs.append(entry.name)
                    continue
            except OSError:
                if errors is not None:
                    errors.file_errors += 1
                continue
            ext = os.path.splitext(entry.name)[1].lower()
            if ext not in ALL_MEDIA_EXTS:
                continue
            try:
                st = entry.stat()  # reuses the scandir listing on Windows
            except OSError:
                if errors is not None:
                    errors.file_errors += 1
                continue
            rel = os.path.relpath(entry.path, base_abs).replace("\\", "/")
            kind = _kind_from_ext(ext)
            yield rel, ext, kind, int(st.st_size), float(st.st_mtime), float(st.st_ctime)
        # Prune subdirs exactly like os.walk + _filter_scan_dirs, then recurse.
        _filter_scan_dirs(subdirs, excluded, skip_hidden=skip_hidden)
        for name in subdirs:
            stack.append(os.path.join(dirpath, name))


# Shared pool for parallel metadata reads (both scan paths). Module-level so the
# frequent poll scan doesn't build and tear down a fresh ThreadPoolExecutor for a
# 1-2 file batch; lazily created so importing this module stays cheap.
_META_READ_POOL: ThreadPoolExecutor | None = None
_meta_pool_lock = threading.Lock()


def _get_meta_pool() -> ThreadPoolExecutor:
    global _META_READ_POOL
    with _meta_pool_lock:
        if _META_READ_POOL is None:
            _META_READ_POOL = ThreadPoolExecutor(
                max_workers=_REINDEX_META_WORKERS, thread_name_prefix="sbg-meta")
        return _META_READ_POOL


def _read_and_upsert_batches(
    conn: sqlite3.Connection,
    root: AllowedRoot,
    items: list[tuple],
    read_metadata_fn: Callable[[str], dict | None] | None,
    *,
    batch_size: int = 100,
    progress_cb: Callable[[int], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> int:
    """Read each batch's metadata in parallel (overlaps slow network file I/O),
    then upsert the batch on the caller's single writer connection (writes
    serialized), committing per batch so a long first index never holds the
    write lock for minutes. Shared by both scan paths. Returns the number of
    rows upserted; stops between batches when `cancel_event` is set."""
    rid = root.root_id

    def _read_one(item):
        rel, ext, kind, size, mtime, ctime = item
        meta_json = None
        if read_metadata_fn:
            try:
                full = safe_join(root.path, rel)
                meta_dict = read_metadata_fn(full)
                if meta_dict:
                    meta_json = json.dumps(meta_dict)
            except Exception as e:
                logger.warning("Metadata parse failed for %s: %s", rel, e)
                # Safe parsing: skip this file's metadata, still index it
        return rel, ext, kind, size, mtime, ctime, meta_json

    done = 0
    if not items:
        return 0
    pool = _get_meta_pool()
    for start in range(0, len(items), batch_size):
        if cancel_event is not None and cancel_event.is_set():
            break
        batch = items[start:start + batch_size]
        for rel, ext, kind, size, mtime, ctime, meta_json in pool.map(_read_one, batch):
            upsert_file(conn, rid, rel, ext, kind, size, mtime, meta_json, ctime=ctime)
            done += 1
        conn.commit()
        if progress_cb:
            progress_cb(done)
    return done


# Cached (root_version, {relpath: mtime}) per root. The auto-refresh poll scans
# frequently, and re-SELECTing tens of thousands of rows just to conclude
# "nothing changed" is wasteful; the per-root version key keeps the cache exact
# (every material write bumps it).
_mtimes_cache: dict[str, tuple[int, dict[str, float]]] = {}


def incremental_scan(
    root: AllowedRoot,
    *,
    read_metadata_fn: Callable[[str], dict | None] | None = None,
    excluded_dirs: set[str] | None = None,
    index_hidden_dirs: bool = False,
    report_progress: bool = False,
    cancel_event: threading.Event | None = None,
) -> ScanResult:
    """Fast incremental scan: only update new/changed files.

    1. Walk the filesystem and collect all files + mtime/size
    2. Compare against DB mtime - only upsert new/changed files
    3. Delete DB records for files no longer on disk - SKIPPED when the
       enumeration was incomplete (see the sweep guard below)

    `report_progress` is decided by the caller (routes knows whether the root
    ever completed an index via the "indexed:<rid>" marker). A first index
    reports live counts under this root's own registry key, so it never touches
    another operation's progress.

    Raises on failure with the progress entry left in phase "error". A
    `cancel_event` stops the scan between batches (used when a root is removed
    from config mid-scan); a cancelled scan commits what it has, skips the
    deletion sweep, and returns complete=False.
    """
    base_abs = os.path.abspath(root.path)
    rid = root.root_id
    token = begin_progress(rid) if report_progress else None

    try:
        result = _incremental_scan_impl(
            root, base_abs, rid, token,
            read_metadata_fn=read_metadata_fn,
            excluded_dirs=excluded_dirs,
            index_hidden_dirs=index_hidden_dirs,
            cancel_event=cancel_event,
        )
    except Exception as e:
        if token is not None:
            end_progress(rid, token, "error", str(e))
        raise

    if token is not None:
        update_progress(rid, token, total=result.total, done=result.changed)
        end_progress(rid, token, "done")
    if result.complete:
        # "This root completed a real index" marker; drives the caller's
        # report_progress decision for future scans.
        set_meta_value(f"indexed:{rid}", "1")
    return result


def _incremental_scan_impl(root, base_abs, rid, token, *, read_metadata_fn,
                           excluded_dirs, index_hidden_dirs, cancel_event) -> ScanResult:
    if not os.path.isdir(base_abs):
        raise OSError(f"root path not accessible: {base_abs}")

    # Existing DB records for this root (relpath -> mtime), cached per version.
    cur_version = get_root_version(rid)
    cached = _mtimes_cache.get(rid)
    if cached is not None and cached[0] == cur_version:
        db_mtimes = cached[1]
    else:
        with _get_conn() as conn:
            db_rows = conn.execute(
                "SELECT relpath, mtime FROM media_files WHERE root_id = ?",
                (rid,),
            ).fetchall()
        db_mtimes = {r["relpath"]: r["mtime"] for r in db_rows}
        _mtimes_cache[rid] = (cur_version, db_mtimes)

    # Collect all current files from filesystem.
    disk_files: dict[str, tuple[str, str, int, float, float]] = {}  # relpath -> (ext, kind, size, mtime, ctime)
    excluded = excluded_dirs or set()
    skip_hidden = not index_hidden_dirs
    errors = _ScanErrors()
    for rel, ext, kind, size, mtime, ctime in _iter_media_files(base_abs, excluded, skip_hidden, errors):
        # st_ctime = creation time on Windows, metadata change time on Unix
        disk_files[rel] = (ext, kind, size, mtime, ctime)
        if token is not None and len(disk_files) % 200 == 0:
            update_progress(rid, token, total=len(disk_files))

    if token is not None:
        update_progress(rid, token, total=len(disk_files), phase="indexing")

    # Files that are new or whose mtime changed need an upsert (+ metadata read).
    changed_items = [
        (rel, ext, kind, size, mtime, ctime)
        for rel, (ext, kind, size, mtime, ctime) in disk_files.items()
        if db_mtimes.get(rel) is None or abs(mtime - db_mtimes[rel]) >= 0.01
    ]
    result = ScanResult(total=len(disk_files))
    result.added = [it[0] for it in changed_items if it[0] not in db_mtimes]
    result.updated = [it[0] for it in changed_items if it[0] in db_mtimes]

    conn = _get_conn()
    try:
        def _cb(done):
            if token is not None:
                update_progress(rid, token, done=done)

        result.changed = _read_and_upsert_batches(
            conn, root, changed_items, read_metadata_fn,
            batch_size=100, progress_cb=_cb, cancel_event=cancel_event,
        )

        # Deletion sweep guard: files "missing" from a partial enumeration are
        # not deletions. Any directory that failed to list, or the whole root
        # vanishing mid-scan (network share drop), skips the sweep so it can't
        # purge entire subtrees' rows and parsed metadata. A genuinely emptied
        # folder still reconciles: its enumeration succeeds with zero errors and
        # zero files.
        if cancel_event is not None and cancel_event.is_set():
            result.complete = False
        elif errors.dir_errors > 0 or not os.path.isdir(base_abs):
            logger.warning(
                "SBG: scan of %s enumerated with %d unreadable director(y/ies); "
                "skipping the deletion sweep this pass", rid, max(errors.dir_errors, 1),
            )
            result.complete = False
        else:
            removed = set(db_mtimes.keys()) - set(disk_files.keys())
            for rel in removed:
                delete_file(conn, rid, rel)
            result.removed = sorted(removed)
            result.changed += len(removed)

        conn.commit()
    finally:
        conn.close()
    if result.complete:
        # Cache the post-scan state keyed to the post-commit version, so the
        # next idle poll skips the mtimes SELECT even right after a change.
        _mtimes_cache[rid] = (
            get_root_version(rid),
            {rel: t[3] for rel, t in disk_files.items()},
        )
    return result


# ── Full reindex (background) ─────────────────────────────────────────


def full_reindex(
    root: AllowedRoot,
    read_metadata_fn: Callable[[str], dict | None],
    *,
    batch_size: int = 100,
    excluded_dirs: set[str] | None = None,
    index_hidden_dirs: bool = False,
) -> int:
    """Full reindex: scan every file, parse every file's metadata.

    Runs synchronously (call from a background thread). Reports into the
    progress registry under _FULL_KEY. Returns total files indexed.

    Uses atomic swap: inserts all new records before deleting old ones,
    so the gallery never sees an empty database.
    """
    rid = root.root_id
    base_abs = os.path.abspath(root.path)
    token = begin_progress(_FULL_KEY, root_id=rid)

    try:
        if not os.path.isdir(base_abs):
            raise OSError(f"root path not accessible: {base_abs}")

        # Phase 1: scan filesystem, with a live found-count so the UI shows
        # motion instead of sitting at "0/0" for the whole walk.
        disk_files: list[tuple[str, str, str, int, float, float]] = []
        excluded = excluded_dirs or set()
        skip_hidden = not index_hidden_dirs
        errors = _ScanErrors()
        for tup in _iter_media_files(base_abs, excluded, skip_hidden, errors):
            disk_files.append(tup)
            if len(disk_files) % 500 == 0:
                update_progress(_FULL_KEY, token, total=len(disk_files))

        update_progress(_FULL_KEY, token, total=len(disk_files), phase="indexing")

        # Phase 2: insert all records using a single connection, then delete old
        # ones, so the gallery always has data and never sees an empty DB.
        conn = _get_conn()
        try:
            new_relpaths = {it[0] for it in disk_files}
            _read_and_upsert_batches(
                conn, root, disk_files, read_metadata_fn,
                batch_size=batch_size,
                progress_cb=lambda done: update_progress(_FULL_KEY, token, done=done),
            )

            # Delete records for files no longer on disk, with the same partial-
            # enumeration guard as incremental_scan (missing subtrees from a
            # flaky share must not be treated as deletions). Uses delete_file
            # (not a raw executemany) so each removal bumps the root version;
            # otherwise clients never learn reindex-swept files are gone.
            if errors.dir_errors == 0 and os.path.isdir(base_abs):
                existing_rows = conn.execute(
                    "SELECT relpath FROM media_files WHERE root_id = ?", (rid,)
                ).fetchall()
                for r in existing_rows:
                    if r["relpath"] not in new_relpaths:
                        delete_file(conn, rid, r["relpath"])
            else:
                logger.warning(
                    "SBG: full reindex of %s had %d unreadable director(y/ies); "
                    "skipping the stale-row sweep", rid, max(errors.dir_errors, 1),
                )

            conn.commit()
            update_progress(_FULL_KEY, token, done=len(disk_files))
        finally:
            conn.close()

        end_progress(_FULL_KEY, token, "done")
        set_meta_value(f"indexed:{rid}", "1")
        # Tell clients to drop cached metadata: a reindex rewrote every row's
        # metadata_json but left file mtimes (and the per-item staleness check)
        # unchanged, so clients wouldn't otherwise notice.
        bump_meta_epoch()
        return len(disk_files)

    except Exception as e:
        logger.error("Full reindex failed: %s", e)
        end_progress(_FULL_KEY, token, "error", str(e))
        raise


# ── is_empty check ─────────────────────────────────────────────────────

def is_empty() -> bool:
    """Return True if the DB has no indexed files at all."""
    try:
        with _get_conn() as conn:
            row = conn.execute("SELECT COUNT(*) as cnt FROM media_files").fetchone()
        return (row["cnt"] if row else 0) == 0
    except Exception:
        return True


# ── Layout Editor: aggregate all metadata keys ─────────────────────────

def get_all_meta_keys() -> dict:
    """Scan ALL indexed files and return all unique metadata keys.

    Aggregated over every row and cached by db_version so the layout editor's
    parameter picker is deterministic (not a random sample that changes which
    workflow-node params appear on every call).

    Returns:
        {
          "sections": ["source_app", "model", "samplers", ...],
          "workflow_nodes": { "NodeClassName": ["param1", "param2", ...], ... },
          "sampler_keys": ["sampler_name", "scheduler", ...],
          "lora_keys": ["name", "strength_model", ...],
          "controlnet_keys": ["model", "preprocessor", ...],
          "upscaling_keys": ["model", "type", ...],
          "adetailer_keys": ["model", "steps", ...],
          "interpolation_keys": ["type", "multiplier", ...],
          "mmaudio_keys": ["steps", "cfg", ...],
          "extra_keys": ["key1", "key2", ...]
        }
    """
    global _meta_keys_cache, _meta_keys_cache_ver
    with _meta_keys_lock:
        if _meta_keys_cache is not None and _meta_keys_cache_ver == _db_version:
            return _meta_keys_cache
        # While any scan/reindex runs, db_version churns (a bump per batch), so
        # serve the last result until the writes settle instead of re-scanning
        # every row on each call.
        if _meta_keys_cache is not None and any_scan_running():
            return _meta_keys_cache
        result = _compute_all_meta_keys()
        _meta_keys_cache = result
        _meta_keys_cache_ver = _db_version
        return result


def _compute_all_meta_keys() -> dict:
    """Full single-pass aggregation over every indexed row's metadata_json.
    Streams the cursor (no fetchall) to bound memory across a large library.
    Pure compute; caching is handled by get_all_meta_keys under its lock."""
    sections: set[str] = set()
    workflow_nodes: dict[str, set[str]] = {}
    workflow_node_titles: dict[str, str] = {}
    # Per-instance info for duplicated/contextual nodes, keyed by class_type.
    # identity key = title or _from or index; lets the layout editor offer
    # "ShowAny - 'LLM Output'" / "ShowAny (from BasicScheduler)" / "KSampler #2".
    workflow_node_instances: dict[str, dict[str, dict]] = {}
    sampler_keys: set[str] = set()
    lora_keys: set[str] = set()
    controlnet_keys: set[str] = set()
    upscaling_keys: set[str] = set()
    adetailer_keys: set[str] = set()
    interpolation_keys: set[str] = set()
    mmaudio_keys: set[str] = set()
    extra_keys: set[str] = set()

    # Which top-level keys are array-of-dict vs object sections comes from the
    # section catalog (single source of truth); map each to its output key set.
    _buckets = meta_key_buckets()
    _key_dest = {
        "samplers": sampler_keys, "loras": lora_keys, "controlnet": controlnet_keys,
        "upscaling": upscaling_keys, "adetailer": adetailer_keys,
        "interpolation": interpolation_keys, "mmaudio": mmaudio_keys, "extra": extra_keys,
    }

    try:
        with _get_conn() as conn:
            # Aggregate over every indexed file (deterministic), not a random
            # sample. Stream the cursor (no fetchall) so all metadata blobs
            # aren't pulled into memory at once.
            cur = conn.execute(
                """SELECT metadata_json FROM media_files
                   WHERE metadata_json IS NOT NULL AND metadata_json != ''"""
            )
            for row in cur:
                try:
                    meta = json.loads(row["metadata_json"])
                except Exception:
                    continue
                if not isinstance(meta, dict):
                    continue

                for key, val in meta.items():
                    if key.startswith("_"):
                        continue
                    sections.add(key)

                    # Array-of-dict and object sections are classified by the catalog
                    # (meta_key_buckets); _key_dest preserves the output contract names.
                    kind = _buckets.get(key)
                    dest = _key_dest.get(key)
                    if kind == "array" and dest is not None and isinstance(val, list):
                        for item in val:
                            if isinstance(item, dict):
                                dest.update(item.keys())
                    elif kind == "object" and dest is not None and isinstance(val, dict):
                        dest.update(val.keys())

                    # Collect workflow node types and their params. Key by
                    # class_type (not title) so renaming a node in the workflow
                    # does not create a duplicate entry in the editor.
                    elif key == "workflow_nodes" and isinstance(val, list):
                        per_type_index: dict[str, int] = {}
                        for node in val:
                            if not isinstance(node, dict):
                                continue
                            node_name = node.get("class_type") or node.get("title") or "Unknown"
                            if node_name not in workflow_nodes:
                                workflow_nodes[node_name] = set()
                            params = node.get("params", {})
                            if isinstance(params, dict):
                                for pk in params:
                                    workflow_nodes[node_name].add(pk)
                            # Remember the human-facing node title (e.g. "JoyCaption
                            # Output") so the layout editor can label nodes by title,
                            # not just the cryptic class_type ("easy showAnything").
                            title = node.get("title")
                            if title and title != node_name and node_name not in workflow_node_titles:
                                workflow_node_titles[node_name] = title
                            # Instance info: merged across sampled rows by identity
                            # key (title > _from > index-within-this-file).
                            idx = per_type_index.get(node_name, 0)
                            per_type_index[node_name] = idx + 1
                            from_ctx = node.get("_from")
                            ident = ("t:" + title) if title else (
                                ("f:" + from_ctx) if from_ctx else ("i:" + str(idx)))
                            inst_bucket = workflow_node_instances.setdefault(node_name, {})
                            if ident not in inst_bucket and len(inst_bucket) < 8:
                                inst: dict = {"index": idx}
                                if title:
                                    inst["title"] = title
                                if from_ctx:
                                    inst["from"] = from_ctx
                                inst["params"] = sorted(params.keys()) if isinstance(params, dict) else []
                                inst_bucket[ident] = inst

    except Exception as e:
        logger.warning("_compute_all_meta_keys failed: %s", e)

    return {
        "sections": sorted(sections),
        "workflow_nodes": {k: sorted(v) for k, v in workflow_nodes.items()},
        "workflow_node_titles": workflow_node_titles,
        "workflow_node_instances": {k: list(v.values()) for k, v in workflow_node_instances.items()},
        "sampler_keys": sorted(sampler_keys),
        "lora_keys": sorted(lora_keys),
        "controlnet_keys": sorted(controlnet_keys),
        "upscaling_keys": sorted(upscaling_keys),
        "adetailer_keys": sorted(adetailer_keys),
        "interpolation_keys": sorted(interpolation_keys),
        "mmaudio_keys": sorted(mmaudio_keys),
        "extra_keys": sorted(extra_keys),
    }


# ── Initialize on import ──────────────────────────────────────────────

init_db()
