import { api, apiPost, lsGet, lsSet } from "./sbg-core.js";
import { B } from "./sbg-settings-store.js";
import { cacheDb } from "./sbg-idb.js";
import { metaCache } from "./sbg-meta-cache.js";
import { saveSnapshot, deleteSnapshots } from "./sbg-snapshot.js";
import { resetFailedThumbs } from "./sbg-thumb-cache.js";
import { setSearchSchema, searchSchemaReady } from "./sbg-schema.js";
import { galleryCache } from "./sbg-gallery-store.js";
import { modifiedTime, itemKey } from "./sbg-media-kind.js";
import { postNotice, dismissNotice, failureText } from "./sbg-toast.js";

/** The server reports a folder settings file set aside or copied in one
 *  config answer only, so every reader of the config passes it on. Each
 *  notice names a file to recover from, so it stays until closed. */
export function announceConfigFiles(cfg) {
  if (!cfg) return;

  if (cfg.quarantined) {
    postNotice("folders-set-aside", `Couldn't read the folder settings, so defaults will be used. The folder settings file was kept as ${cfg.quarantined}.`, { sticky: true, failure: true });
  }

  if (cfg.copied) {
    postNotice("folders-copied", `The folder settings file wasn't saved as UTF-8, so some characters may have been read wrong. The original is kept as ${cfg.copied}.`, { sticky: true });
  }
}

// The search schema's last answer is kept in this browser, so a search typed
// before the config answers still resolves its names. It sits outside the
// metadata cache, which Clear metadata cache empties and Diagnostics counts.
function restoreSearchSchema() {
  if (searchSchemaReady()) return;
  try { setSearchSchema(JSON.parse(lsGet(B.SEARCH_SCHEMA))); } catch { }
}

function keepSearchSchema(payload) {
  if (!setSearchSchema(payload)) return;
  lsSet(B.SEARCH_SCHEMA, JSON.stringify(payload));
}

// A new value drops every cache the browser holds, so it changes whenever the
// shape of a cached row does.
const CACHE_EPOCH = "3";

const POLL_RETRY_MS = 10000;

export function ensureCacheEpoch() {
  if (lsGet(B.CACHE_EPOCH) === CACHE_EPOCH) return false;
  metaCache.clearMemory();
  cacheDb.remove();
  deleteSnapshots();
  lsSet(B.CACHE_EPOCH, CACHE_EPOCH);
  return true;
}

export function createDataService({
  state, teardown, setView, applyFilters, renderFromScratch, refilter, announce, onRootsChanged,
  load, folders, configStatus, poll,
  mountEl, search,
}) {
  let _pollTimer = null;
  let _refreshAbort = null;
  teardown.add(() => { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } });
  teardown.add(() => { if (_refreshAbort) { _refreshAbort.abort(); _refreshAbort = null; } });
  let _configRetry = null;
  let _configRetryMs = 5000;
  let _unreadableShown = false;
  // A config read still out when the panel closes must not start a retry or add
  // listeners that no teardown will remove.
  let _disposed = false;
  teardown.add(() => { _disposed = true; clearTimeout(_configRetry); _configRetry = null; });
  let _pollRetry = null;
  teardown.add(_stopPollRetry);

  let _subfoldersInflight = null;
  let _subfoldersAgain = false;

  function loadSubfolders() {
    if (_subfoldersInflight) {
      _subfoldersAgain = true;
      return _subfoldersInflight;
    }
    _subfoldersInflight = (async () => {
      // The root on screen can change while the request is out.
      const rid = state.rootId;
      try {
        const data = await api("/sidebar_gallery/subfolders", { root_id: rid });
        galleryCache.data.subfolders[rid] = data.subfolders;
        if (rid === state.rootId) {
          state.subfolders = data.subfolders;
          onRootsChanged();
        }
        folders.ok();
      } catch (e) {
        console.warn("[SBG] Subfolder list failed to load:", e);
        folders.fail(failureText("load the folder list", e), null, { tint: true });
      } finally {
        _subfoldersInflight = null;
        if (_subfoldersAgain) {
          _subfoldersAgain = false;
          loadSubfolders();
        }
      }
    })();
    return _subfoldersInflight;
  }

  function _coverSubfolders(items) {
    const known = new Set(state.subfolders);
    if (items.some((it) => it.subfolder && !known.has(it.subfolder))) loadSubfolders();
  }

  function _uncoverSubfolders(removedPaths, remaining) {
    const emptied = new Set();
    for (const rp of removedPaths) {
      const cut = rp.lastIndexOf("/");
      if (cut > 0) emptied.add(rp.slice(0, cut));
    }
    if (!emptied.size) return;
    for (const it of remaining) {
      emptied.delete(it.subfolder);
      if (!emptied.size) return;
    }
    loadSubfolders();
  }

  // Size counts as well as the time, since the scan re-reads a file replaced
  // with its timestamp kept, and a check on time alone would discard that row.
  function _rowChanged(prev, next) {
    return modifiedTime(prev) !== modifiedTime(next) || prev.size !== next.size;
  }

  function _dropCachedDetails(rootId, relpath) {
    metaCache.delete(itemKey({ root_id: rootId, relpath }));
  }

  function _retryConfig() {
    if (_disposed) return;
    clearTimeout(_configRetry);
    _configRetry = setTimeout(() => { _configRetry = null; refreshConfig().catch(() => { }); }, _configRetryMs);
    _configRetryMs = Math.min(60000, _configRetryMs * 2);
  }

  async function refreshConfig() {
    restoreSearchSchema();
    let cfg;
    try {
      cfg = await api("/sidebar_gallery/config");
    } catch (e) {
      // Set even for a closed panel, since the next opening starts from the
      // cache and reads the config again only while this is set.
      galleryCache.config.configOwed = true;
      if (_disposed) throw e;

      configStatus.fail(failureText("load the folder settings", e), null, { tint: true });
      _retryConfig();
      throw e;
    }
    galleryCache.config.configOwed = cfg.config_read === false;

    announceConfigFiles(cfg);
    // Posted once until a read succeeds, since each read while the file stays
    // unreadable would bring back a notice that had timed out or been closed.
    if (cfg.unreadable) {
      if (!_unreadableShown) postNotice("folders-unreadable", `${failureText("open the folder settings file", cfg.unreadable)}. Extra folders may be missing until the file can be opened.`, { failure: true });
      _unreadableShown = true;
    } else {
      _unreadableShown = false;
      dismissNotice("folders-unreadable");
    }
    keepSearchSchema(cfg.search_schema);
    galleryCache.data.roots = cfg.roots;
    galleryCache.config.autoRefreshSecs = cfg.auto_refresh_interval_s;
    galleryCache.config.last = cfg;

    // Everything above serves the whole page and lands even for a panel closed
    // during the read, since the next opening starts from the cache. The rest
    // belongs to this panel alone.
    if (_disposed) return;
    configStatus.ok();
    if (cfg.config_read === false) {
      _retryConfig();
    } else {
      clearTimeout(_configRetry);
      _configRetry = null;
      _configRetryMs = 5000;
    }
    state.roots = galleryCache.data.roots;
    startAutoRefresh();

    if (!state.roots.find(r => r.id === state.rootId)) {
      switchRoot("output");
    } else {
      onRootsChanged();
    }
  }

  function switchRoot(newRootId) {
    if (newRootId === state.rootId) return;
    setView({ rootId: newRootId, subfolder: "", favoritesOnly: false, searchMatches: null });
    state.subfolders = galleryCache.data.subfolders[newRootId] || [];
    onRootsChanged();
    const foldersListed = loadSubfolders();
    const known = Array.isArray(galleryCache.data.items[newRootId]) && galleryCache.data.items[newRootId].length > 0;
    if (known) {
      state.allItems = galleryCache.data.items[newRootId];

      refilter();

      _pollAndReconcile(true);
      if (state.searchTags.length > 0) search.trigger();
    } else {
      state.allItems = [];
      refilter();

      fetchAllItems({ rescan: false })
        .then(() => foldersListed.then(() => { if (state.rootId === newRootId && !state.subfolders.length) return loadSubfolders(); }));
    }
  }

  const _persistTimers = new Map();

  function _persistSnapshot(rid) {
    const items = galleryCache.data.items[rid];
    if (!items) return;
    const ver = galleryCache.data.itemsVersion[rid];
    saveSnapshot(rid, items, ver, galleryCache.data.serverTime[rid]).then((ok) => {
      if (ok) galleryCache.data.persistedVersion[rid] = ver;
      else console.warn("[SBG] Could not save the gallery snapshot for", rid);
    });
  }

  function _schedulePersist(rid) {
    const prev = _persistTimers.get(rid);
    if (prev) clearTimeout(prev);
    _persistTimers.set(rid, setTimeout(() => {
      _persistTimers.delete(rid);
      _persistSnapshot(rid);
    }, 1500));
  }

  // A rebuild rewrites stored summaries without touching file times, so a new
  // epoch is the only sign that a cached summary is out of date.
  function _checkMetaEpoch(epoch) {
    if (lsGet(B.META_EPOCH) === String(epoch)) return;
    metaCache.clear();
    lsSet(B.META_EPOCH, String(epoch));
  }

  /** A failure is told in the notification area for the root on screen and is
   *  never thrown. The promise resolves to it, or to null once the list loaded,
   *  for a caller that answers its own click. */
  async function fetchAllItems({ rescan = false, rootId: rid = state.rootId } = {}) {
    if (rescan) resetFailedThumbs();
    const shown = rid === state.rootId;
    if (shown) load.progress(rescan ? "Scanning…" : "Loading…");
    try {
      const data = await api("/sidebar_gallery/list_all", { root_id: rid, rescan: rescan ? "1" : undefined });
      const isCurrent = rid === state.rootId;

      galleryCache.data.serverTime[rid] = data.server_time;
      galleryCache.data.itemsVersion[rid] = data.db_version;
      _checkMetaEpoch(data.meta_epoch);

      const newItems = data.items;
      const prevItems = galleryCache.data.items[rid] || [];

      const viewBehind = isCurrent && state.allItems !== prevItems;
      const oldMap = new Map(prevItems.map((x) => [x.relpath, x]));
      const newSet = new Set(newItems.map((x) => x.relpath));
      const added = newItems.filter(x => !oldMap.has(x.relpath));
      const removedAny = prevItems.some(x => !newSet.has(x.relpath));
      const changedAny = newItems.some(x => oldMap.has(x.relpath) && _rowChanged(oldMap.get(x.relpath), x));
      const noChange = prevItems.length > 0 && added.length === 0 && !removedAny && !changedAny;
      const viewStale = !noChange || viewBehind;

      galleryCache.data.items[rid] = newItems;

      if (!noChange || galleryCache.data.persistedVersion[rid] !== galleryCache.data.itemsVersion[rid]) {
        _schedulePersist(rid);
      }

      if (isCurrent) {
        state.allItems = newItems;
        // A list that arrived is as current as a check could make it, so a failed
        // check's line goes too.
        load.ok();
        _pollOk();
        // A preset load can change a filter without a redraw, so an unchanged
        // list still redraws when the filter now keeps other files. Rows are
        // compared by path, since every answer parses them afresh.
        const drawn = state.filteredItems;
        applyFilters();
        const filterMoved = drawn.length !== state.filteredItems.length
          || drawn.some((x, i) => x.relpath !== state.filteredItems[i].relpath);
        if (viewStale || filterMoved) renderFromScratch();
        _coverSubfolders(added);
        if (removedAny) _uncoverSubfolders(prevItems.filter(x => !newSet.has(x.relpath)).map(x => x.relpath), newItems);

        if (viewStale && state.searchTags.length === 0) announce();

        if (state.searchTags.length > 0 && viewStale) search.trigger();
      }
      return null;
    } catch (e) {
      if (rid === state.rootId) load.fail(failureText("load the files", e));
      return e;
    } finally {
      if (shown) load.stop();
    }
  }

  // A failed check's line stays until a check works, and with auto-refresh off
  // nothing checks again until the window next gets focus, so the check tries
  // again by itself while its line shows. A hidden page is left to the check
  // its return makes. The retry doesn't wait for a scan, since the server's
  // first check after a restart scans anyway.
  function _retryPoll() {
    if (_disposed) return;
    clearTimeout(_pollRetry);
    _pollRetry = setTimeout(() => {
      _pollRetry = null;
      if (document.visibilityState === "visible" && mountEl.isConnected) _pollAndReconcile(false);
    }, POLL_RETRY_MS);
  }

  function _stopPollRetry() {
    clearTimeout(_pollRetry);
    _pollRetry = null;
  }

  function _pollOk() {
    _stopPollRetry();
    poll.ok();
  }

  let _pollInflight = null;
  let _pollInflightRid = null;
  function _pollAndReconcile(eager = false) {
    // A poll still out for another root must not stand in for this root's, so
    // this one runs after it instead of joining it.
    if (_pollInflight) {
      if (_pollInflightRid === state.rootId) return _pollInflight;
      return _pollInflight.then(() => _pollAndReconcile(eager));
    }
    _pollInflightRid = state.rootId;
    _pollInflight = (async () => {
      try {
        const rid = state.rootId;
        const known = galleryCache.data.itemsVersion[rid];

        // `eager` makes the server finish its scan before answering, so a change
        // made outside the gallery arrives in one round trip.
        let p;
        try {
          p = await api("/sidebar_gallery/poll", eager ? { root_id: rid, eager: "1" } : { root_id: rid });
        } catch (e) {
          if (rid === state.rootId) {
            // A closed line stops the retry, which would otherwise bring it back.
            poll.fail(`${failureText("check for new files", e)}. The files shown may be out of date.`, _stopPollRetry, { tint: true });
            _retryPoll();
          }
          return;
        }
        _pollOk();
        if (p.reindexing) return;
        // The server answers again, so a failed load's line goes too. Whatever
        // the list still lacks is fetched below, and says so if it fails.
        if (rid === state.rootId) load.ok();
        _checkMetaEpoch(p.meta_epoch);
        if (known == null) {
          await fetchAllItems({ rescan: false, rootId: rid });
        } else if (p.db_version !== known) {
          await fetchNewItems(rid);
        } else if (p.count !== (galleryCache.data.items[rid] || []).length) {
          // The same version with a different count means the list here missed a
          // change, so it is read whole again.
          await fetchAllItems({ rescan: false, rootId: rid });
        }
      } finally {
        _pollInflight = null;
        _pollInflightRid = null;
      }
    })();
    return _pollInflight;
  }

  function startAutoRefresh() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_refreshAbort) { _refreshAbort.abort(); _refreshAbort = null; }

    const ac = new AbortController();
    _refreshAbort = ac;
    const maybePoll = (eager = false) => {
      if (document.visibilityState !== "visible") return;
      if (!mountEl.isConnected) return;
      _pollAndReconcile(eager);
    };

    // These stay on with auto-refresh off, so a return to the tab still checks
    // for new files.
    window.addEventListener("focus", () => maybePoll(true), { signal: ac.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") maybePoll(true);
    }, { signal: ac.signal });
    const secs = galleryCache.config.autoRefreshSecs;
    if (secs) _pollTimer = setInterval(() => maybePoll(false), secs * 1000);
  }

  async function fetchNewItems(rid = state.rootId, routedFiles = null) {
    let files = [];
    if (routedFiles !== null) {
      files = routedFiles;
    } else if (galleryCache.inbox.pendingFiles.length) {
      const pending = galleryCache.inbox.pendingFiles;
      galleryCache.inbox.pendingFiles = [];
      // Every queued file was written to Output. With Output not loaded here
      // they are dropped, since its full list brings them when it is opened.
      if (rid === "output") files = pending;
      else if (galleryCache.data.serverTime.output || (galleryCache.data.items.output || []).length > 0) {
        fetchNewItems("output", pending);
      }
    }

    if (!files.length && (!galleryCache.data.serverTime[rid] || (galleryCache.data.items[rid] || []).length === 0)) {
      return fetchAllItems({ rescan: false, rootId: rid });
    }

    try {
      const body = { root_id: rid };
      if (files.length > 0) {
        body.files = files;
      } else {
        // `since` is a time on the server's clock from its last reply, because
        // the browser's clock can differ.
        body.since = galleryCache.data.serverTime[rid];
        const kv = galleryCache.data.itemsVersion[rid];
        if (typeof kv === "number") body.known_version = kv;
      }

      const data = await apiPost("/sidebar_gallery/list_new", body);
      const isCurrent = rid === state.rootId;

      _checkMetaEpoch(data.meta_epoch);

      if (data.stale) {
        return fetchAllItems({ rescan: false, rootId: rid });
      }

      // Only the since form reads the whole window and its removals, so a read
      // of named files leaves the cursor and the version for the next check to
      // move past.
      if (!files.length) {
        galleryCache.data.serverTime[rid] = data.server_time;
        galleryCache.data.itemsVersion[rid] = data.db_version;
      }

      const added = data.items;
      const removed = data.removed;

      // Nothing between this read and the write back below may await, or two
      // reconciles for one root interleave and one loses its files.
      let items = galleryCache.data.items[rid] || [];
      let changedAny = false;

      if (removed.length > 0) {
        const rm = new Set(removed);
        const next = items.filter(x => !rm.has(x.relpath));
        if (next.length !== items.length) {
          items = next;
          changedAny = true;
        }
        for (const rp of removed) {
          _dropCachedDetails(rid, rp);
        }
      }

      if (added.length > 0) {
        added.sort((a, b) => b.mtime - a.mtime);
        const byPath = new Map(items.map(x => [x.relpath, x]));
        const trulyNew = [];
        for (const it of added) {
          const prev = byPath.get(it.relpath);
          // A delta can carry rows that did not change, and dropping their cached
          // details would send the lightbox back to the server for what it held.
          if (!prev) {
            trulyNew.push(it);
            _dropCachedDetails(rid, it.relpath);
          } else if (_rowChanged(prev, it)) {
            _dropCachedDetails(rid, it.relpath);
            items = items.map(x => (x.relpath === it.relpath ? it : x));
            changedAny = true;
          }
        }
        if (trulyNew.length > 0) {
          items = [...trulyNew, ...items];
          changedAny = true;
        }
      }

      galleryCache.data.items[rid] = items;

      if (data.count !== items.length) {
        fetchAllItems({ rescan: false, rootId: rid });
      }

      if (!changedAny) return;
      if (isCurrent) state.allItems = items;
      _schedulePersist(rid);
      if (!isCurrent) return;
      _coverSubfolders(added);
      _uncoverSubfolders(removed, items);

      if (state.searchMatches && added.length > 0) {
        // The matches belong to the search that asked for them, so they join its
        // map only. A search started meanwhile covers these files itself.
        const map = state.searchMatches;
        try {
          const matches = await search.matchFiles(added.map(a => a.relpath));
          if (state.searchMatches === map) for (const [relpath, fields] of matches) map.set(relpath, fields);
        } catch {
          // Nothing asks about these files again, so the whole search runs once
          // more and reports its own failure.
          search.trigger();
        }
      }

      applyFilters();
      renderFromScratch();
      announce();
      load.ok();
      _pollOk();
    } catch (e) {
      console.warn("[SBG] Delta refresh failed, falling back to full:", e);
      return fetchAllItems({ rescan: false, rootId: rid });
    }
  }

  function reconcileAfterPaint() {
    if (galleryCache.inbox.stale) {
      galleryCache.inbox.stale = false;
      fetchNewItems().finally(() => _pollAndReconcile(true));
    } else {
      _pollAndReconcile(true);
    }
  }

  return {
    loadSubfolders,
    refreshConfig,
    switchRoot,
    fetchAllItems,
    fetchNewItems,
    startAutoRefresh,
    reconcileAfterPaint,
  };
}
