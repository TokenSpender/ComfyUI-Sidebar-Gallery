/**
 * sbg-compare-utils.js: pure helpers for lightbox compare mode.
 *
 * No imports and no DOM access, so the index math is unit-testable in
 * isolation.
 */

/** Stable identity key for a gallery item. The single home for the
 *  "root_id:relpath" format used by metadata caches and item remapping. */
export function itemKey(it) {
  return `${it.root_id}:${it.relpath}`;
}

/** All initial (source) images of a summary, oldest schema first: prefer the
 *  initial_images list (parser v22+), fall back to the scalar initial_image
 *  (older cached summaries). Entries come back raw, either a string or the
 *  legacy {path, filename} object form. Normalize with normalizeInitialEntry. */
export function initialImageList(s) {
  if (!s) return [];
  if (Array.isArray(s.initial_images) && s.initial_images.length) return s.initial_images;
  return s.initial_image ? [s.initial_image] : [];
}

/** ComfyUI marks a widget path loaded from outside the input folder with a
 *  trailing annotation ("sub/img.png [output]"). Split that into the bare path
 *  and the location token; a string without the annotation comes back with a
 *  null type. Brackets anywhere else in the name are left alone. */
const _ANNOTATED_PATH_RE = /^(.*\S)\s\[(input|output|temp)\]$/;
function _splitPathAnnotation(raw) {
  const m = _ANNOTATED_PATH_RE.exec(String(raw));
  return m ? { path: m[1], srcType: m[2] } : { path: raw, srcType: null };
}

/** One home for the string-vs-legacy-object entry shape: {path, name, srcType}.
 *  path is what /view and metadata resolution use ("" when unknown);
 *  name is the display filename ("Unknown" when the legacy object has none);
 *  srcType is the location the annotation named (input/output/temp) or null.
 *  Cache keys, previews and labels all derive from this one projection so a
 *  future shape change can't desync them. */
export function normalizeInitialEntry(entry) {
  if (typeof entry === "string") {
    const { path, srcType } = _splitPathAnnotation(entry);
    return { path, name: path, srcType };
  }
  const rawPath = entry.path || entry.filename || "";
  const { path, srcType } = _splitPathAnnotation(rawPath);
  const rawName = entry.filename || rawPath;
  return { path, name: rawName ? _splitPathAnnotation(rawName).path : "Unknown", srcType };
}

/** Next comparison index: step by dir, skip the current image's index, wrap at
 *  both ends. Two skip/wrap passes are enough because only one index (the
 *  current image) is ever excluded. */
export function nextCompareIdx(compareIdx, dir, idx, len) {
  let newIdx = compareIdx + dir;
  if (newIdx === idx) newIdx += dir;
  if (newIdx < 0) newIdx = len - 1;
  if (newIdx >= len) newIdx = 0;
  if (newIdx === idx) newIdx += dir;
  if (newIdx < 0) newIdx = len - 1;
  if (newIdx >= len) newIdx = 0;
  return newIdx;
}

/** Re-locate the compared item after the items array is replaced (e.g. by
 *  auto-refresh). cmpKey is the "root_id:relpath" identity of the previously
 *  compared item. Returns { compareIdx, changed }: changed=true means the
 *  resolved index now points at a different file, so the caller must reload
 *  the compare media and diff. Callers handle newItems.length < 2 themselves
 *  (compare mode cannot stay open on a single-item list). */
export function remapCompareIdx(newItems, cmpKey, oldCompareIdx, idx) {
  let ni = cmpKey ? newItems.findIndex(it => it && itemKey(it) === cmpKey) : -1;
  if (ni >= 0 && ni !== idx) return { compareIdx: ni, changed: false };
  // Compared item vanished (or would collide with the current image): clamp
  // to the nearest valid index that isn't the current one.
  ni = Math.min(oldCompareIdx, newItems.length - 1);
  if (ni < 0) ni = 0;
  if (ni === idx) ni = ni > 0 ? ni - 1 : ni + 1;
  return { compareIdx: ni, changed: true };
}
