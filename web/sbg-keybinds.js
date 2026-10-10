const _MOD_NAMES = {
  shift: "shift", ctrl: "ctrl", control: "ctrl",
  alt: "alt", meta: "meta", cmd: "meta",
};

// Keyed by `MouseEvent.button`, each with the name a binding stores and the
// one the Keybindings tab shows.
export const MOUSE_BUTTONS = {
  1: { name: "MiddleClick", label: "Middle click" },
  3: { name: "Mouse4", label: "Mouse 4" },
  4: { name: "Mouse5", label: "Mouse 5" },
};
const _BUTTON_OF_NAME = Object.fromEntries(
  Object.entries(MOUSE_BUTTONS).map(([b, m]) => [m.name.toLowerCase(), Number(b)]));

// A binding separates its chunks with commas and joins modifiers with a plus,
// so those two keys and the invisible space are written by name.
export const NAMED_KEYS = { ",": "Comma", "+": "Plus", " ": "Space" };
const _KEY_ALIASES = Object.fromEntries(
  Object.entries(NAMED_KEYS).map(([ch, name]) => [name.toLowerCase(), ch]));

export function parseChunk(raw) {
  const chunk = String(raw || "").trim();
  if (!chunk) return null;
  const mods = { shift: false, ctrl: false, alt: false, meta: false };
  let explicit = false;
  let rest = chunk;
  for (; ;) {
    const m = /^([A-Za-z]+)\+(.+)$/.exec(rest);
    const mod = m && _MOD_NAMES[m[1].toLowerCase()];
    if (!mod) break;
    mods[mod] = true;
    explicit = true;
    rest = m[2];
  }
  const button = _BUTTON_OF_NAME[rest.toLowerCase()];
  if (button !== undefined) return { key: null, button, mods, explicit };
  return { key: _KEY_ALIASES[rest.toLowerCase()] || rest, button: null, mods, explicit };
}

export function splitBindings(str) {
  const raw = String(str || "");
  // A binding of one comma is the comma key itself.
  if (raw.trim() === ",") return ["Comma"];
  return raw.split(",").map(c => c.trim()).filter(Boolean);
}

export function parseBindings(str) {
  return splitBindings(str).map(parseChunk).filter(Boolean);
}

export function descFromKeyEvent(e) {
  return {
    key: e.key, button: null,
    shift: !!e.shiftKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, meta: !!e.metaKey,
  };
}

export function descFromMouseEvent(e) {
  return {
    key: null, button: e.button,
    shift: !!e.shiftKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, meta: !!e.metaKey,
    x: e.clientX, y: e.clientY,
  };
}

function _chunkTargets(chunk, desc) {
  if (chunk.button !== null) return desc.button === chunk.button;
  if (desc.key == null || chunk.key == null) return false;
  return chunk.key.toLowerCase() === desc.key.toLowerCase();
}

function _sameMods(mods, other) {
  return mods.shift === !!other.shift && mods.ctrl === !!other.ctrl
    && mods.alt === !!other.alt && mods.meta === !!other.meta;
}

export function sameChunk(a, b) {
  return !!a && !!b && _chunkTargets(a, b) && _sameMods(a.mods, b.mods);
}

export function matchExplicit(binding, desc) {
  return parseBindings(binding).some((c) => c.explicit && _chunkTargets(c, desc) && _sameMods(c.mods, desc));
}

export function matchBare(binding, desc, mods = "shift") {
  if (mods !== "any" && (desc.ctrl || desc.alt || desc.meta)) return false;
  if (mods === "none" && desc.shift) return false;
  return parseBindings(binding).some((c) => !c.explicit && _chunkTargets(c, desc));
}

const _RANGE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function focusOwnsKey(t, key) {
  if (!t) return false;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return true;
  if (t.tagName === "INPUT") return t.type === "range" && key != null ? _RANGE_KEYS.has(key) : true;
  return false;
}

// A press a binding took on pointerdown still sends an auxclick on release, and
// one inside this window is dropped as that same press.
const AUX_DEDUPE_MS = 800;

function _swallow(e) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

/** Drops the auxclick of a press already taken on pointerdown, for a listener
 *  that stops listening before the button comes back up. */
export function dropAuxclickOf(button) {
  const at = performance.now();
  const onAux = (e) => {
    document.removeEventListener("auxclick", onAux, true);
    if (e.button === button && performance.now() - at < AUX_DEDUPE_MS) _swallow(e);
  };
  document.addEventListener("auxclick", onAux, true);
}

/**
 * Offers presses of the middle and side buttons to `dispatch`. Over a video,
 * Firefox's own controls eat the pointer events and only the auxclick arrives,
 * so both are listened to and the auxclick of a press already taken is dropped.
 * @param {(e: MouseEvent, desc: object) => boolean} dispatch - whether a binding took the press
 * @param {object} [opts]
 * @param {boolean} [opts.capture] - listen on the way down and stop a taken
 *   press and its auxclick there, so nothing under the listener sees them
 */
export function wireMouseBindings(dispatch, { capture = false } = {}) {
  let taken = { button: -1, t: 0 };
  const stop = (e) => { if (capture) _swallow(e); };
  const offered = (e) => e.button !== 0 && e.button !== 2 && !focusOwnsKey(e.target);
  const onDown = (e) => {
    if (!offered(e) || !dispatch(e, descFromMouseEvent(e))) return;
    taken = { button: e.button, t: performance.now() };
    stop(e);
  };
  const onAux = (e) => {
    if (!offered(e)) return;
    const dupe = e.button === taken.button && performance.now() - taken.t < AUX_DEDUPE_MS;
    taken = { button: -1, t: 0 };
    if (dupe || dispatch(e, descFromMouseEvent(e))) stop(e);
  };
  document.addEventListener("pointerdown", onDown, capture);
  document.addEventListener("auxclick", onAux, capture);
  return () => {
    document.removeEventListener("pointerdown", onDown, capture);
    document.removeEventListener("auxclick", onAux, capture);
  };
}

// Answers for one binding on its own. A caller holding several actions has to
// try every explicit binding across all of them before any bare one, or a
// modified press fires the action bound to the bare key.
export function matchAny(binding, desc, mods = "shift") {
  return matchExplicit(binding, desc) || matchBare(binding, desc, mods);
}
