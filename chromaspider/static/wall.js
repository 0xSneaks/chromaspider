"use strict";
// Crawl wall: one tile per crawled page, drawn from its extracted text (plain text only, never markup),
// with stick spiders walking over the words and "reading" them. Purely visual: it reads the same graph
// and page JSON as the rest of the UI and has no effect on the crawler.
(() => {
  const V = window.ChromaspiderViz;
  const STATE_COLORS = { ok: "#a6ff00", crawling: "#00e5ff", browser: "#b44dff", skipped: "#ffe14d",
                         redirected: "#ff8a00", failed: "#ff3b5c", queued: "#5d5878" };
  const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
  const TILE_BG = "#0d0b16", TITLE_COLOR = "#58c4ff", BODY_COLOR = "#a9a3c6", HOST_COLOR = "#6f6990";
  const PAD = 14, TITLE_PX = 17, TITLE_LH = 21, BODY_PX = 12, BODY_LH = 17;
  const REVEAL_GAP_MS = 280, TILE_TWEEN_MS = 450, APPEAR_MS = 320, HIGHLIGHT_MS = 260;
  const LINGER_MS = 6000, FADE_MS = 800, FETCH_LIMIT = 3;
  // Spider geometry in tile units (a tile is TILE_W x TILE_H).
  const BODY = 4.6, THIGH = 21, SHIN = 25, REST = 34, STRIDE = 16, STEP_MS = 120, SPEED = 0.09;
  const LEG_ANGLES = [-0.45, -1.15, -1.95, -2.6, 0.45, 1.15, 1.95, 2.6];  // from heading; 0-3 left, 4-7 right
  const LEG_GROUP = [0, 1, 0, 1, 1, 0, 1, 0];  // alternating tripods

  function create({ canvas, hud, fetchPage, onInspect, reducedMotion }) {
    const ctx = canvas.getContext("2d");
    const meter = document.createElement("canvas").getContext("2d");
    let W = 0, H = 0, dpr = 1, raf = 0, last = 0, hudAt = 0;
    let crawlId = null, graph = null, tiles = [], lastReveal = -Infinity, inflight = 0;
    let wordsRead = 0, settledAt = 0, fadeAt = 0, finished = false;

    const measure = (font) => (text) => { meter.font = font; return meter.measureText(text).width; };
    const nodeOf = (id) => graph && graph.nodes[id];

    // ---------------------------------------------------------------- data in
    function update(g) {
      if (g.id !== crawlId) reset(g.id);
      graph = g;
      if (reducedMotion()) {  // no walking or staggering: show every tile at once
        for (let n = nextCandidate(); n; n = nextCandidate()) addTile(n, performance.now());
      }
      finished = false;
      fadeAt = 0;
      kick();
    }

    function reset(id) {
      crawlId = id;
      tiles = [];
      wordsRead = 0;
      settledAt = 0;
      fadeAt = 0;
      lastReveal = -Infinity;
      finished = false;
    }

    // Pages leave the queue out of order under concurrency, so pick the first crawled page not shown yet.
    function nextCandidate() {
      if (!graph || tiles.length >= V.WALL_MAX_TILES) return null;
      const shown = new Set(tiles.map((t) => t.id));
      return graph.nodes.find((n) => n.state !== "queued" && !shown.has(n.id)) || null;
    }

    function addTile(n, now) {
      const tile = { id: n.id, rect: null, from: null, to: null, t0: now, born: now, words: [], lines: [],
                     ready: false, fetching: false, failed: false, readyAt: 0, spiders: [], fading: [], cache: null };
      layout(tile, { title: n.title || n.url, url: n.url, markdown: "" });
      tiles.push(tile);
      regrid(now);
    }

    function fetchTexts() {
      for (const t of tiles) {
        if (inflight >= FETCH_LIMIT) return;
        const n = nodeOf(t.id);
        if (t.ready || t.fetching || !n || n.state === "queued" || n.state === "crawling") continue;
        t.fetching = true;
        inflight += 1;
        const cid = crawlId;
        fetchPage(cid, t.id).then((p) => {
          if (cid !== crawlId) return;
          layout(t, { title: p.title || p.final_url || p.requested_url, url: p.final_url || p.requested_url,
                      markdown: p.markdown || p.error || (p.status ? `HTTP ${p.status}` : "") });
        }, () => { t.failed = true; }).finally(() => {
          inflight -= 1;
          if (cid !== crawlId) return;
          t.ready = true;
          t.readyAt = performance.now();
          paint(t);
          kick();
        });
      }
    }

    // ---------------------------------------------------------------- tile text layout
    function layout(tile, page) {
      const words = [], lines = [];
      const add = (list, font, px, color, top, lh, kind) => {
        for (const w of list) {
          const y = top + w.line * lh;
          const word = { text: w.text, x: PAD + w.x, y, w: w.w, px, font, color, kind, read: false, fx: null, t0: 0 };
          word.cx = word.x + word.w / 2;
          word.cy = y - px * 0.35;
          words.push(word);
          const key = `${kind}${w.line}`;
          let line = lines.find((l) => l.key === key);
          if (!line) lines.push(line = { key, top: y - px, bottom: y + px * 0.3, words: [] });
          line.words.push(word);
        }
      };
      const inner = V.TILE_W - PAD * 2;
      const titleFont = `700 ${TITLE_PX}px ${SANS}`, bodyFont = `${BODY_PX}px ${SANS}`, hostFont = `10px ${MONO}`;
      const title = V.wrapWords(String(page.title || "").split(/\s+/).filter(Boolean).slice(0, 30),
                                measure(titleFont), inner, 2, 5);
      let y = PAD + TITLE_PX;
      add(title, titleFont, TITLE_PX, TITLE_COLOR, y, TITLE_LH, "t");
      y += Math.max(1, title.length ? title[title.length - 1].line + 1 : 1) * TITLE_LH - 4;
      let host = "";
      try { host = new URL(page.url).host + new URL(page.url).pathname; } catch (_) { host = String(page.url || ""); }
      add(V.wrapWords([host.length > 44 ? host.slice(0, 43) + "…" : host], measure(hostFont), inner, 1),
          hostFont, 10, HOST_COLOR, y, 12, "h");
      y += 12 + BODY_LH;
      const maxLines = Math.max(0, Math.floor((V.TILE_H - PAD - y) / BODY_LH) + 1);
      add(V.wrapWords(V.plainWords(page.markdown), measure(bodyFont), inner, maxLines),
          bodyFont, BODY_PX, BODY_COLOR, y, BODY_LH, "b");
      tile.words = words;
      tile.lines = lines;
      tile.cache = null;
    }

    function wordAt(tile, x, y, radius) {
      let best = null, bestD = radius;
      for (const line of tile.lines) {
        if (y < line.top - radius || y > line.bottom + radius) continue;
        for (const w of line.words) {
          const dx = Math.max(w.x - x, 0, x - (w.x + w.w));
          const dy = Math.max(line.top - y, 0, y - line.bottom);
          const d = Math.hypot(dx, dy);
          if (d <= bestD) { best = w; bestD = d; }
        }
      }
      return best;
    }

    // ---------------------------------------------------------------- tile painting (cached per tile)
    function paint(tile) {
      if (!tile.to || !W) return;
      const scale = (tile.to.w / V.TILE_W) * dpr;
      const c = tile.cache || document.createElement("canvas");
      c.width = Math.max(1, Math.round(V.TILE_W * scale));
      c.height = Math.max(1, Math.round(V.TILE_H * scale));
      const g = c.getContext("2d");
      g.setTransform(scale, 0, 0, scale, 0, 0);
      g.fillStyle = TILE_BG;
      g.fillRect(0, 0, V.TILE_W, V.TILE_H);
      g.textBaseline = "alphabetic";
      for (const w of tile.words) {
        g.font = w.font;
        g.fillStyle = w.color;
        g.fillText(w.text, w.x, w.y);
      }
      if (!tile.ready) {  // text still loading: skeleton bars
        g.fillStyle = "rgba(169, 163, 198, 0.12)";
        for (let i = 0; i < 8; i++) g.fillRect(PAD, 78 + i * BODY_LH, (V.TILE_W - PAD * 2) * (i % 3 === 2 ? 0.6 : 0.95), 7);
      }
      for (const w of tile.words) if (w.read && !tile.fading.includes(w)) highlight(g, w, 1);
      tile.cache = c;
    }

    function highlight(g, w, alpha) {
      const top = w.y - w.px * 0.9, h = w.px * 1.2;
      const erase = () => { g.fillStyle = TILE_BG; g.fillRect(w.x - 1, top - 1, w.w + 2, h + 2); };
      g.save();
      g.globalAlpha = alpha;
      switch (w.fx) {
        case "yellow": case "cyan":
          g.fillStyle = w.fx === "yellow" ? "#ffc53d" : "#22d3ee";
          g.fillRect(w.x - 1.5, top, w.w + 3, h);
          g.font = w.font;
          g.fillStyle = "#120f1c";
          g.fillText(w.text, w.x, w.y);
          break;
        case "box":
          g.strokeStyle = "#22d3ee";
          g.lineWidth = 1;
          g.strokeRect(w.x - 2, top - 1, w.w + 4, h + 2);
          g.font = w.font;
          g.fillStyle = "#7fe9ff";
          g.fillText(w.text, w.x, w.y);
          break;
        case "pink":
          erase();
          g.font = `700 ${w.px}px ${SANS}`;
          g.fillStyle = "#ff2e97";
          g.fillText(w.text, w.x, w.y);
          break;
        case "mono":
          erase();
          g.font = `${w.px}px ${MONO}`;
          g.fillStyle = "#c3a6ff";
          g.fillText(w.text, w.x, w.y, w.w + 6);
          break;
        case "big":
          erase();
          g.font = `600 ${Math.round(w.px * 1.6)}px ${MONO}`;
          g.fillStyle = "#e8e4ff";
          g.fillText(w.text, w.x, w.y + 2);
          break;
        case "vertical":
          erase();
          g.translate(w.x + w.px * 0.4, w.y - w.px);
          g.rotate(Math.PI / 2);
          g.font = `${Math.max(9, w.px - 1)}px ${MONO}`;
          g.fillStyle = "#ff3b5c";
          g.fillText(w.text, 0, 0);
          break;
        default:
          g.font = w.font;
          g.fillStyle = "#ffffff";
          g.fillText(w.text, w.x, w.y);
      }
      g.restore();
    }

    function readWord(tile, w, now) {
      if (!w || w.read) return;
      w.read = true;
      w.fx = V.pickHighlight(Math.random());
      w.t0 = now;
      tile.fading.push(w);
      wordsRead += 1;
    }

    // ---------------------------------------------------------------- layout of tiles on the wall
    function regrid(now) {
      if (!W) return;
      const { rects } = V.wallGrid(tiles.length, W, H);
      const snap = reducedMotion();
      tiles.forEach((t, i) => {
        t.from = t.rect ? { ...t.rect } : { ...rects[i] };
        t.to = rects[i];
        t.t0 = snap ? -Infinity : now;
        if (!t.rect || snap) t.rect = { ...rects[i] };
        paint(t);
      });
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      W = r.width;
      H = r.height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      for (const t of tiles) t.rect = null;
      regrid(-Infinity);
      if (finished && W) draw(performance.now(), 1);  // resizing clears the canvas
      else kick();
    }

    // ---------------------------------------------------------------- spiders
    function spawn(tile, from) {
      const anchor = from || tile.words[0] || { cx: V.TILE_W / 2, cy: 40 };
      const x = from ? from.x : anchor.cx, y = from ? from.y : anchor.cy;
      const heading = Math.random() * Math.PI * 2;
      const legs = LEG_ANGLES.map((a) => {
        const fx = x + Math.cos(heading + a) * REST, fy = y + Math.sin(heading + a) * REST;
        return { fx, fy, sx: fx, sy: fy, tx: fx, ty: fy, t: -1 };
      });
      tile.spiders.push({ x, y, heading, vx: 0, vy: 0, target: null, legs });
    }

    function pickTarget(tile, s) {
      let best = null, bestD = Infinity;
      for (let i = 0; i < 8; i++) {
        const w = tile.words[(Math.random() * tile.words.length) | 0];
        if (!w) break;
        const d = Math.hypot(w.cx - s.x, w.cy - s.y) + (w.read ? 400 : 0);
        if (d < bestD) { best = w; bestD = d; }
      }
      return best;
    }

    function stepSpider(tile, s, dt, now) {
      if (!s.target || (s.target.read && Math.random() < 0.02)) s.target = pickTarget(tile, s);
      s.vx = 0; s.vy = 0;
      if (s.target) {
        const dx = s.target.cx - s.x, dy = s.target.cy - s.y, d = Math.hypot(dx, dy);
        if (d < 3) {
          readWord(tile, s.target, now);
          s.target = null;
        } else {
          const step = Math.min(d, SPEED * dt);
          s.vx = dx / d; s.vy = dy / d;
          s.x += s.vx * step; s.y += s.vy * step;
          const want = Math.atan2(dy, dx);
          const diff = Math.atan2(Math.sin(want - s.heading), Math.cos(want - s.heading));
          s.heading += diff * Math.min(1, dt / 90);
        }
      }
      const stepping = [false, false];
      for (let i = 0; i < 8; i++) if (s.legs[i].t >= 0) stepping[LEG_GROUP[i]] = true;
      for (let i = 0; i < 8; i++) {
        const leg = s.legs[i], a = s.heading + LEG_ANGLES[i];
        if (leg.t >= 0) {
          leg.t += dt / STEP_MS;
          const k = V.easeOutCubic(leg.t);
          leg.fx = leg.sx + (leg.tx - leg.sx) * k;
          leg.fy = leg.sy + (leg.ty - leg.sy) * k;
          if (leg.t >= 1) {  // foot planted: whatever word it landed on gets read
            leg.t = -1;
            readWord(tile, wordAt(tile, leg.fx, leg.fy, 2), now);
          }
          continue;
        }
        const ix = s.x + Math.cos(a) * REST + s.vx * STRIDE * 0.7;
        const iy = s.y + Math.sin(a) * REST + s.vy * STRIDE * 0.7;
        const overreach = Math.hypot(leg.fx - s.x, leg.fy - s.y) > THIGH + SHIN;  // never drag a straight leg
        if (overreach || (Math.hypot(leg.fx - ix, leg.fy - iy) > STRIDE && !stepping[1 - LEG_GROUP[i]])) {
          const w = wordAt(tile, ix, iy, 7);  // feet like to land on words
          leg.sx = leg.fx; leg.sy = leg.fy;
          leg.tx = w ? Math.min(Math.max(ix, w.x), w.x + w.w) : ix;
          leg.ty = w ? w.cy : iy;
          leg.t = 0;
          stepping[LEG_GROUP[i]] = true;
        }
      }
    }

    function drawSpiders(tile, scale) {
      if (!tile.spiders.length) return;
      const lw = Math.max(1.1, 0.7 / scale), dot = Math.max(2.2, 1.3 / scale);
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(88, 214, 255, 0.95)";
      ctx.beginPath();
      const joints = [];
      for (const s of tile.spiders) {
        for (let i = 0; i < 8; i++) {
          const leg = s.legs[i], a = s.heading + LEG_ANGLES[i];
          const hx = s.x + Math.cos(a) * BODY * 0.7, hy = s.y + Math.sin(a) * BODY * 0.7;
          const knee = V.legKnee(hx, hy, leg.fx, leg.fy, THIGH, SHIN, i < 4 ? -1 : 1);
          ctx.moveTo(hx, hy);
          ctx.lineTo(knee.x, knee.y);
          ctx.lineTo(leg.fx, leg.fy);
          joints.push(knee.x, knee.y, leg.fx, leg.fy);
        }
      }
      ctx.stroke();
      ctx.fillStyle = "#ff2e97";
      for (let i = 0; i < joints.length; i += 2) ctx.fillRect(joints[i] - dot / 2, joints[i + 1] - dot / 2, dot, dot);
      ctx.beginPath();
      for (const s of tile.spiders) {  // body: an outlined diamond pointing along the heading
        const c = Math.cos(s.heading), n = Math.sin(s.heading);
        ctx.moveTo(s.x + c * BODY * 1.4, s.y + n * BODY * 1.4);
        ctx.lineTo(s.x - n * BODY, s.y + c * BODY);
        ctx.lineTo(s.x - c * BODY * 1.4, s.y - n * BODY * 1.4);
        ctx.lineTo(s.x + n * BODY, s.y - c * BODY);
        ctx.closePath();
      }
      ctx.fillStyle = "rgba(10, 8, 20, 0.85)";
      ctx.fill();
      ctx.strokeStyle = "#7fe9ff";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      for (const s of tile.spiders) ctx.fillRect(s.x - dot / 2, s.y - dot / 2, dot, dot);
    }

    // ---------------------------------------------------------------- frame loop
    function kick() {
      if (!raf && !finished) raf = requestAnimationFrame(frame);
    }

    function frame(now) {
      raf = 0;
      if (!W || !crawlId) return;  // hidden tab panel: resumes on resize
      const dt = Math.min(50, last ? now - last : 16);
      last = now;
      const still = reducedMotion();

      // Reveal crawled pages one by one so even an instant crawl unfolds.
      const next = nextCandidate();
      if (next && now - lastReveal >= REVEAL_GAP_MS) {
        addTile(next, now);
        lastReveal = now;
      }
      fetchTexts();

      // Spiders multiply on each tile once its text is in, then walk.
      let total = tiles.reduce((s, t) => s + t.spiders.length, 0);
      for (const t of tiles) {
        if (!t.ready || still || fadeAt) continue;
        const target = V.spidersFor(now - t.readyAt, tiles.length);
        for (let k = 0; k < 2 && t.spiders.length < target && total < V.WALL_MAX_SPIDERS; k++, total++) {
          spawn(t, t.spiders[(Math.random() * t.spiders.length) | 0]);
        }
        for (const s of t.spiders) stepSpider(t, s, dt, now);
      }

      // Done when the crawl is over, every tile has its text, and the spiders read it all (or lingered).
      const crawlOver = graph && graph.status !== "running";
      const allIn = crawlOver && !nextCandidate() && tiles.every((t) => t.ready);
      if (allIn && !settledAt) settledAt = now;
      const allRead = tiles.every((t) => t.words.every((w) => w.read));
      if (allIn && !fadeAt && (still || allRead || now - settledAt > LINGER_MS)) fadeAt = now;
      const fade = fadeAt ? Math.max(0, 1 - (now - fadeAt) / FADE_MS) : 1;

      draw(now, fade);
      if (now - hudAt > 100 || fade === 0) {
        hudAt = now;
        hud.spiders.textContent = fade === 0 ? 0 : total;
        hud.pages.textContent = graph ? graph.nodes.filter((n) => n.state !== "queued" && n.state !== "crawling").length : 0;
        hud.words.textContent = wordsRead.toLocaleString();
      }
      if (fade === 0) {
        for (const t of tiles) t.spiders = [];
        draw(now, 1);
        finished = true;
        return;
      }
      kick();
    }

    function draw(now, spiderAlpha) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const t of tiles) {
        if (!t.to) continue;
        const k = V.easeOutCubic((now - t.t0) / TILE_TWEEN_MS);
        t.rect = { x: t.from.x + (t.to.x - t.from.x) * k, y: t.from.y + (t.to.y - t.from.y) * k,
                   w: t.from.w + (t.to.w - t.from.w) * k, h: t.from.h + (t.to.h - t.from.h) * k };
        const r = t.rect, scale = r.w / V.TILE_W;
        const appear = reducedMotion() ? 1 : Math.min(1, (now - t.born) / APPEAR_MS);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = appear;
        if (!t.cache) paint(t);
        if (t.cache) ctx.drawImage(t.cache, r.x, r.y, r.w, r.h);
        const n = nodeOf(t.id), state = n ? n.state : "queued";
        ctx.strokeStyle = STATE_COLORS[state] || STATE_COLORS.queued;
        ctx.globalAlpha = appear * (state === "crawling" && !reducedMotion() ? 0.55 + 0.45 * Math.sin(now / 110) : 0.8);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
        ctx.globalAlpha = 1;

        // Words being read fade into their highlight, then are baked into the tile cache.
        ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * r.x, dpr * r.y);
        const cg = t.cache && t.cache.getContext("2d");
        t.fading = t.fading.filter((w) => {
          const a = (now - w.t0) / HIGHLIGHT_MS;
          if (a < 1 && !reducedMotion()) { highlight(ctx, w, a); return true; }
          if (cg) highlight(cg, w, 1);
          return false;
        });
        ctx.globalAlpha = spiderAlpha;
        drawSpiders(t, scale);
        ctx.globalAlpha = 1;
      }
    }

    // ---------------------------------------------------------------- input
    canvas.addEventListener("click", (ev) => {
      const r = canvas.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      const t = tiles.find((t) => t.rect && x >= t.rect.x && x <= t.rect.x + t.rect.w && y >= t.rect.y && y <= t.rect.y + t.rect.h);
      if (t) onInspect(t.id);
    });
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    else window.addEventListener("resize", resize);
    resize();

    return { update };
  }

  window.ChromaspiderWall = { create };
})();
