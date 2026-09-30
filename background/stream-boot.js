import { MESSAGE, opensInFront } from "../shared/constants.js";
import {
  allowedStageForVisibleTab,
  evaluateHealth,
  HEALTH,
  HEALTH_TIMING,
  nextRecoveryStage,
  RECOVERY_STAGE,
  shouldAttemptRecovery,
} from "../shared/health.js";
import { getFavorites, getManagedTabs, getSettings, mutateManagedTabs, updateManagedTab } from "../shared/storage.js";
import { normalizeLogin } from "../shared/utilities.js";
import { logActivity } from "./activity.js";
// Circular with tab-manager.js, which imports the boot watch from here. That is
// safe because every binding below is a hoisted function declaration called
// long after both modules have finished evaluating. It has to be a static
// import: dynamic import() throws inside a module service worker
// ("import() is disallowed on ServiceWorkerGlobalScope"), measured in Chrome,
// so the lazy version silently broke every recovery attempt that reached it.
import { closeManagedTab, openManagedStream, restartManagedTab } from "./tab-manager.js";

const BOOT_WATCH_PREFIX = "boot-watch-";
const PROBE_TIMEOUT_MS = 4000;

const STAGE_LOG = {
  player_found: "Twitch player detected",
  starting: "Starting background playback",
  retrying: "Retrying playback",
  verifying: "Verifying playback",
  playing: "Playback verified",
  stalled: "Player stalled",
};

function bootWatchName(tabId) {
  return `${BOOT_WATCH_PREFIX}${tabId}`;
}

// The content script gets roughly 40 seconds to start and verify playback, so
// the watchdog has to sit well past that.
export async function scheduleBootWatch(tabId) {
  const name = bootWatchName(tabId);
  await chrome.alarms.clear(name);
  await chrome.alarms.create(name, { delayInMinutes: 1.5 });
}

export async function clearBootWatch(tabId) {
  await chrome.alarms.clear(bootWatchName(tabId));
}

export function parseBootWatchAlarm(name) {
  if (!name?.startsWith(BOOT_WATCH_PREFIX)) return null;
  const tabId = Number(name.slice(BOOT_WATCH_PREFIX.length));
  return Number.isFinite(tabId) ? tabId : null;
}

// Reloads and Twitch's own navigation drop the tab-level mute, so it is
// reapplied — but never against an explicit choice by the user. The stored
// entry is re-read here because callers often hold a snapshot taken before the
// user touched the speaker icon.
export async function ensureTabMuted(tabId) {
  const settings = await getSettings();
  if (!settings.muteTabs) return false;

  const managed = await getManagedTabs();
  const entry = managed[String(tabId)];
  if (!entry || entry.userUnmuted) return false;

  try {
    const tab = await chrome.tabs.get(Number(tabId));
    if (tab.mutedInfo?.muted) return false;
    await chrome.tabs.update(Number(tabId), { muted: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

// Folds one media report into the stored evidence. Both the page's own
// heartbeat and the background probe go through here so there is exactly one
// definition of what counts as progress.
function mergeEvidence(entry, report, at) {
  const time = Number(report.currentTime);
  const previousTime = Number(entry.lastCurrentTime);
  // Any movement counts. Twitch restarts the buffer on reconnects, which sends
  // currentTime backwards, and that still means the player is alive.
  const advanced =
    Number.isFinite(time) &&
    time > 0.2 &&
    (!Number.isFinite(previousTime) || Math.abs(time - previousTime) > 0.2);
  const playing = Boolean(report.playing);

  // A hidden Twitch tab often reports no <video> at all — layout is 0×0 and
  // getVideo used to throw the real player away. That is not a stall: the
  // page answered. Treating it as "paused" is what walked the recovery
  // ladder and refreshed already-playing lurk tabs every minute.
  if (report.hidden && report.hasVideo === false && entry.lastVerifiedAt) {
    return {
      ...entry,
      lastHeartbeatAt: at,
      backgroundUnverifiableAt: at,
    };
  }

  const next = {
    ...entry,
    lastHeartbeatAt: at,
    lastCurrentTime: Number.isFinite(time) ? time : entry.lastCurrentTime,
    lastAdvanceAt: advanced ? at : entry.lastAdvanceAt || 0,
    mediaPlaying: playing,
    backgroundUnverifiableAt: report.hasVideo === true ? 0 : entry.backgroundUnverifiableAt || 0,
  };

  if (report.channel) next.observedChannel = normalizeLogin(report.channel);
  if (typeof report.selectedQuality === "string") next.selectedQuality = report.selectedQuality;
  if (Number.isFinite(Number(report.videoWidth))) next.videoWidth = Number(report.videoWidth);
  if (Number.isFinite(Number(report.videoHeight))) next.videoHeight = Number(report.videoHeight);
  if (typeof report.adPlaying === "boolean") next.adPlaying = report.adPlaying;

  if (typeof report.muted === "boolean") {
    if (report.muted === false && entry.playerMuted !== false) next.playerUnmutedAt = at;
    next.playerMuted = report.muted;
  }

  // Moving frames on the expected channel is the strongest evidence available.
  if (playing && advanced && report.adPlaying !== true) {
    next.lastVerifiedAt = at;
    next.backgroundUnverifiableAt = 0;
    next.recoveryAttempts = 0;
    next.recoveryStage = "";
    next.reopenCount = 0;
    next.discardReloads = 0;
    next.health = HEALTH.MEDIA_PLAYING;
    next.healthReason = "";
  }

  return next;
}

// Pulls the current media state straight from the page. A tab that cannot
// answer is itself a strong signal that playback is gone.
async function probePlayer(tabId) {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(Number(tabId), { type: MESSAGE.PROBE_PLAYER }),
      new Promise((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)),
    ]);
    return response && typeof response === "object" ? response : null;
  } catch {
    // No content script: the page was replaced, crashed, or never injected.
    return null;
  }
}

export async function handlePlayerBoot(tabId, payload = {}) {
  const stage = payload.stage || "";
  const at = Date.now();
  let previous = null;

  const managed = await updateManagedTab(tabId, (entry) => {
    previous = entry;
    if (stage === "playing") {
      return mergeEvidence(
        {
          ...entry,
          // Force the advance check to see movement on the first report.
          lastCurrentTime: null,
        },
        {
          playing: true,
          currentTime: payload.currentTime,
          muted: payload.playerMuted,
          channel: payload.channel,
          adPlaying: payload.adPlaying,
        },
        at
      );
    }
    if (stage === "stalled") {
      return { ...entry, health: HEALTH.STALLED, healthReason: payload.reason || "player stalled" };
    }
    return {
      ...entry,
      health: HEALTH.BOOTING,
      healthReason: payload.reason || STAGE_LOG[stage] || stage,
    };
  });

  const entry = managed[String(tabId)];
  if (!entry || !previous) return null;

  if (stage === "playing") await clearBootWatch(tabId);
  else if (stage !== "stalled") await scheduleBootWatch(tabId);

  const wasPlaying = previous.health === HEALTH.MEDIA_PLAYING;
  const line = STAGE_LOG[stage];
  if (line && !(stage === "playing" && wasPlaying)) {
    await logActivity(payload.reason ? `${line} (${payload.reason})` : line, {
      channel: entry.login,
    });
  }

  if (stage === "playing") {
    const wasAudible = previous.playerMuted === false;
    const audible = entry.playerMuted === false;
    if (audible !== wasAudible || !wasPlaying) {
      await logActivity(
        audible
          ? "Twitch player unmuted"
          : "Twitch player still muted — will unmute when the tab is opened",
        { channel: entry.login }
      );
    }
    if (await ensureTabMuted(tabId)) await updateManagedTab(tabId, { muted: true });
    return entry;
  }

  if (stage === "stalled") {
    // A single media event is not enough evidence to reload Twitch. Let the
    // watchdog/health pass apply the boot and freeze grace periods.
    await scheduleBootWatch(tabId);
    return entry;
  }
  return entry;
}

// Push report from the page. Cheap: it only records evidence and never acts,
// so a chatty page cannot trigger recovery storms.
export async function handlePlayerHealth(tabId, report = {}) {
  const at = Date.now();
  const managed = await updateManagedTab(tabId, (entry) => mergeEvidence(entry, report, at));
  return managed[String(tabId)] || null;
}

// Drops stale playback evidence when a tab starts a fresh page load. The
// timers restart at now rather than zero so the reloading page gets a full
// window to report in before the health check calls it dead.
export async function resetHealth(tabId) {
  const at = Date.now();
  await mutateManagedTabs((current) => {
    const entry = current[String(tabId)];
    if (!entry) return undefined;
    if (
      entry.health === HEALTH.BOOTING &&
      entry.healthReason === "page reloading" &&
      at - Number(entry.openedAt || 0) < 30_000
    ) {
      return undefined;
    }
    current[String(tabId)] = {
      ...entry,
      health: HEALTH.BOOTING,
      healthReason: "page reloading",
      mediaPlaying: false,
      observedChannel: "",
      // Clearing this restores the boot grace period for the new document.
      lastVerifiedAt: 0,
      openedAt: at,
      lastHeartbeatAt: at,
      lastAdvanceAt: at,
      lastCurrentTime: null,
      backgroundUnverifiableAt: 0,
    };
    return current;
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function focusedWindowId() {
  try {
    const window = await chrome.windows.getLastFocused();
    return window.focused ? window.id : null;
  } catch {
    return null;
  }
}

// A restart takes over the screen for as long as the stream needs to start, so
// a pass that restarted every dead tab would hold the foreground for minutes
// on end — which is exactly what waking with six dead streams would do. One
// per pass means recovery is staggered a minute apart and the user keeps their
// screen.
const RESTARTS_PER_PASS = 1;

// Overlapping passes would double-act on the same tab: each restart can occupy
// the whole minute between alarms.
let healthCheckRunning = false;

// Runs on a timer for every managed tab. This is the safety net that catches a
// stream dying hours after it booted, which is what loses watch streaks.
export async function runHealthCheck() {
  if (healthCheckRunning) return;
  healthCheckRunning = true;
  try {
    await healthCheckPass();
  } finally {
    healthCheckRunning = false;
  }
}

async function healthCheckPass() {
  const managed = await getManagedTabs();
  const focused = await focusedWindowId();
  const at = Date.now();
  let restarts = 0;

  for (const [tabId, stored] of Object.entries(managed)) {
    let tab;
    try {
      tab = await chrome.tabs.get(Number(tabId));
    } catch {
      continue;
    }

    // Restoring a discarded Twitch document requires making its new page
    // visible, which can take over the user's screen. Never do that from a
    // background health check; Chrome will restore it when the user opens it,
    // or the dashboard Retry action can do so explicitly.
    if (tab.discarded || tab.status === "unloaded") {
      await handleDiscardedTab(tabId, stored);
      continue;
    }

    // Ask the page directly. Background tabs have their timers throttled, so
    // a missing heartbeat on its own is not proof of a dead stream.
    const report = await probePlayer(tabId);
    let entry = stored;
    if (report) {
      const updated = await updateManagedTab(tabId, (current) => mergeEvidence(current, report, at));
      entry = updated[String(tabId)] || stored;
    }

    const { state, reason } = evaluateHealth(entry, tab, at);
    const visible = tab.active && tab.windowId === focused;

    if (state === HEALTH.MEDIA_PLAYING) {
      if (entry.health !== HEALTH.MEDIA_PLAYING) {
        await updateManagedTab(tabId, {
          health: HEALTH.MEDIA_PLAYING,
          healthReason: "",
          recoveryAttempts: 0,
          recoveryStage: "",
        });
      }
      // A healthy pass also repairs the tab mute if a reload dropped it.
      if (await ensureTabMuted(tabId)) await updateManagedTab(tabId, { muted: true });
      continue;
    }

    if (state === HEALTH.FAILED) {
      const failedFor = at - Number(entry.failedAt || 0);
      if (failedFor >= HEALTH_TIMING.failedRetryMs && shouldAttemptRecovery(entry, at)) {
        const reset = await updateManagedTab(tabId, {
          health: HEALTH.STALLED,
          healthReason: "trying playback again",
          recoveryAttempts: 0,
          recoveryStage: "",
          lastRecoveryAt: 0,
        });
        const next = reset[String(tabId)];
        if (next) await runRecovery(tabId, next, "trying playback again", { visible });
      }
      continue;
    }

    if (
      state === HEALTH.BOOTING ||
      state === HEALTH.RECOVERING ||
      state === HEALTH.SUSPENDED
    ) {
      if (entry.health !== state) await updateManagedTab(tabId, { health: state, healthReason: reason });
      continue;
    }

    if (state === HEALTH.DEGRADED) {
      await updateManagedTab(tabId, { health: HEALTH.DEGRADED, healthReason: reason });
      // Degraded is a nudge, not a reload: the stream is still there.
      // If Twitch intentionally removed the hidden player there is nothing to
      // nudge, and doing so every minute only creates churn.
      if (
        reason !== "background player temporarily unavailable" &&
        shouldAttemptRecovery(entry, at)
      ) {
        await nudgePlayer(tabId, entry, reason);
      }
      continue;
    }

    // Everything below this point may take over the screen. Once the budget is
    // spent the remaining tabs keep their stalled state and are picked up by
    // the next pass, in the same order.
    const stage = nextRecoveryStage(entry);
    const needsScreen = stage === RECOVERY_STAGE.RELOAD || stage === RECOVERY_STAGE.REOPEN;
    // Server rotation is the thing that opens a stream and reloads it. The
    // ordinary ladder must not take the screen on its own minute as well.
    if (needsScreen && (await getSettings()).serverRotation) {
      await updateManagedTab(tabId, { health: HEALTH.STALLED, healthReason: reason });
      continue;
    }
    if (needsScreen && !visible) {
      if (restarts >= RESTARTS_PER_PASS) {
        await updateManagedTab(tabId, { health: HEALTH.STALLED, healthReason: reason });
        continue;
      }
      restarts += 1;
    }

    await runRecovery(tabId, entry, reason, { visible });
  }
}

// Chrome discards background tabs when the machine is short on memory. That is
// Chrome doing its job, so AutoLurk gets exactly one attempt to bring the
// stream back and then reports it honestly instead of reloading in a loop.
export async function handleDiscardedTab(tabId, entry) {
  if (entry.health === HEALTH.FAILED) return entry;
  return markFailed(
    tabId,
    entry,
    "Chrome discarded the tab; open it or press Retry to restore playback"
  );
}

export async function handleBootWatchAlarm(tabId) {
  const managed = await getManagedTabs();
  const entry = managed[String(tabId)];
  if (!entry) return null;
  // Wake recovery suspends every tab until Twitch has authoritatively said
  // which broadcasts survived sleep. A per-tab alarm must not bypass that
  // freeze and restart a stream which may already be offline.
  if (
    entry.health === HEALTH.MEDIA_PLAYING ||
    entry.health === HEALTH.FAILED ||
    entry.health === HEALTH.SUSPENDED
  ) {
    return entry;
  }
  if (!entry.lastVerifiedAt && Date.now() - Number(entry.openedAt || 0) < HEALTH_TIMING.bootGraceMs) {
    await scheduleBootWatch(tabId);
    return entry;
  }
  return runRecovery(tabId, entry, "no response from page");
}

// Manual retry from the dashboard: always start the ladder over.
export async function requestRecovery(tabId, reason = "manual retry") {
  const managed = await updateManagedTab(tabId, (entry) => ({
    ...entry,
    // A user-initiated Retry is the only path allowed to navigate the tab.
    // Start at the reload stage instead of spending the click on a nudge.
    recoveryAttempts: 1,
    lastRecoveryAt: 0,
    health: HEALTH.RECOVERING,
    healthReason: reason,
  }));
  const entry = managed[String(tabId)];
  if (!entry) return null;
  return runRecovery(tabId, entry, reason, { force: true, allowNavigation: true });
}

// ---------------------------------------------------------------------------
// Recovery ladder
// ---------------------------------------------------------------------------

async function nudgePlayer(tabId, entry, reason) {
  await updateManagedTab(tabId, {
    lastRecoveryAt: Date.now(),
    recoveryStage: RECOVERY_STAGE.NUDGE,
    health: HEALTH.RECOVERING,
    healthReason: reason,
  });
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(Number(tabId), { type: MESSAGE.RECOVER_PLAYER, reason }),
      new Promise((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)),
    ]);
    return Boolean(response?.accepted);
  } catch {
    return false;
  }
}

// Restarting a stream always means showing its tab. Reloading one in the
// background looks cheaper and simply does not work: measured against a live
// channel, a hidden tab that is reloaded sits at readyState 0 / networkState 0
// forever because Twitch never gives the element a source. Every reload this
// stage used to do was wasted, and the ladder only ever recovered a stream
// when it reached the reopen stage and showed a tab by accident.
async function restartTab(tabId) {
  return restartManagedTab(tabId, { reason: "recovery" });
}

// A reopen creates a fresh entry, which would otherwise hand the new tab a
// fresh recovery budget and loop forever on a channel that simply will not
// play. The count rides along and is cleared once playback is verified.
const MAX_REOPENS = 2;

// Last resort before giving up: throw the tab away and open a clean one.
async function reopenStream(tabId, entry) {
  try {
    await closeManagedTab(tabId);
  } catch {
    // Tab may already be gone; opening a replacement still makes sense.
  }
  try {
    const [settings, favorites] = await Promise.all([getSettings(), getFavorites()]);
    await openManagedStream(
      {
        userId: entry.userId,
        login: entry.expectedChannel || entry.login,
        displayName: entry.displayName,
      },
      { streamId: entry.streamId },
      {
        focus: opensInFront(settings, Boolean(favorites[entry.userId])),
        carry: { reopenCount: (entry.reopenCount || 0) + 1 },
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function markFailed(tabId, entry, reason) {
  const managed = await updateManagedTab(tabId, {
    health: HEALTH.FAILED,
    healthReason: reason,
    failedAt: Date.now(),
    recoveryStage: RECOVERY_STAGE.GIVE_UP,
    mediaPlaying: false,
  });
  await clearBootWatch(tabId);
  // Nothing is decoding here, so let Chrome reclaim the tab if it is short
  // on memory. Opening it or pressing Retry pins it again.
  try {
    await chrome.tabs.update(Number(tabId), { autoDiscardable: true });
  } catch {
    // Tab may already be gone.
  }
  await logActivity(`Playback failed — ${entry.displayName || entry.login} (${reason})`, {
    channel: entry.login,
    level: "warn",
  });
  return managed[String(tabId)];
}

// Escalates one step per call: nudge the page, reload it, reopen it, give up.
export async function runRecovery(tabId, entry, reason, options = {}) {
  const at = Date.now();
  if (!options.force && !shouldAttemptRecovery(entry, at)) return entry;

  let stage = nextRecoveryStage(entry);

  // Never yank a tab the user is actually looking at. Nudging is fine; a
  // reload would destroy whatever they were reading in chat.
  if (options.visible && !allowedStageForVisibleTab(stage)) {
    return nudgePlayer(tabId, entry, reason).then(() => entry);
  }

  if (stage === RECOVERY_STAGE.GIVE_UP) {
    if (entry.health === HEALTH.FAILED) return entry;
    return markFailed(tabId, entry, reason);
  }

  if (
    !options.allowNavigation &&
    (stage === RECOVERY_STAGE.RELOAD || stage === RECOVERY_STAGE.REOPEN)
  ) {
    return markFailed(
      tabId,
      entry,
      `${reason}; automatic reload suppressed to avoid taking over the screen`
    );
  }

  const attempt = (entry.recoveryAttempts || 0) + 1;
  await updateManagedTab(tabId, (current) => ({
    ...current,
    health: HEALTH.RECOVERING,
    healthReason: reason,
    recoveryStage: stage,
    recoveryAttempts: attempt,
    lastRecoveryAt: at,
    mediaPlaying: false,
    lastHeartbeatAt: at,
    lastAdvanceAt: at,
    lastCurrentTime: null,
  }));

  const name = entry.displayName || entry.login;

  if (stage === RECOVERY_STAGE.NUDGE) {
    await logActivity(`${name} stopped playing (${reason}) — restarting the player`, {
      channel: entry.login,
    });
    await nudgePlayer(tabId, entry, reason);
    // Even a missing content-script response is only one failed recovery
    // attempt. Reloading in this same call bypasses the cooldown and lets one
    // noisy probe perform two ladder stages.
    return (await getManagedTabs())[String(tabId)] || entry;
  }

  if (stage === RECOVERY_STAGE.RELOAD) {
    await updateManagedTab(tabId, {
      recoveryStage: RECOVERY_STAGE.RELOAD,
      openedAt: Date.now(),
      lastVerifiedAt: 0,
    });
    await logActivity(`Restarting ${name} (${reason})`, { channel: entry.login });

    const result = await restartTab(tabId);
    if (result.gone) return null;

    // Chrome was behind another application, so the tab could not be put on
    // screen and nothing was actually tried. Refunding the attempt matters:
    // otherwise a user working in another app for a few minutes would watch
    // every stream walk the ladder to give-up without one real recovery.
    if (result.deferred) {
      await updateManagedTab(tabId, {
        recoveryAttempts: entry.recoveryAttempts || 0,
        recoveryStage: "",
        health: HEALTH.STALLED,
        healthReason: "waiting until Chrome is in front",
      });
      return (await getManagedTabs())[String(tabId)] || entry;
    }

    return (await getManagedTabs())[String(tabId)] || entry;
  }

  if (stage === RECOVERY_STAGE.REOPEN) {
    if ((entry.reopenCount || 0) >= MAX_REOPENS) {
      return markFailed(tabId, entry, "playback never recovered after reopening");
    }
    await logActivity(`Reopening ${name} (${reason})`, { channel: entry.login });
    if (!(await reopenStream(tabId, entry))) return markFailed(tabId, entry, "could not reopen");
    return null;
  }

  return entry;
}

export { HEALTH_TIMING };
