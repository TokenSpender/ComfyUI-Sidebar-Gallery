import { failureText, noticesOnScreen } from "./sbg-toast.js";
import { api } from "./sbg-core.js";

// A message is the server's progress state, {running, full, roots, process},
// where full and each entry under roots is {running, kind, root_id, total,
// done, phase, error, run}. A push and a catch-up read carry the same shape.
const _subs = new Set();
let _settleTimer = null;
let _last = null;
let _priming = false;

// The server drops an ordinary push that follows another too closely, and a
// run's start is an ordinary push while a finish is always sent. So a run that
// starts right after another ends is not seen until its next message, and a
// finish is told only once this long has passed with nothing running.
const _SETTLE_AFTER_MS = 1200;

function _fanOut(data, meta) {
  for (const cb of [..._subs]) {
    try { cb(data, meta); } catch { /* one bad consumer must not stop the rest */ }
  }
}

let _seq = 0;

function _anyRunning(data) {
  return !!(data && (data.running
    || (data.full && data.full.running)
    || Object.values(data.roots || {}).some(e => e && e.running)));
}

function _armSettle() {
  if (_settleTimer) clearTimeout(_settleTimer);
  _settleTimer = setTimeout(() => {
    _settleTimer = null;
    _fanOut(_last, { anyRunning: false, settled: true });
  }, _SETTLE_AFTER_MS);
}

// A catch-up read that failed or was dropped still owes the finish that
// subscribing cancelled.
function _resumeSettle() {
  if (!_settleTimer && _last && !_anyRunning(_last)) _armSettle();
}

function _onProgress(data) {
  _seq++;
  _last = data;
  const anyRunning = _anyRunning(data);
  if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
  _fanOut(data, { anyRunning, settled: false });
  if (!anyRunning) _armSettle();
}

function _prime() {
  if (_priming) return;
  _priming = true;
  const seq = _seq;
  api("/sidebar_gallery/reindex_progress")
    // A push that landed while the read was in flight is newer than its answer.
    .then((d) => { if (seq === _seq) _onProgress(d); else _resumeSettle(); })
    .catch(() => _resumeSettle())
    .finally(() => { _priming = false; });
}

export const progressFeed = {
  subscribe(cb) {
    _subs.add(cb);

    // A consumer joining during the wait must not be told of a finish it never
    // saw running, so the wait is cancelled and the catch-up read puts it back.
    if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
    _prime();
    return () => { _subs.delete(cb); };
  },

  deliver(data) { _onProgress(data); },

  refresh() { _prime(); },
};

// The server keeps a failed entry until the next run and names each run and its
// process, so a new run failing with the same words is still told. A server
// that names neither is matched by the entry's words alone.
const _toldFailures = new Set();
const _runKey = (progress, entry) => (progress && progress.process && entry && entry.run != null
  ? `${progress.process}:${entry.run}` : JSON.stringify(entry));
export function failureTold(progress, entry) { return _toldFailures.has(_runKey(progress, entry)); }
export function markFailureTold(progress, entry) { _toldFailures.add(_runKey(progress, entry)); }

// A folder's first index can run beside a search index build, and its counts
// are what the person waits on, so it shows ahead of the build's bare line.
export function runningEntry(data) {
  if (!data) return null;
  const full = data.full && data.full.running ? data.full : null;
  const root = Object.values(data.roots || {}).find(e => e && e.running) || null;
  return full && full.kind !== "facts" ? full : root || full;
}

export function progressSlots(data) {
  if (!data) return [];
  const slots = Object.entries(data.roots || {}).filter(([, e]) => e);
  if (data.full) slots.push(["full", data.full]);
  return slots;
}

/** How the run seen in `slot` ended: its entry, or null when the server no
 *  longer holds that run, as after a restart. `seen` is the run and process
 *  the running entry named, and a server that names neither matches by slot. */
export function endedEntry(progress, slot, seen) {
  const e = progress && (slot === "full" ? progress.full : (progress.roots || {})[slot]);
  if (!e || e.running) return null;
  if (seen.run != null && (e.run !== seen.run || progress.process !== seen.process)) return null;
  return e;
}

function _counts(entry) {
  if (entry.phase === "scanning") return { counts: `Scanning folder… ${(entry.total || 0).toLocaleString()} found`, pct: -1 };
  const total = entry.total || 0;
  const done = entry.done || 0;
  return {
    counts: `${done.toLocaleString()} / ${total.toLocaleString()}`,
    pct: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

export function progressKind(progress, entry) {
  // A server still running an older version names no kind and builds no search
  // index, so the slot says which of the other two the entry is.
  return entry.kind || (progress && entry === progress.full ? "full" : "first");
}

// The search index rebuild keeps the scanning phase and a total of zero for its
// whole run, so its counts are never printed or its line would read as a scan
// finding zero.
const _KIND_TEXT = {
  first: {
    counted: true,
    running: (count) => `Indexing · ${count}`,
    done: (count) => `Indexing done, ${count.toLocaleString()} ${count === 1 ? "file" : "files"}`,
    tooltip: "This scan only runs the first time a folder is indexed. After it finishes, the gallery loads instantly.",
  },
  full: {
    counted: true,
    running: (count) => `Rebuilding metadata index… ${count}`,
    done: () => "Metadata index rebuilt",
    tooltip: "The index is being rebuilt. You can still use the gallery while it runs.",
  },
  facts: {
    counted: false,
    running: () => "Rebuilding search index…",
    done: () => "Search index rebuilt",
    tooltip: "The fast search index is being rebuilt. Searching still works during the rebuild.",
  },
};

export function indexRunningText(kind, entry) {
  const texts = _KIND_TEXT[kind];
  if (!texts.counted) return texts.running();
  const { counts } = _counts(entry);
  return entry.phase === "scanning" ? counts : texts.running(counts);
}

/** A percentage, or -1 when the run has no fixed total to measure against. */
export function indexPct(kind, entry) {
  return _KIND_TEXT[kind].counted ? _counts(entry).pct : -1;
}

export function indexDoneText(kind, count) {
  return _KIND_TEXT[kind].done(count);
}

export function indexTooltip(kind) {
  return _KIND_TEXT[kind].tooltip;
}

export function indexFailedText(kind, error, label) {
  if (kind === "full") return failureText("rebuild the metadata index", error);
  if (kind === "facts") return `${failureText("build the search index", error)}. Search still works, but may be slower.`;
  return `${failureText(`index ${label || "the folder"}`, error)}. Some files may be missing.`;
}

// Index runs are followed for the whole page instead of by each panel, so a run
// that ends while the gallery is closed is told when it next opens. Its done
// line waits like a notice, its time running only while the notification area
// is on screen, and a failure stands until it is dismissed or what failed ends
// done. A run that ended done before the page loaded is not told.
const DONE_MS = 8000;
const _DONE_TICK_MS = 1000;
// Every run seen running and not yet ended, by the slot it holds.
const _seen = new Map();
// A folder's first index by its root, a rebuild and a search index build by
// their kind.
const _failed = new Map();
const _subjectOf = (kind, slot) => (kind === "first" ? slot : kind);
// A folder's first index can end while a search index build goes on, so the
// done lines owed wait in turn, the first shown once nothing runs.
let _done = [];
let _doneTimer = null;
let _running = false;
let _endedSinceSettle = false;
let _watching = false;
const _endingSubs = new Set();

function _tellEndings(ended) {
  for (const cb of [..._endingSubs]) {
    try { cb(ended); } catch { /* one bad panel must not stop the rest */ }
  }
}

function _dropDone() {
  clearTimeout(_doneTimer);
  _doneTimer = null;
  _done = [];
}

function _startDoneClock() {
  if (_done.length && !_doneTimer && _endingSubs.size) _doneTimer = setTimeout(_tickDone, _DONE_TICK_MS);
}

// The first done line's time runs only while it is the line on screen, so not
// while a run's line stands in its place. The clock stops while no panel is
// open, and the next panel starts it again.
function _tickDone() {
  _doneTimer = null;
  const head = _done[0];
  if (!head) return;
  if (noticesOnScreen() && !_running && !_endedSinceSettle) head.left -= _DONE_TICK_MS;
  if (head.left <= 0) {
    _done.shift();
    _tellEndings(false);
  }
  _startDoneClock();
}

// Whether what the server holds now shows a failure put right since: its own
// slot, or for a folder a rebuild, which reads every folder, ending done on a
// later run. A run that started and ended between two messages is never seen
// running, and a server restarted since numbers its runs afresh, so any done
// entry of another process counts as later.
function _putRight(progress, f) {
  const later = (e) => !!e && !e.running && e.phase === "done"
    && (progress.process !== f.process || (e.run != null && f.run != null && e.run > f.run));
  const own = f.slot === "full" ? progress.full : (progress.roots || {})[f.slot];
  if (later(own) && progressKind(progress, own) === f.kind) return true;
  return f.kind === "first" && later(progress.full) && progressKind(progress, progress.full) === "full";
}

function _onIndexProgress(progress, meta) {
  _running = meta.anyRunning;
  let changed = false;
  for (const [slot, e] of progressSlots(progress)) {
    if (!e.running) continue;
    const had = _seen.get(slot);
    // A run that starts takes the place of the done lines still owed.
    if ((!had || had.run !== e.run || had.process !== progress.process) && _done.length) {
      _dropDone();
      changed = true;
    }
    _seen.set(slot, { kind: progressKind(progress, e), run: e.run, process: progress.process, count: e.total || e.done || 0 });
  }

  // How each run ended is read from what the server holds now, each as soon as
  // it stops, since another run can go on for minutes. A failure is told
  // whether or not it was seen running, since a run can fail before any
  // message of it arrives.
  for (const [slot, f] of progressSlots(progress)) {
    if (f.running || f.phase !== "error" || failureTold(progress, f)) continue;
    markFailureTold(progress, f);
    const kind = progressKind(progress, f);
    _failed.set(_subjectOf(kind, slot), { kind, slot, error: f.error, run: f.run, process: progress.process });
    changed = true;
  }
  for (const [subject, f] of _failed) {
    if (_putRight(progress, f)) { _failed.delete(subject); changed = true; }
  }
  let ended = false;
  for (const [slot, s] of [..._seen]) {
    const now = slot === "full" ? progress.full : (progress.roots || {})[slot];
    if (now && now.running && now.run === s.run && progress.process === s.process) continue;
    _seen.delete(slot);
    ended = true;
    changed = true;
    // A run the server no longer holds was cut short, as by a restart, and
    // is not announced.
    const f = endedEntry(progress, slot, s);
    if (!f || f.phase === "error") continue;
    // A run that ended done clears the failures it put right. A rebuild writes
    // no search index stamp, so it leaves that build's failure up.
    for (const subject of [..._failed.keys()]) {
      if ((s.kind === "full" && subject !== "facts") || subject === _subjectOf(s.kind, slot)) _failed.delete(subject);
    }
    // Progress pushes are throttled, so a quick run can finish before any
    // counted message arrives, and its count comes only in the finished entry.
    _done.push({ kind: s.kind, text: indexDoneText(s.kind, Math.max(s.count, f.total || f.done || 0)), left: DONE_MS });
  }
  _startDoneClock();
  // A settle redraws too, since a panel reads whether a run is still going
  // from its own subscription, which hears each message after this one, and
  // so a run's end is passed on with the settle that follows it.
  if (ended) _endedSinceSettle = true;
  if (changed || meta.settled) {
    const told = meta.settled && _endedSinceSettle;
    if (meta.settled) _endedSinceSettle = false;
    _tellEndings(told);
  }
}

/** Subscribes the page to index endings, which the extension does at setup so
 *  runs are seen while the gallery is closed. */
export function watchIndexEndings() {
  if (_watching) return;
  _watching = true;
  progressFeed.subscribe(_onIndexProgress);
}

export const indexEndings = {
  /** `cb(ended)` runs whenever the endings change, `ended` saying a run seen
   *  running has ended. */
  subscribe(cb) {
    watchIndexEndings();
    _endingSubs.add(cb);
    _startDoneClock();
    return () => { _endingSubs.delete(cb); };
  },
  /** Whether a run was going in the last message the page heard. */
  running: () => _running,
  /** The first done line still owed its time on screen, or null. */
  done: () => (_done.length ? { kind: _done[0].kind, text: _done[0].text } : null),
  /** Each failure standing, as `{subject, kind, slot, error, run, process}`. */
  failures: () => [..._failed].map(([subject, f]) => ({ subject, ...f })),
  dismiss(subject) {
    if (_failed.delete(subject)) _tellEndings(false);
  },
};
