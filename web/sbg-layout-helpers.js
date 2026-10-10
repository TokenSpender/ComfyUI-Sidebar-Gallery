import { h } from "./sbg-core.js";
import { uid } from "./sbg-translation-layer.js";

const SECTION_STYLE_LABELS = { flat: "List", cards: "Cards", text: "Text", nodes: "Workflow nodes", raw: "Raw metadata" };
export const SECTION_STYLES = Object.keys(SECTION_STYLE_LABELS);
export const sectionStyleLabel = (s) => SECTION_STYLE_LABELS[s] || s;

// A Workflow nodes or Raw metadata section draws its own content, and a field
// moved into a hidden section would stop showing.
export const canHoldFields = (s) => s.style !== "nodes" && s.style !== "raw" && !s.hidden;

export function newSection(title, params) {
  return { id: uid(), title, style: "flat", open: true, params };
}

export function mkSelect(values, current, onChange, labelFor, attrs = {}) {
  const sel = h("select", { class: "sbg-gs-select--xs", ...attrs },
    values.map((v) => h("option", { value: v, text: labelFor(v), selected: v === current ? "" : undefined })));
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}
