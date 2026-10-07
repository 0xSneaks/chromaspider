import asyncio

import httpx

from chromaspider.browser import DisabledRenderer, RenderedPage
from chromaspider.browser.base import BrowserRenderer
from chromaspider.crawler import Crawler
from chromaspider.models import CrawlRequest
from chromaspider.security import SecurityPolicy

from .conftest import make_site, public_resolver, run

R = "https://site.test/"


def page(*links, title="t"):
    return f"<html><title>{title}</title><body>" + "".join(f'<a href="{l}">{l}</a>' for l in links) + "</body></html>"


def crawl(pages, policy, delays=None, renderer=None, **req):
    """Run a crawl; returns (pages, page fetches). robots.txt requests are counted separately in the robots tests."""
    transport, hits = make_site(pages, delays)
    request = CrawlRequest(url=req.pop("url", R), **req)
    result = run(Crawler(request, policy=policy, transport=transport, renderer=renderer).run())
    return result, [h for h in hits if not h.endswith("/robots.txt")]


def test_duplicates_suppressed(policy):
    site = {R: page("/a", "/a#x", "/a?", "/A".lower(), "/b"), R + "a": page("/", "/b"), R + "b": page("/a")}
    pages, hits = crawl(site, policy, depth=3)
    assert sorted(p.requested_url for p in pages) == [R, R + "a", R + "b"]
    assert len(hits) == 3


def test_depth_limit(policy):
    site = {R: page("/1"), R + "1": page("/2"), R + "2": page("/3"), R + "3": page()}
    pages, _ = crawl(site, policy, depth=2)
    assert [p.requested_url for p in pages] == [R, R + "1", R + "2"]
    assert [p.depth for p in pages] == [0, 1, 2]
    pages, _ = crawl(site, policy, depth=0)
    assert len(pages) == 1


def test_page_limit(policy):
    site = {R: page(*[f"/p{i}" for i in range(50)])}
    site.update({R + f"p{i}": page() for i in range(50)})
    pages, hits = crawl(site, policy, depth=1, max_pages=7)
    assert len(pages) == 7 and len(hits) == 7


def test_same_domain(policy):
    site = {R: page("https://www.site.test/w", "https://other.test/x"), "https://www.site.test/w": page(),
            "https://other.test/x": page()}
    pages, _ = crawl(site, policy, depth=1, same_domain=True)
    urls = [p.requested_url for p in pages]
    assert "https://other.test/x" not in urls and "https://www.site.test/w" in urls
    assert pages[0].external_links == ["https://other.test/x"]
    pages, _ = crawl(site, policy, depth=1, same_domain=False)
    assert "https://other.test/x" in [p.requested_url for p in pages]


def test_redirect_followed_and_recorded(policy):
    site = {R: (301, {"location": "/new"}, ""), R + "new": page(title="moved")}
    pages, _ = crawl(site, policy, depth=0)
    p = pages[0]
    assert p.state == "redirected" and p.final_url == R + "new" and p.redirects == [R + "new"]
    assert p.title == "moved" and p.status == 200


def test_redirect_to_private_is_blocked():
    async def resolver(host, port):
        return ["10.0.0.1"] if host == "internal.test" else ["93.184.216.34"]

    site = {R: (302, {"location": "http://internal.test/admin"}, ""), "http://internal.test/admin": page()}
    pages, hits = crawl(site, SecurityPolicy(resolver=resolver), depth=0)
    assert pages[0].state == "failed" and "blocked" in pages[0].error
    assert "http://internal.test/admin" not in hits


def test_redirect_to_bad_scheme_and_loops(policy):
    pages, _ = crawl({R: (302, {"location": "file:///etc/passwd"}, "")}, policy, depth=0)
    assert pages[0].state == "failed" and "blocked" in pages[0].error
    pages, hits = crawl({R: (302, {"location": "/"}, "")}, policy, depth=0)
    assert pages[0].state == "failed" and "too many redirects" in pages[0].error
    assert len(hits) == policy.max_redirects + 1


def test_timeout_marks_page_failed_without_crashing(policy):
    site = {R: page("/slow", "/fast"), R + "slow": page(), R + "fast": page()}
    pages, _ = crawl(site, policy, delays={R + "slow": 5}, depth=1, timeout=0.3)
    by = {p.requested_url: p for p in pages}
    assert by[R + "slow"].state == "failed" and "timeout" in by[R + "slow"].error
    assert by[R + "fast"].state == "ok"


def test_http_errors_and_non_html(policy):
    site = {R: page("/missing", "/img.png", "/notes.txt"),
            R + "img.png": (200, {"content-type": "image/png"}, b"\x89PNG"),
            R + "notes.txt": (200, {"content-type": "text/plain"}, "plain words")}
    pages, _ = crawl(site, policy, depth=1)
    by = {p.requested_url: p for p in pages}
    assert by[R + "missing"].state == "failed" and by[R + "missing"].error == "HTTP 404"
    assert by[R + "img.png"].state == "skipped"
    assert by[R + "notes.txt"].state == "ok" and by[R + "notes.txt"].text == "plain words"


def test_response_size_limit(policy):
    site = {R: "<html><body>" + "x" * 50_000 + "</body></html>"}
    transport, _ = make_site(site)
    pol = SecurityPolicy(resolver=public_resolver, max_bytes=1000)
    pages = run(Crawler(CrawlRequest(url=R, depth=0), policy=pol, transport=transport).run())
    assert pages[0].truncated and pages[0].bytes == 1000


def test_page_fields_captured(policy):
    pages, _ = crawl({R: page("/a", title="Home"), R + "a": page()}, policy, depth=1)
    root, child = pages
    assert root.title == "Home" and root.status == 200 and root.content_type.startswith("text/html")
    assert root.elapsed_ms is not None and root.timestamp and root.render_mode == "http"
    assert child.parent_url == R and child.depth == 1


def test_browser_unavailable_falls_back_to_http(policy):
    pages, _ = crawl({R: page()}, policy, depth=0, render_mode="browser", renderer=DisabledRenderer("nope"))
    assert pages[0].state == "ok" and pages[0].render_mode == "http"
    assert "unavailable" in pages[0].render_note


def test_browser_render_marks_page(policy):
    class Fake(BrowserRenderer):
        name = "fake"

        async def render(self, url, timeout=15.0):
            return RenderedPage(url=url, final_url=url, html="<title>JS</title><p>rendered</p>", backend="fake")

    pages, _ = crawl({R: page(title="raw")}, policy, depth=0, render_mode="auto", renderer=Fake())
    assert pages[0].state == "browser" and pages[0].render_mode == "browser" and pages[0].title == "JS"


def test_concurrency_bound(policy):
    active = peak = 0

    async def handler(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        if str(request.url) == R:
            return httpx.Response(200, headers={"content-type": "text/html"}, text=page(*[f"/{i}" for i in range(20)]))
        return httpx.Response(200, headers={"content-type": "text/html"}, text=page())

    req = CrawlRequest(url=R, depth=1, max_pages=21, concurrency=3)
    pages = run(Crawler(req, policy=policy, transport=httpx.MockTransport(handler)).run())
    assert len(pages) == 21 and peak <= 3


# ------------------------------------------------------------------ robots.txt


def robots(text):
    return (200, {"content-type": "text/plain"}, text)


def test_robots_disallow_skips_pages_and_their_links(policy):
    site = {R + "robots.txt": robots("User-agent: *\nDisallow: /private\n"),
            R: page("/a", "/private", "/private/deeper"), R + "a": page(), R + "private": page("/never")}
    pages, hits = crawl(site, policy, depth=2)
    by = {p.requested_url: p for p in pages}
    assert by[R + "private"].state == "skipped" and "robots.txt" in by[R + "private"].error
    assert by[R + "a"].state == "ok"
    assert R + "private" not in hits and R + "private/deeper" not in hits and R + "never" not in by


def test_robots_agent_specific_rules_and_single_fetch(policy):
    site = {R + "robots.txt": robots("User-agent: Chromaspider\nDisallow: /a\n\nUser-agent: *\nDisallow:\n"),
            R: page("/a", "/b"), R + "a": page(), R + "b": page()}
    transport, all_hits = make_site(site)
    result = run(Crawler(CrawlRequest(url=R, depth=1), policy=policy, transport=transport).run())
    states = {p.requested_url: p.state for p in result}
    assert states[R + "a"] == "skipped" and states[R + "b"] == "ok"
    assert all_hits.count(R + "robots.txt") == 1  # fetched once per origin, even with 4 workers


def test_missing_robots_allows_everything(policy):
    pages, _ = crawl({R: page("/a"), R + "a": page()}, policy, depth=1)  # robots.txt -> 404
    assert [p.state for p in pages] == ["ok", "ok"]


def test_unreachable_robots_means_disallow_all(policy):
    site = {R + "robots.txt": (503, {"content-type": "text/plain"}, "down"), R: page("/a")}
    pages, hits = crawl(site, policy, depth=1)
    assert len(pages) == 1 and pages[0].state == "skipped"
    assert "HTTP 503" in pages[0].error and hits == []


def test_ignore_robots_opt_out(policy):
    site = {R + "robots.txt": robots("User-agent: *\nDisallow: /\n"), R: page()}
    transport, all_hits = make_site(site)
    result = run(Crawler(CrawlRequest(url=R, depth=0, respect_robots=False), policy=policy, transport=transport).run())
    assert result[0].state == "ok" and R + "robots.txt" not in all_hits


def test_robots_checked_on_redirect_targets(policy):
    site = {R + "robots.txt": robots("User-agent: *\nDisallow: /secret\n"),
            R: (302, {"location": "/secret"}, ""), R + "secret": page()}
    pages, hits = crawl(site, policy, depth=0)
    assert pages[0].state == "skipped" and R + "secret" not in hits


def test_crawl_delay_is_honored_and_capped(policy, monkeypatch):
    import chromaspider.crawler as crawler_mod

    slept = []

    async def fake_sleep(s):
        slept.append(s)

    monkeypatch.setattr(crawler_mod.asyncio, "sleep", fake_sleep)
    site = {R + "robots.txt": robots("User-agent: *\nCrawl-delay: 30\n"), R: page("/a", "/b"),
            R + "a": page(), R + "b": page()}
    pages, _ = crawl(site, policy, depth=1, concurrency=1)
    assert [p.state for p in pages] == ["ok", "ok", "ok"]
    # fake sleep does not advance the clock, so waits stack: each step is the capped 5s, not robots' 30s
    cap = crawler_mod.MAX_CRAWL_DELAY
    steps = [b - a for a, b in zip([0.0] + slept, slept)]
    assert len(slept) == 2 and all(cap - 0.1 <= st <= cap + 0.01 for st in steps)
