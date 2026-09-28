import { mutateActivity } from "../shared/storage.js";

const MAX_ITEMS = 200;

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
