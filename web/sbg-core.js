export const EXT_NAME = "ComfyUI-sidebar-gallery.Sidebar";

const CSS_URL = new URL("./sidebar_gallery.css", import.meta.url).href;

// Written by the search bar and read by the lightbox's metadata panel to mark
// its matches.
export const searchState = {
  terms: [],
};

const _inflightByKey = new Map();
export function singleFlight(key, fn) {
  const cur = _inflightByKey.get(key);
  if (cur) return cur;
  const p = Promise.resolve().then(fn);
  _inflightByKey.set(key, p);

  // A chain of its own, so the rejection is not reported as unhandled while
  // the caller still receives it from `p`.
  p.finally(() => _inflightByKey.delete(key)).catch(() => { });
  return p;
}

export function ensureCss() {
  if (document.querySelector(`link[data-sbg-css="1"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_URL;
  link.dataset.sbgCss = "1";
  document.head.appendChild(link);
}

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else if (c) el.appendChild(c);
  }
  return el;
}

// The tree's geometry, which the folder dropdown and the Presets tab both draw
// from. The stylesheet draws the chevron at TREE_GLYPH too, so the two change
// together.
const TREE_BASE = 32;
const TREE_STEP = 20;
const TREE_GLYPH = 14;
/** Where a row's name starts at `depth`, which is also its strip's width. */
export const treeNameX = (depth) => TREE_BASE + TREE_STEP * depth;
export const treeGlyphLeft = (depth) => treeNameX(depth) - 6 - TREE_GLYPH;
/** The middle of the chevron at `depth`, where the guides under it run. */
export const treeGlyphMid = (depth) => treeGlyphLeft(depth) + TREE_GLYPH / 2;

/** The guide for one tree row, from the trunk at `x` to `end`, both in pixels
 *  from the row's left edge. */
export function branchGuides(x, end, last) {
  const piece = (cls, width) => {
    const el = h("i", { class: cls, "aria-hidden": "true" });
    el.style.left = x + "px";
    if (width) el.style.width = width;
    return el;
  };
  if (last) return [piece("sbg-tree-line sbg-tree-line--top"), piece("sbg-tree-elbow", (end - x) + "px")];
  return [piece("sbg-tree-line sbg-tree-line--full"), piece("sbg-tree-tick", `calc(${end - x}px - var(--sbg-tree-line))`)];
}

export function passingGuide(x) {
  const el = h("i", { class: "sbg-tree-line sbg-tree-line--full", "aria-hidden": "true" });
  el.style.left = x + "px";
  return el;
}

export function treeStem(depth) {
  const el = h("i", { class: "sbg-tree-line sbg-tree-line--stem", "aria-hidden": "true" });
  el.style.left = treeGlyphMid(depth) + "px";
  return el;
}

function _reasonIn(data, status) {
  const reason = data && typeof data.error === "string" ? data.error.trim() : "";
  return reason || `HTTP ${status}`;
}

/** The server's `error` field from a failed response, or its status when there
 *  is none. This reads the body, so the caller must not have read it first. */
export async function errorFrom(resp) {
  return _reasonIn(await resp.json().catch(() => ({})), resp.status);
}

// localStorage throws on any access where site data is blocked, and on a write
// once it is full, so a remembered width or tab never stops the code around it.
export function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
export function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { }
}
export function lsKeys(prefix) {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch { }
  return out;
}

/** Whether ComfyUI took the graph. For a graph it cannot build, ComfyUI shows
 *  its own error dialog and answers false, so the caller has nothing to add. */
export async function loadWorkflow(app, wf) {
  // The text came from the file, so a parse failure is said to be the file's.
  // Its own message would read as ComfyUI's answer being unreadable.
  if (typeof wf === "string") {
    try { wf = JSON.parse(wf); } catch { throw new Error("the file's workflow is damaged"); }
  }
  return (await app.loadGraphData(wf)) !== false;
}

export async function api(path, params) {
  const query = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString() : "";
  const resp = await fetch(query ? `${path}?${query}` : path);
  if (!resp.ok) throw Object.assign(new Error(await errorFrom(resp)), { status: resp.status });
  return resp.json();
}

/** A failure carries the parsed `data` beside the `status`, since some
 *  refusals say more in the body than the reason. */
export async function apiPost(path, body, { signal, keepalive = false } = {}) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    keepalive,
  });
  if (resp.ok) return resp.json();
  const data = await resp.json().catch(() => ({}));
  throw Object.assign(new Error(_reasonIn(data, resp.status)), { status: resp.status, data });
}

export const RESTART_FIRST = "restart ComfyUI to finish the update";

export function fmtBytes(b) {
  const n = Number(b);
  if (!Number.isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function timeAgo(ts, dateOptions) {
  const diff = (Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, dateOptions);
}

export function downloadJson(doc, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
  h("a", { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

export function pj(x) { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }

/** Every term's ranges are merged per text node before any node changes, so
 *  one term cannot mark inside another's mark or miss text that mark split.
 *  Each parent's display is read before the first replacement, since a read
 *  after one forces the browser to recompute style. */
export function highlightSearchMatches(container, terms) {
  const patterns = [];
  for (const term of terms) {
    const esc = String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A run of spaces, underscores or hyphens matches any of the three, so a
    // query typed with spaces still marks a name written with underscores.
    const pattern = esc.replace(/[\s_-]+/g, "[\\s_-]+");
    if (!pattern) continue;
    patterns.push(new RegExp(pattern, "gi"));
  }
  if (!patterns.length) return;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const hits = [];
  const displayOf = new Map();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent;
    const ranges = [];
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        ranges.push([m.index, m.index + m[0].length]);
      }
    }
    if (!ranges.length) continue;
    const parent = node.parentElement;
    if (parent?.closest("pre, button, .sbg-section__head")) continue;
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of ranges) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    if (parent && !displayOf.has(parent)) displayOf.set(parent, getComputedStyle(parent).display);
    hits.push({ node, text, merged });
  }

  for (const { node, text, merged } of hits) {
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    for (const [start, end] of merged) {
      if (start > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, start)));
      const mark = document.createElement("mark");
      mark.className = "sbg-highlight";
      mark.textContent = text.slice(start, end);
      frag.appendChild(mark);
      lastIdx = end;
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));

    // Inside a flex parent every piece of the fragment would become an item of
    // its own, so they go back in wrapped in one span.
    const display = displayOf.get(node.parentElement) || "";
    if (display === "flex" || display === "inline-flex") {
      const wrapper = document.createElement("span");
      wrapper.appendChild(frag);
      node.parentNode.replaceChild(wrapper, node);
    } else {
      node.parentNode.replaceChild(frag, node);
    }
  }
}
