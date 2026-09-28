// Applies an update into the unpacked extension folder. Chrome will not do
// this itself for an extension loaded from a folder, so the dashboard asks
// for that folder once and writes the new files there.

import { compareVersions, extractZip, updateOrigins, validatePackageManifest } from "../shared/update-logic.js";

const DB_NAME = "autolurk-update";
const STORE = "handles";
const HANDLE_KEY = "root";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savedFolder() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function rememberFolder(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(handle, HANDLE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function allowUpdateOrigin(url) {
  const origins = updateOrigins(url);
  if (!chrome.permissions?.contains) return;
  if (await chrome.permissions.contains({ origins })) return;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error("Chrome did not allow that update address.");
}

function directoryPicker() {
  // The bare name is missing inside a module on an extension page. The method
  // still lives on the window when Chrome provides it.
  const picker = globalThis.showDirectoryPicker;
  return typeof picker === "function" ? picker : null;
}

async function extensionFolder() {
  const saved = await savedFolder().catch(() => null);
  if (saved?.queryPermission) {
    const current = await saved.queryPermission({ mode: "readwrite" });
    if (current === "granted") return saved;
    const asked = await saved.requestPermission({ mode: "readwrite" });
    if (asked === "granted") return saved;
  }
  const picker = directoryPicker();
  if (!picker) return null;
  try {
    const picked = await picker({ id: "autolurk-extension", mode: "readwrite" });
    await rememberFolder(picked);
    return picked;
  } catch (error) {
    // Chrome aborts the picker immediately on an extension page. A Twitch tab
    // can still open it.
    if (error?.name === "AbortError") return null;
    throw error;
  }
}

function tabLoaded(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("The folder page did not load."));
    }, 20000);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function sendWhenReady(tabId, message) {
  let last = "The Twitch tab did not load the updater.";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      last = error?.message || last;
      if (!/Receiving end does not exist|Could not establish connection/i.test(last)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(last);
}

// Extension pages do not get the folder picker. A normal Twitch tab does, and
// a content script is already allowed to run there.
async function installViaTwitchTab(files, expected) {
  const tab = await chrome.tabs.create({ url: "https://www.twitch.tv/", active: true });
  if (tab.status !== "complete") await tabLoaded(tab.id);
  const response = await sendWhenReady(tab.id, {
    type: "APPLY_UPDATE_FILES",
    entries: [...files].map(([path, bytes]) => [path, Array.from(bytes)]),
    expected,
  });
  if (!response?.ok) throw new Error(response?.error || "The update was not written.");
  await chrome.tabs.remove(tab.id);
  return response.version;
}

async function readJson(dir, name) {
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return JSON.parse(await file.text());
}

async function writeFile(dir, path, bytes) {
  const parts = path.split("/");
  let current = dir;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = await current.getDirectoryHandle(parts[index], { create: true });
  }
  const handle = await current.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function downloadPackage(packageUrl) {
  const response = await fetch(packageUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`The update download returned ${response.status}.`);
  if (!String(response.url || packageUrl).startsWith("https:")) {
    throw new Error("The update package has to stay on https.");
  }
  const files = await extractZip(await response.arrayBuffer());
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) throw new Error("The update package has no manifest.");
  const running = chrome.runtime.getManifest();
  const next = validatePackageManifest(running, new TextDecoder().decode(manifestBytes));
  if (compareVersions(next.version, running.version) !== 1) {
    throw new Error("That package is not a newer version.");
  }
  return { files, next, running };
}

// Downloads the package and replaces the loaded folder. The caller reloads.
export async function installUpdatePackage(packageUrl) {
  await allowUpdateOrigin(packageUrl);
  const { files, next, running } = await downloadPackage(packageUrl);
  const folder = await extensionFolder();
  if (!folder) {
    return installViaTwitchTab(files, { name: running.name, key: running.key || "", version: next.version });
  }

  let current;
  try {
    current = await readJson(folder, "manifest.json");
  } catch {
    throw new Error("That folder is not AutoLurk. Choose the folder you loaded on chrome://extensions.");
  }
  if (current.name !== running.name || (running.key && current.key !== running.key)) {
    throw new Error("That folder is a different extension. Choose the AutoLurk folder.");
  }

  for (const [path, bytes] of files) {
    await writeFile(folder, path, bytes);
  }
  return next.version;
}
