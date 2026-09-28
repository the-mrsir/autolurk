import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";

const mock = chromeMock();

const { nextServerTarget, serverReportWorking } = await import("../shared/server-logic.js");
const { rotateServerStreams } = await import("../background/server-rotation.js");

function entry(tabId, login) {
  return {
    tabId,
    userId: String(tabId),
    login,
    displayName: login,
    expectedChannel: login,
    openedAt: Date.now(),
  };
}

function tab(id, login) {
  return {
    id,
    windowId: 1,
    active: false,
    status: "complete",
    url: `https://www.twitch.tv/${login}`,
  };
}

describe("server rotation order", () => {
  it("opens the next stream and wraps after the last", () => {
    const streams = [entry(5, "b"), entry(2, "a")];
    assert.equal(nextServerTarget(streams, null).tabId, 2);
    assert.equal(nextServerTarget(streams, 2).tabId, 5);
    assert.equal(nextServerTarget(streams, 5).tabId, 2);
  });

  it("ignores a tab that is not a channel", () => {
    const streams = [{ tabId: 1 }, entry(4, "a")];
    assert.equal(nextServerTarget(streams, 4).tabId, 4);
  });

  it("has nothing to open when no streams are managed", () => {
    assert.equal(nextServerTarget([], 1), null);
  });
});

describe("whether a probe counts as playing", () => {
  it("accepts a visible player that has started", () => {
    assert.equal(serverReportWorking({ playing: true, currentTime: 4, hasVideo: true }), true);
  });

  it("accepts a preroll that is actually playing", () => {
    assert.equal(
      serverReportWorking({ playing: true, adPlaying: true, currentTime: 0, hasVideo: true }),
      true
    );
  });

  it("rejects a hidden page, a missing player, and a player sitting at zero", () => {
    assert.equal(serverReportWorking({ playing: true, currentTime: 4, hidden: true }), false);
    assert.equal(serverReportWorking({ playing: true, currentTime: 4, hasVideo: false }), false);
    assert.equal(serverReportWorking({ playing: true, currentTime: 0, hasVideo: true }), false);
    assert.equal(serverReportWorking(null), false);
  });
});

describe("opening the next stream", () => {
  const fast = { confirmMs: 0, reloadConfirmMs: 0 };

  function install(reports) {
    for (const [id, queue] of Object.entries(reports)) {
      const pending = [...queue];
      mock.setContentScript(Number(id), (message) => {
        if (message.type !== "PROBE_PLAYER") return { ok: true };
        return pending.length > 1 ? pending.shift() : pending[0];
      });
    }
  }

  it("does nothing until the option is on", async () => {
    mock.reset({
      tabs: [tab(2, "alpha")],
      storage: {
        settings: { serverRotation: false, automationEnabled: true },
        managedTabs: { 2: entry(2, "alpha") },
      },
    });
    assert.equal(await rotateServerStreams(fast), null);
    assert.equal((await mock.chrome.tabs.get(2)).active, false);
  });

  it("waits out a wake recheck", async () => {
    mock.reset({
      tabs: [tab(2, "alpha")],
      storage: {
        settings: { serverRotation: true, automationEnabled: true },
        managedTabs: { 2: entry(2, "alpha") },
        meta: { wakeRecheckPending: true },
      },
    });
    assert.equal(await rotateServerStreams(fast), null);
  });

  it("brings the next stream forward when it is already playing", async () => {
    mock.reset({
      tabs: [tab(2, "alpha"), tab(5, "beta")],
      storage: {
        settings: { serverRotation: true, automationEnabled: true, muteTabs: true },
        managedTabs: { 2: entry(2, "alpha"), 5: entry(5, "beta") },
      },
    });
    install({
      2: [{ playing: true, currentTime: 12, hasVideo: true, hidden: false }],
      5: [{ playing: true, currentTime: 8, hasVideo: true, hidden: false }],
    });

    const first = await rotateServerStreams(fast);
    assert.equal(first.tabId, 2);
    assert.equal(first.playing, true);
    assert.equal(first.reloaded, false);
    assert.equal((await mock.chrome.tabs.get(2)).active, true);

    const second = await rotateServerStreams(fast);
    assert.equal(second.tabId, 5);
    assert.equal((await mock.chrome.tabs.get(5)).active, true);
  });

  it("reloads a visible stream that is not playing and checks it again", async () => {
    mock.reset({
      tabs: [tab(2, "alpha")],
      storage: {
        settings: { serverRotation: true, automationEnabled: true, muteTabs: true },
        managedTabs: { 2: entry(2, "alpha") },
      },
    });
    install({
      2: [
        { playing: false, currentTime: 0, hasVideo: true, hidden: false },
        { playing: true, currentTime: 3, hasVideo: true, hidden: false },
      ],
    });
    let reloads = 0;
    const realReload = mock.chrome.tabs.reload;
    mock.chrome.tabs.reload = (id) => {
      reloads += 1;
      return realReload(id);
    };
    try {
      const result = await rotateServerStreams(fast);
      assert.equal(result.reloaded, true);
      assert.equal(result.playing, true);
      assert.equal(reloads, 1);
    } finally {
      mock.chrome.tabs.reload = realReload;
    }
  });

  it("does not reload a stream it could not show", async () => {
    mock.reset({
      tabs: [tab(2, "alpha")],
      storage: {
        settings: { serverRotation: true, automationEnabled: true, muteTabs: true },
        managedTabs: { 2: entry(2, "alpha") },
      },
    });
    install({
      2: [{ playing: false, currentTime: 0, hasVideo: true, hidden: true }],
    });
    let reloads = 0;
    const realReload = mock.chrome.tabs.reload;
    mock.chrome.tabs.reload = (id) => {
      reloads += 1;
      return realReload(id);
    };
    try {
      const result = await rotateServerStreams(fast);
      assert.equal(result.reloaded, false);
      assert.equal(result.playing, false);
      assert.equal(reloads, 0);
    } finally {
      mock.chrome.tabs.reload = realReload;
    }
  });
});
