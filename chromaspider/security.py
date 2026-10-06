"""SSRF protection.

Every outbound TCP connection the crawler makes goes through ``SafeBackend``,
which resolves the hostname itself, rejects private / loopback / link-local /
metadata destinations, and then connects to the vetted IP. Because the check
happens at connect time (not only before the request), redirects and DNS
rebinding cannot route a request to an internal address.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from typing import Awaitable, Callable, Iterable, Optional
from urllib.parse import urlsplit

import httpcore
import httpx

Resolver = Callable[[str, int], Awaitable[list[str]]]

BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
}
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa")

# Addresses that ipaddress may consider "global" but that must never be crawled.
EXTRA_BLOCKED_NETS = [
    ipaddress.ip_network("100.64.0.0/10"),  # carrier-grade NAT
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("64:ff9b:1::/48"),
    ipaddress.ip_network("2002::/16"),  # 6to4 can wrap private IPv4
]


class BlockedURL(Exception):
    """Raised when a URL or destination is refused by the security policy."""


def is_blocked_ip(ip: str | ipaddress._BaseAddress) -> bool:
    addr = ipaddress.ip_address(ip) if isinstance(ip, str) else ip
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            return is_blocked_ip(addr.ipv4_mapped)
        if addr.sixtofour is not None and is_blocked_ip(addr.sixtofour):
            return True
        if addr.teredo is not None:
            return True
    if (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
        or not addr.is_global
    ):
        return True
    return any(addr in net for net in EXTRA_BLOCKED_NETS if net.version == addr.version)


def check_hostname(host: str) -> None:
    h = host.strip("[]").rstrip(".").lower()
    if not h:
        raise BlockedURL("missing host")
    if h in BLOCKED_HOSTNAMES or h.endswith(BLOCKED_SUFFIXES):
        raise BlockedURL(f"blocked host: {h}")
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return
    if is_blocked_ip(ip):
        raise BlockedURL(f"blocked address: {h}")


def check_url(url: str, allow_private: bool = False) -> None:
    """Static checks that need no DNS: scheme, host, port, credentials."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as e:
        raise BlockedURL(f"malformed URL: {e}") from None
    if parts.scheme not in ("http", "https"):
        raise BlockedURL(f"scheme not allowed: {parts.scheme or '(none)'}")
    if not parts.hostname:
        raise BlockedURL("missing host")
    if parts.username or parts.password:
        raise BlockedURL("credentials in URL are not allowed")
    if port is not None and not (0 < port < 65536):
        raise BlockedURL("invalid port")
    if not allow_private:
        check_hostname(parts.hostname)


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(info[4][0] for info in infos))


@dataclass
class SecurityPolicy:
    allow_private: bool = False
    max_bytes: int = 5_000_000
    max_redirects: int = 5
    resolver: Resolver = system_resolver

    async def vet_host(self, host: str, port: int) -> list[str]:
        """Resolve ``host`` and return its IPs, or raise BlockedURL."""
        if not self.allow_private:
            check_hostname(host)
        try:
            ips = await self.resolver(host.strip("[]"), port)
        except (OSError, UnicodeError) as e:
            raise BlockedURL(f"DNS lookup failed for {host}: {e}") from None
        if not ips:
            raise BlockedURL(f"no addresses for {host}")
        if not self.allow_private:
            bad = [ip for ip in ips if is_blocked_ip(ip)]
            if bad:
                raise BlockedURL(f"{host} resolves to blocked address {bad[0]}")
        return ips

    async def vet_url(self, url: str) -> None:
        check_url(url, self.allow_private)
        parts = urlsplit(url)
        await self.vet_host(parts.hostname or "", parts.port or (443 if parts.scheme == "https" else 80))


class SafeBackend(httpcore.AsyncNetworkBackend):
    """Network backend that only dials vetted public IPs.

    A configured proxy endpoint is the one exception: it is chosen by the
    operator, and the target host is still vetted before each request.
    """

    def __init__(self, policy: SecurityPolicy, proxy_endpoint: Optional[tuple[str, int]] = None):
        self.policy = policy
        self.proxy_endpoint = proxy_endpoint
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        if self.proxy_endpoint and (host, port) == self.proxy_endpoint:
            return await self._inner.connect_tcp(host, port, timeout, local_address, socket_options)
        try:
            ips = await self.policy.vet_host(host, port)
        except BlockedURL as e:
            raise httpcore.ConnectError(f"blocked: {e}") from None
        last: Exception | None = None
        for ip in ips:
            try:
                return await self._inner.connect_tcp(ip, port, timeout, local_address, socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as e:
                last = e
        raise last or httpcore.ConnectError("connect failed")

    async def connect_unix_socket(self, *args, **kwargs):  # pragma: no cover
        raise httpcore.ConnectError("unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class SafeTransport(httpx.AsyncHTTPTransport):
    """httpx transport whose connection pool uses ``SafeBackend``."""

    def __init__(self, policy: SecurityPolicy, proxy: Optional[str] = None, max_connections: int = 16):
        super().__init__(trust_env=False)
        ssl_context = httpx.create_ssl_context(trust_env=True)  # honours SSL_CERT_FILE
        limits = dict(max_connections=max_connections, max_keepalive_connections=max_connections)
        if proxy:
            p = httpx.URL(proxy)
            if p.scheme not in ("http", "https"):
                raise ValueError("only http(s) proxies are supported")
            port = p.port or (443 if p.scheme == "https" else 80)
            backend = SafeBackend(policy, (p.host, port))
            self._pool = httpcore.AsyncHTTPProxy(
                proxy_url=httpcore.URL(scheme=p.raw_scheme, host=p.raw_host, port=port, target=b"/"),
                ssl_context=ssl_context,
                network_backend=backend,
                **limits,
            )
        else:
            self._pool = httpcore.AsyncConnectionPool(
                ssl_context=ssl_context, network_backend=SafeBackend(policy), **limits
            )


def blocked_reason(exc: BaseException) -> Optional[str]:
    """Return a readable reason if ``exc`` came from the security layer."""
    for e in _chain(exc):
        if isinstance(e, BlockedURL):
            return str(e)
        msg = str(e)
        if msg.startswith("blocked: "):
            return msg[len("blocked: "):]
    return None


def _chain(exc: BaseException) -> Iterable[BaseException]:
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__
