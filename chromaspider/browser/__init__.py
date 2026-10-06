"""Optional JavaScript rendering backends.

The HTTP crawler never depends on these. ``get_renderer`` returns the best
available backend for the requested mode, or a ``DisabledRenderer``.
"""

from __future__ import annotations

from .base import BrowserRenderer, DisabledRenderer, RenderedPage, RenderUnavailable
from .desktop import PlaywrightRenderer
from .termux import ChromiumDumpRenderer, is_termux

__all__ = [
    "BrowserRenderer",
    "DisabledRenderer",
    "RenderedPage",
    "RenderUnavailable",
    "PlaywrightRenderer",
    "ChromiumDumpRenderer",
    "is_termux",
    "get_renderer",
    "describe_backends",
]


def get_renderer(mode: str, policy=None) -> BrowserRenderer:
    if mode == "http":
        return DisabledRenderer("rendering disabled (render_mode=http)")
    candidates = [ChromiumDumpRenderer(policy), PlaywrightRenderer(policy)]
    if not is_termux():
        candidates.reverse()
    for r in candidates:
        if r.available():
            return r
    return DisabledRenderer("no browser backend available; install Playwright (desktop) or chromium (Termux)")


def describe_backends() -> dict:
    return {
        "termux": is_termux(),
        "playwright": PlaywrightRenderer().available(),
        "chromium_binary": ChromiumDumpRenderer().binary,
    }
