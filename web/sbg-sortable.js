/**
 * sbg-sortable.js: Pointer-based real-time sortable
 *
 * Items physically reorder as you drag them, like a modern sortable list.
 * The layout editor drives it for sections, tabs, and fields.
 * No external dependencies.
 */

let _sortState = null;

/**
 * Make an item sortable within a container via a drag handle.
 *
 * @param {HTMLElement} container - Parent element containing sortable children
 * @param {HTMLElement} handle - The drag handle element (mousedown target)
 * @param {HTMLElement} item - The draggable item element
 * @param {Object} [opts]
 * @param {string} [opts.type] - "section" or "param"; determines the default sibling selector
 * @param {string} [opts.itemSelector] - explicit selector for sortable siblings (overrides type default)
 * @param {string} [opts.dropContainerSelector] - cross-container param/tab moves: container selector to detect under cursor
 * @param {Object} [opts.convertTargets] - drop-INTO targets: {selector, accepts(el, item), band, className}.
 *   While the cursor is over a matching element (inside the vertical band, a
 *   [lo, hi] fraction of its height), the element is highlighted and the drop
 *   reports it via info.convertEl instead of reordering.
 * @param {Object} [opts.promote] - gap-promote zones: {containerSelector, itemSelector}.
 *   When the cursor is over the container but no drop list or convert target
 *   claims it, the placeholder is positioned BETWEEN the container's items and
 *   the drop reports that position via info.promoteIndex.
 * @param {Function} [opts.onDrop] - callback(item, info) after drop. info carries
 *   {convertEl} or {promoteIndex} when one of those zones took the drop, and is
 *   empty for a plain reorder or cross-list move.
 */
export function initSortable(container, handle, item, opts = {}) {
  handle.style.cursor = "grab";

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = item.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    // Create placeholder
    const placeholder = document.createElement("div");
    placeholder.className = "sbg-sortable-placeholder";
    placeholder.style.height = rect.height + "px";
    placeholder.style.margin = getComputedStyle(item).margin;

    // Position the item as fixed overlay
    const origWidth = rect.width;
    item.style.position = "fixed";
    item.style.zIndex = "999999";
    item.style.width = origWidth + "px";
    item.style.left = rect.left + "px";
    item.style.top = rect.top + "px";
    item.style.opacity = "0.92";
    item.style.boxShadow = "0 8px 32px rgba(0,0,0,0.4)";
    item.style.pointerEvents = "none";
    item.style.transition = "none";
    item.classList.add("sbg-sortable--dragging");
    // Mark the drag type on <body> so drop targets (e.g. empty tab-lists) can reveal
    // themselves only while a drag of that kind is in progress.
    document.body.classList.add("sbg-dragging-" + (opts.type || "item"));

    // Insert placeholder where item was. homeNext is the item's original
    // following sibling, so an abandoned drag can put it back exactly.
    const actualParent = item.parentNode;
    const homeNext = item.nextSibling;
    actualParent.insertBefore(placeholder, item);

    // Get sortable siblings (exclude the dragged item)
    const selector = opts.itemSelector || (opts.type === "param" ? "[data-type='param']" : ".sbg-section");
    const getSiblings = () => [...container.querySelectorAll(selector)].filter(s => s !== item && !s.classList.contains("sbg-sortable-placeholder"));

    // Find the scrollable ancestor for auto-scroll
    let scrollParent = container.parentElement;
    while (scrollParent && scrollParent !== document.body) {
      const ov = getComputedStyle(scrollParent).overflowY;
      if (ov === "auto" || ov === "scroll") break;
      scrollParent = scrollParent.parentElement;
    }
    if (!scrollParent) scrollParent = document.documentElement;

    let _scrollRAF = null;
    const SCROLL_EDGE = 50; // px from edge to trigger auto-scroll
    const SCROLL_SPEED = 8; // px per frame

    let _lastX = 0, _lastY = 0; // last real cursor position, for re-testing during auto-scroll

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
          // The cursor is stationary while auto-scrolling, so no mousemove fires.
          // Re-run the hit test against the scrolled content so the convert
          // highlight and placeholder track the section now under the pointer.
          evaluate(_lastX, _lastY);
          _scrollRAF = requestAnimationFrame(scroll);
        })();
      }
    }

    // Convert-target state: the element currently highlighted as a drop-INTO
    // target, if any. Cleared whenever the cursor leaves it.
    let convertEl = null;
    const convertClass = (opts.convertTargets && opts.convertTargets.className) || "sbg-sortable-dropinto";
    function clearConvert() {
      if (convertEl) { convertEl.classList.remove(convertClass); convertEl = null; }
    }

    _sortState = { item, placeholder, container, offsetX, offsetY, selector, getSiblings, opts };

    function onMove(ev) {
      if (!_sortState) return;
      // A mouseup delivered outside the window never reaches our listener, and a
      // synthetic mousemove from other page code carries no button. Either way a
      // move with no button held means this is not a live user gesture, so ABANDON
      // the drag (revert, no drop) rather than commit something unintended.
      if (ev.buttons === 0) { cancelDrag(); return; }
      _lastX = ev.clientX; _lastY = ev.clientY;
      // Move the dragged item with cursor
      item.style.left = (ev.clientX - offsetX) + "px";
      item.style.top = (ev.clientY - offsetY) + "px";
      // Auto-scroll when near container edges
      autoScroll(ev.clientY);
      evaluate(ev.clientX, ev.clientY);
    }

    // Position the placeholder / pick a convert target for a cursor position.
    // Called from onMove and, with the last cursor position, from the auto-scroll
    // loop so a stationary cursor keeps tracking the scrolled content.
    // Uses a 40% threshold (not the 50% midpoint) for a snappier reorder feel.
    function evaluate(clientX, clientY) {
      if (!_sortState) return;
      const elUnder = document.elementFromPoint(clientX, clientY);

      // For params (cross-section field moves) AND tabs (cross-section tab moves):
      // detect the drop container under the cursor so the item can hop lists.
      // A hovered drop list always wins over convert targets and promote zones.
      let activeContainer = container;
      let overDropList = false;
      if ((opts.type === "param" || opts.type === "tab") && opts.dropContainerSelector && elUnder) {
        const dropC = elUnder.closest(opts.dropContainerSelector);
        if (dropC) overDropList = true;
        if (dropC && dropC !== activeContainer && dropC !== item) activeContainer = dropC;
      }

      // Drop-INTO target: hovering a matching card (inside its vertical band)
      // highlights it and the drop converts the item instead of reordering. The
      // band leaves the card's edges to plain reorder or gap-promote placement.
      if (opts.convertTargets && !overDropList && elUnder) {
        const ct = opts.convertTargets;
        const t = elUnder.closest(ct.selector);
        if (t && t !== item && !t.contains(item) && (!ct.accepts || ct.accepts(t, item))) {
          const r = t.getBoundingClientRect();
          const frac = (clientY - r.top) / Math.max(1, r.height);
          const band = ct.band || [0, 1];
          if (frac >= band[0] && frac <= band[1]) {
            if (convertEl !== t) { clearConvert(); convertEl = t; t.classList.add(convertClass); }
            // Leave the placeholder in flow (do not hide it): hiding removes its
            // reserved height, which shifts the cards under the cursor and makes
            // the band test flip between convert and reorder on every frame. Clear
            // its promote caption so a merge target and a gap hint never show at once.
            placeholder.classList.remove("sbg-sortable-placeholder--promote");
            return;
          }
        }
      }
      clearConvert();

      // Gap-promote zone: the cursor is over the promote container but no drop
      // list or convert target claimed it, so position the placeholder between
      // the container's items (e.g. a tab about to become its own section).
      // Hovering the item's OWN card is exempt, so reordering inside it keeps
      // the placeholder where it was rather than jumping out to a gap.
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
      placeholder.classList.toggle("sbg-sortable-placeholder--promote", promoting);

      const siblings = [...activeContainer.querySelectorAll(placeSelector)].filter(s => s !== item && !s.classList.contains("sbg-sortable-placeholder"));

      // Detect flow orientation from the first two siblings. Horizontally-wrapped
      // lists (e.g. the layout editor's field chips) share a row, so a Y-only test
      // is identical for every same-row sibling and the placeholder can only ever
      // land at the very start or end. Those need an X-aware (reading-order) test.
      // Vertically-stacked lists (sections, kv rows) keep the Y-threshold test.
      let horizontal = false;
      if (siblings.length >= 2) {
        const a = siblings[0].getBoundingClientRect();
        const b = siblings[1].getBoundingClientRect();
        horizontal = (b.left > a.left + 1) && (Math.abs(b.top - a.top) < Math.min(a.height, b.height) * 0.6);
      }

      let ref = null; // sibling to insert the placeholder BEFORE; null appends at the end
      if (horizontal) {
        for (const sib of siblings) {
          const r = sib.getBoundingClientRect();
          if (clientY < r.top) { ref = sib; break; }                                   // pointer on an earlier row
          if (clientY <= r.bottom && clientX < r.left + r.width / 2) { ref = sib; break; } // same row, left half
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
        activeContainer.appendChild(placeholder); // empty target container
      }
    }

    // Shared teardown: restore the dragged item's inline styles and drop the
    // document listeners. The caller has already cancelled the auto-scroll RAF.
    function endDrag() {
      clearConvert();
      item.style.position = "";
      item.style.zIndex = "";
      item.style.width = "";
      item.style.left = "";
      item.style.top = "";
      item.style.opacity = "";
      item.style.boxShadow = "";
      item.style.pointerEvents = "";
      item.style.transition = "";
      item.classList.remove("sbg-sortable--dragging");
      document.body.classList.remove("sbg-dragging-" + (opts.type || "item"));
      _sortState = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    // Abandon the drag: put the item back where it started and fire no drop.
    function cancelDrag() {
      if (!_sortState) return;
      if (_scrollRAF) cancelAnimationFrame(_scrollRAF);
      placeholder.remove();
      actualParent.insertBefore(item, homeNext);
      endDrag();
    }

    function onUp() {
      if (!_sortState) return;
      if (_scrollRAF) cancelAnimationFrame(_scrollRAF);

      // Report what kind of zone took the drop. A highlighted convert target
      // wins; otherwise a placeholder parked in the promote container reports
      // its position among that container's items.
      const info = {};
      if (convertEl) {
        info.convertEl = convertEl;
      } else if (opts.promote && placeholder.parentNode && placeholder.parentNode.matches
        && placeholder.parentNode.matches(opts.promote.containerSelector)) {
        let idx = 0;
        for (const ch of placeholder.parentNode.children) {
          if (ch === placeholder) break;
          if (ch.matches && ch.matches(opts.promote.itemSelector) && ch !== item) idx++;
        }
        info.promoteIndex = idx;
      }

      // Place item back into flow where the placeholder is. An async re-render
      // (e.g. a late sample-metadata fetch repainting the editor) can detach the
      // placeholder mid-drag; guard so cleanup still runs instead of throwing.
      if (placeholder.parentNode) placeholder.parentNode.insertBefore(item, placeholder);
      placeholder.remove();
      endDrag();

      if (opts.onDrop) opts.onDrop(item, info);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
