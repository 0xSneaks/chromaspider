"""Record the demo crawl used by the GitHub Pages site.

Runs the real Chromaspider crawler and API against an offline mock site built from this repo's own
docs (README, SECURITY, ANDROID), so the published demo shows genuine crawler output without
crawling or republishing anyone else's pages.

    pip install -e .[test] && python site/make_demo.py   # writes site/demo-crawl.json
"""

import html
import json
import re
import sys
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from chromaspider.security import SecurityPolicy  # noqa: E402
from chromaspider.server import create_app  # noqa: E402
from chromaspider.storage import CrawlStore  # noqa: E402
from tests.conftest import make_site, public_resolver  # noqa: E402

BASE = "https://docs.chromaspider.test/"
DOCS = [("readme", "README.md"), ("security", "SECURITY.md"), ("android", "ANDROID.md")]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "section"


def sections(md):
    """Split a Markdown file into (title, body) by level-2 headings."""
    title, out, cur, buf = None, [], None, []
    for line in md.splitlines():
        if line.startswith("# ") and title is None:
            title = line[2:].strip()
        elif line.startswith("## "):
            if cur:
                out.append((cur, "\n".join(buf)))
            cur, buf = line[3:].strip(), []
        elif cur:
            buf.append(line)
    if cur:
        out.append((cur, "\n".join(buf)))
    return title, out


def page(title, md, links=()):
    paras = "".join(f"<p>{html.escape(p.strip())}</p>" for p in md.split("\n\n") if p.strip())
    nav = "".join(f'<li><a href="{href}">{html.escape(text)}</a></li>' for href, text in links)
    return f"<title>{html.escape(title)}</title><h1>{html.escape(title)}</h1>{paras}<ul>{nav}</ul>"


def build_site():
    pages, top = {}, []
    for key, fname in DOCS:
        title, secs = sections((ROOT / fname).read_text(encoding="utf-8"))
        title = title or fname
        doc_url = f"{BASE}{key}/"
        links = [(f"/{key}/{slug(t)}", t) for t, _ in secs[:6]]
        if key == "android":
            links.append(("/android/missing-page", "Old install guide"))  # a dead link, so the demo shows a failure
        intro = " ".join(body for _, body in secs[:1])
        pages[doc_url] = page(title, intro, links)
        for t, body in secs[:6]:
            pages[f"{BASE}{key}/{slug(t)}"] = page(f"{title}: {t}", body)
        top.append((f"/{key}/", title))
    pages[BASE] = page("Chromaspider docs", "Crawl the web. Follow the colors. Demo site built from the Chromaspider docs.", top)
    pages[f"{BASE}android/missing-page"] = (404, {"content-type": "text/html"}, "<title>404</title>")
    return pages


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "site" / "demo-crawl.json"
    transport, _ = make_site(build_site())
    app = create_app(store=CrawlStore(Path(tempfile.mkdtemp())), policy=SecurityPolicy(resolver=public_resolver),
                     crawler_kwargs={"transport": transport}, allowed_hosts=["testserver"])
    with TestClient(app) as c:
        r = c.post("/api/crawl", json={"url": BASE, "depth": 2, "max_pages": 40, "same_domain": True})
        cid = r.json()["id"]
        for _ in range(200):
            crawl = c.get(f"/api/crawls/{cid}").json()
            if crawl["status"] != "running":
                break
            time.sleep(0.05)
        graph = c.get(f"/api/crawls/{cid}/graph").json()
        pages = [c.get(f"/api/crawls/{cid}/pages/{i}").json() for i in range(len(crawl["pages"]))]
        assert pages == crawl["pages"], "page API should match the crawl record; demo.js serves crawl.pages"
        markdown = c.get(f"/api/crawls/{cid}/export?format=markdown").text
    data = {"note": "Recorded by site/make_demo.py from an offline mock site built from the Chromaspider docs.",
            "crawl": crawl, "graph": graph, "markdown": markdown}
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out}: {len(pages)} pages, status {crawl['status']}, counts {graph['counts']}")


if __name__ == "__main__":
    main()
