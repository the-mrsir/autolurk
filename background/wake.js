// Coming back from sleep.
//
// While the machine is asleep nothing runs: no alarms, no page timers, no
// media events. Hours later the browser resumes with every managed tab still
// sitting in its group, every player dead, and most of those broadcasts long
// since ended. Left to the ordinary health check, that state is a disaster —
// every tab reads as stalled at once and the recovery ladder starts restarting
// streams that no longer exist, one screen takeover at a time, while the tabs
// that really did end stay open behind a grace period meant for a blip in a
// single poll.
//
// So a wake is handled as its own event, in a fixed order: stop the ladder,
// find out who is still live, close what ended, and only then bring back what
// is left.
import { HEALTH } from "../shared/health.js";
import { POLL_STATUS } from "../shared/poll-logic.js";
import { getManagedTabs, getMeta, mutateManagedTabs, mutateMeta } from "../shared/storage.js";
import { logActivity } from "./activity.js";
import { pollLiveState } from "./stream-manager.js";
import { runHealthCheck } from "./stream-boot.js";

// The health check runs every minute, so consecutive ticks are a usable clock.
// Anything past this is either sleep or a worker suspended so long that the
// players are dead regardless: the heartbeat timeout is 150 seconds, so
// nothing quiet for five minutes is still playing. Treating a long stall as a
// wake is therefore harmless even when the machine never actually slept.
export const WAKE_GAP_MS = 5 * 60_000;

// Pure so the threshold can be tested without faking alarms or clocks.
export function detectWakeGap(lastTickAt, at, gapMs = WAKE_GAP_MS) {
  if (!lastTickAt) return 0; // First tick after an install or update.
  const gap = at - lastTickAt;
  return gap >= gapMs ? gap : 0;
}

// Records this tick and reports the gap that preceded it, if it was long
// enough to count as a wake.
export async function noteHealthTick(at = Date.now()) {
  let gap = 0;
  await mutateMeta((meta) => {
    gap = detectWakeGap(meta.lastHealthTickAt, at);
    return { ...meta, lastHealthTickAt: at };
  });
  return gap;
}

export function describeGap(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// The single entry point for the one-minute alarm. A tick is one of three
// things: an ordinary health check, the first tick after a sleep, or a retry
// of a wake whose poll could not run.
export async function handleHealthTick(at = Date.now()) {
  const gap = await noteHealthTick(at);
  if (gap) return runWakeRecovery(gap, at);

  const meta = await getMeta();
  if (meta.wakeRecheckPending) {
    // The tabs are still frozen from a wake whose poll failed. Nothing may
    // touch them until we know which streams are still running.
    return runWakeRecovery(meta.lastWakeGapMs || 0, at, { retry: true });
  }

  return runHealthCheck();
}

export async function runWakeRecovery(gapMs, at = Date.now(), options = {}) {
  const before = await getManagedTabs();
  const count = Object.keys(before).length;

  await mutateMeta((meta) => ({ ...meta, lastWakeAt: at, lastWakeGapMs: gapMs }));

  if (count === 0) {
    // Still worth a poll: favorites may have gone live during the sleep.
    await mutateMeta((meta) => ({ ...meta, wakeRecheckPending: false }));
    await pollLiveState().catch(() => {});
    return { closed: 0, resumed: 0 };
  }

  if (!options.retry) {
    await logActivity(
      `Back after ${describeGap(gapMs)} — rechecking ${count} stream${count === 1 ? "" : "s"}`,
      { level: "warn" }
    );
  }

  // Freeze the ladder first. Every stored timestamp is now hours stale, so a
  // health check running in parallel would read all of these as dead and start
  // restarting them before the poll has said which ones still exist.
  await mutateManagedTabs((managed) => {
    for (const [tabId, entry] of Object.entries(managed)) {
      managed[tabId] = {
        ...entry,
        health: HEALTH.SUSPENDED,
        healthReason: "machine was asleep",
        mediaPlaying: false,
      };
    }
    return managed;
  });

  // Who is actually still on air. immediateCloses drops the offline grace: it
  // exists so one unlucky poll cannot close a tab, and a broadcast that ended
  // during a three hour sleep is not an unlucky poll.
  //
  // Deliberately not forced. A forced poll ignores the rate limit and would
  // hammer Twitch once a minute for as long as the retry loop runs.
  let status = null;
  try {
    ({
      status,
    } = await pollLiveState({
      immediateCloses: true,
      requireCompleteBeforeMutations: true,
    }));
  } catch (error) {
    status = null;
    if (!options.retry) {
      await logActivity(`Could not check streams after waking (${error.message})`, {
        level: "warn",
      });
    }
  }

  // A degraded poll is worse than no poll here, because acting on it means
  // either closing a tab whose stream is fine or restarting one that ended.
  // No network yet is the normal case on wake — Wi-Fi reconnects after the
  // browser resumes — so the tabs stay frozen and the next tick tries again.
  if (status !== POLL_STATUS.OK) {
    await mutateMeta((meta) => ({ ...meta, wakeRecheckPending: true }));
    return { closed: 0, resumed: 0, deferred: true };
  }

  await mutateMeta((meta) => ({ ...meta, wakeRecheckPending: false }));

  const survivors = await getManagedTabs();
  const closed = count - Object.keys(survivors).length;

  // Hand the survivors to the ordinary ladder rather than restarting them
  // here. It already knows how to try the cheap thing first — a nudge, which
  // costs no screen time and is often all a paused player needs — and how to
  // escalate to a restart and stagger those one per pass. The cooldown is
  // cleared so the first attempt happens now instead of in 45 seconds.
  await mutateManagedTabs((managed) => {
    for (const [tabId, entry] of Object.entries(managed)) {
      managed[tabId] = {
        ...entry,
        health: HEALTH.STALLED,
        healthReason: "machine was asleep",
        recoveryAttempts: 0,
        recoveryStage: "",
        lastRecoveryAt: 0,
        // A wake is not a reason to stay given up on.
        failedAt: 0,
      };
    }
    return managed;
  });

  const resumed = Object.keys(survivors).length;
  if (closed) {
    await logActivity(`Closed ${closed} stream${closed === 1 ? "" : "s"} that ended while asleep`);
  }
  if (resumed) {
    await logActivity(`Restarting ${resumed} stream${resumed === 1 ? "" : "s"} that are still live`);
  }

  await runHealthCheck();
  return { closed, resumed };
}
