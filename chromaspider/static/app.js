"use strict";
// Chromaspider UI. All crawled content is rendered with textContent only.
(() => {
  const $ = (s) => document.querySelector(s);
  const SVG = "http://www.w3.org/2000/svg";
  const state = { id: null, graph: null, selected: null, timer: null };

  const form = $("#crawl-form"), msg = $("#message"), goBtn = $("#go");

  function say(text, isError = false) {
    msg.textContent = text;
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
    try {
      const g = await api(`/api/crawls/${state.id}/graph`);
      state.graph = g;
      draw(g);
      const c = g.counts || {};
      const parts = Object.entries(c).map(([k, v]) => `${k} ${v}`).join(" · ");
      $("#summary").textContent = `${g.status.toUpperCase()} · ${g.nodes.length} pages${parts ? " · " + parts : ""}`;
      if (g.status === "running") {
        say("Crawling… follow the colors.");
        state.timer = setTimeout(poll, 600);
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

  function draw(g) {
    const pos = layout(g);
    const edges = $("#edges"), nodes = $("#nodes");
    edges.replaceChildren();
    nodes.replaceChildren();
    const big = g.nodes.length > 60;
    for (const e of g.edges) {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) continue;
      const l = document.createElementNS(SVG, "line");
      l.setAttribute("x1", a.x); l.setAttribute("y1", a.y);
      l.setAttribute("x2", b.x); l.setAttribute("y2", b.y);
      edges.appendChild(l);
    }
    for (const n of g.nodes) {
      const p = pos.get(n.id) || { x: 0, y: 0 };
      const grp = document.createElementNS(SVG, "g");
      grp.setAttribute("class", `node ${n.state}${state.selected === n.id ? " sel" : ""}`);
      grp.setAttribute("transform", `translate(${p.x},${p.y})`);
      grp.setAttribute("tabindex", "0");
      grp.setAttribute("role", "button");
      const c = document.createElementNS(SVG, "circle");
      c.setAttribute("r", n.depth === 0 ? 11 : big ? 5 : 7);
      c.setAttribute("filter", "url(#glow)");
      const hit = document.createElementNS(SVG, "circle");  // generous touch target
      hit.setAttribute("class", "hit");
      hit.setAttribute("r", 16);
      const t = document.createElementNS(SVG, "title");
      t.textContent = `${n.state.toUpperCase()} ${n.status ?? ""} ${n.url}`;
      grp.append(hit, c, t);
      if (!big) {
        const label = document.createElementNS(SVG, "text");
        label.setAttribute("x", 10); label.setAttribute("y", 3);
        label.textContent = shortLabel(n);
        grp.appendChild(label);
      }
      const open = () => inspect(n.id);
      grp.addEventListener("click", open);
      grp.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
      nodes.appendChild(grp);
    }
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
    if (state.graph) draw(state.graph);
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
    if (state.graph) draw(state.graph);
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
