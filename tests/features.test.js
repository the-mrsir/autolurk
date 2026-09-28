import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";
import {
  emptyPointsEntry,
  parseBalance,
  pointsSummary,
  recordClaim,
} from "../shared/points-logic.js";
import {
  getPageConfig,
  recordPointsBalance,
  recordPointsClaim,
} from "../background/channel-points.js";
import { clearSevenTvCache, getSevenTvForUser, prefetchSevenTv } from "../background/seventv.js";
import { getActivity, getChannelPoints, saveSettings } from "../shared/storage.js";
import { STORAGE_KEYS } from "../shared/constants.js";

const mock = chromeMock();

describe("channel point accounting", () => {
  it("parses the formats Twitch renders and flags rounded ones", () => {
    assert.deepEqual(parseBalance("482"), { value: 482, approximate: false });
    assert.deepEqual(parseBalance("12,480"), { value: 12480, approximate: false });
    assert.deepEqual(parseBalance("1.2K"), { value: 1200, approximate: true });
    assert.deepEqual(parseBalance("3.4M"), { value: 3400000, approximate: true });
    assert.equal(parseBalance(""), null);
    assert.equal(parseBalance("Claim"), null);
  });

  it("counts a claim only when the chest actually disappeared", () => {
    const start = emptyPointsEntry("caedrel");
    const confirmed = recordClaim(start, {
      confirmed: true,
      reading: { value: 550, approximate: false },
    });
    assert.equal(confirmed.claims, 1);
    assert.equal(confirmed.unconfirmedClaims, 0);
    assert.equal(confirmed.balance, 550);
    assert.ok(confirmed.lastClaimAt > 0);

    const failed = recordClaim(confirmed, { confirmed: false });
    assert.equal(failed.claims, 1, "a click that changed nothing is not a claim");
    assert.equal(failed.unconfirmedClaims, 1);
    assert.equal(failed.lastClaimAt, confirmed.lastClaimAt);
  });

  // The bug this guards against is the whole reason claims are not measured in
  // points: at 1.2K a fifty point bonus leaves the displayed number identical.
  it("does not infer points earned from a rounded balance", () => {
    const entry = recordClaim(emptyPointsEntry("x"), {
      confirmed: true,
      reading: parseBalance("1.2K"),
    });
    assert.ok(entry.balanceApproximate, "balance must be marked as rounded");
    assert.equal(entry.earned, undefined, "there is no earned figure to trust");
  });

  it("summarises claims across channels", () => {
    const summary = pointsSummary({
      a: { claims: 3, lastClaimAt: 100 },
      b: { claims: 2, lastClaimAt: 500 },
    });
    assert.deepEqual(summary, { channels: 2, claims: 5, lastClaimAt: 500 });
  });
});

describe("channel point claims in the background", () => {
  it("stores a confirmed claim and logs it", async () => {
    mock.reset();
    await recordPointsClaim("caedrel", { confirmed: true, balanceText: "1,050" });

    const points = await getChannelPoints();
    assert.equal(points.caedrel.claims, 1);
    assert.equal(points.caedrel.balance, 1050);

    const activity = await getActivity();
    assert.equal(activity[0].text, "Claimed channel points");
    assert.equal(activity[0].channel, "caedrel");
  });

  it("warns rather than takes credit when the chest stayed put", async () => {
    mock.reset();
    await recordPointsClaim("caedrel", { confirmed: false, balanceText: "1,000" });

    const points = await getChannelPoints();
    assert.equal(points.caedrel.claims, 0);
    assert.equal(points.caedrel.unconfirmedClaims, 1);

    const activity = await getActivity();
    assert.equal(activity[0].level, "warn");
  });

  it("records balances without counting them as claims", async () => {
    mock.reset();
    await recordPointsBalance("caedrel", "2.4K");
    const points = await getChannelPoints();
    assert.equal(points.caedrel.balance, 2400);
    assert.ok(points.caedrel.balanceApproximate);
    assert.equal(points.caedrel.claims, 0);
  });
});

describe("who is allowed to claim", () => {
  it("refuses when the setting is off", async () => {
    mock.reset();
    await saveSettings({ claimChannelPoints: false });
    const config = await getPageConfig(7);
    assert.equal(config.claim, false);
  });

  it("claims on any Twitch tab by default", async () => {
    mock.reset();
    const config = await getPageConfig(7);
    assert.equal(config.claim, true);
    assert.equal(config.managed, false);
  });

  it("restricts to managed tabs when asked", async () => {
    mock.reset({
      storage: {
        [STORAGE_KEYS.MANAGED_TABS]: { 7: { tabId: 7, userId: "1", login: "caedrel" } },
      },
    });
    await saveSettings({ claimOnManagedTabsOnly: true });

    assert.equal((await getPageConfig(7)).claim, true, "managed tab may claim");
    assert.equal((await getPageConfig(8)).claim, false, "unmanaged tab may not");
  });
});

describe("7TV lookups", () => {
  const original = globalThis.fetch;

  function stubFetch(responder) {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return responder(String(url));
    };
    return calls;
  }

  function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  const SAMPLE = {
    user: { id: "01F6M" },
    emote_set: {
      id: "set1",
      name: "caedrel",
      emote_count: 340,
      emotes: [
        { id: "e1", name: "Clueless" },
        { id: "e2", name: "Aware" },
      ],
    },
  };

  async function cleanup() {
    globalThis.fetch = original;
  }

  it("caches a result so the next lookup makes no request", async () => {
    mock.reset();
    const calls = stubFetch(() => jsonResponse(SAMPLE));
    try {
      const first = await getSevenTvForUser("123");
      assert.equal(first.emoteCount, 340);
      assert.equal(first.setName, "caedrel");
      assert.equal(first.emotes[0].url, "https://cdn.7tv.app/emote/e1/1x.webp");
      assert.equal(first.profileUrl, "https://7tv.app/users/01F6M");

      const second = await getSevenTvForUser("123");
      assert.equal(second.emoteCount, 340);
      assert.equal(calls.length, 1, "the second lookup must come from cache");
    } finally {
      await cleanup();
    }
  });

  it("collapses simultaneous lookups for the same channel into one request", async () => {
    mock.reset();
    await clearSevenTvCache();
    const calls = stubFetch(() => jsonResponse(SAMPLE));
    try {
      await Promise.all([getSevenTvForUser("456"), getSevenTvForUser("456")]);
      assert.equal(calls.length, 1);
    } finally {
      await cleanup();
    }
  });

  // A channel with no 7TV presence is the common case, not an error, and must
  // not be re-requested on every poll for the rest of the day.
  it("treats a 404 as a cached answer", async () => {
    mock.reset();
    const calls = stubFetch(() => jsonResponse({}, 404));
    try {
      const entry = await getSevenTvForUser("789");
      assert.ok(entry.absent);
      assert.equal(entry.error, "");
      await getSevenTvForUser("789");
      assert.equal(calls.length, 1);
    } finally {
      await cleanup();
    }
  });

  it("caches a failure instead of retrying in a loop", async () => {
    mock.reset();
    const calls = stubFetch(() => jsonResponse({}, 500));
    try {
      const entry = await getSevenTvForUser("999");
      assert.ok(entry.error, "the failure should be recorded, not thrown");
      await getSevenTvForUser("999");
      assert.equal(calls.length, 1);
    } finally {
      await cleanup();
    }
  });

  it("does nothing at all when the setting is off", async () => {
    mock.reset();
    await saveSettings({ sevenTvEnabled: false });
    const calls = stubFetch(() => jsonResponse(SAMPLE));
    try {
      assert.equal(await getSevenTvForUser("123"), null);
      await prefetchSevenTv([{ userId: "123", isLive: true }]);
      assert.equal(calls.length, 0);
    } finally {
      await cleanup();
    }
  });

  it("bounds how many channels a single poll refreshes", async () => {
    mock.reset();
    const calls = stubFetch(() => jsonResponse(SAMPLE));
    try {
      const streams = Array.from({ length: 20 }, (_, index) => ({
        userId: String(2000 + index),
        isLive: true,
      }));
      await prefetchSevenTv(streams);
      assert.equal(calls.length, 6, "a poll must not become a burst of traffic");
    } finally {
      await cleanup();
    }
  });
});
