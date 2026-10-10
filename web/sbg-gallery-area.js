import { h } from "./sbg-core.js";
import { mountNoticeStrip, noticeRow } from "./sbg-toast.js";
import { REFRESH_ICON, CHECK_ICON, sizedIcon } from "./sbg-icons.js";

const MARKS = { running: sizedIcon(REFRESH_ICON, 12), done: sizedIcon(CHECK_ICON, 12) };

// A progress line waits this long before it shows, so work that finishes at
// once never opens the area and closes it again.
const OPEN_DELAY_MS = 300;

// Only these sources show a progress line, and the first with one showing wins.
const PROGRESS_ORDER = ["index", "load", "search"];

// The Count at bottom layout hands over its count, and the area then stays open
// as that row, the count giving way to a progress line's percentage.
export function createNotifyArea({ teardown, countEl = null }) {
  const alwaysOpen = !!countEl;
  const markEl = h("span", { class: "sbg-area__mark", "aria-hidden": "true" });
  const msgEl = h("span");
  const text = h("span", { class: "sbg-area__text" }, [markEl, msgEl]);
  const pctEl = h("span", { class: "sbg-area__pct", hidden: "" });
  const right = h("span", { class: "sbg-area__right" }, countEl ? [countEl, pctEl] : [pctEl]);
  const fill = h("div", { class: "sbg-progress__fill" });
  const bar = h("div", { class: "sbg-progress__bar", hidden: "" }, [fill]);
  const progressLine = h("div", { class: "sbg-area__progress", hidden: alwaysOpen ? undefined : "" },
    [h("div", { class: "sbg-area__row" }, [text, right]), bar]);
  const problemList = h("div", { class: "sbg-notices", hidden: "" });
  const notices = h("div", { class: "sbg-notices", hidden: "" });
  const el = h("div", { class: "sbg-area" + (alwaysOpen ? " sbg-area--open" : "") },
    [progressLine, problemList, notices]);

  const progress = new Map();
  const problems = new Map();
  const timers = new Set();
  teardown.add(() => { for (const t of timers) clearTimeout(t); timers.clear(); });

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  }

  function _shownProgress() {
    for (const key of PROGRESS_ORDER) {
      const p = progress.get(key);
      if (p && p.ready) return p;
    }
    return null;
  }

  function render() {
    const p = _shownProgress();
    const want = p ? p.text : "";
    if (msgEl.textContent !== want) msgEl.textContent = want;
    const mark = (p && MARKS[p.mark]) || "";
    if (markEl.innerHTML !== mark) markEl.innerHTML = mark;
    const title = p ? p.title || "" : "";
    if (text.title !== title) text.title = title;
    const hasPct = !!p && p.pct >= 0;
    pctEl.hidden = !hasPct;
    if (hasPct) pctEl.textContent = `${Math.round(Math.min(100, p.pct))}%`;
    if (countEl) countEl.hidden = hasPct;
    bar.hidden = !p || p.bar === false;
    if (p && p.bar !== false) {
      fill.classList.toggle("sbg-progress__fill--indeterminate", !hasPct);
      fill.style.width = hasPct ? `${Math.min(100, p.pct)}%` : "";
    }
    if (!alwaysOpen) progressLine.hidden = !p;
    problemList.hidden = problems.size === 0;
    const open = alwaysOpen || !!p || problems.size > 0 || !notices.hidden;
    el.classList.toggle("sbg-area--open", open);
  }

  function _drawProblems() {
    problemList.innerHTML = "";
    for (const [key, { msg, tint }] of problems) {
      problemList.appendChild(noticeRow(msg, () => { problems.get(key)?.onDismiss?.(); clearProblem(key); }, { failure: !tint }));
    }
  }

  function setProgress(key, msg, pct = -1, { title = "", bar: withBar = true, now = false, mark = "" } = {}) {
    const prev = progress.get(key);
    const ready = now || (prev ? prev.ready : false);
    progress.set(key, { text: msg, pct, title, bar: withBar, ready, mark });
    if (ready) { render(); return; }
    if (prev) return;
    later(() => {
      const cur = progress.get(key);
      if (!cur) return;
      cur.ready = true;
      render();
    }, OPEN_DELAY_MS);
  }

  function clearProgress(key) {
    if (!progress.delete(key)) return;
    render();
  }

  function setProblem(key, msg, onDismiss, tint) {
    // A failure repeated in the same words keeps its row, so a retry neither
    // moves the focus off a cross nor has the row read out again.
    const had = problems.get(key);
    if (had && had.msg === msg && had.tint === tint) { had.onDismiss = onDismiss; return; }
    problems.set(key, { msg, onDismiss, tint });
    _drawProblems();
    render();
  }

  function clearProblem(key) {
    if (!problems.delete(key)) return;
    _drawProblems();
    render();
  }

  function source(key) {
    return {
      progress: (msg, pct = -1, opts) => setProgress(key, msg, pct, opts),
      stop: () => clearProgress(key),
      ok: () => clearProblem(key),
      // `onDismiss` runs when the person closes the line, for a failure kept
      // beyond this panel. A `tint` line is one the gallery works around or
      // tries again by itself, drawn in the notice tint instead of red.
      fail: (msg, onDismiss, { tint = false } = {}) => { clearProgress(key); setProblem(key, msg, onDismiss, tint); },
    };
  }

  teardown.add(mountNoticeStrip(notices, render));
  render();

  return { el, source };
}
