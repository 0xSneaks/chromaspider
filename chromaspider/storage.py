"""In-memory crawl store with JSON-file persistence. No database server."""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Optional

from .models import CrawlRecord

ID_RE = re.compile(r"^[0-9a-f]{32}$")


def default_dir() -> Path:
    return Path(os.environ.get("CHROMASPIDER_DATA", Path.home() / ".chromaspider" / "crawls"))


class CrawlStore:
    def __init__(self, directory: Optional[Path] = None, persist: bool = True):
        self.dir = Path(directory) if directory else default_dir()
        self.persist = persist
        self._mem: dict[str, CrawlRecord] = {}

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex

    def put(self, crawl: CrawlRecord) -> None:
        self._mem[crawl.id] = crawl

    def save(self, crawl: CrawlRecord) -> None:
        self._mem[crawl.id] = crawl
        if not self.persist:
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.dir / f"{crawl.id}.json.tmp"
        tmp.write_text(crawl.model_dump_json(), encoding="utf-8")
        os.replace(tmp, self.dir / f"{crawl.id}.json")

    def get(self, crawl_id: str) -> Optional[CrawlRecord]:
        if not ID_RE.match(crawl_id or ""):
            return None  # also prevents path traversal
        if crawl_id in self._mem:
            return self._mem[crawl_id]
        path = self.dir / f"{crawl_id}.json"
        if self.persist and path.is_file():
            crawl = CrawlRecord.model_validate_json(path.read_text(encoding="utf-8"))
            self._mem[crawl_id] = crawl
            return crawl
        return None

    def list_ids(self) -> list[str]:
        ids = set(self._mem)
        if self.persist and self.dir.is_dir():
            ids |= {p.stem for p in self.dir.glob("*.json") if ID_RE.match(p.stem)}
        return sorted(ids)
