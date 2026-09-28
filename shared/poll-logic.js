// Pure decision logic for turning Twitch API results into live state.
//
// The important rule here: a channel is only "offline" when a query that
// covered it succeeded. Anything else is unknown, and unknown must never be
// treated as offline or AutoLurk will close tabs during an outage.

export const POLL_STATUS = {
  OK: "ok",
  PARTIAL: "partial",
  FAILED: "failed",
  UNAUTHORIZED: "unauthorized",
};

export function classifyPoll({ followedFailure = null, favoriteFailure = null } = {}) {
  if (followedFailure === "unauthorized" || favoriteFailure === "unauthorized") {
    return POLL_STATUS.UNAUTHORIZED;
  }
  if (followedFailure && favoriteFailure) return POLL_STATUS.FAILED;
  if (followedFailure || favoriteFailure) return POLL_STATUS.PARTIAL;
  return POLL_STATUS.OK;
}

// Builds the next live map plus the set of channels whose status is actually
// known this round.
export function mergeLiveState({
  previousLive = {},
  followedStreams = null,
  favoriteStreams = null,
  followIds = [],
  favoriteIds = [],
  now = Date.now(),
} = {}) {
  const fresh = {};
  if (favoriteStreams) {
    for (const [userId, stream] of Object.entries(favoriteStreams)) fresh[userId] = stream;
  }
  if (followedStreams) {
    for (const stream of followedStreams) fresh[stream.userId] = stream;
  }

  // A successful followed-streams walk tells us about every followed channel;
  // a successful favorites lookup only tells us about the ids we asked for.
  const covered = new Set();
  if (followedStreams) {
    for (const id of followIds) covered.add(String(id));
    for (const stream of followedStreams) covered.add(String(stream.userId));
  }
  if (favoriteStreams) {
    for (const id of favoriteIds) covered.add(String(id));
  }

  const live = {};
  for (const [userId, stream] of Object.entries(fresh)) {
    live[userId] = { ...stream, isLive: true, stale: false, observedAt: now };
  }

  for (const [userId, stream] of Object.entries(previousLive)) {
    if (live[userId]) continue;
    // Known offline: drop it. Unknown: keep the last reading, flagged stale.
    if (covered.has(String(userId))) continue;
    live[userId] = { ...stream, stale: true };
  }

  return { live, covered };
}

// Offline handling may only act on channels this poll could actually see.
export function offlineCandidates({ managedEntries = [], live = {}, covered = new Set() } = {}) {
  return managedEntries.filter((entry) => {
    const userId = String(entry.userId);
    // Not covered means the poll never learned anything about this channel.
    if (!covered.has(userId)) return false;
    return !live[userId];
  });
}

// A leftover live-state row is not a reason to open a tab. Only a stream this
// poll (or a fresh Helix lookup) actually saw as live may be opened.
export function streamIsOpenable(stream) {
  return Boolean(stream && stream.isLive && !stream.stale && stream.streamId);
}

export function pollStatusMessage(status, detail = "") {
  switch (status) {
    case POLL_STATUS.UNAUTHORIZED:
      return "Twitch sign-in expired. Reconnect to keep AutoLurk running.";
    case POLL_STATUS.FAILED:
      return detail || "Could not reach Twitch. Showing the last known status.";
    case POLL_STATUS.PARTIAL:
      return detail || "Twitch returned part of the data. Some channels may be out of date.";
    default:
      return "";
  }
}
