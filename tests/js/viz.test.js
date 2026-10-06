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

test("replay lasts 3 seconds", () => {
  assert.equal(V.REPLAY_MS, 3000);
});

test("spider walks tree edges: down to children, back up between siblings and cousins", () => {
  // 0 -> 1, 2 ; 1 -> 3 ; 2 -> 4
  const parent = new Map([[1, 0], [2, 0], [3, 1], [4, 2]]);
  assert.deepEqual(V.treePath(parent, null, 0), [0]);   // first page: drop in
  assert.deepEqual(V.treePath(parent, 0, 0), [0]);
  assert.deepEqual(V.treePath(parent, 0, 1), [0, 1]);   // parent -> child along the edge
  assert.deepEqual(V.treePath(parent, 1, 2), [1, 0, 2]);
  assert.deepEqual(V.treePath(parent, 3, 4), [3, 1, 0, 2, 4]);
  assert.deepEqual(V.treePath(parent, 4, 0), [4, 2, 0]);
  assert.deepEqual(V.treePath(parent, 0, 9), [0, 9]);   // unconnected: straight hop
  const loop = new Map([[1, 2], [2, 1]]);                // malformed input must not hang
  assert.deepEqual(V.treePath(loop, 1, 5), [1, 5]);
});

test("path length sums segment distances and skips unknown points", () => {
  const pts = new Map([[0, { x: 0, y: 0 }], [1, { x: 3, y: 4 }], [2, { x: 3, y: 10 }]]);
  const pt = (id) => pts.get(id) || null;
  assert.equal(V.pathLength([0, 1, 2], pt), 11);
  assert.equal(V.pathLength([0], pt), 0);
  assert.equal(V.pathLength([0, 7], pt), 0);
});

test("replay pacing fills the 3s budget exactly", () => {
  for (const [len, n] of [[1200, 30], [50, 3], [5000, 200]]) {
    const { speed, pause } = V.replayPacing(len, n);
    assert.ok(pause <= V.SPIDER_PAUSE_MS && pause >= 0);
    assert.ok(Math.abs(len / speed + pause * n - V.REPLAY_MS) < 1);
  }
  assert.ok(V.replayPacing(0, 1).speed > 0);
});

test("live spider speeds up and rests less when it falls behind, within limits", () => {
  assert.equal(V.liveSpeed(0), V.SPIDER_SPEED);
  assert.equal(V.livePause(0), V.SPIDER_PAUSE_MS);
  assert.ok(V.liveSpeed(6) > V.liveSpeed(0));
  assert.ok(V.livePause(6) < V.livePause(0));
  assert.equal(V.liveSpeed(10000), V.SPIDER_SPEED * 8);
});

test("spider scales up on small screens so it stays visible", () => {
  const phone = 326 / 600;  // 390px phone: ~326px graph width for a 600-unit viewBox
  assert.ok(V.spiderScale(phone) * V.SPIDER_SPAN * phone >= V.SPIDER_MIN_PX - 0.01);
  assert.equal(V.spiderScale(1.2), 1);   // desktop: natural size
  assert.equal(V.spiderScale(0.01), 2.2); // capped
  assert.equal(V.spiderScale(0), 1);
});

test("spider turns the short way toward its heading", () => {
  assert.equal(V.turnToward(0, 90, 1), 90);
  assert.equal(V.turnToward(170, -170, 1), 190);  // +20, not -340
  assert.equal(V.turnToward(0, 90, 0.5), 45);
});

test("legs alternate in two opposite tripods", () => {
  const phase = Math.PI / 2;
  const a = V.legSwing(phase, 0, 1), b = V.legSwing(phase, 1, 1), c = V.legSwing(phase, 0, -1);
  assert.ok(a > 0 && Math.abs(a + b) < 1e-9 && Math.abs(a + c) < 1e-9);
  assert.equal(V.legSwing(0, 0, 1), 0);
});

test("easing is clamped", () => {
  assert.equal(V.easeOutCubic(-1), 0);
  assert.equal(V.easeOutCubic(0), 0);
  assert.equal(V.easeOutCubic(1), 1);
  assert.equal(V.easeOutCubic(5), 1);
  assert.ok(V.easeOutCubic(0.5) > 0.5);
});
