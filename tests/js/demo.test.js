"use strict";
// Unit tests for site/demo.js (GitHub Pages replay). Run with: node --test tests/js/demo.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const D = require(path.join(__dirname, "..", "..", "site", "demo.js"));
const data = require(path.join(__dirname, "..", "..", "site", "demo-crawl.json"));
const graph = data.graph;
const times = D.schedule(graph);

test("recording is a finished crawl with one page record per node", () => {
  assert.equal(graph.status, "done");
  assert.equal(data.pages.length, graph.nodes.length);
  graph.nodes.forEach((n, i) => assert.equal(n.id, i));
  for (const e of graph.edges) assert.ok(e.source < e.target, "parents are discovered before children");
  assert.ok(graph.nodes.some((n) => n.state === "failed"), "demo shows a failure color too");
});

test("schedule: children start after their parent finishes, never more than 4 at once", () => {
  const parent = new Map(graph.edges.map((e) => [e.target, e.source]));
  times.forEach((t, i) => {
    assert.ok(t.found <= t.start && t.start < t.end);
    if (parent.has(i)) assert.ok(t.found >= times[parent.get(i)].end);
    if (i) assert.ok(t.found >= times[i - 1].found);
  });
  const edgesT = times.flatMap((t) => [t.start, t.end]);
  for (const at of edgesT) {
    assert.ok(times.filter((t) => t.start <= at && at < t.end).length <= D.CONCURRENCY);
  }
});

test("snapshots grow as a prefix, move queued -> crawling -> final, then finish", () => {
  const end = Math.max(...times.map((t) => t.end));
  let prev = 0;
  for (let t = 0; t <= end + 100; t += 50) {
    const s = D.snapshotAt(graph, times, t, "x".repeat(32));
    assert.equal(s.id, "x".repeat(32));
    assert.ok(s.nodes.length >= prev);
    prev = s.nodes.length;
    s.nodes.forEach((n, i) => assert.equal(n.id, i));
    for (const e of s.edges) assert.ok(e.source < s.nodes.length && e.target < s.nodes.length);
    assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), s.nodes.length);
    assert.ok(s.nodes.filter((n) => n.state === "crawling").length <= D.CONCURRENCY);
    assert.equal(s.status, t >= end ? "done" : "running");
  }
  const first = D.snapshotAt(graph, times, 0);
  assert.deepEqual(first.nodes.map((n) => n.state), ["crawling"]);
  assert.deepEqual(D.snapshotAt(graph, times, Infinity).nodes, graph.nodes);
});

test("durations are deterministic and in range", () => {
  for (let i = 0; i < 100; i++) {
    assert.equal(D.duration(i), D.duration(i));
    assert.ok(D.duration(i) >= 260 && D.duration(i) <= 620);
  }
});
