export const EXTENSION_NAME = "AutoLurk Companion";
export const GROUP_NAME = "AutoLurk";

export const ALARMS = {
  POLL_LIVE: "poll-live",
  SYNC_FOLLOWS: "sync-follows",
  VALIDATE_TOKEN: "validate-token",
  HEALTH_CHECK: "health-check",
  DEVICE_POLL: "device-poll",
  STREAK_CHECK: "streak-check",
  UPDATE_CHECK: "update-check",
  SERVER_ROTATE: "server-rotate",
  // Created only after this install turns the local monitor on. Absent otherwise.
  WATCHDOG: "external-watchdog",
  // Not part of the standing schedule. Created only when the startup poll
  // could not reach Twitch, then cleared once a poll succeeds.
  STARTUP_POLL: "startup-poll",
};

// Bumped whenever stored data needs reshaping. See background/migrations.js.
export const SCHEMA_VERSION = 3;

// chrome.storage.session keys. These hold intent that must survive a service
// worker restart but must not outlive the browser session.
export const SESSION_KEYS = {
  PROGRAMMATIC_CLOSES: "programmaticCloses",
  // Off-screen startup windows must remain identifiable if MV3 tears down the
  // service worker while Twitch is still booting.
  STAGING_WINDOWS: "stagingWindows",
  // Tiled multistream is deliberately temporary. Session storage is what makes
  // "put everything back" survive a worker restart without surviving a browser
  // restart, where the popup windows are gone anyway.
  MULTISTREAM: "multistream",
  // Watch-streak recovery tabs. The browser session is the right lifetime:
  // a recovery video does not need to resume after Chrome restarts.
  STREAK: "streakRecovery",
  // Which stream the server rotation opened last. Session lifetime matches a
  // run of Chrome; a fresh browser starts the cycle at the beginning.
  SERVER: "serverRotation",
  // Set on the first worker wake after the browser process starts. Session
  // storage dies with the browser, so the next launch polls again.
  BOOTED: "browserBooted",
  STARTUP_POLLS: "startupPolls",
  // Local-monitor session. Dies with the browser. Absent while the monitor is off.
  WATCHDOG: "watchdogSession",
  // Startup reconciliation. Session lifetime matches one browser run.
  RECONCILE: "startupReconciliation",
  // The AutoLurk group this browser run created, as opposed to one it joined.
  // Group ids are only valid for one browser run.
  GROUP: "autoLurkGroup",
};

export const STORAGE_KEYS = {
  SETTINGS: "settings",
  AUTH: "auth",
  FOLLOWS: "follows",
  FAVORITES: "favorites",
  LIVE_STATE: "liveState",
  MANAGED_TABS: "managedTabs",
  PENDING_CLOSES: "pendingCloses",
  DISMISSED: "dismissed",
  META: "meta",
  SNAPSHOT: "snapshot",
  ACTIVITY: "activity",
  SEVENTV: "sevenTv",
  CHANNEL_POINTS: "channelPoints",
  UPDATE: "extensionUpdate",
  WATCHDOG: "watchdog",
};

export const PRIORITY = {
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low",
};

export const PRIORITY_RANK = {
  high: 3,
  normal: 2,
  low: 1,
};

export const CHECK_INTERVALS = [
  { label: "2 minutes", value: 120 },
  { label: "5 minutes", value: 300 },
];

// Set this to your public Twitch Client ID before sharing the extension.
// Users then only click Connect Twitch. They never open the developer console.
export const PUBLISHED_CLIENT_ID = "qt2v4zt52exls2wzg1h8zm8ag14wja";

export const TAB_LOAD_GRACE_MS = 20000;

export const PUBLIC_SCALE = {
  maxUsers: 200,
  defaultCheckIntervalSeconds: 300,
  followSyncMinutes: 120,
  followSyncMinAgeMs: 2 * 60 * 60 * 1000,
  startupJitterMaxMinutes: 1.5,
  sevenTvPrefetchLimit: 6,
};

export const SEVENTV = {
  API: "https://7tv.io/v3",
  APP: "https://7tv.app",
  CDN: "https://cdn.7tv.app",
  // A channel's emote set rarely changes, and 7TV is a volunteer-run service.
  CACHE_TTL_MS: 6 * 60 * 60 * 1000,
  // Failures are cached too, briefly, so an outage is not retried per poll.
  ERROR_TTL_MS: 30 * 60 * 1000,
  MAX_CONCURRENT: 2,
  PREVIEW_EMOTES: 12,
};

export const CHANNEL_POINTS = {
  // Twitch offers the bonus chest roughly every 15 minutes and leaves it on
  // screen for several, so a slow scan is plenty and survives Chrome
  // throttling background-tab timers down to once a minute.
  SCAN_INTERVAL_MS: 20000,
  // Refuse to click more often than this; the real bonus is never this fast.
  MIN_CLAIM_GAP_MS: 60000,
};

// Four is where a 2x2 grid stops being watchable on one screen, and it is also
// the point past which four decoding streams stop being kind to a GPU.
export const MULTISTREAM = {
  MIN_TILES: 2,
  MAX_TILES: 4,
  // The grid has to be a real Twitch page. Twitch's embedded player takes a
  // bare https domain as its parent and its frame-ancestors policy rejects
  // chrome-extension origins, so an extension page cannot hold the tiles.
  GRID_URL: "https://www.twitch.tv/?autolurk-grid=1",
  GRID_MARKER: "autolurk-grid",
  // Measured against the live site: starting four players the moment the host
  // document is stopped leaves every one of them buffering - they gained
  // twenty-seven seconds of video in a minute. Letting the document settle and
  // then starting the tiles one at a time holds all four at real time.
  START_DELAY_MS: 2000,
  START_STAGGER_MS: 1500,
  // A quarter of a 1440p screen is roughly 720p, and asking for source on four
  // tiles is what makes them fight over the connection. Twitch's own bitrate
  // ladder takes it from here.
  TILE_QUALITY: "720p60",
};

export const GROUP_COLORS = [
  "purple",
  "blue",
  "cyan",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "grey",
];

export const TWITCH_SCOPES = ["user:read:follows"];

export const TWITCH = {
  ID: "https://id.twitch.tv",
  API: "https://api.twitch.tv/helix",
  ACTIVATE: "https://www.twitch.tv/activate",
  DROPS_INVENTORY: "https://www.twitch.tv/drops/inventory",
  DROPS_CAMPAIGNS: "https://www.twitch.tv/drops/campaigns",
};

export const RESERVED_TWITCH_PATHS = new Set([
  "activate",
  "bits",
  "broadcast",
  "clips",
  "directory",
  "downloads",
  "drops",
  "embed",
  "friends",
  "inventory",
  "jobs",
  "login",
  "moderator",
  "p",
  "payments",
  "popout",
  "prime",
  "privacy",
  "products",
  "search",
  "settings",
  "signup",
  "store",
  "subs",
  "subscriptions",
  "team",
  "turbo",
  "u",
  "user",
  "video",
  "videos",
  "wallet",
]);

export function opensInFront(settings, favorite) {
  const mode = settings?.openInFront || "off";
  if (mode === "all") return true;
  if (mode === "favorites") return Boolean(favorite);
  return false;
}

// Only server rotation lets recovery show a stalled stream and reload it.
// "Open streams in front" is about new streams, and a stalled one pulled over
// the stream someone is watching is exactly what it must not do.
export function pullsStreamsForward(settings) {
  return settings?.serverRotation === true;
}

// Twitch's own quality ids. 160p is the lightest decode; Source is whatever the
// channel is sending. Content scripts repeat this list because they cannot
// import it.
export const STREAM_QUALITIES = [
  { id: "160p30", label: "160p" },
  { id: "360p30", label: "360p" },
  { id: "480p30", label: "480p" },
  { id: "720p30", label: "720p" },
  { id: "720p60", label: "720p60" },
  { id: "1080p60", label: "1080p" },
  { id: "chunked", label: "Source" },
];

export const DEFAULT_BACKGROUND_QUALITY = "160p30";
export const DEFAULT_WATCHING_QUALITY = "1080p60";

export function streamQuality(value, fallback) {
  const id = String(value || "");
  return STREAM_QUALITIES.some((item) => item.id === id) ? id : fallback;
}

export function qualityMessage(type, settings) {
  return {
    type,
    backgroundQuality: streamQuality(settings?.backgroundQuality, DEFAULT_BACKGROUND_QUALITY),
    watchingQuality: streamQuality(settings?.watchingQuality, DEFAULT_WATCHING_QUALITY),
  };
}

export const DEFAULT_SETTINGS = {
  clientId: "",
  automationEnabled: true,
  checkIntervalSeconds: 300,
  autoOpenFavorites: true,
  muteTabs: true,
  groupTabs: true,
  collapseGroup: true,
  groupColor: "purple",
  autoCloseOffline: true,
  closeRaids: true,
  offlineGraceSeconds: 45,
  maxAutoOpenStreams: 8,
  notifyLive: true,
  notifyGameChange: false,
  notifyTitleChange: false,
  notifyOnlyWhenNotOpened: true,
  reopenIfManuallyClosed: false,
  // Clicks the channel point bonus chest on Twitch channel tabs.
  claimChannelPoints: true,
  // Only claim on tabs AutoLurk opened, rather than every Twitch tab.
  claimOnManagedTabsOnly: false,
  // Opens a recovery clip or VOD when a favorite's watch streak is expiring.
  saveWatchStreaks: true,
  // A tab that has never been visible often never receives a media source.
  // Showing the recovery video is what lets it actually play.
  streakOpenInFront: true,
  // Automatic streams stay behind the tab the user is on. "favorites" brings
  // starred channels to the front. "all" does that for every stream AutoLurk opens.
  openInFront: "off",
  // Per computer. A laptop and a desktop do not want the same decode size.
  backgroundQuality: "160p30",
  watchingQuality: "1080p60",
  // A machine left running as a server. Every two minutes the next managed
  // stream is opened and checked. Off on a computer someone is using.
  serverRotation: false,
  // A public GitHub repository, or a JSON file { version, packageUrl }.
  // Blank uses this repository. Chrome does not update an unpacked folder on its own.
  updateManifestUrl: "https://github.com/the-mrsir/autolurk",
  sevenTvEnabled: true,
  // Shares favorites and preferences with the user's other computers through
  // the Chrome profile. The Twitch login is never included. syncGroup is filled
  // with a generated code on startup. Paste another computer's code to join it.
  syncEnabled: true,
  syncGroup: "",
};

// null on the notify fields means "follow the global setting"; true or false
// is a per-channel override.
export const DEFAULT_FAVORITE = {
  autoOpen: true,
  notifyLive: null,
  notifyGameChange: null,
  notifyTitleChange: null,
  autoClose: true,
  priority: PRIORITY.NORMAL,
  includeCategories: [],
  excludeCategories: [],
  snoozeUntilNextStream: false,
  snoozedStreamId: null,
  // When the user last changed this favorite, so another computer can tell
  // which edit is the newer one.
  updatedAt: 0,
};

export const DEFAULT_AUTH = {
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
  userId: "",
  login: "",
  displayName: "",
  profileImageUrl: "",
  scopes: [],
};

export const DEFAULT_META = {
  schemaVersion: 0,
  lastPollAt: 0,
  // Last poll that returned a complete, authoritative view of live channels.
  lastSuccessfulPollAt: 0,
  lastFollowsSyncAt: 0,
  lastLiveNotifyAt: {},
  // The one AutoLurk group. A group cannot span windows, so keeping a single id
  // is also what keeps every managed tab in a single window.
  groupId: null,
  deviceFlow: null,
  // Health of the last poll: ok, partial, failed, or unauthorized.
  pollStatus: "ok",
  pollError: "",
  pollFailureStreak: 0,
  rateLimitedUntil: 0,
  // Whether the 7TV browser extension was seen on a Twitch page.
  sevenTvExtension: false,
  sevenTvExtensionAt: 0,
  // Clock for sleep detection: the gap between health checks is what reveals
  // that the machine was suspended, since nothing runs while it is.
  lastHealthTickAt: 0,
  lastWakeAt: 0,
  lastWakeGapMs: 0,
  // Set when a wake happened but the poll could not say which streams are
  // still live. Managed tabs stay frozen until it clears.
  wakeRecheckPending: false,
  // Cross-machine sync bookkeeping.
  syncedAt: 0,
  settingsUpdatedAt: 0,
  // Favorites removed here, kept until every other machine has had a chance
  // to notice. Without these an offline removal is undone by the next sync.
  removedFavorites: {},
};

export const MESSAGE = {
  GET_STATE: "GET_STATE",
    CONNECT: "CONNECT",
    POLL_DEVICE: "POLL_DEVICE",
    CANCEL_CONNECT: "CANCEL_CONNECT",
  DISCONNECT: "DISCONNECT",
  REFRESH_FOLLOWS: "REFRESH_FOLLOWS",
  POLL_NOW: "POLL_NOW",
  TOGGLE_FAVORITE: "TOGGLE_FAVORITE",
  UPDATE_FAVORITE: "UPDATE_FAVORITE",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  OPEN_STREAM: "OPEN_STREAM",
  CLOSE_STREAM: "CLOSE_STREAM",
  SNOOZE_STREAM: "SNOOZE_STREAM",
  UNSNOOZE_STREAM: "UNSNOOZE_STREAM",
  ADOPT_TAB: "ADOPT_TAB",
  RELEASE_TAB: "RELEASE_TAB",
  RETRY_STREAM: "RETRY_STREAM",
  TOGGLE_AUTOMATION: "TOGGLE_AUTOMATION",
  FOCUS_OR_OPEN: "FOCUS_OR_OPEN",
  ADD_CHANNEL: "ADD_CHANNEL",
  AUTH_UPDATED: "AUTH_UPDATED",
  DEVICE_FLOW: "DEVICE_FLOW",
  CHANNEL_CHANGED: "CHANNEL_CHANGED",
  PLAYER_BOOT: "PLAYER_BOOT",
  PLAYER_HEALTH: "PLAYER_HEALTH",
  // Background asks the page for its real media state. Page timers are
  // throttled in background tabs, so pulling beats waiting to be pushed.
  PROBE_PLAYER: "PROBE_PLAYER",
  RECOVER_PLAYER: "RECOVER_PLAYER",
  PIN_LOW_QUALITY: "PIN_LOW_QUALITY",
  PIN_VIEWING_QUALITY: "PIN_VIEWING_QUALITY",
  PIN_HIGH_QUALITY: "PIN_HIGH_QUALITY",
  // Multistream: a grid of embedded players on one Twitch page.
  START_MULTISTREAM: "START_MULTISTREAM",
  STOP_MULTISTREAM: "STOP_MULTISTREAM",
  FOCUS_MULTISTREAM: "FOCUS_MULTISTREAM",
  // The grid page asking which channels it is showing.
  MULTISTREAM_TILES: "MULTISTREAM_TILES",
  // A request to move the sound, from the grid page or the dashboard.
  SET_MULTISTREAM_AUDIO: "SET_MULTISTREAM_AUDIO",
  // Broadcast to the grid document and every player frame in it. Each frame
  // decides whether the named channel is its own.
  MULTISTREAM_AUDIO: "MULTISTREAM_AUDIO",
  AM_I_MANAGED: "AM_I_MANAGED",
  // Pushed when a tab is registered. The page asks once on load and then waits
  // for this, instead of re-asking on a timer forever.
  MANAGED_NOW: "MANAGED_NOW",
  UNMANAGED_NOW: "UNMANAGED_NOW",
  // Content scripts cannot read settings defaults, so they ask for the small
  // slice of configuration they act on and are told when it changes.
  PAGE_CONFIG: "PAGE_CONFIG",
  CONFIG_CHANGED: "CONFIG_CHANGED",
  POINTS_CLAIMED: "POINTS_CLAIMED",
  POINTS_BALANCE: "POINTS_BALANCE",
  // Asked of a logged-in Twitch page, which is the only place the streak query
  // can use the viewer's own session.
  STREAK_GQL: "STREAK_GQL",
  STREAK_PROGRESS: "STREAK_PROGRESS",
  SEVENTV_DETECTED: "SEVENTV_DETECTED",
  OPEN_DASHBOARD: "OPEN_DASHBOARD",
  OPEN_DROPS: "OPEN_DROPS",
  SYNC_NOW: "SYNC_NOW",
  EXPORT_DATA: "EXPORT_DATA",
  IMPORT_DATA: "IMPORT_DATA",
  CHECK_UPDATE: "CHECK_UPDATE",
  WATCHDOG_GET: "WATCHDOG_GET",
  WATCHDOG_SAVE: "WATCHDOG_SAVE",
};
