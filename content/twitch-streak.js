// Isolated bridge for watch-streak recovery.
//
// The background is the clock. This file answers two questions when asked:
// what RewardList says (asked through the page, where the login cookie lives),
// and whether the recovery video has actually moved. It does not poll, click
// the page, or decide that a streak was saved.
(() => {
  if (globalThis.__autoLurkStreak) return;
  globalThis.__autoLurkStreak = true;

  const CONTAINERS = [
    '[data-a-player-type="site"]',
    '[data-a-target="video-player"]',
    ".persistent-player",
    ".video-player__container",
  ];

  function siteVideo() {
    let best = null;
    let bestArea = -1;
    for (const selector of CONTAINERS) {
      for (const container of document.querySelectorAll(selector)) {
        for (const video of container.querySelectorAll("video")) {
          const area = (Number(video.videoWidth) || 0) * (Number(video.videoHeight) || 0);
          if (!best || area > bestArea) {
            best = video;
            bestArea = area;
          }
        }
      }
    }
    return best;
  }

  let maxTime = 0;

  function progress() {
    const video = siteVideo();
    // play() on an element that already has a source is the same nudge the
    // lurk player uses. An element with no source cannot be started from here,
    // and clicking around the page is what removed the channel player before.
    if (video && video.paused && video.readyState > 0 && !video.ended) {
      video.play().catch(() => {});
    }
    const currentTime = video ? Number(video.currentTime) || 0 : 0;
    if (currentTime > maxTime) maxTime = currentTime;
    return {
      url: location.href,
      hasVideo: Boolean(video),
      currentTime,
      maxTime,
      ended: Boolean(video?.ended),
      readyState: video ? Number(video.readyState) || 0 : 0,
      paused: video ? Boolean(video.paused) : true,
    };
  }

  const pending = new Map();

  window.addEventListener("autolurk-streak-result", (event) => {
    const detail = event.detail || {};
    const wait = pending.get(detail.id);
    if (!wait) return;
    pending.delete(detail.id);
    wait(detail);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "STREAK_PROGRESS") {
      sendResponse(progress());
      return false;
    }
    if (message?.type !== "STREAK_GQL") return false;

    const id = `${Date.now()}-${Math.random()}`;
    const finish = (detail) => {
      pending.delete(id);
      try {
        sendResponse(detail);
      } catch {
        // The service worker already moved on.
      }
    };
    pending.set(id, finish);
    // One backstop for a reply that never arrives. This is not a poll: it
    // fires once per query and only reports failure. A hidden tab may deliver
    // it late, which still unblocks the background.
    setTimeout(() => {
      if (!pending.has(id)) return;
      finish({ ok: false, error: "Twitch streak query timed out." });
    }, 20000);
    window.dispatchEvent(
      new CustomEvent("autolurk-streak-query", {
        detail: {
          id,
          operations: message.operations,
          clientId: message.clientId,
        },
      })
    );
    return true;
  });
})();
