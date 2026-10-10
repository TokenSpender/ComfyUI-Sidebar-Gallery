import { h } from "./sbg-core.js";
import { attachOverlayThumb } from "./sbg-overlay-thumb.js";
import { showToast, confirmClick } from "./sbg-toast.js";
import { trapFocus } from "./sbg-a11y.js";
import { CLOSE_ICON } from "./sbg-icons.js";
import { uid } from "./sbg-translation-layer.js";
import { closePopovers } from "./sbg-color-popover.js";
import { APPS, MEDIA_KEYS, profileKey, profileLabel, forgetPromptTabs } from "./sbg-layout-store.js";
import { mkSelect, sectionStyleLabel, canHoldFields, newSection } from "./sbg-layout-helpers.js";

export const titleKey = (s) => String(s || "").trim().toLowerCase();

export function cloneSectionForCopy(sec) {
  const c = JSON.parse(JSON.stringify(sec));
  c.id = uid();
  for (const t of (c.tabs || [])) t.id = uid("tab");
  return c;
}
export function cloneTabForCopy(t) {
  const c = JSON.parse(JSON.stringify(t));
  c.id = uid("tab");
  return c;
}

/** Returns the dialog's close, for the caller to run when the settings panel
 *  closes or leaves the tab. */
export function openTransferDialog({ activeKey, layoutFor, persistKeys, appendTabToSection, expanded, render }) {
  closePopovers();

  const LAYOUTS = [];
  for (const app of APPS) for (const med of MEDIA_KEYS) {
    const key = profileKey(app, med);
    LAYOUTS.push({ app, med, key, label: profileLabel(key) });
  }
  const keys = LAYOUTS.map(d => d.key);
  const byKey = new Map(LAYOUTS.map(d => [d.key, d]));
  const layoutLabel = (key) => (byKey.get(key) || {}).label || key;
  const layoutOf = (key) => { const d = byKey.get(key); return layoutFor(d.app, d.med); };

  const active = byKey.get(activeKey());
  let fromKey = active.key;
  let toKey = profileKey(active.app, MEDIA_KEYS[(MEDIA_KEYS.indexOf(active.med) + 1) % MEDIA_KEYS.length]);

  const overlay = h("div", { class: "sbg-ly3-xfer-overlay" });
  const dlg = h("div", {
    class: "sbg-ly3-xfer", role: "dialog", "aria-modal": "true",
    "aria-label": "Copy between layouts",
  });
  overlay.appendChild(dlg);

  let _releaseTrap = null;
  const close = () => {
    if (_releaseTrap) { _releaseTrap(); _releaseTrap = null; }
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };

  // Taken on the capture phase and stopped there, so Escape does not also close
  // the settings panel underneath.
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  const head = h("div", { class: "sbg-ly3-xfer-head" });
  head.appendChild(h("span", { class: "sbg-ly3-xfer-title", text: "Copy between layouts" }));
  const closeBtn = h("button", { class: "sbg-btn sbg-btn--icon", title: "Close", "aria-label": "Close", html: CLOSE_ICON });
  closeBtn.addEventListener("click", close);
  head.appendChild(closeBtn);
  dlg.appendChild(head);

  const fromRow = h("div", { class: "sbg-ly3-xfer-row" });
  fromRow.appendChild(h("span", { text: "From" }));
  fromRow.appendChild(mkSelect(keys, fromKey, (v) => { fromKey = v; renderChecklist(); }, layoutLabel, { "aria-label": "Copy from" }));
  fromRow.appendChild(h("span", { text: "to" }));
  fromRow.appendChild(mkSelect(keys, toKey, (v) => { toKey = v; updateCount(); }, layoutLabel, { "aria-label": "Copy to" }));
  dlg.appendChild(fromRow);
  dlg.appendChild(h("div", { class: "sbg-ly3-xfer-dim", text: "Select the sections or tabs to copy. If From and to are the same layout, the copies are added to it." }));

  const listEl = h("div", { class: "sbg-ly3-xfer-list" });
  attachOverlayThumb(listEl);
  dlg.appendChild(listEl);

  let rows = [];
  function renderChecklist() {
    listEl.innerHTML = "";
    rows = [];
    for (const sec of layoutOf(fromKey)) {
      const r = { sec, tabRows: [] };
      const item = h("label", { class: "sbg-ly3-xfer-item" });
      const cb = h("input", { type: "checkbox" });
      r.cb = cb;
      item.appendChild(cb);
      item.appendChild(h("span", { text: sec.title || "(untitled)" }));
      const bits = [sectionStyleLabel(sec.style || "flat")];
      const tabs = sec.tabs || [];
      if (tabs.length) bits.push(tabs.length + " tab" + (tabs.length > 1 ? "s" : ""));
      else if ((sec.params || []).length) bits.push(sec.params.length + " field" + (sec.params.length > 1 ? "s" : ""));
      if (sec.hidden) bits.push("hidden");
      item.appendChild(h("span", { class: "sbg-ly3-xfer-dim", text: bits.join(" · ") }));
      listEl.appendChild(item);
      cb.addEventListener("change", () => {
        for (const tr of r.tabRows) tr.cb.checked = cb.checked;
        syncParentHint(r); updateCount();
      });
      for (const tab of tabs) {
        const ti = h("label", { class: "sbg-ly3-xfer-item sbg-ly3-xfer-item--tab" });
        const tcb = h("input", { type: "checkbox" });
        ti.appendChild(tcb);
        ti.appendChild(h("span", { text: tab.label || "Tab" }));
        listEl.appendChild(ti);
        const tr = { tab, cb: tcb };
        r.tabRows.push(tr);
        tcb.addEventListener("change", () => {
          if (r.cb.checked && !r.tabRows.some(x => x.cb.checked)) r.cb.checked = false;
          syncParentHint(r); updateCount();
        });
      }
      rows.push(r);
    }
    if (!rows.length) listEl.appendChild(h("div", { class: "sbg-ly3-empty", text: "This layout has no sections." }));
    updateCount();
  }

  function syncParentHint(r) {
    r.cb.indeterminate = !r.cb.checked && r.tabRows.some(tr => tr.cb.checked);
  }
  function selection() {
    const secItems = [], loneTabs = [];
    for (const r of rows) {
      const picked = r.tabRows.filter(tr => tr.cb.checked).map(tr => tr.tab);
      if (r.cb.checked) {
        secItems.push({ sec: r.sec, tabs: picked });
      } else {
        for (const tab of picked) loneTabs.push({ srcSec: r.sec, tab });
      }
    }
    return { secItems, loneTabs, count: secItems.length + loneTabs.length };
  }

  const wholeRow = h("div", { class: "sbg-ly3-xfer-row" });
  const wholeLabel = h("label", { class: "sbg-ly3-xfer-check" });
  const wholeCb = h("input", { type: "checkbox" });
  wholeLabel.appendChild(wholeCb);
  wholeLabel.appendChild(document.createTextNode("Copy the whole layout, replacing everything already there"));
  wholeRow.appendChild(wholeLabel);
  dlg.appendChild(wholeRow);
  wholeCb.addEventListener("change", () => {
    listEl.classList.toggle("sbg-ly3-xfer-off", wholeCb.checked);
    updateCount();
  });

  const ruleRow = h("div", { class: "sbg-ly3-xfer-row" });
  ruleRow.appendChild(h("span", { class: "sbg-ly3-xfer-dim", text: "If a section or tab with the same name is already there:" }));
  const mkRule = (val, lbl, chk) => {
    const l = h("label", { class: "sbg-ly3-xfer-radio" });
    const rb = h("input", { type: "radio", name: "sbg-xfer-clash", value: val });
    rb.checked = chk;
    l.appendChild(rb);
    l.appendChild(document.createTextNode(lbl));
    return l;
  };
  ruleRow.appendChild(mkRule("add", "Keep both", true));
  ruleRow.appendChild(mkRule("replace", "Replace it", false));
  dlg.appendChild(ruleRow);

  const foot = h("div", { class: "sbg-ly3-xfer-foot" });
  const cancel = h("button", { class: "sbg-btn sbg-btn--sm", text: "Cancel" });
  cancel.addEventListener("click", close);
  const go = h("button", { class: "sbg-btn sbg-btn--sm sbg-btn--accent", text: "Copy 0 selected" });
  go.disabled = true;
  go.addEventListener("click", commit);

  // Replacing a whole layout cannot be undone, so it takes two clicks. It has
  // its own button because `updateCount` rewrites the copy button's label.
  const replaceBtn = h("button", { class: "sbg-btn sbg-btn--sm sbg-btn--accent sbg-hidden", text: "Replace whole layout" });
  const disarmReplace = confirmClick(replaceBtn, commitWhole, {
    label: () => "Replace " + layoutLabel(toKey) + "?", armClass: "sbg-btn--danger",
  });
  foot.appendChild(cancel);
  foot.appendChild(go);
  foot.appendChild(replaceBtn);
  dlg.appendChild(foot);

  function updateCount() {
    disarmReplace();
    const whole = wholeCb.checked;
    ruleRow.classList.toggle("sbg-ly3-xfer-off", whole || toKey === fromKey);
    go.classList.toggle("sbg-hidden", whole);
    replaceBtn.classList.toggle("sbg-hidden", !whole);
    if (whole) {
      replaceBtn.disabled = toKey === fromKey;
      return;
    }
    const { count } = selection();
    go.textContent = "Copy " + count + " selected";
    go.disabled = !count;
  }

  function commitWhole() {
    if (!wholeCb.checked || toKey === fromKey) return;
    const src = layoutOf(fromKey);
    const target = layoutOf(toKey);
    const replacedIds = target.map(s => s.id);
    target.splice(0, target.length, ...JSON.parse(JSON.stringify(src)));
    if (persistKeys([toKey])) {
      forgetPromptTabs(replacedIds);
      showToast("Replaced " + layoutLabel(toKey) + " with a copy of " + layoutLabel(fromKey));
    }
    close();
    if (toKey === activeKey()) render();
  }

  function commit() {
    if (wholeCb.checked) return;
    const { secItems, loneTabs, count } = selection();
    if (!count) return;
    const rb = overlay.querySelector('input[name="sbg-xfer-clash"]:checked');

    const replace = toKey !== fromKey && rb.value === "replace";
    const target = layoutOf(toKey);

    const toActive = toKey === activeKey();

    // Only a section the target held before this copy can be replaced, and each
    // only once, so two copied sections with the same title never land on one.
    const originalTargets = target.slice();
    const claimedReplace = new Set();
    const claimReplaceTarget = (title) => {
      const s = originalTargets.find(x => !claimedReplace.has(x) && titleKey(x.title) === titleKey(title));
      if (s) claimedReplace.add(s);
      return s || null;
    };

    const findHost = (title) => target.find(s => canHoldFields(s) && titleKey(s.title) === titleKey(title)) || null;

    for (const it of secItems) {
      const clone = cloneSectionForCopy(it.sec);
      if (Array.isArray(clone.tabs)) {
        // The clone's tabs are new objects, so the ticked ones are matched by
        // their position in the source section.
        const keep = new Set(it.tabs.map(t => (it.sec.tabs || []).indexOf(t)));
        clone.tabs = clone.tabs.filter((t, i) => keep.has(i));
        if (!clone.tabs.length) delete clone.tabs;
      }
      const repl = replace ? claimReplaceTarget(it.sec.title) : null;
      if (repl) {
        // Anything holding the replaced section's id still finds a section.
        clone.id = repl.id;
        target.splice(target.indexOf(repl), 1, clone);
      } else {
        target.push(clone);
      }
      if (toActive) expanded.add(clone.id);
    }

    const groups = new Map();
    for (const lt of loneTabs) {
      if (!groups.has(lt.srcSec)) groups.set(lt.srcSec, []);
      groups.get(lt.srcSec).push(lt.tab);
    }

    const hostOrigTabs = new Map();
    for (const [srcSec, tabs] of groups) {
      let host = findHost(srcSec.title);
      if (!host) {
        // A section with tabs can still carry a `source` and a `highlow` that do
        // nothing, and the copied tabs keep their own, so the new section takes
        // neither.
        host = newSection(srcSec.title || "Section", []);
        host.style = srcSec.style || "flat";
        if (srcSec.color) host.color = { ...srcSec.color };
        if (srcSec.showWhen) host.showWhen = srcSec.showWhen;
        target.push(host);
      }
      if (!hostOrigTabs.has(host)) {
        hostOrigTabs.set(host, originalTargets.includes(host) && Array.isArray(host.tabs) ? host.tabs.slice() : []);
      }
      const origTabs = hostOrigTabs.get(host);
      for (const tab of tabs) {
        const tclone = cloneTabForCopy(tab);
        const key = titleKey(tab.label);

        const ti = replace && key && Array.isArray(host.tabs)
          ? host.tabs.findIndex(t => origTabs.includes(t) && titleKey(t.label) === key) : -1;
        if (ti >= 0) host.tabs.splice(ti, 1, tclone); else appendTabToSection(host, tclone);
      }
      if (toActive) expanded.add(host.id);
    }

    if (persistKeys([toKey])) showToast("Copied " + count + " item" + (count > 1 ? "s" : "") + " to " + layoutLabel(toKey));
    close();
    if (toActive) render();
  }

  renderChecklist();
  document.body.appendChild(overlay);
  _releaseTrap = trapFocus(dlg);
  return close;
}
