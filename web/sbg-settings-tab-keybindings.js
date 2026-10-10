import { h } from "./sbg-core.js";
import { sectionTitle, keyInput } from "./sbg-settings-inputs.js";
import { KEYBIND_GROUPS } from "./sbg-settings-catalog.js";

// Every row gets every action, since a clash can cross groups within a scope,
// and the row itself skips the actions in the other scope.
const ALL_KEYS = KEYBIND_GROUPS.flatMap(g => g.keys);

export function renderKeybindings({ content, visitCleanups }) {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Click Add, then press a key or mouse button. Click the cross on a key to remove it. A tap of Escape binds Escape, and holding it cancels." }));

  for (const group of KEYBIND_GROUPS) {
    sectionTitle(wrap, group.title);
    if (group.desc) wrap.appendChild(h("div", { class: "sbg-gs-desc", text: group.desc }));
    for (const spec of group.keys) wrap.appendChild(keyInput(spec, ALL_KEYS, visitCleanups));
  }

  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "In fullscreen video outside compare, Previous File and Next File skip a tenth of the video instead of changing the file." }));
  content.appendChild(wrap);
}
