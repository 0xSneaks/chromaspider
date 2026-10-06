"""Bounded breadth-first crawler. Shared by the CLI, the API and tests."""

from __future__ import annotations

import asyncio
import time
from typing import Callable, Optional
from urllib.parse import urljoin

import httpx

from . import __version__
from .browser import BrowserRenderer, RenderUnavailable, get_renderer
from .extract import extract, normalize_url, same_site
from .models import Asset, CrawlRequest, PageResult
from .security import BlockedURL, SafeTransport, SecurityPolicy, blocked_reason

USER_AGENT = f"Chromaspider/{__version__} (+https://github.com/0xSneaks/chromaspider)"
HTML_TYPES = ("text/html", "application/xhtml+xml")
REDIRECT_CODES = (301, 302, 303, 307, 308)


class FetchError(Exception):
    pass


class Crawler:
    def __init__(
        self,
        request: CrawlRequest,
        policy: Optional[SecurityPolicy] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        proxy: Optional[str] = None,
        renderer: Optional[BrowserRenderer] = None,
        on_update: Optional[Callable[[PageResult], None]] = None,
    ):
        self.req = request
        self.policy = policy or SecurityPolicy()
        self.transport = transport or SafeTransport(self.policy, proxy=proxy, max_connections=request.concurrency)
        self.renderer = renderer if renderer is not None else get_renderer(request.render_mode, self.policy)
        self.on_update = on_update or (lambda page: None)
        self.pages: list[PageResult] = []
        self.seen: set[str] = set()

    # ------------------------------------------------------------ public

    async def run(self) -> list[PageResult]:
        root = normalize_url(self.req.url)
        if root is None:
            page = PageResult(requested_url=self.req.url, state="failed", error="invalid or unsupported URL")
            self.pages.append(page)
            self.on_update(page)
            return self.pages
        self.root = root
        queue: asyncio.Queue[PageResult] = asyncio.Queue()
        self._enqueue(queue, root, 0, None)
        headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"}
        async with httpx.AsyncClient(transport=self.transport, headers=headers, follow_redirects=False,
                                     timeout=self.req.timeout, trust_env=False) as client:
            workers = [asyncio.create_task(self._worker(client, queue)) for _ in range(self.req.concurrency)]
            try:
                await queue.join()
            finally:
                for w in workers:
                    w.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                await self.renderer.close()
        return self.pages

    # ----------------------------------------------------------- internals

    def _enqueue(self, queue: asyncio.Queue, url: str, depth: int, parent: Optional[str]) -> None:
        if url in self.seen or len(self.pages) >= self.req.max_pages:
            return
        self.seen.add(url)
        page = PageResult(requested_url=url, depth=depth, parent_url=parent)
        self.pages.append(page)
        self.on_update(page)
        queue.put_nowait(page)

    async def _worker(self, client: httpx.AsyncClient, queue: asyncio.Queue) -> None:
        while True:
            page = await queue.get()
            try:
                await self._process(client, page)
                if page.state not in ("failed", "skipped") and page.depth < self.req.depth:
                    for link in page.links:
                        if self.req.same_domain and not same_site(link, self.root):
                            continue
                        self._enqueue(queue, link, page.depth + 1, page.final_url or page.requested_url)
            except Exception as e:  # never let one page kill the crawl
                page.state, page.error = "failed", f"internal error: {type(e).__name__}: {e}"
            finally:
                self.on_update(page)
                queue.task_done()

    async def _process(self, client: httpx.AsyncClient, page: PageResult) -> None:
        page.state = "crawling"
        self.on_update(page)
        t0 = time.monotonic()
        try:
            status, final_url, ctype, body, redirects, truncated = await asyncio.wait_for(
                self._fetch(client, page.requested_url), self.req.timeout
            )
        except asyncio.TimeoutError:
            page.state, page.error = "failed", f"timeout after {self.req.timeout:g}s"
            return
        except BlockedURL as e:
            page.state, page.error = "failed", f"blocked: {e}"
            return
        except (httpx.HTTPError, FetchError) as e:
            reason = blocked_reason(e)
            page.state = "failed"
            page.error = f"blocked: {reason}" if reason else f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
            return
        finally:
            page.elapsed_ms = int((time.monotonic() - t0) * 1000)

        page.status, page.final_url, page.content_type = status, final_url, ctype
        page.redirects, page.truncated, page.bytes = redirects, truncated, len(body)
        self.seen.add(final_url)
        mime = (ctype or "").split(";")[0].strip().lower()

        if mime in HTML_TYPES or (not mime and body.lstrip()[:15].lower().startswith((b"<!doctype", b"<html"))):
            html: str | bytes = body
            if self.req.render_mode != "http" and status < 400:
                try:
                    rendered = await self.renderer.render(final_url, self.req.timeout)
                    html, page.render_mode = rendered.html, "browser"
                    page.render_note = f"rendered by {rendered.backend}"
                except (RenderUnavailable, BlockedURL) as e:
                    page.render_note = f"browser rendering unavailable, used HTTP: {e}"
            ex = extract(html, final_url)
            page.title, page.text, page.markdown = ex.title, ex.text, ex.markdown
            page.links = ex.links
            page.external_links = [u for u in ex.links if not same_site(u, self.root)]
            page.assets = [Asset(kind=k, url=u) for k, u in ex.assets]
            state = "browser" if page.render_mode == "browser" else "ok"
        elif mime.startswith("text/") or mime in ("application/json", "application/xml"):
            page.text = body.decode("utf-8", "replace")
            page.markdown = f"```\n{page.text}\n```" if mime != "text/markdown" else page.text
            state = "ok"
        else:
            state = "skipped"
            page.error = f"not parsed: content type {mime or 'unknown'}"

        if status >= 400:
            page.state, page.error = "failed", f"HTTP {status}"
        elif state == "ok" and redirects:
            page.state = "redirected"
        else:
            page.state = state

    async def _fetch(self, client: httpx.AsyncClient, url: str):
        redirects: list[str] = []
        current = url
        for _ in range(self.policy.max_redirects + 1):
            await self.policy.vet_url(current)
            resp = await client.send(client.build_request("GET", current), stream=True)
            try:
                location = resp.headers.get("location")
                if resp.status_code in REDIRECT_CODES and location:
                    nxt = normalize_url(urljoin(current, location))
                    if nxt is None:
                        raise BlockedURL(f"redirect to unsupported URL: {location[:200]}")
                    redirects.append(nxt)
                    current = nxt
                    continue
                body, truncated = bytearray(), False
                async for chunk in resp.aiter_bytes():
                    room = self.policy.max_bytes - len(body)
                    if len(chunk) > room:
                        body += chunk[:room]
                        truncated = True
                        break
                    body += chunk
                return resp.status_code, current, resp.headers.get("content-type"), bytes(body), redirects, truncated
            finally:
                await resp.aclose()
        raise FetchError(f"too many redirects (>{self.policy.max_redirects})")


async def crawl(request: CrawlRequest, **kwargs) -> list[PageResult]:
    return await Crawler(request, **kwargs).run()
