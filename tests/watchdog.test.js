import { readFile } from "node:fs/promises";
import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";
import { HEALTH } from "../shared/health.js";
import {
  heartbeatPayload,
  heartbeatStatusPayload,
  watchdogRefusalDetail,
  normalizeWatchdog,
  parseLoopbackEndpoint,
  readWatchdogReply,
  watchdogFormState,
  watchdogPeriodMinutes,
  watchdogRecoveryTarget,
  watchdogStatusText,
} from "../shared/watchdog-logic.js";
import {
  acknowledgeWatchdogEvents,
  emptyWatchdogLedger,
  foldWatchdogLedger,
  heartbeatReport,
} from "../shared/watchdog-telemetry.js";

const mock = chromeMock();

describe("local monitor decisions", () => {
  it("stays off until this install turns it on", () => {
    const config = normalizeWatchdog({});
    assert.equal(config.enabled, false);
    assert.equal(config.endpoint, "");
    assert.equal(config.token, "");
    assert.equal(config.recover, false);
    assert.equal(config.intervalSeconds, 30);
    assert.equal(watchdogPeriodMinutes(30), 0.5);
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
    assert.equal(body.at, 10);
    assert.equal(heartbeatPayload({ at: 1_790_772_771_003 }).at, 1_790_772_771_003);
    const shaped = heartbeatStatusPayload(body);
    assert.equal(shaped.status, "OK");
    assert.equal(shaped.extension, undefined);
    assert.equal(shaped.at, 10);
    assert.equal(
      watchdogRefusalDetail({ error: "missing streams" }, "", 400),
      "missing streams"
    );
    assert.equal(
      watchdogRefusalDetail(null, "<html><p>Message: expected unix time</p></html>", 400),
      "expected unix time"
    );
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
    const warning = readWatchdogReply(
      { status: "STREAM_WARNING", report: { playing: 0, stalled: 4 } },
      true
    );
    assert.equal(warning.ok, true);
    assert.equal(warning.recover, true);
    assert.equal(
      watchdogRecoveryTarget({ enabled: true, recover: false }, warning, managed),
      null
    );
    assert.equal(
      watchdogRecoveryTarget({ enabled: true, recover: true }, warning, {
        "7": { tabId: 7, health: HEALTH.STALLED, lastRecoveryAt: Date.now() },
        "8": { tabId: 8, health: HEALTH.FAILED, lastRecoveryAt: 0 },
      }),
      8
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
      assert.equal(mock.session.watchdogSession, undefined);
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
      const body = JSON.parse(seen.init.body);
      assert.equal(seen.url, "http://127.0.0.1:8765/heartbeat");
      assert.equal(seen.init.headers.Authorization, "Bearer monitor-secret");
      assert.equal(seen.init.body.includes("monitor-secret"), false);
      assert.equal(body.schemaVersion, 2);
      assert.equal(body.extension, "autolurk");
      assert.equal(body.managed, 1);
      assert.equal(body.playing, 1);
      assert.equal(body.stalled, 0);
      assert.equal(body.at > 1_000_000_000_000, true);
      assert.equal(body.streams.length, 1);
      assert.equal(body.streams[0].channel, "one");
      assert.equal(body.streams[0].watchStreak.count, null);
      assert.equal(body.streams[0].channelPoints.balance, null);
      assert.equal(body.instanceId.includes("r640"), false);
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

  it("tries the status shape when the first report is refused", async () => {
    mock.reset({ storage: { settings: { automationEnabled: false }, managedTabs: {} } });
    await mock.chrome.permissions.request({ origins: ["http://127.0.0.1/*"] });
    const bodies = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return { ok: false, status: 400, text: async () => "" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "OK", message: "stored" }) };
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
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].extension, "autolurk");
      assert.equal(bodies[0].schemaVersion, 2);
      assert.equal(bodies[1].status, "OK");
      assert.equal(bodies[1].extension, undefined);
      assert.equal(form.lastOk, true);
      assert.equal(mock.session.watchdogSession.events.length > 0, true);
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

describe("watchdog schema 2", () => {
  function ledgerAt(now) {
    return { ...emptyWatchdogLedger(now), sessionId: "session-1", startedAt: now };
  }

  it("keeps the original counts and leaves unknown measurements empty", () => {
    const now = 1_790_774_874_469;
    const { ledger, streams } = foldWatchdogLedger(ledgerAt(now - 1000), {
      now,
      managed: {
        "4": {
          tabId: 4,
          login: "Example_Channel",
          health: HEALTH.MEDIA_PLAYING,
          muted: true,
          streamId: "live",
          lastAdvanceAt: now - 50,
          selectedQuality: "160p",
          videoWidth: 284,
          videoHeight: 160,
        },
        "5": { tabId: 5, login: "second", health: HEALTH.BOOTING },
      },
      points: {},
    });
    const report = heartbeatReport({
      version: "1.2.38",
      at: now,
      managed: 2,
      playing: 1,
      stalled: 0,
      instanceId: "11111111-1111-4111-8111-111111111111",
      sessionId: ledger.sessionId,
      startedAt: ledger.startedAt,
      streams,
      events: ledger.events,
    });
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.extension, "autolurk");
    assert.equal(report.managed, 2);
    assert.equal(report.playing, 1);
    assert.equal(report.stalled, 0);
    assert.equal(report.at, now);
    assert.equal(report.streams.length, 2);
    assert.equal(report.streams[0].channel, "example_channel");
    assert.equal(report.streams[0].state, "PLAYING");
    assert.equal(report.streams[0].muted, true);
    assert.equal(report.streams[0].decodedFrames, null);
    assert.equal(report.streams[0].channelPoints.balance, null);
    assert.equal(report.streams[0].channelPoints.successfulClaims, null);
    assert.equal(report.streams[1].watchStreak.count, null);
    assert.equal(report.streams[1].watchStreak.successfulClaims, null);
    assert.equal(JSON.stringify(report).includes("monitor-secret"), false);
  });

  it("records one pause and does not call it a stall", () => {
    const start = ledgerAt(1_000);
    const first = foldWatchdogLedger(start, {
      now: 2_000,
      managed: {
        "9": { tabId: 9, login: "quiet", health: HEALTH.STALLED, healthReason: "player is paused" },
      },
    });
    const second = foldWatchdogLedger(first.ledger, {
      now: 32_000,
      managed: {
        "9": { tabId: 9, login: "quiet", health: HEALTH.STALLED, healthReason: "player is paused" },
      },
    });
    assert.equal(first.streams[0].state, "PAUSED");
    assert.equal(first.streams[0].stallCount, 0);
    assert.equal(first.streams[0].pauseCount, 1);
    assert.equal(first.streams[0].lastFailureCategory, null);
    assert.equal(second.streams[0].pauseCount, 1);
    assert.equal(second.ledger.events.filter((event) => event.type === "playback-paused").length, 1);
    assert.equal(second.ledger.events.filter((event) => event.type === "playback-stalled").length, 0);
  });

  it("emits one stall and one recovery, then drops them only after acknowledgement", () => {
    const start = ledgerAt(10_000);
    const stalled = foldWatchdogLedger(start, {
      now: 20_000,
      managed: {
        "3": { tabId: 3, login: "held", health: HEALTH.STALLED, healthReason: "video froze", recoveryAttempts: 1 },
      },
    });
    const still = foldWatchdogLedger(stalled.ledger, {
      now: 50_000,
      managed: {
        "3": { tabId: 3, login: "held", health: HEALTH.STALLED, healthReason: "video froze", recoveryAttempts: 1 },
      },
    });
    assert.equal(still.streams[0].stallCount, 1);
    assert.equal(still.ledger.events.filter((event) => event.type === "playback-stalled").length, 1);
    const kept = acknowledgeWatchdogEvents(still.ledger, []);
    assert.equal(kept.events.length, still.ledger.events.length);
    const playing = foldWatchdogLedger(kept, {
      now: 80_000,
      managed: { "3": { tabId: 3, login: "held", health: HEALTH.MEDIA_PLAYING, recoveryAttempts: 0 } },
    });
    assert.equal(playing.streams[0].successfulRecoveries, 1);
    assert.equal(playing.ledger.events.filter((event) => event.type === "playback-recovered").length, 1);
    const again = foldWatchdogLedger(playing.ledger, {
      now: 110_000,
      managed: { "3": { tabId: 3, login: "held", health: HEALTH.MEDIA_PLAYING, lastAdvanceAt: 110_000 } },
    });
    assert.equal(again.ledger.events.filter((event) => event.type === "playback-recovered").length, 1);
    assert.equal(again.streams[0].sessionPlaybackSeconds, 30);
    const acked = acknowledgeWatchdogEvents(
      again.ledger,
      again.ledger.events.map((event) => event.id)
    );
    assert.equal(acked.events.length, 0);
    const after = foldWatchdogLedger(acked, {
      now: 140_000,
      managed: { "3": { tabId: 3, login: "held", health: HEALTH.MEDIA_PLAYING, lastAdvanceAt: 140_000 } },
    });
    assert.equal(after.ledger.events.length, 0);
  });

  it("counts a confirmed claim separately from a balance change", () => {
    const start = ledgerAt(5_000);
    const seen = foldWatchdogLedger(start, {
      now: 6_000,
      managed: { "2": { tabId: 2, login: "points", health: HEALTH.MEDIA_PLAYING } },
      points: { points: { balance: 1000, balanceApproximate: false, claims: 2, unconfirmedClaims: 1, lastClaimAt: 0 } },
    });
    const claimed = foldWatchdogLedger(seen.ledger, {
      now: 7_000,
      managed: { "2": { tabId: 2, login: "points", health: HEALTH.MEDIA_PLAYING } },
      points: { points: { balance: 1400, balanceApproximate: false, claims: 3, unconfirmedClaims: 1, lastClaimAt: 7_000 } },
    });
    assert.equal(claimed.streams[0].channelPoints.balance, 1400);
    assert.equal(claimed.streams[0].channelPoints.observedBalanceChange, 400);
    assert.equal(claimed.streams[0].channelPoints.successfulClaims, 3);
    assert.equal(claimed.streams[0].channelPoints.failedClaims, 1);
    assert.equal(claimed.ledger.events.filter((event) => event.type === "bonus-claimed").length, 1);
    assert.equal(claimed.streams[0].watchStreak.count, null);
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
