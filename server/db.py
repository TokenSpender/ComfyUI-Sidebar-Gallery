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
from pathlib import Path
from typing import Any, Callable

from .schema import meta_key_buckets
from .security import AllowedRoot, safe_join

logger = logging.getLogger("sbg.db")

_DB_PATH = Path(__file__).resolve().parents[1] / "sidebar_gallery_cache.db"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

# Database version counter — incremented on any write operation. The frontend
# compares this against its last-seen value to know when to invalidate cached
# metadata. PERSISTED in the sbg_meta table (lazily, on read) so a ComfyUI
# restart doesn't reset it to 0 — an in-memory-only counter made every restart
# look like a DB change, which nuked the browser's entire thumbnail/metadata
# cache on each reboot.
_db_version = 0
_db_version_dirty = False

# Metadata epoch — increments only when metadata is fully RE-EXTRACTED (a reindex),
# NOT on every write. Kept in memory (mirrors _db_version) so the list_all hot path
# reads it without opening a fresh SQLite connection per request; persisted in
# sbg_meta and restored in init_db so it survives a ComfyUI restart.
_meta_epoch = 0

# Cached result of get_all_meta_keys() — a full scan of every row is too slow to
# repeat per request, so the aggregate is recomputed only when _db_version changes.
# The lock serializes concurrent callers (each runs in a run_in_executor worker
# thread) so they don't both run the scan and race on the module-global cache.
_meta_keys_cache: dict | None = None
_meta_keys_cache_ver = -1
_meta_keys_lock = threading.Lock()

def get_db_version() -> int:
    """Return the current version, persisting it first if it changed."""
    global _db_version_dirty
    if _db_version_dirty:
        try:
            with _get_conn() as conn:
                conn.execute(
                    "INSERT INTO sbg_meta(key, value) VALUES('db_version', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(_db_version),),
                )
            _db_version_dirty = False
        except Exception:
            pass  # persist on the next read instead
    return _db_version

def _bump_version():
    global _db_version, _db_version_dirty
    _db_version += 1
    _db_version_dirty = True


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


def get_meta_epoch() -> int:
    """Epoch that increments when metadata is fully RE-EXTRACTED (a reindex).
    A reindex rewrites every row's metadata_json without changing file mtimes,
    so the client's per-item mtime check can't see it; clients drop cached
    metadata when this changes. A plain db_version bump (a new generation) must
    NOT, or the lightbox would re-fetch metadata on every navigation.

    Served from the in-memory counter (no DB connection) — this is read on every
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
    """Open a NEW SQLite connection with WAL mode.

    Note: this is per-call, not thread-local/pooled. Callers either close it
    explicitly (long scans) or rely on GC after a short `with conn:` block —
    WAL mode + the 30s busy timeout make concurrent use safe.
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
            # Backfill: set ctime = mtime for existing rows (temporary until real ctime from filesystem)
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
    """One-time cleanup: an earlier uncapped 'show'-node text override could store a
    huge blob (a 600KB+ JSON dump) into a single workflow_nodes entry, ballooning the
    DB and making search take tens of seconds. Trim any oversized node-param string in
    already-indexed rows so search is fast again WITHOUT a full reindex. Idempotent via
    PRAGMA user_version (runs once). Best-effort: any failure is swallowed."""
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
                "SBG: trimmed oversized node text in %d row(s) — search speed restored. "
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
    if metadata_json is not None:
        # meta_mtime records WHEN metadata was extracted (distinct from the file's
        # own mtime). It is intentionally unread today — metadata-cache invalidation
        # is driven by meta_epoch (reindex) + file mtime (overwrite) — but kept as a
        # per-item extraction stamp in case granular invalidation is wanted later.
        conn.execute(
            """INSERT INTO media_files
                   (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime, metadata_json, meta_mtime)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, relpath) DO UPDATE SET
                   size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime,
                   metadata_json=excluded.metadata_json, meta_mtime=excluded.meta_mtime""",
            (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime, metadata_json, time.time()),
        )
    else:
        conn.execute(
            """INSERT INTO media_files
                   (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, relpath) DO UPDATE SET
                   size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime""",
            (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime),
        )
    _bump_version()


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
                      size, mtime, metadata_json
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
    conn.execute(
        "DELETE FROM media_files WHERE root_id = ? AND relpath = ?",
        (root_id, relpath),
    )
    _bump_version()


# ── Incremental scan (fast) ───────────────────────────────────────────

def incremental_scan(
    root: AllowedRoot,
    *,
    read_metadata_fn: Callable[[str], dict | None] | None = None,
) -> tuple[int, int]:
    """Fast incremental scan: only update new/changed files.

    1. Walk the filesystem and collect all files + mtime/size
    2. Compare against DB mtime — only update changed files
    3. Delete DB records for files that no longer exist on disk
    4. Optionally parse metadata for new/changed files

    Returns (total_files, changed_files).
    """
    base_abs = os.path.abspath(root.path)
    rid = root.root_id

    # Collect all current files from filesystem
    disk_files: dict[str, tuple[str, str, int, float, float]] = {}  # relpath -> (ext, kind, size, mtime, ctime)
    for dirpath, _dirnames, filenames in os.walk(base_abs):
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext not in ALL_MEDIA_EXTS:
                continue
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(full, base_abs).replace("\\", "/")
            kind = "video" if ext in VIDEO_EXTS else "image"
            # st_ctime = creation time on Windows, metadata change time on Unix
            disk_files[rel] = (ext, kind, int(st.st_size), float(st.st_mtime), float(st.st_ctime))

    # Get existing DB records for this root
    with _get_conn() as conn:
        db_rows = conn.execute(
            "SELECT relpath, mtime FROM media_files WHERE root_id = ?",
            (rid,),
        ).fetchall()
    db_mtimes: dict[str, float] = {r["relpath"]: r["mtime"] for r in db_rows}

    # Find new and changed files
    changed = 0
    conn = _get_conn()
    try:
        for rel, (ext, kind, size, mtime, ctime) in disk_files.items():
            old_mtime = db_mtimes.get(rel)
            if old_mtime is not None and abs(mtime - old_mtime) < 0.01:
                continue  # unchanged

            # New or changed file
            meta_json = None
            if read_metadata_fn:
                try:
                    full = safe_join(root.path, rel)
                    meta_dict = read_metadata_fn(full)
                    if meta_dict:
                        meta_json = json.dumps(meta_dict)
                except Exception as e:
                    logger.warning("Metadata parse failed for %s: %s", rel, e)

            upsert_file(conn, rid, rel, ext, kind, size, mtime, meta_json, ctime=ctime)
            changed += 1
            # Commit in batches. A first scan of an empty DB inserts the ENTIRE
            # library; a single giant transaction held the write lock for
            # minutes, which crashed any concurrent writer with "database is
            # locked" (e.g. a user-triggered rebuild) and kept readers from
            # seeing progress.
            if changed % 100 == 0:
                conn.commit()

        # Delete records for files no longer on disk
        db_relpaths = set(db_mtimes.keys())
        disk_relpaths = set(disk_files.keys())
        removed = db_relpaths - disk_relpaths
        for rel in removed:
            delete_file(conn, rid, rel)
            changed += 1

        conn.commit()
    finally:
        conn.close()

    return len(disk_files), changed


# ── Full reindex (background) ─────────────────────────────────────────

# Global progress tracking
_reindex_progress: dict[str, Any] = {
    "running": False,
    "root_id": None,
    "total": 0,
    "done": 0,
    "phase": "",
    "error": None,
}


def get_reindex_progress() -> dict:
    """Return the current reindex progress."""
    return dict(_reindex_progress)


def full_reindex(
    root: AllowedRoot,
    read_metadata_fn: Callable[[str], dict | None],
    *,
    batch_size: int = 50,
) -> int:
    """Full reindex: scan every file, parse every file's metadata.

    Runs synchronously (call from a background thread).
    Updates _reindex_progress for frontend polling.
    Returns total files indexed.

    Uses atomic swap: inserts all new records before deleting old ones,
    so the gallery never sees an empty database.
    """
    global _reindex_progress

    rid = root.root_id
    base_abs = os.path.abspath(root.path)

    _reindex_progress.update({
        "running": True,
        "root_id": rid,
        "total": 0,
        "done": 0,
        "phase": "scanning",
        "error": None,
    })

    try:
        # Phase 1: scan filesystem
        disk_files: list[tuple[str, str, str, int, float, float]] = []
        for dirpath, _dirnames, filenames in os.walk(base_abs):
            for name in filenames:
                ext = os.path.splitext(name)[1].lower()
                if ext not in ALL_MEDIA_EXTS:
                    continue
                full = os.path.join(dirpath, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, base_abs).replace("\\", "/")
                kind = "video" if ext in VIDEO_EXTS else "image"
                disk_files.append((rel, ext, kind, int(st.st_size), float(st.st_mtime), float(st.st_ctime)))

        _reindex_progress["total"] = len(disk_files)
        _reindex_progress["phase"] = "indexing"

        # Phase 2: insert all records using a SINGLE connection, then delete old ones
        # This ensures the gallery always has data — never sees an empty DB.
        conn = _get_conn()
        try:
            # Collect all new relpaths for the final cleanup step
            new_relpaths = set()

            for i, (rel, ext, kind, size, mtime, ctime) in enumerate(disk_files):
                meta_json = None
                try:
                    full = safe_join(root.path, rel)
                    meta_dict = read_metadata_fn(full)
                    if meta_dict:
                        meta_json = json.dumps(meta_dict)
                except Exception as e:
                    logger.warning("Metadata parse failed for %s: %s", rel, e)
                    # Safe parsing: skip this file's metadata, still index it

                # upsert_file's ON CONFLICT clause refreshes ctime from the
                # filesystem too, so no separate per-row UPDATE is needed.
                upsert_file(conn, rid, rel, ext, kind, size, mtime, meta_json, ctime=ctime)
                new_relpaths.add(rel)

                if (i + 1) % batch_size == 0:
                    conn.commit()
                    _reindex_progress["done"] = i + 1

            # Now delete records for files that no longer exist on disk
            # (in the same connection, so this is part of the same logical transaction)
            existing_rows = conn.execute(
                "SELECT relpath FROM media_files WHERE root_id = ?", (rid,)
            ).fetchall()
            stale = [r["relpath"] for r in existing_rows if r["relpath"] not in new_relpaths]
            if stale:
                conn.executemany(
                    "DELETE FROM media_files WHERE root_id = ? AND relpath = ?",
                    [(rid, rp) for rp in stale],
                )

            conn.commit()
            _reindex_progress["done"] = len(disk_files)
        finally:
            conn.close()

        _reindex_progress["phase"] = "done"
        # Tell clients to drop cached metadata: a reindex rewrote every row's
        # metadata_json but left file mtimes (and the per-item staleness check)
        # unchanged.
        bump_meta_epoch()
        return len(disk_files)

    except Exception as e:
        logger.error("Full reindex failed: %s", e)
        _reindex_progress["error"] = str(e)
        _reindex_progress["phase"] = "error"
        raise
    finally:
        _reindex_progress["running"] = False


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
    parameter picker is deterministic. (It previously sampled a random 500 rows,
    so which workflow-node params appeared changed on every call.)

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
    # Serialize concurrent callers (each runs in a run_in_executor worker thread)
    # so they don't both run the full scan and race on the module-global cache.
    with _meta_keys_lock:
        if _meta_keys_cache is not None and _meta_keys_cache_ver == _db_version:
            return _meta_keys_cache
        # During a reindex, db_version churns (a bump per batch) — don't re-scan
        # every row on each call; serve the last result until the reindex settles.
        if _meta_keys_cache is not None and _reindex_progress.get("running"):
            return _meta_keys_cache
        result = _compute_all_meta_keys()
        _meta_keys_cache = result
        _meta_keys_cache_ver = _db_version
        return result


def _compute_all_meta_keys() -> dict:
    """Full single-pass aggregation over every indexed row's metadata_json.
    Streams the cursor (no fetchall) to bound memory across a ~29k-row library.
    Pure compute — caching is handled by get_all_meta_keys under its lock."""
    sections: set[str] = set()
    workflow_nodes: dict[str, set[str]] = {}
    workflow_node_titles: dict[str, str] = {}
    # Per-instance info for duplicated/contextual nodes, keyed by class_type.
    # identity key = title or _from or index; lets the layout editor offer
    # "ShowAny — 'LLM Output'" / "ShowAny (from BasicScheduler)" / "KSampler #2".
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
            # Aggregate over EVERY indexed file (deterministic), not a random
            # sample. Stream the cursor (no fetchall) so all ~29k metadata blobs
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

                    # Collect workflow node types and their params.
                    # Key by class_type (NOT title) so renaming a node in the
                    # workflow does not create a duplicate entry in the editor.
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
