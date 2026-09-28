import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";

const mock = chromeMock();

const {
  getMultistream,
  gridTiles,
  handleMultistreamTabRemoved,
  multistreamSnapshot,
  reconcileMultistream,
  setMultistreamAudio,
  startMultistream,
  stopMultistream,
} = await import("../background/multistream.js");
const { BOOTSTRAP_TIMING, openManagedStream, updateLiveGroup } = await import(
  "../background/tab-manager.js"
);
const { MULTISTREAM } = await import("../shared/constants.js");
const { getManagedTabs } = await import("../shared/storage.js");

BOOTSTRAP_TIMING.visibleMs = 60;
BOOTSTRAP_TIMING.pollMs = 10;

const CHANNELS = [
  { userId: "1", login: "one", displayName: "One" },
  { userId: "2", login: "two", displayName: "Two" },
  { userId: "3", login: "three", displayName: "Three" },
  { userId: "4", login: "four", displayName: "Four" },
  { userId: "5", login: "five", displayName: "Five" },
];

function liveState() {
  const live = {};
  for (const channel of CHANNELS) {
    live[channel.userId] = { ...channel, isLive: true, streamId: `s${channel.userId}` };
  }
  return live;
}

function follows() {
  return Object.fromEntries(CHANNELS.map((channel) => [channel.userId, { ...channel }]));
}

function base(extraTabs = [{ id: 1, url: "https://example.com", active: true }]) {
  return {
    tabs: extraTabs,
    storage: {
      settings: { muteTabs: true, groupTabs: true, collapseGroup: false },
      follows: follows(),
      liveState: liveState(),
    },
  };
}

// Every stream AutoLurk opens has to report playback or bootstrap gives up on
// it, and starting a grid opens a lurk tab for anything not already open.
async function playing(run) {
  const realCreate = mock.chrome.tabs.create;
  mock.chrome.tabs.create = async (props) => {
    const tab = await realCreate(props);
    mock.setContentScript(tab.id, () => ({
      playing: true,
      currentTime: 5,
      muted: false,
      channel: "streamer",
      hidden: false,
    }));
    return tab;
  };
  try {
    return await run();
  } finally {
    mock.chrome.tabs.create = realCreate;
  }
}

async function start(userIds, { tabs } = {}) {
  mock.reset(base(tabs));
  return playing(() => startMultistream(userIds));
}

function gridTab() {
  for (const [id, tab] of mock.tabState) {
    if (String(tab.url || "").includes(MULTISTREAM.GRID_MARKER)) return { id, ...tab };
  }
  return null;
}

function tabFor(login) {
  for (const [id, tab] of mock.tabState) {
    if (String(tab.url || "").includes(`twitch.tv/${login}`)) return { id, ...tab };
  }
  return null;
}

// Everything the grid must not disturb: where each lurk tab lives, which group
// holds it, and whether it is muted.
function lurkTabs() {
  return [...mock.tabState.entries()]
    .filter(([, tab]) => {
      const url = String(tab.url || "");
      return url.includes("twitch.tv") && !url.includes(MULTISTREAM.GRID_MARKER);
    })
    .map(([id, tab]) => ({
      id,
      url: tab.url,
      windowId: tab.windowId,
      groupId: tab.groupId,
      muted: Boolean(tab.mutedInfo?.muted),
    }))
    .sort((a, b) => a.id - b.id);
}

async function openLurkTabs(channels) {
  await playing(async () => {
    for (const channel of channels) {
      await openManagedStream(channel, { streamId: `s${channel.userId}` });
    }
  });
  await updateLiveGroup(await getManagedTabs());
}

describe("multistream grid", () => {
  it("refuses fewer than two and more than four streams", async () => {
    mock.reset(base());
    await assert.rejects(startMultistream(["1"]), "one stream is not a multistream");
    await assert.rejects(startMultistream(["1", "2", "3", "4", "5"]), "five tiles were accepted");
    assert.equal(await getMultistream(), null, "a rejected start must leave no session");
  });

  it("refuses a channel that is not live", async () => {
    mock.reset(base());
    const live = mock.local.liveState;
    mock.local.liveState = { ...live, 2: { ...live["2"], isLive: false } };
    await assert.rejects(startMultistream(["1", "2"]), "an offline channel was put in the grid");
    assert.equal(await getMultistream(), null);
  });

  it("refuses stale live data", async () => {
    mock.reset(base());
    const live = mock.local.liveState;
    mock.local.liveState = { ...live, 2: { ...live["2"], stale: true } };
    await assert.rejects(
      startMultistream(["1", "2"]),
      "a channel not confirmed by the latest poll was put in the grid"
    );
    assert.equal(await getMultistream(), null);
  });

  // The whole point of the rewrite: one tab, in the window the user is already
  // in, rather than one window per stream.
  it("opens a single grid tab in an ordinary window", async () => {
    const result = await start(["1", "2", "3", "4"]);

    assert.equal(result.tiles.length, 4);
    const grid = gridTab();
    assert.ok(grid, "no grid tab was opened");
    assert.equal(grid.url, MULTISTREAM.GRID_URL);
    assert.ok(grid.active, "the grid tab was opened in the background");

    const popups = [...mock.windowState.values()].filter((window) => window.type === "popup");
    assert.equal(popups.length, 0, "multistream should not open windows of its own");
    assert.equal(
      mock.windowState.get(Number(grid.windowId))?.type,
      "normal",
      "the grid belongs in an ordinary window"
    );
    assert.equal(grid.groupId, -1, "the grid tab was filed into the AutoLurk group");
  });

  // An embedded player claims no points and earns no streak, so the real tabs
  // behind the tiles have to carry on untouched. They were moved into popups
  // and regrouped by the version this replaced.
  it("leaves the lurk tabs exactly where they were", async () => {
    mock.reset(base());
    await openLurkTabs(CHANNELS.slice(0, 3));

    const before = lurkTabs();
    assert.equal(before.length, 3, "the lurk tabs were not set up");
    assert.ok(
      before.every((tab) => tab.groupId !== -1),
      "the lurk tabs should start out grouped"
    );

    await playing(() => startMultistream(["1", "2", "3"]));

    assert.deepEqual(lurkTabs(), before, "starting the grid disturbed the lurk tabs");
  });

  it("opens a lurk tab for a tiled channel that has none", async () => {
    mock.reset(base());
    await openLurkTabs([CHANNELS[0]]);
    assert.equal(lurkTabs().length, 1);

    await playing(() => startMultistream(["1", "2"]));

    assert.equal(lurkTabs().length, 2, "the second channel was never opened for real");
    assert.ok(tabFor("two"), "no lurk tab exists for the channel that was not open");
  });

  it("hands the grid its tiles and tells any other tab nothing", async () => {
    const result = await start(["1", "2", "3"]);
    const grid = gridTab();

    const payload = await gridTiles(grid.id);
    assert.deepEqual(
      payload.tiles.map((tile) => tile.login),
      ["one", "two", "three"]
    );
    assert.equal(payload.audibleLogin, "one", "the first tile should start with the sound");
    assert.equal(payload.quality, MULTISTREAM.TILE_QUALITY);
    assert.equal(result.tiles.filter((tile) => tile.audible).length, 1);

    assert.equal(await gridTiles(grid.id + 500), null, "another tab was handed the grid");
  });

  // The grid asks for its tiles the instant it loads, which can beat
  // tabs.create returning an id, so the asking tab is adopted.
  it("adopts the asking tab when the grid id is not known yet", async () => {
    mock.reset(base());
    mock.session.multistream = {
      active: true,
      startedAt: Date.now(),
      gridTabId: null,
      focusedUserId: "2",
      channels: CHANNELS.slice(0, 2),
    };

    const payload = await gridTiles(77);
    assert.equal(payload.tiles.length, 2);
    assert.equal(payload.audibleLogin, "two", "the audible channel was not carried over");
    assert.equal((await getMultistream()).gridTabId, 77, "the grid tab was not adopted");
  });

  it("moves the sound to the channel the user picks", async () => {
    await start(["1", "2", "3"]);
    const grid = gridTab();

    const announced = [];
    const realSend = mock.chrome.tabs.sendMessage;
    mock.chrome.tabs.sendMessage = async (id, message) => {
      if (message?.type === "MULTISTREAM_AUDIO") announced.push({ id: Number(id), login: message.login });
      return realSend(id, message);
    };
    try {
      const result = await setMultistreamAudio("3");
      assert.equal(result.focusedUserId, "3");
      assert.equal(result.tiles.filter((tile) => tile.audible).length, 1, "two tiles are audible");
      assert.equal(result.tiles.find((tile) => tile.audible).login, "three");
    } finally {
      mock.chrome.tabs.sendMessage = realSend;
    }

    // One broadcast to the grid tab; the frames inside it sort out which of
    // them the named channel belongs to.
    assert.deepEqual(announced, [{ id: grid.id, login: "three" }]);
    assert.equal((await multistreamSnapshot()).focusedUserId, "3");
  });

  it("refuses to open a second grid while one is running", async () => {
    await start(["1", "2"]);
    await assert.rejects(startMultistream(["3", "4"]), "a second grid was opened");
    assert.equal(await getMultistream() ? 1 : 0, 1, "the running session was lost");
  });

  // A favorite going live mid-session is the case the popup version kept
  // getting wrong: it has nowhere special to go now, because nothing moved.
  it("lets a favorite going live join the one group as usual", async () => {
    await start(["1", "2"]);
    const grid = gridTab();

    await playing(() => openManagedStream(CHANNELS[3], { streamId: "s4" }));
    await updateLiveGroup(await getManagedTabs());

    const groups = new Set(lurkTabs().map((tab) => tab.groupId));
    assert.equal(groups.size, 1, `the lurk tabs are spread across ${groups.size} groups`);
    assert.notOk(groups.has(-1), "a lurk tab was left out of the group");
    assert.equal(
      mock.tabState.get(grid.id).groupId,
      -1,
      "consolidation swept the grid tab into the AutoLurk group"
    );
    assert.ok(await getMultistream(), "opening a stream ended the session");
  });

  it("ends the session when the grid tab is closed", async () => {
    await start(["1", "2", "3"]);
    const grid = gridTab();
    const before = lurkTabs();

    await mock.chrome.tabs.remove(grid.id);
    await handleMultistreamTabRemoved(grid.id);

    assert.equal(await getMultistream(), null, "closing the grid left the session behind");
    assert.deepEqual(lurkTabs(), before, "closing the grid disturbed the lurk tabs");
  });

  it("closes the grid tab on exit and leaves the streams running", async () => {
    await start(["1", "2", "3"]);
    const before = lurkTabs();

    const result = await stopMultistream();

    assert.equal(result.active, false);
    assert.equal(gridTab(), null, "the grid tab was left open");
    assert.equal(await getMultistream(), null);
    assert.deepEqual(lurkTabs(), before, "exiting the grid disturbed the lurk tabs");
  });

  it("ends a session whose grid tab died while the worker was asleep", async () => {
    await start(["1", "2", "3"]);
    const grid = gridTab();

    // Closed with no event delivered, which is what a worker restart looks
    // like from in here.
    mock.tabState.delete(grid.id);

    await reconcileMultistream();
    assert.equal(await getMultistream(), null, "the dead session was kept");
  });

  it("ends a session whose grid tab was navigated somewhere else", async () => {
    await start(["1", "2", "3"]);
    const grid = gridTab();

    await mock.chrome.tabs.update(grid.id, { url: "https://www.twitch.tv/one" });

    await reconcileMultistream();
    assert.equal(await getMultistream(), null, "a tab that is no longer a grid kept the session");
    assert.ok(mock.tabState.has(grid.id), "reconciling closed a tab it does not own");
  });
});
