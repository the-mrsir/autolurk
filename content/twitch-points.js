// Claims the Twitch channel point bonus chest.
//
// Twitch exposes no API for this, so it is DOM work and therefore fragile by
// nature. Two rules keep the fragility contained: never click anything outside
// the channel points widget, and send the balance to the background as raw
// text so only one copy of the parsing rules exists.
(() => {
  const { extractChannel, send } = globalThis.__autoLurk;
  // Nothing to claim on the multistream grid: the embedded players have no
  // channel points widget, which is exactly why the lurk tabs stay open.
  if (globalThis.__autoLurk.gridPage) return;

  // Mirrors CHANNEL_POINTS in shared/constants.js. Twitch offers the chest
  // roughly every 15 minutes and leaves it up for several, so a slow scan is
  // enough even after Chrome throttles background timers to once a minute.
  const SCAN_INTERVAL_MS = 20000;
  const MIN_CLAIM_GAP_MS = 60000;
  const CLAIM_CONFIRM_TIMEOUT_MS = 3 * 60000;

  let config = null;
  let lastClaimAt = 0;
  let pendingClaim = null;
  let pendingReport = null;
  let lastReportedBalance = "";
  let watchedWidget = null;
  let scanQueued = false;

  function pointsWidget() {
    return document.querySelector(
      '[data-test-selector="community-points-summary"], .community-points-summary'
    );
  }

  // Ordered by how stable each hook has proven. The icon class has outlived
  // several Twitch redesigns; the aria-label only works in English.
  function isRendered(element) {
    if (!element?.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      element.getClientRects().length > 0
    );
  }

  function findClaimButton(widget) {
    // Current Twitch markup: the bonus is the green success button. Keep the
    // icon and accessible-label fallbacks for older layouts and locales.
    const success = widget.querySelector("button.tw-button--success, button[class*='success']");
    if (success && isRendered(success)) return success;

    const icon = widget.querySelector(
      '.claimable-bonus__icon, .claimable-bonusicon, [class*="claimable-bonus"]'
    );
    const fromIcon = icon?.closest("button");
    if (fromIcon && isRendered(fromIcon)) return fromIcon;

    for (const button of widget.querySelectorAll("button")) {
      const label = (button.getAttribute("aria-label") || "").toLowerCase();
      if ((label.includes("bonus") || label.includes("claim")) && isRendered(button)) return button;
    }
    return null;
  }

  function readBalanceText(widget) {
    const node = widget.querySelector('[data-test-selector="balance-string"]');
    return node ? node.textContent.trim() : "";
  }

  // Confirmation deliberately waits for the NEXT scan rather than sleeping in
  // a loop. Chrome throttles timers in a hidden tab to once a minute, so a
  // nested six-second deadline would always expire unmet and every claim would
  // be reported as unconfirmed. Riding the existing tick is throttle-proof.
  function resolvePendingClaim(widget) {
    if (!pendingClaim) return;
    const button = findClaimButton(widget);
    if (button && Date.now() - pendingClaim.at < CLAIM_CONFIRM_TIMEOUT_MS) {
      // A click is asynchronous. Twitch often leaves the old button mounted
      // (or replaces it with an identical disabled one) while the request is
      // settling. The old code cleared pending on the very next throttled scan
      // and recorded a false failure. A widget MutationObserver below confirms
      // as soon as the rendered chest actually disappears.
      return;
    }

    const claim = pendingClaim;
    pendingClaim = null;
    reportClaim({
      login: claim.login,
      // The balance is abbreviated past a thousand, so a +50 bonus often leaves
      // the number untouched. The chest vanishing is the dependable signal.
      confirmed: !button,
      balanceText: readBalanceText(widget),
    });
  }

  // Unlike balance telemetry, a confirmed claim must not disappear if the MV3
  // worker is being restarted at exactly the wrong moment. Keep one report and
  // retry it on later scans until the background acknowledges persistence.
  function reportClaim(payload) {
    pendingReport = payload;
    flushClaimReport();
  }

  function flushClaimReport() {
    if (!pendingReport) return;
    const payload = pendingReport;
    try {
      chrome.runtime.sendMessage({ type: "POINTS_CLAIMED", ...payload }, (response) => {
        if (!chrome.runtime.lastError && response?.ok && pendingReport === payload) {
          pendingReport = null;
        }
      });
    } catch {
      // Extension reload; the next scan retries if this document survives.
    }
  }

  function attemptClaim() {
    const widget = pointsWidget();
    if (!widget) return;

    resolvePendingClaim(widget);
    if (!config?.claim) return;

    const login = extractChannel(location.pathname);
    if (!login) return;

    const button = findClaimButton(widget);
    // Refuse to act on a button that escaped the widget between lookups.
    if (!button || !widget.contains(button) || button.disabled) return;

    // The real bonus never returns this fast. If something is re-rendering a
    // claim button in a loop, stop rather than spam clicks on the account.
    if (Date.now() - lastClaimAt < MIN_CLAIM_GAP_MS) return;

    lastClaimAt = Date.now();
    button.click();
    pendingClaim = { login, at: lastClaimAt };
  }

  // Only on change. Otherwise every Twitch tab writes to storage three times a
  // minute to say the same number.
  function reportBalance() {
    const widget = pointsWidget();
    if (!widget) return;
    const login = extractChannel(location.pathname);
    const balanceText = readBalanceText(widget);
    if (!login || !balanceText) return;
    // Keyed by channel too, so a raid to a channel with a similar balance is
    // still reported.
    const key = `${login}:${balanceText}`;
    if (key === lastReportedBalance) return;
    lastReportedBalance = key;
    send("POINTS_BALANCE", { login, balanceText });
  }

  // The service worker answers in an { ok, result } envelope.
  function loadConfig() {
    try {
      chrome.runtime.sendMessage({ type: "PAGE_CONFIG" }, (response) => {
        void chrome.runtime.lastError;
        if (response?.result) {
          config = response.result;
          scheduleScan();
        }
      });
    } catch {
      // Service worker asleep or extension reloading; the next scan retries.
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "CONFIG_CHANGED") loadConfig();
    return false;
  });

  loadConfig();

  // Confirm a chest that disappeared. Do not click from here: this fires for
  // ordinary widget updates, and a click while the notification tray is
  // opening is what makes that tray close immediately.
  const widgetObserver = new MutationObserver(() => {
    const widget = pointsWidget();
    if (!widget) return;
    resolvePendingClaim(widget);
    reportBalance();
  });
  const discoveryObserver = new MutationObserver(() => {
    if (pointsWidget()) scheduleScan();
  });

  function watch(widget) {
    if (widget === watchedWidget) return;
    watchedWidget = widget;
    widgetObserver.disconnect();
    if (widget) {
      widgetObserver.observe(widget, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "disabled", "hidden", "aria-hidden"],
      });
      discoveryObserver.disconnect();
    }
  }

  function scan() {
    const widget = pointsWidget();
    watch(widget);
    flushClaimReport();
    // The first request loses a race with a sleeping service worker often
    // enough that retrying matters; without this the tab would never claim.
    if (!config) loadConfig();
    attemptClaim();
    reportBalance();
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      scan();
    });
  }

  if (document.documentElement) {
    discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => discoveryObserver.observe(document.documentElement, { childList: true, subtree: true }),
      { once: true }
    );
  }

  scheduleScan();
  setInterval(() => {
    // Also rediscovers a widget Twitch replaced wholesale while the tab was
    // hidden. The interval is fallback; normal claims are mutation-driven.
    if (!watchedWidget?.isConnected) {
      watchedWidget = null;
      if (document.documentElement) {
        discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
    }
    scan();
  }, SCAN_INTERVAL_MS);
})();
