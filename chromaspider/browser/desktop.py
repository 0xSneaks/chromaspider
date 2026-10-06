"""Playwright adapter. Used only if the ``playwright`` package and its browser
are already installed; Chromaspider never installs them for you."""

from __future__ import annotations

import importlib.util
from typing import Optional

from ..security import BlockedURL, SecurityPolicy
from .base import BrowserRenderer, RenderedPage, RenderUnavailable


class PlaywrightRenderer(BrowserRenderer):
    name = "playwright"

    def __init__(self, policy: Optional[SecurityPolicy] = None):
        self.policy = policy or SecurityPolicy()
        self._pw = None
        self._browser = None
        self._failed: Optional[str] = None

    def available(self) -> bool:
        return importlib.util.find_spec("playwright") is not None

    async def _ensure(self):
        if self._failed:
            raise RenderUnavailable(self._failed)
        if self._browser is None:
            try:
                from playwright.async_api import async_playwright
            except ImportError as e:
                raise RenderUnavailable(f"playwright not installed: {e}") from None
            try:
                self._pw = await async_playwright().start()
                self._browser = await self._pw.chromium.launch(headless=True)
            except Exception as e:
                await self.close()
                self._failed = f"playwright launch failed: {e}"
                raise RenderUnavailable(self._failed) from None
        return self._browser

    async def render(self, url: str, timeout: float = 15.0) -> RenderedPage:
        browser = await self._ensure()
        ctx = await browser.new_context(java_script_enabled=True, accept_downloads=False, service_workers="block")
        policy = self.policy

        async def guard(route):
            # Every request the page makes (redirects, subresources) is vetted.
            try:
                await policy.vet_url(route.request.url)
            except BlockedURL:
                await route.abort("blockedbyclient")
                return
            await route.continue_()

        try:
            await ctx.route("**/*", guard)
            page = await ctx.new_page()
            resp = await page.goto(url, timeout=timeout * 1000, wait_until="networkidle")
            html = await page.content()
            return RenderedPage(url=url, final_url=page.url, html=html, backend=self.name,
                                status=resp.status if resp else None)
        except Exception as e:
            raise RenderUnavailable(f"playwright render failed: {e}") from None
        finally:
            await ctx.close()

    async def close(self) -> None:
        try:
            if self._browser:
                await self._browser.close()
            if self._pw:
                await self._pw.stop()
        finally:
            self._browser = self._pw = None
