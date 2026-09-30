import { assert, describe, it } from "./harness.js";
import {
  evaluateHealth,
  HEALTH,
  HEALTH_TIMING,
  nextRecoveryStage,
  RECOVERY_STAGE,
  shouldAttemptRecovery,
} from "../shared/health.js";

const NOW = 1_000_000_000;

function entry(overrides = {}) {
  return {
    expectedChannel: "streamer",
    observedChannel: "streamer",
    openedAt: NOW - 10_000,
    lastVerifiedAt: NOW - 5000,
    lastHeartbeatAt: NOW - 1000,
    lastAdvanceAt: NOW - 1000,
    mediaPlaying: true,
    playerMuted: false,
    ...overrides,
  };
}

describe("evaluateHealth", () => {
  it("calls a moving player on the right channel media_playing", () => {
    assert.equal(evaluateHealth(entry(), {}, NOW).state, HEALTH.MEDIA_PLAYING);
  });

  it("gives a brand new tab a boot grace period", () => {
    const result = evaluateHealth(
      entry({ lastVerifiedAt: 0, openedAt: NOW - 5000, mediaPlaying: false }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.BOOTING);
  });

  it("stops excusing a tab that never started once the grace period ends", () => {
    const result = evaluateHealth(
      entry({ lastVerifiedAt: 0, openedAt: NOW - HEALTH_TIMING.bootGraceMs - 1, mediaPlaying: false }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.STALLED);
    assert.equal(result.reason, "never started playing");
  });

  it("does not reapply the boot grace to a stream that dies hours later", () => {
    // The old bug: openedAt was reset on every recovery, so a long-running
    // stream that froze kept getting excused as "still booting".
    const result = evaluateHealth(
      entry({
        openedAt: NOW - 1000,
        lastVerifiedAt: NOW - 4 * 3600_000,
        lastHeartbeatAt: NOW - 1000,
        lastAdvanceAt: NOW - HEALTH_TIMING.stallMs - 1,
      }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.STALLED);
  });

  it("treats a silent page as stalled", () => {
    const result = evaluateHealth(
      entry({ lastHeartbeatAt: NOW - HEALTH_TIMING.heartbeatTimeoutMs - 1 }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.STALLED);
    assert.equal(result.reason, "page stopped responding");
  });

  it("treats an unloaded tab as stalled", () => {
    assert.equal(evaluateHealth(entry(), { discarded: true }, NOW).state, HEALTH.STALLED);
  });

  it("refuses to credit a tab that wandered to another channel", () => {
    const result = evaluateHealth(entry({ observedChannel: "someoneelse" }), {}, NOW);
    assert.equal(result.state, HEALTH.STALLED);
    assert.equal(result.reason, "tab moved to someoneelse");
  });

  it("keeps a playing muted stream healthy after a reload drops the tab mute", () => {
    const result = evaluateHealth(
      entry({
        playerMuted: true,
        muted: false,
        mediaPlaying: true,
        playerUnmutedAt: NOW - HEALTH_TIMING.mutedGraceMs - 1,
      }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.MEDIA_PLAYING);
  });

  it("calls a muted player that is not playing degraded", () => {
    const result = evaluateHealth(
      entry({
        playerMuted: true,
        mediaPlaying: false,
        playerUnmutedAt: NOW - HEALTH_TIMING.mutedGraceMs - 1,
      }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.DEGRADED);
    assert.equal(result.reason, "player is muted");
  });

  it("tolerates a briefly muted player during the bootstrap", () => {
    const result = evaluateHealth(entry({ playerMuted: true, playerUnmutedAt: NOW - 1000 }), {}, NOW);
    assert.equal(result.state, HEALTH.MEDIA_PLAYING);
  });

  it("holds a recovering tab steady during the cooldown", () => {
    const result = evaluateHealth(
      entry({ health: HEALTH.RECOVERING, lastRecoveryAt: NOW - 1000, mediaPlaying: false }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.RECOVERING);
  });

  it("keeps a failed tab quiet until an explicit recovery signal", () => {
    const result = evaluateHealth(
      entry({ health: HEALTH.FAILED, failedAt: NOW - 24 * 60 * 60_000 }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.FAILED);
  });

  it("does not call a responsive hidden tab stalled when Twitch removed its video", () => {
    const result = evaluateHealth(
      entry({
        lastAdvanceAt: NOW - HEALTH_TIMING.stallMs - 1,
        backgroundUnverifiableAt: NOW - 1000,
      }),
      {},
      NOW
    );
    assert.equal(result.state, HEALTH.DEGRADED);
    assert.equal(result.reason, "background player temporarily unavailable");
  });
});

describe("recovery ladder", () => {
  it("escalates one step per failed attempt", () => {
    assert.equal(nextRecoveryStage({ recoveryAttempts: 0 }), RECOVERY_STAGE.NUDGE);
    assert.equal(nextRecoveryStage({ recoveryAttempts: 1 }), RECOVERY_STAGE.RELOAD);
    assert.equal(nextRecoveryStage({ recoveryAttempts: 2 }), RECOVERY_STAGE.REOPEN);
    assert.equal(nextRecoveryStage({ recoveryAttempts: 3 }), RECOVERY_STAGE.GIVE_UP);
  });

  it("holds off while a previous attempt is still settling", () => {
    assert.notOk(shouldAttemptRecovery({ lastRecoveryAt: NOW - 100 }, NOW));
    assert.ok(shouldAttemptRecovery({ lastRecoveryAt: NOW - 60_000 }, NOW));
  });
});
