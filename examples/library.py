"""Use the crawler core directly from Python (same code the CLI and API use)."""

import asyncio
import sys

from chromaspider.crawler import crawl
from chromaspider.models import CrawlRequest


async def main(url: str) -> None:
    pages = await crawl(CrawlRequest(url=url, depth=1, max_pages=5))
    for p in pages:
        print(f"{p.state:<10} {p.status or '---'} {p.requested_url} {p.title or p.error or ''}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "https://example.com"))
