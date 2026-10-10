import { h } from "./sbg-core.js";
import { getSetting, storedSetting, saveSetting, deleteSetting, settingsUnread, orderedIds, keepUnshown } from "./sbg-settings-store.js";
import { initSortable } from "./sbg-sortable.js";
import { showSettingsUnread } from "./sbg-toast.js";
import { parseBindings, parseChunk, splitBindings, sameChunk, dropAuxclickOf, NAMED_KEYS, MOUSE_BUTTONS } from "./sbg-keybinds.js";
import { CLOSE_ICON, sizedIcon } from "./sbg-icons.js";
import { declaration, keyScope } from "./sbg-settings-catalog.js";
import { themeValueName } from "./sbg-theme-tokens.js";

export function settingChoiceLabel(id, value) {
  const choices = declaration(id)?.choices;
  const one = (v) => choices?.find(([c]) => String(c) === String(v))?.[1] ?? String(v);
  return Array.isArray(value) ? value.map(one).join(", ") : one(value);
}

export function settingDefault(id) {
  return declaration(id)?.def;
}

// The list an order row's switch sits in, to tell apart two switches that
// share a name.
export function settingGroup(id) {
  return declaration(id)?.group;
}

export function settingName(id) {
  return declaration(id)?.label || themeValueName(id) || id;
}

let _armedRow = null;

// Escape held this long cancels a recording, and a shorter tap binds it.
const _ESC_HOLD_MS = 500;

function chunkFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  let base;
  if (e.type === "pointerdown") {
    base = MOUSE_BUTTONS[e.button]?.name;
    if (!base) return null;
  } else {
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return null;
    // These name a class of keys instead of one key, so a binding to one would
    // fire on all of them. The row keeps waiting for another press.
    if (e.key === "Dead" || e.key === "Unidentified" || e.key === "Process") return null;
    base = NAMED_KEYS[e.key] || e.key;
  }
  return mods.concat(base).join("+");
}

function labelForChunk(raw) {
  const c = parseChunk(raw);
  if (!c) return raw;
  const parts = [];
  if (c.mods.ctrl) parts.push("Ctrl");
  if (c.mods.alt) parts.push("Alt");
  if (c.mods.shift) parts.push("Shift");
  if (c.mods.meta) parts.push("Meta");
  if (c.button !== null) parts.push(MOUSE_BUTTONS[c.button]?.label || "Mouse");
  else parts.push(NAMED_KEYS[c.key] || _KEY_LABELS[c.key] || (c.key.length === 1 ? c.key.toUpperCase() : c.key));
  return parts.join(" + ");
}

const _KEY_LABELS = { ArrowLeft: "Left arrow", ArrowRight: "Right arrow", ArrowUp: "Up arrow", ArrowDown: "Down arrow", Escape: "Esc" };

export const keysText = (binding) => splitBindings(binding).map(labelForChunk).join(", ");

export function titleWithKeys(title, binding) {
  const keys = keysText(binding);
  return keys ? `${title} (${keys})` : title;
}

export function sectionTitle(container, text, tooltip) {
  const form = container.closest(".sbg-gs-form") || container;
  const gap = form.querySelector(".sbg-gs-section-title") ? " sbg-gs-section-title--gap" : "";
  const el = h("div", { class: "sbg-gs-section-title" + gap, text });
  if (tooltip) el.title = tooltip;
  container.appendChild(el);
}

let _fieldSeq = 0;

export function nameField(name, input) {
  if (input.tagName !== "INPUT" && input.tagName !== "SELECT") return;
  if (!input.getAttribute("id")) input.setAttribute("id", "sbg-gs-field-" + ++_fieldSeq);
  name.setAttribute("for", input.getAttribute("id"));
}

export function settingRow(label, input, tooltip) {
  const row = h("div", { class: "sbg-gs-row", title: tooltip || undefined });
  const name = h("label", { class: "sbg-gs-label", text: label });
  nameField(name, input);
  row.append(name, input);
  return row;
}

export function toggle(id, tooltip, callback) {
  const { label } = declaration(id);
  const cb = h("input", { type: "checkbox", class: "sbg-gs-switch" });
  cb.checked = getSetting(id);
  cb.addEventListener("change", () => {
    saveSetting(id, cb.checked);
    if (callback) callback(cb.checked);
  });
  return settingRow(label, cb, tooltip);
}

export function orderList(orderId, entries) {
  const { label } = declaration(orderId);
  const list = h("div", { class: "sbg-gs-orderlist", role: "list", "aria-label": label });
  const byId = new Map(entries.map(e => [e.id, e]));
  for (const id of orderedIds(orderId, entries.map(e => e.id))) {
    const e = byId.get(id);
    const row = h("div", { class: "sbg-gs-row sbg-gs-orderrow", role: "listitem", "data-id": e.id });
    const grip = h("span", { class: "sbg-grip sbg-gs-ordergrip", text: "⋮⋮", title: "Drag to reorder", "aria-hidden": "true" });
    const cb = h("input", { type: "checkbox", class: "sbg-gs-switch" });
    cb.checked = getSetting(e.show);
    cb.addEventListener("change", () => saveSetting(e.show, cb.checked));
    const name = h("label", { class: "sbg-gs-label", text: e.label });
    nameField(name, cb);
    row.append(grip, name, cb);
    list.appendChild(row);
    initSortable(list, grip, row, {
      itemSelector: ".sbg-gs-orderrow",
      onDrop: () => {
        if (settingsUnread()) {
          showSettingsUnread();
          return;
        }
        const known = new Set(entries.map(e => e.id));
        saveSetting(orderId, keepUnshown(storedSetting(orderId), [...list.children].map(r => r.dataset.id), id => known.has(id)));
      },
    });
  }
  return list;
}

const _keyRows = new Set();
// A change on one row can start or end a clash on another, so every row
// redraws.
function _rerenderKeyRows() {
  for (const entry of [..._keyRows]) {
    if (!entry.list.isConnected) { _keyRows.delete(entry); continue; }
    entry.render();
  }
}

const _ADD = ".sbg-key-btn--add";
const _CANCEL = ".sbg-key-btn--cancel";
const _ARMED = ".sbg-key--armed";

export function keyInput(spec, peers, cleanups) {
  const { id, label, tip } = spec;
  const list = h("div", { class: "sbg-gs-keys" });
  const row = settingRow(label, list, tip);

  const read = () => splitBindings(getSetting(id));

  const write = (chunks) => { saveSetting(id, chunks.join(",")); _rerenderKeyRows(); };

  // A render replaces every button in the row, so focus that was in it moves
  // to the button named.
  const redraw = (update, focusOn) => {
    const had = list.contains(document.activeElement);
    update();
    if (had) list.querySelector(focusOn)?.focus();
  };

  let armed = false;
  let detach = null;

  function clashesFor(chunk) {
    const mine = parseChunk(chunk);
    const out = [];
    for (const peer of peers) {
      if (peer.id === id || keyScope(peer.id) !== keyScope(id)) continue;
      const theirs = parseBindings(getSetting(peer.id));
      if (theirs.some(o => sameChunk(mine, o))) out.push(peer.label);
    }
    return out;
  }

  function stopListening() {
    armed = false;
    if (_armedRow === disarm) _armedRow = null;
    if (detach) { detach(); detach = null; }
  }

  function disarm() {
    if (!armed) return;
    redraw(() => { stopListening(); render(); }, _ADD);
  }

  function commit(chunk) {
    const chunks = read();
    const parsed = parseChunk(chunk);
    if (!chunks.some(c => sameChunk(parseChunk(c), parsed))) chunks.push(chunk);
    redraw(() => { stopListening(); write(chunks); }, _ADD);
  }

  function arm() {
    if (armed) return;
    if (_armedRow) _armedRow();
    armed = true;
    _armedRow = disarm;

    let escTimer = null;
    let escChunk = null;

    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Escape is both bindable and the way out, so its commit waits for the
      // keyup that says the press was a tap.
      if (e.key === "Escape") {
        if (escTimer !== null || e.repeat) return;
        escChunk = chunkFromEvent(e);
        escTimer = setTimeout(() => { escTimer = null; disarm(); }, _ESC_HOLD_MS);
        return;
      }
      const chunk = chunkFromEvent(e);
      if (chunk) commit(chunk);
    };
    const onKeyUp = (e) => {
      if (e.key !== "Escape" || escTimer === null) return;
      clearTimeout(escTimer);
      escTimer = null;
      e.preventDefault();
      e.stopPropagation();
      commit(escChunk);
    };
    // The gallery's mouse bindings act on the press, or on the auxclick of a
    // release when no press reached them, so the recorder takes the press on
    // the way down and drops the auxclick that follows it.
    const onPointer = (e) => {
      // A click on the row's own Cancel or remove button works that button.
      if (list.contains(e.target)) return;
      const chunk = chunkFromEvent(e);
      if (!chunk) { disarm(); return; }
      e.preventDefault();
      e.stopPropagation();
      dropAuxclickOf(e.button);
      commit(chunk);
    };
    // Captured, so a press reaches the recorder before the settings panel's Escape
    // handler or the control under the pointer.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("pointerdown", onPointer, true);
    detach = () => {
      if (escTimer !== null) { clearTimeout(escTimer); escTimer = null; }
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
    // The recorder takes every key, so focus waits on the chip asking for one.
    // With focus on Cancel, an Enter or Space meant to press it would be bound.
    redraw(render, _ARMED);
  }

  function render() {
    list.innerHTML = "";
    const chunks = read();
    chunks.forEach((chunk, i) => {
      const text = labelForChunk(chunk);
      const clash = clashesFor(chunk);
      const chip = h("span", {
        class: clash.length ? "sbg-key sbg-key--clash" : "sbg-key",
        title: clash.length ? "Also bound to " + clash.join(", ") : "",
      }, [h("span", { text })]);
      const del = h("button", {
        type: "button", class: "sbg-key__x", html: sizedIcon(CLOSE_ICON, 10),
        "aria-label": `Remove ${text} from ${label}`,
      });
      del.addEventListener("click", () => redraw(() => write(chunks.filter((_, j) => j !== i)), armed ? _CANCEL : _ADD));
      chip.appendChild(del);
      list.appendChild(chip);
    });

    if (armed) {
      list.appendChild(h("span", {
        class: "sbg-key sbg-key--armed", text: "Press a key or mouse button",
        title: "Tap Escape to bind it, or hold Escape to cancel", tabindex: "-1",
      }));
      const cancel = h("button", {
        type: "button", class: "sbg-key-btn sbg-key-btn--cancel", text: "Cancel",
        "aria-label": `Cancel adding a key for ${label}`,
      });
      cancel.addEventListener("click", disarm);
      list.appendChild(cancel);
      return;
    }

    const add = h("button", {
      type: "button", class: "sbg-key-btn sbg-key-btn--add", text: "+ Add",
      "aria-label": `Add a key for ${label}`,
    });
    add.addEventListener("click", arm);
    list.appendChild(add);
    // A binding stored equal to its default still holds off a later change to
    // the default, so Reset shows until the setting is forgotten.
    if (storedSetting(id) !== undefined) {
      const reset = h("button", {
        type: "button", class: "sbg-key-btn", text: "Reset",
        title: "Back to the default binding", "aria-label": `Reset ${label}`,
      });
      reset.addEventListener("click", () => redraw(() => { deleteSetting(id); _rerenderKeyRows(); }, _ADD));
      list.appendChild(reset);
    }
  }

  render();
  _keyRows.add({ list, render });

  cleanups.push(disarm);
  return row;
}

export function comboInput(id, tooltip) {
  const { label, choices } = declaration(id);
  const sel = h("select", { class: "sbg-gs-select" }, choices.map(([value, text]) => h("option", { value, text })));
  sel.value = getSetting(id);
  sel.addEventListener("change", () => saveSetting(id, sel.value));
  return settingRow(label, sel, tooltip);
}

// A box left empty, or holding no number, clears the setting back to its default.
export function numberInput(id, tooltip, callback) {
  const d = declaration(id);
  const { min, max, step } = d.range;
  const inp = h("input", { type: "number", class: "sbg-gs-input", min, max, step, value: String(getSetting(id)) });
  inp.addEventListener("change", () => {
    const typed = inp.value.trim() === "" ? NaN : Number(inp.value);
    let n = d.def;
    if (Number.isFinite(typed)) {
      // toFixed(10) drops the float error a step such as 0.1 leaves behind.
      n = Math.min(max, Math.max(min, Number((step ? Math.round(typed / step) * step : Math.round(typed)).toFixed(10))));
      saveSetting(id, n);
    } else {
      deleteSetting(id);
    }
    inp.value = String(n);
    if (callback) callback(n);
  });
  return settingRow(d.label, inp, tooltip);
}
