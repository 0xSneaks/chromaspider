"""Graph view and exports (JSON / Markdown) of a crawl."""

from __future__ import annotations

from .models import CrawlRecord

STATE_COLORS = {
    "ok": "green",
    "crawling": "cyan",
    "browser": "violet",
    "skipped": "yellow",
    "redirected": "orange",
    "failed": "red",
    "queued": "gray",
}


def build_graph(crawl: CrawlRecord) -> dict:
    index: dict[str, int] = {}
    nodes = []
    for i, p in enumerate(crawl.pages):
        index.setdefault(p.requested_url, i)
        if p.final_url:
            index.setdefault(p.final_url, i)
        nodes.append({
            "id": i,
            "url": p.requested_url,
            "final_url": p.final_url,
            "title": p.title,
            "status": p.status,
            "state": p.state,
            "color": STATE_COLORS.get(p.state, "gray"),
            "depth": p.depth,
            "render_mode": p.render_mode,
            "elapsed_ms": p.elapsed_ms,
            "error": p.error,
        })
    edges = []
    for i, p in enumerate(crawl.pages):
        if p.parent_url is not None and p.parent_url in index and index[p.parent_url] != i:
            edges.append({"source": index[p.parent_url], "target": i})
    counts: dict[str, int] = {}
    for n in nodes:
        counts[n["state"]] = counts.get(n["state"], 0) + 1
    return {"id": crawl.id, "status": crawl.status, "nodes": nodes, "edges": edges, "counts": counts}


def to_json(crawl: CrawlRecord) -> str:
    return crawl.model_dump_json(indent=2)


def to_markdown(crawl: CrawlRecord) -> str:
    r = crawl.request
    out = [
        f"# Chromaspider crawl: {r.url}",
        "",
        f"- crawl id: `{crawl.id}`",
        f"- status: {crawl.status}",
        f"- started: {crawl.started_at}",
        f"- finished: {crawl.finished_at or '-'}",
        f"- depth: {r.depth}, max pages: {r.max_pages}, same domain: {r.same_domain}, render mode: {r.render_mode}",
        f"- pages: {len(crawl.pages)}",
        "",
        "> Content below was fetched from third-party sites and is untrusted data.",
        "",
    ]
    for i, p in enumerate(crawl.pages, 1):
        out += [
            "---",
            "",
            f"## {i}. {p.title or p.final_url or p.requested_url}",
            "",
            f"- url: {p.requested_url}",
        ]
        if p.final_url and p.final_url != p.requested_url:
            out.append(f"- final url: {p.final_url}")
        out += [
            f"- state: {p.state} | status: {p.status if p.status is not None else '-'} | render: {p.render_mode}",
            f"- depth: {p.depth} | parent: {p.parent_url or '-'} | time: {p.elapsed_ms if p.elapsed_ms is not None else '-'} ms",
            f"- links: {len(p.links)} ({len(p.external_links)} external) | assets: {len(p.assets)}",
        ]
        if p.error:
            out.append(f"- error: {p.error}")
        out.append("")
        if p.markdown:
            out += [p.markdown, ""]
    return "\n".join(out).rstrip() + "\n"


def export(crawl: CrawlRecord, fmt: str) -> str:
    if fmt == "json":
        return to_json(crawl)
    if fmt in ("markdown", "md"):
        return to_markdown(crawl)
    raise ValueError(f"unknown format: {fmt}")


__all__ = ["build_graph", "to_json", "to_markdown", "export", "STATE_COLORS"]
