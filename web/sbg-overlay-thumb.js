import { h } from "./sbg-core.js";

// Firefox ignores the ::-webkit-scrollbar rules that thin and color the
// scrollbars elsewhere in the stylesheet, so there the thumb is drawn instead.
const _needed = /firefox/i.test(navigator.userAgent);

export function attachOverlayThumb(scrollEl) {
  if (!_needed || scrollEl._sbgOvThumb) return;
  scrollEl._sbgOvThumb = true;
  scrollEl.classList.add("sbg-ovscroll-scroller");

  const rail = h("div", { class: "sbg-ovscroll-rail", "aria-hidden": "true" });
  const thumb = h("div", { class: "sbg-ovscroll-thumb" });
  rail.appendChild(thumb);
  scrollEl.prepend(rail);
  const GRAB = 26, FADE = 1100;
  let hideTimer = null, dragging = false, nearEdge = false;

  // Reading the scroller's box forces any pending layout, so the grab band is
  // measured against a held box that is dropped only where it can have moved.
  let box = null;
  const forgetBox = () => { box = null; };
  let measured = false;
  let borderTop = 0;

  const measure = () => {
    const cs = getComputedStyle(scrollEl);
    // The rail sits inside the scroller's padding, so the right padding is
    // taken back out to keep the thumb the same inset from the edge.
    thumb.style.right = (2 - (parseFloat(cs.paddingRight) || 0)) + "px";
    // A zero height rail still takes a row of its own in a grid or flex column,
    // and the negative margin cancels the gap that row would add.
    const gap = parseFloat(cs.rowGap);
    if (gap) rail.style.marginBottom = -gap + "px";
    borderTop = parseFloat(cs.borderTopWidth) || 0;
    measured = true;
  };

  const layout = () => {
    if (!scrollEl.isConnected) return;
    // A scroller that rebuilds its children throws the rail out with them.
    if (rail.parentNode !== scrollEl) scrollEl.prepend(rail);
    if (!measured) measure();
    const ch = scrollEl.clientHeight, sh = scrollEl.scrollHeight;
    if (sh <= ch + 1) { thumb.classList.add("sbg-hidden"); return; }
    thumb.classList.remove("sbg-hidden");
    const th = Math.max(20, Math.round(ch * ch / sh));
    const top = Math.round((scrollEl.scrollTop / (sh - ch)) * (ch - th));
    // The thumb hangs from the sticky rail, so the rail's own offset from the
    // scroller's top comes back out of the travel.
    const railDelta = rail.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - borderTop;
    thumb.style.height = th + "px";
    thumb.style.transform = `translateY(${top - railDelta}px)`;
  };

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!dragging && !nearEdge) thumb.classList.remove("sbg-ovscroll-thumb--show", "sbg-ovscroll-thumb--wide");
    }, FADE);
  };

  const reveal = (wide) => {
    thumb.classList.add("sbg-ovscroll-thumb--show");
    thumb.classList.toggle("sbg-ovscroll-thumb--wide", !!wide || dragging);
    if (!dragging) scheduleHide();
  };

  const show = (wide) => { layout(); reveal(wide); };

  scrollEl.addEventListener("scroll", () => show(nearEdge), { passive: true });
  // The scroller can move without resizing, as when the sidebar changes sides,
  // and the pointer arriving is the first chance to notice.
  scrollEl.addEventListener("mouseenter", forgetBox);
  scrollEl.addEventListener("mousemove", (e) => {
    if (!box) box = scrollEl.getBoundingClientRect();
    nearEdge = (box.right - e.clientX) <= GRAB;
    reveal(nearEdge);
  });
  scrollEl.addEventListener("mouseleave", () => { nearEdge = false; scheduleHide(); });

  thumb.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragging = true; nearEdge = true;
    const startY = e.clientY, startScroll = scrollEl.scrollTop;
    const ch = scrollEl.clientHeight, sh = scrollEl.scrollHeight, th = thumb.offsetHeight;
    const trackRange = ch - th, scrollRange = sh - ch;
    thumb.classList.add("sbg-ovscroll-thumb--show", "sbg-ovscroll-thumb--wide");
    const onMove = (ev) => {
      // A release outside the window sends no mouseup, so a move with no
      // button held ends the drag.
      if (ev.buttons === 0) { onUp(); return; }
      if (trackRange > 0) scrollEl.scrollTop = startScroll + (ev.clientY - startY) * (scrollRange / trackRange);
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scheduleHide();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Both observers only keep the thumb current between scrolls, so a browser
  // without them still has it laid out on every scroll.
  let ro = null, mo = null;

  // No caller disposes a scroller, so the observers let go once it leaves the
  // page, which the resize observer hears as a resize to nothing.
  const release = () => {
    if (ro) { ro.disconnect(); ro = null; }
    if (mo) { mo.disconnect(); mo = null; }
    delete scrollEl._sbgOvThumb;
  };
  const onResize = () => {
    forgetBox();
    if (scrollEl.isConnected) { layout(); return; }

    setTimeout(() => { if (!scrollEl.isConnected) release(); }, 0);
  };

  try {
    ro = new ResizeObserver(onResize);
    ro.observe(scrollEl);
  } catch { }

  // New children change the scroll height without resizing the scroller.
  try {
    mo = new MutationObserver(layout);
    mo.observe(scrollEl, { childList: true });
  } catch { }
  requestAnimationFrame(layout);
}
