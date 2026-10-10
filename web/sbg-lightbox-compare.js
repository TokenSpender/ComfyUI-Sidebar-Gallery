import { h } from "./sbg-core.js";
import { summaryOf, summaryInMemory } from "./sbg-meta-cache.js";
import { showToast } from "./sbg-toast.js";
import { fileUrl, isImage, isVideo, kindIcon, itemKey } from "./sbg-media-kind.js";
import { nextCompareIdx, remapCompareIdx, isCompareTag } from "./sbg-compare-utils.js";
import { CLOSE_ICON, NAV_ARROW, sizedIcon } from "./sbg-icons.js";
import { failedMediaHTML } from "./sbg-lightbox-media.js";
import { S, getSetting } from "./sbg-settings-store.js";
import { titleWithKeys } from "./sbg-settings-inputs.js";

export const COMPARE_LABEL = "Compare";
const COMPARE_EXIT_LABEL = `${sizedIcon(CLOSE_ICON, 11)}Exit Compare`;

export function createCompareController({
  getItems, getIdx, isDestroyed, goTo, panel, releaseMedia,
  compareBtn, mediaArea, mediaContainer, zoomCtl,
}) {
  let _compareActive = false;
  let _compareIdx = -1;
  let _compareElements = null;
  let _cmpGen = 0;

  // The panel draws its waiting and failed lines from these two markers.
  const _CMP_PENDING = { __cmpPending: true };
  const _CMP_ERROR = { __cmpError: true };

  const navButton = (dir, label, binding) => h("button", {
    class: `sbg-lb__nav sbg-lb__nav--${dir} sbg-compare__nav`, html: NAV_ARROW,
    title: titleWithKeys(label, getSetting(binding)), "aria-label": label,
  });

  function toggleCompareMode() {
    if (_compareActive) { closeCompareMode(); return; }
    const currentItem = getItems()[getIdx()];
    if (getItems().length < 2) { showToast("Compare needs at least two files."); return; }
    _compareActive = true;
    _compareIdx = getIdx() === 0 ? 1 : getIdx() - 1;
    // The current media element moves into the left half still carrying the
    // single pane's transform, so every zoom is cleared first.
    zoomCtl.resetAll();

    compareBtn.innerHTML = COMPARE_EXIT_LABEL;
    compareBtn.classList.add("sbg-lb__act--compare-on");

    const leftHalf = h("div", { class: "sbg-compare__half" });
    const leftFig = h("div", { class: "sbg-compare__fig" });
    const leftOverlay = h("div", { class: "sbg-compare__label", text: "CURRENT" });
    const leftFilename = h("div", { class: "sbg-compare__filename", text: currentItem.filename || "" });
    const leftPrevBtn = navButton("prev", "Previous file on the left", S.KEY_CMP_CUR_PREV);
    const leftNextBtn = navButton("next", "Next file on the left", S.KEY_CMP_CUR_NEXT);
    leftPrevBtn.addEventListener("click", (e) => { e.stopPropagation(); goTo(getIdx() - 1); });
    leftNextBtn.addEventListener("click", (e) => { e.stopPropagation(); goTo(getIdx() + 1); });

    const rightHalf = h("div", { class: "sbg-compare__half" });
    const rightFig = h("div", { class: "sbg-compare__fig" });
    const rightImg = h("img", {});
    const rightPrevBtn = navButton("prev", "Previous file on the right", S.KEY_PREV);
    const rightNextBtn = navButton("next", "Next file on the right", S.KEY_NEXT);
    const rightFilename = h("div", { class: "sbg-compare__filename", text: "" });
    const rightLabel = h("div", { class: "sbg-compare__label sbg-compare__label--compared", text: "COMPARED" });
    rightPrevBtn.addEventListener("click", (e) => { e.stopPropagation(); _navigateCompare(-1); });
    rightNextBtn.addEventListener("click", (e) => { e.stopPropagation(); _navigateCompare(1); });

    const divider = h("div", { class: "sbg-compare__divider" });

    for (const el of [leftOverlay, leftFilename]) {
      el.dataset.sbgCompare = "1";
    }

    rightFig.append(rightImg, rightLabel, rightFilename);
    rightHalf.append(rightFig, rightPrevBtn, rightNextBtn);
    leftFig.append(leftOverlay, leftFilename);

    mediaArea.classList.add("sbg-lb__media-area--compare");

    while (mediaContainer.firstChild) leftFig.appendChild(mediaContainer.firstChild);
    leftHalf.append(leftFig, leftPrevBtn, leftNextBtn);
    mediaContainer.append(leftHalf, divider, rightHalf);

    _compareElements = {
      leftHalf, leftFig, divider, rightHalf, rightMedia: rightImg,
      leftOverlay, leftFilename, leftPrevBtn, leftNextBtn, rightFilename,
    };
    _loadCompared();
  }

  function closeCompareMode() {
    if (!_compareActive) return;
    // Before the halves are let go below, since resetAll finds them through getCompareElements.
    zoomCtl.resetAll();
    _compareActive = false;
    panel.clearCompare();
    _cmpGen++;
    compareBtn.textContent = COMPARE_LABEL;
    compareBtn.classList.remove("sbg-lb__act--compare-on");
    releaseMedia(_compareElements.rightMedia);

    for (const child of [..._compareElements.leftFig.children]) {
      if (!isCompareTag(child)) mediaContainer.appendChild(child);
    }
    _compareElements.leftHalf.remove();
    _compareElements.divider.remove();
    _compareElements.rightHalf.remove();
    _compareElements = null;
    mediaArea.classList.remove("sbg-lb__media-area--compare");
    if (!isDestroyed()) panel.redraw();
  }

  function _navigateCompare(dir) {
    if (!_compareActive) return;
    _compareIdx = nextCompareIdx(_compareIdx, dir, getIdx(), getItems().length);
    _loadCompared();
  }

  function _updateCompareLabels() {
    if (!_compareActive) return;
    _compareElements.leftFilename.textContent = getItems()[getIdx()].filename;
    _compareElements.rightFilename.textContent = getItems()[_compareIdx].filename;

    _compareElements.leftPrevBtn.style.visibility = getIdx() === 0 ? "hidden" : "visible";
    _compareElements.leftNextBtn.style.visibility = getIdx() === getItems().length - 1 ? "hidden" : "visible";
  }

  function _loadCompared() {
    if (!_compareActive) return;
    const compItem = getItems()[_compareIdx];

    zoomCtl.navigated("right");
    // Any other kind gets an icon pane, since its file URL in an img would download in full.
    const wantTag = isVideo(compItem) ? "VIDEO"
      : isImage(compItem) ? "IMG" : "DIV";
    let mediaEl = _compareElements.rightMedia;
    if (mediaEl.tagName !== wantTag) {
      const neu = wantTag === "VIDEO"
        ? h("video", { loop: "", autoplay: "", controls: "", playsinline: "" })
        : wantTag === "DIV"
          ? h("div", { class: "sbg-lb__icon-pane sbg-lb__icon-pane--compare" })
          : h("img", {});
      if (wantTag === "VIDEO") neu.muted = true;
      releaseMedia(mediaEl);
      mediaEl.replaceWith(neu);
      _compareElements.rightMedia = neu;
      mediaEl = neu;
    }
    // Zoom leaves the pane alone until the new file gives the element its size.
    mediaEl.dataset.sbgPending = "1";
    const _clearPending = () => {
      delete mediaEl.dataset.sbgPending;
      zoomCtl.reapply("right");
    };
    if (mediaEl.tagName === "VIDEO") {
      mediaEl.onloadeddata = _clearPending;
      mediaEl.oncanplay = _clearPending;
      mediaEl.onerror = _clearPending;
    } else if (mediaEl.tagName === "IMG") {
      mediaEl.onload = _clearPending;

      const img = mediaEl;
      img.onerror = () => {
        if (!_compareElements || _compareElements.rightMedia !== img) return;
        const pane = h("div", { class: "sbg-lb__icon-pane sbg-lb__icon-pane--compare sbg-lb__icon-pane--failed", html: failedMediaHTML(compItem) });
        releaseMedia(img);
        img.replaceWith(pane);
        _compareElements.rightMedia = pane;
        _clearPending();
      };
    }
    if (mediaEl.tagName === "DIV") {
      mediaEl.classList.remove("sbg-lb__icon-pane--failed");
      mediaEl.innerHTML = kindIcon(compItem);
      _clearPending();
    } else {
      mediaEl.src = fileUrl(compItem);
    }
    _updateCompareLabels();

    const gen = ++_cmpGen;
    const held = summaryInMemory(compItem);
    if (held?.summary) {
      panel.renderCompare(held.summary);
    } else {
      // At once, or a redraw before the fetch lands would diff against the previous compared file.
      panel.renderCompare(_CMP_PENDING);
      summaryOf(compItem)
        .then((m2) => {
          if (_compareActive && _cmpGen === gen) panel.renderCompare(m2.summary);
        })
        .catch((e) => {
          if (_compareActive && _cmpGen === gen) panel.renderCompare({ ..._CMP_ERROR, error: e });
        });
    }
  }

  function avoidCollision(newIdx) {
    if (_compareActive && newIdx === _compareIdx && getItems().length > 1) {
      const _dir = newIdx >= getIdx() ? 1 : -1;
      _compareIdx = nextCompareIdx(_compareIdx, _dir, newIdx, getItems().length);
      _loadCompared();
    }
  }

  // Read before the items array is replaced, since it finds the compared file by index.
  function comparedKey() {
    const cmpItem = _compareActive ? getItems()[_compareIdx] : null;
    return cmpItem ? itemKey(cmpItem) : null;
  }

  function remapAfterItemsChange(cmpKey, curIdx) {
    if (!_compareActive) return;
    if (getItems().length < 2) { closeCompareMode(); return; }
    const r = remapCompareIdx(getItems(), cmpKey, _compareIdx, curIdx);
    _compareIdx = r.compareIdx;
    // Loading again only for a different file keeps a playing compared video running.
    if (r.changed) _loadCompared();
    else _updateCompareLabels();
  }

  return {
    isActive: () => _compareActive,
    comparedIdx: () => _compareIdx,
    elements: () => _compareElements,
    mediaHost: () => (_compareElements ? _compareElements.leftFig : null),
    toggle: toggleCompareMode,
    close: closeCompareMode,
    navigate: _navigateCompare,
    updateLabels: _updateCompareLabels,
    avoidCollision,
    comparedKey,
    remapAfterItemsChange,
  };
}
