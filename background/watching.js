// Which streams a person is looking at, here and on the other computers.
//
// Brave mirrors the AutoLurk group, so a tab that another computer closes in
// that group closes here too. Every automatic close and reopen checks this
// first, and each computer publishes what it is showing in sync storage so the
// others can check it as well.

import { getSettings } from "../shared/storage.js";
import { extractChannelFromUrl } from "../shared/utilities.js";
import { machineId } from "./group-claim.js";

export const WATCHING_PREFIX = "watching:";
export const WATCHING_TIMING = {
  freshMs: 5 * 60_000,
  refreshMs: 2 * 60_000,
};

let lastPublished = { key: "", at: 0 };

function syncArea() {
  return chrome.storage?.sync || null;
}

// Tabs in front of their window on this computer. A server's front tab is
// chosen by rotation, so there only a stream the user unmuted counts.
export async function watchedHere(managed = {}) {
  const tabIds = new Set();
  const logins = new Set();
  const settings = await getSettings();
  for (const entry of Object.values(managed)) {
    if (!entry?.userUnmuted) continue;
    tabIds.add(Number(entry.tabId));
    if (entry.login) logins.add(String(entry.login).toLowerCase());
  }
  if (settings.serverRotation === true) return { tabIds, logins };

  let windows = [];
  try {
    windows = await chrome.windows.getAll();
  } catch {
    return { tabIds, logins };
  }
  const shown = new Set(
    windows.filter((window) => window.type === "normal" && window.state !== "minimized").map((window) => window.id)
  );
  let active = [];
  try {
    active = await chrome.tabs.query({ active: true });
  } catch {
    return { tabIds, logins };
  }
  for (const tab of active) {
    if (!shown.has(tab.windowId)) continue;
    const login = extractChannelFromUrl(tab.url);
    if (!login) continue;
    tabIds.add(Number(tab.id));
    logins.add(login);
  }
  return { tabIds, logins };
}

export async function publishWatching(managed, now = Date.now()) {
  const area = syncArea();
  if (!area || (await getSettings()).syncEnabled === false) return;
  const { logins } = await watchedHere(managed);
  const list = [...logins].sort();
  const key = list.join(",");
  if (key === lastPublished.key && now - lastPublished.at < WATCHING_TIMING.refreshMs) return;
  const storageKey = `${WATCHING_PREFIX}${await machineId()}`;
  try {
    if (list.length) await area.set({ [storageKey]: { logins: list, at: now } });
    else if (lastPublished.key || !lastPublished.at) await area.remove(storageKey);
    lastPublished = { key, at: now };
  } catch {
    // Quota or offline. The next pass tries again.
  }
}

export async function watchedElsewhere(now = Date.now()) {
  const logins = new Set();
  const area = syncArea();
  if (!area || (await getSettings()).syncEnabled === false) return logins;
  let all = {};
  try {
    all = (await area.get(null)) || {};
  } catch {
    return logins;
  }
  const mine = `${WATCHING_PREFIX}${await machineId()}`;
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(WATCHING_PREFIX) || key === mine) continue;
    if (now - Number(value?.at || 0) >= WATCHING_TIMING.freshMs) continue;
    for (const login of value?.logins || []) logins.add(String(login).toLowerCase());
  }
  return logins;
}

// Everything a close has to respect: tabs in front here, and channels being
// watched on another computer.
export async function watchedStreams(managed = {}) {
  const [here, elsewhere] = await Promise.all([watchedHere(managed), watchedElsewhere()]);
  return {
    tabIds: here.tabIds,
    logins: new Set([...here.logins, ...elsewhere]),
    elsewhere,
  };
}

export function isWatched(watched, tabId, login) {
  if (watched.tabIds.has(Number(tabId))) return true;
  return Boolean(login) && watched.logins.has(String(login).toLowerCase());
}

export function resetWatchingForTests() {
  lastPublished = { key: "", at: 0 };
}
