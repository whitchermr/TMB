# Tour du Mont Blanc trip planner

A static, mobile-first site for planning our TMB hike: the real trail traced on a
topographic map, per-day elevation profiles, photography waypoints with light
timing, pace-driven schedules, lodging options, and Splitwise-style settle-up.

No build step, no framework, no database. Vanilla ES modules, Leaflet bundled
locally, and all trip data in committed JSON files.

## Running it locally

Browsers refuse `fetch` on `file://` URLs, so the folder has to be served over
http rather than opened directly:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

### If `python3` or `git` refuse to run

On this machine the `/usr/bin` shims abort with *"You have not agreed to the
Xcode license agreements."* The permanent fix is one command:

```bash
sudo xcodebuild -license accept
```

Until then, the real binaries inside Xcode work fine and every script here falls
back to them automatically. To get a working shell by hand:

```bash
export PATH="/Applications/Xcode.app/Contents/Developer/usr/bin:$PATH"
```

## Layout

```
index.html            Full loop, trip totals, whole-trip elevation profile
day.html?d=day-03     Per-day detail: map, profile, segments, light, scenery
plan.html             Start date, rest days, pace model, per-day timings
stays.html            Lodging candidates and booked choices
money.html            Expenses, balances, settle-up
packing.html          Shared packing list, ticked off per person
transit.html          Getting to, off and between trail stops by bus and train
print.html            Printable trail brief, and a one-file data export
about.html            Data sources, accuracy, attribution, offline downloads

sw.js                 Service worker: offline app shell, data and map tiles
manifest.webmanifest  Home-screen install metadata

assets/css/           base.css (tokens, layout), components.css, print.css
assets/js/core/       store, sync, units, geo, sun, schedule, money, transit
assets/js/ui/         nav (shared header), map (Leaflet), elevation (canvas
                      chart), offline (service worker + tile prefetch)
assets/js/pages/      One controller per page
assets/vendor/        Leaflet 1.9.4, bundled so the site works offline
assets/icons/         App icon, as SVG plus rasterised PNGs

data/                 Trip data — edited through the UI, committed as JSON
data/route/           Generated trail geometry, legs and elevation
data/photos.json      Generated: one photo per scenery stop, with attribution
data/transit-schedules.json  Generated: published times where a GTFS feed exists
assets/photos/        The photographs themselves, stored for offline use
docs/data-notes.md    Provenance, calibration, and known discrepancies
docs/sync-setup.md    How shared editing works, and how to switch it on
docs/transit-notes.md Feed coverage, confidence levels, pre-travel checklist
docs/photo-review.html  Generated contact sheet for checking the photos by eye
tools/                Data pipeline and tests
tools/sync-worker/    The Cloudflare Worker that appends shared edits
```

## Dates

`data/settings.json` holds one date, `trip.startDate`, and every other date is
derived from it. It is the **arrival day** — the first entry in
`data/itinerary.json` — not the first day of walking.

We start walking on **Fri 2 July 2027**, so the seeded value is `2027-07-01`.
That puts the Courmayeur rest day on Mon 5 July and the last hiking day on
Fri 9 July.

Because that one-day distinction is easy to lose, the planner prints "Hiking day 1
is Fri Jul 2" directly beneath the date field.

Nothing else stores a date, so moving the start or inserting a rest day reflows
the entire trip, sun times included.

## Units

Distances default to **miles** and elevations to **feet**, from `units` in
`data/settings.json`. All stored data and every calculation stay in metres —
conversion happens only at render time in `assets/js/core/units.js` — so the
toggle in the header switches the whole site without touching the data. That
toggle is a per-device preference and overrides the committed default.

## Photographs

Every scenery stop shows a photograph of the view, sourced from Wikimedia Commons
and stored in `assets/photos/` so it works offline. Regenerate or extend the set
with:

```bash
tools/fetch_photos.py                    # fill in anything missing
tools/fetch_photos.py --only lac-blanc --force    # re-pick one
tools/photo_contact_sheet.py             # writes docs/photo-review.html
```

The picker is a best guess and is meant to be reviewed: open
`docs/photo-review.html`, and to replace a photo add its Commons title to `PICKS`
in `tools/fetch_photos.py` and re-run with `--only … --force`.

Only public domain, CC0, CC BY and CC BY-SA files are accepted, and the
photographer and licence are shown wherever a photo appears — that is a condition
of the licence, which is why `assets/js/ui/photo.js` renders the image and the
credit together and nothing else builds an `<img>` for these. `docs/data-notes.md`
explains how candidates are scored and why.

## On the trail

The site installs a service worker on first visit, so the pages, the trip data
and the trail geometry all work with no signal. Map tiles are the exception,
because they are fetched from third-party servers as you pan — so download them
deliberately from **About → Offline maps** while you still have wifi. That
enumerates the tiles along a corridor following the route (not a bounding box
over the whole massif) and fetches them a few at a time, which keeps well inside
what the community tile servers ask of clients.

`print.html` renders a paper brief: one page per hiking day with the profile,
the timings, the scenery stops and that night's lodging. Worth printing as a
backup for a flat battery. The same page exports every data file as a single
JSON download for backup or handover.

## Editing trip data

There are two mechanisms, and which one a page uses is the difference between an
edit only you can publish and an edit everyone sees.

**Drafts and export** — the planner, days, stays and money pages. Edits are held
in your browser's local storage and an **unsaved** badge appears in the header.
Open that badge to copy the exact file content, then commit it over the matching
file in `data/`. Teammates can pull the change, or use **Import** to load a file
someone sent them. Drafts are per-browser and per-device; clearing site data
discards them.

**Shared edits** — the packing page. Saving appends a small operation to a log
that everyone reads, so a change is visible to the group in about a second with
no copying and no commit. There is still no server: a Cloudflare Worker holds the
GitHub token and the browser only ever talks to that. Sharing is off until an
endpoint is configured, and it degrades to the same device-local behaviour with
no signal. [docs/sync-setup.md](docs/sync-setup.md) explains the design and how
to switch it on.

The packing page is the pilot for that mechanism. The intent is to move the other
pages onto it once it has proved itself, at which point the export flow becomes
the fallback rather than the norm.

## Regenerating route data

Only needed if the route definition changes — the committed output under
`data/route/` is what the site reads.

```bash
./tools/run-pipeline.sh            # full run
./tools/run-pipeline.sh --offline  # reuse the cached Overpass payload
```

Three stages:

1. **`fetch_route.py`** pulls OSM relation
   [9678362](https://www.openstreetmap.org/relation/9678362) and seven variant
   relations from Overpass, stitches the member ways into continuous lines, and
   verifies the main route closes. It currently comes back as a single ring of
   736 ways, 16,999 points, 166.01 km — no manual repair needed.

2. **`split_legs.py`** reads `data/route/route-plan.json`, works out which
   direction the loop runs by checking whether the stage stops appear in
   itinerary order, then cuts one file per day and variant. Each day is composed
   declaratively from `hike` segments (slices of the main loop, or a whole
   variant relation) and `transit` segments (bus, navette, lift) that carry
   distance but are excluded from walking totals.

   Run with `--diagnose` to check anchor placement without writing anything.

3. **`fetch_elevation.py`** samples elevation for every track point through
   three providers in accuracy order — IGN RGE ALTI at 1 m for France and a
   strip across both borders, swisstopo swissALTI3D at 2 m for Switzerland, and
   OpenTopoData SRTM as the fallback. Results are cached by coordinate in
   `data/route/cache/`, so re-runs cost nothing and days whose variants share
   geometry are only fetched once.

   Use `--only-cached` to recompute statistics with no network calls.

To change the route, edit `data/route/route-plan.json` and re-run stages 2 and 3.
Adding an anchor only needs an approximate coordinate; it gets projected onto the
trail, and the script reports how far off it was so a mistake is obvious.

## Refreshing the timetables

Separate from the route pipeline, because the transit page works without it.

```bash
python3 tools/fetch_transit.py --date 2027-07-14
```

Every service in `data/transit.json` is hand-recorded from an operator's own
timetable, so the page is complete on its own. This tool overlays published times
from the two open GTFS feeds that exist for the corridor — the Swiss 2027
timetable, which is already the right year, and Chamonix Mobilité, which
republishes each summer. It only overwrites the stops a feed covers, so a line the
feed follows halfway does not lose its far end.

Raw zips are cached in `tools/cache/gtfs/` and gitignored; the Swiss feed is
58 MB. The extract it writes to `data/transit-schedules.json` is about 5 KB.
[docs/transit-notes.md](docs/transit-notes.md) records what each feed covers, what
it does not, and what has to be re-checked before travel.

## Tests

```bash
./tools/test.sh
```

Six layers, all using tools that ship with macOS — no Node, no npm, nothing to
install:

- **Syntax check** of every JavaScript file via JavaScriptCore's
  `checkModuleSyntax`, which parses without executing. `sw.js` gets the plain
  `checkSyntax` because a service worker is a classic script, not a module.
- **Static cross-checks** (`tools/test/static_check.py`) confirming every element
  id a page reaches for actually exists, every import resolves to a real export,
  and every page loads its module, styles and viewport tag.
- **Path and case check** (`tools/test/check_paths.py`) resolving every local
  reference in the HTML, CSS and JS. It is case-sensitive on purpose: macOS is
  not, so `assets/CSS/base.css` would work locally and 404 only once published.
  It also rejects root-absolute paths, which break under a Pages project
  subpath. Module specifiers are resolved against the file, `fetch()` calls
  against the document, matching what browsers do.
- **Photo and credit check** (`tools/test/check_photos.py`) confirming every
  photograph is on disk at the recorded size and carries a photographer and a
  redistributable licence. That last part is not cosmetic: attribution is a term
  of the CC BY and CC BY-SA licences these files are used under, so an empty
  credit fails the build.
- **Served-site check** (`tools/test/serve_check.sh`) serving the repo from a
  `/TMB/` subdirectory — the way a GitHub Pages project site is served — and
  requesting every page, asset and data file, asserting 200s and correct content
  types for modules and JSON.
- **Logic tests** (`tools/test/run-tests.js`) exercising the geometry,
  scheduling, solar, money, sync and transit modules against the real generated
  data — 312 assertions covering things like "balances always sum to zero", "elapsed time
  never goes backwards along a day", "the later shared edit wins whichever order
  the operations arrive in", and "the JS and Python distance implementations
  agree to within 5 m over 166 km".
- **Page smoke tests** (`tools/test/page_smoke.js`) actually *running* each page
  controller. `tools/test/dom.js` is a small DOM — HTML parser, element tree,
  CSS selector subset, canvas and Leaflet stubs, `fetch` backed by the real files
  on disk — that is enough for the real page modules to execute unmodified. A
  page passes only if nothing threw, nothing was logged as an error, no
  load-error notice appeared, and the containers it should fill contain the
  expected content. Run one page on its own, and dump what it rendered, with:

  ```bash
  jsc -m tools/test/page_smoke.js -- print --dump brief
  ```

`tools/smoke-test.sh` loads the pages in a real headless Chromium-family browser
instead. It does not work on this machine — headless Brave hangs on crash-reporter
setup regardless of flags, which is why the DOM shim above exists — so treat it as
a convenience for other environments rather than part of the normal loop.

## Deploying to GitHub Pages

All paths are relative and `.nojekyll` is present, so the repository works as-is
from a project page at `https://<user>.github.io/<repo>/`. `./tools/test.sh`
verifies that from a subpath before you push.

```bash
git add -A
git commit -m "TMB trip planner"
git remote add origin git@github.com:<user>/<repo>.git
git push -u origin main
```

Then in the repository settings, under **Pages**, set the source to the `main`
branch at `/ (root)`.

Two things only work on the published site, not over plain http on a LAN
address, because both require a secure context: the service worker (so offline
caching and home-screen install) and the clipboard button in the export dialog,
which falls back to a hidden textarea. `localhost` counts as secure, so local
development is unaffected.

## Conventions

See [AGENTS.md](AGENTS.md).
