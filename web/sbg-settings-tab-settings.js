import { h, api, apiPost } from "./sbg-core.js";
import { sectionTitle, settingRow, toggle, comboInput, numberInput } from "./sbg-settings-inputs.js";
import { S } from "./sbg-settings-catalog.js";
import { showToast, showFailure, failureText, confirmClick, noticeRow } from "./sbg-toast.js";
import { TRASH_ICON } from "./sbg-icons.js";
import { announceConfigFiles } from "./sbg-gallery-data.js";
import { galleryCache } from "./sbg-gallery-store.js";

const _postConfig = (patch) => apiPost("/sidebar_gallery/config", patch);

// The focused control stays enabled because disabling it would drop the focus,
// so a box goes read-only instead and a button or switch refuses in its handler.
function _hold(editors, on) {
  for (const el of editors) {
    const keep = on && el === document.activeElement;
    el.disabled = on && !keep;
    if (el.tagName === "INPUT") el.readOnly = keep;
  }
}

export function renderSettings({ content, galleryCtx, indexOnly }) {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });

  const _loadCfg = async () => {
    const cfg = await api("/sidebar_gallery/config");
    announceConfigFiles(cfg);
    return cfg;
  };

  // The save has already landed, so a failed reload is only logged, and the
  // gallery retries the read on its own.
  const _reloadGallery = async () => {
    if (!galleryCtx.refreshConfig) return;
    try { await galleryCtx.refreshConfig(); }
    catch (e) { console.warn("[SBG] The gallery could not reload the folder settings after a save:", e); }
  };

  const _held = (cfg) => !cfg || !!cfg.unreadable;

  sectionTitle(wrap, "Sorting");
  wrap.appendChild(comboInput(S.SORT,
    "The sort order the gallery opens with. Once you pick a sort in the sort dropdown, the gallery reopens with that one until the page is refreshed."));

  sectionTitle(wrap, "Deleting");
  wrap.appendChild(toggle(S.DELETE_CONFIRM,
    "Delete in the lightbox or a card's right-click menu needs a second press before the file goes to the Recycle Bin or Trash. With this off, one press deletes."));

  sectionTitle(wrap, "Lightbox zoom and pan");
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Zoom and pan on the image or video in the lightbox. Pinch always zooms, and drag pans when zoomed in." }));
  wrap.appendChild(comboInput(S.LB_ZOOM_SCROLL_MODE,
    "What scrolling over the image does. With Mouse, scrolling zooms. With Touchpad, a two-finger scroll pans when zoomed in. Auto works out which one you're using."));
  wrap.appendChild(comboInput(S.LB_ZOOM_ANCHOR, "Zoom towards the mouse cursor or towards the center of the view."));
  wrap.appendChild(numberInput(S.LB_ZOOM_SENSITIVITY, "How fast zooming is, from 0.1 to 5. 1 is the default."));
  wrap.appendChild(comboInput(S.LB_COMPARE_ZOOM, "In compare, zoom and pan only the side under the cursor, or both sides together."));
  wrap.appendChild(toggle(S.LB_ZOOM_KEEP_ON_NAV,
    "Keep the zoom and position when you move to the next or previous file. With this off, each file opens fitted to the screen."));

  sectionTitle(wrap, "Lightbox metadata panel");
  wrap.appendChild(toggle(S.META_TAB_PERSIST, "When you move to another file, keep the tab you're on instead of going back to Generated."));

  sectionTitle(wrap, "Library");

  let arSaved = "";
  const arInput = h("input", { type: "number", class: "sbg-gs-input", min: "0", step: "5", value: "" });
  arInput.disabled = true;

  const _applyAr = (cfg) => {
    if (cfg && typeof cfg.auto_refresh_interval_s === "number") arInput.value = arSaved = String(cfg.auto_refresh_interval_s);
    arInput.disabled = _held(cfg);
  };
  arInput.addEventListener("change", async () => {
    const n = Math.max(0, Math.floor(Number(arInput.value) || 0));
    _hold([arInput], true);
    let cfg = null;
    try {
      cfg = await _postConfig({ auto_refresh_interval_s: n });
    } catch (e) {
      arInput.value = arSaved;
      _hold([arInput], false);
      showFailure("save this setting", e);
      return;
    }
    // The server clamps the interval, so the box takes the value it saved and
    // the toast speaks only when that differs from what was typed.
    const eff = (cfg && typeof cfg.auto_refresh_interval_s === "number") ? cfg.auto_refresh_interval_s : n;
    arInput.value = arSaved = String(eff);
    _hold([arInput], false);

    if (eff > 0 && eff !== n) showToast(`Auto-Refresh Interval is set to ${eff} seconds, the ${eff > n ? "shortest" : "longest"} allowed.`);
    await _reloadGallery();
  });
  wrap.appendChild(settingRow("Auto-Refresh Interval (seconds)", arInput,
    "How often the open gallery checks the disk for added, removed or renamed files. The minimum is 5, and 0 turns it off, though the gallery still checks when you come back to it. Applies right away."));

  const noticeSlot = h("div", { class: "sbg-notices sbg-gs-notices" });
  wrap.appendChild(noticeSlot);

  function _renderNotice(cfg, failure, retried = false) {
    noticeSlot.innerHTML = "";
    if (!_held(cfg)) return;
    const text = cfg
      ? `${failureText("open the folder settings file", cfg.unreadable)}. The folders below can't be edited until the file can be opened.`
      : `${failureText("load the folders below", failure)}. They can't be edited until they load.`;
    const line = noticeRow(retried ? `${text} Tried again.` : text, () => { noticeSlot.innerHTML = ""; content.focus(); }, { failure: true });
    const again = h("button", { class: "sbg-btn sbg-btn--sm", text: "Try again" });
    again.addEventListener("click", async () => {
      again.disabled = true;
      again.textContent = "Trying…";
      await _loadAll(true);
    });
    line.insertBefore(again, line.querySelector(".sbg-notice__x"));
    noticeSlot.appendChild(line);
  }

  // Each list entry goes straight into the form as its own row, since the
  // settings search counts and marks the form's children one by one.
  const listRow = (label, sub) => {
    const el = h("div", { class: "sbg-gs-row" });
    el.appendChild(h("span", { class: "sbg-gs-label", text: label, title: sub || "" }));
    if (sub) el.appendChild(h("span", { class: "sbg-gs-desc--inline sbg-gs-subpath", text: sub }));
    return el;
  };
  const trashButton = (title) => h("button", { class: "sbg-btn sbg-btn--icon sbg-btn--icon-danger", html: TRASH_ICON, title });

  sectionTitle(wrap, "Folders");
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Extra folders to browse and index alongside ComfyUI's output folder. Paths are on the machine running ComfyUI." }));
  const outputRow = listRow("Output", "ComfyUI's output folder");
  outputRow.appendChild(h("span", { class: "sbg-gs-desc--inline", text: "Always included" }));
  wrap.appendChild(outputRow);
  const addHint = h("div", { class: "sbg-gs-desc sbg-gs-desc--top-gap" });
  addHint.appendChild(document.createTextNode(
    "To add a folder, open sidebar_gallery_config.json and put the path in its extra_roots list, for example "));
  addHint.appendChild(h("code", { text: '{"extra_roots": ["C:/Renders"]}' }));
  addHint.appendChild(document.createTextNode(". The gallery picks the change up within a few seconds."));
  wrap.appendChild(addHint);
  const configPath = h("div", { class: "sbg-gs-path sbg-hidden" });
  wrap.appendChild(configPath);

  // A removal names one folder and the server takes it from what the file holds,
  // so a list drawn before the file changed cannot drop a folder added since.
  let foldersBusy = false;
  let folderRows = [];
  let folderBins = [];

  function _renderFolders(cfg) {
    const held = _held(cfg);
    for (const el of folderRows) el.remove();
    folderRows = [];
    folderBins = [];
    for (const p of (cfg && cfg.extra_roots) || []) {
      const el = listRow(p.split(/[\\/]/).pop() || p, p);
      const del = trashButton("Remove this folder from the gallery (files on disk are not touched)");
      del.disabled = held;
      confirmClick(del, async () => {
        if (foldersBusy) return;
        foldersBusy = true;
        _hold(folderBins, true);
        let next;
        try { next = await _postConfig({ extra_roots_remove: [p] }); }
        catch (e) { showFailure("remove the folder", e); return; }
        finally { foldersBusy = false; _hold(folderBins, false); }
        const had = document.activeElement === del;
        const at = folderBins.indexOf(del);
        _renderFolders(next);
        if (had) (folderBins[at] || folderBins[at - 1] || inp).focus();
        await _reloadGallery();
      }, { label: "Remove?", busy: () => foldersBusy });
      el.appendChild(del);
      folderRows.push(el);
      folderBins.push(del);
      wrap.insertBefore(el, addHint);
    }
    const path = (cfg && cfg.config_path) || "";
    configPath.textContent = path;
    configPath.title = path;
    configPath.classList.toggle("sbg-hidden", !path);
  }

  sectionTitle(wrap, "Excluded folders");
  wrap.appendChild(h("div", { class: "sbg-gs-desc", text: "Folder names to skip when scanning, such as thumbnails or backup. A name matches a folder at any depth, in any letter case. Changes apply on the next scan." }));

  let excludedBusy = false;
  let excluded = [];
  let excludedRows = [];
  let excludedBins = [];

  const hiddenChk = h("input", { type: "checkbox", class: "sbg-gs-switch" });
  hiddenChk.disabled = true;

  // The focused switch stays enabled while it saves, so a second press is
  // stopped here before it can flip the box.
  hiddenChk.addEventListener("click", (e) => { if (excludedBusy) e.preventDefault(); });
  hiddenChk.addEventListener("change", async () => {
    setBusy(true);
    try { await _postConfig({ index_hidden_dirs: hiddenChk.checked }); }
    catch (e) {
      hiddenChk.checked = !hiddenChk.checked;
      showFailure("save this setting", e);
      return;
    } finally { setBusy(false); }
    await _reloadGallery();
  });
  wrap.appendChild(settingRow("Include Hidden Folders", hiddenChk,
    "Also scan folders whose names start with a dot, such as .thumbs."));

  const addRow = h("div", { class: "sbg-gs-row sbg-gs-row--gap" });
  const inp = h("input", { type: "text", class: "sbg-gs-input sbg-gs-grow", placeholder: "thumbnails" });
  const addBtn = h("button", { class: "sbg-btn sbg-btn--accent", text: "+ Add" });
  inp.disabled = true;
  addBtn.disabled = true;
  addRow.append(inp, addBtn);
  wrap.appendChild(addRow);

  const setBusy = (on) => {
    excludedBusy = on;
    _hold([hiddenChk, inp, addBtn, ...excludedBins], on);
  };

  function _renderExcluded(cfg) {
    const held = _held(cfg);
    excluded = (cfg && cfg.excluded_dirs) || [];
    for (const el of excludedRows) el.remove();
    excludedRows = [];
    excludedBins = [];
    hiddenChk.checked = !!(cfg && cfg.index_hidden_dirs);
    for (const el of [hiddenChk, inp, addBtn]) el.disabled = held;
    for (const name of excluded) {
      const el = listRow(name);
      const del = trashButton("Stop excluding this folder (its files reappear on the next scan)");
      del.disabled = held;
      del.addEventListener("click", async () => {
        if (excludedBusy) return;
        setBusy(true);
        let next;
        try { next = await _postConfig({ excluded_dirs_remove: [name] }); }
        catch (e) { showFailure("save this setting", e); return; }
        finally { setBusy(false); }
        const had = document.activeElement === del;
        const at = excludedBins.indexOf(del);
        _renderExcluded(next);
        if (had) (excludedBins[at] || excludedBins[at - 1] || inp).focus();
        await _reloadGallery();
      });
      el.appendChild(del);
      excludedRows.push(el);
      excludedBins.push(del);
    }
    if (!excluded.length) excludedRows.push(h("div", { class: "sbg-gs-row sbg-gs-desc--inline", text: "No extra folders excluded." }));
    for (const el of excludedRows) wrap.insertBefore(el, addRow);
  }

  const doAdd = async () => {
    if (excludedBusy) return;

    // An exclude matches a folder name, so a pasted path keeps only its last segment.
    const name = (inp.value.split(/[\\/]/).filter(Boolean).pop() || "").trim().toLowerCase();
    if (!name || name === "." || name === "..") { showToast("Enter a folder name to exclude"); return; }
    if (excluded.includes(name)) { showToast(`"${name}" is already excluded.`); inp.value = ""; return; }
    setBusy(true);
    let next;
    try { next = await _postConfig({ excluded_dirs_add: [name] }); }
    catch (e) { showFailure("exclude the folder", e); return; }
    finally { setBusy(false); }
    inp.value = "";
    _renderExcluded(next);
    await _reloadGallery();
  };
  addBtn.addEventListener("click", doAdd);
  inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") doAdd(); });

  sectionTitle(wrap, "Performance");
  wrap.appendChild(numberInput(S.VSCROLL_BUFFER, "How many rows of cards are built above and below what's on screen, from 1 to 30. More rows let thumbnails you haven't viewed yet load before they scroll into view, but mean more work for the browser."));
  wrap.appendChild(numberInput(S.GRID_WHEEL_SPEED,
    "How far one scroll step moves the gallery, for mouse wheels and touchpads alike, from 25 to 400. 100 is the browser's normal speed. Applies right away."));

  function _show(cfg, failure = "", retried = false) {
    _applyAr(cfg);
    _renderNotice(cfg, failure, retried);
    _renderFolders(cfg);
    _renderExcluded(cfg);
  }
  async function _loadAll(retried = false) {
    let cfg = null;
    let failure = "";
    try { cfg = await _loadCfg(); } catch (e) { failure = e; }
    _show(cfg, failure, retried);
  }

  // The settings search renders this tab into a detached element to count its
  // matches, so it draws the lists from the config the gallery last read.
  if (!indexOnly) _loadAll();
  else if (galleryCache.config.last) _show(galleryCache.config.last);

  content.appendChild(wrap);
}
