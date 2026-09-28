import { MESSAGE, TWITCH, TWITCH_SCOPES } from "../shared/constants.js";
import { clearAuth, getAuth, getSettings, resolveClientId, saveAuth, saveMeta } from "../shared/storage.js";
import { now } from "../shared/utilities.js";

let refreshPromise = null;

function formBody(params) {
  return new URLSearchParams(params);
}

export async function startDeviceFlow() {
  const settings = await getSettings();
  const clientId = resolveClientId(settings);
  if (!clientId) {
    throw new Error("AutoLurk Companion needs a public Client ID before anyone can connect.");
  }

  const response = await fetch(`${TWITCH.ID}/oauth2/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: clientId,
      scopes: TWITCH_SCOPES.join(" "),
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || "Unable to start Twitch sign-in.");
  }

  const flow = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: now() + (data.expires_in || 1800) * 1000,
    interval: Math.max(5, data.interval || 5),
    startedAt: now(),
  };

  await saveMeta({ deviceFlow: flow });
  broadcast({ type: MESSAGE.DEVICE_FLOW, flow });
  return flow;
}

export async function pollDeviceToken(flow) {
  const settings = await getSettings();
  const response = await fetch(`${TWITCH.ID}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: resolveClientId(settings),
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      scopes: TWITCH_SCOPES.join(" "),
    }),
  });

  const data = await response.json();
  if (response.ok && data.access_token) {
    await saveTokens(data);
    await saveMeta({ deviceFlow: null });
    return { status: "authorized", auth: await getAuth() };
  }

  const message = String(data.message || "").toLowerCase();
  if (message.includes("authorization_pending")) {
    return { status: "pending" };
  }
  if (message.includes("slow_down")) {
    return { status: "slow_down" };
  }
  if (message.includes("expired") || message.includes("invalid device code")) {
    await saveMeta({ deviceFlow: null });
    return { status: "expired", error: "The sign-in code expired. Try connecting again." };
  }
  if (message.includes("access_denied")) {
    await saveMeta({ deviceFlow: null });
    return { status: "denied", error: "Twitch authorization was denied." };
  }

  return { status: "error", error: data.message || "Twitch sign-in failed." };
}

export async function cancelDeviceFlow() {
  await saveMeta({ deviceFlow: null });
}

async function saveTokens(data) {
  const expiresIn = Number(data.expires_in || 14400);
  const previous = await getAuth();
  const auth = await saveAuth({
    ...previous,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous.refreshToken,
    expiresAt: now() + expiresIn * 1000,
    scopes: data.scope || previous.scopes || TWITCH_SCOPES,
  });

  try {
    const user = await fetchCurrentUser(auth.accessToken);
    await saveAuth({ ...auth, ...user });
  } catch {
    // Token is stored even if the user lookup fails; the next poll will retry.
  }

  broadcast({ type: MESSAGE.AUTH_UPDATED });
}

export async function fetchCurrentUser(accessToken) {
  const settings = await getSettings();
  const response = await fetch(`${TWITCH.API}/users`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": resolveClientId(settings),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || "Unable to load Twitch user.");
  }
  const user = data.data?.[0];
  if (!user) throw new Error("Twitch did not return a user profile.");
  return {
    userId: user.id,
    login: user.login,
    displayName: user.display_name,
    profileImageUrl: user.profile_image_url,
  };
}

export async function validateToken(accessToken) {
  const response = await fetch(`${TWITCH.ID}/oauth2/validate`, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!response.ok) return null;
  return response.json();
}

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
    if (!auth.refreshToken) {
      throw new Error("Twitch session expired. Connect Twitch again.");
    }

    const response = await fetch(`${TWITCH.ID}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: resolveClientId(settings),
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
      await clearAuth();
      throw new Error("Twitch session expired. Connect Twitch again.");
    }

    await saveTokens(data);
    return getAuth();
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export async function getValidAccessToken() {
  const auth = await getAuth();
  if (!auth.accessToken) {
    throw new Error("Connect Twitch to continue.");
  }

  const remaining = auth.expiresAt - now();
  if (remaining < 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken();
    return refreshed.accessToken;
  }

  return auth.accessToken;
}

export async function disconnectTwitch() {
  const auth = await getAuth();
  const settings = await getSettings();
  if (auth.accessToken) {
    try {
      await fetch(`${TWITCH.ID}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({
          client_id: resolveClientId(settings),
          token: auth.accessToken,
        }),
      });
    } catch {
      // Revoke is best-effort; local session is cleared either way.
    }
  }

  await clearAuth();
  await saveMeta({ deviceFlow: null });
  broadcast({ type: MESSAGE.AUTH_UPDATED });
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
