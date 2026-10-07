"""Data models shared by the CLI, API, crawler and exports."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

RenderMode = Literal["http", "auto", "browser"]
NodeState = Literal["ok", "crawling", "browser", "skipped", "redirected", "failed", "queued"]

# Hard ceilings. Requests above these are rejected, not clamped.
MAX_DEPTH = 5
MAX_PAGES = 500
MAX_CONCURRENCY = 16
MAX_TIMEOUT = 60.0


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CrawlRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    depth: int = Field(default=1, ge=0, le=MAX_DEPTH)
    max_pages: int = Field(default=20, ge=1, le=MAX_PAGES)
    same_domain: bool = True
    render_mode: RenderMode = "http"
    timeout: float = Field(default=10.0, gt=0, le=MAX_TIMEOUT)
    concurrency: int = Field(default=4, ge=1, le=MAX_CONCURRENCY)
    respect_robots: bool = True

    @field_validator("url")
    @classmethod
    def _scheme(cls, v: str) -> str:
        v = v.strip()
        if "://" not in v:
            v = "https://" + v
        if not v.lower().startswith(("http://", "https://")):
            raise ValueError("only http and https URLs are allowed")
        return v


class Asset(BaseModel):
    kind: str
    url: str


class PageResult(BaseModel):
    requested_url: str
    final_url: Optional[str] = None
    title: Optional[str] = None
    status: Optional[int] = None
    content_type: Optional[str] = None
    text: str = ""
    markdown: str = ""
    links: list[str] = []
    external_links: list[str] = []
    assets: list[Asset] = []
    redirects: list[str] = []
    depth: int = 0
    parent_url: Optional[str] = None
    elapsed_ms: Optional[int] = None
    bytes: int = 0
    truncated: bool = False
    render_mode: Literal["http", "browser"] = "http"
    render_note: Optional[str] = None
    state: NodeState = "queued"
    error: Optional[str] = None
    timestamp: str = Field(default_factory=utcnow)


class CrawlRecord(BaseModel):
    id: str
    request: CrawlRequest
    status: Literal["running", "done", "failed"] = "running"
    started_at: str = Field(default_factory=utcnow)
    finished_at: Optional[str] = None
    error: Optional[str] = None
    pages: list[PageResult] = []
