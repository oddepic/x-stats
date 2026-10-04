import { totals, followerDelta, filterScope, effectiveHandle, fmt } from "../lib/range.js";
import { describePage } from "../lib/page.js";
import { CLEANUP, sortCleanup } from "../lib/cleanup.js";

const $ = (id) => document.getElementById(id);
const daysEl = $("days");

// theme: same behavior as tracking-browser. Stored pref wins, else OS.
const themeBtn = $("theme");
async function initTheme() {
  const { theme } = await chrome.storage.local.get(["theme"]);
  const initial = theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  // x-stats defaults to dark on first run even if OS is light
  document.documentElement.dataset.theme = theme || "dark";
  themeBtn.setAttribute("aria-label", document.documentElement.dataset.theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
}
themeBtn.addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  themeBtn.setAttribute("aria-label", next === "dark" ? "Switch to light mode" : "Switch to dark mode");
  await chrome.storage.local.set({ theme: next });
});
await initTheme();

async function refresh() {
  const days = Number(daysEl.value);
  let data = null;
  try {
    data = await chrome.runtime.sendMessage({ type: "XSTATS_GET_DASHBOARD", days });
  } catch (_) {
    data = null;
  }
  if (!data || data.error) {
    $("status").textContent = "Background unreachable. Reload the extension in brave://extensions.";
    return;
  }
  const { scope } = await chrome.storage.local.get("scope");
  const activeScope = scope || "mine";
  const personal = activeScope !== "all";
  $("scopeMine").className = personal ? "" : "ghost";
  $("scopeAll").className = personal ? "ghost" : "";
  $("statFol").style.display = "";
  // Context wins: on a profile or post page, show THAT handle's stats,
  // never the saved owner. Everywhere else the scope buttons apply.
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    tab = null;
  }
  const page = describePage(tab?.url || "");
  const ctxHandle = (page.kind === "profile" || page.kind === "post") && page.handle
    ? page.handle.toLowerCase()
    : null;
  const { profiles } = data;
  const ownerSnap = [...profiles].reverse().find((p) => p.following != null);
  clOwnerFollowing = ownerSnap?.following ?? null;
  let posts;
  let folSnapshots = profiles;
  if (ctxHandle) {
    posts = data.posts.filter((p) => (effectiveHandle(p) || "").toLowerCase() === ctxHandle);
    folSnapshots = profiles.filter((p) => (p.handle || "").toLowerCase() === ctxHandle);
  } else {
    posts = filterScope(data.posts, activeScope, data.ownerHandle);
  }
  const rangeName = daysEl.options[daysEl.selectedIndex].text;
  const warn = $("rangeWarn");
  const totalMine = data.totalMine ?? data.totalPosts ?? 0;
  const totalsByHandle = data.handleTotals || {};
  // Only warn when there is genuinely nothing to analyze in range.
  // A handle with posts saved outside the range names the real cause,
  // and a handle with nothing saved at all gets a sync prompt instead.
  const ctxSaved = ctxHandle ? totalsByHandle[ctxHandle] || 0 : 0;
  const showWarn = posts.length === 0 && (ctxHandle
    ? ctxSaved > 0 ? days < 36500 : (data.totalPosts || 0) > 0
    : days < 36500 && (activeScope === "all" ? (data.totalPosts || 0) > 0 : totalMine > 0));
  if (showWarn) {
    $("rangeWarnText").textContent = ctxHandle
      ? ctxSaved > 0
        ? `No posts for @${page.handle} in the last ${rangeName}, but ${ctxSaved} saved overall. They fall outside this range.`
        : `Nothing saved for @${page.handle} yet. Sync their profile to start tracking.`
      : activeScope === "all"
      ? `No posts in the last ${rangeName}, but ${data.totalPosts} are saved overall. They fall outside this range.`
      : `No personal posts in the last ${rangeName}, but ${totalMine} personal are tracked overall. They fall outside this range.`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  // Empty state replaces the zero cards: nothing saved for this view at all.
  const empty = posts.length === 0 && (ctxHandle ? ctxSaved === 0 : (data.totalPosts || 0) === 0);
  if (empty) {
    warn.hidden = true;
    $("statGrid").hidden = true;
    $("syncRow").hidden = true;
    $("emptyState").hidden = false;
    $("emptyTitle").textContent = ctxHandle ? `No data tracked for @${page.handle} yet` : "No data tracked yet";
    $("emptyText").textContent = ctxHandle
      ? "Sync their profile to start tracking."
      : "Open an X profile and sync to start tracking.";
    $("emptySync").textContent = ctxHandle ? `Sync @${page.handle}` : "Sync this page";
    $("modStatsLine").textContent = ctxHandle ? `@${page.handle} · not tracked yet` : "Not tracked yet";
    await updateContext(data.ownerHandle, page);
    return;
  }
  $("statGrid").hidden = false;
  $("syncRow").hidden = false;
  $("emptyState").hidden = true;
  const t = totals(posts);
  $("sViews").textContent = fmt.int(t.views);
  $("sEng").textContent = fmt.int(t.engagements);
  $("sRate").textContent = fmt.rate(t.engagementRate);
  $("sLikes").textContent = fmt.int(t.likes);
  $("sPosts").textContent = fmt.int(t.posts);
  const fd = followerDelta(folSnapshots);
  const ctxSnap = ctxHandle ? (data.profileByHandle || {})[ctxHandle] : null;
  const ctxFollowers = ctxSnap?.followers;
  $("sFol").textContent = ctxHandle
    ? ctxFollowers != null ? fmt.int(ctxFollowers) : "-"
    : fd ? `${fmt.int(fd.last)} (${fd.change >= 0 ? "+" : ""}${fd.change})` : folSnapshots.at(-1)?.followers ? fmt.int(folSnapshots.at(-1).followers) : "-";
  $("modStatsLine").textContent = ctxHandle
    ? `@${page.handle} · ${fmt.int(t.views)} impressions · ${fmt.int(t.posts)} posts` +
      (ctxFollowers != null ? ` · ${fmt.int(ctxFollowers)} followers` : "")
    : `${fmt.int(t.views)} impressions · ${fmt.int(t.posts)} posts` +
      (personal && profiles.at(-1)?.followers != null ? ` · ${fmt.int(profiles.at(-1).followers)} followers` : "");
  await updateContext(data.ownerHandle, page);
}

async function updateContext(ownerHandle, page) {
  if (!page) {
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (_) {
      tab = null;
    }
    page = describePage(tab?.url || "");
  }
  const syncBtn = $("sync");
  if (page.kind === "profile") {
    const yours = ownerHandle && page.handle.toLowerCase() === String(ownerHandle).toLowerCase();
    $("pageCtx").textContent = yours
      ? `On your profile @${page.handle}, showing your stats`
      : `On profile @${page.handle}, showing their stats`;
    syncBtn.textContent = `Sync @${page.handle}`;
  } else if (page.kind === "post") {
    $("pageCtx").textContent = `On a post by @${page.handle}`;
    syncBtn.textContent = "Sync this post";
  } else if (page.kind === "home") {
    $("pageCtx").textContent = "On home timeline (counts toward All)";
    syncBtn.textContent = "Sync timeline";
  } else {
    $("pageCtx").textContent = "Open an x.com profile, post, or timeline to sync.";
    syncBtn.textContent = "Sync this page";
  }
}

daysEl.onchange = refresh;
$("rangeWarnBtn").onclick = async () => {
  daysEl.value = "36500";
  await refresh();
};
$("scopeMine").onclick = async () => { await chrome.storage.local.set({ scope: "mine" }); refresh(); };
$("scopeAll").onclick = async () => { await chrome.storage.local.set({ scope: "all" }); refresh(); };

// Self-contained scraper for scripting.executeScript fallback.
// Runs when the content script missed the page load (install after tab open).
function fallbackScrape() {
  const parseCount = (s) => {
    if (s == null) return 0;
    const t = String(s).trim().replace(/,/g, "");
    if (!t) return 0;
    const m = t.match(/^([\d.]+)\s*([KMB])?$/i);
    if (m) {
      const mult = { K: 1e3, M: 1e6, B: 1e9 }[String(m[2] || "").toUpperCase()] || 1;
      return Math.round(parseFloat(m[1]) * mult);
    }
    const digits = t.replace(/[^\d]/g, "");
    return digits ? Number(digits) : 0;
  };
  const numFromNode = (node) => {
    if (!node) return 0;
    const label = node.getAttribute("aria-label") || "";
    const first = label.match(/([\d.,]+[KMB]?)/i);
    if (first) return parseCount(first[1]);
    return parseCount(node.textContent);
  };
  const posts = [];
  for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
    const link = article.querySelector('a[href*="/status/"]');
    const href = link?.getAttribute("href") || link?.href || "";
    const id = href.match(/status\/(\d+)/)?.[1];
    if (!id || posts.some((p) => p.id === id)) continue;
    const group = article.querySelector('[role="group"]');
    const scope = group || article;
    const byId = (tid) => scope.querySelector(`[data-testid="${tid}"]`);
    let views =
      numFromNode(scope.querySelector('a[href$="/analytics"]')) ||
      numFromNode(scope.querySelector('[href*="/analytics"]'));
    let likes = numFromNode(byId("like"));
    let reposts = numFromNode(byId("retweet"));
    let replies = numFromNode(byId("reply"));
    // group aria-label carries every count at once, e.g. "90 replies, 54 reposts, 681 likes, 264 bookmarks, 224900 views"
    const groupLabel = group?.getAttribute("aria-label") || article.getAttribute("aria-label") || "";
    if (groupLabel) {
      const get = (re) => {
        const mm = groupLabel.match(re);
        return mm ? parseCount(mm[1]) : null;
      };
      const r = get(/([\d.,]+[KMB]?)\s+repl/i);
      const rt = get(/([\d.,]+[KMB]?)\s+repost/i);
      const l = get(/([\d.,]+[KMB]?)\s+like/i);
      const v = get(/([\d.,]+[KMB]?)\s+view/i);
      if (r != null && !replies) replies = r;
      if (rt != null && !reposts) reposts = rt;
      if (l != null && !likes) likes = l;
      if (v != null && !views) views = v;
    }
    // generic fallback: any node whose accessible name pairs number + action
    if (!likes || !reposts || !replies || !views) {
      const pick = (re) => {
        let best = 0;
        for (const el of article.querySelectorAll("button, a, span")) {
          const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
          const m = label.match(re);
          if (m) best = Math.max(best, parseCount(m[1]));
        }
        return best;
      };
      if (!replies) replies = pick(/([\d.,]+[KMB]?)\s+repl/i);
      if (!reposts) reposts = pick(/([\d.,]+[KMB]?)\s+repost/i);
      if (!likes) likes = pick(/([\d.,]+[KMB]?)\s+like/i);
      if (!views) views = pick(/([\d.,]+[KMB]?)\s+view/i);
    }
    const timeEl = article.querySelector("time");
    const textEl = article.querySelector('[data-testid="tweetText"]');
    posts.push({
      id,
      url: link.href,
      handle: (href.match(/\/([^/]+)\/status\//) || [])[1] || null,
      views,
      likes,
      reposts,
      replies,
      bookmarks: 0,
      engagements: likes + reposts + replies,
      postedAt: timeEl?.getAttribute("datetime") || null,
      text: (textEl?.innerText || article.innerText || "").slice(0, 400),
    });
  }
  const profileCount = (kind) => {
    const want = (href) => {
      const h = (href || "").toLowerCase();
      return kind === "followers"
        ? h.includes("follower") && !h.includes("following")
        : h.includes("/following");
    };
    for (const a of document.querySelectorAll('a[href*="/"]')) {
      if (!want(a.getAttribute("href"))) continue;
      const text = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
      const m = text.match(/([\d.,]+[KMB]?)/i);
      if (m) return parseCount(m[1]);
    }
    const main = document.querySelector("main") || document;
    for (const s of main.querySelectorAll("span")) {
      const t = (s.innerText || "").trim();
      if (t.length > 40) continue;
      const m = t.match(/^([\d.,]+[KMB]?)\s+followers$/i) || t.match(/^([\d.,]+[KMB]?)\s+following$/i);
      if (m && t.toLowerCase().includes(kind === "followers" ? "follower" : "following")) return parseCount(m[1]);
    }
    return null;
  };
  return {
    posts,
    profile: {
      handle: location.pathname.split("/").filter(Boolean)[0] || null,
      followers: profileCount("followers"),
      following: profileCount("following"),
      postCount: null,
      isOwnProfile: !!(
        document.querySelector('a[href*="/setup_profile"]') ||
        [...document.querySelectorAll('a, button, [role="button"]')].some((el) =>
          /^\s*edit profile\s*$/i.test(el.innerText || el.textContent || "")
        )
      ),
      url: location.href,
    },
    scrapedAt: new Date().toISOString(),
    pageUrl: location.href,
    via: "fallback",
    diag: (() => {
      try {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        const group = articles[0]?.querySelector('[role="group"]');
        const testids = new Set();
        if (group) {
          for (const el of group.querySelectorAll("[data-testid]")) {
            testids.add(el.getAttribute("data-testid"));
            if (testids.size >= 20) break;
          }
        }
        return {
          articles: articles.length,
          groups: [...articles].filter((a) => a.querySelector('[role="group"]')).length,
          testids: [...testids],
          groupAria: (group?.getAttribute("aria-label") || "").slice(0, 140),
          analyticsLinks: document.querySelectorAll('a[href*="analytics"]').length,
          followersLinks: [...document.querySelectorAll('a[href*="followers"]')].slice(0, 3).map((a) => ({
            href: a.getAttribute("href"),
            text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
          })),
          userName: !!document.querySelector('[data-testid="UserName"]'),
        };
      } catch (_) {
        return null;
      }
    })(),
  };
}

async function scrapeTab(tabId) {
  // 1. try content script listener
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "XSTATS_SCRAPE_NOW" });
    if (res?.posts) return res;
  } catch (_) {
    // content script not injected yet, fall through to scripting
  }
  // 2. inject on demand, covers tabs opened before install
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/x-analytics.js"],
  });
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "XSTATS_SCRAPE_NOW" });
    if (res?.posts) return res;
  } catch (_) {
    // 3. direct func eval as last resort
  }
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: fallbackScrape });
  return r.result;
}

async function doSync() {
  $("status").textContent = "Scraping this X tab...";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      $("status").textContent = "No active tab found.";
      return;
    }
    if (!tab?.url?.includes("x.com") && !tab?.url?.includes("twitter.com")) {
      $("status").textContent = "Open an x.com tab first, then Sync.";
      return;
    }
    const scraped = await scrapeTab(tab.id);
    if (!scraped || !Array.isArray(scraped.posts) || !scraped.posts.length) {
      $("status").textContent = `Page read OK, but found 0 posts. Scroll so tweets are visible, then Sync again. (${scraped?.pageUrl || tab.url})`;
      return;
    }
    $("status").textContent = `Found ${scraped.posts.length} posts, saving...`;
    let saved = null;
    try {
      saved = await chrome.runtime.sendMessage({ type: "XSTATS_SAVE_SCRAPE", payload: scraped });
    } catch (e) {
      $("status").textContent = `Save failed, background unreachable: ${e?.message || e}. Reload the extension in brave://extensions, then reload X.`;
      return;
    }
    if (!saved) {
      $("status").textContent = "Save failed, background gave no reply. Reload the extension in brave://extensions, then reload X.";
      return;
    }
    if (saved.error) {
      $("status").textContent = `Save failed: ${saved.error}`;
      return;
    }
    $("status").textContent = `Saved ${saved.saved} posts (${saved.date}). Profile: ${saved.profile?.followers ?? "-" } followers. Scroll for older posts, Sync again.`;
    const days = Number(daysEl.value);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const dated = (scraped.posts || []).map((p) => p.postedAt).filter(Boolean).sort();
    const inRange = (scraped.posts || []).filter((p) => p.postedAt && new Date(p.postedAt).getTime() >= cutoff).length;
    if (dated.length) {
      $("status").textContent += ` Dates: ${dated[0].slice(0, 10)}..${dated[dated.length - 1].slice(0, 10)}, ${inRange}/${scraped.posts.length} in last ${days}d.`;
    }
    const pageKind = describePage(tab.url).kind;
    if (pageKind !== "profile") {
      $("status").textContent += " Tip: sync from your own profile page to capture follower counts.";
    } else if (saved.profile?.followers == null) {
      $("status").textContent += " Profile header not read. Scroll to the top so counts show, then Sync again.";
    }
    const d = scraped.diag;
    if (d && inRange === 0) {
      const fol = (d.followersLinks || []).map((l) => `${l.href}=[${l.text}]`).join(" ") || "none";
      $("status").textContent += ` Diag: via=${scraped.via || "content"} articles=${d.articles} groups=${d.groups} testids=[${(d.testids || []).join(",")}] analytics=${d.analyticsLinks} followers=${fol} userName=${d.userName ? 1 : 0} aria="${d.groupAria || ""}"`;
    }
    await refresh();
  } catch (e) {
    $("status").textContent = `Sync failed: ${e?.message || e}. Reload X tab once after install, then Sync.`;
  }
}

$("sync").onclick = doSync;
$("emptySync").onclick = doSync;

$("open").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });

// ---- dashboard home: 2 modules ----
function showView(name) {
  $("viewHome").hidden = name !== "home";
  $("viewStats").hidden = name !== "analytics";
  $("viewCleanup").hidden = name !== "cleanup";
  if (name === "analytics") void refresh();
  if (name === "cleanup") void refreshCleanupPopup();
}
$("goAnalytics").onclick = () => showView("analytics");
$("goCleanup").onclick = () => showView("cleanup");
document.querySelectorAll(".backBtn").forEach((b) => {
  b.onclick = () => showView("home");
});
let clData = { rels: [], whitelist: [], log: [], settings: { cap: 20, dryRun: true }, doneToday: 0, ownerHandle: null };
let clCtxHandle = null;
let clOwnerFollowing = null;
const clSelected = new Set();
let clTimer = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refreshCleanupPopup() {
  clData = await chrome.runtime.sendMessage({ type: "XSTATS_GET_CLEANUP", handle: clCtxHandle });
  const wl = new Set(clData.whitelist);
  const alive = new Set(clData.rels.map((r) => r.handle.toLowerCase()));
  for (const h of [...clSelected]) {
    if (!alive.has(h.toLowerCase()) || wl.has(h.toLowerCase())) clSelected.delete(h);
  }
  const pace = clData.pace || { cap: 8, level: 0, doneToday: 0, cooling: false };
  $("clPace").textContent = pace.cooling
    ? `Paused after an X warning · resumes tomorrow`
    : `Safe pace ${pace.cap}/day · ${pace.doneToday}/${pace.cap} today`;
  const rows = sortCleanup(clData.rels.filter((r) => !wl.has(r.handle.toLowerCase())));
  const nonFb = rows.filter((r) => !r.followsBack).length;
  $("modCleanupLine").textContent = clData.rels.length
    ? `${nonFb} do not follow back · ${pace.doneToday}/${pace.cap} today`
    : "Not scanned yet.";
  $("clStatus").textContent = clData.rels.length
    ? `${clData.rels.length} following, ${nonFb} do not follow back.`
    : "Not scanned yet. Scans your following list for non-followbacks.";
  $("clList").innerHTML = rows.map((r) => {
    const h = esc(r.handle);
    return `<div class="crow"><input type="checkbox" data-h="${h}" ${clSelected.has(r.handle) ? "checked" : ""} ${r.followsBack ? "disabled" : ""} />` +
      `<span class="h">@${h}</span>${r.verified ? `<span class="tag">verified</span>` : ""}` +
      `<span class="tag">${r.followsBack ? "mutual" : "no FB"}</span></div>`;
  }).join("");
  $("clList").querySelectorAll("input[data-h]").forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) clSelected.add(cb.dataset.h);
      else clSelected.delete(cb.dataset.h);
      paintClMaster();
      paintClUnfollow();
    };
  });
  paintClMaster();
  paintClUnfollow();
  void pollClProgress();
}

// Master checkbox above the list: checks every selectable non-followback.
function selectableRows() {
  const wl = new Set(clData.whitelist);
  return clData.rels.filter((r) => !r.followsBack && !wl.has(r.handle.toLowerCase()));
}

function paintClMaster() {
  const all = selectableRows();
  const n = all.filter((r) => clSelected.has(r.handle)).length;
  const master = $("clMaster");
  master.checked = all.length > 0 && n === all.length;
  master.indeterminate = n > 0 && n < all.length;
  $("clCount").textContent = all.length ? `${all.length} non-followbacks` : "";
}

function paintClUnfollow() {
  const n = clSelected.size;
  const pace = clData.pace || { cap: 8 };
  $("clUnfollow").title = n
    ? `Unfollow ${n} selected at safe pace (${pace.cap}/day, about half a minute apart, with rests every 25)`
    : "Tick accounts above, then hit this to unfollow them at safe pace";
}

async function pollClProgress() {
  const [{ relScan }, { unfollowStatus: st }] = await Promise.all([
    chrome.storage.local.get("relScan"),
    chrome.storage.local.get("unfollowStatus"),
  ]);
  if (relScan?.active) {
    const goal = relScan.expected != null ? `, ${relScan.collected || 0}/${relScan.expected} collected` : "";
    $("clProg").textContent = `Scanning following: pass ${relScan.pass || 0}${goal}.`;
  } else if (st?.active) {
    if (st.onBreak) {
      const m = Math.round((st.breakSec || 0) / 60);
      $("clProg").textContent = `${st.done || 0}/${st.total || 0}, on break, resumes in ~${m}m.`;
    } else {
      $("clProg").textContent = `${st.done || 0}/${st.total || 0}` +
        (st.current ? `, on @${st.current}` : "") +
        (st.nextInSec ? `, next in ${st.nextInSec}s` : "");
    }
  } else if (st && !st.active && st.total) {
    $("clProg").textContent = st.status === "done" ? `Finished ${st.done}/${st.total}.`
      : st.status === "cap" ? `Safe pace reached at ${st.done}/${st.total}. Continues tomorrow.`
      : st.status === "hour" ? `Hourly burst guard at ${st.done}/${st.total}. Resumes within the hour.`
      : st.status === "cooldown" ? `Paused after an X warning at ${st.done}/${st.total}. Resumes tomorrow.`
      : st.status === "warning" ? `Stopped on X warning at ${st.done}/${st.total}.`
      : st.status === "wrong-tab" ? `Stopped: the scan tab left the following page at ${st.done}/${st.total}.`
      : `Stopped at ${st.done || 0}/${st.total || 0}.`;
  } else {
    $("clProg").textContent = "";
  }
}

async function ensureXTab(url, preferActive = false) {
  // Scan flows run on the X tab you are already looking at when possible.
  // Only when you are nowhere on X do they fall back to a dedicated tab.
  if (preferActive) {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id && (active.url?.includes("x.com") || active.url?.includes("twitter.com"))) {
        await chrome.tabs.update(active.id, { url });
        return readyXTab(active);
      }
    } catch (_) {
      // fall through to the dedicated tab
    }
  }
  const { xstatsTabId } = await chrome.storage.local.get("xstatsTabId");
  let target = null;
  if (xstatsTabId) {
    try {
      target = await chrome.tabs.get(xstatsTabId);
    } catch (_) {
      target = null;
    }
  }
  if (!target) {
    target = await chrome.tabs.create({ url, active: false });
    await chrome.storage.local.set({ xstatsTabId: target.id });
  } else {
    await chrome.tabs.update(target.id, { url });
  }
  return readyXTab(target);
}

async function readyXTab(target) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try {
      const t = await chrome.tabs.get(target.id);
      if (t.status === "complete") break;
    } catch (_) {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    await chrome.tabs.sendMessage(target.id, { type: "XSTATS_SCRAPE_NOW" });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content/x-analytics.js"] });
  }
  return target;
}

async function ownerForCleanup() {
  const { ownerHandle } = await chrome.storage.local.get("ownerHandle");
  return (ownerHandle || clData.ownerHandle || "").replace(/^@/, "").trim();
}

$("clScan").onclick = async () => {
  // Scan whoever you are looking at. Standing on a profile page targets
  // that handle, otherwise it falls back to the saved owner. No confirms:
  // the list simply follows the page.
  let handle = await ownerForCleanup();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = describePage(tab?.url || "");
    if (page.kind === "profile" && page.handle) handle = page.handle;
  } catch (_) {
    // keep the saved owner
  }
  if (!handle) {
    $("clStatus").textContent = "Open an X profile, then scan.";
    return;
  }
  clCtxHandle = handle.toLowerCase();
  clOwnerFollowing = null;
  const target = await ensureXTab(`https://x.com/${handle}/following`, true);
  await chrome.tabs.sendMessage(target.id, { type: "XSTATS_START_REL_SCAN", handle, expected: clOwnerFollowing });
  $("clStatus").textContent = `Scanning @${handle}/following on this X tab. Reopen this popup for progress.`;
  startClPoll();
};

function setRowChecks(checked) {
  $("clList").querySelectorAll("input[data-h]").forEach((cb) => {
    if (cb.disabled) return;
    cb.checked = checked;
  });
}

$("clMaster").onchange = () => {
  if ($("clMaster").checked) {
    for (const r of selectableRows()) clSelected.add(r.handle);
    setRowChecks(true);
  } else {
    clSelected.clear();
    setRowChecks(false);
  }
  paintClMaster();
  paintClUnfollow();
};
$("clDrop").onclick = async () => {
  if (!clSelected.size) {
    $("clProg").textContent = "Nothing selected.";
    return;
  }
  await chrome.runtime.sendMessage({ type: "XSTATS_DROP_REL", handles: [...clSelected] });
  clSelected.clear();
  $("clProg").textContent = "Removed from the list. A rescan brings them back.";
  refreshCleanupPopup();
};
$("clWlAdd").onclick = async () => {
  const h = $("clWl").value.replace(/^@/, "").trim().toLowerCase();
  if (!h) return;
  await chrome.runtime.sendMessage({ type: "XSTATS_SET_WHITELIST", handles: [...clData.whitelist, h] });
  $("clWl").value = "";
  refreshCleanupPopup();
};

$("clUnfollow").onclick = async () => {
  if (!clSelected.size) {
    $("clProg").textContent = "Tick at least one account first.";
    return;
  }
  const pace = clData.pace || { cap: 8, doneToday: 0, cooling: false };
  if (pace.cooling) {
    $("clProg").textContent = "Paused after an X warning. Resumes tomorrow.";
    return;
  }
  if (pace.doneToday >= pace.cap) {
    $("clProg").textContent = `Safe pace reached (${pace.doneToday}/${pace.cap} today). Continues tomorrow.`;
    return;
  }
  const n = clSelected.size;
  if (!confirm(`Unfollow ${n} account${n > 1 ? "s" : ""} at safe pace (${pace.cap}/day, about half a minute apart, with rests every 25)?`)) return;
  const handle = clCtxHandle || await ownerForCleanup();
  if (!handle) {
    $("clProg").textContent = "Scan a profile first, then run.";
    return;
  }
  const target = await ensureXTab(`https://x.com/${handle}/following`);
  await chrome.tabs.sendMessage(target.id, {
    type: "XSTATS_RUN_UNFOLLOW",
    handles: [...clSelected],
    dryRun: false,
    delayMin: CLEANUP.delayMinSec,
    delayMax: CLEANUP.delayMaxSec,
    sessionMax: CLEANUP.sessionMax,
    breakMin: CLEANUP.breakMinSec,
    breakMax: CLEANUP.breakMaxSec,
  });
  $("clProg").textContent = "Started. About a minute between unfollows.";
  startClPoll();
};

function startClPoll() {
  if (clTimer) clearInterval(clTimer);
  clTimer = setInterval(async () => {
    await pollClProgress();
    const [{ relScan }, { unfollowStatus: st }] = await Promise.all([
      chrome.storage.local.get("relScan"),
      chrome.storage.local.get("unfollowStatus"),
    ]);
    if (!relScan?.active && !st?.active) {
      clearInterval(clTimer);
      clTimer = null;
      await refreshCleanupPopup();
      const fin = relScan;
      if (fin && fin.status === "done") {
        const nonFb = clData.rels.filter((r) => !r.followsBack).length;
        $("clStatus").textContent = `Done: ${clData.rels.length} following scanned, ${nonFb} not following back.` +
          (fin.expected != null && !fin.complete ? ` Reached ${fin.collected || 0}/${fin.expected}; rerun Scan to continue.` : "");
      }
      if (fin && fin.status === "wrong-tab") {
        $("clStatus").textContent = "Scan stopped: the scan tab left the following page.";
      }
    }
  }, 2000);
}

await refresh();
await refreshCleanupPopup();
