import { app } from "../../scripts/app.js";
import { api as comfyApi } from "../../scripts/api.js";
import { progressFeed, watchIndexEndings } from "./sbg-progress.js";

import {
  EXT_NAME,
  ensureCss,
  lsGet,
  lsSet,
} from "./sbg-core.js";
import { paintTheme, loadUserThemes, adoptSettingColours } from "./sbg-theme.js";
import { S, getSetting, loadSettings, settingsUnread, B, downgradedFrom, clearDowngradeNotice, onSettingsChanged } from "./sbg-settings-store.js";
import { showFailure, postNotice } from "./sbg-toast.js";

import { openGallerySettings as _openGallerySettings, closeGallerySettings } from "./sbg-settings.js";
import { sweepStalePromptTabKeys, consolidateLayoutStorage, LAYOUTS_HELD, layoutsHeldText } from "./sbg-layout-store.js";
import { openLightbox, isLightboxOpen } from "./sbg-lightbox.js";
import { initGallery } from "./sbg-gallery.js";
import { galleryCache, disposeLiveTeardown } from "./sbg-gallery-store.js";
import { descFromKeyEvent, matchExplicit, matchBare, focusOwnsKey, wireMouseBindings } from "./sbg-keybinds.js";
import { fileUrl } from "./sbg-media-kind.js";
import { loadWorkflowFrom } from "./sbg-file-actions.js";
import { fetchFullMeta } from "./sbg-meta-cache.js";

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    ensureCss();

    await loadSettings();

    await loadUserThemes();
    try { await adoptSettingColours(); } catch (e) { console.warn("[SBG] Taking the settings colors into the theme failed:", e); }

    consolidateLayoutStorage().catch((e) => { postNotice(LAYOUTS_HELD, layoutsHeldText(e)); });

    const newer = downgradedFrom();
    if (newer) {
      postNotice("downgrade", `You last used gallery version ${newer}, which is newer than this one. The layouts and presets made in it come back after updating to it again. To use its layouts now, load a preset saved in ${newer} from the Presets tab.`,
        { onShown: clearDowngradeNotice });
    }

    paintTheme();

    // The sweep walks all of localStorage, so a mark keeps it to one pass.
    // Deleting a section in the Metadata tab removes its key as it goes.
    // Unread settings answer no layouts, which would sweep every custom
    // section's key, so the pass waits for a load that reads them.
    if (!settingsUnread() && lsGet(B.LAYOUT_HYGIENE_MARK) !== "1") {
      sweepStalePromptTabKeys();
      lsSet(B.LAYOUT_HYGIENE_MARK, "1");
    }

    const applyCardLift = () => {
      if (getSetting(S.CARD_LIFT)) document.documentElement.removeAttribute("data-sbg-card-lift");
      else document.documentElement.setAttribute("data-sbg-card-lift", "off");
    };
    applyCardLift();
    onSettingsChanged((ids) => { if (ids.has(S.CARD_LIFT)) applyCardLift(); });

    // The body carries the graph library's class and ComfyUI draws its panels
    // inside the graph's container, so neither tells the graph apart. A target
    // over the graph is the canvas, a node of the newer renderer, or a widget
    // the classic renderer lays over the canvas.
    function _overGraph(t) {
      if (!t || t.closest?.(".sbg-root")) return false;
      return t.id === "graph-canvas" || !!t.closest?.('#graph-canvas, [data-testid="transform-pane"], .dom-widget');
    }
    const _inGallery = (t) => !!(t && t.closest?.(".sbg-root"));

    document.body.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-sbg-workflow")) return;
      e.preventDefault();

      e.dataTransfer.dropEffect = _overGraph(e.target) ? "copy" : "none";

      // ComfyUI lights a node only for a drag the node itself accepts, which a
      // gallery card is not, so the highlight is set here. A point over the
      // sidebar still maps onto the canvas, so the node is looked up only over
      // the graph.
      try {
        const node = _overGraph(e.target) ? _nodeUnderDrop(e) : null;
        if (app.dragOverNode !== node) {
          app.dragOverNode = node;
          app.canvas?.setDirty?.(true, true);
        }
      } catch { }
    }, true);
    function _clearComfyDragHighlight() {
      try {
        if (app.dragOverNode) {
          app.dragOverNode = null;
          app.canvas?.setDirty?.(true, true);
        }
      } catch { }
    }

    // The point is in the coordinates of the graph on screen, which inside an
    // open subgraph is the canvas's graph. ComfyUI's `app.graph` is always the
    // root graph, where the same point holds no node or an unrelated one.
    function _nodeUnderDrop(e) {
      try {
        const c = app.canvas;
        const graph = c?.graph ?? app.graph;
        if (!c || !graph || typeof graph.getNodeOnPos !== "function") return null;
        const pos = c.convertEventToCanvasOffset(e);
        return graph.getNodeOnPos(pos[0], pos[1]) || null;
      } catch { return null; }
    }

    function _isImageLoaderNode(node) {
      if (!node) return false;
      if (/load.?image|image.?load/i.test(node.type || node.comfyClass || "")) return true;
      return Array.isArray(node.widgets) && node.widgets.some(w => w && w.name === "image" && (w.type === "combo" || (w.options && w.options.values)));
    }

    async function _loadImageIntoNode(node, dragged) {
      const widget = (node.widgets || []).find(w => w && w.name === "image");
      if (!widget) {
        showFailure(`load the image into ${node.title || "this node"}`, "the node has no image field");
        return;
      }
      const name = dragged.relpath.split("/").pop();
      const fileResp = await fetch(fileUrl(dragged));
      if (!fileResp.ok) throw new Error("the gallery can't read it");
      const blob = await fileResp.blob();
      const file = new File([blob], name, { type: blob.type || "image/png" });
      const fd = new FormData();
      fd.append("image", file);
      const up = await comfyApi.fetchApi("/upload/image", { method: "POST", body: fd });
      if (!up.ok) throw new Error("the upload to ComfyUI failed");
      const data = await up.json();
      const uploaded = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
      // The combo's list lacks a file uploaded since it was filled.
      if (widget.options && Array.isArray(widget.options.values) && !widget.options.values.includes(uploaded)) {
        widget.options.values.push(uploaded);
      }
      widget.value = uploaded;
      try { widget.callback?.(uploaded); } catch { }
      app.canvas?.setDirty?.(true, true);
    }

    document.body.addEventListener("drop", async (e) => {
      const sbgData = e.dataTransfer.getData("application/x-sbg-workflow");
      if (!sbgData) return;

      if (_inGallery(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        _clearComfyDragHighlight();
        return;
      }
      if (!_overGraph(e.target)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      _clearComfyDragHighlight();
      try {
        const dragged = JSON.parse(sbgData);

        const node = _nodeUnderDrop(e);
        if (node && _isImageLoaderNode(node)) {
          await _loadImageIntoNode(node, dragged);
          return;
        }

        await loadWorkflowFrom(await fetchFullMeta(dragged));
      } catch (err) {
        showFailure("load this file", err);
      }
    }, true);

    // Clears the highlight for a drag that ended off the graph, where the drop
    // handler returned early. Only the payload's types can be read on dragend.
    document.body.addEventListener("dragend", (e) => {
      if (!e.dataTransfer?.types?.includes("application/x-sbg-workflow")) return;
      _clearComfyDragHighlight();
    }, true);

    if (!app?.extensionManager?.registerSidebarTab) return;

    let galleryApi = null;
    let mounted = null;
    // The gallery reads these when it is built, so a change of one, however it
    // is made, builds it again as a reopen does when the settings panel over
    // it closes.
    const READ_AT_OPEN = [S.THUMB_SIZE, S.THUMB_PER_ROW, S.THUMB_SHAPE, S.CARD_STYLE, S.TOOLBAR_LAYOUT];
    let rebuildOwed = false;
    onSettingsChanged((ids) => { if (READ_AT_OPEN.some((id) => ids.has(id))) rebuildOwed = true; });

    app.extensionManager.registerSidebarTab({
      id: "sidebarGallery",
      icon: "pi pi-images",
      title: "Gallery",
      tooltip: "Sidebar Gallery",
      type: "custom",

      destroy: disposeLiveTeardown,
      render: renderGallery,
    });

    function renderGallery(mountEl) {
      rebuildOwed = false;
      mounted = mountEl;
      ensureCss();
      // ComfyUI's palette can change while the gallery is closed, and a theme
      // follows it for every base colour it does not name, so each open paints
      // again.
      paintTheme();
      // A tab switch in ComfyUI's own sidebar runs no toggle, so a settings
      // panel or folder dropdown still open is closed before the mount is
      // emptied behind it.
      try { galleryApi?.closePopup?.(); } catch { }
      try { closeGallerySettings(); } catch { }
      mountEl.innerHTML = "";
      mountEl.classList.add("sbg-mount");

      function openGallerySettings() {
        // Each reads `galleryApi` when called, so work the settings panel
        // finishes after a remount reaches the new gallery.
        _openGallerySettings({
          getAllItems: () => galleryApi?.state?.allItems || [],
          getRoots: () => galleryApi?.state?.roots || [],
          fetchAllItems: (opts) => galleryApi?.fetchAllItems?.(opts),
          refreshConfig: () => galleryApi?.refreshConfig?.(),
          closed: () => { if (rebuildOwed && mounted?.isConnected) renderGallery(mounted); },
        });
      }

      galleryApi = initGallery(mountEl, {
        openLightbox,
        openGallerySettings,
      });
    }

    // The aria-label matches current ComfyUI frontends, the id and data-tooltip
    // forms older ones, and the icon scan is the last resort. A key press with no
    // button to click says nothing, since a toast for a shortcut is more noise
    // than help.
    function _toggleGallery() {
      try {
        try { galleryApi?.closePopup?.(); } catch { }
        try { closeGallerySettings(); } catch { }
        const tabBtns = document.querySelectorAll('button[aria-label="Sidebar Gallery"], [id*="sidebarGallery"], [data-tooltip*="Gallery"], [data-tooltip*="Sidebar Gallery"]');
        for (const btn of tabBtns) {
          if (btn.click) { btn.click(); return; }
        }
        const allTabs = document.querySelectorAll('.p-tablist .p-tab, [class*="sidebar"] button');
        for (const tab of allTabs) {
          if (tab.querySelector('.pi-images') || tab.textContent?.includes('Gallery')) {
            tab.click(); return;
          }
        }
        console.warn("[SBG] Toggle Gallery found no gallery button in the sidebar");
      } catch (err) {
        console.warn("[SBG] Toggle Gallery failed:", err);
      }
    }

    // While the lightbox is open the toggle key is still taken and does nothing,
    // so the gallery is never pulled away behind it. A closed panel keeps its
    // handle, so refresh checks that the mount is still in the page.
    const _globalActions = [
      { setting: S.KEY_TOGGLE, off: () => isLightboxOpen(), run: () => _toggleGallery() },
      { setting: S.KEY_REFRESH, run: () => { if (galleryApi?.mountEl?.isConnected) galleryApi.fetchAllItems({ rescan: true }); } },
    ];

    function _handleGlobal(e, desc) {
      if (focusOwnsKey(e.target, desc.key)) return false;
      // Explicit bindings are tried across every action first, so a modified
      // press never fires another action's bare binding.
      for (const match of [matchExplicit, matchBare]) {
        for (const a of _globalActions) {
          if (match(getSetting(a.setting), desc)) {
            e.preventDefault();
            if (!a.off?.()) a.run();
            return true;
          }
        }
      }
      return false;
    }

    // Keys and buttons are heard in the bubble phase, so the lightbox's capture
    // handlers win any press both of them bind.
    document.addEventListener("keydown", (e) => _handleGlobal(e, descFromKeyEvent(e)));

    wireMouseBindings(_handleGlobal);

    let _refreshTimer = null;

    const _PENDING_FILES_CAP = 500;

    comfyApi.addEventListener("sbg.progress", (event) => {
      if (event.detail) progressFeed.deliver(event.detail);
    });

    comfyApi.addEventListener("reconnected", () => { progressFeed.refresh(); });
    watchIndexEndings();

    comfyApi.addEventListener("executed", (event) => {
      try {
        const output = event.detail?.output;
        if (!output) return;

        // ComfyUI names only the folder type a file went to, so only an output
        // file can be matched to the Output root by name. An extra root can be
        // the temp or input folder, so a file written there makes the root on
        // screen check for new files, unless that root is Output.
        const media = [...(output.images || []), ...(output.gifs || []), ...(output.audio || [])]
          .filter((m) => m.filename);
        const written = media.filter((m) => (m.type || "output") === "output");
        if (!written.length && (!media.length || galleryCache.view.lastRootId === "output")) return;

        const inbox = galleryCache.inbox;
        for (const m of written) {
          inbox.pendingFiles.push({ root_id: "output", filename: m.filename, subfolder: m.subfolder || "" });
        }
        // Past the cap the list is dropped, and the refresh asks instead for
        // every file newer than the server's last reply.
        if (inbox.pendingFiles.length > _PENDING_FILES_CAP) inbox.pendingFiles = [];

        inbox.stale = true;

        // A run reports each output node separately, so the fetch waits for
        // them to stop arriving.
        if (_refreshTimer) clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(() => {
          _refreshTimer = null;
          if (galleryApi && galleryApi.mountEl.isConnected) {
            galleryApi.fetchNewItems();
          }
        }, 800);
      } catch (err) {
        console.warn("[SBG] Auto-refresh error:", err);
      }
    });
  },
});
