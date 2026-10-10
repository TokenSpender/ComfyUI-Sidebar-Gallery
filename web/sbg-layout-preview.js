import { h } from "./sbg-core.js";
import { summaryOf } from "./sbg-meta-cache.js";
import { failureText, noticeRow } from "./sbg-toast.js";
import * as TL from "./sbg-translation-layer.js";
import { MEDIA_KEYS } from "./sbg-layout-store.js";
import { makeSection } from "./sbg-meta-section.js";

// Stands in where the renderer draws nothing in the preview, which is a
// section with no fields or a nodes section with no sample workflow.
function buildPlaceholderSection(sec) {
  const wrap = h("div", { class: "sbg-meta-group sbg-ly3-placeholder" });
  wrap.appendChild(TL.kvRow(sec.style === "nodes" ? "(workflow nodes)" : "(no fields)", "—"));
  return wrap;
}

export function createLayoutPreview({ rightPane, getMedia, activeLayout, activeKey, galleryCtx }) {
  const mockByMedia = Object.fromEntries(MEDIA_KEYS.map((m) => [m, null]));

  const sampleReads = {};
  const started = new Set();
  const mock = () => mockByMedia[getMedia()];

  function refreshPreview() {
    rightPane.innerHTML = "";
    const m = mock();
    rightPane.appendChild(h("div", { class: "sbg-ly3-prevhint", text: "Live preview" }));
    if (!m) { rightPane.appendChild(h("div", { class: "sbg-ly3-empty", text: "Loading sample metadata…" })); return; }

    const f = sampleReads[getMedia()];
    if (f && !f.read && f.error && !f.closed) {
      rightPane.appendChild(h("div", { class: "sbg-notices sbg-gs-notices" }, [noticeRow(`${failureText("load the sample metadata", f.error)}. The preview has no values.`,
        () => { f.closed = true; refreshPreview(); rightPane.closest("[role=tabpanel]").focus(); })]));
    }
    const panel = h("div", { class: "sbg-ly3-panel" });
    let any = false;
    for (const sec of TL.visibleSections(activeLayout(), m, { preview: true })) {
      const contentEl = TL.renderSection(sec, m, { preview: true, profileKey: activeKey() }) || buildPlaceholderSection(sec);
      panel.appendChild(makeSection(sec, contentEl, { remember: false }));
      any = true;
    }
    if (!any) rightPane.appendChild(h("div", { class: "sbg-ly3-empty", text: "Nothing to preview. Add a section, or show a hidden one." }));
    else rightPane.appendChild(panel);
    const hiddenCount = activeLayout().filter(s => s.hidden).length;
    if (hiddenCount) rightPane.appendChild(h("div", { class: "sbg-ly3-prevnote", text: `${hiddenCount} hidden section${hiddenCount > 1 ? "s" : ""} not shown.` }));
  }

  // No single file carries every field a layout can bind, so the sample merges several.
  function ensureMock() {
    const media = getMedia();
    if (started.has(media)) return;
    started.add(media);

    const pool = galleryCtx.getAllItems().filter(it => it.kind === media);
    if (!pool.length) {
      mockByMedia[media] = {};
      return;
    }

    // More files give rare sections an example value, and each one costs a
    // summary read when it is not cached.
    const MAX_FETCH = 12;
    const sample = pool.slice(0, MAX_FETCH);
    const merged = {};

    // The preview shows with the first answer, and later answers repaint it as they merge in.
    let pending = sample.length, done = false;
    const finish = () => {
      if (done) return; done = true;

      // Applied in place, since later answers keep merging into this same object.
      Object.assign(merged, TL.mergeFileInfo(merged, sample[0]));
      mockByMedia[media] = merged;

      if (rightPane.isConnected) refreshPreview();
    };

    let timer = null;
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (mockByMedia[getMedia()] && rightPane.isConnected) refreshPreview(); }, 150);
    };

    const mergeInto = (s) => {
      if (!s || typeof s !== "object") return;
      for (const [k, v] of Object.entries(s)) {
        if (v == null) continue;
        if (Array.isArray(v)) { if (v.length && !(merged[k] && merged[k].length)) merged[k] = v; }
        else if (typeof v === "object") {
          const held = merged[k];
          if (held === undefined) merged[k] = v;
          else if (held && typeof held === "object" && !Array.isArray(held)) merged[k] = Object.assign({}, v, held);
        }
        else if (merged[k] === undefined) merged[k] = v;
      }
    };
    const reads = sampleReads[media] = { read: false, error: null };
    for (const it of sample) {
      summaryOf(it)
        .then(m => {
          reads.read = true;
          mergeInto(m.summary);
          if (done) scheduleRefresh(); else finish();
        })
        .catch((e) => { reads.error = e; })
        .finally(() => { if (--pending === 0) finish(); });
    }

    // A request that never settles would hold the loading line, so the sample is taken as it stands.
    setTimeout(finish, 2500);
  }

  return { refreshPreview, ensureMock };
}
