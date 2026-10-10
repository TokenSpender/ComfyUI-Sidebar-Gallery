let _sorting = false;

let _afterSort = [];

// A redraw during a drag would take the dragged node out of the page, so it
// waits for the drag to end.
export function afterSort(fn) {
  if (_sorting) _afterSort.push(fn); else fn();
}

function _flushAfterSort() {
  for (const fn of _afterSort.splice(0)) {
    try { fn(); } catch (e) { console.warn("[SBG] A redraw held for a drag failed:", e); }
  }
}

export function initSortable(container, handle, item, opts = {}) {
  function beginDrag(e) {
    const rect = item.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    const placeholder = document.createElement("div");
    placeholder.className = "sbg-sortable-placeholder";
    placeholder.style.height = rect.height + "px";
    placeholder.style.margin = getComputedStyle(item).margin;

    // The class holds the dragged look, and only the measured place and width
    // are written here.
    item.style.width = rect.width + "px";
    item.style.left = rect.left + "px";
    item.style.top = rect.top + "px";
    item.classList.add("sbg-sortable--dragging");

    // The stylesheet reads the drag type here to show drop targets, such as an
    // empty tab list, only while a drag lasts.
    if (opts.type) document.body.classList.add("sbg-dragging-" + opts.type);

    // A drop that makes the item a container of its own says so in the
    // placeholder, in the words the caller gives.
    const markPromote = (on) => {
      placeholder.classList.toggle("sbg-sortable-placeholder--promote", on);
      placeholder.textContent = on ? opts.promote.label : "";
    };

    const actualParent = item.parentNode;
    const homeNext = item.nextSibling;
    actualParent.insertBefore(placeholder, item);

    const selector = opts.itemSelector;

    let scrollParent = container.parentElement;
    while (scrollParent && scrollParent !== document.body) {
      const ov = getComputedStyle(scrollParent).overflowY;
      if (ov === "auto" || ov === "scroll") break;
      scrollParent = scrollParent.parentElement;
    }
    if (!scrollParent) scrollParent = document.documentElement;

    let _scrollRAF = null;
    const SCROLL_EDGE = 50;
    const SCROLL_SPEED = 8;

    let _lastX = 0, _lastY = 0;

    function autoScroll(clientY) {
      if (_scrollRAF) cancelAnimationFrame(_scrollRAF);
      const spRect = scrollParent.getBoundingClientRect();
      const distTop = clientY - spRect.top;
      const distBottom = spRect.bottom - clientY;
      let speed = 0;
      if (distTop < SCROLL_EDGE) speed = -SCROLL_SPEED * (1 - distTop / SCROLL_EDGE);
      else if (distBottom < SCROLL_EDGE) speed = SCROLL_SPEED * (1 - distBottom / SCROLL_EDGE);

      if (speed !== 0) {
        (function scroll() {
          scrollParent.scrollTop += speed;
          // No pointer event arrives while the list moves under a still
          // pointer, so the drop spot is worked out again from the last one.
          evaluate(_lastX, _lastY);
          _scrollRAF = requestAnimationFrame(scroll);
        })();
      }
    }

    let convertEl = null;
    function clearConvert() {
      if (convertEl) { convertEl.classList.remove(opts.convertTargets.className); convertEl = null; }
    }

    _sorting = true;

    function onMove(ev) {
      if (!_sorting) return;

      // A button released outside the window sends no mouseup, and the next
      // move reports no button held.
      if (ev.buttons === 0) { cancelDrag(); return; }
      _lastX = ev.clientX; _lastY = ev.clientY;
      item.style.left = (ev.clientX - offsetX) + "px";
      item.style.top = (ev.clientY - offsetY) + "px";
      autoScroll(ev.clientY);
      evaluate(ev.clientX, ev.clientY);
    }

    function evaluate(clientX, clientY) {
      if (!_sorting) return;
      const elUnder = document.elementFromPoint(clientX, clientY);

      let activeContainer = container;
      let overDropList = false;
      if (opts.dropContainerSelector && elUnder) {
        const dropC = elUnder.closest(opts.dropContainerSelector);
        if (dropC) overDropList = true;
        if (dropC && dropC !== activeContainer && dropC !== item) activeContainer = dropC;
      }

      if (opts.convertTargets && !overDropList && elUnder) {
        const ct = opts.convertTargets;
        const t = elUnder.closest(ct.selector);
        if (t && t !== item && !t.contains(item) && (!ct.accepts || ct.accepts(t, item))) {
          const r = t.getBoundingClientRect();
          const frac = (clientY - r.top) / Math.max(1, r.height);
          const band = ct.band || [0, 1];
          if (frac >= band[0] && frac <= band[1]) {
            if (convertEl !== t) { clearConvert(); convertEl = t; t.classList.add(ct.className); }

            // The placeholder stays where it is, since moving it shifts the
            // items under the pointer and the band check then flips every frame.
            markPromote(false);
            return;
          }
        }
      }
      clearConvert();

      let placeSelector = selector;
      let promoting = false;
      if (opts.promote && !overDropList && elUnder) {
        const pc = elUnder.closest(opts.promote.containerSelector);
        const overCard = opts.convertTargets ? elUnder.closest(opts.convertTargets.selector) : null;
        if (pc && !(overCard && overCard.contains(item))) {
          activeContainer = pc;
          placeSelector = opts.promote.itemSelector;
          promoting = true;
        }
      }
      markPromote(promoting);

      const siblings = [...activeContainer.querySelectorAll(placeSelector)].filter(s => s !== item && !s.classList.contains("sbg-sortable-placeholder"));

      // In a wrapped row the siblings cannot be told apart on Y alone, so a
      // horizontal list is placed in reading order instead.
      let horizontal = false;
      if (siblings.length >= 2) {
        const a = siblings[0].getBoundingClientRect();
        const b = siblings[1].getBoundingClientRect();
        horizontal = (b.left > a.left + 1) && (Math.abs(b.top - a.top) < Math.min(a.height, b.height) * 0.6);
      }

      let ref = null;
      if (horizontal) {
        for (const sib of siblings) {
          const r = sib.getBoundingClientRect();
          if (clientY < r.top) { ref = sib; break; }
          if (clientY <= r.bottom && clientX < r.left + r.width / 2) { ref = sib; break; }
        }
      } else {
        for (const sib of siblings) {
          const r = sib.getBoundingClientRect();
          if (clientY < r.top + r.height * 0.4) { ref = sib; break; }
        }
      }

      const parent = (siblings[0] && siblings[0].parentNode) || activeContainer;
      if (ref) {
        if (placeholder.nextSibling !== ref) parent.insertBefore(placeholder, ref);
      } else if (siblings.length) {
        const last = siblings[siblings.length - 1];
        if (last.nextSibling !== placeholder) (last.parentNode || activeContainer).insertBefore(placeholder, last.nextSibling);
      } else if (placeholder.parentNode !== activeContainer) {
        activeContainer.appendChild(placeholder);
      }
    }

    // Both callers cancel the auto-scroll frame first, so this does not.
    function endDrag() {
      clearConvert();
      item.style.width = "";
      item.style.left = "";
      item.style.top = "";
      item.classList.remove("sbg-sortable--dragging");
      if (opts.type) document.body.classList.remove("sbg-dragging-" + opts.type);
      _sorting = false;
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    function cancelDrag() {
      if (!_sorting) return;
      if (_scrollRAF) cancelAnimationFrame(_scrollRAF);
      placeholder.remove();
      actualParent.insertBefore(item, homeNext);
      endDrag();
      _flushAfterSort();
    }

    function onUp() {
      if (!_sorting) return;
      if (_scrollRAF) cancelAnimationFrame(_scrollRAF);

      const info = {};
      if (convertEl) {
        info.convertEl = convertEl;
      } else if (opts.promote && placeholder.parentNode && placeholder.parentNode.matches(opts.promote.containerSelector)) {
        let idx = 0;
        for (const ch of placeholder.parentNode.children) {
          if (ch === placeholder) break;
          if (ch.matches(opts.promote.itemSelector) && ch !== item) idx++;
        }
        info.promoteIndex = idx;
      }

      // A redraw can take the placeholder out mid-drag.
      if (placeholder.parentNode) placeholder.parentNode.insertBefore(item, placeholder);
      placeholder.remove();
      endDrag();

      if (opts.onDrop) opts.onDrop(item, info);
      _flushAfterSort();
    }

    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    beginDrag(e);
  });
}
