import { MESSAGE, SESSION_KEYS } from "../shared/constants.js";
import { getFavorites, getFollows, getSettings, mutateSessionValue } from "../shared/storage.js";
import {
  STREAK_TIMING,
  TWITCH_WEB_CLIENT_ID,
  clipsOperation,
  gqlFailureMessage,
  judgeRecovery,
  missedBroadcastIds,
  pickRecoveryMedia,
  readWatchStreak,
  recoveryKind,
  rewardListOperation,
  rewardListSignedOut,
  saveStreakUrl,
  streakIsExpiring,
  videosOperation,
} from "../shared/streak-logic.js";
import { logActivity } from "./activity.js";

const EMPTY = {
  queue: [],
  active: null,
  authLogged: false,
  // userId -> expiresAt the user closed, so the same expiration is not reopened
  // until Twitch reports a different one.
  declined: {},
};

// scan and tick both open tabs. Serializing them keeps two alarms from opening
// two recovery videos for the same channel. Tab-close bookkeeping stays off
// this lock: it runs while a close is already in progress.
let pending = Promise.resolve();

function serialized(fn) {
  const run = pending.then(fn, fn);
  pending = run.then(
    () => {},
    () => {}
  );
  return run;
}

function session(mutator) {
  return mutateSessionValue(SESSION_KEYS.STREAK, EMPTY, (current) =>
    mutator({ ...EMPTY, ...current, queue: [...(current?.queue || [])], declined: { ...(current?.declined || {}) } })
  );
}

export function scanWatchStreaks() {
  return serialized(scanBody);
}

export function tickWatchStreaks() {
  return serialized(tickBody);
}

export function stopWatchStreaks() {
  return serialized(stopBody);
}

export function noteStreakTabClosed(tabId) {
  const id = Number(tabId);
  return session((state) => {
    if (!state.active || Number(state.active.tabId) !== id) return undefined;
    if (!state.active.closing) state.declined[state.active.userId] = state.active.expiresAt;
    state.active = null;
    return state;
  });
}

async function scanBody() {
  const settings = await getSettings();
  if (!settings.saveWatchStreaks || !settings.automationEnabled) return;

  const courier = await acquireCourier();
  try {
    const jobs = await collectJobs(courier.tabId);
    await session((state) => {
      const activeId = state.active?.userId;
      state.queue = jobs.filter(
        (job) => job.userId !== activeId && state.declined[job.userId] !== job.expiresAt
      );
      return state;
    });
    const current = await session((state) => state);
    if (!current.active) await startNext(settings);
  } catch (error) {
    await reportQueryFailure(error);
  } finally {
    await releaseCourier(courier);
  }
}

async function tickBody() {
  const settings = await getSettings();
  if (!settings.saveWatchStreaks) {
    await stopBody();
    return;
  }
  if (!settings.automationEnabled) return;

  const state = await session((current) => current);
  if (!state.active) {
    if (state.queue.length) await startNext(settings);
    return;
  }
  await advance(state.active, settings);
}

async function stopBody() {
  const state = await session((current) => {
    current.queue = [];
    if (current.active) current.active = { ...current.active, closing: true };
    return current;
  });
  const tabId = state.active?.tabId;
  if (tabId == null) return;
  await chrome.tabs.remove(tabId).catch(() => {});
  await session((current) => {
    if (Number(current.active?.tabId) === Number(tabId)) current.active = null;
    return current;
  });
}

async function collectJobs(tabId) {
  const [favorites, follows] = await Promise.all([getFavorites(), getFollows()]);
  const channels = Object.entries(favorites)
    .map(([userId, favorite]) => ({
      userId: String(userId),
      login: favorite?.login || follows[userId]?.login || "",
      displayName: favorite?.displayName || follows[userId]?.displayName || favorite?.login || userId,
    }))
    .filter((channel) => channel.login);

  if (!channels.length) return [];

  const listed = [];
  for (let index = 0; index < channels.length; index += 8) {
    const slice = channels.slice(index, index + 8);
    const payloads = await postGql(
      tabId,
      slice.map((channel) => rewardListOperation(channel.userId))
    );
    if (payloads.every((payload) => rewardListSignedOut(payload))) {
      throw new Error("Twitch did not return a signed-in streak. Open Twitch while logged in and try again.");
    }
    slice.forEach((channel, offset) => {
      const payload = payloads[offset];
      const failure = gqlFailureMessage(payload);
      if (failure) throw new Error(failure);
      const milestone = readWatchStreak(payload);
      if (!streakIsExpiring(milestone)) return;
      listed.push({
        ...channel,
        expiresAt: milestone.expiresAt,
        missedIds: missedBroadcastIds(milestone),
      });
    });
  }

  const jobs = [];
  for (const channel of listed) {
    let clipUrl = "";
    let vodUrl = "";
    if (channel.missedIds.length) {
      try {
        const [clipsPayload, videosPayload] = await postGql(tabId, [
          clipsOperation(channel.login),
          videosOperation(channel.login),
        ]);
        const clipsFailure = gqlFailureMessage(clipsPayload);
        const videosFailure = gqlFailureMessage(videosPayload);
        if (clipsFailure || videosFailure) throw new Error(clipsFailure || videosFailure);
        const picked = pickRecoveryMedia({
          clips: edgeNodes(clipsPayload, "clips"),
          videos: edgeNodes(videosPayload, "videos"),
          missedIds: channel.missedIds,
          login: channel.login,
        });
        clipUrl = picked.clipUrl;
        vodUrl = picked.vodUrl;
      } catch (error) {
        // RewardList already said the streak is expiring. Twitch's save-streak
        // page can still pick a video when the clip and VOD lists do not load.
        console.warn("Streak media lookup failed", error);
      }
    }
    const openedUrl = clipUrl || vodUrl || saveStreakUrl(channel.login);
    if (!openedUrl) continue;
    jobs.push({
      userId: channel.userId,
      login: channel.login,
      displayName: channel.displayName,
      expiresAt: channel.expiresAt,
      clipUrl,
      vodUrl,
      openedUrl,
    });
  }
  return jobs;
}

function edgeNodes(payload, field) {
  const edges = payload?.data?.user?.[field]?.edges;
  if (!Array.isArray(edges)) return [];
  return edges.map((edge) => edge?.node).filter(Boolean);
}

async function startNext(settings) {
  const state = await session((current) => current);
  if (state.active || !state.queue.length) return;
  const job = state.queue[0];
  const kind = recoveryKind(job.openedUrl);
  const inFront = Boolean(settings.streakOpenInFront);
  let tab;
  try {
    // Only this recovery tab is allowed to cover the screen. Lurk tabs stay
    // inactive; a hidden tab is also the one Chrome often never starts.
    tab = await chrome.tabs.create({ url: job.openedUrl, active: inFront });
    if (inFront && tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  } catch (error) {
    await logActivity(`Could not open a recovery video for ${job.displayName}.`, {
      channel: job.login,
      level: "warn",
    });
    await session((current) => {
      current.queue = current.queue.filter((item) => item.userId !== job.userId);
      return current;
    });
    return;
  }
  if (settings.muteTabs) {
    await chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  }
  await session((current) => {
    current.queue = current.queue.filter((item) => item.userId !== job.userId);
    current.active = {
      tabId: tab.id,
      userId: job.userId,
      login: job.login,
      displayName: job.displayName,
      expiresAt: job.expiresAt,
      clipUrl: job.clipUrl,
      vodUrl: job.vodUrl,
      openedUrl: job.openedUrl,
      phase: kind === "vod" ? "vod" : kind === "redirect" ? "redirect" : "clip",
      openedAt: Date.now(),
      baselineTime: null,
      triedVod: kind === "vod",
      closing: false,
    };
    return current;
  });
  await logActivity(`Watch streak for ${job.displayName} is expiring. Opening a recovery video.`, {
    channel: job.login,
  });
}

async function advance(active, settings) {
  const tab = await chrome.tabs.get(active.tabId).catch(() => null);
  if (!tab) {
    await session((current) => {
      if (Number(current.active?.tabId) === Number(active.tabId)) current.active = null;
      return current;
    });
    return;
  }

  const progress = await chrome.tabs
    .sendMessage(active.tabId, { type: MESSAGE.STREAK_PROGRESS })
    .catch(() => null);
  const verdict = judgeRecovery(active, progress, Date.now(), tab.url);
  if (verdict.baselineTime != null && verdict.baselineTime !== active.baselineTime) {
    await session((current) => {
      if (Number(current.active?.tabId) !== Number(active.tabId)) return undefined;
      current.active = { ...current.active, baselineTime: verdict.baselineTime, phase: verdict.phase };
      return current;
    });
  }

  if (verdict.action === "wait") return;

  if (verdict.action === "never-started") {
    await finish(active, `${active.displayName}'s recovery video never started playing, so the streak was not recovered.`, "warn");
    return;
  }
  if (verdict.action === "no-video") {
    await finish(active, `Twitch has no recovery video for ${active.displayName}.`, "warn");
    return;
  }

  let cleared = false;
  try {
    const [payload] = await postGql(active.tabId, [rewardListOperation(active.userId)]);
    const failure = gqlFailureMessage(payload);
    if (failure) throw new Error(failure);
    if (rewardListSignedOut(payload)) {
      throw new Error("Twitch did not return a signed-in streak.");
    }
    cleared = !streakIsExpiring(readWatchStreak(payload));
  } catch (error) {
    await finish(
      active,
      `Could not recheck the watch streak for ${active.displayName}.`,
      "warn"
    );
    console.warn("Streak recheck failed", error);
    return;
  }

  if (cleared) {
    await finish(active, `Watch streak for ${active.displayName} recovered.`, "");
    return;
  }

  if (!active.triedVod && active.vodUrl && verdict.phase !== "vod") {
    await finish(active, "", "");
    await session((current) => {
      current.queue.unshift({
        userId: active.userId,
        login: active.login,
        displayName: active.displayName,
        expiresAt: active.expiresAt,
        clipUrl: "",
        vodUrl: active.vodUrl,
        openedUrl: active.vodUrl,
      });
      return current;
    });
    await startNext(settings);
    return;
  }

  await finish(
    active,
    `Recovery video for ${active.displayName} finished, and Twitch still shows the streak expiring.`,
    "warn"
  );
}

async function finish(active, text, level) {
  // Close the recovery tab itself, including when it is the tab in front.
  // A restored streak is the success path; the other reasons close it too so
  // a finished attempt is not left on screen.
  await session((current) => {
    if (Number(current.active?.tabId) !== Number(active.tabId)) return undefined;
    current.active = { ...current.active, closing: true };
    return current;
  });
  await chrome.tabs.remove(active.tabId).catch(() => {});
  await session((current) => {
    if (Number(current.active?.tabId) === Number(active.tabId)) current.active = null;
    return current;
  });
  if (text) {
    await logActivity(text, { channel: active.login, ...(level ? { level } : {}) });
  }
}

async function postGql(tabId, operations) {
  let reply;
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      reply = await chrome.tabs.sendMessage(tabId, {
        type: MESSAGE.STREAK_GQL,
        clientId: TWITCH_WEB_CLIENT_ID,
        operations,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  if (lastError) throw new Error("No Twitch page could run the streak query.");
  if (!reply?.ok) throw new Error(reply?.error || "Twitch streak query failed.");
  const body = Array.isArray(reply.body) ? reply.body : [reply.body];
  if (body.length !== operations.length) {
    throw new Error("Twitch returned an unexpected streak response.");
  }
  return body;
}

async function acquireCourier() {
  const tabs = await chrome.tabs.query({ url: "https://www.twitch.tv/*" });
  const ready = tabs.find((tab) => tab.status === "complete" && !tab.discarded && tab.id != null);
  if (ready) return { tabId: ready.id, owned: false };
  const created = await chrome.tabs.create({ url: "https://www.twitch.tv/", active: false });
  return { tabId: created.id, owned: true };
}

async function releaseCourier(courier) {
  if (!courier?.owned) return;
  const tab = await chrome.tabs.get(courier.tabId).catch(() => null);
  if (!tab || tab.active) return;
  await chrome.tabs.remove(courier.tabId).catch(() => {});
}

async function reportQueryFailure(error) {
  const message = String(error?.message || "Twitch streak query failed.").slice(0, 180);
  let shouldLog = false;
  await session((state) => {
    if (state.authLogged) return undefined;
    shouldLog = true;
    state.authLogged = true;
    return state;
  });
  if (!shouldLog) return;
  await logActivity(`Could not read watch streaks. ${message}`, { level: "warn" });
  console.warn("Streak scan failed", error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
