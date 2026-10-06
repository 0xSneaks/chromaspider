import json

from chromaspider.cli import main
from chromaspider.graph import build_graph, to_markdown
from chromaspider.models import CrawlRecord, CrawlRequest, PageResult


def record():
    pages = [
        PageResult(requested_url="https://a.test/", final_url="https://a.test/", state="ok", title="Root",
                   markdown="# Root"),
        PageResult(requested_url="https://a.test/x", parent_url="https://a.test/", depth=1, state="failed",
                   error="HTTP 500"),
        PageResult(requested_url="https://a.test/y", parent_url="https://a.test/", depth=1, state="redirected",
                   final_url="https://a.test/z"),
        PageResult(requested_url="https://a.test/q", parent_url="https://a.test/z", depth=2, state="browser"),
    ]
    return CrawlRecord(id="f" * 32, request=CrawlRequest(url="https://a.test/"), pages=pages, status="done")


def test_graph_construction():
    g = build_graph(record())
    assert [n["color"] for n in g["nodes"]] == ["green", "red", "orange", "violet"]
    # parent of /q is the *final* URL of /y, so it links to node 2
    assert sorted((e["source"], e["target"]) for e in g["edges"]) == [(0, 1), (0, 2), (2, 3)]
    assert g["counts"] == {"ok": 1, "failed": 1, "redirected": 1, "browser": 1}


def test_markdown_export():
    md = to_markdown(record())
    assert md.startswith("# Chromaspider crawl: https://a.test/")
    assert "## 1. Root" in md and "# Root" in md and "- error: HTTP 500" in md
    assert "- final url: https://a.test/z" in md and "untrusted" in md


def test_json_roundtrip():
    rec = record()
    again = CrawlRecord.model_validate_json(rec.model_dump_json())
    assert again == rec


def test_cli_blocks_private(capsys):
    assert main(["crawl", "http://127.0.0.1/", "-q"]) == 1
    out = json.loads(capsys.readouterr().out)
    assert out["status"] == "failed" and out["pages"] == []


def test_cli_rejects_bad_scheme(capsys):
    assert main(["crawl", "file:///etc/passwd", "-q"]) == 2
