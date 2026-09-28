import { GROUP_NAME, MESSAGE, SESSION_KEYS } from "../shared/constants.js";
import {
  getManagedTabs,
  getMeta,
  getSessionValue,
  getSettings,
  mutateManagedTabs,
  mutateMeta,
  mutateSessionValue,
  updateManagedTab,
} from "../shared/storage.js";
import {
  extractChannelFromUrl,
  managedChannelUrl,
  normalizeLogin,
  twitchChannelUrl,
} from "../shared/utilities.js";
import { streamIsOpenable } from "../shared/poll-logic.js";
import { logActivity } from "./activity.js";
import {
  clearBootWatch,
  ensureTabMuted,
  handlePlayerHealth,
  parseBootWatchAlarm,
  scheduleBootWatch,
} from "./stream-boot.js";

// Tells a page it is managed. The content script asks once when it loads and
// then waits for this, so neither side has to poll: whichever of the two
// happens second closes the gap.
export async function announceManaged(tabId) {
  try {
    await chrome.tabs.sendMessage(Number(tabId), { type: MESSAGE.MANAGED_NOW });
  } catch {
    // Page has not injected yet. Its own AM_I_MANAGED will find the entry.
  }
}

async function pinQualityForTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(Number(tabId));
  } catch {
    return;
  }
  // tab.active means this is the selected tab in its window, which is the
  // one the user is looking at even if another window happens to have focus.
  // A background pin on that tab is how a watched stream snaps back to 160p.
  const managed = await getManagedTabs();
  const entry = managed[String(tabId)];
  const type = entry?.userUnmuted
    ? MESSAGE.PIN_HIGH_QUALITY
    : tab.active
      ? MESSAGE.PIN_VIEWING_QUALITY
      : MESSAGE.PIN_LOW_QUALITY;
  try {
    await chrome.tabs.sendMessage(Number(tabId), { type });
  } catch {
    // A fresh page may not have injected yet; document_start and the next
    // visibility pass still apply the matching preference.
  }
}

export async function reconcileManagedTabs() {
  await restoreStagingWindows();
  let tabs = await chrome.tabs.query({});
  if (await closeDuplicateStreamTabs(tabs)) tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map((tab) => [String(tab.id), tab]));

  const next = await mutateManagedTabs((managed) => {
    for (const [tabId, entry] of Object.entries(managed)) {
      const tab = byId.get(tabId);
      if (!tab) {
        delete managed[tabId];
        continue;
      }
      const url = String(tab.pendingUrl || tab.url || "");
      const observed = extractChannelFromUrl(url);
      const expected = normalizeLogin(entry.expectedChannel || entry.login);
      const loadingGrace =
        (!url || url === "about:blank" || tab.status === "loading") &&
        Date.now() - Number(entry.openedAt || 0) < 15_000;
      if (!loadingGrace && (!observed || (expected && observed !== expected))) {
        // Tab ids are only unique for one Chrome session. After a restart an
        // old managed id can refer to an unrelated restored tab; never adopt,
        // regroup, or close that tab based on the stale local entry.
        delete managed[tabId];
        continue;
      }
      managed[tabId] = {
        ...entry,
        muted: Boolean(tab.mutedInfo?.muted),
        currentUrl: tab.url || entry.currentUrl,
      };
    }
    return managed;
  });

  for (const tabId of Object.keys(next)) {
    try {
      await chrome.tabs.update(Number(tabId), { autoDiscardable: false });
    } catch {
      // Tab may already be closing.
    }
  }

  await reconcileStagingTabs(tabs, next);
  await clearOrphanedBootWatches(next);
  // Unconditionally, not just when a tab vanished. This runs on startup and is
  // the only thing that repairs a profile whose managed tabs are already split
  // across several groups.
  await updateLiveGroup(next);
  return next;
}

// Repairs both historical duplicates and an interrupted staging request. Only
// tabs already managed by AutoLurk, or tabs sitting in a group named AutoLurk,
// are candidates; two ordinary Twitch tabs the user opened remain their own.
async function closeDuplicateStreamTabs(tabs) {
  const managed = await getManagedTabs();
  const ourGroupIds = new Set();
  try {
    for (const group of await chrome.tabGroups.query({})) {
      if (String(group.title || "").startsWith(GROUP_NAME)) ourGroupIds.add(group.id);
    }
  } catch {
    // Managed entries alone are enough for the basic cleanup.
  }

  const byLogin = new Map();
  for (const tab of tabs) {
    const login = extractChannelFromUrl(tab.url);
    if (!login) continue;
    if (!managed[String(tab.id)] && !ourGroupIds.has(tab.groupId)) continue;
    const matches = byLogin.get(login) || [];
    matches.push(tab);
    byLogin.set(login, matches);
  }

  let removed = 0;
  for (const [login, matches] of byLogin) {
    if (matches.length < 2) continue;

    // Keep the tab the user is looking at. Otherwise prefer one with managed
    // playback evidence, then the oldest id (normally the original).
    matches.sort((a, b) => {
      const aEntry = managed[String(a.id)];
      const bEntry = managed[String(b.id)];
      const aScore =
        (aEntry?.health === "media_playing" ? 200 : 0) +
        (a.active ? 100 : 0) +
        (aEntry ? 20 : 0) +
        (Number(aEntry?.lastVerifiedAt) > 0 ? 10 : 0);
      const bScore =
        (bEntry?.health === "media_playing" ? 200 : 0) +
        (b.active ? 100 : 0) +
        (bEntry ? 20 : 0) +
        (Number(bEntry?.lastVerifiedAt) > 0 ? 10 : 0);
      return bScore - aScore || Number(a.id) - Number(b.id);
    });

    const keeper = matches[0];
    const source = matches.map((tab) => managed[String(tab.id)]).find(Boolean);
    const duplicates = matches.slice(1);

    await mutateManagedTabs((current) => {
      if (!current[String(keeper.id)] && source) {
        current[String(keeper.id)] = {
          ...source,
          tabId: keeper.id,
          currentUrl: keeper.url || source.currentUrl,
        };
      }
      for (const duplicate of duplicates) delete current[String(duplicate.id)];
      return current;
    });

    for (const duplicate of duplicates) {
      await clearBootWatch(duplicate.id);
      try {
        await chrome.tabs.remove(Number(duplicate.id));
        removed += 1;
      } catch {
        // It closed between the scan and cleanup.
      }
    }

    if (source && !managed[String(keeper.id)]) {
      await announceManaged(keeper.id);
      await scheduleBootWatch(keeper.id);
    }
    await logActivity(
      `Closed ${duplicates.length} duplicate ${login} tab${duplicates.length === 1 ? "" : "s"}`,
      { channel: login, level: "warn" }
    );
  }
  return removed > 0;
}

// Per-tab alarms outlive crashes, so sweep the ones whose tab is gone.
async function clearOrphanedBootWatches(managed) {
  try {
    const alarms = await chrome.alarms.getAll();
    for (const alarm of alarms) {
      const tabId = parseBootWatchAlarm(alarm.name);
      if (tabId != null && !managed[String(tabId)]) await chrome.alarms.clear(alarm.name);
    }
  } catch {
    // Alarm enumeration is best effort.
  }
}

export async function findTabForChannel(login) {
  const target = normalizeLogin(login);
  if (!target) return null;
  const tabs = await chrome.tabs.query({ url: "*://www.twitch.tv/*" });
  return (
    tabs.find((tab) => {
      if (String(tab.url || "").includes("autolurk-grid")) return false;
      return extractChannelFromUrl(tab.url) === target;
    }) || null
  );
}

// Chrome can sync a saved AutoLurk group from another computer without any of
// its tabs appearing in this computer's local managedTabs storage. Polling
// must inventory the group itself so those stale tabs can still be checked.
export async function getAutoLurkGroupedTabs() {
  const found = new Map();
  let groups;
  try {
    groups = (await chrome.tabGroups.query({})).filter((group) =>
      String(group.title || "").startsWith(GROUP_NAME)
    );
  } catch {
    return [];
  }

  for (const group of groups) {
    try {
      for (const tab of await chrome.tabs.query({ groupId: group.id })) {
        const login = extractChannelFromUrl(tab.url);
        if (!login || String(tab.url || "").includes("autolurk-grid")) continue;
        found.set(Number(tab.id), {
          tabId: Number(tab.id),
          windowId: tab.windowId,
          groupId: group.id,
          login,
          url: tab.url || "",
          muted: Boolean(tab.mutedInfo?.muted),
        });
      }
    } catch {
      // A synced group can disappear while Chrome reconciles it.
    }
  }
  return [...found.values()];
}

export function adoptGroupedStreamTab(tabId, channel, stream) {
  return withUserLock(String(channel.userId), () =>
    withBootstrapLock(async () => {
      const login = normalizeLogin(channel.login);
      const existing =
        (await getManagedTabForUser(channel.userId)) || (await getManagedTabForLogin(login));
      if (existing) return existing;

      let tab;
      try {
        tab = await chrome.tabs.get(Number(tabId));
      } catch {
        return null;
      }
      if (extractChannelFromUrl(tab.url) !== login) return null;
      return adoptTabNow(tab, channel, stream, login);
    })
  );
}

export async function closeGroupedStreamTab(tabId) {
  const managed = await getManagedTabs();
  if (managed[String(tabId)]) return closeManagedTab(tabId);
  try {
    await chrome.tabs.remove(Number(tabId));
    return true;
  } catch {
    return false;
  }
}

export async function getManagedTabForUser(userId) {
  const managed = await getManagedTabs();
  return Object.values(managed).find((entry) => String(entry.userId) === String(userId)) || null;
}

export async function getManagedTabForLogin(login) {
  const target = normalizeLogin(login);
  if (!target) return null;
  const managed = await getManagedTabs();
  return (
    Object.values(managed).find((entry) => {
      const expected = normalizeLogin(entry.expectedChannel || entry.login);
      return expected === target;
    }) || null
  );
}

// Favorite toggles, manual opens, notifications and the scheduled poll can all
// decide to open the same channel at once. Serializing per user is what stops
// AutoLurk from creating two tabs for one stream.
const openLocks = new Map();

function withUserLock(userId, run) {
  const key = String(userId);
  const previous = openLocks.get(key) || Promise.resolve();
  const result = previous.then(run, run);
  const settled = result.then(
    () => {},
    () => {}
  );
  openLocks.set(key, settled);
  settled.then(() => {
    if (openLocks.get(key) === settled) openLocks.delete(key);
  });
  return result;
}

export function openManagedStream(channel, stream, options = {}) {
  return withUserLock(String(channel.userId), () => createManagedStream(channel, stream, options));
}

// Chrome and Twitch between them are reluctant to start a stream in a tab that
// has never been visible. Measured against a live channel in a real browser:
// the video element is never handed a media source at all, so it sits at
// readyState 0 and networkState 0 indefinitely, play() has nothing to act on,
// and every reload and reopen the recovery ladder tries afterwards is doomed
// for the same reason. Playback does survive being hidden once it is running.
//
// An automatic open is therefore created as an inactive tab. Nothing here
// activates a tab, opens a window, or tells Twitch the hidden page is visible:
// that lie is what makes Twitch remove the player from the channel page. A
// stream that will not start quietly is marked as needing attention instead of
// taking over the screen. An explicit Focus/Open still uses the window the
// user asked for.
//
// One at a time, so several favorites going live together cannot interleave
// their bootstraps and leave each other's tabs half-adopted.
let bootstrapChain = Promise.resolve();
const bootstrappingTabIds = new Set();
let bootstrapCreateDepth = 0;
const stagingWindowIds = new Set();

const STAGING_BOUNDS = {
  width: 480,
  height: 320,
  left: -10000,
  top: 80,
};

async function restoreStagingWindows() {
  const stored = await getSessionValue(SESSION_KEYS.STAGING_WINDOWS, []);
  const valid = [];
  for (const rawId of stored || []) {
    const id = Number(rawId);
    try {
      await chrome.windows.get(id);
      stagingWindowIds.add(id);
      valid.push(id);
    } catch {
      stagingWindowIds.delete(id);
    }
  }
  if (valid.length !== (stored || []).length) {
    await mutateSessionValue(SESSION_KEYS.STAGING_WINDOWS, [], () => valid);
  }
}

async function rememberStaging(windowId) {
  if (windowId == null) return;
  const id = Number(windowId);
  stagingWindowIds.add(id);
  await mutateSessionValue(SESSION_KEYS.STAGING_WINDOWS, [], (ids) => [
    ...new Set([...(ids || []).map(Number), id]),
  ]);
}

async function forgetStaging(windowId) {
  if (windowId == null) return;
  const id = Number(windowId);
  stagingWindowIds.delete(id);
  await mutateSessionValue(SESSION_KEYS.STAGING_WINDOWS, [], (ids) =>
    (ids || []).map(Number).filter((value) => value !== id)
  );
}

function isStagingWindow(windowId) {
  return windowId != null && stagingWindowIds.has(Number(windowId));
}

async function ordinaryWindowId() {
  try {
    const focused = await chrome.windows.getLastFocused();
    if (focused?.id != null && focused.type === "normal" && !isStagingWindow(focused.id)) {
      return focused.id;
    }
  } catch {
    // Fall through.
  }
  try {
    const windows = await chrome.windows.getAll();
    return windows.find(
      (window) => window.type === "normal" && !isStagingWindow(window.id)
    )?.id ?? null;
  } catch {
    return null;
  }
}

async function reconcileStagingTabs(tabs, managed) {
  const destination = await ordinaryWindowId();
  for (const tab of tabs) {
    if (!isStagingWindow(tab.windowId) || bootstrappingTabIds.has(Number(tab.id))) continue;
    if (managed[String(tab.id)] && destination != null) {
      await moveIntoWindow([tab.id], destination);
      await forgetStaging(tab.windowId);
      continue;
    }
    // A worker can die after the staging tab is created but before its managed
    // entry is committed. It is safe to remove only our marked Twitch URL.
    if (!managed[String(tab.id)] && String(tab.url || "").includes("#autolurk")) {
      try {
        await chrome.tabs.remove(Number(tab.id));
      } catch {
        // It may already be gone.
      }
      await forgetStaging(tab.windowId);
    }
  }
}

export function isBootstrapActivation(tabId) {
  return bootstrapCreateDepth > 0 || bootstrappingTabIds.has(Number(tabId));
}

function withBootstrapLock(run) {
  const result = bootstrapChain.then(run, run);
  bootstrapChain = result.then(
    () => {},
    () => {}
  );
  return result;
}

// Starts on a visible tab were measured at three to ten seconds. The ceiling
// is for a preroll ad; past it the foreground is handed back regardless and
// the ordinary health check takes over, because holding the user's screen
// hostage is worse than a stream that needs one recovery pass.
//
// Mutable so tests do not have to sit through half a minute of real waiting.
export const BOOTSTRAP_TIMING = {
  visibleMs: 30_000,
  // Hidden startup is opportunistic. Keepalive gets a short chance to make
  // Twitch start in place, but auto-open must not serialize behind a long
  // timeout when Chrome refuses.
  backgroundMs: 15_000,
  pollMs: 1000,
};

// Reports whether the page ever actually came into view, not just whether it
// started. Chrome calls a tab hidden whenever its window is minimised,
// occluded or behind a lock screen, and a hidden page is never handed a media
// source, so "did not start" and "was never on screen" need opposite
// responses: one is a broken stream, the other is a reason to wait.
const HIDDEN_REPORTS_BEFORE_GIVING_UP = 3;

async function waitForPlaybackStart(tabId, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || BOOTSTRAP_TIMING.visibleMs);
  let sawPage = false;
  let everVisible = false;
  let hiddenReports = 0;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_TIMING.pollMs));

    // Polling is only safe here because the tab is in the foreground for the
    // duration. Nothing else in this extension may poll a Twitch page.
    let report = null;
    try {
      report = await chrome.tabs.sendMessage(Number(tabId), { type: MESSAGE.PROBE_PLAYER });
    } catch {
      continue; // The content script has not injected yet.
    }
    if (!report) continue;
    sawPage = true;

    // Only an explicit "hidden" counts against the tab. A page that answers
    // without the field at all is not evidence that the screen is unavailable,
    // and treating it as such would stall every restart.
    if (report.hidden !== true) {
      everVisible = true;
    } else if (
      !options.allowHidden &&
      !everVisible &&
      (hiddenReports += 1) >= HIDDEN_REPORTS_BEFORE_GIVING_UP
    ) {
      // The screen is not available. Waiting out the full timeout would
      // achieve nothing and delay every other stream queued behind the lock.
      return { started: false, sawPage, everVisible: false };
    }

    // Fold the reading into the normal evidence trail so a stream verified
    // here does not then look unverified to the first health check.
    await handlePlayerHealth(tabId, report);
    if (report.playing && Number(report.currentTime) > 0) {
      return { started: true, sawPage, everVisible };
    }
  }

  return { started: false, sawPage, everVisible };
}

// Whether Chrome is the application the user is currently in. Showing a tab
// means focusing its window, and doing that while the user is in another
// application yanks the whole browser in front of whatever they are doing.
// Restarting a stream is never worth that, so it waits instead.
async function chromeHasFocus() {
  try {
    const window = await chrome.windows.getLastFocused();
    return Boolean(window?.focused);
  } catch {
    return false;
  }
}

// Both halves of the user's place have to be remembered. Restarting a stream
// focuses the window holding the AutoLurk group, which is often not the window
// they were working in, so putting back only the tab would leave them staring
// at the wrong window.
async function captureFocus() {
  let windowId = null;
  try {
    const window = await chrome.windows.getLastFocused();
    if (window?.focused) windowId = window.id;
  } catch {
    // Fall back to restoring the tab alone.
  }

  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    // Nothing to put back.
  }
  return { windowId, tab };
}

async function restoreFocus(previous, shownTabId) {
  await restoreActiveTab(previous.tab, shownTabId);
  if (previous.windowId == null) return;
  try {
    const current = await chrome.windows.getLastFocused();
    if (current?.id === previous.windowId) return;
    await chrome.windows.update(previous.windowId, { focused: true });
  } catch {
    // The window may have closed while the stream was starting.
  }
}

// Brings a dead stream back by showing its tab, reloading it and waiting for
// playback, then handing the user's place back.
//
// A background reload cannot do this. Measured against a live channel: a
// hidden tab that is reloaded drops to readyState 0 / networkState 0 and stays
// there indefinitely, identical to a tab that has never been shown, because
// Twitch never hands the element a source. Having a document already is not
// enough; it is the new document that has to be visible.
//
// Returns shown:false when the screen was not available. That is not a
// playback failure and callers must not spend a recovery attempt on it.
export function restartManagedTab(tabId, options = {}) {
  return withBootstrapLock(() => showAndRestart(tabId, options));
}

async function showAndRestart(tabId, options = {}) {
  const managed = await getManagedTabs();
  const entry = managed[String(tabId)];
  if (!entry) return { started: false, shown: false };

  let tab;
  try {
    tab = await chrome.tabs.get(Number(tabId));
  } catch {
    return { started: false, shown: false, gone: true };
  }

  const previous = await captureFocus();
  const looking =
    Boolean(tab.active) &&
    previous.tab?.id === Number(tabId) &&
    previous.windowId === tab.windowId &&
    (await chromeHasFocus());
  const originalWindowId = tab.windowId;

  bootstrappingTabIds.add(Number(tabId));
  try {
    if (!looking) {
    // Park the tab in an off-screen window so a reload can start a player
    // without covering what the user is doing. A hidden in-place reload
    // never gets a media source.
    const parked = await parkInStaging(tab);
    if (parked == null && !(await chromeHasFocus())) {
      return { started: false, shown: false, deferred: true };
    }
    if (parked == null) {
      try {
        await chrome.tabs.update(Number(tabId), { active: true });
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        return { started: false, shown: false, deferred: true };
      }
    }
    }

    try {
    // Navigating rather than reloading in place, because the marker hash has
    // to be on the URL before the document starts: Twitch strips it, and the
    // quality pin is written at document_start or not at all. Adding only a
    // fragment is a same-document navigation, so the reload forces a real one.
    await chrome.tabs.update(Number(tabId), {
      url: managedChannelUrl(entry.expectedChannel || entry.login),
    });
    await chrome.tabs.reload(Number(tabId));
    } catch {
      if (looking) await restoreFocus(previous, tabId);
      else await returnFromStaging(tabId, originalWindowId);
      return { started: false, shown: false, deferred: true };
    }

    const { started, sawPage, everVisible } = await waitForPlaybackStart(tabId);
    if (looking) await restoreFocus(previous, tabId);
    else await returnFromStaging(tabId, originalWindowId);
    await pinQualityForTab(tabId);
    await ensureTabMuted(tabId);
    await scheduleBootWatch(tabId);

    // Only a page that answered and said it was hidden counts as deferred. A
    // page that never answered at all is a broken tab, not an unavailable
    // screen, and it has to keep costing a recovery attempt or a tab whose
    // content script is dead would retry forever without ever escalating.
    return { started, shown: everVisible, deferred: sawPage && !everVisible };
  } finally {
    bootstrappingTabIds.delete(Number(tabId));
  }
}

async function createManagedStream(channel, stream, options = {}) {
  const login = normalizeLogin(channel.login);
  if (!login) throw new Error("That channel is missing a Twitch username.");

  const settings = await getSettings();
  return withBootstrapLock(async () => {
    // This check has to live inside the same queue as creation. When two
    // requests for one login used different/stale user ids, both previously
    // passed the check before either reached this queue, then each made a tab.
    const existingManaged =
      (await getManagedTabForUser(channel.userId)) || (await getManagedTabForLogin(login));
    if (existingManaged) {
      if (options.focus) await focusTab(existingManaged.tabId);
      return existingManaged;
    }

    // Also re-query Chrome here. A staging tab from an interrupted worker, or
    // a tab the user opened while this request waited, must be adopted.
    const existingTab = await findTabForChannel(login);
    if (existingTab) {
      const adopted = await adoptTabNow(existingTab, channel, stream, login);
      if (options.focus) await focusTab(existingTab.id);
      return adopted;
    }

    return bootstrapManagedStream(channel, stream, options, settings, login);
  });
}

// The window the managed tabs already live in. Everything AutoLurk opens ends
// up here so there is one group holding every stream, whichever window the user
// happened to be looking at when a favorite went live.
async function homeWindowId() {
  // The group we already own decides, so a stream that opens while the managed
  // tabs are briefly unreachable still aims at the right window.
  const meta = await getMeta();
  const stored = await groupInfo(meta.groupId ?? null);
  if (stored && !isStagingWindow(stored.windowId)) return stored.windowId;

  const managed = await getManagedTabs();
  for (const entry of Object.values(managed)) {
    try {
      const tab = await chrome.tabs.get(Number(entry.tabId));
      if (tab?.windowId != null && !isStagingWindow(tab.windowId)) return tab.windowId;
    } catch {
      // Tab is gone; another entry may still say where home is.
    }
  }

  // No managed tabs right now, but the group itself may still be sitting open.
  try {
    const groups = await chrome.tabGroups.query({});
    const ours = groups.find(
      (group) => (group.title || "").startsWith(GROUP_NAME) && !isStagingWindow(group.windowId)
    );
    if (ours) return ours.windowId;
  } catch {
    // No group information available.
  }

  return null;
}

async function parkInStaging(tab) {
  try {
    const win = await chrome.windows.create({
      tabId: Number(tab.id),
      focused: false,
      type: "normal",
      ...STAGING_BOUNDS,
    });
    await rememberStaging(win.id);
    return win.id;
  } catch {
    return null;
  }
}

async function returnFromStaging(tabId, originalWindowId) {
  let stagingId = null;
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    if (isStagingWindow(tab.windowId)) stagingId = tab.windowId;
  } catch {
    return;
  }

  if (originalWindowId != null && !isStagingWindow(originalWindowId)) {
    try {
      await chrome.windows.get(originalWindowId);
      await moveIntoWindow([tabId], originalWindowId);
      await forgetStaging(stagingId);
      return;
    } catch {
      // The original window closed when this was its last tab.
    }
  }
  const home = await homeWindowId();
  if (home != null) {
    await moveIntoWindow([tabId], home);
    await forgetStaging(stagingId);
    return;
  }
  try {
    const last = await chrome.windows.getLastFocused();
    if (last?.id != null && !isStagingWindow(last.id)) {
      await moveIntoWindow([tabId], last.id);
      await forgetStaging(stagingId);
    }
  } catch {
    // Nowhere to put it; it stays where it is.
  }
}

async function bootstrapManagedStream(channel, stream, options, settings, login) {
  const home = await homeWindowId();

  let tab;
  bootstrapCreateDepth += 1;
  try {
    if (options.focus) {
      tab = await chrome.tabs.create({
        url: managedChannelUrl(login),
        active: true,
        ...(home != null ? { windowId: home } : {}),
      });
    } else {
      // Start inactive. Forcing a hidden tab to look visible, or clicking Play
      // for it, is what made Twitch unmount the player. No temporary window
      // and no focus change, so this does not cover whatever the user is doing.
      tab = await chrome.tabs.create({
        url: managedChannelUrl(login),
        active: false,
        ...(home != null ? { windowId: home } : {}),
      });
    }
    bootstrappingTabIds.add(Number(tab.id));
  } finally {
    bootstrapCreateDepth -= 1;
  }
  // PLAYER_BOOT and a scheduled poll can both request group consolidation
  // before waitForPlaybackStart finishes. Moving this tab at that point hides
  // the new document before Twitch gives it a media source, so group code
  // skips this id until the release below. The finally is the failure path
  // only: each success path releases the id before it groups the tab.
  try {
    await settleNewTab(tab.id, settings);

    const entry = {
      ...newManagedEntry({
        tabId: tab.id,
        channel,
        login,
        stream,
        muted: Boolean(settings.muteTabs),
        currentUrl: tab.url || twitchChannelUrl(login),
      }),
      // Recovery carries its budget across a reopen so a channel that never
      // plays cannot loop forever on fresh tabs.
      ...(options.carry || {}),
    };

    await mutateManagedTabs((managed) => {
      managed[String(tab.id)] = entry;
      return managed;
    });
    await announceManaged(tab.id);
    await scheduleBootWatch(tab.id);

    await logActivity(`Opened ${channel.displayName || login}`, {
      channel: login,
    });

    if (options.focus) {
      if (tab.windowId != null) {
        try {
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch {
          // Focusing is best effort; the tab is open either way.
        }
      }
      bootstrappingTabIds.delete(Number(tab.id));
      await pinQualityForTab(tab.id);
      if (settings.groupTabs) await addTabToLiveGroup(tab.id, { background: false });
      return { ...entry, bootstrapStarted: null };
    }

    const { started } = await waitForPlaybackStart(tab.id, {
      allowHidden: true,
      timeoutMs: BOOTSTRAP_TIMING.backgroundMs,
    });
    await pinQualityForTab(tab.id);
    bootstrappingTabIds.delete(Number(tab.id));

    // Grouped only now that the tab is in its final window. A group belongs to
    // one window, so grouping any earlier would put it in the wrong one and
    // leave a stray group behind.
    if (settings.groupTabs) await addTabToLiveGroup(tab.id, { background: true });

    const name = channel.displayName || login;
    if (!started) {
      await updateManagedTab(tab.id, {
        health: "failed",
        healthReason: "Twitch did not start in the background; open the tab or press Retry",
        failedAt: Date.now(),
        recoveryStage: "give_up",
        mediaPlaying: false,
      });
      await clearBootWatch(tab.id);
    }
    await logActivity(
      started
        ? `${name} is playing`
        : `${name} needs attention — Twitch refused background startup`,
      { channel: login, level: started ? "info" : "warn" }
    );

    // Transient result metadata, deliberately not persisted. Auto-open reporting
    // must distinguish "a tab was created" from verified moving media.
    return { ...entry, bootstrapStarted: started };
  } finally {
    bootstrappingTabIds.delete(Number(tab.id));
  }
}

// Muting and pinning are one call so a tab that is still being created cannot
// be seen unmuted. Chrome occasionally rejects the combined update on a brand
// new tab, and mute is the half that matters.
async function settleNewTab(tabId, settings) {
  try {
    await chrome.tabs.update(tabId, {
      autoDiscardable: false,
      muted: Boolean(settings.muteTabs),
    });
  } catch {
    if (!settings.muteTabs) return;
    try {
      await chrome.tabs.update(tabId, { muted: true });
    } catch {
      // Mute is best-effort at create time.
    }
  }
}

// One place that defines what AutoLurk tracks per stream, so opening, adopting
// and reloading all start from the same shape.
export function newManagedEntry({ tabId, channel, login, stream, muted, currentUrl, adopted }) {
  const openedAt = Date.now();
  return {
    tabId,
    userId: channel.userId,
    login,
    displayName: channel.displayName || login,
    streamId: stream?.streamId || "",
    expectedChannel: login,
    adopted: Boolean(adopted),
    openedAt,
    muted: Boolean(muted),
    userUnmuted: false,
    currentUrl,
    lastSeenLiveAt: openedAt,

    // Playback evidence. Nothing here claims Twitch credited the view.
    health: "booting",
    healthReason: "",
    mediaPlaying: false,
    playerMuted: null,
    observedChannel: "",
    lastHeartbeatAt: 0,
    lastAdvanceAt: 0,
    lastCurrentTime: null,
    lastVerifiedAt: 0,

    // Separate budgets so a tab switch cannot spend playback recovery tries.
    recoveryAttempts: 0,
    wakeAttempts: 0,
    discardReloads: 0,
    lastRecoveryAt: 0,
    recoveryStage: "",
  };
}

async function adoptTabNow(tab, channel, stream, login) {
  const settings = await getSettings();
  const entry = newManagedEntry({
    tabId: tab.id,
    channel,
    login,
    stream,
    muted: Boolean(tab.mutedInfo?.muted),
    currentUrl: tab.url || twitchChannelUrl(login),
    adopted: true,
  });

  await mutateManagedTabs((managed) => {
    managed[String(tab.id)] = entry;
    return managed;
  });

  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    // Tab may be closing.
  }
  await announceManaged(tab.id);
  await pinQualityForTab(tab.id);
  await scheduleBootWatch(tab.id);
  if (settings.groupTabs) await addTabToLiveGroup(tab.id, { background: !tab.active });

  await logActivity(`Now managing ${channel.displayName || login}`, { channel: login });
  return entry;
}

// Registers a Twitch tab the user already had open, so the UI stops claiming
// control it does not have.
export function adoptExistingTab(channel, stream) {
  return withUserLock(String(channel.userId), () => withBootstrapLock(async () => {
    const login = normalizeLogin(channel.login);
    if (!login) throw new Error("That channel is missing a Twitch username.");

    const existing =
      (await getManagedTabForUser(channel.userId)) || (await getManagedTabForLogin(login));
    if (existing) return existing;

    const tab = await findTabForChannel(login);
    if (!tab) throw new Error("No open tab found for that channel.");

    return adoptTabNow(tab, channel, stream, login);
  }));
}

// Stops managing a tab without closing it.
export async function releaseManagedTab(userId) {
  const entry = await getManagedTabForUser(userId);
  if (!entry) return false;
  try {
    await chrome.tabs.sendMessage(Number(entry.tabId), { type: MESSAGE.UNMANAGED_NOW });
  } catch {
    // The page may be navigating; removing ownership still takes precedence.
  }
  await removeManagedTab(entry.tabId);
  await logActivity(`Stopped managing ${entry.displayName || entry.login}`, {
    channel: entry.login,
  });
  return true;
}

async function restoreActiveTab(previous, openedTabId) {
  if (!previous?.id || previous.id === openedTabId) return;
  try {
    const [current] = await chrome.tabs.query({ active: true, windowId: previous.windowId });
    if (current?.id !== openedTabId) return;
    await chrome.tabs.update(previous.id, { active: true });
  } catch {
    // Previous tab may have closed.
  }
}

export async function focusOrOpen(channel, stream) {
  const managed = await getManagedTabForUser(channel.userId);
  if (managed) {
    await focusTab(managed.tabId);
    return managed;
  }

  // A tab the user already opened is adopted rather than duplicated, so the
  // dashboard's "Focus" really does hand the stream to AutoLurk.
  const existing = await findTabForChannel(channel.login);
  if (existing) {
    const entry = await adoptExistingTab(channel, stream);
    await focusTab(existing.id);
    return entry;
  }

  if (!streamIsOpenable(stream)) {
    throw new Error(`${channel.displayName || channel.login} is not live right now.`);
  }
  return openManagedStream(channel, stream, { focus: true });
}

// "AutoLurk closed this" has to outlive a service worker restart, otherwise a
// scheduled close is later mistaken for the user closing the tab and the
// channel gets marked dismissed for the rest of the broadcast.
export function markProgrammaticClose(tabId) {
  return mutateSessionValue(SESSION_KEYS.PROGRAMMATIC_CLOSES, {}, (map) => ({
    ...map,
    [String(tabId)]: Date.now(),
  }));
}

export async function consumeProgrammaticClose(tabId) {
  let wasProgrammatic = false;
  await mutateSessionValue(SESSION_KEYS.PROGRAMMATIC_CLOSES, {}, (map) => {
    const key = String(tabId);
    wasProgrammatic = Boolean(map[key]);
    if (!wasProgrammatic) return undefined;
    const next = { ...map };
    delete next[key];
    return next;
  });
  return wasProgrammatic;
}

async function clearProgrammaticClose(tabId) {
  await mutateSessionValue(SESSION_KEYS.PROGRAMMATIC_CLOSES, {}, (map) => {
    const key = String(tabId);
    if (!map[key]) return undefined;
    const next = { ...map };
    delete next[key];
    return next;
  });
}

export async function closeManagedTab(tabId) {
  await markProgrammaticClose(tabId);
  try {
    await chrome.tabs.remove(Number(tabId));
  } catch {
    await clearProgrammaticClose(tabId);
    return false;
  }
  // tabs.onRemoved may run before or after tabs.remove resolves. Clearing here
  // makes both orders safe and prevents a reused Chrome tab id from inheriting
  // stale programmatic-close intent.
  await clearProgrammaticClose(tabId);
  await removeManagedTab(tabId);
  return true;
}

export async function closeManagedForUser(userId) {
  const entry = await getManagedTabForUser(userId);
  if (!entry) return false;
  await closeManagedTab(entry.tabId);
  return true;
}

export async function removeManagedTab(tabId) {
  await clearBootWatch(tabId);
  try {
    await chrome.tabs.update(Number(tabId), { autoDiscardable: true });
  } catch {
    // Tab may already be gone.
  }
  const managed = await mutateManagedTabs((current) => {
    if (!current[String(tabId)]) return undefined;
    delete current[String(tabId)];
    return current;
  });
  await updateLiveGroup(managed);
  return managed;
}

export async function focusTab(tabId) {
  let tab;
  try {
    await wakeManagedTab(tabId, { force: true });
    tab = await chrome.tabs.get(Number(tabId));
  } catch {
    // Only stop tracking when the tab itself is gone.
    await removeManagedTab(tabId);
    return;
  }

  try {
    await chrome.tabs.update(tab.id, { active: true, autoDiscardable: false });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Focusing is best effort; the tab is still managed.
  }
}

function tabLooksStuck(tab, entry) {
  if (!tab) return true;
  if (tab.discarded || tab.status === "unloaded") return true;
  if (!tab.url || tab.url === "about:blank" || tab.url.startsWith("chrome://")) return true;
  const channel = extractChannelFromUrl(tab.url);
  if (channel && channel !== normalizeLogin(entry.expectedChannel)) return false;
  if (!channel && Date.now() - entry.openedAt > 4000) return true;
  return false;
}

const MAX_WAKE_ATTEMPTS = 3;

export async function wakeManagedTab(tabId, options = {}) {
  const managed = await getManagedTabs();
  const entry = managed[String(tabId)];
  if (!entry) return false;

  let tab;
  try {
    tab = await chrome.tabs.get(Number(tabId));
  } catch {
    await removeManagedTab(tabId);
    return false;
  }

  const stuck = tabLooksStuck(tab, entry);
  if (!stuck && !options.force) return false;
  if (!stuck) return true;
  // Waking has its own budget; it must not consume playback recovery attempts.
  if ((entry.wakeAttempts || 0) >= MAX_WAKE_ATTEMPTS) return false;

  await updateManagedTab(tabId, (current) => ({
    ...current,
    wakeAttempts: (current.wakeAttempts || 0) + 1,
    mediaPlaying: false,
    health: "booting",
    healthReason: "tab reloaded after being unloaded",
    openedAt: Date.now(),
    lastHeartbeatAt: 0,
    lastAdvanceAt: 0,
    lastCurrentTime: null,
  }));
  await scheduleBootWatch(tabId);

  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    await chrome.tabs.update(tab.id, { url: managedChannelUrl(entry.expectedChannel) });
  } catch {
    try {
      await chrome.tabs.reload(tab.id);
    } catch {
      return false;
    }
  }
  return true;
}

// Chrome rejects anything outside this set, and rejects the entire update call
// with it.
const GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

// There is one AutoLurk group, ever. A tab group belongs to exactly one window,
// so that promise is really a promise about tabs: every managed tab has to live
// in the same window. Tracking a group per window, as this used to, quietly
// accepts a split and nothing ever heals it, which is how a long session ends
// up with five AutoLurk groups. Consolidating costs a tab move, and moving a
// tab between windows does not interrupt playback (verified against a live
// stream, where currentTime advanced straight through the move).

// Managed entries paired with where Chrome says their tabs are right now.
async function locateManagedTabs(managedTabs) {
  const found = [];
  for (const entry of Object.values(managedTabs || {})) {
    try {
      found.push(await chrome.tabs.get(Number(entry.tabId)));
    } catch {
      // Tab closed between the read and now.
    }
  }
  return found;
}

// The managed tabs consolidation is allowed to touch. A stream the user has
// filed into a group they named themselves is deliberate, so it is left where
// it is - not moved, not regrouped. That is the escape hatch for watching one
// stream apart from the rest, and it is the only way a managed tab is ever
// outside the AutoLurk group.
async function ourManagedTabs(managedTabs) {
  const ours = [];
  for (const tab of await locateManagedTabs(managedTabs)) {
    if (bootstrappingTabIds.has(Number(tab.id))) continue;
    const group = await groupInfo(tab.groupId);
    if (group && !looksLikeOurs(group)) continue;
    ours.push(tab);
  }
  return ours;
}

async function groupInfo(groupId) {
  if (groupId == null || groupId === -1) return null;
  try {
    return await chrome.tabGroups.get(groupId);
  } catch {
    return null;
  }
}

// A group is ours if we named it, or if it has no name at all while holding a
// managed tab: Chrome creates a group untitled and we rename it a moment later,
// so a failed rename must not make the group invisible to us forever. A group
// the user named themselves is theirs, and is left alone.
function looksLikeOurs(group) {
  return !group?.title || String(group.title).startsWith(GROUP_NAME);
}

// Where the one group should live. Staying put matters more than being optimal,
// so an existing group wins; otherwise the window already holding the most
// managed tabs wins, which moves the fewest tabs to consolidate.
async function chooseHomeWindow(tabs, storedGroupId) {
  const stored = await groupInfo(storedGroupId);
  if (stored && tabs.some((tab) => tab.windowId === stored.windowId)) return stored.windowId;

  const counts = new Map();
  for (const tab of tabs) counts.set(tab.windowId, (counts.get(tab.windowId) || 0) + 1);

  let best = null;
  let bestCount = -1;
  // Lowest window id breaks ties so two machines-worth of polls agree instead of
  // trading the group back and forth between equally populated windows.
  for (const windowId of [...counts.keys()].sort((a, b) => a - b)) {
    if (counts.get(windowId) > bestCount) {
      bestCount = counts.get(windowId);
      best = windowId;
    }
  }
  return best;
}

// Chrome can sync tab groups created independently on two computers. Their
// numeric group ids are local to each browser, so storage cannot identify the
// shared logical group. Discover every locally-visible AutoLurk group by title
// before selecting a window or considering creation.
async function discoverAutoLurkGroups(tabs, storedGroupId) {
  const groups = new Map();
  let enumerationSucceeded = false;

  try {
    for (const group of await chrome.tabGroups.query({})) {
      if (String(group.title || "").startsWith(GROUP_NAME)) groups.set(group.id, group);
    }
    enumerationSucceeded = true;
  } catch {
    // Fail closed below: an unavailable global query is never evidence that
    // no AutoLurk group exists.
  }

  for (const tab of tabs) {
    if (tab.groupId == null || tab.groupId === -1 || groups.has(tab.groupId)) continue;
    const group = await groupInfo(tab.groupId);
    if (group && looksLikeOurs(group)) groups.set(group.id, group);
  }

  const stored = await groupInfo(storedGroupId);
  if (
    stored &&
    (String(stored.title || "").startsWith(GROUP_NAME) ||
      tabs.some((tab) => tab.groupId === stored.id))
  ) {
    groups.set(stored.id, stored);
  }

  const candidates = [...groups.values()];
  let canonical = null;
  if (candidates.length) {
    const ranked = await Promise.all(
      candidates.map(async (group) => {
        try {
          return { group, count: (await chrome.tabs.query({ groupId: group.id })).length };
        } catch {
          return { group, count: 0 };
        }
      })
    );
    ranked.sort(
      (a, b) =>
        b.count - a.count ||
        Number(b.group.id === storedGroupId) - Number(a.group.id === storedGroupId) ||
        Number(a.group.id) - Number(b.group.id)
    );
    canonical = ranked[0].group;
  }

  return { canonical, groups: candidates, enumerationSucceeded };
}

// The single group in the home window, adopted if one is already there.
async function resolveHomeGroup(home, tabs, storedGroupId) {
  const stored = await groupInfo(storedGroupId);
  if (stored && stored.windowId === home) return stored.id;

  for (const tab of tabs) {
    if (tab.windowId !== home || tab.groupId == null || tab.groupId === -1) continue;
    const group = await groupInfo(tab.groupId);
    if (group && looksLikeOurs(group)) return group.id;
  }

  try {
    const groups = await chrome.tabGroups.query({ windowId: home });
    const ours = groups.find((group) => String(group.title || "").startsWith(GROUP_NAME));
    if (ours) return ours.id;
  } catch {
    // Fall through and make one.
  }
  return null;
}

// Every other group that belongs to us, anywhere. These are the leftovers from
// before consolidation existed, plus any group Chrome spawned when a tab was
// dragged out. Their tabs get pulled back in rather than the group being
// abandoned, so the count in the title stays honest.
async function ourOtherGroupIds(keepGroupId, tabs) {
  const strays = new Set();

  try {
    for (const group of await chrome.tabGroups.query({})) {
      if (group.id === keepGroupId) continue;
      if (String(group.title || "").startsWith(GROUP_NAME)) strays.add(group.id);
    }
  } catch {
    // Group enumeration is unavailable; fall back to what the tabs tell us.
  }

  for (const tab of tabs) {
    if (tab.groupId == null || tab.groupId === -1 || tab.groupId === keepGroupId) continue;
    if (strays.has(tab.groupId)) continue;
    const group = await groupInfo(tab.groupId);
    if (group && looksLikeOurs(group)) strays.add(group.id);
  }

  return strays;
}

async function tabsInGroups(groupIds) {
  const ids = [];
  for (const groupId of groupIds) {
    try {
      for (const tab of await chrome.tabs.query({ groupId })) ids.push(tab.id);
    } catch {
      // Group vanished; nothing to reclaim.
    }
  }
  return ids;
}

// Moving a tab between windows does not reload it: verified against a live
// stream in a real browser, where currentTime kept advancing straight through
// the move and the tab was not discarded. That is what makes it safe both to
// start a stream in whichever window the user is looking at and rehome it
// afterwards, and to gather scattered streams back together at any time.
async function moveIntoWindow(tabIds, windowId) {
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      if (tab.windowId === windowId) continue;
      await chrome.tabs.move(Number(tabId), { windowId, index: -1 });
    } catch {
      // Tab or window went away mid-move.
    }
  }
}

export async function addTabToLiveGroup(tabId, options = {}) {
  // Nothing tab-specific left to do: the tab is already recorded as managed by
  // every caller, and consolidation puts all of them in the one group.
  await updateLiveGroup(await getManagedTabs(), { collapseNow: options.background });
}

// Tab opens, playback reports, closes, startup reconciliation and the health
// alarm can all request consolidation at the same time. Chrome's group API is
// not transactional: two callers can both observe "no group" and each create
// one. Keep the whole read/move/group/remember sequence in one queue.
let groupUpdateChain = Promise.resolve();

export function updateLiveGroup(managedTabs, options = {}) {
  const result = groupUpdateChain.then(
    () => updateLiveGroupNow(managedTabs, options),
    () => updateLiveGroupNow(managedTabs, options)
  );
  groupUpdateChain = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function updateLiveGroupNow(managedTabs, options = {}) {
  const settings = await getSettings();
  const startingMeta = await getMeta();
  const stored = startingMeta.groupId ?? null;

  // groupIds is the old per-window map. Dropping the key on the next write
  // retires the split-group model for anyone upgrading, rather than leaving
  // stale ids behind to be adopted later.
  const legacy = Object.hasOwn(startingMeta, "groupIds");
  const remember = async (groupId) => {
    if (groupId === stored && !legacy) return;
    await mutateMeta((meta) => {
      const next = { ...meta, groupId };
      delete next.groupIds;
      return next;
    });
  };

  let tabs = await ourManagedTabs(managedTabs);
  const discovered = await discoverAutoLurkGroups(tabs, stored);
  if (!tabs.length && discovered.groups.length === 0) {
    await remember(null);
    return;
  }
  if (!settings.groupTabs) return;

  // An existing AutoLurk group wins globally, even if this invocation carries
  // a stale managed-tab snapshot that has no entries in that group's window.
  // This is the cross-machine case: Chrome restored the other computer's
  // group locally before this computer opened its next stream.
  const home =
    discovered.canonical?.windowId ?? (await chooseHomeWindow(tabs, stored));
  if (home == null) return;

  // One window first, then one group. Grouping before the moves would only
  // create a group in a window the tabs are about to leave.
  await moveIntoWindow(
    tabs.filter((tab) => tab.windowId !== home).map((tab) => tab.id),
    home
  );
  tabs = await ourManagedTabs(managedTabs);
  if (!tabs.length && discovered.groups.length === 0) {
    await remember(null);
    return;
  }

  let groupId =
    discovered.canonical?.id ?? (await resolveHomeGroup(home, tabs, stored));

  // Reclaim the tabs of every other group of ours before folding them in, so
  // an existing split collapses instead of persisting.
  const strays = await ourOtherGroupIds(groupId, tabs);
  for (const group of discovered.groups) {
    if (group.id !== groupId) strays.add(group.id);
  }
  const reclaimed = await tabsInGroups(strays);
  await moveIntoWindow(reclaimed, home);

  const wanted = [...new Set([...tabs.map((tab) => tab.id), ...reclaimed])];
  if (!wanted.length && groupId != null) {
    await remember(groupId);
    return;
  }

  if (groupId != null) {
    try {
      await chrome.tabs.group({ groupId, tabIds: wanted });
    } catch {
      // Chrome refused to add the tabs to the group we already own, which one
      // being dragged or closed mid-call is enough to cause. Making a second
      // group here is precisely how a profile ends up with several AutoLurk
      // groups, so only start one once the old group is genuinely gone.
      if (await groupInfo(groupId)) {
        await remember(groupId);
        return;
      }
      groupId = null;
    }
  }
  if (groupId == null) {
    // Never interpret an API failure as "there are no groups." That fail-open
    // behavior was able to create one AutoLurk group per computer.
    if (!discovered.enumerationSucceeded) return;
    try {
      groupId = await chrome.tabs.group({ tabIds: wanted, createProperties: { windowId: home } });
    } catch {
      return;
    }
  }

  let count = wanted.length;
  try {
    count = (await chrome.tabs.query({ groupId })).length;
  } catch {
    // Fall back to what we asked for.
  }

  try {
    await chrome.tabGroups.update(groupId, {
      title: `${GROUP_NAME} · ${count}`,
      // An unrecognised colour makes Chrome reject the whole call, taking the
      // title with it and leaving the group anonymous.
      color: GROUP_COLORS.has(settings.groupColor) ? settings.groupColor : "purple",
    });
    // Only collapse when a tab was just added in the background, otherwise the
    // periodic refresh keeps folding a group the user expanded.
    if (settings.collapseGroup && options.collapseNow === true) {
      const active = await chrome.tabs.query({ groupId, active: true });
      if (active.length === 0) await chrome.tabGroups.update(groupId, { collapsed: true });
    }
  } catch {
    // Renaming and recolouring are cosmetic. Forgetting a group that is still
    // there is not: the next stream then fails to find it and starts another,
    // which is how a session ends up with several AutoLurk groups.
    if (!(await groupInfo(groupId))) {
      await remember(null);
      return;
    }
  }

  // Worth saying out loud. Extra groups keep turning up from places the
  // extension never sees - a window restored with last session's group in it, a
  // tab dragged out, Chrome syncing a group across from another machine - and
  // silently absorbing them leaves no way to tell a cause that has been fixed
  // from one that is still happening.
  if (strays.size) {
    await logActivity(
      `Merged ${strays.size} stray ${GROUP_NAME} group${strays.size === 1 ? "" : "s"} back into one`
    );
  }

  await remember(groupId);
}

// Consolidation used to run only when a stream opened, closed or reached
// playback. Anything that produced a second group between those moments simply
// stayed, sometimes for hours, which is what "it keeps making extra groups"
// actually looked like. The health alarm now checks every minute, and the check
// is deliberately cheap so the common case - one group, everything in it - costs
// two queries and changes nothing.
export async function consolidateIfSplit() {
  const settings = await getSettings();
  if (!settings.groupTabs) return false;

  const managed = await getManagedTabs();
  if (!Object.keys(managed).length) return false;

  let ours = [];
  try {
    ours = (await chrome.tabGroups.query({})).filter((group) =>
      String(group.title || "").startsWith(GROUP_NAME)
    );
  } catch {
    return false;
  }

  // ourManagedTabs already drops tabs the user filed into a group of their own,
  // so a tab counts as loose only if it is in no group or in one of ours that
  // the rest are not in.
  const ourGroupIds = new Set(ours.map((group) => group.id));
  const tabs = await ourManagedTabs(managed);
  if (!tabs.length) return false;
  const loose = tabs.some((tab) => tab.groupId === -1 || !ourGroupIds.has(tab.groupId));

  if (ours.length <= 1 && !loose) return false;

  await updateLiveGroup(managed);
  return true;
}

export function isManagedTab(managedTabs, tabId) {
  return Boolean(managedTabs?.[String(tabId)]);
}

export function urlLeftExpectedChannel(entry, url) {
  const current = extractChannelFromUrl(url);
  if (!current) return false;
  return current !== normalizeLogin(entry.expectedChannel);
}
