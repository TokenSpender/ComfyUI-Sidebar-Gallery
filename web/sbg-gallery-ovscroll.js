import { h } from "./sbg-core.js";

export function attachOverlayScrollbar(scrollEl, wrap, teardown) {
  scrollEl.classList.add("sbg-body--ovscroll");
  const thumb = h("div", { class: "sbg-ovscroll-thumb" });
  wrap.appendChild(thumb);
  const GRAB = 26, FADE = 1100;
  let hideTimer = null, dragging = false, nearEdge = false;

  // Reading the box forces a layout after every hover restyle of the cards, so
  // it is kept until it can have moved.
  let box = null;
  const forgetBox = () => { box = null; };

  const layout = () => {
    const ch = scrollEl.clientHeight, sh = scrollEl.scrollHeight;
    if (sh <= ch + 1) { thumb.classList.add("sbg-hidden"); return; }
    thumb.classList.remove("sbg-hidden");
    const th = Math.max(28, Math.round(ch * ch / sh));
    const top = Math.round((scrollEl.scrollTop / (sh - ch)) * (ch - th));
    thumb.style.height = th + "px";
    thumb.style.transform = `translateY(${top}px)`;
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

  // The sidebar switching sides moves the scroller without the resize the
  // observer below catches.
  wrap.addEventListener("mouseenter", forgetBox);
  wrap.addEventListener("mousemove", (e) => {
    if (!box) box = scrollEl.getBoundingClientRect();
    nearEdge = (box.right - e.clientX) <= GRAB && e.clientY >= box.top && e.clientY <= box.bottom;
    reveal(nearEdge);
  });
  wrap.addEventListener("mouseleave", () => { nearEdge = false; scheduleHide(); });

  thumb.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragging = true; nearEdge = true;
    const startY = e.clientY, startScroll = scrollEl.scrollTop;
    const ch = scrollEl.clientHeight, sh = scrollEl.scrollHeight, th = thumb.offsetHeight;
    const trackRange = ch - th, scrollRange = sh - ch;
    thumb.classList.add("sbg-ovscroll-thumb--show", "sbg-ovscroll-thumb--wide");
    const onMove = (ev) => {
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

  const ro = new ResizeObserver(() => { forgetBox(); layout(); });
  ro.observe(scrollEl);
  ro.observe(scrollEl.firstElementChild);
  teardown.add(() => ro.disconnect());
  requestAnimationFrame(layout);
}
