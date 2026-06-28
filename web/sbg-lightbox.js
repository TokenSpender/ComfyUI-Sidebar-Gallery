/**
 * sbg-lightbox.js \u2014 Lightbox module
 *
 * Full-screen image/video viewer with metadata panel, compare mode,
 * keyboard navigation, section ordering, and search highlighting.
 * Extracted from the monolith as a standalone module.
 */

import { app } from "../../scripts/app.js";

import {
  ensureCss, h, api, fmtBytes, pj,
  showToast, copyText, fileUrl, isVideo,
  _metaCache, _metaCacheAPI, _mediaState,
  _thumbCacheAPI,
  searchState, highlightSearchMatches,
  S, getSetting, getLayout,
} from "./sbg-core.js";

import * as TL from "./sbg-translation-layer.js";

// Fully release a <video>'s decoder. Removing the element from the DOM is NOT
// enough: the browser keeps the (hardware) decoder alive until garbage
// collection, and Firefox-on-Windows has a tiny H.265/HEVC decoder pool. A few
// un-released video elements exhaust it, after which every subsequent H.265 clip
// fails with "could not be decoded" / NS_ERROR_DOM_MEDIA_NOT_SUPPORTED_ERR
// (H.264 has a software fallback, so it keeps playing; a page refresh frees them
// all). Clearing src + load() drops the decoder immediately. This is the same
// release the nav swap does; the close/compare paths previously only paused,
// which leaked a decoder on every lightbox close.
function releaseVideo(el) {
  if (!el || el.tagName !== "VIDEO") return;
  try { el.pause(); el.removeAttribute("src"); el.load(); } catch { }
}

// Resolve a source/initial image's summary metadata, cached so navigating
// between items that share a source image (or revisiting one) doesn't re-fetch
// it on every navigation. Probes the current root, then ComfyUI's "input" root,
// then the on-demand input/output/temp endpoint; a miss is cached (as null) so a
// missing source image isn't re-probed every time.
async function _resolveInitMeta(imgPath, curRoot) {
  // Key includes the starting root: two items can reference different source
  // images that share a relpath under different roots.
  const ck = "initmeta:" + (curRoot || "") + ":" + imgPath;
  const l1 = _metaCache.get(ck);
  if (l1) return l1;                           // cached hit (misses are NOT cached)
  try {
    const l2 = await _metaCacheAPI.get(ck);
    if (l2) { _metaCache.set(ck, l2); return l2; }
  } catch { }
  for (const rootId of [curRoot, "input"].filter(Boolean)) {
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
    for (const _t of ["input", "output", "temp"]) {
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

export function openLightbox(_initialItems, startItemOrIndex) {
  ensureCss();
  let items = _initialItems; // let so sbg-items-updated can reassign
  let idx = typeof startItemOrIndex === "number" ? startItemOrIndex : items.indexOf(startItemOrIndex);
  // The gallery card closes over the item object from when it was rendered; a
  // background refresh (e.g. after a reindex) can replace the items array with
  // NEW objects for the same files, so indexOf() fails. Match by the stable
  // identity key so a click still opens the clicked item, not item #0.
  if (idx < 0 && startItemOrIndex && typeof startItemOrIndex === "object") {
    idx = items.findIndex(it => it && it.root_id === startItemOrIndex.root_id
                                && it.relpath === startItemOrIndex.relpath);
  }
  if (idx < 0) idx = 0;
  let meta = null;
  let destroyed = false;
  let currentMediaEl = null;

  // Defaults must match what the Keybindings settings tab displays
  // ("ArrowLeft,a" / "ArrowRight,d" — A/D navigate out of the box).
  const keyPrev = getSetting(S.KEY_PREV, "ArrowLeft,a");
  const keyNext = getSetting(S.KEY_NEXT, "ArrowRight,d");
  const keyClose = getSetting(S.KEY_CLOSE, "Escape");
  const keyFullscreen = getSetting(S.KEY_FULLSCREEN, "f");
  const keyDownload = getSetting(S.KEY_DOWNLOAD, "");
  const keyCopyPrompt = getSetting(S.KEY_COPY_PROMPT, "");
  const keyCopyWf = getSetting(S.KEY_COPY_WF, "");
  const keyLoadWf = getSetting(S.KEY_LOAD_WF, "");



  /* ── Build DOM ──────────────────────────────────────────────── */

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
  // Feature 6: Compare button
  const compareBtn = h("button", { class: "sbg-btn sbg-btn--sm", text: "⚖ Compare", title: "Compare with another image (C)" });

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

  // Feature 4: Tab bar for Generated / Initial Image
  // Tabs are hidden by default and only shown when initial_image data exists
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
  let _initialImageContent = null;  // cached DOM for initial image tab
  let _activeMetaTab = "generated"; // "generated" or "initial"

  function _switchMetaTab(tab) {
    _activeMetaTab = tab;
    _tabGenerated.classList.toggle("sbg-lb__meta-tab--active", tab === "generated");
    _tabInitialImage.classList.toggle("sbg-lb__meta-tab--active", tab === "initial");
    metaBody.innerHTML = "";
    if (tab === "generated") {
      // If compare mode is active, re-render the compare diff
      if (_compareActive && _compareSummary) {
        _showCompDiff(_compareSummary);
      } else if (_generatedMetaContent) {
        metaBody.appendChild(_generatedMetaContent);
      }
    } else if (tab === "initial" && _initialImageContent) {
      metaBody.appendChild(_initialImageContent);
    }
    // Cached tab content was sized while detached/hidden (scrollHeight 0 → boxes
    // collapsed to one line). Re-measure prompt boxes now that they're visible.
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
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  const overlay = h("div", { class: "sbg-lightbox" }, [mediaArea, metaPanel]);
  document.body.appendChild(overlay);

  // Re-render metadata when layout changes (B008: live preview of style changes)
  const _onLayoutChanged = () => { if (meta && !destroyed) renderMeta(meta); };
  document.addEventListener("sbg-layout-changed", _onLayoutChanged);

  /* ── Section builder ────────────────────────────────────────── */

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

  /** Sort metaBody children by saved order — uses layout config if available */
  /* ── Render metadata ────────────────────────────────────────── */

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

    // Reset tab state — preserve active tab if user enabled tab persistence
    _generatedMetaContent = null;
    _initialImageContent = null;
    const tabPersist = getSetting(S.META_TAB_PERSIST, false);
    if (!tabPersist) {
      _activeMetaTab = "generated";
      _tabGenerated.classList.add("sbg-lb__meta-tab--active");
      _tabInitialImage.classList.remove("sbg-lb__meta-tab--active");
    }
    _metaTabs.style.display = "none"; // hide entire tab bar until initial_image found

    if (!m) {
      metaBody.appendChild(h("div", { class: "sbg-lb__loading", text: "No metadata" }));
      return;
    }

    const s = m.summary || {};
    const _ly = getLayout();

    /* ── Helper: key-value pill row ─────────────────────────── */
    function kvRow(label, value) {
      if (value === undefined || value === null || value === "") return null;
      const _lyRenames = _ly.renames || {};
      const _lbl = label == null ? "" : String(label);
      const displayLabel = _lyRenames[_lbl] || _lyRenames[_lbl.toLowerCase()] || _lbl;
      const row = h("div", { class: "sbg-meta-row" });
      if (String(displayLabel).trim() !== "") {
        row.appendChild(h("span", { class: "sbg-meta-label", text: displayLabel }));
      } else {
        row.classList.add("sbg-meta-row--nolabel");
      }
      row.appendChild(h("span", { class: "sbg-meta-value", text: String(value) }));
      return row;
    }

    // ── Source App Badge (in METADATA header) ─────────────────
    const _appLabels = { comfyui: "ComfyUI", a1111: "A1111", forge: "Forge", sdnext: "SD.Next", fooocus: "Fooocus" };
    // App badge color settings map
    const _appColorKeys = {
      comfyui: S.APP_BADGE_COMFYUI,
      a1111: S.APP_BADGE_A1111,
      forge: S.APP_BADGE_FORGE,
      sdnext: S.APP_BADGE_SDNEXT,
      fooocus: S.APP_BADGE_FOOOCUS,
    };
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

    // ── Translation-layer rendering (single source of truth) ──
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
      const contentEl = TL.renderSection(section, _merged, { searchQuery: searchState.query, rawData, profileKey: TL.profileKey(_app, _isVid) });
      if (!contentEl) continue;
      metaBody.appendChild(makeSection(section, contentEl));
    }
    if (s.positive_prompt) copyPromptBtn.disabled = false;

    // ── Search highlighting in metadata panel ──────────────────────
    // Highlight each searched VALUE wherever it appears in the panel. searchState.query
    // holds values only (field prefixes like "adetailer:" never reach here), so a
    // field-scoped search like "adetailer:denoising" highlights "denoising". An earlier
    // attempt to scope highlights to a section via [data-section-id] matched nothing —
    // the renderer never stamps that attribute — so field-scoped searches highlighted
    // nothing at all. Panel-wide highlighting is correct and only trivially over-broad.
    if (searchState.query) {
      const queries = searchState.query.split("\x00").filter(Boolean);
      for (const q of queries) highlightSearchMatches(metaBody, q);
    }

    // ── Workflow buttons ─────────────────────────────────────────
    if (s.has_workflow) {
      loadWfBtn.disabled = false;
      copyWfBtn.disabled = false;
    }

    // ── Cache generated content for tab switching ─────────────────
    _generatedMetaContent = h("div", {});
    while (metaBody.firstChild) _generatedMetaContent.appendChild(metaBody.firstChild);
    metaBody.appendChild(_generatedMetaContent);

    // ── Feature 4: Initial Image tab ─────────────────────────────
    if (s.initial_image) {
      _metaTabs.style.display = ""; // show tab bar when initial_image exists
      // Build initial image tab content
      const initWrap = h("div", { class: "sbg-meta-group", style: "padding:8px" });

      // Show the initial image name
      const imgName = typeof s.initial_image === "string" ? s.initial_image : (s.initial_image.filename || "Unknown");
      initWrap.appendChild(h("div", { style: "font-size:12px;font-weight:600;color:var(--sbg-text);margin-bottom:6px", text: "Source Image" }));

      // Try to show a thumbnail preview via ComfyUI's /view endpoint
      const imgPath = typeof s.initial_image === "string" ? s.initial_image : (s.initial_image.path || s.initial_image.filename || "");
      if (imgPath) {
        // ComfyUI /view endpoint expects filename=<subpath>&type=input for input images
        // Also try subfolder format: filename=basename&subfolder=dir&type=input
        const parts = imgPath.replace(/\\/g, "/").split("/");
        const basename = parts.pop();
        const subfolder = parts.join("/");
        const viewUrl = (type) => subfolder
          ? `/view?filename=${encodeURIComponent(basename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
          : `/view?filename=${encodeURIComponent(basename)}&type=${type}`;
        const img = h("img", { class: "sbg-initial-image-preview" });
        // The reference/initial image can live in input, output, or temp — not
        // just input. Try each in turn before giving up (fixes reference images
        // that were themselves previous generations in the output folder).
        const _viewTypes = ["input", "output", "temp"];
        let _vt = 0;
        const _tryNextView = () => {
          if (_vt >= _viewTypes.length) { img.style.display = "none"; return; }
          img.src = viewUrl(_viewTypes[_vt++]);
        };
        img.onerror = _tryNextView;
        _tryNextView();
        initWrap.appendChild(img);
      }

      // File info
      const infoGroup = h("div", { class: "sbg-meta-group" });
      const nameRow = kvRow("Filename", imgName);
      if (nameRow) infoGroup.appendChild(nameRow);
      initWrap.appendChild(infoGroup);

      // Try to load the initial image's own metadata from any indexed root
      if (imgPath) {
        const metaNote = h("div", { class: "sbg-lb__loading sbg-loading", text: "Loading initial image metadata…", style: "font-size:10px;padding:8px" });
        initWrap.appendChild(metaNote);
        (async () => {
          const m = await _resolveInitMeta(imgPath, items[idx]?.root_id);
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

      _initialImageContent = initWrap;

      // If tab persistence is on and user was on the initial tab, switch back to it
      if (tabPersist && _activeMetaTab === "initial") {
        _switchMetaTab("initial");
      }
    }
  }


  // (Search highlighting uses highlightSearchMatches from sbg-core.js — the
  // identical local copy that used to live here was removed.)

  /* ── Navigate ───────────────────────────────────────────────── */

  let _navGen = 0; // generation counter: prevents stale metadata overwrites
  const metaCache = _metaCache; // use module-level cache

  function goTo(newIdx) {
    if (newIdx < 0 || newIdx >= items.length) return;
    idx = newIdx;
    _navGen++;
    const gen = _navGen;
    const it = items[idx];

    // ── Cross-fade media swap (images only) ───────────────────────
    // Keep the previous frame visible until the NEW media can paint, so there's
    // no blank flash — but ONLY for images. A <video> kept alive as a backdrop
    // holds its decoder, and Firefox-on-Windows has a tiny H.265/HEVC decoder
    // pool that is also shared with ComfyUI's own canvas video previews. The old
    // cross-fade paused the outgoing video and released it only AFTER the new clip
    // loaded, so two HEVC decoders were live at once during every swap. Combined
    // with the canvas previews (e.g. after a workflow switch), that intermittently
    // exhausted the pool and the next clip failed with "could not be decoded"
    // (H.264 has a software fallback, so it kept working; a refresh frees them).
    // So release any outgoing VIDEO's decoder UP FRONT; images cost no decoder and
    // still stay as a no-flash backdrop. This also drops any still-pending
    // (un-revealed) media from a previous fast nav (the "freeze on fast browsing"
    // bug) so half-loaded <video>s don't pile up.
    for (const child of [...mediaContainer.children]) {
      if (child.tagName === "VIDEO" || (child.dataset && child.dataset.sbgPending === "1")) {
        releaseVideo(child);
        child.remove();
      }
    }
    const prevChildren = [...mediaContainer.children];
    mediaContainer.style.position = "relative";

    let swapped = false;
    const _swapIn = (neu) => {
      if (swapped || destroyed || _navGen !== gen) return; // stale or already done
      swapped = true;
      if (neu.dataset) delete neu.dataset.sbgPending;
      neu.style.position = "";
      neu.style.opacity = "";
      mediaContainer.style.position = "";
      for (const old of prevChildren) {
        if (old.parentNode !== mediaContainer) continue;
        releaseVideo(old);
        old.remove();
      }
    };

    if (isVideo(it)) {
      // preload="metadata" (not "auto"): "auto" eagerly buffers/decodes the whole
      // clip the moment its src is set, keeping the HEVC decoder engaged longer
      // than needed. autoplay still plays it; this just trims decoder/IO pressure.
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
      // Retry a few times (file may still be flushing to disk right after
      // generation) but give up after that — an unbounded retry loop would
      // hammer the server forever on a permanently broken file. On final give-up,
      // still swap in so the stale backdrop doesn't linger over a broken file.
      // Recover from a failed load. A decode / "format not supported" error on
      // these files is almost always TRANSIENT: the browser briefly couldn't get
      // one of the few HEVC hardware decoders (which are shared with ComfyUI's own
      // canvas video previews). So fully reset the element and re-request a decoder
      // a handful of times with backoff before giving up and revealing the broken
      // box. The bytes are already cached (immutable /file URL), so retrying only
      // re-acquires a decoder — it does not re-download.
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
      mediaContainer.appendChild(video);
      video.src = fileUrl(it);
      if (video.readyState >= 2) _swapIn(video); // already buffered (revisit)
    } else {
      const img = h("img", { class: "sbg-lb__img" });
      img.dataset.sbgPending = "1";
      img.style.position = "absolute";
      img.style.opacity = "0";
      img.onload = () => _swapIn(img);
      img.onerror = () => _swapIn(img); // still swap on error
      currentMediaEl = img;
      mediaContainer.appendChild(img);
      img.src = fileUrl(it);
      if (img.complete) _swapIn(img); // synchronously cached
    }

    bottomName.textContent = `${it.filename}  (${idx + 1} / ${items.length})`;
    dlBtn.href = fileUrl(it);
    dlBtn.download = it.filename || "";
    prevBtn.style.visibility = idx === 0 ? "hidden" : "visible";
    nextBtn.style.visibility = idx === items.length - 1 ? "hidden" : "visible";

    // ── Metadata: use cache or fetch summary from DB ────────────
    const cacheKey = `${it.root_id}:${it.relpath}`;
    const cached = metaCache.get(cacheKey);
    // Validate against the file's real MODIFICATION time. it.mtime is the gallery
    // sort key (creation time), so comparing the cached mtime against it marked
    // every file whose ctime != mtime (copied/imported/re-saved files) permanently
    // stale, re-fetching metadata on every visit. it.mtime_real is the true mtime,
    // matching cached.file.mtime returned by /metadata.
    const _itMtime = it.mtime_real ?? it.mtime;
    const l1Stale = cached && _itMtime && cached.file?.mtime && cached.file.mtime < _itMtime;
    // B044: Save scroll position before any metadata content change
    const savedScroll = metaPanel.scrollTop;
    if (cached && !l1Stale) {
      renderMeta(cached);
      requestAnimationFrame(() => { metaPanel.scrollTop = savedScroll; });
    } else {
      // L2: check IndexedDB persistent cache
      metaBody.innerHTML = "";
      metaBody.appendChild(h("div", { class: "sbg-lb__loading sbg-loading", text: "Loading metadata…" }));

      _metaCacheAPI.get(cacheKey).then(idbCached => {
        // Validate IDB cache: reject if file was modified since cache was stored
        const idbStale = idbCached && _itMtime && idbCached.file?.mtime && idbCached.file.mtime < _itMtime;
        if (idbCached && !idbStale && !destroyed && _navGen === gen) {
          metaCache.set(cacheKey, idbCached);
          renderMeta(idbCached);
          requestAnimationFrame(() => { metaPanel.scrollTop = savedScroll; });
          return;
        }
        // L3: network fallback
        return api("/sidebar_gallery/metadata", { root_id: it.root_id, relpath: it.relpath, summary_only: "1" })
          .then((m) => {
            metaCache.set(cacheKey, m);
            _metaCacheAPI.put(cacheKey, m);
            if (!destroyed && _navGen === gen) {
              renderMeta(m);
              requestAnimationFrame(() => { metaPanel.scrollTop = savedScroll; });
            }
          });
      }).catch((e) => {
        if (!destroyed && _navGen === gen) {
          metaBody.innerHTML = "";
          metaBody.appendChild(h("div", { class: "sbg-lb__loading", text: `Error: ${e?.message || e}` }));
        }
      });
    }

    // ── Debounced prefetch: only when user settles (300ms) ──────
    clearTimeout(_prefetchTimer);
    _prefetchTimer = setTimeout(() => {
      if (destroyed || _navGen !== gen) return;
      for (const di of [-1, 1]) {
        const ni = idx + di;
        if (ni < 0 || ni >= items.length) continue;
        const adj = items[ni];

        const adjKey = `${adj.root_id}:${adj.relpath}`;
        if (!metaCache.has(adjKey)) {
          api("/sidebar_gallery/metadata", { root_id: adj.root_id, relpath: adj.relpath, summary_only: "1" })
            .then((m) => metaCache.set(adjKey, m))
            .catch(() => { });
        }

        // Only prefetch IMAGES. Prefetching a video would download the whole file
        // (preload=auto) for a neighbour the user may never open; revisits of an
        // already-viewed video are covered by /file's immutable caching instead.
        if (!isVideo(adj)) {
          const pre = new Image();
          pre.src = fileUrl(adj);
        }
      }
    }, 300);
  }

  /* ── Events ─────────────────────────────────────────────────── */

  // Feature 8: Listen for new items so lightbox can navigate to newly generated images
  function _onItemsUpdated(e) {
    if (destroyed) return;
    const newItems = e.detail?.items;
    if (!newItems || !Array.isArray(newItems)) return;
    // Find the current item by relpath to maintain position
    const currentItem = items[idx];
    const currentKey = currentItem ? `${currentItem.root_id}:${currentItem.relpath}` : null;
    items = newItems;
    // Re-find our position in the new array
    if (currentKey) {
      const newIdx = items.findIndex(it => `${it.root_id}:${it.relpath}` === currentKey);
      if (newIdx >= 0) idx = newIdx;
    }
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
    // Release the decoder, not just pause it — a bare pause() here leaked an
    // HEVC decoder on every lightbox close (see releaseVideo()).
    releaseVideo(currentMediaEl);
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("sbg-items-updated", _onItemsUpdated);
    document.removeEventListener("sbg-layout-changed", _onLayoutChanged);
  }

  function matchKey(e, boundKey) {
    if (!boundKey) return false;
    // Case-insensitive comparison (supports Caps Lock)
    const pressed = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return String(boundKey).split(",").map(k => k.trim()).some(k => {
      const bound = k.length === 1 ? k.toLowerCase() : k;
      return pressed === bound;
    });
  }

  let _prefetchTimer = null;

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

    if (matchKey(e, keyClose)) {
      if (document.fullscreenElement) { document.exitFullscreen(); e.preventDefault(); return; }
      // Close compare mode first, then lightbox
      if (_compareActive) { closeCompareMode(); e.preventDefault(); return; }
      destroy(); e.preventDefault();
    }
    else if (matchKey(e, keyFullscreen)) {
      // Only toggle fullscreen if no modifier keys are held (e.g., CTRL+F should not trigger)
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else overlay.requestFullscreen?.().catch(() => { });
      e.preventDefault();
    }
    else if (e.key === "c" || e.key === "C") {
      // Toggle comparison mode (no modifiers)
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      openCompareMode();
      e.preventDefault();
    }
    // Optional action keys (configured in Keybindings; empty = disabled)
    else if (matchKey(e, keyDownload)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      dlBtn.click();
      e.preventDefault();
    }
    else if (matchKey(e, keyCopyPrompt)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!copyPromptBtn.disabled) copyPromptBtn.click();
      e.preventDefault();
    }
    else if (matchKey(e, keyCopyWf)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!copyWfBtn.disabled) copyWfBtn.click();
      e.preventDefault();
    }
    else if (matchKey(e, keyLoadWf)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!loadWfBtn.disabled) loadWfBtn.click();
      e.preventDefault();
    }
    else if (matchKey(e, keyPrev) || matchKey(e, keyNext)) {
      // Block if modifier keys are held (unless the binding explicitly includes them)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // In compare mode: navigate comparison images
      if (_compareActive) {
        _navigateCompare(matchKey(e, keyPrev) ? -1 : 1);
        e.preventDefault();
        return;
      }
      const isFS = !!document.fullscreenElement;
      const isVid = currentMediaEl && currentMediaEl.tagName === "VIDEO";
      const isArrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
      if (isFS && isVid && isArrow && isFinite(currentMediaEl.duration)) {
        // In fullscreen + video: ONLY arrows seek by 10% of duration
        const step = currentMediaEl.duration * 0.1;
        if (e.key === "ArrowLeft") currentMediaEl.currentTime = Math.max(0, currentMediaEl.currentTime - step);
        else currentMediaEl.currentTime = Math.min(currentMediaEl.duration, currentMediaEl.currentTime + step);
      } else {
        // A/D keys always navigate gallery. Arrows navigate outside fullscreen.
        goTo(idx + (matchKey(e, keyPrev) ? -1 : 1));
      }
      e.preventDefault();
    }
  }

  // Wrap the handler so a key the lightbox ACTS ON is also blocked from reaching
  // ComfyUI's global shortcuts underneath (e.g. "c" also opening the ComfyUI
  // console). Capture phase = we run before ComfyUI's bubble-phase handlers, and
  // stopImmediatePropagation keeps the event from bubbling to them.
  function onKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    _handleKey(e);
    if (e.defaultPrevented) { e.stopPropagation(); e.stopImmediatePropagation(); }
  }
  document.addEventListener("keydown", onKey, true);
  closeBtn.addEventListener("click", destroy);
  prevBtn.addEventListener("click", () => goTo(idx - 1));
  nextBtn.addEventListener("click", () => goTo(idx + 1));
  mediaArea.addEventListener("click", (e) => {
    if (e.target === mediaArea || e.target === mediaContainer) destroy();
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
    const ck = `${it.root_id}:${it.relpath}`;
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

  // ── Feature 6: In-lightbox comparison mode ─────────────────────
  let _compareActive = false;
  let _compareIdx = -1;
  let _compareElements = null;
  let _compareSummary = null;  // cached for tab switching

  function openCompareMode() {
    if (_compareActive) { closeCompareMode(); return; }
    const currentItem = items[idx];
    if (!currentItem) return;
    _compareActive = true;
    _compareIdx = idx === 0 ? 1 : idx - 1;
    if (_compareIdx < 0 || _compareIdx >= items.length) _compareIdx = 0;

    compareBtn.textContent = "✕ Exit Compare";
    compareBtn.classList.add("sbg-btn--active");

    // Create right panel
    const rightWrapper = h("div", { class: "sbg-compare__right" });
    const rightImg = h("img", { class: "sbg-compare__right-img" });
    const rightPrevBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--prev sbg-compare__nav", text: "‹", title: "Previous comparison image" });
    const rightNextBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--next sbg-compare__nav", text: "›", title: "Next comparison image" });
    const rightCounter = h("div", { class: "sbg-compare__counter", text: "" });
    const rightFilename = h("div", { class: "sbg-compare__filename", text: "" });
    rightPrevBtn.addEventListener("click", (e) => { e.stopPropagation(); _navigateCompare(-1); });
    rightNextBtn.addEventListener("click", (e) => { e.stopPropagation(); _navigateCompare(1); });
    rightWrapper.appendChild(rightImg);
    rightWrapper.appendChild(rightPrevBtn);
    rightWrapper.appendChild(rightNextBtn);
    rightWrapper.appendChild(rightCounter);
    rightWrapper.appendChild(rightFilename);
    // "COMPARED" label — mirrors the "CURRENT" label on the left
    const rightLabel = h("div", {
      class: "sbg-compare__left-label",
      text: "COMPARED",
      style: "left:auto;right:8px;color:#f87171;"
    });
    rightWrapper.appendChild(rightLabel);

    const leftOverlay = h("div", { class: "sbg-compare__left-label", text: "CURRENT" });
    const leftFilename = h("div", { class: "sbg-compare__filename sbg-compare__filename--left", text: currentItem.filename || "" });
    const divider = h("div", { class: "sbg-compare__divider" });
    mediaContainer.classList.add("sbg-compare--active");
    mediaContainer.appendChild(leftOverlay);
    mediaContainer.appendChild(leftFilename);
    mediaContainer.appendChild(divider);
    mediaContainer.appendChild(rightWrapper);

    _compareElements = { rightWrapper, rightMedia: rightImg, divider, leftOverlay, leftFilename, rightPrevBtn, rightNextBtn, rightCounter, rightFilename };
    _loadCompareImage();
  }

  function closeCompareMode() {
    if (!_compareActive) return;
    _compareActive = false;
    _compareSummary = null;
    compareBtn.textContent = "⚖ Compare";
    compareBtn.classList.remove("sbg-btn--active");
    if (_compareElements) {
      releaseVideo(_compareElements.rightMedia);
      _compareElements.rightWrapper.remove();
      _compareElements.divider.remove();
      _compareElements.leftOverlay.remove();
      _compareElements.leftFilename.remove();
      _compareElements = null;
    }
    mediaContainer.classList.remove("sbg-compare--active");
    if (meta) renderMeta(meta);
  }

  function _navigateCompare(dir) {
    if (!_compareActive) return;
    let newIdx = _compareIdx + dir;
    if (newIdx === idx) newIdx += dir;
    if (newIdx < 0) newIdx = items.length - 1;
    if (newIdx >= items.length) newIdx = 0;
    if (newIdx === idx) newIdx += dir;
    if (newIdx < 0) newIdx = items.length - 1;
    if (newIdx >= items.length) newIdx = 0;
    _compareIdx = newIdx;
    _loadCompareImage();
  }

  function _loadCompareImage() {
    if (!_compareActive || !_compareElements) return;
    const compItem = items[_compareIdx];
    if (!compItem) return;
    // The compared item can be a video too — swap the element type so a video URL
    // isn't stuffed into an <img> (which rendered a broken-thumbnail icon).
    const wantVideo = isVideo(compItem);
    let mediaEl = _compareElements.rightMedia;
    if (wantVideo !== (mediaEl.tagName === "VIDEO")) {
      const neu = wantVideo
        ? h("video", { class: "sbg-compare__right-img", loop: "", autoplay: "", controls: "", playsinline: "" })
        : h("img", { class: "sbg-compare__right-img" });
      if (wantVideo) neu.muted = true; // required for autoplay
      releaseVideo(mediaEl); // release the outgoing video's decoder before discarding it
      mediaEl.replaceWith(neu);
      _compareElements.rightMedia = neu;
      mediaEl = neu;
    }
    mediaEl.src = fileUrl(compItem);
    // Update counter and filename
    const displayIdx = _compareIdx < idx ? _compareIdx + 1 : _compareIdx;
    _compareElements.rightCounter.textContent = `${displayIdx} of ${items.length - 1}`;
    _compareElements.rightFilename.textContent = compItem.filename || "";

    const compKey = `${compItem.root_id}:${compItem.relpath}`;
    const cached = _metaCache.get(compKey);
    if (cached?.summary) {
      _showCompDiff(cached.summary);
    } else {
      api("/sidebar_gallery/metadata", { root_id: compItem.root_id, relpath: compItem.relpath, summary_only: "1" })
        .then((m2) => { _metaCache.set(compKey, m2); if (_compareActive) _showCompDiff(m2?.summary || {}); })
        .catch(() => {});
    }
  }

  function _showCompDiff(compareSummary) {
    if (!meta) return;
    const currentSummary = meta.summary || {};
    const compItem = items[_compareIdx];
    _compareSummary = compareSummary;  // store for tab-switch re-render

    // Profile + merged summaries for the engine-based comparison.
    const _isVidCmp = items[idx] ? isVideo(items[idx]) : false;
    const _cmpApp = currentSummary.source_app || compareSummary.source_app || "comfyui";
    const _cmpProfile = TL.getActiveProfile(_cmpApp, _isVidCmp);
    const _curMerged = _mergeFileInfo(currentSummary, meta && meta.file);
    const _cmpMerged = _mergeFileInfo(compareSummary, compItem);

    // Signature of a section's resolved values — used to detect per-section diffs.
    const _sig = (section, summary) => {
      try {
        if (section.style === "nodes") return JSON.stringify(summary.workflow_nodes || []);
        if (section.style === "cards") {
          const els = TL.resolveSourceElements(section.source, summary);
          return JSON.stringify(els.map(el => (section.params || []).map(p => el && el[p.path])));
        }
        return JSON.stringify((section.params || []).map(p =>
          p.path && p.path.endsWith(".*") ? summary[p.path.slice(0, -2)] : TL.resolvePath(p.path, summary)
        ));
      } catch { return Math.random().toString(); }
    };

    metaBody.innerHTML = "";

    // Header with filename and bold color legend
    const header = h("div", { class: "sbg-compare-header", style: "padding:8px 10px;background:rgba(124,106,239,0.12);border-radius:8px;margin-bottom:8px;" });
    header.appendChild(h("div", { style: "font-weight:700;font-size:12px;margin-bottom:4px;color:var(--sbg-text,#eee);", text: `⚖ Comparing: ${compItem?.filename || "?"}` }));
    const legend = h("div", { style: "display:flex;gap:12px;font-size:11px;" });
    legend.appendChild(h("span", { text: "■ Same", style: "color:rgba(255,255,255,0.4)" }));
    legend.appendChild(h("span", { text: "■ Changed", style: "color:#facc15;font-weight:700" }));
    legend.appendChild(h("span", { text: "■ Current only", style: "color:#4ade80;font-weight:700" }));
    legend.appendChild(h("span", { text: "■ Compared only", style: "color:#f87171;font-weight:700" }));
    header.appendChild(legend);
    metaBody.appendChild(header);

    // Render each profile section, comparing current vs compared.
    for (const section of _cmpProfile) {
      if (!section || !section.title || section.style === "raw") continue;

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
        const topBlock = h("div", { style: "padding:6px 8px;border-left:3px solid #4ade80;margin:4px 0;" });
        topBlock.appendChild(h("div", { style: "font-size:9px;font-weight:700;color:#4ade80;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;", text: "▎Current" }));
        const tc = TL.renderSection(section, _curMerged, {}); if (tc) topBlock.appendChild(tc);
        stack.appendChild(topBlock);
        stack.appendChild(h("div", { style: "height:1px;background:rgba(255,255,255,0.08);margin:0 8px;" }));
        const bottomBlock = h("div", { style: "padding:6px 8px;border-left:3px solid #f87171;margin:4px 0;" });
        bottomBlock.appendChild(h("div", { style: "font-size:9px;font-weight:700;color:#f87171;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;", text: "▎Compared" }));
        const bc = TL.renderSection(section, _cmpMerged, {}); if (bc) bottomBlock.appendChild(bc);
        stack.appendChild(bottomBlock);
        sectionWrap.appendChild(stack);
      } else if (hasCurrent && hasCompare) {
        // Identical section — single column, collapsed by default
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
          const label = hasCurrent ? "Current only" : "Compared only";
          const color = hasCurrent ? "#4ade80" : "#f87171";
          const wrapper = h("div", { style: `padding:6px 8px;border-left:3px solid ${color};` });
          wrapper.appendChild(h("div", { style: `font-size:9px;font-weight:700;color:${color};margin-bottom:4px;text-transform:uppercase;`, text: label }));
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