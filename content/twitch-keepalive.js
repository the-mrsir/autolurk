// Runs in Twitch's MAIN world at document_start.
//
// This used to mask document.hidden, block pause, fake intersection, and
// click Play on whatever video card it found. Twitch answers that by taking
// the persistent player out of the channel page: the header, About, Goals,
// panels, and chat stay, and the video is gone until a refresh. Measured
// on live channel pages after those hooks shipped.
//
// A hidden tab that has never been shown may not start playback. That is
// acceptable. Unmounting the player is not. This file intentionally does
// nothing to the page.
(() => {
  if (globalThis.__autoLurkKeepAliveInstalled) return;
  globalThis.__autoLurkKeepAliveInstalled = true;
})();
