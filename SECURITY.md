# Security model

Chromaspider fetches URLs you give it and URLs it finds on pages. Both are
untrusted. The defaults are built so a crawl cannot be turned against your
phone, your LAN or a cloud metadata service.

## Network destination rules (SSRF)

Enforced in `chromaspider/security.py`:

* **Schemes:** only `http` and `https`. `file:`, `ftp:`, `data:`,
  `javascript:`, `gopher:`, `ws:` and others are rejected. URLs with
  embedded credentials are rejected.
* **Blocked hostnames:** `localhost`, `*.localhost`, `*.local`,
  `*.internal`, `*.home.arpa`, `metadata.google.internal`, `instance-data`
  and similar.
* **Blocked addresses:** loopback (`127.0.0.0/8`, `::1`), private ranges
  (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local
  (`169.254/16`, which includes `169.254.169.254` metadata, and `fe80::/10`),
  CGNAT `100.64/10`, unspecified, multicast, reserved and benchmark ranges,
  and anything Python's `ipaddress` does not consider globally routable.
  Blocking also covers IPv4-mapped IPv6 (`::ffff:127.0.0.1`), 6to4 addresses
  that wrap a private IPv4, and Teredo.
* **DNS is resolved and checked.** If *any* address a hostname resolves to
  is blocked, the request is refused.
* **Connect-time enforcement:** a custom httpcore network backend resolves
  and vets the host itself and then dials the vetted IP. Every TCP
  connection goes through this check, including each redirect hop, so DNS
  rebinding between the check and the connection cannot reach an internal
  address. This is tested in `tests/test_security.py`.
* **Redirects are followed manually.** Each hop is re-validated, with a
  maximum of 5.
* Environment proxy variables are **ignored**. Use `--proxy` to set one
  explicitly. With a proxy, the proxy endpoint itself is trusted, and the
  target hostname is still resolved and vetted locally before each request.

`--allow-private` turns these destination rules off. Use it only to crawl
your own local test servers.

## Resource limits

| Limit | Default | Hard max |
| --- | --- | --- |
| depth | 1 | 5 |
| pages per crawl | 20 | 500 |
| concurrency | 4 | 16 |
| request timeout (total per page, incl. redirects) | 10 s | 60 s |
| response body | 5 MB (truncated, flagged `truncated: true`) | CLI `--max-bytes` |
| redirects | 5 | - |
| simultaneous crawls via API | 2 | - |

## Content handling

* Crawled content is **never executed**. HTML is parsed with BeautifulSoup.
  `script`, `style`, `iframe`, `object`, `embed`, `svg`, `form` and similar
  are removed before text and Markdown are produced.
* The web UI renders all crawled data with `textContent`, never `innerHTML`,
  and serves a strict Content-Security-Policy (`script-src 'self'`, no
  inline script, `frame-ancestors 'none'`).
* Crawled content is **not sent to any LLM or external API**. Markdown
  exports carry a note that the content is untrusted. Treat it as data, not
  instructions, if you feed it to an agent.

## Local server

* `chromaspider serve` binds to `127.0.0.1` by default.
* The `Host` header must be `127.0.0.1`, `localhost` or `::1`. This blocks
  DNS-rebinding attacks from web pages against the local API.
* `POST` requires `Content-Type: application/json` and a same-origin
  `Origin`, so other websites open in your browser cannot start crawls.
* There is **no authentication**. Do not expose the server to a network
  (`--host 0.0.0.0`) unless you understand that anyone who can reach it can
  use it.

## Optional browser rendering: known limitations

* **Termux/Chromium adapter** (`--dump-dom`): Chromium's resolver is pinned
  with `--host-resolver-rules` so only the page's own host resolves, to the
  already-vetted IP. Every other host fails. This is safe but reduces
  fidelity. Chromium error and certificate pages are detected and discarded.
* **Playwright adapter**: every request the page makes is intercepted and
  vetted with the same rules before it is allowed. Residual risks:
  WebSocket connections are not intercepted by Playwright routing, and the
  browser's own DNS resolution happens after the check (rebinding window).
  Use the HTTP mode if that matters to you.

## Limits in V1

* `robots.txt` is obeyed by default (RFC 9309), but `--ignore-robots` or
  `"respect_robots": false` turns that off. Crawl politely, and only sites
  you are allowed to crawl.
* No authentication or rate limiting on the local API beyond the
  concurrent-crawl cap.

## Reporting

Please open a GitHub issue, or a private security advisory for anything
sensitive.
