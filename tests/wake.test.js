// Coming back from sleep is the one situation where nearly every assumption
// the rest of the extension makes is false at once: every timestamp is hours
// stale, every player is dead, and most of the broadcasts have ended. These
// cover the order things have to happen in, because getting it wrong is what
// left tabs open for streams that finished overnight.
import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";

const mock = chromeMock();

const { detectWakeGap, describeGap, WAKE_GAP_MS } = await import("../background/wake.js");
const { BOOTSTRAP_TIMING } = await import("../background/tab-manager.js");
const { handleBootWatchAlarm } = await import("../background/stream-boot.js");

describe("detecting a sleep", () => {
  it("ignores the ordinary minute between health checks", () => {
    const at = 1_000_000_000;
    assert.equal(detectWakeGap(at - 60_000, at), 0);
  });

  it("ignores an alarm that merely ran late", () => {
    // MV3 alarms are routinely a couple of minutes behind under load, and
    // treating that as a wake would close tabs on a healthy machine.
    const at = 1_000_000_000;
    assert.equal(detectWakeGap(at - 3 * 60_000, at), 0);
  });

  it("reports the gap when the machine was away for hours", () => {
    const at = 1_000_000_000;
    const gap = detectWakeGap(at - 4 * 60 * 60_000, at);
    assert.equal(gap, 4 * 60 * 60_000);
  });

  it("treats the very first tick as normal rather than as a wake", () => {
    // On a fresh install there is nothing to compare against, and claiming a
    // wake would run recovery against tabs that were only just opened.
    assert.equal(detectWakeGap(0, Date.now()), 0);
  });

  it("counts a gap exactly on the threshold", () => {
    const at = 1_000_000_000;
    assert.equal(detectWakeGap(at - WAKE_GAP_MS, at), WAKE_GAP_MS);
  });

  it("describes a gap the way a person would say it", () => {
    assert.equal(describeGap(60_000), "1 minute");
    assert.equal(describeGap(25 * 60_000), "25 minutes");
    assert.equal(describeGap(3 * 60 * 60_000), "3 hours");
  });
});

// Recovery shows a tab and waits for playback. Left at its real value this
// file would spend half a minute per stream waiting for a mock to answer.
BOOTSTRAP_TIMING.visibleMs = 40;
BOOTSTRAP_TIMING.pollMs = 5;

describe("waking with streams still open", () => {
  const base = {
    settings: {
      automationEnabled: true,
      autoOpenFavorites: false,
      autoCloseOffline: true,
      offlineGraceSeconds: 45,
      groupTabs: false,
      muteTabs: true,
      syncEnabled: false,
    },
    // Far enough out that nothing tries to refresh it mid-test.
    auth: { accessToken: "token", userId: "self", expiresAt: Date.now() + 60 * 60_000 },
    favorites: {
      "1": { userId: "1", login: "one", autoOpen: true, autoClose: true },
      "2": { userId: "2", login: "two", autoOpen: true, autoClose: true },
    },
    follows: {
      "1": { userId: "1", login: "one", displayName: "One" },
      "2": { userId: "2", login: "two", displayName: "Two" },
    },
  };

  // Two managed tabs, both playing when the machine went to sleep hours ago.
  function sleepingProfile(hoursAgo = 4) {
    const slept = Date.now() - hoursAgo * 60 * 60_000;
    return {
      ...base,
      liveState: {
        "1": { userId: "1", login: "one", streamId: "s1", isLive: true, observedAt: slept },
        "2": { userId: "2", login: "two", streamId: "s2", isLive: true, observedAt: slept },
      },
      managedTabs: {
        "11": {
          tabId: 11,
          userId: "1",
          login: "one",
          displayName: "One",
          expectedChannel: "one",
          streamId: "s1",
          health: "media_playing",
          openedAt: slept,
          lastHeartbeatAt: slept,
          lastAdvanceAt: slept,
          lastVerifiedAt: slept,
          mediaPlaying: true,
        },
        "12": {
          tabId: 12,
          userId: "2",
          login: "two",
          displayName: "Two",
          expectedChannel: "two",
          streamId: "s2",
          health: "media_playing",
          openedAt: slept,
          lastHeartbeatAt: slept,
          lastAdvanceAt: slept,
          lastVerifiedAt: slept,
          mediaPlaying: true,
        },
      },
      meta: { schemaVersion: 3, lastPollAt: slept, lastSuccessfulPollAt: slept },
    };
  }

  const sleepingTabs = [
    { id: 11, url: "https://www.twitch.tv/one#autolurk", windowId: 1 },
    { id: 12, url: "https://www.twitch.tv/two#autolurk", windowId: 1 },
  ];

  // Only "one" is still on air; "two" ended while the machine was asleep.
  function onlyOneStillLive() {
    globalThis.fetch = async (url) => {
      const target = String(url);
      const streams = target.includes("user_id=1")
        ? [{ id: "s1", user_id: "1", user_login: "one", user_name: "One", type: "live" }]
        : [];
      if (target.includes("/streams")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: target.includes("user_id=2") && !target.includes("user_id=1") ? [] : streams,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [], pagination: {} }) };
    };
  }

  it("closes the stream that ended without waiting out the offline grace", async () => {
    mock.reset({ tabs: sleepingTabs, storage: sleepingProfile() });
    onlyOneStillLive();

    const { runWakeRecovery } = await import("../background/wake.js");
    await runWakeRecovery(4 * 60 * 60_000);

    const managed = mock.local.managedTabs || {};
    assert.equal(managed["12"], undefined, "the ended stream should have been closed");
    assert.ok(managed["11"], "the stream still on air should have been kept");
    assert.equal(mock.tabState.has(12), false, "its tab should be gone too");
  });

  it("starts recovering the surviving stream immediately, not in 45 seconds", async () => {
    // The cool-off between recovery attempts would otherwise be measured from
    // the last attempt before the machine slept, which is hours ago and would
    // read as "still settling".
    mock.reset({ tabs: sleepingTabs, storage: sleepingProfile() });
    onlyOneStillLive();

    const { runWakeRecovery } = await import("../background/wake.js");
    await runWakeRecovery(4 * 60 * 60_000);

    const entry = (mock.local.managedTabs || {})["11"];
    assert.ok(entry, "survivor missing");
    assert.ok(entry.health !== "suspended", "it should not be left frozen");
    assert.ok(entry.recoveryAttempts >= 1, "recovery should already be under way");
  });

  it("leaves every tab alone when the network is not back yet", async () => {
    // Wi-Fi reconnects after the browser resumes, so the first poll on wake
    // often fails. Closing tabs on a poll that could not run would throw away
    // streams that are perfectly fine.
    mock.reset({ tabs: sleepingTabs, storage: sleepingProfile() });
    globalThis.fetch = async () => {
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    };

    const { runWakeRecovery } = await import("../background/wake.js");
    const result = await runWakeRecovery(4 * 60 * 60_000);

    assert.equal(result.deferred, true);
    assert.equal(Object.keys(mock.local.managedTabs || {}).length, 2, "no tab should be closed");
    assert.equal(mock.tabState.has(11), true);
    assert.equal(mock.tabState.has(12), true);
  });

  it("keeps the tabs frozen until a poll finally succeeds", async () => {
    mock.reset({ tabs: sleepingTabs, storage: sleepingProfile() });
    globalThis.fetch = async () => {
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    };

    const { runWakeRecovery, handleHealthTick } = await import("../background/wake.js");
    await runWakeRecovery(4 * 60 * 60_000);
    assert.equal((mock.local.meta || {}).wakeRecheckPending, true);

    // A minute later, still nothing. The gap is now small, so this is not a
    // fresh wake — the pending flag is what has to bring it back here.
    await handleHealthTick();
    assert.equal((mock.local.meta || {}).wakeRecheckPending, true);
    assert.equal(Object.keys(mock.local.managedTabs || {}).length, 2);

    // Network back.
    onlyOneStillLive();
    await handleHealthTick();

    assert.equal((mock.local.meta || {}).wakeRecheckPending, false);
    assert.equal(mock.local.managedTabs["12"], undefined, "the ended stream should close now");
  });

  it("freezes the tabs so a parallel health check cannot restart dead streams", async () => {
    // The freeze is the whole reason a wake is handled separately: without it
    // the health check reads all these stale timestamps as stalled streams and
    // starts restarting broadcasts that ended hours ago.
    mock.reset({ tabs: sleepingTabs, storage: sleepingProfile() });

    const { evaluateHealth, HEALTH } = await import("../shared/health.js");
    const frozen = {
      ...sleepingProfile().managedTabs["11"],
      health: HEALTH.SUSPENDED,
      healthReason: "machine was asleep",
    };

    const { state } = evaluateHealth(frozen, { discarded: false }, Date.now());
    assert.equal(state, HEALTH.SUSPENDED);
  });

  it("does not let a per-tab boot alarm bypass the wake freeze", async () => {
    const profile = sleepingProfile();
    profile.managedTabs["11"].health = "suspended";
    mock.reset({ tabs: sleepingTabs, storage: profile });

    let probed = false;
    mock.setContentScript(11, () => {
      probed = true;
      return { playing: false };
    });

    const entry = await handleBootWatchAlarm(11);
    assert.equal(entry.health, "suspended");
    assert.notOk(probed, "boot watch restarted a tab before the wake poll");
  });

  // The freeze belongs to the wake coordinator, but it is not the only thing
  // that polls. The minute alarm, a manual refresh and a sync pull all call
  // straight into the same poll, and any of them acting on the answer is the
  // tab churn the freeze exists to prevent.
  function frozenProfile() {
    const profile = sleepingProfile();
    profile.meta.wakeRecheckPending = true;
    profile.meta.lastWakeGapMs = 4 * 60 * 60_000;
    for (const entry of Object.values(profile.managedTabs)) entry.health = "suspended";
    return profile;
  }

  it("does not close an ended stream from an ordinary poll while frozen", async () => {
    mock.reset({ tabs: sleepingTabs, storage: frozenProfile() });
    onlyOneStillLive();

    const { pollLiveState } = await import("../background/stream-manager.js");
    const result = await pollLiveState();

    assert.equal(result.deferred, true);
    assert.equal(mock.tabState.has(12), true, "a frozen poll closed a tab");
    assert.equal(Object.keys(mock.local.managedTabs || {}).length, 2);
    assert.equal((mock.local.meta || {}).wakeRecheckPending, true, "the freeze was lifted early");
  });

  it("does not let a manual refresh bypass the freeze either", async () => {
    mock.reset({ tabs: sleepingTabs, storage: frozenProfile() });
    onlyOneStillLive();

    const { pollLiveState } = await import("../background/stream-manager.js");
    const result = await pollLiveState({ force: true });

    assert.equal(result.deferred, true);
    assert.equal(mock.tabState.has(12), true);
  });

  it("does not open a live favorite while frozen", async () => {
    const profile = frozenProfile();
    profile.settings = { ...profile.settings, autoOpenFavorites: true };
    delete profile.managedTabs["11"];
    mock.reset({
      tabs: [{ id: 12, url: "https://www.twitch.tv/two#autolurk", windowId: 1 }],
      storage: profile,
    });
    onlyOneStillLive();

    const { pollLiveState } = await import("../background/stream-manager.js");
    await pollLiveState();

    assert.equal(
      [...mock.tabState.values()].filter((tab) => String(tab.url || "").includes("twitch.tv")).length,
      1,
      "a frozen poll opened a stream"
    );
  });

  it("still refreshes what it learned while frozen", async () => {
    // Deferring the tab work is not a reason to throw the answer away; the UI
    // should still show that the second stream ended.
    mock.reset({ tabs: sleepingTabs, storage: frozenProfile() });
    onlyOneStillLive();

    const { pollLiveState } = await import("../background/stream-manager.js");
    await pollLiveState();

    assert.equal((mock.local.liveState || {})["2"], undefined, "stale live row survived");
    assert.ok((mock.local.meta || {}).lastSuccessfulPollAt > 0);
  });

  it("still checks for newly live favorites when nothing was open", async () => {
    const profile = sleepingProfile();
    profile.managedTabs = {};
    mock.reset({ tabs: [], storage: profile });
    onlyOneStillLive();

    const { runWakeRecovery } = await import("../background/wake.js");
    const result = await runWakeRecovery(4 * 60 * 60_000);

    assert.equal(result.closed, 0);
    assert.ok((mock.local.meta || {}).lastPollAt > 0, "a wake should still refresh the live list");
  });
});
