"""Command-line interface: ``chromaspider crawl|serve|doctor``."""

from __future__ import annotations

import argparse
import asyncio
import os
import platform
import sys

from . import __version__
from .browser import describe_backends
from .crawler import Crawler
from .graph import export
from .models import CrawlRecord, CrawlRequest, utcnow
from .security import BlockedURL, SecurityPolicy
from .storage import CrawlStore

COLORS = {"ok": "92", "crawling": "96", "browser": "95", "skipped": "93", "redirected": "38;5;208",
          "failed": "91", "queued": "90", "brand": "38;5;213"}


def _use_color(stream) -> bool:
    return stream.isatty() and not os.environ.get("NO_COLOR")


def paint(text: str, key: str, on: bool) -> str:
    return f"\033[{COLORS[key]}m{text}\033[0m" if on else text


def banner(on: bool) -> str:
    letters = "CHROMASPIDER"
    hues = ["91", "38;5;208", "93", "92", "96", "94", "95", "38;5;213"]
    word = "".join(paint(c, "brand", False) if not on else f"\033[1;{hues[i % len(hues)]}m{c}\033[0m"
                   for i, c in enumerate(letters))
    return f"{word}  {paint('Crawl the web. Follow the colors.', 'queued', on)}"


def cmd_crawl(args) -> int:
    err = sys.stderr
    color = _use_color(err)
    try:
        req = CrawlRequest(url=args.url, depth=args.depth, max_pages=args.max_pages, same_domain=args.same_domain,
                           render_mode=args.render, timeout=args.timeout, concurrency=args.concurrency,
                           respect_robots=not args.ignore_robots)
    except ValueError as e:
        errors = getattr(e, "errors", lambda: [])()
        detail = "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in errors) or str(e)
        print(f"invalid request: {detail}", file=err)
        return 2
    policy = SecurityPolicy(allow_private=args.allow_private, max_bytes=args.max_bytes)
    if not args.quiet:
        print(banner(color), file=err)

    def on_update(page):
        if args.quiet or page.state in ("queued", "crawling"):
            return
        status = page.status if page.status is not None else "---"
        label = paint(f"{page.state:<10}", page.state, color)
        extra = f"  {page.error}" if page.error else f"  {page.title or ''}"[:80]
        print(f"{label} {status} d{page.depth} {page.requested_url}{extra}", file=err)

    crawl = CrawlRecord(id=CrawlStore.new_id(), request=req)

    async def go():
        try:
            await policy.vet_url(req.url)
        except BlockedURL as e:
            crawl.error = f"blocked: {e}"
            print(paint(crawl.error, "failed", color), file=err)
            return False
        crawler = Crawler(req, policy=policy, proxy=args.proxy, on_update=on_update)
        crawler.pages = crawl.pages
        await crawler.run()
        return True

    ok = asyncio.run(go())
    crawl.status, crawl.finished_at = ("done" if ok else "failed"), utcnow()
    body = export(crawl, args.output)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(body)
        if not args.quiet:
            print(f"wrote {args.out}", file=err)
    else:
        sys.stdout.write(body)
    if args.save:
        CrawlStore().save(crawl)
    return 0 if ok else 1


def cmd_serve(args) -> int:
    import uvicorn

    from .server import create_app

    policy = SecurityPolicy(allow_private=args.allow_private)
    hosts = None
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: serving beyond localhost exposes a crawler to your network.", file=sys.stderr)
        hosts = ["127.0.0.1", "localhost", args.host] + (args.allow_host or [])
    app = create_app(policy=policy, proxy=args.proxy, allowed_hosts=hosts)
    print(banner(_use_color(sys.stderr)), file=sys.stderr)
    print(f"open http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}", file=sys.stderr)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


def cmd_doctor(args) -> int:
    from .extract import PARSER

    info = {"chromaspider": __version__, "python": sys.version.split()[0], "platform": platform.platform(),
            "html_parser": PARSER, **describe_backends()}
    for k, v in info.items():
        print(f"{k:>16}: {v}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="chromaspider", description="Crawl the web. Follow the colors.")
    p.add_argument("--version", action="version", version=f"chromaspider {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("crawl", help="crawl a URL and print JSON or Markdown")
    c.add_argument("url")
    c.add_argument("--depth", type=int, default=1)
    c.add_argument("--max-pages", type=int, default=20)
    c.add_argument("--same-domain", action=argparse.BooleanOptionalAction, default=True)
    c.add_argument("--output", choices=["json", "markdown"], default="json")
    c.add_argument("--out", help="write to file instead of stdout")
    c.add_argument("--timeout", type=float, default=10.0)
    c.add_argument("--concurrency", type=int, default=4)
    c.add_argument("--render", choices=["http", "auto", "browser"], default="http")
    c.add_argument("--max-bytes", type=int, default=5_000_000)
    c.add_argument("--ignore-robots", action="store_true", help="do not fetch or obey robots.txt")
    c.add_argument("--proxy", help="http(s) proxy URL (environment proxies are ignored)")
    c.add_argument("--allow-private", action="store_true", help="DANGER: allow localhost/private targets")
    c.add_argument("--save", action="store_true", help="also save to ~/.chromaspider/crawls")
    c.add_argument("-q", "--quiet", action="store_true")
    c.set_defaults(func=cmd_crawl)

    s = sub.add_parser("serve", help="run the web UI and API")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8788)
    s.add_argument("--proxy")
    s.add_argument("--allow-host", action="append", help="extra Host header to accept")
    s.add_argument("--allow-private", action="store_true", help="DANGER: allow localhost/private targets")
    s.set_defaults(func=cmd_serve)

    d = sub.add_parser("doctor", help="show platform and optional backend status")
    d.set_defaults(func=cmd_doctor)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
