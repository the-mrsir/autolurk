import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { assert, describe, it } from "./harness.js";

const root = new URL("../", import.meta.url);

function storage(initial = {}) {
  class Storage {}
  const values = new Map(Object.entries(initial));
  Storage.prototype.getItem = (key) => values.get(key) ?? null;
  Storage.prototype.setItem = (key, value) => values.set(String(key), String(value));
  const localStorage = new Storage();
  return { Storage, localStorage, values };
}

describe("player behavior inside a Twitch page", () => {
  it("treats a playing preroll as playback instead of the paused stream behind it", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const { Storage, localStorage } = storage();
    let selected1080 = false;

    const video = (props) => ({
      clientWidth: props.videoWidth,
      clientHeight: props.videoHeight,
      volume: 0.5,
      muted: false,
      src: "",
      className: "",
      hasAttribute: () => false,
      setAttribute: () => {},
      getBoundingClientRect: () => ({
        width: props.videoWidth,
        height: props.videoHeight,
      }),
      closest: () => null,
      play: async () => {},
      ...props,
    });
    const stream = video({
      paused: true,
      currentTime: 1,
      readyState: 4,
      networkState: 2,
      videoWidth: 284,
      videoHeight: 160,
      currentSrc: "",
    });
    const ad = video({
      paused: false,
      currentTime: 8,
      readyState: 4,
      networkState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      currentSrc: "https://gcdn.2mdn.net/videoplayback/ad",
    });
    const container = { querySelectorAll: () => [stream, ad] };

    const context = {
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {},
        visibilityState: "hidden",
        querySelectorAll: (selector) => {
          if (selector === '[data-a-player-type="site"]') return [container];
          if (selector.includes("player-settings-submenu-quality-option")) {
            return [
              {
                textContent: "1080p60 (Source)",
                querySelector: () => ({ click: () => (selected1080 = true) }),
              },
            ];
          }
          return [];
        },
        querySelector: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: false }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = {
      extractChannel: () => "streamer",
      send: () => {},
    };

    vm.runInNewContext(source, context);
    let report = null;
    listeners[0]({ type: "PROBE_PLAYER" }, {}, (value) => {
      report = value;
    });

    assert.equal(report.playing, true, "the playing ad was mistaken for a dead stream");
    assert.equal(report.currentTime, 8);
    assert.equal(report.adPlaying, true);
    assert.equal(report.videoWidth, 1920);

    context.document.visibilityState = "visible";
    listeners[0]({ type: "PIN_VIEWING_QUALITY" }, {}, () => {});
    assert.ok(selected1080, "opening a managed stream did not select 1080p");
    assert.equal(
      localStorage.getItem("video-quality"),
      JSON.stringify({ default: "auto" }),
      "an opened managed stream did not leave lurk quality"
    );
    context.document.visibilityState = "hidden";
    listeners[0]({ type: "PIN_LOW_QUALITY" }, {}, () => {});
    assert.equal(
      localStorage.getItem("video-quality"),
      JSON.stringify({ default: "160p30" }),
      "a background managed stream did not return to 160p"
    );

    listeners[0]({ type: "PIN_HIGH_QUALITY" }, {}, () => {});
    assert.equal(
      localStorage.getItem("video-quality"),
      JSON.stringify({ default: "auto" }),
      "an unmuted background stream kept the 160p preference"
    );
  });

  it("does not pin 160p on a tab the user is looking at", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const { Storage, localStorage } = storage({
      "video-quality": JSON.stringify({ default: "auto" }),
    });
    let selected160 = false;
    const context = {
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {},
        visibilityState: "visible",
        querySelectorAll: (selector) => {
          if (selector.includes("player-settings-submenu-quality-option")) {
            return [
              {
                textContent: "160p",
                querySelector: () => ({ click: () => (selected160 = true) }),
              },
            ];
          }
          return [];
        },
        querySelector: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: false }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    listeners[0]({ type: "PIN_LOW_QUALITY" }, {}, () => {});

    assert.equal(selected160, false, "the quality menu was driven to 160p while visible");
    assert.equal(
      localStorage.getItem("video-quality"),
      JSON.stringify({ default: "auto" }),
      "a visible tab had its quality preference overwritten"
    );
  });

  it("closes the settings menu after changing quality", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const { Storage, localStorage } = storage();
    let selected1080 = false;
    let settingsClicks = 0;
    let expanded = true;
    const settingsBtn = {
      getAttribute: (name) => (name === "aria-expanded" ? String(expanded) : ""),
      click: () => {
        settingsClicks += 1;
        expanded = !expanded;
      },
    };
    const stream = {
      paused: false,
      currentTime: 8,
      readyState: 4,
      networkState: 2,
      videoWidth: 284,
      videoHeight: 160,
      volume: 0.5,
      muted: true,
      src: "",
      currentSrc: "",
      className: "",
      clientWidth: 284,
      clientHeight: 160,
      hasAttribute: () => false,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ width: 284, height: 160 }),
      closest: () => null,
      play: async () => {},
    };
    const container = { querySelectorAll: () => [stream] };
    const context = {
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {},
        visibilityState: "visible",
        querySelectorAll: (selector) => {
          if (selector === '[data-a-player-type="site"]') return [container];
          if (selector.includes("player-settings-submenu-quality-option")) {
            return [
              {
                textContent: "1080p60 (Source)",
                querySelector: () => ({ click: () => (selected1080 = true) }),
              },
            ];
          }
          return [];
        },
        querySelector: (selector) => {
          if (selector.includes("player-settings-button")) return settingsBtn;
          if (selector.includes("player-settings-menu")) return expanded ? {} : null;
          return null;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: true }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    listeners[0]({ type: "PIN_VIEWING_QUALITY" }, {}, () => {});

    assert.ok(selected1080, "1080p was not selected");
    assert.ok(settingsClicks > 0, "the settings gear was never toggled closed");
    assert.equal(expanded, false, "the settings menu was left open");
  });

  it("does not reopen the settings menu when the picture is already right", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const { Storage, localStorage } = storage();
    let settingsClicks = 0;
    let selected1080 = false;
    const stream = {
      paused: false,
      currentTime: 20,
      readyState: 4,
      networkState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      volume: 0.5,
      muted: false,
      src: "",
      currentSrc: "",
      className: "",
      clientWidth: 1920,
      clientHeight: 1080,
      hasAttribute: () => true,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
      closest: () => null,
      play: async () => {},
    };
    const container = { querySelectorAll: () => [stream] };
    const context = {
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {},
        visibilityState: "visible",
        querySelectorAll: (selector) => {
          if (selector === '[data-a-player-type="site"]') return [container];
          if (selector.includes("player-settings-submenu-quality-option")) {
            return [
              {
                textContent: "1080p60 (Source)",
                querySelector: () => ({ click: () => (selected1080 = true) }),
              },
            ];
          }
          return [];
        },
        querySelector: (selector) => {
          if (selector.includes("player-settings-button")) {
            return { getAttribute: () => "false", click: () => (settingsClicks += 1) };
          }
          return null;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: true }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    listeners[0]({ type: "PIN_VIEWING_QUALITY" }, {}, () => {});

    assert.equal(selected1080, false, "the quality menu was driven again on a 1080p stream");
    assert.equal(settingsClicks, 0, "tabbing back to a watchable stream reopened settings");
  });

  it("does not remute a visible player after a quality-change pause", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const docListeners = new Map();
    const { Storage, localStorage } = storage();
    const stream = {
      paused: false,
      currentTime: 12,
      readyState: 4,
      networkState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      volume: 0.5,
      muted: false,
      src: "",
      currentSrc: "",
      className: "",
      clientWidth: 1920,
      clientHeight: 1080,
      hasAttribute: () => true,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
      closest: () => null,
      play: async () => {},
    };
    const container = { querySelectorAll: () => [stream] };
    const context = {
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {},
        visibilityState: "visible",
        querySelectorAll: (selector) =>
          selector === '[data-a-player-type="site"]' ? [container] : [],
        querySelector: () => null,
        addEventListener: (type, fn) => {
          const list = docListeners.get(type) || [];
          list.push(fn);
          docListeners.set(type, list);
        },
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: true }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    listeners[0]({ type: "PIN_VIEWING_QUALITY" }, {}, () => {});
    for (const fn of docListeners.get("pause") || []) fn({ target: stream });

    assert.equal(stream.muted, false, "a visible player was remuted after a pause");
  });

  it("does not steal a click on Twitch's mute button", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const docListeners = new Map();
    const { Storage, localStorage } = storage();
    const stream = {
      paused: false,
      currentTime: 4,
      readyState: 0,
      networkState: 0,
      videoWidth: 284,
      videoHeight: 160,
      volume: 0.5,
      muted: true,
      src: "",
      currentSrc: "",
      className: "",
      clientWidth: 284,
      clientHeight: 160,
      hasAttribute: () => false,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ width: 284, height: 160 }),
      closest: () => null,
      play: async () => {
        if (stream.muted) return;
        throw Object.assign(new Error("autoplay"), { name: "NotAllowedError" });
      },
    };
    let buttonClicks = 0;
    const muteBtn = {
      getAttribute: () => "Unmute",
      click: () => {
        buttonClicks += 1;
        stream.muted = !stream.muted;
      },
      closest: (selector) => (selector.includes("player-mute-unmute") ? muteBtn : null),
    };
    const container = { querySelectorAll: () => [stream] };
    const context = {
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {},
        visibilityState: "visible",
        querySelectorAll: (selector) =>
          selector === '[data-a-player-type="site"]' ? [container] : [],
        querySelector: (selector) =>
          selector.includes("player-mute-unmute-button") ? muteBtn : null,
        addEventListener: (type, fn) => {
          const list = docListeners.get(type) || [];
          list.push(fn);
          docListeners.set(type, list);
        },
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: true }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    await Promise.resolve();
    await Promise.resolve();
    // becomeManaged + NotAllowedError attaches the unmute watch. A click on
    // Unmute must be left to Twitch — a second synthetic click would mute it.
    const before = buttonClicks;
    for (const fn of docListeners.get("pointerdown") || []) fn({ target: muteBtn });
    assert.equal(buttonClicks, before, "the unmute watch also clicked the mute button");
    muteBtn.click();
    assert.equal(buttonClicks, before + 1, "the user's click did not reach the mute button");
  });

  it("does not click the player when the notification bell is pressed", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const docListeners = new Map();
    const { Storage, localStorage } = storage();
    let buttonClicks = 0;
    let playCalls = 0;
    const stream = {
      paused: true,
      currentTime: 4,
      readyState: 2,
      networkState: 1,
      videoWidth: 1920,
      videoHeight: 1080,
      volume: 0,
      muted: true,
      src: "",
      currentSrc: "",
      className: "",
      clientWidth: 1280,
      clientHeight: 720,
      hasAttribute: () => false,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
      closest: () => null,
      play: async () => {
        playCalls += 1;
        if (playCalls === 1) throw Object.assign(new Error("autoplay"), { name: "NotAllowedError" });
        stream.paused = false;
      },
    };
    const muteBtn = {
      getAttribute: () => "Unmute",
      click: () => {
        buttonClicks += 1;
        stream.muted = !stream.muted;
      },
      closest: (selector) => (selector.includes("player-mute-unmute") ? muteBtn : null),
    };
    const bell = { closest: () => null };
    const container = { querySelectorAll: () => [stream] };
    const context = {
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {},
        visibilityState: "visible",
        querySelectorAll: (selector) =>
          selector === '[data-a-player-type="site"]' ? [container] : [],
        querySelector: (selector) =>
          selector.includes("player-mute-unmute-button") ? muteBtn : null,
        addEventListener: (type, fn) => {
          const list = docListeners.get(type) || [];
          list.push(fn);
          docListeners.set(type, list);
        },
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: true }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    await Promise.resolve();
    await Promise.resolve();
    const afterOpen = buttonClicks;
    assert.ok(afterOpen > 0, "opening a visible stream never asked the player to unmute");
    assert.equal(stream.muted, false, "the player was left muted after open");
    listeners[0]({ type: "PIN_VIEWING_QUALITY" }, {}, () => {});
    for (const fn of docListeners.get("pointerdown") || []) fn({ target: bell });
    assert.equal(buttonClicks, afterOpen, "the notification bell also clicked the player mute control");
    assert.equal(stream.muted, false, "a second unmute pass muted the player");
    assert.equal(
      localStorage.getItem("video-muted"),
      JSON.stringify({ default: false }),
      "Twitch was left with a muted player preference"
    );
  });

  it("does not click a recommended Play control when recovering the site player", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const { Storage, localStorage } = storage();
    let recommendedClicks = 0;
    const recommendedPlay = {
      click: () => {
        recommendedClicks += 1;
      },
    };
    const stream = {
      paused: true,
      currentTime: 12,
      readyState: 4,
      networkState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      volume: 0.5,
      muted: false,
      src: "",
      currentSrc: "",
      className: "",
      clientWidth: 1920,
      clientHeight: 1080,
      hasAttribute: () => true,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
      closest: (selector) => (String(selector).includes("video-player") ? container : null),
      play: async () => {
        stream.paused = false;
      },
    };
    const container = {
      querySelectorAll: (selector) => (selector === "video" ? [stream] : []),
      querySelector: () => null,
    };
    const context = {
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {},
        visibilityState: "visible",
        querySelectorAll: (selector) =>
          selector === '[data-a-player-type="site"]' ? [container] : [],
        querySelector: (selector) => {
          if (selector === '[data-a-player-type="site"]') return container;
          if (selector.includes("player-play-pause-button")) return recommendedPlay;
          return null;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: true }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    listeners[0]({ type: "RECOVER_PLAYER" }, {}, () => {});
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(recommendedClicks, 0, "recovery clicked a Play button outside the site player");
    assert.equal(stream.paused, false, "the site player was not asked to play");
  });

  it("drives a hidden player back to 160p when a probe finds it decoding high", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const { Storage, localStorage } = storage({
      "video-quality": JSON.stringify({ default: "160p30" }),
    });
    let selected160 = false;
    const stream = {
      paused: false,
      currentTime: 40,
      readyState: 4,
      networkState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      volume: 0.5,
      muted: false,
      src: "",
      currentSrc: "",
      className: "",
      clientWidth: 1920,
      clientHeight: 1080,
      hasAttribute: () => false,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
      closest: () => null,
      play: async () => {},
    };
    const preview = {
      ...stream,
      videoWidth: 320,
      videoHeight: 180,
      paused: true,
      currentTime: 0,
      readyState: 1,
      src: "https://example.com/preview.mp4",
      currentSrc: "https://example.com/preview.mp4",
      pause() {
        this.paused = true;
      },
      removeAttribute(name) {
        if (name === "src") this.src = "";
      },
      load() {
        this.readyState = 0;
      },
    };
    preview.srcObject = {};
    const container = { querySelectorAll: () => [stream] };
    const attrs = new Map();
    const context = {
      Date,
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: {
          setAttribute: (name, value) => attrs.set(name, value),
          removeAttribute: (name) => attrs.delete(name),
        },
        visibilityState: "hidden",
        querySelectorAll: (selector) => {
          if (selector === "video") return [stream, preview];
          if (selector === '[data-a-player-type="site"]') return [container];
          if (selector.includes("player-settings-submenu-quality-option")) {
            return [
              {
                textContent: "160p",
                querySelector: () => ({ click: () => (selected160 = true) }),
              },
            ];
          }
          return [];
        },
        querySelector: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: true }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    listeners[0]({ type: "PROBE_PLAYER" }, {}, () => {});

    assert.ok(selected160, "a 1080p hidden lurk was left decoding high");
    assert.equal(preview.src, "https://example.com/preview.mp4", "a probe destroyed a video element");
  });

  it("does not tear down the site player when a sidebar preview is playing", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    const listeners = [];
    const { Storage, localStorage } = storage({
      "video-quality": JSON.stringify({ default: "160p30" }),
    });
    const stream = {
      paused: true,
      currentTime: 12,
      readyState: 4,
      networkState: 2,
      videoWidth: 284,
      videoHeight: 160,
      volume: 0.5,
      muted: false,
      src: "https://example.com/stream.mp4",
      currentSrc: "https://example.com/stream.mp4",
      className: "",
      clientWidth: 284,
      clientHeight: 160,
      hasAttribute: () => false,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ width: 284, height: 160 }),
      closest: (selector) => (String(selector).includes("player") ? container : null),
      play: async () => {},
      pause() {
        this.paused = true;
      },
      removeAttribute(name) {
        if (name === "src") this.src = "";
      },
      load() {},
    };
    const preview = {
      ...stream,
      paused: false,
      currentTime: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      clientWidth: 1920,
      clientHeight: 1080,
      src: "https://example.com/preview.mp4",
      currentSrc: "https://example.com/preview.mp4",
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
      closest: () => null,
    };
    preview.srcObject = {};
    const container = {
      querySelectorAll: (selector) => (selector === "video" ? [stream] : []),
      contains: (node) => node === stream,
    };
    const recommended = { querySelectorAll: (selector) => (selector === "video" ? [preview] : []) };
    const context = {
      Date,
      Storage,
      localStorage,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { pathname: "/streamer", hash: "#autolurk" },
      document: {
        documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
        visibilityState: "hidden",
        querySelectorAll: (selector) => {
          if (selector === "video") return [stream, preview];
          if (selector === '[data-a-player-type="site"]') return [container];
          if (selector === '[data-a-target="video-player"]') return [recommended];
          return [];
        },
        querySelector: (selector) => {
          if (selector === '[data-a-player-type="site"]') return container;
          if (selector === '[data-a-target="video-player"]') return recommended;
          return null;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      window: { dispatchEvent: () => {} },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          sendMessage: (_message, callback) => callback?.({ result: true }),
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = { extractChannel: () => "streamer", send: () => {} };

    vm.runInNewContext(source, context);
    listeners[0]({ type: "PROBE_PLAYER" }, {}, () => {});

    assert.equal(stream.src, "https://example.com/stream.mp4", "the site player was unloaded");
    assert.equal(preview.src, "https://example.com/preview.mp4", "a preview video was destroyed");
  });

  it("does not mask visibility, pause, or intersection", async () => {
    const source = await readFile(new URL("content/twitch-keepalive.js", root), "utf8");
    const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(body.includes("defineProperty"), false, "keepalive still patches a page API");
    assert.equal(body.includes("IntersectionObserver"), false, "keepalive still forges intersection");
    assert.equal(body.includes(".pause"), false, "keepalive still intercepts pause");
    assert.equal(body.includes("stopImmediatePropagation"), false, "keepalive still swallows Twitch events");
    assert.equal(body.includes("querySelector"), false, "keepalive still clicks into the page");
  });

  it("does not delete chat nodes Twitch owns", async () => {
    const source = await readFile(new URL("content/twitch-player.js", root), "utf8");
    assert.equal(source.includes("chat-scroller"), false, "the player script still targets chat");
    assert.equal(source.includes("removeChild"), false, "the player script still deletes DOM nodes");
  });

  it("prevents Twitch from overwriting 160p while a tab lurks", async () => {
    const source = await readFile(new URL("content/twitch-quality.js", root), "utf8");
    const handlers = new Map();
    const { Storage, localStorage } = storage({
      "video-quality": JSON.stringify({ default: "chunked" }),
    });
    const document = {
      visibilityState: "hidden",
      addEventListener: (type, listener) => handlers.set(type, listener),
    };
    const context = {
      Storage,
      localStorage,
      location: { hash: "#autolurk" },
      document,
      window: {
        addEventListener: (type, listener) => handlers.set(type, listener),
      },
    };

    vm.runInNewContext(source, context);
    localStorage.setItem("video-quality", JSON.stringify({ default: "chunked" }));
    assert.equal(localStorage.getItem("video-quality"), JSON.stringify({ default: "160p30" }));

    document.visibilityState = "visible";
    handlers.get("autolurk-quality-mode")({ detail: "view" });
    assert.equal(
      localStorage.getItem("video-quality"),
      JSON.stringify({ default: "chunked" }),
      "opening the tab should restore the user's prior quality"
    );
    localStorage.setItem("video-quality", JSON.stringify({ default: "720p60" }));
    assert.equal(localStorage.getItem("video-quality"), JSON.stringify({ default: "720p60" }));

    localStorage.setItem("video-quality", JSON.stringify({ default: "1080p60" }));
    assert.equal(
      localStorage.getItem("video-quality"),
      JSON.stringify({ default: "1080p60" }),
      "a manual quality change on a visible tab was forced back to 160p"
    );

    document.visibilityState = "hidden";
    handlers.get("autolurk-quality-mode")({ detail: "low" });
    assert.equal(localStorage.getItem("video-quality"), JSON.stringify({ default: "160p30" }));
    handlers.get("autolurk-quality-mode")({ detail: "high" });
    localStorage.setItem("video-quality", JSON.stringify({ default: "1080p60" }));
    assert.equal(
      localStorage.getItem("video-quality"),
      JSON.stringify({ default: "1080p60" }),
      "an explicitly unmuted hidden tab was forced back to 160p"
    );

    handlers.get("autolurk-quality-mode")({ detail: "low" });
    assert.equal(localStorage.getItem("video-quality"), JSON.stringify({ default: "160p30" }));
  });
});

describe("channel point behavior inside a Twitch page", () => {
  it("waits for the rendered chest to disappear before confirming a claim", async () => {
    const source = await readFile(new URL("content/twitch-points.js", root), "utf8");
    const sent = [];
    const observers = [];
    let interval = null;
    let claimButton = null;

    const widget = {
      isConnected: true,
      contains: (node) => node === claimButton,
      querySelector: (selector) => {
        if (selector.includes("balance-string")) return { textContent: "1,200" };
        if (selector.includes("success")) return claimButton;
        return null;
      },
      querySelectorAll: (selector) => (selector === "button" && claimButton ? [claimButton] : []),
    };
    claimButton = {
      isConnected: true,
      hidden: false,
      disabled: false,
      getAttribute: () => null,
      getClientRects: () => [{}],
      click: () => {},
    };

    class MutationObserver {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    }

    const context = {
      Date,
      MutationObserver,
      queueMicrotask,
      setInterval: (callback) => {
        interval = callback;
      },
      location: { pathname: "/streamer" },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      document: {
        documentElement: {},
        querySelector: (selector) =>
          selector.includes("community-points-summary") ? widget : null,
        addEventListener: () => {},
      },
      chrome: {
        runtime: {
          lastError: null,
          onMessage: { addListener: () => {} },
          sendMessage: (message, callback) => {
            if (message.type === "PAGE_CONFIG") callback?.({ result: { claim: true } });
            else {
              sent.push({ type: message.type, payload: message });
              callback?.({ ok: true });
            }
          },
        },
      },
      globalThis: null,
    };
    context.globalThis = context;
    context.__autoLurk = {
      extractChannel: () => "streamer",
      send: (type, payload) => sent.push({ type, payload }),
    };

    vm.runInNewContext(source, context);
    await Promise.resolve();
    await Promise.resolve();

    // The next scan can happen immediately in a foreground test or a minute
    // later in a throttled tab. Either way, a still-rendered chest is pending,
    // not proof the click failed.
    interval();
    assert.equal(
      sent.filter((item) => item.type === "POINTS_CLAIMED").length,
      0,
      "the first post-click scan falsely rejected the claim"
    );

    claimButton = null;
    // The second observer is the widget observer (the first discovers it).
    observers[0].callback();
    await Promise.resolve();
    await Promise.resolve();

    const claims = sent.filter((item) => item.type === "POINTS_CLAIMED");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].payload.confirmed, true);
  });
});
