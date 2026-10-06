import asyncio

import httpx
import pytest

from chromaspider.security import SecurityPolicy

PUBLIC_IP = "93.184.216.34"


async def public_resolver(host, port):
    return [PUBLIC_IP]


def make_site(pages: dict, delays: dict | None = None):
    """MockTransport serving ``pages``: {url: (status, headers, body)} or html str."""
    delays = delays or {}
    hits: list[str] = []

    async def handler(request: httpx.Request):
        url = str(request.url)
        hits.append(url)
        if url in delays:
            await asyncio.sleep(delays[url])
        spec = pages.get(url)
        if spec is None:
            return httpx.Response(404, headers={"content-type": "text/html"}, text="<title>404</title>")
        if isinstance(spec, str):
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=spec)
        status, headers, body = spec
        return httpx.Response(status, headers=headers, content=body.encode() if isinstance(body, str) else body)

    return httpx.MockTransport(handler), hits


@pytest.fixture
def policy():
    return SecurityPolicy(resolver=public_resolver)


def run(coro):
    return asyncio.run(coro)
