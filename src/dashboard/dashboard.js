import { totals, dailySeries, topPosts, bestHours, followerDelta, delta, filterScope, effectiveHandle, fmt } from "../lib/range.js";
import { CLEANUP, sortCleanup } from "../lib/cleanup.js";
import { describePage } from "../lib/page.js";

const $ = (id) => document.getElementById(id);
let state = { posts: [], profiles: [], days: 90, ownerHandle: null, scope: "mine", ctxHandle: null };

const themeBtn = $("theme");
const { theme: storedTheme } = await chrome.storage.local.get("theme");
document.documentElement.dataset.theme = storedTheme || "dark";
themeBtn.setAttribute("aria-label", document.documentElement.dataset.theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
themeBtn.addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  themeBtn.setAttribute("aria-label", next === "dark" ? "Switch to light mode" : "Switch to dark mode");
  await chrome.storage.local.set({ theme: next });
});

async function load() {
  const days = Number($("days").value);
  const data = await chrome.runtime.sendMessage({ type: "XSTATS_GET_DASHBOARD", days });
  const { scope } = await chrome.storage.local.get("scope");
  state = { ...data, days, scope: scope || state.scope || "mine", ctxHandle: state.ctxHandle || null };
  if (state.ownerHandle) $("owner").value = `@${state.ownerHandle}`;
  render();
}

function scopedPosts() {
  return filterScope(state.posts, state.scope, state.ownerHandle);
}

function kpi(label, value, sub = "") {
  return `<div class="card kpi"><span>${label}</span><b>${value}</b><small class="muted">${sub}</small></div>`;
}

function render() {
  const { profiles, days, ownerHandle, scope } = state;
  const posts = scopedPosts();
  const t = totals(posts);
  const d = delta(posts, 28);
  const fd = followerDelta(profiles);
  const lastProfile = profiles.at(-1);

  $("handle").textContent = ownerHandle ? `@${ownerHandle}` : lastProfile?.handle ? `@${lastProfile.handle}` : "";
  const personal = scope !== "all";
  $("scopeMine").className = personal ? "" : "ghost";
  $("scopeAll").className = personal ? "ghost" : "";
  $("editOwner").style.display = personal ? "" : "none";
  $("profileCard").hidden = !personal;
  $("cleanupCard").hidden = !personal;
  $("importCard").hidden = !personal;
  if (!personal && editingOwner) {
    editingOwner = false;
    $("owner").hidden = true;
    paintOwnerBtn(ICON_PENCIL, "Edit owner handle");
  }
  $("scan").textContent = ownerHandle ? `Scan @${ownerHandle}` : "Scan";
  const mineCount = filterScope(state.posts, "mine", ownerHandle).length;
  const othersCount = state.posts.length - mineCount;  const untaggedCount = ownerHandle
    ? state.posts.filter((p) => !effectiveHandle(p)).length
    : 0;
  $("scopeLabel").textContent = personal
    ? `${posts.length} of ${state.posts.length} posts are yours${ownerHandle ? ` (@${ownerHandle})` : " (set owner to split)"}${untaggedCount ? `, ${untaggedCount} untagged` : ""}`
    : `${state.posts.length} total (${mineCount} yours, ${othersCount} others)`;
  $("meta").textContent =
    `${personal ? "Personal" : "All"}. Local only, data stays in this browser. ` +
    `Last sync: ${state.syncs?.at(-1)?.date || profiles.at(-1)?.date || "never"}. ` +
    (personal
      ? `Tip: open your own X profile, scroll, hit Sync to backfill.`
      : `Tip: sync any timeline to compare, profile stats stay separate.`);

  const rangeName = $("days").options[$("days").selectedIndex].text;
  const totalMine = state.totalMine ?? state.totalPosts ?? 0;
  const showWarn = posts.length === 0 && days < 36500 && (personal ? totalMine > 0 : (state.totalPosts || 0) > 0);
  if (showWarn) {
    $("rangeWarnText").textContent = personal
      ? `No personal posts in ${rangeName.toLowerCase()}, but ${totalMine} personal are tracked overall. They fall outside this range.`
      : `No posts in ${rangeName.toLowerCase()}, but ${state.totalPosts} are saved overall. They fall outside this range.`;
    $("rangeWarn").hidden = false;
  } else {
    $("rangeWarn").hidden = true;
  }

  const cards = [
    kpi("Impressions", fmt.int(t.views), `28d trend ${fmt.pct(d.views)}`),
    kpi("Engagements", fmt.int(t.engagements), `28d trend ${fmt.pct(d.engagements)}`),
    kpi("Eng. rate", fmt.rate(t.engagementRate), `${fmt.int(t.avgViews)} avg views/post`),
    kpi("Likes", fmt.int(t.likes)),
    kpi("Reposts", fmt.int(t.reposts)),
    kpi("Replies", fmt.int(t.replies)),
    kpi("Bookmarks", fmt.int(t.bookmarks)),
  ];
  if (personal) {
    cards.push(kpi("Followers", fd ? fmt.int(fd.last) : lastProfile?.followers ? fmt.int(lastProfile.followers) : "-",
      fd ? `${fd.change >= 0 ? "+" : ""}${fd.change} (${fmt.pct(fd.pct)})` : "Sync profile 2x to see growth"));
  }
  $("kpis").innerHTML = cards.join("");

  // daily chart (cap buckets at a year so all-time stays readable)
  const series = dailySeries(posts, Math.min(days, 365));
  const max = Math.max(1, ...series.map((s) => s.views));
  $("chart").innerHTML = series.map((s) => `<div style="height:${Math.round((s.views / max) * 100)}%" title="${s.date}: ${s.views.toLocaleString()} views"></div>`).join("");
  $("chartLabel").textContent = `${series[0]?.date} to ${series.at(-1)?.date} . Peak ${fmt.int(max)} in a day.`;

  // hours
  const hours = bestHours(posts);
  const hmax = Math.max(1, ...hours.map((h) => h.avg));
  $("hours").innerHTML = hours.map((h) => `<div style="height:${Math.round((h.avg / hmax) * 100)}%" title="${h.hour}:00 avg ${Math.round(h.avg)}"></div>`).join("");
  const best = [...hours].sort((a, b) => b.avg - a.avg)[0];
  $("hoursLabel").textContent = posts.length ? `Best hour: ${best.hour}:00 with ${fmt.int(Math.round(best.avg))} avg views.` : "No timed posts yet.";

  // top
  $("top").innerHTML = topPosts(posts, "views", 5)
    .map((p) => `<p style="font-size:13px"><b>${fmt.int(p.views)}</b> views, ${fmt.rate(p.views ? ((p.likes + p.reposts + p.replies) / p.views) * 100 : 0)} eng.<br><span class="muted">${escapeHtml((p.text || "").slice(0, 120))}</span><br><a href="${p.url}" target="_blank">Open</a></p>`)
    .join("") || `<p class="muted">No posts yet. Sync from your profile.</p>`;

  // profile
  $("profile").innerHTML = lastProfile    ? `<p>Followers <b>${fmt.int(lastProfile.followers)}</b> . Following <b>${fmt.int(lastProfile.following)}</b><br><span class="muted">${lastProfile.displayName || ""} . ${lastProfile.postCount != null ? fmt.int(lastProfile.postCount) + " posts on X" : ""}</span></p>
       <p class="muted" style="font-size:12px">Profile snapshots: ${profiles.length}. Sync your profile page once a day to track follower growth.</p>`
    : `<p class="muted">No profile snapshot yet. Open your x.com profile tab and hit Sync.</p>`;

  renderTable();
  if (personal) void refreshCleanup();
}

function renderTable() {
  const q = $("q").value.toLowerCase();
  const sort = $("sort").value;
  let rows = scopedPosts().filter((p) => (p.text || "").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
  $("count").textContent = `${rows.length} posts`;
  $("rows").innerHTML = rows.slice(0, 200).map((p) => {
    const rate = p.views ? ((p.likes + p.reposts + p.replies + p.bookmarks) / p.views) * 100 : 0;
    return `<tr><td>${(p.postedAt || "").slice(0, 10)}</td>
      <td><a href="${p.url}" target="_blank">${escapeHtml((p.text || "").slice(0, 90))}</a></td>
      <td>${fmt.int(p.views)}</td><td>${fmt.int(p.likes)}</td><td>${fmt.int(p.reposts)}</td>
      <td>${fmt.int(p.replies)}</td><td>${fmt.rate(rate)}</td></tr>`;
  }).join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("days").onchange = load;
$("rangeWarnBtn").onclick = async () => {
  $("days").value = "36500";
  await load();
};
$("scopeMine").onclick = async () => { state.scope = "mine"; await chrome.storage.local.set({ scope: "mine" }); render(); };
$("scopeAll").onclick = async () => { state.scope = "all"; await chrome.storage.local.set({ scope: "all" }); render(); };
// Single owner editor: pencil opens the input, click again to save,
// check confirms, then back to pencil.
const ICON_PENCIL = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`;
const ICON_SAVE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
const ICON_CHECK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
let editingOwner = false;
function paintOwnerBtn(icon, label) {
  $("editOwner").innerHTML = icon;
  $("editOwner").title = label;
  $("editOwner").setAttribute("aria-label", label);
}
paintOwnerBtn(ICON_PENCIL, "Edit owner handle");
$("editOwner").onclick = async () => {
  if (!editingOwner) {
    editingOwner = true;
    if (state.ownerHandle) $("owner").value = `@${state.ownerHandle}`;
    $("owner").hidden = false;
    $("owner").focus();
    $("owner").select();
    paintOwnerBtn(ICON_SAVE, "Save owner handle");
    return;
  }
  const handle = $("owner").value.replace(/^@/, "").trim();
  if (!handle) {
    editingOwner = false;
    $("owner").hidden = true;
    paintOwnerBtn(ICON_PENCIL, "Edit owner handle");
    return;
  }
  await chrome.runtime.sendMessage({ type: "XSTATS_SET_OWNER", handle });
  state.ownerHandle = handle;
  editingOwner = false;
  $("owner").hidden = true;
  paintOwnerBtn(ICON_CHECK, "Saved");
  render();
  setTimeout(() => {
    if (!editingOwner) paintOwnerBtn(ICON_PENCIL, "Edit owner handle");
  }, 1200);
};
let scanTimer = null;

function stopPolling() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

async function pollScan() {
  const { scan } = await chrome.storage.local.get("scan");
  if (!scan) {
    $("scanStatus").textContent = "";
    stopPolling();
    return;
  }
  if (scan.status === "running" || scan.status === "navigating") {
    const tabName = (scan.tabs || []).length > 1
      ? ` (${(scan.tabs || [])[scan.tabIndex || 0] === "with_replies" ? "replies" : "posts"})`
      : "";
    $("scanStatus").textContent = `Scanning @${scan.handle}${tabName}: pass ${scan.pass || 0}/${scan.maxPasses || 40}, saved ${scan.savedTotal || 0} posts.`;
    return;
  }
  $("scanStatus").textContent = `Scan ${scan.status}: ${scan.pass || 0} passes, ${scan.savedTotal || 0} posts saved.`;
  stopPolling();
  await load();
}

async function waitForTab(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return;
    } catch (_) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

$("scan").onclick = async () => {
  await startProfileScan(40, [""]);
};

$("deepScan").onclick = async () => {
  await startProfileScan(500, ["", "with_replies"]);
};

async function startProfileScan(maxPasses, tabs) {
  const handle = (state.ownerHandle || "").replace(/^@/, "").trim();
  if (!handle) {
    $("scanStatus").textContent = "Set the owner first with the pencil next to the handle above.";
    return;
  }
  await chrome.runtime.sendMessage({ type: "XSTATS_SET_OWNER", handle });
  state.ownerHandle = handle;
  render();
  const label = tabs.length > 1 ? `Deep scanning @${handle} (posts + replies, up to ${maxPasses} passes per tab, resumable)` : `Opening x.com/${handle}...`;
  $("scanStatus").textContent = label;
  const target = await ensureScanTab(`https://x.com/${handle}`);
  await chrome.tabs.sendMessage(target.id, { type: "XSTATS_START_SCAN", handle, maxPasses, tabs });
  $("scanStatus").textContent = tabs.length > 1
    ? `Deep scanning @${handle}. It pages posts then replies on its own, leave that tab open. Come back any time, it resumes.`
    : `Scanning @${handle} in the X tab. It scrolls on its own, leave that tab open.`;
  stopPolling();
  scanTimer = setInterval(pollScan, 2000);
};

$("stopScan").onclick = async () => {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { type: "XSTATS_STOP_SCAN" });
    } catch (_) {
      // tab has no content script, ignore
    }
  }
  await chrome.storage.local.set({ scan: { active: false, status: "stopped", stoppedAt: new Date().toISOString() } });
  stopPolling();
  $("scanStatus").textContent = "Scan stopped.";
  await load();
};

// ---- cleanup: non-followback finder + safe unfollow queue ----
let cleanup = { rels: [], whitelist: [], log: [], settings: { cap: 20, dryRun: true }, doneToday: 0, ownerHandle: null };
const selected = new Set();
let relTimer = null;
let unfollowTimer = null;

async function refreshCleanup() {
  cleanup = await chrome.runtime.sendMessage({ type: "XSTATS_GET_CLEANUP", handle: state.ctxHandle });
  // drop handles that left the relationship set or got protected
  const alive = new Set(cleanup.rels.map((r) => r.handle.toLowerCase()));
  const wl = new Set(cleanup.whitelist);
  for (const h of [...selected]) {
    if (!alive.has(h.toLowerCase()) || wl.has(h.toLowerCase())) selected.delete(h);
  }
  const pace = cleanup.pace || { cap: 8, level: 0, doneToday: 0, cooling: false };
  $("paceLabel").textContent = pace.cooling
    ? "Safe pace paused after an X warning · resumes tomorrow"
    : `Safe pace ${pace.cap}/day · ${pace.doneToday}/${pace.cap} today`;
  $("paceLabel").title = "Starts at 40 unfollows a day. Clean days raise it step by step to 100. Any warning from X resets it and pauses a full day.";
  $("wlList").textContent = cleanup.whitelist.length ? `Protected: ${cleanup.whitelist.join(", ")}` : "Protected: none";
  const rows = sortCleanup(cleanup.rels.filter((r) => !wl.has(r.handle.toLowerCase())));
  const nonFb = rows.filter((r) => !r.followsBack).length;
  $("relStatus").textContent = cleanup.rels.length
    ? `${cleanup.rels.length} following scanned, ${nonFb} do not follow back.`
    : "Not scanned yet.";
  $("relRows").innerHTML = rows.map((r) => {
    const h = escapeHtml(r.handle);
    return `<tr><td><input type="checkbox" data-h="${h}" ${selected.has(r.handle) ? "checked" : ""} ${r.followsBack ? "disabled" : ""} /></td>
      <td><a href="https://x.com/${h}" target="_blank">@${h}</a></td>
      <td>${r.followsBack ? "yes" : "no"}</td>
      <td>${r.verified ? "yes" : "-"}</td>
      <td>${(r.lastSeen || "").slice(0, 10)}</td>
      <td><button data-wl="${h}" class="ghost" style="padding:2px 8px">Protect</button></td></tr>`;
  }).join("");
  $("relRows").querySelectorAll("input[data-h]").forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) selected.add(cb.dataset.h);
      else selected.delete(cb.dataset.h);
      paintRelMaster();
      paintUnfollowBtn();
    };
  });
  $("relRows").querySelectorAll("button[data-wl]").forEach((b) => {
    b.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "XSTATS_SET_WHITELIST", handles: [...cleanup.whitelist, b.dataset.wl] });
      await refreshCleanup();
    };
  });
  $("unfollowLog").innerHTML = cleanup.log.length
    ? [...cleanup.log].reverse().map((e) => {
      const what = e.dryRun ? "dry run" : e.ok ? "unfollowed" : "failed (" + (e.reason || "?") + ")";
      return `<div>${(e.date || "").slice(0, 16)} @${escapeHtml(e.handle)}: ${what} ` +
        `<a href="https://x.com/${escapeHtml(e.handle)}" target="_blank">profile</a></div>`;
    }).join("")
    : "No actions yet today.";
  paintRelMaster();
  paintUnfollowBtn();
}

function selectableRels() {
  const wl = new Set(cleanup.whitelist);
  return cleanup.rels.filter((r) => !r.followsBack && !wl.has(r.handle.toLowerCase()));
}

function paintRelMaster() {
  const master = $("relMaster");
  if (!master) return;
  const all = selectableRels();
  const n = all.filter((r) => selected.has(r.handle)).length;
  master.checked = all.length > 0 && n === all.length;
  master.indeterminate = n > 0 && n < all.length;
}

function paintUnfollowBtn() {
  const n = selected.size;
  const pace = cleanup.pace || { cap: 8 };
  $("startUnfollow").title = n
    ? `Unfollow ${n} selected at safe pace (${pace.cap}/day, about half a minute apart, with rests every 25)`
    : "Tick accounts above, then hit this to unfollow them at safe pace";
}

// Scans prefer the X tab you are already looking at. Only when you are
// nowhere on X do they fall back to a dedicated tab reused across runs.
async function ensureScanTab(url, preferActive = false) {
  if (preferActive) {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id && (active.url?.includes("x.com") || active.url?.includes("twitter.com"))) {
        await chrome.tabs.update(active.id, { url });
        await waitForTab(active.id);
        try {
          await chrome.tabs.sendMessage(active.id, { type: "XSTATS_SCRAPE_NOW" });
        } catch (_) {
          await chrome.scripting.executeScript({ target: { tabId: active.id }, files: ["content/x-analytics.js"] });
        }
        return active;
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
  await waitForTab(target.id);
  try {
    await chrome.tabs.sendMessage(target.id, { type: "XSTATS_SCRAPE_NOW" });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content/x-analytics.js"] });
  }
  return target;
}

async function ensureFollowingTab(handle) {
  return ensureScanTab(`https://x.com/${handle}/following`);
}

$("scanRel").onclick = async () => {
  // Scan whoever you are looking at. Standing on a profile page targets
  // that handle, otherwise it falls back to the saved owner. No confirms:
  // the list simply follows the page.
  let handle = (state.ownerHandle || "").replace(/^@/, "").trim();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = describePage(tab?.url || "");
    if (page.kind === "profile" && page.handle) handle = page.handle;
  } catch (_) {
    // keep the saved owner
  }
  if (!handle) {
    $("relStatus").textContent = "Open an X profile, then scan.";
    return;
  }
  state.ctxHandle = handle.toLowerCase();
  const target = await ensureScanTab(`https://x.com/${handle}/following`, true);
  const ownerSnap = [...state.profiles].reverse().find((p) => p.following != null);
  await chrome.tabs.sendMessage(target.id, { type: "XSTATS_START_REL_SCAN", handle, expected: ownerSnap?.following ?? null });
  $("relStatus").textContent = `Scanning @${handle}/following on this X tab. Leave that tab open.`;
  if (relTimer) clearInterval(relTimer);
  relTimer = setInterval(async () => {
    const { relScan } = await chrome.storage.local.get("relScan");
    if (!relScan) return;
    if (relScan.status === "running" || relScan.status === "navigating") {
      const goal = relScan.expected != null ? `, ${relScan.collected || 0}/${relScan.expected} collected` : "";
      $("relStatus").textContent = `Scanning following: pass ${relScan.pass || 0}${goal}.`;
      return;
    }
    clearInterval(relTimer);
    relTimer = null;
    if (relScan.status === "wrong-tab") {
      $("relStatus").textContent = "Scan stopped: the scan tab left the following page.";
    }
    await refreshCleanup();
    if (relScan.status === "done") {
      const nonFb = cleanup.rels.filter((r) => !r.followsBack).length;
      $("relStatus").textContent = `Done: ${cleanup.rels.length} following scanned, ${nonFb} not following back.` +
        (relScan.expected != null && !relScan.complete ? ` Reached ${relScan.collected || 0}/${relScan.expected}; rerun Scan to continue.` : "");
    }
  }, 2000);
};

$("relMaster").onchange = () => {
  if ($("relMaster").checked) {
    for (const r of selectableRels()) selected.add(r.handle);
  } else {
    selected.clear();
  }
  document.querySelectorAll('#relRows input[data-h]').forEach((cb) => {
    if (!cb.disabled) cb.checked = $("relMaster").checked;
  });
  paintRelMaster();
  paintUnfollowBtn();
};
$("relDrop").onclick = async () => {
  if (!selected.size) {
    $("unfollowStatus").textContent = "Nothing selected.";
    return;
  }
  await chrome.runtime.sendMessage({ type: "XSTATS_DROP_REL", handles: [...selected] });
  selected.clear();
  $("unfollowStatus").textContent = "Removed from the list. A rescan brings them back.";
  refreshCleanup();
};
$("wlAdd").onclick = async () => {
  const h = $("wlInput").value.replace(/^@/, "").trim().toLowerCase();
  if (!h) return;
  await chrome.runtime.sendMessage({ type: "XSTATS_SET_WHITELIST", handles: [...cleanup.whitelist, h] });
  $("wlInput").value = "";
  await refreshCleanup();
};

$("startUnfollow").onclick = async () => {
  if (!selected.size) {
    $("unfollowStatus").textContent = "Tick at least one account first.";
    return;
  }
  const pace = cleanup.pace || { cap: 8, doneToday: 0, cooling: false };
  if (pace.cooling) {
    $("unfollowStatus").textContent = "Paused after an X warning. Resumes tomorrow.";
    return;
  }
  if (pace.doneToday >= pace.cap) {
    $("unfollowStatus").textContent = `Safe pace reached (${pace.doneToday}/${pace.cap} today). Continues tomorrow.`;
    return;
  }
  const n = selected.size;
  if (!confirm(`Unfollow ${n} account${n > 1 ? "s" : ""} at safe pace (${pace.cap}/day, about half a minute apart, with rests every 25)?`)) return;
  const handle = state.ctxHandle || (state.ownerHandle || "").replace(/^@/, "").trim();
  if (!handle) {
    $("unfollowStatus").textContent = "Scan a profile first, then run.";
    return;
  }
  const target = await ensureFollowingTab(handle);
  const handles = [...selected];
  await chrome.tabs.sendMessage(target.id, {
    type: "XSTATS_RUN_UNFOLLOW",
    handles,
    dryRun: false,
    delayMin: CLEANUP.delayMinSec,
    delayMax: CLEANUP.delayMaxSec,
    sessionMax: CLEANUP.sessionMax,
    breakMin: CLEANUP.breakMinSec,
    breakMax: CLEANUP.breakMaxSec,
  });
  if (unfollowTimer) clearInterval(unfollowTimer);
  unfollowTimer = setInterval(async () => {
    const { unfollowStatus: st } = await chrome.storage.local.get("unfollowStatus");
    if (!st) return;
    if (st.active) {
      if (st.onBreak) {
        const m = Math.round((st.breakSec || 0) / 60);
        $("unfollowStatus").textContent = `${st.done || 0}/${st.total || 0}, on break, resumes in ~${m}m.`;
      } else {
        $("unfollowStatus").textContent =
          `${st.done || 0}/${st.total || 0}` +
          (st.current ? `, on @${st.current}` : "") +
          (st.nextInSec ? `, next in ${st.nextInSec}s` : "");
      }
      return;
    }
    clearInterval(unfollowTimer);
    unfollowTimer = null;
    const end = st.status === "done" ? `Finished ${st.done}/${st.total}.`
      : st.status === "cap" ? `Safe pace reached at ${st.done}/${st.total}. Continues tomorrow.`
      : st.status === "hour" ? `Hourly burst guard at ${st.done}/${st.total}. Resumes within the hour.`
      : st.status === "cooldown" ? `Paused after an X warning at ${st.done}/${st.total}. Resumes tomorrow.`
      : st.status === "warning" ? `Stopped on X warning at ${st.done}/${st.total}. Wait a day before retrying.`
      : st.status === "wrong-tab" ? `Stopped: the scan tab left the following page at ${st.done}/${st.total}.`
      : `Stopped at ${st.done || 0}/${st.total || 0}.`;
    $("unfollowStatus").textContent = end + " Check the log.";
    await refreshCleanup();
  }, 2000);
};

// Note: no stop button by design. Runs are short, self-limiting, and stop
// on their own at the pace cap, burst guard, cooldown, or any X warning.
$("resetMine").onclick = async () => {
  if (!state.ownerHandle) {
    alert("Set the owner handle first, otherwise Mine means everything.");
    return;
  }
  if (!confirm("Delete all posts counted under My profile? Profile snapshots stay. Timeline-only posts stay.")) return;
  const res = await chrome.runtime.sendMessage({ type: "XSTATS_RESET_SCOPE", scope: "mine", ownerHandle: state.ownerHandle });
  if (res?.error) {
    alert(res.error);
    return;
  }
  await load();
};
$("resetAll").onclick = async () => {
  if (!state.ownerHandle) {
    alert("Set the owner handle first, otherwise nothing counts as timeline-only.");
    return;
  }
  if (!confirm("Delete timeline-only posts (not yours)? Your posts and profile snapshots stay.")) return;
  const res = await chrome.runtime.sendMessage({ type: "XSTATS_RESET_SCOPE", scope: "all", ownerHandle: state.ownerHandle });
  if (res?.error) {
    alert(res.error);
    return;
  }
  await load();
};
$("resetEverything").onclick = async () => {
  if (!confirm("Delete ALL tracked data (posts, profiles, relationships, logs)? Use this after switching X accounts. Owner and settings stay.")) return;
  await chrome.runtime.sendMessage({ type: "XSTATS_RESET_ALL" });
  await load();
  await refreshCleanup();
};
$("q").oninput = renderTable;
$("sort").onchange = renderTable;
$("csv").onclick = async () => {
  const { csv, count } = await chrome.runtime.sendMessage({ type: "XSTATS_EXPORT_CSV", days: state.days, scope: state.scope, ownerHandle: state.ownerHandle });
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `x-stats-${state.scope === "all" ? "all" : "personal"}-${state.days}d.csv`;
  a.click();
};
$("sync").onclick = async () => {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const target = tabs[0];
  if (!target) {
    alert("Open x.com in another tab first.");
    return;
  }
  let scraped = null;
  try {
    scraped = await chrome.tabs.sendMessage(target.id, { type: "XSTATS_SCRAPE_NOW" });
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      files: ["content/x-analytics.js"],
    });
    scraped = await chrome.tabs.sendMessage(target.id, { type: "XSTATS_SCRAPE_NOW" });
  }
  await chrome.runtime.sendMessage({ type: "XSTATS_SAVE_SCRAPE", payload: scraped });
  await load();
};

// ---- analytics CSV import: X exports max 30 days / 3,000 posts per file ----
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseAnalyticsCsv(text, ownerHandle) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const heads = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (...names) => heads.findIndex((h) => names.some((n) => h.includes(n)));
  const iId = col("tweet id", "tweetid");
  const iLink = col("tweet permalink", "permalink", "tweet url", "url", "link");
  const iText = col("tweet text", "text", "content");
  const iTime = col("time", "date", "created", "timestamp");
  const iViews = col("impressions", "views");
  const iLikes = col("likes");
  const iReposts = col("retweets", "reposts");
  const iReplies = col("replies");
  const iBm = col("bookmarks", "bookmark");
  const num = (row, i) => {
    if (i < 0 || i >= row.length) return 0;
    const n = Number(String(row[i]).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const link = iLink >= 0 ? cells[iLink] : "";
    const id = (iId >= 0 && cells[iId]?.trim()) || (link.match(/status\/(\d+)/) || [])[1] || null;
    if (!id) continue;
    let postedAt = null;
    if (iTime >= 0 && cells[iTime]) {
      const t = new Date(cells[iTime].replace(" ", "T"));
      if (!Number.isNaN(t.getTime())) postedAt = t.toISOString();
    }
    rows.push({
      id: String(id).trim(),
      url: link || `https://x.com/i/status/${id}`,
      handle: ownerHandle || null,
      postedAt,
      views: num(cells, iViews),
      likes: num(cells, iLikes),
      reposts: num(cells, iReposts),
      replies: num(cells, iReplies),
      bookmarks: num(cells, iBm),
      text: (iText >= 0 ? cells[iText] : "").slice(0, 400),
      source: "analytics-csv",
    });
  }
  return rows;
}

$("importCsv").onclick = async () => {
  const files = [...($("csvFiles").files || [])];
  if (!files.length) {
    $("importStatus").textContent = "Pick one or more CSV files first.";
    return;
  }
  let rows = [];
  for (const f of files) {
    rows.push(...parseAnalyticsCsv(await f.text(), state.ownerHandle));
  }
  if (!rows.length) {
    $("importStatus").textContent = "No tweet rows recognized. Check the file is an X analytics export.";
    return;
  }
  const dates = rows.map((r) => r.postedAt).filter(Boolean).sort();
  $("importStatus").textContent = `Parsed ${rows.length} rows${dates.length ? ` (${dates[0].slice(0, 10)}..${dates[dates.length - 1].slice(0, 10)})` : ""}, importing...`;
  let done = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await chrome.runtime.sendMessage({ type: "XSTATS_IMPORT_POSTS", rows: rows.slice(i, i + 500) });
    done += res?.imported || 0;
  }
  $("importStatus").textContent = `Imported ${done} posts. They merge with synced data by tweet id.`;
  await load();
};
try {
  const { scan } = await chrome.storage.local.get("scan");
  if (scan?.active) {
    stopPolling();
    scanTimer = setInterval(pollScan, 2000);
    void pollScan();
  }
} catch (_) {
  // ignore
}

await load();
