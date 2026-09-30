// Two computers sharing one set of favorites. Every case here is one that
// cannot be reproduced by hand without owning two machines and waiting, which
// is exactly why the merge was written as a pure function.
import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";
import {
  favoriteKey,
  itemTooLarge,
  makeSyncGroup,
  mergeFavorites,
  mergeSettings,
  stripUnsynced,
  TOMBSTONE_TTL_MS,
} from "../shared/sync-logic.js";

const mock = chromeMock();
const NOW = 1_700_000_000_000;
const minutes = (n) => n * 60_000;

function favorite(userId, overrides = {}) {
  return { userId, login: userId, autoOpen: true, priority: "normal", ...overrides };
}

describe("a sync code", () => {
  it("makes a short code this computer can hand to another", () => {
    const code = makeSyncGroup();
    assert.equal(/^[a-z2-9]{4}-[a-z2-9]{4}$/.test(code), true);
    assert.equal(code === makeSyncGroup(), false);
  });
});

describe("merging favorites between computers", () => {
  it("collects both machines' favorites the first time they meet", () => {
    // Neither machine has ever synced, so neither list is more correct than
    // the other. Erasing either one would lose work the user actually did.
    const { favorites } = mergeFavorites({
      local: { "1": favorite("1") },
      remote: { [favoriteKey("2")]: { ...favorite("2"), updatedAt: NOW - minutes(5) } },
      firstMerge: true,
      now: NOW,
    });

    assert.deepEqual(Object.keys(favorites).sort(), ["1", "2"]);
  });

  it("takes the newer edit when both machines changed the same channel", () => {
    const { favorites } = mergeFavorites({
      local: { "1": favorite("1", { priority: "low", updatedAt: NOW - minutes(10) }) },
      remote: { [favoriteKey("1")]: favorite("1", { priority: "high", updatedAt: NOW - minutes(1) }) },
      now: NOW,
    });

    assert.equal(favorites["1"].priority, "high");
  });

  it("keeps the local edit when it is the newer one, and offers it up", () => {
    const { favorites, push } = mergeFavorites({
      local: { "1": favorite("1", { priority: "low", updatedAt: NOW - minutes(1) }) },
      remote: { [favoriteKey("1")]: favorite("1", { priority: "high", updatedAt: NOW - minutes(9) }) },
      now: NOW,
    });

    assert.equal(favorites["1"].priority, "low");
    assert.ok(push[favoriteKey("1")], "the newer local copy should be published");
  });

  it("writes nothing when the two sides already agree", () => {
    // Otherwise every startup would burn sync quota republishing itself.
    const shared = favorite("1", { updatedAt: NOW - minutes(30) });
    const { push, drop } = mergeFavorites({
      local: { "1": shared },
      remote: { [favoriteKey("1")]: shared },
      now: NOW,
    });

    assert.deepEqual(push, {});
    assert.deepEqual(drop, []);
  });

  it("does not resurrect a favorite the other computer removed", () => {
    const { favorites } = mergeFavorites({
      local: { "1": favorite("1", { updatedAt: NOW - minutes(30) }) },
      remote: { [favoriteKey("1")]: { deleted: true, updatedAt: NOW - minutes(2) } },
      now: NOW,
    });

    assert.equal(favorites["1"], undefined);
  });

  it("keeps a favorite that was re-added after the other computer removed it", () => {
    const { favorites } = mergeFavorites({
      local: { "1": favorite("1", { updatedAt: NOW - minutes(1) }) },
      remote: { [favoriteKey("1")]: { deleted: true, updatedAt: NOW - minutes(20) } },
      now: NOW,
    });

    assert.ok(favorites["1"], "the newer re-add should win over the older removal");
  });

  it("ignores a removal that predates this computer ever syncing", () => {
    // A tombstone older than the first merge may be from before this machine
    // existed. Silently deleting a favorite the user can see is worse than
    // keeping one they meant to drop.
    const { favorites, push } = mergeFavorites({
      local: { "1": favorite("1", { updatedAt: 0 }) },
      remote: { [favoriteKey("1")]: { deleted: true, updatedAt: NOW - minutes(2) } },
      firstMerge: true,
      now: NOW,
    });

    assert.ok(favorites["1"]);
    assert.ok(push[favoriteKey("1")], "and it should be republished so it stops being deleted");
  });

  it("makes a removal stick even though it happened while offline", () => {
    // The publish failed, so sync storage still has the favorite. The local
    // tombstone is the only record that it was deleted; without it the next
    // successful sync would hand the channel straight back.
    const { favorites, push } = mergeFavorites({
      local: {},
      localTombstones: { "1": NOW - minutes(5) },
      remote: { [favoriteKey("1")]: favorite("1", { updatedAt: NOW - minutes(60) }) },
      now: NOW,
    });

    assert.equal(favorites["1"], undefined);
    assert.deepEqual(push[favoriteKey("1")], { deleted: true, updatedAt: NOW - minutes(5) });
  });

  it("lets the other computer's newer re-add beat a local removal", () => {
    const { favorites } = mergeFavorites({
      local: {},
      localTombstones: { "1": NOW - minutes(30) },
      remote: { [favoriteKey("1")]: favorite("1", { updatedAt: NOW - minutes(2) }) },
      now: NOW,
    });

    assert.ok(favorites["1"], "a deliberate re-add elsewhere should win");
  });

  it("forgets a removal once no machine could still be unaware of it", () => {
    const { tombstones, drop } = mergeFavorites({
      local: {},
      localTombstones: { "1": NOW - TOMBSTONE_TTL_MS - minutes(1) },
      remote: { [favoriteKey("1")]: { deleted: true, updatedAt: NOW - TOMBSTONE_TTL_MS - minutes(1) } },
      now: NOW,
    });

    assert.equal(tombstones["1"], undefined, "the local record should be pruned");
    assert.deepEqual(drop, [favoriteKey("1")], "and the sync item released");
  });

  it("keeps a removal that is still recent", () => {
    const { tombstones } = mergeFavorites({
      local: {},
      localTombstones: { "1": NOW - minutes(60) },
      remote: {},
      now: NOW,
    });

    assert.equal(tombstones["1"], NOW - minutes(60));
  });

  it("keeps a different sync name's favorites out of this set", () => {
    const { favorites } = mergeFavorites({
      local: {},
      remote: {
        [favoriteKey("1", "house")]: favorite("1", { updatedAt: NOW }),
        [favoriteKey("2", "office")]: favorite("2", { updatedAt: NOW }),
      },
      group: "house",
      now: NOW,
    });

    assert.deepEqual(Object.keys(favorites), ["1"]);
  });

  it("ignores keys in sync storage that are not favorites", () => {
    const { favorites } = mergeFavorites({
      local: {},
      remote: { syncSettings: { muteTabs: true, updatedAt: NOW }, syncMeta: { version: 1 } },
      now: NOW,
    });

    assert.deepEqual(favorites, {});
  });
});

describe("merging preferences between computers", () => {
  it("takes the other computer's newer preferences", () => {
    const { settings } = mergeSettings({
      local: { muteTabs: true, checkIntervalSeconds: 300 },
      remote: { muteTabs: false, checkIntervalSeconds: 120, updatedAt: NOW },
      localUpdatedAt: NOW - minutes(10),
    });

    assert.equal(settings.muteTabs, false);
    assert.equal(settings.checkIntervalSeconds, 120);
  });

  it("keeps this computer's preferences when they are newer", () => {
    const { settings, push } = mergeSettings({
      local: { muteTabs: true },
      remote: { muteTabs: false, updatedAt: NOW - minutes(10) },
      localUpdatedAt: NOW,
    });

    assert.equal(settings.muteTabs, true);
    assert.ok(push, "the newer local copy should be published");
  });

  it("never lets the other computer's client id travel", () => {
    // It identifies the Twitch app this install is registered against and is
    // derived locally; taking someone else's would break every API call.
    const { settings } = mergeSettings({
      local: { clientId: "mine", muteTabs: true },
      remote: { clientId: "theirs", muteTabs: false, updatedAt: NOW },
      localUpdatedAt: 0,
    });

    assert.equal(settings.clientId, "mine");
    assert.equal(settings.muteTabs, false);
  });

  it("strips machine-specific fields before publishing", () => {
    const stripped = stripUnsynced({
      clientId: "x",
      publishedApp: true,
      syncGroup: "house",
      backgroundQuality: "360p30",
      watchingQuality: "480p30",
      serverRotation: true,
      watchdogToken: "local-secret",
      muteTabs: false,
    });
    assert.deepEqual(stripped, { muteTabs: false });
  });

  it("publishes the local copy when the other computer has none", () => {
    const { push } = mergeSettings({ local: { muteTabs: true }, remote: null, now: NOW });
    assert.equal(push.muteTabs, true);
  });
});

describe("sharing favorites through Chrome", () => {
  const group = "house";
  const base = {
    settings: { syncEnabled: true, syncGroup: group, automationEnabled: false, autoOpenFavorites: false },
    meta: { schemaVersion: 3, syncedAt: NOW - minutes(60) },
  };

  it("picks up a favorite the other computer added", async () => {
    mock.reset({ storage: { ...base, favorites: {} } });
    mock.seedSync({
      [favoriteKey("42", group)]: { userId: "42", login: "newbie", autoOpen: true, updatedAt: Date.now() },
    });

    const { pullFromSync } = await import("../background/sync.js");
    await pullFromSync();

    assert.ok(mock.local.favorites["42"], "the favorite should have arrived");
    assert.equal(mock.local.favorites["42"].login, "newbie");
  });

  it("publishes a favorite added here", async () => {
    mock.reset({
      storage: {
        ...base,
        favorites: { "7": { userId: "7", login: "mine", autoOpen: true, updatedAt: Date.now() } },
      },
    });

    const { pushToSync } = await import("../background/sync.js");
    await pushToSync("favorites");

    assert.ok(mock.sync[favoriteKey("7", group)], "it should have been offered to the other computer");
  });

  it("does not report this computer's own change as coming from the other one", async () => {
    // Chrome echoes every write back as a change event. Treating that echo as
    // remote would announce the user's own edit to them and start a pull for
    // data they just supplied.
    mock.reset({
      storage: {
        ...base,
        favorites: { "7": { userId: "7", login: "mine", autoOpen: true, updatedAt: Date.now() } },
      },
    });

    const { pushToSync, handleSyncChange } = await import("../background/sync.js");
    await pushToSync("favorites");

    const echo = {
      [favoriteKey("7", group)]: { newValue: mock.sync[favoriteKey("7", group)] },
    };
    assert.equal(await handleSyncChange(echo), false, "the echo should be ignored");
  });

  it("acts on a genuine change from the other computer", async () => {
    mock.reset({ storage: { ...base, favorites: {} } });
    const item = { userId: "9", login: "theirs", autoOpen: true, updatedAt: Date.now() };
    mock.seedSync({ [favoriteKey("9", group)]: item });

    const { handleSyncChange } = await import("../background/sync.js");
    const acted = await handleSyncChange({ [favoriteKey("9", group)]: { newValue: item } });

    assert.equal(acted, true);
    assert.ok(mock.local.favorites["9"], "the favorite should have been taken up");
  });

  it("stays out of the way entirely when the user turns sync off", async () => {
    mock.reset({
      storage: {
        ...base,
        settings: { ...base.settings, syncEnabled: false },
        favorites: { "7": { userId: "7", login: "mine", updatedAt: Date.now() } },
      },
    });

    const { pushToSync, pullFromSync } = await import("../background/sync.js");
    await pushToSync("favorites");
    await pullFromSync();

    assert.deepEqual(Object.keys(mock.sync), [], "nothing should have been published");
  });

  it("never lets the Twitch login travel", async () => {
    // Sync storage rides on the Google account. An OAuth token does not belong
    // there, and this is the check that keeps a careless addition from putting
    // one there later.
    mock.reset({
      storage: {
        ...base,
        auth: { accessToken: "secret-token", refreshToken: "secret-refresh", userId: "self" },
        favorites: { "7": { userId: "7", login: "mine", updatedAt: Date.now() } },
      },
    });

    const { pushToSync } = await import("../background/sync.js");
    await pushToSync("all");

    const published = JSON.stringify(mock.sync);
    assert.equal(published.includes("secret-token"), false, "access token was published");
    assert.equal(published.includes("secret-refresh"), false, "refresh token was published");
    assert.equal(published.includes("syncGroup"), false, "the sync name was published with the settings");
  });

  it("leaves a favorite stored under a different name where it is", async () => {
    mock.reset({ storage: { ...base, favorites: {} } });
    mock.seedSync({
      [favoriteKey("42", "office")]: { userId: "42", login: "other", autoOpen: true, updatedAt: Date.now() },
    });

    const { pullFromSync } = await import("../background/sync.js");
    await pullFromSync();

    assert.equal(mock.local.favorites["42"], undefined, "another name's favorite arrived");
    assert.ok(mock.sync[favoriteKey("42", "office")], "the other name's favorite should still be stored");
  });

  it("shares nothing until a sync name is set", async () => {
    mock.reset({
      storage: {
        ...base,
        settings: { ...base.settings, syncGroup: "" },
        favorites: { "7": { userId: "7", login: "mine", updatedAt: Date.now() } },
      },
    });
    mock.seedSync({
      [favoriteKey("42", "house")]: { userId: "42", login: "newbie", autoOpen: true, updatedAt: Date.now() },
    });

    const { pushToSync, pullFromSync } = await import("../background/sync.js");
    await pushToSync("all");
    await pullFromSync();

    assert.equal(mock.local.favorites["42"], undefined, "a named set was pulled with no name set");
    assert.equal(mock.sync[favoriteKey("7", "house")], undefined, "a favorite was published with no name set");
  });

  it("drops the old shared bucket once a name is in use", async () => {
    mock.reset({ storage: { ...base, favorites: {} } });
    mock.seedSync({
      [favoriteKey("42")]: { userId: "42", login: "shared", autoOpen: true, updatedAt: Date.now() },
    });

    const { pullFromSync } = await import("../background/sync.js");
    await pullFromSync();

    assert.equal(mock.local.favorites["42"], undefined, "the old shared favorite was taken up");
    assert.equal(mock.sync[favoriteKey("42")], undefined, "the old shared key should have been removed");
  });
});

describe("carrying favorites in a file", () => {
  const base = {
    settings: { syncEnabled: true, automationEnabled: false, autoOpenFavorites: false },
    meta: { schemaVersion: 3 },
  };

  it("round trips favorites through a backup", async () => {
    mock.reset({
      storage: {
        ...base,
        favorites: {
          "1": { userId: "1", login: "one", autoOpen: true, updatedAt: NOW },
          "2": { userId: "2", login: "two", autoOpen: false, updatedAt: NOW },
        },
      },
    });

    const { exportData, importData } = await import("../background/sync.js");
    const backup = await exportData();

    mock.reset({ storage: { ...base, favorites: {} } });
    await importData(backup);

    assert.deepEqual(Object.keys(mock.local.favorites).sort(), ["1", "2"]);
    assert.equal(mock.local.favorites["2"].autoOpen, false, "per-channel options should survive");
  });

  it("adds to what is already here rather than replacing it", async () => {
    // This is what makes a backup safe to import on a machine that has already
    // been used, which is exactly when someone reaches for one.
    mock.reset({
      storage: {
        ...base,
        favorites: { "1": { userId: "1", login: "one", updatedAt: NOW } },
      },
    });

    const { importData } = await import("../background/sync.js");
    await importData({
      kind: "autolurk-backup",
      version: 1,
      favorites: { "2": { userId: "2", login: "two", updatedAt: NOW } },
    });

    assert.deepEqual(Object.keys(mock.local.favorites).sort(), ["1", "2"]);
  });

  it("dates imported settings to the import, not to the backup", async () => {
    // Otherwise the push that follows carries whatever timestamp the file was
    // written with, and the other computer's untouched settings read as newer
    // and quietly undo the import on the next pull.
    mock.reset({ storage: { ...base, favorites: {}, meta: { schemaVersion: 3 } } });

    const before = Date.now();
    const { importData } = await import("../background/sync.js");
    await importData({
      kind: "autolurk-backup",
      version: 1,
      exportedAt: NOW - 90 * 24 * 60 * 60_000,
      favorites: {},
      settings: { muteTabs: false },
    });

    assert.ok(
      (mock.local.meta || {}).settingsUpdatedAt >= before,
      "imported settings kept a stale timestamp"
    );
  });

  it("never writes the Twitch login into a backup", async () => {
    mock.reset({
      storage: {
        ...base,
        auth: { accessToken: "secret-token", refreshToken: "secret-refresh" },
        watchdog: { enabled: true, token: "monitor-secret", endpoint: "http://127.0.0.1:9/heartbeat" },
        favorites: { "1": { userId: "1", login: "one", updatedAt: NOW } },
      },
    });

    const { exportData } = await import("../background/sync.js");
    const serialized = JSON.stringify(await exportData());

    assert.equal(serialized.includes("secret-token"), false, "access token was exported");
    assert.equal(serialized.includes("secret-refresh"), false, "refresh token was exported");
    assert.equal(serialized.includes("monitor-secret"), false, "monitor token was exported");
  });

  it("refuses a file that is not an AutoLurk backup", async () => {
    mock.reset({ storage: base });
    const { importData } = await import("../background/sync.js");

    let message = "";
    try {
      await importData({ some: "other json" });
    } catch (error) {
      message = error.message;
    }
    assert.ok(message.includes("AutoLurk backup"), `unhelpful error: ${message}`);
  });

  it("refuses a backup from a newer version rather than mangling it", async () => {
    mock.reset({ storage: base });
    const { importData } = await import("../background/sync.js");

    let message = "";
    try {
      await importData({ kind: "autolurk-backup", version: 99, favorites: {} });
    } catch (error) {
      message = error.message;
    }
    assert.ok(message.includes("newer version"), `unhelpful error: ${message}`);
  });
});

describe("staying inside the sync quota", () => {
  it("accepts an ordinary favorite", () => {
    assert.equal(itemTooLarge(favoriteKey("1"), favorite("1")), false);
  });

  it("rejects one large enough to fail the whole write", () => {
    // Chrome refuses an item over 8KB and fails the entire set() call with it,
    // so one favorite with a huge category list would block every other change
    // in the same batch.
    const huge = favorite("1", { includeCategories: new Array(2000).fill("Just Chatting") });
    assert.equal(itemTooLarge(favoriteKey("1"), huge), true);
  });
});
