// Every stored setting, declared once: the id it is stored under, its kind, its
// default, the values it takes and the name it shows. ComfyUI loads each file in
// this folder as its own entry, so a fact one module registered at load could be
// missing when another reads it. This module imports nothing, which makes it
// whole before any module that imports it runs.
//
// `HighlightBg` and the five `CUSTOM_` colours keep ids without the `SBG.`
// prefix, since settings already on disk hold them under those names.

// What a preset and a backup do with each kind. `block` names the preset block
// that holds its entries, and a carried kind is one a preset saves, so a change
// to it dates the Current row. Colours live in the theme, so only an older
// preset or a backup holds the colours block. A library kind goes back only
// with a restore of the whole settings file, and a content kind is the
// install's own record, which no restore puts back.
export const KINDS = Object.freeze({
  pref: { block: "settings", carried: true },
  key: { block: "keys", carried: true },
  color: { block: "colors", carried: false },
  layout: { block: null, carried: true },
  theme: { block: null, carried: true },
  library: { block: null, carried: false },
  content: { block: null, carried: false },
});

const _NAMES = [["basename", "Name only"], ["relpath", "Name with folder path"]];

export const SORT_OPTIONS = [
  ["created_desc", "Created ↓"], ["created_asc", "Created ↑"],
  ["modified_desc", "Modified ↓"], ["modified_asc", "Modified ↑"],
  ["name_asc", "Name ↑"], ["name_desc", "Name ↓"],
  ["size_desc", "Size ↓"], ["size_asc", "Size ↑"],
];

export const SETTINGS = {
  THUMB_SIZE: { id: "SBG.ThumbSize", kind: "pref", def: 110, range: { min: 64, max: 256 }, label: "Thumbnail Size (px)" },
  THUMB_SHAPE: { id: "SBG.ThumbShape", kind: "pref", def: "square", choices: [["square", "Square"], ["ar", "Aspect ratio"]], label: "Thumbnail Shape" },
  THUMB_PER_ROW: {
    id: "SBG.ThumbPerRow", kind: "pref", def: "auto", label: "Thumbnails Per Row",
    choices: [["auto", "Auto"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"], ["6", "6"], ["8", "8"], ["10", "10"]],
  },
  TOOLBAR_LAYOUT: {
    id: "SBG.ToolbarLayout", kind: "pref", def: "count-in-search", label: "Toolbar Layout",
    choices: [["rows", "Count at bottom"], ["count-in-search", "Count in search bar"], ["filters-in-search", "Filters in search bar"]],
  },
  CARD_STYLE: {
    id: "SBG.CardStyle", kind: "pref", def: "one-line", label: "Card Style",
    choices: [["boxed", "Boxed"], ["one-line", "Picture with one line"], ["picture", "Picture only"]],
  },
  CARD_LIFT: { id: "SBG.CardLift", kind: "pref", def: true, label: "Hover Animation" },
  SORT: { id: "SBG.DefaultSort", kind: "pref", def: "created_desc", choices: SORT_OPTIONS, label: "Default Sort" },
  THEME: { id: "SBG.Theme", kind: "theme" },
  THEME_ORDER: { id: "SBG.ThemeOrder", kind: "library", label: "theme order" },
  PINNED_FOLDERS: { id: "SBG.PinnedFolders", kind: "library", label: "pinned folders" },
  SETTINGS_CHANGED: { id: "SBG.SettingsChanged", kind: "content" },
  FAVORITE_MEDIA: { id: "SBG.FavoriteMedia", kind: "library", label: "favorites" },
  PICKER_ROOTS_IN_FOLDERS: { id: "SBG.PickerRootsInFolders", kind: "pref", def: false, label: "Roots in Folder Dropdown" },
  PICKER_INCLUDE_SUBFOLDERS: { id: "SBG.PickerIncludeSubfolders", kind: "pref", def: true, label: "Include Files from Subfolders" },
  GRID_WHEEL_SPEED: { id: "SBG.GridWheelSpeed", kind: "pref", def: 100, range: { min: 25, max: 400 }, label: "Wheel Scroll Speed (%)" },
  KEY_PREV: { id: "SBG.KeyPrev", kind: "key", def: "ArrowLeft,a,j", label: "Previous File", tip: "Go to the previous file in the lightbox" },
  KEY_NEXT: { id: "SBG.KeyNext", kind: "key", def: "ArrowRight,d,l", label: "Next File", tip: "Go to the next file in the lightbox" },
  KEY_CLOSE: { id: "SBG.KeyClose", kind: "key", def: "Escape,q,z,0", label: "Close Lightbox", tip: "Close the lightbox, or leave fullscreen or compare first if one is on." },
  KEY_TOGGLE: { id: "SBG.KeyToggle", kind: "key", def: "z,0", label: "Toggle Gallery" },
  KEY_REFRESH: { id: "SBG.KeyRefresh", kind: "key", def: "", label: "Refresh Gallery" },
  KEY_FULLSCREEN: { id: "SBG.KeyFullscreen", kind: "key", def: "f", label: "Fullscreen" },
  KEY_DOWNLOAD: { id: "SBG.KeyDownload", kind: "key", def: "", label: "Download" },
  KEY_COPY_PROMPT: { id: "SBG.KeyCopyPrompt", kind: "key", def: "", label: "Copy Prompt", tip: "Copy the positive prompt" },
  KEY_COPY_WF: { id: "SBG.KeyCopyWF", kind: "key", def: "", label: "Copy Workflow" },
  KEY_LOAD_WF: { id: "SBG.KeyLoadWF", kind: "key", def: "", label: "Load Workflow" },
  KEY_COMPARE: { id: "SBG.KeyCompare", kind: "key", def: "c", label: "Compare" },
  KEY_RESET_ZOOM: {
    id: "SBG.KeyResetZoom", kind: "key", def: "MiddleClick,r", label: "Reset Zoom",
    tip: "Fit the picture back to the screen. In compare, when each side zooms on its own, the side under the cursor resets.",
  },
  KEY_ZOOM_IN: {
    id: "SBG.KeyZoomIn", kind: "key", def: "=,+", label: "Zoom In",
    tip: "Zoom in one step per press, and hold to keep zooming. Follows the Zoom Sensitivity and Zoom Direction settings.",
  },
  KEY_ZOOM_OUT: { id: "SBG.KeyZoomOut", kind: "key", def: "-", label: "Zoom Out", tip: "Zoom out one step per press, and hold to keep zooming." },
  KEY_MUTE: { id: "SBG.KeyMute", kind: "key", def: "m", label: "Mute", tip: "Mute or unmute the current video or audio" },
  KEY_VOL_UP: { id: "SBG.KeyVolumeUp", kind: "key", def: "ArrowUp", label: "Volume Up", tip: "Raise the volume of the playing video or audio by a tenth, and unmute it if it was muted." },
  KEY_VOL_DOWN: { id: "SBG.KeyVolumeDown", kind: "key", def: "ArrowDown", label: "Volume Down", tip: "Lower the volume of the playing video or audio by a tenth." },
  KEY_FAVORITE: { id: "SBG.KeyFavorite", kind: "key", def: "", label: "Favorite", tip: "Add the current file to favorites, or remove it" },
  KEY_DELETE: {
    id: "SBG.KeyDelete", kind: "key", def: "", label: "Delete",
    tip: "Same as the lightbox's Delete button. A second press within two seconds confirms, unless Confirm Before Deleting is off. Does nothing while the Delete button is hidden in Appearance.",
  },
  KEY_FRAME_PREV: { id: "SBG.KeyFramePrev", kind: "key", def: "Comma", label: "Frame Back", tip: "Pause the video and step back one frame. On audio, skip back 5 seconds." },
  KEY_FRAME_NEXT: { id: "SBG.KeyFrameNext", kind: "key", def: ".", label: "Frame Forward", tip: "Pause the video and step forward one frame. On audio, skip ahead 5 seconds." },
  KEY_CMP_CUR_PREV: { id: "SBG.KeyCompareCurPrev", kind: "key", def: "Shift+ArrowLeft,Shift+a", label: "Previous File on the Left" },
  KEY_CMP_CUR_NEXT: { id: "SBG.KeyCompareCurNext", kind: "key", def: "Shift+ArrowRight,Shift+d", label: "Next File on the Left" },
  TOOLTIP_NAME: { id: "SBG.TooltipName", kind: "pref", def: true, label: "Show Filename" },
  TOOLTIP_SIZE: { id: "SBG.TooltipSize", kind: "pref", def: true, label: "Show File Size" },
  TOOLTIP_DATE: { id: "SBG.TooltipDate", kind: "pref", def: true, label: "Show Modified Date" },
  BADGE_HIGH_COLOR: { id: "SBG.BadgeHighColor", kind: "color" },
  BADGE_LOW_COLOR: { id: "SBG.BadgeLowColor", kind: "color" },
  VIDEO_BADGE_COLOR: { id: "SBG.VideoBadgeColor", kind: "color" },
  FAV_COLOR: { id: "SBG.FavColor", kind: "color" },
  LB_SHOW_DOWNLOAD: { id: "SBG.LbShowDownload", kind: "pref", def: true, label: "Download", group: "Lightbox Buttons" },
  LB_SHOW_COPY_PROMPT: { id: "SBG.LbShowCopyPrompt", kind: "pref", def: true, label: "Copy Prompt", group: "Lightbox Buttons" },
  LB_SHOW_COPY_WF: { id: "SBG.LbShowCopyWF", kind: "pref", def: true, label: "Copy Workflow", group: "Lightbox Buttons" },
  LB_SHOW_LOAD_WF: { id: "SBG.LbShowLoadWF", kind: "pref", def: true, label: "Load Workflow", group: "Lightbox Buttons" },
  LB_SHOW_COMPARE: { id: "SBG.LbShowCompare", kind: "pref", def: true, label: "Compare", group: "Lightbox Buttons" },
  LB_SHOW_FAVORITE: { id: "SBG.LbShowFavorite", kind: "pref", def: true, label: "Favorite", group: "Lightbox Buttons" },
  LB_SHOW_DELETE: { id: "SBG.LbShowDelete", kind: "pref", def: true, label: "Delete", group: "Lightbox Buttons" },
  DELETE_CONFIRM: { id: "SBG.DeleteConfirm", kind: "pref", def: true, label: "Confirm Before Deleting" },
  LB_BUTTON_ORDER: { id: "SBG.LbButtonOrder", kind: "pref", label: "Lightbox Buttons" },
  CARD_MENU_ORDER: { id: "SBG.CardMenuOrder", kind: "pref", label: "Card Menu Items" },
  CARD_MENU_SHOW_FAVORITE: { id: "SBG.CardMenuShowFavorite", kind: "pref", def: true, label: "Favorite", group: "Card Menu Items" },
  CARD_MENU_SHOW_DOWNLOAD: { id: "SBG.CardMenuShowDownload", kind: "pref", def: true, label: "Download", group: "Card Menu Items" },
  CARD_MENU_SHOW_COPY_PROMPT: { id: "SBG.CardMenuShowCopyPrompt", kind: "pref", def: true, label: "Copy Prompt", group: "Card Menu Items" },
  CARD_MENU_SHOW_COPY_WF: { id: "SBG.CardMenuShowCopyWF", kind: "pref", def: true, label: "Copy Workflow", group: "Card Menu Items" },
  CARD_MENU_SHOW_LOAD_WF: { id: "SBG.CardMenuShowLoadWF", kind: "pref", def: true, label: "Load Workflow", group: "Card Menu Items" },
  CARD_MENU_SHOW_DELETE: { id: "SBG.CardMenuShowDelete", kind: "pref", def: true, label: "Delete", group: "Card Menu Items" },
  LB_COLOR_DOWNLOAD: { id: "SBG.LbColorDownload", kind: "color" },
  LB_COLOR_COPY_PROMPT: { id: "SBG.LbColorCopyPrompt", kind: "color" },
  LB_COLOR_COPY_WF: { id: "SBG.LbColorCopyWF", kind: "color" },
  LB_COLOR_LOAD_WF: { id: "SBG.LbColorLoadWF", kind: "color" },
  LB_COLOR_COMPARE: { id: "SBG.LbColorCompare", kind: "color" },
  LB_COLOR_FAVORITE: { id: "SBG.LbColorFavorite", kind: "color" },
  LB_COLOR_DELETE: { id: "SBG.LbColorDelete", kind: "color" },
  SEARCH_TAG_COLOR: { id: "SBG.SearchTagColor", kind: "color" },
  SEARCH_TAG_NEG_COLOR: { id: "SBG.SearchTagNegColor", kind: "color" },
  SAVED_SEARCHES: { id: "SBG.SavedSearches", kind: "library", label: "saved searches" },
  SEARCH_AC_ROWS: { id: "SBG.SearchAcRows", kind: "pref", def: 8, range: { min: 3, max: 30 }, label: "Suggestion Rows" },
  APP_BADGE_COMFYUI: { id: "SBG.AppBadgeComfyUI", kind: "color" },
  APP_BADGE_A1111: { id: "SBG.AppBadgeA1111", kind: "color" },
  APP_BADGE_FORGE: { id: "SBG.AppBadgeForge", kind: "color" },
  APP_BADGE_SDNEXT: { id: "SBG.AppBadgeSDNext", kind: "color" },
  APP_BADGE_FOOOCUS: { id: "SBG.AppBadgeFooocus", kind: "color" },
  APP_BADGE_CIVITAI: { id: "SBG.AppBadgeCivitAI", kind: "color" },
  INITIAL_IMAGE_TAB_COLOR: { id: "SBG.InitialImageTabColor", kind: "color" },
  PILL_BG_COLOR: { id: "SBG.PillBgColor", kind: "color" },
  PILL_TEXT_COLOR: { id: "SBG.PillTextColor", kind: "color" },
  PILL_BORDER_COLOR: { id: "SBG.PillBorderColor", kind: "color" },
  HIGHLIGHT_TEXT_COLOR: { id: "SBG.HighlightTextColor", kind: "color" },
  FILENAME_STYLE: { id: "SBG.FilenameStyle", kind: "pref", def: "basename", choices: _NAMES, label: "Filename Display" },
  MODEL_NAME_STYLE: { id: "SBG.ModelNameStyle", kind: "pref", def: "basename", choices: _NAMES, label: "Model Display" },
  VSCROLL_BUFFER: { id: "SBG.VScrollBuffer", kind: "pref", def: 2, range: { min: 1, max: 30 }, label: "Scroll Buffer (rows)" },
  META_TAB_PERSIST: { id: "SBG.MetaTabPersist", kind: "pref", def: false, label: "Keep Tab While Browsing" },
  LB_ZOOM_SCROLL_MODE: {
    id: "SBG.LbZoomScrollMode", kind: "pref", def: "mouse", label: "Scroll Input",
    choices: [["mouse", "Mouse"], ["touchpad", "Touchpad"], ["auto", "Auto"]],
  },
  LB_ZOOM_ANCHOR: {
    id: "SBG.LbZoomAnchor", kind: "pref", def: "cursor", label: "Zoom Direction",
    choices: [["cursor", "Towards the cursor"], ["center", "Towards the center"]],
  },
  // Older versions saved an emptied box as 0 and zoomed at the slowest speed for it.
  LB_ZOOM_SENSITIVITY: { id: "SBG.LbZoomSensitivity", kind: "pref", def: 1, range: { min: 0.1, max: 5, step: 0.1, zeroIsMin: true }, label: "Zoom Sensitivity" },
  LB_COMPARE_ZOOM: {
    id: "SBG.LbCompareZoom", kind: "pref", def: "independent", label: "Compare Zoom",
    choices: [["independent", "Each side on its own"], ["synced", "Both sides together"]],
  },
  LB_ZOOM_KEEP_ON_NAV: { id: "SBG.LbZoomKeepOnNav", kind: "pref", def: false, label: "Keep Zoom While Browsing" },
  LAYOUT_PROFILES: { id: "SBG.Layouts", kind: "layout", label: "layouts" },
  LAYOUT_INDEX: { id: "SBG.LayoutsIndex", kind: "layout", label: "layouts" },
  HIGHLIGHT_BG: { id: "HighlightBg", kind: "color" },
  CUSTOM_BG: { id: "CUSTOM_BG", kind: "color" },
  CUSTOM_SURFACE: { id: "CUSTOM_SURFACE", kind: "color" },
  CUSTOM_BORDER: { id: "CUSTOM_BORDER", kind: "color" },
  CUSTOM_TEXT: { id: "CUSTOM_TEXT", kind: "color" },
  CUSTOM_ACCENT: { id: "CUSTOM_ACCENT", kind: "color" },
  DOWNGRADED_FROM: { id: "SBG._downgradedFrom", kind: "content" },
};

export const S = Object.freeze({
  ...Object.fromEntries(Object.entries(SETTINGS).map(([name, d]) => [name, d.id])),

  LAYOUT_PROFILE_PREFIX: "SBG.Layouts.",
});

// The saved orders store the ids of these two lists, so renaming an id sends
// that item to the end.
export const LB_BUTTONS = Object.freeze([
  { id: "favorite", label: "Favorite", show: S.LB_SHOW_FAVORITE, color: S.LB_COLOR_FAVORITE },
  { id: "download", label: "Download", show: S.LB_SHOW_DOWNLOAD, color: S.LB_COLOR_DOWNLOAD },
  { id: "copy-prompt", label: "Copy Prompt", show: S.LB_SHOW_COPY_PROMPT, color: S.LB_COLOR_COPY_PROMPT },
  { id: "copy-wf", label: "Copy Workflow", show: S.LB_SHOW_COPY_WF, color: S.LB_COLOR_COPY_WF },
  { id: "load-wf", label: "Load Workflow", show: S.LB_SHOW_LOAD_WF, color: S.LB_COLOR_LOAD_WF },
  { id: "compare", label: "Compare", show: S.LB_SHOW_COMPARE, color: S.LB_COLOR_COMPARE },
  { id: "delete", label: "Delete", show: S.LB_SHOW_DELETE, color: S.LB_COLOR_DELETE },
]);
export const CARD_MENU_ITEMS = Object.freeze([
  { id: "favorite", label: "Favorite", show: S.CARD_MENU_SHOW_FAVORITE },
  { id: "download", label: "Download", show: S.CARD_MENU_SHOW_DOWNLOAD },
  { id: "copy-prompt", label: "Copy Prompt", show: S.CARD_MENU_SHOW_COPY_PROMPT },
  { id: "copy-wf", label: "Copy Workflow", show: S.CARD_MENU_SHOW_COPY_WF },
  { id: "load-wf", label: "Load Workflow", show: S.CARD_MENU_SHOW_LOAD_WF },
  { id: "delete", label: "Delete", show: S.CARD_MENU_SHOW_DELETE },
]);

for (const [name, items] of [["LB_BUTTON_ORDER", LB_BUTTONS], ["CARD_MENU_ORDER", CARD_MENU_ITEMS]]) {
  SETTINGS[name].def = items.map((b) => b.id);
  SETTINGS[name].choices = items.map((b) => [b.id, b.label]);
}
Object.freeze(SETTINGS);

// A group's `scope` says where its keys are listened for, and two bindings clash
// only within one scope. The lightbox takes a press first and keeps every one
// bound there, so one key can serve an action in each scope.
export const KEYBIND_GROUPS = [
  { title: "Gallery", scope: "gallery", keys: ["KEY_TOGGLE", "KEY_REFRESH"] },
  { title: "Navigation", scope: "lightbox", keys: ["KEY_PREV", "KEY_NEXT", "KEY_CLOSE"] },
  {
    title: "Lightbox actions", scope: "lightbox",
    keys: ["KEY_FULLSCREEN", "KEY_DOWNLOAD", "KEY_COPY_PROMPT", "KEY_COPY_WF", "KEY_LOAD_WF", "KEY_FAVORITE", "KEY_DELETE", "KEY_COMPARE"],
  },
  { title: "Zoom", scope: "lightbox", keys: ["KEY_RESET_ZOOM", "KEY_ZOOM_IN", "KEY_ZOOM_OUT"] },
  { title: "Video and audio", scope: "lightbox", keys: ["KEY_MUTE", "KEY_VOL_UP", "KEY_VOL_DOWN", "KEY_FRAME_PREV", "KEY_FRAME_NEXT"] },
  {
    title: "Compare mode", scope: "lightbox",
    desc: "In compare, the Previous and Next keys change the file on the right. These change the file on the left.",
    keys: ["KEY_CMP_CUR_PREV", "KEY_CMP_CUR_NEXT"],
  },
].map((g) => ({ ...g, keys: g.keys.map((name) => SETTINGS[name]) }));

const _SCOPES = Object.fromEntries(KEYBIND_GROUPS.flatMap((g) => g.keys.map((k) => [k.id, g.scope])));

export const keyScope = (id) => _SCOPES[id] ?? null;

const _BY_ID = new Map(Object.values(SETTINGS).map((d) => {
  if (Array.isArray(d.def)) Object.freeze(d.def);
  return [d.id, d];
}));

export const declaration = (id) => _BY_ID.get(id);

// What a reader gets for a stored value: the value when it is one the setting
// takes, brought into its range, and the default otherwise. A hand-edited file
// or a later version can store anything.
export function settingValue(d, raw) {
  if (raw === undefined || raw === null) return d.def;
  if (Array.isArray(d.def)) return Array.isArray(raw) ? raw : d.def;
  if (d.choices) {
    const text = typeof raw === "string" || typeof raw === "number";
    return text && d.choices.some(([v]) => String(v) === String(raw)) ? String(raw) : d.def;
  }
  if (d.range) {
    // A value that is no number reads as unset, and so does zero unless the
    // setting reads it as its lowest value. A value between steps is read as
    // stored, since an older version saved whatever was typed and only the
    // box rounds to the step. A setting without a step holds a whole number,
    // which its readers count with.
    const n = Number(raw);
    const { min, max, step, zeroIsMin } = d.range;
    if (!Number.isFinite(n) || (n === 0 && !zeroIsMin)) return d.def;
    return Math.min(max, Math.max(min, step ? n : Math.round(n)));
  }
  if (typeof d.def === "boolean") return typeof raw === "boolean" ? raw : d.def;
  if (d.kind === "key") return typeof raw === "string" ? raw : d.def;
  return raw;
}
