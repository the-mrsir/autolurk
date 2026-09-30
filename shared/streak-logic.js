// Watch-streak recovery decisions, with no Chrome and no network.
//
// Twitch's RewardList query is the only signal that counts. A streak is
// expiring when that payload carries a future expiresAt. It is recovered when
// a later payload no longer does. Opening a clip or VOD is not evidence.

export const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

// Hashes are Twitch's persisted web queries, the same ones the public miners
// call. The query text never ships; Twitch looks the hash up.
const REWARD_LIST_HASH = "0b1471876d7647993731b9e3c6a13bf304c67fb31d07f06a945d42286ee377c4";
const CLIPS_HASH = "1cd671bfa12cec480499c087319f26d21925e9695d1f80225aae6a4354f23088";
const VIDEOS_HASH = "67004f7881e65c297936f32c75246470629557a393788fb5a69d6d9a25a8fd5f";

export const STREAK_TIMING = {
  // A clip counts after it has actually played. A VOD counts after about five
  // minutes, which is what Twitch's own recovery help describes.
  clipPlaySeconds: 3,
  vodPlaySeconds: 300,
  // A hidden tab that never receives a media source stays at readyState 0.
  // Waiting longer does not change that.
  neverStartedMs: 2 * 60 * 1000,
  // Twitch keeps showing the expiration for a while after the video has played.
  confirmMs: 3 * 60 * 1000,
  redirectWaitMs: 20 * 1000,
  vodCapMs: 8 * 60 * 1000,
  clipCapMs: 90 * 1000,
  scanIntervalMs: 60 * 60 * 1000,
};

function persisted(operationName, hash, variables) {
  return {
    operationName,
    variables,
    extensions: {
      persistedQuery: { version: 1, sha256Hash: hash },
    },
  };
}

export function rewardListOperation(channelId) {
  return persisted("RewardList", REWARD_LIST_HASH, {
    channelID: String(channelId),
    shouldIncludeAllSuspendedStreaks: false,
  });
}

export function clipsOperation(login) {
  return persisted("ClipsCards__User", CLIPS_HASH, {
    login: String(login || "").toLowerCase(),
    limit: 20,
    criteria: { filter: "LAST_WEEK" },
    cursor: "",
  });
}

export function videosOperation(login) {
  return persisted("FilterableVideoTower_Videos", VIDEOS_HASH, {
    channelOwnerLogin: String(login || "").toLowerCase(),
    limit: 20,
    videoSort: "TIME",
    cursor: "",
  });
}

export function gqlFailureMessage(payload) {
  const errors = payload?.errors;
  if (!Array.isArray(errors) || !errors.length) return "";
  return errors
    .map((error) => (error && error.message ? String(error.message) : ""))
    .filter(Boolean)
    .join("; ");
}

export function readWatchStreak(payload) {
  return payload?.data?.channel?.self?.watchStreakMilestone ?? null;
}

// A logged-out page still answers the query. The channel is public, but
// `self` is absent, so there is no streak to read and nothing to open.
export function rewardListSignedOut(payload) {
  if (gqlFailureMessage(payload)) return false;
  const channel = payload?.data?.channel;
  if (!channel) return true;
  return channel.self == null;
}

export function streakExpiry(milestone) {
  const raw = milestone?.expiresAt;
  if (typeof raw !== "string" || !raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

export function streakIsExpiring(milestone, now = Date.now()) {
  const at = streakExpiry(milestone);
  return at != null && at > now;
}

export function missedBroadcastIds(milestone) {
  const streams = milestone?.missedStreams;
  if (!Array.isArray(streams)) return [];
  const ids = [];
  for (const stream of streams) {
    const list = stream?.broadcastIdentifiers;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.id) ids.push(String(item.id));
    }
  }
  return ids;
}

export function saveStreakUrl(login) {
  const name = String(login || "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) return "";
  return `https://www.twitch.tv/save-streak/${name}`;
}

function wwwTwitchUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "https:" || parsed.hostname !== "www.twitch.tv") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function clipUrl(node, login) {
  const direct = wwwTwitchUrl(node?.url);
  if (direct) return direct;
  const slug = String(node?.slug || "");
  const name = String(login || "").trim();
  if (!slug || !/^[A-Za-z0-9_]+$/.test(name)) return "";
  if (!/^[A-Za-z0-9-]+$/.test(slug)) return "";
  return `https://www.twitch.tv/${name}/clip/${slug}`;
}

function videoUrl(node) {
  const id = String(node?.id || "");
  if (!/^\d+$/.test(id)) return "";
  return `https://www.twitch.tv/videos/${id}`;
}

function newestFirst(nodes, field) {
  return [...nodes].sort((a, b) => String(b?.[field] || "").localeCompare(String(a?.[field] || "")));
}

// The newest clip is often from an older broadcast that was published late.
// Only a broadcast id Twitch listed under missedStreams can recover this streak.
export function pickRecoveryMedia({ clips = [], videos = [], missedIds = [], login = "" } = {}) {
  const wanted = new Set(missedIds.map(String));
  const matchingClips = newestFirst(
    clips.filter((node) => wanted.has(String(node?.broadcastIdentifier?.id))),
    "createdAt"
  );
  const clip =
    matchingClips.find((node) => Number(node?.durationSeconds) >= 5) || matchingClips[0] || null;

  const matchingVideos = newestFirst(
    videos.filter((node) => wanted.has(String(node?.broadcastIdentifier?.id))),
    "publishedAt"
  );
  const video =
    matchingVideos.find((node) => Number(node?.lengthSeconds) >= 300) || matchingVideos[0] || null;

  return {
    clipUrl: clip ? clipUrl(clip, login) : "",
    vodUrl: video ? videoUrl(video) : "",
  };
}

export function recoveryKind(url) {
  const value = String(url || "");
  if (value.includes("/clip/")) return "clip";
  if (value.includes("/videos/")) return "vod";
  if (value.includes("/save-streak/")) return "redirect";
  return "unknown";
}

// `progress` is one read of the page's real video element. The background is
// the clock: this function never waits.
export function judgeRecovery(job, progress, now, pageUrl = "") {
  const url = (progress && progress.url) || pageUrl || job?.openedUrl || "";
  const detected = recoveryKind(url);
  const phase =
    detected === "clip" || detected === "vod" || detected === "redirect"
      ? detected
      : job?.phase === "vod"
        ? "vod"
        : "clip";
  const openedAt = Number(job?.openedAt);
  const elapsed = now - (Number.isFinite(openedAt) ? openedAt : now);
  const hold = (extra = {}) => ({ action: "wait", phase, ...extra });

  if (phase === "redirect") {
    if (elapsed >= STREAK_TIMING.redirectWaitMs) return { action: "no-video", phase };
    return hold();
  }

  if (!progress) {
    if (elapsed >= STREAK_TIMING.neverStartedMs) return { action: "never-started", phase };
    return hold();
  }

  const time = Number(progress.currentTime);
  const seen = Number(progress.maxTime);
  const current = Math.max(Number.isFinite(time) ? time : 0, Number.isFinite(seen) ? seen : 0);
  const ready = Number(progress.readyState) || 0;
  const playing = Boolean(progress.hasVideo) && (ready > 0 || current > 0 || progress.ended === true);
  if (!playing) {
    if (elapsed >= STREAK_TIMING.neverStartedMs) return { action: "never-started", phase };
    return hold();
  }

  const needed = phase === "vod" ? STREAK_TIMING.vodPlaySeconds : STREAK_TIMING.clipPlaySeconds;
  const cap = phase === "vod" ? STREAK_TIMING.vodCapMs : STREAK_TIMING.clipCapMs;
  // The health check looks about once a minute. A clip has usually finished by
  // then, so the position already reached is the play time, not a baseline.
  const playedEnough = current >= needed || (progress.ended === true && phase === "clip");
  if (job?.baselineTime == null) {
    if (playedEnough) return { action: "recheck", phase, baselineTime: current };
    if (elapsed >= cap) return { action: "never-started", phase };
    return hold({ baselineTime: current });
  }

  const delta = current - Number(job.baselineTime);
  // A clip that looped jumped back to the start. It already played through.
  if (delta >= needed || (phase === "clip" && delta < -0.5)) {
    return { action: "recheck", phase, baselineTime: job.baselineTime };
  }
  if (elapsed >= cap) {
    if (delta > 0) return { action: "recheck", phase, baselineTime: job.baselineTime };
    return { action: "never-started", phase };
  }
  return hold({ baselineTime: job.baselineTime });
}
