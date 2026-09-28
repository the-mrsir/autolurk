// The multistream grid: several Twitch players side by side in one tab.
//
// This page is a real www.twitch.tv document whose own load is stopped before
// its app boots, and whose body is replaced with a grid of embedded players.
// It has to be a Twitch page rather than an extension page because Twitch's
// player refuses to be framed anywhere else - see background/multistream.js.
//
// Runs before the other content scripts and tells them to stand down, because
// none of what they do - channel detection, playback recovery, points - means
// anything on a document that is no longer Twitch's.
(() => {
  // Must stay identical to MULTISTREAM.GRID_MARKER in shared/constants.js.
  // A content script cannot import it, so tests/static.test.js compares them.
  const GRID_MARKER = "autolurk-grid";

  globalThis.__autoLurk.gridPage = location.search.includes(GRID_MARKER);
  if (!globalThis.__autoLurk.gridPage) return;

  // Everything below rebuilds the document, so Twitch's own bundle must never
  // run. Stopping the load at document_start is what prevents it, and it is
  // also why the tiles cannot start immediately: see startTiles.
  window.stop();

  const STYLE = `
    html, body { margin: 0; height: 100%; background: #0b0b0f; overflow: hidden; }
    body { display: grid; gap: 2px; font: 13px/1.4 Inter, system-ui, sans-serif; color: #efeff1; }
    body.count-2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
    body.count-3 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
    body.count-3 .tile:last-child { grid-column: span 2; }
    body.count-4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
    .tile { position: relative; background: #000; overflow: hidden; }
    .tile iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    .waiting {
      position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; color: #adadb8;
    }
    /* Above the picker, so the name stays readable and clickable on every
       tile whether or not the player underneath is reachable. */
    .bar {
      position: absolute; left: 0; right: 0; top: 0; z-index: 2; display: flex;
      align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer;
      background: linear-gradient(#000000cc, #00000000); border: 0;
      color: inherit; font: inherit; text-align: left;
    }
    .name { font-weight: 600; }
    .state { color: #adadb8; }
    .tile.audible .bar { background: linear-gradient(#772ce8cc, #00000000); }
    .tile.audible .state { color: #efeff1; }
    /* Only on the muted tiles. The audible one is left fully interactive so
       its own player controls still work. */
    .pick { position: absolute; inset: 0; z-index: 1; background: transparent; border: 0; cursor: pointer; }
    .tile.audible .pick { display: none; }
    .notice { position: absolute; inset: 0; display: grid; place-items: center; color: #adadb8; }
  `;

  function request(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          void chrome.runtime.lastError;
          resolve(response?.ok ? response.result : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function paintShell() {
    let root = document.documentElement;
    if (!root) {
      root = document.createElement("html");
      document.appendChild(root);
    }
    root.innerHTML = "<head><title>AutoLurk multistream</title></head><body></body>";
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function showNotice(text) {
    document.body.innerHTML = `<p class="notice">${text}</p>`;
  }

  let tiles = [];
  let audibleLogin = "";

  function markAudible() {
    for (const tile of tiles) {
      const on = tile.login === audibleLogin;
      tile.element.classList.toggle("audible", on);
      tile.state.textContent = on ? "audible" : "muted";
    }
  }

  function buildTile(tile, quality) {
    const element = document.createElement("div");
    element.className = "tile";

    const waiting = document.createElement("p");
    waiting.className = "waiting";
    waiting.textContent = "Starting…";
    element.appendChild(waiting);

    const pick = document.createElement("button");
    pick.className = "pick";
    pick.type = "button";
    pick.title = `Listen to ${tile.displayName}`;
    element.appendChild(pick);

    const bar = document.createElement("button");
    bar.className = "bar";
    bar.type = "button";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = tile.displayName;
    const state = document.createElement("span");
    state.className = "state";
    bar.append(name, state);
    element.appendChild(bar);

    const listen = async () => {
      if (tile.login === audibleLogin) return;
      // Moved through the background rather than straight into the frame, so
      // the dashboard and the session agree on which tile has the sound.
      const result = await request("SET_MULTISTREAM_AUDIO", { userId: tile.userId });
      if (!result) return;
      audibleLogin = tile.login;
      markAudible();
    };
    pick.addEventListener("click", listen);
    bar.addEventListener("click", listen);

    document.body.appendChild(element);

    return {
      ...tile,
      element,
      state,
      start() {
        const frame = document.createElement("iframe");
        // parent is the only host Twitch accepts here, and the quality rides
        // along so the player frame can set it before its bundle reads it.
        frame.src =
          `https://player.twitch.tv/?channel=${encodeURIComponent(tile.login)}` +
          `&parent=www.twitch.tv&autoplay=true&muted=true&autolurk=${encodeURIComponent(quality)}`;
        frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
        frame.addEventListener("load", () => waiting.remove(), { once: true });
        element.insertBefore(frame, pick);
      },
    };
  }

  // Measured against the live site: four players started the moment the host
  // document is stopped never recover - all four sit buffering and fall a
  // third behind real time. Letting the document settle first and then
  // starting them one at a time keeps every tile at full speed.
  function startTiles(startDelayMs, staggerMs) {
    tiles.forEach((tile, index) => {
      setTimeout(() => tile.start(), startDelayMs + index * staggerMs);
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "MULTISTREAM_AUDIO") return false;
    audibleLogin = message.login || "";
    markAudible();
    return false;
  });

  async function build() {
    paintShell();
    const grid = await request("MULTISTREAM_TILES");

    // No session behind this URL - a restored tab, or a grid whose session
    // ended while the browser was closed. Hand the tab back to Twitch.
    if (!grid?.tiles?.length) {
      location.replace("https://www.twitch.tv/");
      return;
    }

    document.body.className = `count-${grid.tiles.length}`;
    audibleLogin = grid.audibleLogin || grid.tiles[0].login;
    tiles = grid.tiles.map((tile) => buildTile(tile, grid.quality));
    markAudible();
    startTiles(grid.startDelayMs, grid.staggerMs);
  }

  build().catch(() => showNotice("AutoLurk could not open the multistream."));
})();
