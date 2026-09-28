import { formatViewers } from "../shared/utilities.js";

export const NOTIFICATION_BUTTONS = {
  OPEN: 0,
  DISMISS: 1,
};

const STREAM_BUTTONS = [{ title: "Open stream" }, { title: "Dismiss" }];

export async function notifyLive(channel, stream) {
  const viewers = formatViewers(stream.viewerCount);
  await createNotification(`live:${channel.userId}:${stream.streamId}`, {
    title: `${channel.displayName} is live`,
    message: [stream.gameName, stream.title, viewers ? `${viewers} viewers` : ""]
      .filter(Boolean)
      .join("\n"),
    iconUrl: channel.profileImageUrl || defaultIcon(),
    buttons: STREAM_BUTTONS,
    eventTime: Date.now(),
  });
}

export async function notifyGameChange(channel, stream, previousGame) {
  await createNotification(`game:${channel.userId}:${stream.streamId}:${stream.gameId}`, {
    title: `${channel.displayName} — ${stream.gameName || "category change"}`,
    message: [previousGame && `Was ${previousGame}`, stream.title].filter(Boolean).join("\n") || stream.gameName,
    iconUrl: channel.profileImageUrl || defaultIcon(),
    buttons: STREAM_BUTTONS,
  });
}

export async function notifyTitleChange(channel, stream) {
  await createNotification(`title:${channel.userId}:${stream.streamId}:${hashText(stream.title)}`, {
    title: `${channel.displayName} — title updated`,
    message: [stream.gameName, stream.title].filter(Boolean).join("\n"),
    iconUrl: channel.profileImageUrl || defaultIcon(),
    buttons: STREAM_BUTTONS,
  });
}

function defaultIcon() {
  return chrome.runtime.getURL("icons/icon128.png");
}

async function createNotification(id, options) {
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: options.iconUrl,
      title: options.title,
      message: options.message,
      contextMessage: "AutoLurk",
      priority: 1,
      buttons: options.buttons,
    });
  } catch (error) {
    // Remote avatars can fail to load; fall back to the extension icon.
    if (options.iconUrl !== defaultIcon()) {
      await createNotification(id, { ...options, iconUrl: defaultIcon() });
      return;
    }
    console.warn("Notification failed", error);
  }
}

function hashText(value) {
  return String(value || "")
    .split("")
    .reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1_000_000, 0)
    .toString(36);
}
