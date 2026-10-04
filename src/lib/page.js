// URL page-type detection for x.com. Shared by popup and background
// so both agree on what counts as a profile page.
export const RESERVED = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "bookmarks",
  "lists",
  "communities",
  "jobs",
  "settings",
  "search",
  "i",
  "compose",
  "login",
  "signup",
  "logout",
  "tos",
  "privacy",
  "about",
  "download",
  "hashtag",
  "intent",
  "share",
  "account",
  "oauth",
]);

// Returns { kind: "profile" | "post" | "home" | "other", handle, tab }
export function describePage(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return { kind: "other", handle: null };
  }
  if (!/^(x\.com|twitter\.com|mobile\.twitter\.com)$/i.test(u.hostname)) {
    return { kind: "other", handle: null };
  }
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 0 || segs[0].toLowerCase() === "home") {
    return { kind: "home", handle: null };
  }
  const [first, second, third] = segs;
  const low = first.toLowerCase();
  if (RESERVED.has(low)) return { kind: "other", handle: null };
  if (second === "status" && third) return { kind: "post", handle: first };
  if (second && ["followers", "following", "media", "likes", "lists", "highlights", "articles", "with_replies", "verified_followers"].includes(second.toLowerCase())) {
    return { kind: "profile", handle: first, tab: second.toLowerCase() };
  }
  if (segs.length === 1) return { kind: "profile", handle: first };
  return { kind: "other", handle: first };
}
