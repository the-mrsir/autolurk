// Runs on https://the-mrsir.github.io/autolurk/updater.html, which is a normal
// page. Chrome does not provide showDirectoryPicker to an extension script,
// so the button on this page is what opens the folder dialog.

export const EXTENSION_NAME = "AutoLurk Companion";
export const EXTENSION_ID = "lofaafmcmpeoaflmfjainbofphpooboa";
const REPO = "the-mrsir/autolurk";
const BRANCH = "main";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export function safeRepoPath(path) {
  const cleaned = String(path || "").replace(/\\/g, "/");
  if (!cleaned || cleaned.endsWith("/") || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) return "";
  const parts = cleaned.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return parts.join("/");
}

export function rawFileUrl(path) {
  const safe = safeRepoPath(path);
  if (!safe) throw new Error("The file list contains an unsafe path.");
  const encoded = safe.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${encoded}`;
}

function versionOrder(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function versionParts(version) {
  const numbers = String(version || "").split(".").map((item) => Number(item));
  if (numbers.length !== 3 || numbers.some((item) => !Number.isInteger(item) || item < 0)) return null;
  return numbers;
}

export async function readManifest(dir) {
  let handle;
  try {
    handle = await dir.getFileHandle("manifest.json");
  } catch {
    throw new Error("That folder has no manifest.json. Choose the folder you loaded on chrome://extensions.");
  }
  let text;
  try {
    text = await (await handle.getFile()).text();
  } catch {
    throw new Error("That folder has no readable manifest.json.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("That folder has no readable manifest.json.");
  }
}

export function assertSameExtension(local, remote) {
  if (local?.name !== EXTENSION_NAME || remote?.name !== EXTENSION_NAME) {
    throw new Error("That folder is not AutoLurk. Choose the folder that contains manifest.json.");
  }
  if (!local?.key || local.key !== remote?.key) {
    throw new Error("That folder is a different copy of AutoLurk. It was not changed.");
  }
}

export async function listRepoFiles(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
    { headers: { Accept: "application/vnd.github+json" } }
  );
  if (!response.ok) throw new Error("GitHub did not return the file list.");
  const data = await response.json();
  if (data?.truncated) throw new Error("GitHub returned an incomplete file list.");
  const files = [];
  for (const entry of data?.tree || []) {
    if (entry?.type !== "blob") continue;
    const path = safeRepoPath(entry.path);
    if (!path) throw new Error("The file list contains an unsafe path.");
    files.push(path);
  }
  if (!files.includes("manifest.json")) throw new Error("The update has no manifest.");
  return files;
}

async function fetchBytes(fetchImpl, path, total) {
  const response = await fetchImpl(rawFileUrl(path));
  if (!response.ok) throw new Error(`GitHub did not return ${path}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${path} is too large to install.`);
  total.bytes += bytes.byteLength;
  if (total.bytes > MAX_TOTAL_BYTES) throw new Error("The update is too large to install.");
  return bytes;
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

export async function installRepo(dir, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const onStatus = options.onStatus || (() => {});
  onStatus("Reading the folder…");
  const local = await readManifest(dir);
  onStatus("Reading the update…");
  const files = await listRepoFiles(fetchImpl);
  const total = { bytes: 0 };
  const manifestBytes = await fetchBytes(fetchImpl, "manifest.json", total);
  let remote;
  try {
    remote = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error("The update has no readable manifest.");
  }
  assertSameExtension(local, remote);
  const order = versionOrder(remote.version, local.version);
  if (order === null) throw new Error("The update has an invalid version.");
  if (order < 0) {
    throw new Error(`The folder is already on ${local.version}, which is newer than ${remote.version}.`);
  }
  const rest = files.filter((path) => path !== "manifest.json");
  const count = rest.length + 1;
  for (let index = 0; index < rest.length; index += 1) {
    onStatus(`Writing ${index + 1} of ${count}…`);
    await writeFile(dir, rest[index], await fetchBytes(fetchImpl, rest[index], total));
  }
  onStatus(`Writing ${count} of ${count}…`);
  await writeFile(dir, "manifest.json", manifestBytes);
  const written = await readManifest(dir);
  if (written.version !== remote.version || written.key !== remote.key) {
    throw new Error("The folder did not keep the new version.");
  }
  return remote.version;
}

export function reloadMessage(version, reloaded) {
  if (reloaded) return `Version ${version} is in place. Reloading AutoLurk…`;
  return `Version ${version} is in the folder. On chrome://extensions, click Reload on AutoLurk.`;
}

export function askReload(version) {
  return new Promise((resolve) => {
    const finish = (reloaded) => resolve(reloadMessage(version, reloaded));
    try {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.sendMessage) {
        finish(false);
        return;
      }
      runtime.sendMessage(EXTENSION_ID, { type: "autolurk-reload" }, (response) => {
        finish(!runtime.lastError && response?.ok);
      });
    } catch {
      finish(false);
    }
  });
}

export async function chooseAndInstall(onStatus = () => {}) {
  const picker = globalThis.window?.showDirectoryPicker;
  if (typeof picker !== "function") throw new Error("This page cannot choose a folder.");
  const dir = await globalThis.window.showDirectoryPicker({ mode: "readwrite" });
  const version = await installRepo(dir, { onStatus });
  return askReload(version);
}

if (typeof document !== "undefined") {
  const status = document.getElementById("status");
  const button = document.getElementById("pick");
  if (button && typeof window.showDirectoryPicker !== "function" && status) {
    status.textContent = "This page cannot choose a folder.";
  }
  button?.addEventListener("click", () => {
    chooseAndInstall((message) => {
      if (status) status.textContent = message;
    }).then((message) => {
      if (status && message) status.textContent = message;
    }).catch((error) => {
      if (!status) return;
      status.textContent = error?.name === "AbortError"
        ? "The folder dialog closed. Click Choose AutoLurk folder again."
        : (error?.message || "The update did not finish.");
    });
  });
}
