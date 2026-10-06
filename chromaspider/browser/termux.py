"""Experimental headless-Chromium adapter for Termux (also works on desktop).

Runs ``chromium --headless --dump-dom URL`` as a subprocess. To keep the SSRF
guarantees, Chromium's resolver is pinned with ``--host-resolver-rules`` so the
page's own host maps to the IP we already vetted and *every other host fails
to resolve*. That means third-party scripts/CDNs do not load: rendering is
same-host only. This is deliberate; see SECURITY.md.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from typing import Optional
from urllib.parse import urlsplit

from ..security import SecurityPolicy
from .base import BrowserRenderer, RenderedPage, RenderUnavailable

CANDIDATES = ("chromium", "chromium-browser", "google-chrome", "chrome")
MAX_DOM_BYTES = 10_000_000
# Chromium's own error / TLS-interstitial pages must never be reported as content.
ERROR_PAGE_MARKERS = ('id="main-frame-error"', 'class="interstitial-wrapper"', '<body class="neterror"')


def is_termux() -> bool:
    prefix = os.environ.get("PREFIX", "")
    return bool(
        os.environ.get("TERMUX_VERSION")
        or "com.termux" in prefix
        or (hasattr(sys, "getandroidapilevel"))
        or os.path.isdir("/data/data/com.termux/files/usr")
    )


def find_chromium() -> Optional[str]:
    override = os.environ.get("CHROMASPIDER_CHROMIUM")
    if override:
        return override if os.path.isfile(override) and os.access(override, os.X_OK) else None
    for name in CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def looks_like_error_page(html: str) -> bool:
    head = html[:200_000]
    return any(marker in head for marker in ERROR_PAGE_MARKERS)


class ChromiumDumpRenderer(BrowserRenderer):
    name = "chromium-dump-dom"

    def __init__(self, policy: Optional[SecurityPolicy] = None, binary: Optional[str] = None):
        self.policy = policy or SecurityPolicy()
        self.binary = binary or find_chromium()

    def available(self) -> bool:
        return self.binary is not None

    async def render(self, url: str, timeout: float = 15.0) -> RenderedPage:
        if not self.binary:
            raise RenderUnavailable("chromium binary not found")
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "https" else 80)
        ips = await self.policy.vet_host(host, port)  # raises BlockedURL
        ip = ips[0] if ":" not in ips[0] else f"[{ips[0]}]"
        rules = f"MAP {host} {ip}, MAP * ~NOTFOUND"
        with tempfile.TemporaryDirectory(prefix="chromaspider-") as profile:
            args = [
                self.binary, "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", "--disable-extensions", "--disable-sync",
                "--mute-audio", "--no-proxy-server", f"--host-resolver-rules={rules}",
                f"--user-data-dir={profile}", f"--timeout={int(timeout * 1000)}",
                "--virtual-time-budget=5000", "--dump-dom", url,
            ]
            if is_termux() or os.geteuid() == 0:  # no setuid sandbox on Android or as root
                args.insert(1, "--no-sandbox")
            try:
                proc = await asyncio.create_subprocess_exec(
                    *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
                )
            except OSError as e:
                raise RenderUnavailable(f"could not start chromium: {e}") from None
            try:
                out, _ = await asyncio.wait_for(proc.communicate(), timeout + 10)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise RenderUnavailable("chromium timed out") from None
        if proc.returncode != 0 or not out.strip():
            raise RenderUnavailable(f"chromium exited with code {proc.returncode} and no DOM")
        html = out[:MAX_DOM_BYTES].decode("utf-8", "replace")
        if looks_like_error_page(html):
            raise RenderUnavailable("chromium showed an error or certificate page instead of the site")
        return RenderedPage(url=url, final_url=url, html=html, backend=self.name)
