"use strict";
// Chromaspider UI. All crawled content is rendered with textContent only.
(() => {
  const $ = (s) => document.querySelector(s);
  const SVG = "http://www.w3.org/2000/svg";
  const V = window.ChromaspiderViz;
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = () => motionQuery.matches;
  const state = { id: null, graph: null, selected: null, timer: null, sig: null };

  const form = $("#crawl-form"), msg = $("#message"), goBtn = $("#go");

  function say(text, isError = false) {
    if (msg.textContent !== text) msg.textContent = text;  // avoid re-announcing on every poll
    msg.classList.toggle("error", isError);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error(typeof body === "object" ? formatDetail(body.detail) : body);
    return body;
  }

  function formatDetail(d) {
    if (Array.isArray(d)) return d.map((e) => `${(e.loc || []).slice(1).join(".")}: ${e.msg}`).join("; ");
    return String(d || "request failed");
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    let url = $("#url").value.trim();
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    const body = {
      url,
      depth: Number($("#depth").value),
      max_pages: Number($("#max_pages").value),
      same_domain: $("#same_domain").checked,
      render_mode: $("#render_mode").value,
    };
    goBtn.disabled = true;
    say("Starting crawl…");
    try {
      const r = await api("/api/crawl", { method: "POST", body: JSON.stringify(body) });
      state.id = r.id;
      state.sig = null;
      state.selected = null;
      $("#inspector").hidden = true;
      setExports(true);
      try { history.replaceState(null, "", `#${r.id}`); } catch (_) {}
      poll();
    } catch (e) {
      say(e.message, true);
      goBtn.disabled = false;
    }
  });

  async function poll() {
    clearTimeout(state.timer);
    if (!state.id) return;
    const id = state.id;
    try {
      const g = await api(`/api/crawls/${id}/graph`);
      if (id !== state.id) return;  // a newer crawl started while this request was in flight
      state.graph = g;
      const sig = V.signature(g);
      if (sig !== state.sig) {
        state.sig = sig;
        draw(g);
        const c = g.counts || {};
        const parts = Object.entries(c).map(([k, v]) => `${k} ${v}`).join(" · ");
        $("#summary").textContent = `${g.status.toUpperCase()} · ${g.nodes.length} pages${parts ? " · " + parts : ""}`;
      }
      const delay = V.pollDelay(g.status, document.hidden);
      if (delay !== null) {
        say("Crawling… follow the colors.");
        state.timer = setTimeout(poll, delay);
      } else {
        say(g.status === "done" ? "Crawl finished. Tap a node to inspect it." : "Crawl failed.", g.status !== "done");
        goBtn.disabled = false;
      }
    } catch (e) {
      say(e.message, true);
      goBtn.disabled = false;
    }
  }

  // ------------------------------------------------------------ graph
  function layout(g) {
    // Radial tree: depth = ring, each subtree gets an angular slice sized by its leaves.
    const kids = new Map(), hasParent = new Set();
    for (const e of g.edges) {
      if (!kids.has(e.source)) kids.set(e.source, []);
      kids.get(e.source).push(e.target);
      hasParent.add(e.target);
    }
    const roots = g.nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
    const leaves = new Map();
    const count = (id, seen = new Set()) => {
      if (seen.has(id)) return 1;
      seen.add(id);
      const ch = kids.get(id) || [];
      const n = ch.length ? ch.reduce((s, c) => s + count(c, seen), 0) : 1;
      leaves.set(id, n);
      return n;
    };
    roots.forEach((r) => count(r));
    const total = roots.reduce((s, r) => s + (leaves.get(r) || 1), 0) || 1;
    const maxDepth = Math.max(1, ...g.nodes.map((n) => n.depth));
    const ring = 250 / maxDepth;
    const pos = new Map();
    const place = (id, a0, a1, depth) => {
      const a = (a0 + a1) / 2, r = roots.length === 1 && depth === 0 ? 0 : (depth + (roots.length > 1 ? 1 : 0)) * ring * 0.9;
      pos.set(id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
      const ch = kids.get(id) || [];
      const sum = ch.reduce((s, c) => s + (leaves.get(c) || 1), 0) || 1;
      let cur = a0;
      for (const c of ch) {
        if (pos.has(c)) continue;
        const span = (a1 - a0) * (leaves.get(c) || 1) / sum;
        place(c, cur, cur + span, depth + 1);
        cur += span;
      }
    };
    let cur = -Math.PI / 2;
    for (const r of roots) {
      const span = (2 * Math.PI * (leaves.get(r) || 1)) / total;
      place(r, cur, cur + span, 0);
      cur += span;
    }
    return pos;
  }

  // Live view: node/edge elements persist across polls so state changes can transition, new nodes
  // spawn from their parent and slide outward, and a crawl that finished too fast to watch is replayed.
  const view = { crawl: null, nodes: new Map(), edges: new Map(), pending: new Set(),
                 data: new Map(), parent: new Map(), pos: new Map(), big: false, raf: 0 };

  function resetView(crawlId) {
    cancelAnimationFrame(view.raf);
    view.raf = 0;
    $("#edges").replaceChildren();
    $("#nodes").replaceChildren();
    view.nodes.clear(); view.edges.clear(); view.pending.clear();
    view.crawl = crawlId;
    resetSpider();
  }

  function draw(g) {
    if (view.crawl !== g.id) resetView(g.id);
    const now = performance.now();
    view.pos = layout(g);
    view.data = new Map(g.nodes.map((n) => [n.id, n]));
    view.parent = new Map();
    for (const e of g.edges) if (!view.parent.has(e.target)) view.parent.set(e.target, e.source);
    view.big = g.nodes.length > 60;
    for (const v of view.nodes.values()) {
      const n = view.data.get(v.id);
      if (!n) continue;
      retarget(v, now);
      decorate(v, n);
      if (!v.flashUntil) setNodeState(v, n.state);
    }
    const unseen = g.nodes.filter((n) => !view.nodes.has(n.id) && !view.pending.has(n.id));
    if (unseen.length) {
      const ordered = V.revealOrder(unseen);
      if (V.shouldReplay(g.status, g.nodes.length, unseen.length, reducedMotion())) {
        // The spider replays the crawl: each page appears as it walks onto it.
        for (const n of ordered) view.pending.add(n.id);
        planReplay(ordered.map((n) => n.id));
      } else {
        for (const n of ordered) reveal(n, false, now);
        if (reducedMotion()) placeSpider(ordered[ordered.length - 1].id);
        else for (const n of ordered) spider.queue.push({ id: n.id, reveal: false });
      }
    }
    kick();
  }

  function reveal(n, flash, now, fromParent = true) {
    const v = makeNode(n);
    const p = view.pos.get(n.id) || { x: 0, y: 0 };
    const from = fromParent && view.nodes.get(view.parent.get(n.id));  // spawn at the parent, then crawl outward
    v.x = v.fx = from ? from.x : p.x;
    v.y = v.fy = from ? from.y : p.y;
    v.tx = p.x; v.ty = p.y; v.t0 = now;
    v.grp.setAttribute("transform", `translate(${v.x},${v.y})`);
    decorate(v, n);
    if (flash && n.state !== "crawling") { v.flashUntil = now + V.FLASH_MS; setNodeState(v, "crawling"); }
    else setNodeState(v, n.state);
    if (!reducedMotion()) v.grp.classList.add("enter");
    v.grp.classList.toggle("sel", state.selected === n.id);
    view.nodes.set(n.id, v);
    $("#nodes").appendChild(v.grp);
    for (const e of state.graph ? state.graph.edges : []) {
      if (e.source === n.id || e.target === n.id) connect(e.source, e.target);
    }
  }

  function connect(s, t) {
    const key = `${s}>${t}`;
    if (view.edges.has(key) || !view.nodes.has(s) || !view.nodes.has(t)) return;
    let l;
    if (spider.silk && spider.silk.key === key) {  // the thread the spider just spun becomes the edge
      l = spider.silk.el;
      l.removeAttribute("class");
      spider.silk = null;
    } else {
      l = document.createElementNS(SVG, "line");
      if (!reducedMotion()) l.setAttribute("class", "enter");
    }
    const edge = { s, t, el: l };
    placeEdge(edge);
    view.edges.set(key, edge);
    $("#edges").appendChild(l);
  }

  function placeEdge(e) {
    const a = view.nodes.get(e.s), b = view.nodes.get(e.t);
    e.el.setAttribute("x1", a.x); e.el.setAttribute("y1", a.y);
    // A gradient stroke sized to the line's bounding box vanishes on perfectly flat/upright lines.
    e.el.setAttribute("x2", Math.abs(a.x - b.x) < 0.01 ? b.x + 0.01 : b.x);
    e.el.setAttribute("y2", Math.abs(a.y - b.y) < 0.01 ? b.y + 0.01 : b.y);
  }

  function retarget(v, now) {
    const p = view.pos.get(v.id);
    if (!p || (p.x === v.tx && p.y === v.ty)) return;
    v.fx = v.x; v.fy = v.y; v.tx = p.x; v.ty = p.y; v.t0 = now;
  }

  function makeNode(n) {
    const grp = document.createElementNS(SVG, "g");
    grp.setAttribute("class", "node");
    grp.setAttribute("tabindex", "0");
    grp.setAttribute("role", "button");
    const body = document.createElementNS(SVG, "g");  // scaled on entry; grp carries the position
    body.setAttribute("class", "body");
    const hit = document.createElementNS(SVG, "circle");  // generous touch target
    hit.setAttribute("class", "hit");
    hit.setAttribute("r", 16);
    const ring = document.createElementNS(SVG, "circle");  // crawl pulse / settle burst
    ring.setAttribute("class", "ring");
    const core = document.createElementNS(SVG, "circle");
    core.setAttribute("class", "core");
    core.setAttribute("filter", "url(#glow)");
    body.append(hit, ring, core);
    const title = document.createElementNS(SVG, "title");
    const label = document.createElementNS(SVG, "text");
    label.setAttribute("x", 10); label.setAttribute("y", 3);
    grp.append(body, title, label);
    const open = () => inspect(n.id);
    grp.addEventListener("click", open);
    grp.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
    grp.addEventListener("animationend", (ev) => {
      if (ev.animationName === "node-in") grp.classList.remove("enter");
      if (ev.animationName === "ring-settle") grp.classList.remove("settle");
    });
    return { id: n.id, grp, ring, core, title, label, shown: null, flashUntil: 0,
             x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t0: null };
  }

  function decorate(v, n) {
    const r = n.depth === 0 ? 11 : view.big ? 5 : 7;
    v.core.setAttribute("r", r);
    v.ring.setAttribute("r", r);
    v.title.textContent = `${n.state.toUpperCase()} ${n.status ?? ""} ${n.url}`;
    v.label.textContent = view.big ? "" : shortLabel(n);
  }

  function setNodeState(v, s) {
    if (v.shown === s) return;
    const prev = v.shown;
    if (prev) v.grp.classList.remove(prev);
    v.grp.classList.add(s);
    v.shown = s;
    // A finished page: core color transitions via CSS, and the ring bursts once in the new color.
    if (prev && s !== "queued" && s !== "crawling" && !reducedMotion()) v.grp.classList.add("settle");
  }

  function markSelected() {
    for (const v of view.nodes.values()) v.grp.classList.toggle("sel", v.id === state.selected);
  }

  function kick() {
    if (!view.raf) view.raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    view.raf = 0;
    let busy = stepSpider(now);
    const moved = new Set();
    const snap = reducedMotion();
    for (const v of view.nodes.values()) {
      if (v.flashUntil) {
        if (now >= v.flashUntil) {
          v.flashUntil = 0;
          const n = view.data.get(v.id);
          if (n) setNodeState(v, n.state);
        } else busy = true;
      }
      if (v.t0 === null) continue;
      const k = snap ? 1 : V.easeOutCubic((now - v.t0) / V.TWEEN_MS);
      v.x = v.fx + (v.tx - v.fx) * k;
      v.y = v.fy + (v.ty - v.fy) * k;
      v.grp.setAttribute("transform", `translate(${v.x},${v.y})`);
      moved.add(v.id);
      if (k >= 1) v.t0 = null; else busy = true;
    }
    if (moved.size) for (const e of view.edges.values()) if (moved.has(e.s) || moved.has(e.t)) placeEdge(e);
    drawSpider();
    if (busy) kick();
  }

  // ------------------------------------------------------------ spider
  // A purely visual walker: it follows tree edges from page to page behind the real crawl and,
  // during a replay, reveals each page as it arrives. It never affects polling or the crawler.
  const LEG_HIPS = [3.4, 1.4, -0.6, -2.6];
  const LEG_BASE = [-40, -14, 12, 38];  // front legs reach forward, back legs trail
  const spider = { el: null, legs: [], x: 0, y: 0, angle: 0, scale: 1, at: null, queue: [], entry: null,
                   path: null, seg: 0, segDist: 0, speed: 0, pause: 0, pauseUntil: 0, phase: 0,
                   walking: false, silk: null, last: 0 };

  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  function buildSpider() {
    const g = svgEl("g", { id: "spider", class: "hidden", "aria-hidden": "true", filter: "url(#spider-glow)" });
    for (const side of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        const leg = svgEl("path", { class: "leg", d: "M0 0 L2.6 5.6 L0.6 11.6" });
        spider.legs.push({ el: leg, i, side });
        g.appendChild(leg);
      }
    }
    g.append(
      svgEl("ellipse", { class: "abdomen", cx: -5.2, cy: 0, rx: 6, ry: 4.6 }),
      svgEl("ellipse", { class: "head", cx: 2.6, cy: 0, rx: 3.7, ry: 3.1 }),
      svgEl("circle", { class: "eye", cx: 5, cy: -1.3, r: 0.95 }),
      svgEl("circle", { class: "eye", cx: 5, cy: 1.3, r: 0.95 }),
    );
    $("#graph").appendChild(g);
    spider.el = g;
    measureSpider();
    window.addEventListener("resize", measureSpider);
  }

  function measureSpider() {
    const r = $("#graph").getBoundingClientRect();
    spider.scale = V.spiderScale(Math.min(r.width, r.height) / 600);  // viewBox is 600 units square
    drawSpider();
  }

  function resetSpider() {
    Object.assign(spider, { at: null, queue: [], entry: null, path: null, pauseUntil: 0, silk: null, walking: false });
    spider.el.classList.add("hidden");
  }

  function placeSpider(id) {
    spider.at = id;
    spider.path = null;
    spider.el.classList.remove("hidden");
    drawSpider();
  }

  const nodePoint = (id) => {
    const v = view.nodes.get(id);
    return v ? { x: v.x, y: v.y } : view.pos.get(id) || null;
  };

  // Pick one pace for all replay hops so the whole walk (including walking back between
  // siblings and cousins) fills REPLAY_MS.
  function planReplay(ids) {
    let from = spider.queue.length ? spider.queue[spider.queue.length - 1].id : spider.path ? spider.entry.id : spider.at;
    let total = 0;
    const finalPoint = (id) => view.pos.get(id) || null;
    for (const id of ids) {
      total += V.pathLength(V.treePath(view.parent, from, id), finalPoint);
      from = id;
    }
    const { speed, pause } = V.replayPacing(total, ids.length);
    for (const id of ids) spider.queue.push({ id, reveal: true, speed, pause });
  }

  function revealPending(id, now) {
    if (!view.pending.delete(id)) return;
    const n = view.data.get(id);
    if (n && !view.nodes.has(id)) reveal(n, true, now, false);
  }

  function dropSilk() {
    if (spider.silk) spider.silk.el.remove();
    spider.silk = null;
  }

  function arrive(now) {
    const id = spider.entry.id;
    spider.path = null;
    spider.at = id;
    if (spider.entry.reveal) revealPending(id, now);
    dropSilk();
    spider.pauseUntil = now + spider.pause;
  }

  function stepSpider(now) {
    const dt = Math.min(64, Math.max(0, now - (spider.last || now)));
    spider.last = now;
    spider.walking = false;
    if (reducedMotion()) {  // no walking: reveal everything owed and sit on the newest page
      const last = spider.queue.length ? spider.queue[spider.queue.length - 1].id : spider.path ? spider.entry.id : null;
      if (spider.path && spider.entry.reveal) revealPending(spider.entry.id, now);
      for (const e of spider.queue) if (e.reveal) revealPending(e.id, now);
      spider.queue = [];
      dropSilk();
      if (last !== null) placeSpider(last);
      return false;
    }
    let budget = dt;
    for (let guard = 0; guard < 200; guard++) {
      if (spider.pauseUntil > now) return true;
      if (!spider.path) {
        if (!spider.queue.length) return false;
        if (spider.queue.length > V.SPIDER_MAX_BACKLOG) {  // fell too far behind a fast live crawl
          for (const e of spider.queue.splice(0, spider.queue.length - V.SPIDER_MAX_BACKLOG)) {
            if (e.reveal) revealPending(e.id, now);
          }
        }
        const entry = spider.queue.shift();
        const backlog = spider.queue.length;
        spider.entry = entry;
        spider.speed = entry.speed ?? V.liveSpeed(backlog);
        spider.pause = entry.pause ?? V.livePause(backlog);
        spider.path = V.treePath(view.parent, spider.at, entry.id);
        spider.seg = 0;
        spider.segDist = 0;
        spider.el.classList.remove("hidden");
        if (spider.path.length === 1) { arrive(now); continue; }  // first page: drop in
        startSegment();
      }
      if (budget <= 0) return true;
      const a = nodePoint(spider.path[spider.seg]), b = nodePoint(spider.path[spider.seg + 1]);
      if (!a || !b) { arrive(now); continue; }
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const step = spider.speed * budget, left = len - spider.segDist;
      spider.walking = true;
      if (step < left) {
        spider.segDist += step;
        spider.phase += step * 0.55;
        return true;
      }
      budget -= left / spider.speed;
      spider.phase += left * 0.55;
      spider.seg += 1;
      spider.segDist = 0;
      spider.at = spider.path[spider.seg];
      if (spider.seg === spider.path.length - 1) arrive(now);
      else startSegment();
    }
    return true;
  }

  // Spinning a new thread: a silk line trails the spider toward a page that is not shown yet.
  function startSegment() {
    const s = spider.path[spider.seg], t = spider.path[spider.seg + 1];
    if (!spider.entry.reveal || view.nodes.has(t) || spider.seg !== spider.path.length - 2) return;
    dropSilk();
    const el = svgEl("line", { class: "silk" });
    $("#edges").appendChild(el);
    spider.silk = { key: `${s}>${t}`, from: s, el };
  }

  function drawSpider() {
    if (!spider.el || spider.at === null) return;
    let p = nodePoint(spider.at) || { x: spider.x, y: spider.y };
    if (spider.path && spider.seg < spider.path.length - 1) {
      const a = nodePoint(spider.path[spider.seg]), b = nodePoint(spider.path[spider.seg + 1]);
      if (a && b) {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const k = Math.min(1, spider.segDist / len);
        p = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
        if (len > 1) spider.angle = V.turnToward(spider.angle, (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, 0.35);
      }
    }
    spider.x = p.x;
    spider.y = p.y;
    spider.el.setAttribute("transform",
      `translate(${p.x.toFixed(2)},${p.y.toFixed(2)}) rotate(${spider.angle.toFixed(1)}) scale(${spider.scale.toFixed(3)})`);
    for (const { el, i, side } of spider.legs) {
      const swing = spider.walking ? V.legSwing(spider.phase, i, side) : 0;
      el.setAttribute("transform", `translate(${LEG_HIPS[i]},${side * 1.6}) scale(1,${side}) rotate(${(LEG_BASE[i] + swing).toFixed(1)})`);
    }
    if (spider.silk) {
      const a = nodePoint(spider.silk.from);
      if (a) {
        spider.silk.el.setAttribute("x1", a.x); spider.silk.el.setAttribute("y1", a.y);
        spider.silk.el.setAttribute("x2", p.x); spider.silk.el.setAttribute("y2", p.y);
      }
    }
  }
  buildSpider();

  function shortLabel(n) {
    try {
      const u = new URL(n.url);
      const s = n.depth === 0 ? u.host : u.pathname + u.search;
      return s.length > 24 ? s.slice(0, 23) + "…" : s;
    } catch (_) { return ""; }
  }

  // ------------------------------------------------------------ inspector
  async function inspect(index) {
    state.selected = index;
    markSelected();
    try {
      const p = await api(`/api/crawls/${state.id}/pages/${index}`);
      state.page = p;
      $("#inspector").hidden = false;
      $("#i-title").textContent = p.title || p.final_url || p.requested_url;
      const meta = [
        ["URL", p.requested_url],
        ["Final URL", p.final_url && p.final_url !== p.requested_url ? p.final_url : null],
        ["State", p.state],
        ["HTTP status", p.status],
        ["Content type", p.content_type],
        ["Render", p.render_mode + (p.render_note ? ` (${p.render_note})` : "")],
        ["Depth", p.depth],
        ["Parent", p.parent_url],
        ["Time", p.elapsed_ms != null ? `${p.elapsed_ms} ms` : null],
        ["Size", p.bytes ? `${p.bytes.toLocaleString()} bytes${p.truncated ? " (truncated)" : ""}` : null],
        ["Redirects", p.redirects.length ? p.redirects.join(" → ") : null],
        ["Assets", p.assets.length || null],
        ["External links", p.external_links.length || null],
        ["Error", p.error],
        ["Fetched", p.timestamp],
      ];
      const dl = $("#i-meta");
      dl.replaceChildren();
      for (const [k, v] of meta) {
        if (v === null || v === undefined || v === "") continue;
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = k; dd.textContent = String(v);
        dl.append(dt, dd);
      }
      $("#i-md").textContent = p.markdown || "(no Markdown extracted)";
      $("#i-nlinks").textContent = p.links.length;
      const ul = $("#i-links");
      ul.replaceChildren();
      for (const href of p.links.slice(0, 500)) {
        const li = document.createElement("li"), a = document.createElement("a");
        a.textContent = href;
        if (/^https?:\/\//i.test(href)) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer nofollow"; }
        li.appendChild(a);
        ul.appendChild(li);
      }
      if (window.matchMedia("(max-width: 899px)").matches) $("#inspector").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      say(e.message, true);
    }
  }
  $("#i-close").addEventListener("click", () => {
    $("#inspector").hidden = true;
    state.selected = null;
    markSelected();
  });

  // ------------------------------------------------------------ export
  function setExports(on) {
    document.querySelectorAll('[data-act="copy-md"],[data-act="copy-json"]').forEach((b) => (b.disabled = !on));
    for (const [id, fmt] of [["#dl-json", "json"], ["#dl-md", "markdown"]]) {
      const a = $(id);
      a.setAttribute("aria-disabled", String(!on));
      if (on) { a.href = `/api/crawls/${state.id}/export?format=${fmt}`; a.setAttribute("download", ""); }
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    say("Copied to clipboard.");
  }

  document.addEventListener("click", async (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    try {
      if (act === "copy-md") await copy(await api(`/api/crawls/${state.id}/export?format=markdown`));
      if (act === "copy-json") await copy(JSON.stringify(await api(`/api/crawls/${state.id}`), null, 2));
      if (act === "copy-page-md" && state.page) await copy(state.page.markdown || "");
      if (act === "copy-page-json" && state.page) await copy(JSON.stringify(state.page, null, 2));
    } catch (e) { say(e.message, true); }
  });

  // Reopen a crawl from the URL hash (e.g. after a reload).
  const fromHash = location.hash.slice(1);
  if (/^[0-9a-f]{32}$/.test(fromHash)) { state.id = fromHash; setExports(true); poll(); }
})();
