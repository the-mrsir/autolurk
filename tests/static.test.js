import { assert, describe, it } from "./harness.js";

// A build-step-free extension has no compiler to catch a renamed export or a
// content script left out of the manifest. Chrome reports those only at
// runtime, usually as a silently dead service worker, so they are checked here.

const SOURCES = [
  "shared/constants.js",
  "shared/storage.js",
  "shared/utilities.js",
  "shared/health.js",
  "shared/poll-logic.js",
  "shared/points-logic.js",
  "shared/sync-logic.js",
  "shared/streak-logic.js",
  "shared/update-logic.js",
  "shared/watchdog-logic.js",
  "shared/watchdog-telemetry.js",
  "background/service-worker.js",
  "background/activity.js",
  "background/auth.js",
  "background/channel-points.js",
  "background/drops.js",
  "background/migrations.js",
  "background/multistream.js",
  "background/notifications.js",
  "background/seventv.js",
  "background/streaks.js",
  "background/stream-boot.js",
  "background/stream-manager.js",
  "background/sync.js",
  "background/tab-manager.js",
  "background/twitch-api.js",
  "background/updates.js",
  "background/wake.js",
  "background/watchdog.js",
  "dashboard/dashboard.js",
  "dashboard/update-client.js",
  "dashboard/watchdog-client.js",
  "popup/popup.js",
];

const CONTENT_SCRIPTS = [
  "content/twitch-quality.js",
  "content/twitch-keepalive.js",
  "content/twitch-streak-gql.js",
  "content/twitch-common.js",
  "content/twitch-grid.js",
  "content/twitch-navigation.js",
  "content/twitch-player.js",
  "content/twitch-points.js",
  "content/twitch-streak.js",
  "content/twitch-embed.js",
];

// Everything the service worker pulls in, directly or not. Node and the browser
// both support dynamic import() here, so nothing but a source check can catch
// its use - and in Chrome it is fatal.
const WORKER_SOURCES = SOURCES.filter(
  (path) => path.startsWith("background/") || path.startsWith("shared/")
);

// These checks read the source tree, which the two runners reach differently:
// over HTTP in the browser, off disk under Node.
const inBrowser = typeof location !== "undefined";
const root = new URL("../", import.meta.url);

async function read(path) {
  const target = new URL(path, root);
  if (inBrowser) {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`Missing file: ${path}`);
    return response.text();
  }
  const { readFile } = await import("node:fs/promises");
  return readFile(target, "utf8");
}

function resolvePath(fromPath, specifier) {
  const base = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

// Deliberately simple: the codebase only uses `import { a, b } from "./x.js"`
// and `import x from`, so a regex is enough and avoids pulling in a parser.
function parseImports(source) {
  const imports = [];
  const pattern = /import\s+([^"';]*?)\s*from\s*["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source))) {
    const [, clause, specifier] = match;
    if (!specifier.startsWith(".")) continue;
    const braces = clause.match(/\{([\s\S]*?)\}/);
    const names = braces
      ? braces[1]
          .split(",")
          .map((part) => part.split(/\s+as\s+/)[0].trim())
          .filter(Boolean)
      : [];
    imports.push({ specifier, names });
  }
  return imports;
}

function parseExports(source) {
  const names = new Set();
  const declaration = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g;
  let match;
  while ((match = declaration.exec(source))) names.add(match[1]);

  const list = /export\s*\{([^}]*)\}/g;
  while ((match = list.exec(source))) {
    for (const part of match[1].split(",")) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

describe("static wiring", () => {
  it("keeps the package and extension versions in sync", async () => {
    const manifest = JSON.parse(await read("manifest.json"));
    const packageJson = JSON.parse(await read("package.json"));
    assert.equal(
      manifest.version,
      packageJson.version,
      "manifest.json and package.json advertise different versions"
    );
    assert.ok(
      /^\d+\.\d+\.\d+$/.test(manifest.version),
      `invalid Chrome extension version: ${manifest.version}`
    );
  });

  it("resolves every relative import to a real exported name", async function checkImports() {

    const cache = new Map();
    const load = async (path) => {
      if (!cache.has(path)) cache.set(path, await read(path));
      return cache.get(path);
    };

    const problems = [];
    for (const path of SOURCES) {
      const source = await load(path);
      for (const { specifier, names } of parseImports(source)) {
        const target = resolvePath(path, specifier);
        let exported;
        try {
          exported = parseExports(await load(target));
        } catch {
          problems.push(`${path} imports missing module ${target}`);
          continue;
        }
        for (const name of names) {
          if (!exported.has(name)) problems.push(`${path} imports {${name}} not exported by ${target}`);
        }
      }
    }

    assert.deepEqual(problems, [], "unresolved imports");
  });

  // Measured in Chrome: a module service worker throws "import() is disallowed
  // on ServiceWorkerGlobalScope" for any dynamic import at runtime, including
  // one of the extension's own files. It cost the recovery ladder both of its
  // last two stages, and nothing failed except the recovery itself, so it went
  // unnoticed. Circular imports between worker modules must be static.
  it("never lazily imports anything into the service worker", async () => {
    const offenders = [];
    for (const path of WORKER_SOURCES) {
      const source = await read(path);
      // Ignore the word inside a comment; only a real call matters.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/(^|[^.\w])import\s*\(/.test(stripped)) offenders.push(path);
    }
    assert.deepEqual(offenders, [], `dynamic import() would throw in Chrome: ${offenders}`);
  });

  // JSON has no comments, and Chrome warns about every key it does not know,
  // so an explanatory "_comment" field shows up as a load warning on the
  // extensions page. Explanations belong in the README.
  it("carries no manifest keys Chrome will warn about", async () => {
    const manifest = JSON.parse(await read("manifest.json"));
    const invented = Object.keys(manifest).filter((key) => key.startsWith("_"));
    assert.deepEqual(invented, [], `Chrome will warn about: ${invented}`);
  });

  // The pinned id is what makes two computers share sync storage, and it is
  // derived from this key: the SHA-256 of the DER public key, first 16 bytes,
  // each nibble mapped from 0-f onto a-p. If the key is ever regenerated this
  // fails, which is the point - the README quotes the id and the dashboard
  // shows it, and both machines have to agree.
  it("pins the extension id that cross-machine sync depends on", async () => {
    const manifest = JSON.parse(await read("manifest.json"));
    assert.ok(manifest.key, "manifest.key is missing; sync cannot work without it");

    const der = Uint8Array.from(atob(manifest.key), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
    const id = [...digest.slice(0, 16)]
      .flatMap((byte) => [byte >> 4, byte & 0xf])
      .map((nibble) => "abcdefghijklmnop"[nibble])
      .join("");

    assert.equal(id, "lofaafmcmpeoaflmfjainbofphpooboa", "the extension id moved");
  });

  it("lists every content script in the manifest, in dependency order", async () => {

    const manifest = JSON.parse(await read("manifest.json"));
    assert.equal(manifest.manifest_version, 3);
    const entries = manifest.content_scripts || [];

    const declared = entries.flatMap((entry) => entry.js || []);
    assert.deepEqual(declared, CONTENT_SCRIPTS, "manifest content scripts");
    const isolated = entries.find((entry) => entry.world !== "MAIN")?.js || [];
    // twitch-common defines the shared helpers the other isolated scripts
    // destructure at load. The quality lock intentionally runs first in the
    // page's MAIN world so it can intercept Twitch's own preference writes.
    assert.equal(isolated[0], "content/twitch-common.js");
    assert.equal(entries[0]?.world, "MAIN");
    assert.equal(entries[0]?.run_at, "document_start");

    for (const path of declared) await read(path);
    await read(manifest.background.service_worker);
    assert.equal(manifest.background.type, "module");
  });

  it("keeps the content-script reserved paths in step with the shared list", async () => {

    // Content scripts cannot import modules, so this list is duplicated on
    // purpose. Drift between the two would make the background and the page
    // disagree about what counts as a channel URL.
    const { RESERVED_TWITCH_PATHS } = await import("../shared/constants.js");
    const source = await read("content/twitch-common.js");
    const literal = source.match(/const RESERVED_PATHS = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(literal, "could not find the content-script path list");

    const inContentScript = literal[1]
      .split(",")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .sort();

    assert.deepEqual(inContentScript, [...RESERVED_TWITCH_PATHS].sort());
  });

  // The grid page recognises itself from its own URL before it can ask the
  // background anything, so the marker is duplicated into the content script.
  // If the two drift, the grid either never builds or eats an ordinary Twitch
  // page, and only one of those is obvious.
  it("keeps stream quality ids in step with the settings", async () => {
    const { STREAM_QUALITIES } = await import("../shared/constants.js");
    const ids = STREAM_QUALITIES.map((item) => item.id);
    for (const path of ["content/twitch-player.js", "content/twitch-quality.js"]) {
      const source = await read(path);
      const literal = source.match(/const STREAM_QUALITY_IDS = \[([\s\S]*?)\]/);
      assert.ok(literal, `${path} is missing the quality list`);
      const found = literal[1]
        .split(",")
        .map((part) => part.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      assert.deepEqual(found, ids, path);
    }
    const html = await read("dashboard/dashboard.html");
    for (const id of ["backgroundQuality", "watchingQuality"]) {
      const block = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`));
      assert.ok(block, `${id} is missing from settings`);
      const values = [...block[1].matchAll(/value="([^"]+)"/g)].map((match) => match[1]);
      assert.deepEqual(values, ids, id);
    }
  });

  it("keeps the grid marker in step with the shared constant", async () => {
    const { MULTISTREAM } = await import("../shared/constants.js");
    const source = await read("content/twitch-grid.js");
    const literal = source.match(/const GRID_MARKER = "([^"]+)"/);
    assert.ok(literal, "could not find the content-script grid marker");
    assert.equal(literal[1], MULTISTREAM.GRID_MARKER);
    assert.ok(
      MULTISTREAM.GRID_URL.includes(MULTISTREAM.GRID_MARKER),
      "the grid URL does not carry the marker the page looks for"
    );
  });

  // The player frames are a content script of their own, and a Twitch embed on
  // somebody else's site must be left alone, so the frame script only ever
  // runs where the grid asked for it.
  it("scopes the embed script to player frames the grid opened", async () => {
    const manifest = JSON.parse(await read("manifest.json"));
    const entry = (manifest.content_scripts || []).find((item) =>
      (item.js || []).includes("content/twitch-embed.js")
    );
    assert.ok(entry, "the embed script is not in the manifest");
    assert.deepEqual(entry.matches, ["https://player.twitch.tv/*"]);
    assert.equal(entry.all_frames, true);
    assert.ok(
      (manifest.host_permissions || []).includes("https://player.twitch.tv/*"),
      "player.twitch.tv is missing from host_permissions"
    );
    const requiredHosts = manifest.host_permissions || [];
    assert.equal(
      requiredHosts.some((pattern) => /localhost|127\.0\.0\.1/.test(pattern)),
      false,
      "localhost must stay optional"
    );
    const optionalHosts = manifest.optional_host_permissions || [];
    assert.ok(optionalHosts.includes("http://127.0.0.1/*"));
    assert.ok(optionalHosts.includes("http://localhost/*"));

    const source = await read("content/twitch-embed.js");
    assert.ok(
      /params\.get\("autolurk"\)/.test(source) && /if \(!quality\) return;/.test(source),
      "the embed script does not bail out on frames the grid did not open"
    );
  });

  it("does not reference removed feature modules", async () => {

    const banned = [
      "handleDropsStatus",
      "PLAYER_STATUS",
      "PLAYER_NEEDS_RELOAD",
      // The multistream rewrite: tiles were popup windows before they were
      // frames in one tab, and nothing should reach for the old machinery.
      "MULTISTREAM_MODE",
      "multistreamHomeWindowId",
      "multistreamTabIds",
      "tileLayout",
      "restoreTileMode",
      // Dead wiring removed in the 1.2.5 cleanup. These were exported and
      // never imported, which is how a reader mistakes them for live code.
      "followToChannel",
      "SYNCED_STORAGE_KEYS",
      "NOTIFIED_DROPS",
      // Every live-state and auth write goes through the mutation queue now,
      // because a bare set loses whatever landed during the poll it raced.
      "saveLiveState",
      "saveFollows",
      "saveFavorites",
    ];
    const problems = [];
    for (const path of [...SOURCES, ...CONTENT_SCRIPTS]) {
      const source = await read(path);
      for (const term of banned) {
        if (source.includes(term)) problems.push(`${path} still references ${term}`);
      }
    }
    assert.deepEqual(problems, [], "stale references");
  });
});
