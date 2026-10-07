// One AutoLurk group across every computer on the same browser profile.
//
// Brave and Chrome sync tab groups, but a group that is open on another
// computer is only a closed saved group here, and the tab group API cannot see
// or open a closed saved group. So the computer holding the group says so in
// sync storage, and the others check that before they create one.

import { getMeta, getSettings, mutateMeta } from "../shared/storage.js";

export const GROUP_CLAIM_KEY = "groupClaim";
export const GROUP_CLAIM_TIMING = {
  // A computer that stops refreshing is treated as gone after this.
  freshMs: 5 * 60_000,
  // Sync storage allows 1800 writes an hour. One every two minutes is plenty.
  refreshMs: 2 * 60_000,
};

function syncArea() {
  return chrome.storage?.sync || null;
}

async function claimAllowed() {
  if (!syncArea()) return false;
  return (await getSettings()).syncEnabled !== false;
}

export async function machineId() {
  const existing = (await getMeta()).machineId;
  if (existing) return existing;
  const made =
    globalThis.crypto?.randomUUID?.() || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const meta = await mutateMeta((current) =>
    current.machineId ? undefined : { ...current, machineId: made }
  );
  return meta?.machineId || made;
}

async function readClaim() {
  try {
    const result = await syncArea().get(GROUP_CLAIM_KEY);
    const claim = result?.[GROUP_CLAIM_KEY];
    return claim && typeof claim === "object" ? claim : null;
  } catch {
    return null;
  }
}

function isFresh(claim, now) {
  return Boolean(claim?.machine) && now - Number(claim.at || 0) < GROUP_CLAIM_TIMING.freshMs;
}

// The claim of another computer that currently holds the group, or null.
export async function groupHeldElsewhere(now = Date.now()) {
  if (!(await claimAllowed())) return null;
  const claim = await readClaim();
  if (!isFresh(claim, now)) return null;
  return claim.machine === (await machineId()) ? null : claim;
}

// Records that this computer holds the group. Returns "held" when the claim is
// this computer's, or "elsewhere" when another computer already holds it.
export async function holdGroupClaim(now = Date.now()) {
  if (!(await claimAllowed())) return "held";
  const me = await machineId();
  const claim = await readClaim();
  if (isFresh(claim, now) && claim.machine !== me) return "elsewhere";
  if (claim?.machine === me && now - Number(claim.at || 0) < GROUP_CLAIM_TIMING.refreshMs) {
    return "held";
  }
  try {
    await syncArea().set({ [GROUP_CLAIM_KEY]: { machine: me, at: now } });
  } catch {
    // Quota or offline. The next pass tries again.
  }
  return "held";
}

export async function releaseGroupClaim() {
  if (!syncArea()) return;
  const claim = await readClaim();
  if (!claim || claim.machine !== (await machineId())) return;
  try {
    await syncArea().remove(GROUP_CLAIM_KEY);
  } catch {
    // It expires on its own.
  }
}
