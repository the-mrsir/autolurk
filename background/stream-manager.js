import { opensInFront, PRIORITY_RANK, SESSION_KEYS, TAB_LOAD_GRACE_MS } from "../shared/constants.js";
import { normalizeSyncGroup } from "../shared/sync-logic.js";
import {
  createFavorite,
  getAppState,
  getAuth,
  getDismissed,
  getExtensionUpdate,
  getFavorites,
  getFollows,
  getLiveState,
  getManagedTabs,
  getMeta,
  getPendingCloses,
  getSessionValue,
  getSettings,
  mutateDismissed,
  mutateFavorites,
  mutateFollows,
  mutateManagedTabs,
  mutateMeta,
  mutatePendingCloses,
  mutateLiveState,
  saveMeta,
  savePendingCloses,
  setSessionValue,
  saveSnapshot,
} from "../shared/storage.js";
import { evaluateHealth, healthLabel } from "../shared/health.js";
import { updateStillNewer } from "../shared/update-logic.js";
import {
  classifyPoll,
  mergeLiveState,
  offlineCandidates,
  POLL_STATUS,
  pollStatusMessage,
  streamIsOpenable,
} from "../shared/poll-logic.js";
import {
  extractChannelFromUrl,
  normalizeLogin,
  notifyEnabled,
  now,
  shouldAutoOpenForCategory,
} from "../shared/utilities.js";
import {
  notifyGameChange,
  notifyLive,
  notifyTitleChange,
} from "./notifications.js";
import { pointsSummary } from "../shared/points-logic.js";
import { logActivity } from "./activity.js";
import { recordFavoriteRemoval, schedulePush } from "./sync.js";
import { prefetchSevenTv } from "./seventv.js";
import { multistreamSnapshot } from "./multistream.js";
import { clearBootWatch, scheduleBootWatch } from "./stream-boot.js";
import {
  adoptGroupedStreamTab,
  announceManaged,
  closeGroupedStreamTab,
  closeManagedTab,
  consumeProgrammaticClose,
  findTabForChannel,
  focusOrOpen,
  getManagedTabForLogin,
  getManagedTabForUser,
  getAutoLurkGroupedTabs,
  openManagedStream,
  pinQualityForTab,
  reconcileManagedTabs,
  releaseManagedTab,
  updateLiveGroup,
  urlLeftExpectedChannel,
} from "./tab-manager.js";
import { isWatched, watchedHere, watchedStreams } from "./watching.js";
import {
  API_FAILURE,
  getFollowedChannels,
  getFollowedStreams,
  getStreamsByUserIds,
  getUsersByIds,
  getUsersByLogin,
  TwitchApiError,
} from "./twitch-api.js";

let pollChain = Promise.resolve();
let followsInFlight = false;

async function resolveGroupedChannels(groupedTabs, follows, favorites) {
  const byLogin = new Map();
  for (const channel of Object.values(follows)) {
    const login = normalizeLogin(channel.login);
    if (login) byLogin.set(login, channel);
  }
  for (const [userId, favorite] of Object.entries(favorites)) {
    const login = normalizeLogin(favorite.login);
    if (!login || byLogin.has(login)) continue;
    byLogin.set(login, {
      userId,
      login,
      displayName: favorite.displayName || login,
      profileImageUrl: favorite.profileImageUrl || "",
    });
  }

  const unknown = [...new Set(groupedTabs.map((tab) => tab.login).filter((login) => !byLogin.has(login)))];
  if (unknown.length) {
    try {
      for (const channel of await getUsersByLogin(unknown)) {
        byLogin.set(normalizeLogin(channel.login), channel);
      }
    } catch (error) {
      // Unknown tabs remain untouched. Failure to resolve a synced group is
      // never evidence that its channels are offline.
      console.warn("Could not resolve synced AutoLurk group tabs", error);
    }
  }

  return groupedTabs
    .map((tab) => ({ tab, channel: byLogin.get(tab.login) || null }))
    .filter((item) => item.channel?.userId);
}

export async function reconcileGroupedStreams(
  items,
  liveState,
  favorites,
  settings,
  options = {}
) {
  for (const { tab, channel } of items) {
    const userId = String(channel.userId);
    if (options.covered && !options.covered.has(userId)) continue;
    const stream =
      liveState[userId] ||
      Object.values(liveState).find(
        (candidate) => normalizeLogin(candidate.login) === normalizeLogin(channel.login)
      );
    const favorite = favorites[userId];
    const removed = !favorite && Number(options.removedFavorites?.[userId]) > 0;
    const snoozed =
      favorite?.snoozeUntilNextStream &&
      (favorite.snoozedStreamId === "current" ||
        favorite.snoozedStreamId === stream?.streamId);

    // User intent syncs separately from Chrome's tab groups. A tab delivered
    // by group sync must not override a snooze or resurrect an unfavorite.
    if (removed || snoozed) {
      await closeGroupedStreamTab(tab.tabId);
      continue;
    }
    if (streamIsOpenable(stream)) {
      await adoptGroupedStreamTab(tab.tabId, channel, stream);
      continue;
    }
    if (!settings.autoCloseOffline || favorite?.autoClose === false) continue;
    if ((await watchedHere(await getManagedTabs())).tabIds.has(Number(tab.tabId))) continue;
    if (await closeGroupedStreamTab(tab.tabId)) {
      await logActivity(
        `Closed offline synced-group tab — ${channel.displayName || channel.login}`,
        { channel: channel.login }
      );
    }
  }
}

async function closeLocalTabsForChannel(userId, login) {
  const closed = new Set();
  const entry = await getManagedTabForUser(userId);
  if (entry) {
    await closeManagedTab(entry.tabId);
    closed.add(Number(entry.tabId));
  }
  const target = normalizeLogin(login);
  if (!target) return;
  for (const tab of await getAutoLurkGroupedTabs()) {
    if (tab.login === target && !closed.has(Number(tab.tabId))) {
      await closeGroupedStreamTab(tab.tabId);
    }
  }
}

// One reconciliation at a time. A service-worker restart and an extension
// reload can both ask during the same second, and both opening the missing
// channels would duplicate them.
let startupReconcileChain = Promise.resolve();

function configuredLurkChannels(favorites, follows, liveState) {
  const wanted = [];
  const seen = new Set();
  for (const [userId, favorite] of Object.entries(favorites || {})) {
    if (favorite?.autoOpen === false || favorite?.snoozeUntilNextStream) continue;
    const login = normalizeLogin(
      follows[userId]?.login || favorite.login || liveState[userId]?.login
    );
    if (!login || seen.has(login)) continue;
    seen.add(login);
    wanted.push({
      userId: String(userId),
      login,
      channel: resolveChannel(userId, follows, liveState[userId], favorite),
      stream: liveState[userId] || { userId: String(userId), login, streamId: "" },
    });
  }
  return wanted;
}

function tabsForLogin(tabs, login) {
  return tabs.filter((tab) => {
    if (String(tab.url || "").includes("autolurk-grid")) return false;
    return extractChannelFromUrl(tab.pendingUrl || tab.url) === login;
  });
}

async function armManagedTab(tabId) {
  await announceManaged(tabId);
  await pinQualityForTab(tabId);
  await scheduleBootWatch(tabId);
}

export const RECONCILE_RETRY_MS = 2 * 60 * 1000;

function logStartupReconciliation(record) {
  console.info("AutoLurk startup reconciliation");
  console.info(`Configured channels: ${record.configured}`);
  console.info(`Open Twitch tabs: ${record.openTwitchTabs}`);
  console.info(`Existing matching tabs: ${record.matchingTabs}`);
  console.info(`Adopted: ${record.adopted}`);
  console.info(`Opened: ${record.opened}`);
  console.info(`Skipped: ${record.skipped}`);
  console.info(`Managed after reconciliation: ${record.managed}`);
  console.info(`Reconciliation state: ${record.state}`);
}

export function reconciliationNeedsAnotherPass(record, at = Date.now()) {
  if (!record) return false;
  const busy = new Set(["STARTING", "SCANNING", "ADOPTING", "OPENING_MISSING"]);
  if (busy.has(record.state)) return false;
  if (!(Number(record.configured) > Number(record.managed))) return false;
  const completed = Number(record.completedAt) || 0;
  if (!completed) return false;
  return at - completed >= RECONCILE_RETRY_MS;
}

// Restores the managed registry from favorites and whatever Twitch tabs are
// already open. A live poll and the local monitor are not required: a failed
// heartbeat must not be what decides whether these channels exist.
export function reconcileStartupChannels() {
  const run = startupReconcileChain.then(runStartupReconciliation, runStartupReconciliation);
  startupReconcileChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

export async function reconcileStartupChannelsIfShort(at = Date.now()) {
  const record = await getSessionValue(SESSION_KEYS.RECONCILE, null);
  if (!reconciliationNeedsAnotherPass(record, at)) return null;
  return reconcileStartupChannels();
}

async function rememberReconciliation(record) {
  await setSessionValue(SESSION_KEYS.RECONCILE, record);
  return record;
}

async function runStartupReconciliation() {
  const startedAt = Date.now();
  const previous = await getSessionValue(SESSION_KEYS.RECONCILE, null);
  const record = {
    state: "STARTING",
    configured: 0,
    openTwitchTabs: 0,
    matchingTabs: 0,
    adopted: 0,
    opened: 0,
    skipped: 0,
    managed: 0,
    startedAt,
    completedAt: null,
    reachedExpectedAt: Number(previous?.reachedExpectedAt) > 0 ? Number(previous.reachedExpectedAt) : null,
    timeToExpectedMs: Number.isFinite(Number(previous?.timeToExpectedMs)) ? Number(previous.timeToExpectedMs) : null,
  };
  await rememberReconciliation(record);

  try {
    const [settings, favorites, follows, liveState, dismissed] = await Promise.all([
      getSettings(),
      getFavorites(),
      getFollows(),
      getLiveState(),
      getDismissed(),
    ]);
    await reconcileManagedTabs();
    const wanted = configuredLurkChannels(favorites, follows, liveState);
    record.configured = wanted.length;
    record.state = "SCANNING";
    await rememberReconciliation(record);

    const automation = settings.automationEnabled === true && settings.autoOpenFavorites === true;
    const tabs = (await chrome.tabs.query({ url: "*://www.twitch.tv/*" })).filter(
      (tab) => !String(tab.url || "").includes("autolurk-grid")
    );
    record.openTwitchTabs = tabs.length;
    record.state = "ADOPTING";
    await rememberReconciliation(record);

    for (const item of wanted) {
      const matches = tabsForLogin(tabs, item.login);
      record.matchingTabs += matches.length;
      if (!automation) {
        if (!matches.length) record.skipped += 1;
        continue;
      }

      const already =
        (await getManagedTabForUser(item.userId)) || (await getManagedTabForLogin(item.login));
      const keeper =
        matches.find((tab) => already && Number(tab.id) === Number(already.tabId)) ||
        matches.find((tab) => tab.active) ||
        matches[0];

      if (!already && keeper) {
        const entry = await adoptGroupedStreamTab(keeper.id, item.channel, item.stream);
        if (entry) record.adopted += 1;
      }

      for (const extra of matches) {
        if (!keeper || Number(extra.id) === Number(keeper.id)) continue;
        if (already && Number(extra.id) === Number(already.tabId)) continue;
        const still = await getManagedTabs();
        if (still[String(extra.id)]) continue;
        if ((await watchedHere(still)).tabIds.has(Number(extra.id))) continue;
        try {
          await chrome.tabs.remove(Number(extra.id));
        } catch {
          // Closed while we were matching it.
        }
      }
    }

    record.state = "OPENING_MISSING";
    await rememberReconciliation(record);

    if (automation) {
      const max = Number(settings.maxAutoOpenStreams) || 0;
      for (const item of wanted) {
        if ((await getManagedTabForUser(item.userId)) || (await getManagedTabForLogin(item.login))) {
          continue;
        }
        const fresh = tabsForLogin(await chrome.tabs.query({ url: "*://www.twitch.tv/*" }), item.login);
        if (fresh.length) {
          const entry = await adoptGroupedStreamTab(fresh[0].id, item.channel, item.stream);
          if (entry) record.adopted += 1;
          continue;
        }
        if (!streamIsOpenable(item.stream)) {
          record.skipped += 1;
          continue;
        }
        const dismissedId = dismissed[item.userId];
        if (
          !settings.reopenIfManuallyClosed &&
          dismissedId &&
          item.stream.streamId &&
          dismissedId === item.stream.streamId
        ) {
          record.skipped += 1;
          continue;
        }
        const openCount = Object.keys(await getManagedTabs()).length;
        if (max > 0 && openCount >= max) {
          record.skipped += 1;
          continue;
        }
        try {
          // A repair pass. It fills in a missing stream behind whatever is
          // on screen and never takes the screen itself.
          const entry = await openManagedStream(item.channel, item.stream, { focus: false });
          if (entry) record.opened += 1;
          else record.skipped += 1;
        } catch (error) {
          record.skipped += 1;
          console.warn("Startup open failed", error);
        }
      }
    }

    const managed = await getManagedTabs();
    if (automation) {
      for (const entry of Object.values(managed)) await armManagedTab(entry.tabId);
    }
    record.managed = Object.keys(managed).length;
    record.completedAt = Date.now();
    if (record.managed >= record.configured) {
      record.state = "COMPLETE";
      if (!record.reachedExpectedAt) {
        record.reachedExpectedAt = record.completedAt;
        record.timeToExpectedMs = record.completedAt - startedAt;
      }
    } else {
      record.state = "PARTIAL";
    }
    await rememberReconciliation(record);
    logStartupReconciliation(record);
    return record;
  } catch (error) {
    record.state = "ERROR";
    record.completedAt = Date.now();
    await rememberReconciliation(record).catch(() => {});
    logStartupReconciliation(record);
    throw error;
  }
}

// A tab the user opened or navigated onto a configured channel. Adopts that
// tab. It does not open anything else, and it does not ask the local monitor.
export async function adoptNavigatedChannel(tabId, url) {
  const login = extractChannelFromUrl(url);
  if (!login) return null;
  const settings = await getSettings();
  if (!settings.automationEnabled || !settings.autoOpenFavorites) return null;

  const managed = await getManagedTabs();
  if (managed[String(tabId)]) return null;
  if (await getManagedTabForLogin(login)) return null;

  const [favorites, follows, liveState] = await Promise.all([
    getFavorites(),
    getFollows(),
    getLiveState(),
  ]);
  const match = configuredLurkChannels(favorites, follows, liveState).find(
    (item) => item.login === login
  );
  if (!match) return null;

  const entry = await adoptGroupedStreamTab(tabId, match.channel, match.stream);
  if (entry) await armManagedTab(entry.tabId);
  return entry;
}

export async function enforceSyncedFavoriteIntent() {
  const [favorites, follows, meta] = await Promise.all([
    getFavorites(),
    getFollows(),
    getMeta(),
  ]);
  const targets = new Set(
    Object.keys(meta.removedFavorites || {}).filter(
      (userId) => !favorites[userId] && Number(meta.removedFavorites[userId]) > 0
    )
  );
  for (const [userId, favorite] of Object.entries(favorites)) {
    if (favorite.snoozeUntilNextStream) targets.add(String(userId));
  }
  for (const userId of targets) {
    await closeLocalTabsForChannel(
      userId,
      follows[userId]?.login || favorites[userId]?.login
    );
  }
  return targets.size;
}

export async function syncFollows() {
  if (followsInFlight) return getFollows();
  followsInFlight = true;
  try {
    const auth = await getAuth();
    if (!auth.userId) throw new Error("Connect Twitch to import follows.");

    const channels = await getFollowedChannels(auth.userId);
    const existing = await getFollows();
    const missingIds = channels
      .filter((channel) => !existing[channel.userId]?.profileImageUrl)
      .map((channel) => channel.userId);
    const users = missingIds.length ? await getUsersByIds(missingIds) : {};

    const follows = await mutateFollows((current) => {
      const next = {};
      // Channels the user added by name are not follows, so a sync must not
      // silently delete them.
      for (const [userId, channel] of Object.entries(current)) {
        if (channel.addedManually) next[userId] = channel;
      }
      for (const channel of channels) {
        const user = users[channel.userId] || current[channel.userId] || {};
        next[channel.userId] = {
          ...channel,
          login: user.login || channel.login,
          displayName: user.displayName || channel.displayName,
          profileImageUrl: user.profileImageUrl || channel.profileImageUrl || "",
        };
      }
      return next;
    });

    await saveMeta({ lastFollowsSyncAt: now() });
    await buildSnapshot();
    return follows;
  } finally {
    followsInFlight = false;
  }
}

export async function addChannelByLogin(login) {
  const users = await getUsersByLogin([login]);
  if (!users[0]) throw new Error(`No Twitch channel found for "${login}".`);
  const user = users[0];
  await mutateFollows((follows) => {
    follows[user.userId] = {
      userId: user.userId,
      login: user.login,
      displayName: user.displayName,
      profileImageUrl: user.profileImageUrl,
      followedAt: follows[user.userId]?.followedAt || "",
      addedManually: true,
    };
    return follows;
  });
  await toggleFavorite(user.userId, true);
  await pollLiveState();
  return user;
}

export async function toggleFavorite(userId, force) {
  const follows = await getFollows();
  let added = false;
  let removed = false;

  const favorites = await mutateFavorites((current) => {
    const exists = Boolean(current[userId]);
    const shouldFavorite = force == null ? !exists : Boolean(force);
    if (shouldFavorite === exists) return undefined;

    if (shouldFavorite) {
      current[userId] = createFavorite(userId, {
        login: follows[userId]?.login,
        displayName: follows[userId]?.displayName,
        updatedAt: now(),
      });
      added = true;
    } else {
      delete current[userId];
      removed = true;
    }
    return current;
  });

  if (removed) {
    await recordFavoriteRemoval(userId);
    await closeLocalTabsForChannel(userId, follows[userId]?.login);
  } else if (added) {
    schedulePush("favorites");
  }

  if (added) {
    try {
      await openFavoriteIfLive(userId, { force: true });
    } catch (error) {
      console.warn("Auto-open after favorite failed", error);
    }
  }
  await buildSnapshot();
  return favorites[userId] || null;
}

async function openFavoriteIfLive(userId, options = {}) {
  const [settings, favorites, follows, liveState, dismissed] = await Promise.all([
    getSettings(),
    getFavorites(),
    getFollows(),
    getLiveState(),
    getDismissed(),
  ]);
  const favorite = favorites[userId];
  if (!favorite) return null;

  let stream = liveState[userId];
  const seenAt = Number(stream?.observedAt) || 0;
  const tooOld = !seenAt || now() - seenAt > 30 * 60 * 1000;
  if (!streamIsOpenable(stream) || tooOld) {
    const fetched = await getStreamsByUserIds([userId]);
    stream = fetched[userId];
    if (stream) {
      await mutateLiveState((current) => {
        current[userId] = { ...stream, stale: false, observedAt: now() };
        return current;
      });
    }
  }
  if (!stream) {
    const name = follows[userId]?.displayName || favorite.displayName || userId;
    await logActivity(`${name} is offline`, { channel: follows[userId]?.login });
    return null;
  }

  const channel = resolveChannel(userId, follows, stream, favorite);
  if (!canAutoOpen(settings, favorite, stream, dismissed, options)) return null;
  return openManagedStream(channel, stream, { focus: opensInFront(settings, true) });
}

export async function refreshStreamForUser(userId) {
  const fetched = await getStreamsByUserIds([String(userId)]);
  const stream = fetched[String(userId)] || fetched[userId] || null;
  await mutateLiveState((current) => {
    if (stream) current[userId] = { ...stream, stale: false, observedAt: now() };
    else delete current[userId];
    return current;
  });
  return stream;
}

function streamForFavorite(userId, favorite, follows, nextLive) {
  if (streamIsOpenable(nextLive[userId])) return nextLive[userId];
  const login = normalizeLogin(follows[userId]?.login || favorite.login);
  if (!login) return null;
  return (
    Object.values(nextLive).find(
      (stream) => streamIsOpenable(stream) && normalizeLogin(stream.login) === login
    ) || null
  );
}

function resolveChannel(userId, follows, stream, favorite = {}) {
  return {
    ...(follows[userId] || {}),
    userId,
    login: follows[userId]?.login || stream?.login || favorite.login || "",
    displayName: follows[userId]?.displayName || stream?.displayName || favorite.displayName || "",
    profileImageUrl: follows[userId]?.profileImageUrl || favorite.profileImageUrl || "",
  };
}

function canAutoOpen(settings, favorite, stream, dismissed, options = {}) {
  if (!streamIsOpenable(stream)) return false;
  if (!favorite?.autoOpen) return false;
  if (!options.force) {
    if (!settings.automationEnabled || !settings.autoOpenFavorites) return false;
    const dismissedId = stream.userId || favorite.userId;
    if (!settings.reopenIfManuallyClosed && dismissed[dismissedId] === stream.streamId) return false;
  }
  if (
    favorite.snoozeUntilNextStream &&
    (favorite.snoozedStreamId === "current" || favorite.snoozedStreamId === stream.streamId)
  ) {
    return false;
  }
  if (!shouldAutoOpenForCategory(stream.gameName, favorite)) return false;
  return true;
}

export async function updateFavorite(userId, patch) {
  const favorites = await mutateFavorites((current) => {
    const base = current[userId] || createFavorite(userId);
    // Stamped so the other machine can tell which edit came last. Only
    // deliberate edits are stamped; housekeeping like clearing a finished
    // snooze is derived state that each machine works out for itself, and
    // stamping it would start a sync round every poll.
    current[userId] = { ...base, ...patch, userId, updatedAt: now() };
    return current;
  });
  schedulePush("favorites");
  await buildSnapshot();
  return favorites[userId];
}

export async function snoozeStream(userId) {
  const liveState = await getLiveState();
  const stream = liveState[userId];
  await updateFavorite(userId, {
    snoozeUntilNextStream: true,
    snoozedStreamId: stream?.streamId || "current",
  });
  const entry = await getManagedTabForUser(userId);
  const name = entry?.displayName || stream?.displayName || userId;
  await logActivity(`Snoozed ${name}`, { channel: entry?.login });
  if (entry) await closeManagedTab(entry.tabId);
  return true;
}

export async function unsnoozeStream(userId) {
  await updateFavorite(userId, { snoozeUntilNextStream: false, snoozedStreamId: null });
  await openFavoriteIfLive(userId, { force: true }).catch(() => {});
  await buildSnapshot();
  return true;
}

export function pollLiveState(options = {}) {
  const result = pollChain.then(
    () => runLivePoll(options),
    () => runLivePoll(options)
  );
  pollChain = result.then(() => {}, () => {});
  return result;
}

function failureKind(error) {
  return error instanceof TwitchApiError ? error.kind : API_FAILURE.NETWORK;
}

async function runLivePoll(options = {}) {
  const auth = await getAuth();
  if (!auth.accessToken || !auth.userId) {
    throw new Error("Connect Twitch before refreshing.");
  }

  await reconcileManagedTabs();
  const [settings, follows, favorites, previousLive, dismissed, meta] = await Promise.all([
    getSettings(),
    getFollows(),
    getFavorites(),
    getLiveState(),
    getDismissed(),
    getMeta(),
  ]);
  await enforceSyncedFavoriteIntent();
  if (meta.rateLimitedUntil > now() && !options.force) {
    return { opened: 0, liveFavoriteCount: 0, status: POLL_STATUS.PARTIAL, skipped: true };
  }

  const groupedTabs = await getAutoLurkGroupedTabs();
  const groupedChannels = await resolveGroupedChannels(groupedTabs, follows, favorites);

  // null means "we do not know", which is different from an empty array.
  let followedStreams = null;
  let followedFailure = null;
  let firstError = null;
  try {
    followedStreams = await getFollowedStreams(auth.userId);
  } catch (error) {
    followedFailure = failureKind(error);
    firstError = error;
    console.warn("Followed live poll failed", error);
  }

  const favoriteIds = Object.keys(favorites);
  const directlyCheckedIds = [
    ...new Set([...favoriteIds, ...groupedChannels.map(({ channel }) => String(channel.userId))]),
  ];
  let favoriteStreams = directlyCheckedIds.length ? null : {};
  let favoriteFailure = null;
  if (directlyCheckedIds.length) {
    try {
      favoriteStreams = await getStreamsByUserIds(directlyCheckedIds);
    } catch (error) {
      favoriteFailure = failureKind(error);
      firstError = firstError || error;
      console.warn("Favorite live poll failed", error);
    }
  }

  const status = classifyPoll({ followedFailure, favoriteFailure });
  const { live: nextLive, covered } = mergeLiveState({
    previousLive,
    followedStreams,
    favoriteStreams,
    followIds: Object.keys(follows),
    favoriteIds: directlyCheckedIds,
    now: now(),
  });

  if (followedStreams) {
    await mutateFollows((current) => {
      let changed = false;
      for (const stream of followedStreams) {
        const existing = current[stream.userId];
        if (!existing) continue;
        if (existing.login === stream.login && existing.displayName === stream.displayName) continue;
        current[stream.userId] = {
          ...existing,
          login: stream.login,
          displayName: stream.displayName,
        };
        changed = true;
      }
      return changed ? current : undefined;
    });
  }

  // This poll is authoritative only for the channels it actually asked about.
  // A single-channel refresh can land while these requests are in flight, and
  // it read Twitch later than the snapshot this merge was built from, so
  // outside `covered` the stored row wins over the carried-forward one.
  await mutateLiveState((current) => {
    const next = { ...nextLive };
    for (const userId of new Set([...Object.keys(previousLive), ...Object.keys(current)])) {
      if (covered.has(String(userId))) continue;
      const stored = current[userId];
      if (!stored) delete next[userId];
      else if (Number(stored.observedAt) > Number(previousLive[userId]?.observedAt || 0)) {
        next[userId] = stored;
      }
    }
    return next;
  });
  await recordPollOutcome(status, firstError);

  if (status === POLL_STATUS.UNAUTHORIZED) {
    // Nothing below can be trusted, and closing tabs now would be wrong.
    await buildSnapshot();
    await updateBadge();
    if (options.force) throw firstError || new Error("Twitch sign-in expired.");
    return { opened: 0, liveFavoriteCount: 0, status };
  }

  // Wake recovery needs an authoritative all-or-nothing answer. A partial
  // poll may update cached rows, but it must not close or open any tabs before
  // the wake coordinator decides whether the result is usable.
  if (options.requireCompleteBeforeMutations && status !== POLL_STATUS.OK) {
    await buildSnapshot();
    await updateBadge();
    return { opened: 0, liveFavoriteCount: 0, status };
  }

  // The freeze belongs to the wake coordinator, not to the caller that happens
  // to poll next. While tabs are suspended from a wake whose poll could not
  // complete, an ordinary alarm, a manual refresh, or a sync-triggered poll may
  // refresh what it learned but must not close or open anything: every stored
  // timestamp is still hours stale. Re-read rather than trusting the value
  // fetched before the network calls, because a wake can begin while they run.
  if (!options.requireCompleteBeforeMutations && (await getMeta()).wakeRecheckPending) {
    await buildSnapshot();
    await updateBadge();
    return { opened: 0, liveFavoriteCount: 0, status, deferred: true };
  }

  if (favoriteStreams !== null) {
    await reconcileGroupedStreams(groupedChannels, nextLive, favorites, settings, {
      covered,
      removedFavorites: meta.removedFavorites || {},
    });
  }

  await handleOfflineCloses(favorites, nextLive, covered, settings, {
    // Wake recovery closes without waiting. The grace exists so a single
    // unlucky poll cannot close a tab, which is not what happened when a
    // broadcast ended hours ago while the machine was asleep.
    graceMs: options.immediateCloses ? 0 : undefined,
  });
  // Auto-open runs first so notifications can skip streams AutoLurk handled.
  const openedIds = await handleAutoOpens(favorites, follows, nextLive, dismissed, settings, options);
  const opened = openedIds.size;

  // Notifications compare against the previous poll, so a degraded poll would
  // announce channels that merely fell out of a broken response.
  if (status === POLL_STATUS.OK) {
    await handleNotifications(favorites, follows, previousLive, nextLive, settings, meta, openedIds);
    await clearFinishedSnoozes(favorites, nextLive);
    await clearFinishedDismissals(dismissed, nextLive);
    // Best effort and rate limited. A 7TV outage must never fail a poll.
    await prefetchSevenTv(
      Object.values(nextLive).filter((stream) => stream.isLive && favorites[stream.userId])
    ).catch(() => {});
  }

  await buildSnapshot();
  await updateBadge();

  const liveFavoriteCount = favoriteIds.filter((id) => nextLive[id]?.isLive).length;
  if (options.force) {
    if (status === POLL_STATUS.OK) {
      await logActivity(
        opened
          ? `Refresh opened ${opened} live favorite${opened === 1 ? "" : "s"}`
          : `Refresh checked ${liveFavoriteCount} live favorite${liveFavoriteCount === 1 ? "" : "s"}`
      );
    } else {
      await logActivity(pollStatusMessage(status, firstError?.message), { level: "warn" });
    }
  }
  return { opened, liveFavoriteCount, status };
}

async function recordPollOutcome(status, error) {
  const at = now();
  await mutateMeta((meta) => {
    const failed = status !== POLL_STATUS.OK;
    return {
      ...meta,
      lastPollAt: at,
      lastSuccessfulPollAt: failed ? meta.lastSuccessfulPollAt || 0 : at,
      pollStatus: status,
      pollError: failed ? pollStatusMessage(status, error?.message) : "",
      pollFailureStreak: failed ? (meta.pollFailureStreak || 0) + 1 : 0,
      rateLimitedUntil:
        error instanceof TwitchApiError && error.kind === API_FAILURE.RATE_LIMITED
          ? at + (error.retryAfterMs || 30000)
          : 0,
    };
  });
}

// A channel that briefly drops out of the Twitch response should not produce a
// second "is live" popup when it comes back.
const RENOTIFY_LIVE_MS = 30 * 60 * 1000;

async function handleNotifications(favorites, follows, previousLive, nextLive, settings, meta, openedIds) {
  // The first poll after connecting sees every live favorite as new.
  const firstPoll = !meta.lastPollAt;
  const lastNotified = { ...(meta.lastLiveNotifyAt || {}) };
  let notifyLogChanged = false;

  for (const [userId, favorite] of Object.entries(favorites)) {
    const stream = nextLive[userId];
    if (!stream) continue;

    const previous = previousLive[userId];
    const channel = resolveChannel(userId, follows, stream, favorite);
    const wentLive = !previous?.isLive || previous.streamId !== stream.streamId;

    if (wentLive) {
      if (!notifyEnabled(favorite, settings, "notifyLive")) continue;
      const since = now() - (lastNotified[userId] || 0);
      const handled = settings.notifyOnlyWhenNotOpened && openedIds.has(userId);
      if (!firstPoll && !handled && since >= RENOTIFY_LIVE_MS) {
        await notifyLive(channel, stream);
      }
      lastNotified[userId] = now();
      notifyLogChanged = true;
      continue;
    }

    if (notifyEnabled(favorite, settings, "notifyGameChange") && previous.gameName !== stream.gameName) {
      await notifyGameChange(channel, stream, previous.gameName);
    }
    if (notifyEnabled(favorite, settings, "notifyTitleChange") && previous.title !== stream.title) {
      await notifyTitleChange(channel, stream);
    }
  }

  if (notifyLogChanged) {
    await mutateMeta((meta) => ({
      ...meta,
      lastLiveNotifyAt: { ...(meta.lastLiveNotifyAt || {}), ...lastNotified },
    }));
  }
}

async function handleAutoOpens(favorites, follows, nextLive, dismissed, settings, options = {}) {
  const openedIds = new Set();
  if (!options.force && (!settings.automationEnabled || !settings.autoOpenFavorites)) return openedIds;

  const candidates = [];
  for (const [userId, favorite] of Object.entries(favorites)) {
    const stream = streamForFavorite(userId, favorite, follows, nextLive);
    if (!canAutoOpen(settings, favorite, stream, dismissed, options)) continue;
    if (await getManagedTabForUser(userId)) continue;
    candidates.push({
      favorite,
      stream,
      channel: resolveChannel(userId, follows, stream, favorite),
    });
  }

  candidates.sort((a, b) => {
    const rank = (PRIORITY_RANK[b.favorite.priority] || 2) - (PRIORITY_RANK[a.favorite.priority] || 2);
    if (rank !== 0) return rank;
    return (b.stream.viewerCount || 0) - (a.stream.viewerCount || 0);
  });

  const managed = await getManagedTabs();
  let openCount = Object.keys(managed).length;
  const max = Number(settings.maxAutoOpenStreams) || 0;
  const handledLogins = new Set();

  for (const candidate of candidates) {
    const login = normalizeLogin(candidate.channel.login);
    // Old synced favorite records can occasionally carry two user ids for one
    // login. Priority sorting above decides which record wins; one broadcast
    // must still produce one tab and count once toward the configured maximum.
    if (!login || handledLogins.has(login)) continue;
    handledLogins.add(login);
    if (await getManagedTabForLogin(login)) continue;

    if (max > 0 && openCount >= max) {
      const replaced = await maybeReplaceLowerPriority(candidate, max);
      if (!replaced) continue;
    }
    try {
      const entry = await openManagedStream(candidate.channel, candidate.stream, {
        focus: opensInFront(settings, true),
        automatic: true,
      });
      if (entry) {
        openCount += 1;
        // A tab existing is not the same as its media moving. Keep it managed
        // so recovery can finish the job, but do not report "opened" or
        // suppress a live notification when bootstrap explicitly failed.
        if (entry.bootstrapStarted !== false) openedIds.add(candidate.channel.userId);
      }
    } catch (error) {
      const name = candidate.channel.displayName || candidate.channel.login;
      console.warn("Auto-open failed", error);
      await logActivity(`Couldn't open ${name}: ${error.message}`);
    }
  }
  return openedIds;
}

async function maybeReplaceLowerPriority(candidate, max) {
  const managed = await getManagedTabs();
  const favorites = await getFavorites();
  const entries = Object.values(managed);
  if (entries.length < max) return true;

  const incomingRank = PRIORITY_RANK[candidate.favorite.priority] || 2;
  const watched = await watchedStreams(managed);
  let lowest = null;
  for (const entry of entries) {
    if (isWatched(watched, entry.tabId, entry.login)) continue;
    const rank = PRIORITY_RANK[favorites[entry.userId]?.priority] || 2;
    if (rank < incomingRank && (!lowest || rank < lowest.rank)) {
      lowest = { entry, rank };
    }
  }
  if (!lowest) return false;
  await closeManagedTab(lowest.entry.tabId);
  return true;
}

// Closing a stream tab is destructive and cannot be undone, so it requires an
// authoritative answer: the poll must have covered this channel and reported it
// as not live. A channel the poll could not see keeps its tab.
async function handleOfflineCloses(favorites, nextLive, covered, settings, options = {}) {
  if (!settings.autoCloseOffline) {
    await savePendingCloses({});
    return;
  }

  const managed = await getManagedTabs();
  const entries = Object.values(managed);
  const offlineIds = new Set(
    offlineCandidates({ managedEntries: entries, live: nextLive, covered })
      .filter((entry) => favorites[entry.userId]?.autoClose === true)
      .map((entry) => String(entry.userId))
  );

  // A stream in front of the user waits until they look away.
  const inFront = (await watchedHere(managed)).tabIds;
  const dueCloses = [];
  await mutatePendingCloses((pending) => {
    for (const entry of entries) {
      const userId = String(entry.userId);
      if (offlineIds.has(userId)) {
        if (!pending[userId]) {
          pending[userId] = { tabId: entry.tabId, streamId: entry.streamId, offlineSince: now() };
        }
      } else {
        delete pending[userId];
      }
    }

    const graceMs = options.graceMs ?? (settings.offlineGraceSeconds || 45) * 1000;
    for (const [userId, item] of Object.entries(pending)) {
      if (!managed[String(item.tabId)]) {
        delete pending[userId];
        continue;
      }
      if (now() - item.offlineSince >= graceMs && !inFront.has(Number(item.tabId))) {
        dueCloses.push({ userId, tabId: item.tabId });
        delete pending[userId];
      }
    }
    return pending;
  });

  for (const { userId, tabId } of dueCloses) {
    const entry = managed[String(tabId)];
    await logActivity(`Stream ended — ${entry?.displayName || entry?.login || userId}`, {
      channel: entry?.login,
    });
    await closeManagedTab(tabId);
  }
}

async function clearFinishedSnoozes(favorites, nextLive) {
  await mutateFavorites((current) => {
    let changed = false;
    for (const [userId, favorite] of Object.entries(current)) {
      if (!favorite.snoozeUntilNextStream) continue;
      if (favorite.snoozedStreamId === "current") {
        if (streamIsOpenable(nextLive[userId])) {
          current[userId] = { ...favorite, snoozedStreamId: nextLive[userId].streamId };
          changed = true;
        }
        continue;
      }
      if (!nextLive[userId] || nextLive[userId].streamId !== favorite.snoozedStreamId) {
        current[userId] = { ...favorite, snoozeUntilNextStream: false, snoozedStreamId: null };
        changed = true;
      }
    }
    return changed ? current : undefined;
  });
}

async function clearFinishedDismissals(dismissed, nextLive) {
  await mutateDismissed((current) => {
    let changed = false;
    for (const [userId, streamId] of Object.entries(current)) {
      if (!nextLive[userId] || nextLive[userId].streamId !== streamId) {
        delete current[userId];
        changed = true;
      }
    }
    return changed ? current : undefined;
  });
}

export async function handleManualTabClose(tabId) {
  const managed = await getManagedTabs();
  const entry = managed[String(tabId)];
  if (!entry) return;

  const programmatic = await consumeProgrammaticClose(tabId);
  const liveState = await getLiveState();
  const stream = liveState[entry.userId];

  // Brave mirrors a shared AutoLurk group, so the other computer closing its
  // copy of a channel closes the same tab here. While another tab of that
  // channel is still open, the stream is still being watched: that tab is
  // taken over, and nothing is recorded as the user closing it.
  if (!programmatic) {
    const other = await findTabForChannel(entry.expectedChannel || entry.login);
    if (other && Number(other.id) !== Number(tabId)) {
      await clearBootWatch(tabId);
      await mutateManagedTabs((current) => {
        delete current[String(tabId)];
        return current;
      });
      await adoptGroupedStreamTab(
        other.id,
        { userId: entry.userId, login: entry.login, displayName: entry.displayName },
        stream || { streamId: entry.streamId }
      ).catch(() => null);
      await buildSnapshot();
      await updateBadge();
      return;
    }
  }

  if (!programmatic && stream?.streamId) {
    await mutateDismissed((dismissed) => {
      dismissed[entry.userId] = stream.streamId;
      return dismissed;
    });
    await logActivity(`Manually closed ${entry.displayName || entry.login}`, {
      channel: entry.login,
    });
  }

  await clearBootWatch(tabId);
  const remaining = await mutateManagedTabs((current) => {
    delete current[String(tabId)];
    return current;
  });
  await updateLiveGroup(remaining);
  await mutatePendingCloses((pending) => {
    if (!pending[entry.userId]) return undefined;
    delete pending[entry.userId];
    return pending;
  });
  await buildSnapshot();
  await updateBadge();
}

export async function handleManagedNavigation(tabId, url) {
  // This runs for every tab update in the browser, so the cheapest possible
  // rejection comes first.
  const managed = await getManagedTabs();
  const entry = managed[String(tabId)];
  if (!entry) return;

  const settings = await getSettings();
  if (!settings.closeRaids) return;
  if (Date.now() - (entry.openedAt || 0) < TAB_LOAD_GRACE_MS) return;
  if (urlLeftExpectedChannel(entry, url)) {
    await endRaidedTab(tabId, entry, extractChannelFromUrl(url));
  }
}

// A raid someone is watching goes on as their own tab, out of the group, so
// neither computer closes it.
async function endRaidedTab(tabId, entry, next) {
  await logActivity(`Raid detected: ${entry.expectedChannel} → ${next}`);
  const watched = await watchedStreams(await getManagedTabs());
  if (isWatched(watched, tabId, entry.expectedChannel) || isWatched(watched, -1, next)) {
    await releaseManagedTab(entry.userId);
    await chrome.tabs.ungroup(Number(tabId)).catch(() => {});
  } else {
    await closeManagedTab(tabId);
  }
  await buildSnapshot();
  await updateBadge();
}

export async function handleChannelChanged(tabId, login) {
  const managed = await getManagedTabs();
  const entry = managed[String(tabId)];
  if (!entry) return;

  const settings = await getSettings();
  if (!settings.closeRaids) return;
  if (Date.now() - (entry.openedAt || 0) < TAB_LOAD_GRACE_MS) return;
  if (login && login !== entry.expectedChannel) {
    await endRaidedTab(tabId, entry, login);
  }
}

export async function handleNotificationClick(notificationId) {
  const userId = String(notificationId).split(":")[1];
  if (!userId) return;
  const [follows, liveState] = await Promise.all([getFollows(), getLiveState()]);
  const channel = follows[userId] || liveState[userId];
  if (!channel) return;
  await focusOrOpen(channel, liveState[userId]);
}

// Turns stored evidence into something the UI can state honestly. Nothing here
// claims Twitch counted the view; it reports what was actually observed.
function playbackEvidence(entry) {
  if (!entry) return null;
  const at = now();
  const { state, reason } = evaluateHealth(entry, {}, at);
  return {
    state,
    label: healthLabel(state),
    reason,
    // Media movement is not proof of Twitch watch credit, and the UI says so.
    creditVerified: false,
    channel: entry.expectedChannel,
    observedChannel: entry.observedChannel || "",
    mediaPlaying: Boolean(entry.mediaPlaying),
    heartbeatAgeMs: entry.lastHeartbeatAt ? at - entry.lastHeartbeatAt : null,
    lastAdvanceAgeMs: entry.lastAdvanceAt ? at - entry.lastAdvanceAt : null,
    verifiedAt: entry.lastVerifiedAt || 0,
    tabMuted: Boolean(entry.muted),
    playerMuted: entry.playerMuted,
    selectedQuality: entry.selectedQuality || "",
    videoWidth: entry.videoWidth || 0,
    videoHeight: entry.videoHeight || 0,
    adPlaying: Boolean(entry.adPlaying),
    userUnmuted: Boolean(entry.userUnmuted),
    recoveryStage: entry.recoveryStage || "",
    recoveryAttempts: entry.recoveryAttempts || 0,
    adopted: Boolean(entry.adopted),
  };
}

export async function buildSnapshot() {
  const state = await getAppState();
  // Session state, not stored state, so a dashboard opened mid-session still
  // shows the running tiles instead of an empty picker.
  const [multistream, extensionUpdate] = await Promise.all([
    multistreamSnapshot(),
    getExtensionUpdate(),
  ]);
  const managedByUser = {};
  for (const entry of Object.values(state.managedTabs)) {
    managedByUser[entry.userId] = entry;
  }

  const liveFavorites = [];
  const otherLiveFollows = [];
  const offlineFavorites = [];
  const allChannels = [];

  for (const [userId, favorite] of Object.entries(state.favorites)) {
    const channel = state.follows[userId] || {
      userId,
      login: favorite.login,
      displayName: favorite.displayName,
      profileImageUrl: favorite.profileImageUrl || "",
    };
    const stream = state.liveState[userId];
    const managed = managedByUser[userId];
    const row = {
      ...channel,
      favorite,
      stream,
      managed,
      playback: playbackEvidence(managed),
      points: state.channelPoints[channel.login] || null,
      sevenTv: state.sevenTv[String(userId)] || null,
      isFavorite: true,
      isLive: streamIsOpenable(stream),
      isStale: Boolean(stream?.stale),
    };
    if (streamIsOpenable(stream)) liveFavorites.push(row);
    else offlineFavorites.push(row);
    allChannels.push(row);
  }

  for (const [userId, channel] of Object.entries(state.follows)) {
    if (state.favorites[userId]) continue;
    const stream = state.liveState[userId];
    const row = {
      ...channel,
      stream,
      managed: managedByUser[userId],
      playback: playbackEvidence(managedByUser[userId]),
      points: state.channelPoints[channel.login] || null,
      sevenTv: state.sevenTv[String(userId)] || null,
      isFavorite: false,
      isLive: streamIsOpenable(stream),
      isStale: Boolean(stream?.stale),
    };
    allChannels.push(row);
    if (streamIsOpenable(stream)) otherLiveFollows.push(row);
  }

  liveFavorites.sort((a, b) => (b.stream?.viewerCount || 0) - (a.stream?.viewerCount || 0));
  otherLiveFollows.sort((a, b) => (b.stream?.viewerCount || 0) - (a.stream?.viewerCount || 0));
  offlineFavorites.sort((a, b) =>
    (a.displayName || a.login || "").localeCompare(b.displayName || b.login || "")
  );

  const snapshot = {
    connected: Boolean(state.auth.accessToken),
    user: {
      userId: state.auth.userId,
      login: state.auth.login,
      displayName: state.auth.displayName,
      profileImageUrl: state.auth.profileImageUrl,
    },
    settings: state.settings,
    liveFavorites,
    otherLiveFollows,
    offlineFavorites,
    allChannels,
    followCount: Object.keys(state.follows).length,
    favoriteCount: Object.keys(state.favorites).length,
    managedCount: Object.keys(state.managedTabs).length,
    lastPollAt: state.meta.lastPollAt,
    lastFollowsSyncAt: state.meta.lastFollowsSyncAt,
    deviceFlow: state.meta.deviceFlow,
    // Operational truth: how fresh the data is and why, so the UI can stop
    // presenting a stale list as if it were current.
    poll: {
      status: state.meta.pollStatus || POLL_STATUS.OK,
      error: state.meta.pollError || "",
      failureStreak: state.meta.pollFailureStreak || 0,
      lastSuccessfulPollAt: state.meta.lastSuccessfulPollAt || 0,
      staleForMs: state.meta.lastSuccessfulPollAt
        ? now() - state.meta.lastSuccessfulPollAt
        : null,
      rateLimitedUntil: state.meta.rateLimitedUntil || 0,
    },
    automationPaused: !state.settings.automationEnabled,
    points: pointsSummary(state.channelPoints),
    sync: {
      enabled: state.settings.syncEnabled !== false && Boolean(normalizeSyncGroup(state.settings.syncGroup)),
      group: normalizeSyncGroup(state.settings.syncGroup),
      lastSyncedAt: state.meta.syncedAt || 0,
    },
    sevenTvExtension: Boolean(state.meta.sevenTvExtension),
    multistream,
    activity: state.activity || [],
    update: (() => {
      const currentVersion = chrome.runtime.getManifest?.().version || extensionUpdate.currentVersion || "";
      const update = { ...extensionUpdate, currentVersion };
      if (updateStillNewer(update)) return update;
      return { ...update, availableVersion: "", packageUrl: "" };
    })(),
  };

  await saveSnapshot(snapshot);
  return snapshot;
}

export async function updateBadge() {
  const [settings, favorites, liveState, managed] = await Promise.all([
    getSettings(),
    getFavorites(),
    getLiveState(),
    getManagedTabs(),
  ]);
  const liveCount = Object.keys(favorites).filter((id) => streamIsOpenable(liveState[id])).length;
  const text = liveCount > 0 ? String(liveCount) : "";
  await chrome.action.setBadgeBackgroundColor({
    color: settings.automationEnabled ? "#9146FF" : "#53535f",
  });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({
    title: liveCount
      ? `AutoLurk Companion · ${liveCount} live favorite${liveCount === 1 ? "" : "s"} · ${Object.keys(managed).length} managed`
      : "AutoLurk Companion",
  });
}
