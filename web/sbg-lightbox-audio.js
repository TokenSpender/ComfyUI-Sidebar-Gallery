import { h, api } from "./sbg-core.js";
import { fileUrl, fileVersion } from "./sbg-media-kind.js";
import { failureText } from "./sbg-toast.js";
import { AUDIO_ICON, PLAY_ICON, PAUSE_ICON, VOLUME_ICON, VOLUME_MUTED_ICON, sizedIcon } from "./sbg-icons.js";

// Volume and mute carry from one file to the next, video included.
export const mediaState = { volume: 1, muted: false };

const _PLAY_SVG = sizedIcon(PLAY_ICON, 18);

function _fmtAudioTime(s) {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function createAudioPane({ item: it, insertMedia, swapIn, setCurrentMedia, isStale }) {
  const wrap = h("div", { class: "sbg-lb__audio-wrap sbg-lb__staged" });
  wrap.dataset.sbgMedia = "audio";
  wrap.dataset.sbgPending = "1";

  const audio = h("audio", { autoplay: "true", preload: "auto" });
  audio.volume = mediaState.volume;
  audio.muted = mediaState.muted;
  const _toggle = () => {
    if (audio.paused) {
      const p = audio.play();
      // A refused autoplay or a pause that lands first rejects this, and both are expected.
      if (p && p.catch) p.catch(() => { });
    } else {
      audio.pause();
    }
  };

  const stage = h("div", { class: "sbg-lb__audio-stage" });
  stage.addEventListener("click", _toggle);
  const icon = h("div", { class: "sbg-lb__icon-pane sbg-lb__icon-pane--audio", html: AUDIO_ICON });
  stage.appendChild(icon);

  const scrub = h("canvas", { class: "sbg-lb__audio-scrub" });
  let peaks = null;
  let accent = "";
  const readAccent = () => {
    // Off the page the read answers nothing, so it waits for a draw on the page.
    if (!scrub.isConnected) return;
    accent = getComputedStyle(scrub).getPropertyValue("--sbg-accent").trim();
  };
  const drawWave = () => {
    if (!scrub.isConnected) return;
    const w = scrub.clientWidth, hgt = scrub.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (scrub.width !== Math.round(w * dpr)) { scrub.width = Math.round(w * dpr); scrub.height = Math.round(hgt * dpr); }
    const ctx = scrub.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (!accent) readAccent();
    const frac = isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    const n = peaks ? peaks.length : 120;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const lvl = peaks ? peaks[i] : 0.3;
      const half = Math.max(1, lvl * hgt * 0.46);
      ctx.fillStyle = (i + 0.5) / n <= frac ? accent : "rgba(255, 255, 255, 0.28)";
      ctx.fillRect(i * bw + bw * 0.18, hgt / 2 - half, Math.max(1, bw * 0.64), half * 2);
    }
  };

  // Reading the accent forces a style recalc, so drag frames and playback ticks
  // draw with the colour in hand and only these occasional redraws read it again.
  // A theme edit shows on the next seek, resize or load.
  const redrawWave = () => { readAccent(); drawWave(); };

  const seekAt = (e) => {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    const r = scrub.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    audio.currentTime = f * audio.duration;
    drawWave();
  };
  let scrubbing = false;
  const _endScrub = (e) => { scrubbing = false; try { scrub.releasePointerCapture(e.pointerId); } catch { } };
  scrub.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    try { scrub.setPointerCapture(e.pointerId); } catch { }
    scrubbing = true;
    seekAt(e);
  });
  scrub.addEventListener("pointermove", (e) => { if (scrubbing) seekAt(e); });
  scrub.addEventListener("pointerup", _endScrub);

  scrub.addEventListener("pointercancel", _endScrub);
  scrub.addEventListener("lostpointercapture", () => { scrubbing = false; });

  const playBtn = h("button", { class: "sbg-btn sbg-btn--round sbg-btn--round-lg", html: _PLAY_SVG, title: "Play or pause (Space)" });
  playBtn.addEventListener("click", _toggle);
  const timeEl = h("span", { class: "sbg-lb__audio-time", text: "0:00 / 0:00" });
  const muteBtn = h("button", { class: "sbg-btn sbg-btn--round", html: audio.muted ? VOLUME_MUTED_ICON : VOLUME_ICON, title: audio.muted ? "Unmute" : "Mute" });
  muteBtn.addEventListener("click", () => { audio.muted = !audio.muted; });
  const volSlider = h("input", { type: "range", class: "sbg-lb__audio-vol", min: "0", max: "1", step: "0.01", "aria-label": "Volume" });
  volSlider.value = String(audio.volume);
  volSlider.addEventListener("input", () => { audio.volume = Number(volSlider.value); if (audio.muted && audio.volume > 0) audio.muted = false; });
  // A focused slider keeps the arrow keys from the lightbox, so it gives up focus once released.
  volSlider.addEventListener("pointerup", () => volSlider.blur());
  const controls = h("div", { class: "sbg-lb__audio-controls" }, [playBtn, timeEl, h("span", { class: "sbg-lb__audio-spacer" }), muteBtn, volSlider]);

  audio.onvolumechange = () => {
    mediaState.volume = audio.volume;
    mediaState.muted = audio.muted;
    muteBtn.innerHTML = audio.muted ? VOLUME_MUTED_ICON : VOLUME_ICON;
    muteBtn.title = audio.muted ? "Unmute" : "Mute";
    volSlider.value = String(audio.volume);
  };
  audio.onplay = () => { playBtn.innerHTML = PAUSE_ICON; };
  audio.onpause = () => { playBtn.innerHTML = _PLAY_SVG; };
  audio.ontimeupdate = () => {
    timeEl.textContent = `${_fmtAudioTime(audio.currentTime)} / ${_fmtAudioTime(audio.duration)}`;
    if (!scrubbing) drawWave();
  };
  audio.ondurationchange = () => { timeEl.textContent = `${_fmtAudioTime(audio.currentTime)} / ${_fmtAudioTime(audio.duration)}`; };
  audio.onseeked = redrawWave;
  audio.onloadeddata = () => { swapIn(wrap); redrawWave(); };
  audio.oncanplay = () => swapIn(wrap);

  let _audRetries = 0;
  audio.onerror = () => {
    if (isStale()) return;
    // A decode error comes out the same on a retry, so only other failures are tried again.
    if (audio.error && audio.error.code !== MediaError.MEDIA_ERR_DECODE && _audRetries < 6) {
      _audRetries++;
      setTimeout(() => {
        if (isStale()) return;
        try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { }
        audio.src = fileUrl(it);
      }, Math.min(1500, 300 * _audRetries));
    } else {
      timeEl.textContent = failureText("load this audio file");
      timeEl.classList.add("sbg-lb__audio-time--failed");
      swapIn(wrap);
    }
  };

  const _waveResize = new ResizeObserver(redrawWave);
  _waveResize.observe(scrub);
  wrap._sbgDispose = () => { try { _waveResize.disconnect(); } catch { } };

  api("/sidebar_gallery/audio_peaks", { root_id: it.root_id, relpath: it.relpath, v: fileVersion(it) })
    .then(d => {
      if (!wrap.isConnected) return;
      if (Array.isArray(d.peaks) && d.peaks.length) peaks = d.peaks;
      // Only the peaks reply says the file has cover art, since its thumbnail may be a drawn waveform.
      if (d.art && it.thumb_url) {
        const art = h("img", { class: "sbg-lb__audio-art" });
        art.onload = () => { if (icon.parentNode) icon.replaceWith(art); };
        art.src = it.thumb_url;
      }
      redrawWave();
    })
    // A file with no peaks keeps the flat waveform it was drawn with.
    .catch(() => { });

  wrap.appendChild(stage);
  wrap.appendChild(scrub);
  wrap.appendChild(controls);
  wrap.appendChild(audio);
  setCurrentMedia(audio);
  insertMedia(wrap);
  audio.src = fileUrl(it);
}
