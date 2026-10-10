import { h } from "./sbg-core.js";
import { sectionTitle, titleWithKeys } from "./sbg-settings-inputs.js";
import { S, KEYBIND_GROUPS } from "./sbg-settings-catalog.js";
import { getSetting } from "./sbg-settings-store.js";
import { APP_REGISTRY } from "./sbg-theme.js";

const _ALL_KEYS = KEYBIND_GROUPS.flatMap((g) => g.keys);

function keyed(id) {
  return titleWithKeys(_ALL_KEYS.find((k) => k.id === id).label, getSetting(id));
}

const bound = (id) => !!getSetting(id).trim();

function joined(items, last) {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}` : items.join("");
}

function rich(text) {
  return text.split(/(`[^`]+`)/).filter(Boolean).map((part) =>
    part.startsWith("`") ? h("code", { class: "sbg-help__inline", text: part.slice(1, -1) }) : document.createTextNode(part));
}

function para(text) {
  return h("p", { class: "sbg-help__p" }, rich(text));
}

function bullets(items) {
  return h("ul", { class: "sbg-help__list" }, items.map((t) => h("li", {}, rich(t))));
}

function subtitle(text) {
  return h("div", { class: "sbg-help__subtitle", text });
}

function section(wrap, title, nodes) {
  sectionTitle(wrap, title);
  wrap.append(...nodes);
}

export function renderHelp({ content, tabs }) {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form sbg-help" });
  // Named as the rail names it, so a renamed tab reads the same here.
  const tabName = (id) => (tabs.find((t) => t.id === id) || {}).label;

  wrap.append(para("Sidebar Gallery shows the images, videos and audio in ComfyUI's output folder and in any folders added to the gallery, along with the settings each one was made with."));

  section(wrap, "Browsing", [
    bullets([
      "Click a card to open it in the lightbox, and right-click it for the card menu. Shift+right-click opens the browser's own menu.",
      "Drag a card onto a Load Image node to use it as that node's image, or onto the canvas to load its workflow. The image is copied into ComfyUI's input folder. If a file of that name is already there, ComfyUI reuses it when it is identical, and otherwise keeps it and saves the copy under a new name.",
      "The star on a card, shown while the pointer is on it, makes the file a favorite. Favorites in the folder dropdown shows the favorites of the root on screen.",
      "New files appear by themselves. Files from a ComfyUI run show up as soon as it finishes, and other changes on disk when you come back to the page. The refresh button in the search bar scans the root for any changes.",
      "With more than one root folder, each root keeps its own folders, pins, favorites and search, and a search covers only the root on screen.",
    ]),
  ]);

  section(wrap, "Searching", [
    bullets([
      "Type a term and press Enter. Everything typed before Enter is one term, spaces included.",
      "A plain term looks through file names, folder names and all the metadata except the negative prompt.",
      "To search one field, start the term with its name and a colon, such as `lora:detail` or `cfg:7`. Any field or section in the metadata panel works, and so does a node's name, such as `ksampler:euler`.",
      "A minus in front of a term excludes it from the search. For instance, searching for `-euler` will show all the results that don't contain euler.",
      "With two or more terms, AND or OR in the search bar decides whether a file must match all of them or any.",
      "A search stays within the folder picked and the filters, so one that finds nothing may be looking in the wrong folder.",
      "To save a search, click into the search bar and choose Save current search.",
    ]),
    subtitle("Good to know"),
    bullets([
      "A field name on its own, such as `lora`, finds every file that has that field.",
      "A term matches anywhere inside a value, so `cfg:7` also finds 7.5 and 17.",
      `\`app:\` takes ${joined(APP_REGISTRY.map((a) => a.id), "or")}.`,
      "Search results have a badge showing what section matched.",
    ]),
  ]);

  // Reset Zoom and Fullscreen have no button in the lightbox, so with no key
  // bound they go unnamed. Compare always keeps its line, since a button carries
  // that name.
  const view = [[S.KEY_RESET_ZOOM, "fits the picture back to the screen"], [S.KEY_FULLSCREEN, "shows it fullscreen"]]
    .filter(([id]) => bound(id)).map(([id, what]) => `${keyed(id)} ${what}`);
  section(wrap, "The lightbox", [
    bullets([
      "Scroll or pinch to zoom, and drag to move around once zoomed in." + (view.length ? ` ${view.join(", and ")}.` : ""),
      `${keyed(S.KEY_COMPARE)} puts the file before the current one beside it, and the metadata panel marks each section Same or Changed. Next and Previous then change the right side, and with Shift the left.`,
      "A file made using another image or audio file has a Source Image or Source Audio tab next to Generated, or Source Media when it has both, showing that file and its own settings.",
      "Delete sends the file to the Recycle Bin or the Trash. If there's none, such as on a network drive, it goes to a `.sbg-trash` folder at the top of its root.",
    ]),
  ]);

  section(wrap, "Keys", [
    bullets([
      `The ${tabName("keybindings")} tab lists the keys and mouse buttons for each action and lets you change them.`,
      ...(bound(S.KEY_TOGGLE) ? [`${keyed(S.KEY_TOGGLE)} works from anywhere on the ComfyUI page outside a text box.`] : []),
      "Space plays and pauses a video or audio file.",
    ]),
  ]);

  section(wrap, "Settings worth knowing", [
    bullets([
      "Opening a preset's row shows what loading it would change, with ticks to load only some parts. After a load or a restore, Undo in the Backups section reverses it.",
      "Presets don't include favorites, saved searches, pinned folders or the theme order.",
      `In the ${tabName("layout")} tab, typing over a section's or field's name renames it. The new name works as a search prefix, and a renamed section's name appears on the badges of matching cards. Each app's layout follows the ComfyUI layout until it is edited.`,
      "Editing a built-in theme makes a copy of it first. Themes export and import as `.sbgtheme` files.",
      `ComfyUI's output folder is always in the gallery. To add another, add its path to \`extra_roots\` in \`sidebar_gallery_config.json\`, whose location is shown in the Folders section of the ${tabName("settings")} tab, and refresh the browser page.`,
    ]),
  ]);

  section(wrap, "What it reads", [
    bullets([
      "Settings saved by ComfyUI, Automatic1111, Forge, SD.Next, Fooocus and CivitAI's generator.",
      "Images in PNG, JPEG and WebP, video in MP4, WebM, MOV, MKV and AVI, and audio in MP3, FLAC, WAV, OGG, Opus and M4A. Other file types are not shown.",
      "A file whose settings can't be read still appears in the gallery and opens, with only its file details.",
    ]),
  ]);

  section(wrap, "When something looks wrong", [
    bullets([
      "If files are missing, or deleted files still show, press Refresh in the search bar.",
      "If generation settings look wrong or are missing after an update, press Rebuild index in Diagnostics. It reads every file again while the gallery stays usable.",
      "If thumbnails or details look out of date, clear the browser caches in Diagnostics.",
    ]),
  ]);

  content.appendChild(wrap);
}
