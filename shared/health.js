// Pure playback health evaluation.
//
// Deliberate limitation: none of this proves Twitch credited the view. The
// strongest claim the evidence supports is that the correct channel's video
// element is decoding frames, which is why the healthy state is called
// media_playing rather than "watching".

export const HEALTH = {
  BOOTING: "booting",
  MEDIA_PLAYING: "media_playing",
  DEGRADED: "degraded",
  STALLED: "stalled",
  RECOVERING: "recovering",
  FAILED: "failed",
  // The machine was asleep. Held until the poll says whether the stream is
  // even still running.
  SUSPENDED: "suspended",
};

export const RECOVERY_STAGE = {
  NUDGE: "nudge",
  RELOAD: "reload",
  REOPEN: "reopen",
  GIVE_UP: "give_up",
};

export const HEALTH_TIMING = {
  // Only applies before the stream has ever been verified. Measured starts in
  // a hidden tab reached playback anywhere from 5s to 45s, and a preroll ad
  // adds to that, so this is deliberately well clear of the slowest good case.
  bootGraceMs: 150_000,
  // The page pushes on media events and the background probes once a minute,
  // so this has to clear two consecutive probes plus alarm slack. MV3 alarms
  // are routinely late, and treating lateness as a dead stream is what caused
  // reload storms.
  heartbeatTimeoutMs: 150_000,
  // Twitch buffers and reconnects, so require a long freeze.
  stallMs: 100_000,
  // How long a muted player is tolerated before it counts as degraded.
  mutedGraceMs: 120_000,
  // One escalation per health check at most. The old 8s let a single bad
  // minute walk the whole ladder from nudge to reopening the tab.
  recoveryCooldownMs: 45_000,
};

function result(state, reason) {
  return { state, reason };
}

export function evaluateHealth(entry = {}, tab = {}, now = Date.now(), timing = HEALTH_TIMING) {
  // Checked before anything else, including the failure retry. After a wake
  // every stored timestamp is hours stale, so every other branch here would
  // read as a dead stream and start reloading tabs whose broadcast ended
  // while the machine was asleep. Wake recovery lifts this once the poll has
  // said which streams still exist.
  if (entry.health === HEALTH.SUSPENDED) {
    return result(HEALTH.SUSPENDED, entry.healthReason || "machine was asleep");
  }

  if (entry.health === HEALTH.FAILED) {
    // A timer must never re-arm an exhausted recovery ladder. That created a
    // nudge/reload/reopen cycle every few minutes for tabs whose player could
    // not be observed. Fresh playback evidence, wake recovery, and the user's
    // Retry action all explicitly clear FAILED when appropriate.
    return result(HEALTH.FAILED, entry.healthReason || "playback failed");
  }

  if (tab.discarded || tab.status === "unloaded") {
    return result(HEALTH.STALLED, "tab was unloaded");
  }

  if (entry.health === HEALTH.RECOVERING) {
    const since = now - (entry.lastRecoveryAt || 0);
    if (since < timing.recoveryCooldownMs) {
      return result(HEALTH.RECOVERING, entry.healthReason || "recovering");
    }
  }

  // Playing the wrong channel earns no credit for the one we care about.
  if (entry.observedChannel && entry.expectedChannel && entry.observedChannel !== entry.expectedChannel) {
    return result(HEALTH.STALLED, `tab moved to ${entry.observedChannel}`);
  }

  const verified = Number(entry.lastVerifiedAt) > 0;
  if (!verified) {
    const booting = now - (entry.openedAt || 0) < timing.bootGraceMs;
    return booting
      ? result(HEALTH.BOOTING, entry.healthReason || "starting playback")
      : result(HEALTH.STALLED, "never started playing");
  }

  // Once verified, the grace period is over for good: a stream that dies at
  // hour three must be caught as fast as one that dies at minute one.
  const silentFor = now - (entry.lastHeartbeatAt || 0);
  if (silentFor > timing.heartbeatTimeoutMs) {
    return result(HEALTH.STALLED, "page stopped responding");
  }

  if (
    entry.backgroundUnverifiableAt &&
    now - entry.backgroundUnverifiableAt <= timing.heartbeatTimeoutMs
  ) {
    return result(HEALTH.DEGRADED, "background player temporarily unavailable");
  }

  const frozenFor = now - (entry.lastAdvanceAt || 0);
  if (frozenFor > timing.stallMs) {
    return result(HEALTH.STALLED, entry.mediaPlaying ? "video froze" : "player is paused");
  }

  // A player mute requested by AutoLurk is intentional and must not trigger a
  // recovery loop. Only an unexpected player mute is degraded.
  if (entry.playerMuted === true && !(entry.muted && !entry.userUnmuted)) {
    const mutedFor = now - (entry.playerUnmutedAt || entry.lastVerifiedAt || 0);
    if (mutedFor > timing.mutedGraceMs) {
      return result(HEALTH.DEGRADED, "player is muted");
    }
  }

  if (!entry.mediaPlaying) {
    return result(HEALTH.DEGRADED, "player reported not playing");
  }

  return result(HEALTH.MEDIA_PLAYING, "");
}

// Escalation ladder. Each failed attempt moves one step further.
export function nextRecoveryStage(entry = {}) {
  const attempts = Number(entry.recoveryAttempts) || 0;
  if (attempts <= 0) return RECOVERY_STAGE.NUDGE;
  if (attempts === 1) return RECOVERY_STAGE.RELOAD;
  if (attempts === 2) return RECOVERY_STAGE.REOPEN;
  return RECOVERY_STAGE.GIVE_UP;
}

export function shouldAttemptRecovery(entry = {}, now = Date.now(), timing = HEALTH_TIMING) {
  const since = now - (entry.lastRecoveryAt || 0);
  return since >= timing.recoveryCooldownMs;
}

// A tab the user is looking at gets nudged, never reloaded out from under them.
export function allowedStageForVisibleTab(stage) {
  return stage === RECOVERY_STAGE.NUDGE ? stage : null;
}

export function healthLabel(state) {
  switch (state) {
    case HEALTH.MEDIA_PLAYING:
      return "Media playing";
    case HEALTH.BOOTING:
      return "Starting";
    case HEALTH.DEGRADED:
      return "Degraded";
    case HEALTH.STALLED:
      return "Stalled";
    case HEALTH.RECOVERING:
      return "Recovering";
    case HEALTH.FAILED:
      return "Playback failed";
    case HEALTH.SUSPENDED:
      return "Asleep";
    default:
      return "Unknown";
  }
}
