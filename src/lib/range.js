// Pure stat helpers shared by popup and dashboard. No DOM here.
export function cutoffISO(days, now = Date.now()) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function sumImpressions(rows) {
  return rows.reduce((a, r) => a + (r.impressions || r.views || 0), 0);
}

export function totals(posts) {
  const t = {
    views: 0,
    likes: 0,
    reposts: 0,
    replies: 0,
    bookmarks: 0,
    posts: posts.length,
  };
  for (const p of posts) {
    t.views += p.views || 0;
    t.likes += p.likes || 0;
    t.reposts += p.reposts || 0;
    t.replies += p.replies || 0;
    t.bookmarks += p.bookmarks || 0;
  }
  t.engagements = t.likes + t.reposts + t.replies + t.bookmarks;
  t.engagementRate = t.views ? (t.engagements / t.views) * 100 : 0;
  t.avgViews = t.posts ? t.views / t.posts : 0;
  return t;
}

// Group posts by postedAt day. Returns [{date, views, likes, ...}]
export function dailySeries(posts, days = 90) {
  const map = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    map.set(d, { date: d, views: 0, likes: 0, reposts: 0, replies: 0, posts: 0 });
  }
  for (const p of posts) {
    if (!p.postedAt) continue;
    const d = p.postedAt.slice(0, 10);
    const row = map.get(d);
    if (!row) continue;
    row.views += p.views || 0;
    row.likes += p.likes || 0;
    row.reposts += p.reposts || 0;
    row.replies += p.replies || 0;
    row.posts += 1;
  }
  return [...map.values()];
}

// Compare last N days to previous N days by postedAt.
export function delta(posts, days = 28) {
  const now = Date.now();
  const cur = posts.filter((p) => p.postedAt && now - new Date(p.postedAt).getTime() <= days * 864e5);
  const prev = posts.filter(
    (p) =>
      p.postedAt &&
      now - new Date(p.postedAt).getTime() > days * 864e5 &&
      now - new Date(p.postedAt).getTime() <= 2 * days * 864e5
  );
  const pct = (c, p) => (p ? ((c - p) / p) * 100 : c ? 100 : 0);
  const tc = totals(cur);
  const tp = totals(prev);
  return {
    views: pct(tc.views, tp.views),
    engagements: pct(tc.engagements, tp.engagements),
    followers: null, // filled from profile series when available
  };
}

export function topPosts(posts, key = "views", n = 10) {
  return [...posts].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, n);
}

export function bestHours(posts) {
  // 0-23 histogram of avg views, tells you when to post
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, views: 0, posts: 0 }));
  for (const p of posts) {
    if (!p.postedAt) continue;
    const h = new Date(p.postedAt).getHours();
    hours[h].views += p.views || 0;
    hours[h].posts += 1;
  }
  return hours.map((r) => ({ ...r, avg: r.posts ? r.views / r.posts : 0 }));
}

export function followerDelta(profiles) {
  if (profiles.length < 2) return null;
  const first = profiles[0].followers;
  const last = profiles[profiles.length - 1].followers;
  if (first == null || last == null) return null;
  return { first, last, change: last - first, pct: first ? ((last - first) / first) * 100 : 0 };
}

// Scope split: "mine" = only the owner's posts, "all" = everything tracked.
// The handle can live in post.handle or be derived from the post URL
// (old saves and fallback scrapes stored no handle). Truly untagged posts
// display as mine so legacy profile syncs do not vanish.
export function effectiveHandle(post) {
  if (post?.handle) return String(post.handle);
  const m = String(post?.url || "").match(/x\.com\/([^/?#]+)\/status/i);
  if (m) return m[1];
  const m2 = String(post?.url || "").match(/twitter\.com\/([^/?#]+)\/status/i);
  if (m2) return m2[1];
  return null;
}

export function isMine(post, ownerHandle) {
  if (!ownerHandle) return true;
  const h = effectiveHandle(post);
  if (!h) return true;
  return h.toLowerCase() === String(ownerHandle).toLowerCase();
}

export function filterScope(posts, scope, ownerHandle) {
  if (scope === "all") return posts;
  return posts.filter((p) => isMine(p, ownerHandle));
}

export const fmt = {
  int: (n) => (n == null ? "-" : Number(n).toLocaleString("en-US")),
  pct: (n) => (n == null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`),
  rate: (n) => `${(n || 0).toFixed(2)}%`,
};
