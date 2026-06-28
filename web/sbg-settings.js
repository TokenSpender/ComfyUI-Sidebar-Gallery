/**
 * sbg-settings.js \u2014 Gallery Settings overlay
 *
 * Contains the full settings panel: Layout Editor, Appearance,
 * Keybindings, Settings, Presets, and Diagnostics tabs.
 * Extracted from the monolith to keep files focused and manageable.
 */

import {
  h, api, showToast,
  getSetting, saveSetting, fmtBytes,
  parseColor, formatColor, formatRgba, checkerBg,
  _metaCache, _metaCacheAPI, _resetIdb,
  _thumbCacheAPI, _thumbMemCache, resetFailedThumbs,
  _sectionOrderKey, S,
} from "./sbg-core.js";

import { renderLayout, clearSwatchCache } from "./sbg-layout-editor.js";
import { createColorPicker } from "./sbg-color-picker.js";
import { replaceElementColor } from "./sbg-translation-layer.js";

/**
 * Open the Gallery Settings panel.
 * @param {Object} galleryCtx - Gallery-scope references
 * @param {Array} galleryCtx.allItems - Current list of all gallery items
 * @param {Function} galleryCtx.fetchAllItems - Function to re-fetch all items from server
 * @param {string} [defaultTab="layout"] - Which tab to open by default
 */
export function openGallerySettings(galleryCtx, defaultTab = "layout") {
// Full-screen overlay (like lightbox)
const gsOverlay = h("div", { class: "sbg-gs-overlay" });
const gsPanel = h("div", { class: "sbg-gs-panel" });

// Header
const gsClose = h("button", { class: "sbg-gs-close", text: "✕", title: "Close" });
const gsHeader = h("div", { class: "sbg-gs-header" }, [
  h("span", { class: "sbg-gs-title", text: "⚙ Gallery Settings" }),
  gsClose,
]);

// Tab bar
const TAB_NAMES = ["Layout", "Appearance", "Keybindings", "Settings", "Presets", "Diagnostics"];
const tabBtns = TAB_NAMES.map(name =>
  h("button", { class: "sbg-gs-tab", text: name, "data-tab": name.toLowerCase() })
);
const tabBar = h("div", { class: "sbg-gs-tabs" }, tabBtns);
const content = h("div", { class: "sbg-gs-content" });

gsPanel.appendChild(gsHeader);
gsPanel.appendChild(tabBar);
gsPanel.appendChild(content);
gsOverlay.appendChild(gsPanel);

// Append to sbg-root if it exists so we inherit native themes (dark/blue), otherwise fallback to document.body
const sbgRoot = document.querySelector(".sbg-root");
if (sbgRoot) {
  sbgRoot.appendChild(gsOverlay);
} else {
  document.body.appendChild(gsOverlay);
}

// Cleanup callbacks run when the settings panel closes (however it closes).
// Color-input popovers append panels + global listeners to the document; without
// this they leaked a little more DOM each time settings was opened.
const _gsCleanups = [];
function closeGS() {
  for (const fn of _gsCleanups.splice(0)) { try { fn(); } catch { } }
  document.removeEventListener("keydown", _gsKey);
  gsOverlay.remove();
}
function _gsKey(e) { if (e.key === "Escape") closeGS(); }
gsClose.addEventListener("click", closeGS);
gsOverlay.addEventListener("click", (e) => { if (e.target === gsOverlay) closeGS(); });
document.addEventListener("keydown", _gsKey);

// Helper: read a setting from the single source of truth (disk-backed cache).
function _readSetting(id, fallback) {
  return getSetting(id, fallback);
}

// Cache sizes: show "—" when empty, otherwise the shared byte formatter.
function _fmtCacheSize(bytes) {
  return !bytes || bytes <= 0 ? "—" : fmtBytes(bytes);
}

async function refreshDiagStats(diagStatsContainer) {
  try {
    const st = await api("/sidebar_gallery/status");
    diagStatsContainer.innerHTML = "";

    const indexInfo = st.index || {};
    const counts = indexInfo.counts || st.index || {};
    const indexTitle = h("div", { class: "sbg-diag-section__title", text: "SQLite Index", title: "Server-side SQLite database that stores the file listing and parsed metadata summaries for fast gallery loading without disk scanning" });
    diagStatsContainer.appendChild(indexTitle);

    const countsObj = typeof counts === "object" && !Array.isArray(counts) ? counts : {};
    for (const [rid, count] of Object.entries(countsObj)) {
      if (rid === "db_path" || rid === "db_size_mb" || rid === "counts") continue;
      diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat" }, [
        h("span", { class: "sbg-diag-stat__label", text: rid }),
        h("span", { class: "sbg-diag-stat__value", text: Number(count).toLocaleString() + " files" }),
      ]));
    }

    if (indexInfo.db_path) {
      diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat", title: "Full filesystem path of the SQLite database file" }, [
        h("span", { class: "sbg-diag-stat__label", text: "DB Path" }),
        h("span", { class: "sbg-diag-stat__value sbg-diag-stat__value--path", text: indexInfo.db_path }),
      ]));
    }
    if (indexInfo.db_size_mb !== undefined) {
      diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat", title: "Size of the SQLite database file on disk" }, [
        h("span", { class: "sbg-diag-stat__label", text: "DB Size" }),
        h("span", { class: "sbg-diag-stat__value", text: `${indexInfo.db_size_mb} MB` }),
      ]));
    }

    try {
      const prog = await fetch("/sidebar_gallery/reindex_progress").then(r => r.json());
      if (prog.running) {
        const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;
        diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat", style: "margin-top:6px;color:var(--sbg-accent)" }, [
          h("span", { class: "sbg-diag-stat__label", text: `${prog.phase || "Indexing"}…` }),
          h("span", { class: "sbg-diag-stat__value", text: `${prog.done.toLocaleString()} / ${prog.total.toLocaleString()} (${pct}%)` }),
        ]));
      }
    } catch { }

    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-section__title", text: "Server Thumbnails", title: "JPEG thumbnails generated and stored on the server in the .thumbs folder. Shared across all browsers/clients. No in-memory cache — served directly from disk on each request.", style: "margin-top:10px" }));
    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat" }, [h("span", { class: "sbg-diag-stat__label", text: "Count" }), h("span", { class: "sbg-diag-stat__value", text: (st.thumbnails?.count || 0).toLocaleString() })]));
    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat" }, [h("span", { class: "sbg-diag-stat__label", text: "Size" }), h("span", { class: "sbg-diag-stat__value", text: `${st.thumbnails?.size_mb || 0} MB` })]));

    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-section__title", text: "Browser Thumb Cache", title: "Thumbnails cached in this browser's IndexedDB for instant loading without server requests.", style: "margin-top:10px" }));
    const _tcCountEl = h("span", { class: "sbg-diag-stat__value", text: "…" });
    const _tcSizeEl = h("span", { class: "sbg-diag-stat__value", text: "…" });
    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat" }, [h("span", { class: "sbg-diag-stat__label", text: "Cached" }), _tcCountEl]));
    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat" }, [h("span", { class: "sbg-diag-stat__label", text: "Size" }), _tcSizeEl]));

    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-section__title", text: "Browser Meta Cache", title: "Parsed metadata summaries cached in IndexedDB and in-memory.", style: "margin-top:10px" }));
    const _mcCountEl = h("span", { class: "sbg-diag-stat__value", text: "…" });
    const _mcSizeEl = h("span", { class: "sbg-diag-stat__value", text: "…" });
    const _mcMemEl = h("span", { class: "sbg-diag-stat__value", text: `${_metaCache.size} entries` });
    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat" }, [h("span", { class: "sbg-diag-stat__label", text: "IndexedDB" }), _mcCountEl]));
    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat" }, [h("span", { class: "sbg-diag-stat__label", text: "Size" }), _mcSizeEl]));
    diagStatsContainer.appendChild(h("div", { class: "sbg-diag-stat", title: "Metadata entries in JS memory for this session" }, [h("span", { class: "sbg-diag-stat__label", text: "In-memory" }), _mcMemEl]));

    Promise.all([_thumbCacheAPI.getStats(), _metaCacheAPI.getStats()]).then(([ts, ms]) => {
      _tcCountEl.textContent = `${ts.count.toLocaleString()} thumbs`;
      _tcSizeEl.textContent = _fmtCacheSize(ts.totalSizeBytes);
      _mcCountEl.textContent = `${ms.count.toLocaleString()} entries`;
      _mcSizeEl.textContent = _fmtCacheSize(ms.totalSizeBytes);
    }).catch(() => { });
  } catch (e) {
    diagStatsContainer.innerHTML = `<div style="padding:8px;color:var(--sbg-text-dim)">Error: ${e?.message || e}</div>`;
  }
}

function _writeSetting(id, value) {
  // Write to the disk-backed settings (single source of truth).
  saveSetting(id, value);
}

// ── Helper: make a setting row ──
function _settingRow(label, input, tooltip) {
  const row = h("div", { class: "sbg-gs-row", title: tooltip || "" });
  row.appendChild(h("label", { class: "sbg-gs-label", text: label }));
  row.appendChild(input);
  return row;
}

function _toggle(id, fallback, label, tooltip) {
  const val = _readSetting(id, fallback);
  const cb = h("input", { type: "checkbox" });
  cb.checked = !!val;
  cb.addEventListener("change", () => _writeSetting(id, cb.checked));
  return _settingRow(label, cb, tooltip);
}

function _textInput(id, fallback, label, tooltip) {
  const val = _readSetting(id, fallback);
  const inp = h("input", { type: "text", class: "sbg-gs-input", value: String(val || "") });
  inp.addEventListener("change", () => _writeSetting(id, inp.value));
  return _settingRow(label, inp, tooltip);
}

function _colorInput(id, fallback, label, tooltip, callback, replaceChannel) {
  const val = _readSetting(id, fallback);
  const wrap = h("div", { class: "sbg-gs-color-wrap", style: "position:relative" });

  // displayColor: the canonical CSS colour (hex when opaque, rgba when translucent).
  // Raw values we can't parse (e.g. "var(--sbg-accent)") are stored verbatim.
  let displayColor = val || fallback || "#7c6aef";
  // The text field always READS as rgba(...) (matching the colour picker), even
  // at full opacity. The stored/applied value (displayColor) stays canonical.
  const _toRgba = (c) => { const pc = parseColor(c); return pc ? formatRgba(pc.r, pc.g, pc.b, pc.a) : c; };

  // Pill colour rows only: debounced find-&-replace of matching per-element pill
  // colours. The baseline is the colour BEFORE the current edit burst, so dragging
  // the picker (which fires applyColor continuously) commits ONE old→new replace at
  // the end rather than chasing every intermediate value.
  let _replBaseline = displayColor, _replTimer = null;

  function applyColor(color) {
    const prev = displayColor;
    displayColor = color;
    swatch.style.background = checkerBg(color);
    text.value = _toRgba(color);
    _writeSetting(id, color);
    if (callback) callback(color);
    // A global colour changed → drop the layout editor's cached swatch defaults
    // so its param/tab/section colour pickers re-read the new value (otherwise
    // the picker shows the colour from when it was first opened).
    clearSwatchCache();
    if (replaceChannel) {
      if (_replTimer === null) _replBaseline = prev; // first change of a burst
      clearTimeout(_replTimer);
      _replTimer = setTimeout(() => { _replTimer = null; replaceElementColor(replaceChannel, _replBaseline, displayColor); }, 400);
    }
  }

  // ── Clickable swatch (shows transparency over a checkerboard) ──
  const swatch = h("div", {
    class: "sbg-color-swatch",
    style: "width:28px;height:28px;border-radius:6px;border:2px solid var(--sbg-border);cursor:pointer;flex-shrink:0;transition:box-shadow 0.15s;"
  });
  swatch.style.background = checkerBg(displayColor);
  swatch.addEventListener("mouseenter", () => { swatch.style.boxShadow = "0 0 0 2px var(--sbg-accent)"; });
  swatch.addEventListener("mouseleave", () => { swatch.style.boxShadow = ""; });

  // ── Colour text input (accepts hex or rgba) ──
  const text = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm", value: _toRgba(displayColor) });
  text.addEventListener("change", () => {
    const v = text.value.trim();
    const pc = parseColor(v);
    if (pc) { applyColor(formatColor(pc.r, pc.g, pc.b, pc.a)); if (picker) { picker.destroy(); panel.removeChild(picker.panel); picker = null; } }
    else { displayColor = v; swatch.style.background = checkerBg(v); _writeSetting(id, v); if (callback) callback(v); }
  });

  // ── Popover hosting the shared colour picker (created lazily on first open) ──
  const panel = h("div", { class: "sbg-color-panel", style: "display:none;position:fixed;z-index:9999;background:var(--sbg-surface,#1e1e1e);border:1px solid var(--sbg-border);border-radius:10px;padding:12px;box-shadow:0 12px 40px rgba(0,0,0,0.6);width:max-content;min-width:220px;" });
  let picker = null;
  function ensurePicker() {
    if (picker) return;
    picker = createColorPicker({ initialColor: displayColor, onChange: applyColor });
    panel.appendChild(picker.panel);
    picker.init();
  }
  function positionPanel() {
    const swatchRect = swatch.getBoundingClientRect();
    const panelH = panel.offsetHeight || 360, panelW = panel.offsetWidth || 220;
    let left = swatchRect.left;
    if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
    if (left < 8) left = 8;
    let top = swatchRect.top - panelH - 4;
    if (top < 8) top = swatchRect.bottom + 4;
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }

  // ── Toggle popover ──
  swatch.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = panel.style.display !== "none";
    document.querySelectorAll(".sbg-color-panel").forEach(p => { p.style.display = "none"; });
    if (!isOpen) {
      ensurePicker();
      panel.style.display = "block";
      requestAnimationFrame(positionPanel);
    }
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  const _docClick = () => { panel.style.display = "none"; };
  document.addEventListener("click", _docClick);

  wrap.appendChild(swatch);
  wrap.appendChild(text);
  document.body.appendChild(panel);
  // Remove the body-level panel + global listener when settings closes,
  // otherwise every settings open leaked another panel into the page.
  _gsCleanups.push(() => {
    document.removeEventListener("click", _docClick);
    if (picker) { try { picker.destroy(); } catch { } }
    panel.remove();
  });
  return _settingRow(label, wrap, tooltip);
}

function _comboInput(id, fallback, options, label, tooltip, callback) {
  const val = _readSetting(id, fallback);
  const sel = h("select", { class: "sbg-gs-select" }, options.map(o => h("option", { value: o, text: o })));
  sel.value = val;
  sel.addEventListener("change", () => { _writeSetting(id, sel.value); if (callback) callback(sel.value); });
  return _settingRow(label, sel, tooltip);
}

function _numberInput(id, fallback, label, tooltip) {
  const val = _readSetting(id, fallback);
  const inp = h("input", { type: "number", class: "sbg-gs-input sbg-gs-input--sm", value: String(val || fallback) });
  inp.addEventListener("change", () => _writeSetting(id, Number(inp.value)));
  return _settingRow(label, inp, tooltip);
}

// ── Tab Renderers ──


/* ── Layout Editor (extracted to sbg-layout-editor.js) ── */















function renderAppearance() {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Badge Colors" }));

  // Helper: create a live preview badge chip
  function _badgePreview(text, color) {
    return h("span", { text, style: `display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;color:#fff;background:${color};margin-right:4px;` });
  }

  // HIGH Badge with live preview
  const highBadge = _badgePreview("HIGH", _readSetting(S.BADGE_HIGH_COLOR, "#f87171") || "#f87171");
  const highRow = _colorInput(S.BADGE_HIGH_COLOR, "#f87171", "", "Color for HIGH/base KSampler and model badges", (c) => { highBadge.style.background = c; });
  const highLabel = highRow.querySelector(".sbg-gs-label");
  if (highLabel) { highLabel.innerHTML = ""; highLabel.appendChild(highBadge); highLabel.appendChild(document.createTextNode(" Badge")); }
  wrap.appendChild(highRow);

  // LOW Badge with live preview
  const lowBadge = _badgePreview("LOW", _readSetting(S.BADGE_LOW_COLOR, "#60a5fa") || "#60a5fa");
  const lowRow = _colorInput(S.BADGE_LOW_COLOR, "#60a5fa", "", "Color for LOW/refine KSampler and model badges", (c) => { lowBadge.style.background = c; });
  const lowLabel = lowRow.querySelector(".sbg-gs-label");
  if (lowLabel) { lowLabel.innerHTML = ""; lowLabel.appendChild(lowBadge); lowLabel.appendChild(document.createTextNode(" Badge")); }
  wrap.appendChild(lowRow);

  // Video Badge with live preview
  const vidBadge = _badgePreview("MP4", _readSetting(S.VIDEO_BADGE_COLOR, "#facc15") || "#facc15");
  vidBadge.style.color = "#000";
  const vidRow = _colorInput(S.VIDEO_BADGE_COLOR, "#facc15", "", "Color for the format badge on video thumbnails", (c) => { vidBadge.style.background = c; });
  const vidLabel = vidRow.querySelector(".sbg-gs-label");
  if (vidLabel) { vidLabel.innerHTML = ""; vidLabel.appendChild(vidBadge); vidLabel.appendChild(document.createTextNode(" Badge")); }
  wrap.appendChild(vidRow);

  // Search Tag Badge with live preview
  const searchBadge = _badgePreview("search", _readSetting(S.SEARCH_TAG_COLOR, "#6495ed") || "#6495ed");
  const searchRow = _colorInput(S.SEARCH_TAG_COLOR, "#6495ed", "", "Color for search tag badges in the search bar", (c) => { searchBadge.style.background = c; });
  const searchLabel = searchRow.querySelector(".sbg-gs-label");
  if (searchLabel) { searchLabel.innerHTML = ""; searchLabel.appendChild(searchBadge); searchLabel.appendChild(document.createTextNode(" Search Badge")); }
  wrap.appendChild(searchRow);

  // Negative Search Tag Badge with live preview
  const negBadge = _badgePreview("−exclude", _readSetting(S.SEARCH_TAG_NEG_COLOR, "#ef4444") || "#ef4444");
  const negRow = _colorInput(S.SEARCH_TAG_NEG_COLOR, "#ef4444", "", "Color for negative/exclude search tag badges", (c) => { negBadge.style.background = c; });
  const negLabel = negRow.querySelector(".sbg-gs-label");
  if (negLabel) { negLabel.innerHTML = ""; negLabel.appendChild(negBadge); negLabel.appendChild(document.createTextNode(" Exclude Badge")); }
  wrap.appendChild(negRow);

  // Search Highlight with live preview
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Highlight Color", style: "margin-top:16px" }));
  const hlColor = localStorage.getItem("SBG.GS.HighlightBg") || "rgba(250, 204, 21, 0.35)";
  const hlSample = h("span", { text: "Highlight", style: `background:${hlColor};padding:1px 4px;border-radius:2px;` });
  const hlRow = _colorInput("HighlightBg", "rgba(250, 204, 21, 0.35)", "", "Background color for search match highlighting in metadata panel", (c) => {
    localStorage.setItem("SBG.GS.HighlightBg", c);
    document.documentElement.style.setProperty("--sbg-highlight-bg", c);
    hlSample.style.background = c;
  });
  const hlLabel = hlRow.querySelector(".sbg-gs-label");
  if (hlLabel) { hlLabel.innerHTML = "Search "; hlLabel.appendChild(hlSample); }
  wrap.appendChild(hlRow);

  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Theme", style: "margin-top:16px" }));

  const customWrap = h("div", { class: "sbg-gs-form sbg-gs-custom-theme", style: _readSetting(S.THEME, "comfyui") === "custom" ? "display:block; margin-top:10px; padding:10px; background:rgba(0,0,0,0.15); border-radius:5px; border:1px solid var(--sbg-border)" : "display:none" });

  wrap.appendChild(_comboInput(S.THEME, "comfyui", ["comfyui", "dark", "blue", "midnight", "synthwave", "retro", "custom"], "Gallery Theme", "Color theme for the gallery sidebar", (val) => {
    const rootEl = document.querySelector(".sbg-root");
    if (rootEl) {
      if (val !== "comfyui") rootEl.setAttribute("data-theme", val);
      else rootEl.removeAttribute("data-theme");

      if (val === "custom") {
        rootEl.style.setProperty("--sbg-bg", _readSetting("CUSTOM_BG", "#1a1a1a"));
        rootEl.style.setProperty("--sbg-surface", _readSetting("CUSTOM_SURFACE", "#222222"));
        rootEl.style.setProperty("--sbg-border", _readSetting("CUSTOM_BORDER", "#444444"));
        rootEl.style.setProperty("--sbg-text", _readSetting("CUSTOM_TEXT", "#e0e0e0"));
        rootEl.style.setProperty("--sbg-accent", _readSetting("CUSTOM_ACCENT", "#7c6aef"));
      } else {
        rootEl.style.removeProperty("--sbg-bg");
        rootEl.style.removeProperty("--sbg-surface");
        rootEl.style.removeProperty("--sbg-border");
        rootEl.style.removeProperty("--sbg-text");
        rootEl.style.removeProperty("--sbg-accent");
      }
    }
    customWrap.style.display = val === "custom" ? "block" : "none";
  }));

  customWrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Configure your own custom UI colors." }));
  const applyVar = (v, c) => { if (_readSetting(S.THEME, "comfyui") === "custom") document.querySelector(".sbg-root")?.style.setProperty(v, c); };
  customWrap.appendChild(_colorInput("CUSTOM_BG", "#1a1a1a", "Background", "Base background color", (c) => applyVar("--sbg-bg", c)));
  customWrap.appendChild(_colorInput("CUSTOM_SURFACE", "#222222", "Surface", "Surface background color", (c) => applyVar("--sbg-surface", c)));
  customWrap.appendChild(_colorInput("CUSTOM_BORDER", "#444444", "Border elements", "Borders and dividers", (c) => applyVar("--sbg-border", c)));
  customWrap.appendChild(_colorInput("CUSTOM_TEXT", "#e0e0e0", "Text", "Main text color", (c) => applyVar("--sbg-text", c)));
  customWrap.appendChild(_colorInput("CUSTOM_ACCENT", "#7c6aef", "Accent", "Primary accent color", (c) => applyVar("--sbg-accent", c)));
  wrap.appendChild(customWrap);

  // Lightbox Button Colors with live preview buttons
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Lightbox Button Colors", style: "margin-top:16px" }));
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Leave blank for default colors." }));

  function _btnPreview(text, color) {
    return h("span", { text, style: `display:inline-block;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:500;color:#fff;background:${color || "var(--sbg-accent,#7c6aef)"};cursor:default;` });
  }

  const dlColor = _readSetting(S.LB_COLOR_DOWNLOAD, "") || "var(--sbg-accent,#7c6aef)";
  const dlBtn = _btnPreview("Download", dlColor);
  const dlRow = _colorInput(S.LB_COLOR_DOWNLOAD, "", "", "Background color for download button", (c) => { dlBtn.style.background = c || "var(--sbg-accent,#7c6aef)"; });
  const dlLabel = dlRow.querySelector(".sbg-gs-label");
  if (dlLabel) { dlLabel.innerHTML = ""; dlLabel.appendChild(dlBtn); }
  wrap.appendChild(dlRow);

  const cpColor = _readSetting(S.LB_COLOR_COPY_PROMPT, "") || "var(--sbg-accent,#7c6aef)";
  const cpBtn = _btnPreview("Copy Prompt", cpColor);
  const cpRow = _colorInput(S.LB_COLOR_COPY_PROMPT, "", "", "Background color for copy prompt button", (c) => { cpBtn.style.background = c || "var(--sbg-accent,#7c6aef)"; });
  const cpLabel = cpRow.querySelector(".sbg-gs-label");
  if (cpLabel) { cpLabel.innerHTML = ""; cpLabel.appendChild(cpBtn); }
  wrap.appendChild(cpRow);

  const cwColor = _readSetting(S.LB_COLOR_COPY_WF, "") || "var(--sbg-accent,#7c6aef)";
  const cwBtn = _btnPreview("Copy WF", cwColor);
  const cwRow = _colorInput(S.LB_COLOR_COPY_WF, "", "", "Background color for copy workflow button", (c) => { cwBtn.style.background = c || "var(--sbg-accent,#7c6aef)"; });
  const cwLabel = cwRow.querySelector(".sbg-gs-label");
  if (cwLabel) { cwLabel.innerHTML = ""; cwLabel.appendChild(cwBtn); }
  wrap.appendChild(cwRow);

  const lwColor = _readSetting(S.LB_COLOR_LOAD_WF, "") || "var(--sbg-accent,#7c6aef)";
  const lwBtn = _btnPreview("Load Workflow", lwColor);
  const lwRow = _colorInput(S.LB_COLOR_LOAD_WF, "", "", "Background color for load workflow button", (c) => { lwBtn.style.background = c || "var(--sbg-accent,#7c6aef)"; });
  const lwLabel = lwRow.querySelector(".sbg-gs-label");
  if (lwLabel) { lwLabel.innerHTML = ""; lwLabel.appendChild(lwBtn); }
  wrap.appendChild(lwRow);

  // Feature 3: App Badge Colors
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "App Badge Colors", style: "margin-top:16px" }));
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Customize the color of each source application badge. Leave blank for defaults." }));

  const _appBadges = [
    { key: S.APP_BADGE_COMFYUI, label: "ComfyUI", default: "#4ade80", cssVar: "--sbg-app-comfyui" },
    { key: S.APP_BADGE_A1111, label: "A1111", default: "#c084fc", cssVar: "--sbg-app-a1111" },
    { key: S.APP_BADGE_FORGE, label: "Forge", default: "#fdba74", cssVar: "--sbg-app-forge" },
    { key: S.APP_BADGE_SDNEXT, label: "SD.Next", default: "#5eead4", cssVar: "--sbg-app-sdnext" },
    { key: S.APP_BADGE_FOOOCUS, label: "Fooocus", default: "#f472b6", cssVar: "--sbg-app-fooocus" },
  ];

  for (const ab of _appBadges) {
    const badgeEl = _badgePreview(ab.label, _readSetting(ab.key, "") || ab.default);
    const row = _colorInput(ab.key, "", "", `Color for ${ab.label} source badge`, (c) => {
      const color = c || ab.default;
      badgeEl.style.background = color;
      document.documentElement.style.setProperty(ab.cssVar, color);
    });
    const label = row.querySelector(".sbg-gs-label");
    if (label) { label.innerHTML = ""; label.appendChild(badgeEl); }
    // Apply initial CSS custom property
    const saved = _readSetting(ab.key, "");
    if (saved) document.documentElement.style.setProperty(ab.cssVar, saved);
    wrap.appendChild(row);
  }

  // Feature 4: Initial Image Tab Color
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Initial Image Tab", style: "margin-top:16px" }));
  const initTabBadge = _badgePreview("Initial Image", _readSetting(S.INITIAL_IMAGE_TAB_COLOR, "") || "#94a3b8");
  const initTabRow = _colorInput(S.INITIAL_IMAGE_TAB_COLOR, "#94a3b8", "", "Color for the Initial Image tab button in the lightbox metadata panel", (c) => {
    initTabBadge.style.background = c || "#94a3b8";
  });
  const initTabLabel = initTabRow.querySelector(".sbg-gs-label");
  if (initTabLabel) { initTabLabel.innerHTML = ""; initTabLabel.appendChild(initTabBadge); }
  wrap.appendChild(initTabRow);

  // Pill/Badge Colors
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Pill / Badge Colors", style: "margin-top:16px" }));
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Customize the color of metadata pills and badges. Leave empty for defaults." }));
  const pillPreview = _badgePreview("Example Pill", _readSetting(S.PILL_BG_COLOR, "") || "rgba(255,255,255,0.06)");
  pillPreview.style.color = _readSetting(S.PILL_TEXT_COLOR, "") || "rgba(255,255,255,0.8)";
  pillPreview.style.border = `1px solid ${_readSetting(S.PILL_BORDER_COLOR, "") || "rgba(255,255,255,0.08)"}`;
  const pillBgRow = _colorInput(S.PILL_BG_COLOR, "rgba(255,255,255,0.06)", "Background", "Pill background color", (c) => {
    pillPreview.style.background = c || "rgba(255,255,255,0.06)";
    if (c) document.documentElement.style.setProperty("--sbg-pill-bg", c);
    else document.documentElement.style.removeProperty("--sbg-pill-bg");
  }, "bg");
  const pillTextRow = _colorInput(S.PILL_TEXT_COLOR, "rgba(255,255,255,0.8)", "Text", "Pill text color", (c) => {
    pillPreview.style.color = c || "rgba(255,255,255,0.8)";
    if (c) document.documentElement.style.setProperty("--sbg-pill-text", c);
    else document.documentElement.style.removeProperty("--sbg-pill-text");
  }, "text");
  const pillBorderRow = _colorInput(S.PILL_BORDER_COLOR, "rgba(255,255,255,0.08)", "Border", "Pill border color", (c) => {
    pillPreview.style.border = `1px solid ${c || "rgba(255,255,255,0.08)"}`;
    if (c) document.documentElement.style.setProperty("--sbg-pill-border", c);
    else document.documentElement.style.removeProperty("--sbg-pill-border");
  }, "border");
  const pillPreviewRow = h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" });
  pillPreviewRow.appendChild(h("span", { class: "sbg-gs-label", text: "Preview:", style: "font-size:11px;opacity:0.6" }));
  pillPreviewRow.appendChild(pillPreview);
  wrap.appendChild(pillPreviewRow);
  wrap.appendChild(pillBgRow);
  wrap.appendChild(pillTextRow);
  wrap.appendChild(pillBorderRow);

  content.appendChild(wrap);
}

function renderKeybindings() {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Keyboard Shortcuts" }));
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Comma-separated key names. Example: ArrowLeft,a" }));
  wrap.appendChild(_textInput(S.KEY_PREV, "ArrowLeft,a", "Previous Image", "Keys for previous image in lightbox"));
  wrap.appendChild(_textInput(S.KEY_NEXT, "ArrowRight,d", "Next Image", "Keys for next image in lightbox"));
  wrap.appendChild(_textInput(S.KEY_CLOSE, "Escape", "Close Lightbox", "Key to close lightbox"));
  wrap.appendChild(_textInput(S.KEY_TOGGLE, "z,0", "Toggle Gallery", "Keys to open/close the gallery sidebar"));
  wrap.appendChild(_textInput(S.KEY_REFRESH, "", "Refresh Gallery", "Key to refresh gallery (leave empty to disable)"));

  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Lightbox Actions", style: "margin-top:16px" }));
  wrap.appendChild(_textInput(S.KEY_FULLSCREEN, "f", "Fullscreen", "Toggle fullscreen in lightbox"));
  wrap.appendChild(_textInput(S.KEY_DOWNLOAD, "", "Download", "Download current file (leave empty to disable)"));
  wrap.appendChild(_textInput(S.KEY_COPY_PROMPT, "", "Copy Prompt", "Copy positive prompt (leave empty to disable)"));
  wrap.appendChild(_textInput(S.KEY_COPY_WF, "", "Copy Workflow", "Copy workflow JSON (leave empty to disable)"));
  wrap.appendChild(_textInput(S.KEY_LOAD_WF, "", "Load Workflow", "Load workflow into ComfyUI (leave empty to disable)"));

  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Note: Arrows seek video in fullscreen. A/D always navigate." }));
  content.appendChild(wrap);
}

function renderSettings() {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });

  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Gallery" }));
  wrap.appendChild(_numberInput(S.THUMB_SIZE, 110, "Thumbnail Size (px)", "Size of thumbnail grid cells (64-256). Only used when Items Per Row is 'auto' — it decides how many columns fit."));
  wrap.appendChild(_comboInput(S.THUMB_PER_ROW, "auto", ["auto", "1", "2", "3", "4", "5", "6", "8", "10"], "Items Per Row", "auto = fit as many as the Thumbnail Size allows. A number = ALWAYS that many per row; thumbnails are sized to fill the row based on their aspect ratios. Reopen the gallery to apply."));
  wrap.appendChild(_comboInput(S.THUMB_SHAPE, "square", ["square", "ar"], "Thumbnail Shape", "Square crops; AR preserves aspect ratio"));
  // Normalize a legacy stored sort value so the combo shows the right selection
  // (the gallery itself aliases these too).
  {
    const _sortAlias = { newest: "created_desc", oldest: "created_asc" };
    const _cur = _readSetting(S.SORT, "created_desc");
    if (_sortAlias[_cur]) _writeSetting(S.SORT, _sortAlias[_cur]);
  }
  wrap.appendChild(_comboInput(S.SORT, "created_desc",
    ["created_desc", "created_asc", "modified_desc", "modified_asc", "name_asc", "name_desc", "size_desc", "size_asc"],
    "Default Sort", "Default sort order for gallery items (matches the gallery's sort menu)"));
  wrap.appendChild(_numberInput(S.VSCROLL_BUFFER, 8, "Scroll Buffer (rows)", "Extra rows pre-rendered above/below viewport (2-30). Higher = less blank space on fast scroll, but more DOM nodes."));

  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Tooltips", style: "margin-top:16px" }));
  wrap.appendChild(_toggle(S.TOOLTIP_NAME, true, "Show Filename", "Show filename in card tooltip"));
  wrap.appendChild(_toggle(S.TOOLTIP_SIZE, true, "Show File Size", "Show file size in card tooltip"));
  wrap.appendChild(_toggle(S.TOOLTIP_DATE, true, "Show Date", "Show date in card tooltip"));

  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Lightbox Buttons", style: "margin-top:16px" }));
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Show or hide individual buttons in the lightbox toolbar." }));
  wrap.appendChild(_toggle(S.LB_SHOW_DOWNLOAD, true, "Download Button", "Show download button in lightbox"));
  wrap.appendChild(_toggle(S.LB_SHOW_COPY_PROMPT, true, "Copy Prompt Button", "Show copy prompt button in lightbox"));
  wrap.appendChild(_toggle(S.LB_SHOW_COPY_WF, true, "Copy WF Button", "Show copy workflow button in lightbox"));
  wrap.appendChild(_toggle(S.LB_SHOW_LOAD_WF, true, "Load Workflow Button", "Show load workflow button in lightbox"));

  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Metadata", style: "margin-top:16px" }));
  wrap.appendChild(_comboInput(S.PROMPT_VIEW, "remember", ["enhanced", "initial", "remember"], "Default Tab View", "Which tab opens first in tabbed sections. For prompt sections this picks Enhanced or Original; 'Remember' keeps your last-opened tab on every tabbed section."));
  wrap.appendChild(_comboInput(S.PROMPT_PADDING, "6", ["0", "1", "2", "3", "4", "5", "6", "8", "10", "12"], "Prompt Padding", "Horizontal padding inside prompt text boxes (in px); top/bottom run 2px tighter.", (v) => {
    document.documentElement.style.setProperty("--sbg-prompt-padding", v + "px");
  }));
  wrap.appendChild(_comboInput(S.FILENAME_STYLE, "basename", ["basename", "relpath"], "Filename Display", "Show just the filename or the full relative path in File Info."));
  wrap.appendChild(_comboInput(S.MODEL_NAME_STYLE, "basename", ["basename", "relpath"], "Model Display", "Show model and LoRA names as just the filename (basename) or the full relative path."));
  wrap.appendChild(_toggle(S.META_TAB_PERSIST, false, "Remember Metadata Tab", "Keep the active metadata tab (Generated/Initial Image) when navigating between images."));

  // ── Folders: extra media roots shown in the folder picker and indexed ──
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Folders", style: "margin-top:16px" }));
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Extra folders to browse and index alongside ComfyUI's output folder. Paths are on the machine running ComfyUI." }));
  const foldersList = h("div", {});
  wrap.appendChild(foldersList);

  async function _postRoots(extraRoots) {
    const r = await fetch("/sidebar_gallery/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extra_roots: extraRoots }),
    });
    return r.json();
  }

  async function _renderFolders() {
    foldersList.innerHTML = "";
    let cfg = { extra_roots: [], roots: [] };
    try { cfg = await fetch("/sidebar_gallery/config").then(r => r.json()); } catch { }
    const row = (label, sub, removeRaw) => {
      const el = h("div", { class: "sbg-gs-row", style: "align-items:center" });
      el.appendChild(h("span", { class: "sbg-gs-label", text: label, title: sub || "" }));
      if (sub) el.appendChild(h("span", { style: "opacity:.55;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%", text: sub }));
      if (removeRaw != null) {
        const del = h("button", { class: "sbg-iconbtn sbg-iconbtn--danger", text: "🗑", title: "Remove this folder from the gallery (files on disk are not touched)" });
        del.addEventListener("click", async () => {
          try {
            await _postRoots(cfg.extra_roots.filter(p => p !== removeRaw));
            showToast("Folder removed");
            if (galleryCtx.refreshConfig) await galleryCtx.refreshConfig();
            _renderFolders();
          } catch (e) { showToast("Failed to remove folder: " + (e?.message || e)); }
        });
        el.appendChild(del);
      } else {
        el.appendChild(h("span", { style: "opacity:.4;font-size:11px", text: "built-in" }));
      }
      return el;
    };
    foldersList.appendChild(row("Output", "ComfyUI's output folder", null));
    for (const p of cfg.extra_roots || []) foldersList.appendChild(row(p.split(/[\\/]/).pop() || p, p, p));

    const addWrap = h("div", { class: "sbg-gs-row", style: "align-items:center;gap:6px" });
    const inp = h("input", { type: "text", class: "sbg-gs-input", placeholder: "C:\\path\\to\\folder", style: "flex:1" });
    const addBtn = h("button", { class: "sbg-btn sbg-btn--accent", text: "+ Add" });
    const doAdd = async () => {
      const p = inp.value.trim();
      if (!p) return;
      try {
        const res = await _postRoots([...(cfg.extra_roots || []), p]);
        const added = (res.extra_roots || []).length > (cfg.extra_roots || []).length;
        if (!added) { showToast("Folder not added — check the path exists on the ComfyUI machine"); return; }
        showToast("Folder added — it will be indexed when you open it");
        inp.value = "";
        if (galleryCtx.refreshConfig) await galleryCtx.refreshConfig();
        _renderFolders();
      } catch (e) { showToast("Failed to add folder: " + (e?.message || e)); }
    };
    addBtn.addEventListener("click", doAdd);
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") doAdd(); });
    addWrap.appendChild(inp);
    addWrap.appendChild(addBtn);
    foldersList.appendChild(addWrap);
  }
  _renderFolders();

  content.appendChild(wrap);
}

function renderPresets() {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Presets" }));
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Save and load gallery configuration presets." }));

  // Current presets list
  const PRESETS_KEY = "SBG.Presets";
  let presets = [];
  try { presets = JSON.parse(localStorage.getItem(PRESETS_KEY)) || []; } catch { }

  // Save options: checkboxes for what to include
  const saveChecks = h("div", { class: "sbg-gs-preset-checks" });
  const incLayout = h("input", { type: "checkbox" }); incLayout.checked = true;
  const incColors = h("input", { type: "checkbox" }); incColors.checked = true;
  const incSettings = h("input", { type: "checkbox" }); incSettings.checked = true;
  const incKeys = h("input", { type: "checkbox" }); incKeys.checked = true;
  saveChecks.appendChild(h("label", {}, [incLayout, document.createTextNode(" Layout")]));
  saveChecks.appendChild(h("label", {}, [incColors, document.createTextNode(" Colors")]));
  saveChecks.appendChild(h("label", {}, [incSettings, document.createTextNode(" Settings")]));
  saveChecks.appendChild(h("label", {}, [incKeys, document.createTextNode(" Keybindings")]));
  wrap.appendChild(saveChecks);

  // Save button
  const nameInput = h("input", { type: "text", class: "sbg-gs-input", placeholder: "Preset name" });
  const saveBtn = h("button", { class: "sbg-btn sbg-btn--accent", text: "💾 Save Preset" });
  saveBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) { showToast("Enter a preset name"); return; }
    const preset = { name, created: Date.now() };
    if (incLayout.checked) {
      // CURRENT layout system: the per-app × per-media section profiles
      // ("SBG.Layouts", translation layer). Without this, presets silently
      // saved only legacy keys the panel no longer reads.
      preset.layouts = getSetting("SBG.Layouts", null);
      // Legacy keys still captured for back-compat with old installs.
      try { preset.layout = JSON.parse(localStorage.getItem("SBG.Layout")); } catch { }
      try { preset.layoutRenames = JSON.parse(localStorage.getItem("SBG.LayoutRenames")); } catch { }
    }
    if (incColors.checked) {
      preset.colors = {
        high: _readSetting(S.BADGE_HIGH_COLOR, "#f87171"),
        low: _readSetting(S.BADGE_LOW_COLOR, "#60a5fa"),
        video: _readSetting(S.VIDEO_BADGE_COLOR, "#facc15"),
        highlight: localStorage.getItem("SBG.GS.HighlightBg") || "",
      };
    }
    if (incSettings.checked) {
      preset.settings = {};
      for (const [k, id] of Object.entries(S)) {
        if (k.startsWith("KEY_")) continue; // keybindings separate
        preset.settings[id] = _readSetting(id, null);
      }
    }
    if (incKeys.checked) {
      preset.keys = {};
      for (const [k, id] of Object.entries(S)) {
        if (k.startsWith("KEY_")) preset.keys[id] = _readSetting(id, "");
      }
    }
    presets = presets.filter(p => p.name !== name);
    presets.unshift(preset);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    showToast(`Preset "${name}" saved`);
    renderPresets(); // refresh list
  });
  const saveRow = h("div", { class: "sbg-gs-preset-save" }, [nameInput, saveBtn]);
  wrap.appendChild(saveRow);

  // Preset list
  if (presets.length > 0) {
    wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Saved Presets", style: "margin-top:16px" }));
    for (const p of presets) {
      const row = h("div", { class: "sbg-gs-preset-item" });
      row.appendChild(h("span", { class: "sbg-gs-preset-name", text: p.name }));
      const loadBtn = h("button", { class: "sbg-btn sbg-btn--accent sbg-btn--sm", text: "Load" });
      let loadConfirm = false;
      loadBtn.addEventListener("click", () => {
        if (!loadConfirm) {
          loadConfirm = true;
          loadBtn.textContent = "Sure?";
          loadBtn.style.background = "var(--sbg-danger)";
          setTimeout(() => { loadConfirm = false; loadBtn.textContent = "Load"; loadBtn.style.background = ""; }, 2000);
          return;
        }
        // Current layout system (per-app/per-media profiles)
        if (p.layouts) {
          saveSetting("SBG.Layouts", p.layouts);
          document.dispatchEvent(new CustomEvent("sbg-layout-changed"));
        }
        // Legacy keys (older preset files)
        if (p.sectionOrder) localStorage.setItem(_sectionOrderKey, JSON.stringify(p.sectionOrder));
        if (p.layout) localStorage.setItem("SBG.Layout", JSON.stringify(p.layout));
        if (p.layoutRenames) localStorage.setItem("SBG.LayoutRenames", JSON.stringify(p.layoutRenames));
        if (p.hiddenSections) localStorage.setItem("SBG.GS.HiddenSections", JSON.stringify(p.hiddenSections));
        if (p.colors) {
          _writeSetting(S.BADGE_HIGH_COLOR, p.colors.high);
          _writeSetting(S.BADGE_LOW_COLOR, p.colors.low);
          _writeSetting(S.VIDEO_BADGE_COLOR, p.colors.video);
          if (p.colors.highlight) localStorage.setItem("SBG.GS.HighlightBg", p.colors.highlight);
        }
        if (p.settings) {
          for (const [id, val] of Object.entries(p.settings)) {
            if (val !== null) _writeSetting(id, val);
          }
        }
        if (p.keys) {
          for (const [id, val] of Object.entries(p.keys)) _writeSetting(id, val);
        }
        showToast(`Preset "${p.name}" loaded. Refresh gallery to apply.`);
      });
      const delBtn = h("button", { class: "sbg-btn sbg-btn--danger sbg-btn--sm", text: "✕" });
      let delConfirm = false;
      delBtn.addEventListener("click", () => {
        if (!delConfirm) {
          delConfirm = true;
          delBtn.textContent = "Sure?";
          setTimeout(() => { delConfirm = false; delBtn.textContent = "✕"; }, 2000);
          return;
        }
        presets = presets.filter(x => x.name !== p.name);
        localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
        renderPresets();
      });
      const expBtn = h("button", { class: "sbg-btn sbg-btn--sm", text: "📤" });
      expBtn.addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = h("a", { href: url, download: `${p.name}.json` });
        a.click();
        URL.revokeObjectURL(url);
      });
      row.appendChild(loadBtn);
      row.appendChild(expBtn);
      row.appendChild(delBtn);
      wrap.appendChild(row);
    }
  }

  // Import button
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Import", style: "margin-top:16px" }));
  const importBtn = h("button", { class: "sbg-btn", text: "📥 Import Preset" });
  importBtn.addEventListener("click", () => {
    const fi = h("input", { type: "file", accept: ".json" });
    fi.addEventListener("change", async () => {
      if (!fi.files.length) return;
      try {
        const text = await fi.files[0].text();
        const p = JSON.parse(text);
        if (!p.name) { showToast("Invalid preset file"); return; }
        presets = presets.filter(x => x.name !== p.name);
        presets.unshift(p);
        localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
        showToast(`Preset "${p.name}" imported`);
        renderPresets();
      } catch (e) { showToast(`Import error: ${e.message}`); }
    });
    fi.click();
  });
  wrap.appendChild(importBtn);

  // D4: Server-side themes (from themes/ subfolder)
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Server Themes", style: "margin-top:16px" }));
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Presets stored in the extension's themes/ folder. Persist across reinstalls." }));
  const serverList = h("div", { class: "sbg-gs-preset-list" });
  serverList.textContent = "Loading...";
  wrap.appendChild(serverList);

  // Fetch server presets
  fetch("/sidebar_gallery/presets").then(r => r.json()).then(data => {
    serverList.innerHTML = "";
    if (!data.presets || data.presets.length === 0) {
      serverList.textContent = "No server themes found.";
      return;
    }
    for (const sp of data.presets) {
      const row = h("div", { class: "sbg-gs-preset-item" });
      row.appendChild(h("span", { class: "sbg-gs-preset-name", text: sp.name }));
      const loadBtn = h("button", { class: "sbg-btn sbg-btn--accent sbg-btn--sm", text: "Load" });
      let loadServerConfirm = false;
      loadBtn.addEventListener("click", async () => {
        if (!loadServerConfirm) {
          loadServerConfirm = true;
          loadBtn.textContent = "Sure?";
          loadBtn.style.background = "var(--sbg-danger)";
          setTimeout(() => { loadServerConfirm = false; loadBtn.textContent = "Load"; loadBtn.style.background = ""; }, 2000);
          return;
        }
        try {
          const resp = await fetch(`/sidebar_gallery/preset?filename=${encodeURIComponent(sp.filename)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const p = await resp.json();
          // Apply preset (same logic as local presets)
          if (p.layouts) {
            saveSetting("SBG.Layouts", p.layouts);
            document.dispatchEvent(new CustomEvent("sbg-layout-changed"));
          }
          if (p.sectionOrder) localStorage.setItem(_sectionOrderKey, JSON.stringify(p.sectionOrder));
          if (p.layout) localStorage.setItem("SBG.Layout", JSON.stringify(p.layout));
          if (p.layoutRenames) localStorage.setItem("SBG.LayoutRenames", JSON.stringify(p.layoutRenames));
          if (p.hiddenSections) localStorage.setItem("SBG.GS.HiddenSections", JSON.stringify(p.hiddenSections));
          if (p.colors) {
            _writeSetting(S.BADGE_HIGH_COLOR, p.colors.high);
            _writeSetting(S.BADGE_LOW_COLOR, p.colors.low);
            _writeSetting(S.VIDEO_BADGE_COLOR, p.colors.video);
            if (p.colors.highlight) localStorage.setItem("SBG.GS.HighlightBg", p.colors.highlight);
          }
          if (p.settings) {
            for (const [id, val] of Object.entries(p.settings)) {
              if (val !== null) _writeSetting(id, val);
            }
          }
          if (p.keys) {
            for (const [id, val] of Object.entries(p.keys)) _writeSetting(id, val);
          }
          showToast(`Server theme "${sp.name}" loaded. Refresh gallery to apply.`);
        } catch (e) { showToast("Error loading theme: " + e.message); }
      });
      const delBtn = h("button", { class: "sbg-btn sbg-btn--danger sbg-btn--sm", text: "\u2715" });
      let delServerConfirm = false;
      delBtn.addEventListener("click", async () => {
        if (!delServerConfirm) {
          delServerConfirm = true;
          delBtn.textContent = "Sure?";
          setTimeout(() => { delServerConfirm = false; delBtn.textContent = "\u2715"; }, 2000);
          return;
        }
        await fetch("/sidebar_gallery/presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", name: sp.name }),
        });
        renderPresets();
      });
      row.appendChild(loadBtn);
      row.appendChild(delBtn);
      serverList.appendChild(row);
    }
  }).catch(() => { serverList.textContent = "Could not load server themes."; });

  // Save to server button
  const saveServerBtn = h("button", { class: "sbg-btn", text: "💾 Save to Server", style: "margin-top:8px" });
  saveServerBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast("Enter a preset name first"); return; }
    const preset = { name, created: Date.now() };
    if (incLayout.checked) {
      // CURRENT layout system: the per-app × per-media section profiles
      // ("SBG.Layouts", translation layer). Without this, presets silently
      // saved only legacy keys the panel no longer reads.
      preset.layouts = getSetting("SBG.Layouts", null);
      // Legacy keys still captured for back-compat with old installs.
      try { preset.layout = JSON.parse(localStorage.getItem("SBG.Layout")); } catch { }
      try { preset.layoutRenames = JSON.parse(localStorage.getItem("SBG.LayoutRenames")); } catch { }
    }
    if (incColors.checked) {
      preset.colors = {
        high: _readSetting(S.BADGE_HIGH_COLOR, "#f87171"),
        low: _readSetting(S.BADGE_LOW_COLOR, "#60a5fa"),
        video: _readSetting(S.VIDEO_BADGE_COLOR, "#facc15"),
        highlight: localStorage.getItem("SBG.GS.HighlightBg") || "",
      };
    }
    if (incSettings.checked) {
      preset.settings = {};
      for (const [k, id] of Object.entries(S)) {
        if (k.startsWith("KEY_")) continue;
        preset.settings[id] = _readSetting(id, null);
      }
    }
    if (incKeys.checked) {
      preset.keys = {};
      for (const [k, id] of Object.entries(S)) {
        if (k.startsWith("KEY_")) preset.keys[id] = _readSetting(id, "");
      }
    }
    try {
      await fetch("/sidebar_gallery/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name, data: preset }),
      });
      showToast(`Theme "${name}" saved to server`);
      renderPresets();
    } catch (e) { showToast("Error saving to server: " + e.message); }
  });
  wrap.appendChild(saveServerBtn);

  content.appendChild(wrap);
}

function renderDiagnosticsTab() {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });
  wrap.appendChild(h("div", { class: "sbg-gs-section-title", text: "Diagnostics & Tools" }));

  const actionRow = h("div", { style: "display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap" });

  // Feature 7: Refresh Gallery button
  const diagGalleryRefreshBtn = h("button", { class: "sbg-btn sbg-btn--accent", text: "🔃 Refresh", title: "Re-fetch all items from the server and refresh the gallery view" });
  diagGalleryRefreshBtn.addEventListener("click", async () => {
    diagGalleryRefreshBtn.disabled = true;
    diagGalleryRefreshBtn.textContent = "Refreshing…";
    try {
      await galleryCtx.fetchAllItems({ rescan: true });
      showToast("Gallery refreshed");
      await refreshDiagStats(diagStatsContainer);
    } catch (e) {
      showToast(`Error: ${e?.message || e}`);
    } finally {
      diagGalleryRefreshBtn.disabled = false;
      diagGalleryRefreshBtn.textContent = "🔃 Refresh";
    }
  });

  // Feature 7: Rebuild DB Index with two-click confirmation
  const diagRefreshBtn = h("button", { class: "sbg-btn sbg-btn--accent", text: "🔄 Rebuild DB Index", title: "Rescan all roots and rebuild metadata/tag index on server" });
  let _rebuildConfirm = false;
  diagRefreshBtn.addEventListener("click", async () => {
    if (!_rebuildConfirm) {
      _rebuildConfirm = true;
      diagRefreshBtn.textContent = "Sure?";
      diagRefreshBtn.style.background = "#f59e0b"; diagRefreshBtn.style.color = "#000";
      setTimeout(() => { _rebuildConfirm = false; diagRefreshBtn.textContent = "🔄 Rebuild DB Index"; diagRefreshBtn.style.background = ""; diagRefreshBtn.style.color = ""; }, 2000);
      return;
    }
    diagRefreshBtn.disabled = true;
    diagRefreshBtn.style.background = ""; diagRefreshBtn.style.color = "";
    diagRefreshBtn.textContent = "🔄 Rebuilding DB... (0%)";
    try {
      await fetch("/sidebar_gallery/rebuild_index", { method: "POST" });
    } catch { }

    const poll = setInterval(async () => {
      try {
        const r = await fetch("/sidebar_gallery/reindex_progress");
        const p = await r.json();
        if (p.total > 0) {
          const pct = Math.round((p.done / p.total) * 100);
          diagRefreshBtn.textContent = `🔄 Rebuilding DB... (${pct}%)`;
        }
        if (!p.running) {
          clearInterval(poll);
          diagRefreshBtn.textContent = "🔄 DB Indexed Successfully!";
          setTimeout(() => {
            diagRefreshBtn.disabled = false;
            diagRefreshBtn.textContent = "🔄 Rebuild DB Index";
          }, 3000);
          // (A stray loadSubfolders() call here used to throw — it only exists
          // inside the gallery — silently skipping both refreshes below.)
          galleryCtx.fetchAllItems({ rescan: true });
          refreshDiagStats(diagStatsContainer);
        }
      } catch { }
    }, 1000);
  });

  const diagCacheMetaBtn = h("button", { class: "sbg-btn", text: "📦 Cache All Metadata", title: "Fetch and cache metadata summaries for all files to IndexedDB" });
  diagCacheMetaBtn.addEventListener("click", async () => {
    diagCacheMetaBtn.disabled = true;
    diagCacheMetaBtn.textContent = "Caching…";
    try {
      const items = galleryCtx.allItems || [];
      let cached = 0;
      const batch = [];
      for (const it of items) {
        const key = `${it.root_id}:${it.relpath}`;
        if (_metaCache.has(key)) { cached++; continue; }
        try {
          const m = await api("/sidebar_gallery/metadata", { root_id: it.root_id, relpath: it.relpath, summary_only: "1" });
          _metaCache.set(key, m);
          batch.push({ key, value: m });
          cached++;
          if (cached % 50 === 0) {
            diagCacheMetaBtn.textContent = `Caching… ${cached}/${items.length}`;
            if (batch.length >= 50) { await _metaCacheAPI.putBatch(batch.splice(0)); }
          }
        } catch { cached++; }
      }
      if (batch.length) await _metaCacheAPI.putBatch(batch);
      diagCacheMetaBtn.textContent = "📦 Cache All Metadata";
      diagCacheMetaBtn.disabled = false;
      showToast(`Metadata cached: ${cached} items`);
      await refreshDiagStats(diagStatsContainer);
    } catch (e) {
      diagCacheMetaBtn.textContent = "📦 Cache All Metadata";
      diagCacheMetaBtn.disabled = false;
      showToast(`Error: ${e?.message || e}`);
    }
  });

  const diagCacheThumbBtn = h("button", { class: "sbg-btn", text: "🖼️ Cache Thumbnails", title: "Cache all lazy-load thumbnails into the local browser IndexedDB" });
  diagCacheThumbBtn.addEventListener("click", async () => {
    diagCacheThumbBtn.disabled = true;
    diagCacheThumbBtn.textContent = "Caching…";
    try {
      const items = galleryCtx.allItems || [];
      let cached = 0;
      for (const it of items) {
        if (!it.thumb_url) continue;
        const existing = await _thumbCacheAPI.tryGet(it.thumb_url);
        if (existing) { URL.revokeObjectURL(existing); cached++; continue; }
        try {
          await _thumbCacheAPI.getOrFetch(it.thumb_url);
          cached++;
          if (cached % 20 === 0) {
            diagCacheThumbBtn.textContent = `Caching… ${cached}/${items.length}`;
          }
        } catch { cached++; }
      }
      diagCacheThumbBtn.textContent = "🖼️ Cache Thumbnails";
      diagCacheThumbBtn.disabled = false;
      showToast(`Thumbnails cached: ${cached} items`);
      await refreshDiagStats(diagStatsContainer);
    } catch (e) {
      diagCacheThumbBtn.textContent = "🖼️ Cache Thumbnails";
      diagCacheThumbBtn.disabled = false;
      showToast(`Error: ${e?.message || e}`);
    }
  });

  const diagClearMetaBtn = h("button", { class: "sbg-btn sbg-btn--danger", text: "🗑️ Clear Meta Cache", title: "Clear browser IndexedDB metadata cache" });
  let clearMetaConfirm = false;
  diagClearMetaBtn.addEventListener("click", async () => {
    if (!clearMetaConfirm) {
      clearMetaConfirm = true;
      diagClearMetaBtn.textContent = "Sure?";
      diagClearMetaBtn.style.background = "#f59e0b"; diagClearMetaBtn.style.color = "#000";
      setTimeout(() => { clearMetaConfirm = false; diagClearMetaBtn.textContent = "🗑️ Clear Meta Cache"; diagClearMetaBtn.style.background = ""; diagClearMetaBtn.style.color = ""; }, 2000);
      return;
    }
    try {
      await _metaCacheAPI.clear();
      _metaCache.clear();
      showToast("Metadata cache cleared");
      await refreshDiagStats(diagStatsContainer);
    } catch (e) { showToast("Error clearing meta cache: " + e.message); }
  });

  const diagClearThumbBtn = h("button", { class: "sbg-btn sbg-btn--danger", text: "🗑️ Clear Thumb Cache", title: "Clear browser IndexedDB thumbnails cache" });
  let clearThumbConfirm = false;
  diagClearThumbBtn.addEventListener("click", async () => {
    if (!clearThumbConfirm) {
      clearThumbConfirm = true;
      diagClearThumbBtn.textContent = "Sure?";
      diagClearThumbBtn.style.background = "#f59e0b"; diagClearThumbBtn.style.color = "#000";
      setTimeout(() => { clearThumbConfirm = false; diagClearThumbBtn.textContent = "🗑️ Clear Thumb Cache"; diagClearThumbBtn.style.background = ""; diagClearThumbBtn.style.color = ""; }, 2000);
      return;
    }
    try {
      await _thumbCacheAPI.clear();
      // Also drop the in-memory blob cache and the failed-URL blacklist —
      // without this, "broken" thumbnails (e.g. requests that timed out
      // during a DB rebuild) stayed broken even after clearing the cache.
      for (const [url, blobUrl] of [..._thumbMemCache]) {
        // Don't revoke blobs still shown by a visible card.
        try {
          if (!document.querySelector(`img.sbg-card__thumb[src="${blobUrl}"]`)) URL.revokeObjectURL(blobUrl);
        } catch { }
        _thumbMemCache.delete(url);
      }
      resetFailedThumbs();
      showToast("Thumbnails cache cleared");
      await refreshDiagStats(diagStatsContainer);
    } catch (e) { showToast("Error clearing thumb cache: " + e.message); }
  });

  // Nuclear option: delete entire IDB database + clear version tracking
  const diagNukeBtn = h("button", { class: "sbg-btn sbg-btn--danger", text: "💣 Nuclear Clear All", title: "Delete ALL browser cache databases (including legacy), reset version tracking, clean up old settings keys, and reload. Fixes any corruption." });
  let nukeConfirm = false;
  diagNukeBtn.addEventListener("click", () => {
    if (!nukeConfirm) {
      nukeConfirm = true;
      diagNukeBtn.textContent = "⚠️ Sure? This will reload the page";
      diagNukeBtn.style.background = "#ef4444"; diagNukeBtn.style.color = "#fff";
      setTimeout(() => { nukeConfirm = false; diagNukeBtn.textContent = "💣 Nuclear Clear All"; diagNukeBtn.style.background = ""; diagNukeBtn.style.color = ""; }, 3000);
      return;
    }
    // Nuke IDB: current + legacy databases
    try { _resetIdb(); } catch (e) { /* ignore */ }
    try { indexedDB.deleteDatabase("sbg-cache"); } catch (e) { /* ignore */ }
    try { indexedDB.deleteDatabase("sbg-gallery-cache"); } catch (e) { /* ignore */ }

    // Nuke localStorage: version tracking + legacy SBGGS.* keys
    localStorage.removeItem("SBG._dbVersion");
    localStorage.removeItem("SBG._cacheEpoch");
    // Clean up legacy settings keys (old system used SBGGS.* prefix)
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("SBGGS.")) keysToRemove.push(k);
    }
    for (const k of keysToRemove) localStorage.removeItem(k);

    _metaCache.clear();
    showToast(`All caches cleared (${keysToRemove.length} legacy keys removed). Reloading…`);
    setTimeout(() => location.reload(true), 500);
  });

  actionRow.appendChild(diagGalleryRefreshBtn);
  actionRow.appendChild(diagRefreshBtn);
  actionRow.appendChild(diagCacheMetaBtn);
  actionRow.appendChild(diagCacheThumbBtn);
  actionRow.appendChild(diagClearThumbBtn);
  actionRow.appendChild(diagClearMetaBtn);
  actionRow.appendChild(diagNukeBtn);
  wrap.appendChild(actionRow);

  const diagStatsContainer = h("div", { class: "sbg-diag-stats" });
  wrap.appendChild(diagStatsContainer);
  content.appendChild(wrap);

  refreshDiagStats(diagStatsContainer);
}

// Tab switching
const TAB_RENDERERS = { layout: () => renderLayout(content, galleryCtx, closeGS), appearance: renderAppearance, keybindings: renderKeybindings, settings: renderSettings, presets: renderPresets, diagnostics: renderDiagnosticsTab };
for (const btn of tabBtns) {
  btn.addEventListener("click", () => {
    tabBtns.forEach(b => b.classList.remove("sbg-gs-tab--active"));
    btn.classList.add("sbg-gs-tab--active");
    TAB_RENDERERS[btn.dataset.tab]?.();
  });
}
// Default: start on requested tab using string param
const defaultBtn = [...tabBtns].find(b => b.dataset.tab === defaultTab) || tabBtns[0];
defaultBtn.classList.add("sbg-gs-tab--active");
if (TAB_RENDERERS[defaultTab]) {
  TAB_RENDERERS[defaultTab]();
} else {
  renderLayout(content, galleryCtx, closeGS);
}
}