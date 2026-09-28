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

// Runs in the page's own JavaScript, not the extension's. The folder picker
// is an own property of that window, so an extension script cannot see it.
function pageProgram(expected, token) {
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
  document.documentElement.dataset.autolurkPicker = typeof window.showDirectoryPicker;
  if (typeof window.showDirectoryPicker !== "function") {
    status.dataset.autolurkError = "This page cannot choose a folder.";
    status.textContent = status.dataset.autolurkError;
    button.disabled = true;
    return;
  }

  let dir = null;
  document.addEventListener("autolurk-write", async () => {
    const slot = document.getElementById("autolurk-payload");
    let message;
    try {
      message = JSON.parse(slot?.textContent || "");
    } catch {
      return;
    }
    if (!message || message.token !== token || !dir) return;
    try {
      const parts = String(message.path).split("/");
      let current = dir;
      for (let index = 0; index < parts.length - 1; index += 1) {
        current = await current.getDirectoryHandle(parts[index], { create: true });
      }
      const handle = await current.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array(message.data));
      await writable.close();
      status.dataset.autolurkWrote = message.path;
    } catch (error) {
      status.dataset.autolurkError = error.message || "The update was not written.";
      status.textContent = status.dataset.autolurkError;
    }
  });

  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Waiting for the folder…";
    delete status.dataset.autolurkError;
    try {
      const picker = window.showDirectoryPicker;
      if (typeof picker !== "function") throw new Error("This page cannot choose a folder.");
      dir = await picker.call(window, { mode: "readwrite", id: "autolurk-extension" });
      let manifest;
      try {
        manifest = JSON.parse(await (await (await dir.getFileHandle("manifest.json")).getFile()).text());
      } catch {
        throw new Error("That folder is not AutoLurk. Choose the folder you loaded on chrome://extensions.");
      }
      if (manifest.name !== expected.name || (expected.key && manifest.key !== expected.key)) {
        throw new Error("That folder is a different extension. Choose the AutoLurk folder.");
      }
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

function installProgram(source) {
  const script = document.createElement("script");
  script.textContent = source;
  document.documentElement.append(script);
  script.remove();
}

function readUpdateState() {
  const status = document.querySelector("#autolurk-update-status");
  return {
    ready: document.documentElement.dataset.autolurkPicker || "",
    picked: status?.dataset.autolurkPicked || "",
    error: status?.dataset.autolurkError || "",
    wrote: status?.dataset.autolurkWrote || "",
  };
}

function sendFile(token, path, data) {
  const status = document.querySelector("#autolurk-update-status");
  if (status) delete status.dataset.autolurkWrote;
  let slot = document.getElementById("autolurk-payload");
  if (!slot) {
    slot = document.createElement("script");
    slot.id = "autolurk-payload";
    slot.type = "application/json";
    document.documentElement.append(slot);
  }
  slot.textContent = JSON.stringify({ token, path, data });
  slot.dispatchEvent(new Event("autolurk-write", { bubbles: true }));
}

async function pageState(tabId) {
  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readUpdateState,
    });
  } catch {
    throw new Error("The folder page was closed before the update finished.");
  }
  return result?.result || { ready: "", picked: "", error: "", wrote: "" };
}

async function installViaPage(files, expected) {
  const token = crypto.randomUUID();
  const source = `(${pageProgram.toString()})(${JSON.stringify(expected).replace(/</g, "\\u003c")},${JSON.stringify(token)})`;
  const tab = await chrome.tabs.create({ url: "https://example.com/", active: true });
  await tabLoaded(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: installProgram,
    args: [source],
  });

  const started = Date.now();
  let picked = false;
  let ready = false;
  while (Date.now() - started < 5 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const state = await pageState(tab.id);
    if (!ready && !state.ready && Date.now() - started > 3000) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw new Error("The folder page blocked the picker.");
    }
    ready = Boolean(state.ready);
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

  for (const [path, bytes] of files) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: sendFile,
      args: [token, path, Array.from(bytes)],
    });
    const fileStarted = Date.now();
    let written = false;
    while (Date.now() - fileStarted < 30000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const state = await pageState(tab.id);
      if (state.error) {
        await chrome.tabs.remove(tab.id).catch(() => {});
        throw new Error(state.error);
      }
      if (state.wrote === path) {
        written = true;
        break;
      }
    }
    if (!written) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw new Error(`Could not write ${path}.`);
    }
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

// Downloads the package and replaces the loaded folder. The caller reloads.
export async function installUpdatePackage(packageUrl) {
  // First wait, so the click still counts. Both of these strings are already
  // listed in the manifest. The folder picker only exists on a normal web page.
  const manifest = chrome.runtime.getManifest();
  const listed = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];
  const origins = [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])];
  if (!listed.includes("scripting") || !origins.includes("https://*/*")) {
    throw new Error("Reload the extension on chrome://extensions, then click Update again.");
  }
  let allowed = false;
  try {
    allowed = await chrome.permissions.request({
      permissions: ["scripting"],
      origins: ["https://*/*"],
    });
  } catch (error) {
    throw new Error(error?.message || "Chrome did not allow the folder page.");
  }
  if (!allowed) throw new Error("Chrome did not allow the folder page.");

  await allowUpdateOrigin(packageUrl);
  const { files, next, running } = await downloadPackage(packageUrl);
  const folder = await extensionFolder();
  if (!folder) {
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
