/**
 * sbg-context-menu.js — Right-click context menu for gallery cards
 *
 * Replicates the official ComfyUI MediaAssetContextMenu style:
 * rounded dark background, shadow, icon + label per item.
 */

import { h, showToast, copyText, api, isVideo, isAudio, is3D, t } from "./sbg-core.js";

let _menu = null;
let _hideTimer = null;

/** Create the reusable context menu DOM (singleton). */
function _ensureMenu() {
  if (_menu) return _menu;
  _menu = h("div", { class: "sbg-ctx-menu" });
  document.body.appendChild(_menu);
  // Click anywhere else closes
  document.addEventListener("mousedown", (e) => {
    if (_menu && !_menu.contains(e.target)) hideContextMenu();
  }, true);
  // Scroll closes
  document.addEventListener("scroll", () => hideContextMenu(), true);
  return _menu;
}

/** Hide the context menu. */
export function hideContextMenu() {
  if (!_menu) return;
  _menu.style.display = "none";
  _menu.innerHTML = "";
  clearTimeout(_hideTimer);
}

/**
 * Show a context menu for a gallery item.
 * @param {MouseEvent} event - The contextmenu event
 * @param {Object} item - The gallery item
 * @param {Object} actions - { openLightbox, fetchAllItems, filteredItems }
 */
export function showContextMenu(event, item, actions) {
  event.preventDefault();
  event.stopPropagation();

  const menu = _ensureMenu();
  menu.innerHTML = "";
  menu.style.display = "block";

  const items = [];

  // Preview
  items.push({
    icon: "🔍",
    label: t("ctx.preview"),
    action: () => { actions.openLightbox(actions.filteredItems, item); },
  });

  // Download
  items.push({
    icon: "📥",
    label: t("ctx.download"),
    action: () => {
      const url = `/sidebar_gallery/file?root_id=${encodeURIComponent(item.root_id)}&relpath=${encodeURIComponent(item.relpath)}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = item.filename || "download";
      a.click();
    },
  });

  // Insert as Node (upload to input + add appropriate node)
  items.push({
      icon: "🧩",
      label: t("ctx.insert_node"),
      action: async () => {
        try {
          const name = item.relpath.replace(/\\/g, "/").split("/").pop();
          const fileResp = await fetch(`/sidebar_gallery/file?root_id=${encodeURIComponent(item.root_id)}&relpath=${encodeURIComponent(item.relpath)}`);
          if (!fileResp.ok) throw new Error("could not read source file");
          const blob = await fileResp.blob();
          const file = new File([blob], name, { type: blob.type || "image/png" });
          const fd = new FormData();
          fd.append("image", file);
          fd.append("overwrite", "true");
          const { api: comfyApi } = await import("../../scripts/api.js");
          const up = comfyApi?.fetchApi
            ? await comfyApi.fetchApi("/upload/image", { method: "POST", body: fd })
            : await fetch("/upload/image", { method: "POST", body: fd });
          if (!up.ok) throw new Error("upload failed");
          const data = await up.json();
          const uploaded = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
          const { app } = await import("../../scripts/app.js");
          
          // Use LiteGraph API to create and add node
          if (typeof LiteGraph === "undefined") {
            throw new Error("LiteGraph not available");
          }
          
          // Determine node type and widget name based on file type
          let nodeType, widgetName;
          if (isVideo(item)) {
            nodeType = "LoadVideo";
            widgetName = "file";
          } else if (isAudio(item)) {
            nodeType = "LoadAudio";
            widgetName = "audio";
          } else if (is3D(item)) {
            nodeType = "Load3D";
            widgetName = "model_file";
          } else {
            nodeType = "LoadImage";
            widgetName = "image";
          }
          
          const node = LiteGraph.createNode(nodeType);
          if (!node) {
            throw new Error(`Failed to create ${nodeType} node`);
          }
          
          // Position at mouse location in graph coordinates
          node.pos = [app.canvas.graph_mouse[0], app.canvas.graph_mouse[1]];
          
          // Add node to graph
          app.canvas.graph.add(node, false);
          
          // Set the appropriate widget
          const widget = (node.widgets || []).find(w => w && w.name === widgetName);
          if (widget) {
            if (widget.options && Array.isArray(widget.options.values) && !widget.options.values.includes(uploaded)) {
              widget.options.values.push(uploaded);
            }
            widget.value = uploaded;
            try { widget.callback?.(uploaded); } catch { }
          }
          
          // Refresh canvas
          app.canvas.setDirty(true, true);
          showToast(t("sidebar.loaded_into", { n: node.title || nodeType }));
        } catch (err) {
          showToast(t("sidebar.load_failed", { e: err?.message || err }));
        }
      },
    });

  // Load Workflow (only for images with metadata)
  if (!isAudio(item) && !is3D(item)) {
    items.push({
      icon: "⬆",
      label: t("ctx.load_workflow"),
      action: async () => {
        try {
          const m = await api("/sidebar_gallery/metadata", { root_id: item.root_id, relpath: item.relpath });
          if (!m?.workflow) { showToast(t("sidebar.no_workflow")); return; }
          let wf = m.workflow;
          if (typeof wf === "string") wf = JSON.parse(wf);
          // Use ComfyUI's app.loadGraphData
          try {
            const { app } = await import("../../scripts/app.js");
            app.loadGraphData(wf);
            showToast(t("sidebar.workflow_loaded"));
          } catch {
            showToast(t("sidebar.no_workflow"));
          }
        } catch (err) {
          showToast(t("sidebar.load_failed", { e: err?.message || err }));
        }
      },
    });
  }

  // Copy Prompt
  if (!isAudio(item) && !is3D(item)) {
    items.push({
      icon: "📋",
      label: t("ctx.copy_prompt"),
      action: async () => {
        try {
          const m = await api("/sidebar_gallery/metadata", { root_id: item.root_id, relpath: item.relpath, summary_only: "1" });
          const prompt = m?.summary?.positive_prompt;
          if (prompt) copyText(typeof prompt === "string" ? prompt : JSON.stringify(prompt, null, 2));
          else showToast(t("core.nothing_to_copy"));
        } catch {
          showToast(t("core.copy_failed"));
        }
      },
    });
  }

  // Export Workflow
  if (!isAudio(item) && !is3D(item)) {
    items.push({
      icon: "📄",
      label: t("ctx.export_workflow"),
      action: async () => {
        try {
          const m = await api("/sidebar_gallery/metadata", { root_id: item.root_id, relpath: item.relpath });
          if (!m?.workflow) { showToast(t("lb.no_workflow")); return; }
          const wf = typeof m.workflow === "string" ? m.workflow : JSON.stringify(m.workflow, null, 2);
          const blob = new Blob([wf], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = (item.filename || "workflow").replace(/\.[^.]+$/, "") + ".json";
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          showToast(t("lb.error", { e: err?.message || err }));
        }
      },
    });
  }

  // Separator
  items.push({ separator: true });

  // Copy Path
  items.push({
    icon: "📎",
    label: t("ctx.copy_path"),
    action: () => {
      const fullPath = item.root_id + "/" + item.relpath;
      copyText(fullPath);
    },
  });

  // Delete
  items.push({
    icon: "🗑",
    label: t("ctx.delete"),
    danger: true,
    action: () => {
      const filename = item.filename || item.relpath;
      if (!confirm(t("ctx.delete_confirm", { f: filename }))) return;
      api("/sidebar_gallery/delete_file", { root_id: item.root_id, relpath: item.relpath }, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root_id: item.root_id, relpath: item.relpath }),
      }).then((r) => {
        if (r?.ok) {
          showToast(t("gs.folder_removed"));
          if (actions.fetchAllItems) actions.fetchAllItems({ rescan: true });
        } else {
          showToast(t("lb.error", { e: r?.error || "delete failed" }));
        }
      }).catch((e) => {
        showToast(t("lb.error", { e: e?.message || e }));
      });
    },
  });

  // Build menu DOM
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(h("div", { class: "sbg-ctx-menu__sep" }));
    } else {
      const el = h("div", {
        class: `sbg-ctx-menu__item${item.danger ? " sbg-ctx-menu__item--danger" : ""}`,
        onclick: () => { hideContextMenu(); item.action(); },
      }, [
        h("span", { class: "sbg-ctx-menu__icon", text: item.icon }),
        h("span", { class: "sbg-ctx-menu__label", text: item.label }),
      ]);
      menu.appendChild(el);
    }
  }

  // Position near cursor, keep within viewport
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = event.clientX;
  let y = event.clientY;
  // Temporarily show to measure
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.visibility = "hidden";
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.visibility = "";
  if (x + mw > vw - 8) x = vw - mw - 8;
  if (y + mh > vh - 8) y = vh - mh - 8;
  if (x < 8) x = 8;
  if (y < 8) y = 8;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
}
