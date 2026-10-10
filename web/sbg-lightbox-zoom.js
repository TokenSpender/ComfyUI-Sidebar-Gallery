import {
  normalizeWheel, wheelZoomFactor, zoomAt, clampPan, panBy, syncPane,
  createWheelModeDetector,
} from "./sbg-zoom-utils.js";
import { isCompareTag } from "./sbg-compare-utils.js";

const _IDENT = () => ({ scale: 1, tx: 0, ty: 0 });

const _IS_FIREFOX = /firefox/i.test(navigator.userAgent);

// The height of a video's own control strip. Narrow controls wrap onto a second
// row, and the wrap follows the layout width, which ignores the zoom transform.
function _controlsBandPx(media) {
  if (_IS_FIREFOX) return 40;
  return (media && media.offsetWidth && media.offsetWidth < 330) ? 66 : 48;
}

const _CHROME_SELECTOR =
  ".sbg-lb__meta-panel, .sbg-lb__bottom, .sbg-lb__nav, .sbg-lb__close, .sbg-compare__divider";

export function createZoomPanController({
  overlay, mediaArea, mediaContainer,
  getCurrentMediaEl, getCompareElements, settings, initialCtrl,
}) {
  const { sensitivity } = settings;
  const detector = createWheelModeDetector("mouse");
  const states = { single: _IDENT(), left: _IDENT(), right: _IDENT() };

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

  function resolvePane(e) {
    if (!(e.target instanceof Element)) return null;
    if (e.target.closest(_CHROME_SELECTOR)) return null;
    if (!mediaArea.contains(e.target)) return null;
    const cmp = getCompareElements();
    if (!cmp) return _paneFor("single");
    let half = e.target.closest(".sbg-compare__half");
    if (!half) {
      const dr = cmp.divider.getBoundingClientRect();
      half = e.clientX < dr.left + dr.width / 2 ? cmp.leftHalf : cmp.rightHalf;
    }
    return _paneFor(half === cmp.leftHalf ? "left" : "right");
  }

  function _paneParts(key) {
    if (key === "single") return { media: getCurrentMediaEl(), host: mediaContainer };
    const cmp = getCompareElements();
    if (!cmp) return null;
    return key === "left"
      ? { media: getCurrentMediaEl(), host: cmp.leftHalf }
      : { media: cmp.rightMedia, host: cmp.rightHalf };
  }

  const _pending = (media) => media.dataset.sbgPending === "1";

  // A DIV here is compare's icon pane, which like audio has nothing to zoom.
  const _zoomable = (media) => !!media && media.tagName !== "AUDIO" && media.tagName !== "DIV"
    && !!media.offsetWidth && !!media.offsetHeight;

  function _paneFor(key) {
    const parts = _paneParts(key);
    if (!parts || !_zoomable(parts.media) || !parts.media.parentNode || _pending(parts.media)) return null;
    return { key, ...parts };
  }

  const _lastMouse = { x: null, y: null };
  function onMouseTrack(e) { _lastMouse.x = e.clientX; _lastMouse.y = e.clientY; _physCtrl = e.ctrlKey === true; }

  function paneAtPoint(x, y) {
    if (x == null || y == null) return null;
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return resolvePane({ target: el, clientX: x });
  }

  // The wheel does not consult this, or the scaled band would be a dead zone
  // for zooming.
  function overVideoControls(e, pane) {
    if (pane.media.tagName !== "VIDEO" || !pane.media.controls) return false;

    const r = pane.media.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right) return false;
    return e.clientY >= r.bottom - _controlsBandPx(pane.media) * states[pane.key].scale
      && e.clientY <= r.bottom;
  }

  const _shields = new Map();

  function _removeShield(key) {
    const s = _shields.get(key);
    if (s) { s.remove(); _shields.delete(key); }
  }

  // A transparent layer over a zoomed video takes the pan drag. It stops short
  // of the control bar so the controls stay usable.
  function _syncVideoShield(pane) {
    const st = states[pane.key];
    const media = pane.media;
    if (media.tagName !== "VIDEO" || st.scale <= 1 || !media.isConnected || _pending(media)) {
      _removeShield(pane.key);
      return;
    }
    let shield = _shields.get(pane.key);
    if (!shield) {
      shield = document.createElement("div");
      shield.className = "sbg-zoom-videoshield";
      _shields.set(pane.key, shield);
    }
    if (shield.parentNode !== mediaArea) mediaArea.appendChild(shield);
    const r = media.getBoundingClientRect();
    const hr = pane.host.getBoundingClientRect();
    const band = media.controls ? _controlsBandPx(media) * st.scale : 0;
    const left = Math.max(r.left, hr.left);
    const right = Math.min(r.right, hr.right);
    const top = Math.max(r.top, hr.top);
    const bottom = Math.min(r.bottom - band, hr.bottom);
    if (right - left < 1 || bottom - top < 1) { shield.classList.add("sbg-hidden"); return; }
    shield.classList.remove("sbg-hidden");
    shield.style.left = left + "px";
    shield.style.top = top + "px";
    shield.style.width = (right - left) + "px";
    shield.style.height = (bottom - top) + "px";
  }

  let _shieldRaf = 0;
  const _shieldPending = new Map();

  // Put off to a frame, since reading geometry in applyState would force a
  // layout flush on every event.
  function _scheduleShieldSync(pane) {
    _shieldPending.set(pane.key, pane);
    if (_shieldRaf) return;
    _shieldRaf = requestAnimationFrame(() => {
      _shieldRaf = 0;
      const panes = [..._shieldPending.values()];
      _shieldPending.clear();
      for (const p of panes) _syncVideoShield(p);
    });
  }

  function applyState(pane, st) {
    states[pane.key] = st;
    pane.media.style.transform = st.scale === 1
      ? "" : `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
    pane.host.classList.toggle("sbg-zoom--pannable", st.scale > 1);
    _scheduleShieldSync(pane);
  }

  function mirrorIfSynced(pane, st) {
    if (pane.key === "single" || settings.compareZoom !== "synced") return;
    // The next event mirrors the whole state again, so skipping a pane still
    // loading loses nothing.
    const other = _paneFor(pane.key === "left" ? "right" : "left");
    if (!other) return;
    const mapped = syncPane(st, pane.media.offsetWidth, pane.media.offsetHeight,
      other.media.offsetWidth, other.media.offsetHeight);
    const hr = other.host.getBoundingClientRect();
    applyState(other, clampPan(mapped, other.media.offsetWidth, other.media.offsetHeight,
      hr.width, hr.height));
  }

  // A touchpad pinch arrives as a wheel event with ctrlKey set while no key is
  // held, so the real key is tracked here.
  let _physCtrl = initialCtrl === true;
  function onModKey(e) { _physCtrl = e.ctrlKey === true; }
  function onWinBlur() { _physCtrl = false; }

  function onWheel(e) {
    // Over the stage a Ctrl wheel is taken even with nothing to zoom yet, since
    // page zoom would resize all of ComfyUI. Elsewhere the browser keeps it.
    const onStage = e.target instanceof Element
      && !e.target.closest(_CHROME_SELECTOR) && mediaArea.contains(e.target);
    if (e.ctrlKey && onStage) {
      e.preventDefault();
      if (!_physCtrl && settings.scrollMode === "auto") detector.force("touchpad", e.timeStamp);
    }
    const pane = resolvePane(e);
    if (!pane) return;
    e.preventDefault();

    const { dx, dy } = normalizeWheel(e.deltaX, e.deltaY, e.deltaMode);
    let zoom;
    if (e.ctrlKey) {
      zoom = true;
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
      if (st.scale <= 1) return;
      const st2 = panBy(st, -dx, -dy,
        pane.media.offsetWidth, pane.media.offsetHeight, hr.width, hr.height);
      applyState(pane, st2);
      mirrorIfSynced(pane, st2);
    }
  }

  let _drag = null;
  let _suppressClick = false;

  // resolvePane accepts a press anywhere in the media area, so the video branch
  // needs this narrower check.
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
    // A resize or a fullscreen toggle aborts the drag, so geometry read once
    // here holds for the whole drag.
    const _hr = pane.host.getBoundingClientRect();
    const _geo = { mw: pane.media.offsetWidth, mh: pane.media.offsetHeight, hostW: _hr.width, hostH: _hr.height };
    if (pane.media.tagName === "VIDEO" && overMediaBody(e, pane)) {
      // The press is kept from the video's own click-to-play, which onPointerUp
      // stands in for.
      e.preventDefault();
      e.stopPropagation();
      try { mediaArea.setPointerCapture(e.pointerId); } catch { }
      _drag = { pane, geo: _geo, id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, video: true };
      return;
    }

    _drag = { pane, geo: _geo, id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
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
    const g = _drag.geo;
    const st2 = panBy(states[pane.key], e.clientX - _drag.lastX, e.clientY - _drag.lastY,
      g.mw, g.mh, g.hostW, g.hostH);
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
      // The release would otherwise count as a click that closes the lightbox.
      _suppressClick = true;
      try { mediaArea.releasePointerCapture(e.pointerId); } catch { }
      mediaArea.classList.remove("sbg-zoom--panning");
      return;
    }
    if (d.video) {
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

  function onClickCapture(e) {
    if (!_suppressClick) return;
    _suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  // A zoomed image would otherwise start the browser's own image drag.
  function onDragStart(e) {
    const pane = resolvePane(e);
    if (pane && states[pane.key].scale > 1) e.preventDefault();
  }

  function _abortDrag(paneKey) {
    if (!_drag || (paneKey && _drag.pane.key !== paneKey)) return;
    if (_drag.moved) {
      // The button is still down, and its release must not close the lightbox.
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

  function resetPane(key) {
    states[key] = _IDENT();
    _abortDrag(key);
    _removeShield(key);
    const parts = _paneParts(key);
    if (parts) {
      if (parts.media) parts.media.style.transform = "";
      parts.host.classList.remove("sbg-zoom--pannable");
    }
    _hideIndicator();
  }

  function resetAll() {
    for (const k of Object.keys(states)) { states[k] = _IDENT(); _removeShield(k); }
    const cmp = getCompareElements();
    const hosts = cmp ? [mediaContainer, cmp.leftFig, cmp.leftHalf, cmp.rightHalf] : [mediaContainer];
    for (const host of hosts) {
      host.classList.remove("sbg-zoom--pannable");
      for (const child of host.children) {
        if (!isCompareTag(child) && child.style.transform) child.style.transform = "";
      }
    }
    if (cmp) cmp.rightMedia.style.transform = "";
    const cur = getCurrentMediaEl();
    if (cur) cur.style.transform = "";
    _abortDrag();
    _hideIndicator();
  }

  function navigated(side) {
    const whole = side === "single" || settings.compareZoom === "synced";
    if (settings.keepOnNav) { _abortDrag(whole ? null : side); return; }
    if (whole) resetAll(); else resetPane(side);
  }

  function reapply(key) {
    if (!settings.keepOnNav) return;
    const parts = _paneParts(key);
    if (!parts) return;
    const { media, host } = parts;

    if (!_zoomable(media)) {
      _removeShield(key);
      host.classList.remove("sbg-zoom--pannable");
      return;
    }
    if (_pending(media)) return;
    const st = states[key];
    if (st.scale <= 1) { applyState({ key, media, host }, _IDENT()); return; }
    const hr = host.getBoundingClientRect();
    applyState({ key, media, host },
      clampPan(st, media.offsetWidth, media.offsetHeight, hr.width, hr.height));
  }

  function keyZoom(dir) {
    let pane = paneAtPoint(_lastMouse.x, _lastMouse.y);
    if (!pane) pane = _paneFor(getCompareElements() ? "left" : "single");
    if (!pane) return;
    const st = states[pane.key];
    const hr = pane.host.getBoundingClientRect();
    const useCursor = settings.anchor !== "center"
      && _lastMouse.x != null
      && _lastMouse.x >= hr.left && _lastMouse.x <= hr.right
      && _lastMouse.y >= hr.top && _lastMouse.y <= hr.bottom;
    const ax = useCursor ? _lastMouse.x - (hr.left + hr.width / 2) : 0;
    const ay = useCursor ? _lastMouse.y - (hr.top + hr.height / 2) : 0;
    // A key step zooms as far as one mouse wheel notch, so the one sensitivity
    // setting governs both.
    const st2 = clampPan(
      zoomAt(st, wheelZoomFactor(dir > 0 ? -100 : 100, sensitivity), ax, ay),
      pane.media.offsetWidth, pane.media.offsetHeight, hr.width, hr.height);
    applyState(pane, st2);
    mirrorIfSynced(pane, st2);
    showIndicator(st2.scale);
  }

  function resetSmart(x, y) {
    const cmp = getCompareElements();
    if (!cmp) { resetPane("single"); return; }
    if (settings.compareZoom === "synced") { resetAll(); return; }
    const pane = paneAtPoint(x ?? _lastMouse.x, y ?? _lastMouse.y);
    if (pane) { resetPane(pane.key); return; }
    if (states.left.scale > 1) { resetPane("left"); return; }
    if (states.right.scale > 1) resetPane("right");
  }

  function onGeometryChange() { resetAll(); }

  overlay.addEventListener("wheel", onWheel, { capture: true, passive: false });
  overlay.addEventListener("mousemove", onMouseTrack, { passive: true });

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
    if (_shieldRaf) { cancelAnimationFrame(_shieldRaf); _shieldRaf = 0; }
    _shieldPending.clear();
    for (const k of [..._shields.keys()]) _removeShield(k);
    indicator.remove();
  }

  return { resetAll, reapply, keyZoom, resetSmart, destroy, navigated };
}
