// Watchdog schema 2. Built only while the local monitor is on.
//
// Scopes:
// - pauseCount, stallCount, recoveryAttempts, successfulRecoveries,
//   failedRecoveries, reloadCount, sessionPlaybackSeconds, and
//   continuousPlaybackSeconds cover this browser session, and only the time
//   the monitor has been on. They are not carried across a browser restart.
// - channelPoints.successfulClaims and failedClaims are the profile totals
//   already stored by the points observer. observedBalanceChange is this
//   monitor session, and is null when the balance is missing or abbreviated.
// - watchStreak fields stay null. The extension does not store Twitch's
//   streak count, and playback time is not used as a substitute.
//
// A missing measurement is null. A counted zero is a real zero.

import { HEALTH } from "./health.js";
import { heartbeatPayload } from "./watchdog-logic.js";

export const WATCHDOG_SCHEMA_VERSION = 2;
const EVENT_LIMIT = 40;
const SAMPLE_CAP_MS = 120_000;

const FAILURES = [
  [/unmute|autoplay|notallowed|didn't interact/i, "autoplay"],
  [/quality/i, "quality"],
  [/buffer|waiting/i, "buffering"],
  [/offline/i, "offline"],
  [/no player|not loaded|missing|never started/i, "missing-player"],
  [/froze|stall|frozen/i, "stall"],
  [/paused|idle/i, "idle-pause"],
];

export function emptyWatchdogLedger(now = Date.now()) {
  return {
    sessionId: "",
    startedAt: now,
    nextEvent: 1,
    initialized: false,
    tabs: {},
    events: [],
  };
}

export function failureCategory(reason) {
  const text = String(reason || "");
  if (!text) return null;
  for (const [pattern, name] of FAILURES) {
    if (pattern.test(text)) return name;
  }
  return null;
}

export function streamReportState(entry) {
  const health = entry?.health || "";
  const reason = String(entry?.healthReason || "");
  if (health === HEALTH.MEDIA_PLAYING) return "PLAYING";
  if (health === HEALTH.BOOTING) return "STARTING";
  if (health === HEALTH.RECOVERING) return "RECOVERING";
  if (health === HEALTH.FAILED) return "FAILED";
  if (health === HEALTH.SUSPENDED) return "SUSPENDED";
  if (/offline/i.test(reason)) return "OFFLINE";
  if (health === HEALTH.STALLED || health === HEALTH.DEGRADED) {
    if (entry?.mediaPlaying === true) return "PLAYING";
    if (/paused|idle/i.test(reason)) return "PAUSED";
    if (/never started|no player|not loaded|missing/i.test(reason)) return "MISSING";
    if (health === HEALTH.DEGRADED) return "DEGRADED";
    return "STALLED";
  }
  return null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function channelOf(entry) {
  const login = String(entry?.login || entry?.observedChannel || "").trim().toLowerCase();
  return login || null;
}

function pushEvent(ledger, event, now) {
  ledger.events.push({
    id: `${ledger.sessionId}-${ledger.nextEvent}`,
    at: now,
    sessionId: ledger.sessionId,
    channel: event.channel || null,
    type: event.type,
    metadata: event.metadata || {},
  });
  ledger.nextEvent += 1;
  if (ledger.events.length > EVENT_LIMIT) {
    ledger.events.splice(0, ledger.events.length - EVENT_LIMIT);
  }
}

function pointsFor(points, channel) {
  if (!channel || !points) return null;
  return points[channel] || null;
}

function blankTab(channel) {
  return {
    channel,
    pauseCount: 0,
    stallCount: 0,
    recoveryAttempts: 0,
    recoveryHigh: 0,
    successfulRecoveries: 0,
    failedRecoveries: 0,
    reloadCount: 0,
    sessionPlaybackMs: 0,
    continuousPlaybackMs: 0,
    lastSampleAt: 0,
    lastState: "",
    lastQuality: "",
    lastReason: "",
    lastFailureCategory: null,
    lastRecoveryResult: null,
    pendingRecoveryAt: 0,
    recoveryResolved: false,
    openingBalance: null,
    knownClaims: null,
    knownFailedClaims: null,
  };
}

function noteAttempts(tab, entry, now) {
  const attempts = Number(entry?.recoveryAttempts);
  const stage = String(entry?.recoveryStage || "");
  const recovering = entry?.health === "recovering" || stage !== "";
  const markPending = () => {
    tab.pendingRecoveryAt = Number(entry?.lastRecoveryAt) > 0 ? Number(entry.lastRecoveryAt) : now;
    tab.recoveryResolved = false;
  };
  if (!Number.isFinite(attempts) || attempts < 0) {
    if (recovering && !(Number(tab.pendingRecoveryAt) > 0)) markPending();
    return;
  }
  if (attempts > (Number(tab.recoveryHigh) || 0)) {
    tab.recoveryAttempts += attempts - (Number(tab.recoveryHigh) || 0);
    markPending();
  } else if (recovering && !(Number(tab.pendingRecoveryAt) > 0)) {
    markPending();
  }
  tab.recoveryHigh = attempts;
}

function pointsBlock(record, tab) {
  if (!record) {
    return {
      balance: null,
      observedBalanceChange: null,
      successfulClaims: null,
      failedClaims: null,
      lastClaimAt: null,
    };
  }
  const balance = record.balanceApproximate ? null : finite(record.balance);
  const change =
    balance == null || tab.openingBalance == null ? null : balance - tab.openingBalance;
  return {
    balance,
    observedBalanceChange: change,
    successfulClaims: Number(record.claims) || 0,
    failedClaims: Number(record.unconfirmedClaims) || 0,
    lastClaimAt: Number(record.lastClaimAt) > 0 ? Number(record.lastClaimAt) : null,
  };
}

function updateTab(ledger, previous, entry, points, now) {
  const channel = channelOf(entry);
  const tab = previous ? { ...previous, channel: channel || previous.channel } : blankTab(channel);
  const state = streamReportState(entry);
  const reason = String(entry?.healthReason || "");
  const quality = String(entry?.selectedQuality || "");
  const record = pointsFor(points, tab.channel);

  if (!previous) {
    pushEvent(ledger, { type: "stream-opened", channel: tab.channel, metadata: { tabId: entry.tabId } }, now);
  }

  if (previous && tab.lastState === "PLAYING" && tab.lastSampleAt) {
    const delta = Math.min(SAMPLE_CAP_MS, Math.max(0, now - tab.lastSampleAt));
    tab.sessionPlaybackMs += delta;
    tab.continuousPlaybackMs += delta;
  }
  if (state !== "PLAYING") tab.continuousPlaybackMs = 0;

  if (state === "PAUSED" && tab.lastState !== "PAUSED") {
    tab.pauseCount += 1;
    pushEvent(ledger, { type: "playback-paused", channel: tab.channel, metadata: { reason } }, now);
  }
  if (state === "STALLED" && tab.lastState !== "STALLED") {
    tab.stallCount += 1;
    tab.lastFailureCategory = failureCategory(reason) || "stall";
    pushEvent(
      ledger,
      { type: "playback-stalled", channel: tab.channel, metadata: { reason, category: tab.lastFailureCategory } },
      now
    );
  }
  noteAttempts(tab, entry, now);
  const pending = Number(tab.pendingRecoveryAt) > 0 && tab.recoveryResolved !== true;
  const advancedAt = Number(entry.lastAdvanceAt) || 0;

  if (state === "FAILED" && tab.lastState !== "FAILED") {
    tab.failedRecoveries += 1;
    tab.lastFailureCategory = failureCategory(reason);
    tab.lastRecoveryResult = "failed";
    if (pending) tab.recoveryResolved = true;
    pushEvent(ledger, { type: "recovery-failed", channel: tab.channel, metadata: { reason } }, now);
  }
  if (state === "OFFLINE" && tab.lastState !== "OFFLINE") {
    tab.lastFailureCategory = "offline";
    pushEvent(ledger, { type: "channel-offline", channel: tab.channel, metadata: {} }, now);
  }
  // A later PLAYING sample counts as a recovery only when frames advanced
  // after the attempt. Playback that resumes on its own is not a success.
  const attributable = pending && state === "PLAYING" && advancedAt >= tab.pendingRecoveryAt;
  if (attributable) {
    tab.successfulRecoveries += 1;
    tab.lastRecoveryResult = "ok";
    tab.recoveryResolved = true;
    pushEvent(ledger, { type: "playback-recovered", channel: tab.channel, metadata: {} }, now);
  } else if (state === "PLAYING" && tab.lastState !== "PLAYING") {
    if (pending && advancedAt > 0 && advancedAt < tab.pendingRecoveryAt) {
      tab.lastRecoveryResult = "unknown";
    } else if (!pending && (tab.lastState || !previous)) {
      pushEvent(ledger, { type: "playback-started", channel: tab.channel, metadata: {} }, now);
    }
  }
  if (previous && quality && tab.lastQuality && quality !== tab.lastQuality) {
    pushEvent(
      ledger,
      { type: "quality-changed", channel: tab.channel, metadata: { from: tab.lastQuality, to: quality } },
      now
    );
  }
  if (previous && /reload/i.test(reason) && !/reload/i.test(tab.lastReason)) {
    tab.reloadCount += 1;
    pushEvent(ledger, { type: "tab-reloaded", channel: tab.channel, metadata: {} }, now);
  }
  if (record && !record.balanceApproximate && finite(record.balance) != null && tab.openingBalance == null) {
    tab.openingBalance = finite(record.balance);
  }
  if (record) {
    const claims = Number(record.claims) || 0;
    if (tab.knownClaims != null && claims > tab.knownClaims) {
      pushEvent(
        ledger,
        {
          type: "bonus-claimed",
          channel: tab.channel,
          metadata: { at: Number(record.lastClaimAt) > 0 ? Number(record.lastClaimAt) : now },
        },
        now
      );
    }
    tab.knownClaims = claims;
    tab.knownFailedClaims = Number(record.unconfirmedClaims) || 0;
  }

  tab.lastSampleAt = now;
  tab.lastState = state || "";
  if (quality) tab.lastQuality = quality;
  tab.lastReason = reason;

  const width = finite(entry.videoWidth);
  const height = finite(entry.videoHeight);
  const failure =
    state === "PAUSED" || state === "PLAYING" || state === "STARTING" ? null : tab.lastFailureCategory;
  return {
    tab,
    stream: {
      channel: tab.channel,
      tabId: entry.tabId,
      expectedLive: entry.streamId ? true : /offline/i.test(reason) ? false : null,
      visibility: entry.playerHidden === true ? "hidden" : entry.playerHidden === false ? "visible" : null,
      state,
      muted: typeof entry.muted === "boolean" ? entry.muted : null,
      paused: state === "PLAYING" ? false : state === "PAUSED" ? true : typeof entry.playerPaused === "boolean" ? entry.playerPaused : null,
      advancing: state === "PLAYING" ? true : state === "PAUSED" || state === "STALLED" ? false : null,
      quality: quality || null,
      videoWidth: width && width > 0 ? width : null,
      videoHeight: height && height > 0 ? height : null,
      lastProgressAt: Number(entry.lastAdvanceAt) > 0 ? Number(entry.lastAdvanceAt) : null,
      sessionPlaybackSeconds: Math.floor(tab.sessionPlaybackMs / 1000),
      continuousPlaybackSeconds: Math.floor(tab.continuousPlaybackMs / 1000),
      decodedFrames: finite(entry.decodedFrames),
      droppedFrames: finite(entry.droppedFrames),
      playerError: entry.playerError ? String(entry.playerError) : null,
      pauseCount: tab.pauseCount,
      stallCount: tab.stallCount,
      recoveryAttempts: tab.recoveryAttempts,
      successfulRecoveries: tab.successfulRecoveries,
      failedRecoveries: tab.failedRecoveries,
      reloadCount: tab.reloadCount,
      lastFailureCategory: failure,
      lastRecoveryAction: entry.recoveryStage ? String(entry.recoveryStage) : null,
      lastRecoveryResult: tab.lastRecoveryResult,
      channelPoints: pointsBlock(record, tab),
      watchStreak: { count: null, successfulClaims: null, lastDetectedAt: null },
    },
  };
}

export function foldWatchdogLedger(ledger, { managed = {}, points = {}, now = Date.now() } = {}) {
  const next = {
    sessionId: String(ledger?.sessionId || ""),
    startedAt: Number(ledger?.startedAt) > 0 ? Number(ledger.startedAt) : now,
    nextEvent: Number(ledger?.nextEvent) > 0 ? Number(ledger.nextEvent) : 1,
    initialized: ledger?.initialized === true,
    tabs: {},
    events: Array.isArray(ledger?.events) ? ledger.events.map((event) => ({ ...event })) : [],
  };
  for (const [key, tab] of Object.entries(ledger?.tabs || {})) next.tabs[key] = { ...tab };

  if (next.sessionId && !next.initialized) {
    pushEvent(next, { type: "extension-initialized", channel: null, metadata: {} }, now);
    next.initialized = true;
  }

  const seen = new Set();
  const streams = [];
  for (const entry of Object.values(managed || {})) {
    if (!entry || entry.tabId == null || !next.sessionId) continue;
    const key = String(entry.tabId);
    seen.add(key);
    const row = updateTab(next, next.tabs[key] || null, entry, points, now);
    next.tabs[key] = row.tab;
    streams.push(row.stream);
  }
  for (const key of Object.keys(next.tabs)) {
    if (seen.has(key)) continue;
    pushEvent(
      next,
      { type: "stream-closed", channel: next.tabs[key].channel || null, metadata: { tabId: Number(key) } },
      now
    );
    delete next.tabs[key];
  }
  return { ledger: next, streams };
}

export function acknowledgeWatchdogEvents(ledger, ids) {
  const ack = new Set((ids || []).map((id) => String(id)));
  return {
    ...ledger,
    tabs: { ...(ledger?.tabs || {}) },
    events: (ledger?.events || []).filter((event) => !ack.has(String(event.id))),
  };
}

export function reconciliationTelemetry(record) {
  if (!record || typeof record !== "object") {
    return {
      configured: null,
      reconciliationState: null,
      reconciliationStartedAt: null,
      reconciliationCompletedAt: null,
      reconciliation: null,
    };
  }
  const started = Number(record.startedAt) > 0 ? Number(record.startedAt) : null;
  const completed = Number(record.completedAt) > 0 ? Number(record.completedAt) : null;
  const timeToExpected = Number(record.timeToExpectedMs);
  return {
    configured: Number.isFinite(Number(record.configured)) ? Number(record.configured) : null,
    reconciliationState: record.state || null,
    reconciliationStartedAt: started,
    reconciliationCompletedAt: completed,
    reconciliation: {
      state: record.state || null,
      configured: Number.isFinite(Number(record.configured)) ? Number(record.configured) : null,
      openTwitchTabs: Number(record.openTwitchTabs) || 0,
      matchingTabs: Number(record.matchingTabs) || 0,
      adopted: Number(record.adopted) || 0,
      opened: Number(record.opened) || 0,
      skipped: Number(record.skipped) || 0,
      managed: Number.isFinite(Number(record.managed)) ? Number(record.managed) : null,
      startedAt: started,
      completedAt: completed,
      timeToExpectedMs: Number.isFinite(timeToExpected) ? timeToExpected : null,
    },
  };
}

export function heartbeatReport({
  version = "",
  at = 0,
  managed = 0,
  playing = 0,
  stalled = 0,
  instanceId = "",
  sessionId = "",
  startedAt = 0,
  streams = [],
  events = [],
  reconciliation = null,
} = {}) {
  const instant = Number(at);
  let lastPlaybackAt = null;
  for (const stream of streams) {
    if (Number(stream?.lastProgressAt) > (lastPlaybackAt || 0)) lastPlaybackAt = Number(stream.lastProgressAt);
  }
  return {
    schemaVersion: WATCHDOG_SCHEMA_VERSION,
    ...heartbeatPayload({ version, managed, playing, stalled, at }),
    instanceId: String(instanceId || ""),
    sessionId: String(sessionId || ""),
    startedAt: Number(startedAt) > 0 ? Number(startedAt) : 0,
    uptimeMs: Number(startedAt) > 0 && instant > startedAt ? Math.floor(instant - startedAt) : 0,
    lastPlaybackAt,
    ...reconciliationTelemetry(reconciliation),
    streams,
    events,
  };
}
