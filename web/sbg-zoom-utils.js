// The media sits centred in its clip host, and a state of scale, tx and ty
// renders as `translate(tx, ty) scale(scale)`, so pans and anchors are offsets
// from the host centre.
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_K = 0.0022;

// One wheel event changes the scale by at most this factor, so a delta spike
// cannot jump the view.
const ZOOM_MAX_STEP = 1.5;

const LINE_PX = 33;
const PAGE_PX = 400;

const _clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalizeWheel(deltaX, deltaY, deltaMode) {
  const mul = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1;
  return { dx: deltaX * mul, dy: deltaY * mul };
}

export function wheelZoomFactor(normDy, sensitivity = 1) {
  return _clamp(Math.exp(-normDy * ZOOM_K * sensitivity), 1 / ZOOM_MAX_STEP, ZOOM_MAX_STEP);
}

// The returned pan keeps the content point under the anchor fixed.
export function zoomAt(state, factor, ax, ay) {
  const s2 = _clamp(state.scale * factor, ZOOM_MIN, ZOOM_MAX);
  if (s2 === ZOOM_MIN) return { scale: ZOOM_MIN, tx: 0, ty: 0 };
  const r = s2 / state.scale;
  return {
    scale: s2,
    tx: ax * (1 - r) + state.tx * r,
    ty: ay * (1 - r) + state.ty * r,
  };
}

export function clampPan(state, contentW, contentH, viewW, viewH) {
  const maxX = Math.max(0, (state.scale * contentW - viewW) / 2);
  const maxY = Math.max(0, (state.scale * contentH - viewH) / 2);
  return {
    scale: state.scale,
    tx: _clamp(state.tx, -maxX, maxX),
    ty: _clamp(state.ty, -maxY, maxY),
  };
}

export function panBy(state, dx, dy, contentW, contentH, viewW, viewH) {
  return clampPan(
    { scale: state.scale, tx: state.tx + dx, ty: state.ty + dy },
    contentW, contentH, viewW, viewH,
  );
}

export function syncPane(srcState, srcW, srcH, dstW, dstH) {
  return {
    scale: srcState.scale,
    tx: srcW ? srcState.tx * (dstW / srcW) : 0,
    ty: srcH ? srcState.ty * (dstH / srcH) : 0,
  };
}

// The caller zooms on any wheel with ctrlKey set without asking this, so
// ctrlKey is not read here.
export function classifyWheel({ deltaX, deltaY, deltaMode }) {
  if (deltaMode !== 0) return "mouse";
  if (deltaX !== 0) return "touchpad";
  if (!Number.isInteger(deltaY)) return "touchpad";
  if (Math.abs(deltaY) >= 100) return "mouse";
  return "ambiguous";
}

const GESTURE_GAP_MS = 300;

export function createWheelModeDetector(initial) {
  let mode = initial;
  let streak = 0;
  let lastT = -Infinity;
  return {
    update(sample, now) {
      // Classified only as a gesture starts, so a swipe under way cannot turn
      // from a pan into a zoom.
      const gestureStart = !(now - lastT <= GESTURE_GAP_MS);
      lastT = now;
      if (gestureStart) {
        const seen = classifyWheel(sample);
        if (seen === "ambiguous" || seen === mode) {
          streak = 0;
        } else if (++streak >= 2) {
          mode = seen;
          streak = 0;
        }
      }
      return mode;
    },

    force(newMode, now) {
      mode = newMode;
      streak = 0;
      // Counts as inside a gesture, so the events that follow keep the forced mode.
      lastT = now;
      return mode;
    },
  };
}
