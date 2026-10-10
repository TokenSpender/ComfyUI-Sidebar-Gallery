import { h } from "./sbg-core.js";
import { checkerBg, cleanColorValue } from "./sbg-color.js";
import { trapFocus, setSelectedTab, wireTablistKeys } from "./sbg-a11y.js";
import { createColorPicker } from "./sbg-color-picker.js";

const ALL_CHANNELS = ["bg", "text", "border"];

export function paintSwatch(el, colors, defaults, channels = ALL_CHANNELS) {
  const co = (colors && typeof colors === "object") ? colors : {};
  const d = defaults || {};
  // A stored colour can come from a preset or a restored copy, and it is written
  // into an inline style, so it is cleaned first.
  const chan = (k) => cleanColorValue(co[k]) || d[k] || "";
  el.textContent = "";

  const stripe = (c) => h("span", { style: `flex:1;min-width:0;background:${c ? checkerBg(c) : "transparent"};` });
  el.appendChild(h("span", { class: "sbg-swatch" }, channels.map(k => stripe(chan(k)))));
}

let _open = null;

// Escape and Reset to default discard what was typed, and every other way out
// keeps it.
export function closePopovers({ commit = true } = {}) {
  const open = _open;
  if (!open) return;
  _open = null;
  if (commit) open.commit(); else open.discard();
  open.close();
}

export function placePopover(pop, anchor, openLeft, { commit = () => {}, discard = () => {} } = {}) {
  document.body.appendChild(pop);

  // Mounted on the body, outside the settings panel's focus trap, so it needs
  // one of its own.
  const releaseTrap = trapFocus(pop);
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closePopovers({ commit: false }); }
  });
  const clamp = () => {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 240, ph = pop.offsetHeight || 300;
    let left = openLeft ? (r.left - pw - 6) : r.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    if (top < 8) top = 8;
    pop.style.left = left + "px"; pop.style.top = top + "px";
  };
  clamp();
  // The caller may still be filling the popover, so the position is taken again
  // once its final size is known.
  requestAnimationFrame(clamp);
  const onDown = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closePopovers();
  };

  const armTimer = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
  _open = {
    commit,
    discard,
    close: () => {
      clearTimeout(armTimer);
      document.removeEventListener("mousedown", onDown);
      releaseTrap();
      pop.remove();
    },
  };
}

export function openColorPopover(anchor, { channels, colors, onChange, onClear, openLeft = true }) {
  closePopovers();
  const pop = h("div", { class: "sbg-popover" });
  let active = channels[0].key, picker = null;
  const mount = h("div", {});
  const clearRow = h("div", { class: "sbg-popover__clear" });

  function refreshClear() {
    // Pressing Reset to default blurs the colour field, whose change lands here
    // before the click does, so a button still wanted stays the same element
    // for the click to reach.
    const want = !!onClear && channels.some(c => colors()[c.key]);
    if (want === !!clearRow.firstChild) return;
    clearRow.innerHTML = "";
    if (!want) return;
    const clr = h("button", { class: "sbg-btn sbg-btn--sm", text: "Reset to default" });
    clr.addEventListener("click", () => { onClear(); closePopovers({ commit: false }); });
    clearRow.appendChild(clr);
  }
  function mountPicker() {
    mount.innerHTML = "";
    const ch = channels.find(c => c.key === active);
    picker = createColorPicker({ initialColor: colors()[active] || ch.def, onChange: (color) => { onChange(active, color); refreshClear(); } });
    mount.appendChild(picker.panel); picker.init();
  }
  if (channels.length > 1) {
    const tabs = channels.map(({ key, label }) => h("button", { type: "button", class: "sbg-btn sbg-btn--sm", role: "tab", text: label, "data-channel": key }));
    const select = (tab) => {
      active = tab.getAttribute("data-channel");
      setSelectedTab(tabs, tab);
      for (const t of tabs) t.classList.toggle("sbg-btn--accent", t === tab);
      mountPicker();
    };
    for (const t of tabs) t.addEventListener("click", () => select(t));
    setSelectedTab(tabs, tabs[0]);
    tabs[0].classList.add("sbg-btn--accent");
    wireTablistKeys(tabs, select);
    pop.appendChild(h("div", { class: "sbg-btn-row", role: "tablist", "aria-label": "Which color" }, tabs));
  }
  refreshClear();

  pop.appendChild(mount); pop.appendChild(clearRow);
  placePopover(pop, anchor, openLeft, { commit: () => picker.commit(), discard: () => picker.discard() });
  mountPicker();
  return pop;
}
