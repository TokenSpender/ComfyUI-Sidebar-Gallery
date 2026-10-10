// Only the icon set, which imports nothing, so the settings store can use this
// module without an import cycle.
import { CLOSE_ICON } from "./sbg-icons.js";

const MAX_TOASTS = 3;
const _toasts = [];
let _toastHost = null;
let _fullscreenWired = false;

// Only the fullscreen element's subtree is drawn in fullscreen, so the host
// moves into it.
function _hostToasts() {
  if (!_toastHost) {
    _toastHost = document.createElement("div");
    _toastHost.className = "sbg-toasts";
    _toastHost.setAttribute("role", "status");
  }
  const parent = document.fullscreenElement || document.body;
  if (_toastHost.parentNode !== parent) parent.appendChild(_toastHost);
  if (!_fullscreenWired) {
    _fullscreenWired = true;
    document.addEventListener("fullscreenchange", () => { if (_toasts.length) _hostToasts(); });
  }
  return _toastHost;
}

export function toastDuration(msg, { failure = false, min = 0 } = {}) {
  const words = String(msg).trim().split(/\s+/).filter(Boolean).length;
  const byLength = Math.min(12000, Math.max(failure ? 4000 : 2000, 1000 + 300 * words));
  return Math.max(min || 0, byLength);
}

// Every toast and every message row ends a sentence, with a full stop where its
// caller passed no closing mark, so a reason that closes the sentence ends it too.
const _sentence = (text) => {
  const s = String(text).trimEnd();
  return !s || /[.?!…]$/.test(s) ? s : `${s}.`;
};

function _pushToast(text, { failure = false, min = 0 } = {}) {
  const msg = _sentence(text);
  const host = _hostToasts();
  // A repeated action, or one failure reported by several callers, gives the
  // toast already showing its time back instead of stacking a copy.
  const same = _toasts.find((x) => x.failure === failure && x.el.textContent === msg);
  if (same) {
    same.left = toastDuration(msg, { failure, min });
    if (!same.hovered) { clearTimeout(same.timer); same.run(); }
    return same.el;
  }
  while (_toasts.length >= MAX_TOASTS) _dropToast(_toasts[0], true);
  const el = document.createElement("div");
  el.className = "sbg-toast" + (failure ? " sbg-toast--failure" : "");
  el.textContent = msg;
  const t = { el, failure, hovered: false, timer: null, left: toastDuration(msg, { failure, min }), started: 0 };
  t.run = () => { t.started = Date.now(); t.timer = setTimeout(() => _dropToast(t), t.left); };

  el.addEventListener("mouseenter", () => {
    t.hovered = true;
    clearTimeout(t.timer);
    t.left = Math.max(1500, t.left - (Date.now() - t.started));
  });
  el.addEventListener("mouseleave", () => { t.hovered = false; t.run(); });
  host.appendChild(el);
  _toasts.push(t);
  el.classList.add("sbg-toast--visible");
  t.run();
  return el;
}

function _dropToast(t, now = false) {
  const i = _toasts.indexOf(t);
  if (i < 0) return;
  _toasts.splice(i, 1);
  clearTimeout(t.timer);
  t.el.classList.remove("sbg-toast--visible");
  if (now) t.el.remove();
  else setTimeout(() => t.el.remove(), 250);
}

// For an answer to the person's own click. A message with no click behind it
// goes to postNotice instead.
export function showToast(msg, min = 0) {
  return _pushToast(msg, { min });
}

// Names that keep their capital when a reason is lowered to follow the colon.
const _KEEPS_CAPITAL = /^(Windows|Linux|Python|Firefox|Chrome|Safari|ComfyUI|I)\b/;

export function reasonOf(err) {
  let r = err == null ? "" : typeof err === "string" ? err : (err.message || String(err));
  r = String(r).trim().replace(/^Error:\s*/, "");
  if (!r || r === "undefined" || r === "null") return "";
  // Each browser words a failed fetch and an unreadable JSON answer its own way.
  if (/^(TypeError:\s*)?(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network ?error)$/i.test(r)) {
    return "ComfyUI didn't answer";
  }
  if (/JSON\.parse|JSON Parse error|JSON at position|Unexpected token|unexpected character|is not valid JSON|unexpected end of (data|JSON input)/i.test(r)) {
    return "ComfyUI's answer couldn't be read";
  }
  const status = /^HTTP (\d{3})\b/.exec(r);
  if (status) {
    const code = Number(status[1]);
    if (code === 404) return "ComfyUI couldn't find it (HTTP 404)";
    if (code >= 500) return `ComfyUI ran into an error (HTTP ${code})`;
    if (code >= 400) return `ComfyUI refused it (HTTP ${code})`;
    return r;
  }
  if (/^[A-Z][a-z]*\b/.test(r) && !_KEEPS_CAPITAL.test(r)) r = r[0].toLowerCase() + r.slice(1);
  // The caller decides how the sentence ends, so a reason's own full stop goes.
  return r.replace(/\.\s*$/, "");
}

export function failureText(action, reason) {
  const why = reasonOf(reason);
  return why ? `Couldn't ${action}: ${why}` : `Couldn't ${action}`;
}

export function showFailure(action, reason) {
  if (reason && reason.settingsUnread) return showSettingsUnread();
  return _pushToast(failureText(action, reason), { failure: true });
}

// The refusal a change meets while settingsUnread() holds, since saving then
// would write defaults over the saved settings. One toast serves every change,
// in the accent color, since the red notice under the toolbar already says what
// went wrong.
export const SETTINGS_UNREAD_TEXT = "Couldn't save the change: the gallery settings couldn't be read. Refresh the page and try again.";

export function showSettingsUnread() {
  return showToast(SETTINGS_UNREAD_TEXT);
}

// For a refusal thrown from deep in a change, which the caller's own failure
// toast then tells as the one refusal.
export function settingsUnreadError() {
  return Object.assign(new Error(SETTINGS_UNREAD_TEXT), { settingsUnread: true });
}

// The tooltip comes last, since it often opens with a verb that explains the
// action instead of naming it.
function _askFor(btn) {
  const name = (btn.getAttribute("aria-label") || btn.textContent.trim() || btn.title).trim();
  const word = name.split(/\s+/)[0] || "";
  return word ? word[0].toUpperCase() + word.slice(1) + "?" : "Sure?";
}

export function confirmClick(btn, onConfirm, opts = {}) {
  const label = () => (typeof opts.label === "function" ? opts.label() : opts.label) || _askFor(btn);
  let armed = false, timer = null;
  const orig = { content: "", markup: false, armClass: false };
  const disarm = () => {
    if (!armed) return;
    armed = false;
    clearTimeout(timer);
    if (orig.markup) btn.innerHTML = orig.content; else btn.textContent = orig.content;
    btn.classList.remove("sbg-armed");
    if (opts.armClass && !orig.armClass) btn.classList.remove(opts.armClass);
  };
  btn.addEventListener("click", (e) => {
    // A button kept enabled while its own action runs, so it keeps the focus,
    // would otherwise ask again for an action the handler then refuses.
    if (opts.busy && opts.busy()) return;
    if (!armed) {
      armed = true;
      const ask = label();

      orig.markup = btn.children.length > 0;
      orig.content = orig.markup ? btn.innerHTML : btn.textContent;
      orig.armClass = !!(opts.armClass && btn.classList.contains(opts.armClass));
      btn.textContent = ask;
      btn.classList.add("sbg-armed");
      if (opts.armClass) btn.classList.add(opts.armClass);
      timer = setTimeout(disarm, opts.armMs || 2000);
      return;
    }
    // The second click of a double click has a detail of 2, and taking it as the
    // confirm would arm and fire in one gesture before the label can be read.
    if (e && e.detail > 1) return;
    disarm();
    onConfirm(e);
  });
  return disarm;
}

/** `done` is the toast that says what went onto the clipboard. */
export function copyText(text, done) {
  const str = String(text);
  // The clipboard API needs a secure origin, which a gallery reached over plain
  // HTTP on a local network is not, so the fallback is the usual path there.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(str)
      .then(() => showToast(done))
      .catch(() => { if (!_copyFallback(str, done)) showFailure("copy to the clipboard"); });
    return;
  }
  if (!_copyFallback(str, done)) showFailure("copy to the clipboard");
}

function _copyFallback(str, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, str.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) showToast(done);
    return ok;
  } catch {
    return false;
  }
}

// Notices are messages with no click behind them, which a toast would show to
// nobody. Each waits in the notification area and its minute runs only while
// the area is on screen. A sticky notice names a file the person may need and
// stays until closed.
const NOTICE_MS = 60000;
const NOTICE_TICK_MS = 1000;

const _notices = [];
let _noticeHost = null;
let _noticeChanged = null;
let _noticeTicker = null;

// `onShown` runs the first time the notice is drawn, for a notice whose record
// has to outlive a page load where the gallery was never opened. `failure`
// draws it red, for a failure that loses something or stops something working.
export function postNotice(id, text, { onShown, sticky = false, failure = false } = {}) {
  const had = _notices.find(n => n.id === id);
  if (had) {
    if (had.text === text && had.failure === failure) return;
    had.text = text;
    had.failure = failure;
    had.left = NOTICE_MS;
    _drawNotices();
    return;
  }
  _notices.push({ id, text, onShown, sticky, failure, shown: false, left: NOTICE_MS });
  _drawNotices();
}

export function pendingNotices() {
  return _notices.map(n => ({ id: n.id, text: n.text, shown: n.shown, sticky: n.sticky, failure: n.failure, left: n.left }));
}

export function dismissNotice(id) {
  const i = _notices.findIndex(n => n.id === id);
  if (i < 0) return;
  _notices.splice(i, 1);
  _drawNotices();
}

// The panel is rebuilt each time the sidebar tab opens, so the unmount returned
// lets go only of its own strip. `onChange` runs after every draw, so the area
// holding the strip can open or close with it.
export function mountNoticeStrip(el, onChange = null) {
  _noticeHost = el;
  _noticeChanged = onChange;
  _drawNotices();
  return () => { if (_noticeHost === el) { _noticeHost = null; _noticeChanged = null; } };
}

// The lightbox and the settings panel, each of which lies over the notification area.
const _COVERS_NOTICES = ".sbg-lightbox, .sbg-gs-overlay";

function _noticesCovered() {
  return document.visibilityState === "visible" && !!document.querySelector(_COVERS_NOTICES);
}

export function noticesOnScreen() {
  return !!_noticeHost && document.visibilityState === "visible" && !document.querySelector(_COVERS_NOTICES);
}

// A failed save always waits in the notification area. While the lightbox or
// the settings panel covers that area, a change made there would fail unseen,
// so its failure is also a toast when `toast` says it has not had one.
export function postSaveFailure(noticeId, text, toast) {
  if (toast && _noticesCovered()) _pushToast(text, { failure: true });
  postNotice(noticeId, text, { failure: true });
}

function _tickNotices() {
  _noticeTicker = null;
  if (noticesOnScreen()) {
    for (const n of [..._notices]) {
      if (n.sticky || !n.shown) continue;
      n.left -= NOTICE_TICK_MS;
      if (n.left <= 0) { dismissNotice(n.id); return; }
    }
  }
  _scheduleTick();
}

function _scheduleTick() {
  if (_noticeTicker || !_noticeHost || !_notices.some(n => n.shown && !n.sticky)) return;
  _noticeTicker = setTimeout(_tickNotices, NOTICE_TICK_MS);
}

// One notice's row, which the notification area's failure lines and a settings
// tab also draw for a message of their own.
export function noticeRow(message, onDismiss, { failure = false } = {}) {
  const row = document.createElement("div");
  row.className = "sbg-notice" + (failure ? " sbg-notice--failure" : "");
  row.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "sbg-notice__text";
  text.textContent = _sentence(message);
  const x = document.createElement("button");
  x.className = "sbg-btn sbg-btn--icon sbg-notice__x";
  x.innerHTML = CLOSE_ICON;
  x.title = "Dismiss";
  x.setAttribute("aria-label", "Dismiss");
  x.addEventListener("click", onDismiss);
  row.appendChild(text);
  row.appendChild(x);
  return row;
}

function _drawNotices() {
  const host = _noticeHost;
  if (!host) return;
  for (const c of [...host.children]) c.remove();
  for (const n of _notices) host.appendChild(noticeRow(n.text, () => dismissNotice(n.id), { failure: n.failure }));
  host.hidden = !_notices.length;
  if (_noticeChanged) _noticeChanged();
  for (const n of _notices) {
    if (n.shown) continue;
    n.shown = true;
    try { n.onShown?.(); } catch (e) { console.warn("[SBG] A notice's first showing failed:", e); }
  }
  _scheduleTick();
}
