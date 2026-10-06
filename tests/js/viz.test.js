"use strict";
// Unit tests for chromaspider/static/viz.js. Run with: node --test tests/js/viz.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const V = require(path.join(__dirname, "..", "..", "chromaspider", "static", "viz.js"));

const node = (id, depth, state = "ok") => ({ id, depth, state });

test("polls every ~100ms while running, backs off when hidden, stops when finished", () => {
  assert.equal(V.POLL_RUNNING_MS, 100);
  assert.equal(V.pollDelay("running", false), 100);
  assert.equal(V.pollDelay("running", true), V.POLL_HIDDEN_MS);
  assert.equal(V.pollDelay("done", false), null);
  assert.equal(V.pollDelay("failed", false), null);
});

test("signature changes on growth, state change and status change only", () => {
  const g = { status: "running", nodes: [node(0, 0, "crawling")], edges: [] };
  const same = { status: "running", nodes: [node(0, 0, "crawling")], edges: [] };
  assert.equal(V.signature(g), V.signature(same));
  assert.notEqual(V.signature(g), V.signature({ ...g, nodes: [node(0, 0, "ok")] }));
  assert.notEqual(V.signature(g), V.signature({ ...g, status: "done" }));
  assert.notEqual(V.signature(g), V.signature({ ...g, nodes: [...g.nodes, node(1, 1, "queued")] }));
  const states = ["ok", "crawling", "browser", "skipped", "redirected", "failed", "queued"];
  const sigs = states.map((s) => V.signature({ status: "running", nodes: [node(0, 0, s)], edges: [] }));
  assert.equal(new Set(sigs).size, states.length);
});

test("reveal order spreads outward from the root, then by discovery order", () => {
  const order = V.revealOrder([node(4, 2), node(1, 1), node(0, 0), node(3, 1), node(2, 2)]).map((n) => n.id);
  assert.deepEqual(order, [0, 1, 3, 2, 4]);
});

test("replays only a finished crawl the UI mostly missed, never with reduced motion", () => {
  assert.equal(V.shouldReplay("done", 20, 20, false), true);    // finished before the first poll
  assert.equal(V.shouldReplay("done", 20, 6, false), true);     // missed a big chunk
  assert.equal(V.shouldReplay("done", 20, 2, false), false);    // watched nearly all of it live
  assert.equal(V.shouldReplay("done", 1, 1, false), false);     // nothing to spread
  assert.equal(V.shouldReplay("running", 20, 20, false), false);
  assert.equal(V.shouldReplay("done", 20, 20, true), false);
  assert.equal(V.shouldReplay("failed", 10, 10, false), true);
});

test("replay schedule covers ~3s in breadth-first order", () => {
  assert.equal(V.REPLAY_MS, 3000);
  const nodes = Array.from({ length: 25 }, (_, i) => node(i, i === 0 ? 0 : 1 + (i % 3)));
  const sched = V.replaySchedule(nodes);
  assert.equal(sched.length, 25);
  assert.equal(sched[0].id, 0);
  assert.equal(sched[0].at, 0);
  const ats = sched.map((s) => s.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
  assert.ok(ats[ats.length - 1] < V.REPLAY_MS && ats[ats.length - 1] >= V.REPLAY_MS * 0.9);
  const depthAt = sched.map((s) => nodes.find((n) => n.id === s.id).depth);
  assert.deepEqual(depthAt, [...depthAt].sort((a, b) => a - b));
  assert.deepEqual(V.replaySchedule([]), []);
});

test("easing is clamped", () => {
  assert.equal(V.easeOutCubic(-1), 0);
  assert.equal(V.easeOutCubic(0), 0);
  assert.equal(V.easeOutCubic(1), 1);
  assert.equal(V.easeOutCubic(5), 1);
  assert.ok(V.easeOutCubic(0.5) > 0.5);
});

// ------------------------------------------------------------ crawl wall
test("wall grid fits up to 12 page tiles inside the box, biggest tiles first", () => {
  for (const [n, W, H] of [[1, 358, 500], [2, 358, 500], [5, 358, 500], [12, 358, 500], [12, 1000, 600]]) {
    const { rects, cols, rows } = V.wallGrid(n, W, H);
    assert.equal(rects.length, n);
    assert.ok(cols * rows >= n && cols <= 4);
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6);
      assert.ok(Math.abs(r.w / r.h - V.TILE_W / V.TILE_H) < 1e-9);
    }
  }
  assert.equal(V.wallGrid(12, 358, 500).cols, 3);   // phone portrait: 3 x 4
  assert.equal(V.wallGrid(12, 1000, 600).cols, 4);  // desktop: 4 x 3
  assert.ok(V.wallGrid(1, 358, 500).rects[0].w > V.wallGrid(4, 358, 500).rects[0].w);
});

test("markdown becomes plain words; markup, code and link targets are dropped", () => {
  const words = V.plainWords("# Title *bold*\n\n[link text](https://x.test) ![alt](i.png) `tick` - item\n```js\nalert(1)\n```\n<script>evil()</script> 42 -- **");
  assert.deepEqual(words, ["Title", "bold", "link", "text", "tick", "item", "evil()", "42"]);
  assert.equal(V.plainWords("a ".repeat(1000)).length, 400);
  assert.deepEqual(V.plainWords(null), []);
});

test("word wrap respects width and line limit", () => {
  const measure = (w) => w.length * 10;
  const out = V.wrapWords(["aaaa", "bbbb", "cc", "dddddd", "e", "ffff"], measure, 100, 2);
  assert.deepEqual(out.map((w) => [w.text, w.line]), [["aaaa", 0], ["bbbb", 0], ["cc", 1], ["dddddd", 1], ["e", 1]]);
  for (const w of out) assert.ok(w.x + w.w <= 100);
  assert.equal(V.wrapWords(["x".repeat(50)], measure, 100, 1)[0].w, 100);  // overlong word is clamped
});

test("leg knee keeps both segment lengths and bends to the requested side", () => {
  for (const [fx, fy] of [[20, 0], [10, 18], [-5, 25]]) {
    const k = V.legKnee(0, 0, fx, fy, 15, 17, 1);
    assert.ok(Math.abs(Math.hypot(k.x, k.y) - 15) < 1e-6);
    assert.ok(Math.abs(Math.hypot(fx - k.x, fy - k.y) - 17) < 1e-6);
  }
  assert.ok(V.legKnee(0, 0, 20, 0, 15, 15, 1).y > 0);
  assert.ok(V.legKnee(0, 0, 20, 0, 15, 15, -1).y < 0);
  const far = V.legKnee(0, 0, 100, 0, 15, 17, 1);  // out of reach: straightens instead of breaking
  assert.ok(Number.isFinite(far.x) && Number.isFinite(far.y));
});

test("spiders double per tile and stay under the wall cap", () => {
  assert.deepEqual([0, 650, 1300, 1950].map((t) => V.spidersFor(t, 1)), [1, 2, 4, 8]);
  assert.equal(V.spidersFor(1e9, 1), 12);
  assert.ok(V.spidersFor(1e9, 12) * 12 <= V.WALL_MAX_SPIDERS);
  assert.equal(V.spidersFor(-5, 3), 1);
});

test("highlight styles cover the reference looks", () => {
  const seen = new Set();
  for (let r = 0; r < 1; r += 0.01) seen.add(V.pickHighlight(r));
  for (const fx of ["yellow", "cyan", "box", "pink", "mono", "big", "vertical", "plain"]) assert.ok(seen.has(fx), fx);
  assert.equal(V.pickHighlight(0.999999), V.HIGHLIGHTS[V.HIGHLIGHTS.length - 1]);
});
