import {
  h,
  fmtBytes,
  timeAgo,
} from "./sbg-core.js";
import { thumbCache, observeThumb, unobserveThumb, resetThumbQueue } from "./sbg-thumb-cache.js";
import { S, getSetting, onSettingsChanged } from "./sbg-settings-store.js";
import { kindIcon, cardIdentityKey, modifiedTime } from "./sbg-media-kind.js";
import { assembleCard, matchBadge, badgeLookups, CARD_INFO_HEIGHTS, NARROW_CARD_PX } from "./sbg-card.js";
import { openCardMenu, closeCardMenu } from "./sbg-card-menu.js";
import { STAR_ICON, STAR_OUTLINE_ICON, SEARCH_ICON, FOLDER_ICON } from "./sbg-icons.js";

import { computeMetrics, computeMasonryLayout, masonryVisibleRange } from "./sbg-gallery-layout.js";
import { attachOverlayScrollbar } from "./sbg-gallery-ovscroll.js";
import { galleryCache } from "./sbg-gallery-store.js";
import { includeSubfolders } from "./sbg-gallery-nav.js";
import { favKey, favoriteKeys, favoriteTitle, isFavorite, toggleFavorite } from "./sbg-favorites.js";

const _nameCollator = new Intl.Collator();

// A card waits under a spinner and a dimmed placeholder, and a file with no
// thumbnail keeps the placeholder at full strength.
function _showThumb(thumbWrap, thumbImg, blobUrl) {
  thumbWrap.querySelector(".sbg-card__spinner").remove();
  const placeholder = thumbWrap.querySelector(".sbg-card__placeholder");
  if (!blobUrl) {
    placeholder.classList.remove("sbg-card__placeholder--dim");
    return;
  }
  placeholder.remove();
  thumbImg.src = blobUrl;
  thumbWrap.insertBefore(thumbImg, thumbWrap.firstChild);
}

function _showFavState(el, on, filename) {
  el.classList.toggle("sbg-card__fav--on", on);
  el.innerHTML = on ? STAR_ICON : STAR_OUTLINE_ICON;
  el.title = favoriteTitle(on);
  el.setAttribute("aria-label", on ? `Remove ${filename} from favorites` : `Add ${filename} to favorites`);
}

export function createGalleryGrid({
  state, teardown, openLightbox, setCount,
  thumbSize, thumbShape, thumbPerRow, cardStyle,
}) {
  const sortFns = {
    created_desc: (a, b) => b.ctime - a.ctime,
    created_asc: (a, b) => a.ctime - b.ctime,
    modified_desc: (a, b) => modifiedTime(b) - modifiedTime(a),
    modified_asc: (a, b) => modifiedTime(a) - modifiedTime(b),
    name_asc: (a, b) => _nameCollator.compare(a.relpath, b.relpath),
    name_desc: (a, b) => _nameCollator.compare(b.relpath, a.relpath),
    size_desc: (a, b) => b.size - a.size,
    size_asc: (a, b) => a.size - b.size,
  };

  // Every writer of `state.allItems` replaces it whole, so its identity stands
  // for its contents.
  let _sortedFrom = null;
  let _sortedBy = null;
  let _sorted = [];

  function applyFilters() {
    const fn = sortFns[state.sort];
    if (_sortedFrom !== state.allItems || _sortedBy !== fn) {
      _sorted = state.allItems.slice().sort(fn);
      _sortedFrom = state.allItems;
      _sortedBy = fn;
    }
    let items = _sorted;

    const withSub = includeSubfolders();
    if (state.subfolder) {
      items = items.filter(it => it.subfolder === state.subfolder || (withSub && it.subfolder.startsWith(state.subfolder + "/")));
    } else if (!withSub) {
      items = items.filter(it => !it.subfolder);
    }

    if (state.favoritesOnly) {
      const favs = favoriteKeys();
      items = items.filter(it => favs.has(favKey(it.root_id, it.relpath)));
    }

    if (state.kind) items = items.filter(it => it.kind === state.kind);

    if (state.searchMatches) items = items.filter(it => state.searchMatches.has(it.relpath));

    // Copied so the sorted cache is never handed out.
    if (items === _sorted) items = items.slice();

    state.filteredItems = items;
  }

  const grid = h("div", { class: "sbg-grid" });
  const spacer = h("div", { class: "sbg-grid__spacer" });
  grid.appendChild(spacer);

  const body = h("div", { class: "sbg-body" }, [grid]);
  resetThumbQueue();

  const bodyWrap = h("div", { class: "sbg-body-wrap" }, [body]);

  const GAP = 8;
  let _metrics = null;
  let _masonryData = null;
  let _cardMap = new Map();
  let _scrollRafId = null;
  let _emptyMsg = null;
  // The scroll position and height as `_renderVirtual` last read them, so
  // ranking a card for its thumbnail reads no layout.
  let _viewTop = 0;
  let _viewH = 0;

  // The cards' text is capped at the height the rows were sized from, which the
  // stylesheet reads from here. That text follows Base Font Size, and the
  // heights are measured at its default of 13px.
  const _measure = () => {
    const scale = (parseFloat(getComputedStyle(grid).fontSize) || 13) / 13;
    const heights = CARD_INFO_HEIGHTS[cardStyle].map((px) => Math.ceil(px * scale));
    const m = computeMetrics(grid, thumbSize, GAP, !!state.searchMatches, thumbPerRow, heights);
    if (m) grid.style.setProperty("--sbg-card-info-h", `${m.infoH}px`);
    return m;
  };

  // A card's file is read from its slot in the list, since a read that finds
  // nothing new keeps the cards while every row in the list is a new object.
  // A drag of selected text starts on a text node, which has no closest.
  function _slotOf(target) {
    const card = target.closest?.(".sbg-card");
    for (const [i, c] of _cardMap) if (c === card) return i;
    return -1;
  }

  grid.addEventListener("click", (e) => {
    const i = _slotOf(e.target);
    if (i < 0) return;
    const it = state.filteredItems[i];
    if (e.target.closest(".sbg-card__fav")) {
      e.stopPropagation();
      toggleFavorite(it.root_id, it.relpath);
      return;
    }
    openLightbox(state.filteredItems, i, e);
  });

  grid.addEventListener("contextmenu", (e) => {
    if (e.shiftKey) return;
    const i = _slotOf(e.target);
    if (i >= 0 && openCardMenu(e, state.filteredItems[i])) e.preventDefault();
  });

  grid.addEventListener("dragstart", (e) => {
    const i = _slotOf(e.target);
    if (i < 0) return;
    const it = state.filteredItems[i];
    e.dataTransfer.setData("application/x-sbg-workflow", JSON.stringify({ root_id: it.root_id, relpath: it.relpath, mtime_real: modifiedTime(it) }));
    e.dataTransfer.setData("text/plain", it.filename);
    e.dataTransfer.effectAllowed = "copy";
  });

  function buildTooltip(it) {
    const parts = [];
    if (getSetting(S.TOOLTIP_NAME)) parts.push(it.relpath);
    if (getSetting(S.TOOLTIP_SIZE)) parts.push(fmtBytes(it.size));
    if (getSetting(S.TOOLTIP_DATE)) parts.push(timeAgo(it.mtime));
    return parts.join("\n");
  }

  function _distanceFromScreen(index) {
    let top, height;
    if (_masonryData) {
      const pos = _masonryData.positions[index];
      if (!pos) return Infinity;
      top = pos.y;
      height = pos.h;
    } else {
      if (!_metrics) return Infinity;
      top = Math.floor(index / _metrics.colCount) * _metrics.rowH;
      height = _metrics.rowH;
    }
    const viewBottom = _viewTop + _viewH;
    if (top + height > _viewTop && top < viewBottom) return 0;
    return top >= viewBottom ? top - viewBottom : _viewTop - (top + height);
  }

  function _createCard(it, drawLookups, index) {
    const shapeClass = thumbShape === "ar" ? "sbg-card__thumb-wrap--ar" : "sbg-card__thumb-wrap--square";
    const thumbWrap = h("div", { class: `sbg-card__thumb-wrap ${shapeClass}` });

    const thumbImg = h("img", {
      class: "sbg-card__thumb",
      loading: "lazy",
      // The card carries the drag, so the thumbnail must not start its own.
      draggable: "false",
      onerror: function () {
        const img = this;
        img.classList.add("sbg-hidden");
        if (img.parentElement && !img.parentElement.querySelector(".sbg-card__placeholder")) {
          img.parentElement.appendChild(h("div", { class: "sbg-card__placeholder", html: kindIcon(it) }));
        }
      },
    });

    const memUrl = thumbCache.tryGetSync(it.thumb_url);
    if (memUrl) {
      thumbImg.src = memUrl;
      thumbWrap.appendChild(thumbImg);
    } else {
      const show = (blobUrl) => _showThumb(thumbWrap, thumbImg, blobUrl);
      thumbCache.tryGet(it.thumb_url).then(blobUrl => {
        if (!thumbWrap.isConnected) return;
        if (blobUrl) show(blobUrl);
        else observeThumb(thumbWrap, it, show, () => _distanceFromScreen(index));
      });
      thumbWrap.appendChild(h("div", { class: "sbg-card__spinner" }));
      thumbWrap.appendChild(h("div", { class: "sbg-card__placeholder sbg-card__placeholder--dim", html: kindIcon(it) }));
    }

    const fav = h("button", {
      type: "button",
      class: "sbg-card__fav",
    });
    _showFavState(fav, isFavorite(it.root_id, it.relpath), it.filename);

    const badges = [];
    const matched = state.searchMatches ? state.searchMatches.get(it.relpath) : null;
    if (matched) {
      const lookups = drawLookups();
      for (const { field, count } of matched) badges.push(matchBadge(field, count, lookups));
    }

    const card = assembleCard(cardStyle, it, thumbWrap, fav, badges);
    card.classList.add("sbg-card--virtual");
    card.title = buildTooltip(it);
    card.draggable = true;
    card.dataset.key = cardIdentityKey(it);
    return card;
  }

  function _positionCard(card, index) {
    if (_masonryData) {
      const pos = _masonryData.positions[index];
      card.style.top = `${pos.y}px`;
      card.style.left = `${pos.x}px`;
      card.style.width = `${pos.w}px`;
      card.style.height = `${pos.h}px`;
      card.classList.toggle("sbg-card--narrow", pos.w < NARROW_CARD_PX);
      const thumbWrap = card.querySelector(".sbg-card__thumb-wrap");
      if (thumbWrap) thumbWrap.style.height = `${pos.thumbH}px`;
      return;
    }

    const { colCount, rowH, colW, gap, infoH } = _metrics;
    const row = Math.floor(index / colCount);
    const col = index % colCount;
    card.style.top = `${row * rowH}px`;
    card.style.left = `${col * (colW + gap)}px`;
    card.style.width = `${colW}px`;
    card.style.height = `${colW + infoH}px`;
    card.classList.toggle("sbg-card--narrow", colW < NARROW_CARD_PX);
  }

  // A card dropped before its turn for a thumbnail leaves the queue here, so
  // it is never requested.
  function _dropCard(card) {
    unobserveThumb(card.querySelector(".sbg-card__thumb-wrap"));
    card.remove();
  }

  function _syncCardWindow(firstIdx, lastIdx) {
    for (const [idx, card] of _cardMap) {
      if (idx < firstIdx || idx >= lastIdx) {
        _dropCard(card);
        _cardMap.delete(idx);
      }
    }
    let lookups = null;
    const drawLookups = () => lookups || (lookups = badgeLookups());
    for (let i = firstIdx; i < lastIdx; i++) {
      const it = state.filteredItems[i];
      const existing = _cardMap.get(i);
      if (existing) {
        if (existing.dataset.key === cardIdentityKey(it)) continue;
        _dropCard(existing); _cardMap.delete(i);
      }
      const card = _createCard(it, drawLookups, i);
      _positionCard(card, i);
      grid.appendChild(card);
      _cardMap.set(i, card);
    }
  }

  function _renderVirtual() {
    _scrollRafId = null;
    if (!_metrics || state.filteredItems.length === 0) return;

    const scrollTop = body.scrollTop;
    const viewH = body.clientHeight;
    _viewTop = scrollTop;
    _viewH = viewH;
    const bufferRows = getSetting(S.VSCROLL_BUFFER);

    let firstIdx, lastIdx;
    if (_masonryData) {
      const bufferPx = bufferRows * _metrics.rowH;
      const topEdge = Math.max(0, scrollTop - bufferPx);
      const bottomEdge = scrollTop + viewH + bufferPx;
      [firstIdx, lastIdx] = masonryVisibleRange(_masonryData.positions, topEdge, bottomEdge);
    } else {
      const { colCount, rowH } = _metrics;
      const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - bufferRows);
      const lastRow = Math.ceil((scrollTop + viewH) / rowH) + bufferRows;
      const totalRows = Math.ceil(state.filteredItems.length / colCount);
      firstIdx = firstRow * colCount;
      lastIdx = Math.min((Math.min(lastRow, totalRows)) * colCount, state.filteredItems.length);
    }

    _syncCardWindow(firstIdx, lastIdx);
  }

  function _scheduleVirtualRender() {
    if (_scrollRafId) return;
    _scrollRafId = requestAnimationFrame(_renderVirtual);
  }

  function _layOut() {
    if (thumbShape === "ar") {
      _masonryData = computeMasonryLayout(state.filteredItems, _metrics, thumbPerRow);
      spacer.style.height = `${_masonryData.totalHeight}px`;
    } else {
      const { colCount, rowH } = _metrics;
      spacer.style.height = `${Math.ceil(state.filteredItems.length / colCount) * rowH}px`;
    }
  }

  function renderFromScratch() {
    _metrics = _measure();
    updateCount();

    for (const [, card] of _cardMap) {
      _dropCard(card);
    }
    _cardMap.clear();
    _masonryData = null;

    if (_emptyMsg) { _emptyMsg.remove(); _emptyMsg = null; }

    if (!_metrics || state.filteredItems.length === 0) {
      spacer.style.height = "0px";
      // Until this root's list arrives, the notification area explains the empty grid.
      const listKnown = Array.isArray(galleryCache.data.items[state.rootId]);
      if (state.filteredItems.length === 0 && listKnown) {
        const searching = !!state.searchMatches;
        _emptyMsg = h("div", { class: "sbg-empty" }, [
          state.favoritesOnly && !searching
            ? h("div", { class: "sbg-empty__icon", html: STAR_OUTLINE_ICON })
            : h("div", { class: "sbg-empty__icon", html: searching ? SEARCH_ICON : FOLDER_ICON }),
          h("div", { text: searching ? "No matches for this search" : state.favoritesOnly ? "No favorites found" : "No media found" }),
        ]);
        grid.appendChild(_emptyMsg);
      }
      return;
    }

    _layOut();
    _renderVirtual();
  }

  function _relayout() {
    if (_cardMap.size === 0 || state.filteredItems.length === 0) { renderFromScratch(); return; }
    _layOut();
    for (const [idx, card] of _cardMap) _positionCard(card, idx);
    _renderVirtual();
  }

  function updateCount() {
    setCount(state.filteredItems.length, state.allItems.length);
  }

  const _onFavoritesChanged = () => {
    if (state.favoritesOnly) { refilter(); return; }
    for (const [index, cardEl] of _cardMap) {
      const it = state.filteredItems[index];
      const fav = cardEl.querySelector(".sbg-card__fav");
      if (!it || !fav) continue;
      _showFavState(fav, isFavorite(it.root_id, it.relpath), it.filename);
    }
  };
  document.addEventListener("sbg-favorites-changed", _onFavoritesChanged);
  teardown.add(() => document.removeEventListener("sbg-favorites-changed", _onFavoritesChanged));
  // The card menu hangs off the body, so a panel closed from the keyboard would
  // leave it behind.
  teardown.add(closeCardMenu);

  body.addEventListener("scroll", () => { _saveScrollPos(); _scheduleVirtualRender(); }, { passive: true });

  let _detachWheelSpeed = null;
  function _applyWheelSpeed() {
    if (_detachWheelSpeed) { _detachWheelSpeed(); _detachWheelSpeed = null; }
    const mult = getSetting(S.GRID_WHEEL_SPEED) / 100;
    if (mult === 1) return;

    const linePx = parseFloat(getComputedStyle(body).lineHeight) || 19;
    let target = null;
    let raf = null;

    let lastWritten = null;
    const step = () => {
      raf = null;
      if (target == null) return;
      // Something else scrolled since the last step, so the glide gives way.
      if (lastWritten != null && Math.abs(body.scrollTop - lastWritten) > 1) {
        target = null;
        lastWritten = null;
        return;
      }

      const max = Math.max(0, body.scrollHeight - body.clientHeight);
      if (target > max) target = max;
      const diff = target - body.scrollTop;
      if (Math.abs(diff) < 0.75) {
        body.scrollTop = target;
        target = null;
        lastWritten = null;
        return;
      }
      body.scrollTop += diff * 0.3;
      lastWritten = body.scrollTop;
      raf = requestAnimationFrame(step);
    };
    const onWheel = (e) => {
      if (e.ctrlKey) return;
      const px = e.deltaMode === 1 ? e.deltaY * linePx
        : e.deltaMode === 2 ? e.deltaY * body.clientHeight
          : e.deltaY;
      if (!px) return;
      e.preventDefault();
      const max = Math.max(0, body.scrollHeight - body.clientHeight);
      const from = target == null ? body.scrollTop : target;
      target = Math.max(0, Math.min(max, from + px * mult));
      lastWritten = body.scrollTop;
      if (!raf) raf = requestAnimationFrame(step);
    };
    body.addEventListener("wheel", onWheel, { passive: false });
    _detachWheelSpeed = () => {
      body.removeEventListener("wheel", onWheel, { passive: false });
      if (raf) cancelAnimationFrame(raf);
      target = null;
    };
  }
  _applyWheelSpeed();
  teardown.add(onSettingsChanged((ids) => { if (ids.has(S.GRID_WHEEL_SPEED)) _applyWheelSpeed(); }));
  teardown.add(() => { if (_detachWheelSpeed) _detachWheelSpeed(); });

  attachOverlayScrollbar(body, bodyWrap, teardown);

  // A list taller than the panel sets the grid's height, so a taller panel
  // resizes only the scroller, which is watched as well.
  const resizeObserver = new ResizeObserver(() => {
    const next = _measure();
    if (!next) return;
    const prev = _metrics;
    _metrics = next;
    if (!prev || prev.colCount !== next.colCount || prev.infoH !== next.infoH) renderFromScratch();
    else if (prev.colW !== next.colW) _relayout();
    else _scheduleVirtualRender();
  });
  resizeObserver.observe(grid);
  resizeObserver.observe(body);
  teardown.add(() => resizeObserver.disconnect());

  const _scrollKey = () => `${state.rootId}|${state.subfolder}|${state.kind}`;
  function _saveScrollPos() {
    galleryCache.view.scrollPos[_scrollKey()] = body.scrollTop;
  }
  function restoreScrollPos() {
    const saved = galleryCache.view.scrollPos[_scrollKey()];
    if (saved > 0) body.scrollTop = Math.min(saved, Math.max(0, body.scrollHeight - body.clientHeight));
  }

  function refilter() {
    applyFilters();
    body.scrollTop = 0;
    renderFromScratch();
    restoreScrollPos();
  }

  // An open lightbox keeps its own copy of the list, so a change it has to
  // follow is announced to it.
  function announce() {
    document.dispatchEvent(new CustomEvent("sbg-items-updated", { detail: { items: state.filteredItems } }));
  }

  return {
    bodyWrap,
    applyFilters,
    refilter,
    renderFromScratch,
    restoreScrollPos,
    announce,
  };
}
