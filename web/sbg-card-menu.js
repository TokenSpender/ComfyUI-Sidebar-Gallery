import { h } from "./sbg-core.js";
import { S, getSetting, orderedIds } from "./sbg-settings-store.js";
import { CARD_MENU_ITEMS } from "./sbg-settings-catalog.js";
import { showFailure, confirmClick } from "./sbg-toast.js";
import { fileUrl } from "./sbg-media-kind.js";
import { summaryOf, fetchFullMeta } from "./sbg-meta-cache.js";
import { deleteFile, copyPrompt, copyWorkflow, loadWorkflowFrom } from "./sbg-file-actions.js";
import { isFavorite, toggleFavorite, favoriteTitle } from "./sbg-favorites.js";

let _menu = null;
let _cleanup = null;
let _opener = null;

export function closeCardMenu() {
  if (_cleanup) { _cleanup(); _cleanup = null; }
  if (_menu) { _menu.remove(); _menu = null; }
  const back = _opener;
  _opener = null;
  if (back && back.isConnected && back.focus) { try { back.focus(); } catch { } }
}

function _item(label, onClick, cls = "") {
  const b = h("button", { type: "button", class: "sbg-card-menu__item" + (cls ? " " + cls : ""), role: "menuitem", tabindex: "-1", text: label });
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function _wireMenuKeys(menu) {
  menu.addEventListener("keydown", (ev) => {
    const list = [...menu.children].filter(el => !el.disabled);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    let next = -1;
    if (ev.key === "ArrowDown") next = (i + 1) % list.length;
    else if (ev.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = list.length - 1;
    else if (ev.key === "Tab") { ev.preventDefault(); closeCardMenu(); return; }
    else return;
    ev.preventDefault();
    ev.stopPropagation();
    list[next].focus();
  });
}

// Answers null when every item is hidden, so the grid leaves the browser's own
// menu in place.
export function openCardMenu(e, it) {
  closeCardMenu();
  const shown = CARD_MENU_ITEMS.filter(m => getSetting(m.show)).map(m => m.id);
  const ids = orderedIds(S.CARD_MENU_ORDER, CARD_MENU_ITEMS.map(m => m.id)).filter(id => shown.includes(id));
  if (!ids.length) return null;
  const menu = h("div", { class: "sbg-card-menu", role: "menu", tabindex: "-1", "aria-label": `Actions for ${it.filename}` });

  const fav = _item(favoriteTitle(isFavorite(it.root_id, it.relpath)), () => {
    toggleFavorite(it.root_id, it.relpath);
    closeCardMenu();
  });

  const dl = h("a", { class: "sbg-card-menu__item", role: "menuitem", tabindex: "-1", href: fileUrl(it), download: it.filename, target: "_blank", text: "Download" });
  dl.addEventListener("click", () => closeCardMenu());

  const copyPromptItem = _item("Copy Prompt", null);
  copyPromptItem.disabled = true;

  const copyWf = _item("Copy Workflow", async () => {
    copyWf.textContent = "Loading…";
    try {
      copyWorkflow(await fetchFullMeta(it));
    } catch (err) {
      showFailure("copy the workflow", err);
    } finally {
      closeCardMenu();
    }
  });

  const loadWf = _item("Load Workflow", async () => {
    loadWf.textContent = "Loading…";
    try {
      await loadWorkflowFrom(await fetchFullMeta(it));
    } catch (err) {
      showFailure("load the workflow", err);
    } finally {
      closeCardMenu();
    }
  });

  const del = _item("Delete", null, "sbg-card-menu__item--danger");
  const runDelete = async () => {
    del.disabled = true;
    await deleteFile(it);
    closeCardMenu();
  };
  if (getSetting(S.DELETE_CONFIRM)) confirmClick(del, runDelete);
  else del.addEventListener("click", runDelete);

  const byId = { favorite: fav, download: dl, "copy-prompt": copyPromptItem, "copy-wf": copyWf, "load-wf": loadWf, delete: del };
  for (const id of ids) menu.appendChild(byId[id]);
  _wireMenuKeys(menu);
  document.body.appendChild(menu);
  _menu = menu;
  _opener = document.activeElement || null;

  if (ids.includes("copy-prompt")) {
    summaryOf(it).then((m) => {
      if (_menu !== menu || !m.summary.positive_prompt) return;
      copyPromptItem.disabled = false;
      copyPromptItem.addEventListener("click", () => { copyPrompt(m.summary); closeCardMenu(); });
    }).catch((err) => {
      // Left disabled, the item would pass a failed read off as a file with no
      // prompt, so it says why when clicked.
      if (_menu !== menu) return;
      copyPromptItem.disabled = false;
      copyPromptItem.addEventListener("click", () => { showFailure("copy the prompt", err); closeCardMenu(); });
    });
  }

  const pad = 6;
  const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - pad);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - pad);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
  // Copy Prompt is disabled until its summary arrives, and a disabled button takes no focus.
  ([...menu.children].find(el => !el.disabled) || menu).focus();

  const onDown = (ev) => { if (!menu.contains(ev.target)) closeCardMenu(); };
  const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); closeCardMenu(); } };
  const onScroll = () => closeCardMenu();

  // Attached on the next turn so the press that opened the menu cannot close it.
  // It listens for pointerdown because the graph canvas cancels that, which
  // stops the browser sending a mousedown for a click there.
  const t = setTimeout(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  }, 0);
  _cleanup = () => {
    clearTimeout(t);
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", onScroll, true);
  };
  return menu;
}
