import {
  h,
} from "./sbg-core.js";
import { loadSnapshot } from "./sbg-snapshot.js";
import { thumbCache } from "./sbg-thumb-cache.js";
import { S, getSetting } from "./sbg-settings-store.js";
import { SORT_OPTIONS } from "./sbg-settings-catalog.js";
import { progressFeed, runningEntry, progressKind, indexRunningText, indexPct, indexTooltip, indexFailedText, indexEndings } from "./sbg-progress.js";
import { IMAGE_FILTER_ICON, VIDEO_FILTER_ICON, AUDIO_FILTER_ICON, GEAR_ICON } from "./sbg-icons.js";

import { createGalleryStore, adoptTeardown, galleryCache, rootLabel } from "./sbg-gallery-store.js";
import { createSearchBar, arrangeToolbar } from "./sbg-gallery-search.js";
import { createDataService, ensureCacheEpoch } from "./sbg-gallery-data.js";
import { createGalleryGrid } from "./sbg-gallery-grid.js";
import { createFolderNav } from "./sbg-gallery-nav.js";
import { createNotifyArea } from "./sbg-gallery-area.js";
import { failureText } from "./sbg-toast.js";

export function initGallery(mountEl, config) {
  const { openLightbox, openGallerySettings } = config;

  const thumbSize = getSetting(S.THUMB_SIZE);
  const perRow = getSetting(S.THUMB_PER_ROW);
  const thumbPerRow = perRow === "auto" ? 0 : Number(perRow);
  const thumbShape = getSetting(S.THUMB_SHAPE);
  const cardStyle = getSetting(S.CARD_STYLE);

  const defaultSort = getSetting(S.SORT);
  const { state, teardown, setView } = createGalleryStore(defaultSort);
  adoptTeardown(teardown);

  const toolbarLayout = getSetting(S.TOOLBAR_LAYOUT);
  const countEl = h("span", { class: "sbg-count", title: "Files shown out of all files in this root" });
  const area = createNotifyArea({ teardown, countEl: toolbarLayout === "rows" ? countEl : null });
  const loadStatus = area.source("load");

  const grid = createGalleryGrid({
    state, teardown, openLightbox, setCount,
    thumbSize, thumbShape, thumbPerRow, cardStyle,
  });
  const { bodyWrap, applyFilters, renderFromScratch, restoreScrollPos, refilter, announce } = grid;

  const search = createSearchBar({
    state, teardown, setView, refilter, announce, line: area.source("search"), compact: toolbarLayout === "filters-in-search",
  });
  const searchWrap = search.searchWrap;
  search.refreshBtn.addEventListener("click", () => { data.fetchAllItems({ rescan: true }); });

  // An empty file list sends the since form, the only one that reports removals.
  const _onFileDeleted = (e) => { data.fetchNewItems(e.detail.root_id, []); };
  document.addEventListener("sbg-file-deleted", _onFileDeleted);
  teardown.add(() => document.removeEventListener("sbg-file-deleted", _onFileDeleted));

  const nav = createFolderNav({
    state, teardown, setView, refilter, switchRoot: (id) => data.switchRoot(id),
  });
  const folderNav = nav.folderNav;
  const renderFolderNav = nav.renderFolderNav;

  // Pressed buttons instead of a radiogroup, whose single tab stop would take
  // the icon filters out of the Tab order.
  const kindBtnAll = h("button", { class: "sbg-btn sbg-btn--seg sbg-btn--active", text: "All", "data-kind": "", title: "Show all files", "aria-pressed": "true" });
  const kindBtnImg = h("button", { class: "sbg-btn sbg-btn--seg", html: IMAGE_FILTER_ICON, "data-kind": "image", title: "Images only", "aria-label": "Images only", "aria-pressed": "false" });
  const kindBtnVid = h("button", { class: "sbg-btn sbg-btn--seg", html: VIDEO_FILTER_ICON, "data-kind": "video", title: "Videos only", "aria-label": "Videos only", "aria-pressed": "false" });
  const kindBtnAud = h("button", { class: "sbg-btn sbg-btn--seg", html: AUDIO_FILTER_ICON, "data-kind": "audio", title: "Audio only", "aria-label": "Audio only", "aria-pressed": "false" });
  const kindButtons = [kindBtnAll, kindBtnImg, kindBtnVid, kindBtnAud];
  const kindGroup = h("div", { class: "sbg-kind-group", role: "group", "aria-label": "Filter by media type" }, kindButtons);

  const setActiveKind = (kind) => {
    for (const b of kindButtons) {
      const on = b.dataset.kind === kind;
      b.classList.toggle("sbg-btn--active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };

  const sortSel = h("select", { class: "sbg-select sbg-select--auto", title: "Sort order" },
    SORT_OPTIONS.map(([value, text]) => h("option", { value, text })));
  sortSel.value = state.sort;
  const gearBtn = h("button", { class: "sbg-btn sbg-btn--square", html: GEAR_ICON, title: "Gallery settings", "aria-label": "Gallery settings" });

  function setCount(shown, total) {
    const t = total.toLocaleString();
    if (shown === total) countEl.textContent = toolbarLayout === "count-in-search" ? t : `${t} ${total === 1 ? "file" : "files"}`;
    else countEl.textContent = `${shown.toLocaleString()} of ${t}`;
  }
  const toolbar = arrangeToolbar(toolbarLayout, {
    searchWrap, refreshBtn: search.refreshBtn, kindGroup, countEl, folderNav, sortSel, gearBtn, area: area.el,
  });

  gearBtn.addEventListener("click", () => openGallerySettings());

  // A failure line names its folder, so it is drawn again once the folder
  // names arrive.
  let redrawEndings = () => { };
  const rootsChanged = () => { renderFolderNav(); redrawEndings(); };

  // No check that the panel is attached, since opening it from a closed sidebar
  // hands over a container the host attaches afterwards. How runs ended is
  // kept by the page, so this panel draws what is still owed when it opens.
  function watchReindexProgress() {
    const index = area.source("index");
    // Each failure line drawn, with its words and the run it ended, since the
    // words change when the folder names arrive after the panel opens and the
    // same folder can fail again in the same words.
    const failed = new Map();
    // Taken from the page's index endings, since a panel opened during a run
    // would otherwise draw a done line still owed until the catch-up read answers.
    let running = indexEndings.running();
    const drawEndings = (ended) => {
      const standing = indexEndings.failures();
      let newFailure = false;
      for (const f of standing) {
        const text = indexFailedText(f.kind, f.error, rootLabel(state.roots, f.slot));
        const run = `${f.process}:${f.run}`;
        const drawn = failed.get(f.subject);
        if (drawn && drawn.text === text && drawn.run === run) continue;
        const line = drawn ? drawn.line : area.source(`index:${f.subject}`);
        failed.set(f.subject, { line, text, run });
        line.fail(text, () => indexEndings.dismiss(f.subject), { tint: f.kind === "facts" });
        if (!drawn || drawn.run !== run) newFailure = true;
      }
      for (const [subject, { line }] of failed) {
        if (standing.some(f => f.subject === subject)) continue;
        line.ok();
        failed.delete(subject);
      }
      // A run that ends in a failure takes its progress line down as the failure
      // line comes, while one that ends done leaves it for the settle to replace.
      // A run still going draws its line back from the same message.
      if (newFailure) index.stop();
      if (running) return;
      const done = indexEndings.done();
      if (done) index.progress(done.text, -1, { title: indexTooltip(done.kind), bar: false, now: true, mark: "done" });
      else index.stop();
      if (ended && state.allItems.length === 0) data.fetchAllItems({ rescan: false });
    };
    redrawEndings = () => drawEndings(false);
    // Subscribed first, so the page's own subscription reads each message before
    // this panel.
    teardown.add(indexEndings.subscribe(drawEndings));
    teardown.add(progressFeed.subscribe((progress) => {
      const e = runningEntry(progress);
      running = !!e;
      if (!e) return;
      const kind = progressKind(progress, e);
      index.progress(indexRunningText(kind, e), indexPct(kind, e), { title: indexTooltip(kind), now: true, mark: "running" });
    }));
    drawEndings(false);
  }

  for (const btn of kindButtons) {
    btn.addEventListener("click", () => {
      const newKind = btn.dataset.kind;
      setView({ kind: newKind });
      setActiveKind(newKind);
      refilter();
    });
  }
  sortSel.addEventListener("change", () => { setView({ sort: sortSel.value }); refilter(); });

  const root = h("div", { class: "sbg-root" }, [toolbar, bodyWrap]);
  mountEl.appendChild(root);

  const data = createDataService({
    state, teardown, setView, applyFilters, renderFromScratch, refilter, announce, onRootsChanged: rootsChanged,
    load: loadStatus, folders: area.source("folders"), configStatus: area.source("config"), poll: area.source("poll"),
    mountEl, search,
  });

  data.startAutoRefresh();

  // Subscribed outside the boot below, since a first index holds the boot's
  // list request until the whole index is built and its progress would go unseen.
  watchReindexProgress();

  (async () => {
    try {
      const cacheWiped = ensureCacheEpoch();

      // Thumbnail keys carry the file's modified time, so changed files orphan
      // entries. A wipe's delete would wait on the connection a prune opens.
      if (!cacheWiped) thumbCache.pruneIfOver(50000);

      const bootRootId = galleryCache.view.lastRootId;
      const hasCachedItems = galleryCache.data.items[bootRootId];
      const hasCachedRoots = galleryCache.data.roots;
      const hasCachedSubs = galleryCache.data.subfolders[bootRootId];

      if (hasCachedRoots && hasCachedItems && hasCachedSubs) {
        state.roots = galleryCache.data.roots;
        state.rootId = galleryCache.view.lastRootId;
        state.subfolder = galleryCache.view.lastSubfolder;
        state.favoritesOnly = galleryCache.view.lastFavoritesOnly;
        state.kind = galleryCache.view.lastKind;
        state.sort = galleryCache.view.lastSort || defaultSort;
        state.allItems = galleryCache.data.items[state.rootId];
        state.subfolders = galleryCache.data.subfolders[state.rootId];

        if (galleryCache.view.lastSearchTags.length > 0) {
          // Copied, so an edit before the next search leaves the saved pair whole.
          state.searchTags = [...galleryCache.view.lastSearchTags];
          state.searchMode = galleryCache.view.lastSearchMode || "AND";
          search.restore();
          if (galleryCache.view.lastSearchMatches) {
            state.searchMatches = galleryCache.view.lastSearchMatches;
          } else {
            // Tags without matches belong to a search that never answered.
            search.trigger();
          }
        }

        rootsChanged();
        setActiveKind(state.kind);
        sortSel.value = state.sort;
        // Closing the panel ended the retry, and the read reports its own failure.
        if (galleryCache.config.configOwed) data.refreshConfig().catch(() => { });

        applyFilters();
        // A frame passes so the grid has a width to measure.
        await new Promise(r => requestAnimationFrame(r));
        renderFromScratch();
        restoreScrollPos();

        data.reconcileAfterPaint();
      } else {
        const persisted = await loadSnapshot(state.rootId);
        if (persisted) {
          state.allItems = persisted.items;
          galleryCache.data.items[state.rootId] = persisted.items;
          galleryCache.data.itemsVersion[state.rootId] = persisted.dbVersion;
          galleryCache.data.persistedVersion[state.rootId] = persisted.dbVersion;

          if (persisted.serverTime) galleryCache.data.serverTime[state.rootId] = persisted.serverTime;
          applyFilters();
          await new Promise(r => requestAnimationFrame(r));
          renderFromScratch();
          // Each of these puts up its own line when it fails.
          Promise.all([data.refreshConfig(), data.loadSubfolders()]).catch(() => { });
          data.reconcileAfterPaint();
        } else {
          galleryCache.inbox.stale = false;
          // A failed settings read shows its own line instead of failing the load.
          await Promise.all([data.refreshConfig().catch(() => { }), data.loadSubfolders(), data.fetchAllItems({ rescan: true })]);
        }
      }
    } catch (e) {
      loadStatus.fail(failureText("start the gallery", e));
    }
  })();

  return {
    // Read by the extension shell to tell whether the panel is on the page.
    mountEl,
    state,
    fetchAllItems: data.fetchAllItems,
    fetchNewItems: data.fetchNewItems,
    refreshConfig: data.refreshConfig,

    // The folder dropdown hangs off the body, so a close without a pointer
    // event has to shut it outright.
    closePopup: nav.closePopup,
  };
}
