import { itemKey } from "./sbg-media-kind.js";

// Compare mode moves the lightbox's own media into its left half, so what compare adds there is tagged
// and every pass that clears or moves that host's media leaves it standing.
export const isCompareTag = (el) => el.dataset.sbgCompare === "1";

export function nextCompareIdx(compareIdx, dir, idx, len) {
  let next = compareIdx;
  do next = (next + dir + len) % len; while (next === idx && len > 1);
  return next;
}

// A true `changed` says the index now points at a different file, so the caller loads the compared side again.
export function remapCompareIdx(newItems, cmpKey, oldCompareIdx, idx) {
  let ni = cmpKey ? newItems.findIndex(it => it && itemKey(it) === cmpKey) : -1;
  if (ni >= 0 && ni !== idx) return { compareIdx: ni, changed: false };

  ni = Math.min(oldCompareIdx, newItems.length - 1);
  if (ni < 0) ni = 0;
  if (ni === idx) ni = ni > 0 ? ni - 1 : ni + 1;
  return { compareIdx: ni, changed: true };
}
