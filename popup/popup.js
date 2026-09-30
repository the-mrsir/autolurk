import { MESSAGE } from "../shared/constants.js";
import { escapeHtml, formatUserCode } from "../shared/utilities.js";

const els = {
  statusLine: document.getElementById("statusLine"),
  runState: document.getElementById("runState"),
  pauseBtn: document.getElementById("pauseBtn"),
  setupCard: document.getElementById("setupCard"),
  authCard: document.getElementById("authCard"),
  userCode: document.getElementById("userCode"),
  summary: document.getElementById("summary"),
  liveList: document.getElementById("liveList"),
  emptyLive: document.getElementById("emptyLive"),
  dashboardBtn: document.getElementById("dashboardBtn"),
  updateBtn: document.getElementById("updateBtn"),
  openDashboardBtn: document.getElementById("openDashboardBtn"),
  cancelAuthBtn: document.getElementById("cancelAuthBtn"),
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Request failed");
    return response.result;
  });
}

function openDashboard() {
  return send(MESSAGE.OPEN_DASHBOARD).then(() => window.close());
}

function render(state) {
  if (!state) return;
  const connected = Boolean(state.connected);
  const flow = state.deviceFlow;
  const paused = !state.settings?.automationEnabled;
  const live = state.liveFavorites || [];

  els.setupCard.classList.toggle("hidden", connected || flow);
  els.authCard.classList.toggle("hidden", !flow);
  els.userCode.textContent = flow ? formatUserCode(flow.userCode) : "";

  const poll = state.poll || {};
  if (flow) els.statusLine.textContent = "Waiting for Twitch";
  else if (!connected) els.statusLine.textContent = "Not connected";
  else if (poll.status === "unauthorized") els.statusLine.textContent = "Twitch sign-in expired";
  else if (poll.status && poll.status !== "ok") els.statusLine.textContent = "Twitch unreachable";
  else els.statusLine.textContent = state.user?.displayName || state.user?.login || "";
  els.statusLine.classList.toggle(
    "warn",
    connected && !flow && Boolean(poll.status) && poll.status !== "ok"
  );

  els.runState.textContent = !connected ? "—" : paused ? "Paused" : "Running";
  els.runState.classList.toggle("on", connected && !paused);
  els.pauseBtn.textContent = paused ? "Resume" : "Pause";
  els.pauseBtn.disabled = !connected;

  const available = state.update?.packageUrl ? state.update.availableVersion : "";
  els.updateBtn.classList.toggle("hidden", !available);
  els.updateBtn.textContent = available ? `${available} on GitHub` : "Update";

  els.summary.textContent = connected
    ? `${live.length} favorites live · ${state.managedCount || 0} managed`
    : "";

  els.emptyLive.classList.toggle("hidden", !connected || live.length > 0);
  els.liveList.innerHTML = live
    .slice(0, 8)
    .map((item) => {
      // Say what was observed, not what was hoped for. "Media playing" is the
      // strongest honest claim; nothing here proves Twitch counted the view.
      const stateText = item.playback
        ? `${item.playback.label}${item.managed?.muted ? " · Tab muted" : ""}`
        : "Not opened";
      return `
        <article class="item" data-open="${item.userId}">
          <span class="dot"></span>
          <div>
            <div class="name">${escapeHtml(item.displayName || item.login)}</div>
            <div class="meta">${escapeHtml(item.stream?.gameName || "")}</div>
            <div class="meta">${escapeHtml(stateText)}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

let devicePoll = null;
function watchDeviceFlow(flow) {
  if (!flow) {
    if (devicePoll) {
      clearInterval(devicePoll);
      devicePoll = null;
    }
    return;
  }
  if (devicePoll) return;
  devicePoll = setInterval(async () => {
    try {
      await send(MESSAGE.POLL_DEVICE);
    } catch {
      // keep waiting
    }
    await refresh();
  }, 3000);
}

async function refresh() {
  try {
    const next = await send(MESSAGE.GET_STATE);
    render(next);
    watchDeviceFlow(next?.deviceFlow);
  } catch (error) {
    els.statusLine.textContent = error.message;
  }
}

els.pauseBtn.addEventListener("click", async () => {
  await send(MESSAGE.TOGGLE_AUTOMATION);
  await refresh();
});
els.updateBtn.addEventListener("click", () => send(MESSAGE.OPEN_DASHBOARD, { hash: "updates" }).then(() => window.close()));
els.dashboardBtn.addEventListener("click", openDashboard);
els.openDashboardBtn.addEventListener("click", openDashboard);
els.cancelAuthBtn.addEventListener("click", async () => {
  await send(MESSAGE.CANCEL_CONNECT);
  await refresh();
});
els.liveList.addEventListener("click", async (event) => {
  const item = event.target.closest("[data-open]");
  if (!item) return;
  await send(MESSAGE.FOCUS_OR_OPEN, { userId: item.dataset.open });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.snapshot) {
    render(changes.snapshot.newValue);
    watchDeviceFlow(changes.snapshot.newValue?.deviceFlow);
  }
});

refresh();
