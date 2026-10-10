import { h } from "./sbg-core.js";
import { parseColor, formatRgba, rgbToHsl, hslToRgb, checkerBg, getSavedColors, saveSavedColors } from "./sbg-color.js";
import { attachOverlayThumb } from "./sbg-overlay-thumb.js";
import { CLOSE_ICON, PLUS_ICON, sizedIcon } from "./sbg-icons.js";
import { showFailure } from "./sbg-toast.js";

// The saved colours live in this browser's own store, which refuses a write
// only when site data is blocked or the store is full.
const _STORE_REFUSED = "this browser is blocking site data or its storage is full";

const SL_W = 232, SL_H = 150, HUE_H = 14;

// Saturation across and lightness down for one hue. The hue is painted at half
// lightness and washed to white above the middle row and to black below it.
// Each gradient starts half a pixel in so a pixel's centre takes the colour its
// own position names.
export function drawSquare(ctx, hue) {
  const across = ctx.createLinearGradient(0.5, 0, SL_W + 0.5, 0);
  across.addColorStop(0, `hsl(${hue}, 0%, 50%)`);
  across.addColorStop(1, `hsl(${hue}, 100%, 50%)`);
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, SL_W, SL_H);
  const down = ctx.createLinearGradient(0, 0.5, 0, SL_H + 0.5);
  down.addColorStop(0, "rgba(255, 255, 255, 1)");
  down.addColorStop(0.5, "rgba(255, 255, 255, 0)");
  down.addColorStop(0.5, "rgba(0, 0, 0, 0)");
  down.addColorStop(1, "rgba(0, 0, 0, 1)");
  ctx.fillStyle = down;
  ctx.fillRect(0, 0, SL_W, SL_H);
}

function _dragOn(canvas, pick) {
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pick(e); });
  canvas.addEventListener("pointermove", (e) => { if (canvas.hasPointerCapture(e.pointerId)) pick(e); });
}

export function createColorPicker({ initialColor, onChange }) {
  let cH, cS, cL, cA;
  const take = (pc) => { [cH, cS, cL] = rgbToHsl(pc.r, pc.g, pc.b); cA = pc.a; };
  take(parseColor(initialColor) || parseColor("#f2ff59"));
  const current = () => { const [r, g, b] = hslToRgb(cH, cS, cL); return formatRgba(r, g, b, cA); };
  let currentColor = current();

  const panel = h("div", { class: "sbg-color-picker" });
  const col = h("div", { class: "sbg-cp-main" });
  panel.appendChild(col);

  const slCanvas = h("canvas", { class: "sbg-cp-square", width: SL_W, height: SL_H });
  const slCtx = slCanvas.getContext("2d");
  const slCursor = h("div", { class: "sbg-cp-sl-cursor" });
  col.appendChild(h("div", { class: "sbg-cp-canvas-wrap" }, [slCanvas, slCursor]));

  function drawSL() {
    drawSquare(slCtx, cH);
    slCursor.style.left = (cS / 100 * SL_W) + "px";
    slCursor.style.top = ((100 - cL) / 100 * SL_H) + "px";
  }
  _dragOn(slCanvas, (e) => {
    const rect = slCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(SL_W - 1, e.clientX - rect.left));
    const y = Math.max(0, Math.min(SL_H - 1, e.clientY - rect.top));
    cS = Math.round((x / SL_W) * 100);
    cL = Math.round(100 - (y / SL_H) * 100);
    slCursor.style.left = x + "px"; slCursor.style.top = y + "px";
    _apply();
  });

  const hueCanvas = h("canvas", { class: "sbg-cp-hue", width: SL_W, height: HUE_H });
  const hueCtx = hueCanvas.getContext("2d");
  const hueCursor = h("div", { class: "sbg-cp-hue-cursor" });
  col.appendChild(h("div", { class: "sbg-cp-canvas-wrap" }, [hueCanvas, hueCursor]));

  function drawHue() {
    const grad = hueCtx.createLinearGradient(0, 0, SL_W, 0);
    for (let i = 0; i <= 360; i += 30) grad.addColorStop(i / 360, `hsl(${i},100%,50%)`);
    hueCtx.fillStyle = grad; hueCtx.fillRect(0, 0, SL_W, HUE_H);
    hueCursor.style.left = (cH / 360 * SL_W) + "px";
  }
  _dragOn(hueCanvas, (e) => {
    const rect = hueCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(SL_W - 1, e.clientX - rect.left));
    cH = Math.round((x / SL_W) * 360);
    drawSL(); drawHue(); _apply();
  });

  const opRange = h("input", { type: "range", min: "0", max: "100", value: String(Math.round(cA * 100)), class: "sbg-cp-opacity" });
  const opVal = h("span", { class: "sbg-cp-opval", text: Math.round(cA * 100) + "%" });
  opRange.addEventListener("input", () => { cA = (parseInt(opRange.value, 10) || 0) / 100; _apply(); });
  col.appendChild(h("div", { class: "sbg-cp-oprow" }, [h("span", { class: "sbg-cp-oplabel", text: "Opacity" }), opRange, opVal]));

  const preview = h("div", { class: "sbg-cp-preview" });
  preview.style.background = checkerBg(currentColor);
  const colorInp = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm sbg-cp-input", value: currentColor });
  let _colorDirty = false;
  // Typed text is read on Enter or on leaving the field, since a half typed
  // colour parses as something else. A caller closing the picker runs it as
  // `commit`, because the field's change event may never fire.
  const commitTyped = () => {
    if (!_colorDirty) return;
    _colorDirty = false;
    const pc = parseColor(colorInp.value.trim());
    if (pc) { take(pc); drawSL(); drawHue(); _apply(); }
    else { colorInp.value = currentColor; }
  };
  // Cancelling clears the flag as well as skipping the commit, because focus
  // returning to the opener fires the field's change event on the way out.
  const discardTyped = () => {
    _colorDirty = false;
    colorInp.value = currentColor;
  };
  colorInp.addEventListener("input", () => { _colorDirty = true; });
  colorInp.addEventListener("change", commitTyped);
  colorInp.addEventListener("keydown", (e) => { if (e.key === "Enter") commitTyped(); });
  col.appendChild(h("div", { class: "sbg-cp-preview-row" }, [preview, colorInp]));

  const savedCol = h("div", { class: "sbg-cp-saved" });
  attachOverlayThumb(savedCol);
  const saveBtn = h("button", { type: "button", class: "sbg-btn sbg-btn--sm sbg-cp-savebtn", html: PLUS_ICON, title: "Save current color", "aria-label": "Save current color" });
  const chipsWrap = h("div", { class: "sbg-cp-chips" });
  function renderSaved() {
    chipsWrap.innerHTML = "";
    for (const sc of getSavedColors()) {
      const chip = h("button", { type: "button", class: "sbg-cp-chip", title: sc, "aria-label": `Use the saved color ${sc}` });
      chip.style.background = checkerBg(sc);
      chip.addEventListener("click", () => { const pc = parseColor(sc); if (pc) { take(pc); drawSL(); drawHue(); } _apply(); });
      // Beside the chip instead of inside it, since a button cannot hold
      // another, and inside the wrapper so the saved list cannot clip it.
      const x = h("button", { type: "button", class: "sbg-cp-chipx", html: sizedIcon(CLOSE_ICON, 9), title: "Remove", "aria-label": `Remove the saved color ${sc}` });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!saveSavedColors(getSavedColors().filter(v => v !== sc))) showFailure("remove the saved color", _STORE_REFUSED);
        renderSaved();
      });
      chipsWrap.appendChild(h("span", { class: "sbg-cp-chipwrap" }, [chip, x]));
    }
  }
  saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const arr = getSavedColors();
    if (arr.includes(currentColor)) return;
    arr.unshift(currentColor);
    if (!saveSavedColors(arr)) showFailure("save the color", _STORE_REFUSED);
    renderSaved();
  });
  savedCol.append(h("div", { class: "sbg-cp-savedlabel", text: "Saved" }), saveBtn, chipsWrap);
  panel.appendChild(savedCol);

  function _apply() {
    currentColor = current();
    preview.style.background = checkerBg(currentColor);
    colorInp.value = currentColor;
    _colorDirty = false;
    opRange.value = String(Math.round(cA * 100));
    opVal.textContent = Math.round(cA * 100) + "%";
    onChange(currentColor);
  }

  function init() { drawSL(); drawHue(); renderSaved(); }

  return { panel, init, commit: commitTyped, discard: discardTyped };
}
