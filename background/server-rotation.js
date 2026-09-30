// A machine left on as a server. Every two minutes the next managed stream is
// brought to the front and asked if it is playing. A hidden reload never gets
// a media source, so a stream that is not playing is reloaded while it is
// open, then checked again before the rotation moves on.

import { MESSAGE, SESSION_KEYS } from "../shared/constants.js";
import { nextServerTarget, serverReportWorking } from "../shared/server-logic.js";
import { getManagedTabs, getSessionValue, getSettings, mutateSessionValue } from "../shared/storage.js";
import { managedChannelUrl } from "../shared/utilities.js";
import { logActivity } from "./activity.js";
import { ensureTabMuted, handlePlayerHealth } from "./stream-boot.js";
import { focusTab, pinQualityForTab } from "./tab-manager.js";

const CONFIRM_MS = 8000;
const RELOAD_CONFIRM_MS = 30_000;
const PROBE_TIMEOUT_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(tabId) {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(Number(tabId), { type: MESSAGE.PROBE_PLAYER }),
      sleep(PROBE_TIMEOUT_MS).then(() => null),
    ]);
    return response && typeof response === "object" ? response : null;
  } catch {
    return null;
  }
}

async function confirmPlaying(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await probe(tabId);
    if (last) await handlePlayerHealth(tabId, last);
    if (serverReportWorking(last)) return last;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return last;
}

// A collapsed AutoLurk group keeps the selected tab hidden. Focusing it does
// not open the stream, the probe stays hidden, and the rotation gives up.
async function expandGroup(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(Number(tabId));
  } catch {
    return;
  }
  const none = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
  if (tab.groupId == null || tab.groupId === none) return;
  try {
    await chrome.tabGroups.update(tab.groupId, { collapsed: false });
  } catch {
    // The tab is still activated below. A group that will not expand is logged
    // as "could not be shown" if the page stays hidden.
  }
}

async function reloadInFront(entry) {
  const tabId = Number(entry.tabId);
  const settings = await getSettings();
  const url = managedChannelUrl(entry.expectedChannel || entry.login, settings);
  await chrome.tabs.update(tabId, { active: true, url });
  await chrome.tabs.reload(tabId);
  await pinQualityForTab(tabId);
  await ensureTabMuted(tabId);
}

const ROTATE_GAP_MS = 100_000;

// The two-minute alarm and the one-minute health check both call this. The
// session stamp keeps them from opening two streams at once.
export async function rotateServerStreamsIfDue() {
  const settings = await getSettings();
  if (!settings.serverRotation || settings.automationEnabled === false) return null;
  const now = Date.now();
  let due = false;
  await mutateSessionValue(SESSION_KEYS.SERVER, {}, (current) => {
    if (Number(current.lastRotatedAt) && now - Number(current.lastRotatedAt) < ROTATE_GAP_MS) {
      return undefined;
    }
    due = true;
    return { ...current, lastRotatedAt: now };
  });
  if (!due) return null;
  return rotateServerStreams();
}

export async function rotateServerStreams(options = {}) {
  const settings = await getSettings();
  if (!settings.serverRotation || settings.automationEnabled === false) return null;

  const managed = await getManagedTabs();
  const entries = Object.values(managed);
  const session = await getSessionValue(SESSION_KEYS.SERVER, {});
  const target = nextServerTarget(entries, session.lastTabId);
  if (!target) return null;

  await mutateSessionValue(SESSION_KEYS.SERVER, {}, (current) => ({
    ...current,
    lastTabId: Number(target.tabId),
    lastRotatedAt: Date.now(),
  }));

  const name = target.displayName || target.expectedChannel || target.login;
  await expandGroup(target.tabId);
  await focusTab(target.tabId);
  let report = await confirmPlaying(target.tabId, options.confirmMs ?? CONFIRM_MS);
  // The group expand and the window restore can land after the first probe.
  if (report?.hidden === true) {
    await expandGroup(target.tabId);
    await focusTab(target.tabId);
    report = await confirmPlaying(target.tabId, options.confirmMs ?? CONFIRM_MS);
  }
  if (serverReportWorking(report)) {
    await logActivity(`Server check: ${name} is playing`, { channel: target.login });
    return { tabId: target.tabId, reloaded: false, playing: true };
  }
  if (report?.hidden === true) {
    await logActivity(`Server check: ${name} could not be shown`, {
      channel: target.login,
      level: "warn",
    });
    return { tabId: target.tabId, reloaded: false, playing: false };
  }

  await logActivity(`Server check: ${name} is not playing, reloading`, {
    channel: target.login,
    level: "warn",
  });
  try {
    await reloadInFront(target);
  } catch {
    await logActivity(`Server check: ${name} could not be reloaded`, {
      channel: target.login,
      level: "warn",
    });
    return { tabId: target.tabId, reloaded: false, playing: false };
  }

  report = await confirmPlaying(target.tabId, options.reloadConfirmMs ?? RELOAD_CONFIRM_MS);
  const playing = serverReportWorking(report);
  await logActivity(
    playing
      ? `Server check: ${name} is playing after reload`
      : `Server check: ${name} is still not playing`,
    { channel: target.login, level: playing ? "info" : "warn" }
  );
  return { tabId: target.tabId, reloaded: true, playing };
}
