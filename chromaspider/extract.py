"""HTML parsing: URL normalization, links, assets, text and Markdown.

Fetched HTML is untrusted data. Nothing here executes it; scripts, styles and
embedded documents are dropped before text or Markdown is produced.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup, NavigableString, Tag

try:  # lxml is optional; it is faster but can be awkward to build on Termux.
    import lxml  # noqa: F401  (availability probe)

    PARSER = "lxml"
except ImportError:  # pragma: no cover - depends on environment
    PARSER = "html.parser"

DROP_TAGS = ("script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "canvas", "form")
SKIP_LINK_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "ftp:", "sms:", "blob:", "about:")


def normalize_url(url: str, base: Optional[str] = None) -> Optional[str]:
    """Return a canonical http(s) URL, or None if it is not crawlable.

    Lowercases scheme and host, IDNA-encodes the host, drops default ports,
    fragments and empty queries, and sorts query parameters.
    """
    url = (url or "").strip()
    if not url or url.lower().startswith(SKIP_LINK_SCHEMES):
        return None
    if base:
        url = urljoin(base, url)
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not parts.hostname:
        return None
    host = parts.hostname.rstrip(".").lower()
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    if ":" in host:
        host = f"[{host}]"
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = f"{host}:{port}"
    path = _remove_dots(re.sub(r"/{2,}", "/", parts.path or "/"))
    query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    return urlunsplit((scheme, host, path, query, ""))


def _remove_dots(path: str) -> str:
    """RFC 3986 section 5.2.4 dot-segment removal."""
    out: list[str] = []
    for seg in path.split("/")[1:]:
        if seg == "..":
            if out:
                out.pop()
        elif seg != ".":
            out.append(seg)
    result = "/" + "/".join(out)
    if path.endswith(("/.", "/..")) and not result.endswith("/"):
        result += "/"
    return result


def host_key(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def same_site(a: str, b: str) -> bool:
    return host_key(a) == host_key(b)


@dataclass
class Extracted:
    title: Optional[str] = None
    text: str = ""
    markdown: str = ""
    links: list[str] = field(default_factory=list)
    assets: list[tuple[str, str]] = field(default_factory=list)


def extract(html: str | bytes, page_url: str) -> Extracted:
    soup = BeautifulSoup(html, PARSER)
    base = page_url
    base_tag = soup.find("base", href=True)
    if base_tag:
        b = normalize_url(base_tag["href"], page_url)
        if b:
            base = b

    title = None
    if soup.title and soup.title.string:
        title = " ".join(soup.title.string.split())[:300] or None

    links: list[str] = []
    for a in soup.find_all(["a", "area"], href=True):
        u = normalize_url(a["href"], base)
        if u and u not in links:
            links.append(u)

    assets: list[tuple[str, str]] = []
    seen_assets = set()

    def add_asset(kind: str, raw: Optional[str]) -> None:
        u = normalize_url(raw or "", base)
        if u and u not in seen_assets:
            seen_assets.add(u)
            assets.append((kind, u))

    for t in soup.find_all("img"):
        add_asset("image", t.get("src"))
    for t in soup.find_all("script", src=True):
        add_asset("script", t["src"])
    for t in soup.find_all("link", href=True):
        rel = " ".join(t.get("rel") or []).lower()
        if "stylesheet" in rel:
            add_asset("stylesheet", t["href"])
        elif "icon" in rel:
            add_asset("icon", t["href"])
    for t in soup.find_all(["video", "audio", "source", "track"]):
        add_asset("media", t.get("src"))

    for t in soup.find_all(DROP_TAGS):
        t.decompose()

    root = soup.find("main") or soup.find("article") or soup.body or soup
    markdown = _clean_md(_md(root, base))
    text = _plain_text(soup.body or soup)
    return Extracted(title=title, text=text, markdown=markdown, links=links, assets=assets)


def _plain_text(root) -> str:
    for t in root.find_all(_TEXT_BREAKS):
        t.insert_before("\n")
        t.insert_after("\n")
    lines = (" ".join(line.split()) for line in root.get_text("").splitlines())
    return "\n".join(line for line in lines if line)


# ---------------------------------------------------------------- Markdown

_TEXT_BREAKS = ["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "li", "tr",
                "br", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "figcaption", "table"]
_BLOCK = {"p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "figure", "dl", "address"}


def _inline(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def _md(node, base: str, list_depth: int = 0) -> str:
    if isinstance(node, NavigableString):
        if node.__class__.__name__ in ("Comment", "Doctype", "Declaration", "ProcessingInstruction"):
            return ""
        return _inline(str(node))
    if not isinstance(node, Tag):
        return ""
    name = node.name
    kids = lambda depth=list_depth: "".join(_md(c, base, depth) for c in node.children)  # noqa: E731

    if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
        inner = kids().strip()
        return f"\n\n{'#' * int(name[1])} {inner}\n\n" if inner else ""
    if name in _BLOCK:
        return f"\n\n{kids()}\n\n"
    if name == "br":
        return "  \n"
    if name == "hr":
        return "\n\n---\n\n"
    if name in ("strong", "b"):
        inner = kids().strip()
        return f"**{inner}**" if inner else ""
    if name in ("em", "i"):
        inner = kids().strip()
        return f"*{inner}*" if inner else ""
    if name == "code" and (node.parent is None or node.parent.name != "pre"):
        inner = node.get_text()
        return f"`{inner}`" if inner else ""
    if name == "pre":
        body = node.get_text().strip("\n")
        return f"\n\n```\n{body}\n```\n\n" if body else ""
    if name == "blockquote":
        inner = _clean_md(kids())
        return "\n\n" + "\n".join("> " + line for line in inner.splitlines()) + "\n\n"
    if name == "a":
        inner = kids().strip()
        href = normalize_url(node.get("href", ""), base)
        if not inner:
            return ""
        return f"[{inner}]({href})" if href else inner
    if name == "img":
        src = normalize_url(node.get("src", ""), base)
        alt = _inline(node.get("alt", "")).strip()
        return f"![{alt}]({src})" if src else ""
    if name in ("ul", "ol"):
        out = []
        for i, li in enumerate(node.find_all("li", recursive=False), 1):
            marker = f"{i}." if name == "ol" else "-"
            body = _clean_md("".join(_md(c, base, list_depth + 1) for c in li.children))
            lines = body.splitlines() or [""]
            pad = "  " * list_depth
            out.append(f"{pad}{marker} {lines[0]}")
            out.extend(f"{pad}  {line}" for line in lines[1:] if line.strip())
        return "\n\n" + "\n".join(out) + "\n\n"
    if name == "table":
        rows = []
        for tr in node.find_all("tr"):
            cells = [_inline(c.get_text(" ")).strip().replace("|", "\\|") for c in tr.find_all(["th", "td"])]
            if cells:
                rows.append(cells)
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
        lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
        return "\n\n" + "\n".join(lines) + "\n\n"
    if name in ("head", "title", "meta", "link", "base"):
        return ""
    return kids()


def _clean_md(md: str) -> str:
    """Tidy whitespace while keeping code fences, list indents and hard breaks."""
    out: list[str] = []
    fence = False
    for line in md.split("\n"):
        if line.strip().startswith("```"):
            fence = not fence
            out.append(line.strip())
            continue
        if fence:
            out.append(line.rstrip())
            continue
        hard_break = line.endswith("  ") and line.strip()
        s = line.rstrip()
        if len(s) - len(s.lstrip()) < 2:  # stray single space from inline text
            s = s.lstrip()
        if hard_break:
            s += "  "
        if not s.strip() and (not out or not out[-1].strip()):
            continue
        out.append(s if s.strip() else "")
    return "\n".join(out).strip()
