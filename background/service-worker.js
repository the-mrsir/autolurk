import { ALARMS, GROUP_NAME, MESSAGE, PUBLIC_SCALE, SESSION_KEYS, qualityMessage } from "../shared/constants.js";
import { startupPollNeedsRetry } from "../shared/poll-logic.js";
import { makeSyncGroup, normalizeSyncGroup } from "../shared/sync-logic.js";
import { HEALTH } from "../shared/health.js";
import {
  getAuth,
  getFavorites,
  getFollows,
  getLiveState,
  getManagedTabs,
  getMeta,
  getSessionValue,
  getSettings,
  mutateMeta,
  saveMeta,
  saveSettings,
  setSessionValue,
  updateManagedTab,
} from "../shared/storage.js";
import {
  cancelDeviceFlow,
  disconnectTwitch,
  pollDeviceToken,
  refreshAccessToken,
  startDeviceFlow,
  validateToken,
} from "./auth.js";
import {
  broadcastConfigChange,
  getPageConfig,
  recordPointsBalance,
  recordPointsClaim,
} from "./channel-points.js";
import { openDropsInventory } from "./drops.js";
import {
  focusGridTab,
  gridTiles,
  handleMultistreamTabRemoved,
  isGridTab,
  reconcileMultistream,
  setMultistreamAudio,
  startMultistream,
  stopMultistream,
} from "./multistream.js";
import { NOTIFICATION_BUTTONS } from "./notifications.js";
import { runMigrations } from "./migrations.js";
import { recordSevenTvExtension } from "./seventv.js";
import { rotateServerStreams, rotateServerStreamsIfDue } from "./server-rotation.js";
import { noteStreakTabClosed, scanWatchStreaks, stopWatchStreaks, tickWatchStreaks } from "./streaks.js";
import { checkForUpdate } from "./updates.js";
import {
  addChannelByLogin,
  adoptNavigatedChannel,
  buildSnapshot,
  enforceSyncedFavoriteIntent,
  handleChannelChanged,
  handleManagedNavigation,
  handleManualTabClose,
  handleNotificationClick,
  pollLiveState,
  reconcileStartupChannels,
  reconcileStartupChannelsIfShort,
  refreshStreamForUser,
  snoozeStream,
  syncFollows,
  toggleFavorite,
  unsnoozeStream,
  updateBadge,
  updateFavorite,
} from "./stream-manager.js";
import {
  adoptExistingTab,
  closeManagedForUser,
  consolidateIfSplit,
  muteAutoLurkTabs,
  focusOrOpen,
  getManagedTabForUser,
  isBootstrapActivation,
  pinAllManagedQualities,
  reconcileManagedTabs,
  releaseManagedTab,
  updateLiveGroup,
  wakeManagedTab,
} from "./tab-manager.js";
import {
  ensureSyncGroup,
  exportData,
  handleSyncChange,
  importData,
  reconcileSync,
  schedulePush,
  syncNow,
} from "./sync.js";
import { handleHealthTick, runWakeRecovery, WAKE_GAP_MS } from "./wake.js";
import { parkWatchdog, readWatchdogSettings, runWatchdogHeartbeat, saveWatchdogSettings } from "./watchdog.js";
import {
  consumeExtensionMute,
  handleBootWatchAlarm,
  handlePlayerBoot,
  handlePlayerHealth,
  parseBootWatchAlarm,
  requestRecovery,
  resetHealth,
  runHealthCheck,
} from "./stream-boot.js";

// ---------------------------------------------------------------------------
// Lifecycle
//
// In Manifest V3 this file is re-evaluated every time the worker wakes, which
// can be many times an hour. Listener registration has to be synchronous.
// Returning the promise is what keeps the worker alive until the poll finishes;
// a listener that returns immediately lets Chrome stop the worker while the
// startup poll is still in flight, which is a launch that never opens streams.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  const pending = initialize({ reset: true });
  pending.catch((error) => console.warn("Install init failed", error));
  return pending;
});

chrome.runtime.onStartup.addListener(() => {
  const pending = initialize({ reset: true, startup: true });
  pending.catch((error) => console.warn("Startup init failed", error));
  return pending;
});

// Chrome fires onInstalled and onStartup in the same session after an update,
// and both want exactly this work. Running it twice re-randomises the alarm
// schedule and spends a second Twitch poll for nothing, so a request that
// arrives while one is already underway is folded into it rather than queued
// behind it. The options object is shared, so a later request can still widen
// the run that is already going as long as it has not read the flag yet.
let initInFlight = null;

function initialize(options = {}) {
  if (initInFlight) {
    initInFlight.options.reset ||= Boolean(options.reset);
    initInFlight.options.startup ||= Boolean(options.startup);
    return initInFlight.promise;
  }

  const entry = { options: { reset: Boolean(options.reset), startup: Boolean(options.startup) } };
  entry.promise = runInitialize(entry.options).finally(() => {
    if (initInFlight === entry) initInFlight = null;
  });
  initInFlight = entry;
  return entry.promise;
}

async function runInitialize(options) {
  const { reset } = options;
  await runMigrations();
  const previousMeta = await getMeta();
  await ensureSyncGroup().catch((error) => console.warn("Sync code failed", error));
  // Before anything acts on favorites, so a machine that was switched off does
  // not spend a poll opening streams the user unstarred on the other one.
  await reconcileSync().catch((error) => console.warn("Sync reconcile failed", error));
  await scheduleAlarms({ reset });
  await parkWatchdog().catch((error) => console.warn("Local monitor schedule failed", error));
  await reconcileMultistream().catch((error) => console.warn("Multistream reconcile failed", error));
  await reconcileManagedTabs();
  // Favorites and tabs that Brave already restored. This does not wait on
  // Twitch or the local monitor. A heartbeat that fails afterwards cannot
  // undo the registry this just rebuilt.
  await reconcileStartupChannels().catch((error) =>
    console.warn("Startup reconciliation failed", error)
  );
  await runWatchdogHeartbeat().catch((error) => console.warn("Local monitor failed", error));
  await buildSnapshot();
  await updateBadge();
  // Start the sleep-detection clock here, or the first health check after a
  // browser restart measures its gap against whenever the browser was last
  // closed and mistakes an ordinary startup for a wake.
  await saveMeta({ lastHealthTickAt: Date.now() });

  const auth = await getAuth();
  if (auth.accessToken) {
    const managed = await getManagedTabs();
    const gap = Date.now() - Number(previousMeta.lastSuccessfulPollAt || previousMeta.lastPollAt || 0);
    // A freeze outlives the session that started it. Tabs left suspended by a
    // wake whose poll never completed have to be finished here, or the restart
    // polls straight past them and nothing may act on the result anyway.
    const frozen = Boolean(previousMeta.wakeRecheckPending);
    const waking = options.startup && gap >= WAKE_GAP_MS;
    if (Object.keys(managed).length && (frozen || waking)) {
      const wakeGap = waking ? gap : Number(previousMeta.lastWakeGapMs) || gap;
      await runWakeRecovery(wakeGap, Date.now(), { retry: frozen && !waking }).catch((error) =>
        console.warn("Startup wake recovery failed", error)
      );
    } else {
      await pollWhenReady();
    }
  }
}

// The first poll of a launch. Twitch is often unreachable for a few seconds
// after the window appears; a failure here used to wait for the regular poll,
// which is minutes away, so nothing happened until Refresh.
async function pollWhenReady() {
  let result = null;
  try {
    result = await pollLiveState();
  } catch (error) {
    console.warn("Initial live poll failed", error);
  }
  const attempts = Number(await getSessionValue(SESSION_KEYS.STARTUP_POLLS, 0)) || 0;
  if (!startupPollNeedsRetry(result?.status, attempts)) {
    await chrome.alarms.clear(ALARMS.STARTUP_POLL);
    return result;
  }
  await setSessionValue(SESSION_KEYS.STARTUP_POLLS, attempts + 1);
  await chrome.alarms.create(ALARMS.STARTUP_POLL, { delayInMinutes: 0.25 });
  return result;
}

function randomMinutes(min, max) {
  return min + Math.random() * (max - min);
}

async function alarmSpecs() {
  const settings = await getSettings();
  const seconds = settings.checkIntervalSeconds || PUBLIC_SCALE.defaultCheckIntervalSeconds;
  return [
    {
      name: ALARMS.POLL_LIVE,
      options: {
        delayInMinutes: randomMinutes(0.2, PUBLIC_SCALE.startupJitterMaxMinutes),
        periodInMinutes: Math.max(1, seconds / 60),
      },
    },
    {
      name: ALARMS.SYNC_FOLLOWS,
      options: {
        delayInMinutes: randomMinutes(1, 5),
        periodInMinutes: PUBLIC_SCALE.followSyncMinutes,
      },
    },
    { name: ALARMS.VALIDATE_TOKEN, options: { periodInMinutes: 50 } },
    { name: ALARMS.HEALTH_CHECK, options: { periodInMinutes: 1 } },
    // Hourly is enough. RewardList does not change minute to minute, and a
    // recovery already in progress is advanced by the health check instead.
    { name: ALARMS.STREAK_CHECK, options: { delayInMinutes: 2, periodInMinutes: 60 } },
    // Unpacked copies do not update themselves. This only looks. The dashboard
    // button is what replaces the folder.
    { name: ALARMS.UPDATE_CHECK, options: { delayInMinutes: 10, periodInMinutes: 720 } },
    // One stream every two minutes. The handler does nothing until Server
    // rotation is turned on.
    { name: ALARMS.SERVER_ROTATE, options: { delayInMinutes: 2, periodInMinutes: 2 } },
  ];
}

// Alarms left behind by removed features must be cleared, or Chrome keeps
// waking the worker for a handler that no longer exists.
const RETIRED_ALARMS = ["drops-reminder"];

// reset=false only fills in alarms Chrome no longer has, so waking the worker
// never restarts a running schedule.
async function scheduleAlarms({ reset = false } = {}) {
  const specs = await alarmSpecs();
  for (const spec of specs) {
    if (!reset) {
      const existing = await chrome.alarms.get(spec.name);
      if (existing) continue;
    }
    await chrome.alarms.create(spec.name, spec.options);
  }

  for (const name of RETIRED_ALARMS) await chrome.alarms.clear(name);
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    switch (alarm.name) {
      case ALARMS.POLL_LIVE:
        await pollLiveState();
        return;
      case ALARMS.STARTUP_POLL:
        await pollWhenReady();
        await buildSnapshot();
        return;
      case ALARMS.HEALTH_CHECK:
        // Group repair must run first. Player probes can take several seconds
        // per tab, while a group synced from another computer should be merged
        // as soon as this alarm fires.
        await consolidateIfSplit().catch((error) =>
          console.warn("Group consolidation failed", error)
        );
        // Nothing runs while the machine is asleep, so the gap since the last
        // tick is the only evidence that it happened at all. A wake needs the
        // opposite of an ordinary health check: find out what is still live
        // before touching any tab.
        await handleHealthTick();
        await rotateServerStreamsIfDue().catch((error) =>
          console.warn("Server rotation failed", error)
        );
        // The session outlives the worker but nothing else does, so this is
        // where a restart finds out whether the grid tab is still there.
        await reconcileMultistream().catch((error) =>
          console.warn("Multistream reconcile failed", error)
        );
        // Another pass only after a shortfall has lasted two minutes. Offline
        // channels are left alone; a channel that already has a tab is adopted.
        await reconcileStartupChannelsIfShort().catch((error) =>
          console.warn("Startup reconciliation failed", error)
        );
        await buildSnapshot();
        await tickWatchStreaks().catch((error) => console.warn("Streak check failed", error));
        return;
      case ALARMS.STREAK_CHECK:
        await scanWatchStreaks();
        return;
      case ALARMS.UPDATE_CHECK:
        await checkForUpdate().catch((error) => console.warn("Update check failed", error));
        return;
      case ALARMS.SERVER_ROTATE:
        await rotateServerStreamsIfDue().catch((error) => console.warn("Server rotation failed", error));
        await buildSnapshot();
        return;
      case ALARMS.WATCHDOG:
        // A report that races startup would still say managed: 0.
        await startupReady;
        await runWatchdogHeartbeat().catch((error) => console.warn("Local monitor failed", error));
        return;
      case ALARMS.SYNC_FOLLOWS:
        await runFollowSyncAlarm();
        return;
      case ALARMS.VALIDATE_TOKEN:
        await runTokenValidation();
        return;
      case ALARMS.DEVICE_POLL:
        await pollDeviceOnce();
        return;
      default:
        break;
    }

    const bootTabId = parseBootWatchAlarm(alarm.name);
    if (bootTabId != null) {
      await handleBootWatchAlarm(bootTabId);
      await buildSnapshot();
    }
  } catch (error) {
    console.warn("Alarm handler failed", error);
  }
});

async function runFollowSyncAlarm() {
  const [auth, meta] = await Promise.all([getAuth(), getMeta()]);
  if (!auth.accessToken) return;
  if (Date.now() - (meta.lastFollowsSyncAt || 0) < PUBLIC_SCALE.followSyncMinAgeMs) return;
  await syncFollows();
}

// A token that no longer validates must be refreshed or cleared here, otherwise
// every later request fails with no explanation in the UI.
async function runTokenValidation() {
  const auth = await getAuth();
  if (!auth.accessToken) return;

  const valid = await validateToken(auth.accessToken);
  if (valid) return;

  try {
    await refreshAccessToken();
  } catch {
    await saveMeta({
      pollStatus: "unauthorized",
      pollError: "Twitch session expired. Connect Twitch again.",
    });
  }
  await buildSnapshot();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

// Messages from extension pages may change settings and auth; messages from a
// content script may only report on the tab they came from.
function isExtensionPage(sender) {
  return Boolean(sender.url && sender.url.startsWith(chrome.runtime.getURL("")));
}

const PAGE_MESSAGES = new Set([
  MESSAGE.CONNECT,
  MESSAGE.POLL_DEVICE,
  MESSAGE.CANCEL_CONNECT,
  MESSAGE.DISCONNECT,
  MESSAGE.REFRESH_FOLLOWS,
  MESSAGE.POLL_NOW,
  MESSAGE.TOGGLE_FAVORITE,
  MESSAGE.UPDATE_FAVORITE,
  MESSAGE.UPDATE_SETTINGS,
  MESSAGE.OPEN_STREAM,
  MESSAGE.CLOSE_STREAM,
  MESSAGE.SNOOZE_STREAM,
  MESSAGE.UNSNOOZE_STREAM,
  MESSAGE.TOGGLE_AUTOMATION,
  MESSAGE.FOCUS_OR_OPEN,
  MESSAGE.ADD_CHANNEL,
  MESSAGE.ADOPT_TAB,
  MESSAGE.RELEASE_TAB,
  MESSAGE.RETRY_STREAM,
  MESSAGE.OPEN_DASHBOARD,
  MESSAGE.OPEN_DROPS,
  MESSAGE.SYNC_NOW,
  MESSAGE.EXPORT_DATA,
  MESSAGE.IMPORT_DATA,
  MESSAGE.CHECK_UPDATE,
  MESSAGE.WATCHDOG_GET,
  MESSAGE.WATCHDOG_SAVE,
  MESSAGE.START_MULTISTREAM,
  MESSAGE.STOP_MULTISTREAM,
  MESSAGE.FOCUS_MULTISTREAM,
]);

async function handleMessage(message, sender) {
  // Opening the dashboard used to only read the last snapshot. The launch poll
  // has to finish first, or the page sits there until Refresh.
  await startupReady;
  const type = message?.type;
  if (PAGE_MESSAGES.has(type) && !isExtensionPage(sender)) {
    throw new Error("That action is only available from the AutoLurk UI.");
  }

  switch (type) {
    case MESSAGE.GET_STATE:
      return buildSnapshot();
    case MESSAGE.CONNECT:
      return beginConnect();
    case MESSAGE.POLL_DEVICE:
      return pollDeviceOnce();
    case MESSAGE.CANCEL_CONNECT:
      await chrome.alarms.clear(ALARMS.DEVICE_POLL);
      await cancelDeviceFlow();
      await buildSnapshot();
      return true;
    case MESSAGE.DISCONNECT:
      await chrome.alarms.clear(ALARMS.DEVICE_POLL);
      await disconnectTwitch();
      await buildSnapshot();
      await updateBadge();
      return true;
    case MESSAGE.REFRESH_FOLLOWS: {
      let syncError = "";
      try {
        await syncFollows();
      } catch (error) {
        syncError = error.message || String(error);
      }
      const result = await pollLiveState({ force: true });
      return syncError ? { ...result, syncError } : result;
    }
    case MESSAGE.POLL_NOW:
      return pollLiveState({ force: true });
    case MESSAGE.TOGGLE_FAVORITE:
      return toggleFavorite(message.userId, message.force);
    case MESSAGE.UPDATE_FAVORITE:
      return updateFavorite(message.userId, message.patch || {});
    case MESSAGE.UPDATE_SETTINGS: {
      const previous = await getSettings();
      const patch = { ...(message.patch || {}) };
      if ("syncGroup" in patch && !normalizeSyncGroup(patch.syncGroup)) patch.syncGroup = makeSyncGroup();
      const settings = await saveSettings(patch);
      // Stamped so the user's other computer can tell whose change is newer.
      await saveMeta({ settingsUpdatedAt: Date.now() });
      schedulePush("settings");
      const nameChanged = normalizeSyncGroup(previous.syncGroup) !== normalizeSyncGroup(settings.syncGroup);
      const toggleChanged = (previous.syncEnabled !== false) !== (settings.syncEnabled !== false);
      if (nameChanged || toggleChanged) {
        await reconcileSync();
      }
      // The check interval lives in the alarm period, so rebuild the schedule.
      await scheduleAlarms({ reset: true });
      if (!previous.serverRotation && settings.serverRotation) {
        // The standing alarm waits two minutes. Open the first stream before
        // this handler returns, or Chrome stops the worker and nothing moves.
        await rotateServerStreams().catch((error) => console.warn("Server rotation failed", error));
      }
      if (
        previous.backgroundQuality !== settings.backgroundQuality ||
        previous.watchingQuality !== settings.watchingQuality
      ) {
        await pinAllManagedQualities();
      }
      // Open Twitch tabs cache the claim setting, so tell them it moved.
      await broadcastConfigChange();
      if (previous.saveWatchStreaks && !settings.saveWatchStreaks) {
        await stopWatchStreaks();
      } else if (!previous.saveWatchStreaks && settings.saveWatchStreaks && settings.automationEnabled) {
        scanWatchStreaks().catch((error) => console.warn("Streak scan failed", error));
      }
      await buildSnapshot();
      await updateBadge();
      return settings;
    }
    case MESSAGE.OPEN_STREAM:
    case MESSAGE.FOCUS_OR_OPEN: {
      const channel = await resolveChannelForUser(message.userId);
        if (await getManagedTabForUser(message.userId)) {
          return focusOrOpen(channel, null);
        }
        const stream = await refreshStreamForUser(message.userId);
        return focusOrOpen(channel, stream);
    }
    case MESSAGE.ADOPT_TAB: {
      const channel = await resolveChannelForUser(message.userId);
      const live = await getLiveState();
      return adoptExistingTab(channel, live[message.userId]);
    }
    case MESSAGE.RELEASE_TAB:
      await releaseManagedTab(message.userId);
      await buildSnapshot();
      return true;
    case MESSAGE.RETRY_STREAM: {
      const managed = await getManagedTabs();
      const entry = Object.values(managed).find(
        (item) => String(item.userId) === String(message.userId)
      );
      if (!entry) throw new Error("That stream is not being managed right now.");
      await requestRecovery(entry.tabId, "manual retry");
      await buildSnapshot();
      return true;
    }
    case MESSAGE.CLOSE_STREAM:
      await closeManagedForUser(message.userId);
      await buildSnapshot();
      await updateBadge();
      return true;
    case MESSAGE.SNOOZE_STREAM:
      return snoozeStream(message.userId);
    case MESSAGE.UNSNOOZE_STREAM:
      return unsnoozeStream(message.userId);
    case MESSAGE.TOGGLE_AUTOMATION: {
      const settings = await getSettings();
      return handleMessage(
        {
          type: MESSAGE.UPDATE_SETTINGS,
          patch: { automationEnabled: !settings.automationEnabled },
        },
        sender
      );
    }
    case MESSAGE.ADD_CHANNEL:
      return addChannelByLogin(message.login);
    case MESSAGE.OPEN_DASHBOARD:
      await openDashboard(message.hash || "");
      return true;
    case MESSAGE.OPEN_DROPS:
      await openDropsInventory();
      return true;
    case MESSAGE.SYNC_NOW:
      return syncNow();
    case MESSAGE.EXPORT_DATA:
      return exportData();
    case MESSAGE.CHECK_UPDATE:
      return checkForUpdate(message.url);
    case MESSAGE.IMPORT_DATA: {
      const result = await importData(message.payload);
      await buildSnapshot();
      await updateBadge();
      return result;
    }
    case MESSAGE.START_MULTISTREAM: {
      const result = await startMultistream(message.userIds || []);
      await buildSnapshot();
      return result;
    }
    case MESSAGE.STOP_MULTISTREAM: {
      const result = await stopMultistream();
      await buildSnapshot();
      return result;
    }
    case MESSAGE.FOCUS_MULTISTREAM:
      return focusGridTab();
    case MESSAGE.SET_MULTISTREAM_AUDIO: {
      // Sent by the dashboard and by the grid page itself, so a content script
      // asking for this has to actually be the grid.
      if (!isExtensionPage(sender) && !(await isGridTab(sender.tab?.id))) {
        throw new Error("That action is only available from the AutoLurk UI.");
      }
      const result = await setMultistreamAudio(message.userId);
      await buildSnapshot();
      return result;
    }
    case MESSAGE.MULTISTREAM_TILES:
      // Asked by the grid document and by each player frame inside it. Both
      // report the grid tab as their sender.
      return sender.tab?.id != null ? gridTiles(sender.tab.id) : null;

    // --- content script reports, scoped to the sending tab ------------------
    case MESSAGE.AM_I_MANAGED: {
      if (!sender.tab?.id) return false;
      const managed = await getManagedTabs();
      return Boolean(managed[String(sender.tab.id)]);
    }
    case MESSAGE.PLAYER_BOOT: {
      if (!sender.tab?.id) return false;
      const entry = await handlePlayerBoot(sender.tab.id, message);
      // The group title carries the managed count, so refresh it once a tab
      // actually reaches playback rather than on every boot stage.
      if (entry?.health === HEALTH.MEDIA_PLAYING) await updateLiveGroup(await getManagedTabs());
      await buildSnapshot();
      return true;
    }
    case MESSAGE.PLAYER_HEALTH:
      // Fires every 20s per managed tab, so it skips the snapshot rebuild.
      if (sender.tab?.id) await handlePlayerHealth(sender.tab.id, message);
      return true;
    case MESSAGE.CHANNEL_CHANGED:
      if (sender.tab?.id) {
        await resetHealth(sender.tab.id);
        await handleChannelChanged(sender.tab.id, message.login);
      }
      return true;
    case MESSAGE.PAGE_CONFIG:
      return getPageConfig(sender.tab?.id);
    case MESSAGE.POINTS_CLAIMED: {
      if (!sender.tab?.id) return false;
      await recordPointsClaim(message.login, message);
      await buildSnapshot();
      return true;
    }
    case MESSAGE.POINTS_BALANCE:
      // Arrives every 20s per Twitch tab, so it skips the snapshot rebuild.
      if (sender.tab?.id) await recordPointsBalance(message.login, message.balanceText);
      return true;
    case MESSAGE.SEVENTV_DETECTED:
      if (sender.tab?.id) await recordSevenTvExtension(Boolean(message.present));
      return true;
    case MESSAGE.WATCHDOG_GET:
      return readWatchdogSettings();
    case MESSAGE.WATCHDOG_SAVE:
      return saveWatchdogSettings(message.patch || {});
    default:
      return null;
  }
}

async function resolveChannelForUser(userId) {
  const [follows, live, favorites] = await Promise.all([
    getFollows(),
    getLiveState(),
    getFavorites(),
  ]);
  const channel = follows[userId] ||
    live[userId] || {
      userId,
      login: favorites[userId]?.login,
      displayName: favorites[userId]?.displayName,
    };
  if (!channel.login) throw new Error("Channel not found.");
  return channel;
}

// ---------------------------------------------------------------------------
// Device code sign-in
// ---------------------------------------------------------------------------

async function beginConnect() {
  const flow = await startDeviceFlow();
  try {
    await chrome.tabs.create({ url: flow.verificationUri, active: true });
  } catch {
    // The UI still shows the activate link.
  }
  // The open UI polls quickly; the alarm is the fallback if it is closed.
  await chrome.alarms.create(ALARMS.DEVICE_POLL, { periodInMinutes: 1 });
  return flow;
}

async function pollDeviceOnce() {
  const meta = await getMeta();
  const flow = meta.deviceFlow;
  if (!flow) {
    await chrome.alarms.clear(ALARMS.DEVICE_POLL);
    return { status: "idle" };
  }

  if (Date.now() > flow.expiresAt) {
    await chrome.alarms.clear(ALARMS.DEVICE_POLL);
    await cancelDeviceFlow();
    await buildSnapshot();
    return { status: "expired", error: "The sign-in code expired. Try connecting again." };
  }

  const result = await pollDeviceToken(flow);
  if (result.status === "authorized") {
    await chrome.alarms.clear(ALARMS.DEVICE_POLL);
    try {
      await syncFollows();
    } catch (error) {
      console.warn("Initial follow sync failed", error);
    }
    await pollLiveState({ force: true }).catch(() => {});
  } else if (["expired", "denied", "error"].includes(result.status)) {
    await chrome.alarms.clear(ALARMS.DEVICE_POLL);
  }

  await buildSnapshot();
  return result;
}

async function openDashboard(hash = "") {
  const base = chrome.runtime.getURL("dashboard/dashboard.html");
  const url = hash ? `${base}#${hash}` : base;
  const open = await chrome.tabs.query({});
  const existing = open.find((tab) => String(tab.url || "").startsWith(base));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

// ---------------------------------------------------------------------------
// Tab and window events
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.mutedInfo) {
      const muted = Boolean(changeInfo.mutedInfo.muted);
      const fromUs = consumeExtensionMute(tabId);
      const managed = await updateManagedTab(tabId, (entry) => {
        const next = { ...entry, muted };
        // A mute this worker just applied is not the user changing their mind.
        if (fromUs) return next;
        if (!muted) next.userUnmuted = true;
        else if (changeInfo.mutedInfo.reason === "user") next.userUnmuted = false;
        return next;
      });
      const entry = managed[String(tabId)];
      if (entry) {
        const type = entry.userUnmuted
          ? MESSAGE.PIN_HIGH_QUALITY
          : tab?.active
            ? MESSAGE.PIN_VIEWING_QUALITY
            : MESSAGE.PIN_LOW_QUALITY;
        const settings = await getSettings();
        await chrome.tabs.sendMessage(Number(tabId), qualityMessage(type, settings)).catch(() => {});
      }
    }

    if (changeInfo.status === "loading" && changeInfo.url) {
      // A fresh document invalidates every piece of playback evidence.
      await resetHealth(tabId);
    }

    if (changeInfo.url || tab?.url) {
      const url = changeInfo.url || tab.url;
      await handleManagedNavigation(tabId, url);
      if (changeInfo.url || changeInfo.status === "complete") {
        await adoptNavigatedChannel(tabId, url);
      }
    }
  } catch (error) {
    console.warn("Tab update handler failed", error);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    await wakeManagedTab(activeInfo.tabId);
    const [managed, settings] = await Promise.all([getManagedTabs(), getSettings()]);
    const others = await Promise.all(
      Object.values(managed)
        .filter((entry) => Number(entry.tabId) !== Number(activeInfo.tabId))
        .map(async (entry) => ({
          entry,
          tab: await chrome.tabs.get(Number(entry.tabId)).catch(() => null),
        }))
    );
    await Promise.all(
      others
        .filter(({ tab }) => tab && !tab.active)
        .map(({ entry, tab }) =>
          chrome.tabs
            .sendMessage(
              Number(tab.id),
              qualityMessage(
                entry.userUnmuted ? MESSAGE.PIN_HIGH_QUALITY : MESSAGE.PIN_LOW_QUALITY,
                settings
              )
            )
            .catch(() => {})
        )
    );
    if (!isBootstrapActivation(activeInfo.tabId)) {
      const activeEntry = managed[String(activeInfo.tabId)];
      await chrome.tabs
        .sendMessage(
          activeInfo.tabId,
          qualityMessage(
            activeEntry?.userUnmuted ? MESSAGE.PIN_HIGH_QUALITY : MESSAGE.PIN_VIEWING_QUALITY,
            settings
          )
        )
        .catch(() => {});
    }
  } catch (error) {
    console.warn("Tab activate handler failed", error);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await noteStreakTabClosed(tabId);
    // Closing the grid tab is how most sessions end, so it is checked before
    // the managed-tab bookkeeping that the rest of this handler does.
    await handleMultistreamTabRemoved(tabId);
    await handleManualTabClose(tabId);
  } catch (error) {
    console.warn("Tab close handler failed", error);
  }
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
  try {
    await mutateMeta((meta) =>
      meta.groupId === group.id ? { ...meta, groupId: null } : undefined
    );
  } catch (error) {
    console.warn("Tab group removal handler failed", error);
  }
});

async function reconcileNamedAutoLurkGroup(group) {
  if (!String(group?.title || "").startsWith(GROUP_NAME)) return;
  try {
    await consolidateIfSplit();
    await muteAutoLurkTabs();
  } catch (error) {
    console.warn("Synced tab group reconciliation failed", error);
  }
}

// Chrome tab-group sync can materialize the other computer's AutoLurk group
// at any time. Merge it immediately instead of waiting for a stream event.
chrome.tabGroups.onCreated.addListener(reconcileNamedAutoLurkGroup);
chrome.tabGroups.onUpdated.addListener(reconcileNamedAutoLurkGroup);

// ---------------------------------------------------------------------------
// Sync from the user's other computers
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "sync") return;
  try {
    if (await handleSyncChange(changes)) {
      // Snooze and unfavorite are user intent, not live-state guesses. Apply
      // them to local/synced group tabs even before this machine has Twitch
      // authorization for an offline check.
      await enforceSyncedFavoriteIntent();
      // Evaluate newly synced favorites now instead of waiting for the next
      // periodic Twitch poll.
      await pollLiveState().catch(() => {});
      await buildSnapshot();
      await updateBadge();
    }
  } catch (error) {
    console.warn("Sync change handler failed", error);
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener(async (notificationId) => {
  try {
    await handleNotificationClick(notificationId);
    await chrome.notifications.clear(notificationId);
  } catch (error) {
    console.warn("Notification click failed", error);
  }
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  try {
    if (buttonIndex === NOTIFICATION_BUTTONS.OPEN) {
      await handleNotificationClick(notificationId);
    }
    await chrome.notifications.clear(notificationId);
  } catch (error) {
    console.warn("Notification button failed", error);
  }
});

// Repair alarms Chrome dropped without restarting healthy schedules.
scheduleAlarms({ reset: false }).catch((error) => {
  console.warn("Alarm check failed", error);
});
parkWatchdog().catch((error) => {
  console.warn("Local monitor schedule failed", error);
});

// onStartup is not delivered when Chrome starts a worker that was not already
// running. Session storage is empty after the browser process starts and
// survives the worker being killed later, so the first wake of a session — an
// alarm, a restored tab, or the dashboard — runs the launch poll. Later wakes
// in the same session leave the schedule alone.
const startupReady = ensureBrowserStartup();

async function ensureBrowserStartup() {
  if (await getSessionValue(SESSION_KEYS.BOOTED, false)) {
    // The browser session is already up. The worker itself was discarded, so
    // the open Twitch tabs have to be claimed again before the next report.
    await reconcileStartupChannels().catch((error) =>
      console.warn("Startup reconciliation failed", error)
    );
    await runWatchdogHeartbeat().catch((error) => console.warn("Local monitor failed", error));
    return;
  }
  await setSessionValue(SESSION_KEYS.BOOTED, true);
  await initialize({ reset: true, startup: true }).catch((error) =>
    console.warn("Startup init failed", error)
  );
}
