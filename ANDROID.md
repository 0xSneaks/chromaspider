# Chromaspider on Android (Termux)

> **Status: NOT VERIFIED on a real Android device.** These steps were written
> for Termux and the install was tested on Linux in a clean virtualenv without
> `lxml`, which matches the Termux setup below. Please open an issue with
> your results.

The HTTP crawler, API and web UI are pure Python except for one compiled
dependency, `pydantic-core` (required by FastAPI/pydantic). PyPI has no
Android wheel for it (checked for pydantic-core 2.46.5), so on Termux pip
will most likely build it from source, which needs Rust. Everything else is
pure Python. `lxml` is optional and **not** installed by default; Chromaspider
falls back to Python's built-in `html.parser`.

## 1. Install Termux

Install Termux from **F-Droid** or the official GitHub releases. The Play
Store build is outdated.

## 2. Install

```sh
pkg update
pkg install python git rust
git clone https://github.com/0xSneaks/chromaspider
cd chromaspider
pip install -e .
```

The first `pip install` may take several minutes while it compiles
`pydantic-core`. That is normal.

## 3. Run

```sh
chromaspider doctor     # shows termux: True, parser, browser backends
chromaspider serve
```

Then open **http://127.0.0.1:8788** in Chrome on the same phone.

Keep Termux in the foreground, or run `termux-wake-lock` first so Android
does not suspend the server. Stop it with `Ctrl+C`.

CLI crawl straight from Termux:

```sh
chromaspider crawl https://example.com --depth 1 --max-pages 10 --output markdown --out example.md
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `error: can't find Rust compiler` while installing | `pkg install rust`, then rerun `pip install -e .` |
| `Failed to determine Android API level` (maturin) | `export ANDROID_API_LEVEL=$(getprop ro.build.version.sdk)` then rerun |
| linker errors while building | `pkg install binutils` then rerun |
| `chromaspider: command not found` | `python -m chromaspider serve` |
| page does not load in Chrome | make sure the URL is `http://127.0.0.1:8788` (not https) and Termux is still running |
| port in use | `chromaspider serve --port 8790` |

Optional, faster HTML parsing: `pkg install libxml2 libxslt` then
`pip install lxml`. If it fails, skip it; nothing depends on it.

## Optional: JavaScript rendering (experimental)

Not needed for normal crawling. If you install Chromium in Termux (for
example `pkg install x11-repo && pkg install chromium`, if your Termux
repos provide it), Chromaspider detects it and can use
`chromium --headless --dump-dom`. Select **Rendering → Browser** in the UI
or pass `--render browser`.

* This path is **experimental and untested on Android**.
* For safety, Chromium may only resolve the page's own host, pinned to the IP
  Chromaspider already vetted. Third-party scripts and CDNs will not load, so
  some sites will render incompletely.
* If Chromium is missing, crashes, times out or shows an error page, the page
  is crawled over plain HTTP and marked `render_mode: "http"` with a
  `render_note` explaining why. A crawl never fails because of this.

Point at a specific binary with `export CHROMASPIDER_CHROMIUM=/path/to/chromium`.
