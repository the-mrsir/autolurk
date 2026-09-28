import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";
import {
  compareVersions,
  describeUpdate,
  extractZip,
  githubZipUrl,
  isUpdaterReload,
  listedUpdateOrigins,
  parseGithubRepo,
  parseUpdateManifest,
  safeZipPath,
  updateInstallRequest,
  updateOrigins,
  validatePackageManifest,
} from "../shared/update-logic.js";
import { UPDATER_ORIGIN, UPDATER_PAGE } from "../shared/constants.js";
import {
  installRepo,
  rawFileUrl,
  reloadMessage,
  safeRepoPath,
} from "../docs/updater.js";

const mock = chromeMock();

function memoryFolder(files) {
  const store = new Map(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  const written = [];
  function directory(prefix) {
    return {
      async getDirectoryHandle(name) {
        return directory(prefix ? `${prefix}/${name}` : name);
      },
      async getFileHandle(name) {
        const path = prefix ? `${prefix}/${name}` : name;
        return {
          async getFile() {
            if (!store.has(path)) throw new Error("not found");
            const bytes = store.get(path);
            return { text: async () => new TextDecoder().decode(bytes) };
          },
          async createWritable() {
            let data = new Uint8Array();
            return {
              async write(chunk) {
                data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
              },
              async close() {
                store.set(path, data);
                written.push(path);
              },
            };
          },
        };
      },
    };
  }
  return { root: directory(""), store, written };
}

function fakeGithub(files) {
  return async (url) => {
    const href = String(url);
    if (href.includes("/git/trees/")) {
      return {
        ok: true,
        async json() {
          return { truncated: false, tree: Object.keys(files).map((path) => ({ path, type: "blob" })) };
        },
      };
    }
    const marker = "/main/";
    const path = decodeURIComponent(href.slice(href.indexOf(marker) + marker.length));
    if (!(path in files)) return { ok: false, async arrayBuffer() { return new ArrayBuffer(0); } };
    const bytes = new TextEncoder().encode(files[path]);
    return {
      ok: true,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function zip(files, methodFor = () => 0) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const raw = new TextEncoder().encode(file.text);
    const method = methodFor(file);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const local = new Uint8Array(30 + name.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, method, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, raw.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, raw.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const end = new DataView(eocd.buffer);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const out = new Uint8Array(offset + directorySize + eocd.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

const CURRENT = {
  name: "AutoLurk Companion",
  version: "1.2.6",
  key: "same-key",
};

describe("extension updates", () => {
  it("treats a higher version as newer and an equal version as not", () => {
    assert.equal(compareVersions("1.2.7", "1.2.6"), 1);
    assert.equal(compareVersions("1.2.6", "1.2.6"), 0);
    assert.equal(compareVersions("1.2.6", "1.3.0"), -1);
    assert.equal(compareVersions("1.2", "1.2.6"), null);
  });

  it("accepts an https package address and refuses anything else", () => {
    const parsed = parseUpdateManifest({
      version: "1.2.7",
      packageUrl: "https://example.com/autolurk.zip",
    });
    assert.equal(parsed.version, "1.2.7");
    assert.ok(throws(() => parseUpdateManifest({ version: "1.2.7", packageUrl: "http://example.com/a.zip" })));
  });

  it("refuses a package that would change the extension id", () => {
    assert.ok(
      throws(() =>
        validatePackageManifest(CURRENT, JSON.stringify({ ...CURRENT, version: "1.2.7", key: "other" }))
      )
    );
    const next = validatePackageManifest(
      CURRENT,
      JSON.stringify({ ...CURRENT, version: "1.2.7" })
    );
    assert.equal(next.version, "1.2.7");
  });

  it("rejects paths that leave the extension folder", () => {
    assert.ok(throws(() => safeZipPath("../manifest.json")));
    assert.equal(safeZipPath("background/updates.js"), "background/updates.js");
  });

  it("unpacks a stored zip and a deflated zip, including a single top folder", async () => {
    const manifest = JSON.stringify({ ...CURRENT, version: "1.2.7" });
    const stored = await extractZip(
      zip([{ name: "manifest.json", text: manifest }, { name: "background/updates.js", text: "ok" }])
    );
    assert.equal(new TextDecoder().decode(stored.get("background/updates.js")), "ok");

    const wrapped = await extractZip(
      zip(
        [
          { name: "autolurk-1.2.7/manifest.json", text: manifest },
          { name: "autolurk-1.2.7/popup/popup.js", text: "popup" },
        ],
        () => 8
      )
    );
    assert.equal(new TextDecoder().decode(wrapped.get("manifest.json")), manifest);
    assert.equal(new TextDecoder().decode(wrapped.get("popup/popup.js")), "popup");
    assert.equal(wrapped.has("autolurk-1.2.7/manifest.json"), false);
  });

  it("says when a newer package is ready and when this copy is current", () => {
    assert.equal(describeUpdate({}, ""), "Add an update address, then check.");
    assert.equal(
      describeUpdate({ packageUrl: "https://example.com/a.zip", availableVersion: "1.2.7" }, "https://example.com/updates.json"),
      "Version 1.2.7 is ready."
    );
    assert.equal(
      describeUpdate({ checkedAt: 1, latestVersion: "1.2.6" }, "https://example.com/updates.json"),
      "You're on the latest version (1.2.6)."
    );
  });

  it("reads a public GitHub repository as the update", () => {
    const repo = parseGithubRepo("https://github.com/you/autolurk");
    assert.equal(repo.owner, "you");
    assert.equal(repo.repo, "autolurk");
    assert.equal(repo.branch, "");
    assert.equal(parseGithubRepo("https://github.com/you/autolurk.git").repo, "autolurk");
    const branched = parseGithubRepo("https://github.com/you/autolurk/tree/release");
    assert.equal(branched.branch, "release");
    assert.equal(parseGithubRepo("https://example.com/you/autolurk"), null);
    assert.equal(githubZipUrl(repo, "main"), "https://codeload.github.com/you/autolurk/zip/refs/heads/main");
    assert.equal(updateOrigins("https://github.com/you/autolurk").length, 3);
    assert.equal(updateOrigins("https://codeload.github.com/you/autolurk/zip/refs/heads/main").length, 1);
  });

  it("asks only for the host permission written in the manifest", () => {
    const manifest = {
      permissions: ["storage"],
      optional_permissions: ["scripting"],
      optional_host_permissions: ["https://*/*"],
    };
    assert.deepEqual(listedUpdateOrigins(manifest), ["https://*/*"]);
    assert.deepEqual(updateInstallRequest(manifest), {
      permissions: ["scripting"],
      origins: ["https://*/*"],
    });
    assert.equal(updateInstallRequest({ permissions: ["storage"] }), null);
    const client = readFileSync(new URL("../dashboard/update-client.js", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../dashboard/dashboard.js", import.meta.url), "utf8");
    const popup = readFileSync(new URL("../popup/popup.js", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../background/service-worker.js", import.meta.url), "utf8");
    const page = readFileSync(new URL("../docs/updater.html", import.meta.url), "utf8");
    const updater = readFileSync(new URL("../docs/updater.js", import.meta.url), "utf8");
    assert.equal(client.includes("executeScript"), false);
    assert.equal(client.includes("example.com"), false);
    assert.equal(client.includes("showDirectoryPicker"), false);
    assert.ok(client.includes("UPDATER_PAGE"));
    assert.equal(UPDATER_PAGE, "https://the-mrsir.github.io/autolurk/updater.html");
    assert.ok(dashboard.includes("openUpdater"));
    assert.ok(popup.includes("UPDATER_PAGE"));
    assert.ok(worker.includes("onMessageExternal"));
    assert.ok(page.includes('id="pick"'));
    assert.ok(page.includes('src="./updater.js"'));
    const choose = updater.slice(updater.indexOf("export async function chooseAndInstall"));
    const awaits = [...choose.matchAll(/await\s+([^;\n]+)/g)].map((match) => match[1]);
    assert.ok(awaits[0].includes("showDirectoryPicker"), "the folder dialog is the first thing the page button does");
    assert.equal(UPDATER_ORIGIN, "https://the-mrsir.github.io");
    assert.equal(isUpdaterReload({ type: "autolurk-reload" }, { origin: UPDATER_ORIGIN }), true);
    assert.equal(
      isUpdaterReload({ type: "autolurk-reload" }, { url: "https://the-mrsir.github.io/autolurk/updater.html" }),
      true
    );
    assert.equal(isUpdaterReload({ type: "autolurk-reload" }, { origin: "https://example.com" }), false);
    assert.equal(isUpdaterReload({ type: "other" }, { origin: UPDATER_ORIGIN }), false);
    assert.equal(reloadMessage("1.2.24", false).includes("chrome://extensions"), true);
  });

  it("writes the GitHub files into the chosen folder, manifest last", async () => {
    const key = "same-key";
    const remote = {
      "manifest.json": JSON.stringify({ name: "AutoLurk Companion", version: "1.2.24", key }),
      "content/player.js": "player",
      "icons/icon16.png": "png",
    };
    const folder = memoryFolder({
      "manifest.json": JSON.stringify({ name: "AutoLurk Companion", version: "1.2.23", key }),
    });
    const version = await installRepo(folder.root, { fetch: fakeGithub(remote), onStatus() {} });
    assert.equal(version, "1.2.24");
    assert.equal(folder.written.at(-1), "manifest.json");
    assert.ok(folder.written.indexOf("content/player.js") < folder.written.indexOf("manifest.json"));
    assert.equal(JSON.parse(new TextDecoder().decode(folder.store.get("manifest.json"))).version, "1.2.24");
    assert.equal(new TextDecoder().decode(folder.store.get("content/player.js")), "player");
  });

  it("refuses a different extension, a downgrade, and an unsafe path", async () => {
    const key = "same-key";
    const local = { "manifest.json": JSON.stringify({ name: "AutoLurk Companion", version: "1.2.24", key }) };
    const older = fakeGithub({
      "manifest.json": JSON.stringify({ name: "AutoLurk Companion", version: "1.2.23", key }),
    });
    const folder = memoryFolder(local);
    let refused = false;
    try {
      await installRepo(folder.root, { fetch: older, onStatus() {} });
    } catch (error) {
      refused = error.message.includes("newer");
    }
    assert.equal(refused, true);
    assert.deepEqual(folder.written, []);

    const other = fakeGithub({
      "manifest.json": JSON.stringify({ name: "AutoLurk Companion", version: "1.2.25", key: "other-key" }),
    });
    let mismatch = false;
    try {
      await installRepo(memoryFolder(local).root, { fetch: other, onStatus() {} });
    } catch (error) {
      mismatch = error.message.includes("different copy");
    }
    assert.equal(mismatch, true);
    assert.equal(safeRepoPath("../evil"), "");
    assert.equal(safeRepoPath("content/player.js"), "content/player.js");
    assert.equal(
      rawFileUrl("content/player.js"),
      "https://raw.githubusercontent.com/the-mrsir/autolurk/main/content/player.js"
    );
  });

  it("records a newer package from a GitHub repository", async () => {
    mock.reset();
    mock.chrome.runtime.getManifest = () => ({ version: "1.2.6", name: "AutoLurk Companion" });
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, options) => {
      seen.push(String(url));
      assert.equal(options?.headers?.["User-Agent"], undefined);
      if (String(url).includes("api.github.com")) {
        return { ok: true, status: 200, url, json: async () => ({ default_branch: "main" }) };
      }
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({ version: "1.2.9", name: "AutoLurk Companion" }),
      };
    };
    try {
      const { checkForUpdate } = await import("../background/updates.js");
      const status = await checkForUpdate("https://github.com/you/autolurk");
      assert.equal(status.availableVersion, "1.2.9");
      assert.equal(status.packageUrl, "https://codeload.github.com/you/autolurk/zip/refs/heads/main");
      assert.equal(seen.some((url) => url.includes("api.github.com")), true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("records a newer package from the update address", async () => {
    mock.reset();
    mock.chrome.runtime.getManifest = () => ({ version: "1.2.6", name: "AutoLurk Companion" });
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      url: "https://example.com/updates.json",
      json: async () => ({ version: "1.2.8", packageUrl: "https://example.com/autolurk.zip" }),
    });
    try {
      const { checkForUpdate } = await import("../background/updates.js");
      const { getExtensionUpdate } = await import("../shared/storage.js");
      const status = await checkForUpdate("https://example.com/updates.json");
      assert.equal(status.availableVersion, "1.2.8");
      assert.equal(status.packageUrl, "https://example.com/autolurk.zip");
      assert.equal((await getExtensionUpdate()).availableVersion, "1.2.8");

      globalThis.fetch = async () => ({
        ok: true,
        url: "https://example.com/updates.json",
        json: async () => ({ version: "1.2.6", packageUrl: "https://example.com/autolurk.zip" }),
      });
      const current = await checkForUpdate("https://example.com/updates.json");
      assert.equal(current.packageUrl, "");
      assert.equal(current.latestVersion, "1.2.6");
    } finally {
      globalThis.fetch = original;
    }
  });
});
