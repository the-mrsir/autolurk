import { mutateActivity } from "../shared/storage.js";

const MAX_ITEMS = 200;
const STUCK_REPEAT_MS = 30 * 60_000;
const stuckLoggedAt = new Map();

// Boot stages and recovery steps arrive back to back, so the shared write queue
// keeps concurrent entries from dropping each other.
export function logActivity(text, detail = {}) {
  if (!text) return Promise.resolve();
  return mutateActivity((items) => {
    items.unshift({
      at: Date.now(),
      text,
      ...(detail.channel ? { channel: detail.channel } : {}),
      ...(detail.level ? { level: detail.level } : {}),
    });
    return items.slice(0, MAX_ITEMS);
  });
}

// A step that timed out is skipped so everything behind it keeps running. It
// is still written down, at most every half hour per step.
export function logStuck(what, now = Date.now()) {
  if (now - (stuckLoggedAt.get(what) || 0) < STUCK_REPEAT_MS) return Promise.resolve();
  stuckLoggedAt.set(what, now);
  return logActivity(`${what} got stuck and was skipped so the rest keeps running`, { level: "warn" }).catch(
    () => {}
  );
}

export function resetStuckLog() {
  stuckLoggedAt.clear();
}
(globalThis.__autoLurkTestResets ||= []).push(resetStuckLog);
