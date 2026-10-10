import {
  h,
  api,
  apiPost,
  lsRemove,
  fmtBytes,
  timeAgo,
} from "./sbg-core.js";
import { sectionTitle } from "./sbg-settings-inputs.js";
import { B, B_RETIRED } from "./sbg-settings-store.js";
import { cacheDb } from "./sbg-idb.js";
import { metaCache, storedSummaryOf, fetchSummary } from "./sbg-meta-cache.js";
import { deleteSnapshots } from "./sbg-snapshot.js";
import { thumbCache, resetFailedThumbs } from "./sbg-thumb-cache.js";
import { showToast, showFailure, failureText, confirmClick, noticeRow } from "./sbg-toast.js";
import { progressFeed, indexEndings, runningEntry, progressKind, indexRunningText, indexPct, indexFailedText } from "./sbg-progress.js";

import { itemKey } from "./sbg-media-kind.js";

async function busyButton(btn, busyLabel, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    await fn();
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

function fmtCacheSize(bytes) {
  return !bytes || bytes <= 0 ? "—" : fmtBytes(bytes);
}

// A rebuild started here refreshes the gallery when it ends, with the settings
// panel open or closed, so the wait lives at module level instead of in one drawing of the tab.
let _stopRefreshWait = null;
function _refreshGalleryWhenSettled(galleryCtx) {
  if (_stopRefreshWait) _stopRefreshWait();
  const stop = progressFeed.subscribe((data, meta) => {
    if (!meta.settled) return;
    stop();
    _stopRefreshWait = null;
    galleryCtx.fetchAllItems({ rescan: true });
  });
  _stopRefreshWait = stop;
}

const STORE_REFUSED = "this browser's storage is full or blocked";

// The In Progress row's words for the run going, or null when none is.
function _runningText(progress) {
  const entry = runningEntry(progress);
  if (!entry) return null;
  const kind = progressKind(progress, entry);
  const pct = indexPct(kind, entry);
  const text = indexRunningText(kind, entry);
  return pct >= 0 ? `${text} (${pct}%)` : text;
}

// The row is drawn with its label at once, since the settings search counts
// rows before any status arrives.
function statRow(container, label, title, before = null) {
  const value = h("span", { class: "sbg-gs-value", text: "…" });
  const row = h("div", { class: "sbg-gs-row", title }, [h("span", { class: "sbg-gs-label", text: label }), value]);
  container.insertBefore(row, before);
  return {
    row,
    value,
    set(text) {
      if (text != null) value.textContent = text;
      row.classList.toggle("sbg-hidden", text == null);
    },
  };
}

export function renderDiagnosticsTab({ content, galleryCtx, visitCleanups, indexOnly }) {
  content.innerHTML = "";
  const wrap = h("div", { class: "sbg-gs-form" });
  sectionTitle(wrap, "Tools");

  const actionRow = h("div", { class: "sbg-gs-actions" });

  // The tab's own failures, under the tools, each until its cross or until what
  // failed works.
  const problemSlot = h("div", { class: "sbg-notices sbg-gs-notices" });
  const problems = new Map();
  const drawProblems = () => {
    problemSlot.textContent = "";
    for (const [key, { text, tint, onDismiss }] of problems) {
      problemSlot.appendChild(noticeRow(text, () => {
        if (onDismiss) onDismiss();
        setProblem(key, null);
        actionRow.querySelector("button").focus();
      }, { failure: !tint }));
    }
  };
  function setProblem(key, text, { tint = false, onDismiss = null } = {}) {
    const had = problems.get(key);
    if (text) {
      if (had && had.text === text) return;
      problems.set(key, { text, tint, onDismiss });
    } else if (!problems.delete(key)) return;
    drawProblems();
  }
  // A rebuild or a search index build that failed is kept by the page, which a
  // failure line in the notification area draws too, so closing either closes
  // both.
  const drawIndexFailures = () => {
    const standing = indexEndings.failures();
    for (const subject of ["full", "facts"]) {
      const f = standing.find((x) => x.subject === subject);
      setProblem(subject, f && indexFailedText(f.kind, f.error), { tint: subject === "facts", onDismiss: () => indexEndings.dismiss(subject) });
    }
  };

  const diagGalleryRefreshBtn = h("button", { class: "sbg-btn sbg-btn--accent", text: "Refresh gallery", title: "Rescan the root you are viewing and reload its file list" });
  diagGalleryRefreshBtn.addEventListener("click", () =>
    busyButton(diagGalleryRefreshBtn, "Refreshing…", async () => {
      // The load reports its failure in the notification area, which the
      // settings panel covers, so it is said here as well, in the same words.
      const failed = await galleryCtx.fetchAllItems({ rescan: true });
      if (failed) showFailure("load the files", failed);
      else showToast("Gallery refreshed");
      await refreshStats();
    }));

  const diagRefreshBtn = h("button", { class: "sbg-btn", text: "Rebuild index", title: "Read every file's metadata again and rebuild the index" });
  // Whether a rebuild was seen running, so its end puts the button back and
  // reads the figures again.
  let seenRun = false;
  // The server refuses a rebuild while a folder's first index runs, so the
  // button waits for it.
  let firstRunning = false;
  const showIdle = () => {
    diagRefreshBtn.disabled = firstRunning;
    diagRefreshBtn.textContent = "Rebuild index";
  };
  // A root's scanning phase has no percentage, so the button reads 0% there
  // instead of the count line of files found. The search index rebuild never
  // has a total, so it shows its text alone.
  const showRunning = (data, entry) => {
    diagRefreshBtn.disabled = true;
    const kind = progressKind(data, entry);
    diagRefreshBtn.textContent = kind === "facts" ? indexRunningText(kind, entry) : `Rebuilding (${Math.max(0, indexPct(kind, entry))}%)`;
  };

  const onProgress = (data, meta) => {
    // The feed alone fills the In Progress row, so it counts along with any
    // run, a folder's first index included, and no slower read puts back an
    // older count.
    inProgress.set(_runningText(data));
    const entry = data && data.full;
    if (entry && entry.running) {
      seenRun = true;
      showRunning(data, entry);
      return;
    }
    const first = Object.values((data && data.roots) || {}).some((e) => e && e.running);
    if (first !== firstRunning) {
      firstRunning = first;
      if (!seenRun) showIdle();
    }
    if (!meta.settled || !seenRun) return;
    seenRun = false;
    refreshStats();
    showIdle();
  };
  confirmClick(diagRefreshBtn, async () => {
    diagRefreshBtn.disabled = true;
    diagRefreshBtn.textContent = "Rebuilding (0%)";
    let answer;
    try {
      answer = await apiPost("/sidebar_gallery/rebuild_index", {});
    } catch (e) {
      showIdle();
      showFailure("start the rebuild", e);
      return;
    }
    if (answer.status === "already_running") {
      showIdle();
      showToast("Couldn't start the rebuild: another scan is running.");
      return;
    }
    seenRun = true;
    _refreshGalleryWhenSettled(galleryCtx);
  });

  const diagCacheMetaBtn = h("button", { class: "sbg-btn", text: "Cache all metadata", title: "Download the metadata of every file in the root you are viewing into this browser" });
  // The tab's own cache figures show what a run stored, so only what went wrong
  // is said: a store that refused the writes, or else the files that couldn't
  // be fetched.
  diagCacheMetaBtn.addEventListener("click", () =>
    busyButton(diagCacheMetaBtn, "Caching…", async () => {
      const items = galleryCtx.getAllItems ? galleryCtx.getAllItems() : [];
      let cached = 0;
      let skipped = 0;
      let refused = false;
      const batch = [];
      for (const it of items) {
        if (await storedSummaryOf(it)) { cached++; continue; }
        try {
          batch.push({ key: itemKey(it), value: await fetchSummary(it) });
          cached++;
          if (cached % 50 === 0) diagCacheMetaBtn.textContent = `Caching… ${cached}/${items.length}`;
          if (batch.length >= 50 && !(await metaCache.putBatch(batch.splice(0)))) refused = true;
        } catch { skipped++; }
      }
      if (batch.length && !(await metaCache.putBatch(batch))) refused = true;
      if (refused) showFailure("cache the metadata", STORE_REFUSED);
      else if (skipped) showToast(`The metadata of ${skipped === 1 ? "1 file" : `${skipped} files`} couldn't be fetched, so it wasn't cached.`);
      await refreshStats();
  }));

  const diagCacheThumbBtn = h("button", { class: "sbg-btn", text: "Cache thumbnails", title: "Download the thumbnails of every file in the root you are viewing into this browser" });
  diagCacheThumbBtn.addEventListener("click", () =>
    busyButton(diagCacheThumbBtn, "Caching…", async () => {
      const items = galleryCtx.getAllItems ? galleryCtx.getAllItems() : [];
      const refusedBefore = thumbCache.refused();
      let cached = 0;
      let skipped = 0;
      for (const it of items) {
        // Fetched directly, outside the thumbnail queue and its cap, since this
        // asks for every file on purpose and one at a time already.
        try {
          if (await thumbCache.fillStore(it.thumb_url)) cached++;
          else skipped++;
          if ((cached + skipped) % 20 === 0) {
            diagCacheThumbBtn.textContent = `Caching… ${cached}/${items.length}`;
          }
        } catch { skipped++; }
      }
      if (thumbCache.refused() > refusedBefore) showFailure("cache the thumbnails", STORE_REFUSED);
      else if (skipped) showToast(skipped === 1 ? "1 thumbnail couldn't be fetched, so it wasn't cached." : `${skipped} thumbnails couldn't be fetched, so they weren't cached.`);
      await refreshStats();
  }));

  const diagClearMetaBtn = h("button", { class: "sbg-btn sbg-btn--danger", text: "Clear metadata cache", title: "Remove the metadata this browser has stored" });
  confirmClick(diagClearMetaBtn, async () => {
    if (!(await metaCache.clear())) showFailure("clear the metadata cache", "this browser's storage is unavailable");
    await refreshStats();
  });

  const diagClearThumbBtn = h("button", { class: "sbg-btn sbg-btn--danger", text: "Clear thumbnail cache", title: "Remove the thumbnails this browser has stored" });
  confirmClick(diagClearThumbBtn, async () => {
    const ok = await thumbCache.clear();
    // A thumbnail that failed is not asked for again until a rescan, so
    // clearing the cache also gives those files another try.
    resetFailedThumbs();
    if (!ok) showFailure("clear the thumbnail cache", "this browser's storage is unavailable");
    await refreshStats();
  });

  const diagNukeBtn = h("button", { class: "sbg-btn sbg-btn--danger", text: "Clear everything and refresh", title: "Delete every cache this browser holds for the gallery and refresh the page. The settings, presets and files are not touched." });
  confirmClick(diagNukeBtn, () => {
    cacheDb.remove();
    deleteSnapshots();
    lsRemove(B.CACHE_EPOCH);
    for (const k of B_RETIRED) lsRemove(k);

    metaCache.clearMemory();
    showToast("All caches cleared. Refreshing the page.");
    setTimeout(() => location.reload(), 500);
  }, { label: "Clear and refresh?", armMs: 3000 });

  actionRow.appendChild(diagGalleryRefreshBtn);
  actionRow.appendChild(diagRefreshBtn);
  actionRow.appendChild(diagCacheMetaBtn);
  actionRow.appendChild(diagCacheThumbBtn);
  actionRow.appendChild(diagClearThumbBtn);
  actionRow.appendChild(diagClearMetaBtn);
  actionRow.appendChild(diagNukeBtn);
  wrap.appendChild(actionRow);

  wrap.appendChild(problemSlot);

  sectionTitle(wrap, "Index", "The database that lists every file and its metadata, so the gallery opens without rescanning the disk");
  const roots = galleryCtx && galleryCtx.getRoots ? galleryCtx.getRoots() : [];
  const rootRows = new Map(roots.map(r => [r.id, statRow(wrap, r.label, r.path || "Files indexed under this root, and when its last scan finished")]));
  const total = statRow(wrap, "Total", "Files indexed across every root");
  const kinds = [["image", "Images"], ["video", "Videos"], ["audio", "Audio"]].map(([kind, label]) => [kind, statRow(wrap, label)]);
  // Shown only when there are any, since a row reading zero would leave users
  // wondering what is missing from their library.
  const missing = statRow(wrap, "Missing", "Files a scan could no longer find. Their details come back if the files do, and a rebuild removes any missing for more than 30 days.");
  missing.set(null);
  const dbPath = statRow(wrap, "Database Path");
  dbPath.value.classList.add("sbg-gs-value--path");
  const dbSize = statRow(wrap, "Database Size", "Size of the database on disk, counting the two working files SQLite keeps beside it");
  const inProgress = statRow(wrap, "In Progress");
  inProgress.row.classList.add("sbg-gs-row--active");
  inProgress.set(null);

  sectionTitle(wrap, "Server thumbnails", "Thumbnails the server makes and keeps in its .thumbs folder, shared by every browser");
  const thumbCount = statRow(wrap, "Count");
  const thumbSize = statRow(wrap, "Size");

  sectionTitle(wrap, "Browser thumbnail cache", "Thumbnails kept in this browser so the grid shows them without asking the server");
  const tcCount = statRow(wrap, "Cached");
  const tcSize = statRow(wrap, "Size");

  sectionTitle(wrap, "Browser metadata cache", "Metadata kept in this browser so the lightbox opens without asking the server");
  const mcCount = statRow(wrap, "Stored");
  const mcSize = statRow(wrap, "Size");
  const mcMem = statRow(wrap, "In Memory", "Metadata held in memory since this page loaded");

  async function refreshStats() {
    mcMem.set(`${metaCache.memorySize} entries`);
    Promise.all([thumbCache.stats(), metaCache.stats()]).then(([ts, ms]) => {
      tcCount.set(`${ts.count.toLocaleString()} thumbnails`);
      tcSize.set(fmtCacheSize(ts.totalSizeBytes));
      mcCount.set(`${ms.count.toLocaleString()} entries`);
      mcSize.set(fmtCacheSize(ms.totalSizeBytes));
    }).catch(() => { });

    try {
      fillStatus(await api("/sidebar_gallery/status"));
      setProblem("status", null);
    } catch (e) {
      setProblem("status", failureText("load diagnostics", e));
      for (const r of [...rootRows.values(), total, ...kinds.map(([, r]) => r), dbPath, dbSize, thumbCount, thumbSize]) r.set("—");
      missing.set(null);
    }
  }

  function fillStatus(st) {
    const indexInfo = st.index;
    const lastScans = indexInfo.last_scan || {};
    for (const [rid, count] of Object.entries(indexInfo.counts)) {
      if (!rootRows.has(rid)) rootRows.set(rid, statRow(wrap, rid, "Files indexed under this root, and when its last scan finished", total.row));
      const when = lastScans[rid] ? " · scanned " + timeAgo(lastScans[rid]) : "";
      rootRows.get(rid).set(Number(count).toLocaleString() + " files" + when);
    }
    total.set(typeof indexInfo.total === "number" ? indexInfo.total.toLocaleString() + " files" : null);
    for (const [kind, row] of kinds) {
      const n = (indexInfo.kinds || {})[kind];
      row.set((typeof n === "number" ? n : 0).toLocaleString());
    }
    missing.set(indexInfo.hidden ? indexInfo.hidden.toLocaleString() : null);
    dbPath.set(indexInfo.db_path || null);
    dbSize.set(indexInfo.db_size_mb !== undefined ? `${indexInfo.db_size_mb} MB` : null);
    thumbCount.set((st.thumbnails?.count || 0).toLocaleString());
    thumbSize.set(`${st.thumbnails?.size_mb || 0} MB`);
  }

  content.appendChild(wrap);

  if (indexOnly) return;
  visitCleanups.push(progressFeed.subscribe(onProgress));
  visitCleanups.push(indexEndings.subscribe(drawIndexFailures));
  drawIndexFailures();
  refreshStats();
}
