/**
 * sbg-translation-layer.js: Metadata Translation Engine (single source of truth)
 *
 * The user configures, per (app × media), an ordered array of "sections". Each section
 * pulls values out of the raw metadata `summary` via dot-paths and renders them in a
 * chosen style. The SAME `renderSection()` drives BOTH the lightbox metadata panel and
 * the layout-editor live preview, so the two can never disagree.
 *
 *   profile = [ section, ... ]
 *   section = { id, title, style, open, source?, params:[param,...] }
 *   param   = { path, label?, style?, variant?, format?, color? }
 *
 *   style (section): "flat" | "cards" | "text" | "nodes" | "raw"
 *   style (param):   "kv" | "pill" | "detail" | "title" | "text" | "hidden"
 *
 * Path resolution:
 *   "model"                         reads summary.model
 *   "samplers.steps"                reads each summary.samplers[i].steps
 *   "extra.app"                     reads summary.extra.app
 *   "extra.*"                       reads every key under summary.extra
 *   "workflow_nodes.KSampler.seed"  reads the seed of every node whose class_type === "KSampler"
 *   "workflow_nodes.KSampler"       reads the params object of every KSampler node
 */

import { h, kvRow, breakable, pj, getSetting, saveSetting, S, parseColor, formatColor, APP_REGISTRY, copyRenderProps } from "./sbg-core.js";
import { DEFAULT_IMAGE_LAYOUT, DEFAULT_VIDEO_LAYOUT } from "./sbg-default-layout.js";
import { SectionRegistry } from "./sbg-section-registry.js";

// Derived from the single app registry in sbg-core.js, so never hand-extend it.
export const APPS = APP_REGISTRY.map(a => a.id);
export const APP_LABELS = Object.fromEntries(APP_REGISTRY.map(a => [a.id, a.label]));

const PROFILES_KEY = "SBG.Layouts";

// Profile (app×media) of the current renderSection pass, so per-field textbox
// heights persist per profile. Set synchronously at each renderSection entry;
// reads (in _attachPromptResize) happen within the same synchronous render.
// Empty = fall back to the global key.
let _activeProfileKey = "";

let _uidCounter = 0;
function uid(prefix = "s") { return `${prefix}_${Date.now().toString(36)}_${(_uidCounter++).toString(36)}`; }

// Default layout
// A fresh install opens with the default ComfyUI panel layout defined in
// web/sbg-default-layout.js. Each call returns a deep copy so callers can
// mutate the result freely without touching the shared constant.
const _clone = (x) => JSON.parse(JSON.stringify(x));
function defaultImageLayout() { return _clone(DEFAULT_IMAGE_LAYOUT); }
function defaultVideoLayout() { return _clone(DEFAULT_VIDEO_LAYOUT); }

// Profile storage (server-backed via settings). A saved layout is the user's
// document and is never rewritten on read.
export function getProfiles() {
  const stored = getSetting(PROFILES_KEY, null);
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    return stored;
  }
  return {};
}

export function saveProfiles(profiles) {
  saveSetting(PROFILES_KEY, profiles);
  document.dispatchEvent(new CustomEvent("sbg-layout-changed"));
}

/**
 * Catalog default titles keyed by section_id, served by /sidebar_gallery/config
 * and stashed here at gallery init. The shipped DEFAULT layouts cannot fill this
 * role: they are a curated profile snapshot, so sections that only appear in
 * other apps' profiles (ADetailer, ControlNet, Upscaling, ...) are missing from
 * them. They remain a fallback for the moments before the config arrives and
 * for bare test environments.
 */
let _catalogTitles = null;

export function setCatalogTitles(map) {
  if (map && typeof map === "object" && !Array.isArray(map)) _catalogTitles = map;
}

function _defaultTitles() {
  if (_catalogTitles) return _catalogTitles;
  const out = {};
  for (const sec of [...DEFAULT_IMAGE_LAYOUT, ...DEFAULT_VIDEO_LAYOUT]) {
    if (sec && sec.id && sec.title && !(sec.id in out)) out[sec.id] = sec.title;
  }
  return out;
}

/**
 * Section-title renames across every saved profile, mapping each default
 * title to the user's title.
 *
 * The layout editor lets the user retitle a section (e.g. "Models" becomes
 * "Checkpoints"). Search-name resolution and the match badges consume this map
 * so a renamed section can be searched and labelled by its new name. Only
 * sections whose id has a catalog default title are considered; user-added
 * custom sections are handled by getCustomSectionNodeMap instead. Profiles are
 * per (app x media) while search is global, so when two profiles retitle the
 * same section differently the later profile wins.
 *
 * @param {Object} [profiles] - Profile store to scan; defaults to the saved one.
 * @returns {Object} Map of default section title to the user's title.
 */
export function getSectionRenames(profiles = getProfiles()) {
  const defaults = _defaultTitles();
  const renames = {};
  for (const prof of Object.values(profiles || {})) {
    if (!Array.isArray(prof)) continue;
    for (const sec of prof) {
      if (!sec || typeof sec !== "object") continue;
      const def = defaults[sec.id];
      if (def && sec.title && sec.title !== def) renames[def] = sec.title;
    }
  }
  return renames;
}

/**
 * User-made layout sections and tabs mapped to something searchable:
 * { lowercased title: { title, field, classes? } }.
 *
 * A custom section or tab is defined by the params it reads, and those paths
 * say where its data lives:
 *   - "workflow_nodes.<Class>.<param>" paths yield a workflow_nodes search
 *     scoped (via classes) to exactly the node classes the section shows,
 *     so a tab like "LLava" or "JoyCaption" is searchable under its own name.
 *   - other paths ("adetailer.model", "extra.note") resolve their root key
 *     through the registry to an existing backend field, so a tab like
 *     "ADetailers" built on adetailer.* searches the adetailer bucket.
 * Node classes win when both kinds are present (a stray extra.* param must not
 * retarget a nodes-heavy section); with no classes, a single resolvable bucket
 * is used; ambiguous multi-bucket titles are skipped. Entries come from every
 * tab label plus the titles of non-catalog sections (catalog sections already
 * have their own search fields; their whole-section params aggregate tabs).
 * Same-titled entries across profiles merge classes; the first field wins.
 *
 * @param {Object} [profiles] - Profile store to scan; defaults to the saved one.
 */
export function getCustomSectionSearchMap(profiles = getProfiles()) {
  const defaults = _defaultTitles();
  const out = {};
  const addEntry = (title, paramLists) => {
    if (!title || typeof title !== "string" || !title.trim()) return;
    const classes = new Set();
    const buckets = new Set();
    for (const params of paramLists) {
      for (const p of (params || [])) {
        const path = p && p.path;
        if (typeof path !== "string" || !path.trim()) continue;
        if (path.startsWith("workflow_nodes.")) {
          const cls = path.split(".")[1];
          if (cls) classes.add(cls);
        } else {
          const root = path.split(".")[0];
          const canonical = SectionRegistry.getCanonicalName(root, null);
          const f = canonical && SectionRegistry.getSearchField(canonical);
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
  for (const prof of Object.values(profiles || {})) {
    if (!Array.isArray(prof)) continue;
    for (const sec of prof) {
      if (!sec || typeof sec !== "object") continue;
      const tabs = Array.isArray(sec.tabs) ? sec.tabs : [];
      for (const t of tabs) if (t) addEntry(t.label, [t.params]);
      if (!defaults[sec.id] && sec.title) {
        addEntry(sec.title, [sec.params, ...tabs.map((t) => t && t.params)]);
      }
    }
  }
  return out;
}

/**
 * Find-and-replace a per-element pill colour across every saved profile: rewrite
 * pill-style params whose color[channel] matches oldVal to newVal. Used by the
 * Appearance pill-colour settings so changing the colour retargets only pills that
 * were showing the old value; pills of other colours are left alone. Colours are
 * compared canonically so "#5249a2" and "rgb(82,73,162)" match. Persists and
 * notifies (re-rendering an open lightbox panel) when anything changed.
 */
export function replaceElementColor(channel, oldVal, newVal) {
  if (!channel || !oldVal || !newVal) return false;
  const norm = (c) => { const pc = parseColor(c); return pc ? formatColor(pc.r, pc.g, pc.b, pc.a) : ""; };
  const target = norm(oldVal), repl = norm(newVal);
  if (!target || !repl || target === repl) return false;
  const profiles = getProfiles();
  let changed = false;
  const visit = (params) => {
    for (const p of (params || [])) {
      if ((p.style || "kv") !== "pill") continue;
      if (p.color && norm(p.color[channel]) === target) { p.color[channel] = newVal; changed = true; }
    }
  };
  for (const key of Object.keys(profiles)) {
    for (const sec of (profiles[key] || [])) {
      visit(sec.params);
      for (const t of (sec.tabs || [])) visit(t.params);
    }
  }
  if (changed) saveProfiles(profiles);
  return changed;
}

export function profileKey(app, isVideo) {
  const a = APPS.includes(app) ? app : "comfyui";
  return `${a}_${isVideo ? "video" : "image"}`;
}

/** Return the section array for an (app, media), creating a default if absent. */
export function getActiveProfile(app, isVideo) {
  const profiles = getProfiles();
  const key = profileKey(app, isVideo);
  if (Array.isArray(profiles[key]) && profiles[key].length) return profiles[key];
  // Fallback chain: comfyui_<media>, then a freshly minted default.
  const fallback = profiles[`comfyui_${isVideo ? "video" : "image"}`];
  if (Array.isArray(fallback) && fallback.length) return JSON.parse(JSON.stringify(fallback));
  return isVideo ? defaultVideoLayout() : defaultImageLayout();
}

export { defaultImageLayout, defaultVideoLayout, uid };

// Path resolution

/**
 * Narrow a list of workflow_nodes instances with an optional instance matcher
 * { title?, from?, index? }. Precedence: title, then from (upstream context),
 * then index. A specified matcher that matches nothing returns [] with no
 * fallback, so a field bound to e.g. a titled node simply doesn't render for
 * workflows that lack it. No matcher = all instances.
 */
export function filterNodesByMatch(nodes, match) {
  if (!match || typeof match !== "object") return nodes;
  if (match.title != null && match.title !== "") return nodes.filter(n => (n.title || "") === match.title);
  if (match.from != null && match.from !== "") return nodes.filter(n => (n._from || "") === match.from);
  if (match.index != null) { const n = nodes[match.index]; return n ? [n] : []; }
  return nodes;
}

/** Resolve a dot-path against the summary; always returns an array of values. */
export function resolvePath(path, summary, match) {
  if (!path || !summary) return [];
  const parts = path.split(".");

  // workflow_nodes.<class_type>[.param...]: match by class_type, allowing duplicates
  if (parts[0] === "workflow_nodes" && parts.length >= 2) {
    const ct = parts[1];
    const paramPath = parts.length > 2 ? parts.slice(2).join(".") : null;
    const nodes = filterNodesByMatch(
      (summary.workflow_nodes || []).filter(n => n && typeof n === "object" && n.class_type === ct),
      match
    );
    if (!paramPath) return nodes.map(n => n.params || {});
    const out = [];
    for (const n of nodes) {
      // Try the flat param key first: many nodes name widgets with dots
      // (e.g. TextGenerate's "sampling_mode.temperature"), so the key lives
      // directly on params instead of as a nested object. Fall back to nested
      // navigation for genuine sub-objects (e.g. Power Lora Loader "lora_1.on").
      const v = (n.params && Object.prototype.hasOwnProperty.call(n.params, paramPath))
        ? n.params[paramPath]
        : _dig(n.params, paramPath);
      if (v !== undefined && v !== null && v !== "") out.push(v);
    }
    return out;
  }

  // array-section param e.g. samplers.steps, loras.name
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

  // plain dotted path into nested dicts
  const v = _dig(summary, path);
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function _dig(obj, path) {
  if (!obj || typeof obj !== "object") return undefined;
  let cur = obj;
  for (const part of path.split(".")) {
    // hasOwnProperty (not `in`) so prototype members never resolve. With `in`, a
    // path like "samplers.shift" would match Array.prototype.shift and render as
    // the literal "function shift() { [native code] }".
    if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

/** For card/object sections: the list of element objects to render. */
export function resolveSourceElements(source, summary, sourceMatch) {
  if (!source) return summary ? [summary] : [];
  const parts = source.split(".");
  if (parts[0] === "workflow_nodes" && parts.length === 2) {
    const nodes = filterNodesByMatch(
      (summary.workflow_nodes || []).filter(n => n && typeof n === "object" && n.class_type === parts[1]),
      sourceMatch
    );
    // Card title disambiguates instances: the node's title, else its upstream
    // context ("ShowAny (from BasicScheduler)"), else the class_type.
    return nodes.map(n => ({
      ...(n.params || {}),
      __title__: n.title || (n._from ? `${n.class_type} (from ${n._from})` : n.class_type),
    }));
  }
  const val = _dig(summary, source);
  if (Array.isArray(val)) return val;
  if (val && typeof val === "object") return [val];
  return [];
}

// Data sections a tab/section can be "anchored" to: when most of a tab's fields
// read from one of these, the tab only shows if that data exists. Prevents a
// field that also resolves elsewhere (e.g. "end_at_step" via samplers) from
// making a ControlNet tab appear on images that used no ControlNet.
export const AUTO_ANCHOR_KEYS = ["controlnet", "adetailer", "upscaling", "interpolation", "mmaudio", "loras"];

/** Infer the anchor for a section/tab: the first path segment shared by a strict
 *  majority of its visible params, if that segment is an anchorable data section. */
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
  if (bestN * 2 <= params.length) return null; // need a strict majority
  return best;
}

/** Honour an explicit `showWhen` ("always" | a summary path), else the auto anchor. */
export function anchorSatisfied(section, summary) {
  let req = section && section.showWhen;
  if (req === "always") return true;
  if (!req) req = autoAnchorFor(section);
  if (!req) return true;
  return resolvePath(req, summary, null).length > 0;
}

/** True if a section would render anything for this summary. Defined as "the
 *  shared resolver produces a non-empty tree", the same tree the renderers and
 *  the compare signature consume, so visibility, rendering, and diffing can
 *  never disagree. */
export function sectionHasData(section, summary) {
  if (!summary) return false;
  return resolveSectionValues(section, summary) !== null;
}

/**
 * Resolve a param's value within a (cards) section, tolerant of how the path was
 * authored. The field tray offers absolute paths from the summary root (e.g.
 * "mmaudio.prompt", "positive_prompt", "duration"), but a cards section resolves
 * paths relative to its source element, so a dragged-in absolute path would
 * otherwise read as empty. Try, in order:
 *   1. relative to the element            (e.g. "prompt" inside the mmaudio object)
 *   2. with the section's source prefix stripped ("mmaudio.prompt" becomes "prompt")
 *   3. absolute from the summary root     ("positive_prompt", "duration", …)
 * Returns the first non-empty value, else null.
 */
function resolveParamValue(path, element, summary, source, match) {
  if (!path) return null;
  const ok = (v) => v !== undefined && v !== null && v !== "" && typeof v !== "function";
  let v = _dig(element, path);
  if (ok(v)) return v;
  if (source && path.startsWith(source + ".")) {
    v = _dig(element, path.slice(source.length + 1));
    if (ok(v)) return v;
  }
  if (summary && element !== summary) {
    v = _dig(summary, path);
    if (ok(v)) return v;
  }
  // Dotted summary paths (workflow_nodes.<type>.<param>, samplers.x, loras.name)
  // can't be reached by a plain dig; resolve them the way flat sections do (search
  // the array by class_type or iterate). Allowed for a "cards" section with an
  // empty source, whose single card is the whole summary (element === summary),
  // and for a per-element card whose path is genuinely summary-global: only the
  // workflow_nodes and extra heads qualify, and only when the path does not
  // lead into the card's own source (a node-sourced section's own params stay
  // entry-relative). A path into ANY array must never reach here: resolvePath
  // gathers values across the whole array, so returning arr[0] would present
  // one sibling's value as every card's.
  if (path.includes(".") && summary) {
    const head = path.split(".")[0];
    const summaryGlobal = element === summary
      || (source && (head === "workflow_nodes" || head === "extra")
          && !path.startsWith(source + "."));
    if (summaryGlobal) {
      const arr = resolvePath(path, summary, match);
      if (arr && arr.length && ok(arr[0])) return arr[0];
    }
  }
  return null;
}

/* Shared section resolution
 * resolveSectionValues() is the single place that decides what a section shows:
 * which tabs are usable, the auto Enhanced/Original prompt toggle, hidden-param
 * and null/"" filtering, wildcard expansion, and the >400-char node-param drop.
 * The renderers consume its tree for those decisions and add only DOM/styling;
 * sectionSignature() hashes the same tree; sectionHasData() is simply
 * "tree !== null". Keeping all three off one resolver ensures compare mode
 * never hides a real difference or flags an identical section.
 *
 * Tree shapes (null = section renders nothing):
 *   {kind:"raw"}
 *   {kind:"nodes", nodes:[{label, entries:[[key, displayString], …]}, …]}
 *   {kind:"cards", cards:[{el, fields:[{key?|param, value}, …]}, …]}
 *   {kind:"tabs",  tabs:[{id, tab, sub, tree}, …], own:tree|null}
 *   {kind:"flat"|"text", rows:[{param, value, key?} | {param, tabs:tree}, …]}
 *
 * ctx.preview (layout editor) skips the anchor gate so authors always see their
 * sections; preview placeholders are added by the renderers rather than here,
 * so signatures can never contain them.
 */
export function resolveSectionValues(section, summary, ctx = {}) {
  if (!section || !summary) return null;
  const inTab = !!ctx.inTab;
  if (!ctx.preview && !anchorSatisfied(section, summary)) return null;

  // User-defined tabs take priority over the section's style (never nested).
  if (Array.isArray(section.tabs) && section.tabs.length && !inTab) {
    return _resolveTabs(section.tabs, section.params || [], summary);
  }
  const style = section.style || "flat";
  if (style === "raw") return { kind: "raw" };
  if (style === "nodes") return _resolveNodes(summary);
  // Hidden params are excluded from rendering, data, and the compare diff.
  const params = (section.params || []).filter(p => p && (p.style || "kv") !== "hidden");
  if (style === "cards") return _resolveCards(section, params, summary);
  if (style === "text") return _resolveText(params, summary, inTab);
  return _resolveFlat(params, summary);
}

function _resolveTabs(tabs, sectionParams, summary) {
  const out = [];
  for (const t of tabs || []) {
    if (!t) continue;
    const sub = tabAsSection(t);
    const tree = resolveSectionValues(sub, summary, { inTab: true });
    if (tree) out.push({ id: (t.id || t.label || ""), tab: t, sub, tree });
  }
  const visible = (sectionParams || []).filter(p => p && (p.style || "kv") !== "hidden");
  const own = visible.length ? _resolveFlat(visible, summary) : null;
  if (!out.length && !own) return null;
  return { kind: "tabs", tabs: out, own };
}

function _resolveFlat(params, summary) {
  const rows = [];
  for (const p of params) {
    // wildcard: every non-empty key of an object (e.g. extra.*). null/"" values
    // are skipped, matching the renderer.
    if (p.path && p.path.endsWith(".*")) {
      const obj = _dig(summary, p.path.slice(0, -2));
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined || v === null || v === "") continue;
          rows.push({ param: p, key: k, value: v });
        }
      }
      continue;
    }
    for (const v of resolvePath(p.path, summary, p.match)) rows.push({ param: p, value: v });
  }
  return rows.length ? { kind: "flat", rows } : null;
}

function _resolveText(params, summary, inTab) {
  const rows = [];
  for (const p of params) {
    // Positive prompt plus an available pre-enhancement original becomes the
    // auto Enhanced/Original toggle (unless already inside a tab). This synthesis
    // must live here: the renderer shows the extra Original tab, so the signature
    // has to hash it too, or two files differing only in initial_prompt read
    // "same".
    if (p.path === "positive_prompt" && _hasInitialPrompt(summary) && !inTab) {
      const tabs = _resolveTabs([
        { label: "Enhanced", path: "positive_prompt" },
        { label: "Original", path: "initial_prompt" },
      ], [], summary);
      if (tabs) { rows.push({ param: p, tabs }); continue; }
    }
    const vals = resolvePath(p.path, summary, p.match);
    // A text block renders only the first resolved value.
    if (vals.length) rows.push({ param: p, value: vals[0] });
  }
  return rows.length ? { kind: "text", rows } : null;
}

/**
 * The effective source of a cards section. An explicit `source` wins. Without
 * one, when the params' shared anchor head names an array-of-objects summary
 * key (interpolation, controlnet and friends), that head becomes an implicit
 * source, so the section renders one card per entry with each card's fields
 * read from its own entry. The blended fallback (resolveParamValue's summary
 * search, which gathers each field across the whole array independently) is
 * only correct for scalar data, so array data must never reach it.
 */
function _cardsSource(section, summary) {
  if (section.source) return section.source;
  const head = autoAnchorFor(section);
  if (head && summary && Array.isArray(summary[head]) && summary[head].length
      && summary[head].every(e => e && typeof e === "object" && !Array.isArray(e))) {
    return head;
  }
  return section.source;
}

function _resolveCards(section, params, summary) {
  const source = _cardsSource(section, summary);
  const els = resolveSourceElements(source, summary, section.sourceMatch);
  if (!els.length) return null;
  const cards = [];
  for (const el of els) {
    const fields = [];
    if (el && el.__title__) fields.push({ key: "__title__", value: String(el.__title__) });
    for (const p of params) {
      let v = resolveParamValue(p.path, el, summary, source, p.match);
      // Mirror _renderOneCard's per-entry filtering: an empty array (or one of
      // only empty entries) renders nothing, so it must not reach the
      // signature either.
      if (Array.isArray(v)) {
        const kept = v.filter(x => x !== undefined && x !== null && x !== "");
        if (!kept.length) continue;
        v = kept;
      }
      if (v === undefined || v === null || v === "") continue; // mirrors _renderOneCard's skip
      fields.push({ param: p, value: v });
    }
    if (fields.length) cards.push({ el, fields });
  }
  return cards.length ? { kind: "cards", cards } : null;
}

function _resolveNodes(summary) {
  const nodes = [];
  for (const wn of (summary.workflow_nodes || [])) {
    if (!wn || typeof wn !== "object") continue;
    const label = wn.title || (wn._from ? `${wn.class_type} (from ${wn._from})` : (wn.class_type || "Unknown"));
    const params = wn.params && typeof wn.params === "object" ? wn.params : {};
    const entries = [];
    for (const [pk, pv] of Object.entries(params)) {
      const dv = typeof pv === "object" ? JSON.stringify(pv) : String(pv);
      if (dv.length > 400) continue; // over-length params are never displayed
      entries.push([pk, dv]);
    }
    if (entries.length) nodes.push({ label, entries });
  }
  return nodes.length ? { kind: "nodes", nodes } : null;
}

/** A value as the signature hashes it: the DISPLAYED form. The renderers
 *  shorten model paths per the Model Display setting and stringify every
 *  scalar, so two files differing only in a checkpoint's folder, or in a
 *  value's stored type (clip skip as 1 in one file and "1" in another),
 *  render identical text; hashing the raw values badged such pairs as
 *  different. Structures pass through unchanged, since their rendering
 *  differs by section style. */
function _sigValue(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(_sigValue);
  if (typeof v === "object") return v;
  return String(_modelDisplay(v));
}

/** Reduce a resolved tree to plain JSON-stable data (drop param/el/tab object
 *  references, keep stable identifiers + displayed values). */
function _stripTree(t) {
  if (!t) return null;
  switch (t.kind) {
    case "raw": return "raw";
    case "nodes": return ["nodes", t.nodes.map(n => [n.label, n.entries])];
    case "cards": return ["cards", t.cards.map(c =>
      c.fields.map(f => [f.key || (f.param && f.param.path) || "", _sigValue(f.value)]))];
    case "tabs": return ["tabs", t.tabs.map(x => [x.id, _stripTree(x.tree)]), _stripTree(t.own)];
    default: return [t.kind, t.rows.map(r => r.tabs
      ? ["@tabs", _stripTree(r.tabs)]
      : [(r.key !== undefined ? r.key : (r.param && r.param.path)) || "", _sigValue(r.value)])];
  }
}

/**
 * Canonical signature of the resolved values a section would show, used by
 * compare mode to tell "changed" from "same". It hashes the same tree the
 * renderers consume, so an equal string means identically rendered content.
 */
export function sectionSignature(section, summary) {
  if (!section) return "";
  return JSON.stringify(_stripTree(resolveSectionValues(section, summary)));
}

// Formatting / styling helpers
function fmt(value, format) {
  if (!format) return String(value);
  return format.replace("{v}", String(value));
}

// Show model/LoRA names as basename or full relpath per the "Model Display" setting.
// Only touches strings that look like model files, so prompts, numbers and media
// filenames (which use the separate "Filename Display" setting) are left alone.
const _MODEL_EXT_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;
function _modelDisplay(v) {
  if (Array.isArray(v)) return v.map(_modelDisplay);
  if (typeof v !== "string" || !_MODEL_EXT_RE.test(v)) return v;
  if (getSetting(S.MODEL_NAME_STYLE, "basename") !== "basename") return v;
  const parts = v.split(/[\\/]/);
  return parts[parts.length - 1] || v;
}

function makePill(text, param) {
  const cls = `sbg-badge${param && param.variant ? ` sbg-badge--${param.variant}` : ""}`;
  const pill = h("span", { class: cls, text, title: String(text) });
  const c = param && param.color;
  if (c) {
    if (c.bg) pill.style.setProperty("--sbg-pill-bg", c.bg);
    if (c.text) pill.style.setProperty("--sbg-pill-text", c.text);
    if (c.border) pill.style.setProperty("--sbg-pill-border", c.border);
    if (typeof c === "string") pill.style.color = c;
  }
  return pill;
}

/**
 * Apply a param's custom colour to a non-pill element (kv row, detail line,
 * prompt text). Pills get their colour via CSS vars in makePill(); everything
 * else uses plain inline styles so colour customisation works for every style.
 */
function applyParamColor(el, param) {
  applyColor(el, param && param.color);
}

/**
 * kv rows need extra care: their label/value spans take their colour from the
 * --sbg-text(-dim) CSS vars, which beat a colour inherited from the row. Apply
 * bg/border to the row as usual, then re-point the vars so the chosen text
 * colour actually shows.
 */
function applyKvColor(row, param) {
  const c = param && param.color;
  if (!row || !c) return;
  applyColor(row, c);
  const text = typeof c === "string" ? c : c.text;
  if (text) {
    row.style.setProperty("--sbg-text", text);
    row.style.setProperty("--sbg-text-dim", text);
  }
}

/** A border at zero alpha must render as NO border. A transparent 1px border
 *  still occupies layout space and nudges the content, and it keeps doing so
 *  after the user dials the opacity back to zero. */
function _fullyTransparent(color) {
  const p = parseColor(color);
  return !!p && p.a === 0;
}

/** Apply a {bg,text,border} colour object (or a plain colour string) to an element. */
export function applyColor(el, c) {
  if (!el || !c) return;
  if (typeof c === "string") { el.style.color = c; return; }
  if (c.text) el.style.color = c.text;
  if (c.bg) el.style.background = c.bg;
  // Zero alpha means NO border, stated explicitly: skipping the style would
  // let an element's class border (sections, prompt pills) show through, and
  // a transparent 1px border would still displace the content.
  if (c.border) el.style.border = _fullyTransparent(c.border) ? "none" : `1px solid ${c.border}`;
}

/** Default section background colours (so the editor's picker shows the right
 *  starting colour for the green Positive / red Negative prompt sections). */
export function defaultSectionColor(section) {
  const title = (section && section.title) || "";
  if (/positive/i.test(title) || section.id === "positive") return { bg: "rgba(34, 197, 94, 0.08)", border: "rgba(34, 197, 94, 0.25)" };
  if (/negative/i.test(title) || section.id === "negative") return { bg: "rgba(239, 68, 68, 0.08)", border: "rgba(239, 68, 68, 0.25)" };
  return null;
}

function labelFor(param) {
  if (param.label) return param.label;
  const tail = param.path.split(".").pop() || param.path;
  return tail.replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}

/**
 * The label to show as a row/detail prefix (e.g. "Seed: 12345"). The field's
 * name is the prefix: a non-blank custom label is used as-is; an explicitly
 * blank name (the user cleared it) means "show just the value, no prefix" and
 * returns "". A truly absent label (undefined) falls back to the auto-name, so
 * default fields keep their names while a cleared name drops the prefix.
 */
function prefixLabel(param) {
  if (typeof param.label === "string") return param.label.trim() ? param.label.trim() : "";
  return labelFor(param);
}

// The single shared renderer
/**
 * Render one section's CONTENT element (without the collapsible wrapper).
 * Returns an HTMLElement, or null if there is nothing to show.
 * @param ctx { rawData?, profileKey? } optional render context
 */
export function renderSection(section, summary, ctx = {}) {
  _activeProfileKey = (ctx && ctx.profileKey) || ""; // scopes per-profile textbox heights
  // User-defined tabs work on any section: clickable pills that switch which
  // field's value the section shows. Takes priority over the section's style.
  // Skipped when already inside a tab, since tabs don't nest (prevents recursion).
  if (Array.isArray(section.tabs) && section.tabs.length && !(ctx && ctx.inTab)) {
    return _renderTabbedSection(section, section.tabs, summary, ctx);
  }
  const style = section.style || "flat";
  switch (style) {
    case "text":  return _renderText(section, summary, ctx);
    case "cards": return _renderCards(section, summary, ctx);
    case "nodes": return _renderNodes(section, summary, ctx);
    case "raw":   return _renderRaw(section, summary, ctx);
    default:      return _renderFlat(section, summary, ctx);
  }
}

function _renderFlat(section, summary, ctx) {
  const preview = !!(ctx && ctx.preview);
  // Values and show/hide decisions come from the shared resolver (the same tree
  // the compare signature hashes); only DOM/styling lives here. Preview
  // placeholders are renderer-side so signatures never contain them.
  const tree = resolveSectionValues(section, summary, { inTab: !!(ctx && ctx.inTab), preview });
  const byParam = new Map();
  for (const r of ((tree && tree.kind === "flat") ? tree.rows : [])) {
    const arr = byParam.get(r.param) || [];
    arr.push(r);
    byParam.set(r.param, arr);
  }
  const wrap = h("div", { class: "sbg-meta-group" });
  let pills = null;
  for (const p of (section.params || [])) {
    const pstyle = p.style || "kv";
    if (pstyle === "hidden") continue;
    // wildcard: every resolved key of an object (e.g. extra.*)
    if (p.path && p.path.endsWith(".*")) {
      for (const r of (byParam.get(p) || [])) {
        // _modelDisplay so a model path in an extra value renders exactly as
        // the compare signature hashes it.
        const row = kvRow(r.key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
                          typeof r.value === "object" ? pj(r.value) : String(_modelDisplay(r.value)));
        if (row) wrap.appendChild(row);
      }
      continue;
    }
    let vals = (byParam.get(p) || []).map(r => r.value);
    // Preview mode: show every configured field even with no sample value.
    if (!vals.length) {
      if (!preview) continue;
      vals = ["—"];
    }
    for (const rawVal of vals) {
      const val = _modelDisplay(rawVal);
      if (pstyle === "pill") {
        if (!pills) { pills = h("div", { class: "sbg-meta-pills" }); wrap.appendChild(pills); }
        pills.appendChild(makePill(val === "—" ? (prefixLabel(p) ? `${prefixLabel(p)}: —` : "—") : fmt(val, p.format), p));
      } else if (pstyle === "detail") {
        const _lab = prefixLabel(p);
        const d = h("div", { class: "sbg-meta-card__seed", text: _lab ? `${_lab}: ${val}` : String(val) });
        applyParamColor(d, p);
        wrap.appendChild(d);
      } else if (pstyle === "title") {
        // Mirror _renderOneCard so "title" works in flat sections/tabs too (not just cards).
        const t = h("div", { class: "sbg-meta-card__title", text: String(val) });
        applyParamColor(t, p);
        wrap.appendChild(t);
      } else if (pstyle === "text") {
        // Mirror _renderOneCard so "text" renders a prompt block in flat sections/tabs.
        const isNeg = p.variant === "neg" || /negative/i.test(p.path);
        const d = h("div", { class: `sbg-prompt-text sbg-prompt-text--sm${isNeg ? " sbg-prompt-text--neg" : ""}`, text: String(val) });
        applyParamColor(d, p);
        // Remember the dragged height, like the main prompt boxes do.
        _attachPromptResize(d, _promptResizeKey(p));
        wrap.appendChild(d);
      } else {
        const row = kvRow(prefixLabel(p), String(val));
        if (row) { applyKvColor(row, p); wrap.appendChild(row); }
      }
    }
  }
  return wrap.children.length ? wrap : null;
}

function _renderText(section, summary, ctx) {
  const preview = !!(ctx && ctx.preview);
  // Values, the auto Enhanced/Original toggle, and show/hide all come from the
  // shared resolver (same tree the compare signature hashes); DOM only here.
  const tree = resolveSectionValues(section, summary, { inTab: !!(ctx && ctx.inTab), preview });
  const byParam = new Map();
  for (const r of ((tree && tree.kind === "text") ? tree.rows : [])) byParam.set(r.param, r);
  const wrap = h("div", { class: "sbg-meta-group" });
  for (const p of (section.params || [])) {
    if ((p.style || "kv") === "hidden") continue;
    const r = byParam.get(p);
    if (r && r.tabs) {
      // The resolver synthesized the Enhanced/Original toggle for this param;
      // render its usable tabs. Pass a paramless shell so _renderTabbedUsable
      // draws just the tabs; this section's own params render through this loop.
      // The id stays so the remembered-tab key is unchanged.
      const el = _renderTabbedUsable({ id: section.id, title: section.title },
        r.tabs.tabs, summary, ctx);
      if (el) wrap.appendChild(el);
      continue;
    }
    if (!r && !preview) continue;
    // _modelDisplay so a model path bound as a text block renders exactly as
    // the compare signature hashes it; ordinary prompt text passes through.
    const text = r ? (typeof r.value === "string" ? String(_modelDisplay(r.value)) : pj(r.value)) : "—";
    const variant = p.variant || (/negative/i.test(p.path) ? "neg" : "");
    const d = h("div", { class: `sbg-prompt-text${_promptVariantClass(variant)}`, text });
    applyParamColor(d, p);
    // Resize behaviour: the element auto-shrinks to its content, the dragged
    // height becomes the remembered max, and longer text scrolls. Persisted per key.
    _attachPromptResize(d, variant === "neg" ? "neg" : "pos");
    wrap.appendChild(d);
  }
  return wrap.children.length ? wrap : null;
}

function _promptVariantClass(variant) {
  if (variant === "neg") return " sbg-prompt-text--neg";
  return "";
}

function _hasInitialPrompt(summary) {
  if (!summary) return false;
  const init = summary.initial_prompt;
  return init != null && String(init).trim() !== "" && String(init) !== String(summary.positive_prompt || "");
}

/**
 * A tab is a mini-section: { id, label, style, source?, color?, params:[…] }, or
 * the shorthand form { label, path } treated as a single text field. Convert a
 * tab to a section object so the normal renderers handle it, giving each tab
 * real multi-field support, its own style/colour, and correct textbox wrapping.
 */
function tabAsSection(t) {
  if (t && Array.isArray(t.params)) {
    return copyRenderProps(t, { id: t.id || ("tab_" + (t.label || "")), title: t.label, style: t.style || "flat", params: t.params });
  }
  return { id: (t && t.id) || ("tab_" + ((t && t.label) || "")), title: t && t.label, style: "text",
    params: [{ path: t && t.path, label: t && t.label, style: "text" }] };
}

/**
 * Render a section as clickable tab PILLS. Each tab is its own mini-section; the
 * active tab's content renders below via the shared renderer. Works for any
 * section. In preview mode all tabs show (so the user sees their full tab set).
 */
function _renderTabbedSection(section, tabs, summary, ctx) {
  const preview = !!(ctx && ctx.preview);
  // Which tabs are usable is the shared resolver's call (the same filter the
  // compare signature hashes). Preview shows every configured tab.
  let usable;
  if (preview) {
    usable = (tabs || []).filter(Boolean).map(t => ({ tab: t, sub: tabAsSection(t) }));
  } else {
    const tree = _resolveTabs(tabs, [], summary);
    usable = tree ? tree.tabs : [];
  }
  return _renderTabbedUsable(section, usable, summary, ctx);
}

/** Tab-pill UI over a prebuilt usable list ({tab, sub} entries). */
function _renderTabbedUsable(section, usable, summary, ctx) {
  // Section-level fields (outside the tabs) render as a flat block, above or below
  // the tab block (section.fieldsAbove). Lets one shared field (e.g. "show output")
  // stay outside the tabs instead of being duplicated into every tab.
  const secParams = Array.isArray(section.params) ? section.params : [];
  const fieldsEl = secParams.length
    ? renderSection({ id: section.id, title: section.title, style: "flat", params: secParams }, summary, { ...ctx, inTab: true })
    : null;
  const fieldsAbove = !!section.fieldsAbove;

  if (!usable.length && !fieldsEl) return null;

  const box = h("div", {});
  if (fieldsEl && fieldsAbove) box.appendChild(fieldsEl);

  if (usable.length) {
    const pillRow = h("div", { class: "sbg-prompt-toggle" });
    const host = h("div", { class: "sbg-tab-body" });

    let idx = 0;
    const lsKey = `SBG.GS.PromptTab.${section.id || "tabs"}`;
    const remembered = localStorage.getItem(lsKey);
    if (remembered != null) {
      const ri = usable.findIndex(u => (u.tab.label || "") === remembered);
      if (ri >= 0) idx = ri;
    } else {
      const pref = getSetting("SBG.PromptView", "remember");
      const pathOf = (u) => u.tab.path || (u.sub.params[0] && u.sub.params[0].path);
      if (pref === "initial") { const oi = usable.findIndex(u => pathOf(u) === "initial_prompt"); if (oi >= 0) idx = oi; }
      else if (pref === "enhanced") { const ei = usable.findIndex(u => pathOf(u) === "positive_prompt"); if (ei >= 0) idx = ei; }
    }

    const render = () => {
      host.innerHTML = "";
      const { sub } = usable[idx];
      // inTab guards against the positive_prompt auto-toggle re-entering here.
      const el = renderSection(sub, summary, { ...ctx, inTab: true });
      if (el) host.appendChild(el);
      // Per-tab background/colour (optional).
      host.style.cssText = "";
      if (sub.color) applyParamColor(host, { color: sub.color });
      [...pillRow.children].forEach((c, i) => c.classList.toggle("sbg-prompt-pill--active", i === idx));
    };

    usable.forEach((u, i) => {
      const btn = h("button", { class: "sbg-prompt-pill", text: u.tab.label || `Tab ${i + 1}` });
      // Per-tab pill colour (customised in the layout editor).
      if (u.tab.pillColor) applyColor(btn, u.tab.pillColor);
      btn.addEventListener("click", () => { idx = i; try { localStorage.setItem(lsKey, u.tab.label || ""); } catch { } render(); });
      pillRow.appendChild(btn);
    });

    if (usable.length > 1) box.appendChild(pillRow);
    box.appendChild(host);
    render();
  }

  if (fieldsEl && !fieldsAbove) box.appendChild(fieldsEl);
  return box;
}

/**
 * Storage key for a "text"-style field's remembered height. The pos/neg prompts
 * stay shared ("pos"/"neg"); any other text field remembers its own size per path
 * so e.g. an LLM-caption tab keeps its dragged height.
 */
function _promptResizeKey(p) {
  const path = (p && p.path) || "";
  if (p && p.variant === "neg") return "neg";
  if (/negative/i.test(path)) return "neg";
  if (path === "positive_prompt" || path === "initial_prompt") return "pos";
  return path ? "f." + path.replace(/[^a-zA-Z0-9_.-]/g, "_") : "pos";
}

/** Auto-shrink-to-content + user-draggable max height (persisted) + scroll past max. */
function _attachPromptResize(el, storageKey) {
  // Per-profile key so e.g. ComfyUI-image and A1111-video keep independent heights.
  // Reads fall back to the global key, then a default.
  const lsKey = `SBG.GS.PromptHeight.${_activeProfileKey ? _activeProfileKey + "." : ""}${storageKey}`;
  const legacyKey = `SBG.GS.PromptHeight.${storageKey}`;
  let sectionEl = null;
  const applySize = () => {
    if (!sectionEl) sectionEl = el.closest(".sbg-section");
    if (sectionEl && !sectionEl.classList.contains("sbg-section--open")) return;
    const storedH = parseInt(localStorage.getItem(lsKey), 10) || parseInt(localStorage.getItem(legacyKey), 10) || 150;
    // Preserve the user's scroll position: the auto/hidden toggle below otherwise
    // resets scrollTop to 0 (e.g. on a resize drag or a tab-switch re-measure).
    const sc = el.scrollTop;
    // Drop any CSS max-height cap (e.g. the compact --sm variant's 100px) so the
    // user's dragged height is what actually applies.
    el.style.maxHeight = "none";
    el.style.height = "auto";
    el.style.overflowY = "hidden";
    // +2 = top/bottom border only (scrollHeight already includes padding);
    // anything more shows as dead space under the last line.
    const requiredH = el.scrollHeight + 2;
    el.style.height = Math.min(requiredH, storedH) + "px";
    // Always "auto" so a scrollbar appears whenever content exceeds the box (avoids
    // a measurement-timing race where content reflows taller after first sizing).
    el.style.overflowY = "auto";
    el.scrollTop = sc;
  };
  el._sbgApplySize = applySize; // exposed so showing a cached tab can re-measure (lightbox)
  requestAnimationFrame(applySize);
  let dragH = 0;
  el.addEventListener("mousedown", () => { dragH = el.getBoundingClientRect().height; });
  el.addEventListener("mouseup", () => {
    const newH = el.getBoundingClientRect().height;
    // Only re-apply sizing after an actual resize drag (the height changed). A
    // plain click must not call applySize(): it resets the box's internal
    // scrollTop, snapping a scrolled-down long prompt back to the top.
    if (Math.abs(newH - dragH) > 2 && newH > 20) {
      localStorage.setItem(lsKey, String(Math.round(newH)));
      applySize();
    }
  });
}

/**
 * For a sourceless high/low cards section, find the first param whose value on the
 * element is an array of length ≥2 and expand it into one pseudo-element per entry
 * (carrying the other params' scalar values along). Returns null if no such param.
 */
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

function _renderCards(section, summary, ctx) {
  const preview = !!(ctx && ctx.preview);
  // The same effective source as _resolveCards, so the render, the signature
  // and sectionHasData can never disagree about the per-entry expansion.
  const source = _cardsSource(section, summary);
  let elements = resolveSourceElements(source, summary, section.sourceMatch);
  if (!elements.length) {
    if (!preview) return null;
    elements = [{}]; // preview: one placeholder card so the user sees the fields
  }
  const wrap = h("div", { class: "sbg-meta-group" });

  // Pair high/low when explicitly enabled, or by default for MoE-capable sources
  // (so existing saved profiles get the feature without needing a reset). Set
  // `highlow: false` on the section to opt out. Single elements fall back to
  // cards. The COMPUTED source decides, so an implicitly sourced section pairs
  // the same way it would with the source written down.
  const doHighLow = section.highlow === true || (section.highlow == null && _AUTO_HIGHLOW.has(source));

  // MoE Models case: a sourceless cards section (e.g. "Models") whose param value
  // is itself an array (summary.model = ["…HIGH.gguf", "…LOW.gguf"]). Expand that
  // array into one pseudo-element per entry so high/low can pair them.
  if (doHighLow && !source && elements.length === 1) {
    const expanded = _expandArrayParam(section, elements[0]);
    // Substitute only when the expanded entries actually classify as a
    // HIGH/LOW pair. A role-less array (a CLIP file list, a model next to
    // its components) would otherwise fake-pair into duplicated cards.
    if (expanded) {
      const kp = _highLowKeyPath(section);
      const roles = expanded.map(e => classifyHighLow(_dig(e, kp)));
      if (roles.includes("high") && roles.includes("low")) elements = expanded;
    }
  }

  if (doHighLow) {
    _renderHighLowPairs(section, elements, wrap, summary, source);
  } else {
    for (const el of elements) {
      const card = _renderOneCard(section, el, summary, preview, source);
      if (card) wrap.appendChild(card);
    }
  }
  return wrap.children.length ? wrap : null;
}

/** Build one card element from a source element, or null if it has nothing. */
function _renderOneCard(section, el, summary, preview, source = section.source) {
  const card = h("div", { class: "sbg-meta-card" });
  let pills = null;
  let lastTitle = null;

  // implicit title for workflow-node sources
  if (el && el.__title__) {
    const t = h("div", { class: "sbg-meta-card__title", text: String(el.__title__) });
    card.appendChild(t);
    lastTitle = t;
  }

  for (const p of (section.params || [])) {
    const pstyle = p.style || "kv";
    if (pstyle === "hidden") continue;
    const raw = resolveParamValue(p.path, el, summary, source, p.match);
    // A list value (e.g. clip_models with several files) renders one element
    // per entry, so the name-only shortening and per-entry styling apply to
    // each rather than a raw comma-joined array.
    let values = (Array.isArray(raw) ? raw : [raw]).map(_modelDisplay);
    values = values.filter(v => v !== undefined && v !== null && v !== "");
    if (!values.length) {
      if (!preview) continue;
      values = ["—"]; // preview placeholder so the field is visible while editing
    }
    for (const v of values) {
      if (pstyle === "title") {
        // Every title param renders. Titles group at the top of the card, in
        // param order, after the implicit node title if there is one.
        const t = h("div", { class: "sbg-meta-card__title", text: String(v) });
        applyParamColor(t, p);
        card.insertBefore(t, lastTitle ? lastTitle.nextSibling : card.firstChild);
        lastTitle = t;
      } else if (pstyle === "pill") {
        if (!pills) { pills = h("div", { class: "sbg-meta-pills" }); card.appendChild(pills); }
        pills.appendChild(makePill(fmt(v, p.format), p));
      } else if (pstyle === "detail") {
        const _lab = prefixLabel(p);
        const d = h("div", { class: "sbg-meta-card__seed", text: _lab ? `${_lab}: ${v}` : String(v) });
        applyParamColor(d, p);
        card.appendChild(d);
      } else if (pstyle === "text") {
        const isNeg = p.variant === "neg" || /negative/i.test(p.path);
        const d = h("div", { class: `sbg-prompt-text sbg-prompt-text--sm${isNeg ? " sbg-prompt-text--neg" : ""}`, text: String(v) });
        applyParamColor(d, p);
        _attachPromptResize(d, _promptResizeKey(p));
        card.appendChild(d);
      } else {
        const row = kvRow(prefixLabel(p), String(v));
        if (row) { applyKvColor(row, p); card.appendChild(row); }
      }
    }
  }
  return card.children.length ? card : null;
}

// High/Low (MoE) pairing
// Wan2.2-style MoE workflows run two near-identical models/LoRAs/samplers: a
// "high-noise" and a "low-noise" pass. Pair them side-by-side with HIGH/LOW
// labels. Detection is name-based and tolerant of "_HIGH"/"-low"/"(High)" etc.
const _AUTO_HIGHLOW = new Set(["loras", "samplers"]);

/**
 * Split a filename into lowercase words, breaking on separators, camelCase
 * boundaries and letter/digit transitions, so "…_i2vHigh-Q6_K.gguf" yields a
 * "high" word and "HighNoise"/"high_noise"/"highnoise" all yield high+noise.
 * classifyHighLow and highLowBase share this, so any name that classifies as
 * high/low also strips to the same base as its counterpart.
 */
function _hlWords(name) {
  return String(name || "")
    .replace(/\.(safetensors|ckpt|pt|bin|gguf|sft)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")     // camelCase: i2vHigh becomes i2v High
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")  // CAPSWord: WANHigh becomes WAN High
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
  // Explicit HIGH/LOW tokens are authoritative; the heuristics below are weak
  // fallbacks. Use a word boundary for "dit" so "distill" doesn't match it.
  if (/(^|[^a-z])dit([^a-z]|$)/.test(n) && !hasLow) return "high";
  if (n.includes("fp8") && !hasHigh) return "low";
  return null;
}

/** Read a loader/group identifier off an element, if the server recorded one. */
function _loaderGroupOf(el) {
  if (!el || typeof el !== "object") return null;
  const g = el.loader != null ? el.loader : (el.loader_id != null ? el.loader_id : (el.group != null ? el.group : el.node_id));
  return g == null ? null : String(g);
}

/** Strip high/low tokens + extension so a HIGH and its LOW share one base key. */
const _HL_TOKENS = new Set(["high", "low", "hi", "lo", "highnoise", "lownoise"]);
function highLowBase(name) {
  return _hlWords(name).filter(w => !_HL_TOKENS.has(w)).join(" ");
}

function _highLowKeyPath(section) {
  const titleParam = (section.params || []).find(p => p.style === "title");
  if (titleParam) return titleParam.path;
  const first = (section.params || [])[0];
  return first ? first.path : "name";
}

function _emitPair(section, hi, lo, wrap, summary, source) {
  const pair = h("div", { class: "sbg-meta-pair" });
  for (const [label, el] of [["HIGH", hi], ["LOW", lo]]) {
    const item = h("div", { class: "sbg-meta-pair__item" });
    item.appendChild(h("span", { class: "sbg-meta-pair__label", text: label }));
    const card = _renderOneCard(section, el, summary, false, source);
    if (card) item.appendChild(card);
    pair.appendChild(item);
  }
  wrap.appendChild(pair);
}

function _renderHighLowPairs(section, elements, wrap, summary, source = section.source) {
  const keyPath = _highLowKeyPath(section);
  // Resolve the classification name the same prefix-tolerant way values render:
  // a dotted source-relative path like "loras.name" must strip the "loras." prefix
  // to read the element's own "name". A bare _dig(el,"loras.name") returns
  // undefined (the element has no "loras" key), so classifyHighLow(null) would
  // break all pairing.
  const nameOf = (el) => resolveParamValue(keyPath, el, summary, source, null);
  // Prefer the server's topology role (the parser tags each LoRA/model with which
  // sampler pass, high-noise vs low-noise, its loader feeds). It is reliable even
  // when the filename carries no high/low token. Fall back to the filename
  // heuristic for un-reindexed or non-MoE data.
  const roleOf = (el) => {
    const r = el && typeof el === "object" ? el.role : null;
    if (r === "high" || r === "low") return r;
    return classifyHighLow(nameOf(el));
  };

  // 1) Loader-group pairing (most reliable for MoE)
  // If the server tagged elements with which loader node they came from, and
  // there are exactly two distinct loaders, pair the high-noise loader against
  // the low-noise one, independent of how different the filenames look.
  const groupIds = [...new Set(elements.map(_loaderGroupOf).filter(g => g != null))];
  if (groupIds.length === 2 && elements.every(e => _loaderGroupOf(e) != null)) {
    const byGroup = { [groupIds[0]]: [], [groupIds[1]]: [] };
    for (const el of elements) byGroup[_loaderGroupOf(el)].push(el);
    const score = (arr) => arr.reduce((s, el) => s + (roleOf(el) === "high" ? 1 : roleOf(el) === "low" ? -1 : 0), 0);
    let gHi = groupIds[0], gLo = groupIds[1];
    const sHi = score(byGroup[gHi]), sLo = score(byGroup[gLo]);
    // Only trust loader-pairing when the two loaders actually lean opposite ways
    // (one reads HIGH, the other LOW). Without that signal we can't tell an MoE
    // high/low setup from two unrelated LoRAs, so fall through to base pairing.
    if (sHi !== sLo) {
      if (sHi < sLo) { [gHi, gLo] = [gLo, gHi]; }
      const hiArr = byGroup[gHi], loArr = byGroup[gLo];
      const n = Math.max(hiArr.length, loArr.length);
      for (let i = 0; i < n; i++) {
        if (hiArr[i] && loArr[i]) _emitPair(section, hiArr[i], loArr[i], wrap, summary, source);
        else { const el = hiArr[i] || loArr[i]; const card = _renderOneCard(section, el, summary, false, source); if (card) wrap.appendChild(card); }
      }
      return;
    }
  }

  // 2) Base-name grouping (a HIGH and its near-identical LOW)
  // Within each base, pair HIGHs with LOWs, opposite roles only. Two same-class
  // entries (e.g. the same LoRA loaded by two parallel high loaders) must never
  // be forced into a HIGH/LOW pair.
  const groups = new Map();
  const order = [];
  for (const el of elements) {
    const base = highLowBase(nameOf(el));
    if (!groups.has(base)) { groups.set(base, []); order.push(base); }
    groups.get(base).push(el);
  }
  const leftovers = []; // classified entries that didn't pair within their base
  for (const base of order) {
    const group = groups.get(base);
    const highs = group.filter(e => roleOf(e) === "high");
    const lows = group.filter(e => roleOf(e) === "low");
    const plains = group.filter(e => !roleOf(e));
    const n = Math.min(highs.length, lows.length);
    for (let i = 0; i < n; i++) _emitPair(section, highs[i], lows[i], wrap, summary, source);
    // Unmatched classified entries may still pair across bases (stage 3).
    leftovers.push(...highs.slice(n), ...lows.slice(n));
    // Unclassified entries just render as plain cards.
    for (const el of plains) { const card = _renderOneCard(section, el, summary, false, source); if (card) wrap.appendChild(card); }
  }

  // 3) Pair remaining lone HIGH/LOW elements across mismatched bases
  const highs = leftovers.filter(e => roleOf(e) === "high");
  const lows = leftovers.filter(e => roleOf(e) === "low");
  const paired = new Set();
  const pn = Math.min(highs.length, lows.length);
  for (let i = 0; i < pn; i++) { _emitPair(section, highs[i], lows[i], wrap, summary, source); paired.add(highs[i]); paired.add(lows[i]); }
  for (const el of leftovers) {
    if (paired.has(el)) continue;
    const card = _renderOneCard(section, el, summary, false, source);
    if (card) wrap.appendChild(card);
  }
}

function _renderNodes(section, summary, ctx) {
  // Node labels and visible entries (incl. the >400-char drop) come from the
  // shared resolver, so the compare signature can never hash a value this
  // renderer would not display.
  const tree = resolveSectionValues(section, summary,
    { inTab: !!(ctx && ctx.inTab), preview: !!(ctx && ctx.preview) });
  if (!tree || tree.kind !== "nodes") return null;
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

function _renderRaw(section, summary, ctx) {
  const data = (ctx && ctx.rawData) || summary;
  if (!data) return null;
  return h("pre", { class: "sbg-pre", text: pj(data) });
}
