/**
 * About page: mostly static prose, the offline-maps panel, and the photograph
 * credits.
 *
 * The panel is the one interactive part, because pre-downloading tiles has to
 * be a deliberate action rather than something the site does on its own. The
 * credits are rendered from data/photos.json rather than written into the HTML so
 * that changing a photo cannot leave the wrong name beside it.
 */

import * as store from '../core/store.js';
import * as offline from '../ui/offline.js';
import { BASEMAPS, escapeHtml } from '../ui/map.js';
import { mountChrome } from '../ui/nav.js';

mountChrome();

const state = { busy: false };

const el = {
  version: document.getElementById('offline-version'),
  status: document.getElementById('offline-state'),
  stats: document.getElementById('offline-stats'),
  controls: document.getElementById('offline-controls'),
  actions: document.getElementById('offline-actions'),
  basemap: document.getElementById('offline-basemap'),
  zoom: document.getElementById('offline-zoom'),
  download: document.getElementById('offline-download'),
  clear: document.getElementById('offline-clear'),
  progress: document.getElementById('offline-progress'),
  bar: document.getElementById('offline-bar'),
  progressText: document.getElementById('offline-progress-text'),
};

/**
 * The photograph credits.
 *
 * Rendered independently of the offline panel: a browser without service workers
 * still shows the photos, so it still owes the credit.
 */
async function renderPhotoCredits() {
  const table = document.getElementById('photo-credit-table');
  const waypointNames = new Map(
    store.get('waypoints').waypoints.map((waypoint) => [waypoint.id, waypoint.name])
  );
  const { photos } = await store.loadRouteFile('photos');

  table.querySelector('tbody').innerHTML = photos
    .map((entry) => {
      const { author, licence, licenceUrl, source } = entry.credit;
      const name = waypointNames.get(entry.waypointId) || entry.waypointId;
      return `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(author)}</td>
          <td>${
            licenceUrl
              ? `<a href="${escapeHtml(licenceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(licence)}</a>`
              : escapeHtml(licence)
          }</td>
          <td>${
            source
              ? `<a href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer">Commons</a>`
              : '—'
          }</td>
        </tr>`;
    })
    .join('');

  document.getElementById('photo-credits-count').textContent =
    `${photos.length} photographs`;
}

async function main() {
  if (!offline.isSupported()) {
    el.status.textContent =
      'This browser will not cache maps here — offline support needs https (or localhost). ' +
      'The published GitHub Pages site qualifies.';
    return;
  }

  el.basemap.innerHTML = Object.entries(BASEMAPS)
    .map(([key, config]) => `<option value="${key}">${config.label}</option>`)
    .join('');
  el.basemap.value = 'opentopomap';

  const registration = await offline.register();
  if (!registration) {
    el.status.textContent = 'Offline support could not start. The site still works online.';
    return;
  }

  el.status.textContent =
    'The planner itself is cached and works offline. Download map tiles below.';
  el.controls.hidden = false;
  el.actions.hidden = false;

  el.download.addEventListener('click', download);
  el.clear.addEventListener('click', clear);

  await refreshStatus();
}

async function refreshStatus() {
  const status = await offline.cacheStatus();
  if (!status) {
    el.stats.innerHTML = '';
    return;
  }

  el.version.textContent = `cache ${status.version}`;
  el.stats.innerHTML = `
    ${stat('Map tiles', status.tiles.toLocaleString(), 'cached')}
    ${stat('Pages and code', String(status.shell), 'files')}
    ${stat('Trip data', String(status.data), 'files')}
    ${stat('View photos', String(status.photos ?? 0), 'saved as you browse')}
    ${stat(
      'Storage used',
      offline.formatBytes(status.usage),
      status.quota ? `of ${offline.formatBytes(status.quota)} available` : ''
    )}
  `;
}

function stat(label, value, sub = '') {
  return `
    <div class="stat">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${value}</span>
      ${sub ? `<span class="stat__sub">${sub}</span>` : ''}
    </div>
  `;
}

async function download() {
  if (state.busy) return;

  const basemap = el.basemap.value;
  const maxZoom = Number(el.zoom.value);

  el.download.disabled = true;
  el.progress.hidden = false;
  el.progressText.textContent = 'Working out which tiles cover the route…';
  el.bar.style.width = '0%';

  try {
    const urls = await offline.planTiles({ basemap, minZoom: 11, maxZoom });

    // Roughly 15 KB per topo tile; enough for an informed yes or no.
    const estimate = offline.formatBytes(urls.length * 15 * 1024);
    const proceed = window.confirm(
      `${urls.length.toLocaleString()} tiles for ${BASEMAPS[basemap].label} at zoom 11–${maxZoom}, ` +
        `roughly ${estimate}.\n\nThis takes a few minutes. Download now?`
    );
    if (!proceed) {
      el.progress.hidden = true;
      return;
    }

    state.busy = true;
    const result = await offline.downloadTiles(urls, (progress) => {
      const percent = progress.total ? (progress.done / progress.total) * 100 : 0;
      el.bar.style.width = `${percent.toFixed(1)}%`;
      el.progressText.textContent =
        `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} — ` +
        `${progress.cached.toLocaleString()} new, ${progress.skipped.toLocaleString()} already held` +
        (progress.failed ? `, ${progress.failed.toLocaleString()} failed` : '');
    });

    el.bar.style.width = '100%';
    el.progressText.textContent =
      `Done. ${result.cached.toLocaleString()} tiles downloaded, ` +
      `${result.skipped.toLocaleString()} already held` +
      (result.failed
        ? `, ${result.failed.toLocaleString()} failed — rerun to fill the gaps.`
        : '.');
  } catch (error) {
    el.progressText.textContent = `Could not download tiles: ${error.message}`;
  } finally {
    state.busy = false;
    el.download.disabled = false;
    await refreshStatus();
  }
}

async function clear() {
  if (state.busy) return;
  if (!window.confirm('Remove every cached map tile? The planner itself stays offline-ready.'))
    return;
  await offline.clearTiles();
  el.progress.hidden = true;
  await refreshStatus();
}

// The two halves of this page fail independently: a broken offline panel should
// not take the credits with it, and vice versa.
store
  .init(['waypoints'])
  .then(renderPhotoCredits)
  .catch((error) => {
    document.getElementById('photo-credits-count').textContent = 'unavailable';
    console.error(error);
  });

main().catch((error) => {
  el.status.textContent = `Offline panel failed to start: ${error.message}`;
  console.error(error);
});
