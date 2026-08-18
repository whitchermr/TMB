# Build status

Written so work can pause here and resume without re-deriving context.

**As of:** 18 Aug 2026. Everything in the build plan is implemented, the first
round of your feedback is in, and the whole suite passes. The site is published;
what is left is committing this round of changes.

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
| Walking starts Fri 2 Jul 2027, arrival day made explicit in the planner | done |
| Group seeded: David, Amanda, Jordan, Sarah, Seth, Kia | done |
| Miles and feet by default | done |
| A photograph of the view on all 32 scenery stops | done |
| Connect GitHub repo, enable Pages | done — live at <https://whitchermr.github.io/TMB/> |
| **Commit and push this round of changes** | **waiting on you** |

## Photographs

`tools/fetch_photos.py` sources one freely-licensed Wikimedia Commons photo per
scenery stop into `assets/photos/` (11.6 MB, 32 files), recording the
photographer and licence in `data/photos.json`. They show on `day.html`, in the
print brief, and are credited in full on `about.html`.

The picker is a best guess and five entries were corrected by hand after review —
see `PICKS` in the script and the notes in `docs/data-notes.md`. Worth a look
before the trip: run `tools/photo_contact_sheet.py` and open
`docs/photo-review.html` to check all 32 at a glance. If any photo is not the view
you had in mind, say which and it is a one-line change.

## Published, but this round is not pushed

`origin` is `git@github.com:whitchermr/TMB.git` and the first commit is on
`main`, so the site is live and serving correctly from the `/TMB/` subpath —
pages, modules, leg JSON, the service worker and the manifest all return 200 with
the right content types.

This round of changes is **uncommitted**: the 2027 dates, the group, miles and
feet, and the 32 photographs. `assets/photos/lac-blanc.jpg` returns 404 on the
live site for exactly that reason. Say the word and I will commit and push.

The bulk of this folder is the `Generalized Product Development Processes` kit,
which is gitignored. The site is about 15 MB, most of it the photographs.

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

## The date field

`settings.trip.startDate` dates the *arrival* day, because it dates the first
entry in `itinerary.json` and that entry is the flight in — not the first day of
walking. The two are one apart, and that gap has now been set the wrong way in
both directions during the build.

You want to be walking on **Fri 2 July 2027**, so it is seeded `2027-07-01`:
arrive Thu 1 July, walk from Fri 2 July, rest in Courmayeur Mon 5 July, finish
Fri 9 July.

Rather than only documenting the distinction, it is defended twice.
`plan.html` prints "Hiking day 1 is Fri Jul 2" under the date input, so the
ambiguity is visible where it would be introduced, and `tools/test/run-tests.js`
asserts the first walking day as a literal date.

## Open questions for you

1. **Commit and push?** Everything is ready; I have not committed on your behalf.
2. **Pace default.** 4.0 km/h flat with Naismith puts day 1 (10.6 mi, +3,156 ft)
   at 7h 37m including breaks, which is slower than most guidebooks for that
   stage. The slider on `plan.html` covers 3–5 km/h; tell me if the default
   should move.
3. **Day count.** Seeded as 7 hiking days plus the Courmayeur rest day, per your
   table. Your chat notes said "7 days, with 6 days of hiking" — see
   `docs/data-notes.md` for the two other places the plan and the trail geometry
   disagree.
4. **Any photo that is not the view you meant.** Open `docs/photo-review.html`
   and name it; swapping one is a single line.
