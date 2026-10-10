// Every method answers a neutral value instead of rejecting, since each store
// is a cache and a browser that refuses IndexedDB leaves the gallery asking
// the server.
function idbDatabase(name, version, stores) {
  let opening = null;

  function open() {
    if (!opening) {
      const attempt = new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const store of stores) {
            if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // A delete or upgrade from another tab waits until this connection
          // closes, and the next call here opens a fresh one.
          db.onversionchange = () => {
            db.close();
            if (opening === attempt) opening = null;
          };
          resolve(db);
        };
        // A failed open is tried again by the next call instead of held.
        req.onerror = () => {
          if (opening === attempt) opening = null;
          reject(req.error);
        };
      });
      opening = attempt;
    }
    return opening;
  }

  // Settled on the transaction's own events, since one that aborts at commit,
  // as on a full disk quota, fires abort alone.
  async function transact(store, mode, work, fallback) {
    try {
      const tx = (await open()).transaction(store, mode);
      const answer = work(tx.objectStore(store));
      return await new Promise((resolve) => {
        tx.oncomplete = () => resolve(answer());
        tx.onerror = () => resolve(fallback);
        tx.onabort = () => resolve(fallback);
      });
    } catch {
      return fallback;
    }
  }

  const write = (store, work) => transact(store, "readwrite", (st) => { work(st); return () => true; }, false);

  return {
    get(store, key) {
      return transact(store, "readonly", (st) => {
        const req = st.get(key);
        return () => req.result;
      }, undefined);
    },
    put: (store, key, value) => write(store, (st) => st.put(value, key)),
    delete: (store, key) => write(store, (st) => st.delete(key)),
    putMany: (store, entries) => write(store, (st) => {
      for (const { key, value } of entries) st.put(value, key);
    }),
    clear: (store) => write(store, (st) => st.clear()),
    write,

    stats(store, sizeOf) {
      return transact(store, "readonly", (st) => {
        const count = st.count();
        let totalSizeBytes = 0;
        st.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          totalSizeBytes += sizeOf(cursor.value);
          cursor.continue();
        };
        return () => ({ count: count.result, totalSizeBytes });
      }, { count: 0, totalSizeBytes: 0 });
    },

    remove() {
      // An open connection holds the delete back until it closes.
      if (opening) opening.then((db) => db.close()).catch(() => { });
      opening = null;
      // A browser with IndexedDB turned off has no database to delete.
      try { indexedDB.deleteDatabase(name); } catch { }
    },
  };
}

// Browsers already hold data under these names and versions.
export const cacheDb = idbDatabase("sbg-cache", 2, ["thumbs", "meta"]);
export const snapshotDb = idbDatabase("sbg-gallery-cache", 1, ["items"]);
