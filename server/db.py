from __future__ import annotations

import errno
import json
import logging
import os
import sqlite3
import stat
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import AbstractSet, Callable, Iterator

from .media_types import ALL_MEDIA_EXTS, kind_from_ext
from .schema import meta_key_buckets, prose_length_threshold, prose_paths
from .search import storable, summary_rows
from .security import AllowedRoot, name_folds, safe_join
from . import recycle

logger = logging.getLogger("sbg.db")

DB_PATH = Path(__file__).resolve().parents[1] / "sidebar_gallery_cache.db"

def root_meta_key(prefix: str, root_id: str) -> str:
    # Every per-root key ends with the root id, which lets delete_root_rows
    # clear a root's keys without knowing the prefixes.
    return f"{prefix}:{root_id}"

_db_version = 0
_versions_lock = threading.Lock()

# A rebuild rewrites stored metadata without moving any file's mtime, so the
# browser drops its metadata cache when this counter moves instead.
_meta_epoch = 0

_meta_keys_cache: dict | None = None
_meta_keys_cache_ver = -1
_meta_keys_lock = threading.Lock()

def get_db_version() -> int:
    return _db_version

def get_root_version(root_id: str) -> int:
    # Read from the table on every call, since an in-memory copy can run ahead
    # of the committed rows after a rollback, so every poll would see a changed
    # version and fetch the list again.
    v = get_meta_value(root_meta_key("root_version", root_id))
    try:
        return int(v) if v is not None else 0
    except (TypeError, ValueError):
        return 0

def _bump_version(conn: sqlite3.Connection, root_id: str) -> None:
    global _db_version
    conn.execute(
        "INSERT INTO sbg_meta(key, value) VALUES(?, '1') "
        "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        (root_meta_key("root_version", root_id),),
    )
    # The write below can wait out the busy timeout on another thread, so it
    # runs outside this module-wide lock, and MAX keeps the stored value from
    # going backwards whatever order two callers write in.
    with _versions_lock:
        _db_version += 1
        reserved = _db_version
    conn.execute(
        "INSERT INTO sbg_meta(key, value) VALUES('db_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = "
        "CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)",
        (str(reserved),),
    )

def get_meta_value(key: str) -> str | None:
    # A failed read raises instead of answering None, since None says nothing
    # is stored, and that decides whether a rebuild runs and a root is indexed.
    with connect() as conn:
        row = conn.execute("SELECT value FROM sbg_meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

def set_meta_value(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO sbg_meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )

def get_meta_epoch() -> int:
    return _meta_epoch

def bump_meta_epoch() -> None:
    global _meta_epoch
    with _versions_lock:
        _meta_epoch += 1
        epoch = _meta_epoch
    set_meta_value("meta_epoch", str(epoch))

def has_any_files() -> bool:
    with connect() as conn:
        return conn.execute("SELECT 1 FROM media_files LIMIT 1").fetchone() is not None

_WAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024

# A scan hides a row whose file it finds gone instead of deleting it, and a
# rebuild deletes one hidden this long, so a drive left unplugged for weeks
# still gives every card back.
_MISSING_GRACE_S = 30 * 86400

def _get_conn() -> sqlite3.Connection:
    # No pool, since a sqlite3 connection belongs to the thread that opened it.
    # WAL mode is stored in the file, so init_db sets it once and it is not set here.
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA synchronous=NORMAL")
    # SQLite reads a negative cache size as KiB.
    conn.execute("PRAGMA cache_size=-8000")
    # A reader open across a long write lets the log grow to the size of that
    # write, and the limit truncates it back at the next checkpoint.
    conn.execute(f"PRAGMA journal_size_limit={_WAL_SIZE_LIMIT_BYTES}")
    conn.row_factory = sqlite3.Row
    return conn

@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = _get_conn()
    try:
        with conn:
            yield conn
    finally:
        conn.close()

def index_size_bytes() -> int:
    total = 0
    for part in (DB_PATH, DB_PATH.with_name(DB_PATH.name + "-wal"),
                 DB_PATH.with_name(DB_PATH.name + "-shm")):
        try:
            total += part.stat().st_size
        except OSError:
            pass
    return total

def _checkpoint_wal(conn: sqlite3.Connection) -> None:
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.Error as exc:
        logger.debug("SBG: write-ahead log checkpoint skipped: %s", exc)

def init_db():
    global _db_version, _meta_epoch
    with connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        # Every older release makes idx_root_mtime at its start and this one drops
        # it below, so finding it means an older version ran since, writing rows
        # with no search index entries, and the search index is built again.
        older_ran = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_root_mtime'").fetchone() is not None
        # Cleared before the drop below commits, so a start cut short between the
        # two still builds the index again on the next.
        if older_ran:
            try:
                conn.execute("DELETE FROM sbg_meta WHERE key = ?", (_FACTS_STAMP_KEY,))
                conn.commit()
            except sqlite3.OperationalError:
                pass
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
            CREATE TABLE IF NOT EXISTS sbg_meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS paths (
                path_id INTEGER PRIMARY KEY,
                path    TEXT UNIQUE
            );
            CREATE TABLE IF NOT EXISTS vals (
                val_id INTEGER PRIMARY KEY,
                text   TEXT UNIQUE
            );
            CREATE TABLE IF NOT EXISTS facts (
                file_id INTEGER,
                path_id INTEGER,
                ord     INTEGER,
                val_id  INTEGER,
                num     REAL
            );
            CREATE TABLE IF NOT EXISTS prose (
                file_id INTEGER,
                path_id INTEGER,
                ord     INTEGER,
                body    TEXT
            );
            CREATE TABLE IF NOT EXISTS node_names (
                file_id INTEGER,
                ord     INTEGER,
                display TEXT,
                PRIMARY KEY (file_id, ord)
            ) WITHOUT ROWID;
            CREATE TRIGGER IF NOT EXISTS trg_facts_on_delete
                AFTER DELETE ON media_files BEGIN
                    DELETE FROM facts WHERE file_id = OLD.rowid;
                    DELETE FROM prose WHERE file_id = OLD.rowid;
                    DELETE FROM node_names WHERE file_id = OLD.rowid;
                END;
            DROP INDEX IF EXISTS idx_root_mtime;
            DROP INDEX IF EXISTS idx_root_subfolder;
            DROP INDEX IF EXISTS idx_root_ctime;
        """)
        # An index from an older release has no missing_since, and a read of
        # the column is how that shows.
        try:
            conn.execute("SELECT missing_since FROM media_files LIMIT 1")
        except sqlite3.OperationalError:
            conn.execute("ALTER TABLE media_files ADD COLUMN missing_since REAL")
            conn.commit()
        conn.execute("CREATE INDEX IF NOT EXISTS idx_root_present "
                     "ON media_files(root_id, ctime DESC) WHERE missing_since IS NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_root_present_subfolder "
                     "ON media_files(root_id, subfolder) WHERE missing_since IS NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_root_present_meta "
                     "ON media_files(root_id, meta_mtime) WHERE missing_since IS NULL")
        # Normally empty. Every scan reads the root's hidden rows, which the
        # present-row indexes cannot answer, so without this each scan reads
        # every row of the root.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_root_hidden "
                     "ON media_files(root_id, missing_since) WHERE missing_since IS NOT NULL")
        conn.executescript(_FACTS_INDEX_SQL)
        conn.commit()
        # Losing the counters only sends open pages back for their lists, while
        # an init_db that raised would fail the whole extension at start. Each
        # is read on its own, so one edited by hand into something that is not a
        # number costs only itself, and the next write casts it back to one.
        unread = (sqlite3.Error, ValueError, TypeError)
        try:
            row = conn.execute("SELECT value FROM sbg_meta WHERE key = 'db_version'").fetchone()
            if row and row["value"] is not None:
                with _versions_lock:
                    _db_version = int(row["value"])
            # An index older than per-root counters gives each root the global
            # count, the version a page already holding its rows was given.
            conn.execute(
                "INSERT OR IGNORE INTO sbg_meta(key, value) "
                "SELECT DISTINCT 'root_version:' || root_id, ? FROM media_files",
                (str(_db_version),),
            )
            conn.commit()
        except unread as exc:
            logger.warning("SBG: the index's stored version could not be read, "
                           "so open pages fetch their lists again: %s", exc)
        try:
            # The record of deletions went with the last process, so a poll
            # holding a version older than this must fetch the list again.
            rows = conn.execute(
                "SELECT substr(key, 14) AS rid, value FROM sbg_meta "
                "WHERE key LIKE 'root_version:%'").fetchall()
            with _removals_lock:
                for r in rows:
                    if not r["rid"]:
                        continue
                    try:
                        _removals_floor[r["rid"]] = int(r["value"])
                    except (ValueError, TypeError):
                        pass
        except sqlite3.Error as exc:
            logger.warning("SBG: the index's folder versions could not be read, "
                           "so open pages fetch their lists again: %s", exc)
        try:
            row = conn.execute("SELECT value FROM sbg_meta WHERE key = 'meta_epoch'").fetchone()
            if row and row["value"] is not None:
                with _versions_lock:
                    _meta_epoch = int(row["value"])
        except unread as exc:
            logger.warning("SBG: the index's metadata epoch could not be read: %s", exc)

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
    # Binding such a name raises, which would roll back every row written in
    # the same transaction, so the check stands here even where a caller made
    # it first.
    if not storable_name(relpath):
        logger.warning("SBG: %r is left out of the index, since its name is not valid "
                       "UTF-8 and cannot be stored", relpath)
        return
    filename = os.path.basename(relpath)
    subfolder = os.path.dirname(relpath).replace("\\", "/")
    # An unchanged row is left untouched, so rowcount counts only a real change
    # and the version moves only for one. meta_mtime stays out of the comparison
    # since every call stamps it with the current time.
    cur = conn.execute(
        """INSERT INTO media_files
               (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime, metadata_json, meta_mtime)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(root_id, relpath) DO UPDATE SET
               filename=excluded.filename, subfolder=excluded.subfolder,
               ext=excluded.ext, kind=excluded.kind,
               size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime,
               metadata_json=COALESCE(excluded.metadata_json, media_files.metadata_json),
               meta_mtime=excluded.meta_mtime
           WHERE excluded.filename IS NOT media_files.filename
              OR excluded.subfolder IS NOT media_files.subfolder
              OR excluded.ext IS NOT media_files.ext
              OR excluded.kind IS NOT media_files.kind
              OR excluded.size IS NOT media_files.size
              OR excluded.mtime IS NOT media_files.mtime
              OR excluded.ctime IS NOT media_files.ctime
              OR (excluded.metadata_json IS NOT NULL
                  AND excluded.metadata_json IS NOT media_files.metadata_json)""",
        (root_id, relpath, filename, subfolder, ext, kind, size, mtime, ctime, metadata_json, time.time()),
    )
    if cur.rowcount:
        _bump_version(conn, root_id)
    if cur.rowcount and metadata_json is not None:
        row = conn.execute(
            "SELECT rowid FROM media_files WHERE root_id = ? AND relpath = ?",
            (root_id, relpath)).fetchone()
        _refresh_file_facts(conn, row[0], json.loads(metadata_json))

# Bump whenever what `_refresh_file_facts` writes changes, since the stamp kept
# beside the search index is what declares it current.
FACTS_VERSION = 6
_FACTS_STAMP_KEY = "facts_version"

def facts_ready() -> bool:
    return get_meta_value(_FACTS_STAMP_KEY) == str(FACTS_VERSION)

@contextmanager
def facts_snapshot() -> Iterator[sqlite3.Connection | None]:
    """A connection whose reads share one snapshot, or None when that snapshot
    holds no complete search index. The stamp is read in the same transaction
    as the search, so a search index build starting meanwhile cannot pass off
    part of the index as all of it."""
    with connect() as conn:
        conn.execute("BEGIN")
        row = conn.execute("SELECT value FROM sbg_meta WHERE key = ?", (_FACTS_STAMP_KEY,)).fetchone()
        yield conn if row is not None and row["value"] == str(FACTS_VERSION) else None

# Any code that runs VACUUM on this database calls this first. A fact keys on
# media_files' implicit rowid, which VACUUM renumbers, so afterwards every fact
# would name a different file while the stamp still read complete.
def invalidate_facts_index() -> None:
    with connect() as conn:
        conn.execute("DELETE FROM sbg_meta WHERE key = ?", (_FACTS_STAMP_KEY,))

def _refresh_file_facts(conn: sqlite3.Connection, file_id: int, summary: dict,
                        path_ids: dict | None = None, val_ids: dict | None = None) -> None:
    conn.execute("DELETE FROM facts WHERE file_id = ?", (file_id,))
    conn.execute("DELETE FROM prose WHERE file_id = ?", (file_id,))
    conn.execute("DELETE FROM node_names WHERE file_id = ?", (file_id,))
    prose_roots = prose_paths()
    threshold = prose_length_threshold()

    def _path_id(p: str) -> int:
        pid = path_ids.get(p) if path_ids is not None else None
        if pid is None:
            stored = storable(p)
            conn.execute("INSERT OR IGNORE INTO paths(path) VALUES (?)", (stored,))
            pid = conn.execute("SELECT path_id FROM paths WHERE path = ?", (stored,)).fetchone()[0]
            if path_ids is not None:
                path_ids[p] = pid
        return pid

    def _val_id(t: str) -> int:
        vid = val_ids.get(t) if val_ids is not None else None
        if vid is None:
            stored = storable(t)
            conn.execute("INSERT OR IGNORE INTO vals(text) VALUES (?)", (stored,))
            vid = conn.execute("SELECT val_id FROM vals WHERE text = ?", (stored,)).fetchone()[0]
            if val_ids is not None:
                val_ids[t] = vid
        return vid

    frows, prows = [], []
    for path, ord_, value in summary_rows(summary):
        # Folded by Python as the matcher folds, since SQLite's lower() folds
        # ASCII alone. Nothing shows a stored value, so its spelling is not kept.
        text = str(value).lower()
        if path.split(".", 1)[0] in prose_roots or len(text) > threshold:
            prows.append((file_id, _path_id(path), ord_, storable(text)))
            continue
        num = value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
        # sqlite3 refuses an int past 64 bits, as an unsigned seed can be, and
        # the column is REAL, so it goes in as the float it would have become.
        if isinstance(num, int) and not -(1 << 63) <= num < (1 << 63):
            num = float(num)
        frows.append((file_id, _path_id(path), ord_, _val_id(text), num))
    if frows:
        conn.executemany(
            "INSERT INTO facts(file_id, path_id, ord, val_id, num) VALUES (?, ?, ?, ?, ?)",
            frows)
    if prows:
        conn.executemany(
            "INSERT INTO prose(file_id, path_id, ord, body) VALUES (?, ?, ?, ?)",
            prows)
    nodes = summary.get("workflow_nodes")
    if isinstance(nodes, list):
        nrows = [(file_id, o, storable(str(node.get("title") or node.get("class_type") or "Node")))
                 for o, node in enumerate(nodes) if isinstance(node, dict)]
        if nrows:
            conn.executemany(
                "INSERT OR REPLACE INTO node_names(file_id, ord, display) VALUES (?, ?, ?)",
                nrows)

# What one file's values can raise on the way into a row. A locked or read-only
# database raises OperationalError, which is left out so it stops the whole pass
# instead of being logged for every file.
_ONE_FILE_ERRORS = (sqlite3.DataError, sqlite3.IntegrityError, ValueError, OverflowError, TypeError)

_FACTS_INDEX_SQL = """
    CREATE INDEX IF NOT EXISTS idx_facts_pv ON facts(path_id, val_id);
    CREATE INDEX IF NOT EXISTS idx_facts_v  ON facts(val_id);
    CREATE INDEX IF NOT EXISTS idx_facts_f  ON facts(file_id);
    CREATE INDEX IF NOT EXISTS idx_prose_f  ON prose(file_id);
    CREATE INDEX IF NOT EXISTS idx_prose_p  ON prose(path_id);
"""

# How many files a search index build indexes under one hold of the write lock,
# which is how long a delete or a new file arriving meanwhile waits.
_FACTS_BATCH = 500

def rebuild_facts_index(cancel_event: threading.Event | None = None) -> dict:
    with connect() as conn:
        try:
            conn.execute("DELETE FROM sbg_meta WHERE key = ?", (_FACTS_STAMP_KEY,))
            conn.commit()
            # idx_facts_f and idx_prose_f stay, since each batch below, and a
            # delete or a new file arriving meanwhile, clears a file's rows by id
            # while holding the write lock.
            conn.executescript("""
                DROP INDEX IF EXISTS idx_facts_pv;
                DROP INDEX IF EXISTS idx_facts_v;
                DROP INDEX IF EXISTS idx_prose_p;
                DELETE FROM facts; DELETE FROM prose;
                DELETE FROM node_names;
                DELETE FROM vals; DELETE FROM paths;
            """)
            conn.commit()
            path_ids: dict = {}
            val_ids: dict = {}
            last = 0
            t0 = time.perf_counter()
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    return {"complete": False, "reason": "cancelled"}
                # The write lock is taken before the batch is read, so no row can
                # change or go between its read and the facts written for it. A
                # row changed or added once its batch is done writes its own
                # facts, and one deleted takes them with it.
                conn.execute("BEGIN IMMEDIATE")
                rows = conn.execute(
                    "SELECT rowid, metadata_json FROM media_files "
                    "WHERE rowid > ? AND metadata_json IS NOT NULL ORDER BY rowid LIMIT ?",
                    (last, _FACTS_BATCH)).fetchall()
                if not rows:
                    conn.commit()
                    break
                for file_id, mj in rows:
                    try:
                        summary = json.loads(mj)
                    except Exception:
                        continue
                    if isinstance(summary, dict):
                        try:
                            _refresh_file_facts(conn, file_id, summary, path_ids, val_ids)
                        except _ONE_FILE_ERRORS as exc:
                            logger.warning("Search index skipped file %s: %s", file_id, exc)
                last = rows[-1][0]
                conn.commit()
            conn.executescript(_FACTS_INDEX_SQL)
            conn.execute("ANALYZE")
            conn.execute("INSERT OR REPLACE INTO sbg_meta(key, value) VALUES (?, ?)",
                         (_FACTS_STAMP_KEY, str(FACTS_VERSION)))
            conn.commit()
            _checkpoint_wal(conn)
            n_facts = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
            n_paths = conn.execute("SELECT COUNT(*) FROM paths").fetchone()[0]
            return {"complete": True, "facts": n_facts, "paths": n_paths,
                    "seconds": time.perf_counter() - t0}
        finally:
            # A cancel or a failure puts back the indexes dropped at the top.
            # Creating them commits, so what a failed pass left uncommitted is
            # rolled back first.
            try:
                conn.rollback()
                conn.executescript(_FACTS_INDEX_SQL)
                conn.commit()
            except sqlite3.Error as exc:
                logger.warning("Search index indexes not restored: %s", exc)

def facts_rebuild_run(token: int, cancel_event: threading.Event | None = None) -> dict:
    try:
        result = rebuild_facts_index(cancel_event=cancel_event)
        if result.get("complete"):
            release_full_reindex(token)
        else:
            release_full_reindex(token, "error", "cancelled")
        return result
    except Exception as exc:
        release_full_reindex(token, "error", str(exc))
        raise

def get_rows_since(root_id: str, since: float) -> list[dict]:
    # Selected on meta_mtime, the time this server wrote the row, instead of the
    # file's own time, so a file copied in with an older timestamp still reaches
    # a browser whose cursor is past it.
    # The index is named because ordering on ctime and filtering on meta_mtime
    # cannot come from one index, and the planner can choose the sort and read
    # every present row for a range that almost always matches none.
    with connect() as conn:
        rows = conn.execute(
            """SELECT root_id, relpath, filename, subfolder, ext, kind,
                      size, mtime, ctime,
                      json_extract(metadata_json, '$.width') as w,
                      json_extract(metadata_json, '$.height') as h
               FROM media_files INDEXED BY idx_root_present_meta
               WHERE root_id = ? AND meta_mtime > ? AND missing_since IS NULL
               ORDER BY ctime DESC, relpath DESC""",
            (root_id, since),
        ).fetchall()
    return [dict(r) for r in rows]

def get_all_with_version(root_id: str) -> tuple[int, list[dict]]:
    # One transaction, so the version a page stores describes the rows it came with.
    with connect() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN")
        try:
            row = conn.execute(
                "SELECT value FROM sbg_meta WHERE key = ?",
                (root_meta_key("root_version", root_id),),
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
                   WHERE root_id = ? AND missing_since IS NULL
                   ORDER BY ctime DESC, relpath DESC""",
                (root_id,),
            ).fetchall()
        finally:
            conn.execute("COMMIT")
    return version, [dict(r) for r in rows]

def mark_meta_attempted(root_id: str, relpath: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE media_files SET meta_mtime = ? "
            "WHERE root_id = ? AND relpath = ? AND metadata_json IS NULL",
            (time.time(), root_id, relpath),
        )

def get_all_with_metadata(root_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT root_id, relpath, metadata_json
               FROM media_files
               WHERE root_id = ? AND missing_since IS NULL""",
            (root_id,),
        ).fetchall()
    return [dict(r) for r in rows]

# SQLite builds before 3.32 bind at most 999 variables per statement, so a long
# list of relpaths is asked for in chunks below that.
_IN_CHUNK = 900

def get_items_with_metadata(root_id: str, relpaths: list[str]) -> list[dict]:
    if not relpaths:
        return []
    out: list[dict] = []
    with connect() as conn:
        for start in range(0, len(relpaths), _IN_CHUNK):
            chunk = relpaths[start:start + _IN_CHUNK]
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"""SELECT root_id, relpath, metadata_json
                   FROM media_files
                   WHERE root_id = ? AND missing_since IS NULL
                         AND relpath IN ({placeholders})""",
                [root_id] + chunk,
            ).fetchall()
            out.extend(dict(r) for r in rows)
    return out

def get_file(root_id: str, relpath: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            """SELECT root_id, relpath, filename, subfolder, ext, kind,
                      size, mtime, ctime, metadata_json, meta_mtime, missing_since
               FROM media_files
               WHERE root_id = ? AND relpath = ?""",
            (root_id, relpath),
        ).fetchone()
    return dict(row) if row else None

def get_subfolders(root_id: str) -> list[str]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT DISTINCT subfolder FROM media_files
               WHERE root_id = ? AND subfolder != '' AND missing_since IS NULL
               ORDER BY subfolder""",
            (root_id,),
        ).fetchall()
    return [r["subfolder"] for r in rows]

def get_count(root_id: str) -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM media_files "
            "WHERE root_id = ? AND missing_since IS NULL",
            (root_id,),
        ).fetchone()
    return row["cnt"] if row else 0

def get_hidden_count() -> int:
    with connect() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM media_files WHERE missing_since IS NOT NULL"
        ).fetchone()[0]

def get_kind_counts() -> dict[str, int]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT kind, COUNT(*) AS cnt FROM media_files "
            "WHERE missing_since IS NULL GROUP BY kind"
        ).fetchall()
    return {r["kind"]: r["cnt"] for r in rows}

def get_last_scan(root_id: str) -> float | None:
    raw = get_meta_value(root_meta_key("last_scan", root_id))
    try:
        return float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None

def delete_file(conn: sqlite3.Connection, root_id: str, relpath: str) -> bool:
    # The caller announces the deletion through record_removals once it has
    # committed.
    cur = conn.execute(
        "DELETE FROM media_files WHERE root_id = ? AND relpath = ?",
        (root_id, relpath),
    )
    if cur.rowcount:
        _bump_version(conn, root_id)
        return True
    return False

# Which relpaths vanished since a given version, so the delta can name them
# instead of sending the page back for the whole list. It lives in this process
# only, so after a restart a poll holding an older version fetches the list
# again. The floor is the oldest root version the record still covers.
_REMOVALS_MAX = 500
_removals_lock = threading.Lock()
_recent_removals: dict[str, deque] = {}
_removals_floor: dict[str, int] = {}

def record_removals(root_id: str, relpaths: list[str], complete_since: int) -> None:
    if not relpaths:
        return
    try:
        with connect() as conn:
            # The bump, the commit and the record are one step under the lock. A
            # poll can read the bumped version without the lock and then waits
            # on this lock in get_removals_since, so it cannot be told nothing was
            # removed and store a version whose removal is about to be recorded.
            with _removals_lock:
                _bump_version(conn, root_id)
                conn.commit()
                row = conn.execute(
                    "SELECT value FROM sbg_meta WHERE key = ?",
                    (root_meta_key("root_version", root_id),),
                ).fetchone()
                ver = int(row[0]) if row else 0
                dq = _recent_removals.get(root_id)
                if dq is None:
                    dq = deque(maxlen=_REMOVALS_MAX)
                    _recent_removals[root_id] = dq
                    _removals_floor.setdefault(root_id, complete_since)
                for rp in relpaths:
                    if len(dq) == dq.maxlen:
                        # The floor never falls, or a poll could be told nothing
                        # was removed when the entries saying so were pushed out.
                        _removals_floor[root_id] = max(
                            _removals_floor.get(root_id, 0), dq[0][0])
                    dq.append((ver, rp))
    except Exception as e:
        logger.warning(
            "SBG: could not announce %d deletion(s) for %s (%s), so clients "
            "reconcile on their next consistency check", len(relpaths), root_id, e,
        )

def get_removals_since(root_id: str, since_version: int) -> list[str] | None:
    # None says the record no longer reaches back to that version, so the caller
    # cannot bring its list up to date from deletions alone.
    current = get_root_version(root_id)
    with _removals_lock:
        # Startup gave every root with rows a floor, so this only fires for one
        # first indexed in this process, where nothing can have been missed.
        _removals_floor.setdefault(root_id, current)
        if since_version < _removals_floor[root_id]:
            return None
        dq = _recent_removals.get(root_id)
        if not dq:
            return []
        return [rp for (v, rp) in dq if v > since_version]

class PathTooLong(OSError):
    """The path is at or past what this install can address, so whether the file
    is still there cannot be told."""

def _unreachable_reason(full: str) -> str | None:
    """None when the path names a regular file, otherwise why not. Windows
    without long path support answers a path at its length limit as missing,
    so "too long" tells a file this install cannot reach from a deleted one."""
    if os.path.isfile(full):
        return None
    if os.path.lexists(full):
        return "not a file"
    if os.name == "nt" and len(full) >= recycle.MAX_PATH:
        return "too long"
    return "gone"

def _move_back(src: str, dst: str) -> None:
    """Moves a file to a name that must still be free, raising FileExistsError
    when another file has taken it. A check before an overwriting move would
    leave a moment in which a new file there is lost."""
    if os.name == "nt":
        os.rename(src, dst)
        return
    try:
        os.link(src, dst, follow_symlinks=False)
    except FileExistsError:
        raise
    except OSError:
        # A filesystem without hard links keeps the check before the move.
        if os.path.lexists(dst):
            raise FileExistsError(dst)
        os.replace(src, dst)
        return
    os.unlink(src)

class FileChanged(OSError):
    """The file at the path is no longer the one the asking card showed."""

def trash_file(root_path: str, root_id: str, relpath: str,
               expect_mtime: float | None = None, expect_size: float | None = None) -> tuple[str, str | None]:
    rel_norm = relpath.replace("\\", "/") if isinstance(relpath, str) else ""
    if not rel_norm or any(seg.lower() == recycle.TRASH_DIR_NAME for seg in rel_norm.split("/")):
        raise ValueError("Invalid path")
    if os.path.splitext(rel_norm)[1].lower() not in ALL_MEDIA_EXTS:
        raise ValueError("Not a media file")
    full = safe_join(root_path, rel_norm)
    trash_dir = safe_join(root_path, recycle.TRASH_DIR_NAME)
    # The name check above misses a link that lands inside the trash folder.
    if _resolves_inside(full, trash_dir):
        raise ValueError("Invalid path")
    # Only a file the index holds may be removed, so a request cannot reach a
    # path the gallery never listed.
    with connect() as conn:
        row = conn.execute(
            "SELECT missing_since FROM media_files WHERE root_id = ? AND relpath = ?",
            (root_id, rel_norm)).fetchone()
    indexed = row is not None
    hidden = indexed and row["missing_since"] is not None
    # A card painted before the poll that hid its row can still ask, and the
    # file may sit in a folder the user excluded, so a hidden row is refused
    # before anything moves.
    if hidden:
        if os.path.isfile(full):
            raise LookupError(rel_norm)
        raise FileNotFoundError(rel_norm)

    reason = _unreachable_reason(full)
    if not indexed:
        if reason == "too long":
            raise PathTooLong(rel_norm)
        if reason is not None:
            raise FileNotFoundError(rel_norm)
        raise LookupError(rel_norm)
    if reason == "too long":
        # The row stays, since the file may well be there.
        raise PathTooLong(rel_norm)
    # Read before anything moves, so an index that cannot be read fails the
    # delete before the file goes.
    v_before = get_root_version(root_id)
    if reason is not None:
        # The file went behind the index's back, so its row goes and the removal
        # is announced now, which takes the card off every open page instead of
        # only the one that asked.
        with connect() as conn:
            dropped = delete_file(conn, root_id, rel_norm)
        if dropped:
            record_removals(root_id, [rel_norm], v_before)
        raise FileNotFoundError(rel_norm)
    # ComfyUI gives a new generation the name a deleted one left, so a card
    # drawn before that, as in another tab, names the file it showed.
    if expect_mtime is not None or expect_size is not None:
        st = os.stat(full)
        # A file with no modified time is listed by its creation time instead,
        # so only its size can be compared.
        if ((expect_size is not None and st.st_size != expect_size)
                or (expect_mtime is not None and st.st_mtime and abs(st.st_mtime - expect_mtime) > 1.0)):
            raise FileChanged(rel_norm)

    try:
        recycle.send_to_bin(full)
    except recycle.RecycleUnavailable as why:
        logger.info("SBG: %s goes to the gallery's trash folder, since %s", rel_norm, why)
    else:
        try:
            with connect() as conn:
                delete_file(conn, root_id, rel_norm)
        except sqlite3.Error as e:
            logger.warning("SBG: %s is in the bin but its row could not be dropped (%s), "
                           "and the next scan reconciles it", rel_norm, e)
        record_removals(root_id, [rel_norm], v_before)
        return "bin", None

    # Each failure below reaches the person as one plain clause, and the
    # system's own words for it go to the log.
    wanted = safe_join(root_path, f"{recycle.TRASH_DIR_NAME}/{rel_norm}")
    try:
        os.makedirs(os.path.dirname(wanted), exist_ok=True)
        dest = recycle.claim_free_name(wanted)
    except OSError as e:
        logger.warning("SBG: the trash folder for %s could not be prepared: %s", rel_norm, e)
        raise OSError("the gallery's trash folder could not be prepared") from e
    try:
        os.replace(full, dest)
    except OSError as e:
        # dest is the empty file claimed above, so removing it and the folders
        # made for it cannot take anything of the user's.
        try:
            os.remove(dest)
        except OSError:
            pass
        _prune_empty_dirs(os.path.dirname(dest), trash_dir)
        logger.warning("SBG: %s could not move to the gallery's trash folder: %s", rel_norm, e)
        if e.errno == errno.EXDEV:
            raise OSError(
                "the file sits on a different disk or volume from its gallery "
                "folder, so it cannot move into that folder's trash") from e
        if getattr(e, "winerror", None) == 32:
            raise OSError(recycle.FILE_IN_USE) from e
        raise OSError("the file could not be moved to the gallery's trash folder") from e

    try:
        with connect() as conn:
            removed = delete_file(conn, root_id, rel_norm)
    except sqlite3.Error as e:
        logger.warning("SBG: the index could not drop %s: %s", rel_norm, e)
        try:
            _move_back(dest, full)
        except FileExistsError:
            # A generation can take the name while the index write waits, so the
            # moved file stays where it is and the user keeps both.
            logger.error("SBG: %s moved to %s but its row stayed, and a new file now "
                         "holds the original name, so it was left in the gallery's "
                         "trash folder", rel_norm, dest)
            raise OSError(
                "a new file took its name while it moved, so the deleted file is in "
                "the gallery's trash folder and the new one stays") from e
        except OSError as back:
            logger.error("SBG: %s moved to %s but its row stayed and the move back "
                         "failed (%s), and the next scan reconciles it", rel_norm, dest, back)
            raise OSError(
                "the gallery's index could not be updated, and the file was left in "
                "the gallery's trash folder") from e
        _prune_empty_dirs(os.path.dirname(dest), trash_dir)
        raise OSError(
            "the gallery's index could not be updated, so the file was put back") from e
    if removed:
        record_removals(root_id, [rel_norm], v_before)
    return "folder", os.path.relpath(dest, root_path).replace("\\", "/")

def _resolves_inside(path: str, folder: str) -> bool:
    try:
        real_path = os.path.realpath(path)
        real_folder = os.path.realpath(folder)
        return os.path.commonpath([real_path, real_folder]) == real_folder
    except (OSError, ValueError):
        # A path that cannot be resolved counts as outside so the move can go
        # on, with the name check and the index check still guarding it.
        return False

def _prune_empty_dirs(start: str, stop: str) -> None:
    cur = os.path.normpath(start)
    stop = os.path.normpath(stop)
    try:
        inside = os.path.commonpath([os.path.normcase(cur), os.path.normcase(stop)]) == os.path.normcase(stop)
    except ValueError:
        inside = False
    if not inside:
        return
    while True:
        try:
            os.rmdir(cur)
        except OSError:
            return
        if os.path.normcase(cur) == os.path.normcase(stop):
            return
        parent = os.path.dirname(cur)
        if not parent or parent == cur:
            return
        cur = parent

def delete_root_rows(root_id: str) -> int:
    with connect() as conn:
        cur = conn.execute("DELETE FROM media_files WHERE root_id = ?", (root_id,))
        n = cur.rowcount
        if n:
            _bump_version(conn, root_id)
        suffix = f":{root_id}"
        # A negative start makes substr count back from the end of the key.
        conn.execute("DELETE FROM sbg_meta WHERE substr(key, ?) = ?", (-len(suffix), suffix))
    with _mtimes_cache_lock:
        _mtimes_cache.pop(root_id, None)
    with _removals_lock:
        # A root added again starts its counter at zero, so a record left behind
        # would replay the old root's deletions.
        _recent_removals.pop(root_id, None)
        _removals_floor.pop(root_id, None)
    return n

@dataclass
class ScanResult:
    total: int = 0
    changed: int = 0
    added: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    # False when the scan was cancelled or could not read the root itself. A
    # deeper folder it could not read leaves it complete, or the root would
    # never count as indexed and every scan of it would show as a first index.
    complete: bool = True

class _WalkRecord:
    __slots__ = ("dir_errors", "unknown", "skipped_links", "unstorable", "folded",
                 "listed_dirs", "seen_dirs")

    def __init__(self):
        self.dir_errors = 0
        # Relpaths of entries a listing returned whose attributes could not be
        # read, so neither they nor anything under them is decided by this walk.
        self.unknown: set[str] = set()
        self.skipped_links: list[str] = []
        self.unstorable: list[str] = []
        # Folders whose name the OS opens as another folder's, so their own
        # files cannot be read.
        self.folded: list[str] = []
        # Folders whose contents the walk read, the root as "". A folder whose
        # own listing failed is absent, which tells a file that is gone from one
        # the walk never got to look for.
        self.listed_dirs: set[str] = set()
        # Folders the walk met as an entry, read or not. A deleted folder is in
        # neither set and an unreadable one only in this one. A link is left out,
        # since the walk never reads through one and no rows sit beneath it.
        self.seen_dirs: set[str] = set()

# A whole-library rebuild and a search index rebuild hold their progress entry
# under this key, and a folder's first index holds one under its root id.
_FULL_KEY = "__full__"
_scan_progress: dict[str, dict] = {}
_scan_progress_lock = threading.Lock()
_progress_token = 0
# The token starts again with each server process, so a run is named by this
# stamp and its token together.
_PROCESS_STAMP = f"{os.getpid()}-{time.time_ns()}"

_progress_listener = None

# Set by the layer that pushes progress to pages, which this module must not
# import.
def set_progress_listener(fn) -> None:
    global _progress_listener
    _progress_listener = fn

def _notify_progress(final: bool = False) -> None:
    fn = _progress_listener
    if fn is None:
        return
    try:
        fn(final)
    except Exception:
        logger.debug("SBG: progress listener failed", exc_info=True)

def _fresh_entry(kind: str, root_id: str | None, token: int) -> dict:
    """Every field an entry has. `kind` is first for a folder's first index,
    full for a rebuild and facts for a search index build, and `root_id` is
    the folder being read, which a search index build has none of."""
    return {"running": True, "kind": kind, "root_id": root_id, "total": 0, "done": 0,
            "phase": "scanning", "error": None, "_token": token}

def begin_progress(key: str, root_id: str | None = None) -> int:
    global _progress_token
    with _scan_progress_lock:
        _progress_token += 1
        token = _progress_token
        _scan_progress[key] = _fresh_entry("full" if key == _FULL_KEY else "first", root_id or key, token)
    # Every notify runs outside the lock, since the listener reads the progress
    # back through get_progress, which takes it.
    _notify_progress()
    return token

def update_progress(key: str, token: int, *, root_id: str | None = None, total: int | None = None,
                    done: int | None = None, phase: str | None = None) -> None:
    """These four are all a run may change, so an entry never grows a field no
    page reads."""
    fields = {k: v for k, v in (("root_id", root_id), ("total", total), ("done", done), ("phase", phase))
              if v is not None}
    with _scan_progress_lock:
        entry = _scan_progress.get(key)
        if entry is None or entry.get("_token") != token:
            return
        entry.update(fields)
    _notify_progress()

def end_progress(key: str, token: int, phase: str, error: str | None = None) -> None:
    with _scan_progress_lock:
        entry = _scan_progress.get(key)
        if entry is None or entry.get("_token") != token:
            return
        entry.update({"running": False, "phase": phase, "error": error})
    _notify_progress(final=True)

def claim_full_reindex(kind: str = "full") -> int | None:
    """None when a first index, a rebuild or a search index build is running. A
    poll's scan reports no progress and is not seen here, so a caller checks
    its own running scans as well. `kind` is full for a rebuild and facts for
    a search index build, which share the one slot."""
    global _progress_token
    with _scan_progress_lock:
        if any(e.get("running") for e in _scan_progress.values()):
            return None
        _progress_token += 1
        token = _progress_token
        _scan_progress[_FULL_KEY] = _fresh_entry(kind, None, token)
    _notify_progress()
    return token

def release_full_reindex(token: int, phase: str = "done", error: str | None = None) -> None:
    end_progress(_FULL_KEY, token, phase, error)

def is_full_reindex_running() -> bool:
    """Whether a whole-library rebuild is running, which rewrites rows a scan
    would race. A search index build holds the same slot and writes no such
    row, so scans, polls and purges go on during one."""
    with _scan_progress_lock:
        entry = _scan_progress.get(_FULL_KEY)
        return bool(entry and entry.get("running") and entry.get("kind") == "full")

def any_scan_running() -> bool:
    with _scan_progress_lock:
        return any(e.get("running") for e in _scan_progress.values())

def _public_entry(e: dict) -> dict:
    out = {kk: vv for kk, vv in e.items() if kk != "_token"}
    out["run"] = e.get("_token")
    return out

def get_progress() -> dict:
    with _scan_progress_lock:
        full = _scan_progress.get(_FULL_KEY)
        roots = {k: _public_entry(e) for k, e in _scan_progress.items() if k != _FULL_KEY}
        return {
            "running": bool(full and full.get("running")),
            "full": _public_entry(full) if full else None,
            "roots": roots,
            "process": _PROCESS_STAMP,
        }

def _dir_excluded(name: str, excluded: set[str], skip_hidden: bool) -> bool:
    # Ahead of the hidden-folder setting, or turning that on would bring
    # deleted files back as cards.
    if _is_bin_folder(name):
        return True
    return (skip_hidden and name.startswith(".")) or name.lower() in excluded

def _is_bin_folder(name: str) -> bool:
    low = name.lower()
    return (low == recycle.TRASH_DIR_NAME or low == "$recycle.bin" or low == ".trashes"
            or low == ".trash" or low.startswith(".trash-"))

def path_excluded(relpath: str, excluded: set[str], skip_hidden: bool) -> bool:
    """Whether a folder on a stored row's path is one the walk skips. Such a
    folder is never listed, so without this its rows would stay undecided for
    good instead of leaving with it."""
    return any(_dir_excluded(seg, excluded, skip_hidden)
               for seg in relpath.split("/")[:-1])

def _link_worth_naming(entry) -> bool:
    try:
        if entry.is_dir(follow_symlinks=True):
            return True
    except OSError:
        return False
    return os.path.splitext(entry.name)[1].lower() in ALL_MEDIA_EXTS

def _warn_left_out(rid: str, walk: _WalkRecord) -> None:
    for names, show, message in (
        (walk.skipped_links, str,
         "SBG: %s has %d linked entr(y/ies) that are not indexed (%s%s). Add the "
         "folder each link points at as its own gallery folder to index it."),
        (walk.unstorable, repr,
         "SBG: %s has %d entr(y/ies) left out of the index, since their names are not "
         "valid UTF-8 and cannot be stored (%s%s)"),
        (walk.folded, str,
         "SBG: %s has %d folder(s) that are not indexed (%s%s), since Windows opens a "
         "folder whose name ends in a dot or a space as the folder without it. Rename "
         "the folder to index it."),
    ):
        if names:
            more = "" if len(names) <= 5 else f" and {len(names) - 5} more"
            logger.warning(message, rid, len(names), ", ".join(show(n) for n in names[:5]), more)

def storable_name(name: str) -> bool:
    # A name the OS hands back can carry unpaired surrogates, which SQLite
    # cannot store, and encoding it is how they show.
    try:
        name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False

def _file_is_really_there(base_abs: str, rel: str, listings: dict[str, set[str]]) -> bool:
    """Whether a stored path still names a file the walk would have taken.
    os.path.isfile follows a link and folds letter case on Windows and macOS,
    so this asks what the walk asks: no link, and the exact name in its
    folder's listing. `listings` keeps each folder's names for the caller's
    whole pass."""
    full = os.path.join(base_abs, rel.replace("/", os.sep))
    try:
        st = os.lstat(full)
    except OSError:
        return False
    # S_ISREG on lstat already rules out a link and a folder. The walk reads a
    # reparse tag only for a folder, so none is read here, or a file tagged by a
    # cloud-backed folder that the walk indexes would be rejected.
    if not stat.S_ISREG(st.st_mode):
        return False
    parent = os.path.dirname(full) or base_abs
    if parent not in listings:
        try:
            with os.scandir(parent) as it:
                listings[parent] = {e.name for e in it}
        except OSError:
            listings[parent] = set()
    return rel.rsplit("/", 1)[-1] in listings[parent]

def clear_missing_mark(conn: sqlite3.Connection, root_id: str, relpath: str) -> bool:
    # meta_mtime moves so the delta carries the row back.
    cur = conn.execute(
        "UPDATE media_files SET missing_since = NULL, meta_mtime = ? "
        "WHERE root_id = ? AND relpath = ? AND missing_since IS NOT NULL",
        (time.time(), root_id, relpath))
    if cur.rowcount:
        _bump_version(conn, root_id)
        return True
    return False

def _row_is_absent(rel, disk_files, listed_dirs, seen_dirs, excluded, skip_hidden,
                   unknown: AbstractSet[str] = frozenset()) -> bool:
    """Whether this walk decided the row's file is gone, which it did when a
    folder on the row's path was listed and did not hold the next folder or the
    file itself. A row under a skipped folder is gone, and one that is an
    unknown entry or sits under one is left alone."""
    if path_excluded(rel, excluded, skip_hidden):
        return True
    if rel in unknown or any(rel.startswith(u + "/") for u in unknown):
        return False
    parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
    prefix = ""
    for seg in (parent.split("/") if parent else []):
        nxt = f"{prefix}/{seg}" if prefix else seg
        if nxt not in seen_dirs:
            return prefix in listed_dirs
        prefix = nxt
    if parent in listed_dirs:
        return rel not in disk_files
    return False

def _mark_and_clear_missing(conn, rid, known, disk_files, listed_dirs, seen_dirs,
                            excluded, skip_hidden,
                            unknown: AbstractSet[str] = frozenset()) -> tuple[list[str], int]:
    # Hidden rows come from the table, since a scan's `known` can be what the
    # last walk saw on disk, which never holds a hidden row.
    marked = {r[0] for r in conn.execute(
        "SELECT relpath FROM media_files WHERE root_id = ? AND missing_since IS NOT NULL",
        (rid,))}
    now = time.time()
    to_mark: list[str] = []
    to_clear = [rel for rel in marked if rel in disk_files]
    for rel in known:
        if rel in disk_files or rel in marked:
            continue
        if _row_is_absent(rel, disk_files, listed_dirs, seen_dirs, excluded, skip_hidden,
                          unknown):
            to_mark.append(rel)
    conn.executemany(
        "UPDATE media_files SET missing_since = ? WHERE root_id = ? AND relpath = ?",
        [(now, rid, rel) for rel in to_mark])
    # meta_mtime moves so the delta carries the row back, and the card returns
    # with the metadata and search rows it always had.
    conn.executemany(
        "UPDATE media_files SET missing_since = NULL, meta_mtime = ? "
        "WHERE root_id = ? AND relpath = ?", [(now, rid, rel) for rel in to_clear])
    if to_clear:
        _bump_version(conn, rid)
    return sorted(to_mark), len(to_clear)

def _note_unknown(walk: _WalkRecord, exc: OSError, path: str, base_abs: str) -> None:
    # An entry gone between the listing and the read is absent, the same as a
    # name the listing never returned.
    if isinstance(exc, FileNotFoundError):
        return
    walk.unknown.add(os.path.relpath(path, base_abs).replace("\\", "/"))

_REPARSE_NAME_SURROGATE = 0x20000000

def _iter_media_files(base_abs, excluded, skip_hidden, walk: _WalkRecord):
    stack = [base_abs]
    while stack:
        dirpath = stack.pop()
        try:
            with os.scandir(dirpath) as it:
                entries = list(it)
        except OSError:
            walk.dir_errors += 1
            continue
        rel_dir = os.path.relpath(dirpath, base_abs).replace("\\", "/")
        walk.listed_dirs.add("" if rel_dir == "." else rel_dir)
        for entry in entries:
            try:
                linked = entry.is_symlink()
                is_dir = False
                if not linked:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    if is_dir:
                        # A junction is not reported as a symlink, and its reparse
                        # tag gives it away. A cloud placeholder folder carries a
                        # tag of its own, so only a name surrogate counts as a link,
                        # as Python's own stat decides before following one.
                        linked = bool(getattr(
                            entry.stat(follow_symlinks=False), "st_reparse_tag", 0)
                            & _REPARSE_NAME_SURROGATE)
                # A link is named and not walked, so the index holds only paths
                # safe_join will agree to serve.
                if linked:
                    if is_dir or _link_worth_naming(entry):
                        walk.skipped_links.append(
                            os.path.relpath(entry.path, base_abs).replace("\\", "/"))
                    continue
                if is_dir:
                    # Walking it would list the other folder's files a second
                    # time. It is left out of seen_dirs, so rows under it go,
                    # and named from the listing since relpath drops the dot or space.
                    if name_folds(entry.name):
                        walk.folded.append(os.path.join(rel_dir, entry.name).replace("\\", "/").removeprefix("./"))
                        continue
                    if storable_name(entry.name):
                        walk.seen_dirs.add(
                            os.path.relpath(entry.path, base_abs).replace("\\", "/"))
                        if not _dir_excluded(entry.name, excluded, skip_hidden):
                            stack.append(entry.path)
                    else:
                        walk.unstorable.append(entry.path)
                    continue
            except OSError as exc:
                _note_unknown(walk, exc, entry.path, base_abs)
                continue
            ext = os.path.splitext(entry.name)[1].lower()
            if ext not in ALL_MEDIA_EXTS:
                continue
            try:
                st = entry.stat()
            except OSError as exc:
                _note_unknown(walk, exc, entry.path, base_abs)
                continue
            rel = os.path.relpath(entry.path, base_abs).replace("\\", "/")
            if not storable_name(rel):
                walk.unstorable.append(entry.path)
                continue
            yield rel, ext, kind_from_ext(ext), int(st.st_size), float(st.st_mtime), float(st.st_ctime)

_PARSE_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sbg-parse")

_UPSERT_BATCH = 100

def _read_and_upsert_batches(
    conn: sqlite3.Connection,
    root: AllowedRoot,
    items: list[tuple],
    read_metadata_fn: Callable[[str], dict | None] | None,
    *,
    progress_cb: Callable[[int], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> tuple[int, list[str]]:
    """Answers the number read and the relpaths skipped because the file was
    gone by the time it was read. A caller recording what it has seen leaves the
    skipped ones out, or they are remembered as written and never retried."""
    rid = root.root_id

    def _read_one(item):
        rel, ext, kind, size, mtime, ctime = item
        meta_json = None
        try:
            full = safe_join(root.path, rel)
        except ValueError:
            full = None
        # The reader logs a parse failure itself and answers None for it.
        if read_metadata_fn and full is not None:
            meta_dict = read_metadata_fn(full)
            if meta_dict:
                meta_json = json.dumps(meta_dict)
        # A file deleted since the walk listed it must not come back as a row.
        gone = full is None or not os.path.isfile(full)
        return rel, ext, kind, size, mtime, ctime, meta_json, gone

    done = 0
    skipped: list[str] = []
    if not items:
        return 0, skipped
    for start in range(0, len(items), _UPSERT_BATCH):
        if cancel_event is not None and cancel_event.is_set():
            break
        batch = items[start:start + _UPSERT_BATCH]
        # Drained before the first upsert, which opens the batch's transaction,
        # so no write lock is held across the reads.
        parsed = list(_PARSE_POOL.map(_read_one, batch))
        for rel, ext, kind, size, mtime, ctime, meta_json, gone in parsed:
            done += 1
            if gone:
                skipped.append(rel)
                continue
            try:
                upsert_file(conn, rid, rel, ext, kind, size, mtime, meta_json, ctime=ctime)
            except _ONE_FILE_ERRORS as exc:
                logger.warning("Skipped indexing %s: %s", rel, exc)
        conn.commit()
        if progress_cb:
            progress_cb(done)
    return done, skipped

# Per root, the stored times and sizes at a root version, so a scan of an
# unchanged root skips reading every row. An entry is swapped whole and its map
# is never written to, so the lock covers only the swap.
_mtimes_cache: dict[str, tuple[int, dict[str, tuple[float, int]]]] = {}
_mtimes_cache_lock = threading.Lock()

def incremental_scan(
    root: AllowedRoot,
    *,
    read_metadata_fn: Callable[[str], dict | None] | None = None,
    excluded_dirs: set[str] | None = None,
    index_hidden_dirs: bool = False,
    report_progress: bool = False,
    cancel_event: threading.Event | None = None,
) -> ScanResult:
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
        set_meta_value(root_meta_key("indexed", rid), "1")
        set_meta_value(root_meta_key("last_scan", rid), str(time.time()))
    return result

def _incremental_scan_impl(root, base_abs, rid, token, *, read_metadata_fn,
                           excluded_dirs, index_hidden_dirs, cancel_event) -> ScanResult:
    if not os.path.isdir(base_abs):
        raise OSError(f"root path not accessible: {base_abs}")

    cur_version = get_root_version(rid)
    with _mtimes_cache_lock:
        cached = _mtimes_cache.get(rid)
    if cached is not None and cached[0] == cur_version:
        db_mtimes = cached[1]
    else:
        with connect() as conn:
            db_rows = conn.execute(
                "SELECT relpath, mtime, size FROM media_files WHERE root_id = ?",
                (rid,),
            ).fetchall()
        db_mtimes = {r["relpath"]: (r["mtime"], r["size"]) for r in db_rows}
        with _mtimes_cache_lock:
            _mtimes_cache[rid] = (cur_version, db_mtimes)

    disk_files: dict[str, tuple[str, str, int, float, float]] = {}
    excluded = excluded_dirs or set()
    skip_hidden = not index_hidden_dirs
    walk = _WalkRecord()
    for rel, ext, kind, size, mtime, ctime in _iter_media_files(base_abs, excluded, skip_hidden, walk):
        disk_files[rel] = (ext, kind, size, mtime, ctime)
        if token is not None and len(disk_files) % 200 == 0:
            update_progress(rid, token, total=len(disk_files))

    _warn_left_out(rid, walk)

    if token is not None:
        update_progress(rid, token, total=len(disk_files), phase="indexing")

    # Size counts as well as the time, since a copy that keeps timestamps can
    # replace the content without moving the time.
    changed_items = [
        (rel, ext, kind, size, mtime, ctime)
        for rel, (ext, kind, size, mtime, ctime) in disk_files.items()
        if db_mtimes.get(rel) is None
        or abs(mtime - db_mtimes[rel][0]) >= 0.01
        or size != db_mtimes[rel][1]
    ]
    result = ScanResult(total=len(disk_files))
    result.added = [it[0] for it in changed_items if it[0] not in db_mtimes]
    result.updated = [it[0] for it in changed_items if it[0] in db_mtimes]

    def _cb(done):
        if token is not None:
            update_progress(rid, token, done=done)

    with connect() as conn:
        result.changed, skipped = _read_and_upsert_batches(
            conn, root, changed_items, read_metadata_fn,
            progress_cb=_cb, cancel_event=cancel_event,
        )
        # A file gone before its read leaves the walk's result, so the sweep
        # below hides a row that already existed for it in this same pass.
        for rel in skipped:
            disk_files.pop(rel, None)

        v_before = get_root_version(rid)
        if cancel_event is not None and cancel_event.is_set():
            result.complete = False
        else:
            if walk.dir_errors > 0:
                logger.warning(
                    "SBG: scan of %s enumerated with %d unreadable director(y/ies), "
                    "and their rows are left as they stand", rid, walk.dir_errors,
                )
            if "" not in walk.listed_dirs:
                logger.warning("SBG: scan of %s could not read the folder itself", rid)
                result.complete = False
            result.removed, cleared = _mark_and_clear_missing(
                conn, rid, db_mtimes.keys(), disk_files, walk.listed_dirs,
                walk.seen_dirs, excluded, skip_hidden, walk.unknown)
            result.changed += len(result.removed) + cleared
    if result.removed:
        record_removals(rid, result.removed, v_before)
    # A walk that could not read a folder or an entry never saw the rows under
    # it, so keeping what it saw would leave them out of what the next scan
    # checks and a file deleted there could never hide.
    if result.complete and walk.dir_errors == 0 and not walk.unknown:
        with _mtimes_cache_lock:
            _mtimes_cache[rid] = (
                get_root_version(rid),
                {rel: (t[3], t[2]) for rel, t in disk_files.items()},
            )
    return result

def full_reindex(
    root: AllowedRoot,
    read_metadata_fn: Callable[[str], dict | None],
    *,
    excluded_dirs: set[str] | None = None,
    index_hidden_dirs: bool = False,
    token: int | None = None,
    unlisted: list[str] | None = None,
) -> int:
    """Rebuilds one root. `unlisted`, when given, gets the root id once if the
    walk could not read one of its folders or files, so a caller can hold back
    anything that claims the whole root is current."""
    rid = root.root_id
    base_abs = os.path.abspath(root.path)
    # A caller that claimed the rebuild before starting its thread holds it
    # across every root, so it is not released and taken again between them.
    owns_slot = token is None
    if owns_slot:
        token = begin_progress(_FULL_KEY, root_id=rid)
    else:
        update_progress(_FULL_KEY, token, root_id=rid, total=0, done=0, phase="scanning")

    try:
        if not os.path.isdir(base_abs):
            raise OSError(f"root path not accessible: {base_abs}")

        disk_files: list[tuple[str, str, str, int, float, float]] = []
        excluded = excluded_dirs or set()
        skip_hidden = not index_hidden_dirs
        walk = _WalkRecord()
        for tup in _iter_media_files(base_abs, excluded, skip_hidden, walk):
            disk_files.append(tup)
            if len(disk_files) % 500 == 0:
                update_progress(_FULL_KEY, token, total=len(disk_files))

        _warn_left_out(rid, walk)
        update_progress(_FULL_KEY, token, total=len(disk_files), phase="indexing")

        with connect() as conn:
            new_relpaths = {it[0] for it in disk_files}
            _read, skipped = _read_and_upsert_batches(
                conn, root, disk_files, read_metadata_fn,
                progress_cb=lambda done: update_progress(_FULL_KEY, token, done=done),
            )
            new_relpaths.difference_update(skipped)

            swept: list[str] = []
            v_before = get_root_version(rid)
            if walk.dir_errors > 0:
                logger.warning(
                    "SBG: full reindex of %s had %d unreadable director(y/ies), "
                    "and their rows are left as they stand", rid, walk.dir_errors,
                )
            if unlisted is not None and (walk.dir_errors > 0 or walk.unknown):
                unlisted.append(rid)
            if "" in walk.listed_dirs:
                known = [r["relpath"] for r in conn.execute(
                    "SELECT relpath FROM media_files WHERE root_id = ?", (rid,))]
                seen = dict.fromkeys(new_relpaths, True)
                # A file made while the rebuild ran can get its row after the walk
                # passed its folder, so the sweep alone would hide it. Each such
                # row is looked for on disk once more, which a rebuild can afford
                # and a scan on every poll cannot.
                listings: dict[str, set[str]] = {}
                for rel in known:
                    if rel in seen:
                        continue
                    row_parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
                    # Only in a folder the walk read under the stored spelling,
                    # since a filesystem that folds letter case would answer for
                    # a renamed folder and bring the old row back.
                    if row_parent not in walk.listed_dirs:
                        continue
                    if os.path.splitext(rel)[1].lower() not in ALL_MEDIA_EXTS:
                        continue
                    if path_excluded(rel, excluded, skip_hidden):
                        continue
                    if _file_is_really_there(base_abs, rel, listings):
                        seen[rel] = True
                swept, _cleared = _mark_and_clear_missing(
                    conn, rid, known, seen, walk.listed_dirs, walk.seen_dirs,
                    excluded, skip_hidden, walk.unknown)
                cutoff = time.time() - _MISSING_GRACE_S
                stale = [r["relpath"] for r in conn.execute(
                    "SELECT relpath FROM media_files WHERE root_id = ? "
                    "AND missing_since IS NOT NULL AND missing_since < ?", (rid, cutoff))]
                for rel in stale:
                    delete_file(conn, rid, rel)
                if stale:
                    logger.info("SBG: %s purged %d row(s) hidden for more than %d days",
                                rid, len(stale), _MISSING_GRACE_S // 86400)
        update_progress(_FULL_KEY, token, done=len(disk_files))
        record_removals(rid, swept, v_before)

        if owns_slot:
            end_progress(_FULL_KEY, token, "done")
        if "" in walk.listed_dirs:
            set_meta_value(root_meta_key("indexed", rid), "1")
            set_meta_value(root_meta_key("last_scan", rid), str(time.time()))
        bump_meta_epoch()
        return len(disk_files)

    except Exception as e:
        if owns_slot:
            end_progress(_FULL_KEY, token, "error", str(e))
        raise

def get_all_meta_keys() -> dict:
    global _meta_keys_cache, _meta_keys_cache_ver
    with _meta_keys_lock:
        if _meta_keys_cache is not None and _meta_keys_cache_ver == _db_version:
            return _meta_keys_cache
        # A first index or a rebuild moves the version constantly, so while one
        # runs the last answer stands instead of reading every row again.
        if _meta_keys_cache is not None and any_scan_running():
            return _meta_keys_cache
        result = _compute_all_meta_keys()
        _meta_keys_cache = result
        _meta_keys_cache_ver = _db_version
        return result

def _compute_all_meta_keys() -> dict:
    sections: set[str] = set()
    workflow_nodes: dict[str, set[str]] = {}
    workflow_node_titles: dict[str, str] = {}
    # So the Metadata tab can offer one of several nodes of a class by its
    # title, the context it came from, or its index.
    workflow_node_instances: dict[str, dict[str, dict]] = {}
    _buckets = meta_key_buckets()
    element_keys: dict[str, set[str]] = {
        k: set() for k, kind in _buckets.items() if kind in ("array", "object")}

    # A failed read raises instead of answering with the rows read so far, since
    # the caller caches the answer until the next write.
    with connect() as conn:
        cur = conn.execute(
            """SELECT metadata_json FROM media_files
               WHERE metadata_json IS NOT NULL AND metadata_json != ''
                 AND missing_since IS NULL"""
        )
        for row in cur:
            try:
                meta = json.loads(row["metadata_json"])
            except Exception:
                continue
            if not isinstance(meta, dict):
                continue

            for key, val in meta.items():
                # A leading underscore marks a key the parser keeps for
                # itself, and no section is built from it.
                if key.startswith("_"):
                    continue
                sections.add(key)

                kind = _buckets.get(key)
                if kind == "array" and isinstance(val, list):
                    for item in val:
                        if isinstance(item, dict):
                            element_keys[key].update(item.keys())
                elif kind == "object" and isinstance(val, dict):
                    element_keys[key].update(val.keys())

                elif key == "workflow_nodes" and isinstance(val, list):
                    per_type_index: dict[str, int] = {}
                    for node in val:
                        if not isinstance(node, dict):
                            continue
                        # Keyed by class_type, so retitling a node in the workflow
                        # adds no second entry to the Metadata tab.
                        node_name = node.get("class_type") or node.get("title") or "Unknown"
                        if node_name not in workflow_nodes:
                            workflow_nodes[node_name] = set()
                        params = node.get("params", {})
                        if isinstance(params, dict):
                            for pk in params:
                                workflow_nodes[node_name].add(pk)
                        title = node.get("title")
                        if title and title != node_name and node_name not in workflow_node_titles:
                            workflow_node_titles[node_name] = title
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

    return {
        "sections": sorted(sections),
        "workflow_nodes": {k: sorted(v) for k, v in workflow_nodes.items()},
        "workflow_node_titles": workflow_node_titles,
        "workflow_node_instances": {k: list(v.values()) for k, v in workflow_node_instances.items()},
        "element_keys": {k: sorted(v) for k, v in element_keys.items()},
    }
