import { SEVENTV } from "../shared/constants.js";
import {
  getSettings,
  getSevenTvCache,
  mutateMeta,
  mutateSevenTvCache,
} from "../shared/storage.js";

// 7TV is a free, volunteer-run service. Everything here is built to keep the
// request count low: results are cached for hours, failures are cached too so
// an outage is not retried on every poll, only a couple of requests run at
// once, and a poll refreshes at most a handful of channels.

const inFlight = new Map();
let activeRequests = 0;
const waiting = [];

function withSlot(task) {
  if (activeRequests < SEVENTV.MAX_CONCURRENT) {
    activeRequests += 1;
    return task().finally(release);
  }
  return new Promise((resolve, reject) => {
    waiting.push(() => {
      activeRequests += 1;
      task().then(resolve, reject).finally(release);
    });
  });
}

function release() {
  activeRequests -= 1;
  const next = waiting.shift();
  if (next) next();
}

function isFresh(entry, now) {
  if (!entry) return false;
  const ttl = entry.error ? SEVENTV.ERROR_TTL_MS : SEVENTV.CACHE_TTL_MS;
  return now - (entry.fetchedAt || 0) < ttl;
}

function shapeUser(userId, data) {
  const set = data?.emote_set || {};
  const emotes = Array.isArray(set.emotes) ? set.emotes : [];
  return {
    userId: String(userId),
    error: "",
    setId: set.id || "",
    setName: set.name || "",
    emoteCount: typeof set.emote_count === "number" ? set.emote_count : emotes.length,
    // Only a preview is stored. Some channels carry a thousand emotes and
    // chrome.storage.local is not the place for that.
    emotes: emotes.slice(0, SEVENTV.PREVIEW_EMOTES).map((emote) => ({
      name: emote.name || emote.data?.name || "",
      url: emote.id ? `${SEVENTV.CDN}/emote/${emote.id}/1x.webp` : "",
    })),
    profileUrl: data?.user?.id ? `${SEVENTV.APP}/users/${data.user.id}` : "",
    fetchedAt: Date.now(),
  };
}

async function fetchUser(userId) {
  const response = await fetch(`${SEVENTV.API}/users/twitch/${encodeURIComponent(userId)}`, {
    headers: { Accept: "application/json" },
  });

  // A channel with no 7TV presence is a normal answer, not a failure, and is
  // cached for the full duration so it is not asked about again all day.
  if (response.status === 404) {
    return { userId: String(userId), error: "", absent: true, emotes: [], fetchedAt: Date.now() };
  }
  if (!response.ok) throw new Error(`7TV responded ${response.status}`);
  return shapeUser(userId, await response.json());
}

export async function getSevenTvForUser(userId, { force = false } = {}) {
  if (!userId) return null;

  const settings = await getSettings();
  if (!settings.sevenTvEnabled) return null;

  const key = String(userId);
  const cache = await getSevenTvCache();
  const now = Date.now();
  if (!force && isFresh(cache[key], now)) return cache[key];

  // Two channels changing at once must not become two identical requests.
  if (inFlight.has(key)) return inFlight.get(key);

  const request = withSlot(() => fetchUser(key))
    .catch((error) => ({
      userId: key,
      error: error?.message || "lookup failed",
      emotes: [],
      fetchedAt: Date.now(),
    }))
    .then(async (entry) => {
      await mutateSevenTvCache((current) => ({ ...current, [key]: entry }));
      return entry;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

// Called after a poll. Refreshes a bounded number of live channels so the
// dashboard has data ready without turning every poll into a burst of traffic.
export async function prefetchSevenTv(streams = []) {
  const settings = await getSettings();
  if (!settings.sevenTvEnabled) return;

  const cache = await getSevenTvCache();
  const now = Date.now();
  const stale = streams
    .filter((stream) => stream.userId && !isFresh(cache[String(stream.userId)], now))
    .slice(0, 6);

  await Promise.all(stale.map((stream) => getSevenTvForUser(stream.userId).catch(() => null)));
}

export async function clearSevenTvCache() {
  await mutateSevenTvCache(() => ({}));
}

// The 7TV browser extension rewrites the page around the player. Recording it
// means the dashboard can name a likely cause when playback readings look odd,
// instead of leaving the user to guess.
export async function recordSevenTvExtension(present) {
  await mutateMeta((meta) => {
    if (meta.sevenTvExtension === present) return meta;
    return { ...meta, sevenTvExtension: present, sevenTvExtensionAt: Date.now() };
  });
}
