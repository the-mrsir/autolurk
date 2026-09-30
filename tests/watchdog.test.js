import { readFile } from "node:fs/promises";
import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";
import { HEALTH } from "../shared/health.js";
import {
  heartbeatPayload,
  normalizeWatchdog,
  parseLoopbackEndpoint,
  readWatchdogReply,
  watchdogFormState,
  watchdogRecoveryTarget,
  watchdogStatusText,
} from "../shared/watchdog-logic.js";

const mock = chromeMock();

describe("local monitor decisions", () => {
  it("stays off until this install turns it on", () => {
    const config = normalizeWatchdog({});
    assert.equal(config.enabled, false);
    assert.equal(config.endpoint, "");
    assert.equal(config.token, "");
    assert.equal(config.recover, false);
    assert.equal(watchdogStatusText(config), "Off.");
  });

  it("accepts only an address on this computer", () => {
    assert.equal(parseLoopbackEndpoint("http://127.0.0.1:8765/heartbeat"), "http://127.0.0.1:8765/heartbeat");
    assert.equal(parseLoopbackEndpoint("http://localhost/status"), "http://localhost/status");
    assert.equal(parseLoopbackEndpoint("https://example.com/heartbeat"), "");
    assert.equal(parseLoopbackEndpoint("http://192.168.1.20/heartbeat"), "");
    assert.equal(parseLoopbackEndpoint("http://user:secret@127.0.0.1/heartbeat"), "");
  });

  it("keeps the token out of the form state and the status line", () => {
    const config = normalizeWatchdog({
      enabled: true,
      endpoint: "http://127.0.0.1:9/heartbeat",
      token: "monitor-secret",
      lastAt: 1,
      lastOk: false,
      lastError: "unauthorized",
    });
    const form = watchdogFormState(config);
    assert.equal(form.hasToken, true);
    assert.equal("token" in form, false);
    const text = watchdogStatusText(config);
    assert.equal(text.includes("monitor-secret"), false);
    assert.equal(text.includes("127.0.0.1"), false);
    assert.equal(text, "The monitor refused the token.");
  });

  it("sends a report with no address and no token in the body", () => {
    const body = heartbeatPayload({ version: "1.2.28", managed: 4, playing: 3, stalled: 1, at: 10 });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("127.0.0.1"), false);
    assert.equal(serialized.includes("token"), false);
    assert.equal(body.managed, 4);
    assert.equal(body.playing, 3);
  });

  it("recovers a stalled stream only when this install asked for that", () => {
    const managed = { "7": { tabId: 7, health: HEALTH.STALLED } };
    const reply = readWatchdogReply({ ok: true, recover: true, notify: "check <script>" }, true);
    assert.equal(reply.notify, "check script");
    assert.equal(readWatchdogReply({ status: "OK", message: "stored" }, true).ok, true);
    assert.equal(readWatchdogReply(null, true).ok, true);
    const waiting = readWatchdogReply({ status: "WAITING", message: "No heartbeat received yet" }, true);
    assert.equal(waiting.ok, false);
    assert.equal(waiting.detail, "No heartbeat received yet");
    const missing = readWatchdogReply({ detail: [{ msg: "Field required" }] }, false);
    assert.equal(missing.ok, false);
    assert.equal(missing.detail, "Field required");
    assert.equal(
      watchdogStatusText({
        enabled: true,
        endpoint: "http://127.0.0.1:9/heartbeat",
        lastAt: 1,
        lastOk: false,
        lastError: "rejected",
        lastDetail: "Field required",
      }),
      "The monitor refused the report. Field required"
    );
    assert.equal(
      watchdogRecoveryTarget({ enabled: true, recover: false }, reply, managed),
      null
    );
    assert.equal(
      watchdogRecoveryTarget({ enabled: true, recover: true }, reply, managed),
      7
    );
    assert.equal(
      watchdogRecoveryTarget(
        { enabled: true, recover: true },
        { recover: true },
        { "7": { tabId: 7, health: HEALTH.MEDIA_PLAYING } }
      ),
      null
    );
  });
});

describe("local monitor runtime", () => {
  it("does not report, schedule, or keep a token in a backup while it is off", async () => {
    mock.reset({
      storage: {
        watchdog: { enabled: false, token: "monitor-secret", endpoint: "http://127.0.0.1:9/heartbeat" },
      },
    });
    let fetched = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched += 1;
      throw new Error("should not report");
    };
    try {
      const { runWatchdogHeartbeat } = await import("../background/watchdog.js");
      const { exportData } = await import("../background/sync.js");
      const form = await runWatchdogHeartbeat();
      const backup = JSON.stringify(await exportData());
      assert.equal(fetched, 0);
      assert.equal(mock.alarms.has("external-watchdog"), false);
      assert.equal(form.enabled, false);
      assert.equal("token" in form, false);
      assert.equal(backup.includes("monitor-secret"), false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports to loopback with the token in the header only", async () => {
    mock.reset({
      storage: {
        settings: { automationEnabled: false },
        managedTabs: { "3": { tabId: 3, health: HEALTH.MEDIA_PLAYING, login: "one" } },
      },
    });
    await mock.chrome.permissions.request({ origins: ["http://127.0.0.1/*"] });
    let seen = null;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    try {
      const { saveWatchdogSettings } = await import("../background/watchdog.js");
      const form = await saveWatchdogSettings({
        enabled: true,
        endpoint: "http://127.0.0.1:8765/heartbeat",
        token: "monitor-secret",
        tokenSet: true,
        intervalSeconds: 60,
        recover: false,
      });
      assert.equal(seen.url, "http://127.0.0.1:8765/heartbeat");
      assert.equal(seen.init.headers.Authorization, "Bearer monitor-secret");
      assert.equal(seen.init.body.includes("monitor-secret"), false);
      assert.equal(form.lastOk, true);
      assert.equal("token" in form, false);
      assert.equal(form.hasToken, true);
      assert.equal(mock.alarms.has("external-watchdog"), true);
      const kept = await saveWatchdogSettings({
        enabled: true,
        endpoint: "http://127.0.0.1:8765/heartbeat",
        intervalSeconds: 120,
        recover: false,
      });
      assert.equal(kept.hasToken, true);
      assert.equal(mock.local.watchdog.token, "monitor-secret");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses a remote address and does not request it", async () => {
    mock.reset({ storage: {} });
    let fetched = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    try {
      const { saveWatchdogSettings } = await import("../background/watchdog.js");
      let message = "";
      try {
        await saveWatchdogSettings({
          enabled: true,
          endpoint: "https://example.com/heartbeat",
          token: "monitor-secret",
          tokenSet: true,
          intervalSeconds: 60,
          recover: true,
        });
      } catch (error) {
        message = error.message;
      }
      assert.ok(message.includes("this computer"));
      assert.equal(fetched, 0);
      assert.equal(mock.alarms.has("external-watchdog"), false);
      assert.equal(JSON.stringify(mock.local.watchdog || {}).includes("example.com"), false);
      assert.equal(JSON.stringify(mock.local.watchdog || {}).includes("monitor-secret"), false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("local monitor is not part of the normal pages", () => {
  it("is not linked from the dashboard navigation", async () => {
    const html = await readFile(new URL("../dashboard/dashboard.html", import.meta.url), "utf8");
    const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
    assert.equal(nav.includes("developer"), false);
    assert.equal(nav.includes("watchdog"), false);
    assert.equal(nav.includes("heartbeat"), false);
  });
});
