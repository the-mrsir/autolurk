// One tile of the multistream grid: an embedded Twitch player in a frame of
// content/twitch-grid.js.
//
// Runs in every player.twitch.tv frame, so the first thing it does is check
// for the marker the grid puts in the URL. A Twitch embed on somebody else's
// site must be left completely alone.
//
// All it owns is which tile has the sound. Exactly one is audible, and the
// player's own mute control is what switches it: assigning video.muted from
// here looks like it works and then quietly loses, because the player's store
// reapplies its own state a few seconds later - measured, after a switch that
// left the grid silent.
(() => {
  const params = new URLSearchParams(location.search);
  const quality = params.get("autolurk");
  if (!quality) return;

  const channel = (params.get("channel") || "").toLowerCase();
  const MUTE_BUTTON = 'button[data-a-target="player-mute-unmute-button"]';

  // Read once as the player boots, so it has to be in place before its bundle
  // runs. Four tiles all asking for source quality is what makes them fight
  // over the connection; a quarter of a screen does not need it.
  try {
    localStorage.setItem("video-quality", JSON.stringify({ default: quality }));
    const volume = Number(localStorage.getItem("volume"));
    if (!Number.isFinite(volume) || volume <= 0) localStorage.setItem("volume", "0.5");
  } catch {
    // Storage can be blocked; the player then picks its own quality.
  }

  let wantAudible = false;
  // Set once this tile has actually been heard playing. Until then every pass
  // nudges again, because a click during the player's own start-up is
  // swallowed - measured, and it left the whole grid silent when the grant was
  // trusted rather than confirmed. Afterwards the user is free to mute the
  // tile with the player's own button and nothing here argues. Silence on the
  // other tiles is a rule; audio on this one is a one-off handover.
  let granted = false;

  function video() {
    return document.querySelector("video");
  }

  function toggleMute() {
    const button = document.querySelector(MUTE_BUTTON);
    if (button) {
      button.click();
      return true;
    }
    // No controls rendered yet. Worth doing anyway: it silences the tile now,
    // and sync() runs again when the player settles.
    const element = video();
    if (!element) return false;
    element.muted = !wantAudible;
    return true;
  }

  function sync() {
    const element = video();
    if (!element) return;

    if (!wantAudible) {
      granted = false;
      if (element.muted) return;
      toggleMute();
      return;
    }

    if (granted) return;
    if (!element.muted) {
      // The player is already audible. Before playback starts, blindly
      // toggling here would mute it again every three seconds; wait for its
      // media clock, then mark the handoff complete.
      if (element.currentTime > 0) granted = true;
      return;
    }
    if (element.volume === 0) element.volume = 0.5;
    toggleMute();
  }

  function apply(audibleLogin) {
    const next = String(audibleLogin || "").toLowerCase() === channel;
    if (next !== wantAudible) granted = false;
    wantAudible = next;
    sync();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "MULTISTREAM_AUDIO") apply(message.login);
    return false;
  });

  // A tile that reloads itself - an ad, a player error, the user hitting
  // refresh - comes back knowing nothing, so it asks rather than waiting for
  // the next switch to tell it.
  try {
    chrome.runtime.sendMessage({ type: "MULTISTREAM_TILES" }, (response) => {
      void chrome.runtime.lastError;
      if (response?.ok && response.result) apply(response.result.audibleLogin);
    });
  } catch {
    // Extension reloading. The next broadcast will set this frame straight.
  }

  // volumechange is the player telling us it has just overwritten what we did,
  // which is the only moment the muted tiles need correcting. The interval is
  // a slow backstop for the seconds before any player exists.
  document.addEventListener("volumechange", sync, true);
  setInterval(sync, 3000);
})();
