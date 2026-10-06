"""FastAPI app: JSON API + static UI. Binds to 127.0.0.1 by default."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .browser import describe_backends
from .crawler import Crawler
from .extract import normalize_url
from .graph import build_graph, export
from .models import CrawlRecord, CrawlRequest, utcnow
from .security import BlockedURL, SecurityPolicy
from .storage import CrawlStore

STATIC = Path(__file__).parent / "static"
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")


def create_app(
    store: Optional[CrawlStore] = None,
    policy: Optional[SecurityPolicy] = None,
    proxy: Optional[str] = None,
    max_active: int = 2,
    allowed_hosts: Optional[list[str]] = None,
    crawler_kwargs: Optional[dict] = None,
) -> FastAPI:
    app = FastAPI(title="Chromaspider", version=__version__, docs_url="/api/docs", redoc_url=None)
    store = store or CrawlStore()
    policy = policy or SecurityPolicy()
    crawler_kwargs = crawler_kwargs or {}
    tasks: set[asyncio.Task] = set()
    hosts = allowed_hosts or ["127.0.0.1", "localhost", "[::1]", "::1"]
    # Rejects DNS-rebinding attacks against this local server.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.method == "POST":
            origin = request.headers.get("origin")
            # Same-origin only: the Host header was already vetted above.
            if origin and origin.split("://", 1)[-1] != request.headers.get("host", ""):
                return JSONResponse({"detail": "cross-origin request refused"}, status_code=403)
            if not request.headers.get("content-type", "").startswith("application/json"):
                return JSONResponse({"detail": "Content-Type must be application/json"}, status_code=415)
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    def active() -> int:
        return sum(1 for t in tasks if not t.done())

    async def run_crawl(crawl: CrawlRecord) -> None:
        try:
            crawler = Crawler(crawl.request, policy=policy, proxy=proxy, **crawler_kwargs)
            crawler.pages = crawl.pages  # share the list so polling sees live progress
            await crawler.run()
            crawl.status = "done"
        except Exception as e:  # pragma: no cover - defensive
            crawl.status, crawl.error = "failed", f"{type(e).__name__}: {e}"
        finally:
            crawl.finished_at = utcnow()
            store.save(crawl)

    @app.get("/api/health")
    async def health():
        return {"ok": True, "version": __version__, "active_crawls": active(), "browser": describe_backends()}

    @app.post("/api/crawl", status_code=202)
    async def start_crawl(req: CrawlRequest):
        root = normalize_url(req.url)
        if root is None:
            raise HTTPException(400, "invalid or unsupported URL")
        try:
            await policy.vet_url(root)
        except BlockedURL as e:
            raise HTTPException(400, f"blocked: {e}") from None
        if active() >= max_active:
            raise HTTPException(429, f"too many active crawls (limit {max_active})")
        crawl = CrawlRecord(id=store.new_id(), request=req)
        store.save(crawl)
        task = asyncio.create_task(run_crawl(crawl))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return {"id": crawl.id, "status": crawl.status}

    def must_get(crawl_id: str) -> CrawlRecord:
        crawl = store.get(crawl_id)
        if crawl is None:
            raise HTTPException(404, "crawl not found")
        return crawl

    @app.get("/api/crawls")
    async def list_crawls():
        return {"ids": store.list_ids()}

    @app.get("/api/crawls/{crawl_id}")
    async def get_crawl(crawl_id: str):
        return must_get(crawl_id)

    @app.get("/api/crawls/{crawl_id}/graph")
    async def get_graph(crawl_id: str):
        return build_graph(must_get(crawl_id))

    @app.get("/api/crawls/{crawl_id}/pages/{index}")
    async def get_page(crawl_id: str, index: int):
        crawl = must_get(crawl_id)
        if not 0 <= index < len(crawl.pages):
            raise HTTPException(404, "page not found")
        return crawl.pages[index]

    @app.get("/api/crawls/{crawl_id}/export")
    async def get_export(crawl_id: str, format: str = Query("json", pattern="^(json|markdown)$")):
        crawl = must_get(crawl_id)
        body = export(crawl, format)
        ext, mime = ("json", "application/json") if format == "json" else ("md", "text/markdown; charset=utf-8")
        return PlainTextResponse(body, media_type=mime, headers={
            "Content-Disposition": f'attachment; filename="chromaspider-{crawl.id[:8]}.{ext}"'})

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
