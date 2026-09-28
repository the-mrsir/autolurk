import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";
import { MESSAGE, SESSION_KEYS, STORAGE_KEYS } from "../shared/constants.js";
import {
  judgeRecovery,
  pickRecoveryMedia,
  streakIsExpiring,
  STREAK_TIMING,
} from "../shared/streak-logic.js";
import { getActivity, getSessionValue, saveSettings, setSessionValue } from "../shared/storage.js";
import { noteStreakTabClosed, scanWatchStreaks, tickWatchStreaks } from "../background/streaks.js";

const mock = chromeMock();
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function rewardList(expiresAt, missedIds = ["broadcast-1"]) {
  return {
    data: {
      channel: {
        self: {
          watchStreakMilestone: {
            expiresAt,
            missedStreams: expiresAt
              ? [{ broadcastIdentifiers: missedIds.map((id) => ({ id })) }]
              : null,
            watchStreakMilestone: { value: "4" },
          },
        },
      },
    },
  };
}

function clipsPayload() {
  return {
    data: {
      user: {
        clips: {
          edges: [
            {
              node: {
                slug: "wrong-new",
                url: "https://www.twitch.tv/aztecross/clip/wrong-new",
                createdAt: "2026-09-02T00:00:00Z",
                durationSeconds: 30,
                broadcastIdentifier: { id: "other-broadcast" },
              },
            },
            {
              node: {
                slug: "right-old",
                url: "https://www.twitch.tv/aztecross/clip/right-old",
                createdAt: "2026-09-01T00:00:00Z",
                durationSeconds: 20,
                broadcastIdentifier: { id: "broadcast-1" },
              },
            },
          ],
        },
      },
    },
  };
}

function videosPayload() {
  return {
    data: {
      user: {
        videos: {
          edges: [
            {
              node: {
                id: "99",
                publishedAt: "2026-09-01T00:00:00Z",
                lengthSeconds: 4000,
                broadcastIdentifier: { id: "broadcast-1" },
              },
            },
          ],
        },
      },
    },
  };
}

function answer(world, message) {
  if (message?.type === MESSAGE.STREAK_GQL) {
    return {
      ok: true,
      body: message.operations.map((operation) => {
        if (operation.operationName === "RewardList") return rewardList(world.expiresAt, world.missedIds);
        if (operation.operationName === "ClipsCards__User") return clipsPayload();
        if (operation.operationName === "FilterableVideoTower_Videos") return videosPayload();
        return { data: null };
      }),
    };
  }
  if (message?.type === MESSAGE.STREAK_PROGRESS) return { ...world.progress };
  return undefined;
}

async function activityText() {
  const items = await getActivity();
  return items.map((item) => item.text).join("\n");
}

async function recoveryTabs() {
  const tabs = await mock.chrome.tabs.query({});
  return tabs.filter((tab) => tab.id !== 7);
}

function install(world) {
  mock.reset({
    tabs: [{ id: 7, url: "https://www.twitch.tv/", status: "complete", active: true }],
    storage: {
      [STORAGE_KEYS.FAVORITES]: {
        55: { userId: "55", login: "aztecross", displayName: "Aztecross" },
      },
    },
  });
  mock.setContentScript(7, (message) => answer(world, message));
  const realCreate = mock.chrome.tabs.create;
  mock.chrome.tabs.create = async (props) => {
    const tab = await realCreate(props);
    world.progress.url = props.url;
    mock.setContentScript(tab.id, (message) => answer(world, message));
    return tab;
  };
  return () => {
    mock.chrome.tabs.create = realCreate;
  };
}

describe("watch streak decisions", () => {
  it("treats a future expiration as the only at-risk signal", () => {
    assert.equal(streakIsExpiring({ expiresAt: FUTURE }), true);
    assert.equal(streakIsExpiring({ expiresAt: null, missedStreams: [{ broadcastIdentifiers: [{ id: "1" }] }] }), false);
    assert.equal(streakIsExpiring({ expiresAt: PAST }), false);
  });

  it("picks the clip from the missed broadcast, not the newest clip", () => {
    const clips = clipsPayload().data.user.clips.edges.map((edge) => edge.node);
    const videos = videosPayload().data.user.videos.edges.map((edge) => edge.node);
    const picked = pickRecoveryMedia({
      clips,
      videos,
      missedIds: ["broadcast-1"],
      login: "aztecross",
    });
    assert.ok(picked.clipUrl.endsWith("/clip/right-old"));
    assert.ok(!picked.clipUrl.includes("wrong-new"));
    assert.equal(picked.vodUrl, "https://www.twitch.tv/videos/99");
  });

  it("waits until the video has actually played", () => {
    const job = { openedAt: 1_000, openedUrl: "https://www.twitch.tv/aztecross/clip/right-old", phase: "clip", baselineTime: null };
    const first = judgeRecovery(
      job,
      { url: job.openedUrl, hasVideo: true, readyState: 4, currentTime: 1 },
      1_000 + 1000
    );
    assert.equal(first.action, "wait");
    assert.equal(first.baselineTime, 1);
    const played = judgeRecovery(
      { ...job, baselineTime: 1 },
      { url: job.openedUrl, hasVideo: true, readyState: 4, currentTime: 1.2 },
      1_000 + 2000
    );
    assert.equal(played.action, "wait");
    const ready = judgeRecovery(
      { ...job, baselineTime: 1 },
      { url: job.openedUrl, hasVideo: true, readyState: 4, currentTime: 6 },
      1_000 + 2000
    );
    assert.equal(ready.action, "recheck");
  });

  it("does not call a video that never started a recovery", () => {
    const job = { openedAt: 0, openedUrl: "https://www.twitch.tv/videos/99", phase: "vod", baselineTime: null };
    const verdict = judgeRecovery(
      job,
      { url: job.openedUrl, hasVideo: true, readyState: 0, currentTime: 0 },
      STREAK_TIMING.neverStartedMs + 1
    );
    assert.equal(verdict.action, "never-started");
  });
});

describe("watch streak recovery", () => {
  it("opens the matching clip in front and closes it once the expiration clears", async () => {
    const world = {
      expiresAt: FUTURE,
      missedIds: ["broadcast-1"],
      progress: { hasVideo: true, readyState: 4, currentTime: 1, paused: false, url: "" },
    };
    const restore = install(world);
    try {
      mock.blurChrome();
      await scanWatchStreaks();
      const opened = await recoveryTabs();
      assert.equal(opened.length, 1);
      assert.equal(opened[0].active, true);
      assert.equal(opened[0].mutedInfo.muted, true);
      assert.ok(opened[0].url.endsWith("/clip/right-old"), opened[0].url);
      const window = await mock.chrome.windows.get(opened[0].windowId);
      assert.equal(window.focused, true);

      await tickWatchStreaks();
      world.progress.currentTime = 10;
      world.expiresAt = null;
      await tickWatchStreaks();

      const text = await activityText();
      assert.ok(text.includes("Watch streak for Aztecross recovered."), text);
      assert.equal((await recoveryTabs()).length, 0);
    } finally {
      restore();
    }
  });

  it("does not say the streak recovered while Twitch still shows the expiration", async () => {
    const world = {
      expiresAt: FUTURE,
      missedIds: ["broadcast-1"],
      progress: { hasVideo: true, readyState: 4, currentTime: 1, paused: false, url: "" },
    };
    const restore = install(world);
    try {
      await scanWatchStreaks();
      await tickWatchStreaks();
      world.progress.currentTime = 10;
      await tickWatchStreaks();

      const text = await activityText();
      assert.ok(!text.includes("Watch streak for Aztecross recovered."), text);
      const opened = await recoveryTabs();
      assert.equal(opened.length, 1);
      assert.equal(opened[0].url, "https://www.twitch.tv/videos/99");
    } finally {
      restore();
    }
  });

  it("reports a recovery video that never starts playing", async () => {
    const world = {
      expiresAt: FUTURE,
      missedIds: ["broadcast-1"],
      progress: { hasVideo: true, readyState: 0, currentTime: 0, paused: true, url: "" },
    };
    const restore = install(world);
    try {
      await scanWatchStreaks();
      const stored = await getSessionValue(SESSION_KEYS.STREAK, null);
      stored.active.openedAt = Date.now() - STREAK_TIMING.neverStartedMs - 1000;
      await setSessionValue(SESSION_KEYS.STREAK, stored);
      await tickWatchStreaks();
      const text = await activityText();
      assert.ok(text.includes("never started playing"), text);
      assert.ok(!text.includes("Watch streak for Aztecross recovered."), text);
      assert.equal((await recoveryTabs()).length, 0);
    } finally {
      restore();
    }
  });

  it("does not open a tab when the streak is not expiring", async () => {
    const world = {
      expiresAt: null,
      missedIds: [],
      progress: { hasVideo: false, readyState: 0, currentTime: 0, paused: true, url: "" },
    };
    const restore = install(world);
    try {
      await scanWatchStreaks();
      assert.equal((await recoveryTabs()).length, 0);
      assert.ok(!(await activityText()).includes("Opening"), await activityText());
    } finally {
      restore();
    }
  });

  it("keeps the recovery video in the background when open-in-front is off", async () => {
    const world = {
      expiresAt: FUTURE,
      missedIds: ["broadcast-1"],
      progress: { hasVideo: true, readyState: 4, currentTime: 1, paused: false, url: "" },
    };
    const restore = install(world);
    try {
      mock.blurChrome();
      await saveSettings({ streakOpenInFront: false });
      await scanWatchStreaks();
      const opened = await recoveryTabs();
      assert.equal(opened.length, 1);
      assert.equal(opened[0].active, false);
      const window = await mock.chrome.windows.get(opened[0].windowId);
      assert.equal(window.focused, false);

      await tickWatchStreaks();
      world.progress.currentTime = 10;
      world.expiresAt = null;
      await tickWatchStreaks();
      assert.equal((await recoveryTabs()).length, 0);
      assert.ok((await activityText()).includes("Watch streak for Aztecross recovered."));
    } finally {
      restore();
    }
  });

  it("stays quiet when the setting is off", async () => {
    const world = {
      expiresAt: FUTURE,
      missedIds: ["broadcast-1"],
      progress: { hasVideo: true, readyState: 4, currentTime: 8, paused: false, url: "" },
    };
    const restore = install(world);
    try {
      await saveSettings({ saveWatchStreaks: false });
      await scanWatchStreaks();
      assert.equal((await recoveryTabs()).length, 0);
    } finally {
      restore();
    }
  });

  it("does not reopen an expiration the user already closed", async () => {
    const world = {
      expiresAt: FUTURE,
      missedIds: ["broadcast-1"],
      progress: { hasVideo: true, readyState: 4, currentTime: 1, paused: false, url: "" },
    };
    const restore = install(world);
    try {
      await scanWatchStreaks();
      const [opened] = await recoveryTabs();
      await noteStreakTabClosed(opened.id);
      await mock.chrome.tabs.remove(opened.id);
      await scanWatchStreaks();
      assert.equal((await recoveryTabs()).length, 0);
    } finally {
      restore();
    }
  });
});
