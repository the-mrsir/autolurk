// Optional local monitor. Off on every install until this computer turns it on.
// While it is off this file's callers clear the alarm and return. They do not
// fetch, and they do not ask Chrome for localhost access.

import { ALARMS } from "../shared/constants.js";
import { getManagedTabs, getWatchdog, saveWatchdogRecord } from "../shared/storage.js";
import {
  LOOPBACK_PATTERNS,
  heartbeatPayload,
  loopbackPermissionPattern,
  normalizeWatchdog,
  readWatchdogReply,
  streamCounts,
  watchdogFormState,
  watchdogPeriodMinutes,
  watchdogRecoveryTarget,
} from "../shared/watchdog-logic.js";
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

export async function runWatchdogHeartbeat() {
  const config = await getWatchdog();
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

  const counts = streamCounts(await getManagedTabs());
  const payload = heartbeatPayload({
    version: chrome.runtime.getManifest?.()?.version || "",
    ...counts,
    at: Date.now(),
  });
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    return watchdogFormState(await note(config, { lastOk: false, lastError: "unreachable" }));
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    return watchdogFormState(await note(config, { lastOk: false, lastError: "unauthorized" }));
  }

  let body = null;
  try {
    body = typeof response.json === "function" ? await response.json() : null;
  } catch {
    body = null;
  }
  const reply = readWatchdogReply(body, response.ok);
  if (!response.ok || !reply.ok) {
    return watchdogFormState(
      await note(config, {
        lastOk: false,
        lastError: "rejected",
        lastDetail: reply.detail || String(response.status || ""),
      })
    );
  }

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
