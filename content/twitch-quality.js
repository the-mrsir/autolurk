// Runs in Twitch's MAIN world before its player bundle.
//
// Merely writing video-quality once is not a lock: Twitch writes its own
// choice later and can put a hidden stream back at Source. An isolated content
// script cannot intercept page-world Storage calls, so this tiny bridge owns
// only that one preference while an AutoLurk document is lurking.
//
// Visibility is the source of truth. A tab the user is looking at must not
// force the background quality — doing so is how a manual selection snaps
// back — and a hidden tab must not keep Source. CustomEvents from the isolated
// script are hints; they cannot override what the user can actually see.
(() => {
  const QUALITY_KEY = "video-quality";
  const PRIOR_KEY = "autolurk-prior-quality";
  const STREAM_QUALITY_IDS = ["160p30", "360p30", "480p30", "720p30", "720p60", "1080p60", "chunked"];
  const nativeSetItem = Storage.prototype.setItem;
  let locked = false;
  let enabled = location.hash.includes("autolurk");

  function hashQuality(flag, fallback) {
    const match = String(location.hash || "").match(new RegExp("[&?]" + flag + "=([^&]+)"));
    let value = "";
    try {
      value = match ? decodeURIComponent(match[1]) : "";
    } catch {
      value = "";
    }
    return STREAM_QUALITY_IDS.includes(value) ? value : fallback;
  }

  let lowQuality = hashQuality("b", "160p30");
  let watchQuality = hashQuality("w", "1080p60");

  function stored(quality) {
    return JSON.stringify({ default: quality });
  }

  function looking() {
    return document.visibilityState === "visible";
  }

  function setRaw(key, value) {
    nativeSetItem.call(localStorage, key, value);
  }

  function rememberAndLower() {
    const current = localStorage.getItem(QUALITY_KEY);
    const low = stored(lowQuality);
    if (current && current !== low) setRaw(PRIOR_KEY, current);
    locked = true;
    setRaw(QUALITY_KEY, low);
  }

  function restoreForViewing() {
    locked = false;
    setRaw(QUALITY_KEY, localStorage.getItem(PRIOR_KEY) || JSON.stringify({ default: "auto" }));
  }

  // Only writes originating in this page's localStorage are constrained.
  // Other Twitch tabs have their own JS realm and can keep the quality the user
  // selected there.
  Storage.prototype.setItem = function autoLurkSetItem(key, value) {
    if (this === localStorage && key === QUALITY_KEY && locked) {
      return nativeSetItem.call(this, key, stored(lowQuality));
    }
    return nativeSetItem.call(this, key, value);
  };

  function modeOf(detail) {
    return detail && typeof detail === "object" ? detail.mode : detail;
  }

  function requestedQuality(detail) {
    const value = detail && typeof detail === "object" ? detail.quality : "";
    return STREAM_QUALITY_IDS.includes(value) ? value : "";
  }

  window.addEventListener("autolurk-quality-mode", (event) => {
    const mode = modeOf(event.detail);
    const quality = requestedQuality(event.detail);
    if (mode === "view") {
      enabled = true;
      locked = false;
      if (quality) {
        watchQuality = quality;
        setRaw(QUALITY_KEY, stored(watchQuality));
      } else {
        restoreForViewing();
      }
    }
    if (mode === "high") {
      enabled = true;
      locked = false;
      if (quality) {
        watchQuality = quality;
        setRaw(QUALITY_KEY, stored(watchQuality));
      }
    }
    if (mode === "low") {
      enabled = true;
      if (quality) lowQuality = quality;
      rememberAndLower();
    }
  });

  // Later changes are driven by autolurk-quality-mode. The isolated content
  // script sees Chrome's real visibility and sends low/view/high explicitly.
  if (enabled && !looking()) rememberAndLower();
  else if (enabled && looking()) setRaw(QUALITY_KEY, stored(watchQuality));
})();
