import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { totals, filterScope, isMine, effectiveHandle, followerDelta } from "../src/lib/range.js";
import { describePage } from "../src/lib/page.js";
import { jitterDelaySec, sortCleanup } from "../src/lib/cleanup.js";

describe("range", () => {
  it("totals engagement rate", () => {
    const t = totals([{ views: 1000, likes: 50, reposts: 10, replies: 5, bookmarks: 2 }]);
    assert.equal(t.views, 1000);
    assert.equal(t.engagements, 67);
    assert.equal(t.engagementRate, 6.7);
  });

  it("derives handle from status urls", () => {
    assert.equal(effectiveHandle({ url: "https://x.com/someone/status/1" }), "someone");
    assert.equal(effectiveHandle({ handle: "me" }), "me");
    assert.equal(effectiveHandle({}), null);
  });

  it("splits mine from all", () => {
    const posts = [{ handle: "me" }, { handle: "other" }, {}];
    assert.equal(filterScope(posts, "mine", "me").length, 2);
    assert.equal(filterScope(posts, "all", "me").length, 3);
    assert.ok(isMine({ handle: "ME" }, "me"));
  });

  it("follower delta needs two snapshots", () => {
    assert.equal(followerDelta([{ followers: 10 }]), null);
    const d = followerDelta([{ followers: 10 }, { followers: 15 }]);
    assert.equal(d.change, 5);
  });
});

describe("page", () => {
  it("classifies profiles, posts, and home", () => {
    assert.equal(describePage("https://x.com/sqfdz").kind, "profile");
    assert.equal(describePage("https://x.com/sqfdz/status/1").kind, "post");
    assert.equal(describePage("https://x.com/home").kind, "home");
    assert.equal(describePage("https://x.com/explore").kind, "other");
    assert.equal(describePage("https://example.com/").kind, "other");
  });
});

describe("cleanup", () => {
  it("jitter stays in range", () => {
    for (let i = 0; i < 50; i++) {
      const d = jitterDelaySec(25, 45);
      assert.ok(d >= 25 && d <= 45);
    }
  });

  it("sorts non-followbacks first", () => {
    const rows = sortCleanup([
      { handle: "b", followsBack: true },
      { handle: "a", followsBack: false },
    ]);
    assert.equal(rows[0].handle, "a");
  });
});
