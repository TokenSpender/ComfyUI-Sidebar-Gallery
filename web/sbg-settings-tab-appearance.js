import { h } from "./sbg-core.js";
import { sectionTitle, toggle, comboInput, numberInput, orderList } from "./sbg-settings-inputs.js";
import { S, LB_BUTTONS, CARD_MENU_ITEMS } from "./sbg-settings-catalog.js";

export function renderAppearance({ content }) {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });

  sectionTitle(wrap, "Grid");
  wrap.appendChild(numberInput(S.THUMB_SIZE, "How wide a thumbnail should be, from 64 to 256, which decides how many fit in a row. They stretch to fill the row. Used only when Thumbnails Per Row is Auto."));
  wrap.appendChild(comboInput(S.THUMB_PER_ROW, "Auto fits as many as Thumbnail Size allows. A number puts exactly that many in each row, sized to fill the width."));
  wrap.appendChild(comboInput(S.THUMB_SHAPE, "Square crops each thumbnail to a square. Aspect ratio keeps each picture's shape where it can, trimming very wide or very tall ones."));

  sectionTitle(wrap, "Cards");
  wrap.appendChild(comboInput(S.CARD_STYLE,
    "How each file shows in the grid. Boxed shows the picture in a bordered card with the name, size and date under it. Picture with one line shows the name and date on one line under the picture. Picture only shows the name, size and date over the picture when you hover it."));
  wrap.appendChild(toggle(S.CARD_LIFT, "Lift the card and zoom its picture a little while the pointer is on it. Applies right away."));

  sectionTitle(wrap, "Toolbar");
  wrap.appendChild(comboInput(S.TOOLBAR_LAYOUT, "Where the file count and the filter buttons are shown."));
  wrap.appendChild(toggle(S.PICKER_ROOTS_IN_FOLDERS,
    "With more than one root, list the roots at the top of the folder dropdown instead of on their own button. Applies right away."));
  wrap.appendChild(numberInput(S.SEARCH_AC_ROWS,
    "How many suggestions the search bar shows before the list scrolls, from 3 to 30. Saved searches come first, then field names."));

  sectionTitle(wrap, "Card tooltip");
  wrap.appendChild(toggle(S.TOOLTIP_NAME, "Show the file's name when you hover a card."));
  wrap.appendChild(toggle(S.TOOLTIP_SIZE, "Show the file's size when you hover a card."));
  wrap.appendChild(toggle(S.TOOLTIP_DATE, "Show how long ago the file was modified when you hover a card, or the date for a file older than a week."));

  sectionTitle(wrap, "Lightbox buttons");
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "The buttons under the picture in the lightbox. Drag one to reorder it, and switch one off to hide it. Reopen the lightbox to apply." }));
  wrap.appendChild(orderList(S.LB_BUTTON_ORDER, LB_BUTTONS));

  sectionTitle(wrap, "Card menu");
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "The menu that opens when you right-click a card. Drag an item to reorder it, and switch one off to hide it. With every item off, right-clicking opens the browser's own menu." }));
  wrap.appendChild(orderList(S.CARD_MENU_ORDER, CARD_MENU_ITEMS));

  sectionTitle(wrap, "File and model names");
  wrap.appendChild(comboInput(S.FILENAME_STYLE, "Show a file's name alone, or with its folder path, in File Info."));
  wrap.appendChild(comboInput(S.MODEL_NAME_STYLE, "Show model and LoRA names alone, or with their folder path."));

  content.appendChild(wrap);
}
