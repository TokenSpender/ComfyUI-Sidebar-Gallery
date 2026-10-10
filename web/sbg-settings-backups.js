import { apiPost, RESTART_FIRST } from "./sbg-core.js";

export function postBackups(body) {
  return apiPost("/sidebar_gallery/settings_backups", body);
}

// One request for an action that changes several things, which the server
// does whole or not at all, taking the backup in the same request. It is never
// sent again by the page, since one that got no answer may have landed.
export async function postApply(body) {
  try {
    return await apiPost("/sidebar_gallery/apply", body);
  } catch (e) {
    // ComfyUI answers a request to a route the server lacks with 405, or 404
    // with no reason of ours, as from a server not restarted since the update.
    if (e.status === 405 || (e.status === 404 && !(e.data && e.data.error))) throw Object.assign(new Error(RESTART_FIRST), { status: e.status });
    throw e;
  }
}

// A failure that carries no status got no answer, or one that couldn't be
// read, so the action may have landed.
export function unconfirmed(err) {
  return !(err && err.status);
}

export const LAYOUTS_FROM_OLDER_VERSION = "layouts-from-older-version";
export const COLOURS_FROM_OLDER_VERSION = "colours-from-older-version";

const _TITLES = {
  [LAYOUTS_FROM_OLDER_VERSION]: "Before applying layouts changed in an older version",
  [COLOURS_FROM_OLDER_VERSION]: "Before applying colors changed in an older version",
};

export function causeLabel(cause) {
  return _TITLES[cause];
}

export function whenText(ms) {
  if (!Number.isFinite(ms)) return "unknown date";
  const d = new Date(ms);

  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Every writer stores the sentence its row shows, so the fallback only meets a
// copy none of them made.
export function backupTitle(row) {
  const title = row && typeof row.title === "string" ? row.title.trim() : "";
  return title || "Backup";
}

export function backupRowLabel(row) {
  return `${backupTitle(row)}, ${whenText(row && row.created)}`;
}

// What putting a copy back undoes, recorded when the copy is taken: a load, the
// undo of a load, a restore, or the undo of a restore. A copy of either of the
// first two names the preset in `subject`.
const _UNDO_KINDS = ["load", "undid", "restore", "unrestored"];

export function undoKind(row) {
  return {
    kind: row && _UNDO_KINDS.includes(row.undo_kind) ? row.undo_kind : null,
    name: row && typeof row.subject === "string" ? row.subject.trim() : "",
  };
}

export function undoKindAfter(row) {
  return { load: "undid", undid: "load", restore: "unrestored", unrestored: "restore" }[undoKind(row).kind] || "restore";
}

// Read from the listing so the Undo line survives a reload. Only the newest copy
// is offered, since once anything newer exists putting an older one back no
// longer undoes the last action.
export function undoableCopy(rows) {
  const newest = (rows || []).find((r) => r && r.readable !== false);
  return newest && undoKind(newest).kind ? newest : null;
}

// A restored backup goes unnamed, since the new row's own date tells two such
// copies apart.
export function undoTitle(row) {
  const { kind, name } = undoKind(row);
  if (kind === "load" && name) return `Before undoing loading the preset "${name}"`;
  if (kind === "undid" && name) return `Before loading the preset "${name}" again`;
  return "Before restoring a backup";
}
