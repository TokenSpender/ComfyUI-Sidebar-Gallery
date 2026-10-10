import { h, lsGet, lsSet } from "./sbg-core.js";
import { attachOverlayThumb } from "./sbg-overlay-thumb.js";
import {
  GEAR_ICON, SEARCH_ICON, CLOSE_ICON, sizedIcon,
  TAB_APPEARANCE_ICON, TAB_DIAGNOSTICS_ICON, TAB_KEYBINDINGS_ICON,
  TAB_HELP_ICON, TAB_LAYOUT_ICON, TAB_PRESETS_ICON, TAB_SETTINGS_ICON, TAB_THEME_ICON,
} from "./sbg-icons.js";
import { trapFocus, wireTablistKeys, setSelectedTab } from "./sbg-a11y.js";
import { attachSplitter } from "./sbg-splitter.js";
import { B } from "./sbg-settings-store.js";

import { renderLayout } from "./sbg-layout-editor.js";
import { renderKeybindings } from "./sbg-settings-tab-keybindings.js";
import { renderDiagnosticsTab } from "./sbg-settings-tab-diagnostics.js";
import { renderPresets } from "./sbg-settings-tab-presets.js";
import { renderTheme } from "./sbg-settings-tab-theme.js";
import { renderAppearance } from "./sbg-settings-tab-appearance.js";
import { renderSettings } from "./sbg-settings-tab-settings.js";
import { renderHelp } from "./sbg-settings-tab-help.js";

const TABS = [
  { id: "layout", label: "Metadata", icon: TAB_LAYOUT_ICON, searchable: false, render: (c) => renderLayout(c.content, c.galleryCtx, c.closeGS, c.visitCleanups) },
  { id: "theme", label: "Theme", icon: TAB_THEME_ICON, render: renderTheme },
  { id: "appearance", label: "Appearance", icon: TAB_APPEARANCE_ICON, render: renderAppearance },
  { id: "presets", label: "Presets", icon: TAB_PRESETS_ICON, render: renderPresets },
  { id: "keybindings", label: "Keybindings", icon: TAB_KEYBINDINGS_ICON, render: renderKeybindings },
  { id: "settings", label: "General", icon: TAB_SETTINGS_ICON, render: renderSettings },
  { id: "diagnostics", label: "Diagnostics", icon: TAB_DIAGNOSTICS_ICON, render: renderDiagnosticsTab },
  { id: "help", label: "Help", icon: TAB_HELP_ICON, render: renderHelp },
];

// So an unmount of the gallery closes the settings panel with its full cleanup, since
// a tab mounts popovers on the body that would otherwise be left behind.
let _activeCloseGS = null;

// Outlives the settings panel, so a tab reopens where it was left after a close too.
const _tabScroll = new Map();

export function closeGallerySettings() {
  if (_activeCloseGS) _activeCloseGS();
}

// Leaves out buttons, since + Add, Reset and Cancel stand on many rows and
// name none of them.
function _rowText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 || node.tagName === "BUTTON") return "";
  return node.childNodes.length ? [...node.childNodes].map(_rowText).join(" ") : node.textContent;
}

function _haystack(el) {
  const text = el.classList.contains("sbg-gs-row") ? _rowText(el) : el.textContent;
  return ((text || "") + " " + (el.getAttribute("title") || "")).toLowerCase();
}

function _sections(form) {
  const sections = [{ heading: null, rows: [], descs: [] }];
  for (const el of form.children) {
    if (el.classList.contains("sbg-gs-section-title")) sections.push({ heading: el, rows: [], descs: [] });
    else if (el.classList.contains("sbg-gs-desc")) sections[sections.length - 1].descs.push(el);
    else sections[sections.length - 1].rows.push(el);
  }
  return sections;
}

// The open tab and the off-screen render of the other tabs both count here, so
// a badge keeps its number when its tab opens unless a fetch then shows a row,
// such as Diagnostics' Missing.
function _match(sections, q, mark) {
  let total = 0;
  for (const sec of sections) {
    const headHit = !!sec.heading && _haystack(sec.heading).includes(q);
    let hits = 0;
    for (const el of sec.rows) {
      const hit = !el.classList.contains("sbg-hidden") && el.hasChildNodes() && (headHit || _haystack(el).includes(q));
      if (hit) hits++;
      if (mark) mark(el, hit);
    }
    if (mark) {
      for (const el of sec.descs) mark(el, headHit);
      if (sec.heading) mark(sec.heading, headHit || hits > 0);
    }
    total += hits + (headHit ? 1 : 0);
  }
  return total;
}

export function openGallerySettings(galleryCtx, defaultTab = null) {
  const gsOverlay = h("div", { class: "sbg-gs-overlay" });

  const gsPanel = h("div", {
    class: "sbg-gs-panel",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "sbg-gs-title",
  });

  const gsClose = h("button", {
    class: "sbg-gs-close", html: sizedIcon(CLOSE_ICON, 18), title: "Close", "aria-label": "Close settings",
  });
  const tabBtns = TABS.map(tab =>
    h("button", {
      class: "sbg-gs-navitem", "data-tab": tab.id,
      role: "tab", "aria-selected": "false", tabindex: "-1",
      "aria-controls": "sbg-gs-content",
    }, [
      h("span", { class: "sbg-gs-navicon", html: tab.icon, "aria-hidden": "true" }),
      h("span", { class: "sbg-gs-navlabel", text: tab.label }),
      h("span", { class: "sbg-gs-navbadge sbg-hidden", "aria-hidden": "true" }),
    ])
  );

  const tabBar = h("div", {
    class: "sbg-gs-nav", role: "tablist",
    "aria-label": "Settings sections", "aria-orientation": "vertical",
  }, tabBtns);

  const searchInput = h("input", {
    type: "search", class: "sbg-gs-searchinput", placeholder: "Search settings…",
    "aria-label": "Search settings",
  });
  const searchBox = h("div", { class: "sbg-gs-search" }, [
    h("span", { class: "sbg-gs-searchicon", html: SEARCH_ICON, "aria-hidden": "true" }),
    searchInput,
  ]);

  const rail = h("div", { class: "sbg-gs-rail" }, [
    h("div", { class: "sbg-gs-railhead" }, [
      h("span", { class: "sbg-gs-railicon", html: GEAR_ICON, "aria-hidden": "true" }),
      h("h2", { class: "sbg-gs-title", id: "sbg-gs-title", text: "Sidebar Gallery" }),
    ]),
    searchBox,
    tabBar,
  ]);

  // Focusable from script, so a tab whose closed row took the focus with it can
  // hand it here and the next Tab stays in the panel.
  const content = h("div", { class: "sbg-gs-content", id: "sbg-gs-content", role: "tabpanel", tabindex: "-1" });
  attachOverlayThumb(content);

  // Outside `content`, since a tab's render clears that, and a message written
  // into it would wake the MutationObserver below and run the filter again.
  const noResults = h("div", { class: "sbg-gs-noresults sbg-gs-desc sbg-hidden" });
  const main = h("div", { class: "sbg-gs-main" }, [
    h("div", { class: "sbg-gs-contenthead" }, [gsClose]),
    content,
    noResults,
  ]);

  gsPanel.appendChild(rail);
  gsPanel.appendChild(main);
  gsOverlay.appendChild(gsPanel);

  const railHandle = h("div", { class: "sbg-gs-railresize" });
  rail.appendChild(railHandle);
  const _applyRailWidth = (w) => { gsPanel.style.gridTemplateColumns = w + "px minmax(0, 1fr)"; };
  const savedRailWidth = parseInt(lsGet(B.SETTINGS_RAIL_WIDTH), 10);
  if (savedRailWidth >= 170 && savedRailWidth <= 420) _applyRailWidth(savedRailWidth);
  attachSplitter(railHandle, {
    min: 170, max: 420,
    size: () => rail.offsetWidth,
    apply: _applyRailWidth,
    done: (w) => lsSet(B.SETTINGS_RAIL_WIDTH, String(w)),
  });

  document.querySelector(".sbg-root").appendChild(gsOverlay);

  const _gsCleanups = [];
  const _visitCleanups = [];
  function closeGS() {
    _activeCloseGS = null;
    _rememberScroll();
    for (const fn of _visitCleanups.splice(0)) { try { fn(); } catch { } }
    for (const fn of _gsCleanups.splice(0)) { try { fn(); } catch { } }
    document.removeEventListener("keydown", _gsKey);
    gsOverlay.remove();
    galleryCtx?.closed?.();
  }
  _activeCloseGS = closeGS;
  // A repeat is ignored, since holding Escape cancels a key recording and its
  // repeats would then close the panel too.
  function _gsKey(e) { if (e.key === "Escape" && !e.repeat) closeGS(); }
  gsClose.addEventListener("click", closeGS);
  gsOverlay.addEventListener("click", (e) => { if (e.target === gsOverlay) closeGS(); });
  document.addEventListener("keydown", _gsKey);

  const _releaseTrap = trapFocus(gsPanel, { initialFocus: gsPanel });
  _gsCleanups.push(_releaseTrap);

  const tabCtx = { content, galleryCtx, closeGS, tabs: TABS, visitCleanups: _visitCleanups };
  let _activeTabId = null;
  function _rememberScroll() {
    if (_activeTabId) _tabScroll.set(_activeTabId, content.scrollTop || 0);
  }
  function selectTab(btn) {
    for (const fn of _visitCleanups.splice(0)) { try { fn(); } catch { } }
    _rememberScroll();
    _activeTabId = btn.dataset.tab;
    lsSet(B.SETTINGS_LAST_TAB, _activeTabId);
    tabBtns.forEach(b => b.classList.remove("sbg-gs-navitem--active"));
    btn.classList.add("sbg-gs-navitem--active");
    setSelectedTab(tabBtns, btn);
    TABS.find(t => t.id === _activeTabId).render(tabCtx);
    applyFilter();

    const top = _tabScroll.get(_activeTabId) || 0;
    content.scrollTop = top;
    if (top) requestAnimationFrame(() => { if (_activeTabId === btn.dataset.tab) content.scrollTop = top; });
  }

  let _tabIndex = null;
  // Each tab renders once into a detached element, so the badges can count
  // matches on tabs that are not open.
  function _buildTabIndex() {
    if (_tabIndex) return _tabIndex;
    _tabIndex = new Map();
    for (const tab of TABS) {
      if (tab.searchable === false) continue;
      const scratchCleanups = [];
      const scratchContent = h("div");
      // A tab that cannot render off screen adds nothing to the search.
      try {
        tab.render({
          ...tabCtx,
          content: scratchContent,
          visitCleanups: scratchCleanups,
          indexOnly: true,
        });
      } catch { }
      const form = scratchContent.querySelector(".sbg-gs-form");
      _tabIndex.set(tab.id, form ? _sections(form) : []);
      for (const fn of scratchCleanups.splice(0)) { try { fn(); } catch { } }
    }
    return _tabIndex;
  }
  function _indexCount(tabId, q) {
    const sections = _buildTabIndex().get(tabId);
    return sections ? _match(sections, q) : 0;
  }
  function _updateBadges(q, activeId, activeTotal) {
    for (let i = 0; i < TABS.length; i++) {
      const badge = tabBtns[i].querySelector(".sbg-gs-navbadge");
      if (!badge) continue;
      if (!q) { badge.classList.add("sbg-hidden"); continue; }
      const n = TABS[i].id === activeId ? activeTotal : _indexCount(TABS[i].id, q);
      badge.textContent = String(n);
      badge.classList.toggle("sbg-hidden", n === 0);
    }
  }
  function _otherTabHits(q, activeId) {
    const out = [];
    for (const tab of TABS) {
      if (tab.id === activeId || tab.searchable === false) continue;
      if (_indexCount(tab.id, q) > 0) out.push(tab.label);
    }
    return out;
  }

  function applyFilter() {
    const form = content.querySelector(".sbg-gs-form");

    if (!form) {
      const qRaw = searchInput.value.trim();
      const formLessId = tabBar.querySelector(".sbg-gs-navitem--active")?.dataset.tab;
      _updateBadges(qRaw.toLowerCase(), formLessId, 0);
      if (qRaw) {
        const hits = _otherTabHits(qRaw.toLowerCase(), formLessId);
        noResults.textContent = "Search does not cover this tab."
          + (hits.length ? " Matches found in " + hits.join(", ") + "." : "");
        noResults.classList.remove("sbg-hidden");
      } else {
        noResults.classList.add("sbg-hidden");
      }
      return;
    }
    const q = searchInput.value.trim().toLowerCase();
    let total = 0;
    // The filter hides with a class of its own, since a tab hides some rows
    // with sbg-hidden and clearing the query must not show those.
    if (!q) {
      for (const el of form.children) el.classList.remove("sbg-gs-filtered");
    } else {
      total = _match(_sections(form), q, (el, shown) => el.classList.toggle("sbg-gs-filtered", !shown));
    }

    const activeId = tabBar.querySelector(".sbg-gs-navitem--active")?.dataset.tab;
    _updateBadges(q, activeId, total);
    if (q && total === 0) {
      const hits = _otherTabHits(q, activeId);
      const shown = searchInput.value.trim();
      noResults.textContent = hits.length
        ? `Nothing in this tab matches "${shown}". Matches found in ${hits.join(", ")}.`
        : `Nothing matches "${shown}".`;
      noResults.classList.remove("sbg-hidden");
    } else {
      noResults.classList.add("sbg-hidden");
    }
  }

  let _filterFrame = 0;
  // A row a fetch adds or fills after its tab renders would otherwise land
  // unfiltered under a live query. The filter only toggles classes, which
  // childList does not see, so it cannot wake itself.
  const _filterObserver = new MutationObserver(() => {
    if (_filterFrame) return;
    _filterFrame = requestAnimationFrame(() => { _filterFrame = 0; applyFilter(); });
  });
  _filterObserver.observe(content, { childList: true, subtree: true });
  _gsCleanups.push(() => {
    _filterObserver.disconnect();
    if (_filterFrame) cancelAnimationFrame(_filterFrame);
  });

  searchInput.addEventListener("input", applyFilter);

  searchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !searchInput.value) return;
    e.stopPropagation();
    searchInput.value = "";
    applyFilter();
  });
  for (const btn of tabBtns) {
    btn.addEventListener("click", () => selectTab(btn));
  }

  const detachTabKeys = wireTablistKeys(tabBtns, selectTab);
  _gsCleanups.push(() => detachTabKeys());

  const openOn = defaultTab || lsGet(B.SETTINGS_LAST_TAB) || "layout";
  selectTab(tabBtns.find(b => b.dataset.tab === openOn) || tabBtns.find(b => b.dataset.tab === "layout"));
}
