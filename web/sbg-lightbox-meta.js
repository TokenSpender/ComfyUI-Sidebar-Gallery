import { h, api, singleFlight } from "./sbg-core.js";
import { failureText } from "./sbg-toast.js";
import { cachedMeta } from "./sbg-meta-cache.js";
import * as TL from "./sbg-translation-layer.js";
import { getActiveProfile } from "./sbg-layout-store.js";
import { makeSection } from "./sbg-meta-section.js";

export function initialImageList(s) {
  return s && Array.isArray(s.initial_images) ? s.initial_images : [];
}

export function initialAudioList(s) {
  return s && Array.isArray(s.initial_audios) ? s.initial_audios : [];
}

export function sourceMediaList(s) {
  return [...initialImageList(s), ...initialAudioList(s)];
}

// A loader widget's value may end in the folder it reads from, as in `photo.png [input]`.
const _ANNOTATED_PATH_RE = /^(.*\S)\s\[(input|output|temp)\]$/;

export function parseSourceEntry(entry) {
  const m = _ANNOTATED_PATH_RE.exec(entry);
  return m ? { path: m[1], srcType: m[2] } : { path: entry, srcType: null };
}

function _splitSourcePath(path) {
  const parts = path.replace(/\\/g, "/").split("/");
  const basename = parts.pop();
  return { basename, subfolder: parts.join("/") };
}

function _folderOrder(srcType) {
  const all = ["input", "output", "temp"];
  return srcType ? [srcType, ...all.filter(t => t !== srcType)] : all;
}

// A miss is not cached, so a source file still being indexed is read again later.
function _resolveSourceMeta(path, curRoot, srcType) {
  const ck = "initmeta:" + curRoot + ":" + path + (srcType ? "|" + srcType : "");
  return singleFlight(ck, () => cachedMeta(ck, () => _probeSourceMeta(path, curRoot, srcType)));
}

// A 4xx is the ordinary answer from a place that does not hold the file. A 5xx or
// no answer at all is kept and thrown if no place has the file, so the tab can
// tell a failed read from a file with no metadata.
async function _probeSourceMeta(path, curRoot, srcType) {
  let failure = null;
  const read = async (route, params) => {
    try {
      const m = await api(route, params);
      // The parser gives every file it reads a source_app, so an empty summary means this place could not read it.
      if (Object.keys(m.summary).length > 0) return m;
    } catch (e) {
      if (e.status === undefined || e.status >= 500) failure = e;
    }
    return null;
  };

  // A temp file is never indexed, so only the on-demand read below can answer for one.
  const rootIds = srcType === "output" ? ["output", curRoot]
    : srcType === "temp" ? []
      : [curRoot, "input"];
  for (const rootId of new Set(rootIds)) {
    const m = await read("/sidebar_gallery/metadata", { root_id: rootId, relpath: path, summary_only: "1" });
    if (m) return m;
  }
  const { basename, subfolder } = _splitSourcePath(path);
  for (const type of _folderOrder(srcType)) {
    const m = await read("/sidebar_gallery/metadata_ondemand", { filename: basename, subfolder: subfolder || null, type });
    if (m) return m;
  }
  if (failure) throw failure;
  return null;
}

// Equal keys mean two summaries share their source media. Each path keeps its
// folder so entries differing only by it stay apart, and NUL separates entries
// since no path can hold it.
export function sourceMediaKey(s, rootId) {
  return `${rootId}:${sourceMediaList(s).map(e => {
    const n = parseSourceEntry(e);
    return n.path + (n.srcType ? "|" + n.srcType : "");
  }).join("\x00")}`;
}

export function sourceTabLabel(imgs, auds) {
  if (imgs && auds) return "Source Media";
  return auds ? "Source Audio" : "Source Image";
}

export function createSourceMediaBuilder({ newStaleCheck }) {
  // ComfyUI's /view needs a folder type that a source entry may not name, so the
  // folder that served each file is remembered here, or "none" when no folder did.
  const viewFolders = new Map();

  function sourceMediaContent(s, rootId) {
    const images = initialImageList(s);
    const audios = initialAudioList(s);
    const el = h("div", {});
    images.forEach((entry, i) => {
      const label = images.length > 1 ? `Source Image ${i + 1} of ${images.length}` : "Source Image";
      el.appendChild(_buildSourceEntry(entry, rootId, label, "image"));
    });
    audios.forEach((entry, i) => {
      const label = audios.length > 1 ? `Source Audio ${i + 1} of ${audios.length}` : "Source Audio";
      el.appendChild(_buildSourceEntry(entry, rootId, label, "audio"));
    });
    return el;
  }

  function _buildSourceEntry(entry, rootId, label, kind) {
    const wrap = h("div", { class: "sbg-meta-group sbg-meta-pad" });
    const { path, srcType } = parseSourceEntry(entry);
    wrap.appendChild(h("div", { class: "sbg-meta-heading", text: label }));

    if (path) {
      const { basename, subfolder } = _splitSourcePath(path);
      const viewUrl = (type) => `/view?filename=${encodeURIComponent(basename)}${subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : ""}&type=${type}`;
      const vk = `${rootId}:${path}` + (srcType ? "|" + srcType : "");
      const known = viewFolders.get(vk);
      const media = kind === "audio"
        ? h("audio", { controls: "true", preload: "metadata", class: "sbg-meta-preview" })
        : h("img", { class: "sbg-initial-image-preview" });

      const noPreview = () => h("div", { class: "sbg-meta-note sbg-meta-note--failed", text: failureText("load the source file") });
      if (known === "none") {
        wrap.appendChild(noPreview());
      } else if (known) {
        media.src = viewUrl(known);
        wrap.appendChild(media);
      } else {
        const folders = _folderOrder(srcType);
        let tried = 0;
        const tryNext = () => {
          if (tried >= folders.length) {
            media.classList.add("sbg-hidden");
            // Checked by parent instead of isConnected, since a Source tab left for another tab is kept off the page and put back whole.
            if (media.parentNode) media.after(noPreview());
            viewFolders.set(vk, "none");
            return;
          }
          media.src = viewUrl(folders[tried++]);
        };
        media.onerror = tryNext;
        const remember = () => viewFolders.set(vk, folders[tried - 1]);
        if (kind === "audio") media.onloadedmetadata = remember;
        else media.onload = remember;
        tryNext();
        wrap.appendChild(media);
      }
    }

    const infoGroup = h("div", { class: "sbg-meta-group" });
    const nameRow = TL.kvRow("Filename", path);
    if (nameRow) infoGroup.appendChild(nameRow);
    wrap.appendChild(infoGroup);

    if (path) {
      const note = h("div", { class: "sbg-meta-note sbg-meta-note--dim sbg-loading", text: "Loading source metadata…" });
      wrap.appendChild(note);
      const isStale = newStaleCheck();
      (async () => {
        let m = null;
        try { m = await _resolveSourceMeta(path, rootId, srcType); }
        catch (e) {
          if (isStale()) return;
          note.textContent = failureText("read the source file's metadata", e);
          note.classList.remove("sbg-loading", "sbg-meta-note--dim");
          note.classList.add("sbg-meta-note--failed");
          return;
        }

        if (isStale()) return;
        if (m) {
          note.remove();
          const merged = TL.mergeFileInfo(m.summary, m.file);
          const profile = getActiveProfile(m.summary.source_app, kind);
          for (const section of TL.visibleSections(profile, merged)) {
            const contentEl = TL.renderSection(section, merged, {});
            if (!contentEl) continue;
            wrap.appendChild(makeSection(section, contentEl));
          }
        } else {
          note.textContent = "No metadata found for this source file";
          note.classList.remove("sbg-loading");
        }
      })();
    }

    return wrap;
  }

  return { sourceMediaContent };
}
