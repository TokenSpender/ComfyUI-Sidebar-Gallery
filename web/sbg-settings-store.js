import { postNotice, dismissNotice, postSaveFailure, failureText } from "./sbg-toast.js";
import { errorFrom, lsGet, lsRemove } from "./sbg-core.js";
import { SETTINGS, S, KINDS, declaration, settingValue } from "./sbg-settings-catalog.js";

export { S };

// Keys kept in this browser's own storage, which never reach the settings file.
export const B = Object.freeze({
  SAVED_COLORS: "SBG.SavedColors",
  CACHE_EPOCH: "SBG._cacheEpoch",
  META_EPOCH: "SBG._metaEpoch",
  SEARCH_SCHEMA: "SBG._searchSchema",
  PANEL_COLLAPSED: "SBG.PanelCollapsed",
  META_PANEL_WIDTH: "SBG.MetaPanelWidth",
  SETTINGS_RAIL_WIDTH: "SBG.SettingsRailWidth",
  SETTINGS_LAST_TAB: "SBG.SettingsLastTab",
  LEGACY_HIGHLIGHT_BG: "SBG.GS.HighlightBg",
  LAYOUT_HYGIENE_MARK: "SBG._layoutHygiene",
  PROMPT_TAB_PREFIX: "SBG.GS.PromptTab.",
  PROMPT_HEIGHT_PREFIX: "SBG.GS.PromptHeight.",

  BROWSER_PRESETS: "SBG.Presets",
});

// Keys older versions left in this browser, listed so they can be cleaned out.
export const B_RETIRED = Object.freeze([
  "SBG._dbVersion", "SBG.Layout", "SBG.LayoutRenames", "SBG.MetaSectionOrder", "SBG.GS.HiddenSections",
]);

// Keys older versions wrote to the settings file, which a preset saved then may
// still hold.
export const S_RETIRED = Object.freeze([
  "SBG.PromptPadding",
  "SBG.PromptView",
]);

export function orderedIds(id, defaults) {
  const saved = storedSetting(id);
  const known = new Set(defaults);
  const out = [];
  if (Array.isArray(saved)) {
    for (const x of saved) if (known.has(x) && !out.includes(x)) out.push(x);
  }
  for (const x of defaults) if (!out.includes(x)) out.push(x);
  return out;
}

// The order a reorder saves. An entry of the saved order that the list does not
// show, such as one a later version added or a theme without a row, stays as
// stored after the entry it followed, so it is in place again once it shows.
// One that followed an entry since removed here follows the nearest earlier
// entry still on screen.
export function keepUnshown(saved, next, shown) {
  if (!Array.isArray(saved)) return next;
  const onScreen = new Set(next);
  const after = new Map();
  let anchor = null;
  for (const x of saved) {
    if (shown(x)) {
      if (onScreen.has(x)) anchor = x;
      continue;
    }
    if (!after.has(anchor)) after.set(anchor, []);
    after.get(anchor).push(x);
  }
  if (!after.size) return next;
  const out = [...(after.get(null) || [])];
  for (const x of next) {
    out.push(x);
    if (after.has(x)) { out.push(...after.get(x)); after.delete(x); }
  }
  return out;
}

export function idsOfClass(cls) {
  return Object.values(SETTINGS).filter((d) => d.kind === cls).map((d) => d.id);
}

export function idsOfBlock(block) {
  return Object.values(SETTINGS).filter((d) => KINDS[d.kind].block === block).map((d) => d.id);
}

export function settingClass(id) {
  return declaration(id)?.kind ?? null;
}

// A profile stored under the prefix has no declaration of its own.
export function carried(key) {
  if (typeof key !== "string") return false;

  if (key.startsWith(S.LAYOUT_PROFILE_PREFIX)) return true;
  return !!KINDS[settingClass(key)]?.carried;
}

function _stampChanged() {
  _settings[S.SETTINGS_CHANGED] = Date.now();
  _pendingChanges[S.SETTINGS_CHANGED] = _settings[S.SETTINGS_CHANGED];
}

function _scheduleSave() {
  clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushSettings, _SAVE_DEBOUNCE_MS);
}

export function settingsChangedAt() {
  const at = _settings[S.SETTINGS_CHANGED];
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

let _settings = {};
let _settingsLoaded = false;
let _settingsLoading = null;

// A failed read leaves every setting looking unset, so a writer that builds on
// the stored value checks this and refuses instead of writing over the file.
let _settingsUnread = false;

export function settingsUnread() {
  return _settingsUnread;
}

let _saveDebounceTimer = null;
const _SAVE_DEBOUNCE_MS = 500;

// The fetch spec refuses a keepalive request once the keepalive bodies in flight
// pass 64 KiB, so a payload near that goes without keepalive.
const _KEEPALIVE_MAX_BYTES = 60000;

let _pendingChanges = {};

// Additions and removals queued for list settings, which the server merges into
// the stored list. A key is on this queue or on _pendingChanges and never on both.
let _pendingDeltas = {};

// A whole value decides what a list holds, so a delta still queued for the key
// is dropped instead of re-applying on top of it.
function _queueWhole(key, value) {
  delete _pendingDeltas[key];
  _pendingChanges[key] = value;
}

function _applyListDelta(stored, add, remove) {
  const current = Array.isArray(stored) ? stored.filter(v => typeof v === "string") : [];
  const dropped = new Set(remove);
  const merged = current.filter(v => !dropped.has(v));
  const present = new Set(merged);
  for (const v of add) {
    if (!present.has(v)) { present.add(v); merged.push(v); }
  }
  return merged;
}

// The server sends these headers once, on the first read after it set the file
// aside or copied it, so every read has to pass them on.
function _announceSettingsFiles(resp) {
  const aside = resp.headers.get("X-SBG-Settings-Quarantined");
  if (aside) postNotice("settings-set-aside", `Couldn't read the settings, so defaults will be used. The settings file was kept as ${aside}.`, { sticky: true, failure: true });
  const copied = resp.headers.get("X-SBG-Settings-Copied");
  if (copied) postNotice("settings-copied", `The gallery settings file wasn't saved as UTF-8, so some characters may have been read wrong. The original is kept as ${copied}.`, { sticky: true });
}

export async function loadSettings() {
  if (_settingsLoaded) return _settings;
  if (_settingsLoading) return _settingsLoading;

  _settingsLoading = (async () => {
    try {
      _settings = await readSettingsFromDisk();
      _fileHeld = _copy(_settings);
    } catch (e) {
      console.warn("[SBG] Failed to load settings from server:", e);
      _settingsUnread = true;
      // It stays until closed, since every change is refused until a reload.
      postNotice("settings-unread", `${failureText("load the gallery settings", e)}. Defaults are in use, and changes won't be saved until the page is refreshed.`, { sticky: true, failure: true });
    }
    _settingsLoaded = true;
    window.addEventListener("pagehide", _sendOnLeave);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") _sendOnLeave();
      else _resumeSaving();
    });
    return _settings;
  })();

  return _settingsLoading;
}

// Reads the file without touching the in-memory settings or the pending saves.
export async function readSettingsFromDisk() {
  const resp = await fetch("/sidebar_gallery/settings");
  if (!resp.ok) throw new Error(await errorFrom(resp));
  _announceSettingsFiles(resp);
  const data = await resp.json();
  if (!data || typeof data !== "object") throw new Error("the settings file couldn't be read");
  return data;
}

export async function reloadSettingsFromDisk() {
  const data = await readSettingsFromDisk();
  const before = _settings;
  _settings = data;
  _fileHeld = _copy(data);
  _settingsLoaded = true;
  _settingsUnread = false;

  dismissNotice("settings-unread");

  // A queued change is newer than the file, so it goes back on top.
  for (const [k, v] of Object.entries(_pendingChanges)) _settings[k] = v;
  for (const [k, d] of Object.entries(_pendingDeltas)) {
    _settings[k] = _applyListDelta(_settings[k], [...d.add], [...d.remove]);
  }
  _tell(before, new Set([...Object.keys(before), ...Object.keys(_settings)]));
  return _settings;
}

function _sendOnLeave() {
  clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = null;
  const pending = { ..._pendingChanges };
  const deltas = _pendingDeltas;
  const keys = Object.keys(pending);
  const deltaKeys = Object.keys(deltas);
  if (!keys.length && !deltaKeys.length) return;
  _pendingChanges = {};
  _pendingDeltas = {};

  // A beacon gets no answer, so each change is kept for the tab's return to
  // check against the file.
  for (const key of keys) if (!_refusedKeys.has(key)) _leave(key, { value: pending[key] });
  for (const key of deltaKeys) if (!_refusedKeys.has(key)) _leave(key, { add: new Set(deltas[key].add), remove: new Set(deltas[key].remove) });

  // One post per key, since posting the whole object would replace the file and
  // drop what another tab wrote since this one loaded.
  const bodies = keys.map((key) => JSON.stringify({ key, value: pending[key] }));

  // A closing page cannot retry a refusal, so each delta carries the whole list
  // too, which a server too old to merge stores instead of refusing.
  for (const key of deltaKeys) {
    bodies.push(JSON.stringify({
      key,
      value: _settings[key],
      add: [...deltas[key].add],
      remove: [...deltas[key].remove],
    }));
  }
  for (const payload of bodies) {
    const blob = new Blob([payload], { type: "application/json" });
    let sent = false;
    try {
      sent = navigator.sendBeacon("/sidebar_gallery/settings", blob);
    } catch { }
    // The page is closing, so a refusal has nowhere to be told.
    if (!sent) {
      fetch("/sidebar_gallery/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: blob.size < _KEEPALIVE_MAX_BYTES })
        .catch(() => { });
    }
  }
}

// The newer version that last used the settings file, set by the server. The
// key stays until the notice has been on screen, so a start where the gallery
// is never opened leaves it for the next.
export function downgradedFrom() {
  const v = storedSetting(S.DOWNGRADED_FROM);
  return typeof v === "string" && v ? v : null;
}

export function clearDowngradeNotice() {
  deleteSetting(S.DOWNGRADED_FROM);
}

// For a caller about to read the settings file back. A drain already running
// sends whatever is queued before it ends, so awaiting it covers this caller's
// writes too.
export function flushSettingsAsync() {
  clearTimeout(_saveDebounceTimer);
  return _flushSettings();
}

// A failed save goes back on the queue, so after a flush anything still queued
// is a change the file does not hold.
export function settingsWaiting() {
  return Object.keys(_pendingChanges).length > 0 || Object.keys(_pendingDeltas).length > 0;
}

// What this tab knows the settings file holds, from the last read and the saves
// landed since. Null until a read succeeds.
let _fileHeld = null;
// The changes the send on leaving carried, each with what the file held before
// it, since that send never learns whether it landed.
let _leftWith = {};
const _UNKNOWN = Symbol("unknown");
const _copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const _stable = (v) => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((n) => [n, x[n]])) : x));
const _same = (a, b) => _stable(a) === _stable(b);

function _leave(key, change) {
  const prior = _leftWith[key];
  const base = prior ? prior.base : (_fileHeld ? _copy(_fileHeld[key]) : _UNKNOWN);
  if (prior && prior.add && change.add) {
    for (const v of change.add) { prior.remove.delete(v); prior.add.add(v); }
    for (const v of change.remove) { prior.add.delete(v); prior.remove.add(v); }
    return;
  }
  // A whole value mixed with a list change for one key is kept as the list this
  // tab holds.
  _leftWith[key] = prior && (prior.add || change.add) ? { value: _copy(_settings[key]), base } : { ...change, base };
}

function _heldLanded(key, value) {
  if (_fileHeld) { if (value == null) delete _fileHeld[key]; else _fileHeld[key] = _copy(value); }
  if (_leftWith[key]) _leftWith[key].base = _copy(value);
  if (_landedWhileChecking) _landedWhileChecking.set(key, _copy(value));
}

// Saves that land while the tab-return read is out, laid over its answer since
// the read may predate them.
let _landedWhileChecking = null;

// When the tab shows again the file is read once. A change the file holds
// landed. A change whose setting still holds what it held before was lost, and
// goes again if this tab still holds it. A setting holding anything else was
// changed by another tab since, and that is kept.
let _checkingLeft = false;
async function _checkLeft() {
  _checkingLeft = true;
  const left = _leftWith;
  _leftWith = {};
  const landed = _landedWhileChecking = new Map();
  let file = null;
  try { file = await readSettingsFromDisk(); } catch { }
  _landedWhileChecking = null;
  if (file) {
    for (const [key, value] of landed) { if (value == null) delete file[key]; else file[key] = value; }
    _fileHeld = _copy(file);
  }
  for (const [key, c] of Object.entries(left)) {
    // Left again while the read was out. When this change is in the file, the
    // file is what the newer one started from. Otherwise it goes under the
    // newer one, both judged against what the file held before either.
    const newer = _leftWith[key];
    if (newer) {
      if (file && _heldBy(c, file[key])) { newer.base = _copy(file[key]); continue; }
      const older = !c.add && newer.add && c.base !== _UNKNOWN ? _asDelta(c.value, c.base) : c;
      if (older.add && newer.add) {
        for (const v of older.add) if (!newer.remove.has(v)) newer.add.add(v);
        for (const v of older.remove) if (!newer.add.has(v)) newer.remove.add(v);
      } else if (older.add || newer.add) {
        _leftWith[key] = { value: _copy(_settings[key]) };
      }
      _leftWith[key].base = c.base;
      continue;
    }

    if (!c.add && !_same(_settings[key], c.value)) continue;
    const kept = c.add ? _stillHeld(key, c) : c;
    // A failed read leaves nothing to judge by, so every change still held goes again.
    if (!file) { _requeue(key, kept); continue; }
    const now = file[key];
    if (c.add) {
      const has = new Set(Array.isArray(now) ? now : []);
      const had = c.base === _UNKNOWN ? null : new Set(Array.isArray(c.base) ? c.base : []);
      const add = [...kept.add].filter((v) => !has.has(v) && (!had || !had.has(v)));
      const remove = [...kept.remove].filter((v) => has.has(v) && (!had || had.has(v)));
      if (add.length || remove.length) { _requeue(key, { add: new Set(add), remove: new Set(remove) }); continue; }
    } else if (!_same(now, c.value) && (c.base === _UNKNOWN || _same(now, c.base))) {
      _requeue(key, c);
      continue;
    }
    _saveLanded(key);
  }
  _checkingLeft = false;
}

function _heldBy(change, now) {
  if (!change.add) return _same(now, change.value);
  const has = new Set(Array.isArray(now) ? now : []);
  return [...change.add].every((v) => has.has(v)) && ![...change.remove].some((v) => has.has(v));
}

// A whole list as the change it made to what the file held, so each item is
// judged on its own once a list change joins it.
function _asDelta(list, base) {
  const now = new Set(Array.isArray(list) ? list : []);
  const had = new Set(Array.isArray(base) ? base : []);
  return { add: new Set([...now].filter((v) => !had.has(v))), remove: new Set([...had].filter((v) => !now.has(v))) };
}

function _stillHeld(key, change) {
  const held = new Set(Array.isArray(_settings[key]) ? _settings[key] : []);
  return {
    add: new Set([...change.add].filter((v) => held.has(v))),
    remove: new Set([...change.remove].filter((v) => !held.has(v))),
  };
}

// A change queued since the tab came back is newer and stays on top, so a whole
// value under a newer list change goes as the list this tab holds.
function _requeue(key, c) {
  if (key in _pendingChanges) return;
  if (!c.add) { _queueWhole(key, _pendingDeltas[key] ? _copy(_settings[key]) : c.value); return; }
  const newer = _pendingDeltas[key];
  if (!newer) { _pendingDeltas[key] = { add: c.add, remove: c.remove }; return; }
  for (const v of c.add) if (!newer.remove.has(v)) newer.add.add(v);
  for (const v of c.remove) if (!newer.add.has(v)) newer.remove.add(v);
}

// A tab left and shown again while a check's read is out has its return
// checked once that check ends.
async function _resumeSaving() {
  if (!_checkingLeft) {
    while (Object.keys(_leftWith).length && document.visibilityState !== "hidden") await _checkLeft();
  }
  if (_saveDebounceTimer || (!Object.keys(_pendingChanges).length && !Object.keys(_pendingDeltas).length)) return;
  _saveDebounceTimer = setTimeout(_flushSettings, _SAVE_DEBOUNCE_MS);
}

// An older version kept the search highlight colour in this browser, where
// this one keeps it in the theme file. The browser's copy is dropped once a
// theme has taken it, so it is handed over once.
export function legacyHighlight() {
  return lsGet(B.LEGACY_HIGHLIGHT_BG) || "";
}

export function dropLegacyHighlight() {
  lsRemove(B.LEGACY_HIGHLIGHT_BG);
}

const _changeSubs = new Set();

// `fn(ids)` runs once for each write, answer or reread that changed a setting,
// with the ids that changed, so the part a setting belongs to applies it
// whichever way it changed. A subscriber reads and never writes.
export function onSettingsChanged(fn) {
  _changeSubs.add(fn);
  return () => { _changeSubs.delete(fn); };
}

function _tell(before, keys) {
  const ids = new Set([...keys].filter((k) => before[k] !== _settings[k] && JSON.stringify(before[k]) !== JSON.stringify(_settings[k])));
  if (!ids.size) return;
  for (const fn of [..._changeSubs]) {
    try { fn(ids); } catch (e) { console.warn("[SBG] Applying a settings change failed:", e); }
  }
}

export function saveSetting(key, value) {
  const was = _settings[key];
  _edited(key);
  _settings[key] = value;
  _queueWhole(key, value);
  if (carried(key)) _stampChanged();
  _scheduleSave();
  _tell({ [key]: was }, [key]);
}

export function deleteSetting(key) {
  const was = _settings[key];
  _edited(key);
  delete _settings[key];
  // The server deletes a key posted with null.
  _queueWhole(key, null);
  if (carried(key)) _stampChanged();
  _scheduleSave();
  _tell({ [key]: was }, [key]);
}

// Sends only the change, so a second tab's additions survive this one's. The
// local list is a fresh array, since readers notice a change by identity.
export function saveSettingDelta(key, delta) {
  const was = _settings[key];
  _edited(key);
  const add = delta.add || [];
  const remove = delta.remove || [];
  _settings[key] = _applyListDelta(_settings[key], add, remove);

  if (key in _pendingChanges) {
    // A whole value is already queued, so the delta folds into it and the key
    // stays on one queue.
    _pendingChanges[key] = _settings[key];
  } else {
    const queued = _pendingDeltas[key] || { add: new Set(), remove: new Set() };
    for (const v of add) { queued.remove.delete(v); queued.add.add(v); }
    for (const v of remove) { queued.add.delete(v); queued.remove.add(v); }
    _pendingDeltas[key] = queued;
  }
  if (carried(key)) _stampChanged();
  _scheduleSave();
  _tell({ [key]: was }, [key]);
}

// One notice stands for every setting whose last save failed, and it goes only
// once each has saved. _toastedKeys keeps a change's failure to one toast across
// its retries, and a new edit clears it.
const _unsavedKeys = new Set();
const _toastedKeys = new Set();
// Of the failed settings, those the server refused. Sending one again cannot
// change the answer, so it waits for the next edit and the tab-return check
// leaves it out.
const _refusedKeys = new Set();
function _saveFailed(key, err) {
  console.warn("[SBG] Failed to save setting", key, err.error);
  const text = `${failureText("save the gallery settings", err.error)}. Recent changes may be lost when the page is refreshed.`;
  postSaveFailure("settings-save-failed", text, !_toastedKeys.has(key));
  _toastedKeys.add(key);
  _unsavedKeys.add(key);
  if (err.status === 0 || err.status >= 500) _refusedKeys.delete(key); else _refusedKeys.add(key);
}

function _edited(key) {
  _toastedKeys.delete(key);
  _refusedKeys.delete(key);
}

function _saveLanded(key) {
  _refusedKeys.delete(key);
  if (!_unsavedKeys.delete(key)) return;
  if (!_unsavedKeys.size) dismissNotice("settings-save-failed");
}

// A status of 0 marks a request that never got an answer.
async function _post(payload) {
  const body = JSON.stringify(payload);
  try {
    const resp = await fetch("/sidebar_gallery/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: new Blob([body]).size < _KEEPALIVE_MAX_BYTES,
    });
    if (!resp.ok) return { error: await errorFrom(resp), status: resp.status };
    // A save that landed stays landed when its answer can't be read.
    let answer = null;
    try { answer = await resp.json(); } catch { }
    return { answer };
  } catch (e) {
    return { error: e, status: 0 };
  }
}

// Keys a drain has taken off the queue and not yet settled. A failed one is
// back on the queue once the run ends, so the set is emptied with it.
const _sending = new Set();

// Takes the file's value for keys this tab holds nothing newer for, after a
// read has shown memory to be behind the file. Nothing is sent or dated.
export function adoptFromDisk(data, keys) {
  const before = Object.fromEntries(keys.map((k) => [k, _settings[k]]));
  for (const key of keys) {
    if (key in _pendingChanges || key in _pendingDeltas || _sending.has(key) || key in _leftWith) continue;
    if (data && key in data) {
      _settings[key] = _copy(data[key]);
      if (_fileHeld) _fileHeld[key] = _copy(data[key]);
    } else {
      delete _settings[key];
      if (_fileHeld) delete _fileHeld[key];
    }
  }
  _tell(before, keys);
}

// Takes what an apply request wrote, as the file now holds it. A key this tab
// holds a newer change for keeps that change. One the send on leaving carried is
// left whole, so the tab-return check reads the apply's value as another tab's
// and keeps it. A tab-return read already out may predate the apply, so what
// landed is laid over its answer.
export function takeApplied(written) {
  const keys = Object.keys(written || {});
  const before = Object.fromEntries(keys.map((k) => [k, _settings[k]]));
  for (const [key, value] of Object.entries(written || {})) {
    if (key in _pendingChanges || key in _pendingDeltas || _sending.has(key) || key in _leftWith) continue;
    if (value === null) delete _settings[key]; else _settings[key] = _copy(value);
    _heldLanded(key, value);
  }
  _tell(before, keys);
}

let _flushRun = null;
let _retryDelay = 0;
const _RETRY_FIRST_MS = 2000;
const _RETRY_MAX_MS = 60000;
function _flushSettings() {
  _saveDebounceTimer = null;
  if (!_flushRun) _flushRun = _drainSettings().finally(() => { _flushRun = null; });
  return _flushRun;
}

async function _drainSettings() {
  const failed = {};
  const failedDeltas = {};
  const sent = new Set();
  const nextChange = () => Object.keys(_pendingChanges).find((k) => !(k in failed));
  const nextDelta = () => Object.keys(_pendingDeltas).find((k) => !(k in failedDeltas));

  let transient = false;
  const noteFailure = (err) => { if (err.status === 0 || err.status >= 500) transient = true; };
  try {
    // A change can arrive while the deltas are being sent, so the two passes
    // repeat until neither has anything left.
    while (nextChange() !== undefined || nextDelta() !== undefined) {
      for (let key = nextChange(); key !== undefined; key = nextChange()) {
        const value = _pendingChanges[key];
        delete _pendingChanges[key];
        sent.add(key);
        _sending.add(key);
        const res = await _post({ key, value });
        if ("error" in res) {
          failed[key] = value;
          noteFailure(res);
          _saveFailed(key, res);
        } else {
          _sending.delete(key);
          _heldLanded(key, value);
          _saveLanded(key);
        }
      }
      for (let key = nextDelta(); key !== undefined; key = nextDelta()) {
        const queued = _pendingDeltas[key];
        delete _pendingDeltas[key];
        sent.add(key);
        _sending.add(key);
        const add = [...queued.add];
        const remove = [...queued.remove];
        let res = await _post({ key, add, remove });
        // A server too old to merge refuses a delta with 400, so the change goes
        // again as the whole list.
        let whole;
        if (res.status === 400) {
          whole = _copy(_settings[key]);
          res = await _post({ key, value: whole });
        }
        if ("error" in res) {
          failedDeltas[key] = queued;
          noteFailure(res);
          _saveFailed(key, res);
        } else {
          // The server answers a delta with the list the file now holds. An answer
          // without one is taken as the change applied to the last known file.
          const merged = res.answer && "value" in res.answer ? res.answer.value
            : whole ?? _applyListDelta(_fileHeld ? _fileHeld[key] : [], add, remove);
          _sending.delete(key);
          _heldLanded(key, merged);
          _saveLanded(key);
        }
      }
    }
  } finally {
    // A value set again during the run was never sent, since the run skips a key
    // once it fails. A failed value this tab no longer holds has been replaced
    // since, and sending it again would write the older value over the newer.
    let unsent = false;
    for (const key of Object.keys(failed)) {
      if (key in _pendingChanges) unsent = true;
      else if ((key in _settings ? _settings[key] : null) === failed[key]) _pendingChanges[key] = failed[key];
    }
    // A whole list queued since carries the failed change already. Otherwise the
    // part this tab's list still agrees with goes back, under any newer change.
    for (const key of Object.keys(failedDeltas)) {
      if (key in _pendingChanges) { unsent = true; continue; }
      const newer = _pendingDeltas[key];
      const merged = _stillHeld(key, failedDeltas[key]);
      if (newer) {
        unsent = true;
        for (const v of newer.add) { merged.remove.delete(v); merged.add.add(v); }
        for (const v of newer.remove) { merged.add.delete(v); merged.remove.add(v); }
      }
      if (merged.add.size || merged.remove.size) _pendingDeltas[key] = merged;
      else {
        // This tab holds none of the failed change any more, so nothing of it is
        // left to save.
        delete _pendingDeltas[key];
        _saveLanded(key);
      }
    }
    for (const key of sent) _sending.delete(key);
    // No answer or a server error retries on a growing wait, while a refused key
    // waits for the next edit since sending it again cannot change the answer. A
    // key set again during the run had its debounce spent inside the run, so it
    // gets a new timer unless one is already pending.
    if (!transient) _retryDelay = 0;
    if (!_saveDebounceTimer && transient) {
      _retryDelay = Math.min(_retryDelay ? _retryDelay * 2 : _RETRY_FIRST_MS, _RETRY_MAX_MS);
      _saveDebounceTimer = setTimeout(_flushSettings, _retryDelay);
    } else if (!_saveDebounceTimer && unsent) {
      _saveDebounceTimer = setTimeout(_flushSettings, _SAVE_DEBOUNCE_MS);
    }
  }
}

// What a reader shows: a declared setting's value checked against what it
// takes, or its default. Saving, presets and backups read storedSetting, so a
// value a later version wrote passes through them unchanged.
export function getSetting(id) {
  const d = declaration(id);
  return d ? settingValue(d, storedSetting(id)) : storedSetting(id);
}

export function storedSetting(id) {
  return _settingsLoaded && id in _settings ? _settings[id] : undefined;
}
