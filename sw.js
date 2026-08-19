/*
 * Service worker: keep the whole planner usable with no signal.
 *
 * Large parts of the TMB have no coverage, and the Italian and Swiss roaming
 * situation makes data expensive even where there is. So the app shell and every
 * data file are precached on install, and map tiles are cached as they are
 * viewed — or deliberately downloaded ahead of time from the About page.
 *
 * Three strategies, chosen per resource type:
 *   shell  stale-while-revalidate — instant load, picks up new versions quietly
 *   data   network-first          — freshness matters, cache is the fallback
 *   tiles  cache-first + cap      — immutable, and the whole point of going offline
 *
 * Scope is whatever directory this file sits in, so it works unchanged at a
 * domain root or under a GitHub Pages project subpath like /TMB/.
 */

const VERSION = 'v6';
const SHELL_CACHE = `tmb-shell-${VERSION}`;
const DATA_CACHE = `tmb-data-${VERSION}`;
const TILE_CACHE = 'tmb-tiles'; // unversioned: tiles do not change with releases
// Also unversioned, and for the same reason: a waypoint photograph is replaced by
// re-running the pipeline, not by shipping a new version of the site.
const PHOTO_CACHE = 'tmb-photos';

// Tiles come back as opaque cross-origin responses, whose size is padded for
// quota accounting and cannot be read from script, so the cap is a tile count
// rather than a byte budget.
const TILE_LIMIT = 6000;

const TILE_HOSTS = [
  'tile.opentopomap.org',
  'a.tile.opentopomap.org',
  'b.tile.opentopomap.org',
  'c.tile.opentopomap.org',
  'server.arcgisonline.com',
  'wmts.geo.admin.ch',
  'tile.waymarkedtrails.org',
  'tile.openstreetmap.org',
];

const SHELL = [
  './',
  'index.html',
  'day.html',
  'plan.html',
  'stays.html',
  'money.html',
  'packing.html',
  'transit.html',
  'about.html',
  'print.html',
  'manifest.webmanifest',
  'assets/css/base.css',
  'assets/css/components.css',
  'assets/css/print.css',
  'assets/vendor/leaflet/leaflet.css',
  'assets/vendor/leaflet/leaflet.js',
  'assets/vendor/leaflet/images/marker-icon.png',
  'assets/vendor/leaflet/images/marker-icon-2x.png',
  'assets/vendor/leaflet/images/marker-shadow.png',
  'assets/vendor/leaflet/images/layers.png',
  'assets/vendor/leaflet/images/layers-2x.png',
  'assets/js/core/store.js',
  'assets/js/core/units.js',
  'assets/js/core/geo.js',
  'assets/js/core/sun.js',
  'assets/js/core/schedule.js',
  'assets/js/core/money.js',
  'assets/js/core/sync.js',
  'assets/js/core/transit.js',
  'assets/js/core/links.js',
  'assets/js/ui/nav.js',
  'assets/js/ui/map.js',
  'assets/js/ui/elevation.js',
  'assets/js/ui/offline.js',
  'assets/js/ui/photo.js',
  'assets/js/ui/history.js',
  'assets/js/pages/index.js',
  'assets/js/pages/day.js',
  'assets/js/pages/plan.js',
  'assets/js/pages/stays.js',
  'assets/js/pages/money.js',
  'assets/js/pages/packing.js',
  'assets/js/pages/transit.js',
  'assets/js/pages/about.js',
  'assets/js/pages/print.js',
];

const DATA = [
  'data/settings.json',
  'data/itinerary.json',
  'data/waypoints.json',
  'data/people.json',
  'data/stays.json',
  'data/expenses.json',
  'data/rates.json',
  'data/packing.json',
  'data/transit.json',
  'data/transit-schedules.json',
  'data/photos.json',
  'data/history.json',
  'data/route/anchors.json',
  'data/route/legs/index.json',
  'data/route/tmb-main.geojson',
  'data/route/tmb-loop-oriented.geojson',
  'data/route/variants/index.json',
];

// No day-05: with the La Fouly night dropped, its half of the walk is the back
// end of day-04. The numbering is deliberately left with a gap so that leg file
// names, waypoint dayIds and any shared link keep meaning what they used to.
const DAY_IDS = ['day-01', 'day-02', 'day-03', 'day-04', 'day-06', 'day-07'];

/* ------------------------------------------------------------------ */
/* install and activate                                               */
/* ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      // addAll is atomic — one 404 would abort the whole install — so each entry
      // is added individually and a missing optional file is not fatal.
      await Promise.all(
        SHELL.map((path) =>
          shell.add(new Request(path, { cache: 'reload' })).catch(() => {})
        )
      );

      const data = await caches.open(DATA_CACHE);
      const legs = await legPaths();
      await Promise.all(
        [...DATA, ...legs].map((path) =>
          data.add(new Request(path, { cache: 'reload' })).catch(() => {})
        )
      );
      // Take over open tabs so a VERSION bump is not stuck behind "close every
      // tab of this site". Without this, a phone that left transit.html open
      // keeps serving the previous shell from cache and the update looks like it
      // never reached GitHub.
      await self.skipWaiting();
    })()
  );
});

/** Every leg file, read from the generated index so this list never drifts. */
async function legPaths() {
  try {
    const response = await fetch('data/route/legs/index.json', { cache: 'reload' });
    if (!response.ok) throw new Error(String(response.status));
    const index = await response.json();
    return index.map((entry) => entry.file || `data/route/legs/${entry.dayId}-${entry.variant}.json`);
  } catch {
    // Fall back to the conventional names so a fetch failure during install
    // still leaves the common variants available offline.
    return DAY_IDS.flatMap((id) => [
      `data/route/legs/${id}-shortcut.json`,
      `data/route/legs/${id}-classic.json`,
    ]);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, DATA_CACHE, TILE_CACHE, PHOTO_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('tmb-') && !keep.has(name)).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/* ------------------------------------------------------------------ */
/* fetch strategies                                                   */
/* ------------------------------------------------------------------ */

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tileFirst(request));
    return;
  }

  // Only same-origin app traffic beyond this point; elevation APIs and the like
  // are pipeline-time concerns and should go straight to the network.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/data/')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Waypoint photographs are a few hundred KB each and never change in place, so
  // revalidating them on every visit would spend the trip's data allowance on
  // responses that are always 304. They are not precached either: they are only
  // wanted once someone has looked at the day, and that is when they arrive.
  if (url.pathname.includes('/assets/photos/')) {
    event.respondWith(cacheFirst(request, PHOTO_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

async function tileFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  try {
    const response = await fetch(request);
    // Opaque (type 'opaque') responses from tile CDNs cannot be inspected but
    // are still cacheable and replayable, which is all a tile needs.
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).then(trimTiles).catch(() => {});
    }
    return response;
  } catch (error) {
    // Offline with no cached tile: a transparent 1x1 keeps Leaflet from
    // showing broken-image icons across the whole map.
    return blankTile();
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: false });
    if (hit) return hit;
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });

  const update = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);

  if (hit) return hit;

  const fresh = await update;
  if (fresh) return fresh;

  // Navigations should land on something rather than a browser error page.
  if (request.mode === 'navigate') {
    const shell = await cache.match('index.html', { ignoreSearch: true });
    if (shell) return shell;
  }
  return new Response('Offline and not cached', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

/** Keep the tile cache from growing without bound; oldest entries go first. */
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  const excess = keys.length - TILE_LIMIT;
  for (let i = 0; i < excess; i += 1) {
    await cache.delete(keys[i]);
  }
}

function blankTile() {
  const bytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6l6DZUAAAAASUVORK5CYII='
    ),
    (character) => character.charCodeAt(0)
  );
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
  });
}

/* ------------------------------------------------------------------ */
/* messages: deliberate offline download and cache accounting         */
/* ------------------------------------------------------------------ */

self.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'tmb:prefetch-tiles') {
    event.waitUntil(prefetchTiles(message.urls || [], event.source));
  } else if (message.type === 'tmb:cache-status') {
    event.waitUntil(reportStatus(event.source));
  } else if (message.type === 'tmb:clear-tiles') {
    event.waitUntil(
      caches.delete(TILE_CACHE).then(() => reportStatus(event.source))
    );
  }
});

/**
 * Fetch a list of tiles into the cache, politely.
 *
 * OpenTopoMap and the other community tile servers ask that nobody bulk
 * downloads, so this runs a small number of requests at a time with a short
 * pause between batches, skips anything already cached, and is only ever
 * triggered by an explicit tap on the About page.
 */
async function prefetchTiles(urls, client) {
  const cache = await caches.open(TILE_CACHE);
  const CONCURRENCY = 4;
  const PAUSE_MS = 120;

  let done = 0;
  let cached = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (url) => {
        try {
          const request = new Request(url, { mode: 'no-cors' });
          if (await cache.match(request)) {
            skipped += 1;
            return;
          }
          const response = await fetch(request);
          if (response && (response.ok || response.type === 'opaque')) {
            await cache.put(request, response.clone());
            cached += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        } finally {
          done += 1;
        }
      })
    );

    client?.postMessage({
      type: 'tmb:prefetch-progress',
      done,
      total: urls.length,
      cached,
      skipped,
      failed,
    });

    if (i + CONCURRENCY < urls.length) {
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  }

  await trimTiles();
  client?.postMessage({
    type: 'tmb:prefetch-done',
    total: urls.length,
    cached,
    skipped,
    failed,
  });
}

async function reportStatus(client) {
  const [tiles, shell, data, photos] = await Promise.all([
    caches.open(TILE_CACHE).then((cache) => cache.keys()),
    caches.open(SHELL_CACHE).then((cache) => cache.keys()),
    caches.open(DATA_CACHE).then((cache) => cache.keys()),
    caches.open(PHOTO_CACHE).then((cache) => cache.keys()),
  ]);

  let usage = null;
  let quota = null;
  if (self.navigator?.storage?.estimate) {
    try {
      const estimate = await self.navigator.storage.estimate();
      usage = estimate.usage ?? null;
      quota = estimate.quota ?? null;
    } catch {
      /* storage estimate is best-effort */
    }
  }

  client?.postMessage({
    type: 'tmb:cache-status',
    version: VERSION,
    tiles: tiles.length,
    shell: shell.length,
    data: data.length,
    photos: photos.length,
    usage,
    quota,
  });
}
