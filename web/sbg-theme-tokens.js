import { S } from "./sbg-settings-catalog.js";
import { APP_REGISTRY } from "./sbg-theme.js";
import { BASE_COLORS, DEFAULT_THEME, builtInTheme } from "./sbg-theme-model.js";

// Every theme value the Theme tab offers, declared once. The Theme tab draws its
// rows from these, and a preset or backup row names a stored value by them.

// The last column selects what the row paints in the sample.
export const DERIVED_ROWS = [
  ["--sbg-surface-hover", "Hover Background", "Surface, shifted slightly towards the text color", ".sbg-gs-sample__hover"],
  ["--sbg-text-dim", "Dim Text", "Text, faded", ".sbg-card__meta, .sbg-area__row"],
  ["--sbg-border-hover", "Border on Hover", "Border, strengthened", ".sbg-gs-sample__hover"],
  ["--sbg-accent-glow", "Focus Glow", "Accent at 30% opacity", ".sbg-search-tag:not(.sbg-search-tag--neg)"],
  ["--sbg-on-accent", "Text on Accent", "Dark or white, whichever reads better on the accent", ".sbg-btn--accent"],
  ["--sbg-accent-ink", "Accent as Text", "Accent, adjusted until it's readable on the background", ".sbg-folder-btn--root, .sbg-search-refresh"],
  ["--sbg-pill-active-text", "Active Pill Text", "Accent, adjusted until it's readable on an active pill", null],
];

const BASE_HITS = {
  "--sbg-bg": ".sbg-root, .sbg-lb__meta-panel",
  "--sbg-surface": ".sbg-toolbar, .sbg-card, .sbg-section__head",
  "--sbg-border": ".sbg-card, .sbg-section, .sbg-search-wrap",
  "--sbg-text": ".sbg-card__name, .sbg-meta-card__title",
  "--sbg-accent": ".sbg-btn--accent, .sbg-search-tag:not(.sbg-search-tag--neg)",
};

// A row's `def` names where its default is read:
//   `derived`   the colour the theme works out
//   `own`       the stylesheet's value of the variable the row paints, with the theme's own lifted off
//   `token`     the value another token paints now
//   `fallback`  what a base colour row shows before the stylesheet loads
export function themeRows() {
  const rows = [];
  const color = (group, label, key, def, hit, tip, note) => rows.push({ group, label, kind: "color", key, def, hit, tip, note });
  const pair = (group, label, channels, hit, tip) => rows.push({ group, label, kind: "pair", channels, hit, tip });
  const number = (group, label, key, def, unit, hit, extra = {}) => rows.push({ group, label, kind: "number", key, def, unit, hit, ...extra });

  const shipped = builtInTheme(DEFAULT_THEME).values;
  for (const { key, cssVar, label, tip } of BASE_COLORS) {
    color("base", label, key, { token: cssVar, fallback: shipped[key] }, BASE_HITS[cssVar], tip);
  }

  const boxedOnly = "Boxed cards only";
  color("gallery", "Card Background", "--sbg-card-bg", { token: "--sbg-surface" }, ".sbg-card", undefined, boxedOnly);
  color("gallery", "Card Border", "--sbg-card-border", { token: "--sbg-border" }, ".sbg-card");
  number("gallery", "Card Corner Radius", "--sbg-card-radius", { token: "--sbg-radius" }, "px", ".sbg-card");
  color("gallery", "File Name", "--sbg-card-name", { token: "--sbg-text" }, ".sbg-card__name");
  color("gallery", "Size and Date", "--sbg-card-meta", { token: "--sbg-text-dim" }, ".sbg-card__meta");
  color("gallery", "Format Badge", S.VIDEO_BADGE_COLOR, { own: "--sbg-badge-vid" }, ".sbg-card__kind", "Color of the format badge on video and audio thumbnails");
  color("gallery", "Favorite Star", S.FAV_COLOR, { token: "--sbg-accent" }, ".sbg-card__fav", "Color of the favorite star on cards, in the lightbox and in the folder dropdown. Stars on cards and in the lightbox use the accent color until you set one.");
  color("gallery", "HIGH Badge", S.BADGE_HIGH_COLOR, { own: "--sbg-badge-high" }, null, "Color of the HIGH label over paired samplers and models in the metadata panel");
  color("gallery", "LOW Badge", S.BADGE_LOW_COLOR, { own: "--sbg-badge-low" }, null, "Color of the LOW label over paired samplers and models in the metadata panel");

  color("toolbar", "Search Bar", "--sbg-search-bg", { token: "--sbg-well-25" }, ".sbg-search-wrap");
  color("toolbar", "Search Tag", S.SEARCH_TAG_COLOR, { token: "--sbg-accent" }, ".sbg-search-tag:not(.sbg-search-tag--neg)", "Color of search tags in the search bar. Uses the accent color until you set one.");
  color("toolbar", "Exclude Tag", S.SEARCH_TAG_NEG_COLOR, { token: "--sbg-danger" }, ".sbg-search-tag--neg", "Color of exclude tags in the search bar, the ones starting with a minus. Uses the Danger color until you set one.");
  color("toolbar", "Filter Buttons", "--sbg-filter-bg", { token: "--sbg-tint-soft" }, ".sbg-kind-group");
  color("toolbar", "Progress Bar", "--sbg-progress-fill", { own: "--sbg-progress-fill" }, null);

  color("lightbox", "Backdrop", "--sbg-lb-backdrop", { token: "--sbg-scrim-90" }, null);

  for (const [key, label, act, def, cleared, note] of [
    [S.LB_COLOR_FAVORITE, "Favorite Button", "favorite", "--sbg-lb-btn-bg", "the Surface color"],
    [S.LB_COLOR_DOWNLOAD, "Download Button", "download", "--sbg-lb-btn-bg", "the Surface color"],
    [S.LB_COLOR_COPY_PROMPT, "Copy Prompt Button", "copy-prompt", "--sbg-lb-btn-bg", "the Surface color"],
    [S.LB_COLOR_COPY_WF, "Copy Workflow Button", "copy-wf", "--sbg-lb-btn-bg", "the Surface color"],
    [S.LB_COLOR_LOAD_WF, "Load Workflow Button", "load-wf", "--sbg-accent", "the accent color"],
    [S.LB_COLOR_COMPARE, "Compare Button", "compare", "--sbg-lb-btn-bg", "the Surface color"],
    [S.LB_COLOR_DELETE, "Delete Buttons", "delete", "--sbg-danger-solid", "a soft red",
      "Every Delete in the gallery: the lightbox, the Presets tab and a card's right-click menu"],
  ]) {
    color("lightbox", label, key, { token: def }, `.sbg-lb__act--${act}`, `Uses ${cleared} until you set one.`, note);
  }
  color("lightbox", "Metadata Panel", "--sbg-panel-solid", { derived: "--sbg-panel-solid", own: "--sbg-panel-solid" }, ".sbg-lb__meta-panel");
  color("lightbox", "Section Header", "--sbg-section-head-bg", { derived: "--sbg-lb-head-bg", token: "--sbg-well-10" }, ".sbg-section__head");
  pair("lightbox", "Pill", [
    { key: "bg", label: "Background", setting: S.PILL_BG_COLOR, def: { derived: "--sbg-lb-pill-bg", token: "--sbg-pill-bg-fallback" }, channel: "bg" },
    { key: "text", label: "Text", setting: S.PILL_TEXT_COLOR, def: { token: "--sbg-panel-ink-pill" }, channel: "text" },
    { key: "border", label: "Border", setting: S.PILL_BORDER_COLOR, def: { derived: "--sbg-lb-pill-border", token: "--sbg-pill-border-fallback" }, channel: "border" },
  ], ".sbg-badge", "The background, text and border of values shown as pills, for any field without its own color.");
  pair("lightbox", "Search Highlight", [
    { key: "bg", label: "Background", setting: S.HIGHLIGHT_BG, def: { own: "--sbg-highlight-bg" } },
    { key: "text", label: "Text", setting: S.HIGHLIGHT_TEXT_COLOR, def: { token: "--sbg-text" } },
  ], ".sbg-highlight", "The background and text of words the search matched in the metadata panel. With a mostly solid background and no text color set, the text turns black or white to stay readable.");
  color("lightbox", "Source Tab", S.INITIAL_IMAGE_TAB_COLOR, { token: "--sbg-text-dim" }, null, "Color of the tab next to Generated in the metadata panel, which shows the source image or audio. Until you set one, it matches the Generated tab.");
  for (const a of APP_REGISTRY) color("lightbox", `${a.label} Badge`, a.settingKey, { own: a.cssVar }, null, `Color of the ${a.label} badge at the top of the metadata panel`);

  color("states", "Danger", "--sbg-danger", { own: "--sbg-danger" }, null);
  color("states", "Warning", "--sbg-warn", { own: "--sbg-warn" }, null);
  color("states", "Success", "--sbg-success-text", { own: "--sbg-success-text" }, null);
  number("states", "Disabled Opacity", "--sbg-disabled-opacity", { own: "--sbg-disabled-opacity" }, "%", null);

  number("shape", "Corner Radius", "--sbg-radius", { own: "--sbg-radius" }, "px", ".sbg-card, .sbg-section");
  number("shape", "Small Corner Radius", "--sbg-radius-sm", { own: "--sbg-radius-sm" }, "px", ".sbg-badge, .sbg-btn, .sbg-search-wrap");
  number("shape", "Base Font Size", "--sbg-font-size", { own: "--sbg-font-size" }, "px", ".sbg-root");

  // More would clip a Boxed card's second line, since the grid reserves a fixed
  // info height for each card style.
  number("shape", "Card Padding", "--sbg-card-pad", { own: "--sbg-card-pad" }, "px", ".sbg-card__info", { max: 8, note: boxedOnly });
  return rows;
}

let _names = null;

// A match badge is named after the section it matches, which the person can
// rename at any time, so the names are kept only until the code that asked
// first has finished running, and a later ask works them out again.
export function themeValueName(key) {
  if (!_names) {
    _names = new Map(DERIVED_ROWS.map(([token, label]) => [token, label]));
    for (const r of themeRows()) {
      if (r.kind === "pair") for (const ch of r.channels) _names.set(ch.setting || ch.token, `${r.label}, ${ch.label}`);
      else _names.set(r.key, r.label);
    }
    queueMicrotask(() => { _names = null; });
  }
  return _names.get(key);
}
