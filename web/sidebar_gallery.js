/**
 * sidebar_gallery.js — Entry point for the SBG ComfyUI extension
 *
 * This module is the thin shell that:
 *   - Registers the ComfyUI sidebar extension
 *   - Applies global CSS variables from saved settings
 *   - Installs global keyboard shortcuts and drag-drop handlers
 *   - Delegates gallery rendering to sbg-gallery.js
 *   - Bridges auto-refresh events from ComfyUI to the gallery
 */

import { app } from "../../scripts/app.js";
import { api as comfyApi } from "../../scripts/api.js";

/* ── Imports from extracted modules ──────────────────────────────── */
import {
  EXT_NAME, CSS_URL,
  _dataCache, ensureCss, h, api, showToast,
  S, getSetting, loadSettings,
} from "./sbg-core.js";

import { openGallerySettings as _openGallerySettings } from "./sbg-settings.js";
import { openLightbox } from "./sbg-lightbox.js";
import { initGallery } from "./sbg-gallery.js";


/* ══════════════════════════════════════════════════════════════════════
   SIDEBAR EXTENSION
   ══════════════════════════════════════════════════════════════════════ */

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    ensureCss();

    // Load disk-backed settings before anything reads them
    await loadSettings();

    /* ── Apply saved CSS custom properties ────────────────────────── */

    const _appCSSVars = [
      { key: S.APP_BADGE_COMFYUI, cssVar: "--sbg-app-comfyui" },
      { key: S.APP_BADGE_A1111, cssVar: "--sbg-app-a1111" },
      { key: S.APP_BADGE_FORGE, cssVar: "--sbg-app-forge" },
      { key: S.APP_BADGE_SDNEXT, cssVar: "--sbg-app-sdnext" },
      { key: S.APP_BADGE_FOOOCUS, cssVar: "--sbg-app-fooocus" },
    ];
    for (const { key, cssVar } of _appCSSVars) {
      const saved = getSetting(key, "");
      if (saved) document.documentElement.style.setProperty(cssVar, saved);
    }

    // Pill/badge custom colors
    const pillBg = getSetting(S.PILL_BG_COLOR, "");
    const pillText = getSetting(S.PILL_TEXT_COLOR, "");
    const pillBorder = getSetting(S.PILL_BORDER_COLOR, "");
    if (pillBg) document.documentElement.style.setProperty("--sbg-pill-bg", pillBg);
    if (pillText) document.documentElement.style.setProperty("--sbg-pill-text", pillText);
    if (pillBorder) document.documentElement.style.setProperty("--sbg-pill-border", pillBorder);

    // Prompt padding
    const promptPad = getSetting(S.PROMPT_PADDING, "");
    if (promptPad) document.documentElement.style.setProperty("--sbg-prompt-padding", promptPad + "px");

    /* ── Global drag-drop handler for workflow loading ────────────── */

    document.body.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-sbg-workflow")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      // ComfyUI doesn't highlight nodes for our custom drag payload, so drive its
      // native per-node highlight ourselves: set dragOverNode to the node under
      // the cursor (or null) and redraw. Cleared on drop/dragend.
      try {
        // Only highlight when the cursor is actually over the graph canvas —
        // otherwise mapped coords could light up a node while dragging over the
        // sidebar/gallery.
        const t = e.target;
        const overGraph = !!(t && (t.tagName === "CANVAS"
          || t.closest?.(".litegraph, canvas, #graph-canvas, .graph-canvas-container, .comfyui-body-center")));
        const node = overGraph ? (_nodeUnderDrop(e) || null) : null;
        if (app.dragOverNode !== node) {
          app.dragOverNode = node;
          app.canvas?.setDirty?.(true, true);
        }
      } catch { }
    }, true);
    /** Clear ComfyUI's blue per-node drag-over highlight and redraw. */
    function _clearComfyDragHighlight() {
      try {
        if (app.dragOverNode) app.dragOverNode = null;
        app.canvas?.setDirty?.(true, true);
      } catch { }
    }

    /** Find the litegraph node under a drop event, or null. */
    function _nodeUnderDrop(e) {
      try {
        const c = app.canvas;
        if (!c || !app.graph || typeof app.graph.getNodeOnPos !== "function") return null;
        let pos;
        if (typeof c.convertEventToCanvasOffset === "function") {
          pos = c.convertEventToCanvasOffset(e);
        } else {
          const rect = c.canvas.getBoundingClientRect();
          const ds = c.ds || { scale: 1, offset: [0, 0] };
          pos = [(e.clientX - rect.left) / ds.scale - ds.offset[0], (e.clientY - rect.top) / ds.scale - ds.offset[1]];
        }
        return app.graph.getNodeOnPos(pos[0], pos[1]) || null;
      } catch { return null; }
    }

    /** True if a node accepts an image (LoadImage and friends). */
    function _isImageLoaderNode(node) {
      if (!node) return false;
      if (/load.?image|image.?load|loadimagemask/i.test(node.type || node.comfyClass || "")) return true;
      return Array.isArray(node.widgets) && node.widgets.some(w => w && w.name === "image" && (w.type === "combo" || (w.options && w.options.values)));
    }

    /** Upload a gallery file into ComfyUI's input dir and point the node at it. */
    async function _loadImageIntoNode(node, root_id, relpath) {
      const name = relpath.replace(/\\/g, "/").split("/").pop();
      const fileResp = await fetch(`/sidebar_gallery/file?root_id=${encodeURIComponent(root_id)}&relpath=${encodeURIComponent(relpath)}`);
      if (!fileResp.ok) throw new Error("could not read source image");
      const blob = await fileResp.blob();
      const file = new File([blob], name, { type: blob.type || "image/png" });
      const fd = new FormData();
      fd.append("image", file);
      fd.append("overwrite", "true");
      const up = comfyApi?.fetchApi
        ? await comfyApi.fetchApi("/upload/image", { method: "POST", body: fd })
        : await fetch("/upload/image", { method: "POST", body: fd });
      if (!up.ok) throw new Error("upload failed");
      const data = await up.json();
      const uploaded = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
      const widget = (node.widgets || []).find(w => w && w.name === "image");
      if (widget) {
        if (widget.options && Array.isArray(widget.options.values) && !widget.options.values.includes(uploaded)) {
          widget.options.values.push(uploaded);
        }
        widget.value = uploaded;
        try { widget.callback?.(uploaded); } catch { }
      }
      app.graph?.setDirtyCanvas?.(true, true);
      showToast(`Loaded image into ${node.title || node.type}`);
    }

    document.body.addEventListener("drop", async (e) => {
      const sbgData = e.dataTransfer.getData("application/x-sbg-workflow");
      if (!sbgData) return;

      // The dropzone overlay has pointer-events:none, so e.target is the
      // element *under* it (the Comfy canvas/litegraph). Load the workflow when
      // the drop lands anywhere over the graph area; otherwise let it pass.
      const target = e.target;
      const isOnGraph = target.closest?.(".litegraph, canvas, .comfyui-body-center, .graph-canvas-container, #graph-canvas")
        || target.tagName === "CANVAS";
      if (!isOnGraph) {
        return; // not over the canvas — don't intercept
      }

      e.preventDefault();
      e.stopPropagation();
      // Because we preventDefault the drop, ComfyUI's own handler won't clear the
      // blue per-node drag highlight — do it ourselves.
      _clearComfyDragHighlight();
      try {
        const { root_id, relpath } = JSON.parse(sbgData);

        // If the drop landed on an image-loading node (LoadImage etc.), load the
        // IMAGE into that node instead of replacing the whole workflow.
        const node = _nodeUnderDrop(e);
        if (node && _isImageLoaderNode(node)) {
          await _loadImageIntoNode(node, root_id, relpath);
          return;
        }

        const m = await api("/sidebar_gallery/metadata", { root_id, relpath });
        if (!m?.workflow) { showToast("No workflow data in this image"); return; }
        let wf = m.workflow;
        if (typeof wf === "string") wf = JSON.parse(wf);
        app.loadGraphData(wf);
        showToast("Workflow loaded from drag & drop!");
      } catch (err) {
        showToast(`Failed to load: ${err?.message || err}`, 5000);
      }
    }, true);

    // Safety net: always clear the per-node highlight when a SBG drag ends,
    // even if the drop landed off-canvas.
    document.body.addEventListener("dragend", () => {
      _clearComfyDragHighlight();
    }, true);

    /* ── Register sidebar tab ─────────────────────────────────────── */

    if (!app?.extensionManager?.registerSidebarTab) return;

    app.extensionManager.registerSidebarTab({
      id: "sidebarGallery",
      icon: "pi pi-images",
      title: "Gallery",
      tooltip: "Sidebar Gallery",
      type: "custom",
      render: (mountEl) => {
        ensureCss();
        mountEl.innerHTML = "";
        mountEl.style.position = "relative";
        mountEl.style.width = "100%";
        mountEl.style.height = "100%";
        mountEl.style.overflow = "hidden";

        /* ── Gallery settings bridge ──────────────────────────────── */
        function openGallerySettings(defaultTab = "layout") {
          // galleryApi may not be set yet on first render, but state is captured via closure
          const allItems = galleryApi?.state?.allItems || [];
          const fetchAll = galleryApi?.fetchAllItems || (() => {});
          _openGallerySettings({
            allItems,
            fetchAllItems: fetchAll,
            // Lets the Folders settings live-refresh the gallery's root list when a
            // folder is added/removed (without it, a new folder only appeared after
            // a full browser reload).
            refreshConfig: galleryApi?.refreshConfig,
          }, defaultTab);
        }

        /* ── Init gallery ─────────────────────────────────────────── */
        const galleryApi = initGallery(mountEl, {
          openLightbox,
          openGallerySettings,
        });
      },
    });

    /* ── Global keyboard shortcuts ────────────────────────────────── */

    // Only the two GLOBAL shortcuts live here — lightbox keys are read inside
    // the lightbox itself. (KEY_REFRESH defaults to disabled, matching the
    // settings UI's "leave empty to disable".)
    const _keyDefaults = {
      [S.KEY_TOGGLE]: "z,0",
      [S.KEY_REFRESH]: "",
    };

    function matchKeyGlobal(e, settingId) {
      const bound = getSetting(settingId, _keyDefaults[settingId] || "");
      if (!bound) return false;
      const pressed = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      return String(bound).split(",").map(k => k.trim()).some(k => {
        const b = k.length === 1 ? k.toLowerCase() : k;
        return pressed === b;
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Toggle gallery sidebar
      if (matchKeyGlobal(e, S.KEY_TOGGLE)) {
        e.preventDefault();
        try {
          const tabBtns = document.querySelectorAll('[id*="sidebarGallery"], [data-tooltip*="Gallery"], [data-tooltip*="Sidebar Gallery"]');
          for (const btn of tabBtns) {
            if (btn.click) { btn.click(); return; }
          }
          const allTabs = document.querySelectorAll('.p-tablist .p-tab, [class*="sidebar"] button');
          for (const tab of allTabs) {
            if (tab.querySelector('.pi-images') || tab.textContent?.includes('Gallery')) {
              tab.click(); return;
            }
          }
        } catch (err) {
          console.warn("[SBG] Could not toggle gallery:", err);
        }
      }

      // Refresh gallery
      if (matchKeyGlobal(e, S.KEY_REFRESH)) {
        e.preventDefault();
        if (_dataCache._fetchAllItems) {
          _dataCache._fetchAllItems({ rescan: true });
        }
      }
    });

    /* ── Auto-refresh on execution complete ────────────────────────── */

    let _refreshTimer = null;

    comfyApi.addEventListener("executed", (event) => {
      try {
        const detail = event.detail;
        if (!detail) return;

        const output = detail.output;
        if (!output) return;
        const hasMedia = output.images || output.gifs;
        if (!hasMedia) return;

        const mediaList = [...(output.images || []), ...(output.gifs || [])];
        for (const m of mediaList) {
          if (m.filename) {
            _dataCache._pendingFiles.push({
              filename: m.filename,
              subfolder: m.subfolder || "",
              type: m.type || "output",
            });
          }
        }

        _dataCache.stale = true;

        if (_refreshTimer) clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(() => {
          _refreshTimer = null;
          if (_dataCache._mountEl && _dataCache._mountEl.isConnected) {
            const fn = _dataCache._fetchNewItems || _dataCache._fetchAllItems;
            if (fn) fn();
          }
        }, 800);
      } catch (err) {
        console.warn("[SBG] Auto-refresh error:", err);
      }
    });
  },
});
