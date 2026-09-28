// Watching several streams at once, in one window.
//
// Chrome paints exactly one tab per window, so four real Twitch tabs can only
// ever be four windows. Side by side in a single window therefore means
// embedded players - and Twitch will not embed its player just anywhere. Its
// parent check takes a bare https domain, and its frame-ancestors policy
// refuses chrome-extension origins outright, both confirmed against the live
// site. That leaves one place the grid can live: an ordinary www.twitch.tv
// page, whose own document is stopped and replaced with the tiles before its
// app boots. See content/twitch-grid.js.
//
// The grid is only a viewer. An embedded player claims no channel points and
// earns no streak, so the managed lurk tabs are deliberately left exactly as
// they are - in the AutoLurk group, muted, at 160p, still doing the thing this
// extension exists for. Nothing here moves, mutes, regroups or reloads them.
// The one thing it does do is open a lurk tab for a tiled channel that has
// none, so watching a stream in the grid also counts.
//
// The session is temporary, so it lives in session storage: it has to survive
// the service worker being torn down mid-session, and it must not survive a
// browser restart, where the grid tab is gone anyway.
import { MESSAGE, MULTISTREAM, SESSION_KEYS } from "../shared/constants.js";
import {
  getFavorites,
  getFollows,
  getLiveState,
  getManagedTabs,
  getSessionValue,
  setSessionValue,
} from "../shared/storage.js";
import { streamIsOpenable } from "../shared/poll-logic.js";
import { logActivity } from "./activity.js";
import { openManagedStream } from "./tab-manager.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export async function getMultistream() {
  const session = await getSessionValue(SESSION_KEYS.MULTISTREAM, null);
  return session?.active ? session : null;
}

async function saveSession(session) {
  await setSessionValue(SESSION_KEYS.MULTISTREAM, session);
  return session;
}

// Starting, switching audio, the grid tab closing and exiting all arrive from
// unrelated events and all rewrite the same session, so they take turns.
let chain = Promise.resolve();

function queued(run) {
  const result = chain.then(run, run);
  chain = result.then(
    () => {},
    () => {}
  );
  return result;
}

export async function isGridTab(tabId) {
  if (tabId == null) return false;
  const session = await getMultistream();
  return session != null && Number(session.gridTabId) === Number(tabId);
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export function startMultistream(userIds) {
  return queued(() => beginMultistream(userIds));
}

function channelFor(userId, follows, favorites, stream) {
  return {
    userId: String(userId),
    login: follows[userId]?.login || stream?.login || favorites[userId]?.login || "",
    displayName:
      follows[userId]?.displayName ||
      stream?.displayName ||
      favorites[userId]?.displayName ||
      follows[userId]?.login ||
      "",
  };
}

const label = (channel) => channel.displayName || channel.login || channel.userId;

async function beginMultistream(userIds) {
  const running = await getMultistream();
  if (running && (await gridTabLives(running.gridTabId))) {
    throw new Error("Multistream is already open. Exit it before starting another.");
  }

  const ids = [...new Set((userIds || []).map(String))];
  if (ids.length < MULTISTREAM.MIN_TILES) {
    throw new Error(`Pick at least ${MULTISTREAM.MIN_TILES} live channels to watch together.`);
  }
  if (ids.length > MULTISTREAM.MAX_TILES) {
    throw new Error(`The grid holds at most ${MULTISTREAM.MAX_TILES} streams at once.`);
  }

  const [live, follows, favorites] = await Promise.all([getLiveState(), getFollows(), getFavorites()]);
  const wanted = [];
  for (const userId of ids) {
    const stream = live[userId];
    const channel = channelFor(userId, follows, favorites, stream);
    if (!streamIsOpenable(stream)) {
      throw new Error(`${label(channel)} is not live right now.`);
    }
    if (!channel.login) throw new Error("That channel is missing a Twitch username.");
    wanted.push({ channel, stream });
  }

  // The lurk tab behind a tile is what claims points and holds the streak, so
  // anything tiled is opened for real too. Failing to open one is not worth
  // refusing the grid over - the stream still plays, it just stops counting.
  for (const { channel, stream } of wanted) {
    if (await managedTabFor(channel.userId)) continue;
    try {
      await openManagedStream(channel, stream);
    } catch (error) {
      console.warn(`Could not open a lurk tab for ${label(channel)}`, error);
    }
  }

  const channels = wanted.map(({ channel }) => channel);

  // Saved before the tab exists, because the grid asks for its tiles the
  // instant it loads and that can happen before tabs.create resolves. The
  // asking tab is adopted as the grid tab when the id is still missing.
  let session = await saveSession({
    active: true,
    startedAt: Date.now(),
    gridTabId: null,
    focusedUserId: channels[0].userId,
    channels,
  });

  const gridTabId = await openGridTab();
  // Re-read rather than patch the copy above: the page may already have
  // adopted itself as the grid tab while tabs.create was still resolving.
  session = await saveSession({ ...((await getMultistream()) || session), gridTabId });

  await logActivity(
    `Multistream opened with ${channels.length} streams: ${channels.map(label).join(", ")}`
  );
  return describeSession(session);
}

async function managedTabFor(userId) {
  const managed = await getManagedTabs();
  return Object.values(managed).find((entry) => String(entry.userId) === String(userId)) || null;
}

// In the window the user is already working in, which after the lurk tabs
// above is the one holding the AutoLurk group. A popup is never a candidate:
// the whole point is that this is one ordinary tab in one ordinary window.
async function openGridTab() {
  const create = { url: MULTISTREAM.GRID_URL, active: true };
  const windowId = await normalWindowId();
  if (windowId != null) create.windowId = windowId;
  const tab = await chrome.tabs.create(create);
  return tab?.id ?? null;
}

async function normalWindowId() {
  try {
    const focused = await chrome.windows.getLastFocused();
    if (focused?.id != null && focused.type === "normal") return focused.id;
  } catch {
    // Fall through to a full scan.
  }
  try {
    const windows = await chrome.windows.getAll();
    return windows.find((window) => window.type === "normal")?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The grid page
// ---------------------------------------------------------------------------

// Answers the grid's one question: which channels, and which of them has the
// sound. Returning null tells the page it is not part of a session, which is
// how a restored or bookmarked grid URL sends itself back to Twitch.
export async function gridTiles(tabId) {
  const session = await getMultistream();
  if (!session) return null;
  if (session.gridTabId != null && Number(session.gridTabId) !== Number(tabId)) return null;
  if (session.gridTabId == null) await saveSession({ ...session, gridTabId: Number(tabId) });

  return {
    tiles: session.channels.map((channel) => ({
      userId: channel.userId,
      login: channel.login,
      displayName: channel.displayName || channel.login,
    })),
    audibleLogin: audibleLogin(session),
    quality: MULTISTREAM.TILE_QUALITY,
    startDelayMs: MULTISTREAM.START_DELAY_MS,
    staggerMs: MULTISTREAM.START_STAGGER_MS,
  };
}

function audibleLogin(session) {
  const tile =
    session.channels.find((channel) => String(channel.userId) === String(session.focusedUserId)) ||
    session.channels[0];
  return tile?.login || "";
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export function setMultistreamAudio(userId) {
  return queued(() => switchAudio(userId));
}

async function switchAudio(userId) {
  const session = await getMultistream();
  if (!session) return null;

  const tile = session.channels.find((channel) => String(channel.userId) === String(userId));
  if (!tile) return describeSession(session);
  if (String(session.focusedUserId) === String(tile.userId)) return describeSession(session);

  const next = await saveSession({ ...session, focusedUserId: String(tile.userId) });
  await broadcastAudio(next);
  return describeSession(next);
}

// One message reaches the grid document and every player frame inside it, and
// each frame decides whether the named channel is its own. Addressing frames
// individually would mean tracking four frame ids that change whenever a tile
// reloads itself.
async function broadcastAudio(session) {
  if (session.gridTabId == null) return;
  try {
    await chrome.tabs.sendMessage(Number(session.gridTabId), {
      type: MESSAGE.MULTISTREAM_AUDIO,
      login: audibleLogin(session),
    });
  } catch {
    // The grid is gone or still loading. A loading grid reads the audible
    // channel out of the session when it asks for its tiles.
  }
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

export function stopMultistream(options = {}) {
  return queued(() => endMultistream(options));
}

// Closing the grid tab is the whole of it. The lurk tabs were never moved, so
// there is nothing to put back and no group to rebuild.
async function endMultistream(options = {}) {
  const session = await getSessionValue(SESSION_KEYS.MULTISTREAM, null);
  if (!session) return { active: false, tiles: [] };

  // Cleared first: removing the tab fires the event that re-enters here.
  await setSessionValue(SESSION_KEYS.MULTISTREAM, null);

  let closed = false;
  if (!options.keepTab && session.gridTabId != null) {
    try {
      await chrome.tabs.remove(Number(session.gridTabId));
      closed = true;
    } catch {
      // Already gone.
    }
  }

  await logActivity(
    options.reason ? `Multistream closed (${options.reason})` : "Multistream closed"
  );
  return { active: false, closed, tiles: [] };
}

export function handleMultistreamTabRemoved(tabId) {
  return queued(async () => {
    const session = await getMultistream();
    if (!session || Number(session.gridTabId) !== Number(tabId)) return null;
    return endMultistream({ keepTab: true, reason: "the grid tab was closed" });
  });
}

// Run after a service worker restart, and on every health check. The session
// outlives the worker, so the grid tab has to be checked against what Chrome
// still has rather than trusted.
export function reconcileMultistream() {
  return queued(async () => {
    const session = await getMultistream();
    if (!session) return null;
    if (!(await gridTabLives(session.gridTabId))) {
      return endMultistream({ keepTab: true, reason: "the grid tab is gone" });
    }
    return describeSession(session);
  });
}

// A grid tab that has been navigated somewhere else is no longer a grid, even
// though the tab is still open, so the marker is what counts rather than the
// id alone. A tab that has not committed a URL yet is given the benefit of the
// doubt, or a health check landing mid-open would end the session it just
// started.
async function gridTabLives(tabId) {
  if (tabId == null) return false;
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    if (!tab) return false;
    const url = tab.url || tab.pendingUrl || "";
    return url ? url.includes(MULTISTREAM.GRID_MARKER) : true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function describeSession(session) {
  if (!session) return { active: false, max: MULTISTREAM.MAX_TILES, tiles: [] };
  return {
    active: true,
    max: MULTISTREAM.MAX_TILES,
    startedAt: session.startedAt || 0,
    gridTabId: session.gridTabId ?? null,
    focusedUserId: String(session.focusedUserId || ""),
    tiles: session.channels.map((channel) => ({
      userId: channel.userId,
      login: channel.login,
      displayName: channel.displayName || channel.login,
      audible: String(channel.userId) === String(session.focusedUserId),
    })),
  };
}

// Folded into the dashboard snapshot, so reopening the dashboard mid-session
// shows the running grid rather than an empty picker.
export async function multistreamSnapshot() {
  return describeSession(await getMultistream());
}

// The dashboard's way of getting back to a grid buried behind other tabs.
export async function focusGridTab() {
  const session = await getMultistream();
  if (!session?.gridTabId) return false;
  try {
    const tab = await chrome.tabs.update(Number(session.gridTabId), { active: true });
    if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}
