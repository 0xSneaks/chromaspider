"use strict";
// GitHub Pages demo. Answers the UI's /api/* calls from a recorded crawl (demo-crawl.json) and replays it
// on a simulated timeline. The only network request this page makes is for the recording itself.
(function (root, factory) {
  const demo = factory();
  if (typeof module === "object" && module.exports) module.exports = demo;
  else { root.ChromaspiderDemo = demo; demo.install(root); }
})(typeof self !== "undefined" ? self : this, () => {
  const CONCURRENCY = 4;  // the crawler's default worker count

  // Deterministic stand-in for each page's fetch time (260-620ms).
  function duration(id) {
    return 260 + ((id * 7919) % 9) * 45;
  }

  // Simulated timeline for a recorded graph: when each page was discovered, started and finished.
  // Node ids are discovery order, so discovery times are kept non-decreasing in id.
  function schedule(graph, concurrency = CONCURRENCY, dur = duration) {
    const parent = new Map();
    for (const e of graph.edges) if (!parent.has(e.target)) parent.set(e.target, e.source);
    const workers = new Array(concurrency).fill(0);
    const times = [];
    let lastFound = 0;
    for (const n of graph.nodes) {
      const p = parent.get(n.id);
      const found = Math.max(lastFound, p !== undefined && times[p] ? times[p].end : 0);
      lastFound = found;
      let w = 0;
      for (let k = 1; k < workers.length; k++) if (workers[k] < workers[w]) w = k;
      const start = Math.max(found, workers[w]);
      workers[w] = start + dur(n.id);
      times.push({ found, start, end: workers[w] });
    }
    return times;
  }

  // The graph as the API would have returned it `t` ms into the replay.
  function snapshotAt(graph, times, t, id = graph.id) {
    const nodes = [];
    for (const n of graph.nodes) {
      const tm = times[n.id];
      if (tm.found > t) break;
      if (t < tm.start) nodes.push({ ...n, state: "queued", color: "gray", status: null, elapsed_ms: null });
      else if (t < tm.end) nodes.push({ ...n, state: "crawling", color: "cyan", status: null, elapsed_ms: null });
      else nodes.push({ ...n });
    }
    const edges = graph.edges.filter((e) => e.source < nodes.length && e.target < nodes.length);
    const counts = {};
    for (const n of nodes) counts[n.state] = (counts[n.state] || 0) + 1;
    const done = nodes.length === graph.nodes.length && times.every((tm) => tm.end <= t);
    return { ...graph, id, status: done ? graph.status : "running", nodes, edges, counts };
  }

  function install(win) {
    const doc = win.document;
    const realFetch = win.fetch.bind(win);
    let data = null, times = null;
    const runs = new Map();  // crawl id -> replay start time
    const load = () => data ? Promise.resolve(data) : realFetch("demo-crawl.json")
      .then((r) => r.json()).then((d) => { data = d; times = schedule(d.graph); return d; });
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const newId = () => Array.from(win.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

    win.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, win.location.href);
      const at = url.pathname.indexOf("/api/");
      if (at < 0) return realFetch(input, init);
      const d = await load();
      const path = url.pathname.slice(at);
      let m;
      if (path === "/api/crawl" && (init.method || "GET").toUpperCase() === "POST") {
        const id = newId();
        runs.set(id, win.performance.now());
        return json({ id, status: "running" }, 202);
      }
      if ((m = path.match(/^\/api\/crawls\/([0-9a-f]{32})\/graph$/))) {
        const started = runs.get(m[1]);
        return json(snapshotAt(d.graph, times, started === undefined ? Infinity : win.performance.now() - started, m[1]));
      }
      if ((m = path.match(/^\/api\/crawls\/[0-9a-f]{32}\/pages\/(\d+)$/))) {
        const p = d.crawl.pages[Number(m[1])];
        return p ? json(p) : json({ detail: "page not found" }, 404);
      }
      if ((m = path.match(/^\/api\/crawls\/([0-9a-f]{32})\/export$/))) {
        if (url.searchParams.get("format") === "markdown") {
          return new Response(d.markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
        }
        return json({ ...d.crawl, id: m[1] });
      }
      if ((m = path.match(/^\/api\/crawls\/([0-9a-f]{32})$/))) return json({ ...d.crawl, id: m[1] });
      if (path === "/api/health") return json({ ok: true, demo: true });
      return json({ detail: "not available in the demo" }, 404);
    };

    // Downloads are plain links to /api/... on a real server; serve them from the recording here.
    doc.addEventListener("click", async (ev) => {
      const a = ev.target.closest && ev.target.closest("#dl-json, #dl-md");
      if (!a || a.getAttribute("aria-disabled") === "true") return;
      ev.preventDefault();
      const d = await load();
      const md = a.id === "dl-md";
      const blob = new Blob([md ? d.markdown : JSON.stringify(d.crawl, null, 2)],
                            { type: md ? "text/markdown" : "application/json" });
      const link = doc.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = md ? "chromaspider-demo.md" : "chromaspider-demo.json";
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }, true);

    // Lock the form to the recorded crawl and start a replay once the UI is ready.
    doc.addEventListener("DOMContentLoaded", async () => {
      const d = await load();
      const req = d.crawl.request;
      const set = (sel, prop, value) => { const el = doc.querySelector(sel); if (el) el[prop] = value; };
      set("#url", "value", req.url);
      set("#url", "readOnly", true);
      set("#depth", "value", req.depth);
      set("#max_pages", "value", req.max_pages);
      for (const sel of ["#depth", "#max_pages", "#same_domain", "#render_mode"]) set(sel, "disabled", true);
      set("#go", "textContent", "REPLAY");
      const form = doc.querySelector("#crawl-form");
      if (form && !/^#[0-9a-f]{32}$/.test(win.location.hash)) form.requestSubmit();
    });
  }

  return { CONCURRENCY, duration, schedule, snapshotAt, install };
});
