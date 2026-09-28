// Merging one machine's favorites and preferences with another's.
//
// Pure on purpose: every awkward case here — a favorite removed on one machine
// while it was edited on the other, two machines that have never seen each
// other, a machine that was offline for a week — is a data question, and
// answering it in a function that takes two objects and returns a third is the
// only way to test it without two computers.
//
// Rules:
//   * Each favorite carries updatedAt and syncs as its own item, so two
//     machines editing different channels never collide.
//   * Removals leave a tombstone. Without one, a machine that was offline
//     during the removal cannot tell "deleted over there" from "added here",
//     and would resurrect the channel on every sync.
//   * Later timestamp wins. Ties go to whatever is already local, so an idle
//     machine never rewrites its own state.

export const SYNC_KEYS = {
  FAVORITE_PREFIX: "fav:",
  SETTINGS: "syncSettings",
  META: "syncMeta",
};

// A code this computer made, or one pasted from another computer. Computers
// that use the same code share one set of favorites and settings. The code
// stays on this machine: if it traveled with the settings, changing it here
// would drag every other computer into the new set.
export const SYNC_GROUP_MAX = 80;

const SYNC_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function makeSyncGroup() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => SYNC_CODE_ALPHABET[byte % SYNC_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function normalizeSyncGroup(value) {
  return String(value ?? "").trim().slice(0, SYNC_GROUP_MAX);
}

// Empty means "do not share". There is no default bucket, because that is
// what made every computer on the profile land in the same set.
export function scopePrefix(group) {
  const name = normalizeSyncGroup(group);
  if (!name) return "";
  return `g:${encodeURIComponent(name)}:`;
}

// Machine-specific or derived, so they must not travel.
export const UNSYNCED_SETTINGS = new Set([
  "clientId",
  "publishedApp",
  "syncGroup",
  "backgroundQuality",
  "watchingQuality",
]);

// A tombstone is kept this long. It only has to outlive the longest realistic
// gap between a machine being switched off and switched on again; keeping them
// forever would slowly consume the 512-item sync quota.
export const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export function favoriteKey(userId, group = "") {
  return `${scopePrefix(group)}${SYNC_KEYS.FAVORITE_PREFIX}${userId}`;
}

export function settingsKey(group = "") {
  return `${scopePrefix(group)}${SYNC_KEYS.SETTINGS}`;
}

export function isFavoriteKey(key, group = "") {
  return typeof key === "string" && key.startsWith(`${scopePrefix(group)}${SYNC_KEYS.FAVORITE_PREFIX}`);
}

export function userIdFromKey(key, group = "") {
  const prefix = `${scopePrefix(group)}${SYNC_KEYS.FAVORITE_PREFIX}`;
  return typeof key === "string" && key.startsWith(prefix) ? key.slice(prefix.length) : "";
}

export function stripUnsynced(settings = {}) {
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!UNSYNCED_SETTINGS.has(key)) out[key] = value;
  }
  return out;
}

function timeOf(value) {
  const at = Number(value?.updatedAt);
  return Number.isFinite(at) ? at : 0;
}

// A removal this machine made, held locally as well as published. Publishing
// alone is not enough: if the machine was offline when the user unstarred a
// channel, the write fails, and the next successful sync sees a favorite the
// other machine still has and no evidence it was ever deleted — so it comes
// back. Keeping the tombstone locally until it has outlived its usefulness is
// what makes an offline removal stick.
function localRecord(local, localTombstones, userId) {
  const favorite = local[userId];
  if (favorite) return { ...favorite, updatedAt: timeOf(favorite) };
  const at = Number(localTombstones[userId]);
  return Number.isFinite(at) && at > 0 ? { deleted: true, updatedAt: at } : null;
}

// Reconciles local favorites against what is in sync storage.
//
// Returns the favorites this machine should now hold, the items it owes the
// other machines, remote items worth deleting, and the tombstones still worth
// keeping. A first-ever merge is deliberately a union: switching sync on
// should collect both machines' favorites, not let whichever one happens to
// sync first erase the other's.
export function mergeFavorites({
  local = {},
  localTombstones = {},
  remote = {},
  firstMerge = false,
  now = Date.now(),
  group = "",
}) {
  const favorites = {};
  const push = {};
  const drop = [];
  const tombstones = {};

  const ids = new Set([
    ...Object.keys(local),
    ...Object.keys(localTombstones),
    ...Object.keys(remote).filter((key) => isFavoriteKey(key, group)).map((key) => userIdFromKey(key, group)),
  ]);

  for (const userId of ids) {
    const mine = localRecord(local, localTombstones, userId);
    const theirs = remote[favoriteKey(userId, group)] || null;
    if (!mine && !theirs) continue;

    let winner;
    let fromRemote = false;

    if (!mine) {
      winner = theirs;
      fromRemote = true;
    } else if (!theirs) {
      winner = mine;
    } else if (theirs.deleted && firstMerge && !mine.deleted) {
      // The one case where a tombstone is not trusted. On a first sync it may
      // predate this machine entirely, and silently deleting a favorite the
      // user can currently see is far worse than keeping an extra one.
      winner = { ...mine, updatedAt: now };
    } else if (timeOf(theirs) > timeOf(mine)) {
      winner = theirs;
      fromRemote = true;
    } else {
      winner = mine;
    }

    const at = timeOf(winner) || now;

    if (winner.deleted) {
      if (now - at > TOMBSTONE_TTL_MS) {
        // Long enough that no machine can still be unaware of it.
        if (theirs) drop.push(favoriteKey(userId, group));
        continue;
      }
      tombstones[userId] = at;
      if (!fromRemote && timeOf(theirs) < at) {
        push[favoriteKey(userId, group)] = { deleted: true, updatedAt: at };
      }
      continue;
    }

    const { updatedAt, deleted, ...fields } = winner;
    favorites[userId] = { ...fields, userId, updatedAt: at };
    if (!fromRemote && timeOf(theirs) < at) {
      push[favoriteKey(userId, group)] = { ...fields, userId, updatedAt: at };
    }
  }

  return { favorites, push, drop, tombstones };
}

// Settings merge as one item rather than per field. Two machines changing
// different preferences within the same sync round would lose one of the two,
// which is a real limitation, but settings are edited rarely and almost always
// from one machine; per-field timestamps would cost more storage and more
// complexity than the case is worth.
export function mergeSettings({ local = {}, remote = null, localUpdatedAt = 0, now = Date.now() }) {
  const mine = stripUnsynced(local);

  if (!remote) {
    return { settings: local, push: { ...mine, updatedAt: localUpdatedAt || now } };
  }

  const { updatedAt, ...theirs } = remote;
  if (Number(updatedAt) > Number(localUpdatedAt)) {
    // Unsynced fields are kept from the local copy: the other machine's client
    // id is not this machine's business.
    return { settings: { ...local, ...stripUnsynced(theirs) }, push: null, updatedAt };
  }

  if (Number(localUpdatedAt) > Number(updatedAt)) {
    return { settings: local, push: { ...mine, updatedAt: localUpdatedAt } };
  }

  return { settings: local, push: null };
}

// Removing a favorite has to leave something behind, or the other machine
// cannot tell a deletion from a channel it has not seen yet.
export function tombstone(now = Date.now()) {
  return { deleted: true, updatedAt: now };
}

// chrome.storage.sync rejects an item over 8KB and silently costs quota for
// the rest, so an oversized favorite is dropped from the sync rather than
// wedging every later write. Category lists are the only field that can grow.
export const MAX_ITEM_BYTES = 8192;

export function itemTooLarge(key, value) {
  try {
    return JSON.stringify({ [key]: value }).length > MAX_ITEM_BYTES;
  } catch {
    return true;
  }
}
