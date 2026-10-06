from chromaspider.extract import extract, normalize_url, same_site


def test_normalize_basic():
    assert normalize_url("HTTPS://Example.COM:443/a/../b/?z=1&a=2#frag") == "https://example.com/b/?a=2&z=1"
    assert normalize_url("http://example.com:80") == "http://example.com/"
    assert normalize_url("http://example.com:8080/x") == "http://example.com:8080/x"
    assert normalize_url("//cdn.example.com/x.js", "https://example.com/") == "https://cdn.example.com/x.js"
    assert normalize_url("page?b=1", "https://example.com/dir/index.html") == "https://example.com/dir/page?b=1"


def test_normalize_dot_segments():
    cases = {"https://e.com/a/..": "https://e.com/", "https://e.com/a/b/.": "https://e.com/a/b/",
             "https://e.com/../../x": "https://e.com/x", "https://e.com/a/./b": "https://e.com/a/b"}
    for raw, want in cases.items():
        assert normalize_url(raw) == want


def test_normalize_rejects_non_http():
    for bad in ["mailto:a@b.c", "javascript:alert(1)", "ftp://x.org/", "data:text/html,hi", "", "   ", "tel:123",
                "http://[::1"]:
        assert normalize_url(bad) is None


def test_normalize_idna_and_dupes():
    assert normalize_url("https://bücher.example/") == "https://xn--bcher-kva.example/"
    assert normalize_url("https://example.com//a///b") == normalize_url("https://example.com/a/b")


def test_same_site_ignores_www():
    assert same_site("https://www.example.com/a", "https://example.com/b")
    assert not same_site("https://evil.com/", "https://example.com/")


def test_markdown_extraction():
    html = """<html><head><title>T</title><script>alert('x')</script><style>p{}</style></head><body>
    <main><h1>Hello</h1><p>Some <b>bold</b> and <a href="/x">a link</a>.</p>
    <ul><li>one</li><li>two</li></ul><pre><code>x = 1
    y = 2</code></pre><blockquote>quoted</blockquote>
    <table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></main></body></html>"""
    ex = extract(html, "https://example.com/")
    assert ex.title == "T"
    md = ex.markdown
    assert md.startswith("# Hello")
    assert "Some **bold** and [a link](https://example.com/x)." in md
    assert "- one\n- two" in md
    assert "```\nx = 1\n    y = 2\n```" in md
    assert "> quoted" in md
    assert "| a | b |" in md and "| 1 | 2 |" in md
    assert "alert" not in md and "alert" not in ex.text
    assert ex.links == ["https://example.com/x"]


def test_links_assets_and_base():
    html = """<head><base href="https://static.example.com/root/"><link rel="stylesheet" href="s.css">
    <link rel="icon" href="/f.ico"><script src="app.js"></script></head>
    <body><a href="a">A</a><a href="a#x">dup</a><a href="mailto:x@y.z">m</a><img src="i.png"><video src="v.mp4"></video></body>"""
    ex = extract(html, "https://example.com/")
    assert ex.links == ["https://static.example.com/root/a"]
    kinds = dict((u, k) for k, u in ex.assets)
    assert kinds["https://static.example.com/root/s.css"] == "stylesheet"
    assert kinds["https://static.example.com/f.ico"] == "icon"
    assert kinds["https://static.example.com/root/app.js"] == "script"
    assert kinds["https://static.example.com/root/i.png"] == "image"
    assert kinds["https://static.example.com/root/v.mp4"] == "media"


def test_malformed_html_does_not_crash():
    for html in ["<html><body><p>unclosed <b>bold <a href='/x'>link", "<<<>>>", "", "\x00\xff garbage <div",
                 b"\xff\xfe<\x00h\x00", "<table><tr><td>a<td>b</table><ul><li>x"]:
        ex = extract(html, "https://example.com/")
        assert isinstance(ex.markdown, str)
    ex = extract("<p>unclosed <b>bold <a href='/x'>link", "https://example.com/")
    assert "https://example.com/x" in ex.links
    assert "link" in ex.text


def test_text_keeps_inline_flow():
    ex = extract("<body><p>Hello <b>bold</b> world.</p><p>Next</p></body>", "https://e.com/")
    assert ex.text == "Hello bold world.\nNext"
