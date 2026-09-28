// Deciding whether a downloaded package is a newer AutoLurk, and unpacking it.
// No Chrome APIs: the dashboard applies the files, the worker only fetches.

const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 400;

export function compareVersions(left, right) {
  const a = parts(left);
  const b = parts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function parts(version) {
  const numbers = String(version || "").split(".").map((item) => Number(item));
  if (numbers.length !== 3 || numbers.some((item) => !Number.isInteger(item) || item < 0)) return null;
  return numbers;
}

// A public GitHub repository is an update source: manifest.json at the top of
// the default branch is the version, and GitHub's own zip of that branch is
// the package. A hand-written JSON file still works for anything else.
export function parseGithubRepo(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  let branch = "";
  if (parts[2] === "tree" && parts[3]) branch = parts.slice(3).map(decodeURIComponent).join("/");
  if (branch.includes("..") || branch.startsWith("/")) return null;
  return { owner, repo, branch };
}

function githubRef(branch) {
  return branch.split("/").map(encodeURIComponent).join("/");
}

export function githubApiUrl(repo) {
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
}

export function githubRawManifestUrl(repo, branch) {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${githubRef(branch)}/manifest.json`;
}

export function githubZipUrl(repo, branch) {
  return `https://codeload.github.com/${repo.owner}/${repo.repo}/zip/refs/heads/${githubRef(branch)}`;
}

// Every host a check or download will touch, so one permission prompt covers
// the automatic check later. The alarm cannot ask.
export function updateOrigins(input) {
  if (parseGithubRepo(input)) {
    return ["https://api.github.com/*", "https://raw.githubusercontent.com/*", "https://codeload.github.com/*"];
  }
  const url = new URL(String(input || "").trim());
  if (url.protocol !== "https:") throw new Error("The update address has to be https.");
  return [`${url.origin}/*`];
}

export function parseUpdateManifest(body) {
  const data = typeof body === "string" ? JSON.parse(body) : body;
  const version = String(data?.version || "");
  const packageUrl = String(data?.packageUrl || "");
  if (!parts(version)) throw new Error("The update manifest has no version.");
  let url;
  try {
    url = new URL(packageUrl);
  } catch {
    throw new Error("The update manifest has no package address.");
  }
  if (url.protocol !== "https:") throw new Error("The update package has to be an https address.");
  return { version, packageUrl: url.toString() };
}

export function describeUpdate(update, manifestUrl) {
  if (!String(manifestUrl || "").trim()) return "Add an update address, then check.";
  if (update?.error) return update.error;
  if (update?.packageUrl && update?.availableVersion) {
    return `Version ${update.availableVersion} is ready.`;
  }
  if (update?.checkedAt && update?.latestVersion) {
    return `You're on the latest version (${update.latestVersion}).`;
  }
  return "Not checked yet.";
}

// A zip entry is only applied when it stays inside the extension folder.
export function safeZipPath(name) {
  const cleaned = String(name || "").replace(/\\/g, "/");
  if (!cleaned || cleaned.endsWith("/")) return "";
  if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
    throw new Error("The update package contains an unsafe path.");
  }
  const kept = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("The update package contains an unsafe path.");
    kept.push(part);
  }
  return kept.join("/");
}

// GitHub's source archive wraps everything in one top folder. A package we
// built ourselves has manifest.json at the root. Accept either.
export function stripSingleRoot(files) {
  const paths = [...files.keys()];
  if (paths.includes("manifest.json")) return files;
  const roots = new Set(paths.map((path) => path.split("/")[0]).filter(Boolean));
  if (roots.size !== 1) return files;
  const prefix = `${[...roots][0]}/`;
  if (!paths.includes(`${prefix}manifest.json`)) return files;
  const next = new Map();
  for (const [path, data] of files) {
    if (path.startsWith(prefix)) next.set(path.slice(prefix.length), data);
  }
  return next;
}

export function validatePackageManifest(current, text) {
  let next;
  try {
    next = JSON.parse(text);
  } catch {
    throw new Error("The update has no readable manifest.");
  }
  if (!next || next.name !== current?.name) throw new Error("That package is not AutoLurk.");
  if (current?.key && next.key !== current.key) {
    throw new Error("That package would change the extension id. It was not applied.");
  }
  if (!parts(next.version)) throw new Error("The update has an invalid version.");
  return next;
}

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function findEocd(bytes) {
  const start = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error("That download is not a zip file.");
}

async function inflate(compressed) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot unpack the update.");
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function extractZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 22) throw new Error("That download is not a zip file.");
  const eocd = findEocd(bytes);
  const count = u16(bytes, eocd + 10);
  let cursor = u32(bytes, eocd + 16);
  if (count > MAX_FILES) throw new Error("The update package has too many files.");

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || u32(bytes, cursor) !== 0x02014b50) {
      throw new Error("The update package is incomplete.");
    }
    const method = u16(bytes, cursor + 10);
    const compSize = u32(bytes, cursor + 20);
    const uncompSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ method, compSize, uncompSize, localOffset, name });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const files = new Map();
  let total = 0;
  for (const entry of entries) {
    const path = safeZipPath(entry.name);
    if (!path) continue;
    if (entry.uncompSize === 0xffffffff || entry.compSize === 0xffffffff) {
      throw new Error("The update package is too large.");
    }
    const local = entry.localOffset;
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) {
      throw new Error("The update package is incomplete.");
    }
    const nameLength = u16(bytes, local + 26);
    const extraLength = u16(bytes, local + 28);
    const dataStart = local + 30 + nameLength + extraLength;
    const compressed = bytes.subarray(dataStart, dataStart + entry.compSize);
    if (dataStart + entry.compSize > bytes.length) throw new Error("The update package is incomplete.");

    let data;
    if (entry.method === 0) data = compressed;
    else if (entry.method === 8) data = await inflate(compressed);
    else throw new Error("The update package uses a compression this updater cannot read.");

    if (data.length !== entry.uncompSize) throw new Error("The update package is incomplete.");
    total += data.length;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error("The update package is too large.");
    files.set(path, data);
  }
  return stripSingleRoot(files);
}
