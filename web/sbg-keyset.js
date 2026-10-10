import { storedSetting, saveSettingDelta, settingsUnread } from "./sbg-settings-store.js";
import { showSettingsUnread } from "./sbg-toast.js";

// A NUL cannot appear in a root id or in a path, so the two join without an ambiguous split.
const SEP = "\u0000";

export function makeNameSet(settingKey, changeEvent) {
  let cachedSource = null;
  let cachedSet = new Set();

  function all() {
    const stored = storedSetting(settingKey) ?? null;
    // The settings store replaces a list on every change instead of editing it,
    // so comparing identity is enough to catch one.
    if (stored !== cachedSource) {
      cachedSource = stored;
      cachedSet = new Set(Array.isArray(stored) ? stored.filter(v => typeof v === "string") : []);
    }
    return cachedSet;
  }

  function write(k, added) {
    // One entry goes to the server instead of the whole list, so a second tab
    // holding an older copy of the list cannot erase this change.
    saveSettingDelta(settingKey, added ? { add: [k] } : { remove: [k] });
    if (changeEvent) document.dispatchEvent(new CustomEvent(changeEvent));
  }

  return {
    all,
    has: (name) => all().has(String(name)),

    toggle(name) {
      const k = String(name);
      if (settingsUnread()) {
        showSettingsUnread();
        return all().has(k);
      }
      const added = !all().has(k);
      write(k, added);
      return added;
    },

    // Unlike toggle, drop and rename show no unread notice, since each only
    // follows a change the user made to the named thing itself.
    drop(name) {
      const k = String(name);
      if (settingsUnread() || !all().has(k)) return false;
      write(k, false);
      return true;
    },

    rename(from, to) {
      const was = String(from);
      if (settingsUnread() || !all().has(was) || String(to) === was) return false;
      write(was, false);
      write(String(to), true);
      return true;
    },
  };
}

export function makeKeySet(settingKey, changeEvent) {
  const names = makeNameSet(settingKey, changeEvent);
  const key = (rootId, path) => String(rootId) + SEP + String(path);

  return {
    key,
    all: names.all,
    has: (rootId, path) => names.has(key(rootId, path)),
    toggle: (rootId, path) => names.toggle(key(rootId, path)),

    hasRoot(rootId) {
      const prefix = String(rootId) + SEP;
      for (const k of names.all()) if (k.startsWith(prefix)) return true;
      return false;
    },

    pathsFor(rootId) {
      const prefix = String(rootId) + SEP;
      const out = [];
      for (const k of names.all()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
      return out.sort();
    },
  };
}
