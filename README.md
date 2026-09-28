# AutoLurk Companion

A Manifest V3 Chrome extension for Twitch follow monitoring and automatic stream handling.

Designed so users only connect Twitch and star favorites. Live checks default to **5 minutes**, which stays comfortable on one shared Twitch app at around **200 users**.

## What it does

- Imports Twitch follows after a one-time Device Code sign-in
- Lets users mark follows as favorites with a star
- Auto-opens favorites directly as inactive tabs without covering whatever
  you are doing
- Keeps the Twitch player unmuted and mutes the Chrome tab
- Keeps user-unmuted tabs at 1080p even while another tab is in front
- Collects every managed tab into a single **AutoLurk** group, across windows
- Shows up to four live streams side by side in one tab, on demand
- Cleans up after sleep and closes streams that ended
- Shares favorites and settings with your other computers through Chrome
- Watches each managed tab's real video element and nudges stalled playback
  without navigating; a disruptive reload happens only when you press Retry
- Closes managed tabs when that streamer goes offline
- Closes managed tabs if the URL leaves the original channel, including raids
- Remembers manual closes for the current broadcast
- Shows live favorites, other live follows, and offline favorites
- Claims the channel point bonus chest on Twitch tabs
- Opens a recovery clip or VOD when a favorite's watch streak is expiring
- Shows each live favorite's 7TV emote set under **Details**

## What it does not claim

AutoLurk can observe that the correct channel's `<video>` element is decoding
frames. It cannot observe whether Twitch counted that live view toward a drop,
a watch streak, or channel points. The UI therefore says **Media playing**,
never "watching", and the per-stream details panel states that Twitch credit
is unverified.

An expiring streak is a separate case. AutoLurk reads Twitch's RewardList
query from a logged-in Twitch page and, only when that query shows an
expiration, opens the clip or VOD from the missed broadcast (or Twitch's
save-streak page when none is listed). It says the streak recovered only when
a later RewardList response no longer has that expiration. Opening the page
is not success, and a recovery video that never starts playing is reported
that way.

The same honesty applies to channel points. Twitch abbreviates the balance past
a thousand ("1.2K"), so a fifty point bonus usually leaves the number on screen
unchanged and "points earned" cannot be measured from the page. AutoLurk
therefore counts a claim when the bonus chest disappears after the click, marks
the balance as rounded when Twitch rounded it, and reports a click that changed
nothing as **not confirmed** rather than as a success.

## Chrome may refuse to start a tab that has never been visible

This is still the case, so it is written down with the evidence.

Measured against a live channel in a real Chrome 152 driven over the DevTools
protocol: open a Twitch channel in a tab that is never shown, and the player
element sits at `readyState 0` and `networkState 0` for as long as you care to
watch. Not stalled, not blocked by autoplay policy, not behind a content gate or
a preroll ad — the element is simply never handed a media source. `play()` has
nothing to act on and resolves against an empty element, so every reload and
reopen the recovery ladder tries next fails for exactly the same reason and
learns nothing. The same tab, made visible, is at `readyState 4` with about
thirty seconds buffered within a few seconds.

The mirror image matters just as much: a stream that is **already playing** goes
on playing after its tab is hidden, with `currentTime` advancing in real time.
The restriction is on starting, not on continuing.

`tab-manager.js` now creates automatic streams **inactive**. It never
activates a tab or creates a temporary window as fallback. If Chrome still
refuses hidden startup, the tab is marked **Needs attention** so the user can
open it or deliberately press Retry.

Spoofing `document.visibilityState`, blocking `pause`, forging intersection
entries, and clicking Play were all tried. Spoofing moved `networkState` off 0
and then buffered nothing. The later hooks did worse: Twitch removed the
persistent player from the channel page, leaving About, Goals, panels, and
chat with no video until a refresh. `content/twitch-keepalive.js` therefore
does not touch the page. The isolated content script may call `play()` on the
real player video and is responsible for 160p versus 1080p. It does not hide
channel sections or destroy `<video>` elements.

## Background tabs cannot use timers

This is the most important constraint in the codebase and the cause of its
worst regression, so it is written down rather than left to be rediscovered.

Chrome throttles `setTimeout` in a hidden tab to once a second, and to **once a
minute** after five minutes hidden. Every tab AutoLurk opens is hidden from
birth. An earlier version bootstrapped playback with loops like
`while (Date.now() < deadline) { ...; await sleep(1000); }`; throttled, those
got one iteration where they expected twelve, blew their deadline, and reported
a perfectly healthy player as dead. The recovery ladder then reloaded and
reopened every tab on a loop until Chrome ran out of memory and froze. The
visible symptom was tabs that did nothing until you clicked them, at which
point the whole queued sequence ran at once.

Muting makes it worse, and unavoidably so: Chrome exempts *audible* tabs from
the aggressive throttling, and muted tabs are not audible. Muted background
tabs are the entire point of this extension, so the code has to be immune to
throttling rather than hope to avoid it.

Three things are not throttled, and `content/twitch-player.js` is built only on
them:

1. **Media element events** (`playing`, `pause`, `waiting`, `timeupdate`,
   `error`) — these come from the media pipeline. `timeupdate` is the heartbeat,
   rate limited by playback position rather than by a clock, so silence means
   playback genuinely stopped.
2. **`chrome.runtime.onMessage`** — the service worker is the clock. It probes
   on its own alarm and the page answers immediately.
3. **User input and `visibilitychange`.**

There are no timers in that file, and `tests/throttling.test.js` fails the
build if one is added. The points script may keep its single scan interval —
throttled to once a minute it still catches a chest that stays up for several —
but it must confirm a claim on the next tick rather than inside a nested
deadline, for exactly the same reason.

## Memory

Managed streams are pinned to 160p only while they are in the background. A
hidden Twitch tab at source quality costs hundreds of megabytes and a decode
thread, and nobody is looking at it. The moment the tab is in front of the
user it selects 1080p (Source/Auto only when 1080p is unavailable), the 160p
lock is released, and a quality the user picks themselves is left alone. The
player settings menu is closed after that click, and is not opened again when
the picture is already at the right size. The player is unmuted when you look
at the tab and is not remuted afterwards — a quality change pause used to
force mute back on, and a second click on Twitch's Unmute control used to
toggle it straight back to muted.
Activating any other tab in that window pins it back to 160p. A selected
stream in another window stays at viewing quality — being the active tab in
its window is enough. Stream details show both the requested quality and
decoded dimensions, so this can be checked without focusing the tab (which
intentionally selects 1080p).

Preroll and midroll ads use a separate video element and Twitch controls their
resolution; a 1080p ad does not mean the stream behind it lost its 160p setting.
AutoLurk labels that case instead of treating the paused stream behind an ad as
failed playback. Quality reduces video bandwidth and decode cost, but the rest
of Twitch's application still consumes memory in every open tab.

Health probes re-pin 160p when the decoded height has grown. A stream that
has given up is marked discardable so Chrome can reclaim it. Chat is left
alone: deleting its nodes makes Twitch unmount the column until reload.

New installs cap automatic opens at eight streams. 0 in settings still means
no limit; each extra tab is a full Twitch page.

When Chrome discards a managed tab it is because the machine is short on
memory. AutoLurk reports it as needing attention and does not automatically
reload it. Opening the tab lets Chrome restore it; Retry performs a deliberate
reload.

## Multistream

**Live → Multistream** puts two to four live channels side by side in a 2×2
grid, in **one tab, in one window**.

Chrome paints exactly one tab per window, so four real Twitch tabs can only ever
be four windows — which is what an earlier version of this did, and it is not
what "watch them together" means. Side by side in a single window therefore has
to mean embedded players, and Twitch will not embed its player just anywhere:
the `parent` check takes a bare https domain, and its `frame-ancestors` policy
refuses `chrome-extension:` origins outright. Both were confirmed against the
live site. That leaves exactly one place the grid can live — an ordinary
`www.twitch.tv` page, whose own document is stopped at `document_start` and
replaced with the tiles before Twitch's app can boot.

**The grid is only a viewer.** An embedded player claims no channel points and
earns no streak, so the managed lurk tabs are deliberately left exactly as they
are: in the AutoLurk group, muted, at 160p, still doing the thing this extension
exists for. Nothing about multistream moves, mutes, regroups or reloads them. A
tiled channel that has no lurk tab gets one opened, so watching a stream in the
grid still counts. Each stream is decoded twice — once at 160p to lurk, once in
the grid to watch — and the cheap copy is the one running twice over.

Two details are measured rather than chosen:

- **The tiles start on a stagger.** Four players started the moment the host
  document is stopped never recover: all four sit buffering and gain
  twenty-seven seconds of video in a minute. Letting the document settle for two
  seconds and then starting the tiles one and a half seconds apart holds every
  one of them at real time.
- **Audio moves by pressing the player's own mute control.** Assigning
  `video.muted` from the frame appears to work and then quietly loses, because
  the player's store reapplies its own state seconds later — measured, after a
  switch that left the whole grid silent. Clicking sticks, needs no user gesture
  in the frame, and reloads nothing, so switching tiles never costs a rebuffer.

Clicking a muted tile — anywhere on it, or on its name bar — gives it the sound.
The audible tile is left fully interactive so its own player controls still
work, and muting it yourself is respected rather than argued with. Tiles are
capped at 720p, which is about what a quarter of a 1440p screen is worth and
keeps four streams from fighting over the connection.

Exiting closes the grid tab, and closing the grid tab exits. There is nothing to
put back. The session lives in `chrome.storage.session`: it survives the service
worker being torn down mid-session, and deliberately does not survive a browser
restart. A grid URL that outlives its session — a restored tab, say — sends
itself back to Twitch rather than sitting there empty.

## Channel points

Claiming is DOM work — Twitch exposes no API for the bonus chest — so it is the
most breakable part of the extension. Three rules keep that contained:

- Only buttons inside Twitch's channel points widget are ever clicked, so a
  stray "Claim" elsewhere on the page cannot be accepted on the user's behalf
- Clicks are rate limited to one a minute per tab; the real bonus is never that
  frequent, so a re-rendering loop cannot turn into a click storm
- A widget observer confirms as soon as the rendered chest disappears. A
  still-mounted button remains pending for up to three minutes instead of being
  falsely rejected on the next throttled scan
- Nothing is ever spent, only claimed

By default this runs on every Twitch channel tab. **Settings → Channel points →
Only on tabs AutoLurk opened** narrows it to managed tabs.

## Watch streaks

Once an hour, while AutoLurk is running, each favorite is checked with Twitch's
RewardList query. A future `expiresAt` is the only reason to act. By default the
recovery video is brought to the front, because a tab that stays hidden often
never starts playing. Favorite lurk tabs are unchanged and still open in the
background. **Settings → Channel points → Open recovery videos in front** turns
that off. The Chrome tab is muted when tab muting is on. A clip is left up until
it has played; a VOD is left up for about five minutes. Then RewardList is read
again, and the recovery tab is closed. It is closed when the expiration is gone,
and also when the attempt is finished without a recovery.

The newest clip is often from a different broadcast than the one that was
missed, so AutoLurk prefers a clip or VOD whose broadcast id is in that
streak's `missedStreams` list. Sub-only or missing videos cannot be recovered;
the log says so instead of claiming the streak was saved.

## Updates

Chrome does not update an extension that was loaded from a folder. **Settings →
Updates** takes a public GitHub repository whose root is this extension
(`manifest.json` at the top). Check reads that `manifest.json`. When its version
is higher than the installed copy, **Update** downloads GitHub's zip of the
same branch.

Check runs on its own about twice a day, and from the Check button. The first
Check is the one that lets Chrome reach GitHub; the automatic check cannot ask.
The popup offers **Update** when a newer version is waiting, and that opens the
settings section. Update writes the new files into the folder you originally
loaded, then reloads the extension. The first time, choose that folder. The
package has to keep the same `key` in `manifest.json`, or it would install as a
different extension and drop synced favorites.

Publishing an update is raising `version` in `manifest.json` (and `package.json`,
which the tests require to match) and pushing. A JSON file with `version` and
`packageUrl` still works as the update address if the files are hosted somewhere
else.

## 7TV

Each live favorite's 7TV emote set is looked up and shown under **Details**,
with a preview of its emotes. 7TV is a volunteer-run service, so results are
cached for six hours, failures and "no 7TV emotes" answers are cached too, at
most two requests run at once, and a poll refreshes at most six channels.
A 7TV outage cannot fail a Twitch poll.

If the 7TV *browser extension* is detected on a Twitch page, the dashboard says
so. It rewrites parts of the page around the player, which is the usual
explanation when playback readings or the points chest cannot be found.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Connect Twitch

Users should only click **Connect Twitch**. They should not open the Twitch developer console.

That works after you, the publisher, create **one** public Twitch app and put its Client ID in `shared/constants.js`:

```js
export const PUBLISHED_CLIENT_ID = "your_public_client_id";
```

Until that value is set, the dashboard still lets you paste a Client ID locally for testing.

Publisher app setup:

1. Open the [Twitch Developer Console](https://dev.twitch.tv/console/apps)
2. Register one application
3. Set the OAuth redirect URL to `http://localhost`
4. Choose **Public** as the client type
5. Enable Device Code Grant if the console shows that option
6. Copy the Client ID into `PUBLISHED_CLIENT_ID`

Then reload the unpacked extension. After that, Connect Twitch is the only setup step.

## Daily use

1. Star favorites in the dashboard
2. Optionally set auto-open, notifications, category rules, and priority per streamer
3. When a favorite goes live, AutoLurk Companion creates an inactive muted tab
   and files it into the AutoLurk group. Your
   current tab is never changed. A stream
   that is already open is adopted, not opened again, and a channel that is not
   live on this poll is not opened. If the group lives in another window, the
   new tab is moved there afterwards, so every stream collects in the one group
   no matter which window you were working in.
   Duplicate protection is checked inside the same serialized operation that
   creates the tab. Reconciliation also closes historical duplicate channel
   tabs already inside AutoLurk.
   There is only ever one group: any stream that has drifted into a window or
   group of its own is gathered back at the next check. That check runs on the
   minute rather than only when a stream opens or closes, because a second
   AutoLurk group can turn up without either happening — Chrome restoring last
   session's group, a tab dragged out, a group arriving from another machine
   through Chrome's own tab group sync. A merge is written to the activity log,
   so a cause that is still happening stays visible rather than being quietly
   absorbed. The one exception is a group you have named yourself — a stream you
   file into one of those is left alone, which is how you keep a single stream
   apart from the rest
   When two computers create groups independently, each browser discovers all
   locally synced AutoLurk groups, keeps the largest one, and folds the others
   into it. A failed Chrome group query never causes a replacement group.
   Live polls also inventory the Twitch tabs inside those synced groups. Live
   tabs are adopted on that computer; channels covered by a complete or partial
   poll are closed when authoritatively offline. Synced snoozes and unfavorites
   close matching local/grouped tabs immediately, even before that computer has
   connected Twitch, so Chrome's tab sync cannot override the user's choice.
4. When they end or raid away, that managed tab closes
5. If you close a managed tab yourself, it stays closed until their next stream
6. After the machine sleeps, streams that ended while you were away are closed;
   surviving tabs get only a non-navigating playback nudge

## Scale notes

At about 200 users, the extension:

- Polls live status every 5 minutes by default
- Spreads the first check after Chrome starts so everyone does not hit Twitch at once
- Syncs follow lists about every 2 hours, and only fetches missing profile images
- Shares one Client ID and therefore one Twitch rate-limit pool

Faster than 2 minutes is not offered. If the user base grows well past 200, move live detection to EventSub.

## Coming back from sleep

Nothing runs while the machine is asleep: no alarms, no page timers, no media
events. Hours later the browser resumes with every managed tab still open,
every player dead, and most of those broadcasts long since finished. The
ordinary health check is exactly the wrong thing to run in that state, because
every tab looks stalled at once and it would start restarting streams that no
longer exist.

The sleep is detected from the gap between health checks — a gap is the only
evidence available, since nothing was running to notice anything else. Recovery
then happens in a fixed order:

1. Freeze every managed tab, so nothing acts on hours-old timestamps
2. Poll Twitch to find out who is actually still on air
3. Close the tabs whose broadcast ended, with no offline grace period — that
   grace exists so one unlucky poll cannot close a tab, and a stream that ended
   three hours ago is not an unlucky poll
4. Nudge surviving players without navigating their tabs; show Retry if a real
   reload is required

If the poll cannot run — no network yet is the normal case on wake, since Wi-Fi
reconnects after the browser does — nothing is touched at all and the tabs stay
frozen until a poll succeeds. Acting on a degraded poll would mean either
closing a tab whose stream is fine or restarting one that ended.

The freeze belongs to the wake, not to whoever polls next. The minute alarm, a
manual refresh, a sync pull and a browser restart all reach the same poll, and
while the freeze is on any of them may update what it learned but none may open
or close a tab. Without that the first ordinary poll after a failed wake would
do exactly the damage the freeze was meant to prevent.

## Two computers

Favorites, their per-channel options, and the settings travel between computers
through `chrome.storage.sync`, keyed to the Chrome profile and to the sync name
typed under **Your other computers**. Computers that use the same name share one
set. A different name is a different set, so two groups on one Chrome profile
do not overwrite each other. Leaving the name blank shares nothing. Follows are not
synced: they are a copy of a list Twitch already holds and would consume the
whole quota. Live state, open tabs, activity and points describe one machine at
one moment and mean nothing on the other. **The Twitch login is deliberately
excluded** — sync storage rides on the Google account, and an OAuth token does
not belong there, so each machine connects Twitch separately.

Each favorite syncs as its own item, so two machines editing different channels
never collide, and the later edit wins when they edit the same one. Removals
leave a tombstone: without one, a machine that was switched off during the
removal cannot tell "deleted over there" from "added here", and would hand the
channel back on the next sync. Settings merge as a single item, so two machines
changing different preferences in the same round will lose one of the two —
a real limitation, accepted because settings are edited rarely and almost
always from one machine.

### The extension ID has to match

Chrome namespaces synced data by extension ID, and it derives that ID from the
folder an unpacked extension was loaded from. Two computers therefore load the
same source from two different paths, get two different IDs, and each write into
a bucket the other cannot see — sync appears to do nothing at all.

The `key` in `manifest.json` fixes the ID at
`lofaafmcmpeoaflmfjainbofphpooboa` on every machine. Do not change or remove it,
or the two machines stop matching. The dashboard prints the current ID under
**Your other computers**; if the two computers show different values, nothing
else about sync can work. (The private half of that keypair is not needed to run
the extension and is not in this repo; it only matters if you ever want to sign
a `.crx` with the same ID.)

Changing the ID also orphans whatever the old ID had stored, because that is
where Chrome kept it. The first load after pinning the ID looks like a fresh
install: no favorites, Twitch not connected.

### Export and import

**Export backup** writes favorites and settings to a JSON file; **Import
backup** merges one back in, adding to what is already there rather than
replacing it, with the newer edit winning per channel. It carries data across
the ID change above, moves it between computers if Chrome's own sync will not,
and is a backup worth taking before anything invasive. Like sync, it leaves the
Twitch login out — a token does not belong in the downloads folder.

## Permissions

The extension asks only for tabs, tab groups, storage, alarms, notifications,
and the Twitch hosts it needs to talk to.

## Tests

There is no build step and no dependencies.

With Node installed:

```
node tests/run.js
```

Without Node, serve the folder and open the runner in any Chromium browser:

```
python -m http.server 8000
# then open http://localhost:8000/tests/runner.html
```

The suite covers poll merging and offline-close eligibility, the playback
health state machine and recovery ladder, serialized storage mutations,
migrations, and mocked-Chrome integration for service worker wake, stalled
playback, duplicate-open locking, and message sender authorization. Grouping is
covered for the single group holding under every route into it, and separately
for the periodic sweep: a second group planted from outside the extension is
merged away, a loose stream is pulled back, and a healthy group is left exactly
as the user left it. Duplicate tabs are covered for concurrent requests using
different user ids for one login, a missing `Window.tabs` response, and cleanup
during reconciliation. Player quality is covered for a visible tab refusing a
late 160p pin, and for the page-world lock leaving a manual quality choice
alone once the tab is in front of the user. Mute handling is covered for a
visible pause not remuting the player, and for a click on Twitch's mute
button not being stolen by the unmute watch. Multistream
is covered for opening a single grid tab in an ordinary window, leaving the lurk
tabs untouched, one-audible switching, worker restart recovery, and ending the
session when the grid tab is closed or navigated away. Channel
point claim accounting and 7TV caching, request coalescing and prefetch limits
are covered against a stubbed `fetch`. It also statically verifies that every
relative import resolves and that the manifest lists the content scripts in
dependency order.

## Manual Chrome checklist

Automated tests use a mocked Chrome, so these still need a real browser.

1. **Autoplay and focus return** — star a live channel. The new tab comes to the
   front, reaches *Media playing*, and the tab you were on is restored within a
   few seconds without a reload. Star two at once: they must bootstrap one after
   the other, never together.
2. **Staying alive once hidden** — leave a verified stream alone for ten minutes
   with other tabs in front. It must still be *Media playing*, since the
   restriction is on starting, not continuing.
3. **Twitch SPA navigation** — click through to another channel in a managed
   tab. Health resets, and with *Close raids* on the tab closes; with it off the
   tab is steered back to the original channel.
4. **User unmute** — unmute a managed tab with the speaker icon. It must stay
   audible through the next health check and the next tab reload.
5. **Browser restart** — quit and reopen Chrome. Alarms are recreated once,
   managed tabs are reconciled, and no duplicate tabs or tab groups appear.
6. **Network loss** — disable the network for two poll cycles. The dashboard
   shows the degraded banner, keeps the last known live list, and closes
   nothing. Restoring the network clears the banner.
7. **Multiple windows** — work in a second window while a favorite goes live.
   The stream must not steal that window; it starts off-screen and then joins
   the existing AutoLurk group, still playing. Then drag a managed tab out into a
   window of its own: by the next check it is back in the one group, and only
   one AutoLurk group exists anywhere. Rename a group yourself and the stream
   in it is left where you put it. Then make a second group called `AutoLurk`
   by hand and drop a stream in it, without opening or closing anything: within
   a minute it is merged away and the activity log says so.
8. **Expired session** — revoke the token in Twitch settings. The dashboard
   shows the persistent reconnect banner instead of silently going stale.
9. **Sleep and wake** — with two or more streams open, sleep the machine long
   enough that at least one broadcast ends. On waking, those tabs close on
   their own. Surviving streams are nudged but their tabs must never take over;
   use Retry only if Twitch requires a full reload.
10. **Waking into another app** — wake the machine and switch straight to
    something other than Chrome. AutoLurk must not pull the browser in front of
    what you are doing; wake recovery must not navigate any stream tab.
11. **Second computer** — star a channel on one machine and confirm it appears
    on the other, then unstar it and confirm it does not come back. The Twitch
    connection must remain separate on each.
12. **Multistream** — pick four live channels and start a session. One new tab
    opens in the window you are already in, no new windows, and within about ten
    seconds it is showing four streams in a 2×2 grid with only the first one
    audible. Click another tile: the sound moves to it immediately and no tile
    rebuffers. Check the AutoLurk group behind it — all four lurk tabs are still
    there, still muted, still grouped. Exit, or just close the grid tab: the grid
    goes away and the lurk tabs carry on.
