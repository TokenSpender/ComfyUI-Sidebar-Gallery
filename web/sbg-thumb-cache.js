import { singleFlight } from "./sbg-core.js";
import { cacheDb } from "./sbg-idb.js";
import { isAudio } from "./sbg-media-kind.js";

const MEMORY_CAP = 500;
// Eviction takes the Map in insertion order, so `touch` moves a hit to the
// newest end.
const memory = new Map();

function touch(url) {
  const blobUrl = memory.get(url);
  if (blobUrl === undefined) return null;
  memory.delete(url);
  memory.set(url, blobUrl);
  return blobUrl;
}

function shownThumbs() {
  return new Set([...document.querySelectorAll("img.sbg-card__thumb")].map((img) => img.getAttribute("src")));
}

function revokeUnlessShown(blobUrl, shown) {
  if (shown.has(blobUrl)) return false;
  URL.revokeObjectURL(blobUrl);
  return true;
}

// A `tryGet` and a `getOrFetch` of one url can race, and the later keeps the
// first blob url instead of making a second that nothing would revoke.
function remember(url, blob) {
  const held = touch(url);
  if (held) return held;
  const blobUrl = URL.createObjectURL(blob);
  memory.set(url, blobUrl);
  if (memory.size > MEMORY_CAP) {
    const shown = shownThumbs();
    let quota = Math.floor(MEMORY_CAP * 0.25);

    // The entry being added is not on a card yet, and is spared with those
    // that are.
    for (const [key, val] of memory) {
      if (!quota) break;
      if (key !== url && revokeUnlessShown(val, shown)) { memory.delete(key); quota--; }
    }
  }
  return blobUrl;
}

async function fromStore(url) {
  const blob = await cacheDb.get("thumbs", url);
  return blob ? remember(url, blob) : null;
}

// The fetched thumbnails the browser's store refused, so Cache thumbnails can
// tell a full or blocked store from a finished one.
let _refused = 0;

async function fetchAndStore(url) {
  const resp = await fetch(url);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`thumb fetch ${resp.status}`);
  const blob = await resp.blob();
  if (!(await cacheDb.put("thumbs", url, blob))) _refused++;
  return remember(url, blob);
}

export const thumbCache = {
  tryGetSync: touch,

  async tryGet(url) {
    return touch(url) ?? singleFlight("thumbTry:" + url, () => fromStore(url));
  },

  async getOrFetch(url) {
    return touch(url) ?? singleFlight("thumbFetch:" + url, async () => (await fromStore(url)) ?? fetchAndStore(url));
  },

  refused: () => _refused,

  // Memory also keeps what the store refused, so the store itself is asked
  // and a thumbnail it lacks is fetched again for it.
  async fillStore(url) {
    return (await cacheDb.get("thumbs", url)) ? true : singleFlight("thumbFetch:" + url, () => fetchAndStore(url));
  },

  stats: () => cacheDb.stats("thumbs", (blob) => blob.size),

  clear() {
    const shown = shownThumbs();
    for (const blobUrl of memory.values()) revokeUnlessShown(blobUrl, shown);
    memory.clear();
    return cacheDb.clear("thumbs");
  },

  // A thumbnail url carries the file's modified time, so an edited file leaves
  // its old entry behind with nothing to reach it.
  pruneIfOver(maxCount) {
    return cacheDb.write("thumbs", (store) => {
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result <= maxCount) return;
        let toDelete = countReq.result - Math.floor(maxCount * 0.75);
        store.openKeyCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor || toDelete <= 0) return;
          store.delete(cursor.primaryKey);
          toDelete--;
          cursor.continue();
        };
      };
    });
  },
};

// Every card the grid has built, the buffer rows included, waits here for a
// thumbnail the browser does not hold. The nearest to the screen loads first,
// and only this many at once, which is the server's IO thread count and
// leaves the browser's other connections for the list, metadata and poll.
const MAX_LOADING = 4;
const waiting = new Set();
const watched = new WeakMap();
const failedUrls = new Set();
let loading = 0;
// A load that settles after a reset frees no slot, since the reset already
// emptied the count.
let generation = 0;

// A file still being written may have no thumbnail yet, so a miss is tried
// again on this backoff before the card settles for the placeholder.
const RETRY_DELAYS = [1500, 3500, 7000];

const current = (watch) => watch.wrap.isConnected && watched.get(watch.wrap) === watch;

// A card the grid dropped, or a panel taken off the page, leaves the queue
// here without being requested.
function nearest() {
  let best = null, bestDistance = Infinity;
  for (const watch of waiting) {
    if (!current(watch)) { waiting.delete(watch); continue; }
    const d = watch.distance();
    if (d < bestDistance) { best = watch; bestDistance = d; }
  }
  return best;
}

// The cards one pass builds arrive one at a time as their store reads miss,
// so the queue is ranked on the next frame, all of them together, instead of
// the first to arrive taking the free slots.
let pumpQueued = false;
function pumpSoon() {
  if (pumpQueued) return;
  pumpQueued = true;
  const gen = generation;
  requestAnimationFrame(() => {
    if (gen !== generation) return;
    pumpQueued = false;
    pump();
  });
}

function pump() {
  while (loading < MAX_LOADING) {
    const watch = nearest();
    if (!watch) return;
    waiting.delete(watch);
    load(watch);
  }
}

function load(watch) {
  const { item, show } = watch;
  const giveUp = () => {
    failedUrls.add(item.thumb_url);
    show(null);
  };
  // A card the grid rebuilds as it scrolls back starts out loading, so a url
  // already given up on has to settle here or the card spins on.
  if (failedUrls.has(item.thumb_url)) { giveUp(); return; }

  loading++;
  const gen = generation;
  const settle = () => { if (gen === generation) loading--; };
  // A retry gives its slot back while it waits, so a file still being written
  // does not hold one through the whole backoff.
  const retry = () => {
    const attempt = watch.attempt++;
    if (attempt >= RETRY_DELAYS.length) { giveUp(); return; }
    setTimeout(() => {
      waiting.add(watch);
      pumpSoon();
    }, RETRY_DELAYS[attempt]);
  };
  // The rejection handler sits beside the success one, so a throw from
  // `show` is not retried as a failed fetch.
  thumbCache.getOrFetch(item.thumb_url).then((blobUrl) => {
    settle();
    try {
      if (!current(watch)) return;
      if (blobUrl) show(blobUrl);
      // For audio a missing thumbnail is the server saying there is nothing
      // to draw, so the card settles at once.
      else if (isAudio(item)) giveUp();
      else retry();
    } finally { pump(); }
  }, () => {
    settle();
    if (current(watch)) retry();
    pump();
  });
}

export function resetThumbQueue() {
  generation++;
  loading = 0;
  waiting.clear();
  pumpQueued = false;
}

// `show` gets the blob url once the card's turn comes, or null when there is
// none to draw. `distance` answers how far the card is from the screen, 0 for
// any part of it on screen, and is asked each time the queue is ranked.
export function observeThumb(wrap, item, show, distance) {
  const watch = { wrap, item, show, distance, attempt: 0 };
  watched.set(wrap, watch);
  waiting.add(watch);
  pumpSoon();
}

export function unobserveThumb(wrap) {
  const watch = watched.get(wrap);
  watched.delete(wrap);
  if (watch) waiting.delete(watch);
}

export function resetFailedThumbs() {
  failedUrls.clear();
}
