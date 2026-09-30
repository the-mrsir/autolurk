// Optional local monitor. Off on every install until this computer turns it on.
// While it is off this file's callers clear the alarm and return. They do not
// fetch, and they do not ask Chrome for localhost access.

import { ALARMS, SESSION_KEYS } from "../shared/constants.js";
import {
  getChannelPoints,
  getManagedTabs,
  getSessionValue,
  getWatchdog,
  saveWatchdogRecord,
  setSessionValue,
} from "../shared/storage.js";
import {
  LOOPBACK_PATTERNS,
  heartbeatStatusPayload,
  loopbackPermissionPattern,
  normalizeWatchdog,
  readWatchdogReply,
  watchdogRefusalDetail,
  streamCounts,
  watchdogFormState,
  watchdogPeriodMinutes,
  watchdogRecoveryTarget,
} from "../shared/watchdog-logic.js";
import {
  acknowledgeWatchdogEvents,
  emptyWatchdogLedger,
  foldWatchdogLedger,
  heartbeatReport,
} from "../shared/watchdog-telemetry.js";
import { requestRecovery } from "./stream-boot.js";

const REPORT_TIMEOUT_MS = 5000;

async function permissionGranted(endpoint) {
  if (!chrome.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains({ origins: [loopbackPermissionPattern(endpoint)] });
  } catch {
    return false;
  }
}

async function releaseLoopback() {
  if (!chrome.permissions?.remove) return;
  try {
    await chrome.permissions.remove({ origins: LOOPBACK_PATTERNS });
  } catch {
    // Leaving a granted optional origin behind is harmless while the alarm is gone.
  }
}

export async function parkWatchdog() {
  const config = await getWatchdog();
  if (!config.enabled || !config.endpoint) {
    await chrome.alarms.clear(ALARMS.WATCHDOG);
    return config;
  }
  const minutes = watchdogPeriodMinutes(config.intervalSeconds);
  const existing = await chrome.alarms.get(ALARMS.WATCHDOG);
  if (existing?.periodInMinutes === minutes) return config;
  await chrome.alarms.create(ALARMS.WATCHDOG, {
    delayInMinutes: minutes,
    periodInMinutes: minutes,
  });
  return config;
}

function note(config, patch) {
  return saveWatchdogRecord({ ...config, lastDetail: "", ...patch, lastAt: Date.now() });
}

async function notifyLocal(message) {
  const text = String(message || "").trim();
  if (!text) return;
  try {
    await chrome.notifications.create("local-monitor", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "AutoLurk",
      message: text,
      contextMessage: "AutoLurk",
      priority: 0,
    });
  } catch {
    // A missing icon or a denied notification is not a reason to retry the report.
  }
}

function postReport(config, payload) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  const request = fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: controller.signal,
  });
  return request.finally(() => clearTimeout(timer));
}

async function responseDetail(response) {
  let body = null;
  let raw = "";
  try {
    if (typeof response.text === "function") {
      raw = await response.text();
      if (raw) body = JSON.parse(raw);
    } else if (typeof response.json === "function") {
      body = await response.json();
    }
  } catch {
    body = null;
  }
  const reply = readWatchdogReply(body, response.ok);
  return {
    body,
    raw,
    reply,
    detail: reply.detail || watchdogRefusalDetail(body, raw, response.status),
  };
}

async function composeReport(config) {
  const now = Date.now();
  let live = config;
  if (!live.instanceId) {
    live = await saveWatchdogRecord({ ...live, instanceId: crypto.randomUUID() });
  }
  const managed = await getManagedTabs();
  const stored = await getSessionValue(SESSION_KEYS.WATCHDOG, null);
  const ledger = stored && typeof stored === "object" ? { ...stored } : emptyWatchdogLedger(now);
  if (!ledger.sessionId) {
    ledger.sessionId = crypto.randomUUID();
    ledger.startedAt = now;
  }
  const folded = foldWatchdogLedger(ledger, {
    managed,
    points: await getChannelPoints(),
    now,
  });
  await setSessionValue(SESSION_KEYS.WATCHDOG, folded.ledger);
  const counts = streamCounts(managed);
  return {
    config: live,
    payload: heartbeatReport({
      version: chrome.runtime.getManifest?.()?.version || "",
      at: now,
      ...counts,
      instanceId: live.instanceId,
      sessionId: folded.ledger.sessionId,
      startedAt: folded.ledger.startedAt,
      streams: folded.streams,
      events: folded.ledger.events,
    }),
  };
}

async function ackSent(payload, body) {
  const ids = Array.isArray(body?.ackedEventIds)
    ? body.ackedEventIds
    : (payload.events || []).map((event) => event.id);
  const stored = await getSessionValue(SESSION_KEYS.WATCHDOG, null);
  if (!stored) return;
  await setSessionValue(SESSION_KEYS.WATCHDOG, acknowledgeWatchdogEvents(stored, ids));
}

export async function runWatchdogHeartbeat() {
  let config = await getWatchdog();
  if (!config.enabled) {
    await chrome.alarms.clear(ALARMS.WATCHDOG);
    return watchdogFormState(config);
  }
  if (!config.endpoint) {
    await chrome.alarms.clear(ALARMS.WATCHDOG);
    return watchdogFormState(await note(config, { lastOk: false, lastError: "address" }));
  }
  if (!(await permissionGranted(config.endpoint))) {
    await chrome.alarms.clear(ALARMS.WATCHDOG);
    return watchdogFormState(await note(config, { lastOk: false, lastError: "permission" }));
  }

  const composed = await composeReport(config);
  config = composed.config;
  const payload = composed.payload;
  let response;
  let detailAccepted = true;
  try {
    response = await postReport(config, payload);
  } catch {
    return watchdogFormState(await note(config, { lastOk: false, lastError: "unreachable" }));
  }
  if (response.status === 400) {
    detailAccepted = false;
    const first = await responseDetail(response);
    let retry;
    try {
      retry = await postReport(config, heartbeatStatusPayload(payload));
    } catch {
      return watchdogFormState(await note(config, { lastOk: false, lastError: "unreachable" }));
    }
    if (retry.status === 400) {
      const second = await responseDetail(retry);
      const detail = first.detail !== "400" ? first.detail : second.detail;
      return watchdogFormState(
        await note(config, { lastOk: false, lastError: "rejected", lastDetail: detail })
      );
    }
    response = retry;
  }

  if (response.status === 401 || response.status === 403) {
    return watchdogFormState(await note(config, { lastOk: false, lastError: "unauthorized" }));
  }

  let body = null;
  let raw = "";
  try {
    if (typeof response.text === "function") {
      raw = await response.text();
      body = raw ? JSON.parse(raw) : null;
    } else if (typeof response.json === "function") {
      body = await response.json();
    }
  } catch {
    body = null;
  }
  const reply = readWatchdogReply(body, response.ok);
  if (!response.ok || !reply.ok) {
    return watchdogFormState(
      await note(config, {
        lastOk: false,
        lastError: "rejected",
        lastDetail: reply.detail || watchdogRefusalDetail(body, raw, response.status),
      })
    );
  }

  if (detailAccepted) await ackSent(payload, body);

  let notice = reply.notify;
  const tabId = watchdogRecoveryTarget(config, reply, await getManagedTabs());
  if (tabId != null) {
    try {
      await requestRecovery(tabId, "local monitor");
      if (!notice) notice = "A stream was asked to start again.";
    } catch {
      if (!notice) notice = "A stream could not be recovered.";
    }
  }
  await notifyLocal(notice);
  return watchdogFormState(await note(config, { lastOk: true, lastError: "", lastDetail: "" }));
}

export async function saveWatchdogSettings(patch = {}) {
  const current = await getWatchdog();
  const token = patch.tokenSet ? String(patch.token || "").slice(0, 256) : current.token;
  const next = normalizeWatchdog({
    ...current,
    enabled: patch.enabled === true,
    endpoint: patch.endpoint,
    intervalSeconds: patch.intervalSeconds,
    recover: patch.recover === true,
    token,
  });
  if (next.enabled && !next.endpoint) {
    throw new Error("The address has to be on this computer.");
  }
  if (next.enabled && !(await permissionGranted(next.endpoint))) {
    throw new Error("Local access was not allowed.");
  }
  await saveWatchdogRecord(next);
  if (!next.enabled) {
    await chrome.alarms.clear(ALARMS.WATCHDOG);
    await releaseLoopback();
    return watchdogFormState(await getWatchdog());
  }
  await parkWatchdog();
  return runWatchdogHeartbeat();
}

export async function readWatchdogSettings() {
  return watchdogFormState(await getWatchdog());
}
