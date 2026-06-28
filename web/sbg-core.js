/**
 * sbg-core.js — Shared utilities, caches, IndexedDB, settings, icons
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
  _lastServerTime: 0, // timestamp from last server response (for delta refresh)
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

export async function _persistItems(rootId, items) {
  try {
    const db = await _openIDB();
    const tx = db.transaction(_IDB_STORE, "readwrite");
    const store = tx.objectStore(_IDB_STORE);
    store.put({ items, ts: Date.now() }, rootId);
    db.close();
  } catch (e) { /* IndexedDB not available — silently fail */ }
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
          resolve(data.items);
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
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
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
  if (text == null || text === "") { showToast("Nothing to copy"); return; }
  const str = String(text);
  // navigator.clipboard only exists in a secure context (https or localhost).
  // ComfyUI is frequently served over plain HTTP on a LAN IP, where it is
  // undefined — fall back to the legacy execCommand path so copy still works.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(str)
      .then(() => showToast("Copied"))
      .catch(() => { if (!_copyFallback(str)) showToast("Copy failed"); });
    return;
  }
  if (!_copyFallback(str)) showToast("Copy failed");
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
    if (ok) showToast("Copied");
    return ok;
  } catch {
    return false;
  }
}

export function fileUrl(it) {
  // Append the file's modification time (in MILLISECONDS) so the URL is
  // content-addressed: an unchanged file keeps a stable URL (browser-cacheable —
  // /file responds with immutable Cache-Control), while a regenerated file gets a
  // fresh URL and so bypasses the now-stale cached bytes. Millisecond precision so
  // a same-second overwrite of a fixed-name file still busts the immutable cache.
  const v = Math.floor((it.mtime_real ?? it.mtime ?? 0) * 1000);
  return `/sidebar_gallery/file?root_id=${encodeURIComponent(it.root_id)}&relpath=${encodeURIComponent(it.relpath)}&v=${v}`;
}

export function isVideo(it) { return it.kind === "video"; }

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
      // Never revoke an object URL still shown by a visible card — doing so
      // turns live thumbnails into broken images. Skip in-use entries; the
      // viewport holds far fewer than the cache cap so eviction still drains.
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
    } catch { /* IndexedDB not available — fall through */ }
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
   *  evict down to 75% in ONE readwrite transaction (count + deletes share the
   *  transaction, so there's no count-then-clear race) instead of nuking the whole
   *  warm cache — evicted thumbnails re-fetch from the server's disk cache on
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
// we retry a few times before giving up — this replaces the old behaviour where a
// miss was only retried on the next full rescan re-render.
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
          // item by the time the fetch resolves — don't inject a stale thumbnail.
          if (!wrap.isConnected || wrap._sbgItem !== item) return;
          // getOrFetch resolves to the raw URL (not a blob:) on a miss — e.g. a
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
 * across — a thumb-size change re-runs initGallery (reusing module-level state),
 * unlike a full page refresh which resets everything. Stale observed wraps were a
 * source of thumbnails being injected into the wrong cards after a remount.
 */
export function resetThumbObserver() {
  if (_thumbObserver) { try { _thumbObserver.disconnect(); } catch { } _thumbObserver = null; }
}

/**
 * Forget thumbnail URLs that previously failed to load, so a rescan can retry
 * them. Without this, a transient 404 (thumb still generating) blacklisted the
 * URL until a full page reload.
 */
export function resetFailedThumbs() {
  _thumbFailedUrls.clear();
}

/* ── SVG Icons ────────────────────────────────────────────────────── */

export const PLAY_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="white"><polygon points="8,5 19,12 8,19"/></svg>`;
export const VIDEO_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
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

/* ═══════════════════════════════════════════════════════════════════════
   DISK-BACKED SETTINGS API

   All user preferences are persisted to a server-side JSON file via
   GET/POST /sidebar_gallery/settings. An in-memory cache makes
   reads synchronous (fast). Writes are debounced to avoid hammering
   the server during rapid UI changes.

   On first load (no disk settings file), we auto-migrate from
   localStorage so existing users don't lose their settings.
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
 * Flush pending settings to the server SYNCHRONOUSLY (sendBeacon), used when the
 * page is hidden/closing. Debounced saves would otherwise be lost if the tab
 * closes within the 500ms window — which silently dropped layout/tab edits and
 * made browsers diverge (the change never reached the shared server file).
 */
export function flushSettingsNow() {
  if (_saveDebounceTimer) { clearTimeout(_saveDebounceTimer); _saveDebounceTimer = null; }
  const pending = { ..._pendingChanges };
  const keys = Object.keys(pending);
  if (!keys.length) return;
  _pendingChanges = {};
  // Send ONE per-key update each (the server merges per key) — never the whole
  // settings object, which would replace the file and clobber keys another tab
  // or browser wrote since we loaded.
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
  // minimize — both flush any debounced changes so nothing is lost.
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

  // Persist each changed key with a per-key update. The server MERGES per key,
  // so we never replace the whole settings file — replacing it would clobber
  // keys another tab/browser saved since we loaded (cross-client data loss).
  // Sequential awaits avoid a read-modify-write race between our own writes.
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
 * Previously duplicated at lines 469 and 1144 of the monolith.
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
  // A blank label (the user cleared the field name) → show just the value, with no
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
 * translucent — so existing opaque colours are untouched while transparency is
 * preserved end-to-end. (named colours / var() return null → caller keeps raw.) */

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

/** Always-rgba string "rgba(r, g, b, a)" — channels clamped to 0..255, alpha
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
 * Previously defined inside openLightbox() closure.
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
