# Project conventions

Read this before changing anything. It captures the decisions that are easy to
break by accident.

## Constraints that are not negotiable

- **No build step.** Vanilla ES modules loaded directly by the browser. No npm,
  no bundler, no transpiler. If something seems to need a build step, it does not
  belong here.
- **No server, no database.** The site is static files on GitHub Pages. Committed
  JSON under `data/` is the shared source of truth.
- **No CDN dependencies at runtime.** Leaflet is bundled in `assets/vendor/` so
  the site keeps working in an Alpine valley with no signal. Map tiles are the
  one unavoidable network dependency.
- **Mobile first.** Most people will read this on a phone on a trail. Single
  column by default, 44 px touch targets, and nothing important behind a hover.

## Coordinates and units

- Coordinates are **`[longitude, latitude]`** (GeoJSON order) everywhere except
  at the Leaflet boundary, which wants `[lat, lon]`. The flip happens only in
  `assets/js/ui/map.js`. Do not let Leaflet's order leak outward.
- Distances are **metres** and elevations are **metres** in all data and logic.
  Conversion to miles or feet happens only at render time, in
  `assets/js/core/units.js`.
- `assets/js/core/geo.js` mirrors `tools/tmblib.py`. If you change a formula in
  one, change it in the other — a test asserts they agree to within 5 m over the
  full 166 km loop.

## Data rules

- **Nothing is stored that can be derived.** Dates are computed by walking the
  itinerary from `settings.trip.startDate`, so a rest day can be inserted without
  editing seven dates. A waypoint's distance into the day is computed by
  projecting it onto the track, so adding one only needs a coordinate. Resist
  adding a field that duplicates something computable.
- **`startDate` is the arrival day**, not the first day of walking, because it
 dates the first entry in `itinerary.json` and that entry is the flight in.
 Hiking day 1 is the day after. Getting this wrong shifts the whole trip by a
 day silently; `run-tests.js` asserts both the relationship and the first walking
 day as a literal, since that date is the group's decision rather than something
 derived.
- **Distances default to miles and elevations to feet.** `units` in
 `settings.json` is the group default; the header toggle overrides it per device.
 Data and logic stay metric regardless.
- **Lodging lives in `stays.json` only.** `money.js` projects booked stays into
  the ledger as derived expenses. Never enter a hotel as a manual expense too.
- **Only paid money creates debt.** `balances()` ignores expenses with no
  `paidBy`, because an unpaid estimate is a forecast, not a debt — including them
  would invent money owed to nobody and balances would stop summing to zero. Use
  `forecast()` for the budget view that does count estimates.
- **Route data under `data/route/` is generated.** Edit
 `data/route/route-plan.json` and re-run the pipeline; never hand-edit a leg
 file.
- **`data/photos.json` is generated too.** `tools/fetch_photos.py` owns it. To
 change a photo, pin its Commons title in that script's `PICKS` table and re-run
 with `--only <waypointId> --force`; do not edit the JSON.
- **A waypoint photo may not be rendered without its credit.** These images are
 used under CC BY and CC BY-SA, where naming the photographer is a condition of
 use rather than a nicety. Go through `assets/js/ui/photo.js`, which emits the
 image and the credit together, instead of writing an `<img>` for them.
- **`data/route/raw/`, `data/route/cache/` and `tools/cache/` are gitignored.**
 They are regenerable and large.

## Reading and writing data

Always go through `assets/js/core/store.js`. It layers localStorage drafts over
the committed files, so a page never needs to know which it is looking at.

```js
const settings = store.get('settings');           // draft if present, else committed
store.update('settings', (data) => {              // receives a deep clone
  data.pace.flatSpeedKmh = 4.5;
});
```

`update()` diffs against the committed file and drops the draft when a value is
edited back to its original, so the unsaved badge never lies.

### Shared edits

`data/packing.json` works differently, and it is the pattern the other files are
meant to move to. Nothing writes it from a browser. An edit becomes an
**operation** appended to a log through `assets/js/core/sync.js`, and the current
state is `reduce(committed file, log)`:

```js
sync.init('packing');                                  // load the cached log
const current = sync.view('packing');                  // committed + log + outbox
sync.upsert('packing', 'items', { id, name, ... });    // add or replace a record
sync.remove('packing', 'items', id);                   // hide a record
```

Things to know before touching it:

- **Operations, not files, because operations compose.** Two people saving a whole
 file means the second write is rejected for a stale revision and whoever retries
 last erases the other's work. Two operations on different records both survive.
- **An upsert replaces the whole record.** Two people editing one record at the
 same time means the later save wins outright. That is deliberate; per-field
 merging would be far harder to reason about for no benefit here.
- **A removal is an operation, not a deletion.** The item stays in the committed
 file, which is what lets the page offer it back under "Removed from the default
 list". Never fix a removal by editing the record out of `packing.json`.
- **`COLLECTIONS` exists twice on purpose** — in `sync.js` and in
 `tools/sync-worker/worker.js`, which cannot import from the site. Extending the
 pattern to a new file means editing both, and `run-tests.js` asserts they agree,
 because drift shows up as a save the page accepts and the Worker silently
 rejects.
- **Device-local state is not a shared edit.** Who you are (`pref('me')`) and what
 you have ticked off both live in preferences. Six people ticking the same shared
 boxes would tell the group nothing, and a tick must never cost a commit.
- **The log lives on an unpublished branch, and publishing is debounced for a
 different reason.** Pages throttles rebuilds at around ten an hour, which is why
 the log is committed to `sync` rather than `main` — a commit there triggers no
 deploy at all. The debounce in `queue()` is a smaller, separate thing: it folds
 operations made together into one commit, keeping the log readable and saving
 round trips. It is deliberately short, because an operation still inside the
 window when a tab closes waits for that person's next visit; `visibilitychange`
 publishes on the way out to narrow that gap. Do not add a code path that commits
 per keystroke.

`docs/sync-setup.md` covers the deployment side. `tools/squash_sync.py` folds a
long log back into the committed file, using the site's own reducer through
`tools/reduce_log.js` rather than a second implementation of the same rules.

## Accuracy expectations

The numbers on this site are checked, not decorative. Before changing anything in
the pipeline or the timing model, read `docs/data-notes.md` — it records the
calibration against surveyed col heights (mean absolute error 3.7 m) and the two
places where the group's original plan and the trail geometry genuinely disagree.

Two specific traps:

- **Never sum raw positive elevation deltas** to get ascent. DEM noise over
  thousands of points inflates it by hundreds of metres. `gain_loss()` smooths
  first and then requires a run to exceed 5 m before counting it.
- **Never measure distance on the simplified track.** The rendered geometry is
  thinned to ~25 m spacing, which cuts corners off switchbacks and loses about 1%
  of length. Distances come from the full-resolution geometry sampled at the kept
  vertices. A test asserts the simplified line measures shorter, so removing this
  will fail loudly.

## Testing

Run `./tools/test.sh` before committing. It needs nothing installed — JavaScript
runs under macOS's built-in JavaScriptCore and the static checks use Python 3.

When adding logic to `core/`, add assertions to `tools/test/run-tests.js`. Prefer
tests that would catch a real regression ("balances sum to zero", "arrival times
never go backwards") over tests that restate the implementation.

When adding or renaming a page, register it everywhere below. Miss one and the
checks quietly stop covering it, which is worse than a failure:

| Where | What |
|---|---|
| `PAGES` in `assets/js/ui/nav.js` | the header link |
| `SHELL` in `sw.js` | so the page works offline |
| `PAGE_MODULES` in `tools/test/static_check.py` | element-id and import checks |
| `PAGES` in `tools/test/page_smoke.js` | actually runs the controller |
| the page loop in `tools/test.sh` | runs that smoke test |
| `PATHS` in `tools/test/serve_check.sh` | serves it from a Pages subpath |

A new shared module goes in `SHARED_MODULES` in `static_check.py`, `SHELL` in
`sw.js`, and `PATHS` in `serve_check.sh`. A new data file goes in `FILES` in
`store.js`, `DATA` in `sw.js`, the name list at the end of
`tools/test/check_paths.py`, and `PATHS` in `serve_check.sh`. Bump `VERSION` in
`sw.js` when `SHELL` changes, or devices keep serving the old shell from cache.

There is no usable headless browser on this machine, so `tools/test/dom.js`
provides a DOM small enough to run the real page controllers under
JavaScriptCore. It is a shim, not an emulator: it implements the APIs this code
actually uses. If a page starts using something new, add it there rather than
working around its absence in the page.

## Style

- Comments explain *why*, or a constraint the code cannot show. Do not narrate
  what the next line does.
- Prefer clear names over short ones. `flatSpeedKmh`, not `spd`.
- Keep page controllers thin: computation belongs in `core/`, rendering in the
  page, reusable widgets in `ui/`.
- Escape anything user-entered before putting it in `innerHTML`. Use
  `escapeHtml()` from `ui/map.js`.
