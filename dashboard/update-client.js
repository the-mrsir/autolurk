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
    // Chrome aborts the picker immediately on an extension page. A normal
    // web page can still open it.
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
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") onUpdated(tabId, { status: "complete" });
    }).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

// Runs on a normal web page. The folder handle has to stay here; extension
// pages are not given the picker, and a handle cannot be sent back.
function chooseFolder(expected) {
  const root = document.createElement("div");
  root.id = "autolurk-update";
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#16171d;color:#f2f2f2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font:16px/1.4 Segoe UI,sans-serif;text-align:center;padding:24px;";
  const title = document.createElement("p");
  title.textContent = "Choose the folder you loaded on chrome://extensions. It contains manifest.json.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Choose AutoLurk folder";
  button.style.cssText = "font:inherit;padding:10px 16px;cursor:pointer;";
  const status = document.createElement("p");
  status.id = "autolurk-update-status";
  root.append(title, button, status);
  document.documentElement.append(root);

  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Waiting for the folder…";
    delete status.dataset.autolurkError;
    try {
      const picker = globalThis.showDirectoryPicker;
      if (typeof picker !== "function") throw new Error("This page cannot choose a folder.");
      const dir = await picker({ mode: "readwrite", id: "autolurk-extension" });
      let manifest;
      try {
        manifest = JSON.parse(await (await (await dir.getFileHandle("manifest.json")).getFile()).text());
      } catch {
        throw new Error("That folder is not AutoLurk. Choose the folder you loaded on chrome://extensions.");
      }
      if (manifest.name !== expected.name || (expected.key && manifest.key !== expected.key)) {
        throw new Error("That folder is a different extension. Choose the AutoLurk folder.");
      }
      globalThis.__autolurkDir = dir;
      status.dataset.autolurkPicked = "1";
      status.textContent = `Writing version ${expected.version}…`;
    } catch (error) {
      button.disabled = false;
      if (error?.name === "AbortError") {
        status.textContent = "Choose the AutoLurk folder to continue.";
        return;
      }
      status.dataset.autolurkError = error.message || "The folder could not be opened.";
      status.textContent = status.dataset.autolurkError;
    }
  });
}

function readUpdateState() {
  const status = document.querySelector("#autolurk-update-status");
  return {
    picked: status?.dataset.autolurkPicked || "",
    error: status?.dataset.autolurkError || "",
  };
}

async function writeChosenFile(path, data) {
  const dir = globalThis.__autolurkDir;
  if (!dir) throw new Error("The folder picker was closed.");
  const parts = String(path).split("/");
  let current = dir;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = await current.getDirectoryHandle(parts[index], { create: true });
  }
  const handle = await current.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Uint8Array(data));
  await writable.close();
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

// Used when this Chrome has not been reloaded since scripting was added.
// The content script from that load can still open the folder picker.
async function installViaContentScript(files, expected) {
  const tab = await chrome.tabs.create({ url: "https://www.twitch.tv/", active: true });
  await tabLoaded(tab.id);
  const response = await sendWhenReady(tab.id, {
    type: "APPLY_UPDATE_FILES",
    entries: [...files].map(([path, bytes]) => [path, Array.from(bytes)]),
    expected,
  });
  if (!response?.ok) throw new Error(response?.error || "The update was not written.");
  await chrome.tabs.remove(tab.id);
  return response.version;
}

async function pageState(tabId) {
  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readUpdateState,
    });
  } catch {
    throw new Error("The folder page was closed before the update finished.");
  }
  return result?.result || { picked: "", error: "" };
}

async function installViaPage(files, expected) {
  // www.twitch.tv is already a host permission. A new origin cannot be
  // requested unless that exact pattern is listed in the manifest.
  const tab = await chrome.tabs.create({ url: "https://www.twitch.tv/", active: true });
  await tabLoaded(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: chooseFolder,
    args: [expected],
  });

  const started = Date.now();
  let picked = false;
  while (Date.now() - started < 5 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const state = await pageState(tab.id);
    if (state.error) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw new Error(state.error);
    }
    if (state.picked) {
      picked = true;
      break;
    }
  }
  if (!picked) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error("The update was not finished.");
  }

  // One file per call. The whole package does not fit in a single injection.
  for (const [path, bytes] of files) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: writeChosenFile,
      args: [path, Array.from(bytes)],
    });
  }
  await chrome.tabs.remove(tab.id);
  return expected.version;
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

function manifestLists(permission) {
  const manifest = chrome.runtime.getManifest();
  return [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].includes(permission);
}

// Downloads the package and replaces the loaded folder. The caller reloads.
export async function installUpdatePackage(packageUrl) {
  // First wait, so the click still counts. Only ask for a permission the
  // loaded manifest already lists. Chrome rejects anything else outright.
  let pageAllowed = false;
  if (manifestLists("scripting")) {
    try {
      pageAllowed = await chrome.permissions.request({ permissions: ["scripting"] });
    } catch {
      pageAllowed = false;
    }
  }
  await allowUpdateOrigin(packageUrl);
  const { files, next, running } = await downloadPackage(packageUrl);
  const folder = await extensionFolder();
  if (!folder) {
    const expected = { name: running.name, key: running.key || "", version: next.version };
    if (pageAllowed) return installViaPage(files, expected);
    return installViaContentScript(files, expected);
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
