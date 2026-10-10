import { api, apiPost, singleFlight, RESTART_FIRST } from "./sbg-core.js";
import { parseColor, resolveColor, withAlpha, textOn, accentInk, lumOf } from "./sbg-color.js";
import { postApply, unconfirmed, causeLabel, COLOURS_FROM_OLDER_VERSION } from "./sbg-settings-backups.js";
import { postNotice, dismissNotice, postSaveFailure, failureText, showFailure, settingsUnreadError } from "./sbg-toast.js";
import { storedSetting, saveSetting, takeApplied, flushSettingsAsync, reloadSettingsFromDisk, settingsUnread, S, legacyHighlight, dropLegacyHighlight, idsOfClass } from "./sbg-settings-store.js";
import { LB_BUTTONS } from "./sbg-settings-catalog.js";
import {
  DEFAULT_THEME, BASE_COLORS, DERIVED_TOKENS, LIGHTBOX_TOKENS, LIGHTBOX_COPIES, DARK_STAGE_TOKENS, THEME_VARIABLES, isBuiltIn, isBaseColor, builtInTheme,
  priorBuiltInValues, userThemeId, userThemeKey, isVarToken, looseColors,
  readThemeFile, migrateCustomTheme, deriveTokens, resolveThemeRef as _resolveRef, themeRefName,
} from "./sbg-theme-model.js";

// The one table of source apps, which every list of apps, the Theme tab's
// badge rows and the badge variables read.
export const APP_REGISTRY = [
  { id: "comfyui", label: "ComfyUI", settingKey: S.APP_BADGE_COMFYUI, cssVar: "--sbg-app-comfyui", inkVar: "--sbg-app-comfyui-ink" },
  { id: "a1111", label: "A1111", settingKey: S.APP_BADGE_A1111, cssVar: "--sbg-app-a1111", inkVar: "--sbg-app-a1111-ink" },
  { id: "forge", label: "Forge", settingKey: S.APP_BADGE_FORGE, cssVar: "--sbg-app-forge", inkVar: "--sbg-app-forge-ink" },
  { id: "sdnext", label: "SD.Next", settingKey: S.APP_BADGE_SDNEXT, cssVar: "--sbg-app-sdnext", inkVar: "--sbg-app-sdnext-ink" },
  { id: "fooocus", label: "Fooocus", settingKey: S.APP_BADGE_FOOOCUS, cssVar: "--sbg-app-fooocus", inkVar: "--sbg-app-fooocus-ink" },
  { id: "civitai", label: "CivitAI", settingKey: S.APP_BADGE_CIVITAI, cssVar: "--sbg-app-civitai", inkVar: "--sbg-app-civitai-ink" },
];

export const THEME_COLOR_KEYS = idsOfClass("color");
// The variables are never settings, so only the colours can wait in the
// settings file.
export const THEME_VALUE_KEYS = [...THEME_COLOR_KEYS, ...THEME_VARIABLES];

const FILL_INK = [
  ["--sbg-card-bg", [["--sbg-card-ink", 1], ["--sbg-card-ink-dim", 0.65]]],
  ["--sbg-search-bg", [["--sbg-search-text", 1], ["--sbg-search-text-dim", 0.65]]],
  ["--sbg-filter-bg", [["--sbg-filter-text", 1]]],
  ["--sbg-section-head-bg", [["--sbg-section-head-text", 0.85]]],
  ["--sbg-panel-solid", [["--sbg-panel-text", 1], ["--sbg-panel-text-dim", 0.65], ["--sbg-panel-pill-text", 1, "pill"], ["--sbg-panel-accent-ink", 1, "accent"]]],
];

const BADGE_VARS = {
  [S.BADGE_HIGH_COLOR]: "--sbg-badge-high",
  [S.BADGE_LOW_COLOR]: "--sbg-badge-low",
  [S.VIDEO_BADGE_COLOR]: "--sbg-badge-vid",
};

// The stylesheet's colour for a badge, read with the theme's value lifted off
// the root for the moment.
export function sheetBadgeColor(id) {
  const name = BADGE_VARS[id];
  if (!name) return "";
  const st = document.documentElement.style;
  const held = st.getPropertyValue(name);
  st.removeProperty(name);
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (held) st.setProperty(name, held);
  return v;
}

const TAG_VARS = [
  [S.SEARCH_TAG_COLOR, "--sbg-tag-fill", "--sbg-tag-fill-hover", "--sbg-tag-color"],
  [S.SEARCH_TAG_NEG_COLOR, "--sbg-tag-neg-fill", "--sbg-tag-neg-fill-hover", "--sbg-tag-neg-color"],
];

// The Delete colour paints every Delete in the gallery, so its variables carry
// no lightbox prefix.
const LB_BUTTON_VARS = {
  "favorite": ["--sbg-lb-favorite-fill", "--sbg-lb-favorite-ink"],
  "download": ["--sbg-lb-download-fill", "--sbg-lb-download-ink"],
  "copy-prompt": ["--sbg-lb-copy-prompt-fill", "--sbg-lb-copy-prompt-ink"],
  "copy-wf": ["--sbg-lb-copy-wf-fill", "--sbg-lb-copy-wf-ink"],
  "load-wf": ["--sbg-lb-load-wf-fill", "--sbg-lb-load-wf-ink"],
  "compare": ["--sbg-lb-compare-fill", "--sbg-lb-compare-ink"],
  "delete": ["--sbg-delete-fill", "--sbg-delete-ink"],
};

let _themes = [];
export const CUSTOM_ORIGIN = "custom";

let _unreadable = [];
let _parked = new Set();
const _isParked = (theme) => _parked.has(theme);
let _themesLoaded = false;
// An empty `_themes` also means an install with no themes, so this marks a list
// that could not be read, which nothing may reconcile against.
let _themesUnread = false;
let _themesError = null;
let _nameMax = null;
// A server from an older version has no themes route, so until ComfyUI restarts
// after the update a new theme and a delete wait for the restart.
let _olderServer = false;
const _listeners = new Set();
const _paintListeners = new Set();

export function onThemesChanged(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
function _emit() {
  for (const fn of _listeners) { try { fn(); } catch { } }
}

export function onThemePainted(fn) {
  _paintListeners.add(fn);
  return () => _paintListeners.delete(fn);
}

// A theme keeps the server's document as it was last read or answered, which an
// export writes out whole.
function _fromServer(entry) {
  const filename = String(entry.filename || "");
  const id = String(entry.id || "");
  const read = entry.readable ? readThemeFile(entry.doc, THEME_COLOR_KEYS) : null;
  if (!read || !read.ok) return { id, filename, unreadable: true };
  return {
    id, filename, name: read.theme.name, values: read.theme.values, doc: entry.doc,
    origin: typeof entry.doc.origin === "string" ? entry.doc.origin : null,
  };
}

// The held edits, save timers and unsaved notice are keyed by theme object, so a
// theme read again keeps its object, updated from the listing with this tab's
// held edits laid over. One gone from the folder leaves the list and drops its
// held edits, its save timer and its notice, while the selection and the order
// stay as they are. One whose file turned unreadable keeps its
// object in `_parked` until the file reads again, and sends nothing meanwhile.
// The server lists such a file under the id it last answered to, so it is found
// by id. One unreadable since before the server started has no such id, and
// reads as gone.
function _keepObjects(listed) {
  const known = [..._themes, ..._parked];
  const before = new Map(known.map(t => [t.id, t]));
  const parked = new Set();
  const out = listed.map((fresh) => {
    if (fresh.unreadable) {
      const old = before.get(fresh.id);
      if (old) parked.add(old);
      return fresh;
    }
    const old = before.get(fresh.id);
    if (!old) return fresh;
    const held = _pending.get(old);
    if (held) for (const [k, v] of held) { if (v) fresh.values[k] = v; else delete fresh.values[k]; }
    if (held && _isParked(old)) _scheduleSave(old);
    return Object.assign(old, fresh);
  });
  const kept = new Set([...out, ...parked]);
  for (const old of known) {
    if (kept.has(old)) continue;
    _cancelSave(old);
    _pending.delete(old);
    _forgetUnsaved(old);
  }
  for (const old of parked) _cancelSave(old);
  _parked = parked;
  return out;
}

export function heldEditsNow() {
  return new Map([..._pending].map(([theme, held]) => [theme.id, new Map(held)]));
}

// A restore wrote the theme's values on the server, which is newer than every
// edit of them this tab held when the restore was sent, so those are dropped
// unsent. `sent` is heldEditsNow() taken then, and an edit made since stays.
// `keys` names the values a restore of part of a copy wrote, so an edit of any
// other value stays to be sent, and without it the restore replaced the whole
// map.
export function dropHeldEdits(id, sent, keys = null) {
  const theme = _themes.find(t => t.id === id) || [..._parked].find(t => t.id === id);
  const held = theme && _pending.get(theme);
  if (!held) return;
  const was = sent.get(id) || new Map();
  for (const [k, v] of [...was]) if (held.get(k) === v && (!keys || keys.includes(k))) held.delete(k);
  if (held.size) return;
  _cancelSave(theme);
  _pending.delete(theme);
  _forgetUnsaved(theme);
}

// Takes the answer of an apply request. Edits this tab held, when the request
// went out, of the values it wrote are older than it and go, `keys` naming
// them when it wrote only some. A theme it made joins the list, and a list read
// that began before the answer is read again.
export function themeApplied(answer, heldAtSend, keys = null) {
  _writesAnswered += 1;
  if (answer.colors_theme_id) dropHeldEdits(answer.colors_theme_id, heldAtSend, keys);
  const entry = answer.theme;
  if (entry && entry.id) {
    const known = _themes.find((t) => t.id === entry.id);
    if (known) _adopt(known, entry);
    else {
      const t = _fromServer({ ...entry, readable: true });
      if (!t.unreadable) _themes.push(t);
    }
  }
  paintTheme();
  _emit();
}

export async function loadUserThemes() {
  let read = false;
  try {
    // Steady edits could keep every read behind, so after two more reads the
    // answer is taken, with this tab's held edits laid over it.
    let data;
    for (let tries = 0; ; tries++) {
      const at = _writesAnswered;
      data = await api("/sidebar_gallery/themes");
      if (_writesAnswered === at || tries >= 2) break;
    }
    const listed = _keepObjects(Array.isArray(data.themes) ? data.themes.map(_fromServer) : []);
    _themes = listed.filter(t => !t.unreadable);
    _unreadable = listed.filter(t => t.unreadable);
    _nameMax = Number(data.name_max) || null;
    _olderServer = false;
    read = true;
  } catch (e) {
    // The route never answers 404 itself, so one comes from a server not
    // restarted since an update from a version without it.
    if (e.status === 404) _olderServer = true;
    _themesError = e.status === 404 ? new Error(RESTART_FIRST) : e;
  }
  _themesUnread = !read;
  _themesLoaded = true;
  _emit();
  return _themes;
}

export function userThemes() { return _themes.slice(); }

export function unreadableThemes() { return _unreadable.slice(); }

export function themeNameMax() { return _nameMax; }

export function activeThemeId() {
  return storedSetting(S.THEME) || DEFAULT_THEME;
}

function _userTheme(id) {
  const key = userThemeKey(id);
  return key ? (_themes.find(t => t.id === key) || null) : null;
}

const _builtInOrDefault = (id) => builtInTheme(id) || builtInTheme(DEFAULT_THEME);

function _valuesOf(id) {
  return (_userTheme(id) || _builtInOrDefault(id)).values;
}

export function activeUserTheme() {
  return _userTheme(activeThemeId());
}

export function activeValues() {
  return _valuesOf(activeThemeId());
}

// While the theme list is unread, colours an older version left in the
// settings paint over the theme's, since a server still running that version
// keeps them there.
function _paintValues() {
  if (!_themesUnread) return activeValues();
  return { ...activeValues(), ...looseColors(_settingValues(), THEME_COLOR_KEYS) };
}

export function themeColor(id) {
  return _paintValues()[id] || "";
}

// Every theme write that is answered is counted, so a list read that began
// before one, and so lacks it, is read again instead of taken.
let _writesAnswered = 0;
const _post = async (body, opts) => {
  const data = await apiPost("/sidebar_gallery/themes", body, opts);
  _writesAnswered += 1;
  return data;
};

// An edit is sent as the values it sets and clears, and the server writes only
// those. Each theme holds one set of edits not yet answered, which every send
// carries whole until an answer takes them, so a send that fails is carried by
// the next. Sends for one theme go one at a time, and each carries a count that
// rises for every send from this tab, since the send made as the page is left
// cannot wait and may overtake one still in flight. The server does not apply a
// send whose count is not above the last it took from this tab for that theme.
const _TAB = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let _count = 0;
const _pending = new Map();
const _inFlight = new Map();
const _deleted = new WeakSet();

function _hold(theme, key, value) {
  if (value) theme.values[key] = value; else delete theme.values[key];
  if (!_pending.has(theme)) _pending.set(theme, new Map());
  _pending.get(theme).set(key, value || null);
}

// The answer's colours become the theme's, except those it still holds unsent
// or unanswered, so another tab's edit shows here once this tab hears back.
function _adopt(theme, entry) {
  if (!entry || !entry.doc) return;
  const read = readThemeFile(entry.doc, THEME_COLOR_KEYS);
  if (!read.ok) return;
  const values = { ...read.theme.values };
  for (const [k, v] of _pending.get(theme) || []) { if (v) values[k] = v; else delete values[k]; }
  theme.values = values;
  theme.doc = entry.doc;
  theme.name = read.theme.name;
  theme.filename = entry.filename || theme.filename;
  if (activeUserTheme() === theme) _paintSoon();
}

async function _send(theme, { keepalive = false } = {}) {
  if (!keepalive) {
    while (_inFlight.has(theme)) await _inFlight.get(theme).catch(() => { });
  }
  const held = _pending.get(theme);
  if (_deleted.has(theme) || _isParked(theme) || !held || !held.size) return;
  const sent = new Map(held);
  const set = {}, clear = [];
  for (const [k, v] of sent) { if (v) set[k] = v; else clear.push(k); }
  const run = _post({ action: "change", id: theme.id, filename: theme.filename, set, clear, tab: _TAB, count: ++_count }, { keepalive });
  if (!keepalive) _inFlight.set(theme, run);
  try {
    const data = await run;
    if (!data.stale) {
      for (const [k, v] of sent) if (held.get(k) === v) held.delete(k);
      // A keepalive may have answered first and a new set been started since,
      // which is not this send's to drop.
      if (!held.size && _pending.get(theme) === held) _pending.delete(theme);
    }
    _adopt(theme, data);
  } catch (e) {
    // Deleted in another tab. A later send cannot land either, so the theme
    // is forgotten here as a delete in this tab forgets it.
    if (e && e.status === 404) _forgetTheme(theme);
    throw e;
  } finally {
    if (_inFlight.get(theme) === run) _inFlight.delete(theme);
  }
}

// A later send carries every colour this tab has not had answered, so one that
// lands also carries what a failed one lost, and takes its theme off the notice.
const _unsaved = new Map();
const _toastedThemes = new WeakSet();
function _tellUnsaved(toast) {
  const themes = [..._unsaved.keys()];
  if (!themes.length) return dismissNotice("theme-save-failed");
  const names = themes.map(t => `"${t.name}"`);
  const reason = _unsaved.get(themes[themes.length - 1]);
  const text = names.length === 1
    ? `${failureText(`save the theme ${names[0]}`, reason)}. Its latest colors may be lost when the page is refreshed.`
    : `${failureText(`save the themes ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`, reason)}. Their latest colors may be lost when the page is refreshed.`;
  postSaveFailure("theme-save-failed", text, toast);
}

/** `told` is a caller saying the failure in its own words, which then comes
 *  with no toast from here. */
function _saveFailed(theme, e, told = false) {
  // The unsaved notice waits for a later save to land, which a theme that is
  // gone cannot have.
  if (_deleted.has(theme)) {
    if (!told) showFailure(`save the theme "${theme.name}"`, e);
    return;
  }
  // Taken out first, so the newest failure's reason is the one told.
  _unsaved.delete(theme);
  _unsaved.set(theme, e);
  _tellUnsaved(!told && !_toastedThemes.has(theme));
  _toastedThemes.add(theme);
}

function _forgetUnsaved(theme) {
  if (_unsaved.delete(theme)) _tellUnsaved(false);
}

async function _saveReported(theme, opts) {
  await _send(theme, opts);
  if (!_pending.has(theme)) _forgetUnsaved(theme);
}

const _saveTimers = new Map();
function _scheduleSave(theme) {
  _watchLeave();
  _toastedThemes.delete(theme);
  clearTimeout(_saveTimers.get(theme));
  _saveTimers.set(theme, setTimeout(() => {
    _saveTimers.delete(theme);
    _saveReported(theme).catch(e => _saveFailed(theme, e));
  }, 400));
}

function _cancelSave(theme) {
  clearTimeout(_saveTimers.get(theme));
  _saveTimers.delete(theme);
}

// A failure is also rethrown, so the caller does not go on without the edit.
function _flushSave(theme) {
  if (!_saveTimers.has(theme) && !_pending.has(theme)) return;
  _cancelSave(theme);
  return _saveReported(theme).catch((e) => { _saveFailed(theme, e, true); throw e; });
}

function _sendWaiting() {
  for (const theme of [..._pending.keys()]) {
    _cancelSave(theme);
    _saveReported(theme, { keepalive: true }).catch(e => _saveFailed(theme, e));
  }
}
let _leaveWatched = false;
function _watchLeave() {
  if (_leaveWatched) return;
  _leaveWatched = true;
  window.addEventListener("pagehide", _sendWaiting);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") _sendWaiting();
  });
}

// The list is read again first, so a restart made since is noticed.
async function _restartFirst() {
  if (_olderServer) await loadUserThemes();
  if (_olderServer) throw new Error(RESTART_FIRST);
}

// The server picks the name from the one sent, with " (copy)" for a fork and a
// number where the name is taken, since only it sees the whole folder. `body`
// is the rest of the request: the colours of a new theme, the id of the theme
// a copy is made from, or the document of a theme being imported.
async function _make(action, name, body, { fork = false } = {}) {
  await _restartFirst();
  const data = await _post({ action, name, fit: fork ? "fork" : "unique", ...body });
  // The server answers a create landing on a file that already holds the same
  // theme with that theme.
  const held = _themes.find(x => x.id === data.id);
  if (held) return held;
  const t = _fromServer({ ...data, readable: true });
  _themes.push(t);
  _emit();
  return t;
}

const _create = (name, values, { fork = false } = {}) => _make("create", name, { values: { ...values } }, { fork });
// Base colours an older version left in the settings while another theme was
// selected are its Custom palette, so they paint nothing and a start makes a
// theme named Custom of them instead.
const _paintedFromSettings = (id) => !isBaseColor(id) || activeThemeId() === "custom";
// Null where the settings hold nothing, since the Custom migration reads an
// empty string as a box the person emptied.
const _settingValues = () => Object.fromEntries(THEME_COLOR_KEYS.filter(_paintedFromSettings).map(k => [k, storedSetting(k) ?? null]));

let _appliedVars = new Set();

let _derived = {};
export function derivedColor(name) {
  return _derived[name] || "";
}

let _paintTimer = null;
let _waitingForSheet = false;

export function paintTheme() {
  clearTimeout(_paintTimer);
  _paintTimer = null;
  const de = document.documentElement;
  const st = de.style;
  const values = _paintValues();
  const setOrClear = (prop, v) => { if (v) st.setProperty(prop, v); else st.removeProperty(prop); };

  for (const name of _appliedVars) st.removeProperty(name);
  for (const name of DERIVED_TOKENS) st.removeProperty(name);
  for (const { key, cssVar } of BASE_COLORS) setOrClear(cssVar, values[key]);
  const applied = new Set();
  for (const [key, v] of Object.entries(values)) {
    if (!isVarToken(key) || DERIVED_TOKENS.includes(key) || !v) continue;
    st.setProperty(key, v);
    applied.add(key);
    if (DARK_STAGE_TOKENS.includes(key)) {
      st.setProperty(key + "-dark", v);
      applied.add(key + "-dark");
    }
  }

  for (const a of APP_REGISTRY) setOrClear(a.cssVar, values[a.settingKey]);
  const pillBg = values[S.PILL_BG_COLOR];
  setOrClear("--sbg-pill-bg", pillBg);
  setOrClear("--sbg-pill-text", values[S.PILL_TEXT_COLOR] || (pillBg ? textOn(pillBg) : ""));
  setOrClear("--sbg-pill-border", values[S.PILL_BORDER_COLOR]);
  for (const [key, cssVar] of Object.entries(BADGE_VARS)) setOrClear(cssVar, values[key]);
  setOrClear("--sbg-fav-color", values[S.FAV_COLOR]);
  setOrClear("--sbg-source-tab-color", values[S.INITIAL_IMAGE_TAB_COLOR]);
  const highlightBg = values[S.HIGHLIGHT_BG];
  setOrClear("--sbg-highlight-bg", highlightBg);
  setOrClear("--sbg-highlight-text", values[S.HIGHLIGHT_TEXT_COLOR] || (highlightBg ? textOn(highlightBg) : ""));
  // A tag's fill is a wash of its colour so the text stays readable on it. A
  // colour `withAlpha` cannot read is used as it is.
  for (const [key, fillVar, hoverVar, colorVar] of TAG_VARS) {
    const c = values[key] || "";
    setOrClear(fillVar, c && (withAlpha(c, 0.2) || c));
    setOrClear(hoverVar, c && (withAlpha(c, 0.45) || c));
    setOrClear(colorVar, c);
  }
  for (const b of LB_BUTTONS) {
    const fill = values[b.color] || "";
    const [fillVar, inkVar] = LB_BUTTON_VARS[b.id];
    setOrClear(fillVar, fill);
    setOrClear(inkVar, fill && textOn(fill));
  }

  const cs = getComputedStyle(de);
  const bg = resolveColor(cs.getPropertyValue("--sbg-bg").trim());
  const accent = resolveColor(cs.getPropertyValue("--sbg-accent").trim());
  if (bg) de.setAttribute("data-sbg-scheme", lumOf(bg) > 0.5 ? "light" : "dark");
  // Channels alone, for stylesheet rules that need the accent at another alpha.
  if (accent) st.setProperty("--sbg-accent-rgb", `${accent.r}, ${accent.g}, ${accent.b}`);
  // Until the gallery stylesheet loads, every colour the theme leaves to it
  // reads empty here, so the whole paint runs again once it has.
  if (!_waitingForSheet) {
    const link = document.querySelector('link[data-sbg-css="1"]');
    if (link && !link.sheet) {
      _waitingForSheet = true;
      link.addEventListener("load", () => { _waitingForSheet = false; paintTheme(); }, { once: true });
    }
  }

  const base = {};
  for (const { cssVar } of BASE_COLORS) base[cssVar.slice("--sbg-".length)] = cs.getPropertyValue(cssVar).trim();
  base.panel = values["--sbg-panel-solid"] || "";
  _derived = deriveTokens(base);
  for (const name of DERIVED_TOKENS) {
    const v = values[name] || _derived[name];
    if (v) { st.setProperty(name, v); applied.add(name); }
  }
  // A lightbox token the theme names was painted above. A Section Header colour
  // it names is also the lightbox panel's own.
  const lightbox = { ..._derived };
  for (const [name, copy] of Object.entries(LIGHTBOX_COPIES)) if (values[name]) lightbox[copy] = values[name];
  for (const name of LIGHTBOX_TOKENS) {
    if (values[name] || !lightbox[name]) continue;
    st.setProperty(name, lightbox[name]);
    applied.add(name);
  }

  // On the lightbox Favorite button the label once favourited takes the
  // Favorite Star colour, or the accent where none is set, and the star takes
  // the Favorite Star colour where one is set. Each is stepped toward near
  // black or white until the label reads on the button's own fill and the
  // star stands out from it. The theme's Text is not the far end, since on a
  // light theme it can itself fall short on the button.
  const favFill = values[S.LB_COLOR_FAVORITE] || lightbox["--sbg-lb-btn-bg"] || "";
  const favGround = parseColor(favFill);
  const favInk = parseColor(textOn(favFill));
  const favOwn = parseColor(values[S.FAV_COLOR] || "");
  const favOn = favOwn || accent;
  const favReady = favGround && favInk && favOn;
  setOrClear("--sbg-lb-favorite-on", favReady ? accentInk(favOn, favInk, favGround) : "");
  setOrClear("--sbg-lb-favorite-star", favReady && favOwn ? accentInk(favOwn, favInk, favGround, 3) : "");

  for (const [fill, inks] of FILL_INK) {
    if (!values[fill]) continue;
    const t = textOn(values[fill]);
    if (!t) continue;
    for (const [ink, alpha, kind] of inks) {
      if (values[ink]) continue;
      // A pill whose fill or text the theme names keeps those, so no ink is
      // worked out against the panel for it.
      if (kind === "pill" && (values[S.PILL_TEXT_COLOR] || values[S.PILL_BG_COLOR])) continue;
      let v = alpha < 1 ? withAlpha(t, alpha) : t;
      if (kind === "accent") {
        if (!accent) continue;
        v = accentInk(accent, parseColor(t), parseColor(values[fill]));
      }
      st.setProperty(ink, v);
      applied.add(ink);
    }
  }
  _appliedVars = applied;

  // A badge colour the theme names is painted as it is. Only the stylesheet's
  // own gets an ink worked out against the panel, whose colour the scheme set
  // above can change.
  const panelGround = resolveColor(cs.getPropertyValue("--sbg-panel-solid").trim()) || bg;
  const panelText = resolveColor(cs.getPropertyValue("--sbg-panel-text").trim()) || resolveColor(cs.getPropertyValue("--sbg-text").trim());
  for (const a of APP_REGISTRY) {
    const shipped = values[a.settingKey] ? null : resolveColor(cs.getPropertyValue(a.cssVar).trim());
    setOrClear(a.inkVar, shipped && panelGround && panelText ? accentInk(shipped, panelText, panelGround) : "");
  }

  for (const fn of _paintListeners) { try { fn(); } catch { } }
}

function _paintSoon() {
  clearTimeout(_paintTimer);
  _paintTimer = setTimeout(paintTheme, 120);
}

export function selectTheme(id) {
  if (!_userTheme(id) && !isBuiltIn(id)) id = DEFAULT_THEME;
  saveSetting(S.THEME, id);
  paintTheme();
  _emit();
}

// An unread list is read again whenever something asks. A retry that lands does
// what the start could not, taking the settings' colours into the theme, and
// paints again.
export function ensureThemesLoaded() {
  return singleFlight("sbg-themes-load", async () => {
    if (_themesLoaded && !_themesUnread) return;
    const retry = _themesLoaded;
    await loadUserThemes();
    if (!retry || _themesUnread) return;
    try { await adoptSettingColours(); } catch (e) { console.warn("[SBG] Taking the settings colors into the theme failed:", e); }
    paintTheme();
  });
}

export function themesUnreadReason() {
  return _themesUnread ? _themesError : null;
}

export function themeExists(id) {
  return userThemeKey(id) ? !!_userTheme(id) : isBuiltIn(id);
}

const _refThemes = () => _themes.map(t => ({ key: t.id, name: t.name }));

// The theme made from an older version's Custom palette, found by the mark in
// its file whatever it has been renamed to.
export function customTheme() {
  return _themes.find(t => t.origin === CUSTOM_ORIGIN) || null;
}

// `storedName` is the name a preset or copy stored beside the reference.
export function themeDisplayName(id, storedName = null) {
  return themeRefName(id, storedName, _refThemes());
}

export function resolveThemeRef(id, storedName) {
  return _resolveRef(id, storedName, _refThemes());
}

// The values of a theme made of the colours an older version's preset carries.
// A built-in or Custom it names starts as that version shipped it, so the theme
// looks the way the preset did.
export function themeValuesFromColours(colours, themeId) {
  const base = themeId === "custom"
    ? migrateCustomTheme(colours).values
    : userThemeKey(themeId) ? _valuesOf(themeId) : priorBuiltInValues(themeId);
  return { ...base, ...looseColors(colours, THEME_COLOR_KEYS) };
}

export async function recordColorEdit(key, value) {
  // A variable outside the list would paint until the next read and then be
  // dropped by it, so it is never taken.
  if (isVarToken(key) && !THEME_VARIABLES.includes(key)) throw new Error(`a theme can't set ${key}`);
  let t = activeUserTheme();
  if (!t) {
    // A built-in cannot take an edit, so the first one makes a copy and edits
    // arriving meanwhile wait on it.
    if (!_forkPending) _forkPending = forkActive().finally(() => { _forkPending = null; });
    t = await _forkPending;
  }
  _hold(t, key, value);
  _scheduleSave(t);
  if (isVarToken(key)) {
    // The picker reports every pointer move, so only the edited token paints
    // at once and the full paint waits for the drag to settle.
    const st = document.documentElement.style;
    const names = DARK_STAGE_TOKENS.includes(key) ? [key, key + "-dark"] : [key];
    if (LIGHTBOX_COPIES[key]) names.push(LIGHTBOX_COPIES[key]);
    for (const name of names) {
      if (value) { st.setProperty(name, value); _appliedVars.add(name); } else st.removeProperty(name);
    }
  }
  _paintSoon();
  return t;
}

let _forkPending = null;

// The name and values a copy of the theme `id` takes when that theme cannot
// take an edit, with `over` laid on. A selection can name a theme file this
// install lacks, as a copy restored from another install does, and the copy
// then takes the default theme's name.
export function forkOf(id, over) {
  const src = _userTheme(id);
  return {
    name: src ? src.name : _builtInOrDefault(id).name,
    values: { ..._valuesOf(id), ...looseColors(over, THEME_VALUE_KEYS) },
  };
}

export async function forkActive() {
  // Unread settings read as the default theme, so the copy would be of that one
  // and its selection would later land over the stored one.
  if (settingsUnread()) throw settingsUnreadError();
  const src = activeUserTheme();

  // A user theme is copied by the server, which carries every colour in its
  // file. A built-in is sent as it paints.
  let t;
  if (src) {
    await _flushSave(src);
    try {
      t = await _make("copy", src.name, { id: src.id, filename: src.filename }, { fork: true });
    } catch (e) {
      if (e.status === 404) _forgetTheme(src);
      throw e;
    }
  } else {
    const { name, values } = forkOf(activeThemeId(), {});
    t = await _create(name, values, { fork: true });
  }
  saveSetting(S.THEME, userThemeId(t.id));
  _emit();
  return t;
}

// The id goes with the theme to its new file, so the selection, the order and
// every preset naming it are left as they are.
export async function renameTheme(theme, name) {
  const next = String(name || "").trim();
  if (!next || next === theme.name) return theme;
  let data;
  try {
    data = await _post({ action: "rename", id: theme.id, filename: theme.filename, name: next });
  } catch (e) {
    if (e.status === 404) _forgetTheme(theme);
    throw e;
  }
  theme.name = next;
  theme.filename = data.filename || theme.filename;
  _adopt(theme, data);
  if (_unsaved.has(theme)) _tellUnsaved(false);
  _emit();
  return theme;
}

// A theme whose file cannot be read is listed by a second object while its own
// waits in `_parked`, so both objects go.
function _forget(theme) {
  for (const t of [theme, ..._parked].filter(t => t === theme || (theme.id && t.id === theme.id))) {
    _deleted.add(t);
    _cancelSave(t);
    _pending.delete(t);
    _forgetUnsaved(t);
    _parked.delete(t);
  }
  _themes = _themes.filter(t => t !== theme);
  _unreadable = _unreadable.filter(t => t !== theme);
}

// Another tab deleted the theme, and its delete took the theme off the
// selection and the order in the file. This tab still names it, so it moves
// off it as that delete did, since a reorder here would otherwise write the
// gone theme's place back. Unread settings hold no order to take it from.
function _forgetTheme(theme) {
  const ref = theme.id ? userThemeId(theme.id) : null;
  const wasActive = !!ref && activeThemeId() === ref;
  _forget(theme);
  const order = storedSetting(S.THEME_ORDER);
  if (ref && !settingsUnread() && Array.isArray(order) && order.includes(ref)) {
    saveSetting(S.THEME_ORDER, order.filter(id => id !== ref));
  }
  if (wasActive) selectTheme(DEFAULT_THEME); else _emit();
}

// The server takes the theme off the selection and out of the order in the
// same request, and this tab takes what it wrote. Changes waiting to be saved
// reach the file first, since one still waiting when the answer comes is taken
// for a change made after it.
export async function deleteTheme(theme) {
  await _restartFirst();
  await flushSettingsAsync();
  let answer;
  try {
    answer = await _post({ action: "delete", id: theme.id });
  } catch (e) {
    if (e.status === 404) _forgetTheme(theme);
    throw e;
  }
  takeApplied(answer.written);
  _forget(theme);
  paintTheme();
  _emit();
  return typeof answer.where === "string" ? answer.where : null;
}

// A user theme exports as its file, with its id and every field a later
// version wrote, once this tab's edits have reached it, so the same theme
// imported elsewhere is still the theme a shared preset names.
export async function themeDocument(theme) {
  await _flushSave(theme);
  return theme.doc;
}

// The server keeps every field of the file but `origin` and the name, which it
// picks, and keeps the id the file brings while no theme here holds it.
export async function importTheme(raw) {
  const read = readThemeFile(raw, THEME_COLOR_KEYS);
  if (!read.ok) throw new Error(read.error);
  return _make("create", read.theme.name, { doc: raw });
}

// An older version keeps colours in the settings file. Every start takes any
// found there into the theme in use and clears them, the theme's own going into
// a backup first, since an older version sharing the install can write more
// between starts.
export async function adoptSettingColours() {
  // The colours and the older highlight wait for a start that reads the
  // settings, since the theme in use is not known before.
  if (settingsUnread()) return null;
  if (!_themesLoaded) await loadUserThemes();
  // Taking colours against an unread list would write them into the wrong
  // theme. The frontend updates on a reload and the server on a restart, so a
  // server without the themes route is an ordinary moment in an upgrade.
  if (_themesUnread) return null;
  // A change still waiting to be saved would be taken for one made after an
  // answer, so it reaches the file first.
  await flushSettingsAsync();

  const values = _settingValues();
  const carried = legacyHighlight();
  // An older version kept the highlight in each browser, so a browser opened after another
  // handed its own over finds one in the theme, which its older copy must not
  // replace. That copy is dropped below all the same.
  const themeHas = !!(activeUserTheme() || { values: {} }).values[S.HIGHLIGHT_BG];
  if (!values[S.HIGHLIGHT_BG] && !themeHas) values[S.HIGHLIGHT_BG] = carried;

  // The Custom palette's base colours leave the settings in the request that
  // makes its theme, so a later failure cannot make it twice.
  if (activeThemeId() !== "custom" && BASE_COLORS.some(({ key }) => storedSetting(key))) {
    const all = Object.fromEntries(THEME_COLOR_KEYS.map(k => [k, storedSetting(k) ?? null]));
    if (!all[S.HIGHLIGHT_BG]) all[S.HIGHLIGHT_BG] = carried;
    const spec = migrateCustomTheme(all);
    const create = { name: spec.name, values: spec.values, origin: CUSTOM_ORIGIN, fit: "unique" };
    try {
      if (!await _handOver({ theme: { create } }, _readFor(BASE_COLORS.map(({ key }) => key)))) return null;
    } catch { return null; }
  }

  const taken = await _takeColours(values);
  if (!taken) return null;
  // Dropped even when the settings held a highlight, so a later start cannot
  // hand over a colour this one replaced.
  dropLegacyHighlight();
  return taken.theme || null;
}

// The colours among `keys` that the settings hold, and the precondition that
// holds each request of the hand-over to them and the selection as read here,
// so two tabs starting together take the colours once.
function _readFor(keys) {
  const held = keys.filter(k => storedSetting(k) != null);
  return { held, precondition: Object.fromEntries([S.THEME, ...held].map(k => [k, storedSetting(k) ?? null])) };
}

// One request of the hand-over, which clears the colours `read` holds. Answers
// null when another tab or an older version changed them since, or no answer
// came, after which both are read again and what is left waits for the next
// start.
async function _handOver(body, { held, precondition }, { clear = true, editing = null } = {}) {
  const settings = clear ? Object.fromEntries(held.map(k => [k, null])) : {};
  if (!body.theme && !held.length) return {};
  // An edit of a theme goes out as one of its saves, after the one already out
  // and before any colour picked meanwhile, which then stays.
  if (editing) while (_inFlight.has(editing)) await _inFlight.get(editing).catch(() => { });
  const run = postApply({ ...body, settings, precondition });
  if (editing) _inFlight.set(editing, run);
  let answer;
  try {
    answer = await run;
  } catch (e) {
    if (e.status !== 409 && !unconfirmed(e)) throw e;
    try { await reloadSettingsFromDisk(); } catch { }
    await loadUserThemes();
    return null;
  } finally {
    if (editing && _inFlight.get(editing) === run) _inFlight.delete(editing);
  }
  takeApplied(answer.written);
  themeApplied(answer, new Map());
  return answer;
}

function coloursOfTheme(id) {
  return looseColors(_valuesOf(id), THEME_COLOR_KEYS);
}

export function themeValuesOf(id) {
  return looseColors(_valuesOf(id), THEME_VALUE_KEYS);
}

export function activeColours() {
  return coloursOfTheme(activeThemeId());
}

// The settings' colours are cleared whether or not any were taken, since one
// the theme already holds is the same colour. Answers null when nothing was
// taken and the colours stay for the next start.
async function _takeColours(values) {
  const made = (answer) => answer && { theme: answer.theme ? _userTheme(userThemeId(answer.theme.id)) : null };
  const read = _readFor(THEME_COLOR_KEYS);
  if (activeThemeId() === "custom") {
    const spec = migrateCustomTheme(values);
    return made(await _handOver({ theme: { create: { name: spec.name, values: spec.values, origin: CUSTOM_ORIGIN, select: true, fit: "unique" } } }, read));
  }

  const active = activeUserTheme();
  const base = active || _builtInOrDefault(activeThemeId());
  const changing = THEME_COLOR_KEYS.filter(k => values[k] && values[k] !== (base.values[k] || ""));
  if (!changing.length) return (await _handOver({}, read)) && {};
  if (active) {
    // The copy holds the theme's own colours and names the theme, so restoring
    // it after a switch puts them back on this theme whatever is in use then.
    // The settings are cleared once the theme holds the colours, in a request
    // of their own so the copy holds none of them, and a page left between the
    // two still finds the colours in one of them.
    let answer;
    try {
      answer = await _handOver({
        theme: { set: { ref: userThemeId(active.id), values: Object.fromEntries(changing.map(k => [k, values[k]])) } },
        backup: { cause: COLOURS_FROM_OLDER_VERSION, title: causeLabel(COLOURS_FROM_OLDER_VERSION) },
      }, read, { clear: false, editing: active });
    } catch (e) {
      postNotice("theme-colours-kept", `${failureText("apply colors from an older version to the theme in use", e)}. Retrying at the next browser refresh.`);
      return null;
    }
    // A theme gone or damaged since the list was read leaves the colours for
    // the next start to place.
    if (!answer || answer.colors_left_out) return null;
    return (await _handOver({}, read)) && { theme: active };
  }
  // A built-in takes no edit, so the colours go into a copy of it, as an
  // edit's do, and the copy is selected. They are passed on since they can hold
  // colours the settings do not, such as the highlight from this browser's own
  // store.
  const { name, values: forked } = forkOf(activeThemeId(), values);
  return made(await _handOver({ theme: { create: { name, values: forked, select: true, fit: "fork" } }, carried: [S.THEME] }, read));
}
