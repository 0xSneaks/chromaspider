import os
import stat

import pytest

from chromaspider.browser import DisabledRenderer, RenderUnavailable, get_renderer
from chromaspider.browser.termux import ChromiumDumpRenderer, is_termux, looks_like_error_page

from .conftest import run
from chromaspider.security import BlockedURL, SecurityPolicy


def test_http_mode_disables_rendering():
    assert isinstance(get_renderer("http"), DisabledRenderer)
    with pytest.raises(RenderUnavailable):
        run(get_renderer("http").render("https://example.com/"))


def test_termux_detection(monkeypatch):
    monkeypatch.setenv("TERMUX_VERSION", "0.118")
    assert is_termux()


def test_error_pages_detected():
    assert looks_like_error_page('<html><body class="neterror"><div id="main-frame-error">')
    assert looks_like_error_page('<body id="body" class="ssl"><div class="interstitial-wrapper">')
    assert not looks_like_error_page("<html><body><p>hello</p></body></html>")


def _fake_chromium(tmp_path, output: str, code: int = 0):
    path = tmp_path / "chromium"
    path.write_text(f"#!/bin/sh\ncat <<'X'\n{output}\nX\nexit {code}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


async def _public(host, port):
    return ["93.184.216.34"]


@pytest.mark.skipif(os.name != "posix", reason="shell script stub")
def test_chromium_adapter_with_stub(tmp_path):
    pol = SecurityPolicy(resolver=_public)
    ok = ChromiumDumpRenderer(pol, _fake_chromium(tmp_path, "<html><title>R</title></html>"))
    page = run(ok.render("https://site.test/"))
    assert "<title>R</title>" in page.html and page.backend == "chromium-dump-dom"

    bad = ChromiumDumpRenderer(pol, _fake_chromium(tmp_path, '<body class="neterror">'))
    with pytest.raises(RenderUnavailable):
        run(bad.render("https://site.test/"))

    crash = ChromiumDumpRenderer(pol, _fake_chromium(tmp_path, "", code=3))
    with pytest.raises(RenderUnavailable):
        run(crash.render("https://site.test/"))


def test_chromium_adapter_refuses_private_targets(tmp_path):
    r = ChromiumDumpRenderer(SecurityPolicy(), _fake_chromium(tmp_path, "<html></html>"))
    with pytest.raises(BlockedURL):
        run(r.render("http://127.0.0.1/"))
