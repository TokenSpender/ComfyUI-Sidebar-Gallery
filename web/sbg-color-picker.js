/**
 * sbg-color-picker.js — Reusable HSL + opacity color picker component
 *
 * Provides createColorPicker() for a consistent color-picker UI *with an alpha
 * channel*. Used by both Appearance settings and the Layout Editor pickers, so
 * colours behave identically everywhere. Depends only on sbg-core.js.
 *
 * Colours round-trip through the canonical model in sbg-core (parseColor /
 * formatColor): plain hex when fully opaque, rgba() when translucent — so the
 * picker can finally show and edit the subtle translucent defaults.
 */

import {
  h,
  parseColor, formatColor, formatRgba, rgbToHsl, hslToRgb, checkerBg,
  getSavedColors, saveSavedColors,
} from "./sbg-core.js";

// Show a (possibly translucent) colour over a checkerboard so transparency reads.
const withChecker = checkerBg;

/**
 * Create an HSL + opacity color picker panel.
 *
 * @param {Object} options
 * @param {string} options.initialColor - Starting colour (hex or rgba)
 * @param {Function} options.onChange - Called with the canonical colour string on every change
 * @param {number} [options.slWidth=196] / [options.slHeight=150] / [options.hueHeight=14]
 * @param {boolean} [options.showPreview=true] / [options.showSaved=true]
 * @param {number} [options.savedChipSize=20]
 * @returns {{ panel: HTMLElement, destroy: Function, setColor: Function, init: Function }}
 */
export function createColorPicker(options) {
  const {
    initialColor = "#7c6aef",
    onChange = () => {},
    slWidth: SL_W = 232,
    slHeight: SL_H = 150,
    hueHeight: HUE_H = 14,
    showPreview = true,
    showSaved = true,
    savedChipSize = 20,
  } = options;

  // Parse the initial colour into HSL + alpha (falls back to the accent purple).
  let cH, cS, cL, cA;
  { const pc = parseColor(initialColor) || parseColor("#7c6aef"); [cH, cS, cL] = rgbToHsl(pc.r, pc.g, pc.b); cA = pc.a; }
  const curStr = () => { const [r, g, b] = hslToRgb(cH, cS, cL); return formatColor(r, g, b, cA); };
  // Always-rgba string for the text field DISPLAY only. The committed value stays
  // canonical via curStr/formatColor (hex when opaque); the user asked the input
  // to always read as rgba(...).
  const curRgbaStr = () => { const [r, g, b] = hslToRgb(cH, cS, cL); return formatRgba(r, g, b, cA); };
  let currentColor = curStr();

  // Two columns: controls on the left, saved colours stacked in the space to the
  // right of the palette (they used to sit below it, leaving that space empty).
  const panel = h("div", { class: "sbg-color-picker", style: "display:flex;gap:10px;align-items:flex-start;" });
  const col = h("div", { class: "sbg-cp-main", style: "display:flex;flex-direction:column;" });
  panel.appendChild(col);

  // ── Saturation / Lightness canvas ──
  const slCanvas = document.createElement("canvas");
  slCanvas.width = SL_W; slCanvas.height = SL_H;
  slCanvas.style.cssText = `width:${SL_W}px;height:${SL_H}px;border-radius:6px;cursor:crosshair;display:block;margin-bottom:8px;`;
  const slCtx = slCanvas.getContext("2d");
  const slCursor = h("div", { style: "position:absolute;width:12px;height:12px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 3px rgba(0,0,0,0.5);pointer-events:none;transform:translate(-6px,-6px);" });
  const slWrap = h("div", { style: "position:relative;display:inline-block;" });
  slWrap.appendChild(slCanvas); slWrap.appendChild(slCursor);
  col.appendChild(slWrap);

  function drawSL() {
    for (let x = 0; x < SL_W; x++) {
      for (let y = 0; y < SL_H; y++) {
        slCtx.fillStyle = `hsl(${cH},${(x / SL_W) * 100}%,${100 - (y / SL_H) * 100}%)`;
        slCtx.fillRect(x, y, 1, 1);
      }
    }
    slCursor.style.left = (cS / 100 * SL_W) + "px";
    slCursor.style.top = ((100 - cL) / 100 * SL_H) + "px";
  }
  function pickSL(e) {
    const rect = slCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(SL_W - 1, e.clientX - rect.left));
    const y = Math.max(0, Math.min(SL_H - 1, e.clientY - rect.top));
    cS = Math.round((x / SL_W) * 100);
    cL = Math.round(100 - (y / SL_H) * 100);
    slCursor.style.left = x + "px"; slCursor.style.top = y + "px";
    _apply();
  }
  let slDrag = false;
  const onSlDown = (e) => { slDrag = true; pickSL(e); };
  const onSlMove = (e) => { if (slDrag) pickSL(e); };
  const onSlUp = () => { slDrag = false; };
  slCanvas.addEventListener("mousedown", onSlDown);
  document.addEventListener("mousemove", onSlMove);
  document.addEventListener("mouseup", onSlUp);

  // ── Hue bar ──
  const HUE_W = SL_W;
  const hueCanvas = document.createElement("canvas");
  hueCanvas.width = HUE_W; hueCanvas.height = HUE_H;
  hueCanvas.style.cssText = `width:${HUE_W}px;height:${HUE_H}px;border-radius:7px;cursor:crosshair;display:block;margin-bottom:8px;`;
  const hueCtx = hueCanvas.getContext("2d");
  const hueCursor = h("div", { style: "position:absolute;top:-1px;width:4px;height:" + (HUE_H + 2) + "px;border:2px solid #fff;border-radius:3px;box-shadow:0 0 3px rgba(0,0,0,0.5);pointer-events:none;transform:translateX(-2px);" });
  const hueWrap = h("div", { style: "position:relative;display:inline-block;" });
  hueWrap.appendChild(hueCanvas); hueWrap.appendChild(hueCursor);
  col.appendChild(hueWrap);

  function drawHue() {
    const grad = hueCtx.createLinearGradient(0, 0, HUE_W, 0);
    for (let i = 0; i <= 360; i += 30) grad.addColorStop(i / 360, `hsl(${i},100%,50%)`);
    hueCtx.fillStyle = grad; hueCtx.fillRect(0, 0, HUE_W, HUE_H);
    hueCursor.style.left = (cH / 360 * HUE_W) + "px";
  }
  function pickHue(e) {
    const rect = hueCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(HUE_W - 1, e.clientX - rect.left));
    cH = Math.round((x / HUE_W) * 360);
    drawSL(); drawHue(); _apply();
  }
  let hueDrag = false;
  const onHueDown = (e) => { hueDrag = true; pickHue(e); };
  const onHueMove = (e) => { if (hueDrag) pickHue(e); };
  const onHueUp = () => { hueDrag = false; };
  hueCanvas.addEventListener("mousedown", onHueDown);
  document.addEventListener("mousemove", onHueMove);
  document.addEventListener("mouseup", onHueUp);

  // ── Opacity slider ──
  const opRow = h("div", { style: `display:flex;align-items:center;gap:8px;width:${SL_W}px;margin-bottom:10px;` });
  const opRange = h("input", { type: "range", min: "0", max: "100", value: String(Math.round(cA * 100)), class: "sbg-cp-opacity", style: "flex:1;" });
  const opVal = h("span", { style: "font-size:10px;opacity:0.7;min-width:30px;text-align:right;", text: Math.round(cA * 100) + "%" });
  opRow.appendChild(h("span", { style: "font-size:10px;opacity:0.5;", text: "Opacity" }));
  opRow.appendChild(opRange); opRow.appendChild(opVal);
  opRange.addEventListener("input", () => { cA = (parseInt(opRange.value, 10) || 0) / 100; _apply(); });
  col.appendChild(opRow);

  // ── Preview + colour input ──
  let preview = null, hexInp = null;
  // Commit the typed hex value. Declared at picker scope (not only inside the
  // showPreview block) so the returned `commit` can flush a pending edit when the
  // host tears the picker down — layout-editor popovers are *removed* on
  // outside-click, which can pre-empt the input's own change/blur event.
  let _hexDirty = false;       // user has typed since the last apply
  let commitHex = () => {};    // real impl assigned below once the input exists
  if (showPreview) {
    const previewRow = h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px;" });
    preview = h("div", { style: "width:32px;height:32px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);flex-shrink:0;" });
    preview.style.background = withChecker(currentColor);
    hexInp = h("input", { type: "text", class: "sbg-gs-input sbg-gs-input--sm", value: curRgbaStr(), style: "flex:1;font-family:monospace;font-size:12px;" });
    commitHex = () => {
      if (!_hexDirty) return;  // nothing typed — don't re-apply on a plain teardown
      _hexDirty = false;
      const pc = parseColor(hexInp.value.trim());
      if (pc) { [cH, cS, cL] = rgbToHsl(pc.r, pc.g, pc.b); cA = pc.a; drawSL(); drawHue(); _apply(); }
      else { hexInp.value = currentColor; }  // revert invalid input to the last valid colour
    };
    hexInp.addEventListener("input", () => { _hexDirty = true; });
    // `change` fires on blur (clicking another control or outside) and on Enter.
    hexInp.addEventListener("change", commitHex);
    hexInp.addEventListener("keydown", (e) => { if (e.key === "Enter") commitHex(); });
    previewRow.appendChild(preview); previewRow.appendChild(hexInp);
    col.appendChild(previewRow);
  }

  // ── Saved colours (right column, fills the space beside the palette) ──
  if (showSaved) {
    const savedCol = h("div", { class: "sbg-cp-saved", style: "display:flex;flex-direction:column;align-items:center;gap:5px;max-height:230px;overflow-y:auto;overflow-x:hidden;padding:2px;" });
    const savedLabel = h("div", { style: "font-size:10px;opacity:0.5;text-align:center;", text: "Saved" });
    const saveBtn = h("button", { class: "sbg-btn sbg-btn--sm", text: "+", title: "Save current colour", style: "font-size:13px;line-height:1;padding:1px 7px;" });
    const chipsWrap = h("div", { style: `display:flex;flex-direction:column;align-items:center;gap:7px;min-height:${savedChipSize}px;` });
    function renderSaved() {
      chipsWrap.innerHTML = "";
      for (const sc of getSavedColors()) {
        const chip = h("div", { style: `position:relative;width:${savedChipSize}px;height:${savedChipSize}px;border-radius:4px;background:${withChecker(sc)};cursor:pointer;border:1px solid rgba(255,255,255,0.1);flex-shrink:0;`, title: sc });
        // Explicit × remove. Sits INSIDE the chip's top-right corner (not
        // overhanging) so the saved-list scrollbar / overflow can't clip or hide it.
        const x = h("span", { text: "×", title: "Remove", style: "position:absolute;top:0;right:0;width:14px;height:14px;line-height:13px;text-align:center;font-size:12px;border-radius:0 4px 0 4px;background:rgba(0,0,0,0.65);color:#fff;cursor:pointer;opacity:0;transition:opacity 0.1s;" });
        x.addEventListener("click", (e) => { e.stopPropagation(); saveSavedColors(getSavedColors().filter(v => v !== sc)); renderSaved(); });
        chip.addEventListener("mouseenter", () => { x.style.opacity = "1"; });
        chip.addEventListener("mouseleave", () => { x.style.opacity = "0"; });
        chip.addEventListener("click", () => { const pc = parseColor(sc); if (pc) { [cH, cS, cL] = rgbToHsl(pc.r, pc.g, pc.b); cA = pc.a; drawSL(); drawHue(); } _apply(); });
        chip.appendChild(x);
        chipsWrap.appendChild(chip);
      }
    }
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const arr = getSavedColors();
      if (!arr.includes(currentColor)) { arr.unshift(currentColor); saveSavedColors(arr); renderSaved(); }
    });
    savedCol.appendChild(savedLabel); savedCol.appendChild(saveBtn); savedCol.appendChild(chipsWrap);
    panel.appendChild(savedCol);
    panel._renderSaved = renderSaved;
  }

  // ── Apply colour everywhere ──
  function _apply() {
    currentColor = curStr();
    if (preview) preview.style.background = withChecker(currentColor);
    // Programmatic value set — not a user edit, so clear the dirty flag. Display
    // is always rgba(...); the committed value (currentColor) stays canonical.
    if (hexInp) { hexInp.value = curRgbaStr(); _hexDirty = false; }
    opRange.value = String(Math.round(cA * 100));
    opVal.textContent = Math.round(cA * 100) + "%";
    onChange(currentColor);
  }

  /** Programmatically set the picker to a new colour (hex or rgba). */
  function setColor(color) {
    const pc = parseColor(color);
    if (pc) { [cH, cS, cL] = rgbToHsl(pc.r, pc.g, pc.b); cA = pc.a; drawSL(); drawHue(); _apply(); }
  }
  /** Initial draw (no onChange fired). */
  function init() { drawSL(); drawHue(); if (panel._renderSaved) panel._renderSaved(); }
  /** Remove document-level listeners to prevent leaks. */
  function destroy() {
    document.removeEventListener("mousemove", onSlMove);
    document.removeEventListener("mouseup", onSlUp);
    document.removeEventListener("mousemove", onHueMove);
    document.removeEventListener("mouseup", onHueUp);
  }

  return { panel, destroy, setColor, init, commit: commitHex };
}
