import { listedUpdateOrigins, readUpdaterReply, UPDATER_HOST, updaterMissing, updaterRequest } from "../shared/update-logic.js";

export const UPDATER_SETUP =
  "The updater is not set up on this computer. Run updater/install-windows.cmd (Windows) " +
  "or sh updater/install-linux.sh (Linux) from the AutoLurk folder once, then click Update now again.";

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

async function allowUpdater() {
  const wanted = { permissions: ["nativeMessaging"] };
  if (await chrome.permissions.contains(wanted)) return;
  let granted = false;
  try {
    granted = await chrome.permissions.request(wanted);
  } catch (error) {
    throw new Error(error?.message || "The browser did not allow the updater.");
  }
  if (!granted) throw new Error("The browser did not allow the updater.");
}

// Returns the status line. On success the extension reloads and this page closes.
export async function installUpdate(manifestUrl) {
  await allowUpdater();
  if (typeof chrome.runtime.sendNativeMessage !== "function") {
    throw new Error("Reopen the dashboard, then click Update now again.");
  }
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(UPDATER_HOST, updaterRequest(manifestUrl));
  } catch (error) {
    if (updaterMissing(error)) throw new Error(UPDATER_SETUP);
    throw new Error(`The updater did not run: ${error?.message || error}`);
  }
  const result = readUpdaterReply(reply, chrome.runtime.getManifest().version);
  if (result.reload) setTimeout(() => chrome.runtime.reload(), 1200);
  return result.text;
}
