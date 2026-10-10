import { h, lsGet, lsSet } from "./sbg-core.js";
import { B } from "./sbg-settings-store.js";
import * as TL from "./sbg-translation-layer.js";
import { CHEVRON_RIGHT_ICON, sizedIcon } from "./sbg-icons.js";

const _PANEL_COLLAPSE_KEY = B.PANEL_COLLAPSED;
function _collapsedSet() {
  try { return new Set(JSON.parse(lsGet(_PANEL_COLLAPSE_KEY)) || []); }
  catch { return new Set(); }
}

// `still` draws the head as a picture of itself, for the Theme tab's sample,
// where it neither toggles nor takes the keyboard.
export function makeSection(section, contentEl, { remember = true, still = false } = {}) {
  const title = section.title || "";
  const collapsed = remember ? _collapsedSet() : null;
  const isOpen = collapsed && collapsed.has(title) ? false : (section.open !== false);

  const chevron = h("span", { class: "sbg-section__chevron", html: sizedIcon(CHEVRON_RIGHT_ICON, 10) });
  const sec = h("div", { class: `sbg-section${isOpen ? " sbg-section--open" : ""}` });
  const body = h("div", { class: "sbg-section__body" }, [contentEl]);
  const parts = [h("span", { text: title }), chevron];
  const head = still
    ? h("div", { class: "sbg-section__head" }, parts)
    : h("button", { type: "button", class: "sbg-section__head", "aria-expanded": String(isOpen) }, parts);
  if (!still) head.addEventListener("click", () => {
    const open = !sec.classList.contains("sbg-section--open");
    sec.classList.toggle("sbg-section--open", open);
    head.setAttribute("aria-expanded", String(open));
    if (open) TL.sizePromptBoxes(body);
    if (!remember) return;
    const set = _collapsedSet();
    if (open) set.delete(title);
    else set.add(title);
    lsSet(_PANEL_COLLAPSE_KEY, JSON.stringify([...set]));
  });
  sec.appendChild(head);
  sec.appendChild(body);

  if (title) {
    // The stylesheet colours the Positive and Negative Prompt sections by this title.
    sec.dataset.sectionTitle = title;
  }

  if (section.color) TL.applySectionColor(sec, section.color);
  return sec;
}
