// Lurk tabs are pinned so Brave does not unload them, which is what keeps them
// earning watch time. With memory nearly gone that pin is what takes the whole
// browser down instead, so below the floor the pin comes off the streams
// nobody is looking at, and goes back on once memory recovers.

import { getManagedTabs } from "../shared/storage.js";
import { logActivity } from "./activity.js";

export const MEMORY_GUARD = { lowBelow: 0.15, recoveredAbove: 0.25 };

let low = false;

export async function freeMemoryRatio() {
  if (!chrome.system?.memory?.getInfo) return null;
  try {
    const info = await chrome.system.memory.getInfo();
    if (!info?.capacity) return null;
    return Number(info.availableCapacity) / Number(info.capacity);
  } catch {
    return null;
  }
}

export function memoryIsLow() {
  return low;
}

export async function guardMemory() {
  const ratio = await freeMemoryRatio();
  if (ratio == null) return low;
  const next = low ? ratio < MEMORY_GUARD.recoveredAbove : ratio < MEMORY_GUARD.lowBelow;
  if (next !== low) {
    low = next;
    const percent = Math.round(ratio * 100);
    await logActivity(
      low
        ? `Only ${percent}% of memory is free, so Brave may unload background streams instead of crashing`
        : `Memory recovered (${percent}% free), so background streams stay loaded again`,
      { level: low ? "warn" : "info" }
    );
  }
  for (const entry of Object.values(await getManagedTabs())) {
    try {
      const tab = await chrome.tabs.get(Number(entry.tabId));
      const discardable = low && !tab.active;
      if (tab.autoDiscardable === discardable) continue;
      await chrome.tabs.update(Number(entry.tabId), { autoDiscardable: discardable });
    } catch {
      // Closed since the list was read.
    }
  }
  return low;
}

export function resetMemoryGuard() {
  low = false;
}
(globalThis.__autoLurkTestResets ||= []).push(resetMemoryGuard);
