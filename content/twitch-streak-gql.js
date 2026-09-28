// MAIN world, on a real twitch.tv page, so the streak query is same-site and
// the logged-in session cookie is sent. The extension's Helix token belongs to
// a different client and Twitch will not honor it here.
//
// This file only fetches. It does not touch the player, visibility, or the DOM.
(() => {
  if (globalThis.__autoLurkStreakGql) return;
  globalThis.__autoLurkStreakGql = true;

  window.addEventListener("autolurk-streak-query", (event) => {
    const detail = event.detail || {};
    const id = detail.id;
    const operations = detail.operations;
    const clientId = detail.clientId;
    if (!id || !clientId || !Array.isArray(operations)) return;

    const finish = (payload) => {
      window.dispatchEvent(
        new CustomEvent("autolurk-streak-result", { detail: { id, ...payload } })
      );
    };

    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(15000)
        : undefined;

    fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      credentials: "include",
      headers: {
        "Client-Id": clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(operations),
      signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          finish({ ok: false, error: `Twitch streak query returned ${response.status}.` });
          return;
        }
        finish({ ok: true, body: await response.json() });
      })
      .catch((error) => {
        const timedOut = error && error.name === "TimeoutError";
        finish({
          ok: false,
          error: timedOut ? "Twitch streak query timed out." : "Twitch streak query failed.",
        });
      });
  });
})();
