// Storage model:
//  post:<id> -> latest post record {id, url, handle, kind, views, likes, ...}
//  profile:snapshot:<handle>:<yyyy-mm-dd> -> {date, followers, following, postCount, handle} (legacy keys without handle still read)
//  sync:<yyyy-mm-dd> -> {date, postIds, totals, profile}
//  rel:<handle> -> {handle, name, followsBack, verified, firstSeen, lastSeen}
//  ownerHandle -> string, the user's own X handle. First synced profile wins, switch via Make Personal / dashboard override.
//  whitelist -> [handle-lower], never queued for unfollow
//  unfollowLog -> [{handle, date, dryRun, ok, reason}], capped at 200
//  unfollow:count:<yyyy-mm-dd> -> number of real unfollows that day
//  cleanupSettings -> {cap, dryRun}
// No data leaves the browser.

import { describePage } from "../lib/page.js";
import { CLEANUP, todayKey } from "../lib/cleanup.js";

const RETENTION_DAYS = 120;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  route(msg).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

async function route(msg) {
  switch (msg.type) {
    case "XSTATS_SAVE_SCRAPE":
      return saveScrape(msg.payload);
    case "XSTATS_GET_DASHBOARD":
      return getDashboard(msg.days ?? 90);
    case "XSTATS_EXPORT_CSV":
      return exportCsv(msg.days ?? 90, msg.scope ?? "mine", msg.ownerHandle);
    case "XSTATS_SET_OWNER":
      return setOwner(msg.handle);
    case "XSTATS_DROP_REL":
      return dropRel(msg.handles || []);
    case "XSTATS_RESET_REL":
      return resetRel();
    case "XSTATS_RESET_SCOPE":
      return resetScope(msg.scope ?? "mine", msg.ownerHandle);
    case "XSTATS_RESET_ALL":
      return resetAll();
    case "XSTATS_SAVE_REL":
      return saveRel(msg.payload);
    case "XSTATS_GET_CLEANUP":
      return getCleanup(msg.handle);
    case "XSTATS_SET_WHITELIST":
      await chrome.storage.local.set({ whitelist: (msg.handles || []).map((h) => String(h).toLowerCase()) });
      return { ok: true };
    case "XSTATS_SET_CLEANUP_SETTINGS":
      return setCleanupSettings(msg.settings || {});
    case "XSTATS_CAN_UNFOLLOW":
      return canUnfollow();
    case "XSTATS_LOG_UNFOLLOW":
      return logUnfollow(msg.payload || {});
    case "XSTATS_IMPORT_POSTS":
      return importPosts(msg.rows || []);
    case "XSTATS_GET_RANGE": // back-compat with 0.1 popup
      return getRange(msg.days ?? 90);
    case "XSTATS_SAVE_SNAPSHOT":
      return saveLegacySnapshot(msg.payload);
    default:
      return { error: "unknown message" };
  }
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function saveScrape(payload = {}) {
  const { posts = [], profile = null, scrapedAt = new Date().toISOString(), pageUrl = "" } = payload || {};
  if (!Array.isArray(posts)) return { error: "no posts array in payload" };
  const date = dayKey(new Date(scrapedAt));
  const toSet = {};

  // Backfill missing handles when the scrape came from a profile page.
  // Fallback scraper and old saves have no handle, without this they all leak into Personal.
  const page = describePage(pageUrl);
  const fillHandle = page.kind === "profile" ? page.handle : profile?.handle || null;

  // batch read previous posts in one call, keeps service worker alive
  const keys = posts.filter((p) => p?.id).map((p) => `post:${p.id}`);
  const prevAll = keys.length ? await chrome.storage.local.get(keys) : {};

  for (const p of posts) {
    if (!p?.id) continue;
    const key = `post:${p.id}`;
    const prev = prevAll[key];
    const handle = p.handle || prev?.handle || fillHandle || null;
    toSet[key] = {
      ...(prev || {}),
      ...p,
      handle,
      views: Math.max(prev?.views || 0, p.views || 0),
      likes: Math.max(prev?.likes || 0, p.likes || 0),
      reposts: Math.max(prev?.reposts || 0, p.reposts || 0),
      replies: Math.max(prev?.replies || 0, p.replies || 0),
      bookmarks: Math.max(prev?.bookmarks || 0, p.bookmarks || 0),
      engagements: Math.max(
        prev?.engagements || 0,
        (p.likes || 0) + (p.reposts || 0) + (p.replies || 0) + (p.bookmarks || 0)
      ),
      firstSeen: prev?.firstSeen || scrapedAt,
      lastSeen: scrapedAt,
    };
  }

  if (profile && (profile.handle || profile.followers != null || profile.following != null || profile.postCount != null)) {
    const snapHandle = String(profile.handle || fillHandle || "unknown").toLowerCase();
    toSet[`profile:snapshot:${snapHandle}:${date}`] = { date, ...profile, scrapedAt };
  }

  toSet[`sync:${date}`] = {
    date,
    scrapedAt,
    postIds: posts.map((p) => p.id),
    totals: sumPosts(posts),
    profile,
  };

  await chrome.storage.local.set(toSet);
  // Owner resolution:
  // - first profile sync wins (initial setup)
  // - syncing your OWN profile (Edit profile button present) auto-switches Personal to it.
  //   This covers X account switches without hijacking when you sync someone else's profile for All.
  // - manual switch always available via Make Personal (popup) or dashboard override.
  const switchHandle = profile?.isOwnProfile ? (profile.handle || fillHandle) : null;
  if (switchHandle) {
    const { ownerHandle } = await chrome.storage.local.get("ownerHandle");
    if (!ownerHandle || String(ownerHandle).toLowerCase() !== String(switchHandle).toLowerCase()) {
      await chrome.storage.local.set({ ownerHandle: switchHandle });
    }
  } else if (profile?.handle) {
    const { ownerHandle } = await chrome.storage.local.get("ownerHandle");
    if (!ownerHandle) await chrome.storage.local.set({ ownerHandle: profile.handle });
  }
  await prune();
  const { ownerHandle } = await chrome.storage.local.get("ownerHandle");
  return { ok: true, saved: posts.length, date, profile, ownerHandle: ownerHandle || profile?.handle || null };
}

function sumPosts(posts) {
  return {
    views: posts.reduce((a, p) => a + (p.views || 0), 0),
    likes: posts.reduce((a, p) => a + (p.likes || 0), 0),
    reposts: posts.reduce((a, p) => a + (p.reposts || 0), 0),
    replies: posts.reduce((a, p) => a + (p.replies || 0), 0),
    bookmarks: posts.reduce((a, p) => a + (p.bookmarks || 0), 0),
  };
}

async function allPosts() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith("post:"))
    .map(([, v]) => v);
}

async function profileSeries() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith("profile:snapshot:"))
    .map(([, v]) => v)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function getDashboard(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = await allPosts();
  const handleTotals = {};
  for (const p of all) {
    const h = effectiveHandle(p);
    const k = (h || "").toLowerCase() || "~untagged";
    handleTotals[k] = (handleTotals[k] || 0) + 1;
  }
  const posts = all.filter((p) => {
    if (!p.postedAt) return true; // keep undated scrapes visible
    return new Date(p.postedAt).getTime() >= cutoff;
  });
  const allProfiles = (await profileSeries()).filter(
    (p) => new Date(p.date).getTime() >= cutoff - 7 * 24 * 60 * 60 * 1000
  );
  const syncs = await syncSeries(days);
  const { ownerHandle: storedOwner } = await chrome.storage.local.get("ownerHandle");
  const owner = storedOwner || allProfiles.at(-1)?.handle || null;
  // Scope follower history to the owner. Without this, switching accounts
  // mixes both profiles' snapshots and the delta + follower card go wrong.
  // Legacy snapshots with no handle are kept (unattributable).
  const profiles = owner
    ? allProfiles.filter((p) => !p.handle || String(p.handle).toLowerCase() === String(owner).toLowerCase())
    : allProfiles;
  // Latest snapshot per handle, unscoped: lets any profile page show its
  // follower count even though the history series stays owner-scoped.
  const profileByHandle = {};
  for (const p of await profileSeries()) {
    if (p?.handle) profileByHandle[String(p.handle).toLowerCase()] = p;
  }
  // Owner-scoped totals so the Personal empty-state never quotes the other account's count.
  const totalMine = owner ? all.filter((p) => isMinePost(p, owner)).length : all.length;
  return { posts, totalPosts: all.length, totalMine, handleTotals, profiles, profileByHandle, syncs, days, ownerHandle: owner, generatedAt: new Date().toISOString() };
}

async function syncSeries(days) {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return Object.entries(all)
    .filter(([k]) => k.startsWith("sync:"))
    .map(([, v]) => v)
    .filter((v) => new Date(v.date).getTime() >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function getRange(days) {
  const syncs = await syncSeries(days);
  return { rows: syncs.map((s) => ({ date: s.date, impressions: s.totals?.views || 0 })) };
}

async function saveLegacySnapshot(payload) {
  const date = payload.date || dayKey();
  await chrome.storage.local.set({
    [`sync:${date}`]: {
      date,
      scrapedAt: new Date().toISOString(),
      postIds: (payload.posts || []).map((p) => p.id),
      totals: {
        views: payload.impressions || 0,
        likes: 0,
        reposts: 0,
        replies: 0,
        bookmarks: 0,
      },
    },
  });
  if (payload.posts?.length) {
    await saveScrape({ posts: payload.posts, scrapedAt: new Date().toISOString() });
  }
  return { ok: true };
}

function toCsv(posts) {
  const head = "id,url,postedAt,views,likes,reposts,replies,bookmarks,engagements,text";
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = posts.map((p) =>
    [p.id, p.url, p.postedAt, p.views, p.likes, p.reposts, p.replies, p.bookmarks, p.engagements, p.text]
      .map(esc)
      .join(",")
  );
  return [head, ...lines].join("\n");
}

async function exportCsv(days, scope = "mine", ownerHandle = null) {
  const { posts } = await getDashboard(days);
  const owner = ownerHandle || (await chrome.storage.local.get("ownerHandle")).ownerHandle;
  const scoped = scope === "all" ? posts : posts.filter((p) => isMinePost(p, owner));
  return { csv: toCsv(scoped), count: scoped.length };
}

function effectiveHandle(post) {
  if (post?.handle) return String(post.handle);
  const m = String(post?.url || "").match(/x\.com\/([^/?#]+)\/status/i);
  if (m) return m[1];
  const m2 = String(post?.url || "").match(/twitter\.com\/([^/?#]+)\/status/i);
  if (m2) return m2[1];
  return null;
}

function isMinePost(post, owner) {
  if (!owner) return true;
  const h = effectiveHandle(post);
  if (!h) return true;
  return h.toLowerCase() === String(owner).toLowerCase();
}

function matchMine(post, owner) {
  return isMinePost(post, owner);
}

async function resetScope(scope = "mine", ownerHandle = null) {
  const owner = ownerHandle || (await chrome.storage.local.get("ownerHandle")).ownerHandle;
  if (scope === "mine" && !owner) return { error: "Set the owner handle first, otherwise Mine means everything." };
  const all = await chrome.storage.local.get(null);
  const remove = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("post:")) continue;
    if (scope === "mine") {
      // remove what Mine displays: definitive mine + untagged legacy
      if (isMinePost(v, owner)) remove.push(k);
    } else {
      // timeline reset removes only definitive others, never untagged legacy
      const h = effectiveHandle(v);
      if (h && owner && h.toLowerCase() !== String(owner).toLowerCase()) remove.push(k);
    }
  }
  if (remove.length) await chrome.storage.local.remove(remove);
  return { ok: true, removed: remove.length, scope };
}

async function saveRel(payload = {}) {
  const { rows = [] } = payload || {};
  if (!Array.isArray(rows)) return { error: "no rows array" };
  const now = new Date().toISOString();
  const { ownerHandle } = await chrome.storage.local.get("ownerHandle");
  // Rows belong to the scanned profile, not to whatever owner is saved.
  const stamp = payload.handle || ownerHandle || null;
  const keys = rows.filter((r) => r?.handle).map((r) => `rel:${String(r.handle).toLowerCase()}`);
  const prevAll = keys.length ? await chrome.storage.local.get(keys) : {};
  const toSet = {};
  for (const r of rows) {
    if (!r?.handle) continue;
    const key = `rel:${String(r.handle).toLowerCase()}`;
    const prev = prevAll[key];
    toSet[key] = {
      handle: r.handle,
      name: r.name || prev?.name || null,
      followsBack: !!r.followsBack,
      verified: !!r.verified || !!prev?.verified,
      owner: stamp || prev?.owner || null,
      firstSeen: prev?.firstSeen || now,
      lastSeen: now,
    };
  }
  await chrome.storage.local.set(toSet);
  const relTotal = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("rel:")).length;
  return { ok: true, saved: Object.keys(toSet).length, total: relTotal };
}

async function getCleanupSettings() {
  const { cleanupSettings } = await chrome.storage.local.get("cleanupSettings");
  return {
    cap: Math.min(Math.max(cleanupSettings?.cap ?? CLEANUP.dailyCapDefault, 1), CLEANUP.dailyCapMax),
    dryRun: cleanupSettings?.dryRun ?? true,
  };
}

async function setCleanupSettings(s) {
  const cur = await getCleanupSettings();
  const next = {
    cap: s.cap != null ? Math.min(Math.max(Number(s.cap) || cur.cap, 1), CLEANUP.dailyCapMax) : cur.cap,
    dryRun: s.dryRun != null ? !!s.dryRun : cur.dryRun,
  };
  await chrome.storage.local.set({ cleanupSettings: next });
  return { ok: true, settings: next };
}

// Automatic safe pace. No user-facing cap input: the daily allowance grows
// with consecutive clean days and collapses on any X warning.
// Published tripwires sit near 400 actions/day, 30-50/hour cooldowns, and
// sub-12s machine clicking, so even the top level (100/day, 25-45s jittered
// gaps, 30/hour burst guard, session breaks) stays well below them.
const PACE_CAPS = CLEANUP.paceCaps;
const PACE_HOURLY = CLEANUP.paceHourly;

function trustLevel(log) {
  const days = {};
  for (const e of log || []) {
    if (e?.dryRun) continue;
    const d = String(e.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    days[d] = days[d] || { done: 0, warned: false };
    if (e.ok) days[d].done++;
    else days[d].warned = true;
  }
  let streak = 0;
  const cursor = new Date();
  const key = (dt) => dt.toISOString().slice(0, 10);
  const today = days[key(cursor)];
  if (!(today && today.done > 0 && !today.warned)) cursor.setDate(cursor.getDate() - 1);
  for (let i = 0; i < 30; i++) {
    const d = days[key(cursor)];
    if (d && d.done > 0 && !d.warned) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else break;
  }
  return Math.min(4, streak);
}

async function getPace() {
  const all = await chrome.storage.local.get(["unfollowLog", "cooldownUntil", `unfollow:count:${todayKey()}`]);
  const log = all.unfollowLog || [];
  const level = trustLevel(log);
  const cap = PACE_CAPS[level];
  const doneToday = all[`unfollow:count:${todayKey()}`] || 0;
  const hourAgo = Date.now() - 3600e3;
  const hourDone = log.filter((e) => !e?.dryRun && e?.ok && new Date(e.date).getTime() >= hourAgo).length;
  const cooling = (all.cooldownUntil || 0) > Date.now();
  return { cap, level, doneToday, hourDone, cooling };
}

async function getCleanup(handleParam) {
  const all = await chrome.storage.local.get(null);
  const { ownerHandle: storedOwner } = await chrome.storage.local.get("ownerHandle");
  const owner = handleParam || storedOwner || null;
  // The list follows an explicit context handle (the profile being cleaned).
  // Anything stamped for someone else, or unstamped from before stamping,
  // stays out. One fresh scan repopulates cleanly.
  const rels = Object.entries(all)
    .filter(([k]) => k.startsWith("rel:"))
    .map(([, v]) => v)
    .filter((r) => !owner || (r.owner && String(r.owner).toLowerCase() === String(owner).toLowerCase()));
  const settings = await getCleanupSettings();
  const pace = await getPace();
  return {
    rels,
    whitelist: all.whitelist || [],
    log: (all.unfollowLog || []).slice(-50),
    ownerHandle: storedOwner || null,
    handle: owner,
    settings,
    doneToday: pace.doneToday,
    pace,
  };
}

// Changing accounts wipes account-scoped relationship state so the new
// account never inherits the old one's following list, log, or counters.
async function setOwner(handle) {
  const next = (handle || "").replace(/^@/, "").trim() || null;
  const { ownerHandle: prev } = await chrome.storage.local.get("ownerHandle");
  await chrome.storage.local.set({ ownerHandle: next });
  const switched = !!prev && !!next && prev.toLowerCase() !== next.toLowerCase();
  if (switched) {
    const all = await chrome.storage.local.get(null);
    const remove = Object.keys(all).filter(
      (k) => k.startsWith("rel:") || k.startsWith("unfollow:count:") || k === "unfollowLog" || k === "scan" || k === "relScan" || k === "unfollowStatus"
    );
    if (remove.length) await chrome.storage.local.remove(remove);
  }
  return { ok: true, switched };
}

async function dropRel(handles) {
  const keys = (handles || []).map((h) => `rel:${String(h).toLowerCase()}`);
  if (keys.length) await chrome.storage.local.remove(keys);
  return { ok: true, removed: keys.length };
}

// Every scan starts from an empty list so stale rows from interrupted or
// older scans can never inflate the count. Rescanning repopulates fully.
async function resetRel() {
  const all = await chrome.storage.local.get(null);
  const remove = Object.keys(all).filter((k) => k.startsWith("rel:"));
  if (remove.length) await chrome.storage.local.remove(remove);
  return { ok: true, removed: remove.length };
}

// Gate checked before every real unfollow. Counts here so a killed
// worker can never overshoot the cap on resume.
async function canUnfollow() {
  const pace = await getPace();
  if (pace.cooling) return { allowed: false, reason: "cooldown", ...pace };
  if (pace.doneToday >= pace.cap) return { allowed: false, reason: "cap", ...pace };
  if (pace.hourDone >= PACE_HOURLY) return { allowed: false, reason: "hour", ...pace };
  return { allowed: true, reason: null, ...pace };
}

async function logUnfollow({ handle, dryRun = false, ok = true, reason = null }) {
  if (!handle) return { error: "no handle" };
  const all = await chrome.storage.local.get(["unfollowLog", `unfollow:count:${todayKey()}`]);
  const log = all.unfollowLog || [];
  log.push({ handle, date: new Date().toISOString(), dryRun: !!dryRun, ok: !!ok, reason });
  const toSet = { unfollowLog: log.slice(-200) };
  if (!dryRun && !ok && reason === "rate warning") {
    // Any X warning drops trust to zero and pauses a full day.
    toSet.cooldownUntil = Date.now() + 24 * 3600e3;
  }
  if (!dryRun && ok) {
    const key = `unfollow:count:${todayKey()}`;
    toSet[key] = (all[key] || 0) + 1;
    // remove the relationship row, it is no longer someone you follow
    await chrome.storage.local.remove(`rel:${String(handle).toLowerCase()}`);
  }
  await chrome.storage.local.set(toSet);
  return { ok: true };
}

// Bulk import, e.g. rows parsed from X analytics CSV exports.
// Upserts by tweet id, keeps max metrics, fills postedAt when missing.
async function importPosts(rows) {
  if (!Array.isArray(rows)) return { error: "no rows array" };
  const clean = rows.filter((r) => r?.id);
  if (!clean.length) return { ok: true, imported: 0 };
  const now = new Date().toISOString();
  const keys = clean.map((r) => `post:${r.id}`);
  const prevAll = await chrome.storage.local.get(keys);
  const toSet = {};
  for (const r of clean) {
    const key = `post:${r.id}`;
    const prev = prevAll[key];
    const url = r.url || prev?.url || `https://x.com/i/status/${r.id}`;
    // The permalink author beats the import-time owner: CSVs are exported per
    // account, but the owner may have changed since. Never trust "/i/".
    const urlHandle = (String(url).match(/\/([^/?#]+)\/status\//) || [])[1] || null;
    const authorHandle = urlHandle && urlHandle.toLowerCase() !== "i" ? urlHandle : null;
    toSet[key] = {
      ...(prev || {}),
      id: r.id,
      url,
      handle: authorHandle || r.handle || prev?.handle || null,
      views: Math.max(prev?.views || 0, r.views || 0),
      likes: Math.max(prev?.likes || 0, r.likes || 0),
      reposts: Math.max(prev?.reposts || 0, r.reposts || 0),
      replies: Math.max(prev?.replies || 0, r.replies || 0),
      bookmarks: Math.max(prev?.bookmarks || 0, r.bookmarks || 0),
      engagements: Math.max(
        prev?.engagements || 0,
        (r.likes || 0) + (r.reposts || 0) + (r.replies || 0) + (r.bookmarks || 0)
      ),
      postedAt: prev?.postedAt || r.postedAt || null,
      text: prev?.text || r.text || null,
      source: prev?.source || r.source || "analytics-csv",
      firstSeen: prev?.firstSeen || now,
      lastSeen: now,
    };
  }
  await chrome.storage.local.set(toSet);
  return { ok: true, imported: Object.keys(toSet).length };
}

async function resetAll() {
  // Account switch helper. Wipes posts, snapshots, relationships, logs, scan state.
  // Keeps owner handle, theme, whitelist, and cleanup settings.
  const all = await chrome.storage.local.get(null);
  const remove = Object.keys(all).filter(
    (k) =>
      k.startsWith("post:") ||
      k.startsWith("profile:snapshot:") ||
      k.startsWith("sync:") ||
      k.startsWith("rel:") ||
      k.startsWith("unfollow:count:") ||
      k === "unfollowLog" ||
      k === "scan" ||
      k === "relScan" ||
      k === "unfollowStatus"
  );
  if (remove.length) await chrome.storage.local.remove(remove);
  return { ok: true, removed: remove.length };
}

async function prune() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(all)) {
    const d = v?.date || v?.postedAt || v?.lastSeen;
    if (d && new Date(d).getTime() < cutoff && (k.startsWith("sync:") || k.startsWith("profile:snapshot:"))) {
      await chrome.storage.local.remove(k);
    }
  }
}
