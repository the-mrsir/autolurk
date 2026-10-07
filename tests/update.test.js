import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { assert, describe, it } from "./harness.js";
import { chromeMock } from "./chrome-mock.js";
import {
  compareVersions,
  describeUpdate,
  updateStillNewer,
  extractZip,
  githubZipUrl,
  listedUpdateOrigins,
  parseGithubRepo,
  parseUpdateManifest,
  readUpdaterReply,
  safeZipPath,
  UPDATER_HOST,
  updateInstallRequest,
  updaterMissing,
  updaterRequest,
  updateOrigins,
  validatePackageManifest,
} from "../shared/update-logic.js";

const mock = chromeMock();

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
      "Version 1.2.7 is on GitHub. Click Update now to install it."
    );
    assert.equal(
      describeUpdate({ checkedAt: 1, latestVersion: "1.2.6" }, "https://example.com/updates.json"),
      "You're on the latest version (1.2.6)."
    );
    assert.equal(
      describeUpdate(
        {
          packageUrl: "https://example.com/a.zip",
          availableVersion: "1.2.7",
          currentVersion: "1.2.7",
          checkedAt: 1,
          latestVersion: "1.2.7",
        },
        "https://example.com/updates.json"
      ),
      "You're on the latest version (1.2.7)."
    );
    assert.equal(
      updateStillNewer({ packageUrl: "https://example.com/a.zip", availableVersion: "1.2.7", currentVersion: "1.2.7" }),
      false
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
    assert.equal(client.includes("showDirectoryPicker"), false);
    assert.equal(client.includes("UPDATER_PAGE"), false);
    assert.equal(dashboard.includes("openUpdater"), false);
    assert.equal(dashboard.includes("applyUpdateBtn"), false);
    assert.equal(popup.includes("UPDATER_PAGE"), false);
    assert.equal(worker.includes("onMessageExternal"), false);
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

describe("Update now", () => {
  it("asks the helper for the configured repository, or AutoLurk's own", () => {
    assert.deepEqual(updaterRequest("https://github.com/someone/fork/tree/dev"), {
      action: "update",
      owner: "someone",
      repo: "fork",
      branch: "dev",
    });
    assert.deepEqual(updaterRequest(""), { action: "update", owner: "the-mrsir", repo: "autolurk", branch: "main" });
  });

  it("reloads only when the folder now holds a newer version", () => {
    assert.equal(readUpdaterReply({ ok: true, version: "1.2.49" }, "1.2.48").reload, true);
    const same = readUpdaterReply({ ok: true, version: "1.2.48" }, "1.2.48");
    assert.equal(same.reload, false);
    assert.ok(same.text.includes("latest"));
    const failed = readUpdaterReply({ ok: false, error: "git pull failed: conflict" }, "1.2.48");
    assert.equal(failed.reload, false);
    assert.ok(failed.text.includes("git pull failed"));
    assert.equal(readUpdaterReply(undefined, "1.2.48").reload, false);
  });

  it("tells a computer without the helper how to set it up", () => {
    assert.ok(updaterMissing(new Error("Specified native messaging host not found.")));
    assert.ok(updaterMissing(new Error("Access to the specified native messaging host is forbidden.")));
    assert.notOk(updaterMissing(new Error("Native host has exited.")));
  });

  it("asks for native messaging only when Update now is used", () => {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    assert.ok(manifest.optional_permissions.includes("nativeMessaging"));
    assert.notOk(manifest.permissions.includes("nativeMessaging"));
  });

  it("registers the helper for the id the manifest key gives this extension", () => {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    const hash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
    const id = [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
    for (const file of ["install-windows.ps1", "install-linux.sh"]) {
      const text = readFileSync(new URL(`../updater/${file}`, import.meta.url), "utf8");
      assert.ok(text.includes(`"${id}"`), `${file} registers ${id}`);
      assert.ok(text.includes(UPDATER_HOST), `${file} registers ${UPDATER_HOST}`);
    }
    for (const file of ["autolurk-updater.ps1", "autolurk-updater.py"]) {
      const text = readFileSync(new URL(`../updater/${file}`, import.meta.url), "utf8");
      assert.ok(text.includes("would change the extension id"), `${file} checks the key`);
    }
  });
});
