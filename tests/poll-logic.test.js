import { assert, describe, it } from "./harness.js";
import {
  classifyPoll,
  mergeLiveState,
  offlineCandidates,
  POLL_STATUS,
  streamIsOpenable,
} from "../shared/poll-logic.js";

const stream = (userId, extra = {}) => ({
  userId,
  streamId: `s-${userId}`,
  login: `user${userId}`,
  isLive: true,
  ...extra,
});

describe("classifyPoll", () => {
  it("reports ok when both queries succeed", () => {
    assert.equal(classifyPoll({}), POLL_STATUS.OK);
  });

  it("reports partial when only one query fails", () => {
    assert.equal(classifyPoll({ followedFailure: "network" }), POLL_STATUS.PARTIAL);
    assert.equal(classifyPoll({ favoriteFailure: "server" }), POLL_STATUS.PARTIAL);
  });

  it("reports failed when both queries fail", () => {
    assert.equal(
      classifyPoll({ followedFailure: "network", favoriteFailure: "network" }),
      POLL_STATUS.FAILED
    );
  });

  it("treats an expired token as unauthorized even if the other call worked", () => {
    assert.equal(classifyPoll({ followedFailure: "unauthorized" }), POLL_STATUS.UNAUTHORIZED);
  });
});

describe("mergeLiveState", () => {
  it("marks a covered channel offline by dropping it", () => {
    const { live, covered } = mergeLiveState({
      previousLive: { "1": stream("1") },
      followedStreams: [],
      favoriteStreams: {},
      followIds: ["1"],
      favoriteIds: ["1"],
    });
    assert.notOk(live["1"], "channel should be gone once a good poll says it is offline");
    assert.ok(covered.has("1"));
  });

  it("keeps the last known state when the poll could not see the channel", () => {
    // This is the outage case: both calls failed, so nothing is authoritative.
    const { live, covered } = mergeLiveState({
      previousLive: { "1": stream("1") },
      followedStreams: null,
      favoriteStreams: null,
      followIds: ["1"],
      favoriteIds: ["1"],
    });
    assert.ok(live["1"], "an unreachable Twitch must not look like everyone went offline");
    assert.equal(live["1"].stale, true);
    assert.equal(covered.size, 0);
  });

  it("only covers the favorites it asked about when the followed walk failed", () => {
    const { live, covered } = mergeLiveState({
      previousLive: { "1": stream("1"), "2": stream("2") },
      followedStreams: null,
      favoriteStreams: {},
      followIds: ["1", "2"],
      favoriteIds: ["1"],
    });
    assert.notOk(live["1"], "the favorite was queried and is offline");
    assert.ok(live["2"], "the non-favorite was never queried, so it stays");
    assert.equal(live["2"].stale, true);
    assert.deepEqual([...covered], ["1"]);
  });

  it("clears the stale flag when a channel is seen again", () => {
    const { live } = mergeLiveState({
      previousLive: { "1": { ...stream("1"), stale: true } },
      followedStreams: [stream("1")],
      favoriteStreams: {},
      followIds: ["1"],
      favoriteIds: [],
    });
    assert.equal(live["1"].stale, false);
  });
});

describe("streamIsOpenable", () => {
  it("rejects a leftover live row that is stale or offline", () => {
    assert.equal(streamIsOpenable(stream("1")), true);
    assert.equal(streamIsOpenable({ ...stream("1"), stale: true }), false);
    assert.equal(streamIsOpenable({ ...stream("1"), isLive: false }), false);
    assert.equal(streamIsOpenable({ ...stream("1"), streamId: "" }), false);
    assert.equal(streamIsOpenable(null), false);
  });
});

describe("offlineCandidates", () => {
  it("never proposes closing a channel the poll could not see", () => {
    const candidates = offlineCandidates({
      managedEntries: [{ userId: "1" }, { userId: "2" }],
      live: {},
      covered: new Set(["1"]),
    });
    assert.deepEqual(candidates.map((entry) => entry.userId), ["1"]);
  });

  it("proposes nothing while the channel is still live", () => {
    const candidates = offlineCandidates({
      managedEntries: [{ userId: "1" }],
      live: { "1": stream("1") },
      covered: new Set(["1"]),
    });
    assert.equal(candidates.length, 0);
  });
});
