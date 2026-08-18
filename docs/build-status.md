# Build status

Written so work can pause here and resume without re-deriving context.

**As of:** 18 Aug 2026. Everything in the build plan is implemented and passing
its checks. One task remains and it needs you: connecting the GitHub repo.

## Where things stand

| Plan task | State |
| --- | --- |
| Prerequisites, repo scaffold, dev-rules footprint | done |
| Route pipeline: fetch, split into legs, elevation | done |
| Data model and seeded JSON | done |
| localStorage draft layer, export/import | done |
| Leaflet map module, canvas elevation chart | done |
| `index.html`, `day.html` | done |
| Scenery waypoints with light guidance | done |
| Scheduling: dates, rest days, pace models, sun times | done |
| `stays.html`, `money.html` | done |
| Print brief, offline service worker, icons, manifest | done |
| **Connect GitHub repo and enable Pages** | **blocked — needs the repo URL** |

## Nothing is committed yet

The repository is initialised on `main` with 96 files staged and **no commits**.
That was deliberate: the plan's last step is to connect your empty GitHub repo,
and I do not have its URL. Resuming needs one thing from you:

```
git@github.com:<user>/<repo>.git      (or the https:// form)
```

With that, the remaining work is: commit, add the remote, push, set Pages to
`main` / `/ (root)`, then load the published URL and confirm the site works on a
phone.

The 249 MB in this folder is the `Generalized Product Development Processes`
kit, which is gitignored. The site itself is about 3 MB.

## How to inspect it now

```bash
cd ~/Documents/TMB
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Worth a look, in rough order of interest:

- `index.html` — the loop on a topo map, trip totals, whole-trip profile. Drag
  across the profile; the marker follows on the map.
- `day.html?d=day-02` — the biggest climb. Check the scenery list and the
  estimated arrival times.
- `plan.html` — move the pace slider and the start date and watch every day
  re-time. Dates should read Jul 3–10 for hiking with a rest day on Jul 6.
- `print.html` — the paper brief. Use your browser's print preview: one page per
  hiking day.
- `about.html` — sources, accuracy, and the offline-maps panel. `localhost`
  counts as a secure origin, so the panel should be live and offer to download
  tiles. Reaching the same server by its LAN address instead will correctly
  report that offline caching needs https.

To run every check:

```bash
./tools/test.sh
```

To see what a single page actually rendered, without a browser:

```bash
jsc -m tools/test/page_smoke.js -- print --dump brief
```

## What is verified, and how

`./tools/test.sh` runs six layers and currently passes all of them:

| Layer | Coverage |
| --- | --- |
| Syntax | every JS file parses as a module; `sw.js` as a classic script |
| Static cross-checks | 31 checks: element ids exist, imports resolve to real exports, pages load their module/styles/viewport |
| Paths and case | 115 local references resolve with exact case; no root-absolute paths |
| Served site | 60 requests return 200 from a `/TMB/` subpath, with correct content types |
| Logic | 187 assertions against the real generated data |
| Page rendering | 88 assertions across 8 page scenarios |

The last layer is the one worth knowing about. There is no usable headless
browser on this machine — headless Brave hangs on crash-reporter setup no matter
which flags it gets — so `tools/test/dom.js` implements a DOM small enough to run
the real page controllers under JavaScriptCore: an HTML parser, an element tree,
a subset of CSS selectors, and stubs for canvas, Leaflet and `fetch`. Each page
passes only if nothing threw, nothing logged an error, no load-error notice
appeared, and the containers it should fill hold the expected content — for
example the brief must contain "Day 1" through "Day 7" and seven elevation
profiles.

That is a real runtime check, but it is not a browser. Layout, tile loading,
touch behaviour and print pagination still need your eyes.

## One bug found and fixed

`settings.trip.startDate` was seeded as `2026-07-03`. Because that field dates
the *arrival* day — the first entry in `itinerary.json` — every hiking day was
landing one day later than your table: day 1 on Jul 4, the rest day on Jul 7.

It is now `2026-07-02`, which puts hiking day 1 on Jul 3 and the Courmayeur rest
day on Jul 6. Two assertions in `tools/test/run-tests.js` pin both the
relationship and the literal dates, and `docs/data-notes.md` records the
semantics so the same slip cannot return quietly.

## Open questions for you

1. **Repo URL** — needed to finish the last task.
2. **Pace default.** 4.0 km/h flat with Naismith puts day 1 (17.1 km, +962 m) at
   7h 37m including breaks, which is slower than most guidebooks for that stage.
   The slider on `plan.html` covers 3–5 km/h; tell me if the default should move.
3. **Day count.** Seeded as 7 hiking days plus the Courmayeur rest day, per your
   table. Your chat notes said "7 days, with 6 days of hiking" — see
   `docs/data-notes.md` for the two other places the plan and the trail geometry
   disagree.
