export function createGalleryStore(defaultSort) {
  const state = {
    roots: [],
    rootId: "output",
    subfolders: [],
    subfolder: "",
    favoritesOnly: false,
    kind: "",
    sort: defaultSort,
    allItems: [],
    filteredItems: [],
    searchTags: [],
    searchMode: "AND",
    searchMatches: null,
  };

  const _disposers = [];
  const teardown = {
    add(fn) { _disposers.push(fn); },
    dispose() {
      for (const fn of _disposers.splice(0)) { try { fn(); } catch { } }
    },
  };

  // Search tags are absent because the search bar saves them itself with its
  // matches. A root switch clears the matches here, which makes a restore
  // search again.
  const REMEMBERED = {
    rootId: "lastRootId", subfolder: "lastSubfolder", favoritesOnly: "lastFavoritesOnly",
    kind: "lastKind", sort: "lastSort", searchMode: "lastSearchMode", searchMatches: "lastSearchMatches",
  };
  function setView(patch) {
    for (const [key, value] of Object.entries(patch)) {
      state[key] = value;
      if (key in REMEMBERED) galleryCache.view[REMEMBERED[key]] = value;
    }
  }

  return { state, teardown, setView };
}

let _liveTeardown = null;

export function adoptTeardown(t) {
  if (_liveTeardown) _liveTeardown.dispose();
  _liveTeardown = t;
}

export function disposeLiveTeardown() {
  if (_liveTeardown) _liveTeardown.dispose();
  _liveTeardown = null;
}

export function rootLabel(roots, id) {
  return roots.find((r) => r.id === id)?.label || id;
}

export function decodeSearchMatches(list) {
  return new Map(list.map((m) => [m.relpath, m.matched_fields]));
}

// Module state, so it outlives a panel that is closed and built again.
export const galleryCache = {
  data: {
    roots: null,
    items: {},
    subfolders: {},

    // Keyed by root id: the version the cached items reflect, the server time
    // the next delta starts from, and the version last written to the snapshot.
    itemsVersion: {},
    serverTime: {},
    persistedVersion: {},
  },

  view: {
    lastRootId: "output",
    lastSubfolder: "",
    lastFavoritesOnly: false,
    lastKind: "",
    lastSort: null,
    lastSearchTags: [],
    lastSearchMode: null,
    lastSearchMatches: null,
    scrollPos: {},
    folderScrollTop: {},
    pickerRootsExpanded: false,
    pickerOpenFolders: {},
  },

  inbox: {
    pendingFiles: [],
    stale: false,
  },

  config: {
    autoRefreshSecs: null,
    configOwed: false,
    // The settings search draws the General tab's folder lists from this,
    // since it builds that tab off screen with no read of its own.
    last: null,
  },
};
