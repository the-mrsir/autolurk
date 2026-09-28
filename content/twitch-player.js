// Keeps the Twitch player running in a managed tab.
//
// The hard constraint that shapes this entire file: Chrome throttles
// setTimeout in a hidden tab to once a second, and to once a MINUTE after five
// minutes hidden. A tab AutoLurk opens in the background is hidden from birth,
// so any loop of the form `while (deadline) { ...; await sleep(1000); }` gets
// one iteration instead of twelve and then wrongly reports a dead player. An
// earlier version of this file was built that way and it caused reload storms.
//
// So nothing here polls. Three things are not throttled and everything is
// driven by them instead:
//
//   1. Media element events (playing, pause, waiting, timeupdate, error).
//      These come from the media pipeline, not from a timer.
//   2. chrome.runtime.onMessage. The background service worker is the clock;
//      it probes on its own alarm and the page answers immediately.
//   3. Real user input and visibilitychange.
//
// Timers appear nowhere in this file. If you add one, it will work on your
// screen and fail in a background tab.
(() => {
  const MANAGED_FLAG = "data-autolurk-managed";
  const { extractChannel, send } = globalThis.__autoLurk;
  // The multistream grid replaces this page with embedded players. There is no
  // Twitch player here to keep alive, and the lurk tabs it leaves running are
  // ordinary managed tabs handled by their own copy of this script.
  if (globalThis.__autoLurk.gridPage) return;

  let managedTab = false;
  let keepMuted = false;
  let lastUnmuteAt = 0;
  let lastReportedTime = -1;
  let unmuteWatchAttached = false;
  let retryUnmute = null;
  let unmuteClickSent = false;
  let handlingUserInput = false;
  let keepHighQualityWhileHidden = false;

  // Twitch reads these once, as the player boots, so they are written at
  // document_start before its bundle runs. The hash is the only synchronous
  // copy of the settings; later messages refresh them without a reload.
  const STREAM_QUALITY_IDS = ["160p30", "360p30", "480p30", "720p30", "720p60", "1080p60", "chunked"];

  function hashQuality(flag, fallback) {
    const match = String(location.hash || "").match(new RegExp("[&?]" + flag + "=([^&]+)"));
    let value = "";
    try {
      value = match ? decodeURIComponent(match[1]) : "";
    } catch {
      value = "";
    }
    return STREAM_QUALITY_IDS.includes(value) ? value : fallback;
  }

  let backgroundQuality = hashQuality("b", "160p30");
  let watchingQuality = hashQuality("w", "1080p60");

  function useQualityMessage(message) {
    if (STREAM_QUALITY_IDS.includes(message?.backgroundQuality)) {
      backgroundQuality = message.backgroundQuality;
    }
    if (STREAM_QUALITY_IDS.includes(message?.watchingQuality)) {
      watchingQuality = message.watchingQuality;
    }
  }

  function qualityDetail(mode) {
    return {
      mode,
      quality: mode === "low" ? backgroundQuality : watchingQuality,
    };
  }

  function currentChannel() {
    return extractChannel(location.pathname) || "";
  }

  function isChannelPage() {
    return Boolean(currentChannel());
  }

  // Twitch renders several <video> elements: the stream, hover previews in the
  // sidebar, and clip/ad players. Picking the first one means AutoLurk can end
  // up "verifying" a two-second preview of someone else entirely, so the
  // element has to be claimed from the real player container.
  const PLAYER_CONTAINERS = [
    '[data-a-player-type="site"]',
    '[data-a-target="video-player"]',
    ".persistent-player",
    ".video-player__container",
  ];

  function sitePlayerRoot() {
    for (const selector of PLAYER_CONTAINERS) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function getVideo() {
    const candidates = new Set();
    for (const selector of PLAYER_CONTAINERS) {
      for (const container of document.querySelectorAll(selector)) {
        for (const video of container.querySelectorAll("video")) candidates.add(video);
      }
    }

    // Twitch keeps the 160p stream element paused behind a separate full-size
    // ad video. Returning the first <video> therefore says playback is dead
    // while the preroll is visibly playing, which makes bootstrap time out and
    // the recovery ladder reload the ad forever. Pick the active rendered
    // player video. Playback outranks dimensions; dimensions keep sidebar
    // previews from winning when nothing has started yet.
    const score = (video) => {
      const rect = video.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const style = getComputedStyle(video);
      const rendered =
        area > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      return (
        (isPlaying(video) ? 1_000_000_000 : 0) +
        (rendered ? 100_000_000 : 0) +
        (video.readyState >= 2 ? 10_000_000 : 0) +
        area
      );
    };

    let best = null;
    let bestScore = -1;
    for (const video of candidates) {
      const current = score(video);
      if (current > bestScore) {
        best = video;
        bestScore = current;
      }
    }
    if (best) return best;

    // Last resort: the biggest video on the page. A preview thumbnail is never
    // the largest element, so this still avoids the sidebar.
    for (const video of document.querySelectorAll("video")) {
      const current = score(video);
      if (current > bestScore) {
        best = video;
        bestScore = current;
      }
    }
    if (!best) return null;
    // Hidden lurk tabs have no layout. Requiring 40k pixels here made every
    // background probe say "no player", which is how already-open streams
    // got reloaded over whatever the user was doing.
    if (document.visibilityState === "hidden") return best;
    return best.clientWidth * best.clientHeight > 40000 ? best : null;
  }

  function isPlaying(video) {
    return Boolean(video) && !video.paused && video.readyState >= 2 && video.currentTime > 0;
  }

  function isAdVideo(video) {
    if (!video) return false;
    const source = String(video.currentSrc || video.src || "").toLowerCase();
    return Boolean(
      video.closest('.video-ad__container, [data-test-selector*="ad" i]') ||
        source.includes("2mdn.net") ||
        source.includes("googlevideo.com")
    );
  }

  function mediaState() {
    const video = getVideo();
    const quality = readStored("video-quality")?.default || "";
    return {
      hasVideo: Boolean(video),
      channel: currentChannel(),
      currentTime: video ? video.currentTime : null,
      playing: isPlaying(video),
      paused: video ? video.paused : true,
      readyState: video ? video.readyState : 0,
      // readyState 0 with networkState 0 is the signature of Twitch declining
      // to load the stream at all, as opposed to loading it and stalling. The
      // two need very different responses, so the background gets both.
      networkState: video ? video.networkState : 0,
      videoWidth: video?.videoWidth || 0,
      videoHeight: video?.videoHeight || 0,
      selectedQuality: quality,
      adPlaying: isAdVideo(video),
      muted: video ? video.muted || video.volume === 0 : true,
      hidden: document.visibilityState === "hidden",
    };
  }

  // ---------------------------------------------------------------------
  // Twitch preferences
  // ---------------------------------------------------------------------

  function readStored(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be blocked; the element-level fallbacks still apply.
    }
  }

  let qualityObserver = null;
  let lastLurkQualityHuntAt = 0;

  function optionProfile(option) {
    const text = String(option.textContent || "").toLowerCase();
    const match = text.match(/(\d{3,4})p(\d{2})?/);
    const source = text.includes("source");
    return {
      height: match ? Number(match[1]) : source ? 10000 : 0,
      fps: match && match[2] ? Number(match[2]) : 30,
      source,
    };
  }

  function wantedProfile(quality) {
    if (quality === "chunked") return { height: 10000, fps: 60, source: true };
    const match = String(quality).match(/^(\d+)p(\d+)?/);
    return {
      height: match ? Number(match[1]) : 0,
      fps: match && match[2] ? Number(match[2]) : 30,
      source: false,
    };
  }

  // Missing renditions step down, then up. Jumping to Source is what makes a
  // low setting hitch on a channel that does not offer that exact size.
  function pickQualityOption(options, quality) {
    const list = [...options];
    if (!list.length) return null;
    const wanted = wantedProfile(quality);
    if (wanted.source) {
      return (
        list.find((option) => String(option.textContent || "").trim().toLowerCase().startsWith("source")) ||
        list.find((option) => /source/i.test(option.textContent || "")) ||
        null
      );
    }
    const exact = list.find((option) => {
      const profile = optionProfile(option);
      return profile.height === wanted.height && profile.fps === wanted.fps;
    });
    if (exact) return exact;
    const sameHeight = list
      .filter((option) => optionProfile(option).height === wanted.height)
      .sort((a, b) => optionProfile(a).fps - optionProfile(b).fps);
    if (sameHeight.length) {
      return sameHeight.find((option) => optionProfile(option).fps <= wanted.fps) || sameHeight[0];
    }
    const ranked = list
      .map((option) => ({ option, height: optionProfile(option).height }))
      .filter((item) => item.height > 0 && item.height < 10000 && Math.abs(item.height - wanted.height) <= 360);
    const lower = ranked.filter((item) => item.height < wanted.height).sort((a, b) => b.height - a.height);
    if (lower[0]) return lower[0].option;
    const higher = ranked.filter((item) => item.height > wanted.height).sort((a, b) => a.height - b.height);
    return higher[0]?.option || null;
  }

  function looking() {
    return document.visibilityState === "visible";
  }

  function settingsButton() {
    return document.querySelector('[data-a-target="player-settings-button"]');
  }

  function settingsMenuIsOpen() {
    const button = settingsButton();
    if (button?.getAttribute("aria-expanded") === "true") return true;
    return Boolean(document.querySelector('[data-a-target="player-settings-menu"]'));
  }

  function qualityOptionSelected(option) {
    const input = option.querySelector?.("input");
    if (input?.checked) return true;
    return option.getAttribute?.("aria-checked") === "true";
  }

  // Twitch leaves its settings panel up after a quality click. Close it the
  // same way a viewer would — toggle the gear — and only when it is actually
  // showing, so a click meant to dismiss cannot open a closed menu.
  function dismissSettingsMenu() {
    if (!settingsMenuIsOpen()) return;
    settingsButton()?.click();
  }

  function alreadyAtQuality(quality) {
    const video = getVideo();
    if (!video || isAdVideo(video)) return false;
    const height = video.videoHeight || 0;
    if (!height) return false;
    if (quality === "chunked") {
      const stored = String(readStored("video-quality")?.default || "");
      return stored === "chunked" || height >= 1400;
    }
    const match = String(quality).match(/^(\d+)p/);
    const target = match ? Number(match[1]) : 0;
    if (!target) return false;
    return Math.abs(height - target) <= 80;
  }

  function stopQualityHunt() {
    qualityObserver?.disconnect();
    qualityObserver = null;
  }

  // Twitch does not apply a localStorage change to a player that is already
  // decoding. Drive its own quality menu using DOM mutations rather than a
  // timer, so this works after Chrome has throttled a hidden tab.
  function selectPlayerQuality(quality, mode) {
    stopQualityHunt();
    if (mode === "low" && looking()) return;
    if (mode === "view" && !looking()) return;
    // Tabbing back to a stream that is already watchable used to reopen the
    // gear every time. Only hunt when the picture is still at the wrong size.
    if (alreadyAtQuality(quality)) return;

    let openedSettings = false;
    let openedQuality = false;

    const stop = (dismiss = true) => {
      stopQualityHunt();
      if (dismiss && (openedSettings || openedQuality || settingsMenuIsOpen())) {
        dismissSettingsMenu();
      }
    };

    const advance = () => {
      // A leftover lurk hunt must not click 160p the moment the user opens
      // the quality menu themselves.
      if (mode === "low" && looking()) {
        stop();
        return;
      }
      if (mode === "view" && !looking()) {
        stop();
        return;
      }

      const options = document.querySelectorAll(
        '[data-a-target="player-settings-submenu-quality-option"]'
      );
      const wanted = pickQualityOption(options, quality);
      if (wanted) {
        stopQualityHunt();
        if (!qualityOptionSelected(wanted)) {
          const control = wanted.querySelector("input") || wanted;
          control.click();
        }
        dismissSettingsMenu();
        return;
      }

      const qualityItem = document.querySelector(
        '[data-a-target="player-settings-menu-item-quality"]'
      );
      if (qualityItem && !openedQuality) {
        openedQuality = true;
        qualityItem.click();
        return;
      }

      const button = settingsButton();
      if (button && !openedSettings) {
        openedSettings = true;
        button.click();
        return;
      }

      // Menu is open and nothing matches. Close it rather than sitting on
      // every later mutation — including the user opening this menu by hand.
      if (openedQuality && options.length) stop();
    };

    // The settings menu is portaled, so the observer has to see the document.
    // It must not act on every mutation: the notification tray, chat, and
    // points widget all add nodes, and a click from here closes those menus.
    const playerUi = (node) =>
      Boolean(
        node?.closest &&
          node.closest(
            '[data-a-target="player-settings-menu"], [data-a-target="player-settings-menu-item-quality"], [data-a-player-type="site"], .persistent-player, .video-player__container'
          )
      );
    qualityObserver = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (playerUi(record.target)) return true;
        return [...(record.addedNodes || [])].some((node) => playerUi(node));
      });
      if (relevant) advance();
    });
    const start = () => {
      qualityObserver.observe(document.documentElement, { childList: true, subtree: true });
      advance();
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  // Twitch owns the element's mute state and restores it from localStorage on
  // every load, so the stored preference has to be corrected too. Callers are
  // responsible for establishing that this tab belongs to AutoLurk; these
  // writes must not touch a tab the user opened themselves.
  function applyLurkPreferences() {
    // A late PIN_LOW_QUALITY or becomeManaged must not drop the picture the
    // user is looking at, or steal the quality menu out from under them.
    if (looking()) return;
    if (keepHighQualityWhileHidden) {
      restoreHighQuality(true);
      return;
    }

    // Do not hide channel sections, unload <video> elements, or delete chat
    // nodes. Twitch unmounts that React tree and it stays gone until reload.
    window.dispatchEvent(new CustomEvent("autolurk-quality-mode", { detail: qualityDetail("low") }));
    writeStored("video-muted", { default: false });
    const volume = Number(localStorage.getItem("volume"));
    if (!Number.isFinite(volume) || volume <= 0) localStorage.setItem("volume", "0.5");

    // A background lurk tab at source quality costs hundreds of megabytes and
    // a decode thread. Nobody is looking at it, so pin it to the smallest
    // stream Twitch offers. Quality is restored when the tab is focused.
    const current = readStored("video-quality");
    if (current?.default !== backgroundQuality) {
      writeStored("autolurk-prior-quality", current || { default: "auto" });
      writeStored("video-quality", { default: backgroundQuality });
    }
    const video = getVideo();
    // The startup preference is enough before a player exists. Opening
    // Twitch's menu while an already-correct stream is booting can itself emit
    // waiting/stalled events, so runtime correction is reserved for genuine
    // quality drift. Ads are separate and their resolution is not selectable.
    // Health probes re-enter here when a hidden stream is still decoding high.
    if (video && !isAdVideo(video) && !alreadyAtQuality(backgroundQuality)) {
      if (Date.now() - lastLurkQualityHuntAt >= 15_000) {
        lastLurkQualityHuntAt = Date.now();
        selectPlayerQuality(backgroundQuality, "low");
      }
    }
  }

  // Twitch only reads video-quality when the player boots, so restoring the
  // preference alone would not change the picture the user is looking at. Its
  // own settings menu does, and driving it is safe here: this only ever runs
  // while the tab is visible, where timers are not throttled.
  function restoreHighQuality(allowHidden = false) {
    if (!looking() && !allowHidden) return;
    // The main-world quality guard has to unlock before this isolated-world
    // script writes the user's preference back.
    window.dispatchEvent(
      new CustomEvent("autolurk-quality-mode", {
        detail: qualityDetail(allowHidden ? "high" : "view"),
      })
    );
    restoreAudioForViewing();
    // Already decoding the rendition the user asked for. Driving the gear
    // again is what left the settings menu stuck open.
    if (alreadyAtQuality(watchingQuality)) return;
    writeStored("video-quality", { default: watchingQuality });
    selectPlayerQuality(watchingQuality, allowHidden ? "high" : "view");
  }

  function restoreQualityForViewing() {
    restoreHighQuality(false);
  }

  // ---------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------

  // One shot. Called from media events and from background commands, never in
  // a loop, so a page that refuses to play simply stays reported as not
  // playing rather than burning the tab down retrying.
  //
  // Returns the reason it could not start, or "" on success. An earlier
  // version swallowed these, which left the activity log showing a player that
  // was detected and then never heard from again with no way to tell whether
  // Chrome blocked it, Twitch stalled it, or nothing had been loaded at all.
  async function attemptPlay(video, { allowMuting = true } = {}) {
    if (!video) return "no player element";
    if (isPlaying(video)) return "";

    // Nothing has been loaded, so play() would resolve against an empty
    // element and change nothing. Say so plainly instead.
    if (video.readyState === 0 && video.networkState === 0) {
      return "Twitch has not loaded the stream";
    }

    try {
      await video.play();
      return "";
    } catch (error) {
      // Chrome refuses unmuted autoplay without a user gesture. Muted media is
      // always allowed, so fall back and try to gain sound later.
      if (allowMuting && error.name === "NotAllowedError") {
        // A visible tab still needs this fallback during a programmatic open
        // (no user gesture on the Twitch page). keepMuted is cleared the
        // moment the tab is in front of the user, so this does not stay muted.
        keepMuted = true;
        video.muted = true;
        try {
          await video.play();
          watchForUnmuteOpportunity();
          return "";
        } catch (mutedError) {
          return `muted playback refused (${mutedError.name})`;
        }
      }
      return `playback refused (${error.name})`;
    }
  }

  function muteButton() {
    return document.querySelector('[data-a-target="player-mute-unmute-button"]');
  }

  function playerShowsMuted() {
    const label = (muteButton()?.getAttribute("aria-label") || "").toLowerCase();
    return label.includes("unmute");
  }

  function isMuteControl(event) {
    const node = event?.target;
    if (!node?.closest) return false;
    return Boolean(node.closest('[data-a-target="player-mute-unmute-button"]'));
  }

  // Unmuting can get playback suspended by Chrome. Rather than sleeping to
  // find out, the `pause` handler below watches for it and undoes this.
  //
  function rememberUnmutedPreference() {
    writeStored("video-muted", { default: false });
    const volume = Number(localStorage.getItem("volume"));
    if (!Number.isFinite(volume) || volume <= 0) localStorage.setItem("volume", "0.5");
  }

  // Only one of "set video.muted" or "click Unmute" — doing both is how the
  // button ends up toggling the player back to muted. Twitch's control is
  // preferred; the property is the fallback when the button is not there.
  // A second click, or a click from inside the user's own pointerdown, closes
  // the notification tray and can leave the player muted.
  function tryUnmute(video, { allowClick = true } = {}) {
    if (!video || keepMuted) return;
    rememberUnmutedPreference();
    if (video.volume === 0) video.volume = 0.5;
    const showsMuted = playerShowsMuted();
    if (!showsMuted && !video.muted) {
      unmuteClickSent = false;
      return;
    }
    if (showsMuted && allowClick && !handlingUserInput) {
      if (unmuteClickSent) return;
      unmuteClickSent = true;
      lastUnmuteAt = Date.now();
      muteButton().click();
      return;
    }
    if (unmuteClickSent) return;
    if (video.muted) {
      lastUnmuteAt = Date.now();
      video.muted = false;
    }
  }

  function restoreAudioForViewing() {
    keepMuted = false;
    lastUnmuteAt = 0;
    const video = getVideo();
    if (video) tryUnmute(video);
  }

  // Chrome only reliably allows audible playback after the user touches the
  // page, so retry on the first real interaction. All three are real events.
  function watchForUnmuteOpportunity() {
    if (unmuteWatchAttached) return;
    unmuteWatchAttached = true;

    const retry = (event) => {
      // The mute button is the user's. A capture listener that also clicks
      // it — or unmutes just before their click — is what makes the control
      // feel broken: they press Unmute and the stream stays muted.
      if (isMuteControl(event)) {
        keepMuted = false;
        lastUnmuteAt = 0;
        unmuteClickSent = false;
        return;
      }
      const video = getVideo();
      if (!video) return;
      if (!video.muted && video.volume > 0 && !playerShowsMuted()) {
        cleanup();
        return;
      }
      // Never click from here. This listener runs for every pointerdown on
      // the page, including the notification bell, and a synthetic click
      // dismisses that tray before it can open.
      keepMuted = false;
      handlingUserInput = true;
      try {
        tryUnmute(video, { allowClick: false });
      } finally {
        handlingUserInput = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };

    function cleanup() {
      unmuteWatchAttached = false;
      retryUnmute = null;
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", retry, true);
      document.removeEventListener("keydown", retry, true);
    }

    retryUnmute = retry;
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("pointerdown", retry, true);
    document.addEventListener("keydown", retry, true);
  }

  // Twitch pauses behind an overlay after long idle periods and on recoverable
  // errors. Its own buttons reset its internal state better than play() does.
  function playerRoot() {
    const video = getVideo();
    const fromVideo = video?.closest?.(PLAYER_CONTAINERS.join(", "));
    if (fromVideo) return fromVideo;
    return sitePlayerRoot();
  }

  function clickPlayerControl() {
    const root = playerRoot();
    if (!root) return false;
    const selectors = [
      '[data-a-target="player-overlay-content-gate-retry-button"]',
      '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
      '[data-a-target="player-play-pause-button"][aria-label*="Play" i]',
    ];
    for (const selector of selectors) {
      const button = root.querySelector(selector);
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------

  function report(extra) {
    if (!managedTab || !isChannelPage()) return;
    send("PLAYER_HEALTH", { ...mediaState(), ...extra });
  }

  function boot(stage, extra) {
    if (!managedTab) return;
    send("PLAYER_BOOT", { stage, channel: currentChannel(), ...extra });
  }

  // timeupdate fires several times a second from the media pipeline while a
  // stream decodes, and is not throttled in a hidden tab. It is therefore the
  // heartbeat. Reporting is rate limited by playback position rather than by a
  // timer, so silence here means playback actually stopped.
  function onTimeUpdate(event) {
    if (!managedTab) return;
    const video = event.target;
    if (video !== getVideo()) return;
    if (Math.abs(video.currentTime - lastReportedTime) < 5) return;
    lastReportedTime = video.currentTime;
    report();
  }

  function onPlaying(event) {
    if (!managedTab) return;
    const video = event.target;
    if (video !== getVideo()) return;
    lastReportedTime = video.currentTime;
    boot("playing", {
      currentTime: video.currentTime,
      playerMuted: video.muted,
      adPlaying: isAdVideo(video),
    });
    // While the user is looking, leave mute alone. A quality change fires
    // playing again and must not unmute a stream they just silenced.
    if (!looking() && !keepMuted && video.muted) tryUnmute(video);
  }

  function onPause(event) {
    if (!managedTab) return;
    const video = event.target;
    if (video !== getVideo()) return;

    // Chrome suspends playback when an unmute is refused. The pause arrives
    // immediately, so this undoes it without waiting on any timer.
    //
    // A visible tab pauses for lots of other reasons — quality changes,
    // ads, the user hitting space. Forcing mute there is how the player
    // ends up stuck muted while you watch.
    if (!looking() && Date.now() - lastUnmuteAt < 10000) {
      keepMuted = true;
      video.muted = true;
      attemptPlay(video, { allowMuting: false });
      watchForUnmuteOpportunity();
      return;
    }
    report();
  }

  function onStalled() {
    if (!managedTab) return;
    report();
  }

  function onError(event) {
    if (!managedTab) return;
    if (event.target !== getVideo()) return;
    boot("stalled", { reason: "media error" });
  }

  // Media events do not bubble, but they do run through the capture phase, so
  // one listener at the document catches the player video the moment Twitch
  // creates it. No MutationObserver and no polling for the element.
  function attachDocumentMediaListeners() {
    const capture = true;
    document.addEventListener("loadedmetadata", onPlayerAppeared, capture);
    document.addEventListener("canplay", onPlayerAppeared, capture);
    document.addEventListener("playing", onPlaying, capture);
    document.addEventListener("timeupdate", onTimeUpdate, capture);
    document.addEventListener("pause", onPause, capture);
    document.addEventListener("waiting", onStalled, capture);
    document.addEventListener("stalled", onStalled, capture);
    document.addEventListener("ended", onStalled, capture);
    document.addEventListener("error", onError, capture);
    document.addEventListener("volumechange", onStalled, capture);
  }

  // Gated on ownership like every other handler here. Without this, opening
  // Twitch yourself and pausing a stream would have the extension press play
  // again on a tab it was never given.
  async function onPlayerAppeared(event) {
    if (!managedTab) return;
    const video = getVideo();
    if (!video || event.target !== video) return;
    if (video.hasAttribute(MANAGED_FLAG)) {
      if (!isPlaying(video)) {
        const refusal = await attemptPlay(video);
        if (refusal) boot("stalled", { reason: refusal });
      }
      return;
    }

    video.setAttribute(MANAGED_FLAG, "1");
    video.autoplay = true;
    boot("player_found");
    boot("starting");
    const refusal = await attemptPlay(video);
    if (refusal) boot("stalled", { reason: refusal });
    if (looking()) restoreAudioForViewing();
    else if (!keepMuted) tryUnmute(video);
  }

  // ---------------------------------------------------------------------
  // Background commands
  // ---------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "MANAGED_NOW") {
      useQualityMessage(message);
      becomeManaged();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "UNMANAGED_NOW") {
      managedTab = false;
      sendResponse({ ok: true });
      return false;
    }

    // The background asks for state directly because a hidden tab cannot be
    // trusted to report on its own schedule. Answering is immediate.
    if (message?.type === "PROBE_PLAYER") {
      useQualityMessage(message);
      becomeManaged();
      // The service worker is the only clock a hidden tab can trust.
      if (!looking() && !keepHighQualityWhileHidden) applyLurkPreferences();
      sendResponse(mediaState());
      return false;
    }

    if (message?.type === "PIN_LOW_QUALITY") {
      useQualityMessage(message);
      becomeManaged();
      keepHighQualityWhileHidden = false;
      applyLurkPreferences();
      sendResponse({ accepted: true });
      return false;
    }

    if (message?.type === "PIN_VIEWING_QUALITY") {
      useQualityMessage(message);
      becomeManaged();
      keepHighQualityWhileHidden = false;
      restoreQualityForViewing();
      sendResponse({ accepted: true });
      return false;
    }

    if (message?.type === "PIN_HIGH_QUALITY") {
      useQualityMessage(message);
      keepHighQualityWhileHidden = true;
      becomeManaged();
      restoreHighQuality(true);
      sendResponse({ accepted: true });
      return false;
    }

    // Returning to a lurk tab should not mean watching 160p. This arrives from
    // the service worker rather than from visibilitychange, which the page
    // world deliberately swallows. It only fires for a tab that is genuinely
    // in front of the user, so the menu interaction is not fighting any
    // throttling.
    if (message?.type === "RECOVER_PLAYER") {
      becomeManaged();
      sendResponse({ accepted: true });
      // One bounded action, then report. The background decides what happens
      // next on its own clock; the page never escalates by itself.
      (async () => {
        const video = getVideo();
        if (!video) return;
        if (video.paused) clickPlayerControl();
        const refusal = await attemptPlay(video);
        if (looking()) restoreAudioForViewing();
        report(refusal ? { reason: refusal } : undefined);
      })().catch(() => {});
      return false;
    }

    return false;
  });

  function becomeManaged() {
    if (managedTab) return;
    managedTab = true;
    // Covers a tab adopted after the fact, which never carried the hash. Match
    // what the user can see: the watching quality while this tab is in front,
    // the background quality only once it is actually in the background.
    if (looking()) restoreQualityForViewing();
    else applyLurkPreferences();
    const video = getVideo();
    if (video) onPlayerAppeared({ target: video });
  }

  // Asked exactly once. If the answer is no, this tab goes dormant rather than
  // retrying forever — the old version re-asked eight times every five seconds
  // on every Twitch tab, which kept the service worker permanently awake. The
  // background pushes MANAGED_NOW when it registers a tab, so the race in the
  // other direction is covered without polling.
  function askManagedOnce() {
    try {
      chrome.runtime.sendMessage({ type: "AM_I_MANAGED" }, (response) => {
        void chrome.runtime.lastError;
        if (response?.result) becomeManaged();
      });
    } catch {
      // Extension reloading. MANAGED_NOW will arrive if this tab matters.
    }
  }

  // Returning to a lurk tab should not mean watching 160p. Only ever runs
  // while visible, so the menu interaction is not fighting any throttling.
  document.addEventListener("visibilitychange", () => {
    if (!managedTab) return;
    if (document.visibilityState === "visible") restoreQualityForViewing();
    else applyLurkPreferences();
  });

  attachDocumentMediaListeners();

  if (isChannelPage()) {
    // AutoLurk marks the tabs it opens with a hash so the page can recognise
    // one synchronously, before Twitch's bundle reads its preferences. The
    // hash only unlocks preference writes; whether this tab is really managed
    // still comes from the background before anything is reported or acted on.
    if (location.hash.includes("autolurk") && !looking()) applyLurkPreferences();
    askManagedOnce();
  }
})();
