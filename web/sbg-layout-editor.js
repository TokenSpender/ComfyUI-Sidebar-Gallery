/**
 * sbg-layout-editor.js — Two-pane Layout Editor
 *
 *   ┌─ left: editable section/field list ─┬─ right: live WYSIWYG preview ─┐
 *   │  • drag ⋮⋮ to reorder sections      │  renders the WHOLE panel the   │
 *   │  • expand a section to edit fields  │  exact way the lightbox does,  │
 *   │  • drag fields within/between secs  │  via the same TL.renderSection │
 *   │  • drag from the "All Fields" tray  │  so the two can never disagree │
 *   └─────────────────────────────────────┴────────────────────────────────┘
 *
 * The bottom "All Fields / Nodes" tray lists every metadata path the server knows
 * about, grouped with friendly names — drag one onto a section to add it.
 *
 * Per-app (ComfyUI/A1111/…) × per-media (image/video) profiles, persisted
 * server-side via the translation layer.
 */

import { h, showToast, parseColor, formatColor, checkerBg } from "./sbg-core.js";
import * as TL from "./sbg-translation-layer.js";
import { initSortable } from "./sbg-sortable.js";
import { createColorPicker } from "./sbg-color-picker.js";

const MEDIA = ["image", "video"];
const SECTION_STYLES = ["flat", "cards", "text", "nodes", "raw"];
const PARAM_STYLES = ["kv", "pill", "detail", "title", "text", "hidden"];
const HIGHLOW_SOURCES = new Set(["loras", "samplers"]);
// Common "cards" sources offered as autocomplete suggestions in the editor.
const _CARD_SOURCES = ["samplers", "loras", "controlnet", "adetailer", "upscaling", "interpolation", "mmaudio"];

const labelize = (s) => String(s).split(".").pop()
  .replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim()
  .replace(/\b\w/g, c => c.toUpperCase());

// Friendlier grouping for the field tray / picker.
const PATH_GROUPS = [
  { key: "file", label: "File Info", test: p => ["filename", "path", "filesize", "resolution", "generation_resolution", "width", "height", "modified", "duration", "codec", "fps", "total_frames"].includes(p) },
  { key: "models", label: "Models", test: p => ["model", "vae", "clip_skip", "clip_models", "model_hash"].includes(p) },
  { key: "prompts", label: "Prompts", test: p => /prompt/i.test(p) },
  { key: "samplers", label: "Sampling", test: p => p.startsWith("samplers.") },
  { key: "loras", label: "LoRAs", test: p => p.startsWith("loras.") },
  { key: "controlnet", label: "ControlNet", test: p => p.startsWith("controlnet.") },
  { key: "adetailer", label: "ADetailer", test: p => p.startsWith("adetailer.") },
  { key: "upscaling", label: "Upscaling", test: p => p.startsWith("upscaling.") },
  { key: "interpolation", label: "Interpolation", test: p => p.startsWith("interpolation.") },
  { key: "mmaudio", label: "MMAudio", test: p => p.startsWith("mmaudio.") },
  { key: "extra", label: "Extra", test: p => p.startsWith("extra") },
  { key: "nodes", label: "Workflow Nodes", test: p => p.startsWith("workflow_nodes.") },
];

// class_type → human node title (e.g. "easy showAnything" → "JoyCaption Output"),
// populated from /meta_keys so the tray is searchable/readable by node title.
let _nodeTitles = {};
// class_type → [{title?, from?, index, params:[…]}, …] — per-instance info for
// node types that appear multiple times (or with distinguishing context), from
// /meta_keys. Lets the tray/picker offer each instance separately.
let _nodeInstances = {};

function prettyPathLabel(path, inst) {
  if (path.startsWith("workflow_nodes.")) {
    const parts = path.split(".");
    const ct = parts[1];
    const title = _nodeTitles[ct];
    let nodeLabel = title && title !== ct ? `${title} (${ct})` : ct;
    if (inst) nodeLabel = instanceLabel(ct, inst);
    return parts.length > 2 ? `${nodeLabel} → ${labelize(parts.slice(2).join("."))}` : nodeLabel;
  }
  return labelize(path);
}

/** Human label for one node instance: title → upstream context → #N. */
function instanceLabel(ct, inst) {
  if (inst.title) return `${ct} — “${inst.title}”`;
  if (inst.from) return `${ct} (from ${inst.from})`;
  return `${ct} #${(inst.index || 0) + 1}`;
}

/** Most-specific instance matcher: title > from > index (see TL.filterNodesByMatch). */
function matchForInstance(inst) {
  if (inst.title) return { title: inst.title };
  if (inst.from) return { from: inst.from };
  return { index: inst.index || 0 };
}

/** Instances of a class_type worth offering separately (2+ distinguishable). */
function instancesForType(ct) {
  const insts = _nodeInstances[ct];
  return Array.isArray(insts) && insts.length > 1 ? insts : null;
}

/**
 * Expand a tray/picker path into its offered items. Node-type paths with
 * multiple distinguishable instances become one item per instance (carrying
 * the matcher); everything else stays a single legacy all-instances item.
 */
function expandPathItems(pth) {
  if (pth.startsWith("workflow_nodes.")) {
    const parts = pth.split(".");
    const ct = parts[1];
    const pk = parts.length > 2 ? parts.slice(2).join(".") : null;
    const insts = instancesForType(ct);
    if (insts) {
      // Instances that actually carry this param (param lists differ between
      // e.g. a ShowAny fed by an LLM and one fed by a scheduler).
      const matching = insts.filter(inst =>
        !(pk && Array.isArray(inst.params) && inst.params.length && !inst.params.includes(pk)));
      // DEFAULT to all instances of the type (unbound). Offer per-instance
      // binding as an explicit EXTRA choice only when there's more than one, so
      // the user isn't silently locked to a single node instance.
      const items = [{ path: pth, match: null, label: prettyPathLabel(pth) }];
      if (matching.length > 1) {
        for (const inst of matching) {
          items.push({ path: pth, match: matchForInstance(inst), label: prettyPathLabel(pth, inst) });
        }
      }
      return items;
    }
  }
  return [{ path: pth, match: null, label: prettyPathLabel(pth) }];
}

const _matchKey = (pth, match) => pth + "|" + JSON.stringify(match || null);

/** Short chip text for a param's instance matcher. */
function matchChipText(match) {
  if (!match) return "";
  if (match.title) return `“${match.title}”`;
  if (match.from) return `from ${match.from}`;
  return `#${(match.index || 0) + 1}`;
}

/** "rgb(34,197,94)" / "rgba(…, a)" → "#rrggbb". Returns null for fully transparent. */
// Normalise a CSS colour (rgb/rgba/hex) to the canonical model, PRESERVING alpha
// so a translucent default (e.g. the rgba section tints) shows its real value in
// the swatch + picker instead of being flattened to an opaque hex.
function _normColor(c) {
  if (!c) return null;
  const pc = parseColor(c);
  if (!pc) return (typeof c === "string" && c[0] === "#") ? c : null;
  // Fully transparent is a REAL colour state (0% opacity) — keep it, so the
  // picker opens at the element's true 0% instead of an invented opaque colour.
  return formatColor(pc.r, pc.g, pc.b, pc.a);
}

// Paint a colour-button as THREE sub-swatches (background / text / border) so all
// three channels are visible at a glance — not just the background (the old single
// swatch hid text/border edits, which read as "the button didn't change"). Each
// channel falls back to the element's computed default when unset; translucent
// colours render over a checkerboard so transparency reads correctly.
function _paintSwatch(el, colorObj, defaults) {
  const co = (colorObj && typeof colorObj === "object") ? colorObj : {};
  const d = defaults || {};
  const chan = (k) => co[k] || d[k] || "";
  el.textContent = "";          // drop the emoji — the stripes are the indicator now
  el.style.background = "";
  // Fixed-size inner swatch. The button has NO intrinsic size (it used to size to
  // its emoji), so a 100%-height inner box collapsed the whole button to ~2px and
  // it vanished. A bordered 22×14 box keeps it visible even when channels are unset.
  const stripe = (c) => h("span", { style: `flex:1;min-width:0;background:${c ? checkerBg(c) : "transparent"};` });
  el.appendChild(h("span", { style: "display:flex;width:22px;height:14px;border-radius:3px;overflow:hidden;border:1px solid rgba(255,255,255,0.25);vertical-align:middle;" },
    [stripe(chan("bg")), stripe(chan("text")), stripe(chan("border"))]));
}

// Build the "Cards from:" source row for a cards section/tab: a clear label, an
// autocomplete (datalist) input listing the common sources, and a VISIBLE one-line
// hint (not just a tooltip). `obj` is the section or tab; onChange persists/re-renders;
// extraEl (optional) is appended inline after the input (e.g. the high/low toggle).
// Attach the gallery-style options popup (.sbg-crumb-popup) to a text input:
// click/focus opens it under the input, picking an option fills the input and
// fires its change handler, typing custom values still works. Native datalist
// dropdowns are NOT used — they render as out-of-place browser UI.
function _attachOptionsPopup(inp, getOptions) {
  let popup = null;
  const close = () => { if (popup) { popup.remove(); popup = null; } };
  const open = () => {
    close();
    popup = h("div", { class: "sbg-crumb-popup" });
    for (const opt of getOptions()) {
      const item = h("div", {
        class: `sbg-crumb-popup__item${opt.value === inp.value ? " sbg-crumb-popup__item--active" : ""}`,
        text: opt.label,
      });
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault(); // keep input focus, beat the blur
        inp.value = opt.value;
        inp.dispatchEvent(new Event("change"));
        close();
      });
      popup.appendChild(item);
    }
    document.body.appendChild(popup);
    const rect = inp.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.left = rect.left + "px";
    popup.style.top = (rect.bottom + 2) + "px";
    popup.style.minWidth = rect.width + "px";
    popup.style.zIndex = "100001";
  };
  inp.addEventListener("focus", open);
  inp.addEventListener("click", open);
  inp.addEventListener("blur", () => setTimeout(close, 120));
  inp.addEventListener("keydown", (ev) => { if (ev.key === "Escape" || ev.key === "Enter") close(); });
}

function _buildCardSourceUI(obj, body, onChange, extraEl) {
  const help = "What each card represents. Choose a list → one card per entry (e.g. loras = one card per LoRA), and the fields below are read from each entry. Leave EMPTY for a single card built from the whole image. You can also type workflow_nodes.<NodeType> (e.g. workflow_nodes.KSampler).";
  const wrap = h("div", { class: "sbg-ly3-src" });
  wrap.appendChild(h("span", { text: "Cards from:", title: help }));
  const inp = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm", placeholder: "(empty = whole image) · loras · samplers …", value: obj.source || "", title: help });
  inp.addEventListener("change", () => { obj.source = inp.value.trim() || undefined; onChange(); });
  _attachOptionsPopup(inp, () => [
    { value: "", label: "(empty — one card from the whole image)" },
    ..._CARD_SOURCES.map(s => ({ value: s, label: s })),
  ]);
  wrap.appendChild(inp);
  if (extraEl) wrap.appendChild(extraEl);
  body.appendChild(wrap);
}

// Build the "Show when:" row for a tab/section: controls when it appears in the
// metadata panel. Empty = Auto (show only when the data most of its fields read
// from exists — e.g. a tab of mostly controlnet.* fields hides on images without
// ControlNet). "always" disables the gate; any summary path (e.g. upscaling, or
// workflow_nodes.SeedVR2LoadDiTModel) shows the tab only when that path has data.
function _buildShowWhenUI(obj, body, onChange) {
  const help = "When should this tab appear? Auto = only when the data its fields mostly read from exists. Always = whenever any field has a value (old behaviour). Or type a data source (controlnet, upscaling, mmaudio, … or workflow_nodes.<NodeType>) to show it only when that exists.";
  const wrap = h("div", { class: "sbg-ly3-src" });
  wrap.appendChild(h("span", { text: "Show when:", title: help }));
  const auto = TL.autoAnchorFor(obj && Array.isArray(obj.params) ? obj : { params: [] });
  const inp = h("input", {
    type: "text", class: "sbg-gs-input sbg-gs-input--sm",
    placeholder: auto ? `(auto: when ${auto} exists)` : "(auto)",
    value: obj.showWhen || "", title: help,
  });
  inp.addEventListener("change", () => { obj.showWhen = inp.value.trim() || undefined; onChange(); });
  _attachOptionsPopup(inp, () => [
    { value: "", label: auto ? `Auto (when ${auto} exists)` : "Auto" },
    { value: "always", label: "Always" },
    ...[...TL.AUTO_ANCHOR_KEYS, "samplers"].map(s => ({ value: s, label: `when ${s} exists` })),
  ]);
  wrap.appendChild(inp);
  body.appendChild(wrap);
}

// Effective DEFAULT colours for an uncustomised target, read from the actual
// rendered CSS (so the picker shows the real current colour — incl. theme / global
// pill overrides — instead of arbitrary placeholders). Cached per kind+title.
// The probe element must MATCH what the renderer really emits for that kind —
// probing a stand-in class lies to the picker (kv/detail/title used to probe
// .sbg-prompt-text, so the picker opened on its 12%-opacity background even
// though those rows render with none; tab pills/bodies probed .sbg-badge /
// .sbg-section instead of .sbg-prompt-pill / .sbg-tab-body).
const _swatchCache = {};
/** Drop cached swatch defaults so the next probe re-reads the LIVE CSS vars —
 *  call after the Appearance tab changes a global pill/badge/accent colour, else
 *  the param colour pickers keep showing the colour from when they were first
 *  opened while the preview/panel render the new one. */
export function clearSwatchCache() { for (const k in _swatchCache) delete _swatchCache[k]; }
function _swatchDefaults(kind, sec) {
  const key = kind + "|" + (kind === "section" && sec ? (sec.title || "") : "");
  if (_swatchCache[key]) return _swatchCache[key];
  let el, textEl = null;
  if (kind === "pill") el = h("span", { class: "sbg-badge", text: "x" });
  else if (kind === "tabpill") el = h("button", { class: "sbg-prompt-pill", text: "x" });
  else if (kind === "tabbody") el = h("div", { class: "sbg-tab-body", text: "x" });
  else if (kind === "section") { el = h("div", { class: "sbg-section" }); if (sec && sec.title) el.dataset.sectionTitle = sec.title; }
  else if (kind === "kv") {
    // kv rows colour the VALUE span, not the row — read text colour from it.
    el = h("div", { class: "sbg-meta-row" });
    el.appendChild(h("span", { class: "sbg-meta-label", text: "L" }));
    textEl = h("span", { class: "sbg-meta-value", text: "x" });
    el.appendChild(textEl);
  }
  else if (kind === "detail") el = h("div", { class: "sbg-meta-card__seed", text: "x" });
  else if (kind === "title") el = h("div", { class: "sbg-meta-card__title", text: "x" });
  else if (kind === "text-neg") el = h("div", { class: "sbg-prompt-text sbg-prompt-text--neg", text: "x" });
  else el = h("div", { class: "sbg-prompt-text", text: "x" });
  const probe = h("div", { style: "position:fixed;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none" }, [el]);
  (document.querySelector(".sbg-gs-overlay") || document.body).appendChild(probe);
  let out;
  try {
    const cs = getComputedStyle(el);
    // A 0-width/none border still COMPUTES a borderTopColor (the text colour,
    // opaque) — treat it as "no border" (transparent) instead.
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
    out = {
      bg: _normColor(cs.backgroundColor),
      text: _normColor(textEl ? getComputedStyle(textEl).color : cs.color),
      border: hasBorder ? _normColor(cs.borderTopColor) : "rgba(0, 0, 0, 0)",
    };
  } catch { out = {}; }
  probe.remove();
  _swatchCache[key] = out;
  return out;
}

// View memory: which app/media tab, which sections/tabs were expanded, tray
// open state. Module-level so closing and reopening the editor in the same
// page session restores exactly the view you left (one tiny object, no I/O).
const _viewMemory = { app: "comfyui", media: "image", expanded: new Set(), trayOpen: false, fresh: true };

export function renderLayout(content, galleryCtx, closeGS) {
  content.innerHTML = "";
  content.classList.add("sbg-ly3");
  // Re-read swatch defaults from live CSS vars on each open, so a global colour
  // changed in the Appearance tab is reflected in the per-element colour pickers.
  clearSwatchCache();

  let activeApp = _viewMemory.app;
  let activeMedia = _viewMemory.media;
  let profiles = TL.getProfiles();
  let serverPaths = null;
  const mockByMedia = { image: null, video: null };
  const expanded = _viewMemory.expanded; // section/tab ids currently expanded in the left pane
  let trayOpen = _viewMemory.trayOpen;

  function activeKey() { return TL.profileKey(activeApp, activeMedia === "video"); }
  function activeLayout() {
    const k = activeKey();
    if (!Array.isArray(profiles[k]) || !profiles[k].length) {
      profiles[k] = JSON.parse(JSON.stringify(TL.getActiveProfile(activeApp, activeMedia === "video")));
    }
    return profiles[k];
  }
  function persist() { TL.saveProfiles(profiles); }
  function mock() { return mockByMedia[activeMedia]; }
  function secById(id) { return activeLayout().find(s => s.id === id); }

  // ── Scaffold ────────────────────────────────────────────────────────
  const topBar = h("div", { class: "sbg-ly3-top" });
  const split = h("div", { class: "sbg-ly3-split" });
  const leftPane = h("div", { class: "sbg-ly3-edit" });
  const rightPane = h("div", { class: "sbg-ly3-preview" });
  split.appendChild(leftPane);
  split.appendChild(rightPane);
  content.appendChild(topBar);
  content.appendChild(split);

  // ── Top bar ─────────────────────────────────────────────────────────
  function renderTopBar() {
    topBar.innerHTML = "";
    const appWrap = h("div", { class: "sbg-ly3-tabs" });
    for (const app of TL.APPS) {
      const b = h("button", { class: `sbg-btn sbg-btn--sm${activeApp === app ? " sbg-btn--primary" : ""}`, text: TL.APP_LABELS[app] });
      b.addEventListener("click", () => { activeApp = app; _viewMemory.app = app; render(); });
      appWrap.appendChild(b);
    }
    topBar.appendChild(appWrap);
    topBar.appendChild(h("span", { class: "sbg-ly3-sep" }));
    const medWrap = h("div", { class: "sbg-ly3-tabs" });
    for (const med of MEDIA) {
      const b = h("button", { class: `sbg-btn sbg-btn--sm${activeMedia === med ? " sbg-btn--primary" : ""}`, text: med === "image" ? "Images" : "Videos" });
      b.addEventListener("click", () => { activeMedia = med; _viewMemory.media = med; ensureMock(); render(); });
      medWrap.appendChild(b);
    }
    topBar.appendChild(medWrap);

    const actions = h("div", { class: "sbg-ly3-actions" });
    if (activeMedia === "video") {
      const clone = h("button", { class: "sbg-btn sbg-btn--sm", text: "⇐ Clone Images" });
      clone.addEventListener("click", () => {
        const src = profiles[TL.profileKey(activeApp, false)] || TL.getActiveProfile(activeApp, false);
        profiles[activeKey()] = JSON.parse(JSON.stringify(src));
        persist(); render(); showToast("Cloned image layout to video");
      });
      actions.appendChild(clone);
    }
    const reset = h("button", { class: "sbg-btn sbg-btn--sm", text: "↺ Reset" });
    let rc = false;
    reset.addEventListener("click", () => {
      if (!rc) { rc = true; reset.textContent = "Sure?"; reset.classList.add("sbg-btn--danger"); setTimeout(() => { rc = false; reset.textContent = "↺ Reset"; reset.classList.remove("sbg-btn--danger"); }, 2000); return; }
      delete profiles[activeKey()]; persist(); render(); showToast("Profile reset to default");
    });
    actions.appendChild(reset);
    topBar.appendChild(actions);
  }

  // ── Full render ─────────────────────────────────────────────────────
  function render() {
    renderTopBar();
    renderEditor();
    refreshPreview();
  }

  // ── Left pane: editable section list + field tray ───────────────────
  function renderEditor() {
    leftPane.innerHTML = "";
    leftPane.appendChild(h("div", { class: "sbg-ly3-hint", text: "Drag ⋮⋮ to reorder. Expand a section to edit its fields, or drag fields in from the tray below. The right pane previews your panel live." }));

    const list = h("div", { class: "sbg-ly3-seclist" });
    leftPane.appendChild(list);
    for (const sec of activeLayout()) list.appendChild(buildSectionEditor(sec, list));

    const addSec = h("button", { class: "sbg-btn sbg-btn--sm sbg-ly3-addsec", text: "+ Add Section" });
    addSec.addEventListener("click", () => {
      const sec = { id: TL.uid(), title: "New Section", style: "flat", open: true, params: [] };
      expanded.add(sec.id);
      activeLayout().push(sec); persist(); render();
    });
    leftPane.appendChild(addSec);

    leftPane.appendChild(buildTray());
  }

  function buildSectionEditor(sec, list) {
    const isOpen = expanded.has(sec.id);
    const card = h("div", { class: "sbg-ly3-sec" + (sec.hidden ? " sbg-ly3-sec--hidden" : "") });
    card.dataset.secId = sec.id;
    card._section = sec;

    const head = h("div", { class: "sbg-ly3-sechead" });
    const grip = h("span", { class: "sbg-grip", text: "⋮⋮", title: "Drag to reorder section" });
    head.appendChild(grip);

    const exp = h("button", { class: "sbg-ly3-exp", text: isOpen ? "▼" : "▶", title: "Expand / collapse fields" });
    exp.addEventListener("click", () => { if (isOpen) expanded.delete(sec.id); else expanded.add(sec.id); renderEditor(); });
    head.appendChild(exp);

    const eye = h("button", { class: "sbg-iconbtn sbg-eyebtn" + (sec.hidden ? " sbg-iconbtn--off" : ""), title: sec.hidden ? "Hidden from panel — click to show" : "Shown in panel — click to hide", text: "👁" });
    eye.addEventListener("click", () => { sec.hidden = !sec.hidden; persist(); render(); });
    head.appendChild(eye);

    const title = h("input", { type: "text", class: "sbg-ly3-title", value: sec.title || "", placeholder: "Section title" });
    title.addEventListener("input", () => { sec.title = title.value || "Untitled"; persist(); refreshPreview(); });
    head.appendChild(title);

    head.appendChild(mkSelect(SECTION_STYLES, sec.style || "flat", (v) => { sec.style = v; persist(); renderEditor(); refreshPreview(); }, "Section render style"));

    // Section background / colour (e.g. green Positive, red Negative). Seeds the
    // default so the picker's Background tab shows the real current colour.
    const secColorBtn = h("button", { class: "sbg-iconbtn", title: "Section background / colours", text: "🎨" });
    _paintSwatch(secColorBtn, sec.color, _swatchDefaults("section", sec));
    secColorBtn.addEventListener("click", () => {
      if (!sec.color) { const d = TL.defaultSectionColor(sec); if (d) sec.color = { ...d }; }
      openPillColorPicker(secColorBtn, sec, sec, "color", "section");
    });
    head.appendChild(secColorBtn);

    const openLbl = h("label", { class: "sbg-ly3-openlbl", title: "Expanded by default in the panel" });
    const openCb = h("input", { type: "checkbox" }); openCb.checked = sec.open !== false;
    openCb.addEventListener("change", () => { sec.open = openCb.checked; persist(); refreshPreview(); });
    openLbl.appendChild(openCb); openLbl.appendChild(document.createTextNode("open"));
    head.appendChild(openLbl);

    const del = h("button", { class: "sbg-iconbtn sbg-iconbtn--danger", title: "Delete section", text: "🗑" });
    let dc = false;
    del.addEventListener("click", () => {
      if (!dc) { dc = true; del.textContent = "Sure?"; setTimeout(() => { dc = false; del.textContent = "🗑"; }, 2000); return; }
      const l = activeLayout(); const i = l.indexOf(sec); if (i >= 0) l.splice(i, 1); expanded.delete(sec.id); persist(); render();
    });
    head.appendChild(del);
    card.appendChild(head);

    if (isOpen) {
      const body = h("div", { class: "sbg-ly3-secbody" });
      const hasTabs = Array.isArray(sec.tabs) && sec.tabs.length;

      // Tab pills sit at the very TOP of the section (a tab is logically the
      // first thing you choose). Available on ANY section style.
      if (sec.style !== "nodes" && sec.style !== "raw") body.appendChild(buildTabsEditor(sec));

      // When tabs are in use they own the content (each tab has its own source /
      // fields), so hide the section-level source row and field list.
      if (sec.style === "cards" && !hasTabs) {
        // High/Low pairing toggle (MoE) — shown inline in the source row.
        const hlLbl = h("label", { class: "sbg-ly3-openlbl", title: "Pair high-noise / low-noise models side-by-side (Wan2.2-style MoE)" });
        const hlCb = h("input", { type: "checkbox" });
        const autoOn = sec.highlow == null && HIGHLOW_SOURCES.has(sec.source);
        hlCb.checked = sec.highlow === true || autoOn;
        hlCb.addEventListener("change", () => { sec.highlow = hlCb.checked; persist(); refreshPreview(); });
        hlLbl.appendChild(hlCb); hlLbl.appendChild(document.createTextNode("pair high/low"));
        _buildCardSourceUI(sec, body, () => { persist(); renderEditor(); refreshPreview(); }, hlLbl);
      }

      if (sec.style !== "nodes" && sec.style !== "raw" && !hasTabs) {
        _buildShowWhenUI(sec, body, () => { persist(); refreshPreview(); });
      }

      if (sec.style === "nodes" || sec.style === "raw") {
        body.appendChild(h("div", { class: "sbg-ly3-auto", text: sec.style === "nodes" ? "Auto-renders every workflow node (no fields to configure)." : "Dumps the raw prompt / workflow JSON." }));
      } else if (!hasTabs) {
        const fields = h("div", { class: "sbg-ly3-fields" });
        fields.dataset.secId = sec.id;
        for (const p of (sec.params || [])) fields.appendChild(buildFieldRow(sec, p, fields));
        if (!(sec.params || []).length) fields.appendChild(h("div", { class: "sbg-ly3-empty", text: "No fields yet — drag from the tray below or click + field." }));
        body.appendChild(fields);
        const addField = h("button", { class: "sbg-ly3-addfield", text: "+ field" });
        addField.addEventListener("click", () => openAddFieldPicker(addField, sec));
        body.appendChild(addField);
      } else {
        // Tabbed section: optional SECTION-LEVEL fields shown OUTSIDE the tabs (with
        // every tab) — e.g. one shared "show output" field rather than duplicating it
        // into each tab (which would make every tab appear whenever that node exists).
        const ofHead = h("div", { class: "sbg-ly3-outerfields-head" });
        ofHead.appendChild(h("span", {
          class: "sbg-ly3-tabsed-label", text: "Fields outside tabs",
          title: "Section-level fields shown alongside EVERY tab. Use for content that isn't tab-specific (e.g. one 'show output' field). Drag fields in from the tray, or between here and the tabs.",
        }));
        const posLbl = h("label", { class: "sbg-ly3-openlbl", title: "Show these fields above or below the tab pills" });
        const posCb = h("input", { type: "checkbox" }); posCb.checked = !!sec.fieldsAbove;
        posCb.addEventListener("change", () => { sec.fieldsAbove = posCb.checked || undefined; persist(); refreshPreview(); });
        posLbl.appendChild(posCb); posLbl.appendChild(document.createTextNode("above tabs"));
        ofHead.appendChild(posLbl);
        body.appendChild(ofHead);
        const fields = h("div", { class: "sbg-ly3-fields" });
        fields.dataset.secId = sec.id;
        for (const p of (sec.params || [])) fields.appendChild(buildFieldRow(sec, p, fields));
        if (!(sec.params || []).length) fields.appendChild(h("div", { class: "sbg-ly3-empty", text: "No fields outside tabs — drag one here from the tray, or click + field." }));
        body.appendChild(fields);
        const addField = h("button", { class: "sbg-ly3-addfield", text: "+ field" });
        addField.addEventListener("click", () => openAddFieldPicker(addField, sec));
        body.appendChild(addField);
      }
      card.appendChild(body);
    }

    initSortable(list, grip, card, { type: "section", itemSelector: ".sbg-ly3-sec", onDrop: () => syncFromDOM() });
    return card;
  }

  function buildFieldRow(sec, p, fields, opts = {}) {
    const hidden = p.style === "hidden";
    const row = h("div", { class: "sbg-ly3-field" + (hidden ? " sbg-ly3-field--hidden" : "") });
    row.dataset.type = "param";
    row._param = p;

    row.appendChild(h("span", { class: "sbg-grip sbg-ly3-fieldgrip", text: "⋮⋮", title: "Drag to move / reorder" }));

    const lbl = h("input", { type: "text", class: "sbg-ly3-fieldlabel", value: p.label || "", placeholder: labelize(p.path) });
    lbl.title = p.path;
    // Keep an explicitly-cleared name as "" (not undefined) so the panel shows the
    // value with NO "Label:" prefix. (Untouched fields keep their auto-name.)
    lbl.addEventListener("input", () => { p.label = lbl.value; persist(); refreshPreview(); });
    row.appendChild(lbl);

    row.appendChild(h("span", { class: "sbg-ly3-fieldpath", text: p.path, title: p.path }));

    // Instance matcher chip ("LLM Output" / from BasicScheduler / #2) with ×
    // to clear (reverting the field to all-instances-of-type).
    if (p.match) {
      const chip = h("span", {
        class: "sbg-ly3-matchchip",
        title: "Bound to one node instance: " + matchChipText(p.match) + ". Click × to match every instance again.",
      });
      chip.appendChild(h("span", { class: "sbg-ly3-matchchip__txt", text: matchChipText(p.match) }));
      const clearX = h("span", { class: "sbg-ly3-matchchip__x", text: "×", title: "Clear instance binding — match every instance again" });
      clearX.addEventListener("click", (e) => { e.stopPropagation(); delete p.match; persist(); renderEditor(); refreshPreview(); });
      chip.appendChild(clearX);
      row.appendChild(chip);
    }

    const styleSel = mkSelect(PARAM_STYLES, hidden ? "hidden" : (p.style || "kv"), (v) => {
      if (v === "hidden") { if (p.style !== "hidden") p._prevStyle = p.style || "kv"; p.style = "hidden"; }
      else { p.style = v; delete p._prevStyle; }
      persist(); renderEditor(); refreshPreview();
    }, "Field display style");
    row.appendChild(styleSel);

    const tools = h("div", { class: "sbg-ly3-fieldtools" });
    const effStyle = hidden ? (p._prevStyle || "kv") : (p.style || "kv");
    // Format string is pill-specific.
    if (effStyle === "pill") {
      const fmt = h("input", { type: "text", class: "sbg-ly3-fmt", value: p.format || "", placeholder: "fmt e.g. CFG {v}" });
      fmt.addEventListener("input", () => { p.format = fmt.value.trim() || undefined; persist(); refreshPreview(); });
      tools.appendChild(fmt);
    }
    // Colour picker — available for every visible style (pill/kv/detail/title/text),
    // not just pills (regression: text/kv used to be colourable too).
    if (effStyle !== "hidden") {
      // The picker's default colours come from a probe of the kind's REAL
      // rendered element, so pass the actual style (kv/detail/title/text/pill).
      const _ckind = effStyle === "text" && (p.variant === "neg" || /negative/i.test(p.path)) ? "text-neg" : effStyle;
      const colorBtn = h("button", { class: "sbg-iconbtn", title: "Colours", text: "🎨" });
      _paintSwatch(colorBtn, p.color, _swatchDefaults(_ckind, sec));
      colorBtn.addEventListener("click", () => openPillColorPicker(colorBtn, p, sec, "color", _ckind));
      tools.appendChild(colorBtn);
    }
    // Find
    const { field: searchField, value: searchValue } = pathToSearch(p.path);
    if (searchField !== "prompt" && searchField !== "app") {
      const findBtn = h("button", { class: "sbg-iconbtn", title: "Find all items with this field", text: "🔍" });
      findBtn.addEventListener("click", () => {
        const raw = sec.title ? `${sec.title}: ${p.label || labelize(p.path)}` : (p.label || labelize(p.path));
        if (closeGS) closeGS();
        document.dispatchEvent(new CustomEvent("sbg-search-submit", { detail: { field: searchField, value: searchValue, raw } }));
      });
      tools.appendChild(findBtn);
    }
    const eyeBtn = h("button", { class: "sbg-iconbtn sbg-eyebtn" + (hidden ? " sbg-iconbtn--off" : ""), title: hidden ? "Hidden — click to show" : "Click to hide", text: "👁" });
    eyeBtn.addEventListener("click", () => {
      if (p.style === "hidden") { p.style = p._prevStyle || "kv"; delete p._prevStyle; }
      else { p._prevStyle = p.style || "kv"; p.style = "hidden"; }
      persist(); renderEditor(); refreshPreview();
    });
    tools.appendChild(eyeBtn);
    const delBtn = h("button", { class: "sbg-iconbtn sbg-iconbtn--danger", title: "Remove field", text: "🗑" });
    delBtn.addEventListener("click", () => { const i = sec.params.indexOf(p); if (i >= 0) sec.params.splice(i, 1); persist(); renderEditor(); refreshPreview(); });
    tools.appendChild(delBtn);
    row.appendChild(tools);

    initSortable(fields, row.querySelector(".sbg-ly3-fieldgrip"), row, {
      type: "param", itemSelector: ".sbg-ly3-field",
      // Allow moving a field between section field-lists AND tab field-lists, so a
      // param can be dragged into (or out of) a tabbed section. syncFromDOM is
      // tab-aware and rebuilds the destination tab's params.
      dropContainerSelector: opts.dropContainerSelector || ".sbg-ly3-fields, .sbg-ly3-tabfields",
      onDrop: opts.onDrop || (() => syncFromDOM()),
    });
    return row;
  }

  // ── Tabs editor (any section) ───────────────────────────────────────
  // Each tab is a mini-section, rendered as a stacked row that mirrors the
  // SECTION row pattern (grip-drag to reorder, inline rename, expand to edit
  // fields, style/colour controls) — so it behaves like everything else.
  function _normalizeTab(t) {
    // Upgrade a legacy {label, path} tab to the subsection shape in place.
    // Returns true if anything changed (so the caller can persist once — a tab's
    // id drives its expand state, which must be stable across reloads).
    let changed = false;
    if (t && !Array.isArray(t.params)) {
      t.params = t.path ? [{ path: t.path, label: t.label, style: "text" }] : [];
      t.style = t.style || "text";
      delete t.path;
      changed = true;
    }
    if (t && !t.style) { t.style = "flat"; changed = true; }
    if (t && !t.id) { t.id = TL.uid("tab"); changed = true; }
    return changed;
  }
  function buildTabsEditor(sec) {
    const wrap = h("div", { class: "sbg-ly3-tabsed" });
    const tabs = sec.tabs || [];
    let _normChanged = false;
    for (const t of tabs) { if (_normalizeTab(t)) _normChanged = true; }
    if (_normChanged) persist();  // stabilise generated ids / upgraded shape

    const head = h("div", { class: "sbg-ly3-tabsed-head" });
    head.appendChild(h("span", {
      class: "sbg-ly3-tabsed-label", text: "Tabs",
      title: "Split this section into pill-switchable sub-sections (e.g. Original / Enhanced prompt). Each tab has its own fields, style and colour. Drag ⋮⋮ to reorder.",
    }));
    const add = h("button", { class: "sbg-ly3-tabadd", text: "+ Tab", title: "Add a tab" });
    add.addEventListener("click", () => {
      if (!sec.tabs) sec.tabs = [];
      let nt;
      if (sec.tabs.length === 0 && (sec.params || []).length) {
        // First tab: move the section's existing fields (and its style/source)
        // INTO the tab so they aren't orphaned/hidden. Later tabs start empty.
        nt = { id: TL.uid("tab"), label: sec.title || "Tab 1", style: sec.style || "flat", source: sec.source, params: sec.params };
        sec.params = [];
      } else {
        nt = { id: TL.uid("tab"), label: "Tab " + (sec.tabs.length + 1), style: "text", params: [] };
      }
      sec.tabs.push(nt); expanded.add(nt.id);
      persist(); renderEditor(); refreshPreview();
    });
    head.appendChild(add);
    wrap.appendChild(head);

    // Always render the tab-list — even when empty — so a tab dragged from ANOTHER
    // section has somewhere to land here. The empty list is invisible at rest and
    // only reveals itself as a drop zone while a tab is actually being dragged
    // (see body.sbg-dragging-tab in the CSS).
    const list = h("div", { class: "sbg-ly3-tablist" + (tabs.length ? "" : " sbg-ly3-tablist--empty") });
    for (const t of tabs) list.appendChild(buildTabRow(sec, t, list, syncTabsFromDOM));
    wrap.appendChild(list);
    return wrap;
  }

  // One tab row — mirrors buildSectionEditor's row (grip / expand / rename /
  // style / pill-colour / bg-colour / delete) + an expandable field list.
  function buildTabRow(sec, t, list, onTabDrop) {
    const isOpen = expanded.has(t.id);
    const row = h("div", { class: "sbg-ly3-tabrow" });
    row._tab = t;
    const head = h("div", { class: "sbg-ly3-tabrow-head" });
    const grip = h("span", { class: "sbg-grip", text: "⋮⋮", title: "Drag to reorder tab" });
    head.appendChild(grip);
    const exp = h("button", { class: "sbg-ly3-exp", text: isOpen ? "▼" : "▶", title: "Expand / collapse fields" });
    exp.addEventListener("click", () => { if (isOpen) expanded.delete(t.id); else expanded.add(t.id); renderEditor(); });
    head.appendChild(exp);
    const name = h("input", { type: "text", class: "sbg-ly3-title", value: t.label || "", placeholder: "Tab name" });
    name.addEventListener("input", () => { t.label = name.value || undefined; persist(); refreshPreview(); });
    head.appendChild(name);
    head.appendChild(mkSelect(SECTION_STYLES, t.style || "text", (v) => { t.style = v; persist(); renderEditor(); refreshPreview(); }, "Tab render style"));
    // Pill colour (the tab's pill in the panel — renders as .sbg-prompt-pill,
    // not a .sbg-badge, so probe the right element for its defaults).
    const pillBtn = h("button", { class: "sbg-iconbtn", title: "Tab pill colour", text: "🔵" });
    _paintSwatch(pillBtn, t.pillColor, _swatchDefaults("tabpill"));
    pillBtn.addEventListener("click", () => openPillColorPicker(pillBtn, t, sec, "pillColor", "tabpill"));
    head.appendChild(pillBtn);
    // Content background colour (applies to the .sbg-tab-body host).
    const bgBtn = h("button", { class: "sbg-iconbtn", title: "Tab content background", text: "🎨" });
    _paintSwatch(bgBtn, t.color, _swatchDefaults("tabbody"));
    bgBtn.addEventListener("click", () => openPillColorPicker(bgBtn, t, sec, "color", "tabbody"));
    head.appendChild(bgBtn);
    const del = h("button", { class: "sbg-iconbtn sbg-iconbtn--danger", title: "Delete tab", text: "🗑" });
    del.addEventListener("click", () => { const i = sec.tabs.indexOf(t); if (i >= 0) sec.tabs.splice(i, 1); if (!sec.tabs.length) delete sec.tabs; expanded.delete(t.id); persist(); renderEditor(); refreshPreview(); });
    head.appendChild(del);
    row.appendChild(head);

    if (isOpen) {
      const body = h("div", { class: "sbg-ly3-tabrow-body" });
      if (t.style === "cards") {
        _buildCardSourceUI(t, body, () => { persist(); renderEditor(); refreshPreview(); });
      }
      _buildShowWhenUI(t, body, () => { persist(); refreshPreview(); });
      if (t.style !== "nodes" && t.style !== "raw") {
        // Tab-only class (NOT .sbg-ly3-fields) so syncFromDOM never overwrites sec.params.
        const fields = h("div", { class: "sbg-ly3-tabfields" });
        for (const p of (t.params || [])) fields.appendChild(buildFieldRow(t, p, fields, { dropContainerSelector: ".sbg-ly3-fields, .sbg-ly3-tabfields", onDrop: () => syncFromDOM() }));
        if (!(t.params || []).length) fields.appendChild(h("div", { class: "sbg-ly3-empty", text: "No fields in this tab — drag from the tray or click + field." }));
        body.appendChild(fields);
        const addField = h("button", { class: "sbg-ly3-addfield", text: "+ field" });
        addField.addEventListener("click", () => openAddFieldPicker(addField, t));
        body.appendChild(addField);
      }
      row.appendChild(body);
    }

    initSortable(list, grip, row, { type: "tab", itemSelector: ".sbg-ly3-tabrow", dropContainerSelector: ".sbg-ly3-tablist", onDrop: onTabDrop });
    return row;
  }

  // ── Field tray ("All Fields / Nodes") ───────────────────────────────
  function buildTray() {
    const tray = h("div", { class: "sbg-ly3-tray" + (trayOpen ? " sbg-ly3-tray--open" : "") });
    const head = h("button", { class: "sbg-ly3-trayhead", text: (trayOpen ? "▼ " : "▶ ") + "All Fields / Nodes — drag into a section" });
    head.addEventListener("click", () => { trayOpen = !trayOpen; _viewMemory.trayOpen = trayOpen; renderEditor(); });
    tray.appendChild(head);
    if (!trayOpen) return tray;

    const search = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm sbg-ly3-traysearch", placeholder: "Filter fields…" });
    const body = h("div", { class: "sbg-ly3-traybody" });
    tray.appendChild(search); tray.appendChild(body);

    function renderTrayList() {
      body.innerHTML = "";
      const all = serverPaths || buildServerPaths(null);
      const filter = search.value.toLowerCase();
      let shown = 0;
      for (const grp of PATH_GROUPS) {
        const inGrp = all.filter(pth => grp.test(pth)).flatMap(expandPathItems)
          .filter(it => !filter || it.path.toLowerCase().includes(filter) || it.label.toLowerCase().includes(filter));
        if (!inGrp.length) continue;
        body.appendChild(h("div", { class: "sbg-ly3-traygrp", text: grp.label }));
        for (const it of inGrp.slice(0, 300)) {
          shown++;
          const item = h("div", { class: "sbg-ly3-palitem", title: it.path + (it.match ? ` (${matchChipText(it.match)})` : "") });
          item.dataset.path = it.path;
          if (it.match) item.dataset.match = JSON.stringify(it.match);
          item.appendChild(h("span", { class: "sbg-grip sbg-ly3-palgrip", text: "⋮⋮" }));
          item.appendChild(h("span", { class: "sbg-ly3-palname", text: it.label }));
          // click also adds to the first expanded section (or first section) as a shortcut
          item.addEventListener("click", (e) => { if (e.target.closest(".sbg-grip")) return; addPathToSection(it.path, _shortcutSection(), it.match); });
          initSortable(body, item.querySelector(".sbg-ly3-palgrip"), item, {
            type: "param", itemSelector: ".sbg-ly3-palitem", dropContainerSelector: ".sbg-ly3-fields, .sbg-ly3-tabfields",
            onDrop: (movedItem) => onTrayDrop(movedItem),
          });
          body.appendChild(item);
        }
      }
      if (!shown) body.appendChild(h("div", { class: "sbg-ly3-empty", text: "No fields match." }));
    }
    search.addEventListener("input", renderTrayList);
    renderTrayList();
    return tray;
  }

  function _shortcutSection() {
    const l = activeLayout();
    for (const id of expanded) { const s = l.find(x => x.id === id); if (s && s.style !== "nodes" && s.style !== "raw") return s; }
    return l.find(s => s.style !== "nodes" && s.style !== "raw") || l[0];
  }

  function _mkParam(pth, match) {
    const param = { path: pth, label: labelize(pth), style: defaultStyleForPath(pth) };
    if (match) param.match = match;
    return param;
  }

  function addPathToSection(pth, sec, match) {
    if (!sec) { showToast("No section to add to"); return; }
    if (!sec.params) sec.params = [];
    if (sec.params.some(p => _matchKey(p.path, p.match) === _matchKey(pth, match))) { showToast("Already in “" + (sec.title || "section") + "”"); return; }
    sec.params.push(_mkParam(pth, match));
    expanded.add(sec.id);
    persist(); render(); showToast("Added to “" + (sec.title || "section") + "”");
  }

  // A tray item was dragged. If it landed inside a section's field list, add it there.
  function onTrayDrop(movedItem) {
    const pth = movedItem && movedItem.dataset ? movedItem.dataset.path : null;
    if (pth) {
      let match = null;
      try { match = movedItem.dataset.match ? JSON.parse(movedItem.dataset.match) : null; } catch { }
      const addAt = (arr, container) => {
        if (arr.some(p => _matchKey(p.path, p.match) === _matchKey(pth, match))) return;
        // insert at the dropped position (before the first real field row after it)
        const idx = [...container.children].filter(c => c.classList.contains("sbg-ly3-field") || c === movedItem).indexOf(movedItem);
        const param = _mkParam(pth, match);
        if (idx >= 0 && idx < arr.length) arr.splice(idx, 0, param); else arr.push(param);
        persist();
      };
      // Dropped into a TAB's field list → add to that tab.
      const tabFieldsEl = movedItem.closest(".sbg-ly3-tabfields");
      const fieldsEl = movedItem.closest(".sbg-ly3-fields");
      if (tabFieldsEl) {
        const tabRow = tabFieldsEl.closest(".sbg-ly3-tabrow");
        const t = tabRow && tabRow._tab;
        if (t) { if (!t.params) t.params = []; addAt(t.params, tabFieldsEl); }
      } else if (fieldsEl) {
        const sec = secById(fieldsEl.dataset.secId);
        if (sec) { if (!sec.params) sec.params = []; addAt(sec.params, fieldsEl); }
      }
    }
    render(); // rebuild — discards the relocated tray node and restores the tray intact
  }

  // ── Add-field picker (click "+ field") ──────────────────────────────
  // onPick: optional. When given, clicking a field invokes onPick(path) and
  // closes the picker (used for choosing a tab's path) instead of adding a param.
  function openAddFieldPicker(anchor, sec, onPick) {
    closePopovers();
    const pop = h("div", { class: "sbg-ly3-pop sbg-ly3-pop--picker" });
    const search = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm", placeholder: "Search fields…" });
    const list = h("div", { class: "sbg-ly3-picklist" });
    pop.appendChild(search); pop.appendChild(list);

    const mapped = new Set(onPick ? [] : (sec.params || []).map(p => _matchKey(p.path, p.match)));
    function renderList() {
      list.innerHTML = "";
      const all = serverPaths || buildServerPaths(null);
      const filter = search.value.toLowerCase();
      let shown = 0;
      for (const grp of PATH_GROUPS) {
        const inGrp = all.filter(pth => grp.test(pth)).flatMap(expandPathItems)
          .filter(it => !mapped.has(_matchKey(it.path, it.match))
            && (!filter || it.path.toLowerCase().includes(filter) || it.label.toLowerCase().includes(filter)));
        if (!inGrp.length) continue;
        list.appendChild(h("div", { class: "sbg-ly3-pickgrp", text: grp.label }));
        for (const it of inGrp.slice(0, 200)) {
          shown++;
          const item = h("div", { class: "sbg-ly3-pickitem" }, [
            h("span", { class: "sbg-ly3-pickname", text: it.label }),
            h("span", { class: "sbg-ly3-pickpath", text: it.path + (it.match ? ` · ${matchChipText(it.match)}` : "") }),
          ]);
          item.addEventListener("click", () => {
            if (onPick) { onPick(it.path); closePopovers(); return; }
            if (!sec.params) sec.params = [];
            sec.params.push(_mkParam(it.path, it.match));
            mapped.add(_matchKey(it.path, it.match)); persist(); renderEditor(); refreshPreview(); renderList();
          });
          list.appendChild(item);
        }
      }
      if (!shown) list.appendChild(h("div", { class: "sbg-ly3-empty", text: "No more fields match." }));
    }
    search.addEventListener("input", renderList);
    renderList();
    placePopover(pop, anchor);
    setTimeout(() => search.focus(), 0);
  }

  // ── Pill HSL colour picker (bg / text / border) ─────────────────────
  // colorKey: which property of `p` to edit ("color" by default; tabs also use
  // "pillColor"). kind: which rendered element supplies the DEFAULT colours shown
  // when nothing is set yet ("pill" | "section" | "text"). Lets one picker drive
  // multiple colourable targets and always show the real current colour.
  function openPillColorPicker(anchor, p, sec, colorKey = "color", kind = "section") {
    // Close any open popover WITH cleanup (a bare .remove() would orphan its
    // outside-click mousedown listener, which then fires closePopovers() on the
    // next click and instantly closes THIS picker — the self-closing bug).
    closePopovers();
    if (!p[colorKey]) p[colorKey] = {};
    const col = p[colorKey];
    const d = _swatchDefaults(kind, sec);
    const pop = h("div", { class: "sbg-ly3-pop sbg-ly3-colorpop" });
    const channels = [["Background", "bg", d.bg || "#2a2a4a"], ["Text", "text", d.text || "#e0e0ff"], ["Border", "border", d.border || "#444444"]];
    let active = "bg", picker = null;
    const tabs = h("div", { class: "sbg-ly3-tabs" });
    const mount = h("div", {});
    function mountPicker() {
      if (picker) picker.destroy();
      mount.innerHTML = "";
      const def = channels.find(c => c[1] === active)[2];
      picker = createColorPicker({ initialColor: col[active] || def, onChange: (color) => { col[active] = color; persist(); refreshPreview(); _paintSwatch(anchor, col, d); } });
      mount.appendChild(picker.panel); picker.init();
    }
    for (const [label, key] of channels) {
      const t = h("button", { class: "sbg-btn sbg-btn--sm" + (key === active ? " sbg-btn--primary" : ""), text: label });
      t.addEventListener("click", () => { active = key; [...tabs.children].forEach(c => c.classList.remove("sbg-btn--primary")); t.classList.add("sbg-btn--primary"); mountPicker(); });
      tabs.appendChild(t);
    }
    const clearRow = h("div", { class: "sbg-ly3-colrow" });
    if (col.bg || col.text || col.border) {
      const clr = h("button", { class: "sbg-btn sbg-btn--sm", text: "Clear colours" });
      clr.addEventListener("click", () => { delete p[colorKey]; persist(); refreshPreview(); _paintSwatch(anchor, null, d); closePopovers(); });
      clearRow.appendChild(clr);
    }
    // If an outside-click removes the popover before the hex input's own
    // change/blur fires, flush any pending typed colour first. Reads the current
    // `picker` (mountPicker reassigns it on channel switch).
    pop._commitActive = () => { if (picker && picker.commit) picker.commit(); };
    pop.appendChild(tabs); pop.appendChild(mount); pop.appendChild(clearRow);
    placePopover(pop, anchor, true);
    mountPicker();
  }

  // ── Popover placement + dismissal ───────────────────────────────────
  function closePopovers() { document.querySelectorAll(".sbg-ly3-pop").forEach(e => { if (e._commitActive) e._commitActive(); if (e._cleanup) e._cleanup(); e.remove(); }); }
  function placePopover(pop, anchor, openLeft) {
    document.body.appendChild(pop);
    const clamp = () => {
      const r = anchor.getBoundingClientRect();
      const pw = pop.offsetWidth || 240, ph = pop.offsetHeight || 300;
      let left = openLeft ? (r.left - pw - 6) : r.left;
      if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
      if (left < 8) left = 8;
      let top = r.bottom + 4;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
      if (top < 8) top = 8;
      pop.style.left = left + "px"; pop.style.top = top + "px";
    };
    clamp();
    requestAnimationFrame(clamp);
    const onDown = (e) => {
      // Self-guard: if this popover was already removed, drop the orphaned
      // listener instead of closing whatever popover is now open.
      if (!pop.isConnected) { document.removeEventListener("mousedown", onDown); return; }
      if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closePopovers();
    };
    pop._cleanup = () => document.removeEventListener("mousedown", onDown);
    setTimeout(() => document.addEventListener("mousedown", onDown), 0);
  }

  // ── Right pane: live full-panel preview (same renderer as lightbox) ──
  function refreshPreview() {
    rightPane.innerHTML = "";
    const m = mock();
    rightPane.appendChild(h("div", { class: "sbg-ly3-prevhint", text: "Live preview" }));
    if (!m) { rightPane.appendChild(h("div", { class: "sbg-ly3-empty", text: "Loading sample metadata…" })); return; }
    const panel = h("div", { class: "sbg-meta-panel sbg-ly3-panel" });
    let any = false;
    for (const sec of activeLayout()) {
      if (!sec || !sec.title) continue;
      if (sec.hidden) continue;
      // preview:true → renderers show EVERY configured field, using an em-dash
      // placeholder where the sample data has no value, so the user sees their
      // full layout while editing.
      const rawData = sec.style === "raw" ? (m.__raw__ || m) : null;
      let contentEl = TL.renderSection(sec, m, { rawData, preview: true, profileKey: activeKey() });
      if (!contentEl) contentEl = buildPlaceholderSection(sec);
      panel.appendChild(makePreviewSection(sec, contentEl));
      any = true;
    }
    if (!any) rightPane.appendChild(h("div", { class: "sbg-ly3-empty", text: "No sections configured. Add a section to preview it here." }));
    else rightPane.appendChild(panel);
    // note about hidden sections
    const hiddenCount = activeLayout().filter(s => s.hidden).length;
    if (hiddenCount) rightPane.appendChild(h("div", { class: "sbg-ly3-prevnote", text: `${hiddenCount} hidden section${hiddenCount > 1 ? "s" : ""} not shown.` }));
  }

  // Dim placeholder for a section the sample data doesn't cover, so every
  // configured section is visible in the live preview while editing.
  function buildPlaceholderSection(sec) {
    const wrap = h("div", { class: "sbg-meta-group sbg-ly3-placeholder" });
    const labels = [];
    if (Array.isArray(sec.tabs) && sec.tabs.length) sec.tabs.forEach(t => labels.push(t.label || (t.path && labelize(t.path)) || "Tab"));
    for (const p of (sec.params || [])) {
      if (p.style === "hidden") continue;
      labels.push(p.label || labelize(p.path));
    }
    if (sec.style === "nodes") labels.push("(workflow nodes)");
    if (sec.style === "raw") labels.push("(raw metadata)");
    if (!labels.length) labels.push("(no fields)");
    for (const l of labels) {
      wrap.appendChild(h("div", { class: "sbg-meta-row" }, [
        h("span", { class: "sbg-meta-label", text: l }),
        h("span", { class: "sbg-meta-value", text: "—" }),
      ]));
    }
    return wrap;
  }

  function makePreviewSection(sec, contentEl) {
    const isOpen = sec.open !== false;
    const secEl = h("div", { class: `sbg-section${isOpen ? " sbg-section--open" : ""}` });
    const head = h("div", { class: "sbg-section__head" }, [h("span", { text: sec.title }), h("span", { class: "sbg-section__chevron", text: "▶" })]);
    head.addEventListener("click", () => secEl.classList.toggle("sbg-section--open"));
    const body = h("div", { class: "sbg-section__body" }, [contentEl]);
    secEl.appendChild(head); secEl.appendChild(body);
    // Match the lightbox panel: section background colours (e.g. green Positive /
    // red Negative) are keyed off this attribute in CSS, so the preview shows the
    // exact same styling as the real panel.
    secEl.dataset.sectionTitle = sec.title || "";
    // Custom section background/colour (overrides the CSS default when set).
    if (sec.color) TL.applyColor(secEl, sec.color);
    return secEl;
  }

  // ── Sync profile order from the left-pane DOM after a drag ───────────
  function syncFromDOM() {
    const cards = [...leftPane.querySelectorAll(".sbg-ly3-seclist > .sbg-ly3-sec")];
    if (!cards.length) { render(); return; }
    const newLayout = [];
    for (const cardEl of cards) {
      const sec = cardEl._section; if (!sec) continue;
      if (sec.tabs && sec.tabs.length) {
        // Tabbed section: rebuild each RENDERED tab's params from its own
        // .sbg-ly3-tabfields (collapsed tabs aren't in the DOM, so keep theirs).
        // This is what lets a field be dragged INTO (or out of) a tab.
        for (const tabRow of cardEl.querySelectorAll(".sbg-ly3-tabrow")) {
          const t = tabRow._tab; if (!t) continue;
          const tf = tabRow.querySelector(".sbg-ly3-tabfields");
          if (tf) t.params = [...tf.querySelectorAll(".sbg-ly3-field")].map(r => r._param).filter(Boolean);
        }
        // Section-level fields shown OUTSIDE the tabs live in the section's own
        // .sbg-ly3-fields (tab fields use .sbg-ly3-tabfields) — rebuild those too, so
        // a field can be dragged between a tab and the outside area.
        const outer = cardEl.querySelector(":scope > .sbg-ly3-secbody > .sbg-ly3-fields");
        if (outer && expanded.has(sec.id)) {
          sec.params = [...outer.querySelectorAll(".sbg-ly3-field")].map(r => r._param).filter(Boolean);
        }
      } else {
        const fieldsEl = cardEl.querySelector(".sbg-ly3-fields");
        if (fieldsEl) {
          const rows = [...fieldsEl.querySelectorAll(".sbg-ly3-field")];
          // only rebuild params from DOM if this section is expanded (rows present);
          // collapsed sections keep their existing params untouched
          if (rows.length || expanded.has(sec.id)) sec.params = rows.map(r => r._param).filter(Boolean);
        }
      }
      newLayout.push(sec);
    }
    profiles[activeKey()] = newLayout;
    persist();
    renderEditor();
    refreshPreview();
  }

  // Cross-section TAB drag: after a tab row is dropped, rebuild every rendered
  // section's `.tabs` from its tab-list DOM (mirrors syncFromDOM, but for whole
  // tabs). Sections whose tab-list isn't in the DOM (collapsed / nodes / raw) keep
  // their tabs untouched.
  function syncTabsFromDOM() {
    const cards = [...leftPane.querySelectorAll(".sbg-ly3-seclist > .sbg-ly3-sec")];
    for (const cardEl of cards) {
      const sec = cardEl._section; if (!sec) continue;
      const tabList = cardEl.querySelector(".sbg-ly3-tablist");
      if (!tabList) continue;
      const hadTabs = !!(sec.tabs && sec.tabs.length);   // model state BEFORE this drop
      const tabs = [...tabList.querySelectorAll(":scope > .sbg-ly3-tabrow")].map(r => r._tab).filter(Boolean);
      if (tabs.length) {
        // A section that just gained its FIRST tab may still hold loose
        // section-level fields — wrap them into a leading tab so they aren't
        // hidden under the tab UI (same idea as the "+ Tab" absorb behaviour).
        // Skip when the section already had tabs (its loose params, if any, were
        // already hidden — don't surface them as a surprise tab).
        if (!hadTabs && sec.params && sec.params.length) {
          const absorb = { id: TL.uid("tab"), label: sec.title || "Tab", style: sec.style || "flat", source: sec.source, params: sec.params };
          expanded.add(absorb.id);
          tabs.unshift(absorb);
          sec.params = [];
        }
        sec.tabs = tabs;
      } else {
        delete sec.tabs;  // last tab dragged out → back to a normal field section
      }
    }
    persist();
    renderEditor();
    refreshPreview();
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  function pathToSearch(path) {
    const parts = String(path).split(".");
    const head = parts[0];
    if (head === "workflow_nodes") return { field: parts[1] || "workflow_nodes", value: "" };
    const HEAD_FIELD = { samplers: "sampling", loras: "lora", controlnet: "controlnet", adetailer: "adetailer", upscaling: "upscaling", interpolation: "interpolation", mmaudio: "mmaudio", extra: "extra", model: "model", vae: "model", clip_skip: "sampling", positive_prompt: "prompt", negative_prompt: "prompt", initial_prompt: "prompt" };
    if (HEAD_FIELD[head]) return { field: HEAD_FIELD[head], value: "" };
    if (["filename", "path", "filesize", "resolution", "modified", "duration", "codec", "fps", "total_frames"].includes(head)) return { field: "fileinfo", value: "" };
    return { field: "any", value: parts[parts.length - 1] };
  }
  function defaultStyleForPath(path) {
    if (/prompt/i.test(path)) return "text";
    if (/^(samplers|loras|controlnet|adetailer|upscaling|interpolation)\./.test(path)) {
      if (/\.(name|label|model)$/.test(path)) return "title";
      return "pill";
    }
    return "kv";
  }
  function buildServerPaths(keys) {
    const paths = new Set();
    ["filename", "path", "filesize", "modified", "resolution", "generation_resolution", "width", "height"].forEach(p => paths.add(p));
    ["duration", "codec", "fps", "total_frames"].forEach(p => paths.add(p));
    ["model", "vae", "clip_skip", "positive_prompt", "negative_prompt", "initial_prompt"].forEach(p => paths.add(p));
    if (keys) {
      const SKIP = new Set(["samplers", "loras", "controlnet", "adetailer", "upscaling", "interpolation", "mmaudio", "extra", "workflow_nodes", "has_prompt", "has_workflow"]);
      for (const sec of (keys.sections || [])) if (!SKIP.has(sec)) paths.add(sec);
      const arr = (list, pfx) => (list || []).forEach(k => paths.add(pfx + "." + k));
      arr(keys.sampler_keys, "samplers"); arr(keys.lora_keys, "loras"); arr(keys.controlnet_keys, "controlnet");
      arr(keys.adetailer_keys, "adetailer"); arr(keys.upscaling_keys, "upscaling"); arr(keys.interpolation_keys, "interpolation");
      arr(keys.mmaudio_keys, "mmaudio"); arr(keys.extra_keys, "extra");
      for (const [ct, ps] of Object.entries(keys.workflow_nodes || {})) for (const pk of ps) paths.add(`workflow_nodes.${ct}.${pk}`);
    }
    return [...paths].sort();
  }

  function mkSelect(opts, current, onChange, title) {
    const sel = document.createElement("select");
    sel.className = "sbg-gs-select--xs";
    if (title) sel.title = title;
    for (const o of opts) { const opt = document.createElement("option"); opt.value = o; opt.textContent = o; if (o === current) opt.selected = true; sel.appendChild(opt); }
    sel.addEventListener("change", () => onChange(sel.value));
    sel.addEventListener("click", (e) => e.stopPropagation());
    return sel;
  }

  // ── Mock sample data (fetched once per media, cached) ───────────────
  // The live preview should show EVERY section the user configured, even if the
  // first example media lacks (say) upscaling. We therefore merge summaries from
  // many items, borrowing each source's example values from whichever item
  // actually has them, and keep fetching until all configured sources are
  // covered (or we hit a cap).
  const _MOCK_ARR = new Set(["samplers", "loras", "controlnet", "adetailer", "upscaling", "interpolation", "workflow_nodes"]);
  const _MOCK_OBJ = new Set(["mmaudio", "extra"]);
  // File-info comes from the gallery item / isn't reliably in the summary — don't
  // let these block "all sources covered".
  const _MOCK_FILE_INFO = new Set(["filename", "path", "filesize", "size", "resolution", "modified",
    "duration", "codec", "fps", "total_frames", "width", "height"]);

  /** Top-level summary keys the active layout actually references. */
  function neededSources() {
    const need = new Set();
    for (const sec of activeLayout()) {
      if (sec.style === "cards") { if (sec.source) need.add(sec.source.split(".")[0]); continue; }
      if (sec.style === "nodes" || sec.style === "raw") { need.add("workflow_nodes"); continue; }
      for (const p of (sec.params || [])) {
        if (!p.path) continue;
        const top = p.path.split(".")[0].replace(/\*$/, "");
        if (top && !_MOCK_FILE_INFO.has(top)) need.add(top);
      }
    }
    return need;
  }

  function ensureMock() {
    if (mockByMedia[activeMedia]) return;
    const items = (galleryCtx && galleryCtx.allItems) || [];
    const wantVideo = activeMedia === "video";
    const pool = items.filter(it => (it.kind === "video") === wantVideo);
    if (!pool.length) { mockByMedia[activeMedia] = {}; return; }

    const MAX_FETCH = 60;
    const sample = pool.slice(0, MAX_FETCH);
    const need = neededSources();
    const merged = {};
    const haveSource = (k) => {
      const v = merged[k];
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === "object") return Object.keys(v).length > 0;
      return v !== undefined && v !== null && v !== "";
    };
    const allCovered = () => [...need].every(haveSource);

    let pending = 0, resolved = 0, done = false;
    const finish = () => {
      if (done) return; done = true;
      const f = sample[0];
      merged.filename = merged.filename || f.filename;
      merged.path = merged.path || f.relpath;
      mockByMedia[activeMedia] = merged;
      refreshPreview(); renderEditor();
    };
    // Late fetches keep enriching `merged` in place after the first render. Repaint
    // (debounced) as they land so fields backed by later-resolved items fill in on
    // their own — previously they stayed blank until an unrelated edit re-rendered.
    let _previewTimer = null;
    const scheduleRefresh = () => {
      clearTimeout(_previewTimer);
      _previewTimer = setTimeout(() => { if (mockByMedia[activeMedia]) refreshPreview(); }, 150);
    };
    const mergeInto = (s) => {
      if (!s || typeof s !== "object") return;
      for (const [k, v] of Object.entries(s)) {
        if (v == null) continue;
        if (_MOCK_ARR.has(k) && Array.isArray(v) && v.length) { if (!merged[k] || !merged[k].length) merged[k] = v; }
        else if (_MOCK_OBJ.has(k) && typeof v === "object") merged[k] = Object.assign({}, v, merged[k]);
        else if (merged[k] === undefined) merged[k] = v;
      }
    };
    for (const it of sample) {
      pending++;
      fetch(`/sidebar_gallery/metadata?root_id=${encodeURIComponent(it.root_id)}&relpath=${encodeURIComponent(it.relpath)}&summary_only=1`)
        .then(r => r.json()).then(m => mergeInto(m.summary || {})).catch(() => {})
        .finally(() => {
          pending--;
          resolved++;
          // Show the preview quickly: as soon as the common sources are covered,
          // or a dozen items have merged, or all are done. (Late results keep
          // enriching `merged` in place even after the first render.)
          if (allCovered() || resolved >= 12 || pending <= 0) finish();
          scheduleRefresh();
        });
    }
    setTimeout(finish, 2500);
  }

  // ── Boot ────────────────────────────────────────────────────────────
  // First open this session: expand the first editable section so the editor
  // isn't a wall of collapsed rows. Reopens keep the remembered view instead.
  if (_viewMemory.fresh) {
    _viewMemory.fresh = false;
    const first = activeLayout().find(s => s.style !== "nodes" && s.style !== "raw");
    if (first) expanded.add(first.id);
  }
  render();
  ensureMock();
  fetch("/sidebar_gallery/meta_keys").then(r => r.json())
    .then(keys => {
      _nodeTitles = (keys && keys.workflow_node_titles) || {};
      _nodeInstances = (keys && keys.workflow_node_instances) || {};
      serverPaths = buildServerPaths(keys);
      // The server now returns the COMPLETE, deterministic key set (aggregated
      // over every file, cached by db_version) instead of a random 500-row
      // sample, so the param picker is consistent across opens. Repaint so the
      // freshly-loaded list shows without needing a re-search.
      if (trayOpen) renderEditor();
    })
    .catch(() => { serverPaths = buildServerPaths(null); if (trayOpen) renderEditor(); });
}
