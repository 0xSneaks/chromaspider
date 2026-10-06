import http.server
import threading

import pytest

from chromaspider.crawler import Crawler
from chromaspider.models import CrawlRequest
from chromaspider.security import BlockedURL, SecurityPolicy, check_url, is_blocked_ip

from .conftest import run


@pytest.mark.parametrize("ip", [
    "127.0.0.1", "127.8.9.10", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "0.0.0.0",
    "100.64.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2002:7f00:1::1", "198.18.0.1",
])
def test_blocked_ips(ip):
    assert is_blocked_ip(ip)


@pytest.mark.parametrize("ip", ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])
def test_public_ips_allowed(ip):
    assert not is_blocked_ip(ip)


@pytest.mark.parametrize("url", [
    "http://localhost/", "http://LOCALHOST:8080/", "http://foo.localhost/", "http://127.0.0.1/",
    "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/",
    "http://10.1.2.3/", "http://printer.local/", "http://[fd00::1]/", "http://0.0.0.0/",
])
def test_localhost_and_private_urls_blocked(url):
    with pytest.raises(BlockedURL):
        check_url(url)


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "javascript:alert(1)",
    "data:text/html,x", "ws://example.com/", "http:///nohost", "http://user:pw@example.com/",
])
def test_invalid_protocols_and_urls(url):
    with pytest.raises(BlockedURL):
        check_url(url)


def test_dns_resolving_to_private_is_blocked():
    async def evil(host, port):
        return ["93.184.216.34", "10.0.0.5"]  # any private answer blocks

    with pytest.raises(BlockedURL, match="10.0.0.5"):
        run(SecurityPolicy(resolver=evil).vet_url("https://evil.example/"))


def test_allow_private_opt_in():
    async def loop(host, port):
        return ["127.0.0.1"]

    run(SecurityPolicy(allow_private=True, resolver=loop).vet_url("http://localhost:1/"))


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = b"<html><title>local</title><body>secret</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def local_server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Quiet)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv.server_address[1]
    srv.shutdown()


def test_real_transport_blocks_localhost(local_server):
    req = CrawlRequest(url=f"http://127.0.0.1:{local_server}/", depth=0)
    pages = run(Crawler(req).run())
    assert pages[0].state == "failed" and pages[0].error.startswith("blocked")
    assert pages[0].text == ""


def test_real_transport_allows_localhost_when_opted_in(local_server):
    req = CrawlRequest(url=f"http://127.0.0.1:{local_server}/", depth=0)
    pages = run(Crawler(req, policy=SecurityPolicy(allow_private=True)).run())
    assert pages[0].state == "ok" and pages[0].title == "local"


def test_dns_rebinding_blocked_at_connect(local_server):
    """Pre-check sees a public IP; the connect-time lookup returns 127.0.0.1."""
    answers = iter([["93.184.216.34"], ["127.0.0.1"]])

    async def rebinding(host, port):
        return next(answers, ["127.0.0.1"])

    req = CrawlRequest(url=f"http://rebind.example:{local_server}/", depth=0)
    pages = run(Crawler(req, policy=SecurityPolicy(resolver=rebinding)).run())
    assert pages[0].state == "failed"
    assert "blocked" in pages[0].error and "127.0.0.1" in pages[0].error
