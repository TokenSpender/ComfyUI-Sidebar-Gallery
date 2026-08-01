/**
 * sbg-lightbox.js: Lightbox module
 *
 * Full-screen image/video viewer with metadata panel, compare mode,
 * keyboard navigation, section ordering, and search highlighting.
 */

import { app } from "../../scripts/app.js";

import {
  ensureCss, h, api, fmtBytes, pj, kvRow,
  showToast, copyText, fileUrl, isVideo,
  _metaCache, _metaCacheAPI, _mediaState,
  singleFlight,
  searchState, highlightSearchMatches,
  S, getSetting, APP_REGISTRY,
} from "./sbg-core.js";

import * as TL from "./sbg-translation-layer.js";
import { itemKey, nextCompareIdx, remapCompareIdx, initialImageList, normalizeInitialEntry } from "./sbg-compare-utils.js";
import { createZoomPanController } from "./sbg-lightbox-zoom.js";
import { descFromKeyEvent, descFromMouseEvent, matchExplicit, matchBare } from "./sbg-keybinds.js";

// Fully release a <video>'s decoder. Removing the element from the DOM is not
// enough: the browser keeps the (hardware) decoder alive until garbage
// collection, and Firefox-on-Windows has a tiny H.265/HEVC decoder pool. A few
// un-released video elements exhaust it, after which every subsequent H.265 clip
// fails with "could not be decoded" / NS_ERROR_DOM_MEDIA_NOT_SUPPORTED_ERR
// (H.264 has a software fallback, so it keeps playing; a page refresh frees them
// all). Clearing src + load() drops the decoder immediately.
function releaseVideo(el) {
  if (!el || el.tagName !== "VIDEO") return;
  try { el.pause(); el.removeAttribute("src"); el.load(); } catch { }
}

// Resolve a source/initial image's summary metadata, cached so navigating
// between items that share a source image (or revisiting one) doesn't re-fetch
// it on every navigation. srcType is the location an annotated widget path
// named (input/output/temp, from normalizeInitialEntry) and steers the probe
// order; without it the probes run as for a plain input-folder image. A miss
// is never cached, so a source image still being indexed retries naturally.
async function _resolveInitMeta(imgPath, curRoot, srcType) {
  // Key includes the starting root: two items can reference different source
  // images that share a relpath under different roots. The location suffix
  // keeps a same-relpath pair under different annotations apart too.
  const ck = "initmeta:" + (curRoot || "") + ":" + imgPath + (srcType ? "|" + srcType : "");
  const l1 = _metaCache.get(ck);
  if (l1) return l1;                           // cached hit (misses are NOT cached)
  // Concurrent callers (compare mode renders both sides in one tick; several
  // blocks can reference one image) share a single probe chain.
  return singleFlight(ck, () => _resolveInitMetaUncached(ck, imgPath, curRoot, srcType));
}

async function _resolveInitMetaUncached(ck, imgPath, curRoot, srcType) {
  try {
    const l2 = await _metaCacheAPI.get(ck);
    if (l2) { _metaCache.set(ck, l2); return l2; }
  } catch { }
  // Indexed lookup first: an [output] path is usually an indexed gallery item,
  // a [temp] path never is, and an unannotated path sits in the current root
  // or ComfyUI's input root.
  const rootIds = srcType === "output" ? ["output", curRoot]
    : srcType === "temp" ? []
      : [curRoot, "input"];
  for (const rootId of [...new Set(rootIds.filter(Boolean))]) {
    try {
      const m = await api("/sidebar_gallery/metadata", { root_id: rootId, relpath: imgPath, summary_only: "1" });
      if (m?.summary && Object.keys(m.summary).length > 2) {
        _metaCache.set(ck, m); _metaCacheAPI.put(ck, m); return m;
      }
    } catch { }
  }
  try {
    const parts = imgPath.replace(/\\/g, "/").split("/");
    const basename = parts.pop();
    const subfolder = parts.join("/");
    // The annotated location goes first; the others stay as fail-open fallback.
    const odTypes = srcType
      ? [srcType, ...["input", "output", "temp"].filter(t => t !== srcType)]
      : ["input", "output", "temp"];
    for (const _t of odTypes) {
      const odUrl = `/sidebar_gallery/metadata_ondemand?filename=${encodeURIComponent(basename)}${subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : ""}&type=${_t}`;
      const odResp = await fetch(odUrl);
      if (odResp.ok) {
        const d = await odResp.json();
        if (d?.summary && Object.keys(d.summary).length > 0) {
          _metaCache.set(ck, d); _metaCacheAPI.put(ck, d); return d;
        }
      }
    }
  } catch { }
  // Don't cache the miss: a source image still being indexed when first viewed
  // would otherwise stay "unavailable" for the whole session.
  return null;
}

export function openLightbox(_initialItems, startItemOrIndex, openEvent) {
  ensureCss();
  let items = _initialItems; // let so sbg-items-updated can reassign
  let idx = typeof startItemOrIndex === "number" ? startItemOrIndex : items.indexOf(startItemOrIndex);
  // The gallery card closes over the item object from when it was rendered; a
  // background refresh (e.g. after a reindex) can replace the items array with
  // new objects for the same files, so indexOf() fails. Match by the stable
  // identity key so a click still opens the clicked item instead of item #0.
  if (idx < 0 && startItemOrIndex && typeof startItemOrIndex === "object") {
    idx = items.findIndex(it => it && it.root_id === startItemOrIndex.root_id
                                && it.relpath === startItemOrIndex.relpath);
  }
  if (idx < 0) idx = 0;
  let meta = null;
  let destroyed = false;
  let currentMediaEl = null;

  // Defaults must match what the Keybindings settings tab displays
  // ("ArrowLeft,a,j" / "ArrowRight,d,l", so A/D and J/L navigate out of the box).
  const keyPrev = getSetting(S.KEY_PREV, "ArrowLeft,a,j");
  const keyNext = getSetting(S.KEY_NEXT, "ArrowRight,d,l");
  const keyClose = getSetting(S.KEY_CLOSE, "Escape,q,z,0");
  const keyFullscreen = getSetting(S.KEY_FULLSCREEN, "f");
  const keyDownload = getSetting(S.KEY_DOWNLOAD, "");
  const keyCopyPrompt = getSetting(S.KEY_COPY_PROMPT, "");
  const keyCopyWf = getSetting(S.KEY_COPY_WF, "");
  const keyLoadWf = getSetting(S.KEY_LOAD_WF, "");
  const keyCompare = getSetting(S.KEY_COMPARE, "c");
  const keyResetZoom = getSetting(S.KEY_RESET_ZOOM, "MiddleClick,r");
  const keyZoomIn = getSetting(S.KEY_ZOOM_IN, "=,+");
  const keyZoomOut = getSetting(S.KEY_ZOOM_OUT, "-");
  const keyMute = getSetting(S.KEY_MUTE, "m");
  const keyFramePrev = getSetting(S.KEY_FRAME_PREV, "Comma");
  const keyFrameNext = getSetting(S.KEY_FRAME_NEXT, ".");
  const keyCmpCurPrev = getSetting(S.KEY_CMP_CUR_PREV, "Shift+ArrowLeft,Shift+a");
  const keyCmpCurNext = getSetting(S.KEY_CMP_CUR_NEXT, "Shift+ArrowRight,Shift+d");

  const zoomSettings = {
    scrollMode: getSetting(S.LB_ZOOM_SCROLL_MODE, "mouse"),
    anchor: getSetting(S.LB_ZOOM_ANCHOR, "cursor"),
    sensitivity: getSetting(S.LB_ZOOM_SENSITIVITY, 1),
    compareZoom: getSetting(S.LB_COMPARE_ZOOM, "independent"),
    keepOnNav: getSetting(S.LB_ZOOM_KEEP_ON_NAV, false),
  };

  /* Build DOM */

  const mediaContainer = h("div", { style: "display:flex;align-items:center;justify-content:center;width:100%;height:100%" });
  const prevBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--prev", text: "‹", title: `Previous (${keyPrev})` });
  const nextBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--next", text: "›", title: `Next (${keyNext})` });
  const closeBtn = h("button", { class: "sbg-lb__close", text: "✕", title: `Close (${keyClose})` });

  const bottomName = h("span", { class: "sbg-lb__bottom-name" });
  const dlBtn = h("a", { class: "sbg-btn sbg-btn--sm", text: "⬇ Download", title: "Download file", download: "", target: "_blank" });
  const loadWfBtn = h("button", { class: "sbg-btn sbg-btn--sm sbg-btn--accent", text: "Load Workflow", title: "Load workflow into ComfyUI", disabled: "true" });
  const copyPromptBtn = h("button", { class: "sbg-btn sbg-btn--sm", text: "Copy Prompt", title: "Copy positive prompt", disabled: "true" });
  const copyWfBtn = h("button", { class: "sbg-btn sbg-btn--sm", text: "Copy WF", title: "Copy workflow JSON", disabled: "true" });

  // Apply lightbox button visibility settings
  if (!getSetting(S.LB_SHOW_DOWNLOAD, true)) dlBtn.style.display = "none";
  if (!getSetting(S.LB_SHOW_COPY_PROMPT, true)) copyPromptBtn.style.display = "none";
  if (!getSetting(S.LB_SHOW_COPY_WF, true)) copyWfBtn.style.display = "none";
  if (!getSetting(S.LB_SHOW_LOAD_WF, true)) loadWfBtn.style.display = "none";

  // Apply lightbox button colors
  const _lbcDl = getSetting(S.LB_COLOR_DOWNLOAD, "");
  const _lbcCp = getSetting(S.LB_COLOR_COPY_PROMPT, "");
  const _lbcWf = getSetting(S.LB_COLOR_COPY_WF, "");
  const _lbcLw = getSetting(S.LB_COLOR_LOAD_WF, "");
  if (_lbcDl) dlBtn.style.background = _lbcDl;
  if (_lbcCp) copyPromptBtn.style.background = _lbcCp;
  if (_lbcWf) copyWfBtn.style.background = _lbcWf;
  if (_lbcLw) loadWfBtn.style.background = _lbcLw;
  // Compare button
  const compareBtn = h("button", { class: "sbg-btn sbg-btn--sm", text: "⚖ Compare", title: `Compare with another image${keyCompare ? ` (${keyCompare})` : ""}` });

  const bottomBar = h("div", { class: "sbg-lb__bottom" }, [
    bottomName,
    h("div", { class: "sbg-lb__bottom-actions" }, [dlBtn, copyPromptBtn, copyWfBtn, loadWfBtn, compareBtn]),
  ]);

  const mediaArea = h("div", { class: "sbg-lb__media-area" }, [
    mediaContainer, prevBtn, nextBtn, closeBtn, bottomBar,
  ]);

  const metaBody = h("div", { class: "sbg-lb__meta-body" }, [
    h("div", { class: "sbg-lb__loading sbg-loading", text: "Loading metadata…" }),
  ]);
  const metaResizeHandle = h("div", { class: "sbg-lb__meta-resize" });
  const savedMetaWidth = localStorage.getItem("SBG.MetaPanelWidth");
  const _metaHeaderBadge = h("span", { class: "sbg-source-app" }); // placeholder, filled by renderMeta

  // Tab bar for Generated / Initial Image.
  // Tabs are hidden by default and only shown when initial_image data exists.
  const _tabGenerated = h("button", { class: "sbg-lb__meta-tab sbg-lb__meta-tab--active", text: "Generated" });
  const _tabInitialImage = h("button", { class: "sbg-lb__meta-tab", text: "Initial Image" });
  const initTabColor = getSetting(S.INITIAL_IMAGE_TAB_COLOR, "");
  if (initTabColor) {
    _tabInitialImage.style.color = initTabColor;
    _tabInitialImage.style.borderBottomColor = initTabColor;
  }
  const _metaTabs = h("div", { class: "sbg-lb__meta-tabs" }, [_tabGenerated, _tabInitialImage]);
  _metaTabs.style.display = "none"; // hide entire tab bar by default

  let _generatedMetaContent = null; // cached DOM for generated tab
  let _initialImageContent = null;  // cached DOM for initial image tab (built lazily)
  let _pendingInitialArgs = null;   // {s, rootId} for on-demand build on tab activation
  let _activeMetaTab = "generated"; // "generated" or "initial"

  function _switchMetaTab(tab) {
    _activeMetaTab = tab;
    _tabGenerated.classList.toggle("sbg-lb__meta-tab--active", tab === "generated");
    _tabInitialImage.classList.toggle("sbg-lb__meta-tab--active", tab === "initial");
    metaBody.innerHTML = "";
    if (_compareActive && _compareSummary) {
      // One router owns compare rendering, so tab clicks and compare
      // navigation can never apply different rules for the same state.
      _renderComparePanel(_compareSummary);
    } else if (tab === "generated" && _generatedMetaContent) {
      metaBody.appendChild(_generatedMetaContent);
    } else if (tab === "initial") {
      // Built on first activation instead of on every navigation: flipping
      // through items without opening this tab costs nothing per source image.
      if (!_initialImageContent && _pendingInitialArgs) {
        _initialImageContent = _getInitialContent(_pendingInitialArgs.s, _pendingInitialArgs.rootId);
      }
      if (_initialImageContent) metaBody.appendChild(_initialImageContent);
    }
    // Cached tab content was sized while detached/hidden (scrollHeight was 0, so
    // boxes collapsed to one line). Re-measure prompt boxes now that they're visible.
    requestAnimationFrame(() => {
      metaBody.querySelectorAll(".sbg-prompt-text").forEach(e => { if (e._sbgApplySize) e._sbgApplySize(); });
    });
  }

  _tabGenerated.addEventListener("click", () => _switchMetaTab("generated"));
  _tabInitialImage.addEventListener("click", () => _switchMetaTab("initial"));

  const metaPanel = h("div", { class: "sbg-lb__meta-panel" }, [
    metaResizeHandle,
    h("div", { class: "sbg-lb__meta-header" }, [_metaTabs, _metaHeaderBadge]),
    metaBody,
  ]);
  if (savedMetaWidth) metaPanel.style.width = savedMetaWidth + "px";

  // Resize drag logic
  let _resizing = false;
  metaResizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    _resizing = true;
    const startX = e.clientX;
    const startW = metaPanel.offsetWidth;
    const onMove = (ev) => {
      if (!_resizing) return;
      const newW = Math.min(600, Math.max(150, startW + (startX - ev.clientX)));
      metaPanel.style.width = newW + "px";
      metaPanel.style.maxWidth = "none";
    };
    const onUp = () => {
      _resizing = false;
      localStorage.setItem("SBG.MetaPanelWidth", metaPanel.offsetWidth);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // The drag reflowed the media area without firing a resize event, so
      // give the zoom controller the same geometry-change reset: stale pan
      // offsets and a stranded video shield otherwise persist until the next
      // wheel or drag re-syncs them. Only when the width actually changed,
      // so a stray click on the divider keeps a deliberately held zoom.
      if (metaPanel.offsetWidth !== startW) zoomCtl.resetAll();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  const overlay = h("div", { class: "sbg-lightbox" }, [mediaArea, metaPanel]);
  document.body.appendChild(overlay);

  // Zoom/pan controller. The getters are only invoked from event handlers,
  // after this closure has finished setting up (_compareElements and
  // currentMediaEl are assigned later).
  const zoomCtl = createZoomPanController({
    overlay, mediaArea, mediaContainer,
    getCurrentMediaEl: () => currentMediaEl,
    getCompareElements: () => (_compareActive ? _compareElements : null),
    settings: zoomSettings,
    // Seed the physical-Ctrl tracker from the click that opened the lightbox,
    // so a Ctrl held since before the controller's key listeners existed is
    // still known and a real Ctrl+wheel is never read as a touchpad pinch.
    initialCtrl: !!(openEvent && openEvent.ctrlKey),
  });

  // Re-render metadata when layout changes (live preview of style changes)
  const _onLayoutChanged = () => { if (meta && !destroyed) renderMeta(meta); };
  document.addEventListener("sbg-layout-changed", _onLayoutChanged);

  /* Section builder */

  // Collapse state is persisted per-section-title in localStorage, independent of
  // the layout profile (so toggling open/closed in the lightbox never mutates the
  // user's saved layout). Section order/visibility live in the profile only.
  const _PANEL_COLLAPSE_KEY = "SBG.PanelCollapsed";
  function _collapsedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(_PANEL_COLLAPSE_KEY)) || []); }
    catch { return new Set(); }
  }
  function makeSection(section, contentEl) {
    const title = section.title;
    const collapsed = _collapsedSet();
    const isOpen = collapsed.has(title) ? false : (section.open !== false);

    const chevron = h("span", { class: "sbg-section__chevron", text: "▶" });
    const sec = h("div", { class: `sbg-section${isOpen ? " sbg-section--open" : ""}` });
    const head = h("div", {
      class: "sbg-section__head", onclick: () => {
        sec.classList.toggle("sbg-section--open");
        const set = _collapsedSet();
        if (sec.classList.contains("sbg-section--open")) set.delete(title);
        else set.add(title);
        try { localStorage.setItem(_PANEL_COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
      }
    }, [h("span", { text: title }), chevron]);
    const body = h("div", { class: "sbg-section__body" }, [contentEl]);
    sec.appendChild(head);
    sec.appendChild(body);
    sec.dataset.sectionTitle = title;
    sec.dataset.sectionId = title; // for scoped search highlighting
    // Custom per-section background/colour set in the layout editor (overrides
    // the CSS-by-title default for Positive/Negative).
    if (section.color) TL.applyColor(sec, section.color);
    return sec;
  }

  // Inject file-level fields (filename/path/size/modified) into the summary so the
  // File Info section can resolve them via plain paths like any other field.
  function _mergeFileInfo(summary, file) {
    // Respect the "Filename Display" setting (basename vs full relative path).
    const relStyle = getSetting(S.FILENAME_STYLE, "basename") === "relpath";
    return Object.assign({}, summary, {
      filename: file && (relStyle ? (file.relpath || file.filename) : file.filename),
      path: file && file.relpath,
      filesize: file ? fmtBytes(file.size) : undefined,
      modified: (file && file.mtime) ? new Date(file.mtime * 1000).toLocaleString() : undefined,
    });
  }

  /** Sort metaBody children by saved order, using layout config if available */
  /* Render metadata */

  let _metaObservers = []; // Track MutationObservers for cleanup on re-render

  function renderMeta(m) {
    meta = m;
    // Disconnect previous MutationObservers before clearing the DOM
    for (const obs of _metaObservers) { try { obs.disconnect(); } catch { } }
    _metaObservers = [];
    metaBody.innerHTML = "";
    loadWfBtn.disabled = true;
    copyPromptBtn.disabled = true;
    copyWfBtn.disabled = true;

    // Reset tab state, preserving the active tab if the user enabled tab persistence.
    // While compare is active the compare panel owns the tab state and the
    // tab-bar visibility (resetting here would yank the user off the Initial
    // tab on every left-side navigation).
    _generatedMetaContent = null;
    _initialImageContent = null;
    _pendingInitialArgs = null;
    const tabPersist = getSetting(S.META_TAB_PERSIST, false);
    if (!tabPersist && !_compareActive) {
      _activeMetaTab = "generated";
      _tabGenerated.classList.add("sbg-lb__meta-tab--active");
      _tabInitialImage.classList.remove("sbg-lb__meta-tab--active");
    }
    if (!_compareActive) _metaTabs.style.display = "none"; // hide until initial_image found

    if (!m) {
      metaBody.appendChild(h("div", { class: "sbg-lb__loading", text: "No metadata" }));
      return;
    }

    const s = m.summary || {};

    // Source App Badge (in METADATA header)
    // Derived from the shared app registry, so a newly supported app gets its
    // lightbox badge automatically.
    const _appLabels = TL.APP_LABELS;
    const _appColorKeys = Object.fromEntries(APP_REGISTRY.map(a => [a.id, a.settingKey]));
    _metaHeaderBadge.innerHTML = "";
    if (s.source_app && _appLabels[s.source_app]) {
      const badge = h("span", { class: `sbg-badge sbg-badge--source sbg-badge--source-${s.source_app}`, text: _appLabels[s.source_app] });
      // Apply user-customized badge color
      const userColor = getSetting(_appColorKeys[s.source_app], "");
      if (userColor) {
        badge.style.color = userColor;
        badge.style.borderColor = userColor;
        badge.style.background = `linear-gradient(135deg, ${userColor}33, ${userColor}1f)`;
      }
      _metaHeaderBadge.appendChild(badge);
    }

    // Action-button enablement depends only on the summary.
    if (s.positive_prompt) copyPromptBtn.disabled = false;
    if (s.has_workflow) {
      loadWfBtn.disabled = false;
      copyWfBtn.disabled = false;
    }

    // Compare mode owns the panel
    // Skip building the full normal panel (it would be wiped immediately and
    // is rebuilt from scratch when compare closes); render the compare view
    // for whichever tab is active instead.
    if (_compareActive) {
      if (_compareSummary) _renderComparePanel(_compareSummary);
      return;
    }

    // Translation-layer rendering (single source of truth)
    // The SAME renderSection() drives the layout-editor preview, so the panel
    // and the editor can never disagree. Section order/visibility come straight
    // from the active profile (app × media).
    // Use the gallery item for file-level fields: the metadata response's `file`
    // object lacks `filename` and `kind`, but the gallery item has both.
    const fileItem = (items && items[idx]) || m.file || {};
    const _app = s.source_app || "comfyui";
    const _isVid = isVideo(fileItem);
    const _profile = TL.getActiveProfile(_app, _isVid);
    const _merged = _mergeFileInfo(s, fileItem);

    for (const section of _profile) {
      if (!section || !section.title) continue;
      if (section.hidden) continue;  // hidden via the layout-editor eye toggle
      if (!TL.sectionHasData(section, _merged)) continue;
      const rawData = section.style === "raw" ? (m.workflow || m.prompt || null) : null;
      const contentEl = TL.renderSection(section, _merged, { rawData, profileKey: TL.profileKey(_app, _isVid) });
      if (!contentEl) continue;
      metaBody.appendChild(makeSection(section, contentEl));
    }

    // Search highlighting in metadata panel
    // Highlight each searched value wherever it appears in the panel. searchState.query
    // holds values only (field prefixes like "adetailer:" never reach here), so a
    // field-scoped search like "adetailer:denoising" highlights "denoising".
    // Panel-wide highlighting is correct and only trivially over-broad.
    if (searchState.query) {
      const queries = searchState.query.split("\x00").filter(Boolean);
      for (const q of queries) highlightSearchMatches(metaBody, q);
    }

    // Cache generated content for tab switching
    _generatedMetaContent = h("div", {});
    while (metaBody.firstChild) _generatedMetaContent.appendChild(metaBody.firstChild);
    metaBody.appendChild(_generatedMetaContent);

    // Initial Image tab
    if (initialImageList(s).length) {
      _metaTabs.style.display = ""; // show tab bar when initial image(s) exist
      // LAZY: don't build the blocks (async metadata chains + /view probes per
      // source image) unless the tab is actually shown. _switchMetaTab builds
      // from these pending args on first activation; compare mode has its own
      // eager path since its blocks are immediately visible.
      _pendingInitialArgs = { s, rootId: meta?._sbgRootId ?? items[idx]?.root_id };

      // If tab persistence is on and user was on the initial tab, switch back
      // to it (this builds the content right away, since the user is looking at it).
      if (tabPersist && _activeMetaTab === "initial") {
        _switchMetaTab("initial");
      }
    }
  }

  // Identity of a summary's source-image SET under a root (compare mode's
  // "same source" check). Pure string; no caching hangs off it. The location
  // token joins the path so two entries differing only by annotation stay
  // distinct.
  function _initialContentKey(s, rootId) {
    return `${rootId || ""}:${initialImageList(s).map(e => {
      const n = normalizeInitialEntry(e);
      return n.path + (n.srcType ? "|" + n.srcType : "");
    }).join("\x00")}`;
  }

  // Fresh wrapper of per-image blocks. The DOM is intentionally NOT cached:
  // every expensive part is cached per IMAGE underneath (_resolveInitMeta's
  // L1/IndexedDB entries + the resolved /view type below), so a rebuild costs
  // microseconds and each caller (Initial tab, either compare side) gets its
  // own nodes, so the same source image can appear in several places at once
  // without DOM-single-parent fights, and one unresolvable image never
  // invalidates its siblings' cached work.
  function _getInitialContent(s, rootId) {
    const list = initialImageList(s);
    const el = h("div", {});
    list.forEach((entry, i) => {
      const label = list.length > 1 ? `Source Image ${i + 1} of ${list.length}` : "Source Image";
      el.appendChild(_buildInitialContent(entry, rootId, label));
    });
    return el;
  }

  // Which /view type (input/output/temp) serves a source image, resolved once
  // per image per session; "none" = all three 404ed (skip probing next time).
  const _initViewType = new Map();

  // Build the "Initial Image" content block for ONE source image: preview,
  // filename, and the source image's own metadata (resolved async, cached and
  // single-flighted per image in _resolveInitMeta). Used by the normal Initial
  // Image tab and by compare mode for both sides.
  function _buildInitialContent(entry, rootId, label) {
    const initWrap = h("div", { class: "sbg-meta-group", style: "padding:8px" });

    const { path: imgPath, name: imgName, srcType } = normalizeInitialEntry(entry);
    initWrap.appendChild(h("div", { style: "font-size:12px;font-weight:600;color:var(--sbg-text);margin-bottom:6px", text: label || "Source Image" }));

    // Thumbnail preview via ComfyUI's /view endpoint. The image can live in
    // input, output, or temp; an annotated path names its location, which is
    // probed first, and the working type is remembered per image so the
    // onerror probe chain runs at most once per session.
    if (imgPath) {
      const parts = imgPath.replace(/\\/g, "/").split("/");
      const basename = parts.pop();
      const subfolder = parts.join("/");
      const viewUrl = (type) => subfolder
        ? `/view?filename=${encodeURIComponent(basename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
        : `/view?filename=${encodeURIComponent(basename)}&type=${type}`;
      const vk = `${rootId || ""}:${imgPath}` + (srcType ? "|" + srcType : "");
      const known = _initViewType.get(vk);
      const img = h("img", { class: "sbg-initial-image-preview" });
      if (known === "none") {
        img.style.display = "none";
      } else if (known) {
        img.src = viewUrl(known);
        initWrap.appendChild(img);
      } else {
        const _viewTypes = srcType
          ? [srcType, ...["input", "output", "temp"].filter(t => t !== srcType)]
          : ["input", "output", "temp"];
        let _vt = 0;
        const _tryNextView = () => {
          if (_vt >= _viewTypes.length) {
            img.style.display = "none";
            _initViewType.set(vk, "none");
            return;
          }
          img.src = viewUrl(_viewTypes[_vt++]);
        };
        img.onerror = _tryNextView;
        img.onload = () => _initViewType.set(vk, _viewTypes[_vt - 1]);
        _tryNextView();
        initWrap.appendChild(img);
      }
    }

    // File info (kvRow inserts word-break opportunities into long filenames)
    const infoGroup = h("div", { class: "sbg-meta-group" });
    const nameRow = kvRow("Filename", imgName);
    if (nameRow) infoGroup.appendChild(nameRow);
    initWrap.appendChild(infoGroup);

    // The source image's own metadata: cache hits render instantly; a miss
    // shows "unavailable" for THIS block only and (since misses are never
    // cached) retries naturally on the next render.
    if (imgPath) {
      const metaNote = h("div", { class: "sbg-lb__loading sbg-loading", text: "Loading initial image metadata…", style: "font-size:10px;padding:8px" });
      initWrap.appendChild(metaNote);
      const _initGen = _navGen;
      (async () => {
        const m = await _resolveInitMeta(imgPath, rootId, srcType);
        // Generation guard like every sibling continuation: the resolve can
        // take seconds across its probes, and by then navigation or close has
        // replaced this block.
        if (destroyed || _initGen !== _navGen) return;
        if (m && m.summary && Object.keys(m.summary).length > 0) {
          metaNote.remove();
          const initS = m.summary;
          const initMerged = _mergeFileInfo(initS, m.file);
          const initProfile = TL.getActiveProfile(initS.source_app || "comfyui", false);
          for (const section of initProfile) {
            if (!section || !section.title) continue;
            if (!TL.sectionHasData(section, initMerged)) continue;
            const contentEl = TL.renderSection(section, initMerged, {});
            if (!contentEl) continue;
            initWrap.appendChild(makeSection(section, contentEl));
          }
        } else {
          metaNote.textContent = "Source image metadata unavailable";
          metaNote.classList.remove("sbg-loading");
          metaNote.style.cssText = "font-size:10px;padding:8px;opacity:0.5";
        }
      })();
    }

    return initWrap;
  }


  /* Navigate */

  let _navGen = 0; // generation counter: prevents stale metadata overwrites
  let _lastNavAt = 0; // for rapid-nav (held key) coalescing in goTo
  const metaCache = _metaCache; // use module-level cache

  // Validate a cached metadata entry against the file's real modification
  // time. it.mtime is the gallery sort key (creation time); comparing against
  // it would mark every file whose ctime != mtime (copied/imported/re-saved
  // files) permanently stale. it.mtime_real is the true mtime, matching
  // cached.file.mtime returned by /metadata.
  const _freshMeta = (c, mt) => !!(c && !(mt && c.file?.mtime && c.file.mtime < mt));

  // Summary metadata for any gallery item through the full cache chain:
  // L1 (in-memory), then L2 (IndexedDB), then network, with mtime staleness
  // validation at each level and write-back to both caches. Shared by the
  // current-item path, the compare side, and the neighbour prefetch so no
  // path can drift to a weaker chain.
  async function _getSummaryMeta(it) {
    const ck = itemKey(it);
    const mt = it.mtime_real ?? it.mtime;
    const l1 = metaCache.get(ck);
    if (_freshMeta(l1, mt)) return l1;
    try {
      const l2 = await _metaCacheAPI.get(ck);
      if (_freshMeta(l2, mt)) { metaCache.set(ck, l2); return l2; }
    } catch { }
    const m = await api("/sidebar_gallery/metadata", { root_id: it.root_id, relpath: it.relpath, summary_only: "1" });
    metaCache.set(ck, m);
    _metaCacheAPI.put(ck, m);
    return m;
  }

  function goTo(newIdx) {
    if (newIdx < 0 || newIdx >= items.length) return;
    // Compare mode invariant: the two panes never show the same file. When
    // the current side lands on the compared image, the compared side steps
    // out of the way in the direction the current moved, mirroring how every
    // other compare mover skips over idx.
    if (_compareActive && newIdx === _compareIdx && items.length > 1) {
      const _dir = newIdx >= idx ? 1 : -1;
      _compareIdx = nextCompareIdx(_compareIdx, _dir, newIdx, items.length);
      _loadCompareImage();
    }
    idx = newIdx;
    _navGen++;
    const gen = _navGen;
    const it = items[idx];
    // Navigation returns to fit-to-screen, but in independent compare mode
    // only the pane being navigated resets, so a zoom pinned on the compared
    // side survives cycling the current side (and vice versa). With "Keep
    // Zoom While Browsing" on, nothing resets: _swapIn re-applies the
    // preserved state to the incoming media once it has its real size.
    if (!zoomSettings.keepOnNav) {
      if (_compareActive && zoomSettings.compareZoom !== "synced") {
        zoomCtl.resetPane("left");
      } else {
        zoomCtl.resetAll();
      }
    }

    // Cross-fade media swap (images only)
    // Keep the previous frame visible until the new media can paint, so there's
    // no blank flash, but only for images. A <video> kept alive as a backdrop
    // holds its decoder, and Firefox-on-Windows has a tiny H.265/HEVC decoder
    // pool also shared with ComfyUI's own canvas video previews; two live HEVC
    // decoders at once can exhaust it and make the next clip fail with "could not
    // be decoded". So release any outgoing video's decoder up front; images cost
    // no decoder and still stay as a no-flash backdrop. This also drops any
    // still-pending (un-revealed) media from a previous fast nav so half-loaded
    // <video>s don't pile up.
    // During compare the current media lives inside the left figure, so the
    // cross-fade swap happens there; overlay elements (labels, arrows) are
    // tagged data-sbg-compare and must survive the sweep.
    const mediaHost = (_compareActive && _compareElements) ? _compareElements.leftFig : mediaContainer;
    for (const child of [...mediaHost.children]) {
      if (_isCompareTag(child)) continue;
      if (child.tagName === "VIDEO" || (child.dataset && child.dataset.sbgPending === "1")) {
        releaseVideo(child);
        // Detaching an <img> does NOT abort its in-flight fetch, and a pending
        // decode() keeps the full download + rasterization alive. Clearing src
        // does abort both. Without this, holding the nav key queues a complete
        // download + decode for EVERY skipped image, and the frame the user
        // lands on paints only after that whole backlog drains.
        if (child.tagName === "IMG") child.removeAttribute("src");
        // The rapid-nav path defers buildMedia, so until it runs the media
        // keys (mute, frame step, spacebar) would otherwise act on this
        // released, detached element; null makes them explicit no-ops.
        if (child === currentMediaEl) currentMediaEl = null;
        child.remove();
      }
    }
    const prevChildren = [...mediaHost.children].filter(c => !_isCompareTag(c));
    mediaContainer.style.position = "relative";
    const _insertMedia = (el) => mediaHost.appendChild(el);

    let swapped = false;
    const _swapIn = (neu) => {
      if (swapped || destroyed || _navGen !== gen) return; // stale or already done
      swapped = true;
      if (neu.dataset) delete neu.dataset.sbgPending;
      neu.style.position = "";
      neu.style.opacity = "";
      mediaContainer.style.position = "";
      for (const old of prevChildren) {
        // The media may have been adopted into (or out of) the compare figure
        // between fade start and swap; remove it wherever it lives now.
        if (!old.parentNode) continue;
        releaseVideo(old);
        old.remove();
      }
      // Keep Zoom While Browsing: the fresh element starts untransformed, so
      // carry the preserved pane state onto it now that its size is known.
      if (zoomSettings.keepOnNav) zoomCtl.reapply(_compareActive ? "left" : "single");
    };

    // Rapid-nav coalescing: Firefox never aborts an <img> fetch once src is set
    // (clearing src or detaching keeps the download AND decode alive), so a held
    // nav key would queue a full-resolution download + decode for EVERY skipped
    // frame and the one the user lands on paints only after that backlog drains.
    // Instead, while keydowns arrive faster than _RAPID_NAV_MS the heavy work
    // (media element + metadata fetch) is deferred with a trailing debounce, so
    // only the settled frame loads. The counter/labels below still track every
    // step, and single-step navigation (gaps > _RAPID_NAV_MS) is unaffected.
    const _RAPID_NAV_MS = 160;
    const rapid = performance.now() - _lastNavAt < _RAPID_NAV_MS;
    _lastNavAt = performance.now();

    const buildMedia = () => {
    if (isVideo(it)) {
      // preload="metadata" (not "auto"): "auto" eagerly buffers/decodes the whole
      // clip the moment its src is set, keeping the HEVC decoder engaged longer
      // than needed. autoplay still plays it; this trims decoder/IO pressure.
      const video = h("video", { class: "sbg-lb__video", controls: "true", autoplay: "true", preload: "metadata" });
      video.dataset.sbgPending = "1";
      video.style.position = "absolute";
      video.style.opacity = "0";
      video.volume = _mediaState.volume;
      video.muted = _mediaState.muted;
      video.loop = _mediaState.loop;
      video.onvolumechange = () => { _mediaState.volume = video.volume; _mediaState.muted = video.muted; };
      // Reveal once the first frame is decoded (loadeddata); canplay is a fallback.
      video.onloadeddata = () => _swapIn(video);
      video.oncanplay = () => _swapIn(video);
      // Recover from a failed load. A decode / "format not supported" error on
      // these files is almost always transient: the browser briefly couldn't get
      // one of the few HEVC hardware decoders (shared with ComfyUI's own canvas
      // video previews), or the file is still flushing to disk right after
      // generation. Reset the element and re-request a decoder a handful of times
      // with backoff before giving up and revealing the broken box. Videos are
      // served no-cache (stored + cheap 304 revalidation, see routes.py
      // get_file), so a retry revalidates and reuses the stored bytes rather
      // than re-downloading the clip.
      let _vidRetries = 0;
      const _maxVidRetries = 6;
      video.onerror = () => {
        if (destroyed || _navGen !== gen) return;
        if (video.error && _vidRetries < _maxVidRetries) {
          _vidRetries++;
          setTimeout(() => {
            if (destroyed || _navGen !== gen) return;
            try { video.pause(); video.removeAttribute("src"); video.load(); } catch { }
            video.src = fileUrl(it);
          }, Math.min(1500, 300 * _vidRetries));
        } else {
          _swapIn(video);
        }
      };
      currentMediaEl = video;
      _insertMedia(video);
      video.src = fileUrl(it);
      if (video.readyState >= 2) _swapIn(video); // already buffered (revisit)
    } else {
      const img = h("img", { class: "sbg-lb__img" });
      img.dataset.sbgPending = "1";
      img.style.position = "absolute";
      img.style.opacity = "0";
      img.onerror = () => _swapIn(img); // still swap on error
      currentMediaEl = img;
      _insertMedia(img);
      img.src = fileUrl(it);
      // Reveal only once the bitmap is DECODED and ready to paint rather than
      // merely downloaded. onload fires before the browser has rasterized the image,
      // so revealing the new frame and removing the old backdrop there leaves a
      // one-frame blank while decode finishes. The flicker seen on slow
      // navigation and whenever the decoded bitmap was evicted (e.g. Firefox
      // dropping it after the tab was backgrounded). decode() resolves only when
      // a synchronous paint is possible, so the swap stays seamless. Fall back
      // to onload where decode() is unavailable, and to a plain swap if decode
      // rejects (a decode error on an otherwise-loaded file).
      if (img.decode) {
        img.decode().then(() => _swapIn(img)).catch(() => _swapIn(img));
      } else {
        img.onload = () => _swapIn(img);
        if (img.complete) _swapIn(img); // synchronously cached
      }
    }
    }; // end buildMedia

    bottomName.textContent = `${it.filename}  (${idx + 1} / ${items.length})`;
    dlBtn.href = fileUrl(it);
    dlBtn.download = it.filename || "";
    prevBtn.style.visibility = idx === 0 ? "hidden" : "visible";
    nextBtn.style.visibility = idx === items.length - 1 ? "hidden" : "visible";
    _updateCompareLabels(); // left filename + arrow visibility depend on idx

    const buildMeta = () => {
    // Metadata: use cache or fetch summary from DB
    const cacheKey = itemKey(it);
    const cached = metaCache.get(cacheKey);
    const _itMtime = it.mtime_real ?? it.mtime;
    // Save scroll position before any metadata content change
    const savedScroll = metaPanel.scrollTop;
    if (_freshMeta(cached, _itMtime)) {
      // Stamp the owning root: a re-render (layout change, compare close) can
      // run after idx already points at another root's item, and pairing this
      // summary with THAT item's root would cache source-image lookups under
      // the wrong root.
      cached._sbgRootId = it.root_id;
      renderMeta(cached);
      requestAnimationFrame(() => { metaPanel.scrollTop = savedScroll; });
    } else {
      // The transitional notes stay compare-aware: during compare a bare
      // "Loading…" would wipe the diff header with no context.
      metaBody.innerHTML = "";
      if (_compareActive) metaBody.appendChild(_compareHeader(false));
      metaBody.appendChild(h("div", { class: "sbg-lb__loading sbg-loading", text: "Loading metadata…" }));

      _getSummaryMeta(it).then((m) => {
        if (!destroyed && _navGen === gen) {
          if (m) m._sbgRootId = it.root_id;
          renderMeta(m);
          requestAnimationFrame(() => { metaPanel.scrollTop = savedScroll; });
        }
      }).catch((e) => {
        if (!destroyed && _navGen === gen) {
          // Drop the previous item's metadata: keeping it would let a later
          // re-render (e.g. layout change during compare) present the OLD
          // item's parameters as the current image's.
          meta = null;
          metaBody.innerHTML = "";
          if (_compareActive) metaBody.appendChild(_compareHeader(false));
          metaBody.appendChild(h("div", { class: "sbg-lb__loading", text: `Error: ${e?.message || e}` }));
        }
      });
    }
    }; // end buildMeta

    if (rapid) {
      // Trailing debounce: a further keydown bumps _navGen, so only the frame
      // the user settles on actually loads media + metadata.
      setTimeout(() => {
        if (destroyed || _navGen !== gen) return;
        buildMedia();
        buildMeta();
      }, _RAPID_NAV_MS);
    } else {
      buildMedia();
      buildMeta();
    }

    // Debounced prefetch: only when user settles (300ms)
    clearTimeout(_prefetchTimer);
    _prefetchTimer = setTimeout(() => {
      if (destroyed || _navGen !== gen) return;
      for (const di of [-1, 1]) {
        const ni = idx + di;
        if (ni < 0 || ni >= items.length) continue;
        const adj = items[ni];

        if (!metaCache.has(itemKey(adj))) {
          _getSummaryMeta(adj).catch(() => { });
        }

        // Only prefetch images. Prefetching a video would download the whole file
        // for a neighbour the user may never open; revisits of an already-viewed
        // video are covered by /file's immutable caching instead.
        if (!isVideo(adj)) {
          const pre = new Image();
          pre.src = fileUrl(adj);
          // Warm the DECODED bitmap rather than just the HTTP cache: goTo reveals the
          // next image on decode(), so a pre-decoded neighbour swaps in with no
          // decode gap even the first time it's viewed. Ignore failures.
          pre.decode?.().catch(() => { });
        }
      }
    }, 300);
  }

  /* Events */

  // Listen for new items so the lightbox can navigate to newly generated images
  function _onItemsUpdated(e) {
    if (destroyed) return;
    const newItems = e.detail?.items;
    if (!newItems || !Array.isArray(newItems)) return;
    // Find the current item by relpath to maintain position
    const currentItem = items[idx];
    const currentKey = currentItem ? itemKey(currentItem) : null;
    const cmpItem = _compareActive ? items[_compareIdx] : null;
    const cmpKey = cmpItem ? itemKey(cmpItem) : null;
    items = newItems;
    // Re-find our position in the new array. If the current file vanished,
    // clamp idx into range: a stale out-of-range index blanks labels, makes
    // the nav arrows dead, and poisons the compare remap's collision check.
    const newIdx = currentKey ? items.findIndex(it => itemKey(it) === currentKey) : -1;
    const vanished = newIdx < 0;
    if (newIdx >= 0) idx = newIdx;
    else idx = Math.max(0, Math.min(idx, items.length - 1));
    // Re-find the compared item too, or compare mode silently drifts to a
    // different file every time auto-refresh replaces the items array.
    if (_compareActive) {
      if (items.length < 2) {
        closeCompareMode();
      } else {
        const r = remapCompareIdx(items, cmpKey, _compareIdx, idx);
        _compareIdx = r.compareIdx;
        // Only reload the media when the resolved file actually changed; a
        // src reset would restart a playing compared video on every refresh.
        if (r.changed) _loadCompareImage();
        else _updateCompareLabels();
      }
    }
    // The viewed file itself is gone: reload the viewer at the clamped
    // position so the media, the metadata panel and the Download button move
    // together. Relabeling alone left them all describing the deleted file
    // while the bottom label named its neighbour. With nothing left to show,
    // close the viewer instead of keeping the deleted file on screen.
    if (vanished && !items.length) { destroy(); return; }
    if (vanished && items.length) { goTo(idx); return; }
    // Update nav button visibility
    prevBtn.style.visibility = idx === 0 ? "hidden" : "visible";
    nextBtn.style.visibility = idx === items.length - 1 ? "hidden" : "visible";
    bottomName.textContent = `${items[idx]?.filename || ""}  (${idx + 1} / ${items.length})`;
  }
  document.addEventListener("sbg-items-updated", _onItemsUpdated);

  function destroy() {
    destroyed = true;
    clearTimeout(_prefetchTimer);
    if (_compareActive) closeCompareMode();
    // Release the decoder instead of just pausing it: a bare pause() here would leak an
    // HEVC decoder on every lightbox close (see releaseVideo()).
    releaseVideo(currentMediaEl);
    zoomCtl.destroy();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onMouseButton, true);
    document.removeEventListener("auxclick", onAuxClick, true);
    document.removeEventListener("sbg-items-updated", _onItemsUpdated);
    document.removeEventListener("sbg-layout-changed", _onLayoutChanged);
  }

  let _prefetchTimer = null;

  // Step a paused video by one frame. The step uses the file's real frame
  // rate when ffprobe extracted one, and 1/30s otherwise. A playing video
  // pauses first so the step lands on a visible frame.
  function _frameStep(dir) {
    const v = currentMediaEl;
    if (!v || v.tagName !== "VIDEO") return true;
    if (!v.paused) v.pause();
    if (!isFinite(v.duration)) return true;
    const fps = Number(meta?.summary?.fps);
    const step = Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30;
    v.currentTime = Math.min(Math.max(0, v.currentTime + dir * step), Math.max(0, v.duration - 0.001));
    return true;
  }

  const _navRun = (dir) => (d) => {
    // In compare mode the plain navigation keys change the compared image.
    if (_compareActive) {
      _navigateCompare(dir);
      return true;
    }
    const isFS = !!document.fullscreenElement;
    const isVid = currentMediaEl && currentMediaEl.tagName === "VIDEO";
    const isArrow = d.key === "ArrowLeft" || d.key === "ArrowRight";
    if (isFS && isVid && isArrow && isFinite(currentMediaEl.duration)) {
      // In fullscreen over a video, ONLY arrows seek by 10% of duration
      const step = currentMediaEl.duration * 0.1;
      if (d.key === "ArrowLeft") currentMediaEl.currentTime = Math.max(0, currentMediaEl.currentTime - step);
      else currentMediaEl.currentTime = Math.min(currentMediaEl.duration, currentMediaEl.currentTime + step);
    } else {
      // A/D keys always navigate gallery. Arrows navigate outside fullscreen.
      goTo(idx + dir);
    }
    return true;
  };

  // Compare mode only: navigate the CURRENT image (the left half). Outside
  // compare mode the action declines, so a combo like Shift+ArrowLeft falls
  // through to plain navigation.
  const _cmpNavRun = (dir) => () => {
    if (!_compareActive) return false;
    goTo(idx + dir);
    return true;
  };

  // Close keys, split by modifier policy: Escape keeps closing under ANY held
  // modifier, while letter and digit close keys (the "q,z,0" defaults) match
  // bare only, so a chord like Ctrl+Z stays with the browser and ComfyUI
  // instead of closing the lightbox. A whole-string "," is the comma KEY (the
  // parser's own special case) and must reach the bare bucket verbatim rather
  // than dissolving into empty chunks.
  const _closeChunks = String(keyClose).trim() === ","
    ? [","]
    : String(keyClose).split(",").map(s => s.trim()).filter(Boolean);
  const keyCloseEscape = _closeChunks.filter(k => k.toLowerCase() === "escape").join(",");
  const keyCloseBare = _closeChunks.filter(k => k.toLowerCase() !== "escape").join(",");
  const _closeRun = () => {
    if (document.fullscreenElement) { document.exitFullscreen(); return true; }
    // Close compare mode first, then lightbox
    if (_compareActive) { closeCompareMode(); return true; }
    destroy();
    return true;
  };

  // Action table for keyboard and mouse bindings, in priority order. Each
  // entry's mods field is the bare-chunk modifier policy of matchBare();
  // run() may return false to decline the event so a later action (or the
  // bare pass) can claim it.
  const _ACTIONS = [
    { keys: keyCloseEscape, mods: "any", run: _closeRun },
    { keys: keyCloseBare, run: _closeRun },
    {
      keys: keyFullscreen, mods: "none", run: () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else overlay.requestFullscreen?.().catch(() => { });
        return true;
      },
    },
    {
      keys: keyCompare, mods: "none",
      // Navigation keys win a conflict: the settings tab promises "A/D
      // always navigate", so a compare binding that collides with prev or
      // next must never hijack them.
      when: (d) => !matchBare(keyPrev, d) && !matchBare(keyNext, d),
      run: () => { openCompareMode(); return true; },
    },
    { keys: keyCmpCurPrev, run: _cmpNavRun(-1) },
    { keys: keyCmpCurNext, run: _cmpNavRun(1) },
    { keys: keyResetZoom, run: (d) => { zoomCtl.resetSmart(d.x, d.y); return true; } },
    { keys: keyZoomIn, run: () => { zoomCtl.keyZoom(1); return true; } },
    { keys: keyZoomOut, run: () => { zoomCtl.keyZoom(-1); return true; } },
    {
      keys: keyMute, run: () => {
        if (currentMediaEl && currentMediaEl.tagName === "VIDEO") currentMediaEl.muted = !currentMediaEl.muted;
        return true;
      },
    },
    { keys: keyFramePrev, run: () => _frameStep(-1) },
    { keys: keyFrameNext, run: () => _frameStep(1) },
    // Optional action keys (configured in Keybindings; empty = disabled)
    { keys: keyDownload, run: () => { dlBtn.click(); return true; } },
    { keys: keyCopyPrompt, run: () => { if (!copyPromptBtn.disabled) copyPromptBtn.click(); return true; } },
    { keys: keyCopyWf, run: () => { if (!copyWfBtn.disabled) copyWfBtn.click(); return true; } },
    { keys: keyLoadWf, run: () => { if (!loadWfBtn.disabled) loadWfBtn.click(); return true; } },
    { keys: keyPrev, run: _navRun(-1) },
    { keys: keyNext, run: _navRun(1) },
  ];

  // Two-pass dispatch: chunks with explicit modifiers ("Shift+a") are tried
  // across ALL actions before any bare chunk, so a combo binding beats a
  // bare binding for the same key regardless of table position.
  function _dispatch(d) {
    for (const explicitPass of [true, false]) {
      for (const a of _ACTIONS) {
        const hit = explicitPass
          ? matchExplicit(a.keys, d)
          : matchBare(a.keys, d, a.mods || "shift");
        if (!hit) continue;
        if (a.when && !a.when(d)) continue;
        if (a.run(d) !== false) return true;
      }
    }
    return false;
  }

  function _handleKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    // Spacebar: pause/play video
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      if (currentMediaEl && currentMediaEl.tagName === "VIDEO") {
        if (currentMediaEl.paused) currentMediaEl.play();
        else currentMediaEl.pause();
      }
      return;
    }

    if (_dispatch(descFromKeyEvent(e))) e.preventDefault();
  }

  // Wrap the handler so a key the lightbox acts on is also blocked from reaching
  // ComfyUI's global shortcuts underneath (e.g. "c" also opening the ComfyUI
  // console). Capture phase runs before ComfyUI's bubble-phase handlers, and
  // stopImmediatePropagation keeps the event from bubbling to them.
  function onKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    _handleKey(e);
    if (e.defaultPrevented) { e.stopPropagation(); e.stopImmediatePropagation(); }
  }
  document.addEventListener("keydown", onKey, true);

  // Mouse buttons route through the same dispatch table, so any binding
  // field can also name MiddleClick, Mouse4, or Mouse5. Plain clicks and
  // right clicks stay native (no binding token maps to their buttons), and
  // preventDefault stops the browser's own middle button behaviors
  // (autoscroll) inside the lightbox.
  //
  // Two triggers are needed. Over images the pointerdown fires normally.
  // Over a <video>, Firefox's native controls consume the entire pointer
  // and mouse down/up pair before page listeners run, and ONLY the
  // auxclick survives, so auxclick dispatches as the fallback. The
  // one-shot token below marks a button already handled by its pointerdown
  // so the auxclick that follows the same physical press is swallowed
  // without running the action a second time.
  let _ptrHandled = { button: -1, t: 0 };

  function onMouseButton(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.button === 0 || e.button === 2) return;
    if (_dispatch(descFromMouseEvent(e))) {
      _ptrHandled = { button: e.button, t: performance.now() };
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }
  function onAuxClick(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.button === 0 || e.button === 2) return;
    const dupe = e.button === _ptrHandled.button && performance.now() - _ptrHandled.t < 800;
    _ptrHandled = { button: -1, t: 0 };
    if (dupe || _dispatch(descFromMouseEvent(e))) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }
  document.addEventListener("pointerdown", onMouseButton, true);
  document.addEventListener("auxclick", onAuxClick, true);

  closeBtn.addEventListener("click", destroy);
  prevBtn.addEventListener("click", () => goTo(idx - 1));
  nextBtn.addEventListener("click", () => goTo(idx + 1));
  mediaArea.addEventListener("click", (e) => {
    // The compare halves tile the container, so the dark space beside each
    // image belongs to a .sbg-compare__half: treat it as background too.
    const isBackground = e.target === mediaArea || e.target === mediaContainer
      || (e.target.classList && e.target.classList.contains("sbg-compare__half"));
    if (isBackground) {
      // Background click peels one layer, matching Escape: compare first.
      if (_compareActive) closeCompareMode();
      else destroy();
    }
  });

  // Helper: lazy-fetch full metadata (with prompt+workflow) for current item
  async function _fetchFullMeta() {
    if (meta?.workflow) return meta; // already have it
    const it = items[idx];
    if (!it) return meta;
    const gen = _navGen; // capture current generation
    const full = await api("/sidebar_gallery/metadata", { root_id: it.root_id, relpath: it.relpath });
    // Guard: if user navigated away during fetch, don't overwrite meta
    if (_navGen !== gen || destroyed) return meta;
    // Merge workflow/prompt into cached meta so subsequent clicks are instant
    if (meta) {
      meta.workflow = full.workflow;
      meta.prompt = full.prompt;
    } else {
      meta = full;
    }
    // Update L1+L2 caches
    const ck = itemKey(it);
    metaCache.set(ck, meta);
    _metaCacheAPI.put(ck, meta);
    return meta;
  }

  loadWfBtn.addEventListener("click", async () => {
    try {
      loadWfBtn.textContent = "Loading…";
      const m = await _fetchFullMeta();
      if (!m?.workflow) { showToast("No workflow data"); return; }
      let wf = m.workflow;
      if (typeof wf === "string") wf = JSON.parse(wf);
      app.loadGraphData(wf);
      showToast("Workflow loaded!");
      destroy();
    } catch (e) {
      showToast(`Failed: ${e?.message || e}`, 5000);
    } finally {
      loadWfBtn.textContent = "Load Workflow";
    }
  });

  copyPromptBtn.addEventListener("click", () => {
    const p = meta?.summary?.positive_prompt;
    if (p) copyText(typeof p === "string" ? p : pj(p));
  });

  copyWfBtn.addEventListener("click", async () => {
    try {
      copyWfBtn.textContent = "Loading…";
      const m = await _fetchFullMeta();
      if (m?.workflow) copyText(typeof m.workflow === "string" ? m.workflow : pj(m.workflow));
      else showToast("No workflow data");
    } catch (e) {
      showToast(`Failed: ${e?.message || e}`);
    } finally {
      copyWfBtn.textContent = "Copy WF";
    }
  });

  // In-lightbox comparison mode
  let _compareActive = false;
  let _compareIdx = -1;
  let _compareElements = null;
  let _compareSummary = null;  // cached for tab switching (may be a sentinel below)
  let _cmpGen = 0;             // generation counter: drops stale compare metadata responses

  // Side colours shared by every compare view (legend, side blocks, labels).
  const CMP_GREEN = "#4ade80";
  const CMP_RED = "#f87171";

  // The single spelling of the "is this a compare overlay element" tag check
  // used by the cross-fade sweep and the compare teardown.
  const _isCompareTag = (el) => !!(el.dataset && el.dataset.sbgCompare === "1");

  // Sentinel summaries: a failed or still-loading compare metadata fetch is a
  // STATE the compare panel renders rather than an excuse to drop out of compare
  // rendering (which would let the normal panel appear under the split view).
  const _CMP_PENDING = { __cmpPending: true };
  const _CMP_ERROR = { __cmpError: true };

  function openCompareMode() {
    if (_compareActive) { closeCompareMode(); return; }
    const currentItem = items[idx];
    if (!currentItem) return;
    if (items.length < 2) { showToast("Need at least 2 images to compare"); return; }
    _compareActive = true;
    _compareIdx = idx === 0 ? 1 : idx - 1;
    if (_compareIdx < 0 || _compareIdx >= items.length) _compareIdx = 0;
    // Entering compare re-keys the current media from the "single" pane to
    // "left"; clear any single-mode zoom so element and state can't disagree.
    zoomCtl.resetAll();

    compareBtn.textContent = "✕ Exit Compare";
    compareBtn.classList.add("sbg-btn--active");

    // Both halves share one structure: a fixed 50% cell centering a figure
    // that shrink-wraps its image. Every label, filename and arrow anchors to
    // the figure, i.e. to the image itself, so the two sides always line up.
    const leftHalf = h("div", { class: "sbg-compare__half" });
    const leftFig = h("div", { class: "sbg-compare__fig" });
    const leftOverlay = h("div", { class: "sbg-compare__label", text: "CURRENT" });
    const leftFilename = h("div", { class: "sbg-compare__filename", text: currentItem.filename || "" });
    const leftPrevBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--prev sbg-compare__nav", text: "‹", title: `Previous current image${keyCmpCurPrev ? ` (${keyCmpCurPrev})` : ""}` });
    const leftNextBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--next sbg-compare__nav", text: "›", title: `Next current image${keyCmpCurNext ? ` (${keyCmpCurNext})` : ""}` });
    leftPrevBtn.addEventListener("click", (e) => { e.stopPropagation(); goTo(idx - 1); });
    leftNextBtn.addEventListener("click", (e) => { e.stopPropagation(); goTo(idx + 1); });

    const rightHalf = h("div", { class: "sbg-compare__half" });
    const rightFig = h("div", { class: "sbg-compare__fig" });
    const rightImg = h("img", {});
    const rightPrevBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--prev sbg-compare__nav", text: "‹", title: `Previous comparison image${keyPrev ? ` (${keyPrev})` : ""}` });
    const rightNextBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--next sbg-compare__nav", text: "›", title: `Next comparison image${keyNext ? ` (${keyNext})` : ""}` });
    const rightFilename = h("div", { class: "sbg-compare__filename", text: "" });
    // "COMPARED" label, mirroring "CURRENT" at the top-left of its image.
    const rightLabel = h("div", { class: "sbg-compare__label", text: "COMPARED", style: `color:${CMP_RED};` });
    rightPrevBtn.addEventListener("click", (e) => { e.stopPropagation(); _navigateCompare(-1); });
    rightNextBtn.addEventListener("click", (e) => { e.stopPropagation(); _navigateCompare(1); });

    const divider = h("div", { class: "sbg-compare__divider" });

    // Tag the left figure's overlays so goTo()'s media cross-fade sweep
    // (which runs inside that figure during compare) leaves them alone. The
    // right figure and the container-level elements are never swept.
    for (const el of [leftOverlay, leftFilename]) {
      el.dataset.sbgCompare = "1";
    }

    // Labels/filenames anchor to the figure (on the image); the arrows anchor
    // to the HALF, so each pair sits at its half's outer edges: screen edge,
    // divider, divider, metadata panel.
    rightFig.append(rightImg, rightLabel, rightFilename);
    rightHalf.append(rightFig, rightPrevBtn, rightNextBtn);
    leftFig.append(leftOverlay, leftFilename);

    mediaContainer.classList.add("sbg-compare--active");
    mediaArea.classList.add("sbg-lb__media-area--compare");
    // Adopt the current media (and any in-flight cross-fade element) into the
    // left figure before assembling the split view.
    while (mediaContainer.firstChild) leftFig.appendChild(mediaContainer.firstChild);
    leftHalf.append(leftFig, leftPrevBtn, leftNextBtn);
    mediaContainer.append(leftHalf, divider, rightHalf);

    _compareElements = {
      leftHalf, leftFig, divider, rightHalf, rightMedia: rightImg,
      leftOverlay, leftFilename, leftPrevBtn, leftNextBtn,
      rightPrevBtn, rightNextBtn, rightFilename,
    };
    _loadCompareImage();
  }

  function closeCompareMode() {
    if (!_compareActive) return;
    // Reset while _compareActive is still true: the controller's compare
    // getter is gated on the flag, and resetAll must still see the halves to
    // clear the right media's transform before the teardown below.
    zoomCtl.resetAll();
    _compareActive = false;
    _compareSummary = null;
    _cmpGen++; // invalidate any in-flight compare metadata fetch
    compareBtn.textContent = "⚖ Compare";
    compareBtn.classList.remove("sbg-btn--active");
    if (_compareElements) {
      releaseVideo(_compareElements.rightMedia);
      // Hand the current media (incl. any pending cross-fade element) back to
      // the media container before tearing the split view down.
      for (const child of [..._compareElements.leftFig.children]) {
        if (!_isCompareTag(child)) mediaContainer.appendChild(child);
      }
      _compareElements.leftHalf.remove();
      _compareElements.divider.remove();
      _compareElements.rightHalf.remove();
      _compareElements = null;
    }
    mediaContainer.classList.remove("sbg-compare--active");
    mediaArea.classList.remove("sbg-lb__media-area--compare");
    if (meta && !destroyed) renderMeta(meta);
  }

  function _navigateCompare(dir) {
    if (!_compareActive) return;
    _compareIdx = nextCompareIdx(_compareIdx, dir, idx, items.length);
    _loadCompareImage();
  }

  // Refresh the overlays that depend on idx/_compareIdx: both filename chips
  // and the left figure's arrow visibility. Called from _loadCompareImage,
  // goTo (left nav) and _onItemsUpdated.
  function _updateCompareLabels() {
    if (!_compareActive || !_compareElements) return;
    _compareElements.leftFilename.textContent = items[idx]?.filename || "";
    _compareElements.rightFilename.textContent = items[_compareIdx]?.filename || "";
    // The left figure's arrows mirror the main nav's at-the-ends hiding.
    _compareElements.leftPrevBtn.style.visibility = idx === 0 ? "hidden" : "visible";
    _compareElements.leftNextBtn.style.visibility = idx === items.length - 1 ? "hidden" : "visible";
  }

  function _loadCompareImage() {
    if (!_compareActive || !_compareElements) return;
    const compItem = items[_compareIdx];
    if (!compItem) return;
    // Compare nav resets the RIGHT pane (the element being replaced); the
    // left pane's zoom survives in independent mode so a detail pinned on
    // the current image can be compared across candidates. Synced mode keeps
    // both panes in lockstep, so both reset. "Keep Zoom While Browsing"
    // skips the reset; _clearPending below re-clamps the preserved state
    // for the incoming image's dimensions instead.
    if (!zoomSettings.keepOnNav) {
      if (zoomSettings.compareZoom === "synced") zoomCtl.resetAll();
      else zoomCtl.resetPane("right");
    }
    // The compared item can be a video too, so swap the element type rather than
    // stuffing a video URL into an <img> (which renders a broken-thumbnail icon).
    const wantVideo = isVideo(compItem);
    let mediaEl = _compareElements.rightMedia;
    if (wantVideo !== (mediaEl.tagName === "VIDEO")) {
      const neu = wantVideo
        ? h("video", { loop: "", autoplay: "", controls: "", playsinline: "" })
        : h("img", {});
      if (wantVideo) neu.muted = true; // required for autoplay
      releaseVideo(mediaEl); // release the outgoing video's decoder before discarding it
      mediaEl.replaceWith(neu);
      _compareElements.rightMedia = neu;
      mediaEl = neu;
    }
    // Tag the right media pending while the new file loads, mirroring the
    // left pane's cross-fade contract: the zoom controller refuses to zoom
    // pending media, so a mid-load zoom can't compute its bounds from the
    // OLD image and land on the new one.
    mediaEl.dataset.sbgPending = "1";
    const _clearPending = () => {
      if (mediaEl.dataset) delete mediaEl.dataset.sbgPending;
      // Keep Zoom While Browsing: same element, new image. Re-clamp the
      // preserved pan against the new dimensions once they're known.
      if (zoomSettings.keepOnNav) zoomCtl.reapply("right");
    };
    if (mediaEl.tagName === "VIDEO") {
      mediaEl.onloadeddata = _clearPending;
      mediaEl.oncanplay = _clearPending;
      mediaEl.onerror = _clearPending;
    } else {
      mediaEl.onload = _clearPending;
      mediaEl.onerror = _clearPending;
    }
    mediaEl.src = fileUrl(compItem);
    // Already buffered (revisit / cached): clear synchronously.
    if (mediaEl.tagName === "VIDEO" ? mediaEl.readyState >= 2 : mediaEl.complete) _clearPending();
    _updateCompareLabels();

    // Generation guard: fast navigation can leave several fetches in flight,
    // and an older response landing last must not overwrite the newer diff.
    // Bumped on every navigation (cache hits too) so any in-flight fetch for a
    // previous compare target is invalidated.
    const gen = ++_cmpGen;
    const l1 = _metaCache.get(itemKey(compItem));
    if (_freshMeta(l1, compItem.mtime_real ?? compItem.mtime) && l1.summary) {
      _renderComparePanel(l1.summary);
    } else {
      // Mark the panel pending immediately, or a re-render arriving before
      // the fetch (left nav, layout change) would diff the NEW compared file's
      // header against the PREVIOUS one's parameter values.
      _renderComparePanel(_CMP_PENDING);
      _getSummaryMeta(compItem)
        .then((m2) => {
          if (_compareActive && _cmpGen === gen) _renderComparePanel(m2?.summary || {});
        })
        .catch(() => {
          if (_compareActive && _cmpGen === gen) _renderComparePanel(_CMP_ERROR);
        });
    }
  }

  // Shared header for both compare views: which file, plus a colour legend.
  function _compareHeader(withDiffLegend) {
    const compItem = items[_compareIdx];
    const header = h("div", { class: "sbg-compare-header" });
    header.appendChild(h("div", { class: "sbg-compare-header__title", text: `⚖ Comparing: ${compItem?.filename || "?"}` }));
    const legend = h("div", { class: "sbg-compare-header__legend" });
    if (withDiffLegend) {
      legend.appendChild(h("span", { text: "■ Same", style: "color:rgba(255,255,255,0.4)" }));
      legend.appendChild(h("span", { text: "■ Changed", style: "color:#facc15;font-weight:700" }));
    }
    legend.appendChild(h("span", { text: withDiffLegend ? "■ Current only" : "■ Current", style: `color:${CMP_GREEN};font-weight:700` }));
    legend.appendChild(h("span", { text: withDiffLegend ? "■ Compared only" : "■ Compared", style: `color:${CMP_RED};font-weight:700` }));
    header.appendChild(legend);
    return header;
  }

  // The one writer for the metadata panel while compare is active: routes to
  // the view matching the active tab (so navigating the comparison while on
  // the Initial Image tab refreshes that view instead of yanking the user
  // back to Generated), renders pending/error states, and owns the tab bar.
  function _renderComparePanel(compareSummary) {
    // Store before the meta guard: if the current item's metadata is still
    // loading, renderMeta's compare branch re-invokes this once it arrives.
    _compareSummary = compareSummary;
    if (!meta) return;

    // Transitional states replace the whole panel regardless of tab; tab-bar
    // state is left untouched so it doesn't flicker while a fetch resolves.
    if (compareSummary && (compareSummary.__cmpPending || compareSummary.__cmpError)) {
      metaBody.innerHTML = "";
      metaBody.appendChild(_compareHeader(false));
      metaBody.appendChild(h("div", {
        class: "sbg-lb__loading" + (compareSummary.__cmpPending ? " sbg-loading" : ""),
        text: compareSummary.__cmpPending ? "Loading comparison metadata…" : "Comparison metadata unavailable",
      }));
      return;
    }

    // Tab-bar ownership: show it when either side has initial image data,
    // hide it (and fall back to the Generated diff) when neither does, so
    // compare navigation can't strand the user on a stale or invisible tab.
    const curS = meta.summary || {};
    const showTabs = !!(initialImageList(curS).length || initialImageList(compareSummary).length);
    _metaTabs.style.display = showTabs ? "" : "none";
    if (!showTabs && _activeMetaTab === "initial") {
      _activeMetaTab = "generated";
      _tabGenerated.classList.add("sbg-lb__meta-tab--active");
      _tabInitialImage.classList.remove("sbg-lb__meta-tab--active");
    }
    if (_activeMetaTab === "initial") _showCompInitial();
    else _showCompDiff(compareSummary);
  }

  // Coloured "▎Current"/"▎Compared" side block used by both compare views;
  // the caller appends the side's content into the returned wrap.
  function _sideBlock(label, color) {
    const wrap = h("div", { style: `padding:6px 8px;border-left:3px solid ${color};margin:4px 0;` });
    wrap.appendChild(h("div", { style: `font-size:9px;font-weight:700;color:${color};margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;`, text: `▎${label}` }));
    return wrap;
  }
  const _hairline = () => h("div", { style: "height:1px;background:rgba(255,255,255,0.08);margin:2px 8px;" });

  // Initial Image tab while comparing: both sides' source images, stacked.
  function _showCompInitial() {
    if (!meta) return;
    const curS = meta.summary || {};
    const cmpS = _compareSummary || {};
    metaBody.innerHTML = "";
    metaBody.appendChild(_compareHeader(false));

    const note = (text) => h("div", { style: "font-size:10px;opacity:0.5;padding:4px 0;", text });
    const block = (label, color, s, rootId) => {
      const wrap = _sideBlock(label, color);
      if (initialImageList(s).length) wrap.appendChild(_getInitialContent(s, rootId));
      else wrap.appendChild(note("No initial image data"));
      return wrap;
    };
    // When both sides resolve to the same source-image set, say "same"
    // explicitly instead of rendering the identical blocks twice, because that
    // IS the answer the user is comparing for (blocks are built fresh per side
    // now, so this is purely a UX choice with no DOM constraint behind it).
    const sameSource = initialImageList(curS).length && initialImageList(cmpS).length
      && _initialContentKey(curS, items[idx]?.root_id) === _initialContentKey(cmpS, items[_compareIdx]?.root_id);
    metaBody.appendChild(block("Current", CMP_GREEN, curS, items[idx]?.root_id));
    metaBody.appendChild(_hairline());
    if (sameSource) {
      const wrap = _sideBlock("Compared", CMP_RED);
      wrap.appendChild(note("Same source image as the current side"));
      metaBody.appendChild(wrap);
    } else {
      metaBody.appendChild(block("Compared", CMP_RED, cmpS, items[_compareIdx]?.root_id));
    }
  }

  function _showCompDiff(compareSummary) {
    if (!meta) return;
    const currentSummary = meta.summary || {};
    const compItem = items[_compareIdx];

    // Profile + merged summaries for the engine-based comparison.
    const _isVidCmp = items[idx] ? isVideo(items[idx]) : false;
    const _cmpApp = currentSummary.source_app || compareSummary.source_app || "comfyui";
    const _cmpProfile = TL.getActiveProfile(_cmpApp, _isVidCmp);
    // Use the gallery item for file-level fields, like renderMeta: the
    // /metadata file object lacks `filename`, which would otherwise force a
    // permanent one-sided File Info diff.
    const _curMerged = _mergeFileInfo(currentSummary, (items && items[idx]) || (meta && meta.file));
    const _cmpMerged = _mergeFileInfo(compareSummary, compItem);

    // Signature of a section's resolved values, used to detect per-section diffs.
    // Delegates to the shared engine so the diff can never drift from what
    // renderSection actually shows, including tabbed sections (prompts) and
    // source-prefixed card fields (samplers/loras).
    const _sig = (section, summary) => {
      try { return TL.sectionSignature(section, summary); }
      catch (e) {
        // Fail visible (unique string means the section reads DIFF) but never
        // silent, so a resolver bug is diagnosable rather than randomizing badges.
        console.warn("[SBG] sectionSignature failed for", section && section.id, e);
        return Math.random().toString();
      }
    };

    metaBody.innerHTML = "";
    metaBody.appendChild(_compareHeader(true));

    // Render each profile section, comparing current vs compared.
    for (const section of _cmpProfile) {
      if (!section || !section.title || section.style === "raw") continue;
      if (section.hidden) continue;  // hidden via the layout-editor eye toggle

      const hasCurrent = TL.sectionHasData(section, _curMerged);
      const hasCompare = TL.sectionHasData(section, _cmpMerged);
      if (!hasCurrent && !hasCompare) continue;

      const hasDiff = _sig(section, _curMerged) !== _sig(section, _cmpMerged);

      const borderColor = hasDiff ? "rgba(250,204,21,0.6)" : "rgba(255,255,255,0.06)";
      const bgColor = hasDiff ? "rgba(250,204,21,0.04)" : "transparent";
      const sectionWrap = h("div", {
        style: `border:1px solid ${borderColor};border-radius:8px;margin-bottom:6px;background:${bgColor};overflow:hidden;`
      });

      const sectionHeader = h("div", {
        style: "display:flex;align-items:center;padding:6px 10px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.06);cursor:default;"
      });
      sectionHeader.appendChild(h("span", { style: "font-weight:600;font-size:11.5px;", text: section.title }));
      sectionHeader.appendChild(hasDiff
        ? h("span", { text: "DIFF", style: "margin-left:8px;font-size:9px;font-weight:700;background:#facc15;color:#000;padding:1px 6px;border-radius:3px;" })
        : h("span", { text: "SAME", style: "margin-left:8px;font-size:9px;color:rgba(255,255,255,0.3);" }));
      sectionWrap.appendChild(sectionHeader);

      if (hasDiff && hasCurrent && hasCompare) {
        // Stacked: Current on top, Compared below (panel is too narrow for side-by-side)
        const stack = h("div", { style: "display:flex;flex-direction:column;gap:0;" });
        const topBlock = _sideBlock("Current", CMP_GREEN);
        const tc = TL.renderSection(section, _curMerged, {}); if (tc) topBlock.appendChild(tc);
        stack.appendChild(topBlock);
        stack.appendChild(_hairline());
        const bottomBlock = _sideBlock("Compared", CMP_RED);
        const bc = TL.renderSection(section, _cmpMerged, {}); if (bc) bottomBlock.appendChild(bc);
        stack.appendChild(bottomBlock);
        sectionWrap.appendChild(stack);
      } else if (hasCurrent && hasCompare) {
        // Identical section: single column, collapsed by default
        const wrapper = h("div", { style: "padding:6px 8px;display:none;" });
        const sc = TL.renderSection(section, _curMerged, {}); if (sc) wrapper.appendChild(sc);
        sectionWrap.appendChild(wrapper);
        sectionHeader.style.cursor = "pointer";
        sectionHeader.addEventListener("click", () => {
          wrapper.style.display = wrapper.style.display === "none" ? "block" : "none";
        });
      } else {
        const single = hasCurrent ? TL.renderSection(section, _curMerged, {}) : TL.renderSection(section, _cmpMerged, {});
        if (single) {
          const wrapper = hasCurrent
            ? _sideBlock("Current only", CMP_GREEN)
            : _sideBlock("Compared only", CMP_RED);
          wrapper.appendChild(single);
          sectionWrap.appendChild(wrapper);
        }
      }

      metaBody.appendChild(sectionWrap);
    }
  }

  compareBtn.addEventListener("click", openCompareMode);

  goTo(idx);
}