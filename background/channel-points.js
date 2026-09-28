import { MESSAGE } from "../shared/constants.js";
import { getManagedTabs, getSettings, mutateChannelPoints } from "../shared/storage.js";
import {
  emptyPointsEntry,
  parseBalance,
  recordBalance,
  recordClaim,
} from "../shared/points-logic.js";
import { logActivity } from "./activity.js";
import { isManagedTab } from "./tab-manager.js";

// Content scripts run on every Twitch channel tab, so the decision about
// whether they may click lives here where the settings are.
export async function getPageConfig(tabId) {
  const [settings, managedTabs] = await Promise.all([getSettings(), getManagedTabs()]);
  const managed = isManagedTab(managedTabs, tabId);
  const allowed = settings.claimChannelPoints && (!settings.claimOnManagedTabsOnly || managed);
  return { claim: Boolean(allowed), managed };
}

// Tells open Twitch tabs to re-read their configuration after a settings save.
export async function broadcastConfigChange() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["*://*.twitch.tv/*"] });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs
        .sendMessage(tab.id, { type: MESSAGE.CONFIG_CHANGED })
        .catch(() => {
          // No content script on that tab yet. It reads config on load anyway.
        })
    )
  );
}

export async function recordPointsBalance(login, balanceText) {
  const reading = parseBalance(balanceText);
  if (!login || !reading) return;

  await mutateChannelPoints((points) => {
    const entry = points[login] || emptyPointsEntry(login);
    points[login] = recordBalance(entry, reading);
    return points;
  });
}

export async function recordPointsClaim(login, { confirmed, balanceText } = {}) {
  if (!login) return;

  const reading = parseBalance(balanceText);
  await mutateChannelPoints((points) => {
    const entry = points[login] || emptyPointsEntry(login);
    points[login] = recordClaim(entry, { confirmed, reading });
    return points;
  });

  // An unconfirmed claim means the chest was still there afterwards, which
  // usually means Twitch changed the markup. Say so instead of claiming credit.
  if (confirmed) {
    await logActivity("Claimed channel points", { channel: login });
  } else {
    await logActivity("Channel point claim not confirmed", { channel: login, level: "warn" });
  }
}
