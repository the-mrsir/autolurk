// Which stream a server machine opens next, and whether a probe counts as
// playing. Pure so the rotation can be tested without opening a tab.

export function nextServerTarget(entries, lastTabId) {
  const ordered = [...entries]
    .filter((entry) => entry && (entry.expectedChannel || entry.login))
    .sort((a, b) => Number(a.tabId) - Number(b.tabId));
  if (!ordered.length) return null;
  const index = ordered.findIndex((entry) => Number(entry.tabId) === Number(lastTabId));
  return ordered[(index + 1) % ordered.length];
}

// A visible player that is advancing, or a preroll that is actually playing.
// A hidden report is not a confirmation: the tab was not on screen, so a
// reload would sit there without a media source.
export function serverReportWorking(report) {
  if (!report || typeof report !== "object") return false;
  if (report.hidden === true) return false;
  if (report.hasVideo === false) return false;
  if (report.adPlaying === true) return Boolean(report.playing);
  return Boolean(report.playing) && Number(report.currentTime) > 0;
}
