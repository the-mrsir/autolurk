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
    token: String(input.token || "").replace(/[\r\n]/g, "").trim().slice(0, 256),
    intervalSeconds: Math.min(3600, Math.max(60, Number.isFinite(interval) ? Math.round(interval) : 60)),
    recover: input.recover === true,
    lastAt: Number(input.lastAt) > 0 ? Number(input.lastAt) : 0,
    lastOk: input.lastOk === true,
    lastError,
    lastDetail: sanitizeWatchdogText(input.lastDetail),
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
    lastDetail: state.lastDetail,
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
  if (state.lastError === "rejected") {
    return state.lastDetail
      ? `The monitor refused the report. ${state.lastDetail}`
      : "The monitor refused the report.";
  }
  return "The monitor could not be reached.";
}

// Unix seconds. A millisecond count is decades past a clock that uses time.time().
function reportInstant(at) {
  const value = Number(at) || 0;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
}

export function heartbeatPayload({ version = "", managed = 0, playing = 0, stalled = 0, at = 0 } = {}) {
  return {
    extension: "autolurk",
    version: String(version || ""),
    at: reportInstant(at),
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

export function sanitizeWatchdogText(value) {
  return String(value || "")
    .replace(/bearer\s+\S+/gi, "")
    .replace(/[^\w .,:'()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function replyMessage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  if (typeof body.message === "string") return sanitizeWatchdogText(body.message);
  if (typeof body.error === "string") return sanitizeWatchdogText(body.error);
  if (typeof body.detail === "string") return sanitizeWatchdogText(body.detail);
  if (body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)) {
    return replyMessage(body.detail);
  }
  if (Array.isArray(body.detail)) {
    return sanitizeWatchdogText(body.detail.map((item) => item?.msg || item?.message || "").filter(Boolean).join("; "));
  }
  return "";
}

export function watchdogRefusalDetail(body, rawText = "", status = 0) {
  const fromJson = replyMessage(body);
  if (fromJson) return fromJson;
  const text = String(rawText || "");
  const message = text.match(/Message:\s*([^<\n]+)/i);
  if (message) {
    const extracted = sanitizeWatchdogText(message[1]);
    if (extracted && !/^bad request\.?$/i.test(extracted)) return extracted;
  }
  const plain = sanitizeWatchdogText(text);
  if (plain && !/^doctype html/i.test(plain) && !/^<!?doctype/i.test(plain)) return plain;
  return String(status || "");
}

// The monitor's own status page is { status, message }, not { ok: true }.
// An empty 2xx body is a recorded report. status WAITING means it was not stored.
export function readWatchdogReply(body, httpOk = true) {
  const detail = replyMessage(body);
  const notify = sanitizeWatchdogText(body?.notify || "");
  if (!httpOk) return { ok: false, recover: false, notify: "", detail };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: true, recover: false, notify: "", detail: "" };
  }
  const status = String(body.status || "").toLowerCase();
  const failed =
    body.ok === false ||
    status === "error" ||
    status === "rejected" ||
    status === "unauthorized" ||
    status === "waiting" ||
    status === "failed";
  return {
    ok: !failed,
    recover: body.recover === true,
    notify,
    detail: failed ? detail : "",
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
