// Pure accounting for channel point claims.
//
// A deliberate limitation runs through this file. Twitch abbreviates the
// balance once it passes a thousand ("1.2K"), so a +50 bonus usually does not
// change the number on screen. That means "points earned" cannot be measured
// from the page, and inventing it would be the same mistake as the old
// "Watching" label. What is observable is whether the bonus chest disappeared
// after the click, so that is what gets counted.

export function emptyPointsEntry(login) {
  return {
    login,
    balance: null,
    // True when the balance came from an abbreviated string like "1.2K".
    balanceApproximate: false,
    claims: 0,
    unconfirmedClaims: 0,
    lastClaimAt: 0,
    updatedAt: 0,
  };
}

// Twitch renders "1,234", "1.2K" or "3.4M" depending on magnitude.
export function parseBalance(text) {
  const raw = String(text ?? "").replace(/,/g, "").trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return null;

  const suffix = (match[2] || "").toLowerCase();
  const multiplier = suffix === "k" ? 1000 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : 1;
  return {
    value: Math.round(Number(match[1]) * multiplier),
    // Any suffix means the real value was rounded for display.
    approximate: Boolean(suffix),
  };
}

export function recordBalance(entry, reading, at = Date.now()) {
  if (!reading) return entry;
  return {
    ...entry,
    balance: reading.value,
    balanceApproximate: Boolean(reading.approximate),
    updatedAt: at,
  };
}

// `confirmed` means the chest was gone after the click, which is the only
// reliable evidence Twitch's DOM offers that the bonus was actually taken.
export function recordClaim(entry, { confirmed, reading, at = Date.now() } = {}) {
  const next = recordBalance(entry, reading, at);
  if (!confirmed) {
    return { ...next, unconfirmedClaims: (next.unconfirmedClaims || 0) + 1, updatedAt: at };
  }
  return {
    ...next,
    claims: (next.claims || 0) + 1,
    lastClaimAt: at,
    updatedAt: at,
  };
}

export function pointsSummary(points = {}) {
  const channels = Object.values(points);
  return {
    channels: channels.length,
    claims: channels.reduce((total, entry) => total + (entry.claims || 0), 0),
    lastClaimAt: channels.reduce((latest, entry) => Math.max(latest, entry.lastClaimAt || 0), 0),
  };
}

// The claim button must live inside the channel points widget. Clicking a
// stray "Claim" button elsewhere on Twitch could accept something the user
// never agreed to, so scope is enforced rather than assumed.
export function isWithinPointsWidget(button, container) {
  if (!button || !container) return false;
  return container.contains(button);
}
