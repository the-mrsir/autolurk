// Which streams a person is looking at on this computer. Duplicate and
// lower-priority closes leave these alone; raids and ended streams only spare
// the one the person is looking at right now.

import { getSettings } from "../shared/storage.js";
import { extractChannelFromUrl } from "../shared/utilities.js";
import { machineId } from "./group-claim.js";

export const WATCHING_PREFIX = "watching:";

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

// Older versions shared what each computer was showing. Only one computer
// runs AutoLurk now, so this just clears this computer's old note once.
export async function publishWatching(_managed, now = Date.now()) {
  const area = syncArea();
  if (!area || lastPublished.at) return;
  lastPublished = { key: "", at: now };
  await area.remove(`${WATCHING_PREFIX}${await machineId()}`).catch(() => {});
}

// What a duplicate or lower-priority close has to respect on this computer.
export async function watchedStreams(managed = {}) {
  const here = await watchedHere(managed);
  return { tabIds: here.tabIds, logins: here.logins, elsewhere: new Set() };
}

// The stream the person is looking at right now: the tab in front of the
// focused window. A server's front tab is picked by rotation, so it has none.
// Raids and ended streams close everything else.
export async function lookingAt() {
  const tabIds = new Set();
  if ((await getSettings()).serverRotation === true) return tabIds;
  try {
    const window = await chrome.windows.getLastFocused();
    if (!window?.focused || window.state === "minimized" || window.type !== "normal") return tabIds;
    const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
    if (tab?.id != null && extractChannelFromUrl(tab.url)) tabIds.add(Number(tab.id));
  } catch {
    // No window to look at.
  }
  return tabIds;
}

export function isWatched(watched, tabId, login) {
  if (watched.tabIds.has(Number(tabId))) return true;
  return Boolean(login) && watched.logins.has(String(login).toLowerCase());
}

export function resetWatchingForTests() {
  lastPublished = { key: "", at: 0 };
}
