// Reports Twitch SPA channel changes and nothing else.
//
// This used to run a MutationObserver over the whole document and rerun four
// DOM scrapes on every mutation, which on a busy chat is thousands of scans a
// minute. Twitch navigates with history.pushState, so watching that plus a
// cheap URL comparison catches every change for a fraction of the cost.
(() => {
  const { extractChannel, send } = globalThis.__autoLurk;
  // The multistream grid is a Twitch URL with Twitch's page thrown away. There
  // is no channel to report and no Twitch UI to find 7TV in.
  if (globalThis.__autoLurk.gridPage) return;

  let lastLogin = null;
  let pending = null;

  function reportChannel() {
    const login = extractChannel(location.pathname);
    if (login === lastLogin) return;
    lastLogin = login;
    if (login) send("CHANNEL_CHANGED", { login, url: location.href });
  }

  // Twitch fires several history updates per navigation while it swaps routes,
  // so collapse them into one report.
  function scheduleReport() {
    clearTimeout(pending);
    pending = setTimeout(reportChannel, 300);
  }

  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  history.pushState = function patchedPushState(...args) {
    originalPush.apply(this, args);
    scheduleReport();
  };
  history.replaceState = function patchedReplaceState(...args) {
    originalReplace.apply(this, args);
    scheduleReport();
  };
  window.addEventListener("popstate", scheduleReport);

  // Safety net for navigations that bypass the patched methods. A string
  // comparison every two seconds costs nothing.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    reportChannel();
  }, 2000);

  reportChannel();

  // The 7TV browser extension rewrites parts of the Twitch page, including the
  // area around the player. When playback diagnostics look wrong it is worth
  // knowing it is installed, so report it once rather than guessing later.
  const SEVENTV_MARKERS = [
    "#seventv-message-container",
    "#seventv-ui",
    "seventv-container",
    ".seventv-chat-list",
    "[data-seventv]",
  ];

  function detectSevenTvExtension() {
    return SEVENTV_MARKERS.some((selector) => {
      try {
        return Boolean(document.querySelector(selector));
      } catch {
        return false;
      }
    });
  }

  // It injects after Twitch's chat mounts, so check a few times and stop.
  let detectionAttempts = 0;
  const detectionTimer = setInterval(() => {
    detectionAttempts += 1;
    const present = detectSevenTvExtension();
    if (present || detectionAttempts >= 6) {
      clearInterval(detectionTimer);
      send("SEVENTV_DETECTED", { present });
    }
  }, 5000);
})();
