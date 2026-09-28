# AutoLurk Companion

Chrome extension that keeps favorite Twitch streams open in the background.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** and select this folder

Connect Twitch from the dashboard. Sign in on each computer. The Twitch login is not synced.

## What you get

- Live favorites open as background tabs in one **AutoLurk** group. The tab you are using stays in front.
- The player stays unmuted. The Chrome tab is muted.
- Background tabs play at 160p. The tab you are looking at plays at 1080p.
- Tabs close when the stream ends or raids away. A tab you close yourself stays closed until the next broadcast.
- Channel point bonus chests are claimed. Nothing is spent.
- Expiring watch streaks open a recovery clip or VOD, in front by default, and that tab closes when Twitch clears the expiration.
- **Live → Multistream** shows two to four live channels in one tab. The background tabs keep running.
- 7TV emotes for live favorites show under **Details**.

## Other computers

Under **Settings → Your other computers**, turn sync on and set a **Sync name**. Computers on the same Chrome profile that use that exact name share favorites and settings. A different name is a separate set. Leave it blank to keep everything on this computer.

Both computers have to show the same extension ID on that page. Do not change or remove the `key` in `manifest.json`.

**Export backup** and **Import backup** move favorites and settings in a file. The Twitch login is left out.

## Updates

Chrome will not update an extension loaded from a folder.

**Settings → Updates** takes a public GitHub repository with this extension at the root. This one is https://github.com/the-mrsir/autolurk. Save it and click **Check for updates** once so Chrome can reach GitHub. After that it checks about twice a day.

When the repo's `manifest.json` version is higher, **Update** appears. The first time, choose the folder you loaded. The extension reloads itself.

To publish an update, raise `version` in `manifest.json` and `package.json` and push.

## Tests

```
node tests/run.js
```
