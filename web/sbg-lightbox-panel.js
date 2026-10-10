import {
  h,
  searchState,
  highlightSearchMatches,
} from "./sbg-core.js";
import { getSetting, S } from "./sbg-settings-store.js";
import { wireTablistKeys, setSelectedTab } from "./sbg-a11y.js";
import * as TL from "./sbg-translation-layer.js";
import { APP_LABELS, profileKey, getActiveProfile } from "./sbg-layout-store.js";
import { sourceMediaKey, sourceTabLabel, initialImageList, initialAudioList, sourceMediaList } from "./sbg-lightbox-meta.js";
import { makeSection } from "./sbg-meta-section.js";
import { failureText } from "./sbg-toast.js";
import { itemKey } from "./sbg-media-kind.js";

export function createMetaPanel({
  host, getMeta, getMetaItem, setMeta, shownItem,
  isCompareActive, comparedItem, sourceMediaContent,
  loadWfBtn, copyPromptBtn, copyWfBtn, focusLightbox = () => {},
}) {
  const loadingLine = () => h("div", { class: "sbg-lb__note sbg-loading", text: "Loading metadata…" });

  let _waitLine = loadingLine();
  const metaBody = h("div", { class: "sbg-lb__meta-body" }, [_waitLine]);

  const _metaHeaderBadge = h("span", { class: "sbg-source-app" });

  const _tabGenerated = h("button", {
    class: "sbg-tab sbg-tab--active", text: "Generated",
    role: "tab", "aria-selected": "true", tabindex: "0",
  });
  const _tabSource = h("button", {
    class: "sbg-tab sbg-lb__source-tab", text: "Source Image",
    role: "tab", "aria-selected": "false", tabindex: "-1",
  });
  const _metaTabs = h("div", {
    class: "sbg-tabs", role: "tablist", "aria-label": "Metadata views",
  }, [_tabGenerated, _tabSource]);
  _metaTabs.classList.add("sbg-hidden");
  host.append(h("div", { class: "sbg-lb__meta-header" }, [_metaTabs, _metaHeaderBadge]), metaBody);

  wireTablistKeys([_tabGenerated, _tabSource], (btn) =>
    _switchMetaTab(btn === _tabGenerated ? "generated" : "source"));

  let _generatedMetaContent = null;
  let _sourceContent = null;
  let _pendingSource = null;
  let _activeMetaTab = "generated";

  function _setActiveMetaTab(tab) {
    _activeMetaTab = tab;
    _tabGenerated.classList.toggle("sbg-tab--active", tab === "generated");
    _tabSource.classList.toggle("sbg-tab--active", tab === "source");
    setSelectedTab([_tabGenerated, _tabSource],
      tab === "generated" ? _tabGenerated : _tabSource);
  }

  let _compareSummary = null;

  // A player taken out of the page keeps playing with no control left on screen.
  // The cached tabs are paused and kept whole, since clearing their source would
  // leave a dead player when the tab reopens.
  function _pauseMedia() {
    for (const root of [metaBody, _generatedMetaContent, _sourceContent]) {
      if (!root) continue;
      for (const m of root.querySelectorAll("audio, video")) m.pause();
    }
  }

  // A section head focused in the body would leave with it and drop focus to
  // the page, so focus goes back to the lightbox first.
  function _emptyBody() {
    _pauseMedia();
    if (metaBody.contains(document.activeElement)) focusLightbox();
    metaBody.innerHTML = "";
  }

  function _drawLine(line) {
    _emptyBody();
    if (isCompareActive()) metaBody.appendChild(_compareHeader(false));
    metaBody.appendChild(line);
  }

  function _showWithoutSummary(line) {
    setMeta(null, null);
    _waitLine = line;
    loadWfBtn.disabled = true;
    copyPromptBtn.disabled = true;
    copyWfBtn.disabled = true;
    _metaHeaderBadge.innerHTML = "";
    if (!isCompareActive()) _metaTabs.classList.add("sbg-hidden");
    _drawLine(line);
  }

  const showLoading = () => _showWithoutSummary(loadingLine());
  const showFailed = (e) => _showWithoutSummary(h("div", { class: "sbg-lb__note sbg-lb__note--failed", text: failureText("load the metadata", e) }));

  function _switchMetaTab(tab) {
    _setActiveMetaTab(tab);
    // While a summary loads the cached tabs still hold the previous file, so only
    // the selection changes.
    if (!getMeta()) return;
    _emptyBody();
    if (isCompareActive() && _compareSummary) {
      _renderComparePanel(_compareSummary);
    } else if (tab === "generated" && _generatedMetaContent) {
      metaBody.appendChild(_generatedMetaContent);
    } else if (tab === "source") {
      if (!_sourceContent && _pendingSource) {
        _sourceContent = sourceMediaContent(_pendingSource.s, _pendingSource.rootId);
      }
      if (_sourceContent) metaBody.appendChild(_sourceContent);
    }
    // Cached tab content was measured off the page, where scrollHeight reads zero.
    requestAnimationFrame(() => TL.sizePromptBoxes(metaBody));
  }

  _tabGenerated.addEventListener("click", () => _switchMetaTab("generated"));
  _tabSource.addEventListener("click", () => _switchMetaTab("source"));

  function show(m, item) {
    setMeta(m, item);
    _emptyBody();
    loadWfBtn.disabled = true;
    copyPromptBtn.disabled = true;
    copyWfBtn.disabled = true;

    _generatedMetaContent = null;
    _sourceContent = null;
    _pendingSource = null;
    const tabPersist = getSetting(S.META_TAB_PERSIST);
    // Compare keeps its tab, or every navigation would pull the user off the Source tab.
    if (!tabPersist && !isCompareActive()) _setActiveMetaTab("generated");
    if (!isCompareActive()) _metaTabs.classList.add("sbg-hidden");

    const s = m.summary || {};

    _metaHeaderBadge.innerHTML = "";
    const appLabel = APP_LABELS[s.source_app];
    if (appLabel) {
      _metaHeaderBadge.appendChild(h("span", { class: `sbg-badge sbg-badge--source sbg-badge--source-${s.source_app}`, text: appLabel }));
    }

    // A redraw in the pause of fast navigation draws the file left behind, and
    // the buttons stay off until the file on screen has its own summary.
    const onScreen = itemKey(item) === itemKey(shownItem());
    if (onScreen && s.positive_prompt) copyPromptBtn.disabled = false;
    if (onScreen && s.has_workflow) {
      loadWfBtn.disabled = false;
      copyWfBtn.disabled = false;
    }

    // Compare owns the panel, and closing it redraws the normal one from scratch.
    if (isCompareActive()) {
      if (_compareSummary) _renderComparePanel(_compareSummary);
      return;
    }

    const app = s.source_app;
    const profile = getActiveProfile(app, item.kind);
    const merged = TL.mergeFileInfo(s, item);

    for (const section of TL.visibleSections(profile, merged)) {
      const rawData = TL.sectionWantsRaw(section) ? (m.workflow || m.prompt || null) : null;
      const contentEl = TL.renderSection(section, merged, { rawData, profileKey: profileKey(app, item.kind) });
      if (!contentEl) continue;
      metaBody.appendChild(makeSection(section, contentEl));
    }

    if (searchState.terms.length) {
      highlightSearchMatches(metaBody, searchState.terms);
    }

    _generatedMetaContent = h("div", {});
    while (metaBody.firstChild) _generatedMetaContent.appendChild(metaBody.firstChild);
    metaBody.appendChild(_generatedMetaContent);

    if (sourceMediaList(s).length) {
      _metaTabs.classList.remove("sbg-hidden");
      _tabSource.textContent = sourceTabLabel(initialImageList(s).length, initialAudioList(s).length);
      // Built when the tab opens, since each source file costs a metadata fetch and a folder probe.
      _pendingSource = { s, rootId: item.root_id };

      if (tabPersist && _activeMetaTab === "source") {
        _switchMetaTab("source");
      }
    }
  }

  function redraw() {
    const m = getMeta();
    if (m) show(m, getMetaItem());
    else _showWithoutSummary(_waitLine);
  }

  function _compareHeader(withDiffLegend) {
    const header = h("div", { class: "sbg-compare-header" });
    header.appendChild(h("div", { class: "sbg-compare-header__title", text: `Comparing: ${comparedItem().filename}` }));
    const legend = h("div", { class: "sbg-compare-header__legend" });
    if (withDiffLegend) {
      legend.appendChild(h("span", { class: "sbg-cmp-legend--same", text: "■ Same" }));
      legend.appendChild(h("span", { class: "sbg-cmp-legend--changed", text: "■ Changed" }));
    }
    legend.appendChild(h("span", { class: "sbg-cmp-legend--current", text: withDiffLegend ? "■ Current only" : "■ Current" }));
    legend.appendChild(h("span", { class: "sbg-cmp-legend--compared", text: withDiffLegend ? "■ Compared only" : "■ Compared" }));
    header.appendChild(legend);
    return header;
  }

  function _renderComparePanel(compareSummary) {
    // Held before the guard, since show draws it again once the current file's summary arrives.
    _compareSummary = compareSummary;
    if (!getMeta()) return;

    if (compareSummary.__cmpPending || compareSummary.__cmpError) {
      _drawLine(h("div", {
        class: "sbg-lb__note " + (compareSummary.__cmpPending ? "sbg-loading" : "sbg-lb__note--failed"),
        text: compareSummary.__cmpPending ? "Loading the compared file's metadata…" : failureText("load the compared file's metadata", compareSummary.error),
      }));
      return;
    }

    const curS = getMeta().summary || {};
    const showTabs = !!(sourceMediaList(curS).length || sourceMediaList(compareSummary).length);
    if (showTabs) {
      _tabSource.textContent = sourceTabLabel(
        initialImageList(curS).length + initialImageList(compareSummary).length,
        initialAudioList(curS).length + initialAudioList(compareSummary).length);
    }
    _metaTabs.classList.toggle("sbg-hidden", !showTabs);
    if (!showTabs && _activeMetaTab === "source") _setActiveMetaTab("generated");
    if (_activeMetaTab === "source") _showCompSources();
    else _showCompDiff(compareSummary);
  }

  function _sideBlock(label, side) {
    const wrap = h("div", { class: `sbg-cmp-side sbg-cmp-side--${side}` });
    wrap.appendChild(h("div", { class: "sbg-cmp-side__label", text: `▎${label}` }));
    return wrap;
  }
  const _hairline = () => h("div", { class: "sbg-cmp-hairline" });

  function _showCompSources() {
    const curS = getMeta().summary || {};
    const cmpS = _compareSummary;
    const curRoot = getMetaItem().root_id;
    const cmpRoot = comparedItem().root_id;
    _emptyBody();
    metaBody.appendChild(_compareHeader(false));

    const note = (text) => h("div", { class: "sbg-cmp-note", text });
    const block = (label, side, s, rootId) => {
      const wrap = _sideBlock(label, side);
      if (sourceMediaList(s).length) wrap.appendChild(sourceMediaContent(s, rootId));
      else wrap.appendChild(note("No source image or audio"));
      return wrap;
    };
    const sameSource = sourceMediaList(curS).length && sourceMediaList(cmpS).length
      && sourceMediaKey(curS, curRoot) === sourceMediaKey(cmpS, cmpRoot);
    metaBody.appendChild(block("Current", "current", curS, curRoot));
    metaBody.appendChild(_hairline());
    if (sameSource) {
      const wrap = _sideBlock("Compared", "compared");
      wrap.appendChild(note("Same source as the current file"));
      metaBody.appendChild(wrap);
    } else {
      metaBody.appendChild(block("Compared", "compared", cmpS, cmpRoot));
    }
  }

  function _showCompDiff(compareSummary) {
    const currentSummary = getMeta().summary || {};
    const curItem = getMetaItem();
    const compItem = comparedItem();
    const sameKind = curItem.kind === compItem.kind;
    const app = currentSummary.source_app || compareSummary.source_app;

    const curProfile = getActiveProfile(app, curItem.kind);

    const compProfile = sameKind ? curProfile : getActiveProfile(app, compItem.kind);

    const pairs = [];
    if (sameKind) {
      for (const sec of curProfile) pairs.push([sec, sec]);
    } else {
      const compById = new Map();
      for (const sec of compProfile) if (sec && sec.id) compById.set(sec.id, sec);
      const taken = new Set();
      for (const sec of curProfile) {
        const twin = sec && sec.id ? compById.get(sec.id) : null;
        if (twin) taken.add(sec.id);
        pairs.push([sec, twin || null]);
      }
      for (const sec of compProfile) {
        if (sec && sec.id && !taken.has(sec.id)) pairs.push([null, sec]);
      }
    }

    const curMerged = TL.mergeFileInfo(currentSummary, curItem);
    const cmpMerged = TL.mergeFileInfo(compareSummary, compItem);

    const differs = (curSec, cmpSec) => {
      try { return TL.sectionSignature(curSec, curMerged) !== TL.sectionSignature(cmpSec, cmpMerged); }
      catch (e) {
        // One that cannot be built counts as different, so the failure never hides a real change.
        console.warn("[SBG] sectionSignature failed for", curSec.id, e);
        return true;
      }
    };

    _emptyBody();
    metaBody.appendChild(_compareHeader(true));

    const _usable = (sec) => !!sec && !!sec.title && sec.style !== "raw" && !sec.hidden;

    for (const [curSection, compSection] of pairs) {
      const secCur = _usable(curSection) ? curSection : null;
      const secCmp = _usable(compSection) ? compSection : null;
      if (!secCur && !secCmp) continue;
      const section = secCur || secCmp;

      const hasCurrent = !!secCur && TL.sectionHasData(secCur, curMerged);
      const hasCompare = !!secCmp && TL.sectionHasData(secCmp, cmpMerged);
      if (!hasCurrent && !hasCompare) continue;

      const hasDiff = !(hasCurrent && hasCompare) || differs(secCur, secCmp);

      const sectionWrap = h("div", { class: `sbg-cmp-sec${hasDiff ? " sbg-cmp-sec--diff" : ""}` });

      const sectionHeader = !hasDiff
        ? h("button", { type: "button", class: "sbg-cmp-sechead sbg-cmp-sechead--fold", "aria-expanded": "false" })
        : h("div", { class: "sbg-cmp-sechead" });
      sectionHeader.appendChild(h("span", { class: "sbg-cmp-sectitle", text: section.title }));
      sectionHeader.appendChild(hasDiff
        ? h("span", { class: "sbg-cmp-flag sbg-cmp-flag--diff", text: "CHANGED" })
        : h("span", { class: "sbg-cmp-flag sbg-cmp-flag--same", text: "SAME" }));
      sectionWrap.appendChild(sectionHeader);

      if (hasDiff && hasCurrent && hasCompare) {
        const stack = h("div", { class: "sbg-cmp-stack" });
        const topBlock = _sideBlock("Current", "current");
        const tc = TL.renderSection(secCur, curMerged, {}); if (tc) topBlock.appendChild(tc);
        stack.appendChild(topBlock);
        stack.appendChild(_hairline());
        const bottomBlock = _sideBlock("Compared", "compared");
        const bc = TL.renderSection(secCmp, cmpMerged, {}); if (bc) bottomBlock.appendChild(bc);
        stack.appendChild(bottomBlock);
        sectionWrap.appendChild(stack);
      } else if (hasCurrent && hasCompare) {
        const wrapper = h("div", { class: "sbg-lb-cmp-fold sbg-hidden" });
        const sc = TL.renderSection(secCur, curMerged, {}); if (sc) wrapper.appendChild(sc);
        sectionWrap.appendChild(wrapper);
        sectionHeader.addEventListener("click", () => {
          const open = wrapper.classList.contains("sbg-hidden");
          wrapper.classList.toggle("sbg-hidden", !open);
          sectionHeader.setAttribute("aria-expanded", String(open));
          // A prompt box drawn inside the hidden fold could not be measured, so it is sized as the fold opens.
          if (open) TL.sizePromptBoxes(wrapper);
        });
      } else {
        const single = hasCurrent
          ? TL.renderSection(secCur, curMerged, {})
          : TL.renderSection(secCmp, cmpMerged, {});
        if (single) {
          const wrapper = hasCurrent
            ? _sideBlock("Current only", "current")
            : _sideBlock("Compared only", "compared");
          wrapper.appendChild(single);
          sectionWrap.appendChild(wrapper);
        }
      }

      metaBody.appendChild(sectionWrap);
    }
  }

  return {
    show,
    showLoading,
    showFailed,
    redraw,
    renderCompare: _renderComparePanel,
    clearCompare: () => { _compareSummary = null; },
    destroy: _pauseMedia,
  };
}
