// Cleanup safety policy. Numbers come from published X behavior, not vibes:
// the dev forum puts machine-speed clicking under ~12s between actions,
// free accounts hitting 30-50 follows/unfollows per hour earn cooldowns,
// and the hard technical ceiling sits near 400/day. Everything below stays
// far from all three: jittered gaps (never fixed intervals, the classic bot
// signature), session chunking with long breaks, and a trust ladder for days.
export const CLEANUP = {
  dailyCapDefault: 20,
  dailyCapMax: 50,
  // seconds between real unfollows, jittered per action
  delayMinSec: 25,
  delayMaxSec: 45,
  // actions per continuous session, then a long break with auto-resume
  sessionMax: 25,
  breakMinSec: 30 * 60,
  breakMaxSec: 60 * 60,
  // trust ladder: consecutive clean days raise the daily allowance
  paceCaps: [40, 60, 80, 100],
  paceHourly: 30,
  // dry runs move fast since they click nothing
  dryRunDelayMinSec: 2,
  dryRunDelayMaxSec: 5,
  scanPasses: 40,
};

export function jitterDelaySec(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

// Non-followbacks first, verified last (verified get a second look).
export function sortCleanup(rows) {
  return [...rows].sort((a, b) => {
    if (a.followsBack !== b.followsBack) return a.followsBack ? 1 : -1;
    if (!!a.verified !== !!b.verified) return a.verified ? 1 : -1;
    return String(a.handle || "").localeCompare(String(b.handle || ""));
  });
}

export function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
