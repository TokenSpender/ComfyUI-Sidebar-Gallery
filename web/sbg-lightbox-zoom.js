/**
 * sbg-lightbox-zoom.js: zoom + pan controller for the lightbox media view.
 *
 * DOM glue around the pure math in sbg-zoom-utils.js. One controller per
 * lightbox instance; it owns a wheel listener on the overlay (capture,
 * non-passive, so pinch can never zoom the ComfyUI page while the lightbox
 * is open) and pointer-drag listeners on the media area.
 *
 * Gestures: mouse wheel zooms; touchpad pinch (ctrlKey wheel) always zooms;
 * touchpad two-finger scroll pans when zoomed (mouse vs touchpad resolved by
 * the sticky heuristic unless the Scroll Input setting forces one); mouse
 * drag pans. Zoom state lives per pane ("single", or "left"/"right" in
 * compare mode) and is reset by the lightbox on every navigation. When the
 * "Keep Zoom While Browsing" setting is on, the lightbox instead calls
 * reapply() to carry the pane's state onto the swapped-in media.
 *
 * The lightbox routes its zoom keybindings here: keyZoom() steps the zoom by
 * one wheel notch and resetSmart() returns a pane to fit, both aimed at the
 * pane under the cursor.
 */

import {
  normalizeWheel, wheelZoomFactor, zoomAt, clampPan, panBy, syncPane,
  createWheelModeDetector,
} from "./sbg-zoom-utils.js";

const _IDENT = () => ({ scale: 1, tx: 0, ty: 0 });

// Visual height of a <video>'s native controls strip, used to keep pan drags
// off the seek/volume controls. Chrome's bar is ~48px (two-row ~66px at
// narrow widths), Firefox's ~40px; use the tall end so the seek bar's
// extended hit area is always covered. The strip renders as part of the
// element, so on a transformed video its on-screen height scales with the
// zoom. Wheel events are deliberately NOT guarded by this band: wheel has no
// native behavior over the controls, and a scaled band would otherwise turn
// into a large dead zone where zoom silently stops working.
const VIDEO_CONTROLS_PX = 64;

// Wheel/drag interactions on these bail out entirely: lightbox chrome, and
// the meta panel (which must keep its normal scrolling).
const _CHROME_SELECTOR =
  ".sbg-lb__meta-panel, .sbg-lb__bottom, .sbg-lb__nav, .sbg-lb__close, .sbg-compare__divider";

export function createZoomPanController({
  overlay, mediaArea, mediaContainer,
  getCurrentMediaEl, getCompareElements, settings, initialCtrl,
}) {
  // Only garbage (NaN) falls back to 1; an explicit 0 clamps to the 0.1
  // minimum instead of silently becoming full speed.
  const _rawSens = Number(settings.sensitivity);
  const sensitivity = Number.isFinite(_rawSens) ? Math.min(5, Math.max(0.1, _rawSens)) : 1;
  const detector = createWheelModeDetector("mouse");
  const states = { single: _IDENT(), left: _IDENT(), right: _IDENT() };

  /* Indicator chip */

  const indicator = document.createElement("div");
  indicator.className = "sbg-lb__zoom-indicator";
  mediaArea.appendChild(indicator);
  let _indicatorTimer = null;

  function showIndicator(scale) {
    indicator.textContent = Math.round(scale * 100) + "%";
    indicator.classList.add("sbg-lb__zoom-indicator--visible");
    clearTimeout(_indicatorTimer);
    _indicatorTimer = setTimeout(
      () => indicator.classList.remove("sbg-lb__zoom-indicator--visible"), 900);
  }

  /* Pane resolution */

  // Map an event to the pane it targets: { key, media, host } or null.
  // host is the clip viewport the media is centered in (mediaContainer in
  // single mode, the compare half in compare mode); its rect center is the
  // transform origin C0 and its size is the pan-clamp viewport.
  function resolvePane(e) {
    if (!(e.target instanceof Element)) return null;
    if (e.target.closest(_CHROME_SELECTOR)) return null;
    if (!mediaArea.contains(e.target)) return null;
    const cmp = getCompareElements();
    if (!cmp) return _paneFor("single");
    let half = e.target.closest(".sbg-compare__half");
    if (!half) {
      // Padding/gap between the halves: attribute the event by side.
      const dr = cmp.divider.getBoundingClientRect();
      half = e.clientX < dr.left + dr.width / 2 ? cmp.leftHalf : cmp.rightHalf;
    }
    return _paneFor(half === cmp.leftHalf ? "left" : "right");
  }

  // Direct pane lookup by key, with the media validity checks every caller
  // needs (attached, sized, and past the pending swap-in stage).
  function _paneFor(key) {
    const cmp = getCompareElements();
    let media, host;
    if (key === "single") { media = getCurrentMediaEl(); host = mediaContainer; }
    else if (!cmp) return null;
    else if (key === "left") { media = getCurrentMediaEl(); host = cmp.leftHalf; }
    else { media = cmp.rightMedia; host = cmp.rightHalf; }
    if (!media || !media.parentNode || (media.dataset && media.dataset.sbgPending === "1")) return null;
    if (!media.offsetWidth || !media.offsetHeight) return null;
    return { key, media, host };
  }

  // Last observed pointer position inside the lightbox, for keyboard driven
  // zoom and reset (both aim at the pane under the cursor). Tracked on the
  // overlay so positions over the meta panel are seen too and resolve to
  // "no pane" through resolvePane's chrome check.
  const _lastMouse = { x: null, y: null };
  function onMouseTrack(e) { _lastMouse.x = e.clientX; _lastMouse.y = e.clientY; _physCtrl = e.ctrlKey === true; }

  // Pane at an absolute screen point, resolved through the live DOM.
  function paneAtPoint(x, y) {
    if (x == null || y == null) return null;
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return resolvePane({ target: el, clientX: x });
  }

  // True when the event sits on a <video>'s native controls strip (bottom
  // band of the element, scaled with the zoom): pan drags must leave it
  // alone so seek and volume scrubbing keep working.
  function overVideoControls(e, pane) {
    if (pane.media.tagName !== "VIDEO" || !pane.media.controls) return false;
    const r = pane.media.getBoundingClientRect(); // transformed rect
    if (e.clientX < r.left || e.clientX > r.right) return false;
    return e.clientY >= r.bottom - VIDEO_CONTROLS_PX * states[pane.key].scale
      && e.clientY <= r.bottom;
  }

  /* Video body shield
   * Real input that hit-tests onto a <video>'s built-in controls never
   * reaches page listeners in Firefox, capture phase included: the widget
   * consumes the whole pointer stream inside its shadow tree (the auxclick
   * keybind workaround observed the same). No listener arrangement can see a
   * pan drag that starts there, so while a video pane is zoomed a transparent
   * page element covers the video body and receives the stream instead. The
   * scaled controls band stays uncovered, so native seek and volume keep
   * working while zoomed; at fit-to-screen the shield is gone and clicks
   * reach the native controls exactly as before. */
  const _shields = new Map(); // pane key, one shield element each

  function _removeShield(key) {
    const s = _shields.get(key);
    if (s) { s.remove(); _shields.delete(key); }
  }

  function _syncVideoShield(pane) {
    const st = states[pane.key];
    const media = pane.media;
    if (!media || media.tagName !== "VIDEO" || st.scale <= 1 || !media.isConnected
      || (media.dataset && media.dataset.sbgPending === "1")) {
      _removeShield(pane.key);
      return;
    }
    let shield = _shields.get(pane.key);
    if (!shield) {
      shield = document.createElement("div");
      shield.className = "sbg-zoom-videoshield";
      shield.style.position = "fixed";
      shield.style.zIndex = "1";
      shield.style.cursor = "grab";
      _shields.set(pane.key, shield);
    }
    if (shield.parentNode !== mediaArea) mediaArea.appendChild(shield);
    const r = media.getBoundingClientRect(); // transformed rect
    const hr = pane.host.getBoundingClientRect();
    const band = media.controls ? VIDEO_CONTROLS_PX * st.scale : 0;
    const left = Math.max(r.left, hr.left);
    const right = Math.min(r.right, hr.right);
    const top = Math.max(r.top, hr.top);
    const bottom = Math.min(r.bottom - band, hr.bottom);
    if (right - left < 1 || bottom - top < 1) { shield.style.display = "none"; return; }
    shield.style.display = "";
    shield.style.left = left + "px";
    shield.style.top = top + "px";
    shield.style.width = (right - left) + "px";
    shield.style.height = (bottom - top) + "px";
  }

  /* State application */

  function applyState(pane, st) {
    states[pane.key] = st;
    pane.media.style.transform = st.scale === 1
      ? "" : `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
    pane.host.classList.toggle("sbg-zoom--pannable", st.scale > 1);
    _syncVideoShield(pane);
  }

  // In synced compare mode, mirror a pane's state onto the other side:
  // same scale, proportional pan (both show the same relative region even
  // when the fitted sizes differ).
  function mirrorIfSynced(pane, st) {
    if (pane.key === "single" || settings.compareZoom !== "synced") return;
    const cmp = getCompareElements();
    if (!cmp) return;
    const other = pane.key === "left"
      ? { key: "right", media: cmp.rightMedia, host: cmp.rightHalf }
      : { key: "left", media: getCurrentMediaEl(), host: cmp.leftHalf };
    // Skip pending (mid-load) media just like resolvePane does: its layout
    // size is provisional, and _swapIn doesn't clear transforms, so a mirror
    // written now would survive onto the revealed element mis-mapped. The
    // next zoom/pan event mirrors absolute state and re-syncs the panes.
    if (!other.media || !other.media.parentNode || !other.media.offsetWidth
      || (other.media.dataset && other.media.dataset.sbgPending === "1")) return;
    const mapped = syncPane(st, pane.media.offsetWidth, pane.media.offsetHeight,
      other.media.offsetWidth, other.media.offsetHeight);
    const hr = other.host.getBoundingClientRect();
    applyState(other, clampPan(mapped, other.media.offsetWidth, other.media.offsetHeight,
      hr.width, hr.height));
  }

  /* Wheel: zoom or touchpad-pan */

  // Browsers report a touchpad pinch as a ctrlKey wheel event. Track the
  // PHYSICAL Ctrl key so a "ctrl+wheel" arriving while Ctrl is up can be
  // recognized as a pinch, categorical touchpad evidence the detector
  // learns from instantly (vertical two-finger swipes are ambiguous, so
  // without this a touchpad that pinches first would stay in mouse mode
  // and zoom on its first pan swipe). Seeded from the event that opened
  // the lightbox: a Ctrl already held then pressed down before these key
  // listeners existed, so without the seed a real Ctrl+wheel would read
  // as a pinch. Mouse moves also refresh the flag, since they carry the
  // live modifier state and cover a Ctrl press made while another window
  // had focus.
  let _physCtrl = initialCtrl === true;
  function onModKey(e) { _physCtrl = e.ctrlKey === true; }
  function onWinBlur() { _physCtrl = false; }

  function onWheel(e) {
    // Pinch (ctrl+wheel) must never zoom the ComfyUI page while the lightbox
    // is open, so swallow it even over the meta panel and chrome.
    if (e.ctrlKey) {
      e.preventDefault();
      // Ctrl flag without the physical key: a pinch, so a touchpad.
      if (!_physCtrl && settings.scrollMode === "auto") detector.force("touchpad", e.timeStamp);
    }
    const pane = resolvePane(e);
    if (!pane) return; // meta panel et al. keep their normal scroll
    e.preventDefault();

    const { dx, dy } = normalizeWheel(e.deltaX, e.deltaY, e.deltaMode);
    let zoom;
    if (e.ctrlKey) {
      zoom = true; // a pinch always zooms and bypasses the detector's streak
    } else {
      const mode = settings.scrollMode === "auto"
        ? detector.update(e, e.timeStamp) : settings.scrollMode;
      zoom = mode !== "touchpad";
    }

    const st = states[pane.key];
    const hr = pane.host.getBoundingClientRect();
    if (zoom) {
      const cursorAnchor = settings.anchor !== "center";
      const ax = cursorAnchor ? e.clientX - (hr.left + hr.width / 2) : 0;
      const ay = cursorAnchor ? e.clientY - (hr.top + hr.height / 2) : 0;
      const st2 = clampPan(
        zoomAt(st, wheelZoomFactor(dy, sensitivity), ax, ay),
        pane.media.offsetWidth, pane.media.offsetHeight, hr.width, hr.height);
      applyState(pane, st2);
      mirrorIfSynced(pane, st2);
      showIndicator(st2.scale);
    } else {
      if (st.scale <= 1) return; // two-finger scroll at fit: nothing to pan
      const st2 = panBy(st, -dx, -dy,
        pane.media.offsetWidth, pane.media.offsetHeight, hr.width, hr.height);
      applyState(pane, st2);
      mirrorIfSynced(pane, st2);
    }
  }

  /* Pointer drag: pan */

  let _drag = null; // { pane, id, startX, startY, lastX, lastY, moved, video }
  let _suppressClick = false;

  // True when the event point sits inside the media's transformed rectangle.
  // resolvePane deliberately maps any press in the media area to a pane (wheel
  // zoom works from the empty background too), so branches that must act only
  // on the media itself need this narrower test.
  function overMediaBody(e, pane) {
    const r = pane.media.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  function onPointerDown(e) {
    _suppressClick = false;
    if (e.button !== 0) return;
    const pane = resolvePane(e);
    if (!pane || states[pane.key].scale <= 1) return;
    if (overVideoControls(e, pane)) return;
    if (pane.media.tagName === "VIDEO" && overMediaBody(e, pane)) {
      // Firefox's built-in controls swallow the pointer stream over the video
      // body inside the video's shadow tree (the keybind code documents the
      // same behaviour), so this handler is registered in the CAPTURE phase:
      // it runs on the way down, before the widget can stop anything.
      // stopPropagation keeps the press out of the widget entirely (no native
      // click-to-play, no widget tracking), preventDefault suppresses the
      // compatibility mouse events, and capturing retargets the rest of the
      // stream to the media area. A stationary press re-issues play/pause in
      // onPointerUp. The controls band bailed out above, so seek and volume
      // scrubbing keep working while zoomed, and a press on the empty
      // background falls through so its click still closes the lightbox.
      e.preventDefault();
      e.stopPropagation();
      try { mediaArea.setPointerCapture(e.pointerId); } catch { }
      _drag = { pane, id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, video: true };
      return;
    }
    // No preventDefault and no capture yet for images and background presses:
    // a plain click must stay untouched until the drag threshold is crossed.
    _drag = { pane, id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
  }

  function onPointerMove(e) {
    if (!_drag || e.pointerId !== _drag.id) return;
    if (!_drag.moved) {
      if (Math.hypot(e.clientX - _drag.startX, e.clientY - _drag.startY) < 4) return;
      _drag.moved = true;
      try { mediaArea.setPointerCapture(e.pointerId); } catch { }
      mediaArea.classList.add("sbg-zoom--panning");
    }
    const pane = _drag.pane;
    const hr = pane.host.getBoundingClientRect();
    const st2 = panBy(states[pane.key], e.clientX - _drag.lastX, e.clientY - _drag.lastY,
      pane.media.offsetWidth, pane.media.offsetHeight, hr.width, hr.height);
    _drag.lastX = e.clientX;
    _drag.lastY = e.clientY;
    applyState(pane, st2);
    mirrorIfSynced(pane, st2);
  }

  function onPointerUp(e) {
    if (!_drag || e.pointerId !== _drag.id) return;
    const d = _drag;
    _drag = null;
    if (d.moved) {
      // The mouseup half of this drag would otherwise register as a click,
      // and over the backdrop that click closes the lightbox.
      _suppressClick = true;
      try { mediaArea.releasePointerCapture(e.pointerId); } catch { }
      mediaArea.classList.remove("sbg-zoom--panning");
      return;
    }
    if (d.video) {
      // Stationary press on a zoomed video body: the capture in onPointerDown
      // kept the browser's own click-to-play out, so toggle playback here.
      // The synthesized click targets the media area, which the backdrop
      // handler reads as background, so it must be swallowed too.
      _suppressClick = true;
      try { mediaArea.releasePointerCapture(e.pointerId); } catch { }
      const v = d.pane.media;
      if (v && v.tagName === "VIDEO") {
        try {
          const p = v.paused ? v.play() : (v.pause(), null);
          if (p && p.catch) p.catch(() => { });
        } catch { }
      }
    }
  }

  // Capture phase: runs before the lightbox's bubble-phase backdrop-close
  // handler. Only swallows the one click synthesized at the end of a drag.
  function onClickCapture(e) {
    if (!_suppressClick) return;
    _suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  // A zoomed <img> would still start the browser's native ghost-image drag,
  // fighting the pan.
  function onDragStart(e) {
    const pane = resolvePane(e);
    if (pane && states[pane.key].scale > 1) e.preventDefault();
  }

  /* Reset / teardown */

  const _isCompareTag = (el) => !!(el.dataset && el.dataset.sbgCompare === "1");

  // Abort an in-progress drag (all drags, or only the given pane's). The
  // mouse button is still down, so the release will synthesize a click.
  // Arm the suppressor, or a pan that got interrupted by a reset would
  // register as a backdrop click and close the lightbox.
  function _abortDrag(paneKey) {
    if (!_drag || (paneKey && _drag.pane.key !== paneKey)) return;
    if (_drag.moved) {
      _suppressClick = true;
      try { mediaArea.releasePointerCapture(_drag.id); } catch { }
      mediaArea.classList.remove("sbg-zoom--panning");
    }
    _drag = null;
  }

  function _hideIndicator() {
    clearTimeout(_indicatorTimer);
    indicator.classList.remove("sbg-lb__zoom-indicator--visible");
  }

  // Reset ONE pane to fit-to-screen, leaving the other compare pane's zoom
  // alone (independent compare mode navigates one side at a time).
  function resetPane(key) {
    states[key] = _IDENT();
    _abortDrag(key);
    _removeShield(key);
    const cmp = getCompareElements();
    const media = key === "right" ? (cmp && cmp.rightMedia) : getCurrentMediaEl();
    if (media) media.style.transform = "";
    const host = key === "single" ? mediaContainer
      : key === "left" ? (cmp && cmp.leftHalf)
        : (cmp && cmp.rightHalf);
    if (host) host.classList.remove("sbg-zoom--pannable");
    _hideIndicator();
  }

  // Back to fit-to-screen everywhere. Called by the lightbox on navigation
  // and around compare open/close, so stale transforms can never survive a
  // media swap or re-parenting.
  function resetAll() {
    for (const k of Object.keys(states)) { states[k] = _IDENT(); _removeShield(k); }
    const cmp = getCompareElements();
    const hosts = cmp ? [mediaContainer, cmp.leftFig, cmp.leftHalf, cmp.rightHalf] : [mediaContainer];
    for (const host of hosts) {
      host.classList.remove("sbg-zoom--pannable");
      for (const child of host.children) {
        if (!_isCompareTag(child) && child.style && child.style.transform) child.style.transform = "";
      }
    }
    if (cmp && cmp.rightMedia) cmp.rightMedia.style.transform = "";
    const cur = getCurrentMediaEl();
    if (cur) cur.style.transform = "";
    _abortDrag();
    _hideIndicator();
  }

  // Carry a pane's preserved state onto the CURRENT (possibly brand-new)
  // media element after a navigation swap: same scale, pan re-clamped for
  // the new media's fitted size (a taller/wider image gets its pan pulled
  // back into valid bounds instead of stranding off-screen). Used by the
  // "Keep Zoom While Browsing" setting; no indicator flash, since nothing
  // the user did changed the zoom level.
  function reapply(key) {
    const cmp = getCompareElements();
    const media = key === "right" ? (cmp && cmp.rightMedia) : getCurrentMediaEl();
    const host = key === "single" ? mediaContainer
      : key === "left" ? (cmp && cmp.leftHalf)
        : (cmp && cmp.rightHalf);
    if (!media || !host || !media.offsetWidth || !media.offsetHeight) return;
    if (media.dataset && media.dataset.sbgPending === "1") return;
    const st = states[key];
    if (st.scale <= 1) { applyState({ key, media, host }, _IDENT()); return; }
    const hr = host.getBoundingClientRect();
    applyState({ key, media, host },
      clampPan(st, media.offsetWidth, media.offsetHeight, hr.width, hr.height));
  }

  /* Keybinding entry points */

  // One keyboard zoom step: the same curve as one full mouse wheel notch at
  // the configured sensitivity, so a single knob governs both inputs. dir is
  // 1 to zoom in and -1 to zoom out. Targets the pane under the cursor; with
  // the cursor elsewhere it falls back to the current image (the left half
  // in compare mode). Key repeat makes a held key step continuously.
  function keyZoom(dir) {
    let pane = paneAtPoint(_lastMouse.x, _lastMouse.y);
    if (!pane) pane = _paneFor(getCompareElements() ? "left" : "single");
    if (!pane) return;
    const st = states[pane.key];
    const hr = pane.host.getBoundingClientRect();
    // Anchor at the cursor only when the Zoom Direction setting asks for it
    // AND the cursor actually sits inside this pane's viewport; otherwise
    // zoom about the view center.
    const useCursor = settings.anchor !== "center"
      && _lastMouse.x != null
      && _lastMouse.x >= hr.left && _lastMouse.x <= hr.right
      && _lastMouse.y >= hr.top && _lastMouse.y <= hr.bottom;
    const ax = useCursor ? _lastMouse.x - (hr.left + hr.width / 2) : 0;
    const ay = useCursor ? _lastMouse.y - (hr.top + hr.height / 2) : 0;
    const st2 = clampPan(
      zoomAt(st, wheelZoomFactor(dir > 0 ? -100 : 100, sensitivity), ax, ay),
      pane.media.offsetWidth, pane.media.offsetHeight, hr.width, hr.height);
    applyState(pane, st2);
    mirrorIfSynced(pane, st2);
    showIndicator(st2.scale);
  }

  // Reset zoom with pane selection rules: single mode resets the image;
  // synced compare resets both halves (they mirror one state); independent
  // compare resets the pane under the given point (falling back to the last
  // cursor position), and with neither half under it the leftmost zoomed
  // pane resets first.
  function resetSmart(x, y) {
    const cmp = getCompareElements();
    if (!cmp) { resetPane("single"); return; }
    if (settings.compareZoom === "synced") { resetAll(); return; }
    const pane = paneAtPoint(x ?? _lastMouse.x, y ?? _lastMouse.y);
    if (pane) { resetPane(pane.key); return; }
    if (states.left.scale > 1) { resetPane("left"); return; }
    if (states.right.scale > 1) resetPane("right");
  }

  // Fullscreen toggles and window resizes change both the view rect and the
  // media's fitted size; the state's screen-pixel translate and clamp bounds
  // would be stale, so refit instead of rendering mis-anchored.
  function onGeometryChange() { resetAll(); }

  overlay.addEventListener("wheel", onWheel, { capture: true, passive: false });
  overlay.addEventListener("mousemove", onMouseTrack, { passive: true });
  // Pointer listeners run in the CAPTURE phase: over a <video> Firefox's
  // control widget stops propagation inside the shadow tree, so a bubble
  // listener here never sees the real press and the pan can never start.
  // Capture runs on the way down, before the widget gets the event.
  mediaArea.addEventListener("pointerdown", onPointerDown, true);
  mediaArea.addEventListener("pointermove", onPointerMove, true);
  mediaArea.addEventListener("pointerup", onPointerUp, true);
  mediaArea.addEventListener("pointercancel", onPointerUp, true);
  mediaArea.addEventListener("click", onClickCapture, true);
  mediaArea.addEventListener("dragstart", onDragStart);
  document.addEventListener("fullscreenchange", onGeometryChange);
  window.addEventListener("resize", onGeometryChange);
  document.addEventListener("keydown", onModKey, true);
  document.addEventListener("keyup", onModKey, true);
  window.addEventListener("blur", onWinBlur);

  function destroy() {
    overlay.removeEventListener("wheel", onWheel, { capture: true });
    overlay.removeEventListener("mousemove", onMouseTrack);
    mediaArea.removeEventListener("pointerdown", onPointerDown, true);
    mediaArea.removeEventListener("pointermove", onPointerMove, true);
    mediaArea.removeEventListener("pointerup", onPointerUp, true);
    mediaArea.removeEventListener("pointercancel", onPointerUp, true);
    mediaArea.removeEventListener("click", onClickCapture, true);
    mediaArea.removeEventListener("dragstart", onDragStart);
    document.removeEventListener("fullscreenchange", onGeometryChange);
    window.removeEventListener("resize", onGeometryChange);
    document.removeEventListener("keydown", onModKey, true);
    document.removeEventListener("keyup", onModKey, true);
    window.removeEventListener("blur", onWinBlur);
    clearTimeout(_indicatorTimer);
    for (const k of [..._shields.keys()]) _removeShield(k);
    indicator.remove();
  }

  return { resetAll, resetPane, reapply, keyZoom, resetSmart, destroy };
}
