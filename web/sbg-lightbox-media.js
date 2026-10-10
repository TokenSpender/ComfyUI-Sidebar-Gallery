import { h } from "./sbg-core.js";
import { failureText } from "./sbg-toast.js";
import { fileUrl, isVideo, isAudio, kindIcon } from "./sbg-media-kind.js";
import { createAudioPane, mediaState } from "./sbg-lightbox-audio.js";

const _FULL_PRELOAD_MAX_BYTES = 16 * 1024 * 1024;

export function failedMediaHTML(it) {
  return `${kindIcon(it)}<div class="sbg-lb__failed-text">${failureText("load this image")}</div>`;
}

export function createMediaStage({ item: it, insertMedia, swapIn, setCurrentMedia, isStale, onImageDecoded }) {
  if (isVideo(it)) {
    const _preload = (it.size && it.size <= _FULL_PRELOAD_MAX_BYTES) ? "auto" : "metadata";
    const video = h("video", { class: "sbg-lb__video sbg-lb__staged", controls: "true", autoplay: "true", loop: "true", preload: _preload });
    // Staged media waits out of view under this class and flag. Zoom leaves a
    // flagged element unmeasured, and the swap clears both.
    video.dataset.sbgPending = "1";
    video.volume = mediaState.volume;
    video.muted = mediaState.muted;
    video.onvolumechange = () => { mediaState.volume = video.volume; mediaState.muted = video.muted; };
    video.onloadeddata = () => swapIn(video);
    video.oncanplay = () => swapIn(video);

    let _vidRetries = 0;
    const _maxVidRetries = 6;
    // A decode error is tried again too, unlike on audio, since a hardware
    // decoder busy with another video fails a decode that works a moment later.
    video.onerror = () => {
      if (isStale()) return;
      if (video.error && _vidRetries < _maxVidRetries) {
        _vidRetries++;
        setTimeout(() => {
          if (isStale()) return;
          try { video.pause(); video.removeAttribute("src"); video.load(); } catch { }
          video.src = fileUrl(it);
        }, Math.min(1500, 300 * _vidRetries));
      } else {
        swapIn(video);
      }
    };
    setCurrentMedia(video);
    insertMedia(video);
    video.src = fileUrl(it);
  } else if (isAudio(it)) {
    createAudioPane({ item: it, insertMedia, swapIn, setCurrentMedia, isStale });
  } else {
    const img = h("img", { class: "sbg-lb__img sbg-lb__staged" });
    img.dataset.sbgPending = "1";

    let failed = false;
    const fail = () => {
      if (failed || isStale()) return;
      failed = true;
      const pane = h("div", { class: "sbg-lb__icon-pane sbg-lb__icon-pane--failed sbg-lb__staged", html: failedMediaHTML(it) });
      pane.dataset.sbgPending = "1";
      setCurrentMedia(null);
      img.removeAttribute("src");
      img.remove();
      insertMedia(pane);
      swapIn(pane);
    };
    img.onerror = fail;
    setCurrentMedia(img);
    insertMedia(img);
    const url = fileUrl(it);
    img.src = url;
    // decode() settles once the image can be painted, where onload can arrive
    // before it is rasterized and leave a blank frame. It can also reject for an
    // image that did load, so only one with no size counts as failed.
    img.decode().then(() => {
      swapIn(img);
      onImageDecoded(url);
    }).catch(() => { if (!img.naturalWidth) fail(); else swapIn(img); });
  }
}
