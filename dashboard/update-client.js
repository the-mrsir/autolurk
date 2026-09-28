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

// Runs on a normal web page. Extension pages are not given the folder picker.
function chooseFolderAndWrite(entries, expected) {
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
  root.append(title, button, status);
  document.documentElement.append(root);

  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Waiting for the folder…";
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
      for (const [path, data] of entries) {
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
      status.dataset.autolurkVersion = expected.version;
      status.textContent = `Version ${expected.version} is in place. Returning to AutoLurk…`;
    } catch (error) {
      button.disabled = false;
      status.textContent = error?.name === "AbortError" ? "Choose the AutoLurk folder to continue." : error.message;
    }
  });
}

function readInstalledVersion() {
  return document.querySelector("#autolurk-update [data-autolurk-version]")?.dataset.autolurkVersion || "";
}

async function installViaPage(files, expected) {
  const tab = await chrome.tabs.create({ url: "https://example.com/", active: true });
  await tabLoaded(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: chooseFolderAndWrite,
    args: [[...files].map(([path, bytes]) => [path, Array.from(bytes)]), expected],
  });

  const started = Date.now();
  while (Date.now() - started < 5 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    let result;
    try {
      [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: readInstalledVersion,
      });
    } catch {
      throw new Error("The folder page was closed before the update finished.");
    }
    if (result?.result) {
      await chrome.tabs.remove(tab.id);
      return result.result;
    }
  }
  throw new Error("The update was not finished.");
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
  // This has to be the first wait. Chrome only shows the permission prompt
  // during the click, and the settings page cannot open the folder picker.
  const pageAllowed = await chrome.permissions.request({
    permissions: ["scripting"],
    origins: ["https://example.com/*"],
  });
  if (!pageAllowed && !directoryPicker()) {
    throw new Error("Chrome did not allow the folder picker to open.");
  }
  await allowUpdateOrigin(packageUrl);
  const { files, next, running } = await downloadPackage(packageUrl);
  const folder = await extensionFolder();
  if (!folder) {
    if (!pageAllowed) throw new Error("Chrome did not allow the folder picker to open.");
    return installViaPage(files, { name: running.name, key: running.key || "", version: next.version });
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
