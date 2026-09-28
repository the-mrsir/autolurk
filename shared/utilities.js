import { RESERVED_TWITCH_PATHS, streamQuality } from "./constants.js";

export function now() {
  return Date.now();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeLogin(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

export function normalizeCategory(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function parseCategoryList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeCategory).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map(normalizeCategory)
    .filter(Boolean);
}

export function unique(list) {
  return [...new Set(list)];
}

export function formatViewers(count) {
  const n = Number(count) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function formatUptime(startedAt) {
  if (!startedAt) return "";
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return "";
  const totalMinutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatActivityDay(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString();
}

export function formatRelativeTime(timestamp) {
  if (!timestamp) return "Never";
  const delta = Date.now() - timestamp;
  if (delta < 15_000) return "Just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleString();
}

export function formatUserCode(code) {
  const raw = String(code || "").replace(/\s+/g, "").toUpperCase();
  if (raw.length === 8) return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return raw;
}

export function extractChannelFromUrl(urlString) {
  if (!urlString) return null;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");
  if (host !== "twitch.tv") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  if (parts[0] === "popout" || parts[0] === "moderator" || parts[0] === "embed") {
    return parts[1] && !RESERVED_TWITCH_PATHS.has(parts[1].toLowerCase())
      ? normalizeLogin(parts[1])
      : null;
  }

  const first = parts[0].toLowerCase();
  if (RESERVED_TWITCH_PATHS.has(first)) return null;
  if (first.startsWith("videos") || first === "clip") return null;
  return normalizeLogin(first);
}

export function twitchChannelUrl(login) {
  return `https://www.twitch.tv/${normalizeLogin(login)}`;
}

// Twitch reads its quality and volume preferences out of localStorage once, as
// the player boots, and its bundle finishes loading long before an extension
// message can round-trip to the service worker and back. A hash is the only
// signal the page can read synchronously at document_start, and Twitch's
// router ignores it. Without this the quality pin would only take effect on a
// later reload, which is useless for a tab that is opened and never touched.
export const LURK_HASH = "#autolurk";

export function managedChannelUrl(login, settings) {
  const background = streamQuality(settings?.backgroundQuality, "160p30");
  const watching = streamQuality(settings?.watchingQuality, "1080p60");
  return `${twitchChannelUrl(login)}${LURK_HASH}&b=${encodeURIComponent(background)}&w=${encodeURIComponent(watching)}`;
}

export function twitchProfileUrl(login) {
  return `https://www.twitch.tv/${normalizeLogin(login)}/about`;
}

export function categoryMatches(gameName, rules = []) {
  const game = normalizeCategory(gameName);
  if (!game || !rules.length) return false;
  return rules.some((rule) => {
    const needle = normalizeCategory(rule);
    return game === needle || game.includes(needle) || needle.includes(game);
  });
}

export function shouldAutoOpenForCategory(gameName, favorite) {
  const include = favorite?.includeCategories || [];
  const exclude = favorite?.excludeCategories || [];
  if (exclude.length && categoryMatches(gameName, exclude)) return false;
  if (include.length && !categoryMatches(gameName, include)) return false;
  return true;
}

// Favorites inherit the global notification settings unless they set their own.
export function notifyEnabled(favorite, settings, key) {
  const override = favorite?.[key];
  if (override === true || override === false) return override;
  return Boolean(settings?.[key]);
}

export function compareFavorites(a, b, mode, liveMap = {}) {
  const liveA = liveMap[a.userId];
  const liveB = liveMap[b.userId];

  if (mode === "live") {
    const aLive = Boolean(liveA?.isLive);
    const bLive = Boolean(liveB?.isLive);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return compareFavorites(a, b, "viewers", liveMap);
  }

  if (mode === "viewers") {
    const av = liveA?.viewerCount || 0;
    const bv = liveB?.viewerCount || 0;
    if (av !== bv) return bv - av;
    return (a.displayName || a.login || "").localeCompare(b.displayName || b.login || "");
  }

  if (mode === "priority") {
    const rankA = a.priority === "high" ? 3 : a.priority === "low" ? 1 : 2;
    const rankB = b.priority === "high" ? 3 : b.priority === "low" ? 1 : 2;
    if (rankA !== rankB) return rankB - rankA;
    return (a.displayName || a.login || "").localeCompare(b.displayName || b.login || "");
  }

  return (a.displayName || a.login || "").localeCompare(b.displayName || b.login || "");
}

export function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

export function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
