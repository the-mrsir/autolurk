import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";

const mock = chromeMock();

const {
  getAuth,
  getLiveState,
  getManagedTabs,
  getMeta,
  mutateLiveState,
  mutateManagedTabs,
  mutateMeta,
  mutateSessionValue,
  saveAuth,
  saveMeta,
  updateManagedTab,
} = await import("../shared/storage.js");

function managedEntry(tabId, extra = {}) {
  return { tabId, userId: String(tabId), login: `user${tabId}`, ...extra };
}

describe("serialized storage mutations", () => {
  it("does not lose a concurrent write to a different field", async () => {
    // The original bug: two read-modify-write cycles overlapped and the second
    // one wrote back a snapshot taken before the first, dropping userUnmuted.
    mock.reset({ storage: { managedTabs: { "1": managedEntry(1, { muted: true }) } } });

    await Promise.all([
      updateManagedTab(1, { userUnmuted: true }),
      updateManagedTab(1, { muted: false }),
      updateManagedTab(1, { health: "media_playing" }),
    ]);

    const managed = await getManagedTabs();
    assert.equal(managed["1"].userUnmuted, true);
    assert.equal(managed["1"].muted, false);
    assert.equal(managed["1"].health, "media_playing");
  });

  it("applies every concurrent insert", async () => {
    mock.reset({ storage: { managedTabs: {} } });

    await Promise.all(
      [1, 2, 3, 4, 5].map((id) =>
        mutateManagedTabs((managed) => {
          managed[String(id)] = managedEntry(id);
          return managed;
        })
      )
    );

    assert.equal(Object.keys(await getManagedTabs()).length, 5);
  });

  it("keeps concurrent metadata patches from clobbering each other", async () => {
    mock.reset({ storage: {} });

    await Promise.all([
      saveMeta({ lastPollAt: 111 }),
      saveMeta({ lastFollowsSyncAt: 222 }),
      mutateMeta((meta) => ({ ...meta, groupIds: { "1": 9 } })),
    ]);

    const meta = await getMeta();
    assert.equal(meta.lastPollAt, 111);
    assert.equal(meta.lastFollowsSyncAt, 222);
    assert.deepEqual(meta.groupIds, { "1": 9 });
  });

  it("skips the write when a mutator returns undefined", async () => {
    mock.reset({ storage: { managedTabs: { "1": managedEntry(1) } } });
    await updateManagedTab(99, { muted: true });
    assert.deepEqual(Object.keys(await getManagedTabs()), ["1"]);
  });

  it("keeps a single-channel refresh from being clobbered by a poll", async () => {
    // A poll reads the whole live map, spends seconds on the network, then
    // writes it back. A refresh for one channel that lands in between used to
    // disappear, because the poll's write was a bare set rather than a queued
    // read-modify-write.
    mock.reset({ storage: { liveState: { "1": { userId: "1", observedAt: 10 } } } });

    await Promise.all([
      mutateLiveState((live) => ({ ...live, "1": { userId: "1", observedAt: 20 } })),
      mutateLiveState((live) => ({ ...live, "2": { userId: "2", observedAt: 20 } })),
    ]);

    const live = await getLiveState();
    assert.equal(live["1"].observedAt, 20);
    assert.ok(live["2"], "the concurrent refresh was lost");
  });

  it("does not let a token write and a profile write cross", async () => {
    mock.reset({ storage: {} });

    await Promise.all([
      saveAuth({ accessToken: "first", userId: "self" }),
      saveAuth({ accessToken: "second", userId: "self", login: "me" }),
    ]);

    const auth = await getAuth();
    assert.equal(auth.accessToken, "second");
    assert.equal(auth.login, "me");
  });

  it("serializes session values the same way", async () => {
    mock.reset({ storage: {} });
    await Promise.all(
      [1, 2, 3].map((id) =>
        mutateSessionValue("programmaticCloses", {}, (map) => ({ ...map, [id]: id }))
      )
    );
    const value = await mutateSessionValue("programmaticCloses", {}, (map) => map);
    assert.equal(Object.keys(value).length, 3);
  });
});
