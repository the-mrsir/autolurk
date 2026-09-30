// Local monitor decisions. No Chrome APIs and no addresses of any particular machine.
// A report is sent only after this install turns the monitor on, and only to
// loopback. Nothing here is a default destination.

import { HEALTH } from "./health.js";

export const LOOPBACK_PATTERNS = [
  "http://127.0.0.1/*",
  "http://localhost/*",
  "https://127.0.0.1/*",
  "https://localhost/*",
];

const WATCHDOG_ERRORS = new Set(["", "unreachable", "unauthorized", "rejected", "permission", "address"]);

export function parseLoopbackEndpoint(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    return "";
  }
  if (url.username || url.password) return "";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1") return "";
  return url.toString();
}

export function loopbackPermissionPattern(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeWatchdog(input = {}) {
  const interval = Number(input.intervalSeconds);
  const lastError = WATCHDOG_ERRORS.has(input.lastError) ? input.lastError : "";
  return {
    enabled: input.enabled === true,
    endpoint: parseLoopbackEndpoint(input.endpoint),
    token: String(input.token || "").slice(0, 256),
    intervalSeconds: Math.min(3600, Math.max(60, Number.isFinite(interval) ? Math.round(interval) : 60)),
    recover: input.recover === true,
    lastAt: Number(input.lastAt) > 0 ? Number(input.lastAt) : 0,
    lastOk: input.lastOk === true,
    lastError,
  };
}

// What the settings page may show. The token stays in local storage.
export function watchdogFormState(config) {
  const state = normalizeWatchdog(config);
  return {
    enabled: state.enabled,
    endpoint: state.endpoint,
    hasToken: Boolean(state.token),
    intervalSeconds: state.intervalSeconds,
    recover: state.recover,
    lastAt: state.lastAt,
    lastOk: state.lastOk,
    lastError: state.lastError,
  };
}

export function watchdogStatusText(config, now = Date.now()) {
  const state = normalizeWatchdog(config);
  if (!state.enabled) return "Off.";
  if (!state.endpoint) return "Add an address on this computer.";
  if (!state.lastAt) return "Waiting for the first report.";
  if (state.lastOk) {
    const seconds = Math.max(0, Math.round((now - state.lastAt) / 1000));
    return `Reached ${seconds}s ago.`;
  }
  if (state.lastError === "unauthorized") return "The monitor refused the token.";
  if (state.lastError === "permission") return "This browser has not allowed local access.";
  if (state.lastError === "address") return "The address has to be on this computer.";
  if (state.lastError === "rejected") return "The monitor refused the report.";
  return "The monitor could not be reached.";
}

export function heartbeatPayload({ version = "", managed = 0, playing = 0, stalled = 0, at = 0 } = {}) {
  return {
    extension: "autolurk",
    version: String(version || ""),
    at: Number(at) || 0,
    managed: Math.max(0, Number(managed) || 0),
    playing: Math.max(0, Number(playing) || 0),
    stalled: Math.max(0, Number(stalled) || 0),
  };
}

export function streamCounts(managed = {}) {
  const entries = Object.values(managed || {});
  let playing = 0;
  let stalled = 0;
  for (const entry of entries) {
    if (entry?.health === HEALTH.MEDIA_PLAYING) playing += 1;
    else if (
      entry?.health === HEALTH.STALLED ||
      entry?.health === HEALTH.FAILED ||
      entry?.health === HEALTH.DEGRADED
    ) {
      stalled += 1;
    }
  }
  return { managed: entries.length, playing, stalled };
}

export function readWatchdogReply(body) {
  if (!body || typeof body !== "object") return { ok: false, recover: false, notify: "" };
  const notify = String(body.notify || "")
    .replace(/[^\w .,:'()-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return {
    ok: body.ok !== false,
    recover: body.recover === true,
    notify,
  };
}

export function watchdogRecoveryTarget(config, reply, managed = {}) {
  if (!config?.enabled || !config?.recover || reply?.recover !== true) return null;
  const entry = Object.values(managed).find(
    (item) => item && (item.health === HEALTH.STALLED || item.health === HEALTH.FAILED)
  );
  const tabId = Number(entry?.tabId);
  return Number.isFinite(tabId) ? tabId : null;
}

export function watchdogPeriodMinutes(intervalSeconds) {
  return Math.max(1, Math.round(Number(intervalSeconds) / 60) || 1);
}
