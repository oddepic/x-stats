// X post + profile scraper. DOM only, no API calls.
// Works in Brave with Shields on. Run on x.com profile, tweet, or analytics pages.
(() => {
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

  // X puts counts in aria-labels like "12 replies, 34 reposts, 56 likes, 789 views"
  // and in visible spans inside each action button. Read both.
  function readActionCounts(article) {
    const out = { replies: 0, reposts: 0, likes: 0, views: 0, bookmarks: 0 };
    const group = article.querySelector('[role="group"]');
    const scope = group || article;

    const byTestId = (id) => scope.querySelector(`[data-testid="${id}"]`);
    const numFromNode = (node) => {
      if (!node) return 0;
      const label = node.getAttribute("aria-label") || "";
      const first = label.match(/([\d.,]+[KMB]?)/i);
      if (first) return parseCount(first[1]);
      return parseCount(node.textContent);
    };

    // reply / retweet / like use testids
    out.replies = numFromNode(byTestId("reply"));
    out.reposts = numFromNode(byTestId("retweet"));
    out.likes = numFromNode(byTestId("like"));

    // views: link ending in /analytics, or testid view, or aria-label with views
    const viewLink =
      scope.querySelector('a[href$="/analytics"]') ||
      scope.querySelector('[data-testid="views"]') ||
      scope.querySelector('[href*="/analytics"]');
    out.views = numFromNode(viewLink);

    // bookmarks: testid bookmark, count often hidden unless you bookmarked
    const bm = byTestId("bookmark") || scope.querySelector('[data-testid="bookmark"] span');
    out.bookmarks = numFromNode(bm);

    // fallback: parse group aria-label which lists all counts at once
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
      const b = get(/([\d.,]+[KMB]?)\s+bookmark/i);
      if (r != null && !out.replies) out.replies = r;
      if (rt != null && !out.reposts) out.reposts = rt;
      if (l != null && !out.likes) out.likes = l;
      if (v != null && !out.views) out.views = v;
      if (b != null && !out.bookmarks) out.bookmarks = b;
    }
    // generic fallback: any node in the article whose accessible name
    // pairs a number with the action word, e.g. "1,118 Likes"
    if (!out.likes || !out.reposts || !out.replies || !out.views) {
      const pick = (re) => {
        let best = 0;
        for (const el of article.querySelectorAll("button, a, span")) {
          const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
          const m = label.match(re);
          if (m) best = Math.max(best, parseCount(m[1]));
        }
        return best;
      };
      if (!out.replies) out.replies = pick(/([\d.,]+[KMB]?)\s+repl/i);
      if (!out.reposts) out.reposts = pick(/([\d.,]+[KMB]?)\s+repost/i);
      if (!out.likes) out.likes = pick(/([\d.,]+[KMB]?)\s+like/i);
      if (!out.views) out.views = pick(/([\d.,]+[KMB]?)\s+view/i);
    }
    return out;
  }

  function scrapePosts() {
    // Tracks everything visible in the timeline: own posts, reposts, replies, quotes.
    const posts = [];
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {      const link = article.querySelector('a[href*="/status/"]');
      const href = link?.getAttribute("href") || link?.href || "";
      const id = href.match(/status\/(\d+)/)?.[1];
      if (!id) continue;
      if (posts.some((p) => p.id === id)) continue;
      const handleFromUrl = href.match(/\/([^/]+)\/status\//)?.[1] || null;
      const counts = readActionCounts(article);
      const timeEl = article.querySelector("time");
      const userEl = article.querySelector('[data-testid="User-Name"]');
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const fullText = article.innerText || "";
      const social = article.querySelector('[data-testid="socialContext"]')?.innerText || "";
      posts.push({
        id,
        url: link.href.startsWith("http") ? link.href : `https://x.com${link.getAttribute("href")}`,
        handle: handleFromUrl,
        views: counts.views,
        likes: counts.likes,
        reposts: counts.reposts,
        replies: counts.replies,
        bookmarks: counts.bookmarks,
        engagements: counts.likes + counts.reposts + counts.replies + counts.bookmarks,
        postedAt: timeEl?.getAttribute("datetime") || null,
        author: (userEl?.innerText || "").split("\n")[0] || null,
        kind: /reposted/i.test(social) ? "repost" : /replying to/i.test(fullText) ? "reply" : "post",
        social: social.slice(0, 120) || null,
        text: (textEl?.innerText || fullText).slice(0, 400),
      });
    }
    return posts;
  }

  // Self-diagnosis: reports which selectors hit so a zero-read sync
  // tells us exactly what X changed instead of failing silently.
  function diagnose() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const first = articles[0];
    const group = first?.querySelector('[role="group"]');
    const testids = new Set();
    if (group) {
      for (const el of group.querySelectorAll("[data-testid]")) {
        testids.add(el.getAttribute("data-testid"));
        if (testids.size >= 20) break;
      }
    }
    const folLinks = [...document.querySelectorAll('a[href*="followers"]')].slice(0, 3).map((a) => ({
      href: a.getAttribute("href"),
      text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    }));
    return {
      articles: articles.length,
      groups: [...articles].filter((a) => a.querySelector('[role="group"]')).length,
      testids: [...testids],
      groupAria: (group?.getAttribute("aria-label") || "").slice(0, 140),
      analyticsLinks: document.querySelectorAll('a[href*="analytics"]').length,
      followersLinks: folLinks,
      userName: !!document.querySelector('[data-testid="UserName"]'),
    };
  }

  function profileCount(kind) {
    // kind is "followers" or "following". X links the followers count as
    // /<handle>/followers or /<handle>/verified_followers, so match the
    // "follower" substring (never matches "following") instead of a suffix.
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
    // last resort: any short element reading "N Followers" / "N Following"
    const scope = document.querySelector("main") || document;
    for (const el of scope.querySelectorAll("span")) {
      const t = (el.innerText || "").trim();
      if (t.length > 40) continue;
      const m = t.match(/^([\d.,]+[KMB]?)\s+followers$/i) || t.match(/^([\d.,]+[KMB]?)\s+following$/i);
      if (m && t.toLowerCase().includes(kind === "followers" ? "follower" : "following")) return parseCount(m[1]);
    }
    return null;
  }

  function scrapeProfile() {
    const path = location.pathname.split("/").filter(Boolean)[0] || null;
    // name from profile header
    const header = document.querySelector('[data-testid="UserName"]');
    const followers = profileCount("followers");
    const following = profileCount("following");
    // posts count: "35 posts" near profile header, number can have commas
    let postCount = null;
    for (const el of document.querySelectorAll("span")) {
      const m = el.textContent.trim().match(/^([\d.,]+[KMB]?)\s+posts?$/i);
      if (m) {
        postCount = parseCount(m[1]);
        break;
      }
    }
    // Own profile shows Edit profile (links to /setup_profile). Other profiles show Follow.
    // Used to auto-switch Personal only when syncing your own profile, never on others.
    const isOwnProfile = !!(
      document.querySelector('a[href*="/setup_profile"]') ||
      [...document.querySelectorAll('a, button, [role="button"]')].some((el) =>
        /^\s*edit profile\s*$/i.test(el.innerText || el.textContent || "")
      )
    );
    return {
      handle: path && !["home", "explore", "notifications", "messages", "i"].includes(path) ? path : null,
      displayName: header?.innerText?.split("\n")[0] || null,
      followers,
      following,
      postCount,
      isOwnProfile,
      url: location.href,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === "XSTATS_SCRAPE_NOW") {
      const posts = scrapePosts();
      const profile = scrapeProfile();
      sendResponse({
        posts,
        profile,
        scrapedAt: new Date().toISOString(),
        pageUrl: location.href,
        diag: diagnose(),
      });
    }
    if (msg.type === "XSTATS_START_SCAN") {
      startScan(msg).then((r) => sendResponse(r));
      return true;
    }
    if (msg.type === "XSTATS_START_REL_SCAN") {
      const handle = String(msg.handle || "").replace(/^@/, "").trim();
      if (!handle) {
        sendResponse({ error: "no handle" });
        return false;
      }
      if (!/\/following\/?(\?.*)?$/.test(location.pathname)) {
        chrome.storage.local.set({
          relScan: { active: true, status: "navigating", handle, expected: msg.expected != null ? Number(msg.expected) || null : null, maxPasses: msg.maxPasses || 500, pass: 0, stall: 0, collected: 0, startedAt: new Date().toISOString() },
        });
        location.href = `https://x.com/${handle}/following`;
        sendResponse({ ok: true, navigated: true });
        return false;
      }
      beginRelScan(handle, msg.maxPasses || 500, msg.expected != null ? Number(msg.expected) || null : null);
      sendResponse({ ok: true, started: true });
      return false;
    }
    if (msg.type === "XSTATS_RUN_UNFOLLOW") {
      chrome.storage.local.set({
        unfollowStatus: { active: true, status: "running", total: msg.handles.length, done: 0, current: null, dryRun: !!msg.dryRun, startedAt: new Date().toISOString() },
      });
      void unfollowLoop(msg.handles || [], !!msg.dryRun, msg.delayMin || 25, msg.delayMax || 45, msg.sessionMax || 25, msg.breakMin || 1800, msg.breakMax || 3600);
      sendResponse({ ok: true, started: true });
      return false;
    }
    if (msg.type === "XSTATS_STOP_SCAN") {
      chrome.storage.local.set({ scan: { active: false, status: "stopped", stoppedAt: new Date().toISOString() } });
      sendResponse({ ok: true });
    }
    if (msg.type === "XSTATS_STOP_UNFOLLOW") {
      chrome.storage.local.set({ unfollowStatus: { active: false, status: "stopped", stoppedAt: new Date().toISOString() } });
      sendResponse({ ok: true });
    }
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const tabUrl = (handle, tab) => (tab ? `https://x.com/${handle}/${tab}` : `https://x.com/${handle}`);
  const currentTab = (handle) => {
    const segs = location.pathname.split("/").filter(Boolean);
    if (segs.length < 2 || segs[0].toLowerCase() !== String(handle).toLowerCase()) return null;
    return segs[1] === "with_replies" ? "with_replies" : "";
  };

  async function startScan({ handle, maxPasses = 40, tabs = [""] }) {
    handle = String(handle || "").replace(/^@/, "").trim();
    if (!handle) return { error: "no handle" };
    tabs = (Array.isArray(tabs) && tabs.length ? tabs : [""]).filter((t) => t === "" || t === "with_replies");
    const here = currentTab(handle);
    if (here == null || !tabs.includes(here)) {
      await chrome.storage.local.set({
        scan: { active: true, status: "navigating", handle, tabs, tabIndex: 0, maxPasses, pass: 0, savedTotal: 0, stall: 0, startedAt: new Date().toISOString() },
      });
      location.href = tabUrl(handle, tabs[0]);
      return { ok: true, navigated: true };
    }
    await chrome.storage.local.set({
      scan: { active: true, status: "running", handle, tabs, tabIndex: Math.max(0, tabs.indexOf(here)), maxPasses, pass: 0, savedTotal: 0, stall: 0, lastHeight: 0, startedAt: new Date().toISOString() },
    });
    void scanLoop();
    return { ok: true, started: true };
  }

  // Advance to the next timeline tab, or finish. State persists in storage
  // so a closed tab, a reload, or tomorrow continues where this stopped.
  async function nextTabOrFinish(scan, height) {
    const next = (scan.tabIndex || 0) + 1;
    if (next < (scan.tabs || [""]).length) {
      const tab = scan.tabs[next];
      await chrome.storage.local.set({
        scan: { ...scan, status: "navigating", tabIndex: next, pass: 0, stall: 0, lastHeight: 0 },
      });
      location.href = tabUrl(scan.handle, tab);
      return;
    }
    await chrome.storage.local.set({
      scan: { ...scan, active: false, status: "done", lastHeight: height, finishedAt: new Date().toISOString() },
    });
  }

  async function scanLoop() {
    for (;;) {
      const { scan } = await chrome.storage.local.get("scan");
      if (!scan?.active) return;
      const pass = (scan.pass || 0) + 1;
      // scrape + save one screen of the profile timeline
      const posts = scrapePosts();
      const profile = scrapeProfile();
      let saved = 0;
      try {
        const res = await chrome.runtime.sendMessage({
          type: "XSTATS_SAVE_SCRAPE",
          payload: { posts, profile, scrapedAt: new Date().toISOString(), pageUrl: location.href },
        });
        saved = res?.saved || 0;
      } catch (_) {
        saved = 0;
      }
      window.scrollBy(0, 1600);
      await wait(2500);
      const height = document.body.scrollHeight;
      const stall = height === scan.lastHeight ? (scan.stall || 0) + 1 : 0;
      const savedTotal = (scan.savedTotal || 0) + saved;
      if (pass >= (scan.maxPasses || 40) || stall >= 4) {
        await nextTabOrFinish({ ...scan, pass, savedTotal }, height);
        return;
      }
      await chrome.storage.local.set({
        scan: { ...scan, status: "running", pass, savedTotal, stall, lastHeight: height },
      });
    }
  }

  // resume after the navigate-to-profile reload (either timeline tab)
  (async () => {
    try {
      const { scan } = await chrome.storage.local.get("scan");
      if (!scan?.active || !scan?.handle) return;
      if (scan.status !== "navigating") return;
      const tabs = scan.tabs && scan.tabs.length ? scan.tabs : [""];
      const want = tabs[scan.tabIndex || 0] || "";
      const here = currentTab(scan.handle);
      if (here == null || here !== want) return;
      await wait(3000);
      await chrome.storage.local.set({ scan: { ...scan, status: "running", pass: 0, savedTotal: scan.savedTotal || 0, stall: 0, lastHeight: 0 } });
      void scanLoop();
    } catch (_) {
      // storage unavailable, skip resume
    }
  })();

  // ---- relationship scan: who you follow vs who follows you back ----
  function scrapeFollowingRows() {    const rows = [];
    for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
      const link = cell.querySelector('a[href^="/"][role="link"]');
      const href = link?.getAttribute("href") || "";
      const m = href.match(/^\/([^/?#]+)$/);
      if (!m) continue;
      const handle = m[1];
      if (rows.some((r) => r.handle.toLowerCase() === handle.toLowerCase())) continue;
      const text = (cell.innerText || "").replace(/\s+/g, " ");
      rows.push({
        handle,
        name: (link.innerText || "").split("\n")[0] || null,
        followsBack: /follows you/i.test(text),
        verified: !!cell.querySelector('[data-testid="icon-verified"]'),
      });
    }
    return rows;
  }

  // Read the "N Following" header count so the scan stops when every
  // followed account is collected instead of after a blind pass count.
  function pageFollowingCount() {
    for (const a of document.querySelectorAll('a[href*="/"]')) {
      const href = (a.getAttribute("href") || "").toLowerCase();
      if (!href.includes("/following") || href.includes("follower")) continue;
      const text = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
      const m = text.match(/([\d.,]+[KMB]?)/i);
      if (m) return parseCount(m[1]);
    }
    return null;
  }

  async function beginRelScan(handle, maxPasses, expected = null) {
    // Fresh list every scan: wipe first so interrupted older scans can never
    // inflate the count with stale rows.
    try {
      await chrome.runtime.sendMessage({ type: "XSTATS_RESET_REL" });
    } catch (_) {
      // background asleep, scan still proceeds
    }
    await wait(2500);
    // The profile snapshot count wins when provided (same number X shows on
    // the profile). The page header is only a fallback: read it before any
    // scrolling happens, never after.
    const expectedFinal = expected != null ? expected : pageFollowingCount();
    await chrome.storage.local.set({
      relScan: { active: true, status: "running", handle, maxPasses, pass: 0, stall: 0, lastHeight: 0, collected: 0, expected: expectedFinal, startedAt: new Date().toISOString() },
    });
    void relScanLoop(maxPasses);
  }

  async function relScanLoop(maxPasses) {
    for (let pass = 1; ; pass++) {
      const { relScan } = await chrome.storage.local.get("relScan");
      if (!relScan?.active) return;
      // Only a following page may drive this scan. Any other tab stops it
      // instead of scrolling some random timeline.
      if (!/\/following\/?(\?.*)?$/.test(location.pathname)) {
        await chrome.storage.local.set({
          relScan: { ...relScan, active: false, status: "wrong-tab", finishedAt: new Date().toISOString() },
        });
        return;
      }
      const rows = scrapeFollowingRows();
      let total = relScan.collected || 0;
      try {
        const res = await chrome.runtime.sendMessage({ type: "XSTATS_SAVE_REL", payload: { rows, handle: relScan.handle } });
        if (res?.total != null) total = res.total;
      } catch (_) {
        // background asleep, keep scrolling, next pass retries
      }
      window.scrollBy(0, 1600);
      await wait(2500);
      const height = document.body.scrollHeight;
      const stall = height === relScan.lastHeight ? (relScan.stall || 0) + 1 : 0;
      const expected = relScan.expected;
      const complete = expected != null && total >= expected;
      if (complete || pass >= maxPasses || stall >= 6) {
        await chrome.storage.local.set({
          relScan: { ...relScan, active: false, status: "done", complete: !!complete, pass, collected: total, finishedAt: new Date().toISOString() },
        });
        return;
      }
      await chrome.storage.local.set({ relScan: { ...relScan, status: "running", pass, stall, lastHeight: height, collected: total } });
    }
  }

  // ---- safe unfollow executor: human pace, stops at the first warning ----
  const RATE_LIMIT_RE = /rate limit|something went wrong|try again later|temporarily limited/i;

  function findUserCell(handle) {
    const cells = [...document.querySelectorAll('[data-testid="UserCell"]')];
    return cells.find((cell) =>
      [...cell.querySelectorAll('a[href^="/"]')].some(
        (a) => (a.getAttribute("href") || "").toLowerCase() === `/${handle.toLowerCase()}`
      )
    );
  }

  function pageHasWarning() {
    return RATE_LIMIT_RE.test(document.body.innerText || "");
  }

  async function unfollowOne(handle) {
    // scroll until the row is rendered
    let cell = null;
    for (let i = 0; i < 30; i++) {
      cell = findUserCell(handle);
      if (cell) break;
      window.scrollBy(0, 1200);
      await wait(1500);
    }
    if (!cell) return { ok: false, reason: "not found on page" };
    cell.scrollIntoView({ block: "center" });
    await wait(1200);
    const btn = [...cell.querySelectorAll('[role="button"]')].find((b) =>
      /^\s*following\s*$/i.test(b.innerText || "")
    );
    if (!btn) {
      const label = (cell.innerText || "").slice(0, 60);
      return { ok: false, reason: /^\s*follow\s*$/i.test(label) ? "already unfollowed" : "no Following button" };
    }
    btn.click();
    await wait(1800);
    const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (!confirm) return { ok: false, reason: "no confirm dialog" };
    if (pageHasWarning()) return { ok: false, reason: "rate warning", abort: true };
    confirm.click();
    await wait(2000);
    if (pageHasWarning()) return { ok: false, reason: "rate warning", abort: true };
    return { ok: true };
  }

  async function unfollowLoop(handles, dryRun, delayMin, delayMax, sessionMax = 25, breakMin = 1800, breakMax = 3600) {
    let sessionDone = 0;
    for (let i = 0; i < handles.length; i++) {
      const { unfollowStatus } = await chrome.storage.local.get("unfollowStatus");
      if (!unfollowStatus?.active) return;
      if (!/\/(following|followers)\/?(\?.*)?$/.test(location.pathname)) {
        await chrome.storage.local.set({
          unfollowStatus: { ...unfollowStatus, active: false, status: "wrong-tab", done: i },
        });
        return;
      }
      const handle = handles[i];
      await chrome.storage.local.set({
        unfollowStatus: { ...unfollowStatus, current: handle, done: i },
      });
      if (dryRun) {
        try {
          await chrome.runtime.sendMessage({ type: "XSTATS_LOG_UNFOLLOW", payload: { handle, dryRun: true } });
        } catch (_) {}
        await wait(2000 + Math.random() * 3000);
        continue;
      }
      // pace is enforced in the background before every real action
      let gate = null;
      try {
        gate = await chrome.runtime.sendMessage({ type: "XSTATS_CAN_UNFOLLOW" });
      } catch (_) {
        gate = null;
      }
      if (!gate?.allowed) {
        await chrome.storage.local.set({
          unfollowStatus: { ...unfollowStatus, active: false, status: gate?.reason || "cap", done: i, current: handle },
        });
        return;
      }
      const res = await unfollowOne(handle);
      try {
        await chrome.runtime.sendMessage({ type: "XSTATS_LOG_UNFOLLOW", payload: { handle, dryRun: false, ok: res.ok, reason: res.reason || null } });
      } catch (_) {}
      if (res.abort) {
        await chrome.storage.local.set({
          unfollowStatus: { ...unfollowStatus, active: false, status: "warning", done: i, current: handle },
        });
        return;
      }
      sessionDone++;
      // session break: after a burst of actions, go quiet for a long while,
      // then pick up alone. Bursts with rests read human, marathons do not.
      if (sessionDone >= sessionMax && i + 1 < handles.length) {
        sessionDone = 0;
        const rest = Math.round(breakMin + Math.random() * (breakMax - breakMin));
        for (let s = rest; s > 0; s -= 10) {
          const { unfollowStatus: st } = await chrome.storage.local.get("unfollowStatus");
          if (!st?.active) return;
          await chrome.storage.local.set({ unfollowStatus: { ...st, onBreak: true, breakSec: s, nextInSec: 0 } });
          await wait(10000);
        }
        await chrome.storage.local.set({
          unfollowStatus: { ...(await chrome.storage.local.get("unfollowStatus")).unfollowStatus, onBreak: false, breakSec: 0 },
        });
        continue;
      }
      const pause = Math.round((delayMin + Math.random() * (delayMax - delayMin)) * 1000);
      await chrome.storage.local.set({
        unfollowStatus: { ...unfollowStatus, done: i + 1, current: null, nextInSec: Math.round(pause / 1000) },
      });
      // countdown so the dashboard shows the human pause
      for (let s = Math.round(pause / 1000); s > 0; s -= 2) {
        const { unfollowStatus: st } = await chrome.storage.local.get("unfollowStatus");
        if (!st?.active) return;
        await chrome.storage.local.set({ unfollowStatus: { ...st, nextInSec: s } });
        await wait(2000);
      }
    }
    const { unfollowStatus: fin } = await chrome.storage.local.get("unfollowStatus");
    await chrome.storage.local.set({
      unfollowStatus: { ...fin, active: false, status: "done", current: null, nextInSec: 0 },
    });
  }

  // resume relationship scan after the navigate-to-following reload
  (async () => {
    try {
      const { relScan } = await chrome.storage.local.get("relScan");
      if (!relScan?.active || relScan.status !== "navigating") return;
      if (!/\/following\/?(\?.*)?$/.test(location.pathname)) return;
      await wait(3000);
      try {
        await chrome.runtime.sendMessage({ type: "XSTATS_RESET_REL" });
      } catch (_) {
        // background asleep, scan still proceeds
      }
      const expected = pageFollowingCount();
      await chrome.storage.local.set({ relScan: { ...relScan, status: "running", pass: 0, stall: 0, lastHeight: 0, expected: relScan.expected ?? expected ?? null } });
      void relScanLoop(relScan.maxPasses || 500);
    } catch (_) {
      // storage unavailable, skip resume
    }
  })();

  window.__xstats = { scrapePosts, scrapeProfile, parseCount };
})();
