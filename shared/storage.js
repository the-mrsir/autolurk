import {
  DEFAULT_AUTH,
  DEFAULT_FAVORITE,
  DEFAULT_META,
  DEFAULT_SETTINGS,
  PUBLISHED_CLIENT_ID,
  STORAGE_KEYS,
} from "./constants.js";
import { normalizeWatchdog } from "./watchdog-logic.js";

export function isPublishedApp() {
  return Boolean(PUBLISHED_CLIENT_ID);
}

export function resolveClientId(settings = {}) {
  return PUBLISHED_CLIENT_ID || settings.clientId || "";
}

export function createFavorite(userId, overrides = {}) {
  return {
    userId,
    ...DEFAULT_FAVORITE,
    ...overrides,
  };
}

// Every stored object is written from several independent event sources: tab
// events, alarms, content-script messages and the UI. A read-modify-write cycle
// that spans an await will silently drop whatever another writer committed in
// between, so all mutations for a key run one at a time.
const writeChains = new Map();

function queueWrite(key, run) {
  const previous = writeChains.get(key) || Promise.resolve();
  const result = previous.then(run, run);
  writeChains.set(
    key,
    result.then(
      () => {},
      () => {}
    )
  );
  return result;
}

// Reads the current value, hands it to the mutator, and writes the result.
// Returning undefined from the mutator commits nothing.
function mutateStored(key, read, mutator) {
  return queueWrite(key, async () => {
    const current = await read();
    const next = await mutator(current);
    if (next === undefined) return current;
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
}

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
  if (!String(settings.updateManifestUrl || "").trim()) {
    settings.updateManifestUrl = DEFAULT_SETTINGS.updateManifestUrl;
  }
  if (PUBLISHED_CLIENT_ID) {
    settings.clientId = PUBLISHED_CLIENT_ID;
    settings.publishedApp = true;
  } else {
    settings.publishedApp = false;
  }
  return settings;
}

export function saveSettings(patch) {
  return mutateStored(STORAGE_KEYS.SETTINGS, getSettings, (current) => {
    // publishedApp is derived on read, never persisted.
    const { publishedApp, ...rest } = { ...current, ...patch };
    return rest;
  });
}

export async function getAuth() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.AUTH);
  return { ...DEFAULT_AUTH, ...(result[STORAGE_KEYS.AUTH] || {}) };
}

// Queued like every other key. A token refresh, the profile lookup that
// follows it, and a disconnect can all be in flight at once, and a bare set
// lets whichever finishes last win regardless of the order they were asked in.
export function saveAuth(auth) {
  return mutateStored(STORAGE_KEYS.AUTH, getAuth, () => ({ ...DEFAULT_AUTH, ...auth }));
}

export async function clearAuth() {
  return saveAuth(DEFAULT_AUTH);
}

export async function getFollows() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.FOLLOWS);
  return result[STORAGE_KEYS.FOLLOWS] || {};
}

export function mutateFollows(mutator) {
  return mutateStored(STORAGE_KEYS.FOLLOWS, getFollows, (current) => mutator({ ...current }));
}

export async function getFavorites() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.FAVORITES);
  return result[STORAGE_KEYS.FAVORITES] || {};
}

export function mutateFavorites(mutator) {
  return mutateStored(STORAGE_KEYS.FAVORITES, getFavorites, (current) => mutator({ ...current }));
}

export async function getLiveState() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LIVE_STATE);
  return result[STORAGE_KEYS.LIVE_STATE] || {};
}

export function mutateLiveState(mutator) {
  return mutateStored(STORAGE_KEYS.LIVE_STATE, getLiveState, (current) => mutator({ ...current }));
}

export async function getManagedTabs() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.MANAGED_TABS);
  return result[STORAGE_KEYS.MANAGED_TABS] || {};
}

export function mutateManagedTabs(mutator) {
  return mutateStored(STORAGE_KEYS.MANAGED_TABS, getManagedTabs, (current) =>
    mutator({ ...current })
  );
}

export function updateManagedTab(tabId, patch) {
  return mutateManagedTabs((managed) => {
    const key = String(tabId);
    const entry = managed[key];
    if (!entry) return undefined;
    managed[key] = typeof patch === "function" ? patch(entry) : { ...entry, ...patch };
    return managed;
  });
}

export async function getPendingCloses() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PENDING_CLOSES);
  return result[STORAGE_KEYS.PENDING_CLOSES] || {};
}

export function savePendingCloses(pendingCloses) {
  return mutateStored(STORAGE_KEYS.PENDING_CLOSES, getPendingCloses, () => pendingCloses);
}

export function mutatePendingCloses(mutator) {
  return mutateStored(STORAGE_KEYS.PENDING_CLOSES, getPendingCloses, (current) =>
    mutator({ ...current })
  );
}

export async function getDismissed() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.DISMISSED);
  return result[STORAGE_KEYS.DISMISSED] || {};
}

export async function saveDismissed(dismissed) {
  await chrome.storage.local.set({ [STORAGE_KEYS.DISMISSED]: dismissed });
  return dismissed;
}

export function mutateDismissed(mutator) {
  return mutateStored(STORAGE_KEYS.DISMISSED, getDismissed, (current) => mutator({ ...current }));
}

export async function getMeta() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.META);
  return { ...DEFAULT_META, ...(result[STORAGE_KEYS.META] || {}) };
}

// The patch is merged against a value read inside the write queue, so two
// concurrent callers patching different fields no longer clobber each other.
export function saveMeta(patch) {
  return mutateStored(STORAGE_KEYS.META, getMeta, (current) => ({ ...current, ...patch }));
}

// Use when the new value depends on the current one, such as the per-window
// group map or the per-channel notification log.
export function mutateMeta(mutator) {
  return mutateStored(STORAGE_KEYS.META, getMeta, (current) => mutator({ ...current }));
}

export async function getSnapshot() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SNAPSHOT);
  return result[STORAGE_KEYS.SNAPSHOT] || null;
}

export async function saveSnapshot(snapshot) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SNAPSHOT]: snapshot });
  return snapshot;
}

const EMPTY_UPDATE = {
  checkedAt: 0,
  latestVersion: "",
  availableVersion: "",
  packageUrl: "",
  error: "",
  currentVersion: "",
};

export async function getExtensionUpdate() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.UPDATE);
  return { ...EMPTY_UPDATE, ...(result[STORAGE_KEYS.UPDATE] || {}) };
}

export function saveExtensionUpdate(status) {
  return mutateStored(STORAGE_KEYS.UPDATE, getExtensionUpdate, () => ({ ...EMPTY_UPDATE, ...status }));
}

export async function getActivity() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.ACTIVITY);
  return result[STORAGE_KEYS.ACTIVITY] || [];
}

export async function saveActivity(activity) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITY]: activity });
  return activity;
}

export async function getWatchdog() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.WATCHDOG);
  return normalizeWatchdog(result[STORAGE_KEYS.WATCHDOG] || {});
}

export function saveWatchdogRecord(record) {
  return mutateStored(STORAGE_KEYS.WATCHDOG, getWatchdog, () => normalizeWatchdog(record));
}

export async function getChannelPoints() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CHANNEL_POINTS);
  return result[STORAGE_KEYS.CHANNEL_POINTS] || {};
}

export function mutateChannelPoints(mutator) {
  return mutateStored(STORAGE_KEYS.CHANNEL_POINTS, getChannelPoints, (current) =>
    mutator({ ...current })
  );
}

export async function getSevenTvCache() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SEVENTV);
  return result[STORAGE_KEYS.SEVENTV] || {};
}

export function mutateSevenTvCache(mutator) {
  return mutateStored(STORAGE_KEYS.SEVENTV, getSevenTvCache, (current) => mutator({ ...current }));
}

export function mutateActivity(mutator) {
  return mutateStored(STORAGE_KEYS.ACTIVITY, getActivity, (current) => mutator([...current]));
}

// Session storage is cleared when the browser closes but survives service
// worker restarts, which is exactly the lifetime short-lived intent needs.
export async function getSessionValue(key, fallback) {
  try {
    const result = await chrome.storage.session.get(key);
    return result[key] ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setSessionValue(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch {
    // Session storage is unavailable in some contexts; callers degrade.
  }
}

const sessionChains = new Map();

export function mutateSessionValue(key, fallback, mutator) {
  const previous = sessionChains.get(key) || Promise.resolve();
  const run = async () => {
    const current = await getSessionValue(key, fallback);
    const next = await mutator(current);
    if (next === undefined) return current;
    await setSessionValue(key, next);
    return next;
  };
  const result = previous.then(run, run);
  sessionChains.set(
    key,
    result.then(
      () => {},
      () => {}
    )
  );
  return result;
}

export async function getAppState() {
  const [
    settings,
    auth,
    follows,
    favorites,
    liveState,
    managedTabs,
    pendingCloses,
    dismissed,
    meta,
    snapshot,
    activity,
    channelPoints,
    sevenTv,
  ] = await Promise.all([
    getSettings(),
    getAuth(),
    getFollows(),
    getFavorites(),
    getLiveState(),
    getManagedTabs(),
    getPendingCloses(),
    getDismissed(),
    getMeta(),
    getSnapshot(),
    getActivity(),
    getChannelPoints(),
    getSevenTvCache(),
  ]);

  return {
    settings,
    auth,
    follows,
    favorites,
    liveState,
    managedTabs,
    pendingCloses,
    dismissed,
    meta,
    snapshot,
    activity,
    channelPoints,
    sevenTv,
  };
}