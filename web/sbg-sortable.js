/**
 * sbg-sortable.js — Pointer-based real-time sortable
 *
 * Items physically reorder as you drag them, like a modern sortable list.
 * Used by both the layout editor and the live metadata panel.
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
 * @param {string} [opts.type] - "section" or "param" — determines default sibling selector
 * @param {string} [opts.itemSelector] - explicit selector for sortable siblings (overrides type default)
 * @param {string} [opts.dropContainerSelector] - cross-container param moves: container selector to detect under cursor
 * @param {string} [opts.groupSelector] - optional inner group element to drop into within a drop container
 * @param {string} [opts.groupClass] - class for a missing inner group (default "sbg-meta-group")
 * @param {Function} [opts.onDrop] - callback(item) after drop
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

    // Insert placeholder where item was
    const actualParent = item.parentNode;
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
          _scrollRAF = requestAnimationFrame(scroll);
        })();
      }
    }

    _sortState = { item, placeholder, container, offsetX, offsetY, selector, getSiblings, opts };

    function onMove(ev) {
      if (!_sortState) return;
      // Move the dragged item with cursor
      item.style.left = (ev.clientX - offsetX) + "px";
      item.style.top = (ev.clientY - offsetY) + "px";

      // Auto-scroll when near container edges
      autoScroll(ev.clientY);

      // Find which sibling we're hovering over and reorder
      // Use 40% threshold (not 50% midpoint) for snappier feel
      
      // For params (cross-section field moves) AND tabs (cross-section tab moves):
      // detect the drop container under the cursor so the item can hop lists.
      let activeContainer = container;
      if (opts.type === "param" || opts.type === "tab") {
        const dropSel = opts.dropContainerSelector || (opts.type === "tab" ? ".sbg-ly3-tablist" : ".sbg-section__body");
        const elUnder = document.elementFromPoint(ev.clientX, ev.clientY);
        if (elUnder) {
          const dropC = elUnder.closest(dropSel);
          if (dropC && dropC !== activeContainer && dropC !== item) {
            if (opts.groupSelector) {
              // Move into an inner group element, creating it if absent
              let tbl = dropC.querySelector(opts.groupSelector);
              if (!tbl) {
                tbl = document.createElement("div");
                tbl.className = opts.groupClass || "sbg-meta-group";
                dropC.appendChild(tbl);
              }
              activeContainer = tbl;
            } else {
              // Drop directly into the container
              activeContainer = dropC;
            }
          }
        }
      }
      
      const siblings = [...activeContainer.querySelectorAll(selector)].filter(s => s !== item && !s.classList.contains("sbg-sortable-placeholder"));

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

      let ref = null; // sibling to insert the placeholder BEFORE; null → append at end
      if (horizontal) {
        for (const sib of siblings) {
          const r = sib.getBoundingClientRect();
          if (ev.clientY < r.top) { ref = sib; break; }                                   // pointer on an earlier row
          if (ev.clientY <= r.bottom && ev.clientX < r.left + r.width / 2) { ref = sib; break; } // same row, left half
        }
      } else {
        for (const sib of siblings) {
          const r = sib.getBoundingClientRect();
          if (ev.clientY < r.top + r.height * 0.4) { ref = sib; break; }
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

    function onUp() {
      if (!_sortState) return;
      if (_scrollRAF) cancelAnimationFrame(_scrollRAF);
      // Place item back into flow where placeholder is
      placeholder.parentNode.insertBefore(item, placeholder);
      placeholder.remove();

      // Reset item styles
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

      if (opts.onDrop) opts.onDrop(item);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
