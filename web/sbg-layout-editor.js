import { h, api } from "./sbg-core.js";
import { showToast, confirmClick, failureText, noticeRow } from "./sbg-toast.js";
import { normalizeColor } from "./sbg-color.js";
import {
  uid, applyColor, autoAnchorFor, pairsHighLow, isNegativePath, absolutizeParamPath, copyRenderProps, RENDER_PROP_KEYS, labelize,
  FILE_INFO_INJECTED, FILE_FACT_FIELDS,
} from "./sbg-translation-layer.js";
import { initSortable, afterSort } from "./sbg-sortable.js";
import { paintSwatch, openColorPopover, placePopover, closePopovers } from "./sbg-color-popover.js";
import { mkSelect, SECTION_STYLES, sectionStyleLabel, canHoldFields, newSection } from "./sbg-layout-helpers.js";
import { schemaRootFields, schemaSections } from "./sbg-schema.js";
import * as layoutStore from "./sbg-layout-store.js";
import { createProfileStore } from "./sbg-layout-profiles.js";
import { createLayoutPreview } from "./sbg-layout-preview.js";
import { makeSection } from "./sbg-meta-section.js";
import { openTransferDialog } from "./sbg-layout-transfer.js";
import { attachOverlayThumb } from "./sbg-overlay-thumb.js";
import { wireListboxKeys } from "./sbg-a11y.js";
import { EYE_ICON, EYE_OFF_ICON, TRASH_ICON, SEARCH_ICON, CHEVRON_RIGHT_ICON, DUPLICATE_ICON, CLOSE_ICON, sizedIcon } from "./sbg-icons.js";

const PARAM_STYLES = ["kv", "pill", "detail", "title", "text", "hidden"];
const PARAM_STYLE_LABELS = { kv: "Row", pill: "Badge", detail: "Detail line", title: "Title", text: "Text box", hidden: "Hidden" };
const paramStyleLabel = (s) => PARAM_STYLE_LABELS[s] || s;

// A server still running an older version sends no catalog rows. Until ComfyUI
// restarts, All fields is one ungrouped list and Cards from and Show when offer
// no lists to pick.
function catalogRows() {
  const rows = Object.entries(schemaSections()).map(([title, r]) => ({ title, ...r }));
  return rows.length ? rows : null;
}

const rowKeys = (test) => (catalogRows() || []).filter(test).map(r => r.key);

const containerRoots = () => rowKeys(r => r.kind === "array" || r.kind === "object");

function pathGroups() {
  const rows = catalogRows();
  if (!rows) return [{ label: "", roots: null }];
  const groups = [];
  let prompts = null;
  for (const r of rows) {
    if (r.kind !== "text") {
      groups.push({ label: r.title, roots: r.kind === "fileinfo" ? [...FILE_INFO_INJECTED, ...r.summary_keys] : r.summary_keys });
    } else if (prompts) {
      prompts.roots.push(...r.summary_keys);
    } else {
      groups.push(prompts = { label: "Prompts", roots: [...r.summary_keys] });
    }
  }
  groups.push({ label: "Other", roots: null });
  return groups;
}

let _nodeTitles = {};

// Keyed by class type, each value a list of that type's instances as
// {index, title?, from?, params}.
let _nodeInstances = {};

function labelWithNodeTitle(path, inst) {
  if (path.startsWith("workflow_nodes.")) {
    const { ct, pk } = splitNodePath(path.split("."));
    const title = _nodeTitles[ct];
    let nodeLabel = title && title !== ct ? `${title} (${ct})` : ct;
    if (inst) nodeLabel = instanceLabel(ct, inst);
    return pk ? `${nodeLabel} → ${labelize(pk)}` : nodeLabel;
  }
  return labelize(path);
}

function instanceLabel(ct, inst) {
  if (inst.title) return `${ct}: “${inst.title}”`;
  if (inst.from) return `${ct} (from ${inst.from})`;
  return `${ct} #${(inst.index || 0) + 1}`;
}

function matchForInstance(inst) {
  if (inst.title) return { title: inst.title };
  if (inst.from) return { from: inst.from };
  return { index: inst.index || 0 };
}

function instancesForType(ct) {
  const insts = _nodeInstances[ct];
  return Array.isArray(insts) && insts.length > 1 ? insts : null;
}

// A class name can itself contain dots, so the longest prefix naming a known
// class is taken as the class.
function splitNodePath(parts) {
  for (let i = parts.length; i >= 2; i--) {
    const cls = parts.slice(1, i).join(".");
    if (_nodeTitles[cls] !== undefined || _nodeInstances[cls] !== undefined) {
      return { ct: cls, pk: i < parts.length ? parts.slice(i).join(".") : null };
    }
  }
  return { ct: parts[1], pk: parts.length > 2 ? parts.slice(2).join(".") : null };
}

function expandPathItems(pth) {
  if (pth.startsWith("workflow_nodes.")) {
    const { ct, pk } = splitNodePath(pth.split("."));
    const insts = instancesForType(ct);
    if (insts) {
      // Instances of one type can carry different params, so only those
      // holding this one are offered.
      const matching = insts.filter(inst =>
        !(pk && Array.isArray(inst.params) && inst.params.length && !inst.params.includes(pk)));

      const items = [{ path: pth, match: null, label: labelWithNodeTitle(pth) }];
      if (matching.length > 1) {
        for (const inst of matching) {
          items.push({ path: pth, match: matchForInstance(inst), label: labelWithNodeTitle(pth, inst) });
        }
      }
      return items;
    }
  }
  return [{ path: pth, match: null, label: labelWithNodeTitle(pth) }];
}

const _matchKey = (pth, match) => pth + "|" + JSON.stringify(match || null);

const alreadyInMessage = (owner) => `Already in "${(owner && (owner.title || owner.label)) || "section"}".`;

function matchChipText(match) {
  if (!match) return "";
  if (match.title) return `“${match.title}”`;
  if (match.from) return `from ${match.from}`;
  return `#${(match.index || 0) + 1}`;
}

const _openOptionPopups = new Set();

function closeOptionPopups() {
  for (const close of [..._openOptionPopups]) { try { close(); } catch { } }
  _openOptionPopups.clear();
}

const LIST_KEYS = ["ArrowDown", "ArrowUp", "Enter", "Escape"];

function _attachOptionsPopup(inp, label, getOptions) {
  let popup = null;
  const close = () => {
    if (popup) { popup.remove(); popup = null; inp.removeAttribute("aria-activedescendant"); }
    _openOptionPopups.delete(close);
  };
  const open = () => {
    close();
    popup = h("div", { class: "sbg-dropdown sbg-dropdown--settings", role: "listbox", "aria-label": label });
    for (const opt of getOptions()) {
      const on = opt.value === inp.value;
      const item = h("div", {
        class: `sbg-dropdown__item${on ? " sbg-dropdown__item--active" : ""}`,
        role: "option", "aria-selected": on ? "true" : "false", text: opt.label,
      });
      // Pressing a row would take the focus from the input and close the list.
      item.addEventListener("mousedown", (ev) => ev.preventDefault());
      item.addEventListener("click", () => {
        inp.value = opt.value;
        inp.dispatchEvent(new Event("change"));
        close();
      });
      popup.appendChild(item);
    }
    document.body.appendChild(popup);
    const rect = inp.getBoundingClientRect();
    popup.style.left = rect.left + "px";
    popup.style.top = (rect.bottom + 2) + "px";
    popup.style.minWidth = rect.width + "px";
    _openOptionPopups.add(close);
    wireListboxKeys(popup, {
      markClass: "sbg-dropdown__item--kbd",
      activeDescendantEl: inp,
      takeFocus: false,
      onEscape: close,
    });
  };
  inp.addEventListener("focus", open);
  inp.addEventListener("click", open);
  inp.addEventListener("blur", () => setTimeout(close, 120));
  // The list sits on the body outside the input's path, so the input forwards
  // the keys a list answers.
  inp.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" && !popup) open();
    if (!popup || !LIST_KEYS.includes(ev.key)) return;
    if (!popup.dispatchEvent(new KeyboardEvent("keydown", { key: ev.key, cancelable: true }))) {
      ev.preventDefault();
      ev.stopPropagation();
    } else if (ev.key === "Enter") {
      // Enter with no row marked keeps what was typed.
      close();
    }
  });
}

const _sourceBoxes = new WeakMap();

function _buildCardSourceUI(obj, body, onSourceChange, onPairChange) {
  const help = "What each card shows. Pick a list, such as loras, for one card per entry. Left empty, it uses the list most fields read from, such as LoRAs, or else makes one card for the whole file. You can also type workflow_nodes.<NodeType> for one card per node of that type.";
  const wrap = h("div", { class: "sbg-ly3-src" });
  wrap.appendChild(h("span", { text: "Cards from:", title: help }));
  const inp = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm", placeholder: "Auto, or loras, samplers…", value: obj.source || "", title: help });
  _sourceBoxes.set(obj, inp);
  inp.addEventListener("change", () => {
    const hadFocus = document.activeElement === inp;
    obj.source = inp.value.trim() || undefined;
    onSourceChange();
    // The redraw replaced this box, so the focus moves to the new one, and the
    // list that focusing opens is closed again.
    const next = _sourceBoxes.get(obj);
    if (hadFocus && next !== inp) { next.focus(); closeOptionPopups(); }
  });
  _attachOptionsPopup(inp, "Cards from", () => [
    { value: "", label: "Auto" },
    ...containerRoots().map(s => ({ value: s, label: s })),
  ]);
  wrap.appendChild(inp);

  const pairLbl = h("label", { class: "sbg-ly3-openlbl", title: "Show high-noise and low-noise entries side by side, as in Wan 2.2" });
  const pairCb = h("input", { type: "checkbox" });
  pairCb.checked = pairsHighLow(obj, obj.source || autoAnchorFor(obj));
  pairCb.addEventListener("change", () => { obj.highlow = pairCb.checked; onPairChange(); });
  pairLbl.appendChild(pairCb); pairLbl.appendChild(document.createTextNode("Pair High and Low Noise"));
  wrap.appendChild(pairLbl);
  body.appendChild(wrap);
}

function _buildShowWhenUI(obj, body, onChange) {
  const help = "When to show this. Auto shows it only when the file has the data most of its fields read, such as LoRAs. Always shows it whenever any field has a value. You can also type a data source, such as controlnet or workflow_nodes.<NodeType>, to show it only when the file has that.";
  const wrap = h("div", { class: "sbg-ly3-src" });
  wrap.appendChild(h("span", { text: "Show when:", title: help }));
  const auto = autoAnchorFor(obj);
  const inp = h("input", {
    type: "text", class: "sbg-gs-input sbg-gs-input--sm",
    placeholder: auto ? `Auto (when ${auto} exists)` : "(auto)",
    value: obj.showWhen || "", title: help,
  });
  inp.addEventListener("change", () => { obj.showWhen = inp.value.trim() || undefined; onChange(); });
  _attachOptionsPopup(inp, "Show when", () => [
    { value: "", label: auto ? `Auto (when ${auto} exists)` : "Auto" },
    { value: "always", label: "Always" },
    ...containerRoots().map(s => ({ value: s, label: `when ${s} exists` })),
  ]);
  wrap.appendChild(inp);
  body.appendChild(wrap);
}

// A swatch with no color picked shows what the stylesheet and theme give the
// element, so a hidden copy is measured inside the settings overlay. It carries
// the classes the renderer emits, under the section and tab it inherits from.
function measureSwatchDefaults(kind, sec, tab) {
  let el, textEl = null;
  if (kind === "pill") el = h("span", { class: "sbg-badge", text: "x" });
  else if (kind === "tabpill") el = h("button", { class: "sbg-prompt-pill", text: "x" });
  else if (kind === "tabbody") el = h("div", { class: "sbg-tab-body", text: "x" });
  else if (kind === "section") { el = h("div", { class: "sbg-section" }); if (sec && sec.title) el.dataset.sectionTitle = sec.title; }
  else if (kind === "kv") {
    el = h("div", { class: "sbg-meta-row" });
    el.appendChild(h("span", { class: "sbg-meta-label", text: "L" }));
    textEl = h("span", { class: "sbg-meta-value", text: "x" });
    el.appendChild(textEl);
  }
  else if (kind === "detail") el = h("div", { class: "sbg-meta-card__detail", text: "x" });
  else if (kind === "title") el = h("div", { class: "sbg-meta-card__title", text: "x" });
  else if (kind === "text-neg") el = h("div", { class: "sbg-prompt-text sbg-prompt-text--neg", text: "x" });
  else el = h("div", { class: "sbg-prompt-text", text: "x" });

  let outer = el;
  if (kind !== "section") {
    if (tab) {
      const tb = h("div", { class: "sbg-tab-body" }, [outer]);
      if (tab.color) applyColor(tb, tab.color);
      outer = tb;
    }
    outer = makeSection({ title: sec && sec.title, color: sec && sec.color, open: true }, outer, { remember: false });
  }
  const probe = h("div", { class: "sbg-probe" }, [outer]);
  (document.querySelector(".sbg-gs-overlay") || document.body).appendChild(probe);
  let out;
  try {
    const cs = getComputedStyle(el);
    // An element with no border still reports a border color, which would show
    // as a stripe on the swatch.
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
    out = {
      bg: normalizeColor(cs.backgroundColor),
      text: normalizeColor(textEl ? getComputedStyle(textEl).color : cs.color),
      border: hasBorder ? normalizeColor(cs.borderTopColor) : "rgba(0, 0, 0, 0)",
    };
  } catch { out = {}; }
  probe.remove();
  return out;
}

// On the module since the settings overlay is discarded when it closes, and the
// tab reopens where it was left.
const _viewMemory = { app: "comfyui", media: "image", expanded: new Set(), expandedByKey: {}, trayOpen: false, fresh: true };

// What this version stores on a section or a tab. A later version may add
// properties, so a conversion carries every other one over as it is.
const OWN_PROPS = new Set(["id", "title", "label", "style", "open", "params", "tabs", "hidden", "fieldsAbove", "pillColor", ...RENDER_PROP_KEYS]);
const laterProps = (o) => Object.keys(o).filter((k) => !OWN_PROPS.has(k));
function carryLaterProps(src, dst) {
  for (const k of laterProps(src)) dst[k] = structuredClone(src[k]);
  return dst;
}

// Render properties carry across both ways, so a section merged in as a tab
// looks the same. `hidden` stays behind since a tab has no control to undo it.
export function tabFromSection(sec) {
  return carryLaterProps(sec, copyRenderProps(sec, { id: uid("tab"), label: sec.title || "Tab 1", style: sec.style || "flat", params: sec.params || [] }));
}
export function sectionFromTab(tab) {
  const sec = carryLaterProps(tab, copyRenderProps(tab, newSection(tab.label || "New Section", tab.params || [])));
  sec.style = tab.style || "flat";
  return sec;
}

function detachTab(sec, tab) {
  const i = (sec.tabs || []).indexOf(tab);
  if (i >= 0) sec.tabs.splice(i, 1);
  if (sec.tabs && !sec.tabs.length) delete sec.tabs;
}
function detachParam(owner, p) {
  const i = (owner.params || []).indexOf(p);
  if (i >= 0) owner.params.splice(i, 1);
}

function setHidden(p, on) {
  if (on === (p.style === "hidden")) return;
  if (on) { p._prevStyle = p.style || "kv"; p.style = "hidden"; }
  else { p.style = p._prevStyle || "kv"; delete p._prevStyle; }
}

function _mkParam(pth, match) {
  const param = { path: pth, label: labelize(pth), style: defaultStyleForPath(pth) };
  if (match) param.match = match;
  return param;
}

export { absolutizeParamPath };

// What a field's find button submits, parsed as if typed in the search bar. A
// wildcard names no one path, so it searches the search field that reads it.
export function searchSpelling(path, source) {
  const abs = absolutizeParamPath(path, source);
  if (abs.includes("*")) return pathToSearch(abs) + ":";
  return abs + ":";
}

export function pathToSearch(path) {
  const parts = String(path).split(".");
  const head = parts[0];
  if (head === "workflow_nodes") return splitNodePath(parts).ct || "workflow_nodes";
  return schemaRootFields()[head] || FILE_FACT_FIELDS[head] || "any";
}

function defaultStyleForPath(path) {
  if (/prompt/i.test(path)) return "text";
  const parts = path.split(".");
  if (parts.length > 1 && rowKeys(r => r.kind === "array").includes(parts[0])) {
    if (/\.(name|label|model)$/.test(path)) return "title";
    return "pill";
  }
  return "kv";
}

function buildFieldPaths(keys) {
  const paths = new Set(FILE_INFO_INJECTED);
  for (const r of catalogRows() || []) {
    if (r.kind === "fileinfo" || r.kind === "scalar" || r.kind === "text") for (const k of r.summary_keys) paths.add(k);
  }
  if (keys) {
    const skip = new Set(keys.non_bindable);
    for (const sec of (keys.sections || [])) if (!skip.has(sec)) paths.add(sec);
    const skipEl = keys.non_bindable_element;
    // Absent from a server still running an older version, which offers none of these until ComfyUI restarts.
    for (const [sec, list] of Object.entries(keys.element_keys || {})) {
      for (const k of list) if (!(skipEl[sec] || []).includes(k)) paths.add(sec + "." + k);
    }
    for (const [ct, ps] of Object.entries(keys.workflow_nodes || {})) for (const pk of ps) paths.add(`workflow_nodes.${ct}.${pk}`);
  }
  return [...paths].sort();
}

/** `cleanups` is the settings panel's list for this visit, drained when the
 *  panel closes or another tab opens. */
export function renderLayout(content, galleryCtx, closeGS, cleanups) {
  content.innerHTML = "";

  // The option lists and popovers sit on the body, and closing the panel from
  // the keyboard fires neither the blur nor the mousedown that closes them.
  if (cleanups) cleanups.push(closeOptionPopups, closePopovers);

  let fieldPaths = null;
  let fieldPathsError = null;
  // The failure the person closed, which the tab's redraws leave closed.
  let closedFieldError = null;

  let trayFilter = "";
  // The copy dialog holds this same Set, so switching profiles refills it
  // instead of replacing it.
  const expanded = _viewMemory.expanded;

  // Measured defaults hold while this tab is open, since the theme changes only
  // from another settings tab.
  const swatchCache = new Map();
  function swatchDefaults(kind, sec, tab) {
    const key = [
      kind,
      sec ? (sec.title || "") : "",
      (kind !== "section" && sec && sec.color) ? JSON.stringify(sec.color) : "",
      (tab && tab.color) ? JSON.stringify(tab.color) : "",
    ].join("|");
    if (!swatchCache.has(key)) swatchCache.set(key, measureSwatchDefaults(kind, sec, tab));
    return swatchCache.get(key);
  }

  function activeKey() { return layoutStore.profileKey(_viewMemory.app, _viewMemory.media); }

  function _swapExpanded(fromKey, toKey) {
    _viewMemory.expandedByKey[fromKey] = new Set(expanded);
    const next = _viewMemory.expandedByKey[toKey];
    expanded.clear();
    if (next) for (const id of next) expanded.add(id);
  }

  const _profileStore = createProfileStore(layoutStore);
  const { layoutFor, persistKeys } = _profileStore;
  function activeLayout() { return layoutFor(_viewMemory.app, _viewMemory.media); }

  // A refused save has dropped the edited copy, so the tab is drawn again from
  // the layout in use.
  function persist() {
    if (persistKeys([activeKey()])) return true;
    render();
    return false;
  }

  // Every way a section gains its first tab comes through here. Cards from and
  // pairing do nothing on a section with tabs, so they move to the first tab
  // while Show when stays. The caller places `tab`, which is null when the
  // loose fields make the only tab.
  function startTabs(sec, tab) {
    if (!Array.isArray(sec.tabs)) sec.tabs = [];
    let first = tab;
    if ((sec.params || []).length) {
      first = tabFromSection(sec);
      delete first.showWhen;
      // The section stays, so it keeps what a later version put on it.
      for (const k of laterProps(sec)) delete first[k];
      sec.params = [];
      sec.tabs.unshift(first);
      expanded.add(first.id);
    }
    for (const k of ["source", "highlow"]) {
      if (sec[k] == null) continue;
      if (first[k] == null) first[k] = sec[k];
      delete sec[k];
    }
  }

  function appendTabToSection(sec, tab) {
    if (!(sec.tabs || []).length) startTabs(sec, tab);
    sec.tabs.push(tab);
  }

  const elToSection = new WeakMap();
  const elToTab = new WeakMap();
  const elToParam = new WeakMap();
  const elToTrayItem = new WeakMap();
  const containerToList = new WeakMap();

  function listOf(container) {
    const d = container && containerToList.get(container);
    if (!d) return null;
    if (d.kind === "sections") return activeLayout();
    if (d.kind === "tabs") { if (!Array.isArray(d.sec.tabs)) d.sec.tabs = []; return d.sec.tabs; }
    if (!Array.isArray(d.owner.params)) d.owner.params = [];
    return d.owner.params;
  }

  function ownerArrayOf(obj, kind) {
    const l = activeLayout();
    if (kind === "section") return l.includes(obj) ? l : null;
    for (const sec of l) {
      if (kind === "tab") {
        if (Array.isArray(sec.tabs) && sec.tabs.includes(obj)) return sec.tabs;
        continue;
      }
      if (Array.isArray(sec.params) && sec.params.includes(obj)) return sec.params;
      for (const t of (sec.tabs || [])) if (Array.isArray(t.params) && t.params.includes(obj)) return t.params;
    }
    return null;
  }
  function dropIndex(container, el, itemSelector) {
    let i = 0;
    for (const ch of container.children) {
      if (ch === el) break;
      if (ch.matches && ch.matches(itemSelector)) i++;
    }
    return i;
  }

  // The sortable has already moved the element, so its new list and index are
  // read from the DOM.
  function applyDrop(el, kind, itemSelector) {
    const obj = kind === "section" ? elToSection.get(el) : kind === "tab" ? elToTab.get(el) : elToParam.get(el);
    const container = el.parentNode;
    const meta = container && containerToList.get(container);
    const src = obj ? ownerArrayOf(obj, kind) : null;

    const destSec = meta && meta.kind === "tabs" ? meta.sec : null;
    const hadTabs = !!(destSec && (destSec.tabs || []).length);
    const dst = listOf(container);
    if (!obj || !src || !dst) { renderEditor(); refreshPreview(); return; }

    const idx = dropIndex(container, el, itemSelector);
    src.splice(src.indexOf(obj), 1);
    dst.splice(idx, 0, obj);
    if (destSec && !hadTabs) startTabs(destSec, obj);

    if (kind === "tab") for (const sec of activeLayout()) if (Array.isArray(sec.tabs) && !sec.tabs.length) delete sec.tabs;
    persist();
    renderEditor();
    refreshPreview();
  }

  const secConvertTargets = (band) => ({ selector: ".sbg-ly3-sec", accepts: (el) => canHoldFields(elToSection.get(el)), band, className: "sbg-ly3-sec--droptarget" });
  const SEC_PROMOTE = { containerSelector: ".sbg-ly3-seclist", itemSelector: ".sbg-ly3-sec", label: "Drops here as its own section" };

  function mergeSectionIntoSection(src, tgt) {
    const l = activeLayout();
    const i = l.indexOf(src);
    if (i >= 0) l.splice(i, 1);
    const srcTabs = src.tabs || [];

    if ((src.params || []).length || !srcTabs.length) appendTabToSection(tgt, tabFromSection(src));
    for (const t of srcTabs) appendTabToSection(tgt, t);
    expanded.delete(src.id);
    expanded.add(tgt.id);
    if (persist()) layoutStore.forgetPromptTabs([src.id]);
    render();
  }

  function moveTabIntoSection(srcSec, tab, tgt) {
    detachTab(srcSec, tab);
    appendTabToSection(tgt, tab);
    expanded.add(tgt.id);
    persist(); render();
  }

  function promoteTabToSection(srcSec, tab, index) {
    detachTab(srcSec, tab);
    const ns = sectionFromTab(tab);
    const l = activeLayout();
    l.splice(index, 0, ns);
    expanded.add(ns.id);
    persist(); render();
  }

  function moveFieldIntoSection(owner, p, tgt) {
    detachParam(owner, p);
    if (!tgt.params) tgt.params = [];
    tgt.params.push(p);
    expanded.add(tgt.id);
    persist(); render();
  }

  function promoteFieldToSection(owner, p, index) {
    detachParam(owner, p);
    const ns = newSection(p.label || labelize(p.path), [p]);
    const l = activeLayout();
    l.splice(index, 0, ns);
    expanded.add(ns.id);
    persist(); render();
  }

  const wrap = h("div", { class: "sbg-ly3" });
  const topBar = h("div", { class: "sbg-ly3-top" });
  const split = h("div", { class: "sbg-ly3-split" });
  const leftPane = h("div", { class: "sbg-ly3-edit" });
  const rightPane = h("div", { class: "sbg-ly3-preview" });
  attachOverlayThumb(leftPane);
  attachOverlayThumb(rightPane);
  split.appendChild(leftPane);
  split.appendChild(rightPane);
  wrap.appendChild(topBar);
  wrap.appendChild(split);
  content.appendChild(wrap);

  const { refreshPreview, ensureMock } = createLayoutPreview({
    rightPane,
    getMedia: () => _viewMemory.media,
    activeLayout,
    activeKey,
    galleryCtx,
  });

  function renderTopBar() {
    topBar.innerHTML = "";
    const appWrap = h("div", { class: "sbg-btn-row" });
    for (const app of layoutStore.APPS) {
      const b = h("button", { class: `sbg-btn sbg-btn--sm${_viewMemory.app === app ? " sbg-btn--accent" : ""}`, text: layoutStore.APP_LABELS[app] });
      b.addEventListener("click", () => { const from = activeKey(); _viewMemory.app = app; _swapExpanded(from, activeKey()); render(); });
      appWrap.appendChild(b);
    }
    topBar.appendChild(appWrap);
    topBar.appendChild(h("span", { class: "sbg-ly3-sep" }));
    const medWrap = h("div", { class: "sbg-btn-row" });
    for (const med of layoutStore.MEDIA_KEYS) {
      const b = h("button", { class: `sbg-btn sbg-btn--sm${_viewMemory.media === med ? " sbg-btn--accent" : ""}`, text: layoutStore.MEDIA_LABELS[med] });
      b.addEventListener("click", () => { const from = activeKey(); _viewMemory.media = med; _swapExpanded(from, activeKey()); ensureMock(); render(); });
      medWrap.appendChild(b);
    }
    topBar.appendChild(medWrap);

    const actions = h("div", { class: "sbg-ly3-actions" });
    const xfer = h("button", {
      class: "sbg-btn sbg-btn--sm sbg-btn--iconlabel", html: `${sizedIcon(DUPLICATE_ICON, 12)}Copy between layouts`,
      title: "Copy sections or tabs from one layout into another",
    });
    xfer.addEventListener("click", () => {
      const close = openTransferDialog({ activeKey, layoutFor, persistKeys, appendTabToSection, expanded, render });
      if (cleanups) cleanups.push(close);
    });
    actions.appendChild(xfer);

    const ownsDefault = _viewMemory.app === "comfyui";
    const reset = h("button", {
      class: "sbg-btn sbg-btn--sm", text: "Reset",
      title: ownsDefault ? "Reset this layout to the default" : "Use the ComfyUI layout again instead of this one",
    });
    confirmClick(reset, () => {
      const dropped = activeLayout().map((s) => s.id);
      _profileStore.reset(activeKey());
      const kept = persist();
      if (kept) layoutStore.forgetPromptTabs(dropped);
      render();
      // A reset to the default shows on the tab, while handing the layout back
      // to ComfyUI's can leave the tab looking the same, so only that one is announced.
      if (kept && !ownsDefault) showToast(`This layout now follows the ComfyUI layout for ${layoutStore.MEDIA_LABELS[_viewMemory.media].toLowerCase()}.`);
    }, { armClass: "sbg-btn--danger" });
    actions.appendChild(reset);
    topBar.appendChild(actions);
  }

  function render() {
    renderTopBar();
    renderEditor();
    refreshPreview();
  }

  function renderEditor() {
    // A list on the body can outlive its input, since removing a focused input
    // can fire no blur.
    closeOptionPopups();
    leftPane.innerHTML = "";
    leftPane.appendChild(h("div", { class: "sbg-ly3-hint", text: "Drag ⋮⋮ to move a section, tab or field. Open a section to edit its fields, or add fields from All fields below." }));

    const list = h("div", { class: "sbg-ly3-seclist" });
    containerToList.set(list, { kind: "sections" });
    leftPane.appendChild(list);
    for (const sec of activeLayout()) list.appendChild(buildSectionEditor(sec, list));

    const addSec = h("button", { class: "sbg-btn sbg-btn--sm sbg-ly3-addsec", text: "+ Add section" });
    addSec.addEventListener("click", () => {
      const sec = newSection("New Section", []);
      expanded.add(sec.id);
      activeLayout().push(sec); persist(); render();
    });
    leftPane.appendChild(addSec);

    leftPane.appendChild(buildTray());
  }

  function buildSectionEditor(sec, list) {
    const isOpen = expanded.has(sec.id);
    const card = h("div", { class: "sbg-ly3-sec" + (sec.hidden ? " sbg-ly3-sec--hidden" : "") });
    elToSection.set(card, sec);

    const head = h("div", { class: "sbg-ly3-sechead" });
    const grip = h("span", { class: "sbg-grip", text: "⋮⋮", title: "Drag to move. Drop onto another section to merge it in as tabs." });
    head.appendChild(grip);

    const exp = h("button", { class: "sbg-ly3-exp" + (isOpen ? " sbg-ly3-exp--open" : ""), html: sizedIcon(CHEVRON_RIGHT_ICON, 11), title: "Open or close this section" });
    exp.addEventListener("click", () => { if (isOpen) expanded.delete(sec.id); else expanded.add(sec.id); renderEditor(); });
    head.appendChild(exp);

    const eye = h("button", { class: "sbg-btn sbg-btn--icon", title: sec.hidden ? "Hidden from panel. Click to show" : "Shown in panel. Click to hide", html: sizedIcon(sec.hidden ? EYE_OFF_ICON : EYE_ICON, 14) });
    eye.addEventListener("click", () => { sec.hidden = !sec.hidden; persist(); render(); });
    head.appendChild(eye);

    const title = h("input", { type: "text", class: "sbg-ly3-title", value: sec.title || "", placeholder: "Section title" });
    title.addEventListener("input", () => { sec.title = title.value || "Untitled"; persist(); refreshPreview(); });
    head.appendChild(title);

    const hasTabs = (sec.tabs || []).length > 0;
    const styleSel = mkSelect(SECTION_STYLES, sec.style || "flat", (v) => { sec.style = v; persist(); renderEditor(); refreshPreview(); }, sectionStyleLabel, { title: "How this section shows its fields" });
    // The panel draws a section's tabs whatever its style, so these two styles
    // wait until the tabs are gone.
    if (hasTabs) {
      for (const o of styleSel.children) {
        if (o.value === "nodes" || o.value === "raw") { o.disabled = true; o.title = "Remove this section's tabs to use this style"; }
      }
    }
    head.appendChild(styleSel);

    const secColorBtn = h("button", { class: "sbg-btn sbg-btn--icon", title: "Section colors" });
    paintSwatch(secColorBtn, sec.color, swatchDefaults("section", sec));
    secColorBtn.addEventListener("click", () => openColorPicker(secColorBtn, sec, sec, "color", "section"));
    head.appendChild(secColorBtn);

    const openLbl = h("label", { class: "sbg-ly3-openlbl", title: "Show this section open by default in the metadata panel" });
    const openCb = h("input", { type: "checkbox" }); openCb.checked = sec.open !== false;
    openCb.addEventListener("change", () => { sec.open = openCb.checked; persist(); refreshPreview(); });
    openLbl.appendChild(openCb); openLbl.appendChild(document.createTextNode("Starts Open"));
    head.appendChild(openLbl);

    const del = h("button", { class: "sbg-btn sbg-btn--icon sbg-btn--icon-danger", title: "Delete section", html: TRASH_ICON });
    confirmClick(del, () => {
      const l = activeLayout(); const i = l.indexOf(sec); if (i >= 0) l.splice(i, 1); expanded.delete(sec.id);
      if (persist()) layoutStore.forgetPromptTabs([sec.id]);
      render();
    });
    head.appendChild(del);
    card.appendChild(head);

    if (isOpen) {
      const body = h("div", { class: "sbg-ly3-secbody" });
      // A saved section can pair tabs with one of these styles, and the panel
      // still draws the tabs, so they stay here to be removed.
      const drawsItself = (sec.style === "nodes" || sec.style === "raw") && !hasTabs;
      const addFieldsList = (emptyText) => {
        const fields = h("div", { class: "sbg-ly3-fields" });
        containerToList.set(fields, { kind: "params", owner: sec });
        for (const p of (sec.params || [])) fields.appendChild(buildFieldRow(sec, p, fields));
        if (!(sec.params || []).length) fields.appendChild(h("div", { class: "sbg-ly3-empty", text: emptyText }));
        body.appendChild(fields);
        const addField = h("button", { class: "sbg-ly3-addfield", text: "+ Add field" });
        addField.addEventListener("click", () => openAddFieldPicker(addField, sec));
        body.appendChild(addField);
      };

      if (!drawsItself) body.appendChild(buildTabsEditor(sec));

      if (sec.style === "cards" && !hasTabs) {
        _buildCardSourceUI(sec, body, () => { persist(); renderEditor(); refreshPreview(); }, () => { persist(); refreshPreview(); });
      }

      _buildShowWhenUI(sec, body, () => { persist(); refreshPreview(); });

      if (drawsItself) {
        body.appendChild(h("div", { class: "sbg-ly3-auto", text: sec.style === "nodes" ? "Shows every workflow node. There are no fields to set up here." : "Shows the file's raw metadata. There are no fields to set up here." }));
      } else if (!hasTabs) {
        addFieldsList("No fields yet. Drag one in from All fields below, or click + Add field.");
      } else {
        const ofHead = h("div", { class: "sbg-ly3-outerfields-head" });
        ofHead.appendChild(h("span", {
          class: "sbg-ly3-tabsed-label", text: "Fields outside tabs",
          title: "Fields shown with every tab. Drag fields here from All fields or from a tab.",
        }));
        const posLbl = h("label", { class: "sbg-ly3-openlbl" });
        const posCb = h("input", { type: "checkbox" }); posCb.checked = !!sec.fieldsAbove;
        posCb.addEventListener("change", () => { sec.fieldsAbove = posCb.checked || undefined; persist(); refreshPreview(); });
        posLbl.appendChild(posCb); posLbl.appendChild(document.createTextNode("Show Above Tabs"));
        ofHead.appendChild(posLbl);
        body.appendChild(ofHead);
        addFieldsList("No fields outside the tabs. Drag one here, or click + Add field.");
      }
      card.appendChild(body);
    }

    initSortable(list, grip, card, {
      itemSelector: ".sbg-ly3-sec",

      // On the middle band a section merges into the target as tabs, and on
      // either edge it reorders.
      convertTargets: secConvertTargets([0.3, 0.7]),
      onDrop: (itm, info) => {
        const tgt = info && info.convertEl && elToSection.get(info.convertEl);
        if (tgt) mergeSectionIntoSection(sec, tgt);
        else applyDrop(itm, "section", ".sbg-ly3-sec");
      },
    });
    return card;
  }

  function buildFieldRow(owner, p, fields, opts = {}) {
    const hostSec = opts.inSec || owner;
    const hostTab = opts.inSec ? owner : null;
    const hidden = p.style === "hidden";
    const row = h("div", { class: "sbg-ly3-field" + (hidden ? " sbg-ly3-field--hidden" : "") });
    elToParam.set(row, p);

    row.appendChild(h("span", { class: "sbg-grip sbg-ly3-fieldgrip", text: "⋮⋮", title: "Drag to move. Dropping it between sections makes it a section of its own." }));

    // The panel labels a field with no label of its own automatically, while a
    // wildcard's rows take their keys, so its box starts empty.
    const autoLabel = String(p.path || "").endsWith(".*") ? "" : labelize(p.path);
    const lbl = h("input", { type: "text", class: "sbg-ly3-fieldlabel", value: typeof p.label === "string" ? p.label : autoLabel, placeholder: "No label" });
    lbl.title = p.path;

    lbl.addEventListener("input", () => { p.label = lbl.value; persist(); refreshPreview(); });
    row.appendChild(lbl);

    row.appendChild(h("span", { class: "sbg-ly3-fieldpath", text: p.path, title: p.path }));

    if (p.match) {
      const chip = h("span", {
        class: "sbg-ly3-matchchip",
        title: "Reads only one node of this type (" + matchChipText(p.match) + "). Click the cross to read all of them again.",
      });
      chip.appendChild(h("span", { class: "sbg-ly3-matchchip__txt", text: matchChipText(p.match) }));
      const clearX = h("button", {
        type: "button", class: "sbg-ly3-matchchip__x", html: sizedIcon(CLOSE_ICON, 10),
        title: "Read every node of this type again", "aria-label": "Read every node of this type again",
      });
      clearX.addEventListener("click", () => { delete p.match; persist(); renderEditor(); refreshPreview(); });
      chip.appendChild(clearX);
      row.appendChild(chip);
    }

    const styleSel = mkSelect(PARAM_STYLES, p.style || "kv", (v) => {
      setHidden(p, v === "hidden");
      if (v !== "hidden") p.style = v;
      persist(); renderEditor(); refreshPreview();
    }, paramStyleLabel, { title: "How this field is shown" });
    row.appendChild(styleSel);

    const tools = h("div", { class: "sbg-ly3-fieldtools" });
    const effStyle = hidden ? (p._prevStyle || "kv") : (p.style || "kv");
    if (effStyle === "pill") {
      const fmt = h("input", { type: "text", class: "sbg-ly3-fmt", value: p.format || "", placeholder: "Format, such as CFG {v}" });
      fmt.addEventListener("input", () => { p.format = fmt.value.trim() || undefined; persist(); refreshPreview(); });
      tools.appendChild(fmt);
    }
    const _ckind = effStyle === "text" && isNegativePath(p.path) ? "text-neg" : effStyle;
    const colorBtn = h("button", { class: "sbg-btn sbg-btn--icon", title: "Field colors" });
    paintSwatch(colorBtn, p.color, swatchDefaults(_ckind, hostSec, hostTab));
    colorBtn.addEventListener("click", () => openColorPicker(colorBtn, p, hostSec, "color", _ckind, hostTab));
    tools.appendChild(colorBtn);
    if (pathToSearch(absolutizeParamPath(p.path, owner.source)) !== "app") {
      const findBtn = h("button", { class: "sbg-btn sbg-btn--icon", title: "Search for files that have this field", html: SEARCH_ICON });
      findBtn.addEventListener("click", () => {
        const spelling = searchSpelling(p.path, owner.source);
        if (closeGS) closeGS();
        document.dispatchEvent(new CustomEvent("sbg-search-submit", { detail: { spelling } }));
      });
      tools.appendChild(findBtn);
    }
    const eyeBtn = h("button", { class: "sbg-btn sbg-btn--icon", title: hidden ? "Hidden. Click to show" : "Shown. Click to hide", html: sizedIcon(hidden ? EYE_OFF_ICON : EYE_ICON, 14) });
    eyeBtn.addEventListener("click", () => { setHidden(p, !hidden); persist(); renderEditor(); refreshPreview(); });
    tools.appendChild(eyeBtn);
    const delBtn = h("button", { class: "sbg-btn sbg-btn--icon sbg-btn--icon-danger", title: "Remove field", html: TRASH_ICON });
    delBtn.addEventListener("click", () => { detachParam(owner, p); persist(); renderEditor(); refreshPreview(); });
    tools.appendChild(delBtn);
    row.appendChild(tools);

    initSortable(fields, row.querySelector(".sbg-ly3-fieldgrip"), row, {
      itemSelector: ".sbg-ly3-field",

      dropContainerSelector: ".sbg-ly3-fields, .sbg-ly3-tabfields",

      convertTargets: secConvertTargets([0.12, 0.88]),
      promote: SEC_PROMOTE,
      onDrop: (itm, info) => {
        const tgt = info && info.convertEl && elToSection.get(info.convertEl);
        if (tgt) moveFieldIntoSection(owner, p, tgt);
        else if (info && info.promoteIndex != null) promoteFieldToSection(owner, p, info.promoteIndex);
        else applyDrop(itm, "param", ".sbg-ly3-field");
      },
    });
    return row;
  }

  function buildTabsEditor(sec) {
    const wrap = h("div", { class: "sbg-ly3-tabsed" });
    const head = h("div", { class: "sbg-ly3-tabsed-head" });
    head.appendChild(h("span", {
      class: "sbg-ly3-tabsed-label", text: "Tabs",
      title: "Split this section into tabs, such as Initial and Enhanced. Each tab has its own fields, style and colors.",
    }));
    const add = h("button", { class: "sbg-ly3-tabadd", text: "+ Add tab" });
    add.addEventListener("click", () => {
      const count = (sec.tabs || []).length;
      if (!count && (sec.params || []).length) {
        startTabs(sec, null);
      } else {
        const nt = { id: uid("tab"), label: "Tab " + (count + 1), style: "text", params: [] };
        if (!count) startTabs(sec, nt);
        sec.tabs.push(nt);
        expanded.add(nt.id);
      }
      persist(); renderEditor(); refreshPreview();
    });
    head.appendChild(add);
    wrap.appendChild(head);

    // Drawn even with no tabs so a tab from another section can be dropped in.
    // The stylesheet shows it only while a tab is dragged.
    const shown = sec.tabs || [];
    const list = h("div", { class: "sbg-ly3-tablist" + (shown.length ? "" : " sbg-ly3-tablist--empty") });
    containerToList.set(list, { kind: "tabs", sec });
    for (const t of shown) list.appendChild(buildTabRow(sec, t, list));
    wrap.appendChild(list);
    return wrap;
  }

  function buildTabRow(sec, t, list) {
    const isOpen = expanded.has(t.id);
    const row = h("div", { class: "sbg-ly3-tabrow" });
    elToTab.set(row, t);
    const head = h("div", { class: "sbg-ly3-tabrow-head" });
    const grip = h("span", { class: "sbg-grip", text: "⋮⋮", title: "Drag to move. Dropping it between sections makes it a section of its own." });
    head.appendChild(grip);
    const exp = h("button", { class: "sbg-ly3-exp" + (isOpen ? " sbg-ly3-exp--open" : ""), html: sizedIcon(CHEVRON_RIGHT_ICON, 11), title: "Open or close this tab" });
    exp.addEventListener("click", () => { if (isOpen) expanded.delete(t.id); else expanded.add(t.id); renderEditor(); });
    head.appendChild(exp);
    const name = h("input", { type: "text", class: "sbg-ly3-title", value: t.label || "", placeholder: "Tab name" });
    name.addEventListener("input", () => { t.label = name.value || undefined; persist(); refreshPreview(); });
    head.appendChild(name);
    head.appendChild(mkSelect(SECTION_STYLES, t.style || "text", (v) => { t.style = v; persist(); renderEditor(); refreshPreview(); }, sectionStyleLabel, { title: "How this tab shows its fields" }));

    const pillBtn = h("button", { class: "sbg-btn sbg-btn--icon", title: "Tab button color" });
    paintSwatch(pillBtn, t.pillColor, swatchDefaults("tabpill", sec));
    pillBtn.addEventListener("click", () => openColorPicker(pillBtn, t, sec, "pillColor", "tabpill"));
    head.appendChild(pillBtn);
    const bgBtn = h("button", { class: "sbg-btn sbg-btn--icon", title: "Tab colors" });
    paintSwatch(bgBtn, t.color, swatchDefaults("tabbody", sec));
    bgBtn.addEventListener("click", () => openColorPicker(bgBtn, t, sec, "color", "tabbody"));
    head.appendChild(bgBtn);
    const del = h("button", { class: "sbg-btn sbg-btn--icon sbg-btn--icon-danger", title: "Delete tab", html: TRASH_ICON });
    confirmClick(del, () => { detachTab(sec, t); expanded.delete(t.id); persist(); renderEditor(); refreshPreview(); });
    head.appendChild(del);
    row.appendChild(head);

    if (isOpen) {
      const body = h("div", { class: "sbg-ly3-tabrow-body" });
      if (t.style === "cards") {
        _buildCardSourceUI(t, body, () => { persist(); renderEditor(); refreshPreview(); }, () => { persist(); refreshPreview(); });
      }
      _buildShowWhenUI(t, body, () => { persist(); refreshPreview(); });
      if (t.style !== "nodes" && t.style !== "raw") {
        const fields = h("div", { class: "sbg-ly3-tabfields" });
        containerToList.set(fields, { kind: "params", owner: t });
        for (const p of (t.params || [])) fields.appendChild(buildFieldRow(t, p, fields, { inSec: sec }));
        if (!(t.params || []).length) fields.appendChild(h("div", { class: "sbg-ly3-empty", text: "No fields in this tab. Drag one in, or click + Add field." }));
        body.appendChild(fields);
        const addField = h("button", { class: "sbg-ly3-addfield", text: "+ Add field" });
        addField.addEventListener("click", () => openAddFieldPicker(addField, t));
        body.appendChild(addField);
      }
      row.appendChild(body);
    }

    initSortable(list, grip, row, {
      type: "tab", itemSelector: ".sbg-ly3-tabrow", dropContainerSelector: ".sbg-ly3-tablist",

      convertTargets: secConvertTargets([0.12, 0.88]),
      promote: SEC_PROMOTE,
      onDrop: (itm, info) => {
        const tgt = info && info.convertEl && elToSection.get(info.convertEl);
        if (tgt) moveTabIntoSection(sec, t, tgt);
        else if (info && info.promoteIndex != null) promoteTabToSection(sec, t, info.promoteIndex);
        else applyDrop(itm, "tab", ".sbg-ly3-tabrow");
      },
    });
    return row;
  }

  function drawPathGroups(listEl, headClass, filter, cap, excluded, drawItem) {
    const all = fieldPaths || buildFieldPaths(null);
    let shown = 0;
    const claimed = new Set();
    for (const grp of pathGroups()) {
      const grpPaths = all.filter(pth => !claimed.has(pth) && (!grp.roots || grp.roots.includes(pth.split(".")[0])));
      for (const pth of grpPaths) claimed.add(pth);
      const inGrp = grpPaths.flatMap(expandPathItems)
        .filter(it => (!excluded || !excluded.has(_matchKey(it.path, it.match)))
          && (!filter || it.path.toLowerCase().includes(filter) || it.label.toLowerCase().includes(filter)));
      if (!inGrp.length) continue;
      const capped = inGrp.slice(0, cap);
      if (grp.label) listEl.appendChild(h("div", { class: headClass, text: grp.label }));
      for (const it of capped) listEl.appendChild(drawItem(it));
      if (capped.length < inGrp.length) {
        listEl.appendChild(h("div", {
          class: "sbg-ly3-cutnote",
          text: `Showing ${capped.length.toLocaleString()} of ${inGrp.length.toLocaleString()}. Type to narrow.`,
        }));
      }
      shown += capped.length;
    }
    return shown;
  }

  function buildTray() {
    const tray = h("div", { class: "sbg-ly3-tray" });
    const head = h("button", { class: "sbg-ly3-trayhead" + (_viewMemory.trayOpen ? " sbg-ly3-trayhead--open" : ""), html: `${sizedIcon(CHEVRON_RIGHT_ICON, 10)}All fields (drag into a section, or click to add)` });
    head.addEventListener("click", () => { _viewMemory.trayOpen = !_viewMemory.trayOpen; renderEditor(); });
    tray.appendChild(head);

    if (fieldPathsError && fieldPathsError !== closedFieldError) {
      const offered = catalogRows() ? "built-in fields" : "the file's name, path, size and modified time";
      tray.appendChild(h("div", { class: "sbg-notices sbg-gs-notices" }, [noticeRow(`${failureText("load the field list", fieldPathsError)}. Only ${offered} can be added.`,
        () => { closedFieldError = fieldPathsError; renderEditor(); content.querySelector(".sbg-ly3-trayhead").focus(); })]));
    }
    if (!_viewMemory.trayOpen) return tray;

    const search = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm sbg-ly3-traysearch", placeholder: "Search fields…", "aria-label": "Search all fields", value: trayFilter });
    const body = h("div", { class: "sbg-ly3-traybody", role: "listbox", "aria-label": "All fields" });
    attachOverlayThumb(body);
    tray.appendChild(search); tray.appendChild(body);

    const drawItem = (it) => {
      const item = h("div", { class: "sbg-ly3-palitem", role: "option", "aria-selected": "false", title: it.path + (it.match ? ` (${matchChipText(it.match)})` : "") });
      elToTrayItem.set(item, it);
      item.appendChild(h("span", { class: "sbg-grip sbg-ly3-palgrip", text: "⋮⋮" }));
      item.appendChild(h("span", { class: "sbg-ly3-palname", text: it.label }));
      item.addEventListener("click", (e) => {
        if (e.target.closest(".sbg-grip")) return;
        // Enter on a marked row clicks it from the field search above All
        // fields, which the redraw replaces, so the new one takes the focus.
        const byKey = document.activeElement === search;
        addPathToSection(it.path, _shortcutSection(), it.match);
        if (byKey) leftPane.querySelector(".sbg-ly3-traysearch")?.focus();
      });
      initSortable(body, item.querySelector(".sbg-ly3-palgrip"), item, {
        itemSelector: ".sbg-ly3-palitem", dropContainerSelector: ".sbg-ly3-fields, .sbg-ly3-tabfields",
        onDrop: (movedItem) => onTrayDrop(movedItem),
      });
      return item;
    };
    let resyncKeys = () => { };
    function renderTrayList() {
      body.innerHTML = "";
      const shown = drawPathGroups(body, "sbg-ly3-traygrp", search.value.toLowerCase(), 300, null, drawItem);
      if (!shown) body.appendChild(h("div", { class: "sbg-ly3-empty", text: "No fields match." }));
      resyncKeys();
    }
    search.addEventListener("input", () => { trayFilter = search.value; renderTrayList(); });
    renderTrayList();
    resyncKeys = wireListboxKeys(tray, {
      markClass: "sbg-ly3-palitem--kbd",
      getOptions: () => [...body.querySelectorAll(".sbg-ly3-palitem")],
      activeDescendantEl: search,
      takeFocus: false,
    });
    return tray;
  }

  // A click in the tray adds to the section opened last that can take a field,
  // since a Set keeps its ids in the order they were added.
  function _shortcutSection() {
    const l = activeLayout();
    for (const id of [...expanded].reverse()) {
      const s = l.find(x => x.id === id);
      if (s && canHoldFields(s)) return s;
    }
    return null;
  }

  function addPathToSection(pth, sec, match) {
    if (!sec) { showToast("Add a section first."); return; }
    if (!sec.params) sec.params = [];
    if (sec.params.some(p => _matchKey(p.path, p.match) === _matchKey(pth, match))) { showToast(alreadyInMessage(sec)); return; }
    sec.params.push(_mkParam(pth, match));
    expanded.add(sec.id);
    persist(); render();
  }

  function onTrayDrop(movedItem) {
    const it = elToTrayItem.get(movedItem);
    if (it) {
      const container = movedItem.parentNode;
      const meta = container && containerToList.get(container);
      const arr = meta && meta.kind === "params" ? listOf(container) : null;
      if (arr && !arr.some(p => _matchKey(p.path, p.match) === _matchKey(it.path, it.match))) {
        arr.splice(dropIndex(container, movedItem, ".sbg-ly3-field"), 0, _mkParam(it.path, it.match));
        persist();
      } else if (arr) {
        showToast(alreadyInMessage(meta.owner));
      }
    }

    // The drag moved the tray's own row into the list, so a redraw puts the
    // tray back whether or not anything was added.
    render();
  }

  function openAddFieldPicker(anchor, owner) {
    closePopovers();
    const pop = h("div", { class: "sbg-popover sbg-popover--picker" });
    const search = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm", placeholder: "Search fields…", "aria-label": "Search fields to add" });
    const list = h("div", { class: "sbg-ly3-picklist", role: "listbox", "aria-label": "Fields to add" });
    attachOverlayThumb(list);
    pop.appendChild(search); pop.appendChild(list);

    const mapped = new Set((owner.params || []).map(p => _matchKey(p.path, p.match)));
    const drawItem = (it) => {
      const item = h("div", { class: "sbg-ly3-pickitem", role: "option", "aria-selected": "false" }, [
        h("span", { class: "sbg-ly3-pickname", text: it.label }),
        h("span", { class: "sbg-ly3-pickpath", text: it.path + (it.match ? ` · ${matchChipText(it.match)}` : "") }),
      ]);
      item.addEventListener("click", () => {
        if (!owner.params) owner.params = [];
        owner.params.push(_mkParam(it.path, it.match));
        mapped.add(_matchKey(it.path, it.match)); persist(); renderEditor(); refreshPreview(); renderList(true);
      });
      return item;
    };
    let resyncKeys = () => { };

    function renderList(keepPlace) {
      list.innerHTML = "";
      const shown = drawPathGroups(list, "sbg-ly3-pickgrp", search.value.toLowerCase(), 200, mapped, drawItem);
      if (!shown) list.appendChild(h("div", { class: "sbg-ly3-empty", text: "No more fields match." }));
      resyncKeys(keepPlace);
    }
    search.addEventListener("input", () => renderList());
    renderList();
    resyncKeys = wireListboxKeys(pop, {
      markClass: "sbg-ly3-pickitem--kbd",
      getOptions: () => [...list.querySelectorAll(".sbg-ly3-pickitem")],
      activeDescendantEl: search,
      takeFocus: false,
    });
    placePopover(pop, anchor);
    setTimeout(() => search.focus(), 0);
  }

  function openColorPicker(anchor, target, sec, colorKey, kind, tab) {
    // Created on the first change, so a picker opened and closed leaves no
    // empty color object in the layout.
    const getCol = () => target[colorKey] || (target[colorKey] = {});
    const curCol = () => target[colorKey] || {};
    const d = swatchDefaults(kind, sec, tab);
    openColorPopover(anchor, {
      channels: [
        { key: "bg", label: "Background", def: d.bg },
        { key: "text", label: "Text", def: d.text },
        { key: "border", label: "Border", def: d.border },
      ],
      colors: curCol,
      onChange: (key, color) => { getCol()[key] = color; persist(); refreshPreview(); paintSwatch(anchor, target[colorKey], d); },
      onClear: () => { delete target[colorKey]; persist(); refreshPreview(); paintSwatch(anchor, null, d); },
    });
  }

  if (_viewMemory.fresh) {
    _viewMemory.fresh = false;
    const first = activeLayout().find(s => s.style !== "nodes" && s.style !== "raw");
    if (first) expanded.add(first.id);
  }

  ensureMock();
  render();
  // A redraw during a drag would take the dragged row out of the page, so each
  // answer waits for the drop.
  api("/sidebar_gallery/meta_keys")
    .then(keys => {
      if (!content.isConnected) return;
      _nodeTitles = (keys && keys.workflow_node_titles) || {};
      _nodeInstances = (keys && keys.workflow_node_instances) || {};
      fieldPaths = buildFieldPaths(keys);
      fieldPathsError = null;
      if (_viewMemory.trayOpen) afterSort(renderEditor);
    })
    .catch((e) => {
      if (!content.isConnected) return;
      fieldPaths = buildFieldPaths(null);
      fieldPathsError = e;
      afterSort(renderEditor);
    });
}
