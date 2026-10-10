/*
 * One renderSection draws the lightbox's metadata panel, compare, the Metadata
 * tab's preview and the Theme tab's sample, so none of them can disagree.
 *
 *   profile = [ section, ... ]
 *   section = { id, title, style, open, source?, showWhen?, highlow?, hidden?, color?, tabs?, fieldsAbove?, params: [param, ...] }
 *   param   = { path, label?, style?, format?, color?, match? }
 *
 *   style (section): "flat" | "cards" | "text" | "nodes" | "raw"
 *   style (param):   "kv" | "pill" | "detail" | "title" | "text" | "hidden"
 *
 * A param path ending in ".*", such as "extra.*", draws one row per key under it.
 */
import { h, pj, lsGet, lsSet, fmtBytes } from "./sbg-core.js";
import { attachOverlayThumb } from "./sbg-overlay-thumb.js";
import { attachSplitter } from "./sbg-splitter.js";
import { getSetting, S, B } from "./sbg-settings-store.js";
import { parseColor, normalizeColor, cleanColorValue, textOn, dimInk } from "./sbg-color.js";
import { sectionHeadColors } from "./sbg-theme-model.js";
import { getProfiles, drawnProfiles, saveProfiles, MEDIA_KEYS } from "./sbg-layout-store.js";
import { schemaRootFields, schemaSections, isSchemaReserved, searchSchemaReady } from "./sbg-schema.js";
import { modifiedTime } from "./sbg-media-kind.js";
import { setSelectedTab, wireTablistKeys } from "./sbg-a11y.js";

// The file's own facts, which the browser adds to a summary, each with the
// search field it is found under.
export const FILE_FACT_FIELDS = { filename: "name", path: "fileinfo", filesize: "fileinfo", modified: "fileinfo" };
export const FILE_INFO_INJECTED = Object.keys(FILE_FACT_FIELDS);

// A gallery item's mtime is the time it sorts by, while a file record from the
// server carries its modified time as mtime.
export function mergeFileInfo(summary, file) {
  const relStyle = getSetting(S.FILENAME_STYLE) === "relpath";
  const mtime = modifiedTime(file) ?? file.mtime;
  return Object.assign({}, summary, {
    filename: relStyle ? (file.relpath || file.filename) : file.filename,
    path: file.relpath,
    filesize: fmtBytes(file.size),
    modified: mtime ? new Date(mtime * 1000).toLocaleString() : undefined,
  });
}

export const RENDER_PROP_KEYS = ["source", "showWhen", "color", "highlow"];

// An object value is copied because the colour picker writes into it in place
// while the source can stay in the layout. Colours hold only strings, so one
// level is enough.
export function copyRenderProps(src, dst) {
  for (const k of RENDER_PROP_KEYS) if (src[k] != null) dst[k] = typeof src[k] === "object" ? { ...src[k] } : src[k];
  return dst;
}

function breakable(value) {
  const s = value == null ? "" : String(value);
  const frag = document.createDocumentFragment();
  if (s.length < 16 || /\s/.test(s) || !/[_./\\-]/.test(s)) {
    frag.appendChild(document.createTextNode(s));
    return frag;
  }
  const chunks = s.match(/[^_.\-/\\]*[_.\-/\\]+|[^_.\-/\\]+$/g) || [s];
  chunks.forEach((chunk, i) => {
    frag.appendChild(document.createTextNode(chunk));
    if (i < chunks.length - 1) frag.appendChild(document.createElement("wbr"));
  });
  return frag;
}

export function kvRow(label, value) {
  if (value === undefined || value === null || value === "") return null;
  const row = h("div", { class: "sbg-meta-row" });

  if (label != null && String(label).trim() !== "") row.appendChild(h("span", { class: "sbg-meta-label", text: String(label) }));
  const valSpan = h("span", { class: "sbg-meta-value" });
  valSpan.appendChild(breakable(value));
  row.appendChild(valSpan);
  return row;
}

let _uidCounter = 0;
export function uid(prefix = "s") { return `${prefix}_${Date.now().toString(36)}_${(_uidCounter++).toString(36)}`; }

// A class name can contain dots, so every dotted prefix is offered as a class.
// The extras match nothing, since the search compares whole class names.
function _nodeClassPrefixes(path) {
  const parts = path.split(".");
  const out = [];
  for (let i = 2; i <= parts.length; i++) {
    const cls = parts.slice(1, i).join(".");
    if (cls && !out.includes(cls)) out.push(cls);
  }
  return out;
}

function _catalogTitles() {
  const out = {};
  for (const [title, row] of Object.entries(schemaSections())) out[row.section_id] = title;
  return out;
}

// Only a key ending in a media name is a profile the panel draws, so any other
// layout the store holds is left out.
function _liveProfiles(profiles) {
  return Object.entries(profiles || {})
    .filter(([key]) => MEDIA_KEYS.includes(key.slice(key.lastIndexOf("_") + 1)))
    .map(([, prof]) => prof);
}

export function getSectionRenames(profiles = drawnProfiles()) {
  const renames = {};
  if (!searchSchemaReady()) return renames;
  const defaults = _catalogTitles();
  for (const prof of _liveProfiles(profiles)) {
    if (!Array.isArray(prof)) continue;
    for (const sec of prof) {
      if (!sec || typeof sec !== "object") continue;
      const def = defaults[sec.id];
      if (def && sec.title && sec.title !== def) renames[def] = sec.title;
    }
  }
  return renames;
}

// Node classes win over a search field, so one stray param cannot retarget a
// section full of nodes.
export function getCustomSectionSearchMap(profiles = drawnProfiles()) {
  const out = {};
  // Until the catalog's titles arrive every section would look like the user's own.
  if (!searchSchemaReady()) return out;
  const defaults = _catalogTitles();
  const addEntry = (title, paramLists) => {
    if (!title || typeof title !== "string" || !title.trim()) return;
    const classes = new Set();
    const buckets = new Set();
    for (const params of paramLists) {
      for (const p of (params || [])) {
        const path = p && p.path;
        if (typeof path !== "string" || !path.trim()) continue;
        if (path.startsWith("workflow_nodes.")) {
          for (const cls of _nodeClassPrefixes(path)) classes.add(cls);
        } else {
          const f = schemaRootFields()[path.split(".")[0]];
          if (f) buckets.add(f);
        }
      }
    }
    let entry = null;
    if (classes.size) entry = { title: title.trim(), field: "workflow_nodes", classes: [...classes] };
    else if (buckets.size === 1) entry = { title: title.trim(), field: [...buckets][0] };
    if (!entry) return;
    const key = entry.title.toLowerCase();
    const prev = out[key];
    if (!prev) { out[key] = entry; return; }
    if (prev.field === "workflow_nodes" && entry.classes) {
      prev.classes = prev.classes || [];
      for (const c of entry.classes) if (!prev.classes.includes(c)) prev.classes.push(c);
    }
  };
  const sectionRows = [];
  for (const prof of _liveProfiles(profiles)) {
    if (!Array.isArray(prof)) continue;
    for (const sec of prof) {
      if (!sec || typeof sec !== "object") continue;
      const tabs = Array.isArray(sec.tabs) ? sec.tabs : [];
      for (const t of tabs) if (t) addEntry(t.label, [t.params]);
      if (!defaults[sec.id] && sec.title) {
        sectionRows.push({ title: sec.title, params: sec.params,
          tabLabels: tabs.map((t) => t && t.label) });
      }
    }
  }

  // A node class two titles both claim is dropped from both, and an entry left
  // with no class goes instead of widening to every node.
  const claims = {};
  for (const e of Object.values(out)) {
    if (e.classes) for (const c of e.classes) claims[c] = (claims[c] || 0) + 1;
  }
  for (const [key, e] of Object.entries(out)) {
    if (!e.classes) continue;
    e.classes = e.classes.filter((c) => claims[c] === 1);
    if (!e.classes.length) delete out[key];
  }

  for (const s of sectionRows) {
    addEntry(s.title, [s.params]);
    const key = s.title.trim().toLowerCase();
    for (const tl of s.tabLabels) {
      const te = tl && out[String(tl).trim().toLowerCase()];
      if (!te || !te.classes) continue;
      let e = out[key];
      if (!e || !e.classes) {
        e = out[key] = { title: s.title.trim(), field: "workflow_nodes", classes: [] };
      }
      for (const c of te.classes) if (!e.classes.includes(c)) e.classes.push(c);
    }
  }
  return out;
}

// A workflow_nodes or extra path is read from the whole summary even inside a
// sourced section, as resolveParamValue does.
export function absolutizeParamPath(path, source) {
  const p = String(path || "");
  if (!source || !p || p.startsWith(source + ".")) return p;
  const head = p.split(".")[0];
  if (head === "workflow_nodes" || head === "extra") return p;
  return source + "." + p;
}

// Consulted only for a spelling typed before a colon, so a plain term stays
// free text.
export function getFieldLabelSearchMap(profiles = drawnProfiles()) {
  const out = {};
  const add = (label, path) => {
    if (!label || typeof label !== "string" || !label.trim()) return;
    if (typeof path !== "string" || !path.trim()) return;
    const key = label.trim().toLowerCase();

    // A label must never take a built-in search name, so nothing registers
    // until those are known.
    if (!searchSchemaReady() || isSchemaReserved(key)) return;
    let entry = null;
    if (path.startsWith("workflow_nodes.")) {
      const classes = _nodeClassPrefixes(path);
      if (classes.length) entry = { title: label.trim(), field: "workflow_nodes", classes };
    } else {
      const leaf = path.split(".").pop();
      if (!path.includes("*") && leaf && !leaf.startsWith("_")) {
        entry = { title: label.trim(), field: key, keyPaths: [path.trim()] };
      }
    }
    if (!entry) return;
    const prev = out[key];
    if (!prev) { out[key] = entry; return; }
    if (entry.classes) {
      if (prev.classes) {
        for (const c of entry.classes) if (!prev.classes.includes(c)) prev.classes.push(c);
      } else {
        prev.classes = entry.classes;
      }
    }
    if (entry.keyPaths) {
      if (prev.keyPaths) {
        for (const p of entry.keyPaths) if (!prev.keyPaths.includes(p)) prev.keyPaths.push(p);
      } else {
        prev.keyPaths = entry.keyPaths;
      }
    }
    if (prev.classes && prev.keyPaths) prev.field = key;
  };
  for (const prof of _liveProfiles(profiles)) {
    if (!Array.isArray(prof)) continue;
    for (const sec of prof) {
      if (!sec || typeof sec !== "object") continue;
      const tabs = Array.isArray(sec.tabs) ? sec.tabs : [];
      for (const params of [sec.params, ...tabs.map((t) => t && t.params)]) {
        for (const p of (params || [])) {
          if (p && typeof p === "object") add(p.label, absolutizeParamPath(p.path, sec.source));
        }
      }
    }
  }

  return out;
}

/** Clears `channel` on every pill field whose colour is `heldBefore`, the Pill
 *  default the theme held until an edit made it `heldAfter`, so those fields
 *  follow the active theme again. Every theme shares the layouts, so the new
 *  colour is never written into them. */
export function clearElementColor(channel, heldBefore, heldAfter) {
  if (!channel || !heldBefore) return false;
  const target = normalizeColor(heldBefore);
  if (!target || target === normalizeColor(heldAfter)) return false;
  const profiles = getProfiles();
  let changed = false;

  const visit = (params) => {
    if (!Array.isArray(params)) return;
    for (const p of params) {
      if (!p || typeof p !== "object") continue;
      // A hidden field keeps its style in `_prevStyle` and shows in it again.
      if ((p.style === "hidden" ? p._prevStyle : p.style) !== "pill") continue;
      if (!p.color || typeof p.color !== "object" || normalizeColor(p.color[channel]) !== target) continue;
      delete p.color[channel];
      if (!Object.keys(p.color).length) delete p.color;
      changed = true;
    }
  };
  for (const key of Object.keys(profiles)) {
    const prof = profiles[key];
    if (!Array.isArray(prof)) continue;
    for (const sec of prof) {
      if (!sec || typeof sec !== "object") continue;
      visit(sec.params);
      if (Array.isArray(sec.tabs)) for (const t of sec.tabs) if (t) visit(t.params);
    }
  }
  if (changed) saveProfiles(profiles);
  return changed;
}

function filterNodesByMatch(nodes, match) {
  if (!match || typeof match !== "object") return nodes;
  if (match.title != null && match.title !== "") return nodes.filter(n => (n.title || "") === match.title);
  if (match.from != null && match.from !== "") return nodes.filter(n => (n._from || "") === match.from);
  if (match.index != null) { const n = nodes[match.index]; return n ? [n] : []; }
  return nodes;
}

/*
 * Every value a layout path names in a summary:
 *   "model"                         summary.model
 *   "samplers.steps"                each summary.samplers[i].steps
 *   "extra.app"                     summary.extra.app
 *   "workflow_nodes.KSampler.seed"  the seed of every node with that class_type
 *   "workflow_nodes.KSampler"       the params object of every KSampler node
 */
export function resolvePath(path, summary, match) {
  if (!path || !summary) return [];
  const parts = path.split(".");

  if (parts[0] === "workflow_nodes" && parts.length >= 2) {
    const all = (summary.workflow_nodes || []).filter(n => n && typeof n === "object");
    // A class name can contain dots, so the longest prefix that names a node wins.
    let matched = [];
    let paramPath = null;
    for (let i = parts.length; i >= 2; i--) {
      const cls = parts.slice(1, i).join(".");
      const hit = all.filter(n => n.class_type === cls);
      if (hit.length) {
        matched = hit;
        paramPath = i < parts.length ? parts.slice(i).join(".") : null;
        break;
      }
    }
    const nodes = filterNodesByMatch(matched, match);
    if (!paramPath) return nodes.map(n => n.params || {});
    const out = [];
    for (const n of nodes) {
      const v = _dig(n.params, paramPath);
      if (v !== undefined && v !== null && v !== "") out.push(v);
    }
    return out;
  }

  const head = parts[0];
  const headVal = summary[head];
  if (Array.isArray(headVal) && parts.length > 1) {
    const sub = parts.slice(1).join(".");
    const out = [];
    for (const entry of headVal) {
      const v = _dig(entry, sub);
      if (v !== undefined && v !== null && v !== "") out.push(v);
    }
    return out;
  }

  const v = _dig(summary, path);
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function _dig(obj, path) {
  if (!obj || typeof obj !== "object" || !path) return undefined;
  // Own keys only, so a path such as "constructor" resolves to nothing.
  const has = (o, k) => o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    // A key can itself contain dots, so the whole remainder is tried as one key
    // before it is split.
    if (i < parts.length - 1) {
      const rest = parts.slice(i).join(".");
      if (has(cur, rest)) return cur[rest];
    }
    if (has(cur, parts[i])) cur = cur[parts[i]];
    else return undefined;
  }
  return cur;
}

function resolveSourceElements(source, summary) {
  if (!source) return [summary];
  const parts = source.split(".");
  if (parts[0] === "workflow_nodes" && parts.length >= 2) {
    const cls = parts.slice(1).join(".");
    const nodes = (summary.workflow_nodes || []).filter(n => n && typeof n === "object" && n.class_type === cls);

    return nodes.map(n => ({ ...(n.params || {}), __title__: _nodeHeading(n) }));
  }
  const val = _dig(summary, source);
  if (Array.isArray(val)) return val;
  if (val && typeof val === "object") return [val];
  return [];
}

export const AUTO_ANCHOR_KEYS = ["controlnet", "adetailer", "upscaling", "interpolation", "mmaudio", "loras"];

export function autoAnchorFor(section) {
  const params = (section && section.params || []).filter(p => p && p.path && (p.style || "kv") !== "hidden");
  if (!params.length) return null;
  const counts = {};
  for (const p of params) {
    const head = p.path.split(".")[0];
    counts[head] = (counts[head] || 0) + 1;
  }
  let best = null, bestN = 0;
  for (const [k, n] of Object.entries(counts)) if (n > bestN) { best = k; bestN = n; }
  if (!best || !AUTO_ANCHOR_KEYS.includes(best)) return null;
  if (bestN * 2 <= params.length) return null;
  return best;
}

function anchorSatisfied(section, summary) {
  let req = section && section.showWhen;
  if (req === "always") return true;
  if (!req) req = autoAnchorFor(section);
  if (!req) return true;
  return resolvePath(req, summary, null).length > 0;
}

export function sectionHasData(section, summary) {
  if (!summary) return false;
  return resolveSectionValues(section, summary) !== null;
}

function resolveParamValue(path, element, summary, source, match) {
  if (!path) return null;
  const ok = (v) => v !== undefined && v !== null && v !== "";
  let v = _dig(element, path);
  if (ok(v)) return v;
  if (source && path.startsWith(source + ".")) {
    v = _dig(element, path.slice(source.length + 1));
    if (ok(v)) return v;
  }
  if (element !== summary) {
    v = _dig(summary, path);
    if (ok(v)) return v;
  }

  if (path.includes(".")) {
    const head = path.split(".")[0];
    // Inside a sourced card only a workflow_nodes or extra path is read across
    // the summary, since any other path would pick up another entry's value.
    // With no source an element other than the summary is a high or low half,
    // which takes a file-wide value only when there is one, or the first of
    // several would show on both halves.
    const half = !source && element !== summary;
    if (element === summary || half
        || ((head === "workflow_nodes" || head === "extra") && !path.startsWith(source + "."))) {
      const arr = resolvePath(path, summary, match);
      if (arr.length && ok(arr[0]) && (!half || arr.length === 1)) return arr[0];
    }
  }
  return null;
}

function resolveSectionValues(section, summary, ctx = {}) {
  if (!section || !summary) return null;
  if (!ctx.preview && !anchorSatisfied(section, summary)) return null;

  if (Array.isArray(section.tabs) && section.tabs.length && !ctx.inTab) {
    return _resolveTabs(section.tabs, section.params || [], summary);
  }
  const style = section.style || "flat";
  if (style === "raw") return { kind: "raw" };
  if (style === "nodes") return _resolveNodes(summary);

  const params = (section.params || []).filter(p => p && (p.style || "kv") !== "hidden");
  if (style === "cards") return _resolveCards(section, params, summary);
  if (style === "text") return _resolveText(params, summary);
  return _resolveFlat(params, summary);
}

function _resolveTabs(tabs, sectionParams, summary) {
  const out = [];
  for (const t of tabs) {
    if (!t) continue;
    const sub = tabAsSection(t);
    const tree = resolveSectionValues(sub, summary, { inTab: true });
    if (tree) out.push({ id: (t.id || t.label || ""), tab: t, sub, tree });
  }
  const visible = sectionParams.filter(p => p && (p.style || "kv") !== "hidden");
  const own = visible.length ? _resolveFlat(visible, summary) : null;
  if (!out.length && !own) return null;
  return { kind: "tabs", tabs: out, own };
}

function _wildcardEntries(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "");
}

function _resolveFlat(params, summary) {
  const rows = [];
  for (const p of params) {
    if (p.path && p.path.endsWith(".*")) {
      // The same lookup a card makes, so a wildcard under a node class finds
      // the node here too.
      for (const [k, v] of _wildcardEntries(resolveParamValue(p.path.slice(0, -2), summary, summary, null, p.match))) rows.push({ param: p, key: k, value: v });
      continue;
    }
    for (const v of resolvePath(p.path, summary, p.match)) rows.push({ param: p, value: v });
  }
  return rows.length ? { kind: "flat", rows } : null;
}

function _resolveText(params, summary) {
  const rows = [];
  for (const p of params) {
    const vals = resolvePath(p.path, summary, p.match);

    if (vals.length) rows.push({ param: p, value: vals[0] });
  }
  return rows.length ? { kind: "text", rows } : null;
}

function _cardsSource(section, summary) {
  if (section.source) return section.source;
  const head = autoAnchorFor(section);
  if (head && Array.isArray(summary[head]) && summary[head].length
      && summary[head].every(e => e && typeof e === "object" && !Array.isArray(e))) {
    return head;
  }
  return null;
}

// Every element gets a card, an empty one included, since the high and low plan
// names cards by the element's place.
function _resolveCards(section, params, summary) {
  const { source, elements, pairs } = _cardElements(section, summary);
  const cards = elements.map((el) => {
    const fields = [];
    if (el && el.__title__) fields.push({ key: "__title__", value: String(el.__title__) });
    for (const p of params) {
      if (p.path && p.path.endsWith(".*")) {
        const obj = resolveParamValue(p.path.slice(0, -2), el, summary, source, p.match);
        for (const [k, v] of _wildcardEntries(obj)) fields.push({ param: p, key: k, value: v });
        continue;
      }
      const v = resolveParamValue(p.path, el, summary, source, p.match);
      for (const x of Array.isArray(v) ? v : [v]) {
        if (x !== undefined && x !== null && x !== "") fields.push({ param: p, value: x });
      }
    }
    return { fields };
  });
  if (!cards.some(c => c.fields.length)) return null;
  const tree = { kind: "cards", cards };
  if (pairs) {
    const at = (el) => elements.indexOf(el);
    tree.plan = _highLowPlan(section, elements, summary, source).map(s => s.el ? [at(s.el)] : [at(s.hi), at(s.lo)]);
  }
  return tree;
}

function _nodeHeading(n) {
  return n.title || (n._from ? `${n.class_type} (from ${n._from})` : (n.class_type || "Unknown"));
}

function _resolveNodes(summary) {
  const nodes = [];
  for (const wn of (summary.workflow_nodes || [])) {
    if (!wn || typeof wn !== "object") continue;
    const label = _nodeHeading(wn);
    const params = wn.params && typeof wn.params === "object" ? wn.params : {};
    const entries = [];
    for (const [pk, pv] of Object.entries(params)) {
      const dv = typeof pv === "object" ? JSON.stringify(pv) : String(pv);
      if (dv.length > 400) continue;
      entries.push([pk, dv]);
    }
    if (entries.length) nodes.push({ label, entries });
  }
  return nodes.length ? { kind: "nodes", nodes } : null;
}

function _sigValue(v, param) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(x => _sigValue(x, param));
  if (typeof v === "object") return v;
  const text = String(_modelDisplay(v));
  // Only a pill draws through its format, so only a pill is signed with it.
  return param && param.style === "pill" && param.format ? fmt(text, param.format) : text;
}

function _stripTree(t) {
  if (!t) return null;
  switch (t.kind) {
    case "raw": return "raw";
    case "nodes": return ["nodes", t.nodes.map(n => [n.label, n.entries])];

    case "cards": {
      const drawn = t.cards.filter(c => c.fields.length);
      // Signed as _renderCards draws them, where a lone empty card draws nothing
      // and an empty half of a pair leaves only its label.
      const plan = t.plan && t.plan
        .filter(s => s.length > 1 || t.cards[s[0]].fields.length)
        .map(s => s.map(i => drawn.indexOf(t.cards[i])));
      return ["cards", drawn.map(c =>
        c.fields.map(f => [f.key || (f.param && f.param.path) || "", _sigValue(f.value, f.param)])), plan || null];
    }
    case "tabs": return ["tabs", t.tabs.map(x => [x.id, _stripTree(x.tree)]), _stripTree(t.own)];
    default: return [t.kind, t.rows.map(r =>
      [(r.key !== undefined ? r.key : (r.param && r.param.path)) || "", _sigValue(r.value, r.param)])];
  }
}

// Compare marks a section changed by this signature, so it has to cover
// everything renderSection draws.
export function sectionSignature(section, summary) {
  return JSON.stringify(_stripTree(resolveSectionValues(section, summary)));
}

export function visibleSections(profile, summary, { preview = false } = {}) {
  return (profile || []).filter(s => s && s.title && !s.hidden && (preview || sectionHasData(s, summary)));
}

function valueText(value) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

function fmt(value, format) {
  if (!format) return valueText(value);
  return format.split("{v}").join(valueText(value));
}

const _MODEL_EXT_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;

function _modelDisplay(v) {
  if (Array.isArray(v)) return v.map(_modelDisplay);
  if (typeof v !== "string" || !_MODEL_EXT_RE.test(v)) return v;
  if (getSetting(S.MODEL_NAME_STYLE) !== "basename") return v;
  const parts = v.split(/[\\/]/);
  return parts[parts.length - 1] || v;
}

function makePill(text, param) {
  const pill = h("span", { class: "sbg-badge", text, title: String(text) });
  const c = _safeColor(param.color);
  if (c) {
    if (c.bg) pill.style.setProperty("--sbg-pill-bg", c.bg);
    if (c.text) pill.style.setProperty("--sbg-pill-text", c.text);
    if (c.border) pill.style.setProperty("--sbg-pill-border", c.border);
  }
  return pill;
}

// Layout colours can arrive from a preset or an import, so each is cleaned
// before it reaches a style.
function _safeColor(c) {
  if (!c || typeof c !== "object") return null;
  const out = {};
  for (const k of ["bg", "text", "border"]) {
    const v = cleanColorValue(c[k]);
    if (v) out[k] = v;
  }
  return out;
}

function applyKvColor(row, param) {
  const c = _safeColor(param.color);
  if (!c) return;
  applyColor(row, c);
  if (c.text) {
    row.style.setProperty("--sbg-text", c.text);
    row.style.setProperty("--sbg-text-dim", c.text);
  }
}

function _fullyTransparent(color) {
  const p = parseColor(color);
  return !!p && p.a === 0;
}

export function applyColor(el, c) {
  c = _safeColor(c);
  if (!c) return;
  if (c.text) el.style.color = c.text;
  else if (c.bg) { const t = textOn(c.bg); if (t) el.style.color = t; }
  if (c.bg) el.style.background = c.bg;
  // A transparent border would still take its pixel, so it is dropped instead.
  if (c.border) el.style.border = _fullyTransparent(c.border) ? "none" : `1px solid ${c.border}`;
}

function _panelColor() {
  try { return getComputedStyle(document.documentElement).getPropertyValue("--sbg-panel-solid").trim(); }
  catch { return ""; }
}

export function applySectionColor(el, c, panel = _panelColor()) {
  applyColor(el, c);
  const safe = _safeColor(c);
  // Both header variables, since the lightbox's panel reads its own, and set
  // on the section so its colour wins over the theme's Section Header.
  const head = safe && safe.bg ? sectionHeadColors(safe.bg, panel, safe.text) : null;
  if (head) {
    el.style.setProperty("--sbg-section-head-bg", head.fill);
    el.style.setProperty("--sbg-lb-head-bg", head.fill);
    el.style.setProperty("--sbg-section-head-text", head.ink);
  }
  const ink = safe && (safe.text || (safe.bg ? textOn(safe.bg) : ""));
  if (!ink) return;
  if (!head) el.style.setProperty("--sbg-section-head-text", ink);
  // The rows inside paint the text tokens, so the section's ink reaches them
  // through those, its labels in the dim form a theme would give it.
  el.style.setProperty("--sbg-text", ink);
  const parsed = parseColor(ink);
  if (parsed) el.style.setProperty("--sbg-text-dim", dimInk(parsed));
  // A pill with no colour of its own takes the section's ink on a wash of it,
  // since the pill fill worked out for the theme can match the section's fill.
  if (safe.bg) {
    el.style.setProperty("--sbg-pill-text", ink);
    el.style.setProperty("--sbg-pill-bg", `color-mix(in srgb, ${ink} 6%, transparent)`);
    el.style.setProperty("--sbg-pill-border", `color-mix(in srgb, ${ink} 8%, transparent)`);
  }
}

function _words(key) {
  return String(key).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function labelize(path) {
  return _words(String(path || "").replace(/\.\*$/, "").split(".").pop());
}

// A label the user cleared stays blank, so the label column goes.
function fieldLabel(p) {
  return typeof p.label === "string" ? p.label.trim() : labelize(p.path);
}

export function renderSection(section, summary, ctx = {}) {
  if (Array.isArray(section.tabs) && section.tabs.length && !ctx.inTab) return _renderTabbed(section, summary, ctx);
  switch (section.style || "flat") {
    case "text":  return _renderText(section, summary, ctx);
    case "cards": return _renderCards(section, summary, ctx);
    case "nodes": return _renderNodes(section, summary, ctx);
    case "raw":   return _renderRaw(section, summary, ctx);
    default:      return _renderFlat(section, summary, ctx);
  }
}

function _wildcardRows(p, rows) {
  const wildPrefix = typeof p.label === "string" ? p.label.trim() : "";
  const out = [];
  for (const { key, value } of rows) {
    // A key can hold dots of its own, as a node's grouped widget does, so the
    // whole key is the label instead of its last part.
    const keyLabel = _words(key);
    const row = kvRow(wildPrefix ? `${wildPrefix} ${keyLabel}` : keyLabel, typeof value === "object" ? pj(value) : String(_modelDisplay(value)));
    if (row) { applyKvColor(row, p); out.push(row); }
  }
  return out;
}

const PLACEHOLDER = "—";

function _renderStyledValue(p, v, { title, pill, append }, ctx, placeholder = false) {
  const pstyle = p.style || "kv";
  if (pstyle === "title") {
    const t = h("div", { class: "sbg-meta-card__title", text: valueText(v) });
    applyColor(t, p.color);
    title(t);
  } else if (pstyle === "pill") {
    const lab = fieldLabel(p);
    pill(makePill(placeholder ? (lab ? `${lab}: ${v}` : v) : fmt(v, p.format), p));
  } else if (pstyle === "detail") {
    const lab = fieldLabel(p);
    const d = h("div", { class: "sbg-meta-card__detail", text: lab ? `${lab}: ${valueText(v)}` : valueText(v) });
    applyColor(d, p.color);
    append(d);
  } else if (pstyle === "text") {
    const d = h("div", { class: `sbg-prompt-text sbg-prompt-text--sm${isNegativePath(p.path) ? " sbg-prompt-text--neg" : ""}`, text: valueText(v) });
    applyColor(d, p.color);
    _attachPromptResize(d, _promptResizeKey(p), ctx.profileKey);
    append(d);
  } else {
    const row = kvRow(fieldLabel(p), valueText(v));
    if (row) { applyKvColor(row, p); append(row); }
  }
}

// A wildcard gets no placeholder in the preview, having no single row to stand
// in for.
function _drawFields(params, rows, place, ctx) {
  const byParam = new Map();
  for (const r of rows) {
    if (!r.param) continue;
    const arr = byParam.get(r.param) || [];
    arr.push(r);
    byParam.set(r.param, arr);
  }
  for (const p of params) {
    if ((p.style || "kv") === "hidden") continue;
    const found = byParam.get(p) || [];
    if (p.path && p.path.endsWith(".*")) {
      for (const row of _wildcardRows(p, found)) place.append(row);
    } else if (found.length) {
      for (const r of found) _renderStyledValue(p, _modelDisplay(r.value), place, ctx);
    } else if (ctx.preview) {
      _renderStyledValue(p, PLACEHOLDER, place, ctx, true);
    }
  }
}

function _drawFlat(params, rows, ctx) {
  const wrap = h("div", { class: "sbg-meta-group" });
  let pills = null;
  _drawFields(params, rows, {
    title: (t) => wrap.appendChild(t),
    pill: (el) => {
      if (!pills) { pills = h("div", { class: "sbg-meta-pills" }); wrap.appendChild(pills); }
      pills.appendChild(el);
    },
    append: (el) => wrap.appendChild(el),
  }, ctx);
  return wrap.children.length ? wrap : null;
}

function _renderFlat(section, summary, ctx) {
  const tree = resolveSectionValues(section, summary, ctx);
  return _drawFlat(section.params || [], tree ? tree.rows : [], ctx);
}

function _renderText(section, summary, ctx) {
  const tree = resolveSectionValues(section, summary, ctx);
  const byParam = new Map();
  for (const r of (tree ? tree.rows : [])) byParam.set(r.param, r);
  const wrap = h("div", { class: "sbg-meta-group" });
  for (const p of (section.params || [])) {
    if ((p.style || "kv") === "hidden") continue;
    const r = byParam.get(p);
    if (!r && !ctx.preview) continue;
    const text = r ? (typeof r.value === "string" ? String(_modelDisplay(r.value)) : pj(r.value)) : PLACEHOLDER;
    const neg = isNegativePath(p.path);
    const d = h("div", { class: `sbg-prompt-text${neg ? " sbg-prompt-text--neg" : ""}`, text });
    applyColor(d, p.color);
    _attachPromptResize(d, neg ? "neg" : "pos", ctx.profileKey);
    wrap.appendChild(d);
  }
  return wrap.children.length ? wrap : null;
}

function tabAsSection(t) {
  return copyRenderProps(t, { id: t.id || ("tab_" + (t.label || "")), title: t.label, style: t.style || "flat", params: t.params });
}

// The fields outside tabs draw from the rows compare signs, so the section's
// Show when governs them too. The preview offers every tab, since a tab with no
// sample value still has to be edited.
function _renderTabbed(section, summary, ctx) {
  const tree = resolveSectionValues(section, summary, ctx);
  const usable = ctx.preview
    ? section.tabs.filter(Boolean).map(t => ({ tab: t, sub: tabAsSection(t) }))
    : (tree ? tree.tabs : []);
  const fieldsEl = _drawFlat(section.params || [], tree && tree.own ? tree.own.rows : [], ctx);
  if (!usable.length && !fieldsEl) return null;

  const box = h("div", {});
  if (fieldsEl && section.fieldsAbove) box.appendChild(fieldsEl);

  if (usable.length) {
    const host = h("div", { class: "sbg-tab-body" });
    const lsKey = B.PROMPT_TAB_PREFIX + (section.id || "tabs");

    const remembered = lsGet(lsKey);
    let idx = Math.max(0, remembered == null ? -1 : usable.findIndex(u => (u.tab.label || "") === remembered));

    const pills = usable.map((u, i) => {
      const btn = h("button", { class: "sbg-prompt-pill", role: "tab", text: u.tab.label || `Tab ${i + 1}` });
      if (u.tab.pillColor) applyColor(btn, u.tab.pillColor);
      btn.addEventListener("click", () => select(i));
      return btn;
    });
    const draw = () => {
      host.innerHTML = "";
      host.style.cssText = "";
      const { sub } = usable[idx];
      const el = renderSection(sub, summary, { ...ctx, inTab: true });
      if (el) host.appendChild(el);
      applyColor(host, sub.color);
      pills.forEach((p, i) => p.classList.toggle("sbg-prompt-pill--active", i === idx));
      setSelectedTab(pills, pills[idx]);
    };
    const select = (i) => { idx = i; lsSet(lsKey, usable[i].tab.label || ""); draw(); };

    if (usable.length > 1) {
      box.appendChild(h("div", { class: "sbg-prompt-toggle", role: "tablist", "aria-label": section.title }, pills));
      wireTablistKeys(pills, (btn) => select(pills.indexOf(btn)));
    }
    box.appendChild(host);
    draw();
  }

  if (fieldsEl && !section.fieldsAbove) box.appendChild(fieldsEl);
  return box;
}

function _promptResizeKey(p) {
  const path = (p && p.path) || "";
  if (isNegativePath(path)) return "neg";
  if (path === "positive_prompt" || path === "initial_prompt") return "pos";
  return path ? "f." + path.replace(/[^a-zA-Z0-9_.-]/g, "_") : "pos";
}

// A box inside a closed section cannot be measured, so its sizer is kept for
// sizePromptBoxes to run when the section opens.
const _promptSizers = new WeakMap();

export function sizePromptBoxes(root) {
  for (const el of root.querySelectorAll(".sbg-prompt-text")) _promptSizers.get(el)?.();
}

function _attachPromptResize(el, storageKey, profileKey) {
  attachOverlayThumb(el);

  const lsKey = B.PROMPT_HEIGHT_PREFIX + (profileKey ? profileKey + "." : "") + storageKey;
  // Compare, the source tab and the Theme tab's sample name no profile, so the
  // height they store sits under this key, which a box with no height of its
  // own falls back to.
  const legacyKey = B.PROMPT_HEIGHT_PREFIX + storageKey;
  let sectionEl = null;
  const applySize = () => {
    if (!sectionEl) sectionEl = el.closest(".sbg-section");

    if (sectionEl && !sectionEl.classList.contains("sbg-section--open")) return;
    const storedH = parseInt(lsGet(lsKey), 10) || parseInt(lsGet(legacyKey), 10) || 150;

    const sc = el.scrollTop;
    // Released first, since scrollHeight never reports less than the box's
    // current height.
    el.style.height = "auto";
    el.style.overflowY = "hidden";

    const requiredH = el.scrollHeight + 2;
    el.style.height = Math.min(requiredH, storedH) + "px";

    el.style.overflowY = "auto";
    el.scrollTop = sc;
  };

  _promptSizers.set(el, applySize);
  requestAnimationFrame(applySize);

  // The grip sits inside the box on a zero height sticky rail, so it stays at
  // the bottom of the scrolled view without a wrapper around the box.
  const grip = h("div", { class: "sbg-prompt-grip", "aria-hidden": "true" });
  el.appendChild(grip);
  attachSplitter(grip, {
    min: 24, max: 4000, axis: "y",
    size: () => el.getBoundingClientRect().height,
    apply: (hgt) => { el.style.height = hgt + "px"; },
    done: (hgt) => {
      lsSet(lsKey, String(Math.round(hgt)));
      applySize();
    },
  });
}

function _expandArrayParam(section, el) {
  for (const p of (section.params || [])) {
    const v = _dig(el, p.path);
    if (Array.isArray(v) && v.length >= 2) {
      return v.map(entry => {
        const pseudo = {};
        for (const q of (section.params || [])) {
          pseudo[q.path] = q.path === p.path ? entry : _dig(el, q.path);
        }
        return pseudo;
      });
    }
  }
  return null;
}

const AUTO_HIGHLOW_SOURCES = new Set(["loras", "samplers"]);

// `source` is the list the cards are drawn from, so a section left on Auto
// passes the one Auto picks.
export function pairsHighLow(section, source) {
  return section.highlow === true || (section.highlow == null && AUTO_HIGHLOW_SOURCES.has(source));
}

function _cardElements(section, summary) {
  const source = _cardsSource(section, summary);
  let elements = resolveSourceElements(source, summary);
  const pairs = pairsHighLow(section, source);

  if (pairs && !source && elements.length === 1) {
    const expanded = _expandArrayParam(section, elements[0]);

    if (expanded) {
      const kp = _highLowKeyPath(section);
      const roles = expanded.map(e => classifyHighLow(_dig(e, kp)));
      if (roles.includes("high") && roles.includes("low")) elements = expanded;
    }
  }
  return { source, elements, pairs };
}

// With no sample value the preview still draws one card of placeholders.
function _renderCards(section, summary, ctx) {
  const tree = resolveSectionValues(section, summary, ctx);
  if (!tree && !ctx.preview) return null;
  const cards = tree ? tree.cards : [{ fields: [] }];
  const wrap = h("div", { class: "sbg-meta-group" });
  const add = (parent, card) => { const el = _renderOneCard(section, card, ctx); if (el) parent.appendChild(el); };
  const plan = tree && tree.plan ? tree.plan : cards.map((c, i) => [i]);
  for (const step of plan) {
    if (step.length === 1) { add(wrap, cards[step[0]]); continue; }
    const pair = h("div", { class: "sbg-meta-pair" });
    step.forEach((i, n) => {
      const item = h("div", { class: "sbg-meta-pair__item" });
      item.appendChild(h("span", { class: "sbg-meta-pair__label", text: n ? "LOW" : "HIGH" }));
      add(item, cards[i]);
      pair.appendChild(item);
    });
    wrap.appendChild(pair);
  }
  return wrap.children.length ? wrap : null;
}

function _renderOneCard(section, card, ctx) {
  const el = h("div", { class: "sbg-meta-card" });
  let pills = null;
  let lastTitle = null;
  const heading = card.fields.find(f => f.key === "__title__" && !f.param);
  if (heading) {
    lastTitle = h("div", { class: "sbg-meta-card__title", text: heading.value });
    el.appendChild(lastTitle);
  }
  _drawFields(section.params || [], card.fields, {
    title: (t) => { el.insertBefore(t, lastTitle ? lastTitle.nextSibling : el.firstChild); lastTitle = t; },
    pill: (p) => {
      if (!pills) { pills = h("div", { class: "sbg-meta-pills" }); el.appendChild(pills); }
      pills.appendChild(p);
    },
    append: (child) => el.appendChild(child),
  }, ctx);
  return el.children.length ? el : null;
}

export function isNegativePath(path) {
  return /negative/i.test(path);
}

function _hlWords(name) {
  return String(name || "")
    .replace(_MODEL_EXT_RE, "")

    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function classifyHighLow(name) {
  const n = String(name || "").toLowerCase();
  const words = _hlWords(name);
  const hasHigh = words.includes("high") || words.includes("highnoise") || /[_\-.]hi([_\-.)]|$)/.test(n);
  const hasLow = words.includes("low") || words.includes("lownoise") || /[_\-.]lo([_\-.)]|$)/.test(n);
  if (hasHigh && !hasLow) return "high";
  if (hasLow && !hasHigh) return "low";

  if (/(^|[^a-z])dit([^a-z]|$)/.test(n) && !hasLow) return "high";
  if (n.includes("fp8") && !hasHigh) return "low";
  return null;
}

function _loaderGroupOf(el) {
  if (!el || typeof el !== "object" || el.loader == null) return null;
  return String(el.loader);
}

const _HL_TOKENS = new Set(["high", "low", "hi", "lo", "highnoise", "lownoise"]);
function highLowBase(name) {
  return _hlWords(name).filter(w => !_HL_TOKENS.has(w)).join(" ");
}

function _highLowKeyPath(section) {
  // A title hidden in the Metadata tab keeps its style in `_prevStyle`,
  // so it can still name the element.
  const params = section.params || [];
  const isTitle = (p) => p.style === "title"
    || (p.style === "hidden" && p._prevStyle === "title");
  const titleParam = params.find(isTitle);
  if (titleParam) return titleParam.path;
  const first = params[0];
  return first ? first.path : "name";
}

function _highLowPlan(section, elements, summary, source) {
  const keyPath = _highLowKeyPath(section);

  const nameOf = (el) => resolveParamValue(keyPath, el, summary, source, null);

  const roleOf = (el) => {
    const r = el && typeof el === "object" ? el.role : null;
    if (r === "high" || r === "low") return r;
    return classifyHighLow(nameOf(el));
  };
  const plan = [];
  const pair = (hi, lo) => plan.push({ hi, lo });
  const one = (el) => plan.push({ el });

  const groupIds = [...new Set(elements.map(_loaderGroupOf).filter(g => g != null))];
  if (groupIds.length === 2 && elements.every(e => _loaderGroupOf(e) != null)) {
    const byGroup = { [groupIds[0]]: [], [groupIds[1]]: [] };
    for (const el of elements) byGroup[_loaderGroupOf(el)].push(el);
    const score = (arr) => arr.reduce((s, el) => s + (roleOf(el) === "high" ? 1 : roleOf(el) === "low" ? -1 : 0), 0);
    let gHi = groupIds[0], gLo = groupIds[1];
    const sHi = score(byGroup[gHi]), sLo = score(byGroup[gLo]);
    // Two loader groups that score the same cannot be told apart, so the names
    // below decide instead.
    if (sHi !== sLo) {
      if (sHi < sLo) { [gHi, gLo] = [gLo, gHi]; }
      const hiArr = byGroup[gHi], loArr = byGroup[gLo];
      const n = Math.max(hiArr.length, loArr.length);
      for (let i = 0; i < n; i++) {
        if (hiArr[i] && loArr[i]) pair(hiArr[i], loArr[i]);
        else one(hiArr[i] || loArr[i]);
      }
      return plan;
    }
  }

  const groups = new Map();
  const order = [];
  for (const el of elements) {
    const base = highLowBase(nameOf(el));
    if (!groups.has(base)) { groups.set(base, []); order.push(base); }
    groups.get(base).push(el);
  }
  const leftovers = [];
  for (const base of order) {
    const group = groups.get(base);
    const highs = group.filter(e => roleOf(e) === "high");
    const lows = group.filter(e => roleOf(e) === "low");
    const plains = group.filter(e => !roleOf(e));
    const n = Math.min(highs.length, lows.length);
    for (let i = 0; i < n; i++) pair(highs[i], lows[i]);

    leftovers.push(...highs.slice(n), ...lows.slice(n));
    for (const el of plains) one(el);
  }

  const highs = leftovers.filter(e => roleOf(e) === "high");
  const lows = leftovers.filter(e => roleOf(e) === "low");
  const paired = new Set();
  const pn = Math.min(highs.length, lows.length);
  for (let i = 0; i < pn; i++) { pair(highs[i], lows[i]); paired.add(highs[i]); paired.add(lows[i]); }
  for (const el of leftovers) if (!paired.has(el)) one(el);
  return plan;
}

function _renderNodes(section, summary, ctx) {
  const tree = resolveSectionValues(section, summary, ctx);
  if (!tree) return null;
  const wrap = h("div", { class: "sbg-meta-group" });
  for (const n of tree.nodes) {
    const card = h("div", { class: "sbg-meta-card" });
    card.appendChild(h("div", { class: "sbg-meta-card__title", text: n.label }));
    const tbl = h("div", { class: "sbg-meta-kv" });
    for (const [pk, dv] of n.entries) {
      const row = h("div", { class: "sbg-meta-kv__row" });
      row.appendChild(h("span", { class: "sbg-meta-kv__key", text: pk }));
      const kvVal = h("span", { class: "sbg-meta-kv__val" });
      kvVal.appendChild(breakable(dv));
      row.appendChild(kvVal);
      tbl.appendChild(row);
    }
    card.appendChild(tbl);
    wrap.appendChild(card);
  }
  return wrap.children.length ? wrap : null;
}

export function sectionWantsRaw(section) {
  if (!section) return false;
  if (section.style === "raw") return true;
  return Array.isArray(section.tabs) && section.tabs.some(t => t && t.style === "raw");
}

function _renderRaw(section, summary, ctx) {
  const data = ctx.rawData || summary;
  if (!data) return null;
  const pre = h("pre", { class: "sbg-pre", text: pj(data) });
  attachOverlayThumb(pre);
  return pre;
}
