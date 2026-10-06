"use strict";
// Pure helpers for the live crawl animation. No DOM access, so they can be unit tested under Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChromaspiderViz = factory();
})(typeof self !== "undefined" ? self : this, () => {
  const POLL_RUNNING_MS = 100;   // live graph poll while a crawl is running
  const POLL_HIDDEN_MS = 1000;   // back off while the tab is in the background
  const REPLAY_MS = 3000;        // client-side replay of a crawl that finished too fast to watch
  const FLASH_MS = 220;          // how long a replayed node shows as "crawling" before settling
  const TWEEN_MS = 380;          // node movement / spawn-from-parent duration

  function pollDelay(status, hidden) {
    if (status !== "running") return null;
    return hidden ? POLL_HIDDEN_MS : POLL_RUNNING_MS;
  }

  // Cheap change detector so identical polls skip all DOM work.
  function signature(g) {
    let s = `${g.status}|${g.nodes.length}|${g.edges.length}|`;
    for (const n of g.nodes) s += n.state[0] + n.state.length;
    return s;
  }

  // Breadth-first from the root: shallower pages first, then discovery order.
  function revealOrder(nodes) {
    return nodes.slice().sort((a, b) => a.depth - b.depth || a.id - b.id);
  }

  // Replay when the crawl ended before the UI saw most of it happen live.
  function shouldReplay(status, total, unseen, reducedMotion) {
    if (reducedMotion || status === "running") return false;
    return unseen > 2 && unseen > total * 0.25;
  }

  // Spread reveals over `duration`, outward ring by ring: [{id, at}] with at in [0, duration).
  function replaySchedule(nodes, duration = REPLAY_MS) {
    const ordered = revealOrder(nodes);
    const step = ordered.length ? duration / ordered.length : 0;
    return ordered.map((n, i) => ({ id: n.id, at: Math.round(i * step) }));
  }

  // ---------------------------------------------------------------- crawl wall
  const WALL_MAX_TILES = 12;      // page tiles shown at once
  const WALL_MAX_SPIDERS = 128;
  const TILE_W = 300, TILE_H = 400;  // tile drawing units (3:4 page)

  // Fit n page tiles (aspect w/h) into a W x H box; tries 1-4 columns and keeps the biggest tiles.
  function wallGrid(n, W, H, gap = 8, aspect = TILE_W / TILE_H) {
    let best = null;
    for (let cols = 1; cols <= Math.min(Math.max(n, 1), 4); cols++) {
      const rows = Math.ceil(Math.max(n, 1) / cols);
      const cellW = (W - gap * (cols + 1)) / cols, cellH = (H - gap * (rows + 1)) / rows;
      const w = Math.max(0, Math.min(cellW, cellH * aspect));
      if (!best || w > best.w + 0.5) best = { cols, rows, w, h: w / aspect };
    }
    const { cols, rows, w, h } = best;
    const ox = (W - cols * w - gap * (cols - 1)) / 2, oy = (H - rows * h - gap * (rows - 1)) / 2;
    const rects = [];
    for (let i = 0; i < n; i++) {
      rects.push({ x: ox + (i % cols) * (w + gap), y: oy + Math.floor(i / cols) * (h + gap), w, h });
    }
    return { cols, rows, rects };
  }

  // Markdown -> plain words. Output is only ever drawn as text, never parsed as markup.
  function plainWords(md, limit = 400) {
    const text = String(md || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
      .replace(/[*_`~|]+/g, " ");
    return text.split(/\s+/).filter((w) => w && /[\p{L}\p{N}]/u.test(w)).slice(0, limit);
  }

  // Greedy word wrap. measure(word) -> width. Returns [{text, x, line}] and stops after maxLines.
  function wrapWords(words, measure, width, maxLines, space = 4) {
    const out = [];
    let x = 0, line = 0;
    for (const text of words) {
      const w = Math.min(measure(text), width);
      if (x > 0 && x + w > width) { x = 0; line += 1; }
      if (line >= maxLines) break;
      out.push({ text, x, w, line });
      x += w + space;
    }
    return out;
  }

  // Two-bone leg: knee position for a hip and foot with segment lengths a, b; bend = +1/-1 picks the side.
  function legKnee(hx, hy, fx, fy, a, b, bend) {
    const dx = fx - hx, dy = fy - hy;
    const d = Math.min(Math.max(Math.hypot(dx, dy), 1e-6), a + b - 1e-6);
    const along = (a * a - b * b + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a * a - along * along));
    const ux = dx / (Math.hypot(dx, dy) || 1), uy = dy / (Math.hypot(dx, dy) || 1);
    return { x: hx + ux * along - uy * h * bend, y: hy + uy * along + ux * h * bend };
  }

  // Spiders on one tile double every ~650ms after its text arrives, within a per-tile share of the cap.
  function spidersFor(ageMs, tiles) {
    const cap = Math.max(2, Math.min(12, Math.floor(WALL_MAX_SPIDERS / Math.max(1, tiles))));
    return Math.min(cap, 2 ** Math.floor(Math.max(0, ageMs) / 650));
  }

  // Highlight styles from the reference video; r in [0, 1).
  const HIGHLIGHTS = ["plain", "plain", "plain", "yellow", "cyan", "box", "pink", "mono", "big", "vertical"];
  function pickHighlight(r) {
    return HIGHLIGHTS[Math.min(HIGHLIGHTS.length - 1, Math.floor(r * HIGHLIGHTS.length))];
  }

  function easeOutCubic(t) {
    const c = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - c, 3);
  }

  return { POLL_RUNNING_MS, POLL_HIDDEN_MS, REPLAY_MS, FLASH_MS, TWEEN_MS,
           WALL_MAX_TILES, WALL_MAX_SPIDERS, TILE_W, TILE_H, HIGHLIGHTS,
           pollDelay, signature, revealOrder, shouldReplay, replaySchedule, easeOutCubic,
           wallGrid, plainWords, wrapWords, legKnee, spidersFor, pickHighlight };
});
