# AutoLurk Companion

Chrome extension that keeps favorite Twitch streams open in the background.

## Install

1. On the GitHub page, click **Code**, then **Download ZIP**
2. Unzip it. Open the folder inside (the one that contains `manifest.json`)
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select that folder

Connect Twitch from the dashboard. Sign in on each computer. The Twitch login is not synced.

## What you get

- Live favorites open as background tabs in one **AutoLurk** group. The tab you are using stays in front, unless **Open streams in front** is set to favorites or all. If Chrome opens that group from another signed-in computer, this computer uses that group.
- **Server rotation** opens the next stream every 2 minutes, reloads it if it is not playing, and checks again. It stays on this computer.
- The player stays unmuted. The Chrome tab is muted.
- Background tabs and the stream you are looking at each have a quality setting. They start at 160p and 1080p.
- Tabs close when the stream ends or raids away. A tab you close yourself stays closed until the next broadcast.
- Channel point bonus chests are claimed. Nothing is spent.
- Expiring watch streaks open a recovery clip or VOD, in front by default, and that tab closes when Twitch clears the expiration.
- **Live → Multistream** shows two to four live channels in one tab. The background tabs keep running.
- 7TV emotes for live favorites show under **Details**.

## Other computers

Each computer makes its own sync code, shown under **Settings → Your other computers**. Computers on the same Chrome profile share favorites and settings when they use the same code. Copy the code from one computer and paste it into the other, then save.

Both computers have to show the same extension ID on that page. Do not change or remove the `key` in `manifest.json`.

**Export backup** and **Import backup** move favorites and settings in a file. The Twitch login is left out.

## Updates

Chrome will not update an extension loaded from a folder.

**Settings → Updates** is pointed at https://github.com/the-mrsir/autolurk. Click **Check for updates** once so Chrome can reach GitHub. After that it checks about twice a day.

When the repo version is higher, pull this folder if it is the git checkout, or replace the folder, then click Reload on chrome://extensions. Chrome will not write the files in for you.

To publish an update, raise `version` in `manifest.json` and `package.json` and push.

## Tests

```
node tests/run.js
```
