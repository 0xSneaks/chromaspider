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
        wall.update(g);
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
  const view = { crawl: null, nodes: new Map(), edges: new Map(), pending: new Map(), replayStart: 0,
                 data: new Map(), parent: new Map(), pos: new Map(), big: false, raf: 0 };

  function resetView(crawlId) {
    cancelAnimationFrame(view.raf);
    view.raf = 0;
    $("#edges").replaceChildren();
    $("#nodes").replaceChildren();
    view.nodes.clear(); view.edges.clear(); view.pending.clear();
    view.crawl = crawlId;
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
      if (V.shouldReplay(g.status, g.nodes.length, unseen.length, reducedMotion())) {
        view.replayStart = now;
        for (const { id, at } of V.replaySchedule(unseen)) view.pending.set(id, at);
      } else {
        for (const n of V.revealOrder(unseen)) reveal(n, false, now);
      }
    }
    kick();
  }

  function reveal(n, flash, now) {
    const v = makeNode(n);
    const p = view.pos.get(n.id) || { x: 0, y: 0 };
    const from = view.nodes.get(view.parent.get(n.id));  // spawn at the parent, then crawl outward
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
    const l = document.createElementNS(SVG, "line");
    if (!reducedMotion()) l.setAttribute("class", "enter");
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
    let busy = false;
    if (view.pending.size) {
      const elapsed = now - view.replayStart;
      for (const [id, at] of view.pending) {
        if (at > elapsed) continue;
        view.pending.delete(id);
        const n = view.data.get(id);
        if (n) reveal(n, true, now);
      }
      busy = view.pending.size > 0;
    }
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
    if (busy) kick();
  }

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

  // ------------------------------------------------------------ views
  const wall = window.ChromaspiderWall.create({
    canvas: $("#wall"),
    hud: { spiders: $("#hud-spiders"), pages: $("#hud-pages"), words: $("#hud-words") },
    fetchPage: (cid, index) => api(`/api/crawls/${cid}/pages/${index}`),
    onInspect: (index) => inspect(index),
    reducedMotion,
  });

  const tabs = [$("#tab-wall"), $("#tab-graph")];
  function selectTab(tab) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
  }
  for (const t of tabs) {
    t.addEventListener("click", () => selectTab(t));
    t.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      const next = tabs[(tabs.indexOf(t) + 1) % tabs.length];
      selectTab(next);
      next.focus();
    });
  }

  // Reopen a crawl from the URL hash (e.g. after a reload).
  const fromHash = location.hash.slice(1);
  if (/^[0-9a-f]{32}$/.test(fromHash)) { state.id = fromHash; setExports(true); poll(); }
})();
