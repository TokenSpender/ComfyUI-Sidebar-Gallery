/**
 * sbg-zoom-utils.js: pure math for lightbox zoom and pan.
 *
 * No imports and no DOM access, so the wheel normalization, zoom/pan
 * geometry, and mouse-vs-touchpad heuristics are unit-testable in
 * isolation.
 *
 * Coordinate model: the media element is flex-centered in its clip host,
 * so its untransformed center C0 equals the host rect center. A pan/zoom
 * state {scale, tx, ty} renders via `translate(tx, ty) scale(scale)`
 * (translate in screen px, scaling about the element center), placing a
 * content point u (offset from element center, fitted px) at
 * P = C0 + t + scale*u.
 */

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const ZOOM_K = 0.0022; // zoom exponent per normalized px of wheel delta
export const ZOOM_MAX_STEP = 1.5; // per-event zoom factor cap
export const LINE_PX = 33; // px per deltaMode LINE unit (3 Firefox lines ~ one 100px Chrome notch)
export const PAGE_PX = 400; // px per deltaMode PAGE unit

const _clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Convert a wheel event's deltas to pixels regardless of deltaMode
 *  (0=pixel, 1=line, 2=page). */
export function normalizeWheel(deltaX, deltaY, deltaMode) {
  const mul = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1;
  return { dx: deltaX * mul, dy: deltaY * mul };
}

/** Multiplicative zoom factor for a normalized vertical wheel delta.
 *  Exponential so mouse notches (±100px) and touchpad streams (±1..20px)
 *  both feel proportional; capped so a delta spike can't teleport the view.
 *  Negative dy (scroll up / pinch out) zooms IN. */
export function wheelZoomFactor(normDy, sensitivity = 1, k = ZOOM_K, maxStep = ZOOM_MAX_STEP) {
  return _clamp(Math.exp(-normDy * k * sensitivity), 1 / maxStep, maxStep);
}

/** Apply a zoom factor about an anchor point, preserving the content point
 *  under the anchor. (ax, ay) is the anchor offset from the host center C0
 *  in screen px; (0,0) zooms about the view center. Returns a new state.
 *  Derivation: the content point under the anchor is u = (a - t)/s;
 *  requiring a = t2 + s2*u gives t2 = a*(1 - r) + t*r with r = s2/s. */
export function zoomAt(state, factor, ax, ay, min = ZOOM_MIN, max = ZOOM_MAX) {
  const s2 = _clamp(state.scale * factor, min, max);
  if (s2 === min) return { scale: min, tx: 0, ty: 0 }; // back to fit: re-center
  const r = s2 / state.scale;
  return {
    scale: s2,
    tx: ax * (1 - r) + state.tx * r,
    ty: ay * (1 - r) + state.ty * r,
  };
}

/** Clamp the pan so the scaled media can't be dragged off-screen: each edge
 *  may reach, but not pass, the view edge. Axes where the scaled media is
 *  smaller than the view stay centered. Returns a new state. */
export function clampPan(state, contentW, contentH, viewW, viewH) {
  const maxX = Math.max(0, (state.scale * contentW - viewW) / 2);
  const maxY = Math.max(0, (state.scale * contentH - viewH) / 2);
  return {
    scale: state.scale,
    tx: _clamp(state.tx, -maxX, maxX),
    ty: _clamp(state.ty, -maxY, maxY),
  };
}

/** Pan by a screen-px delta, clamped to the view. Returns a new state. */
export function panBy(state, dx, dy, contentW, contentH, viewW, viewH) {
  return clampPan(
    { scale: state.scale, tx: state.tx + dx, ty: state.ty + dy },
    contentW, contentH, viewW, viewH,
  );
}

/** Map a pane's state onto another pane in synced compare mode: same scale,
 *  proportional pan so both show the same relative region even when the
 *  fitted sizes differ. Caller clamps against the destination view. */
export function syncPane(srcState, srcW, srcH, dstW, dstH) {
  return {
    scale: srcState.scale,
    tx: srcW ? srcState.tx * (dstW / srcW) : 0,
    ty: srcH ? srcState.ty * (dstH / srcH) : 0,
  };
}

/** Classify a single wheel event: "mouse", "touchpad", or "ambiguous".
 *  LINE/PAGE deltas and full ~100px notches only come from real wheels;
 *  a horizontal component or fractional deltaY only from touchpads. Small
 *  integer vertical deltas are emitted by BOTH precision touchpads and
 *  smooth-scrolling mice, so they count as "ambiguous": treating them as
 *  touchpad evidence would disable wheel zoom for smooth-scroll mice.
 *  Callers should treat ctrlKey events (pinch) as zoom before consulting
 *  this. */
export function classifyWheel({ deltaX, deltaY, deltaMode }) {
  if (deltaMode !== 0) return "mouse";
  if (deltaX !== 0) return "touchpad";
  if (!Number.isInteger(deltaY)) return "touchpad";
  if (Math.abs(deltaY) >= 100) return "mouse";
  return "ambiguous";
}

/** Events closer together than this belong to the same scroll gesture
 *  (a touchpad swipe with inertia, or a continuous wheel spin). */
export const GESTURE_GAP_MS = 300;

/** Sticky wheel-device detector. The mode is only re-evaluated on the FIRST
 *  event of a gesture (a pause of GESTURE_GAP_MS since the last event):
 *  inertia events mid-swipe can spike past the notch threshold and must
 *  never flip an ongoing pan into a zoom. A flip needs two consecutive
 *  gestures that open with strong contrary evidence; ambiguous openers
 *  (small integer vertical deltas) keep the current mode and reset the
 *  streak, so a device that only ever emits ambiguous events stays in the
 *  initial "mouse" mode and keeps a working zoom. `now` is the event
 *  timestamp in ms (e.timeStamp). */
export function createWheelModeDetector(initial = "mouse", gapMs = GESTURE_GAP_MS) {
  let mode = initial;
  let streak = 0;
  let lastT = -Infinity;
  return {
    update(sample, now) {
      const gestureStart = !(now - lastT <= gapMs);
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
    // Categorical evidence that bypasses the streak: e.g. a pinch (a
    // ctrlKey wheel while the physical Ctrl key is up) can only come from
    // a touchpad. Marks the moment as in-gesture so the next few events
    // stay locked to the forced mode.
    force(newMode, now) {
      mode = newMode;
      streak = 0;
      lastT = now;
      return mode;
    },
  };
}
