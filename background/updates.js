import { getSettings, saveExtensionUpdate, saveSettings } from "../shared/storage.js";
import {
  compareVersions,
  githubApiUrl,
  githubRawManifestUrl,
  githubZipUrl,
  parseGithubRepo,
  parseUpdateManifest,
} from "../shared/update-logic.js";

const EMPTY = {
  checkedAt: 0,
  latestVersion: "",
  availableVersion: "",
  packageUrl: "",
  error: "",
};

async function originAllowed() {
  if (!chrome.permissions?.contains) return true;
  try {
    // Granted https://*/* covers GitHub. Asking contains() for the individual
    // GitHub origins reports false even after that grant.
    return await chrome.permissions.contains({ origins: ["https://*/*"] });
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  // Chrome refuses a custom User-Agent and throws before the request is sent.
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    const error = new Error(`The update address returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  if (!String(response.url || url).startsWith("https:")) {
    throw new Error("The update address has to stay on https.");
  }
  return response.json();
}

// Reads version from the repository and points the download at GitHub's zip
// of that same branch. Raising manifest.json and pushing is the whole release.
function githubFailure(error, missing) {
  if (error?.status === 404) throw new Error(missing);
  if (error?.status === 403) throw new Error("GitHub refused the update check. Try again later.");
  throw error;
}

async function manifestFromGithub(repo) {
  let branch = repo.branch;
  if (!branch) {
    let info;
    try {
      info = await fetchJson(githubApiUrl(repo));
    } catch (error) {
      githubFailure(error, "That GitHub repository is missing or private. Updates need a public repository.");
    }
    branch = String(info.default_branch || "");
    if (!branch) throw new Error("That GitHub repository has no default branch.");
  }
  let manifest;
  try {
    manifest = await fetchJson(githubRawManifestUrl(repo, branch));
  } catch (error) {
    githubFailure(error, "That repository has no manifest.json at the top. Put the extension folder at the root of the repo.");
  }
  return parseUpdateManifest({ version: manifest.version, packageUrl: githubZipUrl(repo, branch) });
}

export async function checkForUpdate(url) {
  const settings = await getSettings();
  const manifestUrl = String(url != null ? url : settings.updateManifestUrl || "").trim();
  const currentVersion = chrome.runtime.getManifest?.().version || "";

  if (!manifestUrl) {
    const status = { ...EMPTY, currentVersion };
    await saveExtensionUpdate(status);
    return status;
  }

  if (manifestUrl !== settings.updateManifestUrl) {
    await saveSettings({ updateManifestUrl: manifestUrl });
  }

  try {
    const allowed = await originAllowed();
    if (!allowed) {
      throw new Error("Allow the update address from the dashboard, then check again.");
    }
    const repo = parseGithubRepo(manifestUrl);
    const parsed = repo ? await manifestFromGithub(repo) : parseUpdateManifest(await fetchJson(manifestUrl));
    const compared = compareVersions(parsed.version, currentVersion);
    if (compared == null) throw new Error("The update version is invalid.");
    const newer = compared > 0;
    const status = {
      checkedAt: Date.now(),
      latestVersion: parsed.version,
      availableVersion: newer ? parsed.version : "",
      packageUrl: newer ? parsed.packageUrl : "",
      error: "",
      currentVersion,
    };
    await saveExtensionUpdate(status);
    return status;
  } catch (error) {
    const status = {
      ...EMPTY,
      checkedAt: Date.now(),
      error: error?.message || "Could not check for an update.",
      currentVersion,
    };
    await saveExtensionUpdate(status);
    return status;
  }
}
