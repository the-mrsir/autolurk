import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";

const mock = chromeMock();

// Fresh state before the worker module evaluates: importing it is the test.
mock.reset({ storage: { settings: { checkIntervalSeconds: 120 } } });

const { ALARMS, MESSAGE } = await import("../shared/constants.js");
// A syntax error, a bad import or a throw at module scope leaves the real
// service worker dead with no visible symptom other than nothing happening.
await import("../background/service-worker.js");

// Snapshot the alarm table as it stands just after the worker booted. Later
// suites reset the mock, so the wake behaviour has to be captured here.
await new Promise((resolve) => setTimeout(resolve, 20));
const alarmsAtWake = new Map(mock.alarms);

describe("service worker wake", () => {
  it("registers the alarms it needs without polling Twitch", () => {
    assert.ok(alarmsAtWake.has(ALARMS.POLL_LIVE));
    assert.ok(alarmsAtWake.has(ALARMS.HEALTH_CHECK));
    assert.ok(alarmsAtWake.has(ALARMS.SYNC_FOLLOWS));
    assert.ok(alarmsAtWake.has(ALARMS.VALIDATE_TOKEN));
    assert.ok(alarmsAtWake.has(ALARMS.STREAK_CHECK));
    assert.equal(alarmsAtWake.get(ALARMS.STREAK_CHECK).periodInMinutes, 60);
    assert.ok(alarmsAtWake.has(ALARMS.UPDATE_CHECK));
    assert.equal(alarmsAtWake.get(ALARMS.UPDATE_CHECK).periodInMinutes, 720);
  });

  it("honours the saved interval instead of resetting it", () => {
    assert.equal(alarmsAtWake.get(ALARMS.POLL_LIVE).periodInMinutes, 2);
  });

  it("clears alarms belonging to removed features", () => {
    assert.notOk(alarmsAtWake.has("drops-reminder"));
  });

  it("does not create a device-poll alarm until sign-in starts", () => {
    assert.notOk(alarmsAtWake.has(ALARMS.DEVICE_POLL));
  });
});

describe("starting up twice at once", () => {
  it("folds an install and a startup into one run", async () => {
    // Chrome fires both after an update. Running the whole setup twice
    // rebuilds the alarm schedule a second time, which re-randomises the poll
    // jitter and spends another Twitch call on an answer already in hand.
    mock.reset({
      storage: {
        settings: { checkIntervalSeconds: 300 },
        meta: { schemaVersion: 3 },
      },
    });

    const realCreate = mock.chrome.alarms.create;
    let created = 0;
    mock.chrome.alarms.create = (...args) => {
      created += 1;
      return realCreate(...args);
    };

    try {
      mock.fireInstalled();
      mock.fireStartup();
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      mock.chrome.alarms.create = realCreate;
    }

    const specs = [
      ALARMS.POLL_LIVE,
      ALARMS.SYNC_FOLLOWS,
      ALARMS.VALIDATE_TOKEN,
      ALARMS.HEALTH_CHECK,
      ALARMS.STREAK_CHECK,
      ALARMS.UPDATE_CHECK,
    ];
    assert.equal(created, specs.length, `the schedule was rebuilt ${created / specs.length} times`);
  });
});

describe("message sender authorization", () => {
  it("refuses privileged actions from a Twitch page", async () => {
    const response = await mock.dispatchMessage(
      { type: MESSAGE.UPDATE_SETTINGS, patch: { automationEnabled: false } },
      { tab: { id: 1 }, url: "https://www.twitch.tv/streamer" }
    );
    assert.equal(response.ok, false);
    assert.ok(String(response.error).includes("AutoLurk UI"));
  });

  it("allows the same action from an extension page", async () => {
    const response = await mock.dispatchMessage(
      { type: MESSAGE.UPDATE_SETTINGS, patch: { maxAutoOpenStreams: 4 } },
      { url: "chrome-extension://test/dashboard/dashboard.html" }
    );
    assert.equal(response.ok, true);
    assert.equal(response.result.maxAutoOpenStreams, 4);
  });

  it("answers a managed-tab question only about the sending tab", async () => {
    await chrome.storage.local.set({ managedTabs: { "5": { tabId: 5, userId: "5" } } });
    const yes = await mock.dispatchMessage({ type: MESSAGE.AM_I_MANAGED }, { tab: { id: 5 } });
    const no = await mock.dispatchMessage({ type: MESSAGE.AM_I_MANAGED }, { tab: { id: 6 } });
    assert.equal(yes.result, true);
    assert.equal(no.result, false);
  });
});
