// Runs in Twitch's MAIN world before its player bundle.
//
// Merely writing video-quality once is not a lock: Twitch writes its own
// choice later and can put a hidden stream back at Source. An isolated content
// script cannot intercept page-world Storage calls, so this tiny bridge owns
// only that one preference while an AutoLurk document is lurking.
//
// Visibility is the source of truth. A tab the user is looking at must not
// force 160p — doing so is how a manual 1080p selection snaps back — and a
// hidden tab must not keep Source. CustomEvents from the isolated script are
// hints; they cannot override what the user can actually see.
(() => {
  const QUALITY_KEY = "video-quality";
  const PRIOR_KEY = "autolurk-prior-quality";
  const LOW = JSON.stringify({ default: "160p30" });
  const nativeSetItem = Storage.prototype.setItem;
  let locked = false;
  let enabled = location.hash.includes("autolurk");

  function looking() {
    return document.visibilityState === "visible";
  }

  function setRaw(key, value) {
    nativeSetItem.call(localStorage, key, value);
  }

  function rememberAndLower() {
    const current = localStorage.getItem(QUALITY_KEY);
    if (current && current !== LOW) setRaw(PRIOR_KEY, current);
    locked = true;
    setRaw(QUALITY_KEY, LOW);
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
      return nativeSetItem.call(this, key, LOW);
    }
    return nativeSetItem.call(this, key, value);
  };

  window.addEventListener("autolurk-quality-mode", (event) => {
    if (event.detail === "view") {
      enabled = true;
      restoreForViewing();
    }
    if (event.detail === "high") {
      enabled = true;
      locked = false;
    }
    if (event.detail === "low") {
      enabled = true;
      rememberAndLower();
    }
  });

  // Later changes are driven by autolurk-quality-mode. The isolated content
  // script sees Chrome's real visibility and sends low/view/high explicitly.
  if (enabled && !looking()) rememberAndLower();
})();
