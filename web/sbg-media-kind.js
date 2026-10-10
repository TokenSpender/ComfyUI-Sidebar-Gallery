import { VIDEO_ICON, IMAGE_ICON, AUDIO_ICON } from "./sbg-icons.js";

export function itemKey(it) {
  return `${it.root_id}:${it.relpath}`;
}

// A listed item's mtime and ctime both carry the time it sorts by, and
// mtime_real the file's own modification time.
export function modifiedTime(it) {
  return it.mtime_real;
}

// The modification time is part of it, so a file rewritten at the same path
// gets a new card.
export function cardIdentityKey(it) {
  return `${itemKey(it)}\x00${modifiedTime(it)}`;
}

// A URL carries this as v, so a long cache of what it answers ends when the file changes.
export function fileVersion(it) {
  return Math.floor(modifiedTime(it) * 1000);
}

export function fileUrl(it) {
  return `/sidebar_gallery/file?root_id=${encodeURIComponent(it.root_id)}&relpath=${encodeURIComponent(it.relpath)}&v=${fileVersion(it)}`;
}

export function isImage(it) { return it.kind === "image"; }

export function isVideo(it) { return it.kind === "video"; }

export function isAudio(it) { return it.kind === "audio"; }

const _KIND_ICON = { image: IMAGE_ICON, video: VIDEO_ICON, audio: AUDIO_ICON };

export function kindIcon(it) {
  return _KIND_ICON[it.kind];
}
