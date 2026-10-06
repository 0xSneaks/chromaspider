import time

import pytest
from fastapi.testclient import TestClient

from chromaspider.server import create_app
from chromaspider.storage import CrawlStore

from .conftest import make_site, public_resolver
from chromaspider.security import SecurityPolicy

R = "https://site.test/"
SITE = {R: '<title>Home</title><a href="/a">a</a><a href="/b">b</a>', R + "a": "<title>A</title><p>alpha</p>",
        R + "b": (301, {"location": "/a"}, "")}


@pytest.fixture
def client(tmp_path):
    transport, _ = make_site(SITE)
    app = create_app(store=CrawlStore(tmp_path), policy=SecurityPolicy(resolver=public_resolver),
                     crawler_kwargs={"transport": transport}, allowed_hosts=["testserver", "127.0.0.1"])
    with TestClient(app) as c:
        yield c


def wait_done(client, cid):
    for _ in range(100):
        r = client.get(f"/api/crawls/{cid}")
        if r.json()["status"] != "running":
            return r.json()
        time.sleep(0.05)
    raise AssertionError("crawl did not finish")


def start(client, **body):
    return client.post("/api/crawl", json={"url": R, "depth": 1, "max_pages": 10, "same_domain": True, **body})


def test_full_flow_graph_and_exports(client, tmp_path):
    r = start(client)
    assert r.status_code == 202
    cid = r.json()["id"]
    crawl = wait_done(client, cid)
    assert crawl["status"] == "done" and len(crawl["pages"]) == 3

    g = client.get(f"/api/crawls/{cid}/graph").json()
    assert len(g["nodes"]) == 3
    assert {(e["source"], e["target"]) for e in g["edges"]} == {(0, 1), (0, 2)}
    states = {n["url"]: n["state"] for n in g["nodes"]}
    assert states[R] == "ok" and states[R + "b"] == "redirected"

    j = client.get(f"/api/crawls/{cid}/export?format=json")
    assert j.status_code == 200 and j.headers["content-type"].startswith("application/json")
    assert j.json()["id"] == cid and "attachment" in j.headers["content-disposition"]
    md = client.get(f"/api/crawls/{cid}/export?format=markdown")
    assert md.headers["content-type"].startswith("text/markdown")
    assert "# Chromaspider crawl: https://site.test/" in md.text and "alpha" in md.text

    assert client.get(f"/api/crawls/{cid}/pages/1").json()["title"] == "A"
    assert client.get(f"/api/crawls/{cid}/pages/99").status_code == 404
    assert (tmp_path / f"{cid}.json").is_file()  # persisted


@pytest.mark.parametrize("body", [
    {"url": "file:///etc/passwd"}, {"url": "ftp://x.org/"}, {"url": R, "depth": 99}, {"url": R, "max_pages": 0},
    {"url": R, "max_pages": 100000}, {"url": R, "render_mode": "magic"}, {"url": ""}, {"depth": 1},
    {"url": R, "concurrency": 999}, {"url": R, "timeout": -1},
])
def test_validation_rejects(client, body):
    assert client.post("/api/crawl", json=body).status_code == 422


@pytest.mark.parametrize("url", ["http://127.0.0.1/", "http://localhost:8788/", "http://10.0.0.1/",
                                 "http://169.254.169.254/", "http://[::1]/"])
def test_private_targets_rejected(client, url):
    r = client.post("/api/crawl", json={"url": url})
    assert r.status_code == 400 and "blocked" in r.json()["detail"]


def test_csrf_and_host_guards(client):
    assert client.post("/api/crawl", content='{"url":"https://site.test/"}',
                       headers={"content-type": "text/plain"}).status_code == 415
    assert client.post("/api/crawl", json={"url": R}, headers={"origin": "https://evil.test"}).status_code == 403
    assert client.get("/api/health", headers={"host": "evil.test"}).status_code == 400


def test_unknown_and_malformed_ids(client):
    assert client.get("/api/crawls/" + "0" * 32).status_code == 404
    assert client.get("/api/crawls/..%2F..%2Fetc%2Fpasswd").status_code == 404
    assert client.get("/api/crawls/abc/export?format=json").status_code == 404
    r = start(client)
    assert client.get(f"/api/crawls/{r.json()['id']}/export?format=xml").status_code == 422


def test_ui_and_static_served_with_csp(client):
    r = client.get("/")
    assert r.status_code == 200 and "CHROMASPIDER" in r.text
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/styles.css").status_code == 200
    assert client.get("/api/health").json()["ok"] is True
