/**
 * sbg-gallery.js: Gallery grid, search, virtual scrolling, and data management
 *
 * This module owns:
 *   - Gallery grid rendering (virtual scroll)
 *   - Search bar, tags, autocomplete, server/client search
 *   - Folder navigation (root picker, subfolder tree)
 *   - Sort/filter controls
 *   - Data fetching (list_all, list_new, delta refresh)
 *   - First-time indexing modal
 *
 * Entry point: initGallery(mountEl, config) returns { state, fetchAllItems, ... }
 */

import {
  _dataCache, searchState,
  _metaCache, _persistItems, _loadPersistedItems,
  h, api, fmtBytes, timeAgo,
  showToast, isVideo,
  _thumbMemCache, _thumbCacheAPI, _metaCacheAPI, _resetIdb,
  initThumbObserver, getThumbObserver, resetThumbObserver, resetFailedThumbs,
  PLAY_SVG, VIDEO_ICON, IMG_ICON, IMG_FILTER_ICON, SEARCH_SVG, GEAR_SVG,
  S, getSetting,
  progressPoller, formatProgress,
} from "./sbg-core.js";

import { SectionRegistry } from "./sbg-section-registry.js";
import { getSectionRenames, getCustomSectionSearchMap, setCatalogTitles } from "./sbg-translation-layer.js";

/* SEARCH PREFIXES */

const SEARCH_PREFIXES = [
  "name:", "model:", "vae:", "clip:", "lora:", "sampler:", "controlnet:", "prompt:", "keyword:", "app:",
  "mmaudio:", "sampling:", "adetailer:", "upscaling:", "interpolation:",
  "fileinfo:", "file info:", "extra:", "workflow_nodes:", "workflow nodes:",
];

/* VIRTUAL SCROLL ENGINE

   Instead of creating DOM nodes for every image in the library, cards are
   positioned absolutely inside the grid container and only those within
   the visible viewport (plus a buffer) exist in the DOM at any time.

   Key pieces:
     _cardMap           - Map<itemIndex, cardEl>  (currently mounted cards)
     _visRange          - { first, last } item indices currently mounted
     _metrics           - { colCount, rowH, colW } computed from container
     _scrollRafId       - rAF id for throttled scroll handler */

const DEFAULT_BUFFER_ROWS = 12; // extra rows rendered above/below viewport

/**
 * Compute grid layout metrics from container dimensions and thumb size.
 */
function _computeMetrics(container, thumbSize, gap, searchActive, perRow = 0) {
  const cw = container.clientWidth;
  if (cw <= 0) return null;
  // perRow > 0 = fixed number of items per row; thumbnail size is then derived
  // from the container width instead of the size setting.
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
 * Compute layout positions for all items in aspect-ratio ("masonry") mode.
 * Despite the historical name, this is a justified-rows layout: items flow
 * left-to-right, top-to-bottom in strict reading order, and each row is
 * scaled to fill the container width while every card keeps its true aspect
 * ratio. Supports mixed portrait/landscape without cropping to squares.
 * Each item gets a pre-computed { x, y, w, h }.
 *
 * @param {Array} items - filtered items array
 * @param {object} metrics - { colCount, colW, gap, infoH }
 * @returns {{ positions: Array<{x,y,w,h}>, totalHeight: number }}
 */
function _computeMasonryLayout(items, metrics, fixedPerRow = 0) {
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
      // Fixed count: height follows the ARs; only stop a sparse last row
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


/* GALLERY INIT */

/**
 * Initialize the gallery inside the given mount element.
 *
 * @param {HTMLElement} mountEl - the sidebar container element
 * @param {object} config - { openLightbox, openGallerySettings, app }
 * @returns {object} - public API: { state, fetchAllItems, fetchNewItems, refilter }
 */
export function initGallery(mountEl, config) {
  const { openLightbox, openGallerySettings } = config;

  // Drop thumbnail observations from a previous gallery instance so a remount
  // (e.g. after a thumbnail-size change) can't inject stale thumbnails into the
  // new cards.
  resetThumbObserver();

  // Stop a prior instance's progress subscription and resize observer. ComfyUI can
  // re-render this sidebar tab, leaving old closures running against detached DOM.
  // Tracked on window so a fresh closure can find and clear the previous one.
  if (window._sbgProgressUnsub) { try { window._sbgProgressUnsub(); } catch { } window._sbgProgressUnsub = null; }
  if (window._sbgResizeObserver) { try { window._sbgResizeObserver.disconnect(); } catch { } window._sbgResizeObserver = null; }
  // Clear a prior instance's auto-refresh timer + focus/visibility listeners
  // before this mount installs fresh ones.
  if (window._sbgPollTimer) { clearInterval(window._sbgPollTimer); window._sbgPollTimer = null; }
  if (window._sbgRefreshAbort) { try { window._sbgRefreshAbort.abort(); } catch { } window._sbgRefreshAbort = null; }

  // Bound the persistent thumbnail cache (content-addressed entries orphan as
  // files change and IndexedDB has no LRU). Fire-and-forget on mount.
  _thumbCacheAPI.pruneIfOver(50000);

  /* Read settings */

  const thumbSize = Math.max(64, Math.min(256, Number(getSetting(S.THUMB_SIZE, 110)) || 110));
  // Fixed items-per-row (0 = auto: fit by thumbnail size).
  const thumbPerRow = (() => {
    const v = getSetting(S.THUMB_PER_ROW, "auto");
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.min(12, Math.floor(n)) : 0;
  })();
  const thumbShape = getSetting(S.THUMB_SHAPE, "square");
  // Normalize legacy sort values to the current creation/modified keys.
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

  /* Gallery state */

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

  /* Sorting */

  // Created time = ctime (falls back to mtime); Modified time = mtime_real
  // (falls back to ctime/mtime). "newest"/"oldest" are creation-time aliases
  // kept for saved settings.
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
    if (state._searchMatches) {
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

  /* Search state sync */

  function _setSearchQuery(val) {
    searchState.query = val;
  }

  /* DOM: Toolbar */

  const folderNav = h("div", { class: "sbg-folder-nav" });

  // The two crumb dropdowns (roots, folders) share one open-popup slot with a
  // click toggle. The outside-mousedown dismiss ignores the anchor button, so
  // the button's own click handler decides between closing the open popup and
  // building a fresh one; without that exclusion the dismiss removes the popup
  // first and the click instantly rebuilds it, so a second click on the button
  // could never close the dropdown. Keys are stable strings because the
  // buttons themselves are rebuilt on every renderFolderNav.
  let _crumbPopup = null; // { anchorKey, popup, close }
  function _closeCrumbPopup() {
    if (!_crumbPopup) return;
    _crumbPopup.close();
    _crumbPopup = null;
  }
  function _toggleCrumbPopup(anchorKey, btn, build, onClose) {
    if (_crumbPopup && _crumbPopup.anchorKey === anchorKey) { _closeCrumbPopup(); return null; }
    _closeCrumbPopup();
    const popup = build();
    document.body.appendChild(popup);
    const rect = btn.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.left = rect.left + "px";
    popup.style.top = (rect.bottom + 2) + "px";
    popup.style.zIndex = "100000";
    const dismiss = (ev) => {
      // Self-guard: a popup removed behind our back must not close its successor.
      if (!popup.isConnected) { document.removeEventListener("mousedown", dismiss); return; }
      if (popup.contains(ev.target) || ev.target === btn || btn.contains(ev.target)) return;
      _closeCrumbPopup();
    };
    const close = () => {
      if (onClose) onClose(popup);
      popup.remove();
      document.removeEventListener("mousedown", dismiss);
    };
    _crumbPopup = { anchorKey, popup, close };
    setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
    return popup;
  }

  function renderFolderNav() {
    folderNav.innerHTML = "";
    const rootLabel = (state.roots.find(r => r.id === state.rootId) || {}).label || state.rootId;

    // Root button (only shown if multiple roots)
    if (state.roots.length > 1) {
      const rootBtn = h("button", { class: "sbg-crumb sbg-crumb--root", text: rootLabel, title: "Click to change root" });
      rootBtn.addEventListener("click", () => {
        _toggleCrumbPopup("root", rootBtn, () => {
          const popup = h("div", { class: "sbg-crumb-popup" });
          for (const r of state.roots) {
            const item = h("div", {
              class: `sbg-crumb-popup__item${r.id === state.rootId ? " sbg-crumb-popup__item--active" : ""}`,
              text: r.label,
            });
            item.addEventListener("click", () => {
              _closeCrumbPopup();
              switchRoot(r.id);
            });
            popup.appendChild(item);
          }
          return popup;
        });
      });
      folderNav.appendChild(rootBtn);
    }

    // Folder dropdown button
    if (state.subfolders.length > 0) {
      const currentLabel = state.subfolder || "All folders";
      const pickBtn = h("button", { class: "sbg-crumb sbg-crumb--pick", text: "📂 " + currentLabel, title: "Browse folders" });
      pickBtn.addEventListener("click", () => {
        // Scroll position persists through every close path (dismiss, toggle,
        // pick) via the toggle helper's onClose hook.
        const popup = _toggleCrumbPopup("folders", pickBtn, () => {
          const p = h("div", { class: "sbg-crumb-popup sbg-crumb-popup--folders" });
          const allItem = h("div", { class: `sbg-crumb-popup__item${!state.subfolder ? " sbg-crumb-popup__item--active" : ""}`, text: "📁 All folders" });
          allItem.addEventListener("click", () => {
            _closeCrumbPopup();
            state.subfolder = "";
            _dataCache.lastSubfolder = "";
            refilter();
            renderFolderNav();
          });
          p.appendChild(allItem);
          for (const sf of state.subfolders) {
            const item = h("div", {
              class: `sbg-crumb-popup__item${sf === state.subfolder ? " sbg-crumb-popup__item--active" : ""}`,
              text: "📁 " + sf,
            });
            item.addEventListener("click", () => {
              _closeCrumbPopup();
              state.subfolder = sf;
              _dataCache.lastSubfolder = sf;
              refilter();
              renderFolderNav();
            });
            p.appendChild(item);
          }
          p.style.maxHeight = "300px";
          p.style.overflowY = "auto";
          return p;
        }, (p) => { _dataCache.folderScrollTop = p.scrollTop; });
        if (!popup) return; // second click on the button; the dropdown closed
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

  /* Search bar */

  const qInput = h("input", { class: "sbg-input", placeholder: "Search all fields… (name: for filename only)", title: "Search across all metadata fields. Press Enter to add as a tag. Use name: for filename-only, model: lora: prompt: keyword: sampler: controlnet: for specific fields" });
  const searchClear = h("button", { class: "sbg-search-clear", text: "✕", title: "Clear search" });
  // Refresh button shown in the same slot when the search is empty; swaps to the
  // clear "✕" once a query/tags are active. Rescans disk without opening Diagnostics.
  const searchRefresh = h("button", { class: "sbg-search-refresh", text: "⟳", title: "Refresh gallery (rescan disk)" });
  searchRefresh.addEventListener("click", () => { fetchAllItems({ rescan: true }); });
  const _syncSearchBtns = () => {
    const active = state.searchTags.length > 0 || qInput.value.length > 0;
    searchClear.classList.toggle("sbg-search-clear--visible", active);
    searchRefresh.classList.toggle("sbg-search-refresh--visible", !active);
  };
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

  // Resolve a user-typed search field name. Canonical sections come first
  // (built-in names, aliases, layout-editor retitles); then custom sections
  // and tab labels, which resolve to the backend field their params read (a
  // workflow_nodes search scoped by node classes, or a data bucket like
  // adetailer), so a user-made tab like "LLava" is searchable under its name.
  function _resolveSearchField(typed) {
    const canonical = SectionRegistry.getCanonicalName(typed, getSectionRenames());
    if (canonical) return { field: SectionRegistry.getSearchField(canonical) };
    const custom = getCustomSectionSearchMap()[String(typed).trim().toLowerCase()];
    if (custom) return { field: custom.field, nodeClasses: custom.classes || null };
    return null;
  }

  // One home for turning a typed search string into a tag object: the leading
  // minus (exclusion), the field:value split, the field-name resolution and
  // the bare-term section scope all live here, so the create path and the
  // chip-edit path can never drift apart. `raw` keeps the typed casing with
  // the minus stripped; the pill prepends the minus glyph from `exclude`.
  // Returns null when nothing searchable remains.
  function parseSearchTag(input) {
    let raw = String(input).trim();
    if (!raw) return null;
    let exclude = false;
    if (raw.startsWith("-")) {
      exclude = true;
      raw = raw.replace(/^-\s*/, "");
      if (!raw) return null;
    }
    const lc = raw.toLowerCase();
    let field = "any", value = lc, nodeClasses = null;
    const ci = lc.indexOf(":");
    if (ci > 0 && ci < 30) {
      field = lc.slice(0, ci).trim();
      value = lc.slice(ci + 1).trim();
      const r = _resolveSearchField(field);
      if (r) { field = r.field; nodeClasses = r.nodeClasses || null; }
    } else {
      // No colon: a bare term naming a known section (built-in, renamed or
      // custom) scopes to that section and lists every item that has it;
      // anything else stays a free-text "any" search.
      const r = _resolveSearchField(lc);
      if (r) { field = r.field; nodeClasses = r.nodeClasses || null; value = ""; }
    }
    return { field, value, raw, exclude, ...(nodeClasses ? { node_classes: nodeClasses } : {}) };
  }

  function _updateAutocomplete() {
    const val = qInput.value.toLowerCase().trim();
    autoCompleteDropdown.innerHTML = "";
    _acSelectedIdx = -1;
    // Suggest only after the user has typed something: this also runs on
    // focus, and focusing the empty box must not pop the dropdown open.
    if (val.length === 0 || val.includes(":")) { autoCompleteDropdown.style.display = "none"; return; }
    // Sections retitled in the layout editor are offered under their new names
    // as well (lowercased, matching the built-in prefixes). The built-in names
    // keep resolving, so both spellings work. User-made sections and tab
    // labels are offered too; they resolve to the field their params read.
    const candidates = [...SEARCH_PREFIXES];
    for (const [canonical, renamed] of Object.entries(getSectionRenames())) {
      if (!SectionRegistry.sectionDefs[canonical]?.searchField) continue;
      const p = renamed.toLowerCase() + ":";
      if (!candidates.includes(p)) candidates.push(p);
    }
    for (const key of Object.keys(getCustomSectionSearchMap())) {
      const p = key + ":";
      if (!candidates.includes(p)) candidates.push(p);
    }
    const matches = candidates.filter(p => p.startsWith(val));
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
      _acSelectedIdx = -1; // the highlight is consumed; a later Enter commits
      return true;
    }
    if (items.length > 0 && autoCompleteDropdown.style.display !== "none") {
      qInput.value = items[0].textContent;
      autoCompleteDropdown.style.display = "none";
      _acSelectedIdx = -1;
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
    searchRefresh,
    searchClear,
    autoCompleteDropdown,
  ]);
  _syncSearchBtns(); // an empty query shows the refresh button

  /* Progress bar */

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

  /* Status bar */

  const statusLeft = h("span", { class: "sbg-status__left", text: "Ready" });
  const statusRight = h("span", { class: "sbg-status__right" });

  // Auto-reindex indicator. After a restart that updated the metadata parser,
  // the server re-reads every file in the background; show its progress here so
  // it's visible without opening Diagnostics.
  const statusReindex = h("span", {
    class: "sbg-status__reindex",
    style: "color:var(--sbg-accent);display:none;white-space:nowrap",
    title: "The metadata parser was updated - all files are being re-read in the background. The gallery stays usable; updated metadata appears as files are re-indexed.",
  });
  // Status-bar consumer of the shared progress poller (sbg-core.js): shows the
  // full rebuild if one runs, else any root's first index. Subscribes at mount
  // and unsubscribes once everything settles.
  function watchReindexProgress() {
    // Runs at the end of the async boot, which can finish AFTER this gallery
    // instance was replaced by a remount. A stale instance must not subscribe
    // (its status element is detached) and must not overwrite the live
    // instance's published unsubscribe handle. Clearing any current occupant
    // before publishing keeps exactly one subscription alive.
    if (!statusReindex.isConnected) return;
    if (window._sbgProgressUnsub) { try { window._sbgProgressUnsub(); } catch { } }
    let sawRunning = false;
    const unsub = progressPoller.subscribe((data, meta) => {
      let e = null;
      if (data) {
        if (data.full && data.full.running) e = data.full;
        else e = Object.values(data.roots || {}).find(x => x && x.running) || null;
      }
      if (e) {
        sawRunning = true;
        statusReindex.style.display = "";
        const f = formatProgress(e);
        statusReindex.textContent = e.phase === "scanning"
          ? `⟳ ${f.text}`
          : `⟳ Updating metadata index… ${f.text}`;
        return;
      }
      if (meta.settled) {
        if (sawRunning) {
          statusReindex.textContent = "✓ Metadata index updated";
          setTimeout(() => { statusReindex.style.display = "none"; }, 8000);
        } else {
          statusReindex.style.display = "none";
        }
        unsub();
        if (window._sbgProgressUnsub === unsub) window._sbgProgressUnsub = null;
      }
    });
    window._sbgProgressUnsub = unsub;
  }

  const statusBar = h("div", { class: "sbg-status" }, [statusLeft, statusReindex, statusRight]);

  /* Grid container */

  const grid = h("div", { class: "sbg-grid sbg-grid--virtual" });
  const spacer = h("div", { class: "sbg-grid__spacer" });
  grid.appendChild(spacer);

  const body = h("div", { class: "sbg-body" }, [grid]);
  // Wrap the scroll area so a custom overlay scrollbar can float over the content.
  // Chrome/Edge styled scrollbars always reserve a gutter and never overlay, so
  // _attachOverlayScrollbar adds one there. Firefox keeps its native overlay one.
  const bodyWrap = h("div", { class: "sbg-body-wrap" }, [body]);

  grid.style.setProperty("--sbg-thumb-size", `${thumbSize}px`);

  /* Virtual scroll state */

  const GAP = 8;
  let _metrics = null;
  let _cardMap = new Map();   // card elements, keyed by item index
  let _scrollRafId = null;
  let _resizeObserver = null;
  let _emptyMsg = null;       // empty state placeholder

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
   * Create the card element for an item. For virtual scrolling, cards are
   * positioned absolutely. Always builds a fresh card; reusing unmounted
   * card elements would need careful src/event cleanup.
   */
  function _createCard(it, index) {
    const shapeClass = thumbShape === "ar" ? "sbg-card__thumb-wrap--ar" : "sbg-card__thumb-wrap--square";
    const thumbWrap = h("div", { class: `sbg-card__thumb-wrap ${shapeClass}` });

    if (it.thumb_url) {
      const thumbImg = h("img", {
        class: "sbg-card__thumb",
        loading: "lazy",
        // Non-draggable so the blob: thumbnail never leaks into the card's drag
        // payload (ComfyUI's native drop would try to upload it and get a 500).
        draggable: "false",
        onerror: function () {
          // Show a placeholder icon on any thumbnail load failure, but keep the
          // item: a 404 is often transient (thumb still generating, or the server
          // busy serving another browser). Truly-deleted files are pruned by the
          // next incremental scan.
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
          // Liveness guard, mirroring the observer path: after a re-render
          // this continuation must not write into a detached card.
          if (!thumbWrap.isConnected) return;
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
      onclick: (e) => openLightbox(state.filteredItems, it, e),
    }, [
      thumbWrap,
      h("div", { class: "sbg-card__info" }, [
        h("div", { class: "sbg-card__name", text: it.filename }),
        h("div", { class: "sbg-card__meta", text: `${fmtBytes(it.size)} · ${timeAgo(it.mtime)}` }),
      ]),
    ]);

    // Search match badges
    if (it._matchedFields && state._searchMatches) {
      const _renames = getSectionRenames();
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
        const displayName = canonical ? SectionRegistry.getDisplayName(canonical, _renames) : null;
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
    });

    card.dataset.idx = String(index);
    card.dataset.relpath = it.relpath;  // bind the card to its item so stale reuse is detectable
    // Identity includes mtime: a file overwritten in place keeps its relpath but
    // needs a rebuilt card (fresh ?v= thumb URL), which relpath alone can't detect.
    card.dataset.key = `${it.relpath}\x00${it.mtime_real ?? it.mtime ?? 0}`;
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
      // Masonry (justified-rows) mode
      // Items are placed in strict top-to-bottom, left-to-right reading order
      // (see _computeMasonryLayout), so positions are sorted by Y and the visible
      // items form a CONTIGUOUS index range. Binary-search it (O(log n)) instead
      // of scanning all N positions on every scroll frame.
      const topEdge = Math.max(0, scrollTop - bufferPx);
      const bottomEdge = scrollTop + viewH + bufferPx;
      const [first, last] = _masonryVisibleRange(_masonryData.positions, topEdge, bottomEdge);

      // Unmount cards now outside the visible range.
      for (const [idx, card] of _cardMap) {
        if (idx < first || idx >= last) {
          card.remove();
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
          // now point to a different item, or the same item modified in place (a new
          // mtime and thus a new thumb URL). Rebuild when the bound identity no longer matches
          // so a card never shows another item's or a stale thumbnail.
          if (existing.dataset.key === `${it.relpath}\x00${it.mtime_real ?? it.mtime ?? 0}`) continue;
          existing.remove(); _cardMap.delete(i);
        }
        const card = _createCard(it, i);
        _positionCard(card, i);
        grid.appendChild(card);
        _cardMap.set(i, card);
      }

      state.displayedCount = state.filteredItems.length;
      updateStatus();
      return;
    } else {
      // Grid mode: uniform row-based calculation
      const { colCount, rowH } = _metrics;
      const bufferRows = Math.max(2, Math.min(30, Number(getSetting(S.VSCROLL_BUFFER, DEFAULT_BUFFER_ROWS)) || DEFAULT_BUFFER_ROWS));
      const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - bufferRows);
      const lastRow = Math.ceil((scrollTop + viewH) / rowH) + bufferRows;
      const totalRows = Math.ceil(state.filteredItems.length / colCount);
      firstIdx = firstRow * colCount;
      lastIdx = Math.min((Math.min(lastRow, totalRows)) * colCount, state.filteredItems.length);
    }

    // Unmount cards outside the new range
    for (const [idx, card] of _cardMap) {
      if (idx < firstIdx || idx >= lastIdx) {
        card.remove();
        _cardMap.delete(idx);
      }
    }

    // Mount cards in the new range
    for (let i = firstIdx; i < lastIdx; i++) {
      const it = state.filteredItems[i];
      if (!it) continue;
      const existing = _cardMap.get(i);
      if (existing) {
        // Rebuild if index i now maps to a different item (list shifted) or the
        // same item modified in place (a new mtime and thus a new thumb URL), so a card
        // never displays a stale or wrong thumbnail (image/video mismatch).
        if (existing.dataset.key === `${it.relpath}\x00${it.mtime_real ?? it.mtime ?? 0}`) continue;
        existing.remove(); _cardMap.delete(i);
      }
      const card = _createCard(it, i);
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

    // Clear all cards, then sweep any strays as a defensive backstop: a card
    // that survived a previous render would show a stale or wrong thumbnail.
    for (const [, card] of _cardMap) {
      card.remove();
    }
    _cardMap.clear();
    for (const stray of grid.querySelectorAll(".sbg-card")) stray.remove();
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
      // Masonry mode: pre-compute all positions
      _masonryData = _computeMasonryLayout(state.filteredItems, _metrics, thumbPerRow);
      spacer.style.height = `${_masonryData.totalHeight}px`;
    } else {
      // Grid mode: uniform rows
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

  /* Scroll + Resize handlers */

  body.addEventListener("scroll", () => { _saveScrollPos(); _scheduleVirtualRender(); }, { passive: true });

  // Custom overlay scrollbar for Chrome/Edge (Firefox's native overlay is skipped).
  // A thin thumb floats over the right edge: invisible when idle, widening when the
  // pointer nears it, draggable, synced to scroll position.
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
      // Drop a prior instance's observer so remounts don't leak observers/nodes.
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
      // Column count or row height changed: full re-layout
      _metrics = newMetrics;
      renderFromScratch();
    } else if (newMetrics && !_metrics) {
      _metrics = newMetrics;
      renderFromScratch();
    }
  });
  _resizeObserver.observe(grid);
  window._sbgResizeObserver = _resizeObserver;

  /* Helpers */

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
    // Catalog default titles: the reference the rename bridge diffs saved
    // profiles against (TL.getSectionRenames).
    if (cfg.section_titles) setCatalogTitles(cfg.section_titles);
    state.roots = cfg.roots || [];
    if (!state.roots.find(r => r.id === "output")) state.roots.unshift({ id: "output", label: "Output" });
    _dataCache.roots = state.roots;
    _dataCache._autoRefreshSecs = (typeof cfg.auto_refresh_interval_s === "number") ? cfg.auto_refresh_interval_s : 15;
    _startAutoRefresh(); // apply a possibly-changed interval immediately
    // If the active root was removed, fall back to output and reload its view,
    // otherwise the grid keeps showing the deleted folder's images. switchRoot
    // also redraws the breadcrumb nav.
    if (!state.roots.find(r => r.id === state.rootId)) {
      switchRoot("output");
    } else {
      rebuildRoots();
    }
  }

  // Switch the active root. A previously-shown root paints instantly from its
  // cached list, then a rescan reconciles files created while another root was
  // active (generations land in the output root even when another folder is on
  // screen). A never-opened root has nothing cached, so show an indexing indicator
  // while the backend finishes its first scan (list_all awaits that scan when the
  // root's DB is still empty).
  function switchRoot(newRootId) {
    if (newRootId === state.rootId) return;
    state.rootId = newRootId;
    _dataCache.lastRootId = newRootId;
    state.subfolder = "";
    _dataCache.lastSubfolder = "";
    // An active search's match set is keyed by the OLD root's relpaths; drop
    // it so the new root paints unfiltered while the search re-runs below
    // (or in fetchAllItems for a root that still needs indexing).
    if (state.searchTags.length > 0) {
      state._searchMatches = null;
      _dataCache.lastSearchMatches = null;
    }
    renderFolderNav();
    loadSubfolders();
    const known = Array.isArray(_dataCache.items[newRootId]) && _dataCache.items[newRootId].length > 0;
    if (known) {
      state.allItems = _dataCache.items[newRootId];
      applyFilters();
      renderFromScratch();
      // Paint from the in-memory cache, then version-gated poll.
      _pollAndReconcile();
      if (state.searchTags.length > 0) _triggerMultiSearch();
    } else {
      state.allItems = [];
      applyFilters();
      renderFromScratch();
      showProgress("Indexing new folder…", -1);
      // Watch this root's first-index entry via the shared poller so a slow
      // (network) folder shows progress instead of a static bar. `idxActive`
      // guards a tick already in flight when we unsubscribe, so a late callback
      // can't re-show the bar after hideProgress().
      let idxActive = true;
      const unsubIdx = progressPoller.subscribe((data) => {
        if (!idxActive || !data) return;
        const e = (data.roots || {})[newRootId];
        if (!e || !e.running) return;
        const f = formatProgress(e);
        showProgress(e.phase === "scanning" ? f.text : `Indexing… ${f.text}`, f.pct);
      });
      fetchAllItems({ rescan: false })
        .then(() => loadSubfolders())
        .catch(() => { })
        .finally(() => { idxActive = false; unsubIdx(); hideProgress(); });
    }
  }

  /* Data fetching */

  // Debounced snapshot persistence for the delta path (fetchNewItems), so freshly
  // generated files are included in the IDB snapshot that drives the instant first
  // paint after a reboot/refresh. Coalesced, since a burst generation fires several
  // deltas. fetchAllItems persists inline; this is the delta-path equivalent.
  const _persistTimers = new Map(); // debounce timers, keyed by rootId

  // Single write path for the IndexedDB snapshot: always the per-root cached
  // items with the per-root version they reflect, and a record of what was
  // written so unchanged fetches can skip the multi-MB rewrite entirely.
  function _persistSnapshot(rid) {
    const items = _dataCache.items[rid];
    if (!items) return;
    const ver = _dataCache.itemsVersion[rid];
    _persistItems(rid, items, ver, _dataCache.serverTime[rid] ?? null);
    _dataCache._persistedVersion[rid] = ver;
  }

  function _schedulePersist(rid = state.rootId) {
    // Bind the root at schedule time (not when the timer fires) and debounce per
    // root, so a root switch inside the debounce window can't drop or mis-pair the
    // previous root's pending snapshot write.
    const prev = _persistTimers.get(rid);
    if (prev) clearTimeout(prev);
    _persistTimers.set(rid, setTimeout(() => {
      _persistTimers.delete(rid);
      _persistSnapshot(rid);
    }, 1500));
  }

  // A full reindex re-extracts metadata without changing file mtimes, so the
  // lightbox's per-item mtime check can't detect it. A meta_epoch bump on reindex
  // completion drops cached metadata only (L1 _metaCache + the IndexedDB "meta"
  // store, which also holds the initmeta:* source-image entries); thumbnails are
  // left intact. Generation (db_version) bumps don't trigger this. Carried by
  // list_all, poll AND list_new so the delta-first reconcile (which rarely runs
  // a full list_all) still delivers the drop.
  function _checkMetaEpoch(epoch) {
    if (epoch === undefined) return;
    if (localStorage.getItem("SBG._metaEpoch") === String(epoch)) return;
    _metaCache.clear();
    _metaCacheAPI.clear().catch(() => { });
    localStorage.setItem("SBG._metaEpoch", String(epoch));
  }

  async function fetchAllItems({ rescan = false, rootId = state.rootId } = {}) {
    // Capture the root once. Every cache write below is keyed by the captured
    // value, so a slow response for root A landing after a switch to root B still
    // stores A's items and version under A. View updates additionally require the
    // root to still be on screen.
    const rid = rootId;
    // Status/spinner belong to the on-screen root only: a background refetch for a
    // root the user already left must not flash "Loading…" on the visible one.
    const showedLoading = !rescan && rid === state.rootId;
    if (showedLoading) setLoading(true);
    if (rescan) resetFailedThumbs(); // give previously-failed thumbnails another chance
    if (rid === state.rootId) statusLeft.textContent = rescan ? "Scanning…" : "Loading…";
    try {
      const ts = Math.max(512, thumbSize * 2);
      _dataCache._thumbSize = ts;
      const data = await api("/sidebar_gallery/list_all", {
        root_id: rid,
        rescan: rescan ? "1" : undefined,
        thumb_size: String(ts),
      });
      const isCurrent = rid === state.rootId;

      if (data.server_time) _dataCache.serverTime[rid] = data.server_time;
      if (data.db_version !== undefined) {
        _dataCache.itemsVersion[rid] = data.db_version;
      }

      // Cache epoch vs DB version.
      // CACHE_EPOCH is bumped manually when the cached data SHAPE changes, which
      // requires dropping every cache. A plain db_version change just means a file
      // was added/changed/removed and must NOT wipe the metadata + thumbnail caches.
      // Per-item freshness comes from the lightbox's mtime check and content-
      // addressed thumb/file URLs (?v=mtime), so changed files refresh on their own.
      let cacheReset = false;
      const CACHE_EPOCH = "3";
      if (localStorage.getItem("SBG._cacheEpoch") !== CACHE_EPOCH) {
        _metaCache.clear();
        try { _resetIdb(); indexedDB.deleteDatabase("sbg-cache"); } catch (e) { /* ignore */ }
        try { indexedDB.deleteDatabase("sbg-gallery-cache"); } catch (e) { /* ignore */ }
        localStorage.setItem("SBG._cacheEpoch", CACHE_EPOCH);
        cacheReset = true; // data-shape change: force a fresh repaint below
      }
      _checkMetaEpoch(data.meta_epoch);

      const newItems = data.items || [];

      if (isCurrent && data.db_empty && newItems.length === 0) {
        _showFirstTimeModal();
      }

      // Diff update: when the returned set is identical to what's already cached
      // there is nothing to persist or repaint, which stops the gallery visibly
      // "refreshing" on startup. The diff compares (relpath, mtime) pairs instead
      // of bare relpaths, so a file overwritten in place (same relpath, new mtime
      // and thumb URL) is detected. A cache reset above still forces a repaint.
      const prevItems = _dataCache.items[rid] || [];
      const oldMap = new Map(prevItems.map(x => [x.relpath, x.mtime_real ?? x.mtime ?? 0]));
      const newSet = new Set(newItems.map(x => x.relpath));
      const added = newItems.filter(x => !oldMap.has(x.relpath));
      const removedCount = prevItems.reduce((n, x) => n + (newSet.has(x.relpath) ? 0 : 1), 0);
      const changed = newItems.filter(x =>
        oldMap.has(x.relpath) && oldMap.get(x.relpath) !== (x.mtime_real ?? x.mtime ?? 0));
      const noChange = prevItems.length > 0 && added.length === 0
        && removedCount === 0 && changed.length === 0;

      _dataCache.items[rid] = newItems;
      // Persist items + the DB version they reflect (drives the reopen version
      // gate), but skip the multi-MB IndexedDB rewrite when neither the items nor
      // the version changed since the last write (the common startup case). The
      // debounced path keeps the multi-MB structured-clone put off this render's
      // critical path (it also coalesces a burst of refetches into one write).
      if (!noChange || _dataCache._persistedVersion[rid] !== _dataCache.itemsVersion[rid]) {
        _schedulePersist(rid);
      }

      if (isCurrent) {
        state.allItems = newItems;
        statusLeft.textContent = "Ready";
        applyFilters();
        if (!noChange || cacheReset) renderFromScratch();
        // An active search's match set may predate this refetch (root switch,
        // manual rescan, count-invariant escalation): re-run it against the
        // fresh items so new files aren't silently missing from results.
        if (state.searchTags.length > 0 && !noChange) _triggerMultiSearch();
      }
    } catch (e) {
      if (rid === state.rootId) statusLeft.textContent = `Error: ${e.message || e}`;
    } finally {
      if (showedLoading) setLoading(false);
    }
  }

  function _showFirstTimeModal() {
    // Never stack a second copy: fetchAllItems can fire multiple times while the DB
    // is still empty (init + background rescans), and a duplicate modal resetting on
    // top of the first looks like indexing has silently died.
    if (document.querySelector(".sbg-first-time-overlay")) return;

    const overlay = h("div", { class: "sbg-first-time-overlay" });
    const modal = h("div", { class: "sbg-first-time-modal" });
    const title = h("h3", { text: "🗂️ Building Index for the First Time" });
    const desc = h("p", { text: "This will scan all media files and parse their metadata. This may take a couple minutes depending on library size." });
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
      let modalActive = true;
      const unsub = progressPoller.subscribe((data, meta) => {
        // A sidebar unmount destroys the modal without any close handler
        // running; drop the subscription instead of polling into detached DOM.
        if (!overlay.isConnected) { modalActive = false; unsub(); return; }
        if (!modalActive || !data) return;
        const e = data.full;
        if (data.running) sawRunning = true;
        if (e && data.running) {
          const f = formatProgress(e);
          if (f.pct >= 0) progressFillM.style.width = f.pct + "%";
          progressTextM.textContent = f.text;
        }
        // Real failure (e.g. "database is locked"): say so and offer a retry.
        if (e && !data.running && (e.error || e.phase === "error")) {
          modalActive = false; unsub();
          progressTextM.textContent = `Indexing failed: ${e.error || "unknown error"}. Click to try again.`;
          startBtn.disabled = false;
          startBtn.textContent = "🚀 Start Indexing";
          skipBtn.style.display = "";
          return;
        }
        // `settled` (2+ idle ticks) rather than a single !running read: a
        // multi-root rebuild has a gap between roots where a single read would
        // say "finished" and close the modal mid-rebuild.
        if (meta.settled) {
          if (sawRunning || (e && e.phase === "done")) {
            modalActive = false; unsub();
            progressFillM.style.width = "100%";
            progressTextM.textContent = `Done! ${(e && (e.done || e.total)) || ""} files indexed.`;
            setTimeout(() => { overlay.remove(); fetchAllItems(); }, 1500);
          } else {
            // The rebuild never started (refused because another scan holds the
            // writer, or it died before reporting): recover the buttons instead of
            // sitting on a disabled "Starting…" forever.
            modalActive = false; unsub();
            progressTextM.textContent = "Couldn't start - another scan is still running. Try again in a moment.";
            startBtn.disabled = false;
            startBtn.textContent = "🚀 Start Indexing";
            skipBtn.style.display = "";
          }
        }
      });
    });
  }

  // Remembered scroll positions per view (root + folder + kind), so toggling
  // All/Images/Videos or reopening the gallery returns to where you were.
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
    // index range), then restore this view's remembered position (the scroll event
    // re-renders the virtual window for the right range).
    body.scrollTop = 0;
    renderFromScratch();
    _restoreScrollPos();
  }

  // Poll the backend (which runs a guarded scan and returns the current DB version)
  // and only refetch the full list when that version differs from what this root's
  // view last reconciled against. A no-change reopen is a single tiny poll; this
  // also reconciles external deletes/renames that the add-only delta path can't see.
  let _pollInflight = null;
  let _pollInflightRid = null;
  function _pollAndReconcile(eager = false) {
    // Single-flight: focus + visibilitychange + the interval tick can all fire in
    // the same instant (returning to the tab); without this guard each would run its
    // own full refetch. Root-aware: a poll for the previous root must not swallow the
    // new root's reconcile (its /poll can block for seconds behind a scan), so chain
    // it after the in-flight one instead.
    if (_pollInflight) {
      if (_pollInflightRid === state.rootId) return _pollInflight;
      return _pollInflight.then(() => _pollAndReconcile(eager));
    }
    _pollInflightRid = state.rootId;
    _pollInflight = (async () => {
      try {
        const rid = state.rootId; // captured: all decisions below are for THIS root
        const known = _dataCache.itemsVersion[rid];
        // eager=1 (focus return) makes the server await a snappy-cooldown scan so
        // external changes reconcile in one round trip; the periodic tick lets the
        // scan run in the background and just reads the current version.
        const p = await api("/sidebar_gallery/poll",
          eager ? { root_id: rid, eager: "1" } : { root_id: rid });
        if (p.reindexing) return; // full rebuild churning versions; the timer retries
        _checkMetaEpoch(p.meta_epoch);
        const haveCount = (_dataCache.items[rid] || []).length;
        const countMismatch = typeof p.count === "number" && p.count !== haveCount;
        if (known == null) {
          // No stamped version (cold cache): only the full fetch can seed it.
          await fetchAllItems({ rescan: false, rootId: rid });
        } else if (p.db_version !== known) {
          // Delta-first: fetch only what changed since our stamp. list_new's
          // since-form carries adds, in-place changes and removals; its count
          // backstop and the stale flag escalate to a full refetch in the rare
          // states a delta can't reconcile.
          await fetchNewItems();
        } else if (countMismatch) {
          // Version matches but the count doesn't: a stamp was recorded against
          // a view that missed an add/delete. Self-heal with a full refetch.
          await fetchAllItems({ rescan: false, rootId: rid });
        }
      } catch (e) { /* offline or endpoint missing: keep the cached view */ }
      finally { _pollInflight = null; _pollInflightRid = null; }
    })();
    return _pollInflight;
  }

  // Periodic + focus-driven auto-refresh: while the panel is visible, poll for
  // external changes (delete/move/rename) and reconcile. Interval comes from config
  // (auto_refresh_interval_s, default 15s; 0 = off). One AbortController +
  // window._sbgPollTimer so a sidebar remount tears the listeners + timer down
  // cleanly (see the teardown block at the top of initGallery).
  function _startAutoRefresh() {
    // Clear any existing timer + listeners first, so this can be re-run after a
    // settings change (or 0 = off) without stacking a second interval.
    if (window._sbgPollTimer) { clearInterval(window._sbgPollTimer); window._sbgPollTimer = null; }
    if (window._sbgRefreshAbort) { try { window._sbgRefreshAbort.abort(); } catch { } window._sbgRefreshAbort = null; }
    const secs = Number(_dataCache._autoRefreshSecs);
    const interval = Number.isFinite(secs) ? secs : 15;
    const ac = new AbortController();
    window._sbgRefreshAbort = ac;
    const maybePoll = (eager = false) => {
      if (document.visibilityState !== "visible") return;      // don't scan while hidden
      if (!(_dataCache._mountEl && _dataCache._mountEl.isConnected)) return;
      _pollAndReconcile(eager);
    };
    // The return-to-tab listeners are installed even when the interval is 0: "off"
    // disables only the periodic timer and keeps the one cheap reconcile when the
    // user comes back to look. Focus returns poll eagerly (server awaits a snappy scan) so
    // external changes appear in one round trip; periodic ticks stay cheap and
    // let the scan run in the background instead.
    window.addEventListener("focus", () => maybePoll(true), { signal: ac.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") maybePoll(true);
    }, { signal: ac.signal });
    if (!interval || interval <= 0) return; // 0 = no periodic polling
    const ms = Math.max(5, interval) * 1000;
    window._sbgPollTimer = setInterval(() => maybePoll(false), ms);
  }

  async function fetchNewItems() {
    const files = _dataCache._pendingFiles;
    _dataCache._pendingFiles = [];
    // Captured root: every cache write below is keyed by it, view updates
    // additionally require it to still be on screen (see fetchAllItems).
    const rid = state.rootId;

    if (!files.length && (!_dataCache.serverTime[rid] || (_dataCache.items[rid] || []).length === 0)) {
      // No `since` cursor (pre-serverTime snapshot) or nothing cached: a plain
      // list_all reconciles fully from the DB. rescan:true here would make the
      // server walk the whole library BEFORE answering. The poll that routed
      // us here already scheduled that scan, so forcing a second, awaited one
      // only turns every cold-cache reconcile into a long stall.
      return fetchAllItems({ rescan: false, rootId: rid });
    }

    try {
      const ts = _dataCache._thumbSize || Math.max(512, thumbSize * 2);
      const body_payload = {
        root_id: rid,
        thumb_size: ts,
      };
      if (files.length > 0) {
        body_payload.files = files;
      } else {
        body_payload.since = _dataCache.serverTime[rid];
        // Lets the server answer "what was deleted since my version" from its
        // removals buffer instead of walking the disk.
        const kv = _dataCache.itemsVersion[rid];
        if (typeof kv === "number") body_payload.known_version = kv;
      }

      const resp = await fetch("/sidebar_gallery/list_new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body_payload),
      });
      if (!resp.ok) throw new Error(resp.statusText);
      const data = await resp.json();
      const isCurrent = rid === state.rootId;

      _checkMetaEpoch(data.meta_epoch);
      // The server couldn't determine removals for our version (predates its
      // process life): this delta may be missing deletions, so do a full
      // refetch instead of stamping its version.
      if (data.stale) {
        return fetchAllItems({ rescan: false, rootId: rid });
      }

      if (data.server_time) _dataCache.serverTime[rid] = data.server_time;
      // Stamping the post-scan version is sound only because the merge below applies
      // both directions: adds/replacements from items[] and deletions from removed[].
      // An add-only merge would stamp a version whose deletions it never applied,
      // leaving ghost cards of externally deleted files ("already seen this version").
      if (data.db_version !== undefined) {
        _dataCache.itemsVersion[rid] = data.db_version;
      }

      const added = data.items || [];
      const removed = data.removed || [];

      for (const newItem of added) {
        const ck = `${newItem.root_id}:${newItem.relpath}`;
        _metaCache.delete(ck);
        _metaCacheAPI.put(ck, null).catch(() => { });
      }

      let items = _dataCache.items[rid] || [];
      let changedAny = false;

      if (removed.length > 0) {
        const rm = new Set(removed);
        const next = items.filter(x => !rm.has(x.relpath));
        if (next.length !== items.length) {
          items = next;
          changedAny = true;
        }
        for (const rp of removed) {
          const ck = `${rid}:${rp}`;
          _metaCache.delete(ck);
          _metaCacheAPI.put(ck, null).catch(() => { });
        }
      }

      if (added.length > 0) {
        added.sort((a, b) => b.mtime - a.mtime);
        const byPath = new Map(items.map(x => [x.relpath, x]));
        const trulyNew = [];
        for (const it of added) {
          const prev = byPath.get(it.relpath);
          if (!prev) {
            trulyNew.push(it);
          } else if ((prev.mtime_real ?? prev.mtime ?? 0) !== (it.mtime_real ?? it.mtime ?? 0)) {
            // Same file modified in place: replace the entry so its card rebuilds
            // with the fresh ?v= thumb URL instead of keeping the stale thumbnail.
            items = items.map(x => (x.relpath === it.relpath ? it : x));
            changedAny = true;
          }
        }
        if (trulyNew.length > 0) {
          items = [...trulyNew, ...items];
          changedAny = true;
        }
      }

      _dataCache.items[rid] = items;

      // Count invariant (files[]-form has no removed[]): if the server's row count
      // disagrees with what we now hold, go straight to the full refetch. This must
      // NOT route through _pollAndReconcile, because the poll path escalates version
      // moves to THIS function and bouncing back would loop.
      if (typeof data.count === "number" && data.count !== items.length) {
        fetchAllItems({ rescan: false, rootId: rid });
      }

      if (!changedAny) return;
      if (isCurrent) state.allItems = items;
      _schedulePersist(rid); // so the next cold-start first paint includes these
      if (!isCurrent) return;

      if (state._searchMatches) {
        // Active search: delta search new items
        const newRelpaths = added.map(a => a.relpath);
        try {
          const resp2 = await fetch("/sidebar_gallery/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              root_id: state.rootId,
              tags: state.searchTags.map(t => ({ field: t.field, value: t.value, exclude: t.exclude || false, ...(t.node_classes ? { node_classes: t.node_classes } : {}) })),
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
        } catch { /* delta search failed: non-critical */ }
      }

      applyFilters();
      renderFromScratch();
      document.dispatchEvent(new CustomEvent("sbg-items-updated", { detail: { items: state.filteredItems } }));
      statusLeft.textContent = "Ready";
    } catch (e) {
      console.warn("[SBG] Delta refresh failed, falling back to full:", e);
      return fetchAllItems({ rescan: true, rootId: rid });
    }
  }

  /* Search logic */

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
        // Seed with the minus restored: `raw` stores the term without it, so
        // an exclusion edited without the seed would silently flip into an
        // inclusion on commit.
        const seeded = (isNeg ? "-" : "") + tag.raw;
        const inp = h("input", { type: "text", class: "sbg-search-tag__edit", value: seeded });
        inp.style.cssText = "background:transparent;border:none;color:inherit;font:inherit;width:" + Math.max(40, Math.min(seeded.length * 7, 200)) + "px;outline:none;padding:0;";
        text.replaceWith(inp);
        inp.focus();
        inp.select();
        // The commit runs at most once: Enter's rerender detaches the input,
        // which fires blur, and Escape's cancel must not be overridden by the
        // blur that follows it.
        let done = false;
        const commit = () => {
          if (done) return;
          done = true;
          const newVal = inp.value.trim();
          if (newVal && newVal !== seeded) {
            const parsed = parseSearchTag(newVal);
            if (parsed) {
              state.searchTags[i] = parsed;
              renderSearchTags();
              _triggerMultiSearch();
            } else {
              inp.replaceWith(text); // only a minus remained; keep the chip
            }
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
          else if (ke.key === "Escape") { ke.preventDefault(); done = true; inp.replaceWith(text); }
        });
        inp.addEventListener("blur", commit);
      });
      pill.appendChild(text);
      pill.appendChild(rm);
      searchTagsWrap.appendChild(pill);
    }
    searchModeSel.style.display = state.searchTags.length > 1 ? "inline-block" : "none";
    _syncSearchBtns();
  }

  async function _triggerMultiSearch() {
    clearTimeout(qTimer);
    if (_searchAbort) { _searchAbort.abort(); _searchAbort = null; }

    if (state.searchTags.length === 0) {
      state._searchMatches = null;
      _setSearchQuery("");
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
        // Honour the exclude flag: "-name:draft" must HIDE matching files.
        const tagHit = (t) => t.exclude ? !name.includes(t.value) : name.includes(t.value);
        const matches = state.searchMode === "AND"
          ? state.searchTags.every(tagHit)
          : state.searchTags.some(tagHit);
        if (matches) matchMap.set(it.relpath, [{ field: "name", count: 1 }]);
      }
      state._searchMatches = matchMap;
      _dataCache.lastSearchMatches = matchMap;
      _setSearchQuery(state.searchTags.map(t => t.value).join("\x00"));
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
            tags: state.searchTags.map(t => ({ field: t.field, value: t.value, exclude: t.exclude || false, ...(t.node_classes ? { node_classes: t.node_classes } : {}) })),
            mode: state.searchMode
          }),
          signal: ctrl.signal,
        });

        if (!resp.ok) throw new Error(resp.statusText);
        const data = await resp.json();
        hideProgress();

        const rawMatches = data.matches || [];
        const matchMap = new Map();

        for (const m of rawMatches) {
          if (typeof m === "object" && m.relpath) {
            matchMap.set(m.relpath, m.matched_fields || [{ field: m.matched_field || "any", count: 1 }]);
          } else if (typeof m === "string") {
            matchMap.set(m, [{ field: "any", count: 1 }]);
          }
        }

        // The server evaluates name: tags against filenames itself, so its
        // match set is complete (and keeps per-field badges for mixed searches).
        state._searchMatches = matchMap;
        _dataCache.lastSearchMatches = matchMap;

        _setSearchQuery(state.searchTags.map(t => t.value).join("\x00"));
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

  /* Search event listeners */

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
      // An arrow-highlighted suggestion behaves like clicking it: fill the
      // input with the prefix and let the user type the value. Enter with no
      // highlight commits the typed text as a tag. The take-the-first
      // fallback stays Tab-only.
      if (autoCompleteDropdown.style.display !== "none" && _acSelectedIdx >= 0) {
        _acAccept();
        return;
      }
      autoCompleteDropdown.style.display = "none";
      const parsed = parseSearchTag(qInput.value);
      if (parsed) {
        state.searchTags.push(parsed);
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
    state._searchMatches = null;
    _setSearchQuery("");
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
    _syncSearchBtns();
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

  /* Kind + sort event listeners */

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

  /* Assemble DOM */

  const root = h("div", { class: "sbg-root" }, [toolbar, statusBar, bodyWrap]);
  if (theme !== "comfyui") root.setAttribute("data-theme", theme);

  function _applyCustomThemeVars(r, t) {
    if (t === "custom") {
      r.style.setProperty("--sbg-bg", getSetting("CUSTOM_BG", "#1a1a1a"));
      r.style.setProperty("--sbg-surface", getSetting("CUSTOM_SURFACE", "#222222"));
      r.style.setProperty("--sbg-border", getSetting("CUSTOM_BORDER", "#444444"));
      r.style.setProperty("--sbg-text", getSetting("CUSTOM_TEXT", "#e0e0e0"));
      r.style.setProperty("--sbg-accent", getSetting("CUSTOM_ACCENT", "#7c6aef"));
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

  /* Init */

  _dataCache._mountEl = mountEl;
  _dataCache._fetchAllItems = fetchAllItems;
  _dataCache._fetchNewItems = fetchNewItems;
  _dataCache._refilter = refilter;
  _startAutoRefresh();

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

        // Warm remount always reconciles once: the in-memory paint can hide external
        // deletions/renames made while the panel was closed. If a generation finished
        // while closed, run the targeted delta first (fast path for the new files),
        // then the eager form of the version-gated poll, so the server answers
        // after a snappy-cooldown scan instead of from a DB that hasn't looked
        // at the disk since the panel was last open.
        if (_dataCache.stale) {
          _dataCache.stale = false;
          fetchNewItems().finally(() => _pollAndReconcile(true));
        } else {
          _pollAndReconcile(true);
        }
      } else {
        const persisted = await _loadPersistedItems(state.rootId);
        if (persisted && persisted.items.length > 0) {
          state.allItems = persisted.items;
          _dataCache.items[state.rootId] = persisted.items;
          _dataCache.itemsVersion[state.rootId] = persisted.dbVersion;
          _dataCache._persistedVersion[state.rootId] = persisted.dbVersion;
          // Restore the delta `since` cursor with the snapshot it belongs to,
          // so the first post-refresh reconcile is a tiny list_new instead of
          // escalating to a full list_all.
          if (persisted.serverTime) _dataCache.serverTime[state.rootId] = persisted.serverTime;
          statusLeft.textContent = "Ready";
          applyFilters();
          await new Promise(r => requestAnimationFrame(r));
          renderFromScratch();
          Promise.all([refreshConfig(), loadSubfolders()]).catch(() => { });
          // Paint from the snapshot, then reconcile by the same rules as the
          // warm remount above: generations that finished BEFORE this first
          // mount are sitting in _pendingFiles (the executed listener is
          // module-level), so drain them; either way poll eagerly, since only
          // an awaited scan can reveal files that appeared while no open panel
          // was around to trigger one.
          if (_dataCache.stale) {
            _dataCache.stale = false;
            fetchNewItems().finally(() => _pollAndReconcile(true));
          } else {
            _pollAndReconcile(true);
          }
        } else {
          _dataCache.stale = false;
          await Promise.all([refreshConfig(), loadSubfolders(), fetchAllItems({ rescan: true })]);
        }
      }
    } catch (e) {
      statusLeft.textContent = `Error: ${e?.message || e}`;
    }
    watchReindexProgress();
  })();

  /* Public API */

  return {
    state,
    fetchAllItems,
    fetchNewItems,
    refilter,
    refreshConfig,
  };
}
