import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";

const mock = chromeMock();

const { BOOTSTRAP_TIMING, openManagedStream, removeManagedTab } = await import(
  "../background/tab-manager.js"
);

BOOTSTRAP_TIMING.visibleMs = 60;
BOOTSTRAP_TIMING.pollMs = 10;

function playingTab(mockRef) {
  const realCreate = mockRef.chrome.tabs.create;
  mockRef.chrome.tabs.create = async (props) => {
    const tab = await realCreate(props);
    mockRef.setContentScript(tab.id, () => ({
      playing: true,
      currentTime: 5,
      muted: false,
      channel: "streamer",
    }));
    return tab;
  };
  return () => {
    mockRef.chrome.tabs.create = realCreate;
  };
}

function autoLurkGroups(mockRef, windowId = 1) {
  return [...mockRef.groupState.values()].filter(
    (group) => group.windowId === windowId && (group.title || "").startsWith("AutoLurk")
  );
}

function managedTabIds(mockRef) {
  return [...mockRef.tabState.entries()]
    .filter(([, tab]) => String(tab.url || "").includes("twitch.tv"))
    .map(([id]) => id);
}

function windowsHoldingManagedTabs(mockRef) {
  return new Set(managedTabIds(mockRef).map((id) => mockRef.tabState.get(id).windowId));
}

async function consolidate() {
  const { updateLiveGroup } = await import("../background/tab-manager.js");
  const { getManagedTabs } = await import("../shared/storage.js");
  await updateLiveGroup(await getManagedTabs());
}

function groupsHoldingManagedTabs(mockRef) {
  const ids = new Set();
  for (const tab of mockRef.tabState.values()) {
    if (String(tab.url || "").includes("twitch.tv") && tab.groupId !== -1) ids.add(tab.groupId);
  }
  return ids;
}

// The user-visible bug this guards: three live favorites producing three
// separate AutoLurk groups in one window, a stream in each. It kept coming back
// because the mock used to stub grouping out entirely, so nothing could see it.
describe("one AutoLurk group, ever", () => {
  const base = {
    tabs: [{ id: 1, url: "https://example.com", active: true }],
    storage: { settings: { muteTabs: true, groupTabs: true, collapseGroup: false } },
  };

  it("puts three streams opened in a row into a single group", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
      await openManagedStream({ userId: "3", login: "three", displayName: "Three" }, {});
    } finally {
      restore();
    }

    const holding = groupsHoldingManagedTabs(mock);
    assert.equal(holding.size, 1, `managed tabs are spread across ${holding.size} groups`);
    assert.equal(autoLurkGroups(mock).length, 1, "more than one AutoLurk group exists");
  });

  it("puts three streams opened at once into a single group", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await Promise.all([
        openManagedStream({ userId: "1", login: "one", displayName: "One" }, {}),
        openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {}),
        openManagedStream({ userId: "3", login: "three", displayName: "Three" }, {}),
      ]);
    } finally {
      restore();
    }

    const holding = groupsHoldingManagedTabs(mock);
    assert.equal(holding.size, 1, `a simultaneous poll produced ${holding.size} groups`);
  });

  it("serializes simultaneous consolidation requests", async () => {
    mock.reset({
      ...base,
      tabs: [
        { id: 1, windowId: 1, url: "https://www.twitch.tv/one", active: true },
        { id: 2, windowId: 1, url: "https://www.twitch.tv/two" },
      ],
      storage: {
        ...base.storage,
        managedTabs: {
          "1": { tabId: 1, userId: "1", login: "one" },
          "2": { tabId: 2, userId: "2", login: "two" },
        },
      },
    });

    const { updateLiveGroup } = await import("../background/tab-manager.js");
    const { getManagedTabs } = await import("../shared/storage.js");
    const managed = await getManagedTabs();
    await Promise.all(Array.from({ length: 8 }, () => updateLiveGroup(managed)));

    assert.equal(autoLurkGroups(mock).length, 1, "racing callers created duplicate groups");
    assert.equal(groupsHoldingManagedTabs(mock).size, 1);
  });

  it("reuses the existing group after the worker forgets which one it was", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});

      // The service worker is torn down constantly under MV3. Anything held
      // only in meta has to be recoverable from what Chrome itself reports.
      const meta = JSON.parse(JSON.stringify(mock.local.meta || {}));
      delete meta.groupId;
      mock.local.meta = meta;

      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    assert.equal(groupsHoldingManagedTabs(mock).size, 1, "a forgotten id must not mean a new group");
  });

  it("still finds the group when its title never got written", async () => {
    // Chrome hands back an untitled group and we name it a moment later. If
    // that naming fails, a title search can never see the group again, and
    // every stream after it used to get one of its own.
    mock.reset(base);
    const restore = playingTab(mock);
    const realUpdate = mock.chrome.tabGroups.update;
    mock.chrome.tabGroups.update = async (id, props) => {
      if (props?.title) throw new Error("rename refused");
      return realUpdate(id, props);
    };

    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
      await openManagedStream({ userId: "3", login: "three", displayName: "Three" }, {});
    } finally {
      mock.chrome.tabGroups.update = realUpdate;
      restore();
    }

    const holding = groupsHoldingManagedTabs(mock);
    assert.equal(holding.size, 1, `an unnamed group produced ${holding.size} groups`);
  });

  it("still finds the group when the user renamed it", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      for (const group of mock.groupState.values()) group.title = "my streams";

      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    assert.equal(groupsHoldingManagedTabs(mock).size, 1, "renaming the group split it in two");
  });

  it("survives a group colour Chrome refuses", async () => {
    // An unrecognised colour makes Chrome reject the whole update, title and
    // all, so a bad saved setting used to scatter every stream into its own
    // group on every single open.
    mock.reset({
      ...base,
      storage: { settings: { ...base.storage.settings, groupColor: "chartreuse" } },
    });
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    assert.equal(groupsHoldingManagedTabs(mock).size, 1);
    const [group] = autoLurkGroups(mock);
    assert.ok(group, "the group should still have been named");
  });

  it("merges groups that are already scattered", async () => {
    // Repairs a profile that is in the broken state right now, rather than
    // only preventing new ones.
    mock.reset(base);
    const restore = playingTab(mock);
    const realUpdate = mock.chrome.tabGroups.update;
    mock.chrome.tabGroups.update = async (id, props) => {
      if (props?.title) throw new Error("rename refused");
      return realUpdate(id, props);
    };

    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
      await openManagedStream({ userId: "3", login: "three", displayName: "Three" }, {});
    } finally {
      mock.chrome.tabGroups.update = realUpdate;
      restore();
    }

    // Whatever state that left, a normal pass must pull it back together.
    const { updateLiveGroup } = await import("../background/tab-manager.js");
    const { getManagedTabs } = await import("../shared/storage.js");
    await updateLiveGroup(await getManagedTabs());

    assert.equal(groupsHoldingManagedTabs(mock).size, 1, "scattered groups were not merged");
  });

  it("leaves a group the user named alone", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    // The user pulls one stream out into a group of their own.
    const managedTabIds = [...mock.tabState.entries()]
      .filter(([, tab]) => String(tab.url || "").includes("twitch.tv"))
      .map(([id]) => id);
    const mine = await mock.chrome.tabs.group({
      tabIds: [managedTabIds[0]],
      createProperties: { windowId: 1 },
    });
    await mock.chrome.tabGroups.update(mine, { title: "watch later" });

    const { updateLiveGroup } = await import("../background/tab-manager.js");
    const { getManagedTabs } = await import("../shared/storage.js");
    await updateLiveGroup(await getManagedTabs());

    assert.equal(
      mock.tabState.get(managedTabIds[0]).groupId,
      mine,
      "a group the user named must not be swallowed"
    );
  });

  // The reported bug: a long session drifting into several AutoLurk groups.
  // Preventing new splits was not enough, because nothing ever healed a split
  // that had already happened - the group was tracked per window, so two
  // windows meant two groups forever.
  it("merges AutoLurk groups that already ended up in separate windows", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
      await openManagedStream({ userId: "3", login: "three", displayName: "Three" }, {});
    } finally {
      restore();
    }

    // Recreate the drifted state: two more windows, each with its own group.
    const managed = managedTabIds(mock);
    for (const [index, windowId] of [
      [1, 2],
      [2, 3],
    ]) {
      await mock.chrome.tabs.move(managed[index], { windowId, index: -1 });
      const stray = await mock.chrome.tabs.group({
        tabIds: [managed[index]],
        createProperties: { windowId },
      });
      await mock.chrome.tabGroups.update(stray, { title: "AutoLurk · 1" });
    }
    assert.equal(groupsHoldingManagedTabs(mock).size, 3, "setup should start out split");

    await consolidate();

    const holding = groupsHoldingManagedTabs(mock);
    assert.equal(holding.size, 1, `${holding.size} groups survived consolidation`);
    assert.equal(windowsHoldingManagedTabs(mock).size, 1, "streams are still spread over windows");
  });

  it("pulls back a stream dragged out into a window of its own", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    // Dragging a tab out leaves it ungrouped in a new window, with no group to
    // match on - so only asking where the managed tabs are can find it.
    const managed = managedTabIds(mock);
    await mock.chrome.tabs.move(managed[1], { windowId: 7, index: -1 });

    await consolidate();

    assert.equal(windowsHoldingManagedTabs(mock).size, 1, "the stray tab was not brought back");
    assert.equal(groupsHoldingManagedTabs(mock).size, 1, "the stray tab did not rejoin the group");
  });

  it("counts every stream in the title after a merge", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    const managed = managedTabIds(mock);
    await mock.chrome.tabs.move(managed[1], { windowId: 4, index: -1 });
    await consolidate();

    const [group] = [...mock.groupState.values()].filter((g) =>
      String(g.title || "").startsWith("AutoLurk")
    );
    assert.equal(group?.title, "AutoLurk · 2", `title went stale: ${group?.title}`);
  });

  it("joins the existing group even when the user is in another window", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});

      // The user opens a second window and works there. The next stream still
      // belongs with the first one.
      mock.tabState.set(90, {
        id: 90,
        windowId: 2,
        url: "https://example.org",
        active: true,
        groupId: -1,
        status: "complete",
        mutedInfo: { muted: false },
      });
      mock.focusWindow(2);

      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    const managed = [...mock.tabState.values()].filter((tab) =>
      String(tab.url || "").includes("twitch.tv")
    );
    assert.equal(managed.length, 2);
    assert.deepEqual(
      [...new Set(managed.map((tab) => tab.windowId))],
      [1],
      "both streams should have ended up in the window that holds the group"
    );
    assert.equal(groupsHoldingManagedTabs(mock).size, 1);
  });

  it("joins the AutoLurk group Chrome already opened", async () => {
    mock.reset({
      tabs: [
        { id: 1, windowId: 1, url: "https://www.twitch.tv/local", active: true },
        { id: 2, windowId: 2, url: "https://www.twitch.tv/remote-one" },
        { id: 3, windowId: 2, url: "https://www.twitch.tv/remote-two" },
        { id: 4, windowId: 2, url: "https://www.twitch.tv/remote-three" },
      ],
      storage: {
        settings: { muteTabs: true, groupTabs: true, collapseGroup: false },
        managedTabs: {
          "1": { tabId: 1, userId: "1", login: "local", expectedChannel: "local" },
        },
      },
    });
    const localGroup = await mock.chrome.tabs.group({
      tabIds: [1],
      createProperties: { windowId: 1 },
    });
    await mock.chrome.tabGroups.update(localGroup, { title: "AutoLurk · 1" });
    const syncedGroup = await mock.chrome.tabs.group({
      tabIds: [2, 3, 4],
      createProperties: { windowId: 2 },
    });
    await mock.chrome.tabGroups.update(syncedGroup, { title: "AutoLurk k2xk · 3" });
    mock.local.meta = { groupId: localGroup };

    await consolidate();

    const groups = [...mock.groupState.values()].filter((group) =>
      String(group.title || "").startsWith("AutoLurk")
    );
    assert.equal(groups.length, 1, "a second AutoLurk group was created");
    assert.equal(groups[0].id, syncedGroup, "the group Chrome already opened was not kept");
    assert.equal(groups[0].title, "AutoLurk · 4");
    assert.equal(String(groups[0].title).includes("k2xk"), false);
    assert.equal(mock.tabState.get(1).groupId, syncedGroup);
    assert.equal(mock.tabState.get(2).mutedInfo?.muted, true, "a pulled stream stayed unmuted");
  });

  it("keeps the server's group in front when a second AutoLurk group is opened", async () => {
    mock.reset({
      tabs: [
        {
          id: 1,
          windowId: 1,
          url: "https://www.twitch.tv/zerggyyyy",
          active: true,
        },
        { id: 2, windowId: 2, url: "https://www.twitch.tv/zerggyyyy", active: true },
        { id: 3, windowId: 2, url: "https://www.twitch.tv/goober", active: false },
      ],
      storage: {
        settings: { muteTabs: true, groupTabs: true, collapseGroup: true, serverRotation: true },
        managedTabs: {
          "1": {
            tabId: 1,
            userId: "1",
            login: "zerggyyyy",
            expectedChannel: "zerggyyyy",
            health: "media_playing",
          },
        },
      },
    });
    mock.focusWindow(1);
    const localGroup = await mock.chrome.tabs.group({
      tabIds: [1],
      createProperties: { windowId: 1 },
    });
    await mock.chrome.tabGroups.update(localGroup, { title: "AutoLurk · 1", collapsed: false });
    const syncedGroup = await mock.chrome.tabs.group({
      tabIds: [2, 3],
      createProperties: { windowId: 2 },
    });
    await mock.chrome.tabGroups.update(syncedGroup, {
      title: "AutoLurk · 2",
      collapsed: true,
    });
    mock.local.meta = { groupId: localGroup };

    await consolidate();

    const groups = [...mock.groupState.values()].filter((group) =>
      String(group.title || "").startsWith("AutoLurk")
    );
    assert.equal(groups.length, 1, "the opened group was left beside the server's group");
    assert.equal(groups[0].id, localGroup, "the server's streams were moved onto the new group");
    assert.equal(groups[0].windowId, 1);
    assert.equal(groups[0].collapsed, false, "the merge collapsed the group the server is showing");
    assert.equal(mock.tabState.has(1), true, "the stream the server was watching was closed");
    assert.equal(mock.tabState.has(2), false, "the opened copy of the same channel stayed open");
    assert.equal(mock.tabState.get(1).active, true);
    assert.equal(mock.tabState.get(1).windowId, 1);
    assert.equal(mock.tabState.get(3).windowId, 1);
    assert.equal(mock.tabState.get(3).groupId, localGroup);
  });

  it("keeps one tab per channel when both computers opened the same streams", async () => {
    const channels = ["eslcs", "esfandtv", "northernlion", "otk"];
    const tabs = [];
    const managedTabs = {};
    for (let index = 0; index < channels.length; index += 1) {
      const login = channels[index];
      const localId = index + 1;
      const remoteId = index + 5;
      tabs.push({
        id: localId,
        windowId: 1,
        url: `https://www.twitch.tv/${login}`,
        active: index === 0,
      });
      tabs.push({
        id: remoteId,
        windowId: 2,
        url: `https://www.twitch.tv/${login}`,
        active: false,
      });
      managedTabs[String(localId)] = {
        tabId: localId,
        userId: String(localId),
        login,
        expectedChannel: login,
      };
    }
    mock.reset({
      tabs,
      storage: {
        settings: { muteTabs: true, groupTabs: true, collapseGroup: false },
        managedTabs,
      },
    });
    const localGroup = await mock.chrome.tabs.group({
      tabIds: [1, 2, 3, 4],
      createProperties: { windowId: 1 },
    });
    await mock.chrome.tabGroups.update(localGroup, { title: "AutoLurk · 4" });
    const remoteGroup = await mock.chrome.tabs.group({
      tabIds: [5, 6, 7, 8],
      createProperties: { windowId: 2 },
    });
    await mock.chrome.tabGroups.update(remoteGroup, { title: "AutoLurk · 4" });
    mock.local.meta = { groupId: localGroup };

    await consolidate();

    const twitch = [...mock.tabState.values()].filter((tab) =>
      String(tab.url || "").includes("twitch.tv/")
    );
    assert.equal(twitch.length, 4, "both computers' copies stayed open");
    const groups = [...mock.groupState.values()].filter((group) =>
      String(group.title || "").startsWith("AutoLurk")
    );
    assert.equal(groups.length, 1, "the two groups were not combined");
    assert.equal(groups[0].title, "AutoLurk · 4");
    for (const id of [1, 2, 3, 4]) {
      assert.equal(mock.tabState.get(id).groupId, groups[0].id);
    }
  });

  it("does not create a group when Chrome cannot enumerate existing groups", async () => {
    mock.reset({
      tabs: [{ id: 1, windowId: 1, url: "https://www.twitch.tv/one", active: true }],
      storage: {
        settings: { muteTabs: true, groupTabs: true },
        managedTabs: {
          "1": { tabId: 1, userId: "1", login: "one", expectedChannel: "one" },
        },
      },
    });
    const realQuery = mock.chrome.tabGroups.query;
    mock.chrome.tabGroups.query = () => Promise.reject(new Error("group sync unavailable"));
    try {
      await consolidate();
    } finally {
      mock.chrome.tabGroups.query = realQuery;
    }

    assert.equal(mock.groupState.size, 0, "an API failure was mistaken for no existing group");
  });

  it("does not take over the tab the user is looking at", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});

      mock.tabState.set(90, {
        id: 90,
        windowId: 2,
        url: "https://example.org",
        active: true,
        groupId: -1,
        status: "complete",
        mutedInfo: { muted: false },
      });
      mock.focusWindow(2);

      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    assert.equal(mock.tabState.get(90).active, true, "the user's tab was left in the background");
    assert.equal(mock.tabState.get(90).windowId, 2);
    const opened = [...mock.tabState.values()].find((tab) => String(tab.url || "").includes("/two"));
    assert.ok(opened, "the new stream was not opened");
    assert.equal(opened.windowId, 1, "after start it should join the AutoLurk window");
  });

  it("does not let a PLAYER_BOOT consolidation activate a tab mid-bootstrap", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});

      mock.tabState.set(90, {
        id: 90,
        windowId: 2,
        url: "https://example.org",
        active: true,
        groupId: -1,
        status: "complete",
        mutedInfo: { muted: false },
      });
      mock.focusWindow(2);

      let activeDuringBoot = null;
      const realCreate = mock.chrome.tabs.create;
      mock.chrome.tabs.create = async (props) => {
        const tab = await realCreate(props);
        mock.setContentScript(tab.id, async () => {
          // This is the service worker's PLAYER_BOOT handler racing the
          // hidden startup. It may regroup established tabs, but must not
          // activate this one.
          await consolidate();
          if (activeDuringBoot == null) activeDuringBoot = mock.tabState.get(tab.id).active;
          return { playing: true, currentTime: 4, channel: "two", hidden: false };
        });
        return tab;
      };
      try {
        await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
      } finally {
        mock.chrome.tabs.create = realCreate;
      }

      assert.equal(activeDuringBoot, false, "consolidation activated the booting tab");
    } finally {
      restore();
    }
  });

  it("gives the user their tab back in the window they were in", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});

      mock.tabState.set(90, {
        id: 90,
        windowId: 2,
        url: "https://example.org",
        active: true,
        groupId: -1,
        status: "complete",
        mutedInfo: { muted: false },
      });
      mock.focusWindow(2);

      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    assert.equal(mock.tabState.get(90).active, true, "the user's tab was left in the background");
  });

  it("does not strand a group when the last stream in it closes", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      const first = await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await removeManagedTab(first.tabId);
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }

    assert.equal(groupsHoldingManagedTabs(mock).size, 1);
  });

  it("opens an automatic stream behind the Twitch stream being watched", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/watching", active: true }],
      storage: base.storage,
    });
    const restore = playingTab(mock);
    let opened;
    try {
      opened = await openManagedStream(
        { userId: "2", login: "two", displayName: "Two" },
        {},
        { focus: true, automatic: true }
      );
    } finally {
      restore();
    }

    assert.equal(mock.tabState.get(1).active, true, "the stream being watched lost the screen");
    assert.equal(mock.tabState.get(opened.tabId).active, false);
  });

  it("still brings a stream forward when the user asked for it", async () => {
    mock.reset({
      tabs: [{ id: 1, url: "https://www.twitch.tv/watching", active: true }],
      storage: base.storage,
    });
    const restore = playingTab(mock);
    let opened;
    try {
      opened = await openManagedStream(
        { userId: "2", login: "two", displayName: "Two" },
        {},
        { focus: true }
      );
    } finally {
      restore();
    }

    assert.equal(mock.tabState.get(opened.tabId).active, true);
  });

  it("asks a focused open for viewing quality, not 160p", async () => {
    mock.reset(base);
    const restore = playingTab(mock);
    const pins = [];
    const realSend = mock.chrome.tabs.sendMessage;
    mock.chrome.tabs.sendMessage = async (id, message) => {
      if (message?.type === "PIN_LOW_QUALITY" || message?.type === "PIN_VIEWING_QUALITY") {
        pins.push(message.type);
      }
      return realSend(id, message);
    };
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {}, { focus: true });
    } finally {
      mock.chrome.tabs.sendMessage = realSend;
      restore();
    }

    assert.ok(pins.includes("PIN_VIEWING_QUALITY"), "a focused open never asked for 1080p");
    assert.equal(
      pins.includes("PIN_LOW_QUALITY"),
      false,
      "a stream the user asked to watch was pinned to 160p"
    );
  });

  it("does not start a second group when Chrome refuses to extend the first", async () => {
    // A tab being dragged or closed at the wrong moment makes Chrome reject the
    // whole grouping call. Treating that as "there is no group" and making a
    // fresh one is how a working profile grows a second AutoLurk group.
    mock.reset(base);
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }
    const before = autoLurkGroups(mock).length;
    assert.equal(before, 1);

    const realGroup = mock.chrome.tabs.group;
    mock.chrome.tabs.group = async (props) => {
      if (props?.groupId != null) throw new Error("tab is being dragged");
      return realGroup(props);
    };
    try {
      await consolidate();
    } finally {
      mock.chrome.tabs.group = realGroup;
    }

    assert.equal(autoLurkGroups(mock).length, 1, "a refused regroup created a second group");
    assert.equal(groupsHoldingManagedTabs(mock).size, 1);
  });
});

// Chrome can hand a profile a second AutoLurk group with no tab of ours moving
// at all: a window restored with last session's group still in it, a group
// arriving from another machine through Chrome's own tab group sync, a tab
// dragged out. Consolidation used to run only on open, close and playback, so
// those splits sat there until a stream happened to move.
describe("the periodic split sweep", () => {
  const base = {
    tabs: [{ id: 1, url: "https://example.com", active: true }],
    storage: { settings: { muteTabs: true, groupTabs: true, collapseGroup: false } },
  };

  async function sweep() {
    const { consolidateIfSplit } = await import("../background/tab-manager.js");
    return consolidateIfSplit();
  }

  async function twoStreams() {
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }
  }

  it("leaves a healthy single group untouched", async () => {
    mock.reset(base);
    await twoStreams();
    const [group] = autoLurkGroups(mock);

    assert.equal(await sweep(), false, "a tidy profile should not be regrouped every minute");
    assert.equal(autoLurkGroups(mock).length, 1);
    assert.equal(autoLurkGroups(mock)[0].id, group.id, "the group was needlessly rebuilt");
  });

  it("merges a second group that appeared on its own", async () => {
    mock.reset(base);
    await twoStreams();
    const [tabId] = managedTabIds(mock);

    // Nothing the extension did: a group of ours simply showed up holding one
    // of our tabs, the way a restored or synced one does.
    const strayId = await mock.chrome.tabs.group({ tabIds: [tabId] });
    await mock.chrome.tabGroups.update(strayId, { title: "AutoLurk · 1" });
    assert.equal(autoLurkGroups(mock).length, 2, "the split was not set up");

    assert.equal(await sweep(), true);
    assert.equal(autoLurkGroups(mock).length, 1, "the stray group was not merged away");
    assert.equal(groupsHoldingManagedTabs(mock).size, 1);
  });

  it("drops duplicate channels after the two groups have already been combined", async () => {
    const channels = ["eslcs", "esfandtv", "northernlion", "otk"];
    const tabs = [{ id: 9, windowId: 1, url: "https://example.com", active: true }];
    const managedTabs = {};
    const grouped = [];
    for (let index = 0; index < channels.length; index += 1) {
      const login = channels[index];
      const localId = index + 1;
      const copyId = index + 5;
      tabs.push({
        id: localId,
        windowId: 1,
        url: `https://www.twitch.tv/${login}`,
        active: false,
      });
      tabs.push({
        id: copyId,
        windowId: 1,
        url: `https://www.twitch.tv/${login}`,
        active: false,
      });
      managedTabs[String(localId)] = {
        tabId: localId,
        userId: String(localId),
        login,
        expectedChannel: login,
      };
      grouped.push(localId, copyId);
    }
    mock.reset({
      tabs,
      storage: {
        settings: { muteTabs: true, groupTabs: true, collapseGroup: false },
        managedTabs,
      },
    });
    const groupId = await mock.chrome.tabs.group({
      tabIds: grouped,
      createProperties: { windowId: 1 },
    });
    await mock.chrome.tabGroups.update(groupId, { title: "AutoLurk · 8" });
    mock.local.meta = { groupId };

    assert.equal(await sweep(), true, "a group of doubled streams was treated as healthy");
    const twitch = [...mock.tabState.values()].filter((tab) =>
      String(tab.url || "").includes("twitch.tv/")
    );
    assert.equal(twitch.length, 4);
    assert.equal(autoLurkGroups(mock).length, 1);
    assert.equal(autoLurkGroups(mock)[0].title, "AutoLurk · 4");
  });

  it("pulls back a stream that ended up in no group at all", async () => {
    mock.reset(base);
    await twoStreams();
    const [tabId] = managedTabIds(mock);
    mock.tabState.get(tabId).groupId = -1;

    assert.equal(await sweep(), true);
    assert.equal(groupsHoldingManagedTabs(mock).size, 1);
    assert.equal(mock.tabState.get(tabId).groupId !== -1, true, "the loose tab was left out");
  });

  it("says so in the activity log when it merges one", async () => {
    mock.reset(base);
    await twoStreams();
    const [tabId] = managedTabIds(mock);
    const strayId = await mock.chrome.tabs.group({ tabIds: [tabId] });
    await mock.chrome.tabGroups.update(strayId, { title: "AutoLurk · 1" });

    await sweep();

    const { getActivity } = await import("../shared/storage.js");
    const entries = await getActivity();
    assert.ok(
      entries.some((entry) => String(entry.text || "").includes("stray AutoLurk group")),
      "a merge should leave a trace, so a cause that is still happening stays visible"
    );
  });

  it("stays out of the way when grouping is switched off", async () => {
    mock.reset(base);
    await twoStreams();
    const { saveSettings } = await import("../shared/storage.js");
    await saveSettings({ groupTabs: false });

    assert.equal(await sweep(), false);
  });
});

// Brave and Chrome sync the group, but on this computer the other computer's
// group is a closed saved group the tab group API cannot see.
describe("one AutoLurk group across computers", () => {
  const base = {
    tabs: [{ id: 1, url: "https://example.com", active: true }],
    storage: { settings: { muteTabs: true, groupTabs: true, collapseGroup: false } },
  };

  async function openTwo() {
    const restore = playingTab(mock);
    try {
      await openManagedStream({ userId: "1", login: "one", displayName: "One" }, {});
      await openManagedStream({ userId: "2", login: "two", displayName: "Two" }, {});
    } finally {
      restore();
    }
  }

  function allAutoLurkGroups() {
    return [...mock.groupState.values()].filter((group) =>
      String(group.title || "").startsWith("AutoLurk")
    );
  }

  it("does not make a group while another computer holds one", async () => {
    mock.reset(base);
    mock.seedSync({ groupClaim: { machine: "other-computer", at: Date.now() } });

    await openTwo();

    assert.equal(allAutoLurkGroups().length, 0, "a second group was made beside the synced one");
    assert.equal(mock.sync.groupClaim.machine, "other-computer");
  });

  it("joins the other computer's group once it is opened here", async () => {
    mock.reset(base);
    mock.seedSync({ groupClaim: { machine: "other-computer", at: Date.now() } });
    await openTwo();

    mock.tabState.set(50, {
      id: 50,
      windowId: 1,
      url: "https://www.twitch.tv/three",
      groupId: -1,
      status: "complete",
      mutedInfo: { muted: false },
    });
    const synced = await mock.chrome.tabs.group({ tabIds: [50], createProperties: { windowId: 1 } });
    await mock.chrome.tabGroups.update(synced, { title: "AutoLurk · 1" });

    const { consolidateIfSplit } = await import("../background/tab-manager.js");
    await consolidateIfSplit();

    const groups = allAutoLurkGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, synced);
    for (const id of managedTabIds(mock)) assert.equal(mock.tabState.get(id).groupId, synced);
    await consolidateIfSplit();
    assert.equal(allAutoLurkGroups().length, 1, "the joined group was taken apart");
  });

  it("keeps the shared group's copy of a channel and closes the loose one", async () => {
    mock.reset(base);
    mock.seedSync({ groupClaim: { machine: "other-computer", at: Date.now() } });
    await openTwo();
    const [loose] = managedTabIds(mock);
    const login = new URL(mock.tabState.get(loose).url).pathname.split("/")[1];

    mock.tabState.set(60, {
      id: 60,
      windowId: 1,
      url: `https://www.twitch.tv/${login}`,
      groupId: -1,
      status: "complete",
      mutedInfo: { muted: false },
    });
    const synced = await mock.chrome.tabs.group({ tabIds: [60], createProperties: { windowId: 1 } });
    await mock.chrome.tabGroups.update(synced, { title: "AutoLurk · 1" });

    const { consolidateIfSplit } = await import("../background/tab-manager.js");
    await consolidateIfSplit();

    assert.equal(mock.tabState.has(60), true, "a tab in the shared group was closed");
    assert.equal(mock.tabState.has(loose), false, "the loose copy stayed open");
    const { getManagedTabs } = await import("../shared/storage.js");
    assert.ok((await getManagedTabs())["60"], "the shared group's tab was not taken over");
  });

  it("claims the group it made so the other computer does not make one", async () => {
    mock.reset(base);
    await openTwo();

    assert.equal(allAutoLurkGroups().length, 1);
    const { getMeta } = await import("../shared/storage.js");
    assert.equal(mock.sync.groupClaim.machine, (await getMeta()).machineId);
  });

  it("takes its own group apart when both computers made one at once", async () => {
    mock.reset(base);
    await openTwo();
    assert.equal(allAutoLurkGroups().length, 1);

    mock.seedSync({ groupClaim: { machine: "other-computer", at: Date.now() } });
    const { consolidateIfSplit } = await import("../background/tab-manager.js");
    assert.equal(await consolidateIfSplit(), true);

    assert.equal(allAutoLurkGroups().length, 0, "two groups stayed after the claim was settled");
    assert.equal(managedTabIds(mock).length, 2, "a stream was closed instead of ungrouped");
    await consolidateIfSplit();
    assert.equal(allAutoLurkGroups().length, 0, "a new group was made after yielding");
  });

  it("makes a group again once the other computer stops holding it", async () => {
    mock.reset(base);
    mock.seedSync({ groupClaim: { machine: "other-computer", at: Date.now() - 10 * 60_000 } });

    await openTwo();

    assert.equal(allAutoLurkGroups().length, 1);
  });

  it("keeps sync storage untouched when sync is off", async () => {
    mock.reset({
      ...base,
      storage: { settings: { ...base.storage.settings, syncEnabled: false } },
    });
    await openTwo();

    assert.equal(allAutoLurkGroups().length, 1);
    assert.equal("groupClaim" in mock.sync, false);
  });
});
