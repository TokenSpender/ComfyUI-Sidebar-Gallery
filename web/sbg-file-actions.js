import { app } from "../../scripts/app.js";
import { apiPost, pj, loadWorkflow } from "./sbg-core.js";
import { showToast, showFailure, copyText } from "./sbg-toast.js";
import { modifiedTime } from "./sbg-media-kind.js";

/** A file the server says is already gone from disk is announced as deleted
 *  too, so the gallery drops its card. */
export async function deleteFile(it) {
  try {
    // The file the card showed, since a new one can take a deleted one's name.
    const data = await apiPost("/sidebar_gallery/delete",
      { root_id: it.root_id, relpath: it.relpath, mtime: modifiedTime(it), size: it.size });
    showToast(`Moved to ${data.where || "the trash"}`);
  } catch (e) {
    showFailure("delete the file", e);
    if (!e.data?.gone) return;
  }
  document.dispatchEvent(new CustomEvent("sbg-file-deleted", { detail: { root_id: it.root_id, relpath: it.relpath } }));
}

export function copyPrompt(summary) {
  const p = summary.positive_prompt;
  if (p) copyText(typeof p === "string" ? p : pj(p), "Prompt copied.");
}

// A file with no workflow is the file's nature and no failure, so it is told
// in the accent color.
const NO_WORKFLOW = "This file has no workflow.";

export function copyWorkflow(meta) {
  if (meta.workflow) copyText(typeof meta.workflow === "string" ? meta.workflow : pj(meta.workflow), "Workflow copied.");
  else showToast(NO_WORKFLOW);
}

/** Answers whether the file had a workflow to hand to ComfyUI, whether or not
 *  ComfyUI could build it. The graph it builds is the confirmation, so a load
 *  that worked says nothing. */
export async function loadWorkflowFrom(meta) {
  if (!meta.workflow) {
    showToast(NO_WORKFLOW);
    return false;
  }
  await loadWorkflow(app, meta.workflow);
  return true;
}
