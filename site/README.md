# Chromaspider live demo (GitHub Pages)

This folder builds the static demo at
**https://0xsneaks.github.io/chromaspider/**.

The demo runs the **real Chromaspider web UI**, including the spider CRAWL
view, the GRAPH tab, the page inspector and the copy/download buttons. It
**replays a recorded crawl**. Nothing is crawled from the demo page: GitHub
Pages only hosts static files, and the crawler is a Python server that runs
on your own machine.

To crawl real sites, install Chromaspider instead. See
[Quick start](../README.md#-quick-start).

## What the demo shows

- **A recorded crawl** of `https://docs.chromaspider.test/`. This is an
  offline mock site whose pages are sections of this repo's own `README.md`,
  `SECURITY.md` and `ANDROID.md`.
- **22 pages at depth 2.** 21 are `ok`, and one dead link returns 404, so the
  red "failed" color appears too.
- **A replay that starts on page load.** Pages go queued → crawling → done
  with 4 crawling at a time, like the crawler's default concurrency. Press
  **REPLAY** to run it again.
- **A locked form.** The URL and the depth, page-limit, domain and rendering
  settings can't be edited, because they don't affect the replay.

The page content is genuine crawler output: `make_demo.py` produced it by
running the real crawler and API. The replay timing is simulated (see below).

## Files

| File | Purpose |
| --- | --- |
| `build.py` | Builds the site into a folder. Standard library only. |
| `demo.js` | Answers the UI's `/api/*` calls from the recording and replays it. |
| `demo.css` | Styles for the demo banner and install notes. |
| `demo-crawl.json` | The recorded crawl: crawl record, graph, every page and the Markdown export. |
| `make_demo.py` | Re-records `demo-crawl.json`. |

The workflow that publishes the site is `../.github/workflows/pages.yml`.

## How it works

### Build (`build.py`)

1. Copies `chromaspider/static/` (`app.js`, `viz.js`, `wall.js`,
   `styles.css`) **unchanged**, so the demo always runs the current UI code.
2. Edits a copy of `index.html`:
   - Rewrites `/static/...` paths to relative ones, because Pages serves the
     site under `/chromaspider/`.
   - Loads `demo.js` before the app scripts.
   - Adds the demo banner, a "Run it yourself" install section and
     `demo.css`.
   - Adds a `Content-Security-Policy` meta tag. It uses the same policy the
     real server sends, minus `frame-ancestors`, which browsers ignore in a
     meta tag.
3. Copies `demo.js`, `demo.css` and `demo-crawl.json`, and writes
   `.nojekyll`.

Each `index.html` edit looks for an exact piece of markup. If the UI's
markup changes and an edit no longer matches, the build stops with an error
instead of shipping a broken page.

### Replay (`demo.js`)

- **API calls:** `demo.js` replaces `window.fetch` for paths containing
  `/api/` and answers them from `demo-crawl.json`:

  | Request | Demo response |
  | --- | --- |
  | `POST /api/crawl` | a new random crawl id; starts the replay clock |
  | `GET /api/crawls/{id}/graph` | the graph as it would look that many ms into the replay |
  | `GET /api/crawls/{id}/pages/{n}` | the recorded page |
  | `GET /api/crawls/{id}/export?format=markdown\|json` | the recorded export |
  | `GET /api/crawls/{id}` | the recorded crawl record |

  Any other request goes to the network normally. In practice the only one
  is `demo-crawl.json` itself.
- **Timeline:** `schedule()` gives every page a discovery, start and end time.
  A page is discovered when its parent finishes, and 4 workers take pages in
  discovery order. Each page "takes" a fixed, made-up 260–620 ms.
  `snapshotAt()` turns that into the graph for any moment of the replay.
- **Downloads:** the DOWNLOAD JSON and DOWNLOAD MARKDOWN links are served
  from the recording as file downloads.
- **Fresh runs:** each REPLAY gets a new crawl id, so the CRAWL and GRAPH
  views start over cleanly.

## Run the demo locally

```sh
python site/build.py _site
cd _site && python -m http.server 8000
```

Open http://127.0.0.1:8000/. `_site/` is git-ignored.

## Re-record the demo crawl

Do this after changing the docs or anything that affects crawler output:

```sh
pip install -e .[test]
python site/make_demo.py      # rewrites site/demo-crawl.json
```

It runs offline. A mock transport serves the pages, and DNS resolution is
stubbed, so no real site is contacted.

## Publishing

`.github/workflows/pages.yml` runs on every push to `main` and can also be
started by hand from the Actions tab. It builds `_site` with Python 3.12 and
deploys it with GitHub's official Pages actions.

**One-time setup:** go to **Settings → Pages → Build and deployment → Source**
and choose **GitHub Actions**. Until then the workflow's deploy step fails and
the demo URL returns 404.

## Vercel

The same demo can also be hosted on Vercel. `../vercel.json` builds it with
`python3 site/build.py _site` and publishes `_site`. It also sends the same
security headers as the real server: `Content-Security-Policy` (this time
including `frame-ancestors`), `X-Content-Type-Options` and `Referrer-Policy`.
A test keeps those headers identical to the server's.

If the Vercel project is connected to this GitHub repo, every push gets a
preview deployment and every push to `main` updates production. GitHub Pages
and Vercel can both host the demo at the same time.

## Tests

```sh
pytest tests/test_site.py               # build output, script order, CSP, recording consistency
node --test tests/js/demo.test.js       # replay timeline: ordering, concurrency, snapshots
```

`pytest` also runs the Node tests automatically through
`tests/test_ui_viz.py` when Node is installed.
