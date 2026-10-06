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

test("replay schedule covers ~1s in breadth-first order", () => {
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
