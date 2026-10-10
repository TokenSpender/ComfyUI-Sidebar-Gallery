import { api } from "./sbg-core.js";
import { cacheDb } from "./sbg-idb.js";
import { itemKey, modifiedTime } from "./sbg-media-kind.js";

const MEMORY_CAP = 5000;
// A Map iterates in insertion order, so `hold` moving a key to the end on
// every read and write leaves the least recently used one first out.
const memory = new Map();

function hold(key, value) {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > MEMORY_CAP) memory.delete(memory.keys().next().value);
}

function fromMemory(key) {
  const value = memory.get(key);
  if (value !== undefined) hold(key, value);
  return value;
}

export const metaCache = {
  get memorySize() { return memory.size; },

  put(key, value) {
    hold(key, value);
    return cacheDb.put("meta", key, value);
  },

  putBatch(entries) {
    for (const { key, value } of entries) hold(key, value);
    return cacheDb.putMany("meta", entries);
  },

  delete(key) {
    memory.delete(key);
    return cacheDb.delete("meta", key);
  },

  clearMemory() {
    memory.clear();
  },

  clear() {
    memory.clear();
    return cacheDb.clear("meta");
  },

  stats: () => cacheDb.stats("meta", (value) => JSON.stringify(value).length * 2),
};

async function lookup(key, fresh) {
  const inMemory = fromMemory(key);
  if (fresh(inMemory)) return inMemory;
  const stored = await cacheDb.get("meta", key);
  if (!fresh(stored)) return null;
  hold(key, stored);
  return stored;
}

export async function cachedMeta(key, fetchFresh, fresh = Boolean) {
  const hit = await lookup(key, fresh);
  if (hit) return hit;
  const m = await fetchFresh();
  if (m) metaCache.put(key, m);
  return m;
}

// The cached file.mtime is the file's real modified time. An item's own mtime
// is its sort time and can be a creation time, which would hold every copied
// file stale for good.
function freshFor(it) {
  const mt = modifiedTime(it);
  // A time of 0 on either side has nothing to compare, so it cannot make a
  // hit stale.
  return (hit) => !!hit && !(mt && hit.file?.mtime && hit.file.mtime < mt);
}

// A file the scan has not reached answers its summary read with its whole
// metadata, and that reply is cached as it came.
export function fetchSummary(it) {
  return api("/sidebar_gallery/metadata", { root_id: it.root_id, relpath: it.relpath, summary_only: "1" });
}

// Never cached, so a workflow read here does not change what the summary cache
// holds.
export function fetchFullMeta(it) {
  return api("/sidebar_gallery/metadata", { root_id: it.root_id, relpath: it.relpath });
}

export function summaryOf(it) {
  return cachedMeta(itemKey(it), () => fetchSummary(it), freshFor(it));
}

export function summaryInMemory(it) {
  const hit = fromMemory(itemKey(it));
  return freshFor(it)(hit) ? hit : null;
}

// The store's own answer, which memory can't give, since memory also keeps what
// the store refused.
export async function storedSummaryOf(it) {
  const stored = await cacheDb.get("meta", itemKey(it));
  return freshFor(it)(stored) ? stored : null;
}
