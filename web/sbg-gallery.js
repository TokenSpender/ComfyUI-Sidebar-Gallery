/**
 * sbg-gallery.js — Gallery grid, search, virtual scrolling, and data management
 *
 * Extracted from sidebar_gallery.js. This module owns:
 *   - Gallery grid rendering (virtual scroll with card recycling)
 *   - Search bar, tags, autocomplete, server/client search
 *   - Folder navigation (root picker, subfolder tree)
 *   - Sort/filter controls
 *   - Data fetching (list_all, list_new, delta refresh)
 *   - First-time indexing modal
 *
 * Entry point: initGallery(mountEl, config) → { state, fetchAllItems, ... }
 */

import {
  _dataCache, searchState,
  _metaCache, _persistItems, _loadPersistedItems,
  h, api, fmtBytes, timeAgo,
  showToast, isVideo,
  _thumbMemCache, _thumbCacheAPI, _metaCacheAPI, _resetIdb,
  initThumbObserver, getThumbObserver, resetThumbObserver, resetFailedThumbs,
  PLAY_SVG, VIDEO_ICON, IMG_ICON, IMG_FILTER_ICON, SEARCH_SVG, GEAR_SVG,
  S, getSetting, getLayout,
} from "./sbg-core.js";

import { SectionRegistry } from "./sbg-section-registry.js";

/* ═══════════════════════════════════════════════════════════════════════
   SEARCH PREFIXES
   ═══════════════════════════════════════════════════════════════════════ */

const SEARCH_PREFIXES = [
  "name:", "model:", "lora:", "sampler:", "controlnet:", "prompt:", "keyword:", "app:",
  "mmaudio:", "sampling:", "adetailer:", "upscaling:", "interpolation:",
  "fileinfo:", "file info:", "extra:", "workflow_nodes:", "workflow nodes:",
];

/* ═══════════════════════════════════════════════════════════════════════
   VIRTUAL SCROLL ENGINE
   ═══════════════════════════════════════════════════════════════════════

   Instead of creating DOM nodes for every image in the library, we
   maintain a POOL of reusable card elements and position them absolutely
   inside the grid container. Only cards within the visible viewport
   (plus a buffer) exist in the DOM at any time.

   Key pieces:
     _pool[]           — reusable card DOM elements
     _cardMap           — Map<itemIndex, cardEl>  (currently mounted cards)
     _visRange          — { first, last } item indices currently mounted
     _metrics           — { colCount, rowH, colW } computed from container
     _scrollRafId       — rAF id for throttled scroll handler
   ═══════════════════════════════════════════════════════════════════════ */

const DEFAULT_BUFFER_ROWS = 12; // extra rows rendered above/below viewport
const MAX_POOL = 120;  // max pooled (off-screen) cards before GC

/**
 * Compute grid layout metrics from container dimensions and thumb size.
 */
function _computeMetrics(container, thumbSize, gap, searchActive, perRow = 0) {
  const cw = container.clientWidth;
  if (cw <= 0) return null;
  // perRow > 0 = the user fixed the number of items per row; thumbnail size
  // is then derived from the container width instead of the size setting.
  const colCount = perRow > 0 ? perRow : Math.max(1, Math.floor((cw + gap) / (thumbSize + gap)));
  const colW = (cw - (colCount - 1) * gap) / colCount;
  // Row height = square thumb area + info area (name + meta line) + gap.
  // When a search is active, reserve an extra row so the match badges flow INSIDE
  // the card info area (below name/meta) instead of overlaying the thumbnail.
  const infoH = searchActive ? 60 : 42;
  const rowH = colW + infoH + gap;
  return { colCount, rowH, colW, gap, infoH };
}

/**
 * Compute masonry layout positions for all items.
 * Each item gets a pre-computed { x, y, w, h } based on its aspect ratio.
 * Items are placed in the shortest column (standard masonry algorithm).
 *
 * @param {Array} items — filtered items array
 * @param {object} metrics — { colCount, colW, gap, infoH }
 * @returns {{ positions: Array<{x,y,w,h}>, totalHeight: number }}
 */
function _computeMasonryLayout(items, metrics, fixedPerRow = 0) {
  // Justified-rows layout (Google-Photos style): items are placed left-to-right,
  // top-to-bottom in strict order (so reading order is always preserved), each row
  // is scaled to fill the container width while every card keeps its true aspect
  // ratio. This supports mixed portrait/landscape without cropping to squares and
  // without the shortest-column reordering the old masonry caused.
  // fixedPerRow > 0: every row holds EXACTLY that many cards (user setting);
  // row height comes purely from the cards' aspect ratios.
  const { colCount, colW, gap, infoH } = metrics;
  const containerW = colCount * colW + (colCount - 1) * gap;
  const targetH = colW;          // nominal row height ≈ one column width
  const positions = new Array(items.length);

  const arOf = (it) => {
    let ar = (it && it.w && it.h && it.h > 0) ? it.w / it.h : 1;
    return Math.max(0.4, Math.min(2.5, ar));  // clamp extremes
  };

  let y = 0;
  let i = 0;
  while (i < items.length) {
    // Fill a row: exactly fixedPerRow cards, or greedily until the cards
    // (at target height) span the container.
    const row = [];
    let sumAR = 0;
    while (i < items.length) {
      const ar = arOf(items[i]);
      row.push({ idx: i, ar });
      sumAR += ar;
      i++;
      if (fixedPerRow > 0) {
        if (row.length >= fixedPerRow) break;
        continue;
      }
      const rowW = sumAR * targetH + (row.length - 1) * gap;
      if (rowW >= containerW) break;
    }
    // Scale the row so its cards exactly fill the container width.
    const totalGap = (row.length - 1) * gap;
    let rowH = (containerW - totalGap) / sumAR;
    if (fixedPerRow > 0) {
      // Fixed count: height follows the ARs; only stop a sparse LAST row
      // (fewer cards than asked) from blowing up to fill the width.
      if (row.length < fixedPerRow) rowH = Math.min(rowH, (containerW - (fixedPerRow - 1) * gap) / fixedPerRow * 1.4);
    } else {
      // Clamp so a sparse last row (or a lone ultra-wide card) doesn't blow up/shrink.
      rowH = Math.max(targetH * 0.6, Math.min(targetH * 1.6, rowH));
    }
    const thumbH = Math.round(rowH);
    const cardH = thumbH + infoH;

    let x = 0;
    for (let k = 0; k < row.length; k++) {
      const r = row[k];
      // Last card absorbs rounding so the row's right edge is flush.
      const w = (k === row.length - 1) ? Math.max(1, containerW - x) : Math.round(rowH * r.ar);
      positions[r.idx] = { x, y, w, h: cardH, thumbH };
      x += w + gap;
    }
    y += cardH + gap;
  }

  const totalHeight = y > 0 ? y - gap : 0;
  return { positions, totalHeight };
}


/**
 * Visible index range for the justified-rows masonry layout.
 *
 * _computeMasonryLayout places items in strict reading order, so positions are
 * sorted by Y (non-decreasing y, and non-decreasing y + h). The items overlapping
 * the viewport therefore form a CONTIGUOUS range, found with two binary searches
 * in O(log n) instead of scanning every position each scroll frame.
 *
 * Returns [firstIdx, lastIdx): items with (y + h) > topEdge and y < bottomEdge.
 */
function _masonryVisibleRange(positions, topEdge, bottomEdge) {
  const n = positions.length;
  // firstIdx = lowest i whose bottom (y + h) sits past the top edge.
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = positions[mid];
    if (p.y + p.h > topEdge) hi = mid; else lo = mid + 1;
  }
  const firstIdx = lo;
  // lastIdx = lowest i whose top (y) is at or past the bottom edge.
  lo = firstIdx; hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid].y >= bottomEdge) hi = mid; else lo = mid + 1;
  }
  return [firstIdx, lo];
}


/* ═══════════════════════════════════════════════════════════════════════
   GALLERY INIT
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Initialize the gallery inside the given mount element.
 *
 * @param {HTMLElement} mountEl — the sidebar container element
 * @param {object} config — { openLightbox, openGallerySettings, app }
 * @returns {object} — public API: { state, fetchAllItems, fetchNewItems, refilter }
 */
export function initGallery(mountEl, config) {
  const { openLightbox, openGallerySettings } = config;

  // Drop any thumbnail observations from a previous gallery instance so a
  // remount (e.g. after a thumbnail-size change) can't inject stale thumbnails
  // into the new cards. A full page refresh already resets this; a remount didn't.
  resetThumbObserver();

  // Likewise stop a prior instance's reindex-progress poll and resize observer.
  // ComfyUI can re-render this sidebar tab; the old closures keep running against
  // now-detached DOM otherwise — a stacked-interval leak. Tracked on window so a
  // fresh closure can find and clear the previous one.
  if (window._sbgReindexTimer) { clearInterval(window._sbgReindexTimer); window._sbgReindexTimer = null; }
  if (window._sbgResizeObserver) { try { window._sbgResizeObserver.disconnect(); } catch { } window._sbgResizeObserver = null; }

  // Bound the persistent thumbnail cache (content-addressed entries orphan as
  // files change and IndexedDB has no LRU). Fire-and-forget on mount.
  _thumbCacheAPI.pruneIfOver(50000);

  /* ── Read settings ──────────────────────────────────────────────── */

  const thumbSize = Math.max(64, Math.min(256, Number(getSetting(S.THUMB_SIZE, 110)) || 110));
  // Fixed items-per-row (0 = auto: fit by thumbnail size).
  const thumbPerRow = (() => {
    const v = getSetting(S.THUMB_PER_ROW, "auto");
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.min(12, Math.floor(n)) : 0;
  })();
  const thumbShape = getSetting(S.THUMB_SHAPE, "square");
  // Normalize legacy sort values (pre creation/modified split) to the new keys.
  const _SORT_ALIAS = { newest: "created_desc", oldest: "created_asc" };
  const _rawSort = getSetting(S.SORT, "created_desc");
  const defaultSort = _SORT_ALIAS[_rawSort] || _rawSort;
  const theme = getSetting(S.THEME, "comfyui");

  // Apply badge colors as CSS variables
  const highColor = getSetting(S.BADGE_HIGH_COLOR, "#f87171");
  const lowColor = getSetting(S.BADGE_LOW_COLOR, "#60a5fa");
  mountEl.style.setProperty("--sbg-badge-high", highColor);
  mountEl.style.setProperty("--sbg-badge-low", lowColor);
  const vidBadgeColor = getSetting(S.VIDEO_BADGE_COLOR, "#facc15");
  mountEl.style.setProperty("--sbg-badge-vid", vidBadgeColor);

  /* ── Gallery state ──────────────────────────────────────────────── */

  const state = {
    roots: [],
    rootId: "output",
    subfolders: [],
    subfolder: "",
    q: "",
    kind: "",
    sort: defaultSort,
    allItems: [],
    filteredItems: [],
    displayedCount: 0,
    pageSize: 120,
    loading: false,
    // Search
    searchTags: [],
    searchMode: "AND",
    _searchMatches: null,
  };

  /* ── Sorting ────────────────────────────────────────────────────── */

  // Created time = ctime (falls back to legacy mtime field); Modified time =
  // mtime_real (falls back to ctime/mtime). "newest"/"oldest" remain the
  // default creation-time sort for back-compat with saved settings.
  const _ct = (it) => (it.ctime != null ? it.ctime : it.mtime) || 0;
  const _mt = (it) => (it.mtime_real != null ? it.mtime_real : (it.ctime != null ? it.ctime : it.mtime)) || 0;
  const sortFns = {
    newest: (a, b) => _ct(b) - _ct(a),
    oldest: (a, b) => _ct(a) - _ct(b),
    created_desc: (a, b) => _ct(b) - _ct(a),
    created_asc: (a, b) => _ct(a) - _ct(b),
    modified_desc: (a, b) => _mt(b) - _mt(a),
    modified_asc: (a, b) => _mt(a) - _mt(b),
    name_asc: (a, b) => a.relpath.localeCompare(b.relpath),
    name_desc: (a, b) => b.relpath.localeCompare(a.relpath),
    size_desc: (a, b) => b.size - a.size,
    size_asc: (a, b) => a.size - b.size,
  };

  function applyFilters() {
    let items = state.allItems;

    // Subfolder filter
    if (state.subfolder) {
      items = items.filter(it => it.subfolder === state.subfolder || it.subfolder.startsWith(state.subfolder + "/"));
    }

    // Kind filter
    if (state.kind === "image") items = items.filter(it => it.kind === "image");
    else if (state.kind === "video") items = items.filter(it => it.kind === "video");

    // Search
    if (state.q && !state._searchMatches) {
      const lq = state.q.toLowerCase();
      items = items.filter(it => it.relpath.toLowerCase().includes(lq));
    } else if (state._searchMatches) {
      items = items.filter(it => {
        const rp = it.relpath.replace(/\\/g, "/");
        if (state._searchMatches.has(rp)) {
          it._matchedFields = state._searchMatches.get(rp);
          return true;
        }
        return false;
      });
    }

    const fn = sortFns[state.sort] || sortFns.newest;
    items.sort(fn);

    state.filteredItems = items;
    state.displayedCount = 0;
  }

  /* ── Search state sync ──────────────────────────────────────────── */

  function _setSearchQuery(val) {
    searchState.query = val;
  }
  function _setSearchScopes(val) {
    searchState.scopes = val;
  }

  /* ── DOM: Toolbar ───────────────────────────────────────────────── */

  const folderNav = h("div", { class: "sbg-folder-nav" });

  function renderFolderNav() {
    folderNav.innerHTML = "";
    const rootLabel = (state.roots.find(r => r.id === state.rootId) || {}).label || state.rootId;

    // Root button (only shown if multiple roots)
    if (state.roots.length > 1) {
      const rootBtn = h("button", { class: "sbg-crumb sbg-crumb--root", text: rootLabel, title: "Click to change root" });
      rootBtn.addEventListener("click", () => {
        const popup = h("div", { class: "sbg-crumb-popup" });
        for (const r of state.roots) {
          const item = h("div", {
            class: `sbg-crumb-popup__item${r.id === state.rootId ? " sbg-crumb-popup__item--active" : ""}`,
            text: r.label,
          });
          item.addEventListener("click", () => {
            popup.remove();
            switchRoot(r.id);
          });
          popup.appendChild(item);
        }
        document.body.appendChild(popup);
        const rect = rootBtn.getBoundingClientRect();
        popup.style.position = "fixed";
        popup.style.left = rect.left + "px";
        popup.style.top = (rect.bottom + 2) + "px";
        popup.style.zIndex = "100000";
        const dismiss = (ev) => { if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener("mousedown", dismiss); } };
        setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
      });
      folderNav.appendChild(rootBtn);
    }

    // Folder dropdown button
    if (state.subfolders.length > 0) {
      const currentLabel = state.subfolder || "All folders";
      const pickBtn = h("button", { class: "sbg-crumb sbg-crumb--pick", text: "📂 " + currentLabel, title: "Browse folders" });
      pickBtn.addEventListener("click", () => {
        const popup = h("div", { class: "sbg-crumb-popup sbg-crumb-popup--folders" });
        const allItem = h("div", { class: `sbg-crumb-popup__item${!state.subfolder ? " sbg-crumb-popup__item--active" : ""}`, text: "📁 All folders" });
        allItem.addEventListener("click", () => {
          _dataCache.folderScrollTop = popup.scrollTop;
          popup.remove();
          state.subfolder = "";
          _dataCache.lastSubfolder = "";
          refilter();
          renderFolderNav();
        });
        popup.appendChild(allItem);
        for (const sf of state.subfolders) {
          const item = h("div", {
            class: `sbg-crumb-popup__item${sf === state.subfolder ? " sbg-crumb-popup__item--active" : ""}`,
            text: "📁 " + sf,
          });
          item.addEventListener("click", () => {
            _dataCache.folderScrollTop = popup.scrollTop;
            popup.remove();
            state.subfolder = sf;
            _dataCache.lastSubfolder = sf;
            refilter();
            renderFolderNav();
          });
          popup.appendChild(item);
        }
        document.body.appendChild(popup);
        const rect = pickBtn.getBoundingClientRect();
        popup.style.position = "fixed";
        popup.style.left = rect.left + "px";
        popup.style.top = (rect.bottom + 2) + "px";
        popup.style.zIndex = "100000";
        popup.style.maxHeight = "300px";
        popup.style.overflowY = "auto";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const savedScroll = _dataCache.folderScrollTop || 0;
            if (savedScroll > 0) {
              popup.scrollTop = savedScroll;
            } else {
              const active = popup.querySelector(".sbg-crumb-popup__item--active");
              if (active) active.scrollIntoView({ block: "center" });
            }
          });
        });
        const dismiss = (ev) => {
          if (!popup.contains(ev.target)) {
            _dataCache.folderScrollTop = popup.scrollTop;
            popup.remove();
            document.removeEventListener("mousedown", dismiss);
          }
        };
        setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
      });
      folderNav.appendChild(pickBtn);
    }
  }

  // Kind toggle buttons
  const VID_FILTER_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
  const kindBtnAll = h("button", { class: "sbg-kind-btn sbg-kind-btn--active", text: "All", "data-kind": "", title: "Show all files" });
  const kindBtnImg = h("button", { class: "sbg-kind-btn", html: IMG_FILTER_ICON, "data-kind": "image", title: "Images only" });
  const kindBtnVid = h("button", { class: "sbg-kind-btn", html: VID_FILTER_ICON, "data-kind": "video", title: "Videos only" });
  const kindGroup = h("div", { class: "sbg-kind-group" }, [kindBtnAll, kindBtnImg, kindBtnVid]);

  const sortSel = h("select", { class: "sbg-select", title: "Sort order", style: "flex:0 0 auto;width:auto" }, [
    h("option", { value: "created_desc", text: "Created ↓" }),
    h("option", { value: "created_asc", text: "Created ↑" }),
    h("option", { value: "modified_desc", text: "Modified ↓" }),
    h("option", { value: "modified_asc", text: "Modified ↑" }),
    h("option", { value: "name_asc", text: "Name ↑" }),
    h("option", { value: "name_desc", text: "Name ↓" }),
    h("option", { value: "size_desc", text: "Size ↓" }),
    h("option", { value: "size_asc", text: "Size ↑" }),
  ]);
  sortSel.value = state.sort;
  const diagBtn = h("button", { class: "sbg-btn", html: GEAR_SVG, title: "Gallery Settings" });

  /* ── Search bar ─────────────────────────────────────────────────── */

  const qInput = h("input", { class: "sbg-input", placeholder: "Search all fields… (name: for filename only)", title: "Search across all metadata fields. Press Enter to add as a tag. Use name: for filename-only, model: lora: prompt: keyword: sampler: controlnet: for specific fields" });
  const searchClear = h("button", { class: "sbg-search-clear", text: "✕", title: "Clear search" });
  const searchTagsWrap = h("div", { class: "sbg-search-tags" });

  const searchModeSel = h("select", { class: "sbg-search-mode", title: "Toggle whether tags should match ALL requirements (AND) or ANY requirement (OR)", style: "display:none;" }, [
    h("option", { value: "AND", text: "AND" }),
    h("option", { value: "OR", text: "OR" })
  ]);
  searchModeSel.addEventListener("change", () => {
    state.searchMode = searchModeSel.value;
    _dataCache.lastSearchMode = state.searchMode;
    _triggerMultiSearch();
  });

  const inputFlexBox = h("div", { style: "display:flex;align-items:center;flex:1;min-width:0;gap:4px;flex-wrap:wrap;" }, [searchTagsWrap, qInput]);

  // Autocomplete dropdown
  const autoCompleteDropdown = h("div", { class: "sbg-search-autocomplete" });
  autoCompleteDropdown.style.display = "none";
  let _acSelectedIdx = -1;

  function _updateAutocomplete() {
    const val = qInput.value.toLowerCase().trim();
    autoCompleteDropdown.innerHTML = "";
    _acSelectedIdx = -1;
    // Only suggest once the user has typed something — never on empty focus/scroll
    // (that unexpected full-prefix dropdown was a regression).
    if (val.length === 0 || val.includes(":")) { autoCompleteDropdown.style.display = "none"; return; }
    const matches = SEARCH_PREFIXES.filter(p => p.startsWith(val));
    if (matches.length === 0 || (matches.length === 1 && matches[0] === val + ":")) {
      autoCompleteDropdown.style.display = "none";
      return;
    }
    for (let i = 0; i < matches.length; i++) {
      const prefix = matches[i];
      const item = h("div", { class: "sbg-search-ac-item", text: prefix });
      item.dataset.idx = String(i);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        qInput.value = prefix;
        autoCompleteDropdown.style.display = "none";
        qInput.focus();
      });
      autoCompleteDropdown.appendChild(item);
    }
    autoCompleteDropdown.style.display = "block";
  }

  function _acNavigate(delta) {
    const items = autoCompleteDropdown.querySelectorAll(".sbg-search-ac-item");
    if (items.length === 0) return;
    _acSelectedIdx = Math.max(-1, Math.min(items.length - 1, _acSelectedIdx + delta));
    items.forEach((el, i) => el.classList.toggle("sbg-search-ac-item--active", i === _acSelectedIdx));
  }

  function _acAccept() {
    const items = autoCompleteDropdown.querySelectorAll(".sbg-search-ac-item");
    if (_acSelectedIdx >= 0 && _acSelectedIdx < items.length) {
      qInput.value = items[_acSelectedIdx].textContent;
      autoCompleteDropdown.style.display = "none";
      return true;
    }
    if (items.length > 0 && autoCompleteDropdown.style.display !== "none") {
      qInput.value = items[0].textContent;
      autoCompleteDropdown.style.display = "none";
      return true;
    }
    return false;
  }

  qInput.addEventListener("input", _updateAutocomplete);
  qInput.addEventListener("focus", _updateAutocomplete);
  qInput.addEventListener("blur", () => {
    setTimeout(() => { autoCompleteDropdown.style.display = "none"; }, 150);
  });

  const searchWrap = h("div", { class: "sbg-search-wrap" }, [
    h("span", { class: "sbg-search-icon", html: SEARCH_SVG }),
    inputFlexBox,
    searchModeSel,
    searchClear,
    autoCompleteDropdown,
  ]);

  /* ── Progress bar ───────────────────────────────────────────────── */

  const progressFill = h("div", { class: "sbg-progress__fill" });
  const progressText = h("span", { class: "sbg-progress__text" });
  const progressWrap = h("div", { class: "sbg-progress-wrap" }, [
    h("div", { class: "sbg-progress" }, [
      h("div", { class: "sbg-progress__bar" }, [progressFill]),
      progressText,
    ]),
  ]);

  const toolbar = h("div", { class: "sbg-toolbar" }, [
    searchWrap,
    h("div", { class: "sbg-toolbar-row" }, [folderNav, kindGroup, sortSel, diagBtn]),
    progressWrap,
  ]);

  function showProgress(text, pct) {
    progressWrap.classList.add("sbg-progress-wrap--visible");
    progressText.textContent = text;
    if (pct >= 0) {
      progressFill.classList.remove("sbg-progress__fill--indeterminate");
      progressFill.style.width = `${Math.min(100, pct)}%`;
    } else {
      progressFill.classList.add("sbg-progress__fill--indeterminate");
    }
  }

  function hideProgress() {
    progressWrap.classList.remove("sbg-progress-wrap--visible");
  }

  diagBtn.addEventListener("click", () => openGallerySettings("layout"));

  /* ── Status bar ─────────────────────────────────────────────────── */

  const statusLeft = h("span", { class: "sbg-status__left", text: "Ready" });
  const statusRight = h("span", { class: "sbg-status__right" });

  // Auto-reindex indicator. After a restart that updated the metadata parser,
  // the server re-reads every file in the background (_check_parser_version);
  // show its progress here so it's visible without opening Diagnostics.
  const statusReindex = h("span", {
    class: "sbg-status__reindex",
    style: "color:var(--sbg-accent);display:none;white-space:nowrap",
    title: "The metadata parser was updated — all files are being re-read in the background. The gallery stays usable; updated metadata appears as files are re-indexed.",
  });
  let _reindexTimer = null;
  async function watchReindexProgress() {
    try {
      const p = await fetch("/sidebar_gallery/reindex_progress").then(r => r.json());
      if (p.running) {
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        statusReindex.style.display = "";
        statusReindex.textContent = `⟳ Updating metadata index… ${pct}% (${(p.done || 0).toLocaleString()} / ${(p.total || 0).toLocaleString()})`;
        if (!_reindexTimer) { _reindexTimer = setInterval(watchReindexProgress, 3000); window._sbgReindexTimer = _reindexTimer; }
      } else if (_reindexTimer) {
        clearInterval(_reindexTimer);
        _reindexTimer = null;
        window._sbgReindexTimer = null;
        statusReindex.textContent = "✓ Metadata index updated";
        setTimeout(() => { statusReindex.style.display = "none"; }, 8000);
      } else {
        statusReindex.style.display = "none";
      }
    } catch { /* server briefly unreachable — leave indicator as-is */ }
  }

  const statusBar = h("div", { class: "sbg-status" }, [statusLeft, statusReindex, statusRight]);

  /* ── Grid container ─────────────────────────────────────────────── */

  const grid = h("div", { class: "sbg-grid sbg-grid--virtual" });
  const spacer = h("div", { class: "sbg-grid__spacer" });
  grid.appendChild(spacer);

  const body = h("div", { class: "sbg-body" }, [grid]);
  // Wrap the scroll area so a custom OVERLAY scrollbar can float over the content.
  // Chrome can't do Firefox-style overlay scrollbars (its styled scrollbar always
  // reserves a gutter and never overlays); _attachOverlayScrollbar adds one in
  // Chrome/Edge. Firefox keeps its own native overlay scrollbar.
  const bodyWrap = h("div", { class: "sbg-body-wrap" }, [body]);

  grid.style.setProperty("--sbg-thumb-size", `${thumbSize}px`);

  /* ── Virtual scroll state ───────────────────────────────────────── */

  const GAP = 8;
  let _metrics = null;
  let _cardMap = new Map();   // itemIndex → card element
  let _pool = [];             // recycled off-screen card elements
  let _scrollRafId = null;
  let _resizeObserver = null;
  let _emptyMsg = null;       // empty state placeholder

  function _recycleCard(cardEl) {
    cardEl.style.display = "none";
    cardEl.removeAttribute("data-idx");
    if (_pool.length < MAX_POOL) {
      _pool.push(cardEl);
    } else {
      cardEl.remove();
    }
  }

  /**
   * Build a tooltip string for a card.
   */
  function buildTooltip(it) {
    const parts = [];
    if (getSetting(S.TOOLTIP_NAME, true)) parts.push(it.relpath);
    if (getSetting(S.TOOLTIP_SIZE, true)) parts.push(fmtBytes(it.size));
    if (getSetting(S.TOOLTIP_DATE, true)) parts.push(timeAgo(it.mtime));
    return parts.join("\n");
  }

  /**
   * Create a brand-new card element for an item, OR recycle one from pool.
   * For virtual scrolling, cards are positioned absolutely.
   */
  function _createOrRecycleCard(it, index) {
    // For now, always create fresh (recycling requires careful src/event cleanup)
    // TODO: implement proper card recycling for even better perf
    const shapeClass = thumbShape === "ar" ? "sbg-card__thumb-wrap--ar" : "sbg-card__thumb-wrap--square";
    const thumbWrap = h("div", { class: `sbg-card__thumb-wrap ${shapeClass}` });

    if (it.thumb_url) {
      const thumbImg = h("img", {
        class: "sbg-card__thumb",
        loading: "lazy",
        // Non-draggable so the blob: thumbnail never leaks into the card's drag
        // payload — that was what ComfyUI's native drop tried to upload (→ 500).
        draggable: "false",
        onerror: function () {
          // Show a placeholder icon on ANY thumbnail load failure. We deliberately
          // do NOT remove the item from the gallery here: a 404 is often transient
          // (thumb still generating, or the server is busy serving another browser),
          // and nuking the card on a transient failure was what left "broken"
          // gaps. Truly-deleted files are pruned by the next incremental scan.
          const img = this;
          img.style.display = "none";
          if (img.parentElement && !img.parentElement.querySelector(".sbg-card__placeholder")) {
            img.parentElement.appendChild(h("div", { class: "sbg-card__placeholder", html: isVideo(it) ? VIDEO_ICON : IMG_ICON }));
          }
        },
      });

      // L1: sync memory cache
      const memUrl = _thumbCacheAPI.tryGetSync(it.thumb_url);
      if (memUrl) {
        thumbImg.src = memUrl;
        thumbWrap.appendChild(thumbImg);
      } else {
        // L2+: async IDB then network
        _thumbCacheAPI.tryGet(it.thumb_url).then(blobUrl => {
          if (blobUrl) {
            thumbImg.src = blobUrl;
            thumbWrap.appendChild(thumbImg);
            const spinner = thumbWrap.querySelector(".sbg-card__spinner");
            if (spinner) spinner.remove();
            const placeholder = thumbWrap.querySelector(".sbg-card__placeholder");
            if (placeholder) placeholder.remove();
          } else {
            thumbWrap._sbgItem = it;
            initThumbObserver();
            getThumbObserver().observe(thumbWrap);
          }
        }).catch(() => {
          thumbWrap._sbgItem = it;
          initThumbObserver();
          getThumbObserver().observe(thumbWrap);
        });
        thumbWrap.appendChild(h("div", { class: "sbg-card__spinner" }));
        thumbWrap.appendChild(h("div", { class: "sbg-card__placeholder sbg-card__placeholder--dim", html: isVideo(it) ? VIDEO_ICON : IMG_ICON }));
      }
    } else {
      thumbWrap.appendChild(h("div", { class: "sbg-card__placeholder", html: isVideo(it) ? VIDEO_ICON : IMG_ICON }));
    }

    if (isVideo(it)) {
      thumbWrap.appendChild(h("span", { class: "sbg-card__video-badge", text: (it.ext || "").replace(".", "").toUpperCase() || "VID" }));
      thumbWrap.appendChild(h("div", { class: "sbg-card__play-icon", html: PLAY_SVG }));
    }

    const card = h("div", {
      class: "sbg-card sbg-card--virtual",
      title: buildTooltip(it),
      onclick: () => openLightbox(state.filteredItems, it),
    }, [
      thumbWrap,
      h("div", { class: "sbg-card__info" }, [
        h("div", { class: "sbg-card__name", text: it.filename }),
        h("div", { class: "sbg-card__meta", text: `${fmtBytes(it.size)} · ${timeAgo(it.mtime)}` }),
      ]),
    ]);

    // Search match badges
    if (it._matchedFields && state._searchMatches) {
      const _layout = getLayout();
      const _BADGE_FALLBACK = { pos_prompt: "POSITIVE", neg_prompt: "NEGATIVE", filename: "FILENAME", keyword: "KEYWORD", app: "APP", any: "ANY" };
      const _searchToCanonical = {};
      for (const [name, def] of Object.entries(SectionRegistry.sectionDefs)) {
        if (def.searchField) _searchToCanonical[def.searchField] = name;
      }
      const infoEl = card.querySelector(".sbg-card__info");
      const fields = Array.isArray(it._matchedFields) ? it._matchedFields : [{ field: it._matchedFields, count: 1 }];
      for (const mf of fields) {
        const field = typeof mf === "string" ? mf : mf.field;
        const count = typeof mf === "object" ? (mf.count || 1) : 1;
        const canonical = _searchToCanonical[field.toLowerCase()];
        const displayName = canonical ? SectionRegistry.getDisplayName(canonical, _layout) : null;
        const label = displayName ? displayName.toUpperCase() : (_BADGE_FALLBACK[field] || field.toUpperCase());
        const text = count > 1 ? `${label}(${count})` : label;
        infoEl.appendChild(
          h("span", { class: `sbg-card__match-badge sbg-card__match-badge--${field}`, text })
        );
      }
    }

    // Drag-and-drop workflow loading
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-sbg-workflow", JSON.stringify({ root_id: it.root_id, relpath: it.relpath }));
      e.dataTransfer.setData("text/plain", it.filename);
      e.dataTransfer.effectAllowed = "copy";
      // (No full-canvas overlay — ComfyUI's own per-node drop highlight is enough.)
    });

    card.dataset.idx = String(index);
    card.dataset.relpath = it.relpath;  // bind card → item so we can detect stale reuse
    return card;
  }

  /**
   * Position a card at the correct grid slot based on item index.
   * In AR mode, uses pre-computed masonry positions.
   */
  function _positionCard(card, index) {
    if (!_metrics) return;

    // Masonry mode: use pre-computed positions
    if (_masonryData && _masonryData.positions[index]) {
      const pos = _masonryData.positions[index];
      card.style.position = "absolute";
      card.style.top = `${pos.y}px`;
      card.style.left = `${pos.x}px`;
      card.style.width = `${pos.w}px`;
      card.style.height = `${pos.h}px`;
      // Set thumb wrap height to match the AR
      const thumbWrap = card.querySelector(".sbg-card__thumb-wrap");
      if (thumbWrap) thumbWrap.style.height = `${pos.thumbH}px`;
      card.style.display = "";
      return;
    }

    // Grid mode: uniform positioning
    const { colCount, rowH, colW, gap, infoH } = _metrics;
    const row = Math.floor(index / colCount);
    const col = index % colCount;
    card.style.position = "absolute";
    card.style.top = `${row * rowH}px`;
    card.style.left = `${col * (colW + gap)}px`;
    card.style.width = `${colW}px`;
    // Enforce height so cards never overlap
    card.style.height = `${colW + infoH}px`;
    card.style.display = "";
  }

  /**
   * Core virtual scroll render: mount/unmount cards based on scroll position.
   * Supports both uniform grid (square) and masonry (AR) layouts.
   */
  function _renderVirtual() {
    _scrollRafId = null;
    if (!_metrics || state.filteredItems.length === 0) return;

    const scrollTop = body.scrollTop;
    const viewH = body.clientHeight;
    const bufferPx = Math.max(2, Math.min(30, Number(getSetting(S.VSCROLL_BUFFER, DEFAULT_BUFFER_ROWS)) || DEFAULT_BUFFER_ROWS)) * (_metrics.rowH || 150);

    let firstIdx, lastIdx;

    if (_masonryData) {
      // ── Masonry (justified-rows) mode ──
      // Items are placed in strict top-to-bottom, left-to-right reading order
      // (see _computeMasonryLayout), so positions are sorted by Y and the visible
      // items form a CONTIGUOUS index range. Binary-search it (O(log n)) instead
      // of scanning all N positions on every scroll frame.
      const topEdge = Math.max(0, scrollTop - bufferPx);
      const bottomEdge = scrollTop + viewH + bufferPx;
      const [first, last] = _masonryVisibleRange(_masonryData.positions, topEdge, bottomEdge);

      // Recycle cards now outside the visible range.
      for (const [idx, card] of _cardMap) {
        if (idx < first || idx >= last) {
          _recycleCard(card);
          _cardMap.delete(idx);
        }
      }
      // Mount visible cards.
      for (let i = first; i < last; i++) {
        const it = state.filteredItems[i];
        if (!it) continue;
        const existing = _cardMap.get(i);
        if (existing) {
          // If the list shifted (e.g. a delta refresh prepended items), index i may
          // now point to a DIFFERENT item; rebuild when the bound relpath no longer
          // matches so a card never shows another item thumbnail.
          if (existing.dataset.relpath === it.relpath) continue;
          existing.remove(); _cardMap.delete(i);
        }
        const card = _createOrRecycleCard(it, i);
        _positionCard(card, i);
        grid.appendChild(card);
        _cardMap.set(i, card);
      }

      state.displayedCount = state.filteredItems.length;
      updateStatus();
      return;
    } else {
      // ── Grid mode: uniform row-based calculation ──
      const { colCount, rowH } = _metrics;
      const bufferRows = Math.max(2, Math.min(30, Number(getSetting(S.VSCROLL_BUFFER, DEFAULT_BUFFER_ROWS)) || DEFAULT_BUFFER_ROWS));
      const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - bufferRows);
      const lastRow = Math.ceil((scrollTop + viewH) / rowH) + bufferRows;
      const totalRows = Math.ceil(state.filteredItems.length / colCount);
      firstIdx = firstRow * colCount;
      lastIdx = Math.min((Math.min(lastRow, totalRows)) * colCount, state.filteredItems.length);
    }

    // Recycle cards outside the new range
    for (const [idx, card] of _cardMap) {
      if (idx < firstIdx || idx >= lastIdx) {
        _recycleCard(card);
        _cardMap.delete(idx);
      }
    }

    // Mount cards in the new range
    for (let i = firstIdx; i < lastIdx; i++) {
      const it = state.filteredItems[i];
      if (!it) continue;
      const existing = _cardMap.get(i);
      if (existing) {
        // Rebuild if index i now maps to a different item (list shifted) so a
        // card never displays a stale/wrong thumbnail (image↔video mismatch).
        if (existing.dataset.relpath === it.relpath) continue;
        existing.remove(); _cardMap.delete(i);
      }
      const card = _createOrRecycleCard(it, i);
      _positionCard(card, i);
      grid.appendChild(card);
      _cardMap.set(i, card);
    }

    // Update displayed count for status
    state.displayedCount = Math.min(lastIdx, state.filteredItems.length);
    updateStatus();
  }

  function _scheduleVirtualRender() {
    if (_scrollRafId) return;
    _scrollRafId = requestAnimationFrame(_renderVirtual);
  }

  /**
   * Full re-render: update spacer height, reset card map, render visible.
   */
  // Masonry layout data (null when in square/grid mode)
  let _masonryData = null;

  function renderFromScratch() {
    // Recompute metrics
    _metrics = _computeMetrics(grid, thumbSize, GAP, !!state._searchMatches, thumbPerRow);
    // Reserve the extra info row (for match badges) only while a search is active.
    grid.classList.toggle("sbg-grid--search", !!state._searchMatches);

    // Clear all cards. Also purge any stray card zombies: _recycleCard() hides
    // pooled cards (display:none) without removing them from the grid, and
    // _createOrRecycleCard always builds fresh, so without this sweep an old
    // filter's cards could linger in the DOM and show stale/wrong thumbnails.
    for (const [, card] of _cardMap) {
      card.remove();
    }
    _cardMap.clear();
    for (const stray of grid.querySelectorAll(".sbg-card")) stray.remove();
    _pool = [];
    _masonryData = null;

    // Remove empty message if present
    if (_emptyMsg) { _emptyMsg.remove(); _emptyMsg = null; }

    if (!_metrics || state.filteredItems.length === 0) {
      spacer.style.height = "0px";
      if (state.filteredItems.length === 0) {
        _emptyMsg = h("div", { class: "sbg-empty", style: "grid-column:1/-1" }, [
          h("div", { class: "sbg-empty__icon", text: "📂" }),
          h("div", { text: "No media found" }),
        ]);
        grid.appendChild(_emptyMsg);
      }
      updateStatus();
      return;
    }

    if (thumbShape === "ar") {
      // ── Masonry mode: pre-compute all positions ──
      _masonryData = _computeMasonryLayout(state.filteredItems, _metrics, thumbPerRow);
      spacer.style.height = `${_masonryData.totalHeight}px`;
    } else {
      // ── Grid mode: uniform rows ──
      const { colCount, rowH } = _metrics;
      const totalRows = Math.ceil(state.filteredItems.length / colCount);
      spacer.style.height = `${totalRows * rowH}px`;
    }

    // Render visible cards
    _renderVirtual();
  }

  function updateStatus() {
    statusRight.textContent = `${Math.min(state.displayedCount, state.filteredItems.length)} / ${state.filteredItems.length}`;
  }

  /* ── Scroll + Resize handlers ───────────────────────────────────── */

  body.addEventListener("scroll", () => { _saveScrollPos(); _scheduleVirtualRender(); }, { passive: true });

  // Custom OVERLAY scrollbar for Chrome/Edge (Firefox's native overlay is already
  // ideal — skip there). Chrome's styled scrollbar reserves a gutter and never
  // overlays content; this thin thumb floats over the right edge: invisible when
  // idle, widening when the pointer nears it, draggable, synced to scroll position.
  function _attachOverlayScrollbar(scrollEl, wrap) {
    if (/firefox/i.test(navigator.userAgent)) return;
    scrollEl.classList.add("sbg-body--ovscroll");
    const thumb = h("div", { class: "sbg-ovscroll-thumb" });
    wrap.appendChild(thumb);
    const GRAB = 26, FADE = 1100;
    let hideTimer = null, dragging = false, nearEdge = false;

    const layout = () => {
      const ch = scrollEl.clientHeight, sh = scrollEl.scrollHeight;
      if (sh <= ch + 1) { thumb.style.display = "none"; return; }
      thumb.style.display = "";
      const th = Math.max(28, Math.round(ch * ch / sh));
      const top = Math.round((scrollEl.scrollTop / (sh - ch)) * (ch - th));
      thumb.style.height = th + "px";
      thumb.style.transform = `translateY(${top}px)`;
    };
    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!dragging && !nearEdge) thumb.classList.remove("sbg-ovscroll-thumb--show", "sbg-ovscroll-thumb--wide");
      }, FADE);
    };
    const show = (wide) => {
      layout();
      thumb.classList.add("sbg-ovscroll-thumb--show");
      thumb.classList.toggle("sbg-ovscroll-thumb--wide", !!wide || dragging);
      if (!dragging) scheduleHide();
    };

    scrollEl.addEventListener("scroll", () => show(nearEdge), { passive: true });
    wrap.addEventListener("mousemove", (e) => {
      const r = scrollEl.getBoundingClientRect();
      nearEdge = (r.right - e.clientX) <= GRAB && e.clientY >= r.top && e.clientY <= r.bottom;
      show(nearEdge);
    });
    wrap.addEventListener("mouseleave", () => { nearEdge = false; scheduleHide(); });

    thumb.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      dragging = true; nearEdge = true;
      const startY = e.clientY, startScroll = scrollEl.scrollTop;
      const ch = scrollEl.clientHeight, sh = scrollEl.scrollHeight, th = thumb.offsetHeight;
      const trackRange = ch - th, scrollRange = sh - ch;
      thumb.classList.add("sbg-ovscroll-thumb--show", "sbg-ovscroll-thumb--wide");
      const onMove = (ev) => { if (trackRange > 0) scrollEl.scrollTop = startScroll + (ev.clientY - startY) * (scrollRange / trackRange); };
      const onUp = () => {
        dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        scheduleHide();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // Re-layout when the viewport or content height changes (virtual scroll resizes
    // the spacer, filters change the item count, the window resizes).
    try {
      // Drop a prior instance's observer so remounts (thumb-size change re-runs
      // initGallery) don't leak observers/detached nodes.
      if (window._sbgOverlayRO) { try { window._sbgOverlayRO.disconnect(); } catch { } }
      const ro = new ResizeObserver(() => layout());
      ro.observe(scrollEl);
      if (scrollEl.firstElementChild) ro.observe(scrollEl.firstElementChild);
      window._sbgOverlayRO = ro;
    } catch { }
    requestAnimationFrame(layout);
  }
  _attachOverlayScrollbar(body, bodyWrap);

  _resizeObserver = new ResizeObserver(() => {
    const newMetrics = _computeMetrics(grid, thumbSize, GAP, !!state._searchMatches, thumbPerRow);
    if (newMetrics && _metrics &&
        (newMetrics.colCount !== _metrics.colCount || Math.abs(newMetrics.rowH - _metrics.rowH) > 1)) {
      // Column count or row height changed — full re-layout
      _metrics = newMetrics;
      renderFromScratch();
    } else if (newMetrics && !_metrics) {
      _metrics = newMetrics;
      renderFromScratch();
    }
  });
  _resizeObserver.observe(grid);
  window._sbgResizeObserver = _resizeObserver;

  /* ── Helpers ─────────────────────────────────────────────────────── */

  function setLoading(v) {
    state.loading = v;
    diagBtn.disabled = v;
    if (v) statusLeft.classList.add("sbg-loading");
    else statusLeft.classList.remove("sbg-loading");
  }

  function rebuildRoots() {
    renderFolderNav();
  }

  async function loadSubfolders() {
    try {
      const data = await api("/sidebar_gallery/subfolders", { root_id: state.rootId });
      state.subfolders = data.subfolders || [];
      _dataCache.subfolders[state.rootId] = state.subfolders;
      renderFolderNav();
    } catch { }
  }

  async function refreshConfig() {
    const cfg = await api("/sidebar_gallery/config");
    state.roots = cfg.roots || [];
    if (!state.roots.find(r => r.id === "output")) state.roots.unshift({ id: "output", label: "Output" });
    _dataCache.roots = state.roots;
    // The active root was just removed (Folders → 🗑) → fall back to output and
    // reload its view, otherwise the grid keeps showing the deleted folder's
    // images. switchRoot also redraws the breadcrumb nav.
    if (!state.roots.find(r => r.id === state.rootId)) {
      switchRoot("output");
    } else {
      rebuildRoots();
    }
  }

  // Switch the active root. A root we've shown before paints instantly from its
  // cached list, then an awaited rescan reconciles files created while we were on
  // another root — generations always land in the output root even when an extra
  // folder is on screen, and that file would otherwise stay hidden until a manual
  // refresh. A freshly added / never-opened root has nothing cached or indexed
  // yet, so we show an indexing indicator while the backend finishes its first
  // scan (list_all awaits that scan when the root's DB is still empty).
  function switchRoot(newRootId) {
    if (newRootId === state.rootId) return;
    state.rootId = newRootId;
    _dataCache.lastRootId = newRootId;
    state.subfolder = "";
    _dataCache.lastSubfolder = "";
    renderFolderNav();
    loadSubfolders();
    const known = Array.isArray(_dataCache.items[newRootId]) && _dataCache.items[newRootId].length > 0;
    if (known) {
      state.allItems = _dataCache.items[newRootId];
      applyFilters();
      renderFromScratch();
      fetchAllItems({ rescan: false })
        .then(() => fetchAllItems({ rescan: true }))
        .catch(() => { });
    } else {
      state.allItems = [];
      applyFilters();
      renderFromScratch();
      showProgress("Indexing new folder…", -1);
      fetchAllItems({ rescan: false })
        .then(() => loadSubfolders())
        .catch(() => { })
        .finally(() => hideProgress());
    }
  }

  /* ── Data fetching ──────────────────────────────────────────────── */

  // Debounced snapshot persistence. The delta path (fetchNewItems) used to update
  // only in-memory state, so freshly generated files were absent from the IDB
  // snapshot that drives the instant first paint after a reboot/refresh — they
  // popped in only after a network round-trip. Persisting here (coalesced, since
  // a burst generation fires several deltas) makes the next cold start paint
  // complete. fetchAllItems persists inline; this is the delta-path equivalent.
  let _persistTimer = null;
  function _schedulePersist() {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
      _persistTimer = null;
      _persistItems(state.rootId, state.allItems);
    }, 1500);
  }

  async function fetchAllItems({ rescan = false } = {}) {
    if (!rescan) setLoading(true);
    if (rescan) resetFailedThumbs(); // give previously-404'd thumbnails another chance
    statusLeft.textContent = rescan ? "Scanning…" : "Loading…";
    try {
      const ts = Math.max(512, thumbSize * 2);
      _dataCache._thumbSize = ts;
      const data = await api("/sidebar_gallery/list_all", {
        root_id: state.rootId,
        rescan: rescan ? "1" : undefined,
        thumb_size: String(ts),
      });

      if (data.server_time) _dataCache._lastServerTime = data.server_time;

      // Cache epoch vs DB version.
      // CACHE_EPOCH is bumped manually when the cached DATA SHAPE changes — that
      // genuinely requires dropping every cache. A plain db_version change just
      // means some file was added/changed/removed and must NOT wipe the metadata
      // + thumbnail caches: doing so made the lightbox re-fetch metadata on every
      // navigation during generation. Per-item freshness is now guaranteed by the
      // lightbox's mtime check and by content-addressed thumb/file URLs (?v=mtime),
      // so changed files refresh on their own without nuking everything.
      let cacheReset = false;
      const CACHE_EPOCH = "3";
      if (localStorage.getItem("SBG._cacheEpoch") !== CACHE_EPOCH) {
        _metaCache.clear();
        try { _resetIdb(); indexedDB.deleteDatabase("sbg-cache"); } catch (e) { /* ignore */ }
        try { indexedDB.deleteDatabase("sbg-gallery-cache"); } catch (e) { /* ignore */ }
        localStorage.setItem("SBG._cacheEpoch", CACHE_EPOCH);
        cacheReset = true; // data-shape change — force a fresh repaint below
      }
      // A full reindex re-extracts metadata WITHOUT changing file mtimes, so the
      // lightbox's per-item mtime check can't detect it. meta_epoch bumps on
      // reindex completion → drop cached METADATA only (L1 _metaCache, which also
      // holds the lightbox's initmeta: entries, + the IndexedDB "meta" store).
      // Thumbnails are left intact (the images didn't change); generation
      // (db_version) bumps do NOT trigger this.
      if (data.meta_epoch !== undefined && localStorage.getItem("SBG._metaEpoch") !== String(data.meta_epoch)) {
        _metaCache.clear();
        _metaCacheAPI.clear().catch(() => { });
        localStorage.setItem("SBG._metaEpoch", String(data.meta_epoch));
      }

      const newItems = data.items || [];

      if (data.db_empty && newItems.length === 0) {
        _showFirstTimeModal();
      }

      // Diff update: when the returned set is identical to what's already on
      // screen there is nothing to persist OR repaint. thumb_size is constant
      // within a mount (changing it remounts the gallery), so an unchanged relpath
      // set means identical thumb URLs — skipping the repaint is what stops the
      // gallery visibly "refreshing" 2-3 times on startup (persisted paint →
      // rescan:false → rescan:true all return the same list once the snapshot is
      // complete). A cache reset above still forces a repaint.
      const oldSet = new Set(state.allItems.map(x => x.relpath));
      const newSet = new Set(newItems.map(x => x.relpath));
      const added = newItems.filter(x => !oldSet.has(x.relpath));
      const removed = state.allItems.filter(x => !newSet.has(x.relpath));
      const noChange = state.allItems.length > 0 && added.length === 0 && removed.length === 0;

      state.allItems = newItems;
      _dataCache.items[state.rootId] = state.allItems;
      if (!noChange) _persistItems(state.rootId, state.allItems);
      statusLeft.textContent = "Ready";

      applyFilters();
      if (!noChange || cacheReset) renderFromScratch();
    } catch (e) {
      statusLeft.textContent = `Error: ${e.message || e}`;
    } finally {
      if (!rescan) setLoading(false);
    }
  }

  function _showFirstTimeModal() {
    // Never stack a second copy — fetchAllItems can fire multiple times while
    // the DB is still empty (init + background rescans), and a duplicate modal
    // resetting on top of the first looked like indexing had silently died.
    if (document.querySelector(".sbg-first-time-overlay")) return;

    const overlay = h("div", { class: "sbg-first-time-overlay" });
    const modal = h("div", { class: "sbg-first-time-modal" });
    const title = h("h3", { text: "🗂️ Building Index for the First Time" });
    const desc = h("p", { text: "This will scan all media files and parse their metadata. This may take 2–10 minutes depending on library size." });
    const progressBar = h("div", { class: "sbg-progress__bar" });
    const progressFillM = h("div", { class: "sbg-progress__fill" });
    progressBar.appendChild(progressFillM);
    const progressTextM = h("span", { class: "sbg-first-time-progress", text: "" });
    const startBtn = h("button", { class: "sbg-btn sbg-btn--primary", text: "🚀 Start Indexing" });
    const skipBtn = h("button", { class: "sbg-btn", text: "Skip (no metadata)" });

    modal.appendChild(title);
    modal.appendChild(desc);
    modal.appendChild(progressBar);
    modal.appendChild(progressTextM);
    modal.appendChild(h("div", { class: "sbg-first-time-btns" }, [startBtn, skipBtn]));
    overlay.appendChild(modal);
    root.appendChild(overlay);

    skipBtn.addEventListener("click", () => overlay.remove());
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      startBtn.textContent = "Indexing…";
      skipBtn.style.display = "none";
      progressTextM.textContent = "Starting…";
      try { await fetch("/sidebar_gallery/rebuild_index", { method: "POST" }); } catch { }
      let sawRunning = false; // ignore early polls before the worker spins up
      const poll = setInterval(async () => {
        try {
          const r = await fetch("/sidebar_gallery/reindex_progress");
          const p = await r.json();
          if (p.running) sawRunning = true;
          if (p.total > 0) {
            const pct = Math.round((p.done / p.total) * 100);
            progressFillM.style.width = pct + "%";
            progressTextM.textContent = `${p.done} / ${p.total} files (${pct}%)`;
          }
          // Real failure (e.g. "database is locked"): say so and offer a
          // retry — previously this was misread as success, the modal closed
          // and immediately reopened blank.
          if (!p.running && (p.error || p.phase === "error")) {
            clearInterval(poll);
            progressTextM.textContent = `Indexing failed: ${p.error || "unknown error"}. Click to try again.`;
            startBtn.disabled = false;
            startBtn.textContent = "🚀 Start Indexing";
            skipBtn.style.display = "";
            return;
          }
          if (!p.running && (sawRunning || p.phase === "done")) {
            clearInterval(poll);
            progressFillM.style.width = "100%";
            progressTextM.textContent = `Done! ${p.done || p.total} files indexed.`;
            setTimeout(() => { overlay.remove(); fetchAllItems(); }, 1500);
          }
        } catch { }
      }, 1000);
    });
  }

  // Remembered scroll positions per view (root + folder + kind), so toggling
  // All/Images/Videos or reopening the gallery returns to where you were.
  // One number per view in the module cache — no perf or memory cost.
  const _scrollKey = () => `${state.rootId}|${state.subfolder}|${state.kind}`;
  function _saveScrollPos() {
    (_dataCache.scrollPos = _dataCache.scrollPos || {})[_scrollKey()] = body.scrollTop;
  }
  function _restoreScrollPos() {
    const saved = (_dataCache.scrollPos || {})[_scrollKey()];
    if (saved > 0) body.scrollTop = Math.min(saved, Math.max(0, body.scrollHeight - body.clientHeight));
  }

  function refilter() {
    applyFilters();
    // Reset to the top first so the virtual window's indices line up with the
    // freshly filtered list (a stale scrollTop would mount cards for the wrong
    // index range — the root cause of wrong thumbs when toggling Videos-only),
    // then restore this view's remembered position (the scroll event re-renders
    // the virtual window for the right range).
    body.scrollTop = 0;
    renderFromScratch();
    _restoreScrollPos();
  }

  async function fetchNewItems() {
    const files = _dataCache._pendingFiles;
    _dataCache._pendingFiles = [];

    if (!files.length && (!_dataCache._lastServerTime || state.allItems.length === 0)) {
      return fetchAllItems({ rescan: true });
    }

    try {
      const ts = _dataCache._thumbSize || Math.max(512, thumbSize * 2);
      const body_payload = {
        root_id: state.rootId,
        thumb_size: ts,
      };
      if (files.length > 0) {
        body_payload.files = files;
      } else {
        body_payload.since = _dataCache._lastServerTime;
      }

      const resp = await fetch("/sidebar_gallery/list_new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body_payload),
      });
      if (!resp.ok) throw new Error(resp.statusText);
      const data = await resp.json();

      if (data.server_time) _dataCache._lastServerTime = data.server_time;

      const added = data.items || [];
      if (added.length === 0) return;

      for (const newItem of added) {
        const ck = `${newItem.root_id}:${newItem.relpath}`;
        _metaCache.delete(ck);
        _metaCacheAPI.put(ck, null).catch(() => { });
      }

      added.sort((a, b) => b.mtime - a.mtime);
      const existingPaths = new Set(state.allItems.map(x => x.relpath));
      const trulyNew = added.filter(x => !existingPaths.has(x.relpath));
      if (trulyNew.length === 0) return;
      state.allItems = [...trulyNew, ...state.allItems];
      _dataCache.items[state.rootId] = state.allItems;
      _schedulePersist(); // so the next cold-start first paint includes these

      if (state._searchMatches) {
        // Active search: delta search new items
        const newRelpaths = added.map(a => a.relpath);
        try {
          const resp2 = await fetch("/sidebar_gallery/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              root_id: state.rootId,
              tags: state.searchTags.map(t => ({ field: t.field, value: t.value, exclude: t.exclude || false })),
              mode: state.searchMode,
              relpaths: newRelpaths,
            }),
          });
          if (resp2.ok) {
            const data2 = await resp2.json();
            const deltaMatches = data2.matches || [];
            for (const m of deltaMatches) {
              if (typeof m === "object" && m.relpath) {
                state._searchMatches.set(m.relpath, m.matched_fields || [{ field: "any", count: 1 }]);
              }
            }
            _dataCache.lastSearchMatches = state._searchMatches;
          }
        } catch { /* delta search failed — non-critical */ }
        const nameTags = state.searchTags.filter(t => t.field === "name");
        if (nameTags.length > 0) {
          for (const it of added) {
            const name = it.filename.toLowerCase();
            let nameMatch;
            if (state.searchMode === "AND") {
              nameMatch = nameTags.every(t => name.includes(t.value));
            } else {
              nameMatch = nameTags.some(t => name.includes(t.value));
            }
            if (nameMatch && !state._searchMatches.has(it.relpath)) {
              state._searchMatches.set(it.relpath, [{ field: "name", count: 1 }]);
            }
          }
          _dataCache.lastSearchMatches = state._searchMatches;
        }
      }

      applyFilters();
      renderFromScratch();
      document.dispatchEvent(new CustomEvent("sbg-items-updated", { detail: { items: state.filteredItems } }));
      statusLeft.textContent = "Ready";
    } catch (e) {
      console.warn("[SBG] Delta refresh failed, falling back to full:", e);
      return fetchAllItems({ rescan: true });
    }
  }

  /* ── Search logic ───────────────────────────────────────────────── */

  let qTimer = null;
  let _searchAbort = null;

  function renderSearchTags() {
    searchTagsWrap.innerHTML = "";
    for (let i = 0; i < state.searchTags.length; i++) {
      const tag = state.searchTags[i];
      const isNeg = tag.exclude === true;
      const pill = h("span", { class: "sbg-search-tag" + (isNeg ? " sbg-search-tag--neg" : "") });
      const tagBg = isNeg ? getSetting(S.SEARCH_TAG_NEG_COLOR, "") : getSetting(S.SEARCH_TAG_COLOR, "");
      if (tagBg) {
        pill.style.background = tagBg + "33";
        pill.style.borderColor = tagBg;
      }
      const text = h("span", { text: (isNeg ? "−" : "") + tag.raw, class: "sbg-search-tag__text" });
      text.style.cursor = "pointer";
      const rm = h("span", { class: "sbg-search-tag__remove", text: "✕" });
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        state.searchTags.splice(i, 1);
        renderSearchTags();
        _triggerMultiSearch();
      });
      text.addEventListener("click", (e) => {
        e.stopPropagation();
        const inp = h("input", { type: "text", class: "sbg-search-tag__edit", value: tag.raw });
        inp.style.cssText = "background:transparent;border:none;color:inherit;font:inherit;width:" + Math.max(40, Math.min(tag.raw.length * 7, 200)) + "px;outline:none;padding:0;";
        text.replaceWith(inp);
        inp.focus();
        inp.select();
        const commit = () => {
          let newVal = inp.value.trim();
          if (newVal && newVal !== tag.raw) {
            let exclude = false;
            if (newVal.startsWith("-")) {
              exclude = true;
              newVal = newVal.slice(1).trim();
            }
            const lc = newVal.toLowerCase();
            let field = "any", value = lc;
            const ci = lc.indexOf(":");
            if (ci > 0 && ci < 30) {
              field = lc.slice(0, ci).trim();
              value = lc.slice(ci + 1).trim();
              const _layout = getLayout();
              const canonical = SectionRegistry.getCanonicalName(field, _layout);
              if (canonical) field = SectionRegistry.getSearchField(canonical);
            }
            state.searchTags[i] = { field, value, raw: newVal, exclude };
            renderSearchTags();
            _triggerMultiSearch();
          } else if (!newVal) {
            state.searchTags.splice(i, 1);
            renderSearchTags();
            _triggerMultiSearch();
          } else {
            inp.replaceWith(text);
          }
        };
        inp.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { ke.preventDefault(); commit(); }
          else if (ke.key === "Escape") { ke.preventDefault(); inp.replaceWith(text); }
        });
        inp.addEventListener("blur", commit);
      });
      pill.appendChild(text);
      pill.appendChild(rm);
      searchTagsWrap.appendChild(pill);
    }
    searchModeSel.style.display = state.searchTags.length > 1 ? "inline-block" : "none";
    searchClear.classList.toggle("sbg-search-clear--visible", state.searchTags.length > 0 || qInput.value.length > 0);
  }

  function _computeSearchScopes(tags) {
    if (tags.every(t => t.field === "any" || t.field === "name")) return null;
    const _searchFieldToCanonical = {};
    for (const [name, def] of Object.entries(SectionRegistry.sectionDefs)) {
      if (def.searchField) _searchFieldToCanonical[def.searchField] = name;
    }
    const scopes = new Set();
    for (const t of tags) {
      if (t.field === "any" || t.field === "name") continue;
      const canonical = _searchFieldToCanonical[t.field];
      if (canonical) scopes.add(canonical);
      else scopes.add(t.field);
    }
    return scopes.size > 0 ? scopes : null;
  }

  async function _triggerMultiSearch() {
    clearTimeout(qTimer);
    if (_searchAbort) { _searchAbort.abort(); _searchAbort = null; }

    if (state.searchTags.length === 0) {
      state.q = "";
      state._searchMatches = null;
      _setSearchQuery("");
      _setSearchScopes(null);
      _dataCache.searchTags = [];
      _dataCache.lastSearchMode = state.searchMode;
      _dataCache.lastSearchMatches = null;
      hideProgress();
      refilter();
      statusLeft.textContent = "Ready";
      return;
    }

    // Name-only: client-side filtering
    const allNameOnly = state.searchTags.every(t => t.field === "name");
    if (allNameOnly) {
      _dataCache.searchTags = [...state.searchTags];
      _dataCache.lastSearchMode = state.searchMode;
      const matchMap = new Map();
      for (const it of state.allItems) {
        const name = it.filename.toLowerCase();
        let matches;
        if (state.searchMode === "AND") {
          matches = state.searchTags.every(t => name.includes(t.value));
        } else {
          matches = state.searchTags.some(t => name.includes(t.value));
        }
        if (matches) matchMap.set(it.relpath, [{ field: "name", count: 1 }]);
      }
      state.q = "";
      state._searchMatches = matchMap;
      _dataCache.lastSearchMatches = matchMap;
      _setSearchQuery(state.searchTags.map(t => t.value).join("\x00"));
      _setSearchScopes(_computeSearchScopes(state.searchTags));
      refilter();
      statusLeft.textContent = `Found ${matchMap.size} matches (filename)`;
      showToast(`Found ${matchMap.size} matches`);
      return;
    }

    qTimer = setTimeout(async () => {
      const ctrl = new AbortController();
      _searchAbort = ctrl;
      try {
        statusLeft.textContent = "Searching…";
        showProgress("Searching…", -1);
        _dataCache.searchTags = [...state.searchTags];
        _dataCache.lastSearchMode = state.searchMode;
        const resp = await fetch("/sidebar_gallery/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            root_id: state.rootId,
            tags: state.searchTags.map(t => ({ field: t.field, value: t.value, exclude: t.exclude || false })),
            mode: state.searchMode
          }),
          signal: ctrl.signal,
        });

        if (!resp.ok) throw new Error(resp.statusText);
        const data = await resp.json();
        hideProgress();

        const rawMatches = data.matches || [];
        const matchMap = new Map();
        state.q = "";

        for (const m of rawMatches) {
          if (typeof m === "object" && m.relpath) {
            matchMap.set(m.relpath, m.matched_fields || [{ field: m.matched_field || "any", count: 1 }]);
          } else if (typeof m === "string") {
            matchMap.set(m, [{ field: "any", count: 1 }]);
          }
        }

        const nameTags = state.searchTags.filter(t => t.field === "name");
        if (nameTags.length > 0) {
          const virtualMap = new Map();
          for (const it of state.allItems) {
            const name = it.filename.toLowerCase();
            let matchesPattern = false;
            if (state.searchMode === "AND") {
              matchesPattern = nameTags.every(t => name.includes(t.value));
            } else {
              matchesPattern = nameTags.some(t => name.includes(t.value));
            }
            const inBackend = matchMap.has(it.relpath);
            if (state.searchMode === "AND") {
              if (matchesPattern && (state.searchTags.length === nameTags.length || inBackend)) virtualMap.set(it.relpath, [{ field: "name", count: 1 }]);
            } else {
              if (matchesPattern || inBackend) virtualMap.set(it.relpath, [{ field: "name", count: 1 }]);
            }
          }
          state._searchMatches = virtualMap;
          _dataCache.lastSearchMatches = virtualMap;
        } else {
          state._searchMatches = matchMap;
          _dataCache.lastSearchMatches = matchMap;
        }

        _setSearchQuery(state.searchTags.map(t => t.value).join("\x00"));
        _setSearchScopes(_computeSearchScopes(state.searchTags));
        refilter();

        const total = data.scanned || 0;
        const totalMatches = state._searchMatches.size;
        const inFolder = state.subfolder ? state.filteredItems.length : totalMatches;
        statusLeft.textContent = state.subfolder
          ? `Found ${totalMatches} matches (${inFolder} in folder) of ${total} scanned`
          : `Found ${totalMatches} of ${total} scanned`;
        showToast(`Found ${totalMatches} matches`);
      } catch (e) {
        if (e.name !== "AbortError") {
          statusLeft.textContent = `Search error: ${e?.message || e}`;
          hideProgress();
        }
      }
    }, 400);
  }

  /* ── Search event listeners ─────────────────────────────────────── */

  qInput.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && autoCompleteDropdown.style.display !== "none") {
      e.preventDefault();
      _acAccept();
    } else if (e.key === "ArrowDown" && autoCompleteDropdown.style.display !== "none") {
      e.preventDefault();
      _acNavigate(1);
    } else if (e.key === "ArrowUp" && autoCompleteDropdown.style.display !== "none") {
      e.preventDefault();
      _acNavigate(-1);
    } else if (e.key === "Escape" && autoCompleteDropdown.style.display !== "none") {
      autoCompleteDropdown.style.display = "none";
    } else if (e.key === "Enter") {
      e.preventDefault();
      autoCompleteDropdown.style.display = "none";
      const val = qInput.value.trim().toLowerCase();
      if (val) {
        let exclude = false;
        let rawInput = String(qInput.value).trim();
        let processVal = val;
        if (processVal.startsWith("-")) {
          exclude = true;
          processVal = processVal.slice(1).trim();
          rawInput = rawInput.replace(/^-\s*/, "");
        }
        let field = "any";
        let value = processVal;
        const colonIdx = processVal.indexOf(":");
        if (colonIdx > 0 && colonIdx < 30) {
          field = processVal.slice(0, colonIdx).trim();
          value = processVal.slice(colonIdx + 1).trim();
          const _layout = getLayout();
          const canonical = SectionRegistry.getCanonicalName(field, _layout);
          if (canonical) field = SectionRegistry.getSearchField(canonical);
        } else {
          // No colon: if the bare term names a known section (e.g. "adetailer",
          // "lora", "controlnet"), scope to that section so it lists every item
          // that has it — matching what users expect from "adetailer" without
          // the trailing colon. Otherwise fall back to a free-text "any" search.
          const _layout = getLayout();
          const canonical = SectionRegistry.getCanonicalName(processVal, _layout);
          if (canonical) { field = SectionRegistry.getSearchField(canonical); value = ""; }
        }
        state.searchTags.push({ field, value, raw: rawInput, exclude });
        qInput.value = "";
        renderSearchTags();
        _triggerMultiSearch();
        qInput.focus();
      }
    } else if (e.key === "Backspace" && qInput.value === "") {
      if (state.searchTags.length > 0) {
        state.searchTags.pop();
        renderSearchTags();
        _triggerMultiSearch();
        qInput.focus();
      }
    }
  });

  searchClear.addEventListener("click", () => {
    qInput.value = "";
    state.searchTags = [];
    clearTimeout(qTimer);
    if (_searchAbort) { _searchAbort.abort(); _searchAbort = null; }
    state.q = "";
    state._searchMatches = null;
    _setSearchQuery("");
    _setSearchScopes(null);
    _dataCache.searchTags = [];
    renderSearchTags();
    hideProgress();
    refilter();
    statusLeft.textContent = "Ready";
  });

  searchTagsWrap.parentElement?.addEventListener("click", (e) => {
    if (e.target === searchTagsWrap.parentElement || e.target === searchTagsWrap) qInput.focus();
  });

  qInput.addEventListener("input", () => {
    searchClear.classList.toggle("sbg-search-clear--visible", state.searchTags.length > 0 || qInput.value.length > 0);
  });

  // External search submission (from layout editor)
  if (window._sbgSearchSubmitHandler) {
    document.removeEventListener("sbg-search-submit", window._sbgSearchSubmitHandler);
  }
  window._sbgSearchSubmitHandler = (e) => {
    const { field, value, raw } = e.detail;
    state.searchTags.push({ field, value, raw });
    qInput.value = "";
    renderSearchTags();
    _triggerMultiSearch();
    qInput.focus();
  };
  document.addEventListener("sbg-search-submit", window._sbgSearchSubmitHandler);

  /* ── Kind + sort event listeners ────────────────────────────────── */

  for (const btn of [kindBtnAll, kindBtnImg, kindBtnVid]) {
    btn.addEventListener("click", () => {
      _saveScrollPos(); // remember the outgoing view's position
      const newKind = btn.dataset.kind;
      state.kind = newKind;
      _dataCache.lastKind = newKind;
      for (const b of [kindBtnAll, kindBtnImg, kindBtnVid]) b.classList.remove("sbg-kind-btn--active");
      btn.classList.add("sbg-kind-btn--active");
      refilter();
    });
  }
  sortSel.addEventListener("change", () => { state.sort = sortSel.value; _dataCache.lastSort = state.sort; refilter(); });

  /* ── Assemble DOM ───────────────────────────────────────────────── */

  const root = h("div", { class: "sbg-root" }, [toolbar, statusBar, bodyWrap]);
  if (theme !== "comfyui") root.setAttribute("data-theme", theme);

  function _applyCustomThemeVars(r, t) {
    const readSetting = (id, fallback) => getSetting(id, fallback);

    if (t === "custom") {
      r.style.setProperty("--sbg-bg", readSetting("CUSTOM_BG", "#1a1a1a"));
      r.style.setProperty("--sbg-surface", readSetting("CUSTOM_SURFACE", "#222222"));
      r.style.setProperty("--sbg-border", readSetting("CUSTOM_BORDER", "#444444"));
      r.style.setProperty("--sbg-text", readSetting("CUSTOM_TEXT", "#e0e0e0"));
      r.style.setProperty("--sbg-accent", readSetting("CUSTOM_ACCENT", "#7c6aef"));
    } else {
      r.style.removeProperty("--sbg-bg");
      r.style.removeProperty("--sbg-surface");
      r.style.removeProperty("--sbg-border");
      r.style.removeProperty("--sbg-text");
      r.style.removeProperty("--sbg-accent");
    }
  }
  _applyCustomThemeVars(root, theme);

  mountEl.appendChild(root);

  /* ── Init ────────────────────────────────────────────────────────── */

  _dataCache._mountEl = mountEl;
  _dataCache._fetchAllItems = fetchAllItems;
  _dataCache._fetchNewItems = fetchNewItems;
  _dataCache._refilter = refilter;

  (async () => {
    try {
      const hasCachedItems = _dataCache.items[state.rootId];
      const hasCachedRoots = _dataCache.roots;
      const hasCachedSubs = _dataCache.subfolders[state.rootId];

      if (hasCachedRoots && hasCachedItems && hasCachedSubs) {
        state.roots = _dataCache.roots;
        state.rootId = _dataCache.lastRootId;
        state.subfolder = _dataCache.lastSubfolder;
        state.kind = _dataCache.lastKind;
        state.sort = _dataCache.lastSort || defaultSort;
        state.allItems = _dataCache.items[state.rootId];
        state.subfolders = _dataCache.subfolders[state.rootId];

        if (_dataCache.searchTags && _dataCache.searchTags.length > 0) {
          state.searchTags = _dataCache.searchTags;
          state.searchMode = _dataCache.lastSearchMode || "AND";
          searchModeSel.value = state.searchMode;
          renderSearchTags();
          if (_dataCache.lastSearchMatches) {
            state._searchMatches = _dataCache.lastSearchMatches;
          }
        }

        rebuildRoots();
        for (const b of [kindBtnAll, kindBtnImg, kindBtnVid]) {
          b.classList.toggle("sbg-kind-btn--active", b.dataset.kind === state.kind);
        }
        sortSel.value = state.sort;

        statusLeft.textContent = "Ready";
        applyFilters();
        await new Promise(r => requestAnimationFrame(r));
        renderFromScratch();
        _restoreScrollPos(); // reopening returns to where you were

        if (_dataCache.stale) {
          _dataCache.stale = false;
          fetchNewItems();
        }
      } else {
        _dataCache.stale = false;
        const persistedItems = await _loadPersistedItems(state.rootId);
        if (persistedItems && persistedItems.length > 0) {
          state.allItems = persistedItems;
          _dataCache.items[state.rootId] = persistedItems;
          statusLeft.textContent = "Ready";
          applyFilters();
          await new Promise(r => requestAnimationFrame(r));
          renderFromScratch();
          Promise.all([refreshConfig(), loadSubfolders()]).catch(() => { });
          // Read the current DB immediately (fast) instead of awaiting a full forced
          // disk rescan (~1 min). The server still kicks off a background incremental
          // scan; any files indexed while away are merged here, and brand-new ones
          // surface on the next delta refresh — matching the intended behaviour:
          // "show previous images instantly, then background-scan for new ones."
          // 1) Fast DB read for an immediate refresh of the cached list, then
          // 2) an awaited rescan so brand-new files (e.g. reference/initial
          //    images from generations made while away) and deletions reconcile
          //    without needing a server reboot. (2) re-renders in the background.
          fetchAllItems({ rescan: false })
            .then(() => fetchAllItems({ rescan: true }))
            .catch(() => { });
        } else {
          await Promise.all([refreshConfig(), loadSubfolders(), fetchAllItems({ rescan: true })]);
        }
      }
    } catch (e) {
      statusLeft.textContent = `Error: ${e?.message || e}`;
    }
    watchReindexProgress();
  })();

  /* ── Public API ──────────────────────────────────────────────────── */

  return {
    state,
    fetchAllItems,
    fetchNewItems,
    refilter,
    refreshConfig,
  };
}
