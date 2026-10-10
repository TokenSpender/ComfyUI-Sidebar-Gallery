import {
  h,
  api,
  apiPost,
  branchGuides,
  passingGuide,
  treeStem,
  treeNameX,
  treeGlyphLeft,
  treeGlyphMid,
  singleFlight,
  lsGet,
  lsSet,
  lsRemove,
  downloadJson,
  RESTART_FIRST,
} from "./sbg-core.js";
import { sectionTitle, settingName, settingChoiceLabel, settingDefault, settingGroup, keysText } from "./sbg-settings-inputs.js";
import { paintTheme, activeColours, themeValuesOf, THEME_VALUE_KEYS, adoptSettingColours, loadUserThemes, heldEditsNow, activeThemeId, themeExists, themeDisplayName, resolveThemeRef, themeValuesFromColours, themeApplied, forkOf, CUSTOM_ORIGIN, ensureThemesLoaded, customTheme, themesUnreadReason, sheetBadgeColor, unreadableThemes, userThemes } from "./sbg-theme.js";
import { userThemeId, userThemeKey, BASE_COLORS, DEFAULT_THEME, isBuiltIn, isBaseColor, MISSING_THEME_NAME, THEME_FILE_SUFFIX } from "./sbg-theme-model.js";
import { S, B, S_RETIRED, storedSetting, idsOfClass, idsOfBlock, settingClass, carried, takeApplied, reloadSettingsFromDisk, settingsChangedAt, flushSettingsAsync, settingsUnread, settingsWaiting } from "./sbg-settings-store.js";
import { showToast, showFailure, showSettingsUnread, failureText, reasonOf, confirmClick, noticeRow } from "./sbg-toast.js";
import { getProfiles, layoutWrites, layoutsApplied, profileLabel } from "./sbg-layout-store.js";
import { readPreset, readListing, readCopy, wrapPreset, cleanPresetColors, presetExport, presetDiff, presetPlan, planWritesAnything, pickPresetBlocks, canonicalJson, layoutDigestRef, namesItsTheme } from "./sbg-preset-format.js";
import { postBackups, postApply, unconfirmed, backupTitle, undoTitle, undoKind, undoKindAfter, undoableCopy, whenText } from "./sbg-settings-backups.js";
import { wireListboxKeys } from "./sbg-a11y.js";
import { PIN_FILLED_ICON, PIN_OUTLINE_ICON, CHEVRON_RIGHT_ICON, EYE_ICON, EYE_OFF_ICON } from "./sbg-icons.js";


const READ_OPTS = { classOf: settingClass, themeKey: S.THEME };
// A theme variable has no setting class, so a copy is read with the variables
// counted as colours, which files them in the colours block with the colours
// and lets a restore put them back on the theme.
const isThemeValue = (id) => THEME_VALUE_KEYS.includes(id);
export const COPY_OPTS = { ...READ_OPTS, classOf: (id) => (isThemeValue(id) ? "color" : settingClass(id)), unsetTheme: DEFAULT_THEME, layoutPrefix: S.LAYOUT_PROFILE_PREFIX, layoutMapKey: S.LAYOUT_PROFILES };

// An older preset spelled these colours as named fields beside the block that
// holds colours by id.
const COLOR_FIELDS = { high: S.BADGE_HIGH_COLOR, low: S.BADGE_LOW_COLOR, video: S.VIDEO_BADGE_COLOR, highlight: S.HIGHLIGHT_BG };

// `alsoTheme` is a theme the caller counts as there although its file can't be read.
function _current(alsoTheme = null) {
  const hasTheme = alsoTheme ? (id) => id === alsoTheme || themeExists(id) : themeExists;
  return { layouts: getProfiles(), digests: _layoutDigests, valueOf: (id) => storedSetting(id) ?? null, defaultOf: settingDefault, theme: activeThemeId(), hasTheme };
}

// The install's own layout profiles, which every listing carries as the
// server digested them from the settings file, so a closed row compares a
// stored preset's or copy's with them without reading its file. A server that
// has not restarted since the update sends none.
let _layoutDigests = null;
let _digestError = null;

function _takeDigests(data) {
  const digests = data && data.layout_digests;
  _layoutDigests = digests && typeof digests === "object" ? digests : null;
  _digestError = _layoutDigests ? null : (data && data.layout_digests_error) || RESTART_FIRST;
}

// The row's key and the control's role let a redraw put the focus back on the
// control that replaces this one.
function _control(el, key, role) {
  el.setAttribute("data-focus", `${key}#${role}`);
  return el;
}

function _focusOf(root) {
  const el = document.activeElement;
  return el && root.contains(el) ? el.getAttribute("data-focus") : null;
}

// A redraw leaves the list where it was scrolled, even when the focused row
// moved, as a pin moves its row to the top.
function _refocus(root, focus) {
  const el = focus ? [...root.querySelectorAll("[data-focus]")].find((e) => e.getAttribute("data-focus") === focus) : null;
  if (el) el.focus({ preventScroll: true });
  return !!el;
}

function _deleteButton(key) {
  return _control(h("button", { class: "sbg-btn sbg-btn--danger sbg-btn--delete sbg-btn--sm", text: "Delete" }), key, "delete");
}

// The folder dropdown splits the chevron off because its row also picks a
// folder. A row here does one thing, so a press anywhere on it does that, while
// a button or a tick inside keeps its own press.
function _onRowClick(row, act) {
  row.addEventListener("click", (e) => {
    if (e.target.closest("button, input, label, a[href]")) return;
    act();
  });
}

// The row heading an opened box also owns the box's foot and the other
// controls outside every row. The chevron is left out, since Enter on the
// marked row opens and closes it.
function _rowControls(row) {
  const own = row.querySelectorAll("button, input");
  const box = row.parentNode;
  const heads = box && box.classList.contains("sbg-ptree__box") && box.firstChild === row;
  const boxed = heads ? [...box.querySelectorAll("button, input")].filter((c) => !c.closest(".sbg-ptree__item")) : [];
  return [...own, ...boxed].filter((c) => !c.classList.contains("sbg-tree-strip"));
}

function _rowShell({ key, open = false, label, onToggle, classes = "", role = "listitem", guides = [], depth = 0 }) {
  const item = h("div", { class: `sbg-ptree__item${open ? " sbg-ptree__item--open" : ""}${classes}`, "data-key": key, role });
  for (const g of guides) item.appendChild(g);
  let strip;
  if (onToggle) {
    strip = _control(h("button", {
      type: "button", tabindex: "-1",
      class: `sbg-tree-strip${open ? " sbg-tree-strip--open" : ""}`,
      "aria-label": `${open ? "Close" : "Open"} ${label}`,
      "aria-expanded": open ? "true" : "false",
    }, [h("span", { class: "sbg-tree-chev", html: CHEVRON_RIGHT_ICON, "aria-hidden": "true" })]), key, "strip");
    strip.addEventListener("click", onToggle);
    _onRowClick(item, onToggle);
  } else {
    strip = h("span", { class: "sbg-tree-strip" });
  }
  strip.style.setProperty("--sbg-tree-strip", treeNameX(depth) + "px");
  item.appendChild(strip);
  const body = h("span", { class: "sbg-tree-body" });
  item.appendChild(body);
  return { item, body };
}

function _offer(child) {
  const line = h("div", { class: "sbg-ptree__offer" }, [child]);
  line.style.paddingLeft = treeNameX(1) + "px";
  return line;
}

function _offerLine(text, title) {
  return _offer(h("span", { class: "sbg-ptree__offertext", text, title }));
}

function _offerTick(text, checked, onChange, key, role) {
  const cb = _control(h("input", { type: "checkbox" }), key, role);
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  return _offer(h("label", { class: "sbg-ptree__offertext" }, [cb, ` ${text}`]));
}

// `theme` is the theme on screen, passed in because an install that never
// picked one stores nothing and still shows the shipped theme.
export function presetCapture({ profiles, valueOf, themeKey, theme: onScreen, prefIds = idsOfBlock("settings"), keyIds = idsOfBlock("keys") }) {
  const blocks = { layouts: profiles, settings: {}, keys: {} };
  for (const id of prefIds) blocks.settings[id] = valueOf(id);
  for (const id of keyIds) blocks.keys[id] = valueOf(id);
  const theme = onScreen !== undefined ? onScreen : valueOf(themeKey);
  return { blocks, theme: typeof theme === "string" && theme ? theme : null };
}

// An unset colour is kept as null, since a restore of it takes that colour off
// the theme.
export function copyColours(blocks) {
  const all = (blocks && blocks.colors && blocks.colors.all) || {};
  return Object.entries(all)
    .filter(([id]) => isThemeValue(id))
    .map(([id, v]) => [id, typeof v === "string" && v ? v : null]);
}

const _takesColour = (themeId, id) => !isBaseColor(id) || !isBuiltIn(themeId);

// A theme the restore does not leave in use takes colours only while it is a
// user theme that still exists, and the theme a copy names takes none once it
// is deleted, even while still selected. None can go back with the theme list
// unread. The row's counts and its Restore both ask here, so a row never offers
// a colour its Restore would not write. A copy taken on the older Custom theme
// holds that theme's colours, which go to the theme made from it or to none,
// and one taken on a theme whose file can't be read offers them all for a copy
// of that theme, compared with that copy once it exists.
function _restorableColours(read, switchingTo) {
  const custom = read.preset.theme === "custom" ? themeOf(read) : null;
  const named = read.preset.colorsTheme ? resolveThemeRef(read.preset.colorsTheme, read.preset.colorsThemeName) : null;
  const unread = themesUnreadReason();
  const damaged = !custom && !unread && !(named && themeExists(named)) ? _damagedFile(read.preset.colorsTheme, read.preset.colorsThemeName) : null;
  if (damaged) {
    const made = userThemes().find((t) => t.name === `${damaged.name} (copy)`);
    return { into: made ? userThemeId(made.id) : null, colours: copyColours(read.preset.blocks), unread, damaged, gone: null };
  }
  const into = named || custom || switchingTo || activeThemeId();
  const gone = !unread && !!named && !!userThemeKey(named) && !themeExists(named) ? named : null;
  const writable = !unread && !gone && (into === (switchingTo || activeThemeId()) || (!!userThemeKey(into) && themeExists(into)));
  const colours = writable ? copyColours(read.preset.blocks).filter(([id]) => _takesColour(into, id)) : [];
  return { into, colours, unread, damaged: null, gone };
}

// The file name the server stores a theme name under, short of the underscore
// it adds to a reserved device name and the cut to what the OS takes, which
// only a very long name meets.
const _fileOfName = (name) => `${[...name].filter((c) => /[\p{L}\p{N} _-]/u.test(c)).join("").trim()}${THEME_FILE_SUFFIX}`;

// The damaged file a stored theme reference means, as the server finds it: by
// its id, or by the name stored beside the reference once a restart gave the
// file a new id. Answers the reference and the name to call the theme by.
function _damagedFile(ref, storedName) {
  const key = ref ? userThemeKey(ref) : null;
  if (!key || themeExists(ref)) return null;
  const name = typeof storedName === "string" ? storedName.trim() : "";
  const file = unreadableThemes().find((t) => t.id === key || (name && t.filename === _fileOfName(name)));
  return file ? { ref, name: name || file.filename.slice(0, -THEME_FILE_SUFFIX.length) } : null;
}

const _copiedNote = (into, from) => `The colors were saved to a new theme named "${into}" because theme "${from}" can't be read.`;

// The named fields and the block can hold the same id, and the block wins.
// Older versions painted the Custom base colours only while Custom was the
// theme, so a preset naming any other theme carries them unseen and they are
// left out.
export function oldColours(blocks, classOf, fields, theme) {
  const c = blocks && blocks.colors;
  if (!c) return {};
  const out = {};
  for (const [field, id] of Object.entries(fields || {})) if (typeof c[field] === "string" && c[field]) out[id] = c[field];
  for (const [id, v] of Object.entries(c.all || {})) if (classOf(id) === "color" && typeof v === "string" && v) out[id] = v;
  if (theme !== "custom") for (const { key } of BASE_COLORS) delete out[key];
  return out;
}

// Only ids the block holds are written, so a preset file cannot carry library
// data or an unknown key into the install. A retired key goes unreported, since
// the preset was right to hold it when it was saved.
export function presetBlockEntries(entries, block) {
  const own = new Set(idsOfBlock(block));
  const kept = [];
  const dropped = [];
  for (const [id, val] of Object.entries(entries || {})) {
    if (own.has(id)) kept.push([id, val]);
    else if (!S_RETIRED.includes(id)) dropped.push(id);
  }
  return { kept, dropped };
}

// A load leaves alone an entry the preset does not hold. One held as null was
// at its default when the preset was saved and goes back to it, so the file
// never freezes one version's idea of that default.
export function presetBlockWrites(b) {
  const writes = { settings: null, keys: null };
  const skipped = [];
  const skip = (block, ids) => { for (const id of ids) skipped.push({ block, id }); };
  if (b.settings) {
    const prefs = presetBlockEntries(b.settings, "settings");
    skip("settings", prefs.dropped);
    writes.settings = prefs.kept;
  }
  if (b.keys) {
    const keys = presetBlockEntries(b.keys, "keys");
    skip("keys", keys.dropped);
    const text = presetTextEntries(keys.kept, "keys");
    skipped.push(...text.dropped);
    writes.keys = text.kept;
  }
  return { writes, skipped };
}

// A keybinding is text all the way to its reader and a preset is foreign
// input, so any other type is held back and named. A null is kept, since it
// puts the entry back to its default.
export function presetTextEntries(entries, block) {
  const kept = [];
  const dropped = [];
  for (const [id, val] of entries) {
    if (val === null || typeof val === "string") kept.push([id, val]);
    else dropped.push({ block, id, kind: "text" });
  }
  return { kept, dropped };
}

// An opened row and every Load build from here, so what a row shows and what
// Load writes cannot disagree. A closed row's read from the listing holds a
// digest where a profile's body would be, which the diff compares with the
// install's own digest.
function _loadDocument(read) {
  const b = read.preset.blocks;
  const { writes, skipped } = presetBlockWrites(b);
  let layouts = b.layouts;
  const digests = read.preset.layoutDigests;
  if (digests) {
    layouts = { ...(layouts || {}) };
    for (const [key, d] of Object.entries(digests)) layouts[key] = layoutDigestRef(d);
  }
  return { doc: { layouts, writes, theme: themeOf(read) }, skipped };
}

export function sortPresets(rows) {
  return [...rows].sort((a, b) => {
    const pin = Number(!!b.pinned) - Number(!!a.pinned);
    if (pin) return pin;
    const when = Number(b.created || 0) - Number(a.created || 0);
    if (when) return when;
    return String(a.name).localeCompare(String(b.name));
  });
}

export function sentences(parts) {
  const kept = parts.filter((s) => typeof s === "string" && s.trim());
  return kept.length ? kept.map((s) => s[0].toUpperCase() + s.slice(1)).join(". ") + "." : "";
}

// `unticked` means the whole preset would have changed something the ticks
// left out, so a load that changed nothing does not claim the preset matches.
export function loadMessage(name, plan, notes, skipped, unticked = false, themeName = null) {
  const reasons = [...(notes || []), describeSkipped(skipped || [])];
  const shown = plan.themeMissing ? themeDisplayName(plan.themeMissing, themeName) : "";
  // A preset that stored no theme name has none to quote.
  const quoted = shown && shown !== MISSING_THEME_NAME ? `"${shown}" ` : "";
  if (!planWritesAnything(plan)) {
    const nothing = unticked ? `what's ticked in "${name}" already matches the current settings, so nothing changed`
      : shown ? `the rest of "${name}" already matches the current settings, so nothing changed`
        : `"${name}" already matches the current settings, so nothing changed`;
    return sentences([shown ? `theme ${quoted}not found` : "", nothing, ...reasons]);
  }
  return sentences([shown ? `preset "${name}" loaded, but its theme ${quoted}couldn't be found` : `preset "${name}" loaded`, ...reasons]);
}

export function entryText(id, value, current, changes) {
  const fallback = settingDefault(id);
  const now = current !== null && current !== undefined ? _shown(id, current)
    : fallback !== undefined ? _shown(id, fallback) : "default";

  const next = value === null ? "default" : _shown(id, value);
  if (!changes) return value === null ? now : next;
  return `${now} → ${next}`;
}

function _shown(id, v) {
  if (settingClass(id) === "key") return keysText(v) || "none";
  return valueText(id, v);
}

// The lightbox's buttons and the card menu's items share names, so a name two
// entries share takes its group as well.
export function entryNames(ids) {
  const names = ids.map((id) => settingName(id));
  const count = new Map();
  for (const n of names) count.set(n, (count.get(n) || 0) + 1);
  return new Map(ids.map((id, i) => {
    const group = count.get(names[i]) > 1 ? settingGroup(id) : undefined;
    return [id, group ? `${names[i]} (${group})` : names[i]];
  }));
}

export function valueText(id, v) {
  if (typeof v === "boolean") return v ? "on" : "off";
  return settingChoiceLabel(id, v);
}

const _SKIPPED_NOUNS = { settings: ["setting", "settings"], keys: ["keybinding", "keybindings"] };

// Settings and keybindings skipped for one reason share a sentence.
export function describeSkipped(entries) {
  const groups = new Map();
  for (const { block, id, kind } of entries) {
    const why = kind || (settingClass(id) ? "class" : "unknown");
    if (!groups.has(why)) groups.set(why, { blocks: new Set(), names: [] });
    groups.get(why).blocks.add(block);
    groups.get(why).names.push(settingName(id));
  }
  return [...groups].map(([why, { blocks, names }]) => {
    const n = names.length;
    const [one, many] = _SKIPPED_NOUNS[[...blocks][0]] || _SKIPPED_NOUNS.settings;
    const noun = blocks.size > 1 ? "settings and keybindings" : n === 1 ? one : many;
    const which = why === "text" ? (n === 1 ? "with an invalid value" : "with invalid values")
      : why === "class" ? "that presets can't change"
        : "this version doesn't recognize";
    return `${n} ${noun} ${which} ${n === 1 ? "was" : "were"} skipped (${names.join(", ")})`;
  }).join(". ");
}

let _serverVersion = null;
// A page reloaded after an update meets the older version's server until
// ComfyUI restarts. That server reads every action but delete as a save and never
// answers a conflict, so a rename there writes an empty preset. Its listing has
// no version field, while this version's carries one even when the number is
// unknown. Null until a listing has answered.
let _olderServer = null;
// The server's name limit, which its listing carries.
let _nameMax = null;

// While the server may be the older one it is asked again before each write,
// so a restart made since is noticed without a redraw. A failed ask keeps the
// last answer.
async function _stillOlderServer() {
  if (_olderServer === false) return false;
  try {
    _olderServer = !("version" in await api("/sidebar_gallery/presets"));
  } catch { }
  return _olderServer === true;
}

let _waitNoted = false;
let _retryNoted = false;
// What the move of this browser's presets did, said as a line above the list
// instead of a toast since no click started the move. It stays through the
// redraws until its cross is clicked.
let _moveNote = "";

// Dismissing the note takes its cross off the page, so `list` takes the focus.
function _drawMoveNote(slot, list) {
  slot.textContent = "";
  if (_moveNote) slot.appendChild(noticeRow(_moveNote, () => { _moveNote = ""; _drawMoveNote(slot, list); list.focus(); }));
}

// Closing the row takes its cross off the page, so the list takes the focus.
function _failIn(list, text) {
  list.textContent = "";
  list.appendChild(noticeRow(text, () => { list.textContent = ""; list.focus(); }, { failure: true }));
}

let _typedName = "";
let _liveNameInput = null;
// A Load, Restore or Undo plans against the settings and then waits on a backup
// before applying, so one pressed meanwhile waits for it and plans against what
// it left. The queue outlives a redraw, and a press queued before one runs the
// work of the draw it was pressed in, which reads the preset or copy it named.
let _applying = Promise.resolve();
// The latest draw's redraw, since work that awaits a request, a queued press
// above all, can end after its own draw was replaced.
let _redrawLive = null;

const _SAVE_FIRST = "the latest settings changes couldn't be saved first";

// Another tab can have changed the settings or the themes since this tab read
// them, and a Load, a Restore or an Undo must plan, copy and compare against the
// files. This tab's waiting changes reach the file first, so the read back holds
// them, and the theme list keeps this tab's held colour edits laid over. A
// change that could not be saved refuses the action, since the files would not
// hold what the person has on screen. An opened row draws on what this tab
// holds instead, since only its button writes.
//
// With the settings unread nothing is read back, since only a start may take
// them in, running the steps a start runs on them. A Load, a Restore and an
// Undo refuse before this then, and a row draws on what this tab holds.
async function _readTruth({ forRow = false } = {}) {
  if (settingsUnread()) return;
  await flushSettingsAsync();
  if (settingsWaiting()) {
    if (forRow) return;
    throw new Error(_SAVE_FIRST);
  }
  // A layout another tab changed redraws the lightbox, whatever the action
  // then writes.
  const layouts = JSON.stringify(getProfiles());
  await reloadSettingsFromDisk();
  if (JSON.stringify(getProfiles()) !== layouts) document.dispatchEvent(new CustomEvent("sbg-layout-changed"));
  await loadUserThemes();
}

// One request writes what a plan changes, with the copy taken first, and the
// stores then take what the server wrote. `theme` is an apply theme part, and a
// restore names its copy and may add the library's targets.
async function _sendPlan(plan, theme, backup, { restore = null, more = {} } = {}) {
  const profiles = getProfiles();
  const replaced = [...Object.keys(plan.layouts.set), ...plan.layouts.remove]
    .flatMap((key) => (profiles[key] || []).map((s) => s && s.id));
  const { targets, index } = layoutWrites(plan.layouts);
  const settings = { ...targets, ...more };
  for (const [id, v] of [...plan.settings, ...plan.keys]) settings[id] = v;
  if (plan.theme) settings[S.THEME] = plan.theme;
  const named = [...Object.keys(settings), ...(index ? [S.LAYOUT_INDEX] : []), ...(theme ? [S.THEME] : [])];
  const heldAtSend = heldEditsNow();
  const answer = await postApply({
    settings,
    ...(index ? { deltas: { [S.LAYOUT_INDEX]: index } } : {}),
    ...(theme ? { theme } : {}),
    ...(restore ? { restore } : {}),
    carried: named.filter(carried),
    backup,
  });
  takeApplied(answer.written);
  if (Object.keys(plan.layouts.set).length || plan.layouts.remove.length) layoutsApplied(replaced);
  themeApplied(answer, heldAtSend, theme && theme.set ? Object.keys(theme.set.values) : null);
  return answer;
}

// A restore's colours go into the theme they belong to. A built-in cannot take
// an edit, and neither can a selection naming a theme this install lacks,
// which paints the default theme, so what is painted is copied with them laid
// on and the copy is selected, as an edit of it would do.
function _colourPart(into, entries) {
  if (!entries.length) return null;
  const values = Object.fromEntries(entries.map(([id, v]) => [id, v || null]));
  if (userThemeKey(into) && themeExists(into)) return { set: { ref: into, values } };
  const fork = forkOf(into, values);
  return { create: { name: fork.name, values: fork.values, fit: "fork", select: true } };
}

// A damaged theme's colours go into a new theme named after it, which a second
// restore of the same colours finds again instead of making another.
function _copyPart(damaged, entries, select) {
  const values = Object.fromEntries(entries.filter(([, v]) => v));
  return Object.keys(values).length ? { create: { name: damaged.name, values, fit: "fork", select } } : null;
}

// What a restore left out of its colours, as the server records it and as a
// part restore finds it before sending, said after the action's own sentence
// or alone when nothing else went back.
function _leftOutCaveat(out) {
  if (!out) return null;
  const name = themeDisplayName(out.ref, out.name);
  const theme = name === MISSING_THEME_NAME ? "their theme" : `theme "${name}"`;
  return `The colors weren't restored because ${theme} ${out.why === "damaged" ? "can't be read" : "was deleted"}.`;
}

const _unreadCaveat = (e) => `The colors weren't restored because the theme list couldn't be loaded: ${reasonOf(e)}.`;

// A preset or a copy saved on the older Custom theme, where no theme here is
// that Custom, brings it back from the colours it carries, selected.
function _customPart(read, doc, choice) {
  if (doc.theme !== "custom" || choice.theme === false || !_carriesCustom(read)) return null;
  return { create: { name: "Custom", values: themeValuesFromColours(_customColours(read), "custom"), origin: CUSTOM_ORIGIN, select: true } };
}

// An action that got no answer may have landed, so nothing is sent again and
// what the server holds is read back instead.
async function _rereadUnconfirmed() {
  try { await reloadSettingsFromDisk(); } catch { }
  await loadUserThemes();
  layoutsApplied([]);
  paintTheme();
}

export function stateFor(read) {
  const { doc, skipped } = _loadDocument(read);
  const diff = presetDiff(doc, _current());
  const all = (list) => new Set((list || []).map(([id]) => id));
  const L = diff.layouts;
  const choice = {
    layouts: new Set(L ? [...L.replaces, ...L.adds, ...L.removes, ...L.same] : []),
    settings: all(doc.writes.settings),
    keys: all(doc.writes.keys),
    colors: all(copyColours(read.preset.blocks)),
    theme: true,
    removeUncarried: false,
  };
  return { read, doc, diff, choice, skipped, showAll: false, old: oldColours(read.preset.blocks, settingClass, COLOR_FIELDS, read.preset.theme) };
}

export function colourEntries(st) {
  const D = st.diff;
  const switching = D.theme && D.theme.changes && st.choice.theme !== false ? D.theme.id : null;
  const { into, colours } = _restorableColours(st.read, switching);
  const now = into ? themeValuesOf(into) : {};
  return colours.map(([id, value]) => {
    const mine = now[id] || null;
    const same = (value || "") === (mine || "");
    return { id, label: settingName(id), says: same ? (value || "default") : `${mine || "default"} → ${value || "default"}`, changes: !same };
  });
}

export function changeCounts(st, isCopy) {
  const D = st.diff;
  const L = D.layouts;
  const n = (d) => (d ? d.entries.filter((e) => e.changes).length : 0);
  return {
    layouts: L ? L.replaces.length + L.adds.length + L.removes.length : 0,
    colors: isCopy ? colourEntries(st).filter((e) => e.changes).length : 0,
    settings: n(D.settings),
    keys: n(D.keys),
  };
}

const _KIND_LABELS = [["layouts", "Layouts"], ["colors", "Colors"], ["settings", "Settings"], ["keys", "Keybindings"]];

// A count that couldn't be worked out, shown as the empty-value dash.
const NOT_COMPARED = "—";

export function changePills(counts) {
  return _KIND_LABELS.filter(([k]) => counts[k]).map(([k, label]) => `${label} ${counts[k]}`);
}

export function undoSentence(row) {
  const { kind, name } = undoKind(row);
  const what = name ? `"${name}"` : "a preset";
  const did = kind === "load" ? `Loaded ${what}` : kind === "undid" ? `Undid loading ${what}`
    : kind === "unrestored" ? "Undid restoring a backup" : "Restored a backup";
  return `${did} · ${whenText(row.created)}`;
}

export function undoOffer(row) {
  const { kind } = undoKind(row);
  if (kind === "load") return { button: "Undo", done: "The load was undone.", none: "Nothing to undo. The settings already match how they were before the load." };
  if (kind === "undid") return { button: "Redo", done: "The preset was loaded again.", none: "Nothing to redo. The settings already match the preset." };
  if (kind === "unrestored") return { button: "Redo", done: "The backup was restored again.", none: "Nothing to redo. The settings already match the backup." };
  return { button: "Undo", done: "The restore was undone.", none: "Nothing to undo. The settings already match how they were before the restore." };
}

// What a copy of the whole settings file holds beyond a preset.
export const LIBRARY_IDS = idsOfClass("library").sort((a, b) => settingName(a).localeCompare(settingName(b)));
const _LIBRARY_WORDS = (() => {
  const names = LIBRARY_IDS.map((id) => settingName(id));
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
})();
export const LIBRARY_LINE = _LIBRARY_WORDS[0].toUpperCase() + _LIBRARY_WORDS.slice(1);

// A whole copy is the settings file entire, so a setting, a keybinding or the
// theme picked that it does not hold was at its default then and goes back to
// it. One that names its theme holds that theme's whole map, so a colour or
// variable missing from it was not on the theme then either.
export function asWholeCopy(raw, isSet = (id) => storedSetting(id) !== undefined) {
  const held = new Set([...Object.keys(raw.keys || {}), ...(raw.absent || [])]);
  const unset = [...idsOfBlock("settings"), ...idsOfBlock("keys"), S.THEME].filter((id) => !held.has(id) && isSet(id));
  const out = { ...raw, absent: [...(raw.absent || []), ...unset] };
  if (namesItsTheme(raw)) {
    const off = THEME_VALUE_KEYS.filter((id) => !(id in raw.colors));
    out.colors_absent = [...(Array.isArray(raw.colors_absent) ? raw.colors_absent : []), ...off];
  }
  return out;
}

export function libraryDiffers(raw, valueOf = storedSetting) {
  const then = raw.keys || {};
  return LIBRARY_IDS.some((id) => JSON.stringify(then[id] ?? null) !== JSON.stringify(valueOf(id) ?? null));
}

async function _readWholeCopy(bk) {
  const { doc } = await postBackups({ action: "read", filename: bk.filename });
  const read = readCopy(asWholeCopy(doc), COPY_OPTS);
  if (!read.ok) throw new Error(read.error);
  return { doc, read };
}

// A part copy as the Backups list sends it holds a digest where each layout's
// body would be, which is enough for its closed row. Opening the row and
// restoring it need the bodies, read from the server each time.
async function _readPartCopy(bk) {
  const listed = readCopy(bk.doc, COPY_OPTS);
  if (!listed.ok) throw new Error(listed.error);
  if (!listed.preset.layoutDigests) return listed;
  const { doc } = await postBackups({ action: "read", filename: bk.filename });
  const read = readCopy(doc, COPY_OPTS);
  if (!read.ok) throw new Error(read.error);
  return read;
}

// A whole copy restored with no choice, as the Undo line asks, goes back whole
// on the server, since only the server sees every key. Any other restore reads
// the copy as a preset and sends what it puts back, which is what lets a person
// untick part of it. The caveat says what of the colours was left behind, and
// `goneTheme` names the deleted theme when its colours were all there was to
// put back. `changed` says a whole copy changed something, which `keys` misses
// when only theme colours went back. `unconfirmed` is the failure of one that
// got no answer.
export async function _restoreBackup(bk, choice) {
  await ensureThemesLoaded();
  const undo = undoKindAfter(bk);
  const backup = { cause: "before-restore", title: undoTitle(bk), subject: undo === "load" || undo === "undid" ? undoKind(bk).name : "", undo_kind: undo };
  if (bk.whole && !choice) return _restoreWholeFile(bk, { ...backup, cause: `before-restore-${bk.doc.cause || ""}` });

  await _readTruth();
  let read, library = null;
  if (bk.whole) {
    const whole = await _readWholeCopy(bk);
    read = whole.read;
    // A preset cannot hold the library, so the copy's own values go back.
    const held = whole.doc.keys || {};
    if (choice.library && libraryDiffers(whole.doc)) library = Object.fromEntries(LIBRARY_IDS.map((id) => [id, id in held ? held[id] : null]));
  } else {
    read = await _readPartCopy(bk);
  }

  let doc = _loadDocument(read).doc;
  if (doc.theme === "custom") doc = { ...doc, theme: themeOf(read) };
  // A selection naming a theme whose file can't be read is still that theme,
  // which an Undo of a restore that left it puts back.
  const lostTheme = _damagedFile(doc.theme, read.preset.themeName) ? doc.theme : null;
  const custom = _customPart(read, doc, choice || {});
  const plan = presetPlan(custom ? { ...doc, theme: null } : doc, _current(lostTheme), choice || {});
  // Colours live in the theme file and are left out of the plan, so the ticked
  // ones that differ from their theme go as a theme part. A Custom made from
  // the copy holds them already.
  const picked = choice && choice.colors;
  const ticked = ([id]) => !picked || picked.has(id);
  const { into, colours: offered, unread, damaged, gone } = _restorableColours(read, plan.theme);
  const target = into ? themeValuesOf(into) : {};
  const entries = custom ? [] : offered.filter((e) => ticked(e) && (e[1] || "") !== (target[e[0]] || ""));
  const carried = copyColours(read.preset.blocks).some(ticked);
  const leftOut = !!unread && carried;
  const goneCaveat = gone && !custom && carried ? _leftOutCaveat({ ref: gone, why: "missing", name: read.preset.colorsThemeName }) : null;
  // The copy stands in for the damaged theme where the restore leaves that
  // theme in use, so it is asked for then even when it holds these colours.
  const selects = !!damaged && (plan.theme || activeThemeId()) === damaged.ref;
  const theme = custom || (!damaged ? _colourPart(into, entries)
    : entries.length || selects ? _copyPart(damaged, offered.filter(ticked), selects) : null);
  if (!planWritesAnything(plan) && !theme && !library) {
    if (leftOut) return { keys: [], caveat: _unreadCaveat(unread) };
    // Nothing differed, or only colours of a deleted theme, which `goneTheme` names.
    return goneCaveat ? { keys: [], caveat: null, goneTheme: themeDisplayName(gone, read.preset.colorsThemeName) } : { keys: [], caveat: null };
  }
  let answer;
  try {
    answer = await _sendPlan(plan, theme, backup, { restore: { filename: bk.filename, created: bk.created }, more: library || {} });
  } catch (e) {
    if (!unconfirmed(e)) throw e;
    await _rereadUnconfirmed();
    return { keys: [], caveat: null, unconfirmed: e };
  }
  const out = answer.colors_left_out;
  let caveat = _leftOutCaveat(out) || goneCaveat;
  if (!caveat && leftOut) caveat = _unreadCaveat(unread);
  // The colours went into a theme file, so the settings written leave them out.
  const coloured = out ? [] : entries.map(([id]) => id);
  const keys = [...Object.keys(answer.written), ...coloured];
  // The theme was deleted after the list was read, which the server found.
  if (!keys.length && out && out.why === "missing") return { keys, caveat: null, goneTheme: themeDisplayName(out.ref, out.name) };
  // A copy made before is found again, so only a first one is new.
  const note = damaged && !into && answer.theme ? _copiedNote(answer.theme.doc.name, damaged.name) : null;
  return { keys, caveat, note };
}

async function _restoreWholeFile(bk, backup) {
  // A change still waiting to be saved would miss the copy the server takes of
  // the file, so it reaches the file first, and one that cannot refuses the
  // restore as _readTruth does.
  await flushSettingsAsync();
  if (settingsWaiting()) throw new Error(_SAVE_FIRST);
  const heldAtSend = heldEditsNow();
  // The server puts the copy's colours back on the theme they belong to in the
  // same request as the settings, so the two cannot come apart.
  let answer;
  try {
    answer = await postApply({ restore: { filename: bk.filename, created: bk.created, whole: true }, backup });
  } catch (e) {
    if (!unconfirmed(e)) throw e;
    await _rereadUnconfirmed();
    return { keys: [], caveat: null, unconfirmed: e };
  }
  takeApplied(answer.written);
  layoutsApplied([]);
  themeApplied(answer, heldAtSend);
  if (answer.colors_theme_id) await loadUserThemes();
  // A copy from an older version holds colours among its settings, which go
  // into the theme in use the way the first start after updating takes them.
  let caveat = null;
  try { await adoptSettingColours(); } catch (e) { caveat = `The colors couldn't be saved to the current theme: ${reasonOf(e)}.`; }
  paintTheme();
  const keys = Object.keys(answer.written);
  const out = answer.colors_left_out;
  // A copy whose only difference was colours of a deleted theme restored nothing.
  if (!keys.length && out && out.why === "missing") return { keys, caveat: null, goneTheme: themeDisplayName(out.ref, out.name) };
  // The step keeps colours it could not save in the settings for the next start.
  const waiting = !themesUnreadReason() && keys.some((k) => settingClass(k) === "color" && storedSetting(k) !== undefined);
  if (!caveat && waiting) caveat = "The colors couldn't be saved to the current theme yet. Retrying at the next browser refresh.";
  if (!caveat) caveat = _leftOutCaveat(answer.colors_left_out);
  const unreadThemes = themesUnreadReason();
  if (!caveat && unreadThemes && keys.some((k) => settingClass(k) === "color")) {
    caveat = `The colors couldn't be applied because the theme list couldn't be loaded: ${reasonOf(unreadThemes)}. Retrying at the next browser refresh.`;
  }
  const copied = answer.colors_copied;
  // Colours put back on their theme write no setting, while the copy the
  // server takes before any change says one happened.
  return { keys, caveat, note: copied ? _copiedNote(copied.into, copied.from) : null, changed: !!answer.backup };
}

// An older install kept its own colours under the id custom, and the start
// that took them into a file named that theme Custom, so a file naming custom
// means that one.
export function themeOf(read) {
  const t = read.preset.theme;
  if (t !== "custom") return resolveThemeRef(t, read.preset.themeName);
  const mine = customTheme();
  return mine ? userThemeId(mine.id) : t;
}

// Whether a preset naming the older Custom theme carries the colours to make
// it again, which one saved with Colors unticked does not. A colours block with
// no base colour in it is a palette left at its defaults and still counts.
function _carriesCustom(read) {
  return !!(read.preset.blocks && read.preset.blocks.colors);
}

// A base colour the preset recorded as emptied goes along empty, since that
// version painted an empty one in ComfyUI's colours instead of its default.
function _customColours(read) {
  const colours = oldColours(read.preset.blocks, settingClass, COLOR_FIELDS, "custom");
  const all = (read.preset.blocks.colors && read.preset.blocks.colors.all) || {};
  for (const { key } of BASE_COLORS) if (all[key] === "") colours[key] = "";
  return colours;
}

async function _savePreset(name, doc, force) {
  if (await _stillOlderServer()) throw new Error(RESTART_FIRST);
  return apiPost("/sidebar_gallery/presets", { action: "save", name, data: doc, force });
}

async function _renamePreset(filename, to) {
  if (await _stillOlderServer()) throw new Error(RESTART_FIRST);
  let info;
  try {
    info = await apiPost("/sidebar_gallery/presets", { action: "rename", filename, name: to });
  } catch (e) {
    if (e.data && e.data.error === "conflict") throw new Error(`A preset named "${e.data.existing || to}" already exists`);
    throw e;
  }
  return info.filename || filename;
}

// Moves presets a browser still keeps in its own storage onto the install,
// under a suffixed name where the plain one is taken. With `read`, one whose
// contents match a preset already there is merged into it instead of arriving
// twice. Import passes an empty `from`, since its file says nothing about a
// browser, and gets a number as its suffix. `persist` is handed what is still
// to move after each entry, so a page closed partway never moves one twice.
export async function migrateBrowserPresets({ list, rows, save, read, persist, from = "from browser", nameMax = null }) {
  // With no limit known nothing is cut, and the server refuses a name too long.
  const most = Number.isInteger(nameMax) ? nameMax : Infinity;
  const moved = [];
  const merged = [];
  const skipped = [];
  const remaining = [];
  const errors = [];

  const notes = [];
  const held = new Map((rows || []).map((r) => [r.name, r]));
  const entries = Array.isArray(list) ? list : [];
  const sameAs = async (doc, filename) => _sameContents(doc, await read(filename));
  for (const [i, raw] of entries.entries()) {
    if (persist && i) persist([...remaining, ...entries.slice(i)]);
    const r = readPreset(raw);
    if (!r.ok) { skipped.push({ name: raw && typeof raw.name === "string" ? raw.name : "unnamed", error: r.error }); continue; }
    // Saved as it arrived apart from its colour values, so a preset from a
    // newer version loses nothing here and exports back whole.
    const doc = cleanPresetColors(raw);
    const base = r.preset.name;
    // Names that differ only in punctuation land on one file, so a run of them
    // needs a suffix each. The server refuses a name over its limit and counts
    // characters, and a cut through a UTF-16 pair would leave half an emoji in
    // the name.
    const chars = Array.from(base);
    const fit = (suffix) => chars.slice(0, most - Array.from(suffix).length).join("") + suffix;
    // An older server kept a name over the limit whole.
    const same = held.has(base) ? base : held.has(fit("")) ? fit("") : null;
    const candidates = from ? [fit(""), fit(` (${from})`)] : [fit("")];
    for (let n = 2; n <= 9; n++) candidates.push(fit(from ? ` (${from} ${n})` : ` (${n})`));
    // A move cut short by a reload, or run in a second tab, may have saved this
    // preset under a suffixed name already, and finding it there is the same
    // merge.
    let mergedInto = null;
    let unread = null;
    if (read) {
      for (const name of new Set([same, ...candidates])) {
        const row = name && held.get(name);
        // A file the listing could not read cannot hold the same contents, and
        // asking for it would hold the move back for good.
        if (!row || row.readable === false || !row.filename) continue;
        try {
          if (await sameAs(doc, row.filename)) { mergedInto = name; break; }
        } catch (e) { unread = e; }
      }
    }
    if (mergedInto) { merged.push(mergedInto); continue; }
    // A preset of the same name that could not be read may hold the same
    // contents, and saving now could add it twice, so it waits for a later try.
    if (unread) { remaining.push(raw); errors.push(unread); continue; }
    let saved = null;
    let refused = 0;
    let why = "";
    const allTaken = `a preset named "${candidates[0]}" already exists, as do presets named "${candidates[1]}" through "${candidates[candidates.length - 1]}"`;
    for (const name of candidates) {
      if (held.has(name)) continue;

      try {
        await save(name, doc, false);
        saved = name;
        break;
      } catch (e) {
        const status = (e && e.status) || 0;
        // The name was taken since the list was read, perhaps by this preset
        // saved from another tab, which is the same merge. A file there that
        // cannot be read holds the entry back, as one found before the save does.
        if (status === 409 && read && e.data && e.data.filename) {
          try { if (await sameAs(doc, e.data.filename)) { mergedInto = e.data.existing || name; break; } } catch (err) { unread = err; break; }
        }
        why = status === 409 ? allTaken : e;
        // A name of symbols alone leaves nothing to name a file by and can still
        // land under a suffix. A second refusal means the suffix did not help,
        // and the rest would be refused the same way on every draw of the tab.
        if (status === 400 && ++refused < 2) continue;
        if (status !== 409) break;
      }
    }
    if (mergedInto) merged.push(mergedInto);
    else if (unread) { remaining.push(raw); errors.push(unread); }
    else if (saved) { moved.push(saved); notes.push(...r.notes); held.set(saved, { name: saved }); }
    // With no reason, every name it could take was listed already and none was tried.
    else { remaining.push(raw); errors.push(why || allTaken); }
  }
  if (persist && entries.length) persist(remaining);
  // `errors` holds the reason for each entry of `remaining`, in its order.
  return { moved, merged, skipped, remaining, errors, notes };
}

// Each side is compared as Export would write it, so a listed preset that is
// pinned or in an older format still matches its own exported file. The name is
// left out because a preset saved under a suffixed name holds that name in its
// file, and the save time because an older version stamped the browser copy and
// the server copy of one preset each with its own.
function _sameContents(a, b) {
  const body = (d) => {
    const r = readPreset(d, READ_OPTS);
    const rest = r.ok ? presetExport(d, r.preset) : { ...(d || {}) };
    delete rest.name;
    delete rest.created;
    return canonicalJson(rest);
  };
  return body(a) === body(b);
}

function _readBrowserPresets() {
  try { const v = JSON.parse(lsGet(B.BROWSER_PRESETS)); return Array.isArray(v) ? v : []; } catch { return []; }
}

function _writeBrowserPresets(list) {
  if (list.length) lsSet(B.BROWSER_PRESETS, JSON.stringify(list));
  else lsRemove(B.BROWSER_PRESETS);
}

function _savedValueText(id, v) {
  if (v !== null && v !== undefined) return _shown(id, v);
  const def = settingDefault(id);
  return def === undefined ? "default" : `${_shown(id, def)} (default)`;
}

function _saveEntries(save, block) {
  const b = save.blocks[block] || {};
  if (block === "layouts") {
    return Object.keys(b).map((k) => {
      const n = Array.isArray(b[k]) ? b[k].length : 0;
      return { id: k, label: profileLabel(k), says: `${n} ${n === 1 ? "section" : "sections"}`, changes: true };
    });
  }
  const names = entryNames(Object.keys(b));
  return Object.entries(b).map(([id, v]) => ({ id, label: names.get(id), says: _savedValueText(id, v), changes: true }));
}

function _wholeState(whole) {
  const st = stateFor(whole.read);
  st.library = libraryDiffers(whole.doc);
  st.choice.library = false;
  return st;
}

// With indexOnly the tab is drawn into a throwaway element to collect its
// labels for the settings search, so nothing is fetched.
export function renderPresets(ctx, refocus = null) {
  const { content, indexOnly } = ctx;
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });
  let pending = refocus;
  // Every tab draws into the same element, so once anything else has drawn,
  // this form is off the page and a late redraw would wipe the tab now shown.
  // An open rename field holds redraws back until the rename ends, which
  // redraws.
  // Work that ends after a later draw of this tab replaced this one redraws
  // that draw, and only while it is on the page.
  const rerender = (focus = _focusOf(wrap)) => {
    if (_renaming) return;
    if (wrap.isConnected) renderPresets(ctx, focus);
    else if (_redrawLive && _redrawLive !== rerender) _redrawLive(focus);
  };
  // The settings search draws the tab off the page to read its text.
  if (!indexOnly) _redrawLive = rerender;
  // Where the control that held the focus is gone, such as a deleted row's
  // Delete, the list takes it, so the next Tab stays in the panel.
  const settle = (root, focus, owns, fallback = root) => {
    const want = focus || pending;
    if (!want || !owns(want)) return;
    if (want === pending) pending = null;
    if (!_refocus(root, want)) fallback.focus({ preventScroll: true });
  };
  // A pin is the file's, so its list is drawn again from the listing in place,
  // where the scroll, the focus and the keyboard mark stay.
  const repin = async (send, route, listEl, draw, action) => {
    const focus = _focusOf(wrap);
    try { await send(); } catch (e) { showFailure(action, e); }
    try {
      const data = await api(route);
      if (listEl.isConnected) { _takeDigests(data); draw(data); }
    } catch { rerender(focus); }
  };
  const inPresets = (k) => k.startsWith("p:") || k.startsWith("current");
  const inBackups = (k) => k.startsWith("b:");
  // The button stays disabled while `work` runs, so a second press cannot
  // write a second backup. Disabling drops the focus to the page, so work that
  // draws nothing again hands it back. `work` answers whether to redraw.
  const busy = async (btn, work) => {
    const focus = _focusOf(wrap);
    btn.disabled = true;
    let redraw = false;
    const run = _applying.then(work);
    _applying = run.catch(() => {});
    try { redraw = await run; } finally { btn.disabled = false; }
    if (redraw) rerender(focus);
    else if (focus === btn.getAttribute("data-focus") && btn.isConnected && document.activeElement === document.body) btn.focus();
  };
  // The title keeps an element of its own inside the head row, so the settings
  // search that walks section titles still finds it.
  const head = h("div", { class: "sbg-ptree__head" });
  wrap.appendChild(head);
  sectionTitle(head, "Presets");
  const headSlot = h("span");
  head.appendChild(headSlot);
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Saves the settings, layouts, keybindings and which theme is in use." }));

  function capture() {
    return presetCapture({ profiles: getProfiles(), valueOf: (id) => storedSetting(id) ?? null, themeKey: S.THEME, theme: activeThemeId() });
  }

  async function _runLoad(read, doc, choice, skipped) {
    if (settingsUnread()) { showSettingsUnread(); return false; }
    try {
      await _readTruth();
      // An opened row worked its theme out when it opened, and a press since
      // may have made Custom.
      if (doc.theme === "custom") doc = { ...doc, theme: themeOf(read) };
      const custom = _customPart(read, doc, choice);
      const plan = presetPlan(custom ? { ...doc, theme: null } : doc, _current(), choice);
      const unticked = !custom && !planWritesAnything(plan) && planWritesAnything(presetPlan(doc, _current(), {}));
      const name = read.preset.name;
      const say = (shown) => showToast(loadMessage(name, shown, read.notes, skipped, unticked, read.preset.themeName));
      if (!custom && !planWritesAnything(plan)) { say(plan); return false; }
      let answer;
      try {
        answer = await _sendPlan(plan, custom, { cause: `preset-load-${name}`, title: `Before loading the preset "${name}"`, subject: name, undo_kind: "load" });
      } catch (e) {
        if (!unconfirmed(e)) throw e;
        await _rereadUnconfirmed();
        showFailure("tell if the preset loaded", e);
        return true;
      }
      say(custom && answer.theme ? { ...plan, theme: userThemeId(answer.theme.id) } : plan);
      return true;
    } catch (e) {
      showFailure("load the preset", e);
      return false;
    }
  }

  async function _loadWhole(sp) {
    try {
      const read = readPreset(await api("/sidebar_gallery/preset", { filename: sp.filename }), READ_OPTS);
      if (!read.ok) { showFailure("load the preset", read.error); return false; }
      await ensureThemesLoaded();
      const { doc, skipped } = _loadDocument(read);
      return await _runLoad(read, doc, {}, skipped);
    } catch (e) { showFailure("load the preset", e); return false; }
  }

  const nameInput = _control(h("input", { type: "text", class: "sbg-gs-input", placeholder: "Preset name", "aria-label": "Preset name" }), "current", "name");
  // The tab is drawn again after every Load, Rename and Delete, so a name typed
  // before one of them carries over to the box the redraw builds.
  nameInput.value = _typedName;
  nameInput.addEventListener("input", () => { _typedName = nameInput.value; });
  _liveNameInput = nameInput;
  const saveBtn = _control(h("button", { class: "sbg-btn sbg-btn--accent sbg-btn--sm sbg-ptree__save", text: "Save" }), "current", "save");
  // A name already in use answers 409, and the next press carries the
  // overwrite for that name alone, since the box stays editable while the
  // button is armed and a question asked about one preset must not be
  // answered about another.
  let _armedFor = null;
  const _disarm = () => {
    if (_armedFor === null) return;
    _armedFor = null;
    saveBtn.textContent = "Save";
  };
  nameInput.addEventListener("input", _disarm);

  nameInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    saveBtn.click();
  });
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast("Enter a preset name."); return; }
    // With the settings unread every value reads as unset, which a load of the
    // preset would turn into a reset of every setting to its default.
    if (settingsUnread()) { showSettingsUnread(); return; }
    const armed = _armedFor !== null && _armedFor === name;
    if (_armedFor !== null && !armed) _disarm();
    await ensureThemesLoaded();

    const from = _openRows.get("current") || { ...capture(), choice: null };
    const picks = {};
    for (const block of ["layouts", "settings", "keys"]) {
      const set = from.choice ? from.choice[block] : null;
      if (!from.blocks[block]) continue;
      picks[block] = set || new Set(Object.keys(from.blocks[block]));
      if (!picks[block].size) delete picks[block];
    }
    const blocks = pickPresetBlocks(from.blocks, picks);
    const theme = from.choice && from.choice.theme === false ? null : from.theme;
    if (!Object.keys(blocks).length && !theme) { showToast("Nothing is ticked, so there is nothing to save."); return; }
    const themeName = userThemeKey(theme) && themeExists(theme) ? themeDisplayName(theme) : undefined;
    try {
      await _savePreset(name, cleanPresetColors(wrapPreset({ name, created: Date.now(), savedBy: _serverVersion, blocks, theme, themeName })), armed);
    } catch (e) {
      if (e.status === 409) {
        _armedFor = name;
        saveBtn.textContent = "Overwrite?";
      } else showFailure("save the preset", e);
      return;
    }
    _disarm();
    _openRows.delete("current");
    nameInput.value = "";
    _typedName = "";
    if (_liveNameInput) _liveNameInput.value = "";
    rerender();
  });
  const moveSlot = h("div", { class: "sbg-ptree-note" });
  wrap.appendChild(moveSlot);
  const list = h("div", { class: "sbg-ptree", role: "list", "aria-label": "Presets", tabindex: "0" });
  if (!indexOnly) list.textContent = "Loading…";
  wrap.appendChild(list);
  _drawMoveNote(moveSlot, list);
  // With no filter box to hand the arrow keys to, as the folder dropdown has,
  // the list is reached by Tab and never takes the focus on its own. Escape
  // goes on to close the settings panel, as from any other tab.
  const listKeys = (el) => wireListboxKeys(el, {
    markClass: "sbg-ptree__item--kbd",
    getOptions: () => [...el.querySelectorAll(".sbg-ptree__item")],
    keyOf: (o) => o.getAttribute("data-key"),
    controlsOf: _rowControls,
    takeFocus: false,
    activeDescendant: false,
  });
  const _resyncKeys = indexOnly ? null : listKeys(list);

  let _renaming = false;
  let presetRows = [];
  function _renameRow(nameEl, sp) {
    if (_renaming) return;
    _renaming = true;
    const input = h("input", { type: "text", class: "sbg-gs-input", value: sp.name, "aria-label": `Rename the preset ${sp.name}` });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    // The redraw after it shuts every row, so Enter and Escape leave the focus
    // on the strip of the row the preset is in now, while a click away leaves
    // it where the click put it.
    const finish = async (commit, keepFocus) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      let filename = sp.filename;
      try { if (commit && next && next !== sp.name) filename = await _renamePreset(sp.filename, next); }
      catch (e) { showFailure("rename the preset", e); }
      finally { _renaming = false; rerender(keepFocus ? `p:${filename}#strip` : undefined); }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true, true); }
      else if (e.key === "Escape") { e.stopPropagation(); finish(false, true); }
    });
    input.addEventListener("blur", () => finish(true, false));
  }

  // Open rows by key, with what each works from. Redrawing the rows, as a tick
  // or a preset's pin does, keeps them open, while drawing the whole tab again
  // shuts them. The Current row's state is taken when it opens, so its
  // ticks are not overtaken by a setting changed on another tab.
  const _openRows = new Map();

  function _partRow(box, row, { part, title, count, entries }, last) {
    const { st, redraw } = row;
    const key = `${row.key}/${part}`;
    const open = !!(st.showParts && st.showParts.has(part));
    const toggle = () => {
      if (!st.showParts) st.showParts = new Set();
      if (open) st.showParts.delete(part); else st.showParts.add(part);
      redraw();
    };
    const { item, body } = _rowShell({
      key, open, label: title, onToggle: toggle, role: null,
      classes: ` sbg-ptree__item--part${count ? "" : " sbg-ptree__item--same"}`,
      guides: branchGuides(treeGlyphMid(0), treeGlyphLeft(1), last), depth: 1,
    });
    const cb = _control(h("input", { type: "checkbox", "aria-label": title }), key, "check");
    cb.checked = entries.every((e) => st.choice[part].has(e.id));
    cb.addEventListener("change", () => {
      for (const e of entries) {
        if (cb.checked) st.choice[part].add(e.id); else st.choice[part].delete(e.id);
      }
      redraw();
    });
    body.appendChild(cb);
    body.appendChild(h("span", { class: "sbg-ptree__name", text: title }));
    body.appendChild(h("span", { class: "sbg-dropdown__count", text: String(count) }));
    const shown = open ? entries.filter((e) => e.changes || st.showAll) : [];
    if (shown.length) item.appendChild(treeStem(1));
    box.appendChild(item);
    shown.forEach((e, i) => {
      const entryKey = `${key}/${e.id}`;
      const line = h("div", { class: `sbg-ptree__item sbg-ptree__item--entry${e.changes ? "" : " sbg-ptree__item--same"}`, "data-key": entryKey });

      if (!last) line.appendChild(passingGuide(treeGlyphMid(0)));
      for (const g of branchGuides(treeGlyphMid(1), treeNameX(2) - 6, i === shown.length - 1)) line.appendChild(g);
      const lcb = _control(h("input", { type: "checkbox", "aria-label": e.label }), entryKey, "check");
      lcb.checked = st.choice[part].has(e.id);
      lcb.addEventListener("change", () => {
        if (lcb.checked) st.choice[part].add(e.id); else st.choice[part].delete(e.id);
        redraw();
      });
      const entryBody = h("span", { class: "sbg-tree-body" }, [
        lcb,
        h("span", { class: "sbg-ptree__name", text: e.label }),
        h("span", { class: "sbg-ptree__when", text: e.says }),
      ]);
      entryBody.style.paddingLeft = treeNameX(2) + "px";
      line.appendChild(entryBody);
      _onRowClick(line, () => lcb.click());
      box.appendChild(line);
    });
  }

  function _currentRow(redraw) {
    const save = _openRows.get("current");
    const toggle = async () => {
      if (save) { _openRows.delete("current"); redraw(); return; }
      await ensureThemesLoaded();
      const { blocks, theme } = capture();
      _openRows.set("current", {
        blocks, theme, showParts: new Set(),
        choice: {
          layouts: new Set(Object.keys(blocks.layouts || {})),
          settings: new Set(Object.keys(blocks.settings || {})),
          keys: new Set(Object.keys(blocks.keys || {})),
          theme: true,
        },
      });
      redraw();
    };
    const { item, body } = _rowShell({ key: "current", open: !!save, label: "the current settings", onToggle: toggle });
    body.appendChild(h("span", { class: "sbg-ptree__name", text: "Current" }));
    const changed = settingsChangedAt();
    if (changed) body.appendChild(h("span", { class: "sbg-ptree__when", text: whenText(changed), title: "Last changed" }));
    if (!save) { body.appendChild(nameInput); body.appendChild(saveBtn); return item; }
    item.appendChild(treeStem(0));
    const box = h("div", { class: "sbg-ptree__box" }, [item]);
    const row = { st: save, key: "current", redraw };
    const parts = [["layouts", "Metadata Panel layouts"], ["settings", "Settings"], ["keys", "Keybindings"]]
      .map(([part, title]) => ({ part, title, entries: _saveEntries(save, part) }))
      .filter((p) => p.entries.length);
    parts.forEach((p, i) => _partRow(box, row, { ...p, count: save.choice[p.part].size }, i === parts.length - 1));
    if (save.theme) {
      box.appendChild(_offerTick(`Theme: ${themeDisplayName(save.theme)}`, save.choice.theme !== false, (on) => { save.choice.theme = on; }, "current", "theme"));
    }
    box.appendChild(h("div", { class: "sbg-ptree__foot" }, [nameInput, saveBtn]));
    return box;
  }

  function _eyeButton(row) {
    const { st } = row;
    const eye = _control(h("button", {
      type: "button",
      class: "sbg-ptree__eye",
      html: st.showAll ? EYE_ICON : EYE_OFF_ICON,
      title: st.showAll ? "Hide what already matches" : "Show what already matches",
      "aria-pressed": st.showAll ? "true" : "false",
    }), row.key, "eye");
    eye.addEventListener("click", () => { st.showAll = !st.showAll; row.redraw(); });
    return eye;
  }

  // Where the two kinds of row differ, a preset's old colours are offered as a
  // new theme and never written, while a copy's colours go back into the theme
  // they came from.
  function _fillBox(box, row, { isCopy, name }) {
    const { st, key } = row;
    const D = st.diff;
    const parts = [];
    const after = [];
    const L = D.layouts;
    if (L) {
      const entries = [...L.replaces, ...L.adds, ...L.removes, ...L.same].map((k) => ({
        id: k,
        label: profileLabel(k),
        says: L.replaces.includes(k) ? "changed" : L.adds.includes(k) ? "new" : L.removes.includes(k) ? "removed" : "same",
        changes: !L.same.includes(k),
      }));
      if (entries.length) parts.push({ part: "layouts", title: "Metadata Panel layouts", entries });
      if (L.keeps.length) {
        after.push(_offerTick(`Remove layouts not in this ${isCopy ? "backup" : "preset"}: ${L.keeps.map(profileLabel).join(", ")}`,
          !!st.choice.removeUncarried, (on) => { st.choice.removeUncarried = on; }, key, "remove"));
      }
    }

    if (isCopy && st.library) after.push(_offerTick(LIBRARY_LINE, !!st.choice.library, (on) => { st.choice.library = on; }, key, "library"));
    for (const [part, title] of [["settings", "Settings"], ["keys", "Keybindings"]]) {
      const d = D[part];
      if (!d || !d.total) continue;
      const names = entryNames(d.entries.map((e) => e.id));
      parts.push({ part, title, entries: d.entries.map((e) => ({ id: e.id, label: names.get(e.id), says: entryText(e.id, e.value, e.current, e.changes), changes: e.changes })) });
    }
    if (isCopy) {
      const entries = colourEntries(st);
      if (entries.length) parts.push({ part: "colors", title: "Colors", entries });
    }
    const order = _KIND_LABELS.map(([k]) => k);
    parts.sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part));
    let hidden = 0;
    for (const p of parts) {
      p.count = p.entries.filter((e) => e.changes).length;
      hidden += p.entries.length - p.count;
    }
    const themeChanges = !!(D.theme && D.theme.changes);
    const remade = !!D.theme && !D.theme.exists && D.theme.id === "custom" && _carriesCustom(st.read);
    const changing = parts.reduce((n, p) => n + p.count, 0) + (themeChanges || remade ? 1 : 0) + (isCopy && st.library ? 1 : 0);
    let drawn = 0;
    if (!changing && !st.showAll) {
      box.appendChild(_offerLine("No changes"));
    } else {
      const shown = st.showAll ? parts : parts.filter((p) => p.count);
      drawn = shown.length;
      shown.forEach((p, i) => _partRow(box, row, p, i === shown.length - 1));
    }
    for (const line of after) box.appendChild(line);

    if (D.theme && (themeChanges || !D.theme.exists)) {
      const themeName = remade ? "Custom" : themeDisplayName(D.theme.id, st.read.preset.themeName);
      // A copy's colours go into the theme a restore leaves in use, so this
      // tick redraws the row for the colour counts to follow.
      box.appendChild(!D.theme.exists && !remade ? _offerLine(`Theme: ${themeName} (missing)`)
        : _offerTick(`Theme: ${themeDisplayName(D.theme.current || activeThemeId())} → ${themeName}`, st.choice.theme !== false, (on) => { st.choice.theme = on; row.redraw(); }, key, "theme"));
    }
    // Offered only when the colours differ from what the theme in use paints,
    // since otherwise the new theme is a second copy of it. An unset badge
    // colour paints the stylesheet's own, which an older version wrote into a
    // preset saved with Colors ticked.
    const inUse = activeColours();
    const differ = !!st.old && Object.entries(st.old).some(([id, v]) => v !== (inUse[id] || sheetBadgeColor(id)));
    if (differ && !isCopy && !remade) {
      const line = _offerLine("This preset has its own colors", "Loading this preset won't apply these colors. Save them as a theme to use them.");
      const keep = _control(h("button", { class: "sbg-btn sbg-btn--sm", type: "button", text: "Save as a theme" }), key, "keep");
      keep.addEventListener("click", async () => {
        try {
          const from = st.read.preset.theme;
          const own = from === "custom" ? _customColours(st.read) : st.old;
          const answer = await postApply({ theme: { create: { name, values: themeValuesFromColours(own, from), origin: from === "custom" ? CUSTOM_ORIGIN : null } } });
          themeApplied(answer);
          const made = answer.theme.doc.name;
          // The server answers a theme already holding that name and those
          // colours instead of making another.
          showToast(answer.theme.existing ? `"${made}" is already in the theme list.` : `Theme "${made}" created from the preset's colors.`);
        } catch (e) { showFailure("save the theme", e); }
      });
      line.appendChild(h("span", { class: "sbg-ptree__spacer" }));
      line.appendChild(keep);
      box.appendChild(line);
    }
    for (const note of st.read.notes) box.appendChild(_offerLine(note[0].toUpperCase() + note.slice(1) + "."));

    return { acts: changing > 0 || !!(L && L.keeps.length), branched: drawn > 0, hidden };
  }

  function _openBox(item, body, whenEl, row, fill, buttons) {
    const box = h("div", { class: "sbg-ptree__box" }, [item]);
    const { acts, branched, hidden } = _fillBox(box, row, fill);
    if (hidden) body.insertBefore(_eyeButton(row), whenEl);
    if (branched) item.appendChild(treeStem(0));
    box.appendChild(h("div", { class: "sbg-ptree__foot" }, buttons(acts)));
    return box;
  }

  function _pinButton(key, pinned, label, onClick) {
    const pin = _control(h("button", {
      type: "button",
      class: `sbg-dropdown__pin${pinned ? " sbg-dropdown__pin--on" : ""}`,
      html: pinned ? PIN_FILLED_ICON : PIN_OUTLINE_ICON,
      title: pinned ? label.off : label.on,
      "aria-label": label.aria,
    }), key, "pin");
    pin.addEventListener("click", onClick);
    return pin;
  }

  // A server that has not restarted since the update lists each preset by name
  // alone, so its rows wait for the restart instead of reading as damaged.
  function _waitingRow(sp) {
    const { item, body } = _rowShell({ key: `p:${sp.filename}` });
    body.appendChild(h("span", { class: "sbg-ptree__name", text: sp.name || sp.filename }));
    return item;
  }

  function _unreadableRow(key, filename, remove) {
    const { item, body } = _rowShell({ key });
    body.appendChild(h("span", { class: "sbg-ptree__name", text: `${filename} (can't be read)` }));
    const del = _deleteButton(key);
    confirmClick(del, remove);
    body.appendChild(del);
    return item;
  }

  // A file that can't be read is named by its file, since nothing says it holds a preset.
  async function _deletePreset(sp, unreadable = false) {
    try {
      if (await _stillOlderServer()) throw new Error(RESTART_FIRST);
      const data = await apiPost("/sidebar_gallery/presets", { action: "delete", name: sp.name, filename: sp.filename });
      if (data.where) showToast(`${unreadable ? `"${sp.filename}"` : `Preset "${sp.name}"`} moved to ${data.where}.`);
    } catch (e) { showFailure("delete the preset", e); }
    rerender();
  }

  function _presetRow(sp, fromListing, rows) {
    const key = `p:${sp.filename}`;
    const st = _openRows.get(key);
    const redraw = () => _renderRows(rows);
    const toggle = async () => {
      if (st) { _openRows.delete(key); redraw(); return; }
      try {
        const read = readPreset(await api("/sidebar_gallery/preset", { filename: sp.filename }), READ_OPTS);
        if (!read.ok) { showFailure("open the preset", read.error); return; }
        // The opened row's lines promise what its Load does, which compares
        // against the files.
        await _readTruth({ forRow: true });
        _openRows.set(key, stateFor(read));
        redraw();
      } catch (e) { showFailure("open the preset", e); }
    };
    // Quoted, since a screen reader says the label as one phrase and a bare
    // name runs into the Open or Close before it.
    const { item, body } = _rowShell({ key, open: !!st, label: `"${sp.name}"`, onToggle: toggle });
    const nameEl = h("span", { class: "sbg-ptree__name", text: sp.name });
    body.appendChild(nameEl);

    if (!st) {
      const counts = changeCounts(stateFor(fromListing), false);
      if (_digestError) counts.layouts = fromListing.preset.layoutDigests ? NOT_COMPARED : 0;
      body.appendChild(h("span", { class: "sbg-ptree__pills" }, changePills(counts).map((text) => h("span", { class: "sbg-dropdown__count", text }))));
    }
    const whenEl = h("span", { class: "sbg-ptree__when", text: Number.isFinite(sp.created) ? whenText(sp.created) : "" });
    body.appendChild(whenEl);
    const on = !!sp.pinned;
    const pin = _pinButton(key, on, { on: "Pin to the top of this list", off: "Unpin", aria: (on ? "Unpin " : "Pin ") + sp.name }, () => repin(
      () => apiPost("/sidebar_gallery/presets", { action: "pin", filename: sp.filename, created: sp.created ?? null, pinned: !on }),
      "/sidebar_gallery/presets", list, (data) => { presetRows = data.presets || []; _renderRows(presetRows); }, on ? "unpin the preset" : "pin the preset"));

    const loadBtn = _control(h("button", { class: "sbg-btn sbg-btn--sm", text: "Load" }), key, "load");
    if (!st) {
      loadBtn.addEventListener("click", () => busy(loadBtn, () => _loadWhole(sp)));
      body.appendChild(loadBtn);
      body.appendChild(pin);
      return item;
    }
    body.appendChild(pin);
    loadBtn.addEventListener("click", () => busy(loadBtn, () => _runLoad(st.read, st.doc, st.choice, st.skipped)));
    const renBtn = _control(h("button", { class: "sbg-btn sbg-btn--sm", text: "Rename" }), key, "rename");
    renBtn.addEventListener("click", () => _renameRow(nameEl, sp));
    const expBtn = _control(h("button", { class: "sbg-btn sbg-btn--sm", text: "Export" }), key, "export");
    expBtn.addEventListener("click", async () => {
      try {
        const raw = await api("/sidebar_gallery/preset", { filename: sp.filename });
        const read = readPreset(raw, READ_OPTS);
        if (!read.ok) { showFailure("export the preset", read.error); return; }
        // The stored file's own name holds no character a browser would change
        // on the way to the disk. The browser shows the download, so nothing more is said.
        downloadJson(presetExport(raw, read.preset), sp.filename);
      } catch (e) { showFailure("export the preset", e); }
    });
    const delBtn = _deleteButton(key);
    confirmClick(delBtn, () => _deletePreset(sp));

    return _openBox(item, body, whenEl, { st, key, redraw }, { isCopy: false, name: sp.name },
      (acts) => [...(acts ? [loadBtn] : []), renBtn, expBtn, h("span", { class: "sbg-ptree__spacer" }), delBtn]);
  }

  function _renderRows(rows) {
    const focus = _focusOf(list);
    list.innerHTML = "";
    const redraw = () => _renderRows(rows);
    list.appendChild(_currentRow(redraw));
    const reads = new Map(rows.map((sp) => [sp.filename, sp.readable !== false && sp.doc ? readListing(sp.doc, READ_OPTS) : null]));

    if (!rows.length) list.appendChild(h("div", { class: "sbg-gs-desc", text: "No presets yet." }));
    else if (_olderServer) list.appendChild(h("div", { class: "sbg-gs-desc", text: "Presets open once ComfyUI restarts to finish the update." }));
    for (const sp of sortPresets(rows)) {
      const read = reads.get(sp.filename);
      list.appendChild(read && read.ok ? _presetRow(sp, read, rows)
        : _olderServer ? _waitingRow(sp)
          : _unreadableRow(`p:${sp.filename}`, sp.filename, () => _deletePreset(sp, true)));
    }
    if (_resyncKeys) _resyncKeys(true);
    settle(list, focus, inPresets);
  }

  // Both listings digest the layouts the file holds, so a layout edit still
  // waiting to be saved reaches the file first.
  const saved = indexOnly ? null : flushSettingsAsync().catch(() => {});

  // The listing carries the layout digests, so the rows are drawn once with
  // both in hand. A failure once the list is drawn belongs to the move of this
  // browser's presets and is said as that.
  let listed = false;
  if (saved) saved.then(() => api("/sidebar_gallery/presets")).then(async (data) => {
    if (!list.isConnected) return;
    _takeDigests(data);
    if (typeof data.version === "string" && data.version) _serverVersion = data.version;
    if (Number.isInteger(data.name_max)) _nameMax = data.name_max;
    _olderServer = !("version" in data);
    const rows = data.presets || [];
    presetRows = rows;
    _renderRows(rows);
    listed = true;

    if (!_readBrowserPresets().length) return;
    if (_olderServer) {
      if (!_waitNoted) { _moveNote = "Presets kept by this browser move over once ComfyUI restarts."; _drawMoveNote(moveSlot, list); }
      _waitNoted = true;
      return;
    }
    // Two draws close together share one move, since a second one started from
    // a listing read before the first saved would save the same presets again
    // under a suffix.
    const result = await singleFlight("browser-presets", () => migrateBrowserPresets({
      list: _readBrowserPresets(),
      rows,
      save: _savePreset,
      read: (filename) => api("/sidebar_gallery/preset", { filename }),
      persist: _writeBrowserPresets,
      nameMax: _nameMax,
    }));
    const parts = [];
    if (result.moved.length) parts.push(`${result.moved.length} ${result.moved.length === 1 ? "preset" : "presets"} saved in this browser ${result.moved.length === 1 ? "was" : "were"} added to the preset list (${result.moved.join(", ")})`);
    if (result.merged.length) parts.push(`${result.merged.length} kept by this browser matched ${result.merged.length === 1 ? "a preset" : "presets"} already in the list (${result.merged.join(", ")})`);
    if (result.skipped.length) parts.push(`${result.skipped.length} couldn't be read (${result.skipped.map((s) => s.name).join(", ")})`);
    // The move runs again on every draw of the tab, which follows each Load and
    // Save, so the retry is said once.
    if (result.remaining.length && !_retryNoted) parts.push(`${result.remaining.length} couldn't be saved. Retrying the next time the Presets tab opens`);
    if (result.remaining.length) _retryNoted = true;
    if (parts.length) { _moveNote = parts.join(". ") + "."; _drawMoveNote(moveSlot, list); }
    if (result.moved.length) rerender();
  }).catch((e) => {
    if (!list.isConnected) return;
    if (listed) { _moveNote = `${failureText("move browser presets to files", e)}. Retrying the next time the Presets tab opens.`; _drawMoveNote(moveSlot, list); return; }
    _failIn(list, failureText("load the presets", e));
    settle(list, null, inPresets);
  });

  sectionTitle(wrap, "Backups");

  const backupsDesc = h("div", { class: "sbg-gs-desc" });
  const describeBackups = (n) => {
    backupsDesc.textContent = Number.isFinite(n)
      ? `Saved before a load, a restore or a version change. The newest ${n} are kept, plus any pinned.`
      : "Saved before a load, a restore or a version change. Pinned ones are kept.";
  };
  if (indexOnly) describeBackups();
  wrap.appendChild(backupsDesc);
  const undoSlot = h("div");
  wrap.appendChild(undoSlot);
  const backupList = h("div", { class: "sbg-ptree", role: "list", "aria-label": "Backups", tabindex: "0" });
  if (!indexOnly) backupList.textContent = "Loading…";
  wrap.appendChild(backupList);
  const _resyncBackupKeys = indexOnly ? null : listKeys(backupList);

  async function _runRestore(bk, choice, words) {
    if (settingsUnread()) { showSettingsUnread(); return false; }
    try {
      const { keys, caveat, note, unconfirmed: lost, goneTheme, changed } = await _restoreBackup(bk, choice);
      if (lost) showFailure(`tell if ${words.what === "restore" ? "the backup was restored" : `the ${words.what} happened`}`, lost);
      // The words are a failure's while nothing broke, so it keeps the accent colour.
      else if (goneTheme) showToast(failureText(words.failed, `the theme ${goneTheme === MISSING_THEME_NAME ? "" : `${goneTheme} `}couldn't be found`));
      // What the colours met follows the action's own sentence, and stands
      // alone when nothing else went back.
      else showToast([keys.length || note || changed ? words.done(keys) : caveat ? null : words.none, caveat, note].filter(Boolean).join(" "));
    } catch (e) { showFailure(words.failed, e); }
    return true;
  }

  async function _deleteBackup(bk) {
    try {
      const data = await postBackups({ action: "delete", filename: bk.filename });
      if (data.where) showToast(`Backup moved to ${data.where}.`);
    } catch (e) { showFailure("delete the backup", e); }
    rerender();
  }

  // Every copy is listed with digests in place of its layouts, a whole one
  // included, so a closed row reads what the listing sent, and the bodies are
  // read only when a row opens or a copy is put back.
  function _backupRow(bk, rows) {
    const key = `b:${bk.filename}`;
    const read = !bk.readable ? null : readCopy(bk.whole ? asWholeCopy(bk.doc) : bk.doc, COPY_OPTS);

    if (!bk.readable || !read.ok) return _unreadableRow(key, bk.filename, () => _deleteBackup(bk));
    const st = _openRows.get(key);
    const redraw = () => _renderBackups(rows);
    const label = backupTitle(bk);
    const toggle = async () => {
      if (st) { _openRows.delete(key); redraw(); return; }
      try {
        // The opened row's lines promise what its Restore does, which compares
        // against the files.
        await _readTruth({ forRow: true });
        if (!bk.whole) {
          _openRows.set(key, stateFor(await _readPartCopy(bk)));
        } else {
          _openRows.set(key, _wholeState(await _readWholeCopy(bk)));
        }
      } catch (e) { showFailure("read the backup", e); return; }
      redraw();
    };
    const { item, body } = _rowShell({ key, open: !!st, label: `"${label}"`, onToggle: toggle });

    body.appendChild(h("span", { class: "sbg-ptree__name", text: label }));
    if (!st) {
      const counts = changeCounts(stateFor(read), true);
      // A layout listed by its digest cannot be compared while the install's own digests are unread.
      if (_digestError && read.preset.layoutDigests) counts.layouts = NOT_COMPARED;
      const pills = changePills(counts);
      body.appendChild(h("span", { class: "sbg-ptree__pills" }, pills.map((text) => h("span", { class: "sbg-dropdown__count", text }))));
    }
    const whenEl = h("span", { class: "sbg-ptree__when", text: whenText(bk.created) });
    body.appendChild(whenEl);
    // Restore acts on the first press, since a copy of what it changes is taken
    // first and the Undo line offers it back.
    const restoreBtn = _control(h("button", { class: "sbg-btn sbg-btn--sm", text: "Restore" }), key, "restore");
    // A closed whole copy's Restore does what the opened row does with nothing
    // unticked, which leaves the library alone.
    const choice = st ? st.choice : bk.whole ? { library: false } : undefined;
    restoreBtn.addEventListener("click", () => busy(restoreBtn, () => _runRestore(bk, choice, {
      done: () => sentences(["backup restored"]),
      none: "This backup already matches the current settings, so nothing changed.",
      failed: "restore the backup",
      what: "restore",
    })));
    if (!st) body.appendChild(restoreBtn);
    const pinned = !!bk.pinned;

    body.appendChild(_pinButton(key, pinned, { on: "Pin to always keep this backup", off: "Unpin", aria: (pinned ? "Unpin " : "Pin ") + label }, () => repin(
      () => postBackups({ action: "pin", filename: bk.filename, pinned: !pinned }),
      "/sidebar_gallery/settings_backups", backupList, (data) => _renderBackups(data.backups || []), pinned ? "unpin the backup" : "pin the backup")));
    if (!st) return item;
    const delBtn = _deleteButton(key);
    confirmClick(delBtn, () => _deleteBackup(bk));
    return _openBox(item, body, whenEl, { st, key, redraw }, { isCopy: true },
      (acts) => [...(acts ? [restoreBtn] : []), h("span", { class: "sbg-ptree__spacer" }), delBtn]);
  }

  function _renderBackups(rows) {
    const focus = _focusOf(backupList);
    backupList.innerHTML = "";
    if (!rows.length) backupList.appendChild(h("div", { class: "sbg-gs-desc", text: "No backups yet." }));
    for (const bk of rows) backupList.appendChild(_backupRow(bk, rows));
    if (_resyncBackupKeys) _resyncBackupKeys(true);
    settle(backupList, focus, inBackups);
  }

  // A closed part copy compares its layouts by digest, which the listing
  // carries as the Presets listing does.
  if (saved) saved.then(() => api("/sidebar_gallery/settings_backups")).then((data) => {
    if (!backupList.isConnected) return;
    _takeDigests(data);
    const rows = data.backups || [];
    describeBackups(data.ring_size);
    const undoable = undoableCopy(rows);
    undoSlot.innerHTML = "";
    if (undoable) {
      const offer = undoOffer(undoable);
      const undoBtn = _control(h("button", { class: "sbg-btn sbg-btn--sm", text: offer.button }), "undo", "button");
      undoBtn.addEventListener("click", () => busy(undoBtn, () => _runRestore(undoable, undefined, {
        done: () => offer.done,
        none: offer.none,
        failed: offer.button.toLowerCase(),
        what: offer.button.toLowerCase(),
      })));
      undoSlot.appendChild(h("div", { class: "sbg-ptree__undo" }, [
        h("span", { class: "sbg-ptree__offertext", text: undoSentence(undoable) }),
        h("span", { class: "sbg-ptree__spacer" }),
        undoBtn,
      ]));
    }
    settle(undoSlot, null, (k) => k.startsWith("undo"), backupList);
    _renderBackups(rows);
  }).catch((e) => {
    describeBackups();
    // A server that has not restarted since the update has no such route.
    _failIn(backupList, failureText("load the backups", e && e.status === 404 ? RESTART_FIRST : e));
    settle(backupList, null, (k) => inBackups(k) || k.startsWith("undo"));
  });

  const importBtn = _control(h("button", { class: "sbg-btn sbg-btn--sm", text: "Import", title: "Import a preset file" }), "head", "import");
  importBtn.addEventListener("click", () => {
    const fi = h("input", { type: "file", accept: ".json" });
    fi.addEventListener("change", async () => {
      if (!fi.files.length) return;
      try {
        // A file that is not JSON is left for the reader to refuse, which says
        // in its own words that it is no preset.
        let raw = null;
        try { raw = JSON.parse(await fi.files[0].text()); } catch { }
        // Read is given so a file the list already holds is found, as a browser
        // preset is. A listed preset that can't be read counts as different, so
        // the file is saved beside it instead of failing for a file it isn't.
        const result = await migrateBrowserPresets({
          list: [raw], rows: presetRows, save: _savePreset, from: "", nameMax: _nameMax,
          read: (filename) => api("/sidebar_gallery/preset", { filename }).catch(() => null),
        });
        if (result.skipped.length) { showFailure("import the file", result.skipped[0].error); return; }
        if (result.merged.length) { showToast(`"${result.merged[0]}" is already in the preset list.`); return; }
        if (!result.moved.length) { showFailure("import the file", result.errors[0]); return; }
        // The new row shows in the list, so only the reader's notes on the file are said.
        if (result.notes.length) showToast(sentences([`preset "${result.moved[0]}" imported`, ...result.notes]));
        rerender();
      } catch (e) { showFailure("import the file", e); }
    });
    fi.click();
  });
  headSlot.appendChild(importBtn);
  settle(head, null, (k) => k.startsWith("head"));

  content.appendChild(wrap);
}
