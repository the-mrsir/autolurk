// Applies an update into the unpacked extension folder. Chrome will not do
// this itself for an extension loaded from a folder. showDirectoryPicker does
// not run on an extension page, so a normal https page owns the folder handle
// and writes every file. The handle cannot be passed back here.

import {
  compareVersions,
  extractZip,
  listedUpdateOrigins,
  updateInstallRequest,
  validatePackageManifest,
} from "../shared/update-logic.js";

const PICKER_PAGE = "https://example.com/";

// Runs as a classic script on the https page, which is the only place
// showDirectoryPicker exists. It reads its instructions from the DOM because
// that is shared with the extension; the folder handle is not.
export function pickerBoot(expected) {
  if (expected && typeof expected === "object" && expected.name) {
    document.documentElement.dataset.autolurkExpected = JSON.stringify({
      name: String(expected.name),
      key: String(expected.key || ""),
      version: String(expected.version || ""),
    });
  }
  // A half-built overlay has no picker flag. Remove it and build a complete one.
  // An overlay the user is already looking at is left alone.
  if (document.getElementById("autolurk-update")) {
    if (document.documentElement.dataset.autolurkPicker) return;
    document.getElementById("autolurk-update").remove();
    document.getElementById("autolurk-job")?.remove();
  }
  expected = JSON.parse(document.documentElement.dataset.autolurkExpected || "{}");
  const root = document.createElement("div");
  root.id = "autolurk-update";
  root.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:#16171d;color:#f2f2f2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font:16px/1.4 Segoe UI,sans-serif;text-align:center;padding:24px;";
  const title = document.createElement("p");
  title.textContent = "Choose the folder you loaded on chrome://extensions. It contains manifest.json.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Choose AutoLurk folder";
  button.style.cssText = "font:inherit;padding:10px 16px;cursor:pointer;";
  const status = document.createElement("p");
  status.id = "autolurk-update-status";
  const job = document.createElement("div");
  job.id = "autolurk-job";
  job.hidden = true;
  root.append(title, button, status);
  document.documentElement.append(root, job);

  const fail = (message) => {
    status.dataset.autolurkError = message;
    status.textContent = message;
    button.disabled = true;
  };

  job.addEventListener("autolurk-write", () => {
    let payload;
    try {
      payload = JSON.parse(job.textContent || "{}");
    } catch {
      job.dataset.autolurkError = "The update file was unreadable.";
      return;
    }
    const done = (error) => {
      if (error) job.dataset.autolurkError = error;
      else job.dataset.autolurkWrote = String(payload.id || "");
    };
    Promise.resolve()
      .then(async () => {
        const dir = window.__autolurkDir;
        if (!dir) throw new Error("The folder picker was closed.");
        if (payload.op === "version") {
          const text = await (await (await dir.getFileHandle("manifest.json")).getFile()).text();
          job.dataset.autolurkVersion = String(JSON.parse(text).version || "");
          return;
        }
        const path = String(payload.path || "");
        if (!path || path.split("/").includes("..")) throw new Error("The update contained an unsafe path.");
        const parts = path.split("/");
        let current = dir;
        for (let index = 0; index < parts.length - 1; index += 1) {
          current = await current.getDirectoryHandle(parts[index], { create: true });
        }
        const handle = await current.getFileHandle(parts[parts.length - 1], { create: true });
        const writable = await handle.createWritable();
        const binary = atob(String(payload.data || ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        await writable.write(bytes);
        await writable.close();
      })
      .then(() => done(""))
      .catch((error) => done(error?.message || "The update could not be written."));
  });

  document.documentElement.dataset.autolurkPicker = typeof window.showDirectoryPicker;
  if (typeof window.showDirectoryPicker !== "function") {
    fail("This page cannot choose a folder.");
    return;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    status.dataset.autolurkPicking = "1";
    status.textContent = "Waiting for the folder…";
    delete status.dataset.autolurkError;
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite", id: "autolurk-extension" });
      let manifest;
      try {
        manifest = JSON.parse(await (await (await dir.getFileHandle("manifest.json")).getFile()).text());
      } catch {
        throw new Error("That folder is not AutoLurk. Choose the folder you loaded on chrome://extensions.");
      }
      if (manifest.name !== expected.name || (expected.key && manifest.key !== expected.key)) {
        throw new Error("That folder is a different extension. Choose the AutoLurk folder.");
      }
      window.__autolurkDir = dir;
      status.dataset.autolurkPicked = "1";
      status.textContent = `Writing version ${expected.version}…`;
    } catch (error) {
      button.disabled = false;
      if (error?.name === "AbortError") {
        status.textContent = "Choose the AutoLurk folder to continue.";
        return;
      }
      status.textContent = error.message || "The folder could not be opened.";
    } finally {
      delete status.dataset.autolurkPicking;
    }
  });
}

function bytesToBase64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x2000;
  for (let index = 0; index < data.length; index += chunk) {
    const slice = data.subarray(index, index + chunk);
    let part = "";
    for (let cursor = 0; cursor < slice.length; cursor += 1) part += String.fromCharCode(slice[cursor]);
    binary += part;
  }
  return btoa(binary);
}

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
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") onUpdated(tabId, { status: "complete" });
      })
      .catch((error) => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(error);
      });
  });
}

function readPickerState() {
  const status = document.getElementById("autolurk-update-status");
  return {
    ready: document.documentElement.dataset.autolurkPicker || "",
    picking: status?.dataset.autolurkPicking || "",
    picked: status?.dataset.autolurkPicked || "",
    error: status?.dataset.autolurkError || "",
  };
}

function postJob(payload) {
  const node = document.getElementById("autolurk-job");
  if (!node) throw new Error("The folder page was closed before the update finished.");
  delete node.dataset.autolurkWrote;
  delete node.dataset.autolurkError;
  delete node.dataset.autolurkVersion;
  node.textContent = payload;
  node.dispatchEvent(new Event("autolurk-write"));
}

function readJobState() {
  const node = document.getElementById("autolurk-job");
  return {
    wrote: node?.dataset.autolurkWrote || "",
    error: node?.dataset.autolurkError || "",
    version: node?.dataset.autolurkVersion || "",
  };
}

async function onPage(tabId, func, args) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const details = { target: { tabId }, world: "MAIN", func };
      if (Array.isArray(args)) details.args = args;
      const [result] = await chrome.scripting.executeScript(details);
      return result?.result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error(lastError?.message || "The folder page could not be used.");
}

async function pickerState(tabId) {
  try {
    return (await onPage(tabId, readPickerState)) || { ready: "", picking: "", picked: "", error: "" };
  } catch {
    throw new Error("The folder page was closed before the update finished.");
  }
}

async function installViaPage(files, expected, onStatus) {
  const tab = await chrome.tabs.create({ url: PICKER_PAGE, active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await tabLoaded(tab.id);
  await onPage(tab.id, pickerBoot, [expected]).catch(() => {});
  onStatus("Choose the AutoLurk folder in the tab that opened. Leave that tab open.");

  const started = Date.now();
  let picked = false;
  while (Date.now() - started < 5 * 60 * 1000) {
    const state = await pickerState(tab.id);
    // The folder dialog is open. Injecting again would rebuild the page under it.
    if (state.picking) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    if (state.ready && state.ready !== "function") {
      throw new Error(state.error || "This page cannot choose a folder.");
    }
    if (state.ready !== "function") {
      try {
        await onPage(tab.id, pickerBoot, [expected]);
      } catch {
        // The document can still be navigating. The next pass tries again.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    if (state.picked) {
      picked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!picked) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error("The folder was not chosen. Click Update again and leave the folder tab open until you choose it.");
  }

  let jobId = 1;
  for (const [path, bytes] of files) {
    await runPageJob(tab.id, { id: jobId, path, data: bytesToBase64(bytes) });
    jobId += 1;
  }
  const written = await runPageJob(tab.id, { id: jobId, op: "version" });
  await chrome.tabs.remove(tab.id).catch(() => {});
  if (written.version !== expected.version) {
    throw new Error("The folder did not update. Choose the folder you loaded on chrome://extensions.");
  }
  return expected.version;
}

async function runPageJob(tabId, job) {
  await onPage(tabId, postJob, [JSON.stringify(job)]);
  const started = Date.now();
  while (Date.now() - started < 20000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    let state;
    try {
      state = await onPage(tabId, readJobState);
    } catch {
      throw new Error("The folder page was closed before the update finished.");
    }
    if (state?.error) throw new Error(state.error);
    if (state?.wrote === String(job.id)) return state;
  }
  throw new Error("Writing the update stalled.");
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
export async function installUpdatePackage(packageUrl, onStatus = () => {}) {
  // First wait, so the click still counts. Both strings are the ones listed
  // in the manifest. A GitHub-specific origin is not, and requesting one is
  // what produced "Only permissions specified in the manifest may be requested."
  const request = updateInstallRequest(chrome.runtime.getManifest());
  if (!request) {
    throw new Error("Reload the extension on chrome://extensions, then click Update again.");
  }
  let allowed = false;
  try {
    allowed = await chrome.permissions.request(request);
  } catch (error) {
    throw new Error(error?.message || "Chrome did not allow the folder page.");
  }
  if (!allowed) throw new Error("Chrome did not allow the folder page.");

  onStatus("Downloading the update…");
  const { files, next, running } = await downloadPackage(packageUrl);
  return installViaPage(
    files,
    {
      name: running.name,
      key: running.key || "",
      version: next.version,
    },
    onStatus
  );
}
