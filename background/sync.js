// Keeping two computers in step through chrome.storage.sync.
//
// Only what the user actually set travels: favorites, their per-channel
// options, and preferences. Follows are not synced — they are a copy of a list
// Twitch already holds and would eat the whole quota. Live state, open tabs,
// activity and points are all about one machine at one moment and mean nothing
// on the other. The Twitch login is deliberately excluded too: sync storage
// rides on the Google account, and an OAuth token does not belong there.
//
// The merge itself lives in shared/sync-logic.js and is pure. This file is
// only plumbing: read, merge, write, and do not let the write come back round
// as another read.
import {
  favoriteKey,
  isFavoriteKey,
  itemTooLarge,
  mergeFavorites,
  mergeSettings,
  makeSyncGroup,
  normalizeSyncGroup,
  settingsKey,
  stripUnsynced,
  SYNC_KEYS,
  tombstone,
  userIdFromKey,
} from "../shared/sync-logic.js";
import {
  getFavorites,
  getMeta,
  getSettings,
  mutateFavorites,
  mutateMeta,
  saveMeta,
  saveSettings,
} from "../shared/storage.js";
import { logActivity } from "./activity.js";

// Applying a remote change writes to local storage, which is exactly what a
// local edit does. Without this guard the two would chase each other around
// the sync quota forever.
let applyingRemote = false;

// chrome.storage.sync allows 120 writes a minute and 1800 an hour. Toggling a
// row of favorites can easily produce a burst, so pushes are coalesced.
const PUSH_DEBOUNCE_MS = 1500;
let pushTimer = null;
let pushPending = null;

function syncArea() {
  return chrome.storage?.sync || null;
}

async function syncContext() {
  const settings = await getSettings();
  const group = normalizeSyncGroup(settings.syncGroup);
  const enabled = Boolean(syncArea()) && settings.syncEnabled !== false && Boolean(group);
  return { settings, group, enabled };
}

export async function syncEnabled() {
  return (await syncContext()).enabled;
}

// Every install gets its own code, so two computers do not share a set until
// someone copies the code across. A blank code is filled in here rather than
// left as a prompt to invent one.
export async function ensureSyncGroup() {
  const settings = await getSettings();
  const existing = normalizeSyncGroup(settings.syncGroup);
  if (existing) return existing;
  const made = makeSyncGroup();
  await saveSettings({ syncGroup: made });
  return made;
}

// The old unscoped keys were one set for every computer. Once a name is in
// use, those keys are the set nobody asked to join, so they are dropped
// rather than left sitting in the quota.
async function retireSharedBucket() {
  const remote = await readRemote();
  const stale = Object.keys(remote).filter(
    (key) => !key.startsWith("g:") && (isFavoriteKey(key) || key === SYNC_KEYS.SETTINGS || key === SYNC_KEYS.META)
  );
  if (stale.length) await writeRemote({}, stale);
}

async function readRemote() {
  try {
    return (await syncArea().get(null)) || {};
  } catch {
    return {};
  }
}

// Chrome reports our own writes back to us as change events, exactly as if the
// other computer had made them. Without remembering what we just wrote, every
// local edit would come back round, be treated as remote, and get announced to
// the user as a change from another machine.
const recentWrites = new Map();
const OWN_WRITE_WINDOW_MS = 10_000;

function rememberWrite(key, value) {
  recentWrites.set(key, { at: Date.now(), json: JSON.stringify(value ?? null) });
}

function wasOwnWrite(key, change) {
  const seen = recentWrites.get(key);
  if (!seen) return false;
  if (Date.now() - seen.at > OWN_WRITE_WINDOW_MS) {
    recentWrites.delete(key);
    return false;
  }
  return JSON.stringify(change?.newValue ?? null) === seen.json;
}

async function writeRemote(items, removals = []) {
  const area = syncArea();
  if (!area) return;

  const safe = {};
  for (const [key, value] of Object.entries(items)) {
    // One oversized item would fail the whole set() call and take every other
    // change in the batch down with it.
    if (itemTooLarge(key, value)) continue;
    safe[key] = value;
  }

  try {
    if (Object.keys(safe).length) {
      for (const [key, value] of Object.entries(safe)) rememberWrite(key, value);
      await area.set(safe);
    }
    if (removals.length) {
      for (const key of removals) rememberWrite(key, undefined);
      await area.remove(removals);
    }
  } catch (error) {
    // Over quota, or signed out of Chrome. Local state is untouched and still
    // correct; the next push tries again.
    console.warn("Sync write failed", error);
  }
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export async function pullFromSync({ firstMerge = false } = {}) {
  const { group, enabled } = await syncContext();
  if (!enabled) return null;

  const remote = await readRemote();
  const [localFavorites, localSettings, meta] = await Promise.all([
    getFavorites(),
    getSettings(),
    getMeta(),
  ]);

  // Switching names starts over with that name's set. Tombstones from the
  // previous name must not delete favorites in the one just joined.
  const joining = normalizeSyncGroup(meta.syncGroup) !== group;
  const favoriteResult = mergeFavorites({
    local: localFavorites,
    localTombstones: joining ? {} : meta.removedFavorites || {},
    remote,
    group,
    firstMerge: firstMerge || !meta.syncedAt || joining,
  });

  const settingsResult = mergeSettings({
    local: localSettings,
    remote: remote[settingsKey(group)] || null,
    localUpdatedAt: meta.settingsUpdatedAt || 0,
  });

  applyingRemote = true;
  try {
    await mutateFavorites(() => favoriteResult.favorites);
    if (settingsResult.settings !== localSettings) {
      await saveSettings(settingsResult.settings);
      await mutateMeta((current) => ({
        ...current,
        settingsUpdatedAt: settingsResult.updatedAt || current.settingsUpdatedAt || 0,
      }));
    }
  } finally {
    applyingRemote = false;
  }

  await mutateMeta((current) => ({
    ...current,
    syncedAt: Date.now(),
    syncGroup: group,
    // Expired tombstones are dropped here, which is the only thing keeping
    // this map from growing for the life of the profile.
    removedFavorites: favoriteResult.tombstones,
  }));

  const owed = { ...favoriteResult.push };
  if (settingsResult.push) owed[settingsKey(group)] = settingsResult.push;
  if (Object.keys(owed).length || favoriteResult.drop.length) {
    await writeRemote(owed, favoriteResult.drop);
  }
  await retireSharedBucket();

  return {
    favorites: Object.keys(favoriteResult.favorites).length,
    pushed: Object.keys(owed).length,
  };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export function schedulePush(what = "favorites") {
  pushPending = pushPending === null || pushPending === what ? what : "all";
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    const target = pushPending;
    pushTimer = null;
    pushPending = null;
    pushToSync(target).catch((error) => console.warn("Sync push failed", error));
  }, PUSH_DEBOUNCE_MS);
}

export async function pushToSync(what = "all") {
  if (applyingRemote) return null;
  const { group, enabled } = await syncContext();
  if (!enabled) return null;

  const items = {};

  if (what === "all" || what === "favorites") {
    const favorites = await getFavorites();
    for (const [userId, favorite] of Object.entries(favorites)) {
      items[favoriteKey(userId, group)] = { ...favorite, updatedAt: favorite.updatedAt || Date.now() };
    }
  }

  if (what === "all" || what === "settings") {
    const [settings, meta] = await Promise.all([getSettings(), getMeta()]);
    items[settingsKey(group)] = {
      ...stripUnsynced(settings),
      updatedAt: meta.settingsUpdatedAt || Date.now(),
    };
  }

  await writeRemote(items);
  await mutateMeta((current) => ({ ...current, syncedAt: Date.now(), syncGroup: group }));
  await retireSharedBucket();
  return Object.keys(items).length;
}

// A removal is published as a tombstone rather than by deleting the item, so
// a machine that is switched off today still learns about it tomorrow instead
// of pushing the favorite straight back. It is recorded locally first: the
// publish can fail while offline, and the local copy is what makes the removal
// survive that.
export async function recordFavoriteRemoval(userId) {
  if (applyingRemote) return;
  const { group, enabled } = await syncContext();
  if (!enabled) return;

  const at = Date.now();
  await mutateMeta((meta) => ({
    ...meta,
    syncGroup: group,
    removedFavorites: { ...(meta.removedFavorites || {}), [String(userId)]: at },
  }));
  await writeRemote({ [favoriteKey(userId, group)]: tombstone(at) });
}

// ---------------------------------------------------------------------------
// Remote changes
// ---------------------------------------------------------------------------

// Fires on every machine signed into the same Chrome profile, including this
// one after its own write, which is what applyingRemote is guarding.
export async function handleSyncChange(changes) {
  if (applyingRemote) return false;
  const { group, enabled } = await syncContext();
  if (!enabled) return false;

  const keys = Object.keys(changes || {}).filter(
    (key) =>
      (isFavoriteKey(key, group) || key === settingsKey(group)) && !wasOwnWrite(key, changes[key])
  );
  if (!keys.length) return false;

  await pullFromSync();

  const changedFavorites = keys.filter((key) => isFavoriteKey(key, group)).length;
  if (changedFavorites) {
    await logActivity(
      `Synced ${changedFavorites} favorite${changedFavorites === 1 ? "" : "s"} from another computer`
    );
  } else {
    await logActivity("Synced settings from another computer");
  }
  return true;
}

// Called once when sync is first switched on, and on every startup so a
// machine that was off catches up before it starts acting on stale favorites.
export async function reconcileSync() {
  if (!(await syncEnabled())) return null;
  return pullFromSync();
}

// What the user can see about sync, so a machine that is not syncing can be
// diagnosed rather than guessed at. The extension id is the one that matters:
// sync storage is namespaced by it, so two machines showing different ids can
// never see each other no matter what else is set.
export async function syncDiagnostics() {
  const [settings, meta] = await Promise.all([getSettings(), getMeta()]);
  const group = normalizeSyncGroup(settings.syncGroup);
  const remote = syncArea() ? await readRemote() : {};
  const favorites = Object.keys(remote).filter((key) => isFavoriteKey(key, group)).length;

  let bytes = null;
  try {
    bytes = await syncArea()?.getBytesInUse(null);
  } catch {
    // Not every Chrome build exposes this.
  }

  return {
    extensionId: chrome.runtime.id,
    enabled: settings.syncEnabled !== false && Boolean(group),
    group,
    available: Boolean(syncArea()),
    favorites,
    items: Object.keys(remote).length,
    bytes,
    lastSyncedAt: meta.syncedAt || 0,
  };
}

// Forces a full round trip rather than waiting for the next startup, so the
// user can press a button and find out immediately whether sync works at all.
export async function syncNow() {
  if (!(await syncEnabled())) return { ...(await syncDiagnostics()), ran: false };
  await pushToSync("all");
  await pullFromSync();
  return { ...(await syncDiagnostics()), ran: true };
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

// A file the user can carry themselves. This exists for two reasons that both
// bite in practice: pinning the extension id changes it, and Chrome keys
// storage by id, so an existing install looks empty the first time it loads
// with a key. And if Chrome declines to sync an extension loaded from a folder
// rather than the Web Store, this is the fallback that always works.
//
// The Twitch login is left out for the same reason it is left out of sync: a
// file in the downloads folder is no place for an OAuth token.
export const EXPORT_VERSION = 1;

export async function exportData() {
  const [favorites, settings] = await Promise.all([getFavorites(), getSettings()]);
  return {
    kind: "autolurk-backup",
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    favorites,
    settings: stripUnsynced(settings),
  };
}

export async function importData(payload) {
  if (!payload || payload.kind !== "autolurk-backup") {
    throw new Error("That does not look like an AutoLurk backup file.");
  }
  if (Number(payload.version) > EXPORT_VERSION) {
    throw new Error("That backup was made by a newer version of AutoLurk.");
  }

  // Run through the same merge the other computer's data goes through, so an
  // import adds to what is here rather than replacing it, and a favorite edited
  // more recently on this machine is not undone by an older backup.
  const remote = {};
  for (const [userId, favorite] of Object.entries(payload.favorites || {})) {
    remote[favoriteKey(userId)] = { ...favorite, updatedAt: favorite.updatedAt || 0 };
  }

  const local = await getFavorites();
  const { favorites } = mergeFavorites({ local, remote, firstMerge: true });

  applyingRemote = true;
  try {
    await mutateFavorites(() => favorites);
    if (payload.settings) {
      await saveSettings(stripUnsynced(payload.settings));
      // Stamped with the import, not with whenever the backup was written.
      // Without this the push below still carries the old timestamp, and the
      // other computer's untouched settings read as newer and undo the import.
      await saveMeta({ settingsUpdatedAt: Date.now() });
    }
  } finally {
    applyingRemote = false;
  }

  schedulePush("all");
  return { favorites: Object.keys(favorites).length };
}

export { userIdFromKey };
