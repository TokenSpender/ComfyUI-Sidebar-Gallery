import { h, downloadJson } from "./sbg-core.js";
import { summaryOf } from "./sbg-meta-cache.js";
import { sectionTitle, settingRow, nameField } from "./sbg-settings-inputs.js";
import * as TL from "./sbg-translation-layer.js";
import { getActiveProfile } from "./sbg-layout-store.js";
import {
  themeColor, userThemes, unreadableThemes, activeThemeId, activeUserTheme, activeValues, onThemesChanged, onThemePainted,
  selectTheme, recordColorEdit, forkActive, renameTheme, deleteTheme, importTheme, themeDocument, themesUnreadReason, ensureThemesLoaded, derivedColor, themeNameMax,
} from "./sbg-theme.js";
import {
  BUILT_IN_THEMES, BASE_COLORS, DARK_STAGE_TOKENS, THEME_FILE_SUFFIX,
  isBuiltIn, userThemeId, userThemeKey, themeFile,
} from "./sbg-theme-model.js";
import { themeRows, DERIVED_ROWS } from "./sbg-theme-tokens.js";
import {
  CHECK_ICON, PENCIL_ICON, DUPLICATE_ICON, EXPORT_ICON, IMPORT_ICON, TRASH_ICON, STAR_ICON, STAR_OUTLINE_ICON, GEAR_ICON,
  IMAGE_FILTER_ICON, VIDEO_FILTER_ICON, AUDIO_FILTER_ICON, REFRESH_ICON, FOLDER_ICON,
} from "./sbg-icons.js";
import { makeSection } from "./sbg-meta-section.js";
import { S, getSetting, storedSetting, saveSetting, settingsUnread, orderedIds, keepUnshown } from "./sbg-settings-store.js";
import { LB_BUTTONS, SORT_OPTIONS } from "./sbg-settings-catalog.js";
import { initSortable } from "./sbg-sortable.js";
import { paintSwatch, openColorPopover, closePopovers } from "./sbg-color-popover.js";
import { parseColor, resolveColor, formatRgba } from "./sbg-color.js";
import { showToast, showFailure, showSettingsUnread, confirmClick, failureText, noticeRow } from "./sbg-toast.js";
import { assembleCard, badgeLookups, matchBadge } from "./sbg-card.js";
import { isVideo } from "./sbg-media-kind.js";
import { wireListboxKeys } from "./sbg-a11y.js";
import { searchTagPill, arrangeToolbar } from "./sbg-gallery-search.js";

let _showDerived = null;

let _labelSeq = 0;

const GROUPS = [
  ["base", "Base colors", "The five colors everything else is built from."],
  ["gallery", "Gallery", ""],
  ["toolbar", "Toolbar", ""],
  ["lightbox", "Lightbox", ""],
  ["states", "Status colors and opacity", ""],
  ["shape", "Shape and size", ""],
];

const IMPORT_ACCEPT = THEME_FILE_SUFFIX;

// `indexOnly` is the settings search's render, which is never shown, so it
// builds the rows and nothing that fetches or listens.
export function renderTheme({ content, visitCleanups, galleryCtx, indexOnly }) {
  content.innerHTML = "";
  const de = document.documentElement;
  // A colour popover sits on the body and closes on a document mousedown, which
  // closing the panel does not fire.
  visitCleanups.push(closePopovers);
  // A variable computes to its text as written, so a color-mix or a named
  // colour is resolved through the page.
  const readToken = (name) => {
    const raw = getComputedStyle(de).getPropertyValue(name).trim();
    if (!raw || parseColor(raw)) return raw;
    const c = resolveColor(raw);
    return c ? formatRgba(c.r, c.g, c.b, c.a) : raw;
  };
  // A dark stage token's `-dark` mirror is lifted too, or the theme's value
  // would read back as the default.
  const liftedToken = (name) => {
    const st = de.style;
    const names = DARK_STAGE_TOKENS.includes(name) ? [name, name + "-dark"] : [name];
    const held = names.map(n => st.getPropertyValue(n));
    if (!held.some(Boolean)) return readToken(name);
    for (const n of names) st.removeProperty(n);
    const v = readToken(name);
    names.forEach((n, i) => { if (held[i]) st.setProperty(n, held[i]); });
    return v;
  };
  const resolveDef = (def) => (def.derived && derivedColor(def.derived))
    || (def.own ? liftedToken(def.own) : readToken(def.token)) || def.fallback || "";
  // An unread list may hold the theme in use, which an edit would replace with a
  // copy of a built-in. Import waits for the list too, so a theme it adds never
  // shows beside a list that cannot be read.
  const refused = (verb = "change") => {
    const why = themesUnreadReason();
    if (why) showFailure(`${verb} the theme`, why);
    return !!why;
  };
  const _replBaseline = {}, _replLast = {}, _replTimer = {};
  // Every picker move made on a built-in resolves to the same copy, and a second
  // rename offer would take away the field the first focused.
  let _offeredName = null;
  function write(key, value) {
    const held = activeUserTheme();
    const wasBuiltIn = !held;
    recordColorEdit(key, value).then((t) => {
      if (!wasBuiltIn || _offeredName === t) return;
      _offeredName = t;
      themeBlock.startRename(t);
    }).catch(e => showFailure("save the theme", e));
  }

  const form = h("div", { class: "sbg-gs-form" });
  const side = h("div", { class: "sbg-gs-appearance__side" });
  const grid = h("div", { class: "sbg-gs-appearance" }, [form, side]);

  const themeBlock = buildThemeBlock();
  sectionTitle(form, "Themes");

  form.appendChild(themeBlock.unreadNote);
  form.appendChild(themeBlock.list);
  form.appendChild(themeBlock.actions);
  form.appendChild(themeBlock.caption);

  const repaints = [];
  const rows = themeRows();
  const rowEls = [];
  const derivedEls = [];
  for (const [id, title, desc] of GROUPS) {
    sectionTitle(form, title);
    if (desc) form.appendChild(h("div", { class: "sbg-gs-desc", text: desc }));
    for (const spec of rows.filter(r => r.group === id)) {
      const el = buildRow(spec);
      rowEls.push(el);
      form.appendChild(el);
    }
    if (id === "base") {
      if (_showDerived === null) _showDerived = DERIVED_ROWS.some(([k]) => themeColor(k));
      const derivedSwitch = h("input", { type: "checkbox", class: "sbg-gs-switch" });
      derivedSwitch.checked = _showDerived;
      derivedSwitch.addEventListener("change", () => { _showDerived = derivedSwitch.checked; for (const d of derivedEls) d.classList.toggle("sbg-gs-row--folded", !_showDerived); });
      form.appendChild(settingRow("Show Derived Colors", derivedSwitch, "Colors worked out from the five base colors. Set one to use a different color instead."));
      for (const [key, label, origin, hit] of DERIVED_ROWS) {
        const el = buildDerivedRow(key, label, origin, hit);
        derivedEls.push(el);
        rowEls.push(el);
        form.appendChild(el);
      }
    }
  }

  content.appendChild(grid);
  themeBlock.refresh();
  if (indexOnly) return;

  const sample = buildSample();
  side.appendChild(sample.el);
  sample.fill();
  wirePointing(sample.el);
  visitCleanups.push(
    onThemesChanged(() => { if (themeBlock.list.isConnected && !themeBlock.renaming()) themeBlock.refresh(); }),
    onThemePainted(() => { for (const repaint of repaints) repaint(); }),
  );

  if (themesUnreadReason()) ensureThemesLoaded();

  function labelledRow(spec, control, cls = "sbg-gs-row") {
    const row = h("div", { class: cls, title: spec.tip || "" });
    const label = h("label", { class: "sbg-gs-label", id: `sbg-gs-theme-label-${++_labelSeq}` }, spec.note
      ? [spec.label, h("span", { class: "sbg-gs-label__note", text: spec.note })]
      : [spec.label]);
    control.setAttribute("aria-labelledby", label.getAttribute("id"));
    nameField(label, control);
    row.appendChild(label);
    if (spec.hit) row.dataset.hit = spec.hit;
    return row;
  }

  function swatchButton() {
    return h("button", { type: "button", class: "sbg-btn sbg-btn--icon sbg-gs-swatchbtn", title: "Choose color" });
  }

  function buildRow(spec) {
    if (spec.kind === "color") {
      const btn = swatchButton();
      const row = labelledRow(spec, btn);
      const colors = () => ({ bg: themeColor(spec.key) });
      const repaint = () => paintSwatch(btn, colors(), { bg: resolveDef(spec.def) }, ["bg"]);
      repaint();
      repaints.push(repaint);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (refused()) return;
        openColorPopover(btn, {
          channels: [{ key: "bg", label: "Color", def: resolveDef(spec.def) }],
          colors,
          onChange: (_k, c) => { write(spec.key, c); repaint(); },
          onClear: () => { write(spec.key, ""); repaint(); },
        });
      });
      row.appendChild(btn);
      return row;
    }
    if (spec.kind === "pair") {
      const btn = swatchButton();
      const row = labelledRow(spec, btn);
      const chDef = (c) => (c.token ? liftedToken(c.token) : resolveDef(c.def));
      const chWrite = (c, v) => {
        if (c.token) { write(c.token, v); return; }
        if (c.channel) {
          // A layout field given the old colour by hand follows the theme again.
          // Comparing a burst's first and last values keeps a picker drag from
          // chaining through every colour it passes.
          if (_replTimer[c.channel] == null) _replBaseline[c.channel] = themeColor(c.setting) || "";
          _replLast[c.channel] = v;
          clearTimeout(_replTimer[c.channel]);
          _replTimer[c.channel] = setTimeout(() => {
            _replTimer[c.channel] = null;
            if (_replBaseline[c.channel]) TL.clearElementColor(c.channel, _replBaseline[c.channel], _replLast[c.channel]);
          }, 400);
        }
        write(c.setting, v);
      };
      const defsOf = () => Object.fromEntries(spec.channels.map(c => [c.key, chDef(c)]));
      const keys = spec.channels.map(c => c.key);
      const colors = () => Object.fromEntries(spec.channels.map(c => [c.key, themeColor(c.token || c.setting)]));
      const repaint = () => paintSwatch(btn, colors(), defsOf(), keys);
      repaint();
      repaints.push(repaint);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (refused()) return;
        const defs = defsOf();
        openColorPopover(btn, {
          channels: spec.channels.map(c => ({ key: c.key, label: c.label, def: defs[c.key] })),
          colors,
          onChange: (k, v) => { chWrite(spec.channels.find(c => c.key === k), v); repaint(); },
          onClear: () => { for (const c of spec.channels) chWrite(c, ""); repaint(); },
        });
      });
      row.appendChild(btn);
      return row;
    }
    const input = h("input", {
      type: "number", class: "sbg-gs-input sbg-gs-num", min: "0", max: spec.max, step: spec.unit === "%" ? "5" : "1",
    });
    const row = labelledRow(spec, input);
    const shown = () => {
      const n = parseFloat(themeColor(spec.key) || resolveDef(spec.def));
      if (Number.isNaN(n)) return "";
      return spec.unit === "%" ? String(Math.round(n * 100)) : String(n);
    };
    const repaint = () => { if (document.activeElement !== input) input.value = shown(); };
    input.value = shown();
    repaints.push(repaint);
    input.addEventListener("change", () => {
      const n = parseFloat(input.value);
      if (input.value.trim() === "" && !refused()) {
        // Emptied, it goes back to the default as a colour row's Reset does,
        // and only where the theme in use holds a value of its own.
        const held = activeUserTheme();
        if (held && held.values[spec.key]) write(spec.key, "");
        input.value = shown();
        return;
      }
      if (Number.isNaN(n) || refused()) { input.value = shown(); return; }
      if (spec.unit === "%") {
        write(spec.key, String(Math.max(0, Math.min(100, n)) / 100));
        return;
      }
      // Writing px over a stored em value would change the size.
      const held = String(themeColor(spec.key) || resolveDef(spec.def) || "");
      const unit = (held.match(/[a-z]+$/i) || ["px"])[0];
      const kept = Math.min(spec.max ?? Infinity, Math.max(0, n));
      if (kept !== n) input.value = String(kept);
      write(spec.key, `${kept}${unit}`);
    });
    row.appendChild(h("span", { class: "sbg-gs-numwrap" }, [input, h("span", { class: "sbg-gs-unit", text: spec.unit })]));
    return row;
  }

  function buildDerivedRow(key, label, origin, hit) {
    const btn = swatchButton();
    const row = labelledRow({ label, hit, tip: "Computed from the five base colors unless set here" }, btn,
      "sbg-gs-row sbg-gs-row--derived" + (_showDerived ? "" : " sbg-gs-row--folded"));
    const val = h("span", { class: "sbg-gs-derived", text: origin });
    const colors = () => ({ bg: themeColor(key) });
    const def = () => derivedColor(key) || readToken(key);
    const repaint = () => {
      paintSwatch(btn, colors(), { bg: def() }, ["bg"]);
      val.textContent = themeColor(key) ? "Set here" : origin;
    };
    repaint();
    repaints.push(repaint);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (refused()) return;
      openColorPopover(btn, {
        channels: [{ key: "bg", label: "Color", def: def() }],
        colors,
        onChange: (_k, c) => { write(key, c); repaint(); },
        onClear: () => { write(key, ""); repaint(); },
      });
    });
    row.appendChild(h("span", { class: "sbg-gs-derived-wrap" }, [val, btn]));
    return row;
  }

  function buildThemeBlock() {
    const list = h("div", { class: "sbg-gs-themes", role: "listbox", "aria-label": "Themes", tabindex: "0" });
    const unreadNote = h("div", { class: "sbg-notices sbg-gs-notices" });
    // The failure the person closed, which the list's redraws leave closed, and
    // the one on screen, which a redraw leaves in place under the focus.
    let closedUnread = null;
    let shownUnread = null;

    const guard = (verb, fn) => async (...args) => {
      try { await fn(...args); } catch (e) { showFailure(`${verb} the theme`, e); }
    };
    const imp = h("button", { type: "button", class: "sbg-btn sbg-btn--iconlabel sbg-gs-theme__import", title: "Add a theme from a file" }, [
      h("span", { html: IMPORT_ICON, "aria-hidden": "true" }), h("span", { text: "Import theme" }),
    ]);
    imp.addEventListener("click", () => {
      if (refused("import")) return;
      const fi = h("input", { type: "file", accept: IMPORT_ACCEPT });
      fi.addEventListener("change", guard("import", async () => {
        if (!fi.files.length) return;
        // A file that is not JSON is left for the reader to refuse in its own words.
        const text = await fi.files[0].text();
        let raw = null;
        try { raw = JSON.parse(text); } catch { }
        // A new theme shows in the list below, so only a file the list already
        // held is said.
        const before = new Set(userThemes().map((x) => x.id));
        const t = await importTheme(raw);
        if (before.has(t.id)) showToast(`"${t.name}" is already in the theme list.`);
      }));
      fi.click();
    });
    const actions = h("div", { class: "sbg-gs-actions" }, [imp]);
    const caption = h("div", { class: "sbg-gs-desc", text: "Changes below save to the selected theme as you make them. A change to a built-in theme makes a copy of it first." });

    const iconBtn = (icon, title, focus, cls = "") => h("button", {
      type: "button", class: "sbg-btn sbg-gs-theme__btn" + (cls ? " " + cls : ""), title, "aria-label": title, html: icon, "data-focus": focus,
    });
    let _renaming = false;
    let resyncKeys = null;
    const wireKeys = () => wireListboxKeys(list, {
      markClass: "sbg-gs-theme--kbd",
      getOptions: () => [...list.querySelectorAll(".sbg-gs-theme")],
      keyOf: (o) => o.getAttribute("data-id"),
      controlsOf: (o) => [...o.querySelectorAll("button")],
      takeFocus: false,
    });

    function rowFor(entry) {
      const active = entry.id === activeThemeId();
      const row = h("div", {
        class: "sbg-gs-theme" + (active ? " sbg-gs-theme--active" : ""), role: "option", "aria-selected": String(active),
        tabindex: "-1", "data-id": entry.id, "data-focus": `${entry.id}#row`,
      });
      row.appendChild(h("span", { class: "sbg-grip sbg-gs-theme__grip", text: "⋮⋮", title: "Drag to reorder", "aria-hidden": "true" }));
      row.appendChild(h("span", { class: "sbg-gs-theme__check", html: active ? CHECK_ICON : "", "aria-hidden": "true" }));
      row.appendChild(h("span", { class: "sbg-gs-theme__strip", "aria-hidden": "true" },
        BASE_COLORS.map(({ key }) => h("span", { class: "sbg-gs-theme__swatch", style: entry.values[key] ? `background:${entry.values[key]}` : "" }))));
      const name = h("span", { class: "sbg-gs-theme__name", text: entry.name });
      row.appendChild(name);
      if (entry.builtIn) row.appendChild(h("span", { class: "sbg-gs-theme__tag", text: entry.note ? `Built-in, ${entry.note}` : "Built-in" }));
      const select = () => { if (activeThemeId() !== entry.id) selectTheme(entry.id); };
      row.addEventListener("click", (e) => { if (e.target.closest(".sbg-gs-theme__actions, .sbg-gs-theme__rename, .sbg-gs-theme__grip")) return; select(); });
      // The list's own keys would pick the row they have marked.
      row.addEventListener("keydown", (e) => {
        if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        e.stopPropagation();
        select();
      });
      if (!active) return row;
      const acts = h("span", { class: "sbg-gs-theme__actions" });
      if (entry.theme) {
        const ren = iconBtn(PENCIL_ICON, "Rename", `${entry.id}#rename`);
        ren.addEventListener("click", () => renameRow(name, entry.theme));
        acts.appendChild(ren);
      }
      const dup = iconBtn(DUPLICATE_ICON, "Duplicate this theme", `${entry.id}#dup`);
      // Another settings tab may have taken the content during the wait.
      dup.addEventListener("click", guard("duplicate", async () => {
        if (refused("duplicate")) return;
        const t = await forkActive();
        if (list.isConnected) startRename(t);
      }));
      acts.appendChild(dup);
      const exp = iconBtn(EXPORT_ICON, "Export this theme to a file", `${entry.id}#export`);
      // A file's name holds no character a browser would change on the way to disk.
      exp.addEventListener("click", async () => {
        if (!entry.theme) { downloadJson(themeFile({ name: entry.name, values: activeValues() }), `${entry.name}${THEME_FILE_SUFFIX}`); return; }
        try { downloadJson(await themeDocument(entry.theme), entry.theme.filename); }
        catch (e) { showFailure("export the theme", e); }
      });
      acts.appendChild(exp);
      if (entry.theme) {
        const del = iconBtn(TRASH_ICON, "Delete this theme", `${entry.id}#delete`, "sbg-btn--icon-danger");
        confirmClick(del, guard("delete", async () => {
          const where = await deleteTheme(entry.theme);
          if (where) showToast(`Theme "${entry.theme.name}" moved to ${where}.`, 4000);
        }));
        acts.appendChild(del);
      }
      row.appendChild(acts);
      return row;
    }

    function unreadableRow(t) {
      const row = h("div", { class: "sbg-gs-theme sbg-gs-theme--unreadable", role: "option", "aria-selected": "false", "aria-disabled": "true" });
      row.appendChild(h("span", { class: "sbg-gs-theme__name", text: `${t.filename} (can't be read)` }));
      const del = iconBtn(TRASH_ICON, `Delete ${t.filename}`, `file:${t.filename}#delete`, "sbg-btn--icon-danger");
      confirmClick(del, guard("delete", async () => {
        const where = await deleteTheme(t);
        if (where) showToast(`"${t.filename}" moved to ${where}.`, 4000);
      }));
      row.appendChild(h("span", { class: "sbg-gs-theme__actions" }, [del]));
      return row;
    }

    function renameRow(nameEl, theme) {
      if (_renaming) return;
      _renaming = true;
      const input = h("input", {
        type: "text", class: "sbg-gs-input sbg-gs-theme__rename", value: theme.name, "aria-label": "Theme name", maxlength: themeNameMax(),
      });
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (commit, keepFocus) => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        try { if (commit && next && next !== theme.name) await renameTheme(theme, next); }
        catch (e) { showFailure("rename the theme", e); }
        finally { _renaming = false; refresh(keepFocus ? `${userThemeId(theme.id)}#rename` : undefined); }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true, true); }
        else if (e.key === "Escape") { e.stopPropagation(); finish(false, true); }
      });
      input.addEventListener("blur", () => finish(true, false));
    }

    function startRename(theme) {
      const id = userThemeId(theme.id);
      const row = [...list.querySelectorAll(".sbg-gs-theme")].find(r => r.getAttribute("data-id") === id);
      const name = row && row.querySelector(".sbg-gs-theme__name");
      if (name) renameRow(name, theme);
    }

    // A theme the saved order has not met yet goes above the built-ins.
    function listOrder(ids) {
      const ordered = orderedIds(S.THEME_ORDER, ids);
      const saved = storedSetting(S.THEME_ORDER) ?? null;
      if (!Array.isArray(saved)) return ordered;
      const fresh = ordered.filter(id => userThemeKey(id) && !saved.includes(id));
      const rest = ordered.filter(id => !fresh.includes(id));
      const at = rest.findIndex(isBuiltIn);
      rest.splice(at < 0 ? rest.length : at, 0, ...fresh);
      return rest;
    }

    // Where the focused control is gone, such as a deleted theme's Delete, the
    // list takes the focus so the next Tab stays in the panel.
    function refresh(focus) {
      const el = document.activeElement;
      const held = focus !== undefined ? focus : (el && list.contains(el) ? (el.getAttribute("data-focus") || "") : null);
      list.innerHTML = "";
      const unread = themesUnreadReason();
      const showing = unread && unread !== closedUnread ? unread : null;
      if (showing !== shownUnread) {
        shownUnread = showing;
        unreadNote.textContent = "";
        if (showing) {
          unreadNote.appendChild(noticeRow(`${failureText("load the theme list", showing)}. Only built-in themes are listed.`,
            () => { closedUnread = showing; shownUnread = null; unreadNote.textContent = ""; list.focus(); }, { failure: true }));
        }
      }
      const entries = [
        ...userThemes().map(t => ({ id: userThemeId(t.id), name: t.name, values: t.values || {}, theme: t })),
        ...BUILT_IN_THEMES.map(t => ({ id: t.id, name: t.name, note: t.note, values: t.values || {}, builtIn: true })),
      ];
      const byId = new Map(entries.map(e => [e.id, e]));
      for (const id of listOrder(entries.map(e => e.id))) {
        const row = rowFor(byId.get(id));
        list.appendChild(row);
        if (indexOnly) continue;
        initSortable(list, row.querySelector(".sbg-gs-theme__grip"), row, {
          itemSelector: ".sbg-gs-theme",
          onDrop: () => {
            if (settingsUnread()) {
              showSettingsUnread();
              return;
            }
            // An unread list or an unreadable file leaves a theme without a row,
            // and its place in the order is kept for when it is listed again.
            const ids = [...list.children].map(r => r.dataset.id).filter(Boolean);
            const rows = new Set(ids);
            saveSetting(S.THEME_ORDER, keepUnshown(storedSetting(S.THEME_ORDER), ids, id => rows.has(id)));
          },
        });
      }
      for (const t of unreadableThemes()) list.appendChild(unreadableRow(t));
      if (resyncKeys) resyncKeys(true);
      else if (!indexOnly) resyncKeys = wireKeys();
      if (held === null) return;
      const target = held && [...list.querySelectorAll("[data-focus]")].find(e => e.getAttribute("data-focus") === held);
      (target || list).focus();
    }

    return { unreadNote, list, actions, caption, refresh, startRename, renaming: () => _renaming };
  }

  function buildSample() {
    const items = (galleryCtx && galleryCtx.getAllItems) ? galleryCtx.getAllItems() : [];
    const withThumb = items.filter(it => it.thumb_url);
    const picked = withThumb.slice(0, 3);
    // One card becomes a video so the format badge has somewhere to show.
    if (picked.length === 3 && !picked.some(isVideo)) {
      const vid = withThumb.find(isVideo);
      if (vid) picked[1] = vid;
    }
    const cardStyle = getSetting(S.CARD_STYLE);
    const lookups = badgeLookups();
    const card = (it, i) => {
      const img = h("img", { class: "sbg-card__thumb", alt: "", draggable: "false", src: it.thumb_url });
      const thumb = h("div", { class: "sbg-card__thumb-wrap sbg-card__thumb-wrap--square" }, [img]);
      const fav = h("span", { class: "sbg-card__fav" + (i === 0 ? " sbg-card__fav--on" : ""), html: i === 0 ? STAR_ICON : STAR_OUTLINE_ICON, "aria-hidden": "true" });
      const el = assembleCard(cardStyle, it, thumb, fav, i === 1 ? [matchBadge("filename", 1, lookups)] : []);
      if (i === 1) el.classList.add("sbg-gs-sample__hover");
      return el;
    };
    const refreshBtn = h("span", { class: "sbg-search-refresh sbg-search-refresh--visible", html: REFRESH_ICON, "aria-hidden": "true" });
    const searchWrap = h("div", { class: "sbg-search-wrap" }, [
      h("span", { class: "sbg-search-inputbox" }, [
        h("span", { class: "sbg-search-tags" }, [searchTagPill({ raw: "lora:detail" }).pill, searchTagPill({ raw: "blurry", exclude: true }).pill]),
        h("input", { class: "sbg-search-input", type: "text", placeholder: "Search… (name: for file names only)", tabindex: "-1", readonly: "" }),
      ]),
      refreshBtn,
    ]);
    const layout = getSetting(S.TOOLBAR_LAYOUT);
    const total = items.length.toLocaleString();
    const sq = (icon) => h("span", { class: "sbg-btn sbg-btn--square", html: icon, "aria-hidden": "true" });
    const seg = (content, on) => h("span", { class: "sbg-btn sbg-btn--seg" + (on ? " sbg-btn--active" : ""), ...content });
    const toolbar = arrangeToolbar(layout, {
      searchWrap,
      refreshBtn,
      kindGroup: h("div", { class: "sbg-kind-group" }, [seg({ text: "All" }, true), seg({ html: IMAGE_FILTER_ICON }), seg({ html: VIDEO_FILTER_ICON }), seg({ html: AUDIO_FILTER_ICON })]),
      countEl: h("span", { class: "sbg-count", text: layout === "count-in-search" ? total : `${total} files` }),
      folderNav: h("div", { class: "sbg-folder-nav" }, [
        h("span", { class: "sbg-folder-btn sbg-folder-btn--folders" }, [h("span", { class: "sbg-folder-btn__icon", html: FOLDER_ICON, "aria-hidden": "true" }), h("span", { class: "sbg-folder-btn__label", text: "All folders" })]),
      ]),
      sortSel: h("span", { class: "sbg-select sbg-select--auto sbg-gs-sample__sort", text: SORT_OPTIONS.find(([k]) => k === "created_desc")[1] }),
      gearBtn: sq(GEAR_ICON),
      // In this layout the notification area stays open as a third row holding the count.
      area: layout === "rows" ? h("div", { class: "sbg-area sbg-area--open" }, [h("div", { class: "sbg-area__progress" }, [
        h("div", { class: "sbg-area__row" }, [h("span", { class: "sbg-area__text" }), h("span", { class: "sbg-area__right", text: `${total} files` })]),
      ])]) : null,
    });
    const cards = h("div", { class: "sbg-gs-sample__grid" }, picked.map(card));
    if (!picked.length) cards.appendChild(h("div", { class: "sbg-gs-desc", text: "No thumbnails in the library yet." }));
    const root = h("div", { class: "sbg-root sbg-gs-sample__root" }, [toolbar, cards]);

    const lbLabel = Object.fromEntries(LB_BUTTONS.map(b => [b.id, b.label]));
    const buttonById = {
      favorite: h("span", { class: "sbg-btn sbg-lb__act--favorite" }, [h("span", { class: "sbg-fav-star", html: STAR_OUTLINE_ICON, "aria-hidden": "true" }), lbLabel.favorite]),
      download: h("span", { class: "sbg-btn sbg-lb__act--download", text: lbLabel.download }),
      "copy-prompt": h("span", { class: "sbg-btn sbg-lb__act--copy-prompt", text: lbLabel["copy-prompt"] }),
      "copy-wf": h("span", { class: "sbg-btn sbg-lb__act--copy-wf", text: lbLabel["copy-wf"] }),
      "load-wf": h("span", { class: "sbg-btn sbg-btn--accent sbg-lb__act--load-wf", text: lbLabel["load-wf"] }),
      compare: h("span", { class: "sbg-btn sbg-lb__act--compare", text: lbLabel.compare }),
      delete: h("span", { class: "sbg-btn sbg-btn--danger sbg-btn--delete sbg-lb__act--delete", text: lbLabel.delete }),
    };

    const buttons = orderedIds(S.LB_BUTTON_ORDER, LB_BUTTONS.map(b => b.id)).map(id => buttonById[id]);

    const metaBody = h("div", { class: "sbg-lb__meta-body" });
    const panel = h("div", { class: "sbg-lb__meta-panel sbg-gs-sample__meta" }, [
      h("div", { class: "sbg-lb__meta-header" }, [h("div", { class: "sbg-lb__bottom-actions sbg-gs-sample__actions" }, buttons)]),
      metaBody,
    ]);
    const el = h("div", { class: "sbg-gs-sample" }, [root, panel]);

    function fill() {
      const first = picked[0];
      if (!first) return;
      summaryOf(first).then(m => {
        if (!metaBody.isConnected || !m || !m.summary) return;
        const merged = TL.mergeFileInfo(m.summary, m.file || first);
        const profile = getActiveProfile(m.summary.source_app, first.kind);

        const rendered = [];
        for (const section of TL.visibleSections(profile, merged)) {
          const contentEl = TL.renderSection(section, merged, {});
          if (!contentEl) continue;
          rendered.push({ section, contentEl, prompt: !!contentEl.querySelector(".sbg-prompt-text") });
          if (rendered.length >= 8) break;
        }
        const chosen = rendered.filter(r => !r.prompt).slice(0, 1);
        const promptSec = rendered.find(r => r.prompt);
        if (promptSec) chosen.push(promptSec); else if (rendered[1]) chosen.push(rendered[1]);
        for (const { section, contentEl } of chosen) {
          metaBody.appendChild(makeSection({ ...section, open: true }, contentEl, { remember: false, still: true }));
        }
        // A highlighted first word gives the Search Highlight row something to show.
        const prompt = metaBody.querySelector(".sbg-prompt-text");
        const textNode = prompt && [...prompt.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim());
        if (textNode) {
          const text = textNode.nodeValue;
          const lead = text.length - text.trimStart().length;
          const body = text.slice(lead);
          const cut = body.search(/[\s,]/);
          const head = cut === -1 ? body : body.slice(0, cut);
          if (head) {
            textNode.nodeValue = text.slice(0, lead) + body.slice(head.length);
            prompt.insertBefore(h("span", { class: "sbg-highlight", text: head }), textNode);
          }
        }
      }).catch(() => { });
    }
    return { el, fill };
  }

  function wirePointing(ex) {
    const hitRows = rowEls.filter(r => r.dataset.hit);

    let lit = [], litRows = [], current = null;
    const clear = () => {
      if (!lit.length && !litRows.length) return;
      for (const el of lit) el.classList.remove("sbg-gs-hit");
      for (const r of litRows) r.classList.remove("sbg-gs-row--hit");
      lit = []; litRows = []; current = null;
    };
    const light = (rows, markRows) => {
      clear();
      for (const r of rows) {
        for (const el of ex.querySelectorAll(r.dataset.hit)) { el.classList.add("sbg-gs-hit"); lit.push(el); }
        if (markRows) { r.classList.add("sbg-gs-row--hit"); litRows.push(r); }
      }
      current = rows;
    };
    for (const r of hitRows) {
      const enter = () => light([r], false);
      r.addEventListener("mouseenter", enter);
      r.addEventListener("focusin", enter);
      r.addEventListener("mouseleave", clear);
      r.addEventListener("focusout", clear);
    }

    ex.addEventListener("mousemove", (e) => {
      let el = e.target, found = null;
      while (el && el !== ex && !found) {
        const t = hitRows.filter(r => el.matches(r.dataset.hit));
        if (t.length) found = t;
        el = el.parentElement;
      }
      if (!found) { clear(); return; }
      // Relighting the same rows would restart every transition on each move.
      if (current && current.length === found.length && current.every((r, i) => r === found[i])) return;
      light(found, true);
    });
    ex.addEventListener("mouseleave", clear);
    ex.addEventListener("click", () => {
      if (litRows.length) litRows[0].scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
}
