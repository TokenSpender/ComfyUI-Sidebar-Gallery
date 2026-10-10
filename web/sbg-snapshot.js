import { snapshotDb } from "./sbg-idb.js";

export function saveSnapshot(rootId, items, dbVersion, serverTime) {
  return snapshotDb.put("items", rootId, { items, dbVersion, serverTime });
}

export async function loadSnapshot(rootId) {
  const snapshot = await snapshotDb.get("items", rootId);
  return snapshot?.items.length ? snapshot : null;
}

export function deleteSnapshots() {
  snapshotDb.remove();
}
