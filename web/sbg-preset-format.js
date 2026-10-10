import { cleanColorValue } from "./sbg-color.js";
import { KINDS } from "./sbg-settings-catalog.js";

// A preset file holds a format and version header, a name, and the four
// `PRESET_BLOCKS` at the top level, any of which may be absent, which is where
// the released versions from before the header read them.
export const PRESET_FORMAT = "sbg-preset";
// Raised only when an older reader would misread the file, such as an id moving
// between blocks. A new optional field needs no raise, since readers skip keys
// they do not know.
export const PRESET_VERSION = 4;
export const PRESET_BLOCKS = Object.freeze(["layouts", "colors", "settings", "keys"]);

const _isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const _BLOCK_OK = {
  // A copy holds null for a profile that was absent when it was taken.
  layouts: (v) => _isObj(v) && Object.values(v).every((p) => p === null || Array.isArray(p)),
  colors: (v) => _isObj(v) && (v.all === undefined || _isObj(v.all)),
  settings: _isObj,
  keys: _isObj,
};

const _BLOCK_NAMES = { layouts: "Metadata Panel layouts", colors: "colors", settings: "settings", keys: "keybindings" };

// A file with no `format` key is version 1. The release that wrote these two
// keys of it never used them, so they are skipped without a note.
const _V1_RETIRED = ["layout", "layoutRenames"];
const _HEADER = ["format", "version", "name", "created", "saved_by"];
// `pinned` is written onto the file by the server, whatever its version.
const _V1_OWN = new Set(["name", "created", "pinned", ...PRESET_BLOCKS, ..._V1_RETIRED]);
// A copy is read as a preset, and these fields describe the copy or are written
// onto a preset by the server, so none of them is reported as unknown.
// `colors_theme` names the theme a copy's colours were read from, which is not
// always the theme it switches to.
const _OWN = new Set([..._HEADER, ...PRESET_BLOCKS, "theme", "theme_name", "cause", "subject", "pinned", "colors_theme", "colors_theme_name"]);

// `theme` holds the selection as the settings store it, so a load switches to
// that theme and its colours stay in the theme. `theme_name` is a user theme's
// name when the preset was saved, which finds the theme on an install where the
// reference finds none and names it when nothing does. A copy is written with
// no name, since its row shows the title stored beside it.
export function wrapPreset({ name, created, savedBy, blocks, theme, themeName }) {
  const out = { format: PRESET_FORMAT, version: PRESET_VERSION };
  if (name !== undefined) out.name = String(name);
  Object.assign(out, {
    created: Number.isFinite(created) ? created : Date.now(),
    saved_by: typeof savedBy === "string" && savedBy ? savedBy : null,
  });
  for (const b of PRESET_BLOCKS) {
    if (blocks && blocks[b] !== undefined) out[b] = blocks[b];
  }
  if (typeof theme === "string" && theme) {
    out.theme = theme;
    if (typeof themeName === "string" && themeName.trim()) out.theme_name = themeName.trim();
  }
  return out;
}

// A copy is read in the shape of a preset, with null where nothing was stored,
// so one reader, diff and plan serve both and part of a copy can be unticked
// before it is put back.
// `unsetTheme` is the theme an install that never picked one shows, which a
// copy recording the selection as unset goes back to.
export function copyDocument({ ids, valueOf, created, cause, subject, classOf, themeKey, unsetTheme, layoutPrefix, colorsTheme, colorsThemeName }) {
  const blocks = { settings: {}, keys: {}, layouts: {}, colors: { all: {} } };
  let theme;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const raw = valueOf(id);
    const value = raw === undefined ? null : raw;
    if (themeKey && id === themeKey) {
      if (typeof value === "string" && value) theme = value;
      else if (unsetTheme) theme = unsetTheme;
      continue;
    }
    if (layoutPrefix && id.startsWith(layoutPrefix)) { blocks.layouts[id.slice(layoutPrefix.length)] = value; continue; }
    const block = typeof classOf === "function" ? KINDS[classOf(id)]?.block : null;
    if (block === "colors") blocks.colors.all[id] = value;
    else if (block) blocks[block][id] = value;
  }
  for (const b of ["settings", "keys", "layouts"]) if (!Object.keys(blocks[b]).length) delete blocks[b];
  if (!Object.keys(blocks.colors.all).length) delete blocks.colors;
  const doc = wrapPreset({ created, blocks, theme });
  doc.cause = String(cause || "");
  if (subject) doc.subject = String(subject);
  if (blocks.colors && typeof colorsTheme === "string" && colorsTheme) {
    doc.colors_theme = colorsTheme;
    if (typeof colorsThemeName === "string" && colorsThemeName) doc.colors_theme_name = colorsThemeName;
  }
  return doc;
}

// A copy holds a flat map of stored settings and a list of unset ones, and
// beside them a theme's colours with the theme they belong to. The name only
// satisfies the reader, since a copy's row shows its title. The Backups list
// sends a copy's layouts as digests, which are lifted the way a preset's are.
// The whole copy of an older version's settings file holds its colours among
// the settings, where that version kept them, and they are read as colours of
// no named theme.
export function readCopy(raw, opts = {}) {
  if (!_isObj(raw)) return _refuse("the backup is damaged");
  return readListing({ ..._copyFromFlat(raw, opts), name: "Backup" }, opts);
}

// A copy that names its theme beside a colours map holds that theme's colours
// and theme variables, the whole map when the copy is whole.
export const namesItsTheme = (raw) => typeof raw.colors_theme === "string" && !!raw.colors_theme && _isObj(raw.colors);

function _copyFromFlat(raw, opts) {
  let values = _isObj(raw.keys) ? raw.keys : {};
  let absent = Array.isArray(raw.absent) ? raw.absent : [];
  const named = namesItsTheme(raw);
  if (named) {
    values = { ...values, ...raw.colors };
    absent = [...absent, ...(Array.isArray(raw.colors_absent) ? raw.colors_absent : [])];
  }
  // A copy taken while every layout lived under one key holds them in one map,
  // read here as one entry per layout, a body or the listing's digest of one.
  const map = opts.layoutMapKey ? values[opts.layoutMapKey] : null;
  const prefix = opts.layoutPrefix;
  if (_isObj(map) && prefix && !Object.keys(values).some((k) => k.startsWith(prefix))) {
    values = { ...values };
    for (const [k, profile] of Object.entries(map)) {
      if ((Array.isArray(profile) && profile.length) || (_isObj(profile) && typeof profile.d === "string")) values[prefix + k] = profile;
    }
  }
  return copyDocument({
    ...opts,
    ids: [...Object.keys(values), ...absent],
    valueOf: (id) => (id in values ? values[id] : null),
    created: raw.created,
    cause: raw.cause,
    subject: raw.subject,
    colorsTheme: named ? raw.colors_theme : undefined,
    colorsThemeName: named && typeof raw.colors_theme_name === "string" ? raw.colors_theme_name : undefined,
  });
}

// Anything the reader does not recognise is dropped and named in `notes`, which
// the person reads, and only a file that cannot be used at all is refused. A
// newer version is read the same way, since the blocks this reader knows still
// load.
export function readPreset(raw, opts = {}) {
  const notes = [];
  if (!_isObj(raw)) return _refuse("this file isn't a preset");
  const hasFormat = raw.format !== undefined;
  if (hasFormat && raw.format !== PRESET_FORMAT) return _refuse("this file isn't a preset");
  if (typeof raw.name !== "string" || !raw.name.trim()) return _refuse("the preset has no name");

  let version;
  if (!hasFormat) version = 1;
  else {
    version = _versionOf(raw.version);
    if (version === null) {
      notes.push("the preset's version number isn't valid, so it was read as a current preset");
      version = PRESET_VERSION;
    }
  }
  let source;
  if (version <= 1) {
    source = raw;
    _noteUnknown(raw, hasFormat ? new Set([..._V1_OWN, "format", "version"]) : _V1_OWN, notes);
  } else {
    if (version > PRESET_VERSION) {
      const by = typeof raw.saved_by === "string" && raw.saved_by ? ` (${raw.saved_by})` : "";
      notes.push(`this preset was saved by a newer version of the gallery${by}, so some parts might not load`);
    }
    source = raw;
    _noteUnknown(raw, _OWN, notes);
  }

  const blocks = {};
  const malformed = [];
  for (const b of PRESET_BLOCKS) {
    const v = source[b];
    if (v === undefined || v === null) continue;
    // Copied, since the tidying below edits the blocks in place.
    if (_BLOCK_OK[b](v)) blocks[b] = _deepCopy(v);
    else malformed.push(b);
  }
  if (malformed.length) {
    const names = malformed.map((b) => _BLOCK_NAMES[b]);
    const listed = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    notes.push(`the ${listed} in the file aren't in a usable format, so they were skipped`);
  }
  if (typeof opts.classOf === "function") _sortByClass(blocks, opts.classOf);
  // An older file spells an untouched binding as an empty string, which this
  // version reads as a binding cleared on purpose, so those are dropped and a
  // load leaves the binding alone.
  if (version < PRESET_VERSION && blocks.keys) {
    blocks.keys = Object.fromEntries(Object.entries(blocks.keys).filter(([, v]) => v !== ""));
    if (!Object.keys(blocks.keys).length) delete blocks.keys;
  }
  const badColors = _cleanPresetColors(blocks);
  if (badColors) notes.push(`${badColors} color value${badColors > 1 ? "s" : ""} in the file couldn't be used and ${badColors > 1 ? "were" : "was"} skipped`);
  const theme = _liftTheme(raw, blocks, opts.themeKey);

  return {
    ok: true,
    error: null,
    notes,
    preset: {
      name: raw.name.trim(),
      created: Number.isFinite(raw.created) ? raw.created : null,
      savedBy: typeof raw.saved_by === "string" && raw.saved_by ? raw.saved_by : null,
      version,
      blocks,
      theme,
      themeName: theme && typeof raw.theme_name === "string" && raw.theme_name.trim() ? raw.theme_name.trim() : null,
      colorsTheme: typeof raw.colors_theme === "string" && raw.colors_theme ? raw.colors_theme : null,
      colorsThemeName: typeof raw.colors_theme === "string" && raw.colors_theme && typeof raw.colors_theme_name === "string" && raw.colors_theme_name ? raw.colors_theme_name : null,
    },
  };
}

// The listing sends each layout profile as `{ d }`, its digest, since profiles
// are most of a preset's weight and a closed row shows none of them. The
// digests are lifted out first because the reader counts a stand-in as damage.
export function readListing(raw, opts = {}) {
  if (!_isObj(raw)) return readPreset(raw, opts);
  let digests = null;
  const lift = (layouts) => {
    const bodies = {};
    for (const [key, p] of Object.entries(layouts)) {
      if (_isObj(p) && typeof p.d === "string" && p.d) (digests ||= {})[key] = p.d;
      else bodies[key] = p;
    }
    return bodies;
  };
  const doc = { ...raw };
  if (_isObj(doc.layouts)) doc.layouts = lift(doc.layouts);
  const read = readPreset(doc, opts);
  if (read.ok) read.preset.layoutDigests = digests;
  return read;
}

// Every key in `RELEASED_DEFAULT_LAYOUTS` is a fingerprint of this form, so a
// change here leaves none of them matching.
export function canonicalJson(value) {
  return JSON.stringify(_sortKeys(value));
}

function _sortKeys(v) {
  if (Array.isArray(v)) return v.map(_sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = _sortKeys(v[k]);
    return out;
  }
  return v;
}

// A closed row's stand-in for a profile body. The diff compares it with the
// server's digest of the install's own profile, and a plan refuses it.
export function layoutDigestRef(digest) {
  return { digest };
}

function _isDigestRef(profile) {
  return !!profile && typeof profile === "object" && !Array.isArray(profile) && typeof profile.digest === "string";
}

function _sameLayout(mine, profile, key, current) {
  if (_isDigestRef(profile)) {
    const d = current.digests && current.digests[key];
    return typeof d === "string" && d === profile.digest;
  }
  return canonicalJson(mine) === canonicalJson(profile);
}

// Older files held the theme selection among the settings. It is lifted out so a
// load never writes it as a setting, and the `theme` field wins where a file
// holds both.
function _liftTheme(raw, blocks, themeKey) {
  let theme = typeof raw.theme === "string" && raw.theme.trim() ? raw.theme.trim() : null;
  if (!themeKey || !blocks.settings || !(themeKey in blocks.settings)) return theme;
  const v = blocks.settings[themeKey];
  delete blocks.settings[themeKey];
  if (!theme && typeof v === "string" && v.trim()) theme = v.trim();
  return theme;
}

const _deepCopy = (v) => JSON.parse(JSON.stringify(v));

// Every writer of a preset file passes it through here, so a stored file is
// already what the reader tidies it to. A closed row compares a digest of the
// stored body and an opened row the tidied one, and the two then agree.
export function cleanPresetColors(doc) {
  if (!_isObj(doc)) return doc;
  const out = _deepCopy(doc);
  const blocks = {};
  if (_isObj(out.colors)) blocks.colors = out.colors;
  if (_isObj(out.layouts)) blocks.layouts = out.layouts;
  _cleanPresetColors(blocks);
  return out;
}

// Every colour a file carries ends up in a style property on the page, so each
// is filtered here before it can reach a writer.
function _cleanPresetColors(blocks) {
  let dropped = 0;
  const clean = (obj, key) => {
    const v = obj[key];
    if (v === undefined || v === null || v === "") return;
    const ok = cleanColorValue(v);
    if (ok) obj[key] = ok;
    else { delete obj[key]; dropped++; }
  };
  const cleanColorProp = (owner, prop = "color") => {
    if (!owner || typeof owner !== "object" || owner[prop] === undefined) return;
    if (!_isObj(owner[prop])) { delete owner[prop]; dropped++; return; }
    for (const k of Object.keys(owner[prop])) clean(owner[prop], k);
  };
  // Beside `all`, the block holds only the named colours older versions wrote,
  // so every other key is cleaned as a colour too.
  if (blocks.colors) {
    for (const k of Object.keys(blocks.colors)) if (k !== "all") clean(blocks.colors, k);
    if (blocks.colors.all) for (const k of Object.keys(blocks.colors.all)) clean(blocks.colors.all, k);
  }
  if (blocks.layouts) {
    for (const sections of Object.values(blocks.layouts)) {
      if (!Array.isArray(sections)) continue;
      for (const sec of sections) {
        if (!_isObj(sec)) continue;
        cleanColorProp(sec);
        for (const p of Array.isArray(sec.params) ? sec.params : []) cleanColorProp(p);
        for (const t of Array.isArray(sec.tabs) ? sec.tabs : []) {
          cleanColorProp(t);
          cleanColorProp(t, "pillColor");
          for (const p of t && Array.isArray(t.params) ? t.params : []) cleanColorProp(p);
        }
      }
    }
  }
  return dropped;
}

export function pickPresetBlocks(blocks, picks) {
  const out = {};
  for (const b of PRESET_BLOCKS) {
    const src = blocks[b];
    const keep = picks[b];
    if (src && keep) out[b] = Object.fromEntries(Object.entries(src).filter(([k]) => keep.has(k)));
  }
  return out;
}

function _versionOf(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

// A preset from a newer format goes back out exactly as it arrived, since
// rebuilding it from the parts this install understood would drop the rest.
// The pin belongs to the file on this install, so an export leaves it out.
export function presetExport(raw, preset) {
  if (preset.version <= PRESET_VERSION) return presetDocument(preset);
  const kept = { ...raw };
  delete kept.pinned;
  return kept;
}

export function presetDocument(preset) {
  return wrapPreset({
    name: preset.name,
    created: preset.created,
    savedBy: preset.savedBy,
    blocks: preset.blocks,
    theme: preset.theme,
    themeName: preset.themeName,
  });
}

// A number and its decimal string are one value, since a control writes the
// string where an older file holds the number. Two strings still compare as
// strings, and a boolean never equals a string.
export function sameValue(a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  if (typeof a !== "number" && typeof b !== "number") return false;
  const numeric = (v) => (typeof v === "number" && Number.isFinite(v))
    || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
  return numeric(a) && numeric(b) && Number(a) === Number(b);
}

const _ENTRY_BLOCKS = ["settings", "keys"];

// A null entry puts the setting back to its default, and nothing stored means
// it is at its default already. An id with no known default counts as a
// change, so it is backed up and written.
function _changes(id, value, current) {
  const now = current.valueOf(id);
  const def = typeof current.defaultOf === "function" ? current.defaultOf(id) : undefined;

  if (value !== null) return !sameValue(now ?? def, value);
  if (now === null || now === undefined) return false;
  return def === undefined || !sameValue(now, def);
}

export function presetDiff({ layouts, writes, theme }, current) {
  const out = { layouts: null, settings: null, keys: null, theme: null };
  if (theme) {
    const exists = typeof current.hasTheme === "function" && current.hasTheme(theme);
    out.theme = { id: theme, current: current.theme ?? null, exists, changes: exists && theme !== current.theme };
  }
  if (layouts) {
    const mine = current.layouts || {};
    const replaces = [];
    const adds = [];
    const same = [];
    // Putting back a null profile removes it. Where the install lacks it too it
    // goes in no list, since a row for it would name a profile neither side has.
    const removes = [];
    for (const [key, profile] of Object.entries(layouts)) {
      if (profile === null) { if (key in mine) removes.push(key); }
      else if (!(key in mine)) adds.push(key);
      else if (_sameLayout(mine[key], profile, key, current)) same.push(key);
      else replaces.push(key);
    }
    const keeps = Object.keys(mine).filter((k) => !(k in layouts));
    out.layouts = { replaces, adds, same, removes, keeps };
  }
  for (const block of _ENTRY_BLOCKS) {
    const list = writes && writes[block];
    if (!list) continue;
    const entries = list.map(([id, value]) => (
      { id, value, current: current.valueOf(id), changes: _changes(id, value, current) }
    ));
    out[block] = { changes: entries.filter((e) => e.changes).length, total: entries.length, entries };
  }
  return out;
}

// A picked entry is written only when it would change, so the backup taken
// before a load holds exactly the keys the load writes.
export function presetPlan({ layouts, writes, theme }, current, choice = {}) {
  const picked = (set, id) => !set || set.has(id);
  const plan = { layouts: { set: {}, remove: [] }, settings: [], keys: [], theme: null, themeMissing: null };
  if (theme && choice.theme !== false) {
    const exists = typeof current.hasTheme === "function" && current.hasTheme(theme);
    if (!exists) plan.themeMissing = theme;
    else if (theme !== current.theme) plan.theme = theme;
  }
  if (layouts) {
    const mine = current.layouts || {};
    for (const [key, profile] of Object.entries(layouts)) {
      if (!picked(choice.layouts, key)) continue;
      if (profile === null) { if (key in mine) plan.layouts.remove.push(key); continue; }
      // A load always works from the whole file, so a digest here is a caller's mistake.
      if (_isDigestRef(profile)) throw new Error(`the layout "${key}" holds only a digest of its sections`);
      if (key in mine && canonicalJson(mine[key]) === canonicalJson(profile)) continue;
      plan.layouts.set[key] = profile;
    }
    if (choice.removeUncarried) {
      for (const k of Object.keys(mine)) if (!(k in layouts) && !plan.layouts.remove.includes(k)) plan.layouts.remove.push(k);
    }
  }
  for (const block of _ENTRY_BLOCKS) {
    for (const [id, value] of (writes && writes[block]) || []) {
      if (!picked(choice[block], id)) continue;
      if (!_changes(id, value, current)) continue;
      plan[block].push([id, value]);
    }
  }
  return plan;
}

export function planWritesAnything(plan) {
  return Object.keys(plan.layouts.set).length > 0 || plan.layouts.remove.length > 0 || !!plan.theme
    || _ENTRY_BLOCKS.some((block) => plan[block].length > 0);
}

// Each entry goes to the block of its current class, whatever version wrote the
// file, so an id whose class moved since the preset was saved still loads.
// An entry of no block's class stays where it is for the load to judge.
function _sortByClass(blocks, classOf) {
  const held = { settings: blocks.settings, keys: blocks.keys, colors: blocks.colors && blocks.colors.all };
  const out = {};
  const touch = (b) => (out[b] ||= { ...(held[b] || {}) });
  for (const [from, entries] of Object.entries(held)) {
    for (const [id, val] of Object.entries(entries || {})) {
      const to = KINDS[classOf(id)]?.block;
      if (!to || to === from) continue;
      delete touch(from)[id];
      // A null means never set. The settings and keys blocks read null the same
      // way, while an old colours block left an unset colour out, so a null
      // colour is dropped.
      if (val === null && to === "colors") continue;
      if (!(held[to] && id in held[to]) && !(id in touch(to))) touch(to)[id] = val;
    }
  }
  if (out.settings) blocks.settings = out.settings;
  if (out.keys) blocks.keys = out.keys;
  if (out.colors) blocks.colors = { ...(blocks.colors || {}), all: out.colors };
}

function _refuse(error) {
  return { ok: false, error, notes: [], preset: null };
}

function _noteUnknown(obj, own, notes) {
  const extra = Object.keys(obj).filter((k) => !own.has(k));
  if (!extra.length) return;
  notes.push(`${extra.length} unknown ${extra.length === 1 ? "key was" : "keys were"} skipped (${extra.join(", ")})`);
}
