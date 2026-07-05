/**
 * sbg-core.js - Shared utilities, caches, IndexedDB, settings, icons
 * 
 * This module contains all shared infrastructure used by the gallery,
 * lightbox, settings, and entry point modules. It has no side effects
 * (no DOM mutations, no event listeners, no app.registerExtension).
 */

/* ── Constants ────────────────────────────────────────────────────── */

export const EXT_NAME = "ComfyUI-sidebar-gallery.Sidebar";
// Resolve the stylesheet relative to this module's own served URL, so it loads
// regardless of the install folder name (e.g. when ComfyUI-Manager uses a
// different folder than the git-clone instructions).
export const CSS_URL = new URL("./sidebar_gallery.css", import.meta.url).href;

/* ── Module-level data cache (persists across sidebar open/close) ── */

export const _dataCache = {
  roots: null,        // [{id, label}, ...]
  items: {},          // rootId -> [item, ...]
  subfolders: {},     // rootId -> [subfolder, ...]
  stale: false,       // set true when a new generation completes
  lastRootId: "output",
  lastSubfolder: "",
  lastKind: "",
  lastSort: null,
  // Per-response bookkeeping is keyed per root so a response for one root can't
  // stamp values that another root's logic then trusts (since timestamps,
  // version-gate decisions).
  itemsVersion: {},      // rootId -> db_version the cached items reflect
  serverTime: {},        // rootId -> server timestamp of last response (delta `since`)
  _persistedVersion: {}, // rootId -> db_version last written to IndexedDB
  _pendingFiles: [],  // files from executed events, waiting to be sent to backend
};

/* ── Mutable shared state (used by gallery + lightbox) ───────────── */

export const searchState = {
  query: "",       // current search term for metadata highlighting (_activeSearchQuery)
  scopes: null,    // Set of canonical section names that were searched, or null = global
};

export const _sectionOrderKey = "SBG.MetaSectionOrder";

/* ── Module-level caches ──────────────────────────────────────────── */

// Bounded Map (FIFO eviction) so the metadata cache can't grow without limit
// over a long browsing session. Entries are small, so the cap is generous; an
// evicted item just re-fetches from the server (a fast DB read) when next viewed.
class _LruMap extends Map {
  constructor(max) { super(); this._max = max; }
  set(k, v) {
    if (super.has(k)) super.delete(k);   // refresh recency (move to newest)
    super.set(k, v);
    while (super.size > this._max) super.delete(super.keys().next().value);
    return this;
  }
}
export const _metaCache = new _LruMap(5000); // "root_id:relpath" -> metadata object
export const _mediaState = { volume: 1, muted: false, loop: true };

/* ── IndexedDB persistence (instant load across reboots) ─────────── */
const _IDB_NAME = "sbg-gallery-cache";
const _IDB_VERSION = 1;
const _IDB_STORE = "items";

function _openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_IDB_STORE)) {
        db.createObjectStore(_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function _persistItems(rootId, items, dbVersion = null) {
  try {
    const db = await _openIDB();
    const tx = db.transaction(_IDB_STORE, "readwrite");
    const store = tx.objectStore(_IDB_STORE);
    // Store dbVersion with the items in one put so the reopen version-gate can
    // trust that the saved version matches exactly the saved item set.
    store.put({ items, ts: Date.now(), dbVersion }, rootId);
    db.close();
  } catch (e) { /* IndexedDB not available - silently fail */ }
}

export async function _loadPersistedItems(rootId) {
  try {
    const db = await _openIDB();
    return new Promise((resolve) => {
      const tx = db.transaction(_IDB_STORE, "readonly");
      const store = tx.objectStore(_IDB_STORE);
      const req = store.get(rootId);
      req.onsuccess = () => {
        db.close();
        const data = req.result;
        if (data && Array.isArray(data.items) && data.items.length > 0) {
          resolve({ items: data.items, dbVersion: data.dbVersion ?? null });
        } else {
          resolve(null);
        }
      };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch (e) { return null; }
}

/* ── Helpers ──────────────────────────────────────────────────────── */

export function ensureCss() {
  if (document.querySelector(`link[data-sbg-css="1"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_URL;
  link.dataset.sbgCss = "1";
  document.head.appendChild(link);
}

/** Lazy-load the <model-viewer> web component for 3D preview. */
let _mvLoaded = false;
export function ensureModelViewer() {
  if (_mvLoaded || document.querySelector("model-viewer")) { _mvLoaded = true; return; }
  if (document.querySelector('script[data-sbg-mv="1"]')) return;
  const s = document.createElement("script");
  s.type = "module";
  s.src = "https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js";
  s.dataset.sbgMv = "1";
  document.head.appendChild(s);
  _mvLoaded = true;
}

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else if (c) el.appendChild(c);
  }
  return el;
}

export async function api(path, params, opts) {
  const url = new URL(path, window.location.origin);
  if (params) for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), opts);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

export function fmtBytes(b) {
  const n = Number(b);
  if (!Number.isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function timeAgo(ts) {
  const diff = (Date.now() / 1000) - ts;
  if (diff < 60) return t("core.just_now");
  if (diff < 3600) return t("core.m_ago", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("core.h_ago", { n: Math.floor(diff / 3600) });
  if (diff < 604800) return t("core.d_ago", { n: Math.floor(diff / 86400) });
  return new Date(ts * 1000).toLocaleDateString();
}

export function pj(x) { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }

let _toastEl = null, _toastTimer = null;
export function showToast(msg, duration = 1800) {
  if (!_toastEl) { _toastEl = h("div", { class: "sbg-toast" }); document.body.appendChild(_toastEl); }
  _toastEl.textContent = msg;
  _toastEl.classList.add("sbg-toast--visible");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => _toastEl.classList.remove("sbg-toast--visible"), duration);
}

export function copyText(text) {
  if (text == null || text === "") { showToast(t("core.nothing_to_copy")); return; }
  const str = String(text);
  // navigator.clipboard only exists in a secure context (https or localhost).
  // ComfyUI is often served over plain HTTP on a LAN IP, where it is undefined,
  // so fall back to the legacy execCommand path.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(str)
      .then(() => showToast(t("core.copied")))
      .catch(() => { if (!_copyFallback(str)) showToast(t("core.copy_failed")); });
    return;
  }
  if (!_copyFallback(str)) showToast(t("core.copy_failed"));
}

function _copyFallback(str) {
  try {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, str.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) showToast(t("core.copied"));
    return ok;
  } catch {
    return false;
  }
}

export function fileUrl(it) {
  // Append the file's modification time (in milliseconds) so the URL is
  // content-addressed: an unchanged file keeps a stable, browser-cacheable URL
  // (/file responds with immutable Cache-Control), while a regenerated file gets a
  // fresh URL and bypasses the stale cached bytes. Millisecond precision so a
  // same-second overwrite of a fixed-name file still busts the immutable cache.
  const v = Math.floor((it.mtime_real ?? it.mtime ?? 0) * 1000);
  return `/sidebar_gallery/file?root_id=${encodeURIComponent(it.root_id)}&relpath=${encodeURIComponent(it.relpath)}&v=${v}`;
}

export function isVideo(it) { return it.kind === "video"; }
export function isAudio(it) { return it.kind === "audio"; }
export function is3D(it) { return it.kind === "mesh"; }

/* ── Persistent IndexedDB cache (thumbnails + metadata) ──────────── */

let _idbCachedPromise = null;
const _idbPromise = () => {
  if (!_idbCachedPromise) {
    _idbCachedPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('sbg-cache', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return _idbCachedPromise;
};

/** Reset the cached IDB connection (call after deleteDatabase). */
export function _resetIdb() {
  if (_idbCachedPromise) {
    // Close the existing connection first so deleteDatabase isn't blocked
    _idbCachedPromise.then(db => { try { db.close(); } catch (e) { /* ignore */ } }).catch(() => {});
  }
  _idbCachedPromise = null;
}
// L1 synchronous memory cache: url → blobUrl (with LRU eviction)
const MAX_MEM_CACHE = 500;  // Max blob URLs kept in memory
export const _thumbMemCache = new Map();

/** Insert into L1 cache with LRU eviction */
function _thumbMemSet(url, blobUrl) {
  // Move to end (most recently used)
  if (_thumbMemCache.has(url)) _thumbMemCache.delete(url);
  _thumbMemCache.set(url, blobUrl);
  // Evict oldest 25% when over limit
  if (_thumbMemCache.size > MAX_MEM_CACHE) {
    const evictCount = Math.floor(MAX_MEM_CACHE * 0.25);
    let evicted = 0;
    for (const [key, val] of _thumbMemCache) {
      if (evicted >= evictCount) break;
      // Never revoke an object URL still shown by a visible card, or live
      // thumbnails become broken images. Skip in-use entries; the viewport holds
      // far fewer than the cache cap so eviction still drains.
      try {
        if (document.querySelector(`img.sbg-card__thumb[src="${val}"]`)) continue;
      } catch { }
      try { URL.revokeObjectURL(val); } catch { }
      _thumbMemCache.delete(key);
      evicted++;
    }
  }
}

export const _thumbCacheAPI = {
  async _get(url) {
    const db = await _idbPromise();
    return new Promise(resolve => {
      const tx = db.transaction('thumbs', 'readonly');
      const req = tx.objectStore('thumbs').get(url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  },

  async _put(url, blob) {
    const db = await _idbPromise();
    return new Promise(resolve => {
      const tx = db.transaction('thumbs', 'readwrite');
      tx.objectStore('thumbs').put(blob, url);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  /** Synchronous check of L1 memory cache. Returns blobUrl or null. */
  tryGetSync(url) {
    return _thumbMemCache.get(url) || null;
  },

  /** Load a thumbnail URL from memory/IndexedDB cache or network. Returns an object URL. */
  async getOrFetch(url) {
    // L1: synchronous memory check
    const mem = _thumbMemCache.get(url);
    if (mem) return mem;
    try {
      // L2: IndexedDB
      const cached = await this._get(url);
      if (cached) {
        const blobUrl = URL.createObjectURL(cached);
        _thumbMemSet(url, blobUrl);
        return blobUrl;
      }
      // L3: Network fetch
      const resp = await fetch(url);
      if (resp.ok) {
        const blob = await resp.blob();
        await this._put(url, blob);
        const blobUrl = URL.createObjectURL(blob);
        _thumbMemSet(url, blobUrl);
        return blobUrl;
      }
    } catch { /* IndexedDB not available - fall through */ }
    return url;
  },

  /** Check if a URL is already cached (without fetching). Returns blob URL or null. */
  async tryGet(url) {
    // L1: synchronous memory check
    const mem = _thumbMemCache.get(url);
    if (mem) return mem;
    try {
      // L2: IndexedDB
      const cached = await this._get(url);
      if (cached) {
        const blobUrl = URL.createObjectURL(cached);
        _thumbMemSet(url, blobUrl);
        return blobUrl;
      }
    } catch { }
    return null;
  },

  /** Get cache stats including total size. */
  async getStats() {
    try {
      const db = await _idbPromise();
      return new Promise(resolve => {
        const tx = db.transaction('thumbs', 'readonly');
        const store = tx.objectStore('thumbs');
        const countReq = store.count();
        let totalSize = 0;
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (cursor.value && cursor.value.size) totalSize += cursor.value.size;
            cursor.continue();
          }
        };
        countReq.onsuccess = () => {
          tx.oncomplete = () => resolve({ count: countReq.result, totalSizeBytes: totalSize });
        };
        countReq.onerror = () => resolve({ count: 0, totalSizeBytes: 0 });
      });
    } catch { return { count: 0, totalSizeBytes: 0 }; }
  },

  /** Clear all cached thumbnails. */
  async clear() {
    try {
      const db = await _idbPromise();
      return new Promise(resolve => {
        const tx = db.transaction('thumbs', 'readwrite');
        tx.objectStore('thumbs').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { }
  },

  /** Bound the store: entries are content-addressed (&v=mtime), so a changed
   *  file orphans its old thumbnail and IndexedDB has no LRU. When over the cap,
   *  evict down to 75% in one readwrite transaction (count and deletes share the
   *  transaction, avoiding a count-then-clear race) rather than nuking the whole
   *  warm cache; evicted thumbnails re-fetch from the server's disk cache on
   *  demand. Deletes follow store-key order (IndexedDB has no insertion stamp). */
  async pruneIfOver(maxCount) {
    try {
      const db = await _idbPromise();
      const target = Math.floor(maxCount * 0.75);
      await new Promise(resolve => {
        const tx = db.transaction('thumbs', 'readwrite');
        const store = tx.objectStore('thumbs');
        const countReq = store.count();
        countReq.onsuccess = () => {
          if ((countReq.result || 0) <= maxCount) return;  // under cap → no-op
          let toDelete = countReq.result - target;
          const curReq = store.openKeyCursor();
          curReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor || toDelete <= 0) return;
            store.delete(cursor.primaryKey);
            toDelete--;
            cursor.continue();
          };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch { }
  },
};

export const _metaCacheAPI = {
  /** Get a metadata entry from IndexedDB. */
  async get(key) {
    try {
      const db = await _idbPromise();
      return new Promise(resolve => {
        const tx = db.transaction('meta', 'readonly');
        const req = tx.objectStore('meta').get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  },

  /** Store a single metadata entry. */
  async put(key, value) {
    try {
      const db = await _idbPromise();
      return new Promise(resolve => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { }
  },

  /** Bulk store metadata entries: [{key, value}, ...] */
  async putBatch(entries) {
    if (!entries.length) return;
    try {
      const db = await _idbPromise();
      return new Promise(resolve => {
        const tx = db.transaction('meta', 'readwrite');
        const store = tx.objectStore('meta');
        for (const { key, value } of entries) store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { }
  },

  /** Get count and size of cached metadata entries. */
  async getStats() {
    try {
      const db = await _idbPromise();
      return new Promise(resolve => {
        const tx = db.transaction('meta', 'readonly');
        const store = tx.objectStore('meta');
        const countReq = store.count();
        let totalSize = 0;
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            try { totalSize += JSON.stringify(cursor.value).length * 2; } catch { }
            cursor.continue();
          }
        };
        countReq.onsuccess = () => {
          tx.oncomplete = () => resolve({ count: countReq.result, totalSizeBytes: totalSize });
        };
        countReq.onerror = () => resolve({ count: 0, totalSizeBytes: 0 });
      });
    } catch { return { count: 0, totalSizeBytes: 0 }; }
  },

  /** Clear all cached metadata. */
  async clear() {
    try {
      const db = await _idbPromise();
      return new Promise(resolve => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { }
  },
};

/* ── Lazy thumbnail loading via IntersectionObserver ──────────────── */

let _thumbObserver = null;
const _thumbFailedUrls = new Set(); // Track URLs that have already failed
// Backoff for transient thumbnail misses: the server is still generating the
// thumb for a just-generated file, or is briefly unreachable right after a
// ComfyUI reboot. getOrFetch resolves to the raw URL (not a blob:) on a miss, so
// retry a few times before giving up.
const THUMB_RETRY_DELAYS = [1500, 3500, 7000];

export function initThumbObserver() {
  if (_thumbObserver) return;
  _thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const wrap = entry.target;
      _thumbObserver.unobserve(wrap);
      const item = wrap._sbgItem;
      if (!item || !item.thumb_url) continue;
      if (_thumbFailedUrls.has(item.thumb_url)) continue; // Skip known-failed URLs

      const giveUp = () => {
        _thumbFailedUrls.add(item.thumb_url); // stop hammering a genuinely-dead URL
        const spinner = wrap.querySelector(".sbg-card__spinner");
        if (spinner) spinner.remove();
      };
      const scheduleRetry = (attempt) => {
        if (attempt < THUMB_RETRY_DELAYS.length) {
          setTimeout(() => { if (wrap.isConnected && wrap._sbgItem === item) tryLoad(attempt + 1); }, THUMB_RETRY_DELAYS[attempt]);
        } else { giveUp(); }
      };
      const tryLoad = (attempt) => {
        _thumbCacheAPI.getOrFetch(item.thumb_url).then(blobUrl => {
          // The wrap may have been removed (filter change) or rebound to another
          // item by the time the fetch resolves; don't inject a stale thumbnail.
          if (!wrap.isConnected || wrap._sbgItem !== item) return;
          // getOrFetch resolves to the raw URL (not a blob:) on a miss, e.g. a
          // just-generated file whose thumbnail isn't built yet, or the server not
          // yet up right after a reboot. Retry with backoff so it self-heals in
          // place instead of waiting for a manual rescan.
          if (blobUrl === item.thumb_url) { scheduleRetry(attempt); return; }
          const img = h("img", { class: "sbg-card__thumb", loading: "lazy" });
          img.src = blobUrl;
          const spinner = wrap.querySelector(".sbg-card__spinner");
          if (spinner) spinner.remove();
          const placeholder = wrap.querySelector(".sbg-card__placeholder");
          if (placeholder) placeholder.remove();
          wrap.insertBefore(img, wrap.firstChild);
          item.has_thumb = true;
        }).catch(() => { scheduleRetry(attempt); });
      };
      tryLoad(0);
    }
  }, { rootMargin: "200px" });
}

export function getThumbObserver() {
  return _thumbObserver;
}

/**
 * Disconnect and drop the shared thumbnail IntersectionObserver. Called when the
 * gallery (re)mounts so observations from a previous gallery instance can't leak
 * across (a thumb-size change re-runs initGallery reusing module-level state,
 * unlike a full page refresh which resets everything). Stale observed wraps can
 * otherwise inject thumbnails into the wrong cards after a remount.
 */
export function resetThumbObserver() {
  if (_thumbObserver) { try { _thumbObserver.disconnect(); } catch { } _thumbObserver = null; }
}

/**
 * Forget thumbnail URLs that previously failed to load, so a rescan can retry
 * them. Without this, a transient 404 (thumb still generating) would block the
 * URL until a full page reload.
 */
export function resetFailedThumbs() {
  _thumbFailedUrls.clear();
}

/* ── SVG Icons ────────────────────────────────────────────────────── */

export const PLAY_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="white"><polygon points="8,5 19,12 8,19"/></svg>`;
export const VIDEO_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
export const AUDIO_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
export const MESH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;
export const IMG_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
export const IMG_FILTER_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
export const SEARCH_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="16.65" y1="16.65" x2="21" y2="21"/></svg>`;
export const GEAR_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

/* ── Setting IDs ──────────────────────────────────────────────────── */

export const S = {
  THUMB_SIZE: "SBG.ThumbSize",
  THUMB_SHAPE: "SBG.ThumbShape",
  THUMB_PER_ROW: "SBG.ThumbPerRow",
  SORT: "SBG.DefaultSort",
  THEME: "SBG.Theme",
  KEY_PREV: "SBG.KeyPrev",
  KEY_NEXT: "SBG.KeyNext",
  KEY_CLOSE: "SBG.KeyClose",
  KEY_TOGGLE: "SBG.KeyToggle",
  KEY_REFRESH: "SBG.KeyRefresh",
  KEY_FULLSCREEN: "SBG.KeyFullscreen",
  KEY_DOWNLOAD: "SBG.KeyDownload",
  KEY_COPY_PROMPT: "SBG.KeyCopyPrompt",
  KEY_COPY_WF: "SBG.KeyCopyWF",
  KEY_LOAD_WF: "SBG.KeyLoadWF",
  TOOLTIP_NAME: "SBG.TooltipName",
  TOOLTIP_SIZE: "SBG.TooltipSize",
  TOOLTIP_DATE: "SBG.TooltipDate",
  BADGE_HIGH_COLOR: "SBG.BadgeHighColor",
  BADGE_LOW_COLOR: "SBG.BadgeLowColor",
  VIDEO_BADGE_COLOR: "SBG.VideoBadgeColor",
  LB_SHOW_DOWNLOAD: "SBG.LbShowDownload",
  LB_SHOW_COPY_PROMPT: "SBG.LbShowCopyPrompt",
  LB_SHOW_COPY_WF: "SBG.LbShowCopyWF",
  LB_SHOW_LOAD_WF: "SBG.LbShowLoadWF",
  LB_COLOR_DOWNLOAD: "SBG.LbColorDownload",
  LB_COLOR_COPY_PROMPT: "SBG.LbColorCopyPrompt",
  LB_COLOR_COPY_WF: "SBG.LbColorCopyWF",
  LB_COLOR_LOAD_WF: "SBG.LbColorLoadWF",
  PROMPT_VIEW: "SBG.PromptView",
  SEARCH_TAG_COLOR: "SBG.SearchTagColor",
  SEARCH_TAG_NEG_COLOR: "SBG.SearchTagNegColor",
  // Per-app badge colors
  APP_BADGE_COMFYUI: "SBG.AppBadgeComfyUI",
  APP_BADGE_A1111: "SBG.AppBadgeA1111",
  APP_BADGE_FORGE: "SBG.AppBadgeForge",
  APP_BADGE_SDNEXT: "SBG.AppBadgeSDNext",
  APP_BADGE_FOOOCUS: "SBG.AppBadgeFooocus",
  APP_BADGE_CIVITAI: "SBG.AppBadgeCivitAI",
  // Initial image tab
  INITIAL_IMAGE_TAB_COLOR: "SBG.InitialImageTabColor",
  // Pill/badge colors
  PILL_BG_COLOR: "SBG.PillBgColor",
  PILL_TEXT_COLOR: "SBG.PillTextColor",
  PILL_BORDER_COLOR: "SBG.PillBorderColor",
  PROMPT_PADDING: "SBG.PromptPadding",
  FILENAME_STYLE: "SBG.FilenameStyle",
  MODEL_NAME_STYLE: "SBG.ModelNameStyle",
  VSCROLL_BUFFER: "SBG.VScrollBuffer",
  META_TAB_PERSIST: "SBG.MetaTabPersist",
};

/* ── Source-app registry ──────────────────────────────────────────── */
// The single table of supported source apps. Everything per-app derives from
// it: APPS/APP_LABELS (translation layer + layout-editor profiles), the
// settings rows, the boot-time CSS variable application, and the lightbox
// badge maps. Adding an app means editing this table only.
// defaultColor is applied to the cssVar at boot, so the var(--sbg-app-*, #hex)
// fallbacks in the stylesheet are cosmetic only (pre-boot flash at most).
export const APP_REGISTRY = [
  { id: "comfyui", label: "ComfyUI", settingKey: S.APP_BADGE_COMFYUI, cssVar: "--sbg-app-comfyui", defaultColor: "#4ade80" },
  { id: "a1111",   label: "A1111",   settingKey: S.APP_BADGE_A1111,   cssVar: "--sbg-app-a1111",   defaultColor: "#c084fc" },
  { id: "forge",   label: "Forge",   settingKey: S.APP_BADGE_FORGE,   cssVar: "--sbg-app-forge",   defaultColor: "#fdba74" },
  { id: "sdnext",  label: "SD.Next", settingKey: S.APP_BADGE_SDNEXT,  cssVar: "--sbg-app-sdnext",  defaultColor: "#5eead4" },
  { id: "fooocus", label: "Fooocus", settingKey: S.APP_BADGE_FOOOCUS, cssVar: "--sbg-app-fooocus", defaultColor: "#f472b6" },
  { id: "civitai", label: "CivitAI", settingKey: S.APP_BADGE_CIVITAI, cssVar: "--sbg-app-civitai", defaultColor: "#3b82f6" },
];

/* ── Shared scan/reindex progress poller ─────────────────────────── */
// One timer and one fetch of /sidebar_gallery/reindex_progress, fanned out to
// every UI that shows indexing progress (status bar, new-folder flow,
// first-time modal), so the phase copy can never drift between them.
// Response shape: {running:<full rebuild>, full:{...}|null, roots:{rid:{...}}}
// each entry: {running, root_id, total, done, phase, error}.
const _ppSubs = new Set();
let _ppTimer = null;
let _ppIdleTicks = 0;

async function _ppTick() {
  let data = null;
  try {
    const r = await fetch("/sidebar_gallery/reindex_progress");
    if (r.ok) data = await r.json();
  } catch { /* server briefly unreachable: deliver null, consumers keep state */ }
  const anyRunning = !!(data && (data.running
    || (data.full && data.full.running)
    || Object.values(data.roots || {}).some(e => e && e.running)));
  _ppIdleTicks = anyRunning ? 0 : _ppIdleTicks + 1;
  // settled = nothing running for 2+ consecutive ticks. A multi-root rebuild
  // ends one root's entry moments before beginning the next, so a consumer that
  // treats a single idle read as "finished" would close its UI in that gap.
  const settled = !anyRunning && _ppIdleTicks >= 2;
  for (const cb of [..._ppSubs]) {
    try { cb(data, { anyRunning, settled }); } catch { /* isolate one bad consumer from the rest */ }
  }
  if (_ppSubs.size === 0) { _ppTimer = null; return; }
  _ppTimer = setTimeout(_ppTick, anyRunning ? 1000 : 3000);
}

export const progressPoller = {
  /** Subscribe cb(data, {anyRunning, settled}); returns an unsubscribe fn.
      The poller runs 1s ticks while anything is indexing, 3s when idle, and
      stops entirely once the last subscriber leaves. */
  subscribe(cb) {
    _ppSubs.add(cb);
    if (_ppTimer == null) { _ppIdleTicks = 0; _ppTimer = setTimeout(_ppTick, 0); }
    return () => { _ppSubs.delete(cb); };
  },
};

/** The single formatter for a progress entry → {text, pct, error?}; pct -1 =
    indeterminate. Every progress UI renders from this so phases can never
    drift between them. */
export function formatProgress(entry) {
  if (!entry) return null;
  if (entry.phase === "error") {
    return { text: t("core.indexing_failed", { e: entry.error || "unknown error" }), pct: -1, error: true };
  }
  if (entry.phase === "scanning") {
    return { text: t("core.scanning", { n: (entry.total || 0).toLocaleString() }), pct: -1 };
  }
  const total = entry.total || 0;
  const done = entry.done || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { text: `${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`, pct };
}

/* ═══════════════════════════════════════════════════════════════════════
   DISK-BACKED SETTINGS API

   All user preferences are persisted to a server-side JSON file via
   GET/POST /sidebar_gallery/settings. An in-memory cache makes
   reads synchronous (fast). Writes are debounced to avoid hammering
   the server during rapid UI changes.

   On first load (no disk settings file), settings auto-migrate from
   localStorage so existing users don't lose them.
   ═══════════════════════════════════════════════════════════════════════ */

/** In-memory settings cache. Populated by loadSettings(). */
let _diskSettings = {};
let _diskSettingsLoaded = false;
let _diskSettingsLoading = null; // Promise while loading

/** Debounce timer for saving settings to disk */
let _saveDebounceTimer = null;
const _SAVE_DEBOUNCE_MS = 500;

/** Pending changes to be saved (accumulated during debounce window) */
let _pendingChanges = {};

/**
 * Load all settings from the server into memory.
 * Returns a promise that resolves when settings are loaded.
 * Subsequent calls return the cached promise if still loading.
 */
export async function loadSettings() {
  if (_diskSettingsLoaded) return _diskSettings;
  if (_diskSettingsLoading) return _diskSettingsLoading;

  _diskSettingsLoading = (async () => {
    try {
      const resp = await fetch("/sidebar_gallery/settings");
      if (resp.ok) {
        const data = await resp.json();
        if (data && typeof data === "object") {
          _diskSettings = data;
        }
      }
    } catch (e) {
      console.warn("[SBG] Failed to load settings from server:", e);
    }

    _diskSettingsLoaded = true;
    _installFlushHooks();
    return _diskSettings;
  })();

  return _diskSettingsLoading;
}

/**
 * Flush pending settings to the server synchronously (sendBeacon), used when the
 * page is hidden/closing. Debounced saves would otherwise be lost if the tab
 * closes within the 500ms window, silently dropping layout/tab edits and making
 * browsers diverge (the change never reaches the shared server file).
 */
export function flushSettingsNow() {
  if (_saveDebounceTimer) { clearTimeout(_saveDebounceTimer); _saveDebounceTimer = null; }
  const pending = { ..._pendingChanges };
  const keys = Object.keys(pending);
  if (!keys.length) return;
  _pendingChanges = {};
  // Send one per-key update each (the server merges per key), never the whole
  // settings object, which would replace the file and clobber keys another tab
  // or browser wrote since load.
  for (const key of keys) {
    const payload = JSON.stringify({ key, value: pending[key] });
    let sent = false;
    try {
      const blob = new Blob([payload], { type: "application/json" });
      sent = !!(navigator.sendBeacon && navigator.sendBeacon("/sidebar_gallery/settings", blob));
    } catch { }
    if (!sent) {
      try { fetch("/sidebar_gallery/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }); } catch { }
    }
  }
}

let _flushHooksInstalled = false;
function _installFlushHooks() {
  if (_flushHooksInstalled || typeof window === "undefined") return;
  _flushHooksInstalled = true;
  // pagehide covers tab close / navigation; visibilitychange covers tab switch /
  // minimize - both flush any debounced changes so nothing is lost.
  window.addEventListener("pagehide", flushSettingsNow);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSettingsNow(); });
}

/**
 * Save a single setting by key. Updates in-memory cache immediately
 * and debounces the POST to the server.
 */
export function saveSetting(key, value) {
  _diskSettings[key] = value;
  _pendingChanges[key] = value;

  // Debounce the disk write
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushSettings, _SAVE_DEBOUNCE_MS);
}

/**
 * Flush all pending setting changes to the server.
 */
async function _flushSettings() {
  _saveDebounceTimer = null;
  const toSave = { ..._pendingChanges };
  _pendingChanges = {};

  // Persist each changed key with a per-key update. The server merges per key,
  // so the whole settings file is never replaced; replacing it would clobber
  // keys another tab/browser saved since load (cross-client data loss).
  // Sequential awaits avoid a read-modify-write race between these writes.
  for (const key of Object.keys(toSave)) {
    try {
      await fetch("/sidebar_gallery/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: toSave[key] }),
      });
    } catch (e) {
      console.warn("[SBG] Failed to save setting", key, e);
    }
  }
}

/**
 * Read a setting value, synchronously, from the in-memory disk-settings cache.
 * The disk file (loaded by loadSettings()) is the single source of truth.
 */
export function getSetting(id, fallback) {
  if (_diskSettingsLoaded && id in _diskSettings) {
    return _diskSettings[id];
  }
  return fallback;
}

/* ── Layout config reader (single source of truth) ──────────────── */

/**
 * Read the current layout config from the disk-settings cache.
 */
export function getLayout() {
  if (_diskSettingsLoaded && _diskSettings["SBG.Layout"]) {
    const layout = _diskSettings["SBG.Layout"];
    if (typeof layout === "object") return layout;
  }
  return {};
}


/* ── KV Row helper ──────────────────────────────────────────────── */

/**
 * Build a key-value metadata row.
 * @param {string} label - The label to display
 * @param {*} value - The value to display
 * @param {Object} [layout] - Layout config for label renames. If omitted, reads from getLayout().
 * @returns {HTMLElement|null} The row element, or null if value is empty
 */
/** For a long filename-ish value, return a DocumentFragment with <wbr> break
 *  opportunities inserted after underscore/dot/hyphen runs, so the browser can
 *  wrap at those boundaries. CSS only soft-wraps at spaces/existing hyphens, so
 *  "umt5_xxl_fp8_e4m3fn_scaled.safetensors" would otherwise never break at its
 *  underscores. Short, spaced, or separator-free strings stay a plain text node. */
export function breakable(value) {
  const s = value == null ? "" : String(value);
  const frag = document.createDocumentFragment();
  if (s.length < 16 || /\s/.test(s) || !/[_./\\-]/.test(s)) {
    frag.appendChild(document.createTextNode(s));
    return frag;
  }
  const chunks = s.match(/[^_.\-/\\]*[_.\-/\\]+|[^_.\-/\\]+$/g) || [s];
  chunks.forEach((chunk, i) => {
    frag.appendChild(document.createTextNode(chunk));
    if (i < chunks.length - 1) frag.appendChild(document.createElement("wbr"));
  });
  return frag;
}

export function kvRow(label, value, layout) {
  if (value === undefined || value === null || value === "") return null;
  const _ly = layout || getLayout();
  const _lyRenames = _ly.renames || {};
  const _lbl = label == null ? "" : String(label);
  const displayLabel = _lyRenames[_lbl] || _lyRenames[_lbl.toLowerCase()] || _lbl;
  const row = h("div", { class: "sbg-meta-row" });
  // A blank label (the user cleared the field name) shows just the value, with no
  // empty "Label:" column in front of it.
  if (String(displayLabel).trim() !== "") {
    row.appendChild(h("span", { class: "sbg-meta-label", text: displayLabel }));
  } else {
    row.classList.add("sbg-meta-row--nolabel");
  }
  const valSpan = h("span", { class: "sbg-meta-value" });
  valSpan.appendChild(breakable(value));
  row.appendChild(valSpan);
  return row;
}

/* ── Alpha-aware colour model ───────────────────────────────────────
 * One canonical representation so the pickers, swatches and rendering never
 * disagree. parseColor() understands hex (#rgb/#rgba/#rrggbb/#rrggbbaa), rgb()
 * and rgba(); formatColor() emits plain hex when fully opaque and rgba() when
 * translucent, so opaque colours stay untouched while transparency is preserved
 * end-to-end. (named colours / var() return null, caller keeps raw.) */

/** Parse any hex / rgb / rgba string to {r,g,b,a} (a in 0..1), or null. */
export function parseColor(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  if (s[0] === "#") {
    let hx = s.slice(1);
    if (hx.length === 3 || hx.length === 4) hx = hx.split("").map(c => c + c).join("");
    if (hx.length !== 6 && hx.length !== 8) return null;
    const r = parseInt(hx.slice(0, 2), 16), g = parseInt(hx.slice(2, 4), 16), b = parseInt(hx.slice(4, 6), 16);
    const a = hx.length === 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b, a].some(n => Number.isNaN(n))) return null;
    return { r, g, b, a };
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(/[,\/\s]+/).map(x => x.trim()).filter(Boolean);
    if (p.length < 3) return null;
    const r = Math.round(parseFloat(p[0])), g = Math.round(parseFloat(p[1])), b = Math.round(parseFloat(p[2]));
    let a = p.length >= 4 ? parseFloat(p[3]) : 1;
    if ([r, g, b, a].some(n => Number.isNaN(n))) return null;
    const clamp = (n, hi) => Math.max(0, Math.min(hi, n));
    return { r: clamp(r, 255), g: clamp(g, 255), b: clamp(b, 255), a: clamp(a, 1) };
  }
  return null;
}

/** Format r,g,b (0..255) + a (0..1) as a CSS string: hex when opaque, rgba when not. */
export function formatColor(r, g, b, a = 1) {
  const c = (n, hi) => Math.max(0, Math.min(hi, Math.round(n)));
  r = c(r, 255); g = c(g, 255); b = c(b, 255);
  a = Math.max(0, Math.min(1, a));
  if (a >= 1) {
    const hx = n => n.toString(16).padStart(2, "0");
    return "#" + hx(r) + hx(g) + hx(b);
  }
  return formatRgba(r, g, b, a);
}

/** Always-rgba string "rgba(r, g, b, a)": channels clamped to 0..255, alpha
 *  clamped to 0..1 and rounded to 3 decimals. Unlike formatColor() this never
 *  collapses to hex; used where the UI must always read rgba (the colour picker
 *  and the settings colour inputs). */
export function formatRgba(r, g, b, a = 1) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n)));
  a = Math.max(0, Math.min(1, a));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** RGB (0..255) → [h(0..360), s(0..100), l(0..100)]. */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, s = 0, l = (max + min) / 2;
  if (d > 0) { s = d / (1 - Math.abs(2 * l - 1)); h = max === r ? ((g - b) / d + 6) % 6 * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60; }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/** HSL (h 0..360, s/l 0..100) → [r,g,b] (0..255). */
export function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** A `background` value that shows `color` over a checkerboard, so any transparency
 *  is visible (used by swatches/previews so translucent colours read correctly). */
const _CHECKER = "repeating-conic-gradient(#6b6b6b 0% 25%, #9a9a9a 0% 50%) 50% / 12px 12px";
export function checkerBg(color) { return color ? `linear-gradient(${color}, ${color}), ${_CHECKER}` : _CHECKER; }

/* ── Saved colors palette ───────────────────────────────────────── */

const _SAVED_COLORS_KEY = "SBG.SavedColors";

export function getSavedColors() {
  try { return JSON.parse(localStorage.getItem(_SAVED_COLORS_KEY)) || []; }
  catch { return []; }
}

export function saveSavedColors(arr) {
  localStorage.setItem(_SAVED_COLORS_KEY, JSON.stringify(arr.slice(0, 12)));
}

/* ── Search highlight ───────────────────────────────────────────── */

/**
 * Walk all text nodes in container and wrap query matches in <mark>.
 */
export function highlightSearchMatches(container, query) {
  if (!query) return;
  // Match case-insensitively and treat spaces / underscores / hyphens as
  // interchangeable, so a value-token like "denoising_strength" highlights the
  // humanized label "Denoising Strength" (and "denoising strength" works too).
  const esc = String(query).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = esc.replace(/[\s_-]+/g, "[\\s_-]+");
  if (!pattern) return;
  let re;
  try { re = new RegExp(pattern, "gi"); } catch { return; }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const text = node.textContent;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    // Skip nodes inside <pre> or buttons
    if (node.parentElement?.closest("pre, button, .sbg-section__head")) continue;
    const frag = document.createDocumentFragment();
    let lastIdx = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      const mark = document.createElement("mark");
      mark.className = "sbg-highlight";
      mark.textContent = m[0];
      frag.appendChild(mark);
      lastIdx = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++; // never loop on a zero-length match
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));

    // If parent is a flex container, wrap in a single inline span so that
    // the span is ONE flex child and internal text+mark flow inline without gaps
    const parentStyle = node.parentElement ? getComputedStyle(node.parentElement).display : "";
    if (parentStyle === "flex" || parentStyle === "inline-flex") {
      const wrapper = document.createElement("span");
      wrapper.appendChild(frag);
      node.parentNode.replaceChild(wrapper, node);
    } else {
      node.parentNode.replaceChild(frag, node);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   i18n – Lightweight translation layer
   Auto-detects locale from navigator.language; falls back to English.
   ═══════════════════════════════════════════════════════════════════════ */

const _SBG_I18N = {
  // ── sbg-core.js ──
  "core.just_now":           { en: "just now",       zh: "刚刚" },
  "core.m_ago":              { en: "{n}m ago",       zh: "{n}分钟前" },
  "core.h_ago":              { en: "{n}h ago",       zh: "{n}小时前" },
  "core.d_ago":              { en: "{n}d ago",       zh: "{n}天前" },
  "core.nothing_to_copy":    { en: "Nothing to copy",zh: "没有可复制的内容" },
  "core.copied":             { en: "Copied",         zh: "已复制" },
  "core.copy_failed":        { en: "Copy failed",    zh: "复制失败" },
  "core.scanning":           { en: "Scanning folder… {n} found", zh: "正在扫描文件夹… 找到 {n} 个文件" },
  "core.indexing_failed":    { en: "Indexing failed: {e}",       zh: "索引失败: {e}" },

  // ── sidebar_gallery.js ──
  "sidebar.title":           { en: "Gallery",        zh: "图库" },
  "sidebar.tooltip":         { en: "Sidebar Gallery",zh: "侧边栏图库" },
  "sidebar.no_workflow":     { en: "No workflow data in this image", zh: "此图片中没有工作流数据" },
  "sidebar.workflow_loaded": { en: "Workflow loaded from drag & drop!", zh: "已通过拖放加载工作流！" },
  "sidebar.loaded_into":     { en: "Loaded image into {n}", zh: "已将图片加载到 {n}" },
  "sidebar.load_failed":     { en: "Failed to load: {e}",   zh: "加载失败: {e}" },

  // ── sbg-gallery.js ──
  "gallery.all_folders":     { en: "All folders",    zh: "所有文件夹" },
  "gallery.all":             { en: "All",            zh: "全部" },
  "gallery.images_only":     { en: "Images only",    zh: "仅图片" },
  "gallery.videos_only":     { en: "Videos only",    zh: "仅视频" },
  "gallery.audio_only":      { en: "Audio only",     zh: "仅音频" },
  "gallery.mesh_only":       { en: "3D only",        zh: "仅3D" },
  "gallery.show_all_files":  { en: "Show all files", zh: "显示所有文件" },
  "gallery.settings":        { en: "Gallery Settings", zh: "图库设置" },
  "gallery.ready":           { en: "Ready",          zh: "就绪" },
  "gallery.refresh_tip":     { en: "Refresh gallery (rescan disk)", zh: "刷新图库（重新扫描磁盘）" },
  "gallery.clear_search":    { en: "Clear search",   zh: "清除搜索" },
  "gallery.search_ph":       { en: "Search all fields… (name: for filename only)", zh: "搜索所有字段…（name: 仅搜文件名）" },
  "gallery.search_tip":      { en: "Search across all metadata fields. Press Enter to add as a tag. Use name: for filename-only, model: lora: prompt: keyword: sampler: controlnet: for specific fields", zh: "搜索所有元数据字段。按 Enter 添加为标签。使用 name: 仅搜文件名，model: lora: prompt: keyword: sampler: controlnet: 搜索特定字段" },
  "gallery.sort_tip":        { en: "Sort order",     zh: "排序方式" },
  "gallery.click_change_root":{ en: "Click to change root", zh: "点击切换根目录" },
  "gallery.browse_folders":  { en: "Browse folders", zh: "浏览文件夹" },
  "gallery.toggle_and_or":   { en: "Toggle whether tags should match ALL requirements (AND) or ANY requirement (OR)", zh: "切换标签匹配模式：全部匹配(AND) 或 任意匹配(OR)" },
  "gallery.created_desc":    { en: "Created ↓",      zh: "创建时间 ↓" },
  "gallery.created_asc":     { en: "Created ↑",      zh: "创建时间 ↑" },
  "gallery.modified_desc":   { en: "Modified ↓",     zh: "修改时间 ↓" },
  "gallery.modified_asc":    { en: "Modified ↑",     zh: "修改时间 ↑" },
  "gallery.name_asc":        { en: "Name ↑",         zh: "名称 ↑" },
  "gallery.name_desc":       { en: "Name ↓",         zh: "名称 ↓" },
  "gallery.size_desc":       { en: "Size ↓",         zh: "大小 ↓" },
  "gallery.size_asc":        { en: "Size ↑",         zh: "大小 ↑" },
  "gallery.positive":        { en: "POSITIVE",       zh: "正面" },
  "gallery.negative":        { en: "NEGATIVE",       zh: "负面" },
  "gallery.filename":        { en: "FILENAME",       zh: "文件名" },
  "gallery.keyword":         { en: "KEYWORD",        zh: "关键词" },

  // ── First-time modal ──
  "gallery.building_index":  { en: "🗂️ Building Index for the First Time", zh: "🗂️ 首次构建索引" },
  "gallery.building_desc":   { en: "This will scan all media files and parse their metadata. This may take 2-10 minutes depending on library size.", zh: "将扫描所有媒体文件并解析元数据。根据库大小，可能需要 2-10 分钟。" },
  "gallery.start_indexing":  { en: "🚀 Start Indexing",  zh: "🚀 开始索引" },
  "gallery.skip_no_meta":    { en: "Skip (no metadata)", zh: "跳过（无元数据）" },
  "gallery.no_media":        { en: "No media found",     zh: "未找到媒体文件" },

  // ── sbg-lightbox.js ──
  "lb.prev":                 { en: "Previous ({k})",     zh: "上一张 ({k})" },
  "lb.next":                 { en: "Next ({k})",         zh: "下一张 ({k})" },
  "lb.close":                { en: "Close ({k})",        zh: "关闭 ({k})" },
  "lb.download":             { en: "⬇ Download",         zh: "⬇ 下载" },
  "lb.download_tip":         { en: "Download file",      zh: "下载文件" },
  "lb.load_wf":              { en: "Load Workflow",      zh: "加载工作流" },
  "lb.load_wf_tip":          { en: "Load workflow into ComfyUI", zh: "将工作流加载到 ComfyUI" },
  "lb.copy_prompt":          { en: "Copy Prompt",        zh: "复制提示词" },
  "lb.copy_prompt_tip":      { en: "Copy positive prompt", zh: "复制正面提示词" },
  "lb.copy_wf":              { en: "Copy WF",            zh: "复制工作流" },
  "lb.copy_wf_tip":          { en: "Copy workflow JSON",  zh: "复制工作流 JSON" },
  "lb.compare":              { en: "⚖ Compare",          zh: "⚖ 对比" },
  "lb.compare_tip":          { en: "Compare with another image (C)", zh: "与另一张图片对比 (C)" },
  "lb.exit_compare":         { en: "✕ Exit Compare",     zh: "✕ 退出对比" },
  "lb.loading_meta":         { en: "Loading metadata…",  zh: "正在加载元数据…" },
  "lb.no_meta":              { en: "No metadata",        zh: "无元数据" },
  "lb.generated":            { en: "Generated",          zh: "生成信息" },
  "lb.initial_image":        { en: "Initial Image",      zh: "初始图片" },
  "lb.source_image":         { en: "Source Image",       zh: "源图片" },
  "lb.loading_init_meta":    { en: "Loading initial image metadata…", zh: "正在加载初始图片元数据…" },
  "lb.source_meta_unavail":  { en: "Source image metadata unavailable", zh: "源图片元数据不可用" },
  "lb.loading_wf":           { en: "Loading…",           zh: "加载中…" },
  "lb.no_workflow":           { en: "No workflow data",   zh: "无工作流数据" },
  "lb.compare_with":         { en: "⚖ Comparing: {f}",   zh: "⚖ 对比中: {f}" },
  "lb.same":                 { en: "■ Same",             zh: "■ 相同" },
  "lb.changed":              { en: "■ Changed",          zh: "■ 已变更" },
  "lb.current_only":         { en: "■ Current only",     zh: "■ 仅当前" },
  "lb.compared_only":        { en: "■ Compared only",    zh: "■ 仅对比" },
  "lb.current":              { en: "Current",            zh: "当前" },
  "lb.compared":             { en: "Compared",           zh: "对比" },
  "lb.diff":                 { en: "DIFF",               zh: "差异" },
  "lb.same_label":           { en: "SAME",               zh: "相同" },
  "lb.error":                { en: "Error: {e}",         zh: "错误: {e}" },

  // ── sbg-settings.js ──
  "gs.title":                { en: "⚙ Gallery Settings",    zh: "⚙ 图库设置" },
  "gs.close":                { en: "Close",                  zh: "关闭" },
  "gs.tab_layout":           { en: "Layout",                 zh: "布局" },
  "gs.tab_appearance":       { en: "Appearance",             zh: "外观" },
  "gs.tab_keybindings":      { en: "Keybindings",            zh: "快捷键" },
  "gs.tab_settings":         { en: "Settings",               zh: "设置" },
  "gs.tab_presets":          { en: "Presets",                 zh: "预设" },
  "gs.tab_diagnostics":      { en: "Diagnostics",            zh: "诊断" },
  "gs.badge_colors":         { en: "Badge Colors",           zh: "徽章颜色" },
  "gs.high_badge":           { en: " Badge",                 zh: " 徽章" },
  "gs.low_badge":            { en: " Badge",                 zh: " 徽章" },
  "gs.video_badge":          { en: " Badge",                 zh: " 徽章" },
  "gs.search_badge":         { en: " Search Badge",          zh: " 搜索徽章" },
  "gs.exclude_badge":        { en: " Exclude Badge",         zh: " 排除徽章" },
  "gs.highlight_color":      { en: "Highlight Color",        zh: "高亮颜色" },
  "gs.search_highlight":     { en: "Search ",                zh: "搜索 " },
  "gs.theme":                { en: "Theme",                  zh: "主题" },
  "gs.gallery_theme":        { en: "Gallery Theme",          zh: "图库主题" },
  "gs.gallery_theme_tip":    { en: "Color theme for the gallery sidebar", zh: "图库侧边栏的配色主题" },
  "gs.custom_theme_desc":    { en: "Configure your own custom UI colors.", zh: "自定义你的 UI 颜色。" },
  "gs.background":           { en: "Background",             zh: "背景" },
  "gs.surface":              { en: "Surface",                zh: "表面" },
  "gs.border":               { en: "Border elements",        zh: "边框" },
  "gs.text":                 { en: "Text",                   zh: "文字" },
  "gs.accent":               { en: "Accent",                 zh: "强调色" },
  "gs.lb_btn_colors":        { en: "Lightbox Button Colors", zh: "灯箱按钮颜色" },
  "gs.lb_btn_colors_desc":   { en: "Leave blank for default colors.", zh: "留空使用默认颜色。" },
  "gs.app_badge_colors":     { en: "App Badge Colors",       zh: "应用徽章颜色" },
  "gs.app_badge_desc":       { en: "Customize the color of each source application badge. Leave blank for defaults.", zh: "自定义各来源应用徽章的颜色。留空使用默认值。" },
  "gs.initial_image_tab":    { en: "Initial Image Tab",      zh: "初始图片选项卡" },
  "gs.pill_colors":          { en: "Pill / Badge Colors",    zh: "药丸/徽章颜色" },
  "gs.pill_colors_desc":     { en: "Customize the color of metadata pills and badges. Leave empty for defaults.", zh: "自定义元数据药丸和徽章的颜色。留空使用默认值。" },
  "gs.pill_bg":              { en: "Background",             zh: "背景" },
  "gs.pill_text":            { en: "Text",                   zh: "文字" },
  "gs.pill_border":          { en: "Border",                 zh: "边框" },
  "gs.preview":              { en: "Preview:",               zh: "预览:" },
  "gs.kb_title":             { en: "Keyboard Shortcuts",     zh: "键盘快捷键" },
  "gs.kb_desc":              { en: "Comma-separated key names. Example: ArrowLeft,a", zh: "逗号分隔的按键名称。例如: ArrowLeft,a" },
  "gs.kb_prev":              { en: "Previous Image",         zh: "上一张图片" },
  "gs.kb_next":              { en: "Next Image",             zh: "下一张图片" },
  "gs.kb_close":             { en: "Close Lightbox",         zh: "关闭灯箱" },
  "gs.kb_toggle":            { en: "Toggle Gallery",         zh: "切换图库" },
  "gs.kb_refresh":           { en: "Refresh Gallery",        zh: "刷新图库" },
  "gs.kb_fullscreen":        { en: "Fullscreen",             zh: "全屏" },
  "gs.kb_download":          { en: "Download",               zh: "下载" },
  "gs.kb_copy_prompt":       { en: "Copy Prompt",            zh: "复制提示词" },
  "gs.kb_copy_wf":           { en: "Copy Workflow",          zh: "复制工作流" },
  "gs.kb_load_wf":           { en: "Load Workflow",          zh: "加载工作流" },
  "gs.kb_note":              { en: "Note: Arrows seek video in fullscreen. A/D always navigate.", zh: "注意: 全屏时方向键控制视频播放进度。A/D 始终用于导航。" },
  "gs.lb_actions":           { en: "Lightbox Actions",       zh: "灯箱操作" },
  "gs.gallery_section":      { en: "Gallery",                zh: "图库" },
  "gs.thumb_size":           { en: "Thumbnail Size (px)",    zh: "缩略图大小 (px)" },
  "gs.thumb_size_tip":       { en: "Size of thumbnail grid cells (64-256). Only used when Items Per Row is 'auto' - it decides how many columns fit.", zh: "缩略图网格单元大小(64-256)。仅当每行项目数为'auto'时使用 - 决定可容纳多少列。" },
  "gs.items_per_row":        { en: "Items Per Row",          zh: "每行项目数" },
  "gs.items_per_row_tip":    { en: "auto = fit as many as the Thumbnail Size allows. A number = ALWAYS that many per row; thumbnails are sized to fill the row based on their aspect ratios. Reopen the gallery to apply.", zh: "auto = 按缩略图大小自适应。数字 = 固定每行数量；缩略图根据宽高比自适应。重新打开图库生效。" },
  "gs.thumb_shape":          { en: "Thumbnail Shape",        zh: "缩略图形状" },
  "gs.thumb_shape_tip":      { en: "Square crops; AR preserves aspect ratio", zh: "正方形裁剪；AR 保持原始宽高比" },
  "gs.default_sort":         { en: "Default Sort",           zh: "默认排序" },
  "gs.default_sort_tip":     { en: "Default sort order for gallery items (matches the gallery's sort menu)", zh: "图库项目的默认排序（与图库排序菜单一致）" },
  "gs.scroll_buffer":        { en: "Scroll Buffer (rows)",   zh: "滚动缓冲区（行）" },
  "gs.scroll_buffer_tip":    { en: "Extra rows pre-rendered above/below viewport (2-30). Higher = less blank space on fast scroll, but more DOM nodes.", zh: "视口上方/下方预渲染的额外行数(2-30)。越高 = 快速滚动时空白越少，但 DOM 节点越多。" },
  "gs.auto_refresh":         { en: "Auto-refresh interval",  zh: "自动刷新间隔" },
  "gs.auto_refresh_tip":     { en: "How often the open gallery checks for files added, removed, or renamed on disk (minimum 5s). 0 turns off the background timer; the gallery still checks once when you come back to it. Applies right away.", zh: "打开的图库检查磁盘文件增删改的频率（最少5秒）。0 关闭后台定时器；切换回图库时仍会检查一次。立即生效。" },
  "gs.tooltips":             { en: "Tooltips",               zh: "工具提示" },
  "gs.show_filename":        { en: "Show Filename",          zh: "显示文件名" },
  "gs.show_filename_tip":    { en: "Show filename in card tooltip", zh: "在卡片工具提示中显示文件名" },
  "gs.show_filesize":        { en: "Show File Size",         zh: "显示文件大小" },
  "gs.show_filesize_tip":    { en: "Show file size in card tooltip", zh: "在卡片工具提示中显示文件大小" },
  "gs.show_date":            { en: "Show Date",              zh: "显示日期" },
  "gs.show_date_tip":        { en: "Show date in card tooltip", zh: "在卡片工具提示中显示日期" },
  "gs.lb_buttons":           { en: "Lightbox Buttons",       zh: "灯箱按钮" },
  "gs.lb_buttons_desc":      { en: "Show or hide individual buttons in the lightbox toolbar.", zh: "显示或隐藏灯箱工具栏中的各个按钮。" },
  "gs.dl_button":            { en: "Download Button",        zh: "下载按钮" },
  "gs.dl_button_tip":        { en: "Show download button in lightbox", zh: "在灯箱中显示下载按钮" },
  "gs.cp_button":            { en: "Copy Prompt Button",     zh: "复制提示词按钮" },
  "gs.cp_button_tip":        { en: "Show copy prompt button in lightbox", zh: "在灯箱中显示复制提示词按钮" },
  "gs.cwf_button":           { en: "Copy WF Button",         zh: "复制工作流按钮" },
  "gs.cwf_button_tip":       { en: "Show copy workflow button in lightbox", zh: "在灯箱中显示复制工作流按钮" },
  "gs.lwf_button":           { en: "Load Workflow Button",   zh: "加载工作流按钮" },
  "gs.lwf_button_tip":       { en: "Show load workflow button in lightbox", zh: "在灯箱中显示加载工作流按钮" },
  "gs.metadata":             { en: "Metadata",               zh: "元数据" },
  "gs.default_tab_view":     { en: "Default Tab View",       zh: "默认选项卡视图" },
  "gs.default_tab_view_tip": { en: "Which tab opens first in tabbed sections. For prompt sections this picks Enhanced or Original; 'Remember' keeps your last-opened tab on every tabbed section.", zh: "选项卡区域默认打开哪个。对于提示词区域选择增强版或原始版；'记住'会保留上次打开的选项卡。" },
  "gs.prompt_padding":       { en: "Prompt Padding",         zh: "提示词内边距" },
  "gs.prompt_padding_tip":   { en: "Horizontal padding inside prompt text boxes (in px); top/bottom run 2px tighter.", zh: "提示词文本框内的水平内边距(px)；上下内边距少2px。" },
  "gs.filename_display":     { en: "Filename Display",       zh: "文件名显示" },
  "gs.filename_display_tip": { en: "Show just the filename or the full relative path in File Info.", zh: "在文件信息中显示文件名或完整相对路径。" },
  "gs.model_display":        { en: "Model Display",          zh: "模型显示" },
  "gs.model_display_tip":    { en: "Show model and LoRA names as just the filename (basename) or the full relative path.", zh: "显示模型和 LoRA 名称时使用文件名或完整相对路径。" },
  "gs.remember_tab":         { en: "Remember Metadata Tab",  zh: "记住元数据选项卡" },
  "gs.remember_tab_tip":     { en: "Keep the active metadata tab (Generated/Initial Image) when navigating between images.", zh: "在图片间导航时保持活动的元数据选项卡（生成信息/初始图片）。" },
  "gs.folders":              { en: "Folders",                zh: "文件夹" },
  "gs.folders_desc":         { en: "Extra folders to browse and index alongside ComfyUI's output folder. Paths are on the machine running ComfyUI.", zh: "除 ComfyUI 输出文件夹外，额外浏览和索引的文件夹。路径为运行 ComfyUI 的机器上的路径。" },
  "gs.output":               { en: "Output",                 zh: "输出" },
  "gs.output_desc":          { en: "ComfyUI's output folder", zh: "ComfyUI 的输出文件夹" },
  "gs.builtin":              { en: "built-in",               zh: "内置" },
  "gs.add":                  { en: "+ Add",                  zh: "+ 添加" },
  "gs.folder_removed":       { en: "Folder removed",         zh: "文件夹已移除" },
  "gs.remove_folder_tip":    { en: "Remove this folder from the gallery (files on disk are not touched)", zh: "从图库中移除此文件夹（不删除磁盘上的文件）" },
  "gs.folder_added":         { en: "Folder added - it will be indexed when you open it", zh: "文件夹已添加 - 打开时将被索引" },
  "gs.folder_not_added":     { en: "Folder not added - check the path exists on the ComfyUI machine", zh: "文件夹未添加 - 请检查路径在 ComfyUI 机器上是否存在" },
  "gs.excluded_folders":     { en: "Excluded folders",       zh: "排除的文件夹" },
  "gs.excluded_folders_desc":{ en: "Folder names to skip while scanning (e.g. thumbnails, backup). Matching is by folder name, not full path, and is not case-sensitive. Changes take effect on the next scan.", zh: "扫描时跳过的文件夹名（如 thumbnails, backup）。按文件夹名匹配，不区分大小写。更改在下次扫描时生效。" },
  "gs.include_hidden":       { en: "Include hidden folders", zh: "包含隐藏文件夹" },
  "gs.include_hidden_tip":   { en: "Also scan folders whose names start with a dot (e.g. .thumbs). Off by default - hidden folders are skipped.", zh: "同时扫描以点开头的文件夹（如 .thumbs）。默认关闭 - 跳过隐藏文件夹。" },
  "gs.hidden_scanned":       { en: "Hidden folders will be scanned on the next scan", zh: "隐藏文件夹将在下次扫描时被扫描" },
  "gs.hidden_skipped":       { en: "Hidden folders will be skipped on the next scan", zh: "隐藏文件夹将在下次扫描时被跳过" },
  "gs.no_excluded":          { en: "No extra folders excluded.", zh: "没有额外排除的文件夹。" },
  "gs.stop_excluding_tip":   { en: "Stop excluding this folder (its files reappear on the next scan)", zh: "停止排除此文件夹（文件将在下次扫描时重新出现）" },
  "gs.folder_no_longer":     { en: "Folder no longer excluded - it will be re-indexed on the next scan", zh: "文件夹不再排除 - 将在下次扫描时重新索引" },
  "gs.enter_folder_name":    { en: "Enter a folder name to exclude", zh: "请输入要排除的文件夹名" },
  "gs.already_excluded":     { en: "Already excluded",       zh: "已被排除" },
  "gs.folder_excluded":      { en: "Folder excluded - it will be skipped on the next scan", zh: "文件夹已排除 - 将在下次扫描时被跳过" },
  "gs.presets":              { en: "Presets",                 zh: "预设" },
  "gs.presets_desc":         { en: "Save and load gallery configuration presets.", zh: "保存和加载图库配置预设。" },
  "gs.layout":               { en: " Layout",                zh: " 布局" },
  "gs.colors":               { en: " Colors",                zh: " 颜色" },
  "gs.settings_label":       { en: " Settings",              zh: " 设置" },
  "gs.keybindings_label":    { en: " Keybindings",           zh: " 快捷键" },
  "gs.preset_name":          { en: "Preset name",            zh: "预设名称" },
  "gs.save_preset":          { en: "💾 Save Preset",         zh: "💾 保存预设" },
  "gs.enter_preset_name":    { en: "Enter a preset name",    zh: "请输入预设名称" },
  "gs.preset_saved":         { en: "Preset \"{n}\" saved",   zh: "预设 \"{n}\" 已保存" },
  "gs.saved_presets":        { en: "Saved Presets",          zh: "已保存的预设" },
  "gs.load":                 { en: "Load",                   zh: "加载" },
  "gs.sure":                 { en: "Sure?",                  zh: "确定？" },
  "gs.preset_loaded":        { en: "Preset \"{n}\" loaded. Refresh gallery to apply.", zh: "预设 \"{n}\" 已加载。刷新图库以应用。" },
  "gs.import":               { en: "Import",                 zh: "导入" },
  "gs.import_preset":        { en: "📥 Import Preset",       zh: "📥 导入预设" },
  "gs.invalid_preset":       { en: "Invalid preset file",    zh: "无效的预设文件" },
  "gs.preset_imported":      { en: "Preset \"{n}\" imported", zh: "预设 \"{n}\" 已导入" },
  "gs.import_error":         { en: "Import error: {e}",      zh: "导入错误: {e}" },
  "gs.server_themes":        { en: "Server Themes",          zh: "服务器主题" },
  "gs.server_themes_desc":   { en: "Presets stored in the extension's themes/ folder. Persist across reinstalls.", zh: "存储在扩展 themes/ 文件夹中的预设。重装后仍然保留。" },
  "gs.loading":              { en: "Loading...",              zh: "加载中..." },
  "gs.no_server_themes":     { en: "No server themes found.", zh: "未找到服务器主题。" },
  "gs.server_theme_loaded":  { en: "Server theme \"{n}\" loaded. Refresh gallery to apply.", zh: "服务器主题 \"{n}\" 已加载。刷新图库以应用。" },
  "gs.save_to_server":       { en: "💾 Save to Server",      zh: "💾 保存到服务器" },
  "gs.theme_saved_server":   { en: "Theme \"{n}\" saved to server", zh: "主题 \"{n}\" 已保存到服务器" },
  "gs.diagnostics":          { en: "Diagnostics & Tools",    zh: "诊断与工具" },
  "gs.refresh":              { en: "🔃 Refresh",             zh: "🔃 刷新" },
  "gs.refresh_tip":          { en: "Re-fetch all items from the server and refresh the gallery view", zh: "从服务器重新获取所有项目并刷新图库视图" },
  "gs.refreshing":           { en: "Refreshing…",            zh: "正在刷新…" },
  "gs.gallery_refreshed":    { en: "Gallery refreshed",      zh: "图库已刷新" },
  "gs.rebuild_db":           { en: "🔄 Rebuild DB Index",    zh: "🔄 重建数据库索引" },
  "gs.rebuild_db_tip":       { en: "Rescan all roots and rebuild metadata/tag index on server", zh: "重新扫描所有根目录并重建服务器上的元数据/标签索引" },
  "gs.rebuilding":           { en: "🔄 Rebuilding DB... ({p}%)", zh: "🔄 正在重建数据库... ({p}%)" },
  "gs.db_success":           { en: "🔄 DB Indexed Successfully!", zh: "🔄 数据库索引成功！" },
  "gs.db_busy":              { en: "Couldn't start - another scan is running", zh: "无法启动 - 另一个扫描正在运行" },
  "gs.cache_meta":           { en: "📦 Cache All Metadata",  zh: "📦 缓存所有元数据" },
  "gs.cache_meta_tip":       { en: "Fetch and cache metadata summaries for all files to IndexedDB", zh: "获取所有文件的元数据摘要并缓存到 IndexedDB" },
  "gs.caching":              { en: "Caching…",               zh: "缓存中…" },
  "gs.meta_cached":          { en: "Metadata cached: {n} items", zh: "元数据已缓存: {n} 项" },
  "gs.cache_thumbs":         { en: "🖼️ Cache Thumbnails",   zh: "🖼️ 缓存缩略图" },
  "gs.cache_thumbs_tip":     { en: "Cache all lazy-load thumbnails into the local browser IndexedDB", zh: "将所有延迟加载的缩略图缓存到浏览器 IndexedDB" },
  "gs.thumbs_cached":        { en: "Thumbnails cached: {n} items", zh: "缩略图已缓存: {n} 项" },
  "gs.clear_meta_cache":     { en: "🗑️ Clear Meta Cache",   zh: "🗑️ 清除元数据缓存" },
  "gs.clear_meta_tip":       { en: "Clear browser IndexedDB metadata cache", zh: "清除浏览器 IndexedDB 元数据缓存" },
  "gs.meta_cache_cleared":   { en: "Metadata cache cleared",  zh: "元数据缓存已清除" },
  "gs.clear_thumb_cache":    { en: "🗑️ Clear Thumb Cache",  zh: "🗑️ 清除缩略图缓存" },
  "gs.clear_thumb_tip":      { en: "Clear browser IndexedDB thumbnails cache", zh: "清除浏览器 IndexedDB 缩略图缓存" },
  "gs.thumb_cache_cleared":  { en: "Thumbnails cache cleared", zh: "缩略图缓存已清除" },
  "gs.nuclear_clear":        { en: "💣 Nuclear Clear All",   zh: "💣 全部清除" },
  "gs.nuclear_tip":          { en: "Delete ALL browser cache databases (including legacy), reset version tracking, clean up old settings keys, and reload. Fixes any corruption.", zh: "删除所有浏览器缓存数据库（包括旧版），重置版本跟踪，清理旧设置键并重新加载。修复任何损坏。" },
  "gs.nuclear_confirm":      { en: "⚠️ Sure? This will reload the page", zh: "⚠️ 确定？这将重新加载页面" },
  "gs.sqlite_index":         { en: "SQLite Index",           zh: "SQLite 索引" },
  "gs.sqlite_index_tip":     { en: "Server-side SQLite database that stores the file listing and parsed metadata summaries for fast gallery loading without disk scanning", zh: "服务器端 SQLite 数据库，存储文件列表和解析后的元数据摘要，用于无需磁盘扫描的快速图库加载" },
  "gs.db_path":              { en: "DB Path",                zh: "数据库路径" },
  "gs.db_path_tip":          { en: "Full filesystem path of the SQLite database file", zh: "SQLite 数据库文件的完整文件系统路径" },
  "gs.db_size":              { en: "DB Size",                zh: "数据库大小" },
  "gs.db_size_tip":          { en: "Size of the SQLite database file on disk", zh: "磁盘上 SQLite 数据库文件的大小" },
  "gs.server_thumbs":        { en: "Server Thumbnails",      zh: "服务器缩略图" },
  "gs.server_thumbs_tip":    { en: "JPEG thumbnails generated and stored on the server in the .thumbs folder. Shared across all browsers/clients. No in-memory cache - served directly from disk on each request.", zh: "在服务器 .thumbs 文件夹中生成和存储的 JPEG 缩略图。所有浏览器/客户端共享。无内存缓存 - 每次请求直接从磁盘提供。" },
  "gs.count":                { en: "Count",                  zh: "数量" },
  "gs.size":                 { en: "Size",                   zh: "大小" },
  "gs.browser_thumb_cache":  { en: "Browser Thumb Cache",    zh: "浏览器缩略图缓存" },
  "gs.browser_thumb_tip":    { en: "Thumbnails cached in this browser's IndexedDB for instant loading without server requests.", zh: "缓存在浏览器 IndexedDB 中的缩略图，可即时加载无需服务器请求。" },
  "gs.cached":               { en: "Cached",                 zh: "已缓存" },
  "gs.browser_meta_cache":   { en: "Browser Meta Cache",     zh: "浏览器元数据缓存" },
  "gs.browser_meta_tip":     { en: "Parsed metadata summaries cached in IndexedDB and in-memory.", zh: "解析后的元数据摘要缓存在 IndexedDB 和内存中。" },
  "gs.indexed_db":           { en: "IndexedDB",              zh: "IndexedDB" },
  "gs.in_memory":            { en: "In-memory",              zh: "内存中" },
  "gs.in_memory_tip":        { en: "Metadata entries in JS memory for this session", zh: "本次会话中 JS 内存中的元数据条目" },
  "gs.files":                { en: " files",                 zh: " 个文件" },
  "gs.entries":              { en: " entries",               zh: " 条目" },
  "gs.thumbs":               { en: " thumbs",                zh: " 个缩略图" },

  // ── sbg-layout-editor.js ──
  "le.images":               { en: "Images",                 zh: "图片" },
  "le.videos":               { en: "Videos",                 zh: "视频" },
  "le.clone_images":         { en: "⇐ Clone Images",         zh: "⇐ 克隆图片布局" },
  "le.cloned":               { en: "Cloned image layout to video", zh: "已将图片布局克隆到视频" },
  "le.reset":                { en: "↺ Reset",                zh: "↺ 重置" },
  "le.profile_reset":        { en: "Profile reset to default", zh: "配置已重置为默认值" },
  "le.hint":                 { en: "Drag ⋮⋮ to reorder. Expand a section to edit its fields, or drag fields in from the tray below. The right pane previews your panel live.", zh: "拖动 ⋮⋮ 重新排序。展开区域编辑字段，或从下方托盘拖入字段。右侧面板实时预览。" },
  "le.add_section":          { en: "+ Add Section",          zh: "+ 添加区域" },
  "le.new_section":          { en: "New Section",            zh: "新区域" },
  "le.drag_reorder":         { en: "Drag to reorder section",zh: "拖动以重新排序区域" },
  "le.expand_collapse":      { en: "Expand / collapse fields", zh: "展开/折叠字段" },
  "le.hidden_from_panel":    { en: "Hidden from panel — click to show", zh: "面板中已隐藏 - 点击显示" },
  "le.shown_in_panel":       { en: "Shown in panel — click to hide", zh: "面板中已显示 - 点击隐藏" },
  "le.section_title":        { en: "Section title",          zh: "区域标题" },
  "le.section_colors":       { en: "Section background / colours", zh: "区域背景/颜色" },
  "le.expanded_default":     { en: "Expanded by default in the panel", zh: "面板中默认展开" },
  "le.open":                 { en: "open",                   zh: "展开" },
  "le.delete_section":       { en: "Delete section",         zh: "删除区域" },
  "le.cards_from":           { en: "Cards from:",            zh: "卡片来源:" },
  "le.cards_from_help":      { en: "Leave empty for one card per whole image, or set a source like 'loras' to render one card per item in that array.", zh: "留空为每张图片一个卡片，或设置来源如 'loras' 为该数组的每个项目渲染一个卡片。" },
  "le.show_when":            { en: "Show when:",             zh: "显示条件:" },
  "le.show_when_help":       { en: "Show this section only when a specific app is the source. Empty = always show.", zh: "仅当特定应用为来源时显示此区域。留空 = 始终显示。" },
  "le.pair_highlow":         { en: "pair high/low",          zh: "配对高/低" },
  "le.pair_highlow_tip":     { en: "Pair high-noise / low-noise models side-by-side (Wan2.2-style MoE)", zh: "将高噪声/低噪声模型并排配对（Wan2.2 风格 MoE）" },
  "le.section_bg_tip":       { en: "Color for {app} source badge", zh: "{app} 来源徽章的颜色" },

  // ── Context menu ──
  "ctx.preview":             { en: "Preview",                zh: "预览" },
  "ctx.download":            { en: "Download",               zh: "下载" },
  "ctx.insert_node":        { en: "Insert as Node",         zh: "作为节点插入" },
  "ctx.load_workflow":       { en: "Load Workflow",          zh: "加载工作流" },
  "ctx.copy_prompt":         { en: "Copy Prompt",            zh: "复制提示词" },
  "ctx.export_workflow":     { en: "Export Workflow",         zh: "导出工作流" },
  "ctx.copy_path":           { en: "Copy Path",              zh: "复制路径" },
  "ctx.open_explorer":       { en: "Open in Explorer",       zh: "在资源管理器中打开" },
  "ctx.delete":              { en: "Delete",                 zh: "删除" },
  "ctx.delete_confirm":      { en: "Delete \"{f}\"?",        zh: "确定删除 \"{f}\"？" },

  // ── Section display names (used in search match badges) ──
  "section.file_info":       { en: "File Info",              zh: "文件信息" },
  "section.models":          { en: "Models",                 zh: "模型" },
  "section.positive":        { en: "Positive Prompt",        zh: "正面提示词" },
  "section.negative":        { en: "Negative Prompt",        zh: "负面提示词" },
  "section.initial_prompt":  { en: "Original Prompt (pre-enhance)", zh: "原始提示词（增强前）" },
  "section.sampling":        { en: "Sampling",               zh: "采样" },
  "section.loras":           { en: "LoRAs",                  zh: "LoRAs" },
  "section.controlnet":      { en: "ControlNet",             zh: "ControlNet" },
  "section.adetailer":       { en: "ADetailer",              zh: "ADetailer" },
  "section.upscaling":       { en: "Upscaling",              zh: "放大" },
  "section.interpolation":   { en: "Interpolation",          zh: "插值" },
  "section.mmaudio":         { en: "MMAudio",                zh: "MMAudio" },
  "section.extra":           { en: "Extra Metadata",         zh: "额外元数据" },
  "section.workflow_nodes":  { en: "Workflow Nodes",         zh: "工作流节点" },
  "section.raw":             { en: "Raw Metadata",           zh: "原始元数据" },
};

let _sbgLang = null;

/** Detect locale: returns "zh" for Chinese, "en" otherwise. */
function _detectLocale() {
  const nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
  return nav.startsWith("zh") ? "zh" : "en";
}

/** Translate a key. Falls back to English if missing. Supports {k} placeholders. */
export function t(key, replacements) {
  if (_sbgLang === null) _sbgLang = _detectLocale();
  const entry = _SBG_I18N[key];
  let str = entry ? (entry[_sbgLang] || entry.en) : key;
  if (replacements) {
    for (const [k, v] of Object.entries(replacements)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
  }
  return str;
}

/** Get current language code ("en" or "zh"). */
export function getLang() {
  if (_sbgLang === null) _sbgLang = _detectLocale();
  return _sbgLang;
}
