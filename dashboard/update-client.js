import { listedUpdateOrigins } from "../shared/update-logic.js";

export async function allowUpdateOrigin() {
  const origins = listedUpdateOrigins(chrome.runtime.getManifest());
  if (!origins.length) {
    throw new Error("Reload the extension on chrome://extensions, then try again.");
  }
  if (!chrome.permissions?.contains) return;
  if (await chrome.permissions.contains({ origins })) return;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins });
  } catch (error) {
    throw new Error(error?.message || "Chrome did not allow the update download.");
  }
  if (!granted) throw new Error("Chrome did not allow the update download.");
}
