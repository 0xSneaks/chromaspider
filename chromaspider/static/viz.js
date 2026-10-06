"use strict";
// Pure helpers for the live crawl animation. No DOM access, so they can be unit tested under Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChromaspiderViz = factory();
})(typeof self !== "undefined" ? self : this, () => {
  const POLL_RUNNING_MS = 100;   // live graph poll while a crawl is running
  const POLL_HIDDEN_MS = 1000;   // back off while the tab is in the background
  const REPLAY_MS = 1000;        // client-side replay of a crawl that finished too fast to watch
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

  function easeOutCubic(t) {
    const c = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - c, 3);
  }

  return { POLL_RUNNING_MS, POLL_HIDDEN_MS, REPLAY_MS, FLASH_MS, TWEEN_MS,
           pollDelay, signature, revealOrder, shouldReplay, replaySchedule, easeOutCubic };
});
