import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";

const mock = chromeMock();

const { HEALTH, HEALTH_TIMING, RECOVERY_STAGE } = await import("../shared/health.js");
const { getManagedTabs, getMeta, getSettings } = await import("../shared/storage.js");
const { runMigrations } = await import("../background/migrations.js");
const { SCHEMA_VERSION } = await import("../shared/constants.js");
const {
  handleBootWatchAlarm,
  handlePlayerHealth,
  requestRecovery,
  runHealthCheck,
  resetHealth,
} = await import("../background/stream-boot.js");
const {
  closeManagedTab,
  consumeProgrammaticClose,
  markProgrammaticClose,
  openManagedStream,
  reconcileManagedTabs,
} = await import("../background/tab-manager.js");
const { enforceSyncedFavoriteIntent, reconcileGroupedStreams } = await import(
  "../background/stream-manager.js"
);

const NOW = () => Date.now();

function managed(tabId, extra = {}) {
  return {
    tabId,
    userId: String(tabId),
    login: "streamer",
    displayName: "Streamer",
    expectedChannel: "streamer",
    observedChannel: "streamer",
    openedAt: NOW() - 10_000,
    lastVerifiedAt: NOW() - 5000,
    lastHeartbeatAt: NOW() - 1000,
    lastAdvanceAt: NOW() - 1000,
    lastCurrentTime: 100,
    mediaPlaying: true,
    muted: true,
    playerMuted: false,
    health: HEALTH.MEDIA_PLAYING,
    recoveryAttempts: 0,
    lastRecoveryAt: 0,
    ...extra,
  };
}

describe("migrations", () => {
  it("records the current version on a clean install without running anything", async () => {
    mock.reset({ storage: {} });
    await runMigrations();
    const meta = await getMeta();
    assert.equal(meta.schemaVersion, SCHEMA_VERSION);
    const settings = await getSettings();
    // A fresh install must keep the default interval, not the v1 fallback.
    assert.equal(settings.checkIntervalSeconds, 300);
  });

  it("resumes from the legacy boolean flags instead of replaying old steps", async () => {
    mock.reset({
      storage: {
        settings: { notifyGlobalMigrated: true, checkIntervalSeconds: 120 },
        meta: { lastPollAt: 5 },
      },
    });
    await runMigrations();
    const settings = await getSettings();
    // v0->1 would have forced 300; it must not run again for this install.
    assert.equal(settings.checkIntervalSeconds, 120);
    assert.equal((await getMeta()).schemaVersion, SCHEMA_VERSION);
  });

  it("is safe to run twice", async () => {
    mock.reset({ storage: {} });
    await runMigrations();
    await runMigrations();
    assert.equal((await getMeta()).schemaVersion, SCHEMA_VERSION);
  });
});

describe("programmatic close intent", () => {
  it("survives being read back from session storage", async () => {
    mock.reset({ storage: {} });
    await markProgrammaticClose(7);
    assert.ok(await consumeProgrammaticClose(7));
    // Consuming is one-shot: a later manual close must still count as manual.
    assert.notOk(await consumeProgrammaticClose(7));
  });

  it("reports a close it never made as manual", async () => {
    mock.reset({ storage: {} });
    assert.notOk(await consumeProgrammaticClose(7));
  });

  it("consumes intent after an extension-initiated close", async () => {
    mock.reset({
      tabs: [{ id: 7, url: "https://www.twitch.tv/streamer" }],
      storage: { managedTabs: { "7": managed(7) } },
    });
    assert.ok(await closeManagedTab(7));
    assert.notOk(await consumeProgrammaticClose(7));
    assert.equal((await getManagedTabs())["7"], undefined);
  });
});

describe("playback evidence", () => {
  it("records forward progress as verified playback", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer" }],
      storage: { managedTabs: { "1": managed(1, { lastCurrentTime: 100, lastVerifiedAt: 0 }) } },
    });

    await handlePlayerHealth(1, { playing: true, currentTime: 105, muted: false, channel: "streamer" });
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.health, HEALTH.MEDIA_PLAYING);
    assert.ok(entry.lastVerifiedAt > 0);
  });

  it("does not count preroll ad playback as stream verification", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer" }],
      storage: { managedTabs: { "1": managed(1, { lastCurrentTime: 0, lastVerifiedAt: 0 }) } },
    });

    await handlePlayerHealth(1, {
      playing: true,
      currentTime: 5,
      muted: false,
      channel: "streamer",
      adPlaying: true,
    });
    assert.equal((await getManagedTabs())["1"].lastVerifiedAt, 0);
  });

  it("does not treat a hidden empty probe as the player dying", async () => {
    const advancedAt = NOW() - 1000;
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer" }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            lastAdvanceAt: advancedAt,
            lastVerifiedAt: advancedAt,
            mediaPlaying: true,
            lastCurrentTime: 80,
          }),
        },
      },
    });

    await handlePlayerHealth(1, { hidden: true, hasVideo: false, playing: false, currentTime: null });
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.mediaPlaying, true, "a hidden lurk tab was marked not playing");
    assert.equal(entry.lastAdvanceAt, advancedAt, "the last-advance clock was wiped");
    assert.ok(entry.backgroundUnverifiableAt > 0);
  });

  it("does not recover or reload a responsive hidden tab with no video", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            lastAdvanceAt: NOW() - HEALTH_TIMING.stallMs - 1000,
            recoveryAttempts: 0,
          }),
        },
      },
    });
    mock.setContentScript(1, () => ({
      hidden: true,
      hasVideo: false,
      playing: false,
      currentTime: null,
    }));

    await runHealthCheck();
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.health, HEALTH.DEGRADED);
    assert.equal(entry.recoveryAttempts, 0);
    assert.equal(entry.recoveryStage || "", "");
  });

  it("counts a backwards jump as progress, because Twitch resets the buffer", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer" }],
      storage: { managedTabs: { "1": managed(1, { lastCurrentTime: 500, lastAdvanceAt: 0 }) } },
    });
    await handlePlayerHealth(1, { playing: true, currentTime: 4, channel: "streamer" });
    assert.ok((await getManagedTabs())["1"].lastAdvanceAt > 0);
  });

  it("does not treat a frozen clock as progress", async () => {
    const frozenAt = NOW() - 50_000;
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer" }],
      storage: {
        managedTabs: { "1": managed(1, { lastCurrentTime: 100, lastAdvanceAt: frozenAt }) },
      },
    });
    await handlePlayerHealth(1, { playing: true, currentTime: 100, channel: "streamer" });
    assert.equal((await getManagedTabs())["1"].lastAdvanceAt, frozenAt);
  });

  it("does not verify a playing event before the media clock actually moves", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer" }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            health: HEALTH.BOOTING,
            lastCurrentTime: null,
            lastVerifiedAt: 0,
            lastAdvanceAt: 0,
          }),
        },
      },
    });

    await handlePlayerHealth(1, { playing: true, currentTime: 0, channel: "streamer" });
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.lastVerifiedAt, 0);
    assert.equal(entry.health, HEALTH.BOOTING);
  });

  it("clears evidence and restores the boot grace on a page reload", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer" }],
      storage: { managedTabs: { "1": managed(1) } },
    });
    await resetHealth(1);
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.lastVerifiedAt, 0);
    assert.equal(entry.mediaPlaying, false);
    assert.equal(entry.observedChannel, "");
  });
});

describe("health check", () => {
  it("does not recover a slow startup before boot grace expires", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            health: HEALTH.BOOTING,
            openedAt: NOW(),
            lastVerifiedAt: 0,
            recoveryAttempts: 0,
          }),
        },
      },
    });

    await handleBootWatchAlarm(1);
    assert.equal((await getManagedTabs())["1"].recoveryAttempts, 0);
  });

  it("leaves a healthy stream alone", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: { managedTabs: { "1": managed(1) }, settings: { muteTabs: true } },
    });
    mock.setContentScript(1, () => ({
      playing: true,
      currentTime: 200,
      muted: false,
      channel: "streamer",
    }));

    await runHealthCheck();
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.health, HEALTH.MEDIA_PLAYING);
    assert.equal(entry.recoveryAttempts, 0);
  });

  it("nudges the page first when playback froze", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            lastAdvanceAt: NOW() - HEALTH_TIMING.stallMs - 1000,
            mediaPlaying: true,
          }),
        },
      },
    });

    let nudged = false;
    mock.setContentScript(1, (message) => {
      if (message.type === "RECOVER_PLAYER") {
        nudged = true;
        return { accepted: true };
      }
      return { playing: true, currentTime: 100, muted: false, channel: "streamer" };
    });

    await runHealthCheck();
    assert.ok(nudged, "the first recovery step should ask the page to restart");
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.recoveryStage, RECOVERY_STAGE.NUDGE);
    assert.equal(entry.recoveryAttempts, 1);
  });

  it("does not reload in the same pass when the page cannot answer", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: {
        managedTabs: {
          "1": managed(1, { lastHeartbeatAt: NOW() - HEALTH_TIMING.heartbeatTimeoutMs - 1000 }),
        },
      },
    });
    // No content script registered: sendMessage rejects, like a dead page.

    await runHealthCheck();
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.recoveryStage, RECOVERY_STAGE.NUDGE);
    assert.equal(entry.recoveryAttempts, 1);
  });

  it("never navigates a tab from an automatic recovery pass", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            lastHeartbeatAt: NOW() - HEALTH_TIMING.heartbeatTimeoutMs - 1000,
            recoveryAttempts: 1,
            lastRecoveryAt: 0,
          }),
        },
      },
    });
    let reloads = 0;
    const realReload = mock.chrome.tabs.reload;
    mock.chrome.tabs.reload = (...args) => {
      reloads += 1;
      return realReload(...args);
    };
    try {
      await runHealthCheck();
    } finally {
      mock.chrome.tabs.reload = realReload;
    }

    assert.equal(reloads, 0);
    assert.equal((await getManagedTabs())["1"].health, HEALTH.FAILED);
  });

  it("allows a reload after the user explicitly presses Retry", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: { managedTabs: { "1": managed(1, { health: HEALTH.FAILED }) } },
    });
    mock.setContentScript(1, () => ({
      hasVideo: true,
      hidden: false,
      playing: true,
      currentTime: 120,
      channel: "streamer",
    }));
    let reloads = 0;
    const realReload = mock.chrome.tabs.reload;
    mock.chrome.tabs.reload = (...args) => {
      reloads += 1;
      return realReload(...args);
    };
    try {
      await requestRecovery(1);
    } finally {
      mock.chrome.tabs.reload = realReload;
    }

    assert.equal(reloads, 1);
  });

  it("never reloads the tab the user is looking at", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: true, windowId: 1 }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            lastHeartbeatAt: NOW() - HEALTH_TIMING.heartbeatTimeoutMs - 1000,
            recoveryAttempts: 2,
          }),
        },
      },
    });

    await runHealthCheck();
    const entry = (await getManagedTabs())["1"];
    assert.notOk(
      [RECOVERY_STAGE.RELOAD, RECOVERY_STAGE.REOPEN].includes(entry.recoveryStage),
      "a focused tab must only ever be nudged"
    );
  });

  it("gives up rather than looping once every step has been tried", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            lastHeartbeatAt: NOW() - HEALTH_TIMING.heartbeatTimeoutMs - 1000,
            recoveryAttempts: 3,
          }),
        },
      },
    });

    await runHealthCheck();
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.health, HEALTH.FAILED);
    assert.ok(entry.failedAt > 0);
  });

  it("does not periodically re-arm a failed stream", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false }],
      storage: {
        managedTabs: {
          "1": managed(1, {
            health: HEALTH.FAILED,
            failedAt: NOW() - 24 * 60 * 60_000,
            recoveryAttempts: 3,
            recoveryStage: RECOVERY_STAGE.GIVE_UP,
          }),
        },
      },
    });

    await runHealthCheck();
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.health, HEALTH.FAILED);
    assert.equal(entry.recoveryAttempts, 3);
    assert.equal(entry.recoveryStage, RECOVERY_STAGE.GIVE_UP);
  });

  it("repairs a tab mute the reload dropped", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false, mutedInfo: { muted: false } }],
      storage: { managedTabs: { "1": managed(1) }, settings: { muteTabs: true } },
    });
    mock.setContentScript(1, () => ({ playing: true, currentTime: 300, muted: false, channel: "streamer" }));

    await runHealthCheck();
    assert.equal(mock.tabState.get(1).mutedInfo.muted, true);
  });

  it("leaves the tab audible when the user unmuted it themselves", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", active: false, mutedInfo: { muted: false } }],
      storage: {
        managedTabs: { "1": managed(1, { userUnmuted: true }) },
        settings: { muteTabs: true },
      },
    });
    mock.setContentScript(1, () => ({ playing: true, currentTime: 300, muted: false, channel: "streamer" }));

    await runHealthCheck();
    assert.equal(mock.tabState.get(1).mutedInfo.muted, false);
  });
});

describe("duplicate open protection", () => {
  it("creates one tab even when several callers race", async () => {
    mock.reset({ storage: { managedTabs: {}, settings: { groupTabs: false, muteTabs: true } } });

    const channel = { userId: "42", login: "streamer", displayName: "Streamer" };
    const results = await Promise.all([
      openManagedStream(channel, { streamId: "a" }),
      openManagedStream(channel, { streamId: "a" }),
      openManagedStream(channel, { streamId: "a" }),
    ]);

    const managedTabs = await getManagedTabs();
    assert.equal(Object.keys(managedTabs).length, 1);
    assert.equal(new Set(results.map((entry) => entry.tabId)).size, 1);
  });

  it("adopts a tab that is already open instead of creating another", async () => {
    mock.reset({
      tabs: [{ id: 7, url: "https://www.twitch.tv/streamer", active: false }],
      storage: { managedTabs: {}, settings: { groupTabs: false, muteTabs: true } },
    });

    const entry = await openManagedStream(
      { userId: "42", login: "streamer", displayName: "Streamer" },
      { streamId: "live-1", isLive: true }
    );

    assert.equal(entry.tabId, 7);
    assert.equal(entry.adopted, true);
    assert.equal(
      [...mock.tabState.values()].filter((tab) => String(tab.url || "").includes("twitch.tv")).length,
      1,
      "an already-open stream was opened again"
    );
  });

  it("does not open a second tab when the same login is already managed", async () => {
    mock.reset({
      tabs: [{ id: 3, url: "https://www.twitch.tv/streamer", active: false }],
      storage: {
        managedTabs: { "3": managed(3, { userId: "99", login: "streamer", expectedChannel: "streamer" }) },
        settings: { groupTabs: false, muteTabs: true },
      },
    });

    const entry = await openManagedStream(
      { userId: "42", login: "streamer", displayName: "Streamer" },
      { streamId: "live-1", isLive: true }
    );

    assert.equal(entry.tabId, 3);
    assert.equal(
      [...mock.tabState.values()].filter((tab) => String(tab.url || "").includes("twitch.tv")).length,
      1
    );
  });

  it("serializes different user ids that resolve to the same login", async () => {
    mock.reset({ storage: { managedTabs: {}, settings: { groupTabs: false, muteTabs: true } } });

    const results = await Promise.all([
      openManagedStream(
        { userId: "old-id", login: "streamer", displayName: "Streamer" },
        { streamId: "live-1" }
      ),
      openManagedStream(
        { userId: "new-id", login: "streamer", displayName: "Streamer" },
        { streamId: "live-1" }
      ),
    ]);

    assert.equal(new Set(results.map((entry) => entry.tabId)).size, 1);
    assert.equal(
      [...mock.tabState.values()].filter((tab) => String(tab.url || "").includes("twitch.tv")).length,
      1,
      "two queued requests passed duplicate detection before either created its tab"
    );
  });

  it("does not create a temporary window for automatic startup", async () => {
    mock.reset({ storage: { managedTabs: {}, settings: { groupTabs: false, muteTabs: true } } });
    const realCreate = mock.chrome.windows.create;
    let windowsCreated = 0;
    mock.chrome.windows.create = async (props) => {
      windowsCreated += 1;
      return realCreate(props);
    };
    try {
      await openManagedStream(
        { userId: "42", login: "streamer", displayName: "Streamer" },
        { streamId: "live-1" }
      );
    } finally {
      mock.chrome.windows.create = realCreate;
    }

    assert.equal(
      [...mock.tabState.values()].filter((tab) => String(tab.url || "").includes("twitch.tv")).length,
      1,
      "automatic startup created an extra Twitch tab"
    );
    assert.equal(windowsCreated, 0, "automatic startup created a temporary window");
  });

  it("removes duplicate managed tabs during reconciliation", async () => {
    mock.reset({
      tabs: [
        { id: 3, url: "https://www.twitch.tv/streamer", active: false },
        { id: 4, url: "https://www.twitch.tv/streamer#autolurk", active: false },
      ],
      storage: {
        managedTabs: {
          "3": managed(3, { userId: "42", login: "streamer", expectedChannel: "streamer" }),
          "4": managed(4, { userId: "42", login: "streamer", expectedChannel: "streamer" }),
        },
        settings: { groupTabs: false, muteTabs: true },
      },
    });

    await reconcileManagedTabs();

    assert.equal(
      [...mock.tabState.values()].filter((tab) => String(tab.url || "").includes("twitch.tv")).length,
      1
    );
    assert.equal(Object.keys(await getManagedTabs()).length, 1);
  });

  it("drops a stale managed id without touching the unrelated reused tab", async () => {
    mock.reset({
      tabs: [{ id: 3, url: "https://example.com", active: true }],
      storage: {
        managedTabs: {
          "3": managed(3, {
            userId: "42",
            login: "streamer",
            expectedChannel: "streamer",
            openedAt: Date.now() - 60_000,
          }),
        },
        settings: { groupTabs: false, muteTabs: true },
      },
    });

    await reconcileManagedTabs();

    assert.ok(mock.tabState.has(3), "the unrelated tab was closed");
    assert.deepEqual(await getManagedTabs(), {});
  });

  it("rehomes an orphaned staging tab after a worker restart", async () => {
    mock.reset({
      tabs: [
        { id: 1, windowId: 1, url: "https://example.com", active: true },
        {
          id: 2,
          windowId: 2,
          url: "https://www.twitch.tv/streamer#autolurk",
          active: true,
        },
      ],
      storage: {
        managedTabs: { "2": managed(2) },
        settings: { groupTabs: false, muteTabs: true },
      },
    });
    mock.session.stagingWindows = [2];

    await reconcileManagedTabs();
    assert.equal(mock.tabState.get(2).windowId, 1);
    assert.deepEqual(mock.session.stagingWindows, []);
  });
});

describe("tabs synced inside AutoLurk groups", () => {
  it("adopts live tabs and closes authoritatively offline tabs", async () => {
    mock.reset({
      tabs: [
        { id: 1, url: "https://www.twitch.tv/offline", active: false },
        { id: 2, url: "https://www.twitch.tv/live", active: false },
      ],
      storage: {
        managedTabs: {},
        settings: { groupTabs: false, muteTabs: true, autoCloseOffline: true },
      },
    });

    await reconcileGroupedStreams(
      [
        {
          tab: { tabId: 1, login: "offline" },
          channel: { userId: "1", login: "offline", displayName: "Offline" },
        },
        {
          tab: { tabId: 2, login: "live" },
          channel: { userId: "2", login: "live", displayName: "Live" },
        },
      ],
      {
        "2": {
          userId: "2",
          login: "live",
          displayName: "Live",
          streamId: "stream-2",
          isLive: true,
          stale: false,
        },
      },
      {},
      { autoCloseOffline: true }
    );

    assert.notOk(mock.tabState.has(1), "the offline synced tab stayed open");
    assert.ok(mock.tabState.has(2), "the live synced tab was closed");
    assert.equal((await getManagedTabs())["2"].userId, "2");
  });

  it("closes a synced live tab instead of overriding a snooze", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/snoozed", active: false }],
      storage: { managedTabs: {} },
    });

    await reconcileGroupedStreams(
      [{
        tab: { tabId: 1, login: "snoozed" },
        channel: { userId: "1", login: "snoozed", displayName: "Snoozed" },
      }],
      {
        "1": {
          userId: "1",
          login: "snoozed",
          streamId: "stream-1",
          isLive: true,
          stale: false,
        },
      },
      {
        "1": {
          userId: "1",
          login: "snoozed",
          snoozeUntilNextStream: true,
          snoozedStreamId: "stream-1",
        },
      },
      { autoCloseOffline: true }
    );

    assert.notOk(mock.tabState.has(1));
    assert.deepEqual(await getManagedTabs(), {});
  });

  it("only reconciles grouped channels covered by a partial poll", async () => {
    mock.reset({
      tabs: [
        { id: 1, url: "https://www.twitch.tv/covered", active: false },
        { id: 2, url: "https://www.twitch.tv/unknown", active: false },
      ],
      storage: { managedTabs: {} },
    });
    const items = [
      {
        tab: { tabId: 1, login: "covered" },
        channel: { userId: "1", login: "covered", displayName: "Covered" },
      },
      {
        tab: { tabId: 2, login: "unknown" },
        channel: { userId: "2", login: "unknown", displayName: "Unknown" },
      },
    ];

    await reconcileGroupedStreams(items, {}, {}, { autoCloseOffline: true }, {
      covered: new Set(["1"]),
    });

    assert.notOk(mock.tabState.has(1));
    assert.ok(mock.tabState.has(2), "an uncovered channel was treated as offline");
  });

  it("applies a remotely synced unfavorite without requiring Twitch auth", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/removed", active: false }],
      storage: {
        favorites: {},
        follows: { "1": { userId: "1", login: "removed" } },
        managedTabs: {
          "1": { tabId: 1, userId: "1", login: "removed", openedAt: Date.now() },
        },
        meta: { removedFavorites: { "1": Date.now() } },
      },
    });

    await enforceSyncedFavoriteIntent();

    assert.notOk(mock.tabState.has(1));
    assert.deepEqual(await getManagedTabs(), {});
  });
});
