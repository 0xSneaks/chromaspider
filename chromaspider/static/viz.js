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
  const SPIDER_SPEED = 0.45;     // graph units per ms on a live crawl (~200ms along a typical edge)
  const SPIDER_PAUSE_MS = 90;    // rest on each newly reached page
  const SPIDER_MAX_BACKLOG = 40; // beyond this, older live hops are skipped so the spider keeps up
  const SPIDER_SPAN = 25;        // spider size in its own drawing units
  const SPIDER_MIN_PX = 22;      // on-screen size floor so it stays visible on phones

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

  // Walk along tree edges: up from `from` to the nearest common ancestor, then down to `to`.
  // `parent` maps child id -> parent id. Unconnected nodes fall back to a straight hop.
  function treePath(parent, from, to) {
    if (from === null || from === undefined || from === to) return [to];
    const down = new Map(), chain = [];
    for (let id = to; id !== undefined && !down.has(id); id = parent.get(id)) {
      down.set(id, chain.length);
      chain.push(id);
    }
    const climb = [], seen = new Set();
    for (let id = from; id !== undefined && !seen.has(id); id = parent.get(id)) {
      seen.add(id);
      climb.push(id);
      if (down.has(id)) return climb.concat(chain.slice(0, down.get(id)).reverse());
    }
    return [from, to];
  }

  function pathLength(path, pt) {
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const a = pt(path[i - 1]), b = pt(path[i]);
      if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return total;
  }

  // Live crawl: walk faster and rest less as discovered pages pile up behind the spider.
  function liveBoost(backlog) {
    return Math.min(8, 1 + backlog / 3);
  }
  function liveSpeed(backlog) { return SPIDER_SPEED * liveBoost(backlog); }
  function livePause(backlog) { return SPIDER_PAUSE_MS / liveBoost(backlog); }

  // Replay: pick one speed and pause so walking `totalLength` and resting on `count` pages takes `budget` ms.
  function replayPacing(totalLength, count, budget = REPLAY_MS) {
    const pause = count ? Math.min(SPIDER_PAUSE_MS, (budget * 0.3) / count) : 0;
    const walk = Math.max(1, budget - pause * count);
    return { speed: Math.max(0.01, totalLength / walk), pause };
  }

  // Scale factor for the spider given how many screen pixels one graph unit covers.
  function spiderScale(pxPerUnit) {
    if (!(pxPerUnit > 0)) return 1;
    return Math.min(2.2, Math.max(1, SPIDER_MIN_PX / (SPIDER_SPAN * pxPerUnit)));
  }

  // Rotate `current` toward `target` (degrees) along the shorter arc by fraction k.
  function turnToward(current, target, k) {
    const d = ((((target - current) % 360) + 540) % 360) - 180;
    return current + d * Math.min(1, Math.max(0, k));
  }

  // Alternating-tripod gait: leg i on side (+1/-1) swings in one of two opposite phases.
  function legSwing(phase, i, side, amplitude = 16) {
    const group = (i + (side > 0 ? 0 : 1)) % 2;
    return amplitude * Math.sin(phase + group * Math.PI);
  }

  function easeOutCubic(t) {
    const c = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - c, 3);
  }

  return { POLL_RUNNING_MS, POLL_HIDDEN_MS, REPLAY_MS, FLASH_MS, TWEEN_MS,
           SPIDER_SPEED, SPIDER_PAUSE_MS, SPIDER_MAX_BACKLOG, SPIDER_SPAN, SPIDER_MIN_PX,
           pollDelay, signature, revealOrder, shouldReplay, easeOutCubic,
           treePath, pathLength, liveSpeed, livePause, replayPacing, spiderScale, turnToward, legSwing };
});
