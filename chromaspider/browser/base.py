from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


class RenderUnavailable(Exception):
    """The backend cannot render (missing dependency, crash, timeout)."""


@dataclass
class RenderedPage:
    url: str
    final_url: str
    html: str
    backend: str
    status: Optional[int] = None


class BrowserRenderer:
    name = "base"

    def available(self) -> bool:
        return False

    async def render(self, url: str, timeout: float = 15.0) -> RenderedPage:
        raise RenderUnavailable(f"{self.name}: not implemented")

    async def close(self) -> None:
        return None


class DisabledRenderer(BrowserRenderer):
    name = "disabled"

    def __init__(self, reason: str = "rendering disabled"):
        self.reason = reason

    async def render(self, url: str, timeout: float = 15.0) -> RenderedPage:
        raise RenderUnavailable(self.reason)
