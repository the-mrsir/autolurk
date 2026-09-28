// Loaded before the other content scripts. Content scripts cannot use ES
// modules, but they do share one isolated world per extension, so this is the
// only way to keep a single definition of the Twitch path rules.
(() => {
  // Must stay identical to RESERVED_TWITCH_PATHS in shared/constants.js.
  // A content script cannot import it, so tests/static.test.js compares them.
  const RESERVED_PATHS = new Set([
    "activate", "bits", "broadcast", "clips", "directory", "downloads", "drops",
    "embed", "friends", "inventory", "jobs", "login", "moderator", "p",
    "payments", "popout", "prime", "privacy", "products", "search", "settings",
    "signup", "store", "subs", "subscriptions", "team", "turbo", "u", "user",
    "video", "videos", "wallet",
  ]);

  function extractChannel(pathname = location.pathname) {
    const parts = pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    if (parts[0] === "popout" || parts[0] === "moderator" || parts[0] === "embed") {
      const next = parts[1]?.toLowerCase();
      return next && !RESERVED_PATHS.has(next) ? next : null;
    }
    const first = parts[0].toLowerCase();
    return RESERVED_PATHS.has(first) ? null : first;
  }

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, () => void chrome.runtime.lastError);
    } catch {
      // The extension context disappears on reload; nothing to report to.
    }
  }

  globalThis.__autoLurk = { RESERVED_PATHS, extractChannel, send };
})();
