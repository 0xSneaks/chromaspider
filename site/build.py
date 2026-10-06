"""Build the GitHub Pages demo: the real Chromaspider UI plus a replay shim (demo.js).

    python site/build.py _site

Standard library only. Copies chromaspider/static as-is, makes asset paths relative (Pages serves
the site under /<repo>/), and adds the demo banner, install notes, a CSP meta tag and demo.js.
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "chromaspider" / "static"
SITE = ROOT / "site"
REPO = "https://github.com/0xSneaks/chromaspider"

# Same policy as the server's CSP header, minus frame-ancestors (not allowed in a meta tag).
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")

BANNER = f"""<p class="demo-banner"><b>LIVE DEMO</b> · This page replays a recorded crawl of a small offline
mock site built from Chromaspider's own docs. Nothing is crawled from here.
<a href="#install">Install Chromaspider</a> to crawl real sites.</p>
"""

INSTALL = f"""<section id="install" class="panel install">
  <h2>Run it yourself</h2>
  <p>Chromaspider is a Python app that runs on your own machine and serves this UI on
  <code>http://127.0.0.1:8788</code>. Source and docs: <a href="{REPO}">{REPO.removeprefix("https://")}</a>.</p>
  <h3>Desktop (Linux / macOS / Windows), Python 3.10+</h3>
  <pre class="md">git clone {REPO}
cd chromaspider
python -m venv .venv &amp;&amp; . .venv/bin/activate
pip install -e .
chromaspider serve</pre>
  <h3>Android (Termux from F-Droid), not yet verified on a device</h3>
  <pre class="md">pkg update
pkg install python git rust
git clone {REPO}
cd chromaspider
pip install -e .
chromaspider serve</pre>
  <p>Then open <code>http://127.0.0.1:8788</code>, paste a URL and press CRAWL.
  <a href="{REPO}/blob/main/docs/crawl-view.mp4">Watch the crawl view recording</a>.</p>
</section>
"""

EDITS = [  # (anchor that must appear exactly once in index.html, replacement)
    ('<meta charset="utf-8">', f'<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="{CSP}">'),
    ('<link rel="stylesheet" href="/static/styles.css">',
     '<link rel="stylesheet" href="static/styles.css">\n<link rel="stylesheet" href="demo.css">'),
    ("</header>", "</header>\n" + BANNER),
    ('<footer class="foot">', INSTALL + '<footer class="foot">'),
    ('<script src="/static/viz.js"></script>', '<script src="demo.js"></script>\n<script src="static/viz.js"></script>'),
    ('<script src="/static/wall.js"></script>', '<script src="static/wall.js"></script>'),
    ('<script src="/static/app.js"></script>', '<script src="static/app.js"></script>'),
]


def build(out: Path) -> Path:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC, out / "static", ignore=shutil.ignore_patterns("index.html"))
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    for anchor, replacement in EDITS:
        if html.count(anchor) != 1:
            raise SystemExit(f"build.py: expected exactly one {anchor!r} in index.html; update EDITS")
        html = html.replace(anchor, replacement)
    if '"/static/' in html:
        raise SystemExit("build.py: an absolute /static/ path is left in index.html; update EDITS")
    (out / "index.html").write_text(html, encoding="utf-8")
    for name in ("demo.js", "demo.css", "demo-crawl.json"):
        shutil.copy2(SITE / name, out / name)
    (out / ".nojekyll").write_text("", encoding="utf-8")
    return out


if __name__ == "__main__":
    print(f"built {build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '_site')}")
