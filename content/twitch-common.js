// Loaded before the other content scripts. Content scripts cannot use ES
// modules, but they do share one isolated world per extension, so this is the
// only way to keep a single definition of the Twitch path rules.
(() => {
  // Must stay identical to RESERVED_TWITCH_PATHS in shared/constants.js.
  // A content script cannot import it, so tests/static.test.js compares them.
  const RESERVED_PATHS = new Set([
    "activate", "bits", "broadcast", "clips", "directory", "downloads", "drops",
    "embed", "friends", "inventory", "jobs", "login", "moderator", "p",
    "payments", "popout", "prime", "privacy", "products", "search", "settings",
    "signup", "store", "subs", "subscriptions", "team", "turbo", "u", "user",
    "video", "videos", "wallet",
  ]);

  function extractChannel(pathname = location.pathname) {
    const parts = pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    if (parts[0] === "popout" || parts[0] === "moderator" || parts[0] === "embed") {
      const next = parts[1]?.toLowerCase();
      return next && !RESERVED_PATHS.has(next) ? next : null;
    }
    const first = parts[0].toLowerCase();
    return RESERVED_PATHS.has(first) ? null : first;
  }

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, () => void chrome.runtime.lastError);
    } catch {
      // The extension context disappears on reload; nothing to report to.
    }
  }

  globalThis.__autoLurk = { RESERVED_PATHS, extractChannel, send };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "APPLY_UPDATE_FILES") return;
    writeUpdate(message.entries || [], message.expected || {}).then(
      (version) => sendResponse({ ok: true, version }),
      (error) => sendResponse({ ok: false, error: error?.message || "The update was not written." })
    );
    return true;
  });

  function writeUpdate(entries, expected) {
    const picker = globalThis.showDirectoryPicker;
    if (typeof picker !== "function") {
      return Promise.reject(new Error("This Chrome cannot choose the extension folder."));
    }
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#16171d;color:#f2f2f2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font:16px/1.4 Segoe UI,sans-serif;text-align:center;padding:24px;";
    const title = document.createElement("p");
    title.textContent = "Choose the folder you loaded on chrome://extensions. It contains manifest.json.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Choose AutoLurk folder";
    button.style.cssText = "font:inherit;padding:10px 16px;cursor:pointer;";
    const status = document.createElement("p");
    root.append(title, button, status);
    (document.body || document.documentElement).append(root);

    return new Promise((resolve, reject) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        status.textContent = "Waiting for the folder…";
        try {
          const dir = await picker({ mode: "readwrite", id: "autolurk-extension" });
          const manifest = JSON.parse(await (await (await dir.getFileHandle("manifest.json")).getFile()).text());
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
          resolve(expected.version);
        } catch (error) {
          button.disabled = false;
          const cancelled = error?.name === "AbortError";
          status.textContent = cancelled ? "Choose the AutoLurk folder to continue." : error.message;
          reject(cancelled ? new Error("Choose the AutoLurk folder to continue.") : error);
        }
      });
    });
  }
})();
