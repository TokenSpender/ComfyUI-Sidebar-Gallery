import {
  ensureCss,
  h,
  lsGet,
  lsSet,
} from "./sbg-core.js";
import { summaryOf, summaryInMemory, fetchFullMeta } from "./sbg-meta-cache.js";
import { S, getSetting, B, orderedIds } from "./sbg-settings-store.js";
import { LB_BUTTONS } from "./sbg-settings-catalog.js";
import { showFailure, confirmClick } from "./sbg-toast.js";
import { deleteFile, copyPrompt, copyWorkflow, loadWorkflowFrom } from "./sbg-file-actions.js";
import { fileUrl, itemKey, isImage } from "./sbg-media-kind.js";

import { trapFocus } from "./sbg-a11y.js";
import { attachSplitter } from "./sbg-splitter.js";
import { createZoomPanController } from "./sbg-lightbox-zoom.js";
import { createMediaStage } from "./sbg-lightbox-media.js";
import { createSourceMediaBuilder } from "./sbg-lightbox-meta.js";
import { createMetaPanel } from "./sbg-lightbox-panel.js";
import { attachOverlayThumb } from "./sbg-overlay-thumb.js";
import { createCompareController, COMPARE_LABEL } from "./sbg-lightbox-compare.js";
import { isCompareTag } from "./sbg-compare-utils.js";
import { descFromKeyEvent, matchExplicit, matchBare, focusOwnsKey, splitBindings, wireMouseBindings } from "./sbg-keybinds.js";
import { titleWithKeys } from "./sbg-settings-inputs.js";
import { favoriteTitle, isFavorite, toggleFavorite } from "./sbg-favorites.js";
import { STAR_ICON, STAR_OUTLINE_ICON, CLOSE_ICON, NAV_ARROW, ARROW_LEFT_ICON, iconImage, sizedIcon } from "./sbg-icons.js";

function releaseMedia(el) {
  if (!el) return;
  if (el._sbgDispose) {
    try { el._sbgDispose(); } catch { }
    el._sbgDispose = null;
  }
  // A detached audio element keeps playing, and the audio pane holds its
  // element inside a wrap.
  const m = (el.tagName === "VIDEO" || el.tagName === "AUDIO") ? el : el.querySelector("video, audio");
  if (!m) return;
  // Clearing the source alone does not stop the fetch. The load() after it
  // makes the browser drop the buffer.
  try { m.pause(); m.removeAttribute("src"); m.load(); } catch { }
}

// Set only at the end of a build, so one that throws partway leaves no
// lightbox counted as open.
let _openTeardown = null;
export const isLightboxOpen = () => _openTeardown !== null;

export function openLightbox(list, startIdx, openEvent) {
  ensureCss();
  let items = list;
  let idx = startIdx;

  let meta = null;
  let metaItem = null;
  let destroyed = false;
  let currentMediaEl = null;
  let delDisarm = () => { };

  let _navGen = 0;
  let _lastNavAt = 0;
  let _prefetchTimer = null;

  // File urls carry the modified time, so an entry cannot go stale and a size
  // cap is the only bound the set needs.
  const _WARM_MEDIA_CAP = 512;
  const _warmMedia = new Set();
  function _markWarm(url) {
    // Re-inserting moves the url to the end, so the least recently seen goes first.
    if (_warmMedia.has(url)) _warmMedia.delete(url);
    _warmMedia.add(url);
    while (_warmMedia.size > _WARM_MEDIA_CAP) {
      _warmMedia.delete(_warmMedia.values().next().value);
    }
  }

  const keyPrev = getSetting(S.KEY_PREV);
  const keyNext = getSetting(S.KEY_NEXT);
  const keyClose = getSetting(S.KEY_CLOSE);
  const keyFullscreen = getSetting(S.KEY_FULLSCREEN);
  const keyDownload = getSetting(S.KEY_DOWNLOAD);
  const keyCopyPrompt = getSetting(S.KEY_COPY_PROMPT);
  const keyCopyWf = getSetting(S.KEY_COPY_WF);
  const keyLoadWf = getSetting(S.KEY_LOAD_WF);
  const keyCompare = getSetting(S.KEY_COMPARE);
  const keyResetZoom = getSetting(S.KEY_RESET_ZOOM);
  const keyZoomIn = getSetting(S.KEY_ZOOM_IN);
  const keyZoomOut = getSetting(S.KEY_ZOOM_OUT);
  const keyMute = getSetting(S.KEY_MUTE);
  const keyVolUp = getSetting(S.KEY_VOL_UP);
  const keyVolDown = getSetting(S.KEY_VOL_DOWN);
  const keyFramePrev = getSetting(S.KEY_FRAME_PREV);
  const keyFrameNext = getSetting(S.KEY_FRAME_NEXT);
  const keyCmpCurPrev = getSetting(S.KEY_CMP_CUR_PREV);
  const keyCmpCurNext = getSetting(S.KEY_CMP_CUR_NEXT);
  const keyFavorite = getSetting(S.KEY_FAVORITE);
  const keyDelete = getSetting(S.KEY_DELETE);

  const mediaContainer = h("div", { class: "sbg-lb__center" });

  const prevBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--prev", html: NAV_ARROW, title: titleWithKeys("Previous", keyPrev), "aria-label": "Previous file" });
  const nextBtn = h("button", { class: "sbg-lb__nav sbg-lb__nav--next", html: NAV_ARROW, title: titleWithKeys("Next", keyNext), "aria-label": "Next file" });
  const closeBtn = h("button", { class: "sbg-lb__close", html: sizedIcon(CLOSE_ICON, 16), title: titleWithKeys("Close", keyClose), "aria-label": "Close lightbox" });

  const bottomName = h("span", { class: "sbg-lb__bottom-name" });
  const bottomCount = h("span", { class: "sbg-lb__bottom-count" });

  const dlBtn = h("a", { class: "sbg-btn sbg-lb__act--download", text: "Download", title: "Download file", download: "", target: "_blank" });
  const loadWfBtn = h("button", { class: "sbg-btn sbg-btn--accent sbg-lb__act--load-wf", text: "Load Workflow", title: "Load workflow into ComfyUI", disabled: "true" });
  const copyPromptBtn = h("button", { class: "sbg-btn sbg-lb__act--copy-prompt", text: "Copy Prompt", title: "Copy positive prompt", disabled: "true" });
  const copyWfBtn = h("button", { class: "sbg-btn sbg-lb__act--copy-wf", text: "Copy Workflow", title: "Copy workflow JSON", disabled: "true" });

  const compareBtn = h("button", { class: "sbg-btn sbg-lb__act--compare", text: COMPARE_LABEL, title: titleWithKeys("Compare with another file", keyCompare) });
  const favBtn = h("button", { class: "sbg-btn sbg-lb__act--favorite", title: favoriteTitle(false) });
  const _setFavContent = (on) => {
    favBtn.innerHTML = "";
    favBtn.appendChild(h("span", { class: "sbg-fav-star", html: on ? STAR_ICON : STAR_OUTLINE_ICON, "aria-hidden": "true" }));
    favBtn.appendChild(document.createTextNode(on ? "Favorited" : "Favorite"));
  };
  _setFavContent(false);
  function _syncFavBtn() {
    const it = items[idx];
    const on = isFavorite(it.root_id, it.relpath);
    _setFavContent(on);
    favBtn.title = favoriteTitle(on);
    favBtn.classList.toggle("sbg-btn--fav-on", on);
  }
  favBtn.addEventListener("click", () => toggleFavorite(items[idx].root_id, items[idx].relpath));
  document.addEventListener("sbg-favorites-changed", _syncFavBtn);

  const delBtn = h("button", { class: "sbg-btn sbg-btn--danger sbg-btn--delete sbg-lb__act--delete", text: "Delete", title: `${titleWithKeys("Delete", keyDelete)}. Moves this file to the Recycle Bin or Trash, or to the gallery's trash folder when the drive has none. While comparing, this deletes the left file.` });
  // Drawn by the stylesheet while two files are side by side, as an image so it
  // stays while the button asks for confirmation.
  delBtn.style.setProperty("--sbg-arrow-left", iconImage(ARROW_LEFT_ICON));

  const _runDelete = async () => {
    if (delBtn.disabled) return;
    delBtn.disabled = true;
    await deleteFile(items[idx]);
    delBtn.disabled = false;
  };
  if (getSetting(S.DELETE_CONFIRM)) delDisarm = confirmClick(delBtn, _runDelete);
  else delBtn.addEventListener("click", _runDelete);

  const _actionById = { favorite: favBtn, download: dlBtn, "copy-prompt": copyPromptBtn, "copy-wf": copyWfBtn, "load-wf": loadWfBtn, compare: compareBtn, delete: delBtn };
  for (const b of LB_BUTTONS) {
    if (!getSetting(b.show)) _actionById[b.id].classList.add("sbg-hidden");
  }
  const bottomBar = h("div", { class: "sbg-lb__bottom" }, [
    bottomName,
    bottomCount,
    h("div", { class: "sbg-lb__bottom-actions" }, orderedIds(S.LB_BUTTON_ORDER, LB_BUTTONS.map(b => b.id)).map(id => _actionById[id])),
  ]);

  const mediaArea = h("div", { class: "sbg-lb__media-area" }, [
    mediaContainer, prevBtn, nextBtn, closeBtn, bottomBar,
  ]);

  const { sourceMediaContent } = createSourceMediaBuilder({
    newStaleCheck: () => { const g = _navGen; return () => destroyed || g !== _navGen; },
  });

  const metaResizeHandle = h("div", { class: "sbg-lb__meta-resize" });
  const metaPanel = h("div", { class: "sbg-lb__meta-panel" });

  // Compare is built from the panel and the zoom, so both reach it through
  // getters that first run once it exists.
  const panel = createMetaPanel({
    host: metaPanel,
    getMeta: () => meta,
    getMetaItem: () => metaItem,
    setMeta: (m, it) => { meta = m; metaItem = it; },
    shownItem: () => items[idx],
    isCompareActive: () => cmp.isActive(),
    comparedItem: () => items[cmp.comparedIdx()],
    sourceMediaContent,
    loadWfBtn, copyPromptBtn, copyWfBtn,
    focusLightbox: () => overlay.focus(),
  });
  attachOverlayThumb(metaPanel);

  const overlay = h("div", {
    class: "sbg-lightbox",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Lightbox",
  }, [mediaArea, h("div", { class: "sbg-lb__meta-wrap" }, [metaResizeHandle, metaPanel])]);
  document.body.appendChild(overlay);

  // Focus starts on the overlay, or the first Enter would press whichever
  // button the trap picked.
  const _releaseTrap = trapFocus(overlay, { initialFocus: overlay });

  const zoomCtl = createZoomPanController({
    overlay, mediaArea, mediaContainer,
    getCurrentMediaEl: () => currentMediaEl,
    getCompareElements: () => cmp.elements(),
    settings: {
      scrollMode: getSetting(S.LB_ZOOM_SCROLL_MODE),
      anchor: getSetting(S.LB_ZOOM_ANCHOR),
      sensitivity: getSetting(S.LB_ZOOM_SENSITIVITY),
      compareZoom: getSetting(S.LB_COMPARE_ZOOM),
      keepOnNav: getSetting(S.LB_ZOOM_KEEP_ON_NAV),
    },

    initialCtrl: !!(openEvent && openEvent.ctrlKey),
  });

  const setMetaWidth = (w) => { metaPanel.style.width = w + "px"; };
  const savedMetaWidth = Number(lsGet(B.META_PANEL_WIDTH));
  if (savedMetaWidth) setMetaWidth(savedMetaWidth);

  attachSplitter(metaResizeHandle, {
    min: 150, max: 600, inverted: true,
    size: () => metaPanel.offsetWidth,
    apply: setMetaWidth,
    // The drag reflows the media area without a resize event. The splitter
    // calls this only on a real change of width, so a stray click keeps a held zoom.
    done: (w) => {
      lsSet(B.META_PANEL_WIDTH, w);
      zoomCtl.resetAll();
    },
  });

  const cmp = createCompareController({
    getItems: () => items,
    getIdx: () => idx,
    isDestroyed: () => destroyed,
    goTo,
    panel,
    releaseMedia,
    compareBtn, mediaArea, mediaContainer, zoomCtl,
  });

  // The Metadata tab announces a change on each step of a colour drag,
  // and a redraw rebuilds the whole panel, so it runs at most once a frame.
  let _layoutFrame = 0;
  const _onLayoutChanged = () => {
    if (_layoutFrame) return;
    _layoutFrame = requestAnimationFrame(() => {
      _layoutFrame = 0;
      panel.redraw();
    });
  };
  document.addEventListener("sbg-layout-changed", _onLayoutChanged);

  // Null through the pause on rapid navigation, while the panel still holds the
  // file left behind.
  const shownMeta = () => (meta && itemKey(metaItem) === itemKey(items[idx]) ? meta : null);

  function _showPosition() {
    bottomName.textContent = items[idx].filename;
    bottomCount.textContent = `${(idx + 1).toLocaleString()} / ${items.length.toLocaleString()}`;
    prevBtn.style.visibility = idx === 0 ? "hidden" : "visible";
    nextBtn.style.visibility = idx === items.length - 1 ? "hidden" : "visible";
  }

  function goTo(newIdx) {
    if (newIdx < 0 || newIdx >= items.length) return;

    cmp.avoidCollision(newIdx);
    idx = newIdx;

    delDisarm();
    const gen = ++_navGen;
    const isStale = () => destroyed || _navGen !== gen;
    const it = items[idx];

    zoomCtl.navigated(cmp.isActive() ? "left" : "single");

    const mediaHost = cmp.mediaHost() || mediaContainer;
    for (const child of [...mediaHost.children]) {
      if (isCompareTag(child)) continue;
      // A video goes at once, since one left as a backdrop would hold its decoder.
      if (child.tagName === "VIDEO" || child.dataset.sbgPending === "1" || child.dataset.sbgMedia) {
        releaseMedia(child);
        // Detaching an image does not reliably cancel its fetch or decode, so a
        // held nav key would queue behind pictures nobody stopped on.
        if (child.tagName === "IMG") child.removeAttribute("src");
        // The media build waits out the pause on rapid navigation, and until then
        // the media keys must not act on a released element. contains also finds
        // audio inside its wrap.
        if (child.contains(currentMediaEl)) currentMediaEl = null;
        child.remove();
      }
    }

    // What survives the loop above stays up until the new file paints.
    const prevChildren = [...mediaHost.children].filter(c => !isCompareTag(c));
    // Looked up at insert time, since leaving compare during the pause removes
    // the left figure a delayed build would otherwise append to.
    const _insertMedia = (el) => (cmp.mediaHost() || mediaContainer).appendChild(el);

    let swapped = false;
    const _swapIn = (neu) => {
      if (swapped || isStale()) return;
      swapped = true;
      delete neu.dataset.sbgPending;
      neu.classList.remove("sbg-lb__staged");
      for (const old of prevChildren) {
        if (!old.parentNode) continue;
        releaseMedia(old);
        old.remove();
      }

      zoomCtl.reapply(cmp.isActive() ? "left" : "single");
    };

    const _RAPID_NAV_MS = 160;
    const rapid = performance.now() - _lastNavAt < _RAPID_NAV_MS;
    _lastNavAt = performance.now();

    const buildMedia = () => createMediaStage({
      item: it,
      insertMedia: _insertMedia,
      swapIn: _swapIn,
      setCurrentMedia: (el) => { currentMediaEl = el; },
      isStale,
      onImageDecoded: _markWarm,
    });

    const buildMeta = () => {
      const savedScroll = metaPanel.scrollTop;
      const show = (m) => {
        panel.show(m, it);
        requestAnimationFrame(() => { metaPanel.scrollTop = savedScroll; });
      };
      const cached = summaryInMemory(it);
      if (cached) { show(cached); return; }
      panel.showLoading();
      summaryOf(it)
        .then((m) => { if (!isStale()) show(m); })
        .catch((e) => { if (!isStale()) panel.showFailed(e); });
    };

    _showPosition();
    dlBtn.href = fileUrl(it);
    dlBtn.download = it.filename || "";
    _syncFavBtn();
    cmp.updateLabels();

    // Through the pause the panel still holds the file left behind, so its
    // buttons wait for the file shown.
    if (rapid) loadWfBtn.disabled = copyPromptBtn.disabled = copyWfBtn.disabled = true;
    const warmSkip = rapid && !cmp.isActive()
      && isImage(it)
      && _warmMedia.has(fileUrl(it));
    if (warmSkip) {
      buildMedia();
      setTimeout(() => {
        if (!isStale()) buildMeta();
      }, _RAPID_NAV_MS);
    } else if (rapid) {
      // A settled picture stays up through the pause, and the zoom must not
      // take it for the file now shown.
      currentMediaEl = null;
      setTimeout(() => {
        if (isStale()) return;
        buildMedia();
        buildMeta();
      }, _RAPID_NAV_MS);
    } else {
      buildMedia();
      buildMeta();
    }

    clearTimeout(_prefetchTimer);
    _prefetchTimer = setTimeout(() => {
      if (isStale()) return;
      for (const di of [-1, 1]) {
        const ni = idx + di;
        if (ni < 0 || ni >= items.length) continue;
        const adj = items[ni];

        summaryOf(adj).catch(() => { });
        // Reaching ahead for a video or a track would pull a whole file that
        // may never be opened.
        if (isImage(adj)) {
          const url = fileUrl(adj);
          const pre = new Image();
          pre.src = url;
          // A failed decode leaves the url unmarked, so a missing file never
          // counts as warm.
          pre.decode().then(() => _markWarm(url)).catch(() => { });
        }
      }
    }, 300);
  }

  function _onItemsUpdated(e) {
    const currentKey = itemKey(items[idx]);
    const cmpKey = cmp.comparedKey();
    items = e.detail.items;

    const newIdx = items.findIndex(it => itemKey(it) === currentKey);
    const vanished = newIdx < 0;
    if (newIdx >= 0) idx = newIdx;
    else idx = Math.max(0, Math.min(idx, items.length - 1));

    cmp.remapAfterItemsChange(cmpKey, idx);

    // A vanished file reloads at the clamped position, since relabelling alone
    // would leave the panel and Download on the deleted file.
    if (vanished && !items.length) { destroy(); return; }
    if (vanished && items.length) { goTo(idx); return; }
    _showPosition();
  }
  document.addEventListener("sbg-items-updated", _onItemsUpdated);

  function destroy() {
    // Load Workflow closes the lightbox when its fetch returns, which can be
    // after it was already closed.
    if (destroyed) return;
    destroyed = true;
    if (_openTeardown === destroy) _openTeardown = null;
    clearTimeout(_prefetchTimer);
    if (cmp.isActive()) cmp.close();
    releaseMedia(currentMediaEl);

    for (const child of [...mediaContainer.children]) releaseMedia(child);
    panel.destroy();
    zoomCtl.destroy();
    document.removeEventListener("sbg-favorites-changed", _syncFavBtn);

    _releaseTrap();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    _unwireMouse();
    document.removeEventListener("pointerdown", _onPointerDown, true);
    document.removeEventListener("pointerup", _onPointerUp, true);
    document.removeEventListener("pointercancel", _onPointerUp, true);
    document.removeEventListener("sbg-items-updated", _onItemsUpdated);
    document.removeEventListener("sbg-layout-changed", _onLayoutChanged);
    cancelAnimationFrame(_layoutFrame);
  }

  const playable = () => (currentMediaEl && (currentMediaEl.tagName === "VIDEO" || currentMediaEl.tagName === "AUDIO") ? currentMediaEl : null);

  // A track has no frames, so the frame step keys seek it by a fixed interval.
  const _AUDIO_SEEK_STEP_S = 5;

  function _volumeStep(delta) {
    const m = playable();
    if (!m) return false;
    const next = Math.min(1, Math.max(0, m.volume + delta));
    m.volume = next;

    if (delta > 0 && m.muted && next > 0) m.muted = false;
    return true;
  }

  // A file still loading keeps the press, so another action bound to the same
  // key does not take it.
  function _frameStep(dir) {
    const v = playable();
    if (!v) return false;
    if (v.tagName === "AUDIO") {
      if (!isFinite(v.duration)) return true;
      v.currentTime = Math.min(Math.max(0, v.currentTime + dir * _AUDIO_SEEK_STEP_S), Math.max(0, v.duration - 0.001));
      return true;
    }
    if (!v.paused) v.pause();
    if (!isFinite(v.duration)) return true;
    const fps = Number(shownMeta()?.summary?.fps);
    const step = Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30;
    v.currentTime = Math.min(Math.max(0, v.currentTime + dir * step), Math.max(0, v.duration - 0.001));
    return true;
  }

  const _navRun = (dir) => () => {
    if (cmp.isActive()) {
      cmp.navigate(dir);
      return true;
    }
    const v = playable();
    if (document.fullscreenElement && v?.tagName === "VIDEO" && isFinite(v.duration)) {
      v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + dir * v.duration * 0.1));
    } else {
      goTo(idx + dir);
    }
    return true;
  };

  // Moves compare's left half, the current file. Outside compare it declines,
  // so a chord such as Shift and a nav key falls through to plain navigation.
  const _cmpNavRun = (dir) => () => {
    if (!cmp.isActive()) return false;
    goTo(idx + dir);
    return true;
  };

  // Escape closes under any modifier. The other close keys refuse Ctrl, Alt and
  // Meta, so a chord such as Ctrl and Z stays with the browser.
  const closeChunks = splitBindings(keyClose);
  const keyCloseEscape = closeChunks.filter(k => k.toLowerCase() === "escape").join(",");
  const keyCloseBare = closeChunks.filter(k => k.toLowerCase() !== "escape").join(",");
  const _closeRun = () => {
    if (document.fullscreenElement) { document.exitFullscreen(); return true; }
    if (cmp.isActive()) { cmp.close(); return true; }
    destroy();
    return true;
  };

  // Keyboard and mouse bindings in priority order, where run() returns false to
  // decline the press.
  const _ACTIONS = [
    { keys: keyCloseEscape, mods: "any", run: _closeRun },
    { keys: keyCloseBare, run: _closeRun },
    {
      keys: keyFullscreen, mods: "none", run: () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (!overlay.requestFullscreen) showFailure("go fullscreen", "this browser doesn't offer it");
        else overlay.requestFullscreen().catch((e) => showFailure("go fullscreen", e));
        return true;
      },
    },
    {
      keys: keyCompare, mods: "none",

      when: (d) => !matchBare(keyPrev, d) && !matchBare(keyNext, d),
      run: () => { cmp.toggle(); return true; },
    },
    { keys: keyCmpCurPrev, run: _cmpNavRun(-1) },
    { keys: keyCmpCurNext, run: _cmpNavRun(1) },
    { keys: keyResetZoom, run: (d) => { zoomCtl.resetSmart(d.x, d.y); return true; } },
    { keys: keyZoomIn, run: () => { zoomCtl.keyZoom(1); return true; } },
    { keys: keyZoomOut, run: () => { zoomCtl.keyZoom(-1); return true; } },
    {
      keys: keyMute, run: () => {
        const m = playable();
        if (!m) return false;
        m.muted = !m.muted;
        return true;
      },
    },
    { keys: keyVolUp, run: () => _volumeStep(0.1) },
    { keys: keyVolDown, run: () => _volumeStep(-0.1) },
    { keys: keyFramePrev, run: () => _frameStep(-1) },
    { keys: keyFrameNext, run: () => _frameStep(1) },

    { keys: keyDownload, run: () => { dlBtn.click(); return true; } },
    { keys: keyFavorite, run: () => { favBtn.click(); return true; } },
    // With the confirmation on, a held key would arm and confirm before the
    // question could be read. The confirmation lives on the button, so a hidden
    // Delete button means no delete from the lightbox.
    { keys: keyDelete, noRepeat: true, run: () => { if (delBtn.classList.contains("sbg-hidden")) return false; if (!delBtn.disabled) delBtn.click(); return true; } },
    { keys: keyCopyPrompt, run: () => { if (!copyPromptBtn.disabled) copyPromptBtn.click(); return true; } },
    { keys: keyCopyWf, run: () => { if (!copyWfBtn.disabled) copyWfBtn.click(); return true; } },
    { keys: keyLoadWf, run: () => { if (!loadWfBtn.disabled) loadWfBtn.click(); return true; } },
    { keys: keyPrev, run: _navRun(-1) },
    { keys: keyNext, run: _navRun(1) },
  ];

  function _dispatch(d) {
    // A binding naming the modifiers the press carries wins over one naming
    // only the bare key.
    for (const explicitPass of [true, false]) {
      for (const a of _ACTIONS) {
        const hit = explicitPass
          ? matchExplicit(a.keys, d)
          : matchBare(a.keys, d, a.mods || "shift");
        if (!hit) continue;
        if (a.when && !a.when(d)) continue;

        if (a.noRepeat && d.repeat) continue;
        if (a.run(d) !== false) return true;
      }
    }
    return false;
  }

  const _isBound = (d) => _ACTIONS.some((a) => matchExplicit(a.keys, d) || matchBare(a.keys, d, a.mods || "shift"));

  // Tracked here because the browser's own :focus-visible flips once any key is
  // typed, so it cannot tell a clicked control from one reached by keyboard.
  let _pointerDown = false;
  let _pointerFocused = null;
  const _TAB_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
  const _onPointerDown = () => { _pointerDown = true; };
  const _onPointerUp = () => { _pointerDown = false; };
  overlay.addEventListener("focusin", (e) => { _pointerFocused = _pointerDown ? e.target : null; });
  document.addEventListener("pointerdown", _onPointerDown, true);
  document.addEventListener("pointerup", _onPointerUp, true);
  document.addEventListener("pointercancel", _onPointerUp, true);

  // Listens in the capture phase and stops what it handles, so a press the
  // lightbox takes never reaches the graph's own shortcuts.
  function onKey(e) {
    // A key settles any press whose release never arrived, so focus a Tab
    // moves counts as the keyboard's.
    _pointerDown = false;
    if (focusOwnsKey(e.target, e.key)) return;
    // A tab reached from the keyboard moves along its row with these, while a
    // clicked one leaves the arrows to stepping through files.
    if (_TAB_KEYS.has(e.key) && e.target.getAttribute?.("role") === "tab" && e.target !== _pointerFocused) return;
    // Space plays and pauses ahead of the bindings, as the Help tab says.
    if (e.key === " " || e.code === "Space") {
      // A button focused from the keyboard answers Space itself, so the press
      // keeps its default and is only kept from the graph. One focused by a
      // pointer gets play and pause instead, so Space cannot confirm an armed
      // Delete.
      const t = e.target;
      const role = t.getAttribute?.("role");
      const isButton = t.tagName === "BUTTON" || role === "button" || role === "tab";
      if (isButton && t !== _pointerFocused) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
      // A key typed on a clicked button gives it the keyboard's focus ring, so
      // focus goes back to the lightbox.
      if (isButton) overlay.focus();
      // Taken even with nothing to play, since a Space reaching the graph can
      // start its hold-to-pan.
      e.preventDefault();
      const m = playable();
      if (m && m.paused) {
        const p = m.play();
        if (p && p.catch) p.catch(() => { });
      } else if (m) {
        m.pause();
      }
    } else {
      const d = descFromKeyEvent(e);
      d.repeat = !!e.repeat;
      if (_dispatch(d)) e.preventDefault();
      // A bound press every action declined, such as Mute with nothing playing,
      // is still kept from the graph, whose own shortcut for that key would act
      // behind the lightbox. Its default is kept.
      else if (_isBound(d)) { e.stopPropagation(); e.stopImmediatePropagation(); }
    }
    if (e.defaultPrevented) { e.stopPropagation(); e.stopImmediatePropagation(); }
  }
  document.addEventListener("keydown", onKey, true);

  const _unwireMouse = wireMouseBindings((e, d) => _dispatch(d), { capture: true });

  closeBtn.addEventListener("click", destroy);
  prevBtn.addEventListener("click", () => goTo(idx - 1));
  nextBtn.addEventListener("click", () => goTo(idx + 1));
  mediaArea.addEventListener("click", (e) => {
    // The compare halves tile the container, so their dark space is background too.
    const isBackground = e.target === mediaArea || e.target === mediaContainer
      || e.target.classList.contains("sbg-compare__half");
    if (isBackground) {
      if (cmp.isActive()) cmp.close();
      else destroy();
    }
  });

  // Null when the file shown changed during the fetch. A file the scan has not
  // reached gets its whole metadata from the summary read, so its workflow may
  // already be held.
  async function _fullMetaOfShown() {
    const own = shownMeta();
    if (own?.workflow) return own;
    const gen = _navGen;
    const full = await fetchFullMeta(items[idx]);
    return _navGen === gen && !destroyed ? full : null;
  }

  loadWfBtn.addEventListener("click", async () => {
    try {
      loadWfBtn.textContent = "Loading…";
      const m = await _fullMetaOfShown();
      if (!m) return;
      // Closes even when ComfyUI cannot build the graph, since its own dialog
      // saying so opens behind the lightbox.
      if (await loadWorkflowFrom(m)) destroy();
    } catch (e) {
      showFailure("load the workflow", e);
    } finally {
      loadWfBtn.textContent = "Load Workflow";
    }
  });

  copyPromptBtn.addEventListener("click", () => {
    const m = shownMeta();
    if (m) copyPrompt(m.summary);
  });

  copyWfBtn.addEventListener("click", async () => {
    try {
      copyWfBtn.textContent = "Loading…";
      const m = await _fullMetaOfShown();
      if (m) copyWorkflow(m);
    } catch (e) {
      showFailure("copy the workflow", e);
    } finally {
      copyWfBtn.textContent = "Copy Workflow";
    }
  });

  compareBtn.addEventListener("click", cmp.toggle);

  goTo(idx);
  _openTeardown = destroy;
}
