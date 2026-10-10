// `inverted` is for a handle on the far side of what it sizes, where moving
// towards the origin grows it, as on the lightbox's metadata panel.
export function attachSplitter(handle, { min, max, inverted = false, axis = "x", size, apply, done }) {
  const coord = (e) => (axis === "y" ? e.clientY : e.clientX);
  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    if (dragging) return;
    e.preventDefault();
    dragging = true;
    // The stylesheet keeps the handle lit by this while the pointer is away from it.
    handle.classList.add("sbg-splitter--dragging");
    const start = coord(e);
    const startSize = size();
    const onMove = (ev) => {
      if (!dragging) return;
      // No button held means the release never reached the page, as when
      // focus was taken mid drag, so the drag ends there.
      if (ev.buttons === 0) { onUp(); return; }
      const delta = inverted ? start - coord(ev) : coord(ev) - start;
      apply(Math.min(max, Math.max(min, startSize + delta)));
    };
    const onUp = () => {
      dragging = false;
      handle.classList.remove("sbg-splitter--dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const s = size();
      if (s !== startSize) done(s);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
