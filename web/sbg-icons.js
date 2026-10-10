const IMAGE_SHAPE = `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>`;
const VIDEO_SHAPE = `<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>`;
const AUDIO_SHAPE = `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`;
const THIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">`;
const FILTER = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`;
const VOLUME_BODY = `<polygon points="11.4 5 6.4 9 2.4 9 2.4 15 6.4 15 11.4 19 11.4 5" fill="currentColor" stroke="none"/>`;

export const VIDEO_ICON = `${THIN}${VIDEO_SHAPE}</svg>`;
export const IMAGE_ICON = `${THIN}${IMAGE_SHAPE}</svg>`;
export const AUDIO_ICON = `${THIN}${AUDIO_SHAPE}</svg>`;
export const IMAGE_FILTER_ICON = `${FILTER}${IMAGE_SHAPE}</svg>`;
export const VIDEO_FILTER_ICON = `${FILTER}${VIDEO_SHAPE}</svg>`;
export const AUDIO_FILTER_ICON = `${FILTER}${AUDIO_SHAPE}</svg>`;
export const SEARCH_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="5.5"/><line x1="14.2" y1="14.2" x2="19.5" y2="19.5"/></svg>`;
export const GEAR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

export const TAB_SETTINGS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 12h3M11 12h9M4 17h8M16 17h4"/><circle cx="16" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="17" r="2"/></svg>`;
export const TAB_THEME_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.9-.9 1.9-1.9 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .9-1.9 1.9-1.9H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="9.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="14" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="17.2" cy="10" r="1.1" fill="currentColor" stroke="none"/></svg>`;
export const TAB_APPEARANCE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2.5 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16.5 9 5 9-5"/></svg>`;
export const CHECK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>`;
export const PENCIL_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19h4l10-10-4-4L5 15z"/><path d="m14 6 4 4"/></svg>`;
export const DUPLICATE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M8 16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/></svg>`;
export const EXPORT_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M4 20h16"/></svg>`;
export const IMPORT_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7 9l5-5 5 5M4 20h16"/></svg>`;
export const TRASH_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>`;
export const CLOSE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>`;
export const PLUS_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
export const TAB_KEYBINDINGS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>`;
export const TAB_LAYOUT_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="14" width="9" height="7" rx="1"/><rect x="16" y="14" width="5" height="7" rx="1"/></svg>`;
export const TAB_PRESETS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3M8 21v-6h8v6"/></svg>`;
export const TAB_DIAGNOSTICS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4a5 5 0 0 0-6.2 6.7L4 15.5V20h4.5l4.8-4.8A5 5 0 0 0 20 9l-3 1.5L14.5 9 13 6.5z"/></svg>`;
export const TAB_HELP_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.85.8c0 1.7-2.45 2.3-2.45 3.8"/><path d="M12 17.2h.01"/></svg>`;
export const PIN_OUTLINE_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 4h6v6l2 3H7l2-3z"/><path d="M12 13v7"/></svg>`;
export const PIN_FILLED_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 4h6v6l2 3H7l2-3z"/><path d="M12 13v7"/></svg>`;
export const FOLDER_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
export const ROOT_DRIVE_ICON =`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 13l2.2-6.5A1.5 1.5 0 0 1 7.6 5h8.8a1.5 1.5 0 0 1 1.4 1.5L20 13"/><path d="M4 13h16v4.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><path d="M16.5 16h.01M13.5 16h.01"/></svg>`;
export const REFRESH_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13a8 8 0 1 1-2.34-5.66"/><path d="M18 3v4.5h-4.5"/></svg>`;
/** An icon as a CSS image, for a stylesheet rule that draws it as a mask. */
export function iconImage(svg) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" '))}")`;
}
export const ARROW_LEFT_ICON =`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12H4M11 5l-7 7 7 7"/></svg>`;
export const CHEVRON_RIGHT_ICON =`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 5l7 7-7 7"/></svg>`;
export const STAR_ICON = `<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2.9l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.97l-5.9 3.11 1.13-6.58L2.45 9.84l6.6-.96z"/></svg>`;
export const EYE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
export const EYE_OFF_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>`;
export const PLAY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>`;
export const PAUSE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
export const VOLUME_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${VOLUME_BODY}<path d="M15.9 8.5a5 5 0 0 1 0 7"/><path d="M18.9 5.5a9 9 0 0 1 0 13"/></svg>`;
export const VOLUME_MUTED_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${VOLUME_BODY}<line x1="15.4" y1="9" x2="21.4" y2="15"/><line x1="21.4" y1="9" x2="15.4" y2="15"/></svg>`;
export const STAR_OUTLINE_ICON = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.9l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.97l-5.9 3.11 1.13-6.58L2.45 9.84l6.6-.96z"/></svg>`;

export function sizedIcon(svg, px) {
  const end = svg.indexOf(">");
  const open = svg.slice(0, end).replace(/ (width|height)="[^"]*"/g, "");
  return `${open} width="${px}" height="${px}"${svg.slice(end)}`;
}

// The lightbox's previous and next arrow, which the stylesheet mirrors for previous.
export const NAV_ARROW = sizedIcon(CHEVRON_RIGHT_ICON, 20);
