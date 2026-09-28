import { MESSAGE } from "../shared/constants.js";
import { checkForUpdate } from "../background/updates.js";
import { describeUpdate } from "../shared/update-logic.js";
import { allowUpdateOrigin, installUpdatePackage } from "./update-client.js";
import {
  compareFavorites,
  escapeHtml,
  formatActivityDay,
  formatClock,
  formatRelativeTime,
  formatUptime,
  formatUserCode,
  formatViewers,
} from "../shared/utilities.js";

const state = {
  snapshot: null,
  view: "live",
  search: "",
  sort: "live",
  followFilter: "all",
  openRows: new Set(),
  settingsDirty: false,
  // Channels picked for the next tiled session. Cleared once it starts; the
  // running session is described by the snapshot, not by this.
  multistreamPicks: new Set(),
  multistreamStatus: "",
};

const $ = (id) => document.getElementById(id);

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Request failed");
    return response.result;
  });
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  const titles = { live: "Live", following: "Following", activity: "Activity", settings: "Settings" };
  $("pageTitle").textContent = titles[view];
  render();
}

function matchesSearch(item) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return [item.displayName, item.login, item.stream?.gameName, item.stream?.title]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

function ageLabel(ms) {
  if (ms == null) return "never";
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

function streamerState(item) {
  const bits = [];
  const playback = item.playback;

  if (playback) bits.push(playback.label);
  else if (item.isLive && item.isFavorite) bits.push("Not opened");

  if (item.managed?.muted) bits.push("Tab muted");
  if (item.managed?.playerMuted) bits.push("Player muted");
  if (item.favorite?.snoozeUntilNextStream) bits.push("Snoozed");
  if (!item.isLive) bits.push("Offline");
  if (item.isStale) bits.push("Status unconfirmed");
  return bits.join(" · ");
}

// The evidence panel exists because the old UI said "Watching" from a flag
// that survived the stream dying. Everything shown here is an observation with
// an age attached, and the one thing AutoLurk cannot observe is said plainly.
function playbackDetail(playback) {
  if (!playback) return "";
  const facts = [
    ["Playback", playback.label + (playback.reason ? ` — ${playback.reason}` : "")],
    ["Twitch credit", "not verifiable by this extension"],
    ["Channel on screen", playback.observedChannel || "unknown"],
    ["Media element", playback.mediaPlaying ? "decoding" : "not playing"],
    [
      "Video quality",
      playback.selectedQuality
        ? `${playback.selectedQuality}${playback.videoWidth ? ` · ${playback.videoWidth}×${playback.videoHeight}` : ""}${
            playback.adPlaying ? " · preroll/ad (Twitch controls ad resolution)" : ""
          }`
        : "not reported yet",
    ],
    ["Last page report", ageLabel(playback.heartbeatAgeMs)],
    ["Last frame advance", ageLabel(playback.lastAdvanceAgeMs)],
    ["Tab audio", playback.tabMuted ? "muted" : "audible"],
    ["Player audio", playback.playerMuted === null ? "unknown" : playback.playerMuted ? "muted" : "unmuted"],
  ];
  if (playback.recoveryAttempts) {
    facts.push(["Recovery", `${playback.recoveryStage || "pending"} · attempt ${playback.recoveryAttempts}`]);
  }
  if (playback.adopted) facts.push(["Tab", "adopted from an existing window"]);

  return `
    <div class="evidence">
      ${facts
        .map(
          ([label, value]) =>
            `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b></div>`
        )
        .join("")}
    </div>
  `;
}

// Twitch abbreviates the balance past a thousand, so a claimed bonus often
// leaves the on-screen number unchanged. Claims are counted from the chest
// disappearing; the balance is shown as what the page said, marked when the
// page itself was rounding.
function pointsDetail(points) {
  if (!points || (!points.claims && points.balance === null)) return "";
  const balance =
    points.balance === null
      ? "not read yet"
      : `${points.balance.toLocaleString()}${points.balanceApproximate ? " (rounded by Twitch)" : ""}`;
  const facts = [
    ["Balance", balance],
    ["Bonuses claimed", String(points.claims || 0)],
    ["Last claim", points.lastClaimAt ? ageLabel(Date.now() - points.lastClaimAt) : "never"],
  ];
  if (points.unconfirmedClaims) {
    facts.push(["Clicks not confirmed", String(points.unconfirmedClaims)]);
  }
  return `
    <div class="evidence">
      <div class="evidence-title">Channel points</div>
      ${facts
        .map(
          ([label, value]) =>
            `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`
        )
        .join("")}
    </div>
  `;
}

function sevenTvDetail(sevenTv) {
  if (!sevenTv) return "";
  if (sevenTv.error) {
    return `<div class="evidence"><div class="evidence-title">7TV</div><div><span>Lookup failed</span><b>${escapeHtml(sevenTv.error)}</b></div></div>`;
  }
  if (sevenTv.absent) {
    return `<div class="evidence"><div class="evidence-title">7TV</div><div><span>Channel</span><b>no 7TV emotes</b></div></div>`;
  }

  const emotes = (sevenTv.emotes || [])
    .filter((emote) => emote.url)
    .map(
      (emote) =>
        `<img class="emote" src="${escapeHtml(emote.url)}" alt="${escapeHtml(emote.name)}" title="${escapeHtml(emote.name)}" loading="lazy" />`
    )
    .join("");

  return `
    <div class="evidence">
      <div class="evidence-title">7TV</div>
      <div><span>Emote set</span><b>${escapeHtml(sevenTv.setName || "unnamed")}</b></div>
      <div><span>Emotes</span><b>${escapeHtml(String(sevenTv.emoteCount || 0))}</b></div>
      ${emotes ? `<div class="emotes">${emotes}</div>` : ""}
      ${sevenTv.profileUrl ? `<div><span>Profile</span><b><a href="${escapeHtml(sevenTv.profileUrl)}" target="_blank" rel="noreferrer">Open on 7tv.app</a></b></div>` : ""}
    </div>
  `;
}

function row(item, mode) {
  const stream = item.stream;
  const favorite = item.favorite;
  const managed = item.managed;
  const open = state.openRows.has(item.userId);

  if (mode === "follow") {
    return `
      <article class="follow-tile ${item.isLive ? "is-live" : ""}" data-user="${escapeHtml(item.userId)}">
        <div class="follow-top">
          <img class="avatar" src="${escapeHtml(item.profileImageUrl || "../icons/icon32.png")}" alt="" />
          <button class="star ${item.isFavorite ? "on" : ""}" data-action="favorite" title="${item.isFavorite ? "Unfavorite" : "Favorite"}">${item.isFavorite ? "★" : "☆"}</button>
        </div>
        <div class="name">${escapeHtml(item.displayName || item.login)}</div>
        <div class="status">${item.isLive ? "LIVE" : "Offline"}${stream?.gameName ? ` · ${escapeHtml(stream.gameName)}` : ""}</div>
        <div class="actions">
          <button data-action="open" type="button">${managed ? "Focus" : "Open"}</button>
          ${item.isFavorite ? `<button data-action="toggle-settings" type="button">${open ? "Hide" : "Rules"}</button>` : ""}
        </div>
        ${item.isFavorite && open ? favoriteSettings(favorite) : ""}
      </article>
    `;
  }

  return `
    <article class="row ${item.isLive ? "is-live" : ""}" data-user="${escapeHtml(item.userId)}">
      <button class="star ${item.isFavorite ? "on" : ""}" data-action="favorite" title="${item.isFavorite ? "Unfavorite" : "Favorite"}">${item.isFavorite ? "★" : "☆"}</button>
      <img class="avatar" src="${escapeHtml(item.profileImageUrl || "../icons/icon32.png")}" alt="" />
      <div>
        <div class="name">${escapeHtml(item.displayName || item.login)}</div>
        ${stream?.title ? `<div class="title">${escapeHtml(stream.title)}</div>` : ""}
        <div class="status">${escapeHtml(streamerState(item))}</div>
      </div>
      <div class="sub">${escapeHtml(stream?.gameName || "")}</div>
      <div class="sub">${stream ? formatViewers(stream.viewerCount) : ""}</div>
      <div class="sub">${stream ? formatUptime(stream.startedAt) : ""}</div>
      <div class="actions">
        <button data-action="open" type="button">${managed ? "Focus" : "Open"}</button>
        ${managed ? `<button data-action="retry" type="button">Retry</button>` : ""}
        ${managed ? `<button data-action="release" type="button" title="Leave the tab open but stop managing it">Stop managing</button>` : ""}
        ${managed ? `<button data-action="close" type="button">Close</button>` : ""}
        ${item.isFavorite && item.favorite?.snoozeUntilNextStream ? `<button data-action="unsnooze" type="button">Unsnooze</button>` : ""}
        ${item.isFavorite && !item.favorite?.snoozeUntilNextStream ? `<button data-action="snooze" type="button">Snooze</button>` : ""}
        ${item.isFavorite || managed ? `<button data-action="toggle-settings" type="button">${open ? "Hide" : "Details"}</button>` : ""}
      </div>
      ${open ? playbackDetail(item.playback) : ""}
      ${open ? pointsDetail(item.points) : ""}
      ${open ? sevenTvDetail(item.sevenTv) : ""}
      ${item.isFavorite && open ? favoriteSettings(favorite) : ""}
    </article>
  `;
}

function notifyOverride(favorite, key, label) {
  const value = favorite[key];
  const selected = value === true ? "on" : value === false ? "off" : "default";
  return `
    <label>${label}
      <select data-fav-notify="${key}">
        <option value="default" ${selected === "default" ? "selected" : ""}>Use setting</option>
        <option value="on" ${selected === "on" ? "selected" : ""}>On</option>
        <option value="off" ${selected === "off" ? "selected" : ""}>Off</option>
      </select>
    </label>
  `;
}

function favoriteSettings(favorite) {
  return `
    <div class="details">
      <label><input data-fav="autoOpen" type="checkbox" ${favorite.autoOpen ? "checked" : ""} /> Auto open</label>
      ${notifyOverride(favorite, "notifyLive", "Live notification")}
      ${notifyOverride(favorite, "notifyGameChange", "Category changes")}
      ${notifyOverride(favorite, "notifyTitleChange", "Title changes")}
      <label><input data-fav="autoClose" type="checkbox" ${favorite.autoClose !== false ? "checked" : ""} /> Auto close</label>
      <label>Priority
        <select data-fav="priority">
          <option value="high" ${favorite.priority === "high" ? "selected" : ""}>High</option>
          <option value="normal" ${favorite.priority === "normal" ? "selected" : ""}>Normal</option>
          <option value="low" ${favorite.priority === "low" ? "selected" : ""}>Low</option>
        </select>
      </label>
      <label>Only auto-open
        <input data-fav="includeCategories" type="text" value="${escapeHtml((favorite.includeCategories || []).join(", "))}" placeholder="World of Warcraft" />
      </label>
      <label>Never auto-open
        <input data-fav="excludeCategories" type="text" value="${escapeHtml((favorite.excludeCategories || []).join(", "))}" placeholder="Just Chatting" />
      </label>
    </div>
  `;
}

function fillList(id, emptyId, items, mode) {
  const filtered = items.filter(matchesSearch);
  $(id).innerHTML = filtered.map((item) => row(item, mode)).join("");
  $(emptyId).classList.toggle("hidden", filtered.length > 0);
}

function sortChannels(items) {
  const liveMap = Object.fromEntries(items.map((item) => [item.userId, item.stream || {}]));
  return [...items].sort((a, b) =>
    compareFavorites(
      { ...a, priority: a.favorite?.priority || "normal" },
      { ...b, priority: b.favorite?.priority || "normal" },
      state.sort,
      liveMap
    )
  );
}

function fillFollowGrid(listId, items) {
  const filtered = sortChannels(items).filter(matchesSearch);
  $(listId).innerHTML = filtered.map((item) => row(item, "follow")).join("");
  return filtered.length;
}

function setCount(id, count) {
  $(id).textContent = count ? String(count) : "";
}

function render() {
  const snap = state.snapshot;
  const connected = Boolean(snap?.connected);
  const flow = snap?.deviceFlow;
  const needsSetup = !snap?.settings?.clientId || !connected || flow;

  $("setupView").classList.toggle("hidden", connected && !flow);
  if (state.view === "settings") $("setupView").classList.add("hidden");

  $("liveView").classList.toggle("hidden", !connected || Boolean(flow) || state.view !== "live");
  $("followingView").classList.toggle("hidden", !connected || Boolean(flow) || state.view !== "following");
  $("activityView").classList.toggle("hidden", !connected || Boolean(flow) || state.view !== "activity");
  $("settingsView").classList.toggle("hidden", state.view !== "settings");

  const showToolbar = connected && !flow && (state.view === "live" || state.view === "following");
  $("streamerToolbar").classList.toggle("hidden", !showToolbar);
  $("followFilters").classList.toggle("hidden", state.view !== "following");

  renderSetup(snap);
  if (!snap) return;

  $("sidebarUser").textContent = connected ? snap.user?.displayName || snap.user?.login : "Not connected";
  $("sidebarCounts").textContent = `${snap.liveFavorites?.length || 0} live · ${snap.managedCount || 0} managed`;
  $("pauseBtn").textContent = snap.settings.automationEnabled ? "Pause AutoLurk" : "Resume AutoLurk";
  $("pageMeta").textContent = snap.lastPollAt ? `Checked ${formatRelativeTime(snap.lastPollAt)}` : "";
  $("syncMeta").textContent = `Checked ${formatRelativeTime(snap.lastPollAt)} · Follows ${formatRelativeTime(snap.lastFollowsSyncAt)}`;

  renderBanners(snap);
  renderMultistream(snap);
  renderLive(snap);
  renderFollowing(snap);
  renderActivity(snap);
  renderSettings(snap);
  renderUpdate(snap);
  watchDeviceFlow(snap.deviceFlow);
}

// Problems that persist need to stay on screen. Previously an expired token or
// a failing Twitch API only appeared in the service worker console, so the
// dashboard would quietly show hours-old data as if it were current.
function renderBanners(snap) {
  const banners = [];
  const poll = snap.poll || {};

  if (poll.status === "unauthorized") {
    banners.push({
      tone: "error",
      text: "Twitch sign-in expired. Reconnect under Settings to resume monitoring.",
    });
  } else if (poll.status === "failed" || poll.failureStreak >= 2) {
    banners.push({
      tone: "warn",
      text: poll.error || "Cannot reach Twitch. Showing the last known status.",
    });
  } else if (poll.status === "partial") {
    banners.push({ tone: "warn", text: poll.error || "Twitch returned incomplete data." });
  }

  if (poll.rateLimitedUntil > Date.now()) {
    banners.push({
      tone: "warn",
      text: `Twitch is rate limiting AutoLurk. Checks resume ${formatRelativeTime(poll.rateLimitedUntil)}.`,
    });
  }

  const staleMinutes = poll.staleForMs ? Math.floor(poll.staleForMs / 60_000) : 0;
  if (staleMinutes >= 15) {
    banners.push({
      tone: "warn",
      text: `Live data is ${staleMinutes} minutes old. The last successful check was ${formatRelativeTime(poll.lastSuccessfulPollAt)}.`,
    });
  }

  if (snap.automationPaused) {
    banners.push({ tone: "info", text: "AutoLurk is paused. Nothing will open or close automatically." });
  }

  // 7TV rebuilds parts of the Twitch page, which is the usual explanation when
  // the player readings or the points chest cannot be found.
  if (snap.sevenTvExtension) {
    banners.push({
      tone: "info",
      text: "The 7TV extension is active on Twitch. If playback readings or channel point claims look wrong, it is the likeliest cause.",
    });
  }

  $("banners").innerHTML = banners
    .map((banner) => `<div class="banner ${banner.tone}">${escapeHtml(banner.text)}</div>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Multistream
// ---------------------------------------------------------------------------

function multistreamState(snap) {
  return snap?.multistream || { active: false, max: 4, tiles: [] };
}

function chip(item, { on, audible, disabled }) {
  const audio = audible === undefined ? "" : `<span class="audio">${audible ? "audible" : "muted"}</span>`;
  return `
    <button type="button" class="ms-chip ${on ? "on" : ""} ${audible ? "audible" : ""}"
      data-ms-user="${escapeHtml(String(item.userId))}" ${disabled ? "disabled" : ""}>
      ${escapeHtml(item.displayName || item.login)}${audio}
    </button>
  `;
}

// The picker is only ever a list of live channels. The grid itself is a Twitch
// tab, so there is nothing of it for the dashboard to draw.
function renderMultistream(snap) {
  const ms = multistreamState(snap);
  const ready = Boolean(snap?.connected) && !snap?.deviceFlow;
  // A running session stays reachable from every view, because exiting it is
  // the one control the user may need in a hurry.
  const show = ready && (ms.active || state.view === "live");
  $("multistreamBar").classList.toggle("hidden", !show);
  if (!show) return;

  const live = [...(snap.liveFavorites || []), ...(snap.otherLiveFollows || [])];
  const liveIds = new Set(live.map((item) => String(item.userId)));
  for (const userId of [...state.multistreamPicks]) {
    if (!liveIds.has(userId)) state.multistreamPicks.delete(userId);
  }

  const max = ms.max || 4;
  const picked = state.multistreamPicks.size;

  $("multistreamPicker").innerHTML = ms.active
    ? ms.tiles.map((tile) => chip(tile, { on: true, audible: tile.audible })).join("")
    : live
        .map((item) =>
          chip(item, {
            on: state.multistreamPicks.has(String(item.userId)),
            disabled: !state.multistreamPicks.has(String(item.userId)) && picked >= max,
          })
        )
        .join("");

  $("multistreamEmpty").classList.toggle("hidden", ms.active || live.length > 0);
  $("multistreamHint").textContent = ms.active
    ? "Click a channel to give it the sound. Your lurk tabs keep running in the group either way."
    : `Pick 2–${max} live channels. They open together in one Twitch tab, with one of them audible.`;
  $("multistreamCount").textContent = ms.active
    ? `${ms.tiles.length} in the grid`
    : `${picked} of ${max} selected`;

  $("multistreamStartBtn").classList.toggle("hidden", ms.active);
  $("multistreamStartBtn").disabled = picked < 2 || picked > max;
  $("multistreamFocusBtn").classList.toggle("hidden", !ms.active);
  $("multistreamExitBtn").classList.toggle("hidden", !ms.active);
  $("multistreamStatus").textContent = state.multistreamStatus;
}

function renderSetup(snap) {
  const published = Boolean(snap?.settings?.publishedApp);
  const clientId = snap?.settings?.clientId || "";
  $("publisherSetup").classList.toggle("hidden", published);
  $("publicConnectRow").classList.toggle("hidden", !published);
  if (!published && document.activeElement !== $("clientIdInput")) {
    $("clientIdInput").value = clientId;
  }
  const flow = snap?.deviceFlow;
  $("deviceBox").classList.toggle("hidden", !flow);
  if (flow) {
    $("userCode").textContent = formatUserCode(flow.userCode);
    $("activateLink").href = flow.verificationUri;
    $("setupStatus").textContent = "Waiting for Twitch…";
  } else if (snap?.connected) {
    $("setupStatus").textContent = `Connected as ${snap.user?.displayName || snap.user?.login}`;
  } else {
    $("setupStatus").textContent = published ? "" : clientId ? "Client ID saved." : "";
  }
}

function renderLive(snap) {
  const live = sortChannels(snap.liveFavorites || []);
  const other = sortChannels(snap.otherLiveFollows || []);
  setCount("liveFavCount", live.filter(matchesSearch).length);
  setCount("otherLiveCount", other.filter(matchesSearch).length);
  fillList("liveFavorites", "emptyLiveFavorites", live);
  fillList("otherLive", "emptyOtherLive", other);
}

function renderFollowing(snap) {
  const rows = snap.allChannels || [];
  const showLive = state.followFilter === "all" || state.followFilter === "live";
  const showOffline = state.followFilter === "all" || state.followFilter === "offline";
  const favoritesOnly = state.followFilter === "favorites";

  const liveStarred = rows.filter((item) => item.isLive && item.isFavorite);
  const liveOther = rows.filter((item) => item.isLive && !item.isFavorite);
  const starred = rows.filter((item) => item.isFavorite && !item.isLive);
  const rest = rows.filter((item) => !item.isFavorite && !item.isLive);

  const liveStarredCount = showLive || favoritesOnly ? fillFollowGrid("followLiveStarred", liveStarred) : 0;
  const liveOtherCount = showLive && !favoritesOnly ? fillFollowGrid("followLiveOther", liveOther) : 0;
  const starredCount = showOffline || favoritesOnly ? fillFollowGrid("followStarred", starred) : 0;
  const restCount = showOffline && !favoritesOnly ? fillFollowGrid("followRest", rest) : 0;

  $("followLiveStarredBlock").classList.toggle("hidden", liveStarredCount === 0);
  $("followLiveOtherBlock").classList.toggle("hidden", liveOtherCount === 0);
  $("followLiveBlock").classList.toggle("hidden", liveStarredCount + liveOtherCount === 0);
  $("followStarredBlock").classList.toggle("hidden", starredCount === 0);
  $("followRestBlock").classList.toggle("hidden", restCount === 0);
  $("emptyFollows").classList.toggle("hidden", liveStarredCount + liveOtherCount + starredCount + restCount > 0);

  setCount("followLiveCount", liveStarredCount + liveOtherCount);
  setCount("followLiveStarredCount", liveStarredCount);
  setCount("followLiveOtherCount", liveOtherCount);
  setCount("followStarredCount", starredCount);
  setCount("followRestCount", restCount);
}

function renderActivity(snap) {
  const items = snap.activity || [];
  $("emptyActivity").classList.toggle("hidden", items.length > 0);
  let day = "";
  $("activityList").innerHTML = items.map((item) => {
    const label = formatActivityDay(item.at);
    const heading = label !== day ? `<div class="activity-day">${escapeHtml(label)}</div>` : "";
    day = label;
    const tone = item.level === "warn" ? " warn" : "";
    return `${heading}<div class="activity-row${tone}"><time>${escapeHtml(formatClock(item.at))}</time><span>${escapeHtml(item.text)}</span></div>`;
  }).join("");
}

function renderSettings(snap) {
  const settings = snap.settings || {};
  const published = Boolean(settings.publishedApp);
  $("settingsClientRow").classList.toggle("hidden", published);
  $("publishedClientNote").classList.toggle("hidden", !published);
  if (state.settingsDirty) return;
  const map = {
    automationEnabled: "checked",
    autoOpenFavorites: "checked",
    muteTabs: "checked",
    groupTabs: "checked",
    collapseGroup: "checked",
    autoCloseOffline: "checked",
    closeRaids: "checked",
    reopenIfManuallyClosed: "checked",
    notifyLive: "checked",
    notifyGameChange: "checked",
    notifyTitleChange: "checked",
    notifyOnlyWhenNotOpened: "checked",
    claimChannelPoints: "checked",
    claimOnManagedTabsOnly: "checked",
    saveWatchStreaks: "checked",
    streakOpenInFront: "checked",
    openInFront: "value",
    serverRotation: "checked",
    backgroundQuality: "value",
    watchingQuality: "value",
    updateManifestUrl: "value",
    sevenTvEnabled: "checked",
    syncEnabled: "checked",
    syncGroup: "value",
    checkIntervalSeconds: "value",
    groupColor: "value",
    maxAutoOpenStreams: "value",
    offlineGraceSeconds: "value",
  };
  for (const [id, prop] of Object.entries(map)) {
    const el = $(id);
    if (!el) continue;
    if (prop === "checked") el.checked = Boolean(settings[id]);
    else el.value = settings[id] ?? "";
  }
  if (!published) $("settingsClientId").value = settings.clientId || "";

  const points = snap.points || {};
  $("pointsSummary").textContent = points.claims
    ? `${points.claims} bonus ${points.claims === 1 ? "chest" : "chests"} claimed across ${points.channels} ${points.channels === 1 ? "channel" : "channels"}, most recently ${formatRelativeTime(points.lastClaimAt)}.`
    : "No bonus chests claimed yet.";

  const sync = snap.sync || {};
  const syncSummary = $("syncSummary");
  if (syncSummary) {
    const name = String(settings.syncGroup || "").trim();
    syncSummary.textContent = !settings.syncEnabled
      ? "Sync is off. Favorites stay on this computer."
      : !name
        ? "A sync code is created when the extension starts."
        : sync.lastSyncedAt
          ? `Sharing favorites and settings with code ${name}. Last synced ${formatRelativeTime(sync.lastSyncedAt)}.`
          : `Sharing favorites and settings with code ${name}. Not synced yet.`;
  }
}

function renderUpdate(snap) {
  const update = snap?.update || {};
  const address = $("updateManifestUrl")?.value.trim() || snap?.settings?.updateManifestUrl || "";
  const status = $("updateStatus");
  if (status) {
    const installed = update.currentVersion ? `Installed ${update.currentVersion}. ` : "";
    status.textContent = `${installed}${describeUpdate(update, address)}`;
  }
  const button = $("applyUpdateBtn");
  if (button) {
    const ready = Boolean(update.packageUrl && update.availableVersion);
    button.classList.toggle("hidden", !ready);
    button.disabled = !ready;
    button.textContent = ready ? `Update to ${update.availableVersion}` : "Update";
  }
}

function collectSettings() {
  const patch = {
    automationEnabled: $("automationEnabled").checked,
    autoOpenFavorites: $("autoOpenFavorites").checked,
    muteTabs: $("muteTabs").checked,
    groupTabs: $("groupTabs").checked,
    collapseGroup: $("collapseGroup").checked,
    autoCloseOffline: $("autoCloseOffline").checked,
    closeRaids: $("closeRaids").checked,
    reopenIfManuallyClosed: $("reopenIfManuallyClosed").checked,
    notifyLive: $("notifyLive").checked,
    notifyGameChange: $("notifyGameChange").checked,
    notifyTitleChange: $("notifyTitleChange").checked,
    notifyOnlyWhenNotOpened: $("notifyOnlyWhenNotOpened").checked,
    claimChannelPoints: $("claimChannelPoints").checked,
    claimOnManagedTabsOnly: $("claimOnManagedTabsOnly").checked,
    saveWatchStreaks: $("saveWatchStreaks").checked,
    streakOpenInFront: $("streakOpenInFront").checked,
    openInFront: $("openInFront").value,
    serverRotation: $("serverRotation").checked,
    backgroundQuality: $("backgroundQuality").value,
    watchingQuality: $("watchingQuality").value,
    updateManifestUrl: $("updateManifestUrl").value.trim(),
    sevenTvEnabled: $("sevenTvEnabled").checked,
    syncEnabled: $("syncEnabled").checked,
    syncGroup: $("syncGroup").value.trim(),
    checkIntervalSeconds: Number($("checkIntervalSeconds").value),
    groupColor: $("groupColor").value,
    maxAutoOpenStreams: Number($("maxAutoOpenStreams").value),
    offlineGraceSeconds: Number($("offlineGraceSeconds").value),
  };
  if (!$("settingsClientRow").classList.contains("hidden")) {
    patch.clientId = $("settingsClientId").value.trim();
  }
  return patch;
}

async function refresh() {
  state.snapshot = await send(MESSAGE.GET_STATE);
  render();
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

$("searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});

$("sortSelect").addEventListener("change", (event) => {
  state.sort = event.target.value;
  render();
});

document.querySelectorAll(".filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.followFilter = btn.dataset.filter;
    document.querySelectorAll(".filter").forEach((el) => el.classList.toggle("on", el === btn));
    render();
  });
});

$("pauseBtn").addEventListener("click", async () => {
  await send(MESSAGE.TOGGLE_AUTOMATION);
  await refresh();
});

$("refreshFollowsBtn").addEventListener("click", async () => {
  $("refreshFollowsBtn").textContent = "Refreshing…";
  try {
    const result = await send(MESSAGE.REFRESH_FOLLOWS);
    await refresh();
    if (result?.opened) {
      $("pageMeta").textContent = `Opened ${result.opened} live favorite${result.opened === 1 ? "" : "s"}`;
    } else {
      $("pageMeta").textContent = `Checked ${result?.liveFavoriteCount || 0} live favorites`;
    }
  } catch (error) {
    $("refreshFollowsBtn").textContent = "Couldn't refresh";
    $("pageMeta").textContent = error.message.includes("expired") || error.message.includes("Connect")
      ? error.message
      : "Couldn't refresh Twitch follows.";
    return;
  }
  $("refreshFollowsBtn").textContent = "Refresh";
});

$("saveClientIdBtn").addEventListener("click", async () => {
  await send(MESSAGE.UPDATE_SETTINGS, { patch: { clientId: $("clientIdInput").value.trim() } });
  await refresh();
});

$("connectBtn").addEventListener("click", async () => {
  if ($("clientIdInput").value.trim()) {
    await send(MESSAGE.UPDATE_SETTINGS, { patch: { clientId: $("clientIdInput").value.trim() } });
  }
  await send(MESSAGE.CONNECT);
  await refresh();
});

$("publicConnectBtn").addEventListener("click", async () => {
  await send(MESSAGE.CONNECT);
  await refresh();
});

$("cancelConnectBtn").addEventListener("click", async () => {
  await send(MESSAGE.CANCEL_CONNECT);
  await refresh();
});

$("addChannelBtn").addEventListener("click", async () => {
  const login = $("addChannelInput").value.trim();
  if (!login) return;
  await send(MESSAGE.ADD_CHANNEL, { login });
  $("addChannelInput").value = "";
  await refresh();
});

$("openDropsBtn").addEventListener("click", () => send(MESSAGE.OPEN_DROPS));

$("multistreamPicker").addEventListener("click", async (event) => {
  const target = event.target.closest("[data-ms-user]");
  if (!target || target.disabled) return;
  const userId = target.dataset.msUser;
  const ms = multistreamState(state.snapshot);

  if (ms.active) {
    // The same request the grid page makes when a tile is clicked, so both
    // routes move the sound the same way.
    try {
      await send(MESSAGE.SET_MULTISTREAM_AUDIO, { userId });
      state.multistreamStatus = "";
    } catch (error) {
      state.multistreamStatus = error.message;
    }
    await refresh();
    return;
  }

  if (state.multistreamPicks.has(userId)) state.multistreamPicks.delete(userId);
  else if (state.multistreamPicks.size < (ms.max || 4)) state.multistreamPicks.add(userId);
  render();
});

$("multistreamStartBtn").addEventListener("click", async () => {
  const userIds = [...state.multistreamPicks];
  state.multistreamStatus = "Opening the grid…";
  render();
  try {
    const result = await send(MESSAGE.START_MULTISTREAM, { userIds });
    state.multistreamPicks.clear();
    state.multistreamStatus = `${result.tiles.length} streams in one tab.`;
  } catch (error) {
    state.multistreamStatus = error.message;
  }
  await refresh();
});

$("multistreamFocusBtn").addEventListener("click", async () => {
  try {
    await send(MESSAGE.FOCUS_MULTISTREAM);
    state.multistreamStatus = "";
  } catch (error) {
    state.multistreamStatus = error.message;
  }
  await refresh();
});

$("multistreamExitBtn").addEventListener("click", async () => {
  state.multistreamStatus = "Closing the grid…";
  render();
  try {
    await send(MESSAGE.STOP_MULTISTREAM);
    // Nothing to restore: the lurk tabs never left the group.
    state.multistreamStatus = "Multistream closed.";
  } catch (error) {
    state.multistreamStatus = error.message;
  }
  await refresh();
});

// ---------------------------------------------------------------------------
// Sharing with another computer
// ---------------------------------------------------------------------------

$("syncExtensionId").textContent = chrome.runtime.id;

$("copySyncCode").addEventListener("click", async () => {
  const code = $("syncGroup").value.trim();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    $("syncResult").textContent = "Sync code copied.";
  } catch (error) {
    $("syncResult").textContent = error.message;
  }
});

function describeSync(info) {
  if (!info.available) return "Chrome sync storage is not available in this browser.";
  if (!info.enabled) return "Sync is off. Turn it on above, then save.";
  const shared = `${info.favorites} favorite${info.favorites === 1 ? "" : "s"} shared`;
  return info.lastSyncedAt
    ? `${shared}. Last synced ${formatRelativeTime(info.lastSyncedAt)}.`
    : `${shared}. Not synced yet.`;
}

$("syncNowBtn").addEventListener("click", async () => {
  $("syncResult").textContent = "Syncing…";
  try {
    const info = await send(MESSAGE.SYNC_NOW);
    $("syncResult").textContent = describeSync(info);
    await refresh();
  } catch (error) {
    $("syncResult").textContent = `Sync failed: ${error.message}`;
  }
});

$("exportBtn").addEventListener("click", async () => {
  try {
    const data = await send(MESSAGE.EXPORT_DATA);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `autolurk-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    const count = Object.keys(data.favorites || {}).length;
    $("syncResult").textContent = `Exported ${count} favorite${count === 1 ? "" : "s"}.`;
  } catch (error) {
    $("syncResult").textContent = `Export failed: ${error.message}`;
  }
});

$("importBtn").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());
    const result = await send(MESSAGE.IMPORT_DATA, { payload });
    // An import adds to what is here rather than replacing it, so this is the
    // total afterwards, not the number in the file.
    $("syncResult").textContent = `Imported. ${result.favorites} favorite${result.favorites === 1 ? "" : "s"} now.`;
    await refresh();
  } catch (error) {
    $("syncResult").textContent = `Import failed: ${error.message}`;
  }
});
$("disconnectBtn").addEventListener("click", async () => {
  await send(MESSAGE.DISCONNECT);
  await refresh();
});

$("settingsView").addEventListener("input", () => {
  state.settingsDirty = true;
  $("settingsSaveStatus").textContent = "Unsaved changes";
});
$("settingsView").addEventListener("change", () => {
  state.settingsDirty = true;
  $("settingsSaveStatus").textContent = "Unsaved changes";
});

$("checkUpdateBtn").addEventListener("click", async () => {
  const url = $("updateManifestUrl").value.trim();
  $("checkUpdateBtn").disabled = true;
  $("updateStatus").textContent = "Checking…";
  try {
    if (url) await allowUpdateOrigin();
    // Run here, not in the service worker. The worker keeps the script it
    // started with, so a fix on disk would not run until Chrome restarted it.
    await checkForUpdate(url);
    state.settingsDirty = false;
    await refresh();
  } catch (error) {
    $("updateStatus").textContent = error.message;
  } finally {
    $("checkUpdateBtn").disabled = false;
  }
});

$("applyUpdateBtn").addEventListener("click", async () => {
  const packageUrl = state.snapshot?.update?.packageUrl;
  if (!packageUrl) return;
  // The dialog only opens if this is the first thing the click does.
  // Disabling the button, or writing the status line, before that call makes
  // Chrome drop the click.
  let directoryHandle = null;
  if (typeof window.showDirectoryPicker === "function") {
    try {
      directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (error) {
      if (error?.name === "AbortError") {
        $("updateStatus").textContent = "The folder dialog closed. Click Update again.";
        return;
      }
      // The settings page can see the function and still be refused. A normal
      // browser tab is the backup.
      if (error?.name !== "SecurityError") {
        $("updateStatus").textContent = error?.message || "The folder could not be opened.";
        return;
      }
    }
  }
  $("applyUpdateBtn").disabled = true;
  $("updateStatus").textContent = "Downloading the update…";
  try {
    const version = await installUpdatePackage(packageUrl, (message) => {
      $("updateStatus").textContent = message;
    }, directoryHandle);
    $("updateStatus").textContent = `Version ${version} is in place. Reloading…`;
    chrome.runtime.reload();
  } catch (error) {
    $("updateStatus").textContent = error.message;
    const ready = Boolean(state.snapshot?.update?.packageUrl && state.snapshot?.update?.availableVersion);
    $("applyUpdateBtn").classList.toggle("hidden", !ready);
    $("applyUpdateBtn").disabled = !ready;
  }
});

$("saveSettingsBtn").addEventListener("click", async () => {
  $("saveSettingsBtn").disabled = true;
  try {
    await send(MESSAGE.UPDATE_SETTINGS, { patch: collectSettings() });
    state.settingsDirty = false;
    $("settingsSaveStatus").textContent = "Saved.";
    await refresh();
  } catch (error) {
    $("settingsSaveStatus").textContent = error.message;
  } finally {
    $("saveSettingsBtn").disabled = false;
  }
});

function parseCategories(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

document.body.addEventListener("click", async (event) => {
  const cardEl = event.target.closest("[data-user]");
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!cardEl || !action) return;
  const userId = cardEl.dataset.user;
  try {
    if (action === "favorite") await send(MESSAGE.TOGGLE_FAVORITE, { userId });
    if (action === "open") await send(MESSAGE.FOCUS_OR_OPEN, { userId });
    if (action === "close") await send(MESSAGE.CLOSE_STREAM, { userId });
    if (action === "retry") await send(MESSAGE.RETRY_STREAM, { userId });
    if (action === "release") await send(MESSAGE.RELEASE_TAB, { userId });
    if (action === "snooze") await send(MESSAGE.SNOOZE_STREAM, { userId });
    if (action === "unsnooze") await send(MESSAGE.UNSNOOZE_STREAM, { userId });
  } catch (error) {
    $("pageMeta").textContent = error.message;
  }
  if (action === "toggle-settings") {
    if (state.openRows.has(userId)) state.openRows.delete(userId);
    else state.openRows.add(userId);
  }
  await refresh();
});

document.body.addEventListener("change", async (event) => {
  const override = event.target.closest("[data-fav-notify]");
  const cardForOverride = event.target.closest("[data-user]");
  if (override && cardForOverride) {
    const raw = override.value;
    const value = raw === "on" ? true : raw === "off" ? false : null;
    await send(MESSAGE.UPDATE_FAVORITE, {
      userId: cardForOverride.dataset.user,
      patch: { [override.dataset.favNotify]: value },
    });
    return;
  }

  const input = event.target.closest("[data-fav]");
  const cardEl = event.target.closest("[data-user]");
  if (!input || !cardEl) return;
  const key = input.dataset.fav;
  let value = input.type === "checkbox" ? input.checked : input.value;
  if (key === "includeCategories" || key === "excludeCategories") value = parseCategories(value);
  await send(MESSAGE.UPDATE_FAVORITE, { userId: cardEl.dataset.user, patch: { [key]: value } });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.snapshot) {
    state.snapshot = changes.snapshot.newValue;
    render();
  }
});

let devicePoll = null;
function watchDeviceFlow(flow) {
  if (!flow) {
    if (devicePoll) {
      clearInterval(devicePoll);
      devicePoll = null;
    }
    return;
  }
  if (devicePoll) return;
  devicePoll = setInterval(async () => {
    try {
      await send(MESSAGE.POLL_DEVICE);
    } catch {
      // keep waiting
    }
    await refresh();
  }, 3000);
}

function revealUpdates() {
  if (location.hash !== "#updates") return;
  setView("settings");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const button = $("applyUpdateBtn");
      const target = button && !button.classList.contains("hidden") ? button : $("updates");
      target?.scrollIntoView({ block: "center" });
    });
  });
}

window.addEventListener("hashchange", revealUpdates);

refresh()
  .then(() => {
    if (location.hash === "#settings") setView("settings");
    revealUpdates();
  })
  .catch((error) => {
    $("setupStatus").textContent = error.message;
    $("setupView").classList.remove("hidden");
  });
