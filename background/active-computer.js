// AutoLurk runs on one computer at a time.
//
// Brave mirrors open tab groups between computers, so two computers both
// opening, closing and grouping streams act on each other's tabs. The computer
// running AutoLurk says so in sync storage; the others stand by and leave
// every tab alone until that computer goes quiet or the user picks another.

import { getMeta, getSettings, mutateMeta } from "../shared/storage.js";
import { logActivity } from "./activity.js";
import { machineId } from "./group-claim.js";

export const ACTIVE_COMPUTER_KEY = "activeComputer";
export const ACTIVE_COMPUTER_TIMING = {
  // A computer that stops refreshing is treated as off after this, and the
  // next computer to check takes over.
  freshMs: 10 * 60_000,
  refreshMs: 2 * 60_000,
};

const OS_NAMES = { win: "Windows", linux: "Linux", mac: "Mac", cros: "ChromeOS" };

function syncArea() {
  return chrome.storage?.sync || null;
}

async function shared() {
  if (!syncArea()) return false;
  return (await getSettings()).syncEnabled !== false;
}

async function readClaim() {
  try {
    const claim = (await syncArea().get(ACTIVE_COMPUTER_KEY))?.[ACTIVE_COMPUTER_KEY];
    return claim && typeof claim === "object" ? claim : null;
  } catch {
    return null;
  }
}

function isFresh(claim, now) {
  return Boolean(claim?.machine) && now - Number(claim.at || 0) < ACTIVE_COMPUTER_TIMING.freshMs;
}

export async function computerName() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    return `${OS_NAMES[info?.os] || "Another"} computer`;
  } catch {
    return "Another computer";
  }
}

async function writeClaim(me, now) {
  try {
    await syncArea().set({ [ACTIVE_COMPUTER_KEY]: { machine: me, name: await computerName(), at: now } });
  } catch {
    // Quota or offline. The next check tries again.
  }
}

// Tab events ask this many times a second. Sync is read at most this often.
const CACHE_MS = 15_000;
let cached = { at: 0, here: true };

// Whether this computer runs automation right now. Claims the role when no
// other computer holds it, and keeps the claim fresh while it does.
export async function runsHere(now = Date.now()) {
  if (cached.at && now - cached.at < CACHE_MS) return cached.here;
  const here = await checkRole(now);
  cached = { at: now, here };
  return here;
}

async function checkRole(now) {
  if (!(await shared())) return noteRole(true);
  const me = await machineId();
  const claim = await readClaim();
  if (isFresh(claim, now) && claim.machine !== me) return noteRole(false, claim);
  if (claim?.machine !== me || now - Number(claim.at || 0) >= ACTIVE_COMPUTER_TIMING.refreshMs) {
    await writeClaim(me, now);
  }
  return noteRole(true);
}

export async function standingBy() {
  return !(await runsHere());
}

export async function runHere(now = Date.now()) {
  cached = { at: now, here: true };
  if (!(await shared())) return true;
  await writeClaim(await machineId(), now);
  await noteRole(true);
  return true;
}

export function resetActiveComputer() {
  cached = { at: 0, here: true };
}
(globalThis.__autoLurkTestResets ||= []).push(resetActiveComputer);

export async function activeComputerState(now = Date.now()) {
  if (!(await shared())) return { here: true, name: "" };
  const claim = await readClaim();
  const me = await machineId();
  if (isFresh(claim, now) && claim.machine !== me) {
    return { here: false, name: claim.name || "Another computer", at: Number(claim.at) || 0 };
  }
  return { here: true, name: "" };
}

// Logs the change of role once, and hands the change to whoever registered
// for it: standing by lets go of every tab without closing it.
let onRoleChange = null;

export function whenRoleChanges(handler) {
  onRoleChange = handler;
}

async function noteRole(here, claim = null) {
  const previous = (await getMeta()).runsHere;
  if (previous === here) return here;
  await mutateMeta((meta) => ({ ...meta, runsHere: here }));
  // The first check on a computer that was always running is not a change.
  if (previous === undefined && here) return here;
  await logActivity(
    here
      ? "AutoLurk is running on this computer."
      : `AutoLurk is running on ${claim?.name || "another computer"}. This computer is standing by.`
  );
  // Not awaited: the handler polls and reconciles, and those queues may be
  // the very caller asking for the role.
  if (onRoleChange) {
    const handler = onRoleChange;
    Promise.resolve()
      .then(() => handler(here))
      .catch((error) => console.warn("Role change failed", error));
  }
  return here;
}
