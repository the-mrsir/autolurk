import { TWITCH } from "../shared/constants.js";
import { getSettings, resolveClientId } from "../shared/storage.js";
import { chunk, sleep } from "../shared/utilities.js";
import { getValidAccessToken, refreshAccessToken } from "./auth.js";

// Failures are classified so callers can tell "Twitch says nobody is live"
// apart from "we could not reach Twitch". Treating those the same is what
// closes healthy stream tabs during an outage.
export const API_FAILURE = {
  UNAUTHORIZED: "unauthorized",
  RATE_LIMITED: "rate_limited",
  NETWORK: "network",
  SERVER: "server",
  CLIENT: "client",
  MALFORMED: "malformed",
};

export class TwitchApiError extends Error {
  constructor(kind, message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "TwitchApiError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  // A retryable failure means the data is unknown, not empty.
  get isTransient() {
    return (
      this.kind === API_FAILURE.NETWORK ||
      this.kind === API_FAILURE.SERVER ||
      this.kind === API_FAILURE.RATE_LIMITED
    );
  }
}

const MAX_RETRIES = 2;

function retryAfterMs(response) {
  const header = response.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  }
  const reset = response.headers.get("Ratelimit-Reset");
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      return Math.max(1000, epochSeconds * 1000 - Date.now());
    }
  }
  return 15000;
}

async function helixFetch(path, params = {}, attempt = 0) {
  const [settings, token] = await Promise.all([getSettings(), getValidAccessToken()]);
  const url = new URL(`${TWITCH.API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
    else url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": resolveClientId(settings),
      },
    });
  } catch (error) {
    throw new TwitchApiError(API_FAILURE.NETWORK, "Could not reach Twitch.", {
      status: 0,
      retryAfterMs: 5000,
    });
  }

  if (response.status === 401) {
    if (attempt >= 1) {
      throw new TwitchApiError(API_FAILURE.UNAUTHORIZED, "Twitch sign-in expired.", {
        status: 401,
      });
    }
    await refreshAccessToken();
    return helixFetch(path, params, attempt + 1);
  }

  if (response.status === 429) {
    const wait = retryAfterMs(response);
    if (attempt < MAX_RETRIES) {
      await sleep(Math.min(wait, 20000));
      return helixFetch(path, params, attempt + 1);
    }
    throw new TwitchApiError(API_FAILURE.RATE_LIMITED, "Twitch is rate limiting AutoLurk.", {
      status: 429,
      retryAfterMs: wait,
    });
  }

  if (response.status >= 500) {
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * (attempt + 1));
      return helixFetch(path, params, attempt + 1);
    }
    throw new TwitchApiError(API_FAILURE.SERVER, "Twitch is having problems.", {
      status: response.status,
      retryAfterMs: 30000,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new TwitchApiError(API_FAILURE.MALFORMED, "Twitch sent an unreadable response.", {
      status: response.status,
    });
  }

  if (!response.ok) {
    throw new TwitchApiError(
      API_FAILURE.CLIENT,
      data?.message || `Twitch API error (${response.status})`,
      { status: response.status }
    );
  }

  if (!data || !Array.isArray(data.data)) {
    throw new TwitchApiError(API_FAILURE.MALFORMED, "Twitch sent an unexpected payload.", {
      status: response.status,
    });
  }

  return data;
}

// Pagination is all-or-nothing: a partial list would look like channels went
// offline, so a mid-walk failure rejects instead of returning what it has.
async function paginate(path, params, mapItem) {
  const items = [];
  let after = "";
  let pages = 0;
  do {
    const page = await helixFetch(path, { ...params, first: 100, after });
    items.push(...page.data.map(mapItem));
    after = page.pagination?.cursor || "";
    pages += 1;
  } while (after && pages < 200);
  return items;
}

export async function getFollowedChannels(userId) {
  return paginate("/channels/followed", { user_id: userId }, (row) => ({
    userId: row.broadcaster_id,
    login: row.broadcaster_login,
    displayName: row.broadcaster_name,
    followedAt: row.followed_at,
    profileImageUrl: "",
  }));
}

export async function getFollowedStreams(userId) {
  return paginate("/streams/followed", { user_id: userId }, mapStream);
}

export async function getUsersByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const users = {};
  for (const group of chunk(unique, 100)) {
    const page = await helixFetch("/users", { id: group });
    for (const user of page.data) {
      users[user.id] = {
        userId: user.id,
        login: user.login,
        displayName: user.display_name,
        profileImageUrl: user.profile_image_url,
      };
    }
  }
  return users;
}

export async function getUsersByLogin(logins) {
  const unique = [...new Set(logins.filter(Boolean))];
  const users = [];
  for (const group of chunk(unique, 100)) {
    const page = await helixFetch("/users", { login: group });
    for (const user of page.data) {
      users.push({
        userId: user.id,
        login: user.login,
        displayName: user.display_name,
        profileImageUrl: user.profile_image_url,
      });
    }
  }
  return users;
}

export async function getStreamsByUserIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const streams = {};
  for (const group of chunk(unique, 100)) {
    const page = await helixFetch("/streams", { user_id: group, first: 100 });
    for (const stream of page.data) {
      streams[stream.user_id] = mapStream(stream);
    }
  }
  return streams;
}

function mapStream(stream) {
  return {
    streamId: stream.id,
    userId: stream.user_id,
    login: stream.user_login,
    displayName: stream.user_name,
    gameId: stream.game_id,
    gameName: stream.game_name,
    title: stream.title,
    viewerCount: stream.viewer_count,
    startedAt: stream.started_at,
    thumbnailUrl: stream.thumbnail_url,
    language: stream.language,
    isLive: true,
  };
}
