import { TWITCH } from "../shared/constants.js";

// Drops support is deliberately limited to opening the inventory page. The
// previous heuristic scraped Twitch's DOM for anything containing "claim" or
// "100%" and notified on it, which fired on unrelated page text and could not
// tell a claimable drop from a finished one. Real support needs the GQL drops
// campaign data, so the guesswork is gone rather than shipped as a feature.
export async function openDropsInventory() {
  const existing = await chrome.tabs.query({ url: "*://www.twitch.tv/drops/inventory*" });
  if (existing[0]) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: TWITCH.DROPS_INVENTORY, active: true });
}
