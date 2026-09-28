// A machine left on as a server. Every two minutes the next managed stream is
// brought to the front and asked if it is playing. A hidden reload never gets
// a media source, so a stream that is not playing is reloaded while it is
// open, then checked again before the rotation moves on.

import { MESSAGE, SESSION_KEYS } from "../shared/constants.js";
import { nextServerTarget, serverReportWorking } from "../shared/server-logic.js";
import { getManagedTabs, getMeta, getSessionValue, getSettings, mutateSessionValue } from "../shared/storage.js";
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
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last = null;
  do {
    last = await probe(tabId);
    if (last) await handlePlayerHealth(tabId, last);
    if (serverReportWorking(last)) return last;
    if (last?.hidden === true && Date.now() - started > 3000) return last;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return last;
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

export async function rotateServerStreams(options = {}) {
  const settings = await getSettings();
  if (!settings.serverRotation || settings.automationEnabled === false) return null;

  const meta = await getMeta();
  if (meta.wakeRecheckPending) return null;

  const managed = await getManagedTabs();
  const entries = Object.values(managed);
  const session = await getSessionValue(SESSION_KEYS.SERVER, {});
  const target = nextServerTarget(entries, session.lastTabId);
  if (!target) return null;

  await mutateSessionValue(SESSION_KEYS.SERVER, {}, () => ({ lastTabId: Number(target.tabId) }));

  const name = target.displayName || target.expectedChannel || target.login;
  await focusTab(target.tabId);
  let report = await confirmPlaying(target.tabId, options.confirmMs ?? CONFIRM_MS);
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
