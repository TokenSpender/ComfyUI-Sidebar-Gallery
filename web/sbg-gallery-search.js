import {
  h,
  searchState,
  apiPost,
} from "./sbg-core.js";
import { getSetting, storedSetting, saveSetting, settingsUnread, S } from "./sbg-settings-store.js";
import { showToast, showSettingsUnread, failureText } from "./sbg-toast.js";
import { REFRESH_ICON, CLOSE_ICON, TRASH_ICON, sizedIcon } from "./sbg-icons.js";
import { attachOverlayThumb } from "./sbg-overlay-thumb.js";
import { galleryCache, decodeSearchMatches } from "./sbg-gallery-store.js";
import { getSectionRenames, getCustomSectionSearchMap, getFieldLabelSearchMap, FILE_FACT_FIELDS } from "./sbg-translation-layer.js";
import { resolveSchemaField, schemaPrefixes, schemaSections, schemaRoots } from "./sbg-schema.js";

// A typed summary path scopes the search to that path alone. Only its root is
// checked, so a path no file carries finds nothing.
function _resolvePathSpelling(rawKey, key) {
  if (key.startsWith("workflow_nodes.")) {
    const rest = rawKey.slice("workflow_nodes.".length).trim();
    if (!rest) return null;
    const parts = rest.split(".");
    // A node class name can hold dots of its own, so every prefix of what was
    // typed is offered as the class.
    const classes = [];
    for (let i = 1; i <= parts.length; i++) classes.push(parts.slice(0, i).join("."));
    const r = { field: "workflow_nodes", nodeClasses: classes };
    if (parts.length > 1) r.nodePath = rest;
    return r;
  }
  const root = key.split(".")[0];
  if (!root) return null;
  if (!key.includes(".") && FILE_FACT_FIELDS[root]) return { field: FILE_FACT_FIELDS[root] };
  if (!schemaRoots().includes(root)) return null;
  return { field: key, keyPaths: [rawKey.trim()] };
}

// Only a spelling typed before a colon resolves as a field label or a summary
// path, and it arrives with its case as `rawTyped`. One that is both searches
// both, so a label never takes a path's spelling away.
function _resolveSearchField(typed, rawTyped = null) {
  const key = String(typed).trim().toLowerCase();

  let field = resolveSchemaField(key);
  if (!field) {
    for (const [canonical, renamed] of Object.entries(getSectionRenames())) {
      if (String(renamed).toLowerCase() === key) {
        field = schemaSections()[canonical]?.search_field || null;
        break;
      }
    }
  }
  if (field) return { field };
  const custom = getCustomSectionSearchMap()[key];
  if (custom) return { field: custom.field, nodeClasses: custom.classes || null };

  if (rawTyped == null) return null;
  const e = getFieldLabelSearchMap()[key];
  const fl = e ? { field: e.field, nodeClasses: e.classes || null, keyPaths: e.keyPaths || null } : null;
  const pr = _resolvePathSpelling(rawTyped, key);
  if (fl && pr) {
    const classes = [...new Set([...(fl.nodeClasses || []), ...(pr.nodeClasses || [])])];
    const paths = [...new Set([...(fl.keyPaths || []), ...(pr.keyPaths || [])])];
    return {
      field: fl.field,
      nodeClasses: classes.length ? classes : null,
      keyPaths: paths.length ? paths : null,
      nodePath: pr.nodePath || null,
    };
  }
  return fl || pr;
}

export function parseSearchTag(input) {
  let raw = String(input).trim();
  if (!raw) return null;
  let exclude = false;
  if (raw.startsWith("-")) {
    exclude = true;
    raw = raw.replace(/^-\s*/, "");
    if (!raw) return null;
  }
  const lc = raw.toLowerCase();
  let field = "any", value = lc, nodeClasses = null, keyPaths = null, nodePath = null;
  const ci = lc.indexOf(":");
  const typedField = ci > 0 ? lc.slice(0, ci).trim() : "";
  const known = typedField ? _resolveSearchField(typedField, raw.slice(0, ci).trim()) : null;
  if (known) {
    field = known.field;
    value = lc.slice(ci + 1).trim();
    nodeClasses = known.nodeClasses || null;
    keyPaths = known.keyPaths || null;
    nodePath = known.nodePath || null;
  } else if (typedField && ci < 30) {
    // The server reads an unknown field as a node class or title and then as a
    // key of that name. A colon far into the text belongs to the text.
    field = typedField;
    value = lc.slice(ci + 1).trim();
  } else {
    // A field name typed alone matches every file that has that field.
    const r = _resolveSearchField(lc);
    if (r) { field = r.field; nodeClasses = r.nodeClasses || null; value = ""; }
  }
  return {
    field, value, raw, exclude,
    ...(nodeClasses ? { node_classes: nodeClasses } : {}),
    ...(keyPaths ? { key_paths: keyPaths } : {}),
    ...(nodePath ? { node_path: nodePath } : {}),
  };
}

function _typedText(tag) {
  return (tag.exclude ? "-" : "") + tag.raw;
}

export function highlightTerms(tags) {
  return tags.filter(t => !t.exclude && t.value).map(t => t.value);
}

// A row carrying a kind is a saved search or the save row, and completing the
// typed text must land on neither.
export function firstCompletionRow(items) {
  for (const el of items) {
    if (!el.dataset || !el.dataset.kind) return el;
  }
  return null;
}

/** The Theme tab's sample draws this pill too. */
export function searchTagPill(tag) {
  const neg = tag.exclude === true;
  const text = h("span", { text: (neg ? "−" : "") + tag.raw, class: "sbg-search-tag__text" });
  const rm = h("span", { class: "sbg-search-tag__remove", html: sizedIcon(CLOSE_ICON, 10), title: "Remove tag", "aria-label": "Remove tag" });
  const pill = h("span", { class: "sbg-search-tag" + (neg ? " sbg-search-tag--neg" : "") }, [text, rm]);
  return { pill, text, rm };
}

/** `layout` is one of the three the Appearance tab offers. The gallery and the
 *  Theme tab's sample both lay out their toolbar here. */
export function arrangeToolbar(layout, { searchWrap, refreshBtn, kindGroup, countEl, folderNav, sortSel, gearBtn, area }) {
  const row = h("div", { class: "sbg-toolbar-row" });
  if (layout === "filters-in-search") {
    searchWrap.classList.add("sbg-search-wrap--filters");
    searchWrap.insertBefore(kindGroup, refreshBtn);
    row.append(folderNav, countEl, h("span", { class: "sbg-toolbar__spacer" }), sortSel, gearBtn);
  } else {
    if (layout === "count-in-search") searchWrap.insertBefore(countEl, refreshBtn);
    row.append(folderNav, kindGroup, sortSel, gearBtn);
  }
  return h("div", { class: `sbg-toolbar sbg-toolbar--${layout}` }, [searchWrap, row, area]);
}

let _listCount = 0;

export function createSearchBar({ state, teardown, setView, refilter, announce, line, compact }) {
  const listId = `sbg-search-ac-${++_listCount}`;
  let _rowCount = 0;

  // With the filter buttons on the search bar's row there is room only for the
  // short placeholder.
  const qInput = h("input", {
    class: "sbg-search-input", placeholder: compact ? "Search…" : "Search… (name: for file names only)",
    title: "To search a value in a specific widget/node/etc, type it with a prefix (e.g. cfg:1). To exclude a value from a search, add a minus sign before it (e.g. -euler).",
    role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": listId,
  });
  const searchClear = h("button", { class: "sbg-search-clear", html: CLOSE_ICON, title: "Clear search", "aria-label": "Clear search" });
  const searchRefresh = h("button", { class: "sbg-search-refresh", html: REFRESH_ICON, title: "Refresh (scan for changes)", "aria-label": "Refresh gallery" });
  const _syncSearchBtns = () => {
    const active = state.searchTags.length > 0 || qInput.value.length > 0;
    searchClear.classList.toggle("sbg-search-clear--visible", active);
    searchRefresh.classList.toggle("sbg-search-refresh--visible", !active);
  };
  const searchTagsWrap = h("div", { class: "sbg-search-tags" });

  const searchModeSel = h("select", { class: "sbg-search-mode sbg-hidden", title: "Match all tags (AND) or any tag (OR)" }, [
    h("option", { value: "AND", text: "AND" }),
    h("option", { value: "OR", text: "OR" })
  ]);
  searchModeSel.addEventListener("change", () => {
    setView({ searchMode: searchModeSel.value });
    _runSearch();
  });

  const inputFlexBox = h("div", { class: "sbg-search-inputbox" }, [searchTagsWrap, qInput]);

  const autoCompleteDropdown = h("div", { class: "sbg-search-ac", id: listId, role: "listbox", "aria-label": "Suggestions" });
  attachOverlayThumb(autoCompleteDropdown);
  autoCompleteDropdown.classList.add("sbg-hidden");
  const _acVisible = () => !autoCompleteDropdown.classList.contains("sbg-hidden");
  let _acSelectedIdx = -1;

  // Set while the save form holds the dropdown, so nothing rebuilds or hides it.
  let _acPinned = false;

  // Set once the window loses focus, so coming back to the page does not open
  // the list again.
  let _acSuppressed = false;

  function _acSelect(i) {
    _acSelectedIdx = i;
    const items = autoCompleteDropdown.querySelectorAll(".sbg-search-ac-item");
    items.forEach((el, n) => {
      el.classList.toggle("sbg-search-ac-item--active", n === i);
      el.setAttribute("aria-selected", n === i ? "true" : "false");
    });
    const active = items[i];
    if (!active) { qInput.removeAttribute("aria-activedescendant"); return; }
    qInput.setAttribute("aria-activedescendant", active.id);
    // Only the list scrolls, since scrollIntoView would also scroll the
    // gallery's clipped root and leave the toolbar out of reach.
    const list = autoCompleteDropdown;
    const bottom = active.offsetTop + active.offsetHeight;
    if (active.offsetTop < list.scrollTop) list.scrollTop = active.offsetTop;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
  const _acShow = () => {
    autoCompleteDropdown.classList.remove("sbg-hidden");
    qInput.setAttribute("aria-expanded", "true");
  };
  const _acHide = () => {
    autoCompleteDropdown.classList.add("sbg-hidden");
    qInput.setAttribute("aria-expanded", "false");
    _acSelect(-1);
  };
  const _acRow = (cls, attrs = {}) => h("div", {
    class: "sbg-search-ac-item" + cls, role: "option", id: `${listId}-${_rowCount++}`, "aria-selected": "false", ...attrs,
  });
  const _acHead = (text) => h("div", { class: "sbg-search-ac-head", role: "presentation", text });

  const _SAVED_CAP = 30;

  // A delete or a save edits the list as stored, so a search of a shape this
  // version cannot read, and every field of one it can, stay as a later version
  // wrote them.
  function _storedSaved() {
    const raw = storedSetting(S.SAVED_SEARCHES);
    return Array.isArray(raw) ? raw.slice() : [];
  }
  const _readable = (p) => !!p && typeof p === "object" && typeof p.name === "string" && Array.isArray(p.tags);

  // Each tag is kept as the text it was typed, so a saved search resolves its
  // fields when it is applied.
  function _loadSaved() {
    return _storedSaved().filter(_readable).map(p => ({ ...p, tags: p.tags.filter(t => typeof t === "string") }));
  }

  function _storeSaved(list) {
    if (settingsUnread()) {
      showSettingsUnread();
      return false;
    }
    saveSetting(S.SAVED_SEARCHES, list);
    return true;
  }

  function _applySaved(p) {
    state.searchTags = p.tags.map((t) => parseSearchTag(t)).filter(Boolean);
    setView({ searchMode: p.mode === "OR" ? "OR" : "AND" });
    searchModeSel.value = state.searchMode;
    qInput.value = "";
    _acHide();
    renderSearchTags();
    _runSearch();
    qInput.focus();
  }

  function _deleteSaved(name) {
    if (!_storeSaved(_storedSaved().filter(p => !(_readable(p) && p.name === name)))) return;
    _updateAutocomplete();
  }

  function _commitSaved(name) {
    const clean = name.trim();
    if (!clean) return false;
    const stored = _storedSaved();
    const before = stored.filter(_readable).length;
    const list = stored.filter(p => !(_readable(p) && p.name.toLowerCase() === clean.toLowerCase()));
    list.unshift({
      name: clean,
      mode: state.searchMode === "OR" ? "OR" : "AND",
      tags: state.searchTags.map(_typedText),
    });
    // The oldest search this version reads goes when this save takes the list
    // past the cap. A list a later version kept longer is left as it is.
    const cut = list.filter(_readable).length > _SAVED_CAP && before <= _SAVED_CAP;
    if (cut) list.splice(list.findLastIndex(_readable), 1);
    if (!_storeSaved(list)) return false;
    showToast(cut ? `Search "${clean}" saved. Only ${_SAVED_CAP} saved searches are kept, so the oldest was removed.` : `Search "${clean}" saved`);
    return true;
  }

  function _renderSaveForm() {
    _acPinned = true;
    autoCompleteDropdown.innerHTML = "";
    _acSelect(-1);
    const nameInput = h("input", { class: "sbg-input", placeholder: "Name this search" });
    const okBtn = h("button", { class: "sbg-btn sbg-btn--sm", text: "Save" });
    autoCompleteDropdown.appendChild(h("div", { class: "sbg-search-ac-form" }, [nameInput, okBtn]));
    // The search bar reads collapsed while the form shows, since it holds no
    // suggestions to announce.
    autoCompleteDropdown.classList.remove("sbg-hidden");
    qInput.setAttribute("aria-expanded", "false");

    const close = (save) => {
      if (save && !_commitSaved(nameInput.value)) return;
      _acPinned = false;
      qInput.focus();
      _updateAutocomplete();
    };
    okBtn.addEventListener("mousedown", (e) => { e.preventDefault(); close(true); });
    nameInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); close(true); }
      else if (e.key === "Escape") { e.preventDefault(); close(false); }
    });
    nameInput.addEventListener("blur", () => {
      setTimeout(() => {
        if (_acPinned && !autoCompleteDropdown.contains(document.activeElement)) close(false);
      }, 150);
    });
    nameInput.focus();
  }

  function _renderSavedMenu() {
    const saved = _loadSaved();
    const canSave = state.searchTags.length > 0;
    if (!saved.length && !canSave) return false;
    if (saved.length) autoCompleteDropdown.appendChild(_acHead("Saved searches"));
    saved.forEach((p, i) => {
      const item = _acRow(" sbg-search-ac-item--saved");
      item.dataset.kind = "saved";
      item.dataset.savedIdx = String(i);
      const label = h("span", { class: "sbg-search-ac-name", text: p.name });
      const count = h("span", {
        class: "sbg-search-ac-count",
        text: p.tags.length > 1 ? `${p.tags.length} tags, ${p.mode === "OR" ? "OR" : "AND"}`
          : `${p.tags.length} tag`,
      });

      const del = h("button", { class: "sbg-btn sbg-btn--icon sbg-btn--icon-danger sbg-search-ac-delete", html: TRASH_ICON, title: `Delete "${p.name}"`, "aria-label": `Delete "${p.name}"` });
      del.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        _deleteSaved(p.name);
      });
      item.append(label, count, del);
      item.addEventListener("mousedown", (e) => { e.preventDefault(); _applySaved(p); });
      autoCompleteDropdown.appendChild(item);
    });
    if (canSave) {
      const save = _acRow(" sbg-search-ac-item--save", { text: "Save current search…" });
      save.dataset.kind = "save";
      save.addEventListener("mousedown", (e) => { e.preventDefault(); _renderSaveForm(); });
      autoCompleteDropdown.appendChild(save);
    }
    return true;
  }

  function _candidates() {
    const candidates = [...schemaPrefixes()];
    for (const [canonical, renamed] of Object.entries(getSectionRenames())) {
      if (!schemaSections()[canonical]?.search_field) continue;
      const p = renamed.toLowerCase() + ":";
      if (!candidates.includes(p)) candidates.push(p);
    }
    for (const key of Object.keys(getCustomSectionSearchMap())) {
      const p = key + ":";
      if (!candidates.includes(p)) candidates.push(p);
    }
    for (const key of Object.keys(getFieldLabelSearchMap())) {
      const p = key + ":";
      if (!candidates.includes(p)) candidates.push(p);
    }
    return candidates;
  }

  function _acFitRows() {
    const rows = getSetting(S.SEARCH_AC_ROWS);
    const items = autoCompleteDropdown.querySelectorAll(".sbg-search-ac-item");
    if (items.length <= rows) { autoCompleteDropdown.style.maxHeight = ""; return; }
    const last = items[rows - 1];
    // The list is border-box, so its border goes back onto the cap for the
    // last row to show whole.
    const chrome = autoCompleteDropdown.offsetHeight - autoCompleteDropdown.clientHeight;
    autoCompleteDropdown.style.maxHeight = (last.offsetTop + last.offsetHeight + chrome) + "px";
  }

  function _updateAutocomplete() {
    if (_acPinned) return;
    let val = qInput.value.toLowerCase().trim();

    const negated = val.startsWith("-");
    if (negated) val = val.slice(1).trim();
    autoCompleteDropdown.innerHTML = "";
    _acSelect(-1);
    if (val.includes(":")) { _acHide(); return; }

    let drawn = val.length === 0 ? _renderSavedMenu() : false;
    const matches = _candidates().filter(p => p.startsWith(val));
    const complete = matches.length === 1 && matches[0] === val + ":";
    if (!complete) {
      if (matches.length && drawn) autoCompleteDropdown.appendChild(_acHead("Fields"));
      for (const prefix of matches) {
        const item = _acRow("", { text: prefix });
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          qInput.value = (negated ? "-" : "") + prefix;
          _syncSearchBtns();
          _acHide();
          qInput.focus();
        });
        autoCompleteDropdown.appendChild(item);
        drawn = true;
      }
    }
    if (!drawn) { _acHide(); return; }
    _acShow();
    _acFitRows();
  }

  function _acNavigate(delta) {
    const count = autoCompleteDropdown.querySelectorAll(".sbg-search-ac-item").length;
    if (count === 0) return;
    _acSelect(Math.max(-1, Math.min(count - 1, _acSelectedIdx + delta)));
  }

  function _acAccept() {
    const items = autoCompleteDropdown.querySelectorAll(".sbg-search-ac-item");
    if (_acSelectedIdx >= 0 && _acSelectedIdx < items.length) {
      _acActivate(items[_acSelectedIdx]);
      return true;
    }

    const first = _acVisible() ? firstCompletionRow(items) : null;
    if (first) {
      _acActivate(first);
      return true;
    }
    return false;
  }

  function _acActivate(el) {
    if (el.dataset.kind === "saved") {
      const p = _loadSaved()[Number(el.dataset.savedIdx)];
      if (p) _applySaved(p);
      return;
    }
    if (el.dataset.kind === "save") {
      _renderSaveForm();
      return;
    }

    qInput.value = (qInput.value.trim().startsWith("-") ? "-" : "") + el.textContent;
    _syncSearchBtns();
    _acHide();
  }

  const _acInteract = () => { _acSuppressed = false; };
  qInput.addEventListener("mousedown", _acInteract);
  qInput.addEventListener("keydown", _acInteract);
  qInput.addEventListener("input", () => { _acInteract(); _updateAutocomplete(); _syncSearchBtns(); });
  qInput.addEventListener("focus", () => { if (!_acSuppressed) _updateAutocomplete(); });

  qInput.addEventListener("click", () => { if (!_acVisible()) _updateAutocomplete(); });
  qInput.addEventListener("blur", () => {
    setTimeout(() => {
      if (!_acPinned) _acHide();
    }, 150);
  });
  const _onWindowBlur = () => {
    _acSuppressed = true;
    if (!_acPinned) _acHide();
  };
  window.addEventListener("blur", _onWindowBlur);
  teardown.add(() => window.removeEventListener("blur", _onWindowBlur));

  const searchWrap = h("div", { class: "sbg-search-wrap" }, [
    inputFlexBox,
    searchModeSel,
    searchRefresh,
    searchClear,
    autoCompleteDropdown,
  ]);
  _syncSearchBtns();

  let qTimer = null;
  let _searchAbort = null;

  async function _search(extra, signal) {
    const data = await apiPost("/sidebar_gallery/search",
      { root_id: state.rootId, tags: state.searchTags, mode: state.searchMode, ...extra }, { signal });
    return decodeSearchMatches(data.matches);
  }

  // A tag's text and its cross are spans, which the Theme tab's sample draws
  // too, so the live bar is where they become keyboard buttons.
  function _pressable(el, act) {
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.addEventListener("click", act);
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      act(e);
    });
  }

  function renderSearchTags() {
    searchTagsWrap.innerHTML = "";
    for (let i = 0; i < state.searchTags.length; i++) {
      const tag = state.searchTags[i];
      const { pill, text, rm } = searchTagPill(tag);
      _pressable(rm, (e) => {
        e.stopPropagation();
        state.searchTags.splice(i, 1);
        renderSearchTags();
        _runSearch();
        // The redraw drops the focused cross, so a key press moves focus to the
        // search bar. A click leaves focus alone, since focusing the search bar
        // opens its dropdown.
        if (e.type === "keydown") qInput.focus();
      });
      _pressable(text, (e) => {
        e.stopPropagation();
        const seeded = _typedText(tag);
        const inp = h("input", { type: "text", class: "sbg-search-tag__edit", value: seeded });
        inp.style.width = Math.max(40, Math.min(seeded.length * 7, 200)) + "px";
        text.replaceWith(inp);
        inp.focus();
        inp.select();
        // Enter and the blur that follows it must not both commit the edit.
        let done = false;
        // Answers the tag's text as drawn afterwards, or null once the tag is gone.
        const commit = () => {
          if (done) return null;
          done = true;
          const newVal = inp.value.trim();
          if (newVal && newVal !== seeded) {
            const parsed = parseSearchTag(newVal);
            if (parsed) {
              state.searchTags[i] = parsed;
              renderSearchTags();
              _runSearch();
              return searchTagsWrap.children[i].querySelector(".sbg-search-tag__text");
            }
            inp.replaceWith(text);
          } else if (!newVal) {
            state.searchTags.splice(i, 1);
            renderSearchTags();
            _runSearch();
            return null;
          } else {
            inp.replaceWith(text);
          }
          return text;
        };
        // A key that ends the edit takes away the field it was typed in, so focus
        // goes back to the tag, or to the search bar once the tag is gone.
        inp.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { ke.preventDefault(); (commit() || qInput).focus(); }
          else if (ke.key === "Escape") { ke.preventDefault(); done = true; inp.replaceWith(text); text.focus(); }
        });
        inp.addEventListener("blur", commit);
      });
      searchTagsWrap.appendChild(pill);
    }
    searchModeSel.classList.toggle("sbg-hidden", state.searchTags.length <= 1);
    _syncSearchBtns();
  }

  // The saved tags and matches are written together, so a restore never shows
  // one search's matches under another's tags. A restore with no saved matches,
  // which a root switch also leaves, runs the search again.
  function _saveSearch(matches) {
    galleryCache.view.lastSearchTags = [...state.searchTags];
    galleryCache.view.lastSearchMatches = matches;
  }

  // Every search that answers ends here, the one with no tags included, so the
  // saved search, the highlight terms and the grid agree.
  function _showResult(matches) {
    state.searchMatches = matches;
    _saveSearch(matches);
    searchState.terms = matches ? highlightTerms(state.searchTags) : [];
    refilter();
    announce();
  }

  // Counts every occurrence in the name as the server does for a name tag, so a
  // badge reads the same whichever side answered.
  function _nameMatches() {
    const matches = new Map();
    for (const it of state.allItems) {
      const name = it.filename.toLowerCase();
      let count = 0;
      const checks = state.searchTags.map((t) => {
        const hits = !name.includes(t.value) ? 0 : t.value ? name.split(t.value).length - 1 : 1;
        if (t.exclude) return hits === 0;
        count += hits;
        return hits > 0;
      });
      if (state.searchMode === "AND" ? checks.every(Boolean) : checks.some(Boolean)) {
        matches.set(it.relpath, count ? [{ field: "name", count }] : []);
      }
    }
    return matches;
  }

  function _runSearch() {
    clearTimeout(qTimer);
    if (_searchAbort) { _searchAbort.abort(); _searchAbort = null; }

    if (state.searchTags.length === 0) {
      _showResult(null);
      line.stop();
      line.ok();
      return;
    }

    if (state.searchTags.every(t => t.field === "name")) {
      _showResult(_nameMatches());
      // A server search aborted above leaves its progress line up for the
      // search after it to carry on, and this one has none, so it takes it down.
      line.stop();
      line.ok();
      return;
    }

    // Saved without matches until the answer arrives, so a panel closed before
    // then runs this search when it opens again.
    _saveSearch(null);
    qTimer = setTimeout(async () => {
      const ctrl = new AbortController();
      _searchAbort = ctrl;
      const rootId = state.rootId;
      try {
        line.progress("Searching…");
        const matches = await _search({}, ctrl.signal);
        line.stop();
        // Matches name files in the root they were asked for, and the root now
        // shown searches again once its list is in.
        if (state.rootId !== rootId) return;
        _showResult(matches);
        line.ok();
      } catch (e) {
        // Reading a failed answer's reason swallows an abort that lands during
        // the read, so the signal is asked as well.
        if (e.name !== "AbortError" && !ctrl.signal.aborted) {
          _showResult(null);
          line.fail(failureText("search", e));
        }
      }
    }, 400);
  }

  qInput.addEventListener("keydown", (e) => {
    // Tab takes a suggestion only when there is one to take, and Shift+Tab
    // always moves back, so the open list never holds the focus.
    if (e.key === "Tab" && !e.shiftKey && _acVisible()) {
      if (_acAccept()) e.preventDefault();
    } else if (e.key === "ArrowDown" && _acVisible()) {
      e.preventDefault();
      _acNavigate(1);
    } else if (e.key === "ArrowUp" && _acVisible()) {
      e.preventDefault();
      _acNavigate(-1);
    } else if (e.key === "Escape") {
      if (_acVisible()) _acHide();
      else qInput.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();

      if (_acVisible() && _acSelectedIdx >= 0) {
        _acAccept();
        return;
      }
      _acHide();
      const parsed = parseSearchTag(qInput.value);
      if (parsed) {
        state.searchTags.push(parsed);
        qInput.value = "";
        renderSearchTags();
        _runSearch();
        qInput.focus();
      }
    } else if (e.key === "Backspace" && qInput.value === "") {
      if (state.searchTags.length > 0) {
        state.searchTags.pop();
        renderSearchTags();
        _runSearch();
        qInput.focus();
      }
    }
  });

  searchClear.addEventListener("click", () => {
    qInput.value = "";
    state.searchTags = [];
    renderSearchTags();
    _runSearch();
  });

  inputFlexBox.addEventListener("click", (e) => {
    if (e.target === inputFlexBox || e.target === searchTagsWrap) qInput.focus();
  });

  // The Metadata tab's field button sends only a spelling, so its tag is
  // the one typing that text would make.
  const _onSearchSubmit = (e) => {
    const tag = parseSearchTag(e.detail?.spelling || "");
    if (!tag) return;
    state.searchTags.push(tag);
    qInput.value = "";
    renderSearchTags();
    _runSearch();

    _acSuppressed = true;
    qInput.focus();
  };
  document.addEventListener("sbg-search-submit", _onSearchSubmit);
  teardown.add(() => document.removeEventListener("sbg-search-submit", _onSearchSubmit));

  teardown.add(() => {
    clearTimeout(qTimer);
    if (_searchAbort) { _searchAbort.abort(); _searchAbort = null; }
  });

  function restore() {
    searchModeSel.value = state.searchMode;
    renderSearchTags();
  }

  return {
    searchWrap,
    refreshBtn: searchRefresh,
    trigger: _runSearch,
    matchFiles: (relpaths) => _search({ relpaths }),
    restore,
  };
}
