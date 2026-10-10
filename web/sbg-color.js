import { B } from "./sbg-settings-store.js";
import { lsGet, lsSet } from "./sbg-core.js";

// A colour can come from a theme file or a preset written elsewhere, and lands
// on properties that also take an image, so only these functions pass.
const _COLOR_FUNCTIONS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color",
  "color-mix", "var", "calc", "min", "max", "clamp",
  "linear-gradient", "radial-gradient", "conic-gradient",
  "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
]);

export function cleanColorValue(v) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s || s.length > 64 || /[;{}<>\\]/.test(s)) return "";
  for (const m of s.matchAll(/([A-Za-z-]+)\s*\(/g)) {
    if (!_COLOR_FUNCTIONS.has(m[1].toLowerCase())) return "";
  }
  // `opacity` admits the plain numbers a theme holds. A value the browser
  // refuses leaves the stylesheet's colour showing instead of a transparent area.
  if (typeof CSS !== "undefined" && CSS.supports && !CSS.supports("background", s) && !CSS.supports("opacity", s)) return "";
  return s;
}

const _clamp = (n, hi) => Math.max(0, Math.min(hi, n));

// A named colour or a var() gives null. `resolveColor` resolves a named colour through the page.
export function parseColor(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  if (s[0] === "#") {
    let hx = s.slice(1);
    if (!/^[0-9a-f]+$/i.test(hx)) return null;
    if (hx.length === 3 || hx.length === 4) hx = hx.split("").map(c => c + c).join("");
    if (hx.length !== 6 && hx.length !== 8) return null;
    const r = parseInt(hx.slice(0, 2), 16), g = parseInt(hx.slice(2, 4), 16), b = parseInt(hx.slice(4, 6), 16);
    const a = hx.length === 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  // Anchored, since a gradient or a color-mix holds an rgb() of its own.
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    // CSS writes the arguments as a comma list or as spaces with a slash before the alpha.
    const p = m[1].split(/[,\/\s]+/).filter(Boolean);
    if (p.length < 3) return null;
    const channel = (x) => Math.round(x.endsWith("%") ? parseFloat(x) / 100 * 255 : parseFloat(x));
    const r = channel(p[0]), g = channel(p[1]), b = channel(p[2]);
    const a = p.length >= 4 ? (p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
    if ([r, g, b, a].some(n => Number.isNaN(n))) return null;
    return { r: _clamp(r, 255), g: _clamp(g, 255), b: _clamp(b, 255), a: _clamp(a, 1) };
  }
  // A computed color-mix can come back in this form, with channels as fractions of one.
  const c = s.match(/^color\(srgb\s+([^)]+)\)$/i);
  if (c) {
    const p = c[1].split(/[\/\s]+/).filter(Boolean);
    if (p.length < 3) return null;
    const frac = (x) => x.endsWith("%") ? parseFloat(x) / 100 : parseFloat(x);
    const ch = (x) => Math.round(frac(x) * 255);
    const r = ch(p[0]), g = ch(p[1]), b = ch(p[2]);
    const a = p.length >= 4 ? frac(p[3]) : 1;
    if ([r, g, b, a].some(n => Number.isNaN(n))) return null;
    return { r: _clamp(r, 255), g: _clamp(g, 255), b: _clamp(b, 255), a: _clamp(a, 1) };
  }
  return null;
}

let _probe = null;

// A value whose colour depends on where it is used gives null, since the probe
// would only answer what it paints at the root.
const _CONTEXTUAL = /\bvar\(|\bcurrentcolor\b|^(?:inherit|initial|unset|revert|revert-layer)$/i;
export function resolveColor(text) {
  const parsed = parseColor(text);
  const s = String(text ?? "").trim();
  if (parsed || !s || _CONTEXTUAL.test(s) || typeof document === "undefined") return parsed;
  if (!_probe) _probe = Object.assign(document.createElement("span"), { className: "sbg-probe" });
  _probe.style.color = "";
  _probe.style.color = s;
  if (!_probe.style.color) return null;
  document.documentElement.appendChild(_probe);
  const v = getComputedStyle(_probe).color;
  _probe.remove();
  return parseColor(v);
}

export function normalizeColor(c) {
  const p = parseColor(c);
  return p ? formatRgba(p.r, p.g, p.b, p.a) : "";
}

export function withAlpha(color, a) {
  const p = parseColor(color);
  return p ? formatRgba(p.r, p.g, p.b, a) : "";
}

export function formatRgba(r, g, b, a = 1) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n)));
  a = Math.max(0, Math.min(1, a));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** The dim form of a text colour, as a theme works out its Dim Text. */
export function dimInk(c) {
  return formatRgba(c.r, c.g, c.b, c.a * 0.65);
}

export function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a };
}

// Relative luminance and contrast ratio as WCAG defines them.
function _lin(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function lumOf(c) {
  return 0.2126 * _lin(c.r) + 0.7152 * _lin(c.g) + 0.0722 * _lin(c.b);
}

export function contrast(a, b) {
  const la = lumOf(a), lb = lumOf(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function textOn(color) {
  const p = parseColor(color);
  // A background this transparent shows what is behind it, so no ink can be picked from it.
  if (!p || p.a < 0.5) return "";
  return contrast({ r: 17, g: 17, b: 17 }, p) >= contrast({ r: 255, g: 255, b: 255 }, p) ? "#111111" : "#ffffff";
}

// `min` is the WCAG contrast to reach: 4.5 for normal text, 3 for a mark such as an icon.
export function accentInk(accent, text, ground, min = 4.5) {
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const cand = mix(accent, text, t);
    if (contrast(cand, ground) >= min) return formatRgba(cand.r, cand.g, cand.b, 1);
  }
  // Even the text colour can miss `min`, so the last resort is near black or white.
  const last = parseColor(textOn(formatRgba(ground.r, ground.g, ground.b, 1))) || text;
  return formatRgba(last.r, last.g, last.b, 1);
}

// Hue 0 to 360, saturation and lightness 0 to 100, left unrounded so a colour
// opened in the picker and applied unchanged is stored as it was.
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, s = 0, l = (max + min) / 2;
  if (d > 0) { s = d / (1 - Math.abs(2 * l - 1)); h = max === r ? ((g - b) / d + 6) % 6 * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60; }
  return [h, s * 100, l * 100];
}

export function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// Only the last background layer can be a plain colour, so the colour is drawn
// as a gradient of itself to sit over the checkerboard that shows its alpha.
const _CHECKER = "repeating-conic-gradient(#6b6b6b 0% 25%, #9a9a9a 0% 50%) 50% / 12px 12px";
export function checkerBg(color) { return color ? `linear-gradient(${color}, ${color}), ${_CHECKER}` : _CHECKER; }

export function getSavedColors() {
  try { const v = JSON.parse(lsGet(B.SAVED_COLORS)); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// Answers false when the browser refuses the write, from blocked site data or a full store.
export function saveSavedColors(arr) {
  return lsSet(B.SAVED_COLORS, JSON.stringify(arr.slice(0, 12)));
}
