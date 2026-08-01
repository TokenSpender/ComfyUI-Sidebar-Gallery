/**
 * sbg-keybinds.js: parsing and matching for keyboard and mouse bindings.
 *
 * Pure module with no DOM access, so binding semantics are unit-testable in
 * isolation. A binding string is a comma-separated list of chunks. Each chunk
 * is a key name ("ArrowLeft", "a", "="), a mouse token ("MiddleClick",
 * "Mouse4", "Mouse5"), or a combo joining modifier names with a plus sign
 * ("Shift+ArrowLeft", "Ctrl+MiddleClick"). Key names match
 * case-insensitively. Two keys clash with the syntax itself and have named
 * spellings: the comma key is written "Comma" (a bare "," is also accepted,
 * since it splits into empty chunks otherwise) and the plus key is written
 * "Plus" (or as the final character of its chunk, so "Shift++" also reads
 * as Shift held with the plus key).
 *
 * Matching runs in two passes so a combo always beats a bare binding for the
 * same key: callers try matchExplicit() across every action first, then
 * matchBare(). A bare chunk never fires while Ctrl, Alt, or Meta is held; its
 * treatment of Shift is the caller's choice via the mods policy ("shift"
 * tolerates it so capital letters keep matching, "none" rejects any modifier,
 * "any" ignores modifier state entirely).
 */

const _MOD_NAMES = {
  shift: "shift", ctrl: "ctrl", control: "ctrl",
  alt: "alt", meta: "meta", cmd: "meta",
};

// Binding token keyed to MouseEvent.button: middle wheel press is 1, the
// browser "back" side button is 3, the "forward" side button is 4.
const _MOUSE_BUTTONS = { middleclick: 1, mouse4: 3, mouse5: 4 };

// Named spellings for keys the binding syntax reserves: "," separates
// chunks and "+" joins modifiers.
const _KEY_ALIASES = { comma: ",", plus: "+" };

/** Parse one binding chunk. Returns { key, button, mods, explicit } where
 *  exactly one of key/button is set, or null for an empty chunk. */
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
  const button = _MOUSE_BUTTONS[rest.toLowerCase()];
  if (button !== undefined) return { key: null, button, mods, explicit };
  return { key: _KEY_ALIASES[rest.toLowerCase()] || rest, button: null, mods, explicit };
}

/** Parse a comma-separated binding string into chunk objects. A binding
 *  that is exactly "," reads as the comma key: the comma splits into empty
 *  chunks and would otherwise be impossible to bind. */
export function parseBindings(str) {
  const raw = String(str || "");
  if (raw.trim() === ",") return [parseChunk("Comma")];
  return raw.split(",").map(parseChunk).filter(Boolean);
}

/** Normalize a KeyboardEvent into a matchable descriptor. */
export function descFromKeyEvent(e) {
  return {
    key: e.key, button: null,
    shift: !!e.shiftKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, meta: !!e.metaKey,
  };
}

/** Normalize a MouseEvent into a matchable descriptor. Carries the pointer
 *  position so actions like reset zoom can aim at the clicked pane. */
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

/** True when any chunk WITH explicit modifiers matches the descriptor.
 *  Explicit chunks require the exact modifier state they name: unlisted
 *  modifiers must be up. */
export function matchExplicit(binding, desc) {
  return parseBindings(binding).some((c) => c.explicit && _chunkTargets(c, desc)
    && c.mods.shift === !!desc.shift && c.mods.ctrl === !!desc.ctrl
    && c.mods.alt === !!desc.alt && c.mods.meta === !!desc.meta);
}

/** True when any chunk WITHOUT explicit modifiers matches the descriptor
 *  under the given mods policy ("shift", "none", or "any"). */
export function matchBare(binding, desc, mods = "shift") {
  if (mods !== "any" && (desc.ctrl || desc.alt || desc.meta)) return false;
  if (mods === "none" && desc.shift) return false;
  return parseBindings(binding).some((c) => !c.explicit && _chunkTargets(c, desc));
}

/** Single-action convenience: explicit or bare match. Sites with several
 *  actions should run their own two-pass loop so combos win across actions. */
export function matchAny(binding, desc, mods = "shift") {
  return matchExplicit(binding, desc) || matchBare(binding, desc, mods);
}
