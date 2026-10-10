const isEntry = (x) => !!x && typeof x === "object" && !Array.isArray(x);

const cleanParams = (x) => { x.params = Array.isArray(x.params) ? x.params.filter(isEntry) : []; };

// A hand-edited preset or settings file can put a non-object where a section,
// tab or field belongs, or a non-list where tabs or fields belong.
function cleanLayout(layout) {
  const kept = layout.filter(isEntry);
  for (const sec of kept) {
    cleanParams(sec);
    if (!Array.isArray(sec.tabs)) { delete sec.tabs; continue; }
    sec.tabs = sec.tabs.filter(isEntry);
    for (const t of sec.tabs) cleanParams(t);
    if (!sec.tabs.length) delete sec.tabs;
  }
  return kept;
}

export function createProfileStore(store) {
  const profiles = store.getProfiles();
  const workingByKey = {};

  const isStored = (k) => Array.isArray(profiles[k]) && profiles[k].length > 0;

  // The editor works on a copy of the saved layout, or of the one it inherits,
  // so opening a layout changes nothing the lightbox reads.
  function layoutFor(app, media) {
    const k = store.profileKey(app, media);
    if (!workingByKey[k]) {
      const from = isStored(k) ? profiles[k] : store.getActiveProfile(app, media);
      workingByKey[k] = cleanLayout(JSON.parse(JSON.stringify(from)));
    }
    return workingByKey[k];
  }

  // A refused save drops the edited copy, so the next read copies the layout
  // the lightbox shows. A save is refused only when the settings file could not
  // be read, and then there was no stored layout to put back.
  function persistKeys(keys) {
    for (const k of keys) if (workingByKey[k]) profiles[k] = JSON.parse(JSON.stringify(workingByKey[k]));
    if (store.saveProfiles(profiles, keys) !== false) return true;
    for (const k of keys) reset(k);
    return false;
  }

  function reset(k) { delete profiles[k]; delete workingByKey[k]; }

  return { layoutFor, persistKeys, reset };
}
