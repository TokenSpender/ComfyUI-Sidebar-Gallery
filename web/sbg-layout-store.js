import { lsKeys, lsRemove } from "./sbg-core.js";
import { APP_REGISTRY } from "./sbg-theme.js";
import { storedSetting, saveSetting, saveSettingDelta, deleteSetting, readSettingsFromDisk, reloadSettingsFromDisk, adoptFromDisk, takeApplied, flushSettingsAsync, settingsUnread, S, B } from "./sbg-settings-store.js";
import { showSettingsUnread, postNotice, failureText } from "./sbg-toast.js";
import { DEFAULT_IMAGE_LAYOUT, DEFAULT_VIDEO_LAYOUT, DEFAULT_AUDIO_LAYOUT } from "./sbg-default-layout.js";

export const APPS = APP_REGISTRY.map(a => a.id);
export const APP_LABELS = Object.fromEntries(APP_REGISTRY.map(a => [a.id, a.label]));
export const MEDIA_KEYS = ["image", "video", "audio"];
export const MEDIA_LABELS = { image: "Images", video: "Videos", audio: "Audio" };

function _mediaName(media) {
  return MEDIA_KEYS.includes(media) ? media : "image";
}

export function profileKey(app, media) {
  const a = APPS.includes(app) ? app : "comfyui";
  return `${a}_${_mediaName(media)}`;
}

export function profileLabel(key) {
  for (const app of APPS) for (const med of MEDIA_KEYS) {
    if (profileKey(app, med) === key) return `${APP_LABELS[app]} · ${MEDIA_LABELS[med]}`;
  }
  return key;
}

const DEFAULT_LAYOUTS = { image: DEFAULT_IMAGE_LAYOUT, video: DEFAULT_VIDEO_LAYOUT, audio: DEFAULT_AUDIO_LAYOUT };

function defaultLayoutFor(media) {
  return JSON.parse(JSON.stringify(DEFAULT_LAYOUTS[media]));
}
export const defaultImageLayout = () => defaultLayoutFor("image");
export const defaultVideoLayout = () => defaultLayoutFor("video");

function profileStorageKey(profileKey) {
  return S.LAYOUT_PROFILE_PREFIX + profileKey;
}

function _storedBlob() {
  const stored = storedSetting(S.LAYOUT_PROFILES);
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : null;
}

function _storedIndex() {
  const index = storedSetting(S.LAYOUT_INDEX);
  return Array.isArray(index) ? index.filter((k) => typeof k === "string") : null;
}

// An older version stored every layout in one map, and this one stores a key
// per layout listed in an index. The index wins when both are there.
function _readProfiles() {
  const index = _storedIndex();
  if (index) {
    const out = {};
    for (const k of index) {
      const v = storedSetting(profileStorageKey(k));
      if (Array.isArray(v)) out[k] = v;
    }
    return out;
  }
  return _storedBlob() || {};
}

let _lastSavedText = null;

function _rememberSaved(profiles) {
  _lastSavedText = {};
  for (const [k, v] of Object.entries(profiles)) _lastSavedText[k] = JSON.stringify(v);
}

export function getProfiles() {
  const profiles = _readProfiles();
  if (_lastSavedText === null) _rememberSaved(profiles);
  return profiles;
}

// Every layout the panel can draw: the stored ones, plus the shipped default for
// a media whose ComfyUI layout is not stored, since getActiveProfile falls back
// to it. The defaults are shared, so a caller only reads them.
export function drawnProfiles() {
  const out = { ...getProfiles() };
  for (const med of MEDIA_KEYS) {
    const key = profileKey("comfyui", med);
    if (!(Array.isArray(out[key]) && out[key].length)) out[key] = DEFAULT_LAYOUTS[med];
  }
  return out;
}

// With `onlyKeys`, a stored layout outside that list is left as stored even
// when the caller's copy lacks it, since that copy can predate it. So a caller
// names every layout it edited or deleted. Returns false when the save was
// refused, so the caller can take the edit back.
export function saveProfiles(profiles, onlyKeys = null) {
  if (settingsUnread()) {
    showSettingsUnread();
    return false;
  }
  if (_lastSavedText === null) _rememberSaved(_readProfiles());

  // With no index stored yet no layout has its own key, so every one is
  // written and `onlyKeys` does not apply.
  const splitting = !_storedIndex();
  const keys = Object.keys(profiles).filter((k) => Array.isArray(profiles[k]));
  const only = onlyKeys && !splitting ? new Set(onlyKeys) : null;
  const next = {};
  let wrote = false;
  for (const k of keys) {
    if (only && !only.has(k) && k in _lastSavedText) { next[k] = _lastSavedText[k]; continue; }
    const text = JSON.stringify(profiles[k]);
    next[k] = text;
    if (splitting || _lastSavedText[k] !== text) { saveSetting(profileStorageKey(k), profiles[k]); wrote = true; }
  }

  const removed = [];
  for (const k of Object.keys(_lastSavedText)) {
    if (k in next) continue;
    if (only && !only.has(k)) next[k] = _lastSavedText[k];
    else removed.push(k);
  }
  for (const k of removed) { deleteSetting(profileStorageKey(k)); wrote = true; }

  const index = _storedIndex();
  const added = keys.filter((k) => !index || !index.includes(k));
  if (added.length || removed.length) {
    saveSettingDelta(S.LAYOUT_INDEX, { add: added, remove: removed });
    wrote = true;
  }
  _lastSavedText = next;

  // The lightbox redraws its whole panel on this event, so a save that changed
  // nothing sends none.
  if (wrote) document.dispatchEvent(new CustomEvent("sbg-layout-changed"));
  return true;
}

// Drops only the in-memory record of the last save, so the next save compares
// against the settings as they now stand.
export function forgetSavedLayouts() {
  _lastSavedText = null;
}

export function layoutStorageKeys(profileKeys) {
  return profileKeys.map(profileStorageKey);
}

// What setting `set` and removing `remove` writes, for a request that carries
// it with other changes: each layout's own key, and the index as a list change,
// so a layout another tab added meanwhile stays listed. With no index stored
// yet, every layout is written under its own key and the single map goes in
// the same request, as the conversion at start does.
export function layoutWrites({ set = {}, remove = [] }) {
  const index = _storedIndex();
  const next = { ...getProfiles(), ...set };
  for (const k of remove) delete next[k];
  const written = index ? Object.keys(set) : Object.keys(next).filter((k) => Array.isArray(next[k]));
  const targets = {};
  for (const k of written) targets[profileStorageKey(k)] = next[k];
  for (const k of remove) targets[profileStorageKey(k)] = null;
  if (!index && _storedBlob()) targets[S.LAYOUT_PROFILES] = null;
  const add = written.filter((k) => !index || !index.includes(k));
  const drop = index ? remove.filter((k) => index.includes(k)) : [];
  return { targets, index: add.length || drop.length ? { add, remove: drop } : null };
}

// After a request another module sent wrote layouts: the next save compares
// against the layouts as they now stand, a section no layout holds any more
// lets go of its remembered tab, and the lightbox redraws.
export function layoutsApplied(sectionIds) {
  forgetSavedLayouts();
  forgetPromptTabs(sectionIds);
  document.dispatchEvent(new CustomEvent("sbg-layout-changed"));
}

// A stored layout comes back as the settings hold it, so a caller that edits
// one works on a copy of its own.
export function getActiveProfile(app, media) {
  const profiles = getProfiles();
  const med = _mediaName(media);
  const key = profileKey(app, med);
  if (Array.isArray(profiles[key]) && profiles[key].length) return profiles[key];

  const fallback = profiles[`comfyui_${med}`];
  if (Array.isArray(fallback) && fallback.length) return fallback;
  return defaultLayoutFor(med);
}

// This version deletes the single-map key in the request that gives every
// layout in it its own key and its index entry, so a map found beside the
// index was written since by an older version, or left by an earlier run, and
// its layouts are brought in. Two cases are left out. A layout equal to its own
// key's copy is already in, and one matching a released default is what the
// older editor saved when a layout was only viewed.
export async function consolidateLayoutStorage() {
  const done = { state: "none", converted: [], added: [], broughtIn: [], skipped: [], backup: null, deleted: false };
  if (settingsUnread() || !_storedBlob()) return done;

  // Only a start that finds the map needs these, so they load here instead of
  // with every page.
  const [{ canonicalJson }, { fingerprint }, { RELEASED_DEFAULT_LAYOUTS }, backups] = await Promise.all([
    import("./sbg-preset-format.js"),
    import("./sbg-layout-fingerprint.js"),
    import("./sbg-released-defaults.js"),
    import("./sbg-settings-backups.js"),
  ]);
  // A change still waiting to be saved would be taken for one made after an
  // answer, so it reaches the file before the file is read.
  await flushSettingsAsync();
  let disk;
  try { disk = await readSettingsFromDisk(); } catch { return done; }
  const blob = disk[S.LAYOUT_PROFILES];
  const index = Array.isArray(disk[S.LAYOUT_INDEX]) ? disk[S.LAYOUT_INDEX].filter((k) => typeof k === "string") : null;
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
    // Another tab converted the map since this one loaded, so this tab takes
    // the new shape instead of saving every layout again from its old copy.
    if (index) {
      adoptFromDisk(disk, [S.LAYOUT_INDEX, ...index.map(profileStorageKey), S.LAYOUT_PROFILES]);
      forgetSavedLayouts();
    }
    return done;
  }
  const profiles = Object.keys(blob).filter((k) => Array.isArray(blob[k]) && blob[k].length);
  // Each request holds only while the map, the index and every layout key it
  // writes or takes still read as they did here, so a second tab or an edit
  // made since is never written over. One refused, or one with no answer,
  // reads the settings again and leaves the rest to the next start.
  const held = (keys) => Object.fromEntries([S.LAYOUT_PROFILES, S.LAYOUT_INDEX, ...keys].map((k) => [k, k in disk ? disk[k] : null]));
  const send = async (body) => {
    try {
      return await backups.postApply(body);
    } catch (e) {
      if (e.status !== 409 && !backups.unconfirmed(e)) throw e;
      try { await reloadSettingsFromDisk(); } catch { }
      forgetSavedLayouts();
      return null;
    }
  };

  let move = profiles;
  let listed = profiles;
  if (!index) {
    done.state = "converted";
    done.converted = profiles;
  } else {
    done.state = "reconciled";
    const changes = [];
    const unlisted = [];
    for (const k of profiles) {
      const split = disk[profileStorageKey(k)];
      // A layout's copy under its own key that the index does not list is still
      // this version's work, so it is compared like any other and only gains its
      // index entry. Only a layout with no key of its own goes in without a
      // backup.
      if (!index.includes(k) && Array.isArray(split)) unlisted.push(k);
      if (!Array.isArray(split)) { done.added.push(k); continue; }
      if (canonicalJson(split) === canonicalJson(blob[k])) continue;
      if (RELEASED_DEFAULT_LAYOUTS[fingerprint(blob[k])]) { done.skipped.push(k); continue; }
      changes.push(k);
    }
    if (changes.length) {
      // Bringing in a layout an older version changed is dated, and its copy
      // holds the layouts it replaces and nothing the move below writes.
      const keys = changes.map(profileStorageKey);
      let answer;
      try {
        answer = await send({
          settings: Object.fromEntries(changes.map((k) => [profileStorageKey(k), blob[k]])),
          backup: { cause: backups.LAYOUTS_FROM_OLDER_VERSION, title: backups.causeLabel(backups.LAYOUTS_FROM_OLDER_VERSION) },
          carried: keys,
          precondition: held(keys),
        });
      } catch (e) {
        done.state = "held";
        console.warn("[SBG] Applying layouts from an older version failed:", e);
        postNotice(LAYOUTS_HELD, layoutsHeldText());
        return done;
      }
      if (!answer) return done;
      takeApplied(answer.written);
      done.backup = answer.backup || null;
      done.broughtIn = changes;
      // Posted here, since the next start finds these equal to their own keys
      // and would never post it.
      postNotice("layouts-brought-in", broughtInMessage(changes));
    }
    move = done.added;
    listed = [...unlisted, ...done.added];
  }

  // Moving a layout to its own key changes nothing on screen and is undated.
  // The map goes in the same request, so no file holds one without the other.
  // A tab that loaded before another converted the map holds neither the index
  // nor the keys, so it takes the layouts it did not write as read here, which
  // the request holds to.
  const taken = [...new Set([...move, ...(index || []), ...listed])].filter((k) => !done.broughtIn.includes(k)).map(profileStorageKey);
  const moved = await send({
    settings: { ...Object.fromEntries(move.map((k) => [profileStorageKey(k), blob[k]])), [S.LAYOUT_PROFILES]: null },
    deltas: listed.length ? { [S.LAYOUT_INDEX]: { add: listed, remove: [] } } : {},
    precondition: held(taken),
  });
  if (!moved) return done;
  adoptFromDisk(disk, [S.LAYOUT_INDEX, ...taken].filter((k) => !(k in moved.written)));
  takeApplied(moved.written);
  done.deleted = true;
  forgetSavedLayouts();
  if (done.converted.length || done.added.length || done.broughtIn.length) {
    document.dispatchEvent(new CustomEvent("sbg-layout-changed"));
  }
  return done;
}

const _andList = (xs) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function broughtInMessage(keys) {
  const parts = [];
  for (const app of APPS) {
    const media = MEDIA_KEYS.filter((m) => keys.includes(profileKey(app, m)));
    if (media.length) parts.push(`the ${APP_LABELS[app]} ${_andList(media.map((m) => MEDIA_LABELS[m]))} ${media.length > 1 ? "layouts" : "layout"}`);
  }
  const known = new Set(APPS.flatMap((a) => MEDIA_KEYS.map((m) => profileKey(a, m))));
  const others = keys.filter((k) => !known.has(k)).length;
  if (others) parts.push(others === 1 ? "one other layout" : `${others} other layouts`);
  const replaced = keys.length === 1 ? "The layout they replaced is" : "The layouts they replaced are";
  return `Layout changes you made in an older version are now applied to ${_andList(parts)}. ${replaced} saved under Backups on the Presets tab.`;
}

// Bringing in an older version's layout changes can fail at two steps of the
// start, and both say it in these words under one notice.
export const LAYOUTS_HELD = "layouts-held";
export function layoutsHeldText(err) {
  return `${failureText("apply the layout changes from an older version", err)}. Retrying at the next browser refresh.`;
}

// Every tabbed section remembers its tab under `B.PROMPT_TAB_PREFIX` plus its
// id, and one with no id under "tabs", so that key is never stale.
function _liveSectionIds() {
  const ids = new Set(["tabs"]);
  for (const layout of [...Object.values(getProfiles()), ...Object.values(DEFAULT_LAYOUTS)]) {
    if (Array.isArray(layout)) for (const s of layout) if (s && s.id) ids.add(s.id);
  }
  return ids;
}

export function sweepStalePromptTabKeys() {
  const live = _liveSectionIds();
  const stale = lsKeys(B.PROMPT_TAB_PREFIX).filter((k) => !live.has(k.slice(B.PROMPT_TAB_PREFIX.length)));
  for (const k of stale) lsRemove(k);
  return stale.length;
}

// Call after the save that removed these sections, since a section any stored
// or shipped layout still holds keeps its tab.
export function forgetPromptTabs(sectionIds) {
  const live = _liveSectionIds();
  for (const id of sectionIds) if (id && !live.has(id)) lsRemove(B.PROMPT_TAB_PREFIX + id);
}
