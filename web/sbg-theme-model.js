import { parseColor, resolveColor, formatRgba, dimInk, cleanColorValue, mix, lumOf, contrast, textOn, accentInk } from "./sbg-color.js";
import { S, idsOfClass } from "./sbg-settings-store.js";

// A theme's values are keyed by setting id, or by CSS variable for a token no
// setting reads. A base colour left unset follows ComfyUI's own palette.
export const BASE_COLORS = Object.freeze([
  { key: S.CUSTOM_BG, cssVar: "--sbg-bg", label: "Background", tip: "The gallery's background" },
  { key: S.CUSTOM_SURFACE, cssVar: "--sbg-surface", label: "Surface", tip: "Background of cards, dropdowns and input boxes" },
  { key: S.CUSTOM_BORDER, cssVar: "--sbg-border", label: "Border", tip: "Borders and dividers" },
  { key: S.CUSTOM_TEXT, cssVar: "--sbg-text", label: "Text", tip: "Main text color" },
  { key: S.CUSTOM_ACCENT, cssVar: "--sbg-accent", label: "Accent", tip: "Primary accent color" },
]);
const BG = S.CUSTOM_BG, SURFACE = S.CUSTOM_SURFACE, BORDER = S.CUSTOM_BORDER, TEXT = S.CUSTOM_TEXT, ACCENT = S.CUSTOM_ACCENT;

export function isBaseColor(id) {
  return BASE_COLORS.some(c => c.key === id);
}

const RELEASED_CUSTOM_DEFAULTS = Object.freeze({ [BG]: "#1a1a1a", [SURFACE]: "#222222", [BORDER]: "#444444", [TEXT]: "#e0e0e0", [ACCENT]: "#7c6aef" });

// Computed from the base colours unless a theme names them itself.
export const DERIVED_TOKENS = [
  "--sbg-surface-hover",
  "--sbg-text-dim",
  "--sbg-border-hover",
  "--sbg-accent-glow",
  "--sbg-on-accent",
  "--sbg-accent-ink",
  "--sbg-pill-active-text",
];

export const LIGHTBOX_TOKENS = [
  "--sbg-panel-solid",
  "--sbg-lb-head-bg",
  "--sbg-lb-pill-bg",
  "--sbg-lb-pill-border",
  "--sbg-pill-bg-fallback",
  "--sbg-pill-border-fallback",
  "--sbg-section-head-bg",
  "--sbg-lb-btn-bg",
  "--sbg-lb-btn-text",
  "--sbg-lb-btn-hover",
  "--sbg-lb-btn-border",
  "--sbg-danger-solid",
  "--sbg-danger-solid-hover",
  "--sbg-danger-solid-border",
  "--sbg-danger-solid-text",
];

// The lightbox's panel reads its own copy of each, built from the Metadata Panel
// colour, so a theme that names one of them names the copy too.
export const LIGHTBOX_COPIES = {
  "--sbg-section-head-bg": "--sbg-lb-head-bg",
};

// A surface that stays dark inside the light scheme reads the `-dark` copy of
// these, so a theme's value goes there too.
export const DARK_STAGE_TOKENS = [
  "--sbg-success-text",
  "--sbg-danger-text",
];

// Exactly the variables a Theme tab row paints. A theme file stores these
// names, so renaming one in the stylesheet changes the theme file format. A
// variable outside the list stays in the file and is not painted.
export const THEME_VARIABLES = Object.freeze([
  ...DERIVED_TOKENS,
  "--sbg-card-bg", "--sbg-card-border", "--sbg-card-radius", "--sbg-card-name", "--sbg-card-meta",
  "--sbg-search-bg", "--sbg-filter-bg", "--sbg-progress-fill",
  "--sbg-lb-backdrop", "--sbg-panel-solid", "--sbg-section-head-bg",
  "--sbg-danger", "--sbg-warn", "--sbg-success-text", "--sbg-disabled-opacity",
  "--sbg-radius", "--sbg-radius-sm", "--sbg-font-size", "--sbg-card-pad",
]);

// Ids are stored and outlive a rename, so `dark` and `blue` stay the ids of Obsidian and Slate.
export const BUILT_IN_THEMES = [
  { id: "comfy", name: "Comfy", values: { [BG]: "#171718", [SURFACE]: "#262729", [BORDER]: "rgba(240, 239, 237, 0.12)", [TEXT]: "#f0efed", [ACCENT]: "#f2ff59" } },
  { id: "comfyui", name: "ComfyUI", note: "follows ComfyUI", values: {} },
  { id: "dark", name: "Obsidian", values: { [BG]: "#0a0a0a", [SURFACE]: "#161616", [BORDER]: "rgba(255, 255, 255, 0.1)", [TEXT]: "#ededed", [ACCENT]: "#e6e6e6" } },
  { id: "coffee", name: "Coffee", values: { [BG]: "#17140f", [SURFACE]: "#221e17", [BORDER]: "rgba(255, 240, 220, 0.1)", [TEXT]: "#efe6d8", [ACCENT]: "#f5a524" } },
  { id: "blue", name: "Slate", values: { [BG]: "#1b2230", [SURFACE]: "#242d3e", [BORDER]: "rgba(148, 163, 184, 0.2)", [TEXT]: "#e5eaf2", [ACCENT]: "#8aa4ff" } },
  { id: "midnight", name: "Midnight", values: { [BG]: "#0b0f19", [SURFACE]: "#111827", [BORDER]: "rgba(255, 255, 255, 0.1)", [TEXT]: "#e2e8f0", [ACCENT]: "#38bdf8" } },
  { id: "synthwave", name: "Synthwave", values: { [BG]: "#2b0a3d", [SURFACE]: "#3c0c5b", [BORDER]: "rgba(255, 255, 255, 0.2)", [TEXT]: "#fdf2f8", [ACCENT]: "#06b6d4" } },
  { id: "retro", name: "Retro", values: { [BG]: "#fdf6e3", [SURFACE]: "#eee8d5", [BORDER]: "#ccc7b8", [TEXT]: "#657b83", [ACCENT]: "#cb4b16" } },
  { id: "retro-dark", name: "Retro Dark", values: { [BG]: "#26211a", [SURFACE]: "#312a20", [BORDER]: "rgba(238, 232, 213, 0.14)", [TEXT]: "#eee8d5", [ACCENT]: "#d9622b" } },
];

// A preset from an older version stores only its changes against a built-in
// theme, so it reads against the palette that theme carried then.
const PRIOR_BUILT_IN_VALUES = Object.freeze({
  dark: { [BG]: "#141414", [SURFACE]: "#1c1c1c", [TEXT]: "#dddddd" },
  blue: { [BG]: "rgba(18, 18, 30, 0.95)", [SURFACE]: "rgba(25, 25, 42, 0.9)" },
});

// A preset naming no theme was saved while ComfyUI was the default, so it reads
// as ComfyUI, and so does an id this version does not know.
export function priorBuiltInValues(id) {
  const prior = PRIOR_BUILT_IN_VALUES[id];
  if (prior) return prior;
  return (builtInTheme(id) || builtInTheme("comfyui")).values;
}

export const DEFAULT_THEME = "comfy";
// A user theme is referred to by the id inside its file, which the server
// gives and keeps, so a rename leaves every reference to it whole.
export const USER_THEME_PREFIX = "theme:";
export const THEME_FILE_KIND = "sbg-theme";
export const THEME_FILE_VERSION = 2;
export const THEME_FILE_SUFFIX = ".sbgtheme";

export function isBuiltIn(id) {
  return BUILT_IN_THEMES.some(t => t.id === id);
}

export function builtInTheme(id) {
  return BUILT_IN_THEMES.find(t => t.id === id) || null;
}

export function userThemeId(key) {
  return USER_THEME_PREFIX + key;
}

export function userThemeKey(id) {
  return typeof id === "string" && id.startsWith(USER_THEME_PREFIX) && id.length > USER_THEME_PREFIX.length
    ? id.slice(USER_THEME_PREFIX.length) : null;
}

// The theme a stored reference means, against the user themes as
// `[{ key, name }]`: its own theme when this install has it, else the first
// user theme carrying the name stored beside it, else the reference as given,
// which then reads as missing. A theme of another author that shares the name
// is taken too, since the name is all the reference has left to go on.
export function resolveThemeRef(ref, storedName, themes) {
  const key = userThemeKey(ref);
  if (!key || themes.some(t => t.key === key)) return ref;
  const name = typeof storedName === "string" ? storedName.trim() : "";
  const byName = name ? themes.find(t => t.name === name) : null;
  return byName ? userThemeId(byName.key) : ref;
}

// An id means nothing to a person, so a theme found nowhere and stored with no
// name is called by this.
export const MISSING_THEME_NAME = "a theme this install doesn't have";

export function themeRefName(ref, storedName, themes) {
  const key = userThemeKey(ref);
  if (!key) return builtInTheme(ref)?.name || String(ref || "");
  const t = themes.find(x => x.key === key);
  if (t) return t.name;
  const name = typeof storedName === "string" ? storedName.trim() : "";
  return name || MISSING_THEME_NAME;
}

export function isVarToken(key) {
  return typeof key === "string" && /^--sbg-[a-z0-9-]+$/.test(key);
}

export function looseColors(values, colorKeys) {
  const out = {};
  for (const key of colorKeys) {
    const v = values[key];
    if (typeof v === "string" && v) out[key] = v;
  }
  return out;
}

export function sameColors(a, b) {
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

// A key this version does not know is dropped, so a newer version's file still loads.
export function knownValues(values, colorKeys) {
  const out = {};
  const src = (values && typeof values === "object") ? values : {};
  for (const key of colorKeys) {
    const v = cleanColorValue(src[key]);
    if (v) out[key] = v;
  }
  for (const key of Object.keys(src)) {
    // A base colour stored under its variable is read as that colour.
    const base = BASE_COLORS.find(c => c.cssVar === key);
    if (!base && !THEME_VARIABLES.includes(key)) continue;
    const v = cleanColorValue(src[key]);
    if (!v) continue;
    if (!base) out[key] = v;
    else if (!out[base.key]) out[base.key] = v;
  }
  return out;
}

export function themeFile(theme) {
  return {
    kind: THEME_FILE_KIND,
    version: THEME_FILE_VERSION,
    name: theme.name,
    values: { ...(theme.values || {}) },
    created: Date.now(),
  };
}

export function readThemeFile(raw, colorKeys) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "this file isn't a theme" };
  if (raw.kind !== THEME_FILE_KIND) return { ok: false, error: "this file isn't a theme" };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok: false, error: "the file gives the theme no name" };
  return { ok: true, theme: { name, values: knownValues(raw.values, colorKeys) } };
}

// Older versions painted a Custom colour that was never set in its shipped
// default, and one that was emptied in the stylesheet's own colour.
export function migrateCustomTheme(values) {
  const out = looseColors(values, idsOfClass("color"));
  for (const [key, def] of Object.entries(RELEASED_CUSTOM_DEFAULTS)) {
    if (values[key] === "") delete out[key];
    else out[key] = (typeof values[key] === "string" && values[key]) || def;
  }
  return { name: "Custom", values: out };
}

// `base` holds the base colours as painted, keyed without `--sbg-`, plus
// `panel`, a Metadata Panel colour the theme names.
export function deriveTokens(base) {
  const out = {};
  const bg = resolveColor(base.bg), surface = resolveColor(base.surface), border = resolveColor(base.border);
  const text = resolveColor(base.text), accent = resolveColor(base.accent);
  if (surface && text) {
    const m = mix(surface, text, 0.08);
    out["--sbg-surface-hover"] = formatRgba(m.r, m.g, m.b, surface.a);
  }
  if (text) out["--sbg-text-dim"] = dimInk(text);
  if (border) {
    if (border.a < 1) out["--sbg-border-hover"] = formatRgba(border.r, border.g, border.b, Math.min(1, border.a * 2));
    else if (text) {
      const m = mix(border, text, 0.2);
      out["--sbg-border-hover"] = formatRgba(m.r, m.g, m.b, 1);
    }
  }
  if (accent) {
    out["--sbg-accent-glow"] = formatRgba(accent.r, accent.g, accent.b, 0.3);

    const ownDark = bg && lumOf(bg) < 0.5 ? { r: bg.r, g: bg.g, b: bg.b, a: 1 } : null;
    if (ownDark && contrast(ownDark, accent) >= 4.5) out["--sbg-on-accent"] = formatRgba(ownDark.r, ownDark.g, ownDark.b, 1);
    else out["--sbg-on-accent"] = textOn(formatRgba(accent.r, accent.g, accent.b, 1));
    if (text) {
      const ground = bg || { r: 18, g: 18, b: 22, a: 1 };
      out["--sbg-accent-ink"] = accentInk(accent, text, ground);
      out["--sbg-pill-active-text"] = accentInk(accent, text, mix(ground, accent, 0.18));
    }
  }
  Object.assign(out, _lightboxTokens(bg, surface, border, text, resolveColor(base.panel || "")));
  return out;
}

const _RED = { r: 239, g: 68, b: 68, a: 1 };
const _solid = (c) => formatRgba(c.r, c.g, c.b, 1);

const _flat = (c, under) => (c.a >= 1 ? { r: c.r, g: c.g, b: c.b, a: 1 } : mix(under, { r: c.r, g: c.g, b: c.b, a: 1 }, c.a));

const _PANEL_FALLBACK = { r: 18, g: 18, b: 22, a: 1 };
const _BLACK = { r: 0, g: 0, b: 0, a: 1 };

// The header of a section that has a background colour of its own. A colour
// that shows nothing gives null, so the section keeps the theme's header.
export function sectionHeadColors(sectionBg, panelBg, sectionText = "") {
  const own = resolveColor(sectionBg);
  if (!own || own.a === 0) return null;
  const panel = resolveColor(panelBg);
  const ground = panel ? _flat(panel, _PANEL_FALLBACK) : _PANEL_FALLBACK;
  const solid = mix(_flat(own, ground), _BLACK, 0.1);
  const fill = _solid(solid);
  const text = resolveColor(sectionText);
  const ink = text && text.a >= 1 && contrast(text, solid) >= 4.5 ? _solid(text) : textOn(fill);
  return { fill, ink };
}

// Every colour here is solid, since over the photo and the black backdrop a
// see-through tint shows as near black. The panel's pills and headers sit on
// `panel`, so their copies are tinted from it.
function _lightboxTokens(bg, surface, border, text, panel) {
  const out = {};
  const under = !text || lumOf(text) > 0.5 ? { r: 18, g: 18, b: 22, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  bg = bg && _flat(bg, under);
  surface = surface && _flat(surface, bg || under);
  if (bg) out["--sbg-panel-solid"] = _solid(bg);
  if (bg && text) {
    out["--sbg-pill-bg-fallback"] = _solid(mix(bg, text, 0.1));
    out["--sbg-pill-border-fallback"] = _solid(mix(bg, text, 0.2));
  }
  const named = panel && panel.a >= 0.5 ? { r: panel.r, g: panel.g, b: panel.b, a: 1 } : null;
  const namedInk = named && parseColor(textOn(_solid(named)));
  // Where a step toward the ink drops it under 4.5, as on a mid grey, the tint steps away.
  const away = namedInk && (lumOf(namedInk) > 0.5 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });
  const tint = (t) => {
    const toward = mix(named, namedInk, t);
    return contrast(namedInk, toward) >= 4.5 ? toward : mix(named, away, t);
  };
  if (named && namedInk) {
    out["--sbg-lb-pill-bg"] = _solid(tint(0.1));
    out["--sbg-lb-pill-border"] = _solid(tint(0.2));
  } else {
    if (out["--sbg-pill-bg-fallback"]) out["--sbg-lb-pill-bg"] = out["--sbg-pill-bg-fallback"];
    if (out["--sbg-pill-border-fallback"]) out["--sbg-lb-pill-border"] = out["--sbg-pill-border-fallback"];
  }
  if (!surface) return out;
  out["--sbg-section-head-bg"] = _solid(surface);
  out["--sbg-lb-head-bg"] = named && namedInk ? _solid(tint(0.08)) : _solid(surface);
  out["--sbg-lb-btn-bg"] = _solid(surface);
  if (!text) return out;
  out["--sbg-lb-btn-text"] = _solid(text);
  out["--sbg-lb-btn-hover"] = _solid(mix(surface, text, 0.12));
  // A border the theme left fully see-through still needs an edge on the photo.
  out["--sbg-lb-btn-border"] = _solid(border && border.a > 0 ? mix(surface, border, border.a) : mix(surface, text, 0.12));
  const light = lumOf(bg || surface) > 0.4;
  const fill = mix(surface, _RED, light ? 0.16 : 0.28);
  out["--sbg-danger-solid"] = _solid(fill);
  out["--sbg-danger-solid-hover"] = _solid(mix(surface, _RED, light ? 0.26 : 0.4));
  out["--sbg-danger-solid-border"] = _solid(mix(surface, _RED, 0.5));
  const ink = light ? { r: 153, g: 27, b: 27, a: 1 } : { r: 252, g: 165, b: 165, a: 1 };
  out["--sbg-danger-solid-text"] = contrast(ink, fill) >= 4.5 ? _solid(ink) : accentInk(_RED, text, fill);
  return out;
}
