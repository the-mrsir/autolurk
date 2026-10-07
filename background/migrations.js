import { SCHEMA_VERSION, STORAGE_KEYS } from "../shared/constants.js";
import {
  getMeta,
  getSettings,
  mutateFavorites,
  saveMeta,
  saveSettings,
} from "../shared/storage.js";

// Ordered migrations. Index N upgrades the store from version N to N+1, so a
// fresh install just records the current version and runs nothing.
const MIGRATIONS = [
  // 0 -> 1: the shared Twitch app needs a polling floor that scales.
  async () => {
    const settings = await getSettings();
    if (settings.checkIntervalSeconds >= 300) return;
    await saveSettings({ checkIntervalSeconds: 300 });
  },

  // 1 -> 2: notification preferences became global with per-channel overrides.
  async () => {
    const settings = await getSettings();
    const patch = {};
    if (settings.defaultNotifyLive !== undefined) patch.notifyLive = settings.defaultNotifyLive;
    if (settings.defaultNotifyGameChange !== undefined) {
      patch.notifyGameChange = settings.defaultNotifyGameChange;
    }
    if (settings.defaultNotifyTitleChange !== undefined) {
      patch.notifyTitleChange = settings.defaultNotifyTitleChange;
    }
    if (Object.keys(patch).length) await saveSettings(patch);

    await mutateFavorites((favorites) => {
      for (const [userId, favorite] of Object.entries(favorites)) {
        favorites[userId] = {
          ...favorite,
          notifyLive: null,
          notifyGameChange: null,
          notifyTitleChange: null,
        };
      }
      return favorites;
    });
  },

  // 2 -> 3: drops reminders were guesswork built on DOM scraping and are gone.
  // The old channel-point toggle is dropped too; the feature was rebuilt around
  // claiming rather than scraping a balance, so the new default should apply
  // instead of whatever the old switch was set to.
  async () => {
    const settings = await getSettings();
    const cleaned = { ...settings };
    for (const key of ["dropsReminders", "channelPointsEnabled"]) {
      delete cleaned[key];
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: cleaned });
  },

  // 3 -> 4: a tab Brave closed because the other computer closed its mirror
  // was recorded as the user closing that stream, which kept a live favorite
  // from opening for the rest of its broadcast. Those records are dropped.
  async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.DISMISSED]: {} });
  },
];

// Installs that predate schemaVersion recorded progress as individual booleans.
function inferLegacyVersion(settings) {
  if (settings.notifyGlobalMigrated) return 2;
  if (settings.publicScaleMigrated) return 1;
  return 0;
}

export async function runMigrations() {
  const [meta, settings] = await Promise.all([getMeta(), getSettings()]);

  let version = Number(meta.schemaVersion);
  if (!Number.isFinite(version) || version <= 0) {
    // A store with no data at all is already current; nothing to reshape.
    const untouched = !settings.publicScaleMigrated && !settings.notifyGlobalMigrated;
    version = untouched && !meta.lastPollAt ? SCHEMA_VERSION : inferLegacyVersion(settings);
  }

  if (version >= SCHEMA_VERSION) {
    if (meta.schemaVersion !== SCHEMA_VERSION) await saveMeta({ schemaVersion: SCHEMA_VERSION });
    return SCHEMA_VERSION;
  }

  for (let step = version; step < SCHEMA_VERSION; step += 1) {
    const migrate = MIGRATIONS[step];
    if (migrate) await migrate();
    // Record progress after each step so a crash cannot replay a finished one.
    await saveMeta({ schemaVersion: step + 1 });
  }

  return SCHEMA_VERSION;
}
