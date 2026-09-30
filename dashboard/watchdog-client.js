import { loopbackPermissionPattern, parseLoopbackEndpoint } from "../shared/watchdog-logic.js";

// Asked from the button click, which is the gesture Chrome requires. The
// service worker cannot request an optional origin on its own.
export async function allowLoopback(endpoint) {
  const parsed = parseLoopbackEndpoint(endpoint);
  if (!parsed) throw new Error("The address has to be on this computer.");
  const origins = [loopbackPermissionPattern(parsed)];
  if (!chrome.permissions?.request) return parsed;
  if (await chrome.permissions.contains({ origins })) return parsed;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins });
  } catch (error) {
    throw new Error(error?.message || "Local access was not allowed.");
  }
  if (!granted) throw new Error("Local access was not allowed.");
  return parsed;
}
