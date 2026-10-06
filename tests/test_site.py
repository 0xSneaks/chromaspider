"""The GitHub Pages demo build (site/build.py) and its recorded crawl."""

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_build():
    spec = importlib.util.spec_from_file_location("site_build", ROOT / "site" / "build.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_build_outputs_relative_demo_site(tmp_path):
    out = load_build().build(tmp_path / "_site")
    for f in ["index.html", "demo.js", "demo.css", "demo-crawl.json", ".nojekyll",
              "static/app.js", "static/viz.js", "static/wall.js", "static/styles.css"]:
        assert (out / f).is_file(), f
    html = (out / "index.html").read_text()
    assert '"/static/' not in html  # project Pages live under /<repo>/
    scripts = re.findall(r'<script src="([^"]+)"', html)
    assert scripts == ["demo.js", "static/viz.js", "static/wall.js", "static/app.js"]  # shim before the app
    assert 'http-equiv="Content-Security-Policy"' in html and "script-src 'self'" in html
    assert "LIVE DEMO" in html and 'id="install"' in html
    assert (out / "static" / "app.js").read_bytes() == (ROOT / "chromaspider" / "static" / "app.js").read_bytes()


def test_build_is_repeatable(tmp_path):
    build = load_build().build
    build(tmp_path / "_site")
    (tmp_path / "_site" / "stale.txt").write_text("x")
    build(tmp_path / "_site")
    assert not (tmp_path / "_site" / "stale.txt").exists()


def test_recorded_demo_crawl_is_consistent():
    data = json.loads((ROOT / "site" / "demo-crawl.json").read_text())
    graph, crawl, pages = data["graph"], data["crawl"], data["pages"]
    assert crawl["status"] == graph["status"] == "done"
    assert len(pages) == len(graph["nodes"]) == len(crawl["pages"])
    assert all(n["url"].startswith("https://docs.chromaspider.test/") for n in graph["nodes"])
    assert data["markdown"].startswith("# Chromaspider crawl: https://docs.chromaspider.test/")
