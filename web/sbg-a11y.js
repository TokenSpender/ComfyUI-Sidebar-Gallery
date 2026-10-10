const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "video[controls]",
  "audio[controls]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Display none, on the element or an ancestor, leaves no client rects, while
// visibility hidden keeps the box and needs its own check.
function _visible(el) {
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function _focusables(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(_visible);
}

/** The caller must run the returned release on every close path, Escape
 *  included, since that is what hands focus back to the opener. */
export function trapFocus(container, opts = {}) {
  const opener = document.activeElement;

  if (!container.getAttribute("tabindex")) {
    container.setAttribute("tabindex", "-1");
    container.style.outline = "none";
  }

  (opts.initialFocus || _focusables(container)[0] || container).focus();

  function onKeyDown(e) {
    if (e.key !== "Tab") return;
    const list = _focusables(container);

    if (list.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const firstEl = list[0];
    const lastEl = list[list.length - 1];
    const active = document.activeElement;

    // contains() is true for the container itself, and Shift+Tab from there
    // would walk out of the trap, so that case is checked on its own.
    const onContainer = active === container;
    const outside = !container.contains(active);
    if (e.shiftKey && (onContainer || outside || active === firstEl)) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && (outside || active === lastEl)) {
      e.preventDefault();
      firstEl.focus();
    }
  }

  // Capture, so a handler inside the dialog cannot swallow Tab first.
  container.addEventListener("keydown", onKeyDown, true);

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    container.removeEventListener("keydown", onKeyDown, true);
    if (opener && opener.isConnected) opener.focus();
  };
}

export function wireTablistKeys(tabs, onSelect) {
  const handlers = [];
  for (const tab of tabs) {
    const onKey = (e) => {
      const i = tabs.indexOf(tab);
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      e.stopPropagation();
      tabs[next].focus();
      onSelect(tabs[next]);
    };
    tab.addEventListener("keydown", onKey);
    handlers.push(() => tab.removeEventListener("keydown", onKey));
  }
  return () => { for (const off of handlers) off(); };
}

let _listboxIdCounter = 0;

/** Returns a resync(keepPlace) to run after the caller rebuilds its options.
 *  keepPlace holds the mark near where it was, for a list reshaped where it
 *  stands, and without it the mark goes back to the first option. */
export function wireListboxKeys(listEl, opts) {
  const markClass = opts.markClass;
  const adEl = opts.activeDescendantEl || listEl;
  let options = opts.getOptions ? opts.getOptions() : [...listEl.querySelectorAll('[role="option"]')];

  if (!listEl.getAttribute("tabindex")) listEl.setAttribute("tabindex", "-1");
  listEl.style.outline = "none";

  let idx = options.findIndex(o => o.getAttribute("aria-selected") === "true");
  if (idx < 0) idx = 0;

  let showing = false;

  // With controlsOf, only one option's controls take Tab, the marked one or the
  // one the focus is in, so Tab cannot put the focus ring on another option.
  const tabOnly = (option) => {
    if (!opts.controlsOf) return;
    for (const o of options) for (const c of opts.controlsOf(o)) c.setAttribute("tabindex", o === option ? "0" : "-1");
  };

  const announce = opts.activeDescendant !== false;
  const mark = (next, scroll) => {
    if (options.length === 0) {
      if (announce) adEl.removeAttribute("aria-activedescendant");
      return;
    }
    showing = true;
    if (options[idx]) options[idx].classList.toggle(markClass, false);
    idx = Math.max(0, Math.min(options.length - 1, next));
    const active = options[idx];
    active.classList.toggle(markClass, true);
    tabOnly(active);

    if (announce) {
      if (!active.id) active.id = "sbg-opt-" + (++_listboxIdCounter);
      adEl.setAttribute("aria-activedescendant", active.id);
    }
    if (scroll) active.scrollIntoView({ block: "nearest" });
  };
  // The first mark does not scroll, so a caller restoring the list's scroll
  // keeps it. A list that did not take the focus marks nothing until the
  // keyboard reaches it, since a click on a row focuses the list too.
  const byKeyboard = () => listEl.matches(":focus-visible");
  tabOnly(null);
  if (opts.takeFocus !== false) mark(idx, false);
  else listEl.addEventListener("focus", () => { if (!showing && byKeyboard()) mark(idx, false); });

  const refresh = () => {
    if (!opts.getOptions) return;
    const prev = options[idx];
    const stood = idx;
    options = opts.getOptions();
    // Until a row is marked, the mark starts at the row in use, which a click
    // can have changed since the keys were wired.
    const inUse = showing ? -1 : options.findIndex(o => o.getAttribute("aria-selected") === "true");
    if (inUse >= 0) { idx = inUse; return; }
    let at = prev ? options.indexOf(prev) : -1;
    // A rebuild replaces the option elements, so the marked one is found again
    // by key, or a moved row would pass its mark to whatever took its place.
    if (at < 0 && prev && opts.keyOf) {
      const key = opts.keyOf(prev);
      if (key != null) at = options.findIndex(o => opts.keyOf(o) === key);
    }
    // A removed row leaves the mark where it stood, so collapsing a branch
    // lands beside it instead of at the top.
    idx = at >= 0 ? at : Math.max(0, Math.min(options.length - 1, stood));
  };

  const moveTo = (next) => {
    mark(next, true);
    if (!opts.controlsOf) return;
    // A control left holding focus while the mark moves on would take the next
    // Enter, so focus goes back to what drives the list.
    const f = document.activeElement;
    const own = options[idx] ? opts.controlsOf(options[idx]) : [];
    if (f !== adEl && f !== listEl && listEl.contains(f) && !own.includes(f)) adEl.focus();
  };

  const onKey = (e) => {
    const t = e.target;
    const tick = t.tagName === "INPUT" && (t.type === "checkbox" || t.type === "radio");
    const inText = t.tagName === "INPUT" && !tick;
    // A text field inside the list that does not drive it, such as a name
    // being typed into a row, keeps every key. The field that drives the list
    // keeps these three, and the rest move the list.
    if (inText && t !== adEl) return;
    if (inText && (e.key === " " || e.key === "Home" || e.key === "End")) return;
    // Enter or Space on a button or a tick inside a row belongs to that
    // control, and letting the key through is what presses it.
    if ((e.key === "Enter" || e.key === " ") && t !== listEl && (tick || t.closest("button, a[href]"))) return;
    refresh();
    // With no row marked yet, the first arrow marks the current row instead of
    // moving past it, and Enter or Space has nothing to press.
    const reveal = !showing && (e.key === "ArrowDown" || e.key === "ArrowUp");
    if (!showing && (e.key === "Enter" || e.key === " ")) return;
    if (reveal) moveTo(idx);
    else if (e.key === "ArrowDown") moveTo(idx + 1);
    else if (e.key === "ArrowUp") moveTo(idx - 1);
    else if (e.key === "Home") moveTo(0);
    else if (e.key === "End") moveTo(options.length - 1);
    else if (e.key === "Enter" || e.key === " ") {
      const active = options[idx];
      if (active) active.click();
    }
    // With no onEscape, or one that answers false, the list has nothing open
    // to close, and the key goes on to whatever holds the list.
    else if (e.key === "Escape") {
      if (!opts.onEscape || opts.onEscape() === false) return;
    }
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  listEl.addEventListener("keydown", onKey);

  // The focus landing inside an option, by a click or a redraw putting it back,
  // brings the Tab stop there, and the mark too once one shows. A name typed
  // into a row can then Tab on to that row's button.
  if (opts.controlsOf) listEl.addEventListener("focusin", (e) => {
    const at = options.findIndex(o => o.contains(e.target) || opts.controlsOf(o).includes(e.target));
    if (at < 0) return;
    if (showing) mark(at, false);
    else tabOnly(options[at]);
  });

  if (opts.takeFocus !== false) (opts.initialFocus || listEl).focus();

  return (keepPlace) => {
    const had = showing;
    if (options[idx]) options[idx].classList.toggle(markClass, false);
    if (!keepPlace) idx = -1;
    refresh();
    tabOnly(null);

    if (had) mark(idx, false);
  };
}

export function setSelectedTab(tabs, selected) {
  for (const t of tabs) {
    const on = t === selected;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.setAttribute("tabindex", on ? "0" : "-1");
  }
}
