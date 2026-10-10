import { h, branchGuides, passingGuide, treeStem, treeNameX, treeGlyphLeft, treeGlyphMid } from "./sbg-core.js";
import { wireListboxKeys } from "./sbg-a11y.js";
import { galleryCache, rootLabel } from "./sbg-gallery-store.js";
import { S, getSetting, saveSetting, onSettingsChanged } from "./sbg-settings-store.js";
import { makeKeySet } from "./sbg-keyset.js";
import { PIN_OUTLINE_ICON, PIN_FILLED_ICON, ROOT_DRIVE_ICON, CHEVRON_RIGHT_ICON, STAR_ICON, FOLDER_ICON, EYE_ICON, EYE_OFF_ICON } from "./sbg-icons.js";
import { attachOverlayThumb } from "./sbg-overlay-thumb.js";
import { hasFavoritesFor } from "./sbg-favorites.js";

const _pins = makeKeySet(S.PINNED_FOLDERS);
const _isPinned = _pins.has;
const _togglePinned = _pins.toggle;
const _pinnedPaths = _pins.pathsFor;

export const includeSubfolders = () => getSetting(S.PICKER_INCLUDE_SUBFOLDERS);

function _drawSubfolderToggle(btn, on) {
  btn.innerHTML = on ? EYE_ICON : EYE_OFF_ICON;
  btn.classList.toggle("sbg-dropdown__subfolders--on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

function _treeGuides(chain, branch) {
  const depth = chain.length - 1;
  const out = [];
  for (let i = 1; i < depth; i++) if (!chain[i].last) out.push(passingGuide(treeGlyphMid(i - 1)));
  if (depth > 0) {
    const x = treeGlyphMid(depth - 1);
    const end = branch ? treeGlyphLeft(depth) : treeNameX(depth) - 6;
    out.push(...branchGuides(x, end, chain[depth].last));
  }
  if (branch) out.push(treeStem(depth));
  return out;
}

const _placeRow = (el, depth) => el.style.setProperty("--sbg-tree-strip", treeNameX(depth) + "px");

function _folderTree(subfolders) {
  const byPath = new Map();
  const ensure = (path) => {
    let n = byPath.get(path);
    if (n) return n;
    const cut = path.lastIndexOf("/");
    const parent = cut < 0 ? null : ensure(path.slice(0, cut));
    n = { path, name: cut < 0 ? path : path.slice(cut + 1), parent, children: [], depth: parent ? parent.depth + 1 : 0, count: 0 };
    byPath.set(path, n);
    if (parent) parent.children.push(n);
    return n;
  };
  for (const s of subfolders) if (s) ensure(s);
  const out = [];
  const walk = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const n of nodes) {
      n.last = n === nodes[nodes.length - 1];
      out.push(n);
      walk(n.children);
      // Every folder below this one, which is the number shown beside it and
      // the length of its subtree in `out`.
      n.count = n.children.reduce((t, c) => t + 1 + c.count, 0);
    }
  };
  walk([...byPath.values()].filter(n => !n.parent));
  return out;
}

export function createFolderNav({ state, teardown, setView, refilter, switchRoot }) {
  const folderNav = h("div", { class: "sbg-folder-nav" });

  let _dropdown = null;

  // With subfolders left out, All shows only the root's own files, so the
  // folder button names the root.
  const _folderLabel = () => state.favoritesOnly ? "Favorites"
    : (state.subfolder || (includeSubfolders() ? "All folders" : rootLabel(state.roots, state.rootId)));

  const _openKey = (sub) => _pins.key(state.rootId, sub);
  const _isOpen = (sub) => galleryCache.view.pickerOpenFolders[_openKey(sub)] === true;
  const _setOpen = (sub, on) => {
    if (on) galleryCache.view.pickerOpenFolders[_openKey(sub)] = true;
    else delete galleryCache.view.pickerOpenFolders[_openKey(sub)];
  };

  // Under a pin the walk ends at the pinned folder, since its block draws the
  // subtree from there.
  const _ancestorsOpen = (node, base) => {
    const stop = base ? base.parent : null;
    for (let p = node.parent; p && p !== stop; p = p.parent) if (!_isOpen(p.path)) return false;
    return true;
  };
  function _closeDropdown(refocus = true) {
    if (!_dropdown) return;
    const { popup, btn } = _dropdown;

    const focusWasInside = refocus && popup.contains(document.activeElement);
    btn.setAttribute("aria-expanded", "false");
    _dropdown.close();
    _dropdown = null;
    if (focusWasInside && btn.isConnected) btn.focus();
  }

  /** `build` returns the popup, plus for the folder list the list itself, its
   *  listbox options, `refreshRows` and `onClose`. The `keys.resync` it is
   *  handed does nothing until the popup is wired. */
  function _toggleDropdown(anchorKey, btn, build) {
    if (_dropdown && _dropdown.anchorKey === anchorKey) { _closeDropdown(); return null; }
    _closeDropdown();
    const keys = { resync: () => { } };
    const built = build(keys);
    const { popup } = built;
    document.body.appendChild(popup);

    // The popup hangs off the body to escape the panel's overflow clip, so its
    // width is capped by measuring the toolbar row.
    const row = folderNav.parentElement;

    let anchor = btn;
    const fit = () => {
      // A tab switch in ComfyUI's sidebar can take the gallery away with no
      // teardown reaching this dropdown, and the observer still fires as the
      // toolbar row leaves the page.
      if (!anchor.isConnected) { _closeDropdown(); return; }
      const rect = anchor.getBoundingClientRect();
      popup.style.left = rect.left + "px";
      popup.style.top = (rect.bottom + 2) + "px";
      popup.style.maxWidth = Math.max(0, Math.round(row.getBoundingClientRect().right - rect.left)) + "px";
    };
    fit();
    const hostResize = new ResizeObserver(fit);
    hostResize.observe(row);

    const dismiss = (ev) => {
      // The button's own click closes the popup, and a dismiss here first would
      // let that click open it again.
      if (popup.contains(ev.target) || anchor.contains(ev.target)) return;
      _closeDropdown();
    };
    // Focus taken by anything else on the page, such as a dialog a ComfyUI
    // shortcut opens, closes it and stays where it went. Focus leaving for
    // another window keeps it open.
    popup.addEventListener("focusout", (ev) => {
      const to = ev.relatedTarget;
      if (to && !popup.contains(to) && !anchor.contains(to)) _closeDropdown(false);
    });
    const close = () => {
      if (built.onClose) built.onClose();
      hostResize.disconnect();
      popup.remove();
      document.removeEventListener("pointerdown", dismiss, true);
    };
    const reanchor = (next) => {
      if (anchor !== next) anchor.setAttribute("aria-expanded", "false");
      anchor = next;
      anchor.setAttribute("aria-expanded", "true");
      fit();
    };
    _dropdown = { anchorKey, rootId: state.rootId, popup, close, reanchor, refreshRows: built.refreshRows, get btn() { return anchor; } };
    btn.setAttribute("aria-expanded", "true");

    keys.resync = wireListboxKeys(popup, {
      markClass: "sbg-dropdown__item--kbd",
      onEscape: _closeDropdown,
      ...built.listbox,
    });

    // Capture phase, since the graph canvas stops its pointerdown from bubbling.
    document.addEventListener("pointerdown", dismiss, true);
    return built;
  }

  function makeRootRow(r, withIcon) {
    const item = h("div", {
      class: `sbg-dropdown__item${r.id === state.rootId ? " sbg-dropdown__item--active" : ""}`,
      role: "option", "aria-selected": r.id === state.rootId ? "true" : "false",
    });

    if (withIcon) {
      item.classList.add("sbg-dropdown__item--tree");
      const body = h("div", { class: "sbg-tree-body sbg-tree-body--full" }, [
        h("span", { class: "sbg-dropdown__rowicon", html: ROOT_DRIVE_ICON, "aria-hidden": "true" }),
        h("span", { class: "sbg-dropdown__label", text: r.label }),
      ]);
      _placeRow(body, 0);
      item.appendChild(body);
    } else {
      item.appendChild(h("span", { class: "sbg-dropdown__label", text: r.label }));
    }
    item.addEventListener("click", () => {
      _closeDropdown();
      switchRoot(r.id);
    });
    return item;
  }

  let _favShown = false;

  function renderFolderNav() {
    const prevFocus = document.activeElement;
    const refocusSel = folderNav.contains(prevFocus)
      ? (prevFocus.classList.contains("sbg-folder-btn--root") ? ".sbg-folder-btn--root" : ".sbg-folder-btn--folders")
      : null;
    folderNav.innerHTML = "";
    const currentRoot = rootLabel(state.roots, state.rootId);
    _favShown = hasFavoritesFor(state.rootId);

    const rootsInPicker = getSetting(S.PICKER_ROOTS_IN_FOLDERS) && state.roots.length > 1;

    if (state.roots.length > 1 && !rootsInPicker) {
      const rootBtn = h("button", {
        class: "sbg-folder-btn sbg-folder-btn--root", text: currentRoot, title: "Switch root",
        "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": `Root folder: ${currentRoot}`,
      });
      rootBtn.addEventListener("click", () => {
        _toggleDropdown("root", rootBtn, () => {
          const popup = h("div", { class: "sbg-dropdown", role: "listbox", "aria-label": "Roots" });
          for (const r of state.roots) popup.appendChild(makeRootRow(r, false));
          return { popup };
        });
      });
      folderNav.appendChild(rootBtn);
    }

    if (state.subfolders.length > 0 || rootsInPicker || state.favoritesOnly || _favShown) {
      const pickBtn = h("button", {
        class: "sbg-folder-btn sbg-folder-btn--folders", title: "Browse folders",
        "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": `Folder: ${_folderLabel()}`,
      });
      if (state.favoritesOnly) pickBtn.appendChild(h("span", { class: "sbg-fav-star", html: STAR_ICON, "aria-hidden": "true" }));
      else pickBtn.appendChild(h("span", { class: "sbg-folder-btn__icon", html: FOLDER_ICON, "aria-hidden": "true" }));
      pickBtn.appendChild(h("span", { class: "sbg-folder-btn__label", text: _folderLabel() }));
      pickBtn.addEventListener("click", () => {
        // A root switch closes the dropdown after the root has already changed,
        // so the scroll is saved under the root it was measured on.
        const openedFor = state.rootId;

        const built = _toggleDropdown("folders", pickBtn, (keys) => {
          const p = h("div", { class: "sbg-dropdown sbg-dropdown--folders" });
          const filterInput = h("input", {
            type: "search", class: "sbg-dropdown__filter",
            placeholder: "Filter folders…", "aria-label": "Filter folders",
          });
          const subToggle = h("button", {
            type: "button", class: "sbg-dropdown__subfolders",
            title: "Include files from subfolders", "aria-label": "Include files from subfolders",
          });
          _drawSubfolderToggle(subToggle, includeSubfolders());
          subToggle.addEventListener("click", () => saveSetting(S.PICKER_INCLUDE_SUBFOLDERS, !includeSubfolders()));
          const filterWrap = h("div", { class: "sbg-dropdown__filterwrap" }, [filterInput, subToggle]);
          const list = h("div", {
            class: "sbg-dropdown__list", role: "listbox",
            "aria-label": rootsInPicker ? "Roots and folders" : "Folders",
          });

          const _optionEls = [];
          const _entries = [];

          let rootsBlock = null;

          const pick = (sub) => {
            _closeDropdown();
            setView({ subfolder: sub, favoritesOnly: false });
            refilter();
            renderFolderNav();
          };

          const makeItem = (sub, label, node, base, missing) => {
            const active = !missing && sub === state.subfolder && !state.favoritesOnly;
            const item = h("div", {
              class: `sbg-dropdown__item sbg-dropdown__item--tree${active ? " sbg-dropdown__item--active" : ""}${missing ? " sbg-dropdown__item--missing" : ""}`,
              role: "option", "aria-selected": active ? "true" : "false",

              "aria-disabled": missing ? "true" : undefined,
              "data-sub": sub,
              title: missing ? `${sub} is no longer in this root. Unpin it to remove it.` : undefined,
            });
            const branch = !!node && node.children.length > 0;
            if (node) {
              const chain = [];
              for (let a = node, stop = base ? base.parent : null; a && a !== stop; a = a.parent) chain.unshift(a);
              for (const g of _treeGuides(chain, branch)) item.appendChild(g);
            }

            const body = h("div", { class: `sbg-tree-body${branch ? "" : " sbg-tree-body--full"}` });
            if (branch) {
              // Right and Left open and close the marked branch, so Tab skips the chevron.
              const strip = h("button", {
                type: "button", tabindex: "-1",
                class: `sbg-tree-strip${_isOpen(sub) ? " sbg-tree-strip--open" : ""}`,
                "aria-label": `Show or hide the subfolders of ${sub}`,
              });
              strip.appendChild(h("span", { class: "sbg-tree-chev", html: CHEVRON_RIGHT_ICON, "aria-hidden": "true" }));
              strip.addEventListener("click", (ev) => { ev.stopPropagation(); toggleBranch(sub); });
              item.classList.toggle("sbg-dropdown__item--open", _isOpen(sub));
              item.setAttribute("aria-expanded", _isOpen(sub) ? "true" : "false");
              item.appendChild(strip);
            }
            body.appendChild(h("span", { class: "sbg-dropdown__label", text: label }));
            if (node && node.count > 0) body.appendChild(h("span", { class: "sbg-dropdown__count", text: String(node.count) }));
            if (sub !== "") {
              const on = _isPinned(state.rootId, sub);
              const pin = h("button", {
                type: "button",
                class: `sbg-dropdown__pin${on ? " sbg-dropdown__pin--on" : ""}`,
                html: on ? PIN_FILLED_ICON : PIN_OUTLINE_ICON,
                title: on ? "Unpin" : "Pin to the top of this list",
                "aria-label": (on ? "Unpin " : "Pin ") + sub,
              });
              pin.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const hadFocus = document.activeElement === pin;
                _togglePinned(state.rootId, sub);
                // A pin moves the folder and its subtree into the block at the
                // top, so the rows are built again instead of the icon repainted.
                refreshRows();
                // The rebuild drops the focused pin and sends focus to the filter
                // box. A pinned folder has a row in the pinned block and one in
                // the tree, which a collapsed branch hides, so a key press,
                // whose click has detail 0, focuses the pin in its last row on
                // screen and the mark follows.
                if (hadFocus && ev.detail === 0) {
                  const rows = [...list.querySelectorAll(".sbg-dropdown__item")]
                    .filter(r => r.getAttribute("data-sub") === sub && !r.classList.contains("sbg-hidden"));
                  if (rows.length) rows[rows.length - 1].querySelector(".sbg-dropdown__pin").focus();
                }
                const marked = list.querySelector(".sbg-dropdown__item--kbd");
                if (marked) marked.scrollIntoView({ block: "nearest" });
              });
              body.appendChild(pin);
            }
            item.appendChild(body);
            if (!missing) item.addEventListener("click", () => pick(sub));
            return item;
          };

          const addRow = (sub, label, node, base, missing) => {
            const depth = node ? node.depth - (base ? base.depth : 0) : 0;
            const item = makeItem(sub, label, node, base, missing);
            const stripEl = item.querySelector(".sbg-tree-strip");
            const placeEl = stripEl || item.querySelector(".sbg-tree-body");
            _placeRow(placeEl, depth);
            list.appendChild(item);
            _optionEls.push(item);
            _entries.push({
              el: item, text: sub.toLowerCase(), node, base, depth, stripEl, placeEl,
              labelEl: item.querySelector(".sbg-dropdown__label"),
            });
          };

          const toggleBranch = (sub) => {
            const on = !_isOpen(sub);
            _setOpen(sub, on);
            for (const en of _entries) {
              if (!en.node || en.node.path !== sub) continue;
              en.stripEl.classList.toggle("sbg-tree-strip--open", on);
              en.el.classList.toggle("sbg-dropdown__item--open", on);
              en.el.setAttribute("aria-expanded", on ? "true" : "false");
            }
            keepFocusOnMark(() => applyFilter(true));
          };

          const cellLine = h("div", { class: "sbg-dropdown__cells", role: "group", "aria-label": "Views" });
          const allActive = state.subfolder === "" && !state.favoritesOnly;
          const allCell = h("div", {
            class: `sbg-dropdown__cell${allActive ? " sbg-dropdown__cell--active" : ""}`,
            role: "option", "aria-selected": allActive ? "true" : "false",
            text: "All", title: "All folders, or only the files directly in this root while files from subfolders are not included",
          });
          allCell.addEventListener("click", () => pick(""));
          cellLine.appendChild(allCell);
          _optionEls.push(allCell);

          const hasFavs = hasFavoritesFor(state.rootId) || state.favoritesOnly;
          const favCell = h("div", {
            class: `sbg-dropdown__cell${state.favoritesOnly ? " sbg-dropdown__cell--active" : ""}${hasFavs ? "" : " sbg-dropdown__cell--disabled"}`,
            role: "option", "aria-selected": state.favoritesOnly ? "true" : "false",
          });
          favCell.appendChild(h("span", { class: "sbg-fav-star", html: STAR_ICON, "aria-hidden": "true" }));
          favCell.appendChild(document.createTextNode("Favorites"));
          if (hasFavs) {
            favCell.addEventListener("click", () => {
              _closeDropdown();
              setView({ favoritesOnly: true, subfolder: "" });
              refilter();
              renderFolderNav();
            });
            _optionEls.push(favCell);
          } else {
            favCell.setAttribute("aria-disabled", "true");
            favCell.title = "No favorites in this root yet";
          }
          cellLine.appendChild(favCell);

          if (rootsInPicker) {
            const rootsCell = h("div", {
              class: "sbg-dropdown__cell",
              role: "option", "aria-selected": "false",
            });
            rootsCell.appendChild(h("span", { text: "Roots" }));
            const chevEl = h("span", {
              class: `sbg-dropdown__chev${galleryCache.view.pickerRootsExpanded ? " sbg-dropdown__chev--open" : ""}`,
              html: CHEVRON_RIGHT_ICON, "aria-hidden": "true",
            });
            rootsCell.appendChild(chevEl);
            rootsCell.addEventListener("click", () => {
              galleryCache.view.pickerRootsExpanded = !galleryCache.view.pickerRootsExpanded;
              chevEl.classList.toggle("sbg-dropdown__chev--open", galleryCache.view.pickerRootsExpanded);
              applyFilter();
            });
            cellLine.appendChild(rootsCell);
            _optionEls.push(rootsCell);
          }

          const cellCount = _optionEls.length;

          const buildRows = () => {
            // The drawn scrollbar's rail lives inside the list, so it survives the clear.
            const rail = list.querySelector(":scope > .sbg-ovscroll-rail");
            list.textContent = "";
            if (rail) list.appendChild(rail);
            _optionEls.length = cellCount;
            _entries.length = 0;
            rootsBlock = null;

            if (rootsInPicker) {
              const rows = [];
              for (const r of state.roots) {
                const item = makeRootRow(r, true);
                list.appendChild(item);
                _optionEls.push(item);
                _entries.push({ el: item, text: String(r.label).toLowerCase(), root: true });
                rows.push(item);
              }
              const sepEl = h("div", { class: "sbg-dropdown__sep" });
              list.appendChild(sepEl);
              rootsBlock = { sepEl, rows };
            }

            const tree = _folderTree(state.subfolders);
            const byPath = new Map(tree.map(n => [n.path, n]));

            // Drawn from the pins instead of the folders that exist, so a pin
            // whose folder was renamed or deleted still gets a row and can be
            // taken off. A pin under another pin is left to that pin's block.
            const pinned = _pinnedPaths(state.rootId).filter(sf => sf !== "");
            const underAnotherPin = (sf) => pinned.some(q => q !== sf && sf.startsWith(q + "/"));

            for (const sf of pinned) {
              if (underAnotherPin(sf)) continue;
              const base = byPath.get(sf);
              if (!base) { addRow(sf, sf, null, null, true); continue; }
              addRow(sf, sf, base, base);
              const at = tree.indexOf(base);
              for (const d of tree.slice(at + 1, at + 1 + base.count)) addRow(d.path, d.name, d, base);
            }

            for (const node of tree) addRow(node.path, node.name, node);
          };
          buildRows();
          attachOverlayThumb(list);

          const applyFilter = (keepScroll = false) => {
            const q = filterInput.value.trim().toLowerCase();
            list.classList.toggle("sbg-dropdown__list--flat", q !== "");
            for (const en of _entries) {
              let hidden;
              if (q !== "") hidden = !en.text.includes(q);
              else if (en.root === true) hidden = !galleryCache.view.pickerRootsExpanded;
              else if (en.node) hidden = !_ancestorsOpen(en.node, en.base);
              else hidden = false;
              if (en.node) en.labelEl.textContent = q !== "" || en.node === en.base ? en.node.path : en.node.name;
              if (en.placeEl) _placeRow(en.placeEl, q !== "" ? 0 : en.depth);
              en.el.classList.toggle("sbg-hidden", hidden);
            }
            if (rootsBlock) {
              rootsBlock.sepEl.classList.toggle("sbg-hidden", rootsBlock.rows.every(r => r.classList.contains("sbg-hidden")));
            }
            if (!keepScroll) list.scrollTop = 0;

            keys.resync(keepScroll);
          };
          const markedPin = () => {
            const marked = list.querySelector(".sbg-dropdown__item--kbd");
            return marked ? marked.querySelector(".sbg-dropdown__pin") : null;
          };
          // A rebuild or a closed branch can take away the pin holding the
          // focus, and a pin kept on any row but the marked one would take the
          // next Enter.
          const keepFocusOnMark = (change) => {
            const held = document.activeElement;
            const inRows = list.contains(held);
            change();
            if (inRows && held !== markedPin()) filterInput.focus();
          };
          const refreshRows = () => keepFocusOnMark(() => {
            const keep = list.scrollTop;
            buildRows();
            applyFilter(true);
            list.scrollTop = keep;
          });
          applyFilter();
          filterInput.addEventListener("input", () => applyFilter());

          p.addEventListener("keydown", (e) => {
            const off = e.target !== filterInput && e.target.tagName !== "INPUT";
            // Typing anywhere else in the dropdown goes to the filter box, which
            // takes the character once it has the focus, and no further, since
            // ComfyUI reads a key pressed outside a text box as a shortcut.
            const typed = (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey)
              || e.key === "Backspace" || e.key === "Delete";
            if (off && typed) {
              filterInput.focus();
              e.stopPropagation();
              return;
            }
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            if (off && e.target !== markedPin()) filterInput.focus();
            if (filterInput.value !== "") return;
            const marked = list.querySelector(".sbg-dropdown__item--kbd");
            const en = marked && _entries.find(x => x.el === marked);
            if (!en || !en.node || en.node.children.length === 0) return;
            if (_isOpen(en.node.path) === (e.key === "ArrowLeft")) toggleBranch(en.node.path);
            e.preventDefault();
            e.stopPropagation();
          });
          // A pressed button would otherwise keep the focus and take the next
          // Enter, which belongs to the marked row.
          p.addEventListener("mousedown", (e) => {
            if (e.target.closest("button")) e.preventDefault();
          });

          filterInput.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || !filterInput.value) return;
            e.stopPropagation();
            filterInput.value = "";
            applyFilter();
          });

          p.appendChild(filterWrap);
          p.appendChild(cellLine);
          p.appendChild(list);
          return {
            popup: p,
            list,
            refreshRows,
            listbox: {
              // A row whose pinned folder is gone stays among the options
              // although Enter cannot choose it, since marking it is what lets
              // Tab reach the pin that takes it off.
              getOptions: () => _optionEls.filter(el => !el.classList.contains("sbg-hidden")
                && (!el.classList.contains("sbg-dropdown__cell") || filterInput.value.trim() === "")),
              controlsOf: (el) => {
                const pin = el.querySelector(".sbg-dropdown__pin");
                return pin ? [pin] : [];
              },
              initialFocus: filterInput,
              activeDescendantEl: filterInput,
              keyOf: (el) => el.getAttribute("data-sub"),
            },
            onClose: () => { galleryCache.view.folderScrollTop[openedFor] = list.scrollTop; },
          };
        });

        if (!built) return;

        // The saved scroll only sticks once the list has been laid out.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const savedScroll = galleryCache.view.folderScrollTop[openedFor] || 0;
            if (savedScroll > 0) {
              built.list.scrollTop = savedScroll;
            } else {
              const active = built.popup.querySelector(".sbg-dropdown__item--active");
              if (active) active.scrollIntoView({ block: "center" });
            }
          });
        });
      });
      folderNav.appendChild(pickBtn);
    }
    // The row is drawn again whenever the folder list reloads, even under an
    // open popup, which lives on the body. The popup moves to the new button and
    // rebuilds its rows so a new folder shows, and closes once no button is left
    // or the root changed.
    if (_dropdown) {
      const live = folderNav.querySelector(_dropdown.anchorKey === "root" ? ".sbg-folder-btn--root" : ".sbg-folder-btn--folders");
      if (!live || _dropdown.rootId !== state.rootId) _closeDropdown();
      else {
        // A toolbar drawn while the gallery is out of the page closes the
        // dropdown as it reanchors.
        _dropdown.reanchor(live);
        if (_dropdown && _dropdown.refreshRows) _dropdown.refreshRows();
      }
    }

    if (refocusSel) {
      const again = folderNav.querySelector(refocusSel);
      if (again) again.focus();
    }
  }

  // Applied here however they changed: their row, the dropdown's own toggle,
  // a preset load or a restore.
  teardown.add(onSettingsChanged((ids) => {
    if (ids.has(S.PICKER_ROOTS_IN_FOLDERS)) {
      _closeDropdown();
      renderFolderNav();
    }
    if (ids.has(S.PICKER_INCLUDE_SUBFOLDERS)) {
      const toggle = _dropdown && _dropdown.popup.querySelector(".sbg-dropdown__subfolders");
      if (toggle) _drawSubfolderToggle(toggle, includeSubfolders());
      refilter();
      const live = folderNav.querySelector(".sbg-folder-btn--folders");
      if (live) {
        live.querySelector(".sbg-folder-btn__label").textContent = _folderLabel();
        live.setAttribute("aria-label", `Folder: ${_folderLabel()}`);
      }
    }
  }));

  // A root's first favorite brings the folder button when it has no subfolders,
  // and its last takes it away, so the row is drawn again only when that changes.
  const _onFavoritesChanged = () => {
    if (hasFavoritesFor(state.rootId) === _favShown) return;
    renderFolderNav();
  };
  document.addEventListener("sbg-favorites-changed", _onFavoritesChanged);
  teardown.add(() => document.removeEventListener("sbg-favorites-changed", _onFavoritesChanged));

  teardown.add(_closeDropdown);

  return { folderNav, renderFolderNav, closePopup: _closeDropdown };
}
