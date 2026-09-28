import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";

// Regression cover for the failure that made the extension unusable: Chrome
// throttles setTimeout in a hidden tab to once a second, and to once a minute
// after five minutes hidden. Every tab AutoLurk opens is hidden from birth, so
// the timer-driven boot sequence got one iteration where it expected twelve,
// reported the player dead, and drove an endless reload loop that exhausted
// memory. None of the existing suite could see it, because the Chrome mock has
// no throttling and no real page.
//
// These tests encode the rules that keep it from coming back.

const mock = chromeMock();

const { HEALTH } = await import("../shared/health.js");
const { getManagedTabs } = await import("../shared/storage.js");
const { handleDiscardedTab, runHealthCheck } = await import("../background/stream-boot.js");
const { BOOTSTRAP_TIMING, openManagedStream } = await import("../background/tab-manager.js");

// Real starts take seconds. Tests must not.
BOOTSTRAP_TIMING.visibleMs = 60;
BOOTSTRAP_TIMING.backgroundMs = 60;
BOOTSTRAP_TIMING.pollMs = 10;

const inBrowser = typeof location !== "undefined";
const root = new URL("../", import.meta.url);

async function readSource(path) {
  const target = new URL(path, root);
  if (inBrowser) {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`Missing file: ${path}`);
    return response.text();
  }
  const { readFile } = await import("node:fs/promises");
  return readFile(target, "utf8");
}

// Comments describe the rule; they should not be scanned for breaking it.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("background tabs cannot rely on timers", () => {
  // The player script runs entirely in tabs that are never visible. It has to
  // be driven by media events and background messages, both of which Chrome
  // delivers immediately regardless of throttling.
  it("drives the player with no timers at all", async () => {
    const source = stripComments(await readSource("content/twitch-player.js"));
    const timers = source.match(/set(Timeout|Interval)\s*\(/g) || [];
    assert.deepEqual(timers, [], "twitch-player.js must contain no timers");
  });

  // The streak query runs on hidden Twitch tabs too. The page fetch has no
  // timer. The bridge has one backstop so a lost reply cannot pin the worker,
  // and that backstop is not a loop.
  it("does not poll or spoof the page to read a watch streak", async () => {
    const gql = stripComments(await readSource("content/twitch-streak-gql.js"));
    const bridge = stripComments(await readSource("content/twitch-streak.js"));
    assert.deepEqual(gql.match(/set(Timeout|Interval)\s*\(/g) || [], []);
    assert.equal((bridge.match(/setTimeout\s*\(/g) || []).length, 1);
    assert.deepEqual(bridge.match(/setInterval\s*\(/g) || [], []);
    for (const source of [gql, bridge]) {
      assert.ok(!source.includes("visibilityState"), "streak script touches visibility");
      assert.ok(!source.includes("defineProperty"), "streak script patches a builtin");
      assert.ok(!source.includes("IntersectionObserver"), "streak script forges intersection");
    }
  });

  // A tick-based scan is fine: throttled to once a minute it still catches a
  // bonus chest that stays on screen for several. A nested deadline is not,
  // because the sleep outlives the deadline and the check never happens.
  it("confirms point claims on the next tick rather than a nested deadline", async () => {
    const source = stripComments(await readSource("content/twitch-points.js"));
    assert.deepEqual(
      source.match(/setTimeout\s*\(/g) || [],
      [],
      "twitch-points.js must not sleep; it rides its scan interval"
    );
    const intervals = source.match(/setInterval\s*\(/g) || [];
    assert.equal(intervals.length, 1, "exactly one scan interval is expected");
  });

  // The old script re-asked eight times every five seconds on every Twitch
  // tab, forever, which kept the service worker permanently awake.
  it("asks whether it is managed exactly once and then waits to be told", async () => {
    const source = stripComments(await readSource("content/twitch-player.js"));
    const asks = source.match(/AM_I_MANAGED/g) || [];
    assert.equal(asks.length, 1, "one AM_I_MANAGED call site, not a retry loop");
    assert.ok(source.includes("MANAGED_NOW"), "registration must be pushed by the background");
  });

  // The script is injected into every Twitch page, but may only touch tabs
  // AutoLurk opened or adopted. Pressing play on a stream the user paused in
  // their own tab is the failure this prevents.
  it("gates every media handler on owning the tab", async () => {
    const source = stripComments(await readSource("content/twitch-player.js"));
    // Handlers are the `on<Event>` functions wired up as document listeners.
    const pattern = /\bfunction (on[A-Z]\w*)\s*\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/g;
    const ungated = [];
    let match;
    while ((match = pattern.exec(source))) {
      const [, name, body] = match;
      if (!body.includes("managedTab")) ungated.push(name);
    }

    assert.ok(ungated.length === 0, `handlers missing an ownership check: ${ungated.join(", ")}`);
    // Guards against the regex silently matching nothing after a refactor.
    assert.ok(source.includes("function onPlayerAppeared"), "handler naming changed");
  });

  it("tells a page it is managed instead of waiting to be asked", async () => {
    mock.reset({ storage: { settings: { muteTabs: true, groupTabs: false } } });

    const told = [];
    let created = null;
    const realCreate = mock.chrome.tabs.create;
    mock.chrome.tabs.create = async (props) => {
      const tab = await realCreate(props);
      created = tab.id;
      mock.setContentScript(tab.id, (message) => {
        told.push(message.type);
        return { ok: true };
      });
      return tab;
    };

    try {
      await openManagedStream(
        { userId: "9", login: "streamer", displayName: "Streamer" },
        { streamId: "s1" }
      );
    } finally {
      mock.chrome.tabs.create = realCreate;
    }

    assert.ok(created, "a tab should have been created");
    assert.includes(told, "MANAGED_NOW");
  });
});

// Managed pages now mask background visibility from Twitch and attempt startup
// in place. Failure is reported; it must never fall back to activating a tab.
describe("starting a stream without covering the user", () => {
  it("creates automatic streams as inactive tabs", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://example.com", active: true }],
      storage: { settings: { muteTabs: true, groupTabs: false } },
    });

    let createdActive = null;
    const realCreate = mock.chrome.tabs.create;
    mock.chrome.tabs.create = async (props) => {
      createdActive = props.active;
      const tab = await realCreate(props);
      mock.setContentScript(tab.id, () => ({
        playing: true,
        currentTime: 4,
        channel: "streamer",
        muted: false,
      }));
      return tab;
    };

    try {
      await openManagedStream({ userId: "9", login: "streamer", displayName: "Streamer" }, {});
    } finally {
      mock.chrome.tabs.create = realCreate;
    }

    assert.equal(createdActive, false, "an automatic stream was allowed to take the foreground");
  });

  it("leaves the user's tab in front while the stream starts off-screen", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://example.com", active: true }],
      storage: { settings: { muteTabs: true, groupTabs: false } },
    });

    const realCreate = mock.chrome.tabs.create;
    mock.chrome.tabs.create = async (props) => {
      const tab = await realCreate(props);
      mock.setContentScript(tab.id, () => ({
        playing: true,
        currentTime: 7,
        channel: "streamer",
        muted: false,
      }));
      return tab;
    };

    try {
      await openManagedStream({ userId: "9", login: "streamer", displayName: "Streamer" }, {});
    } finally {
      mock.chrome.tabs.create = realCreate;
    }

    assert.equal(mock.tabState.get(1).active, true, "the tab the user was on was covered");
  });

  it("still leaves the user's tab in front when the stream never starts", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://example.com", active: true }],
      storage: { settings: { muteTabs: true, groupTabs: false } },
    });

    const realCreate = mock.chrome.tabs.create;
    mock.chrome.tabs.create = async (props) => {
      const tab = await realCreate(props);
      mock.setContentScript(tab.id, () => ({ playing: false, currentTime: 0, channel: "streamer" }));
      return tab;
    };

    let result;
    try {
      result = await openManagedStream(
        { userId: "9", login: "streamer", displayName: "Streamer" },
        {}
      );
    } finally {
      mock.chrome.tabs.create = realCreate;
    }

    assert.equal(mock.tabState.get(1).active, true, "a dead stream took the screen");
    assert.equal(result.bootstrapStarted, false, "a created tab was falsely reported as playing");
    const managed = Object.values(await getManagedTabs()).find((entry) => entry.userId === "9");
    assert.equal(managed.health, HEALTH.FAILED);
  });

  it("never shows two streams at once", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://example.com", active: true }],
      storage: { settings: { muteTabs: true, groupTabs: false } },
    });

    let live = 0;
    let overlapped = false;
    const realCreate = mock.chrome.tabs.create;
    mock.chrome.tabs.create = async (props) => {
      live += 1;
      if (live > 1) overlapped = true;
      const tab = await realCreate(props);
      mock.setContentScript(tab.id, () => {
        live = Math.max(0, live - 1);
        return { playing: true, currentTime: 3, channel: "streamer", muted: false };
      });
      return tab;
    };

    try {
      await Promise.all([
        openManagedStream({ userId: "1", login: "one", displayName: "One" }, {}),
        openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {}),
      ]);
    } finally {
      mock.chrome.tabs.create = realCreate;
    }

    assert.notOk(overlapped, "two streams grabbed the foreground together");
  });
});

describe("saying why playback did not start", () => {
  it("names the reason instead of going quiet", async () => {
    // The symptom that hid this bug for three rounds was an activity log that
    // said "player detected", "starting playback" and then nothing at all.
    const player = stripComments(await readSource("content/twitch-player.js"));
    assert.ok(
      player.includes("Twitch has not loaded the stream"),
      "an element with no media source must be named as such"
    );
    assert.ok(/playback refused \(/.test(player), "a rejected play() must say why");
  });
});

describe("running out of memory", () => {
  function discarded(extra = {}) {
    return {
      tabId: 1,
      userId: "1",
      login: "streamer",
      displayName: "Streamer",
      expectedChannel: "streamer",
      openedAt: Date.now() - 600_000,
      health: HEALTH.MEDIA_PLAYING,
      discardReloads: 0,
      ...extra,
    };
  }

  it("does not automatically reload a discarded tab", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", discarded: true }],
      storage: { managedTabs: { "1": discarded() } },
    });

    let reloaded = 0;
    const realReload = mock.chrome.tabs.reload;
    mock.chrome.tabs.reload = (id) => {
      reloaded += 1;
      return realReload(id);
    };

    try {
      await runHealthCheck();
    } finally {
      mock.chrome.tabs.reload = realReload;
    }

    assert.equal(reloaded, 0);
    assert.equal((await getManagedTabs())["1"].health, HEALTH.FAILED);
    assert.equal(
      mock.tabState.get(1).autoDiscardable,
      true,
      "a failed tab was kept pinned in memory"
    );
  });

  it("does not restart any discarded streams in a background health pass", async () => {
    mock.reset({
      tabs: [
        { id: 1, url: "https://www.twitch.tv/streamer", discarded: true },
        { id: 2, url: "https://www.twitch.tv/another", discarded: true },
      ],
      storage: {
        managedTabs: {
          "1": discarded(),
          "2": discarded({
            tabId: 2,
            userId: "2",
            login: "another",
            expectedChannel: "another",
          }),
        },
      },
    });

    let reloaded = 0;
    const realReload = mock.chrome.tabs.reload;
    mock.chrome.tabs.reload = (id) => {
      reloaded += 1;
      return realReload(id);
    };
    try {
      await runHealthCheck();
    } finally {
      mock.chrome.tabs.reload = realReload;
    }

    assert.equal(reloaded, 0);
    assert.equal((await getManagedTabs())["1"].health, HEALTH.FAILED);
    assert.equal((await getManagedTabs())["2"].health, HEALTH.FAILED);
  });

  // Chrome discards tabs because the machine is short on memory. Reloading in
  // a loop is how AutoLurk turned that into a freeze, so the second discard
  // has to be reported rather than fought.
  it("gives up rather than reloading a tab Chrome discarded twice", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", discarded: true }],
      storage: { managedTabs: { "1": discarded({ discardReloads: 1 }) } },
    });

    let reloaded = 0;
    const realReload = mock.chrome.tabs.reload;
    mock.chrome.tabs.reload = (id) => {
      reloaded += 1;
      return realReload(id);
    };

    try {
      await runHealthCheck();
    } finally {
      mock.chrome.tabs.reload = realReload;
    }

    assert.equal(reloaded, 0, "a second discard must not trigger another reload");
    assert.equal((await getManagedTabs())["1"].health, HEALTH.FAILED);
  });

  it("never probes a discarded tab, because there is no page to answer", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", discarded: true }],
      storage: { managedTabs: { "1": discarded({ discardReloads: 5 }) } },
    });

    let probed = false;
    mock.setContentScript(1, () => {
      probed = true;
      return {};
    });

    await runHealthCheck();
    assert.notOk(probed);
  });

  it("restores the discard budget once playback is verified again", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer" }],
      storage: {
        managedTabs: {
          "1": discarded({
            discardReloads: 1,
            lastVerifiedAt: Date.now() - 5000,
            lastHeartbeatAt: Date.now() - 1000,
            lastAdvanceAt: Date.now() - 1000,
            lastCurrentTime: 100,
            observedChannel: "streamer",
          }),
        },
      },
    });
    mock.setContentScript(1, () => ({
      playing: true,
      currentTime: 250,
      muted: false,
      channel: "streamer",
    }));

    await runHealthCheck();
    const entry = (await getManagedTabs())["1"];
    assert.equal(entry.health, HEALTH.MEDIA_PLAYING);
    assert.equal(entry.discardReloads, 0);
  });
});

describe("recovery pacing", () => {
  // One escalation per health check at most. The old eight second cooldown let
  // a single bad minute walk the ladder from nudge to reopening the tab.
  it("cannot walk the whole ladder inside one minute", async () => {
    const { HEALTH_TIMING } = await import("../shared/health.js");
    assert.ok(
      HEALTH_TIMING.recoveryCooldownMs >= 30_000,
      `cooldown ${HEALTH_TIMING.recoveryCooldownMs}ms is short enough to escalate repeatedly`
    );
    assert.ok(
      HEALTH_TIMING.heartbeatTimeoutMs > 120_000,
      "must survive a late MV3 alarm without declaring the page dead"
    );
  });

  it("marks a twice-discarded tab failed without any tab churn", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/streamer", discarded: true }],
      storage: { managedTabs: { "1": { tabId: 1, userId: "1", login: "s", discardReloads: 1 } } },
    });
    const before = mock.tabState.size;
    await handleDiscardedTab(1, { tabId: 1, userId: "1", login: "s", discardReloads: 1 });
    assert.equal(mock.tabState.size, before, "giving up must not open a replacement tab");
  });
});
