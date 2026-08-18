/**
 * Offline support: register the service worker, and pre-download the map tiles
 * covering the route so the map still works with no signal.
 *
 * Registration is unconditional on every page; the tile download is opt-in from
 * a panel on the About page, because community tile servers ask that nobody
 * bulk-download and this should only ever happen on a deliberate tap.
 */

import * as store from '../core/store.js';

/* ------------------------------------------------------------------ */
/* registration                                                       */
/* ------------------------------------------------------------------ */

let registration = null;

export async function register() {
  if (!('serviceWorker' in navigator)) return null;
  // A worker cannot be installed from file://, and there is no point over a
  // plain-http LAN address either since the API requires a secure context.
  if (!window.isSecureContext) return null;

  try {
    registration = await navigator.serviceWorker.register('sw.js', { scope: './' });
    return registration;
  } catch (error) {
    console.warn('Offline support unavailable', error);
    return null;
  }
}

export function isSupported() {
  return 'serviceWorker' in navigator && window.isSecureContext;
}

async function controller() {
  if (!isSupported()) return null;
  const ready = await navigator.serviceWorker.ready;
  return ready.active || navigator.serviceWorker.controller;
}

/* ------------------------------------------------------------------ */
/* tile enumeration                                                   */
/* ------------------------------------------------------------------ */

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom
  );
}

function fillTemplate(template, z, x, y) {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/** Every coordinate on the main loop and on the variants, as [lon, lat]. */
async function routeCoordinates() {
  const coords = [];

  const push = (geojson) => {
    const features = geojson.features || [geojson];
    features.forEach((feature) => {
      const geometry = feature.geometry || feature;
      if (geometry?.type === 'LineString') coords.push(...geometry.coordinates);
      else if (geometry?.type === 'MultiLineString') {
        geometry.coordinates.forEach((line) => coords.push(...line));
      }
    });
  };

  push(await store.loadRouteFile('loop'));

  // Variants matter for offline use too — someone may switch to Arpette on the
  // day, which is exactly when there is no signal to fetch its tiles.
  try {
    const index = await (await fetch('data/route/variants/index.json')).json();
    const files = await Promise.all(
      index.map((entry) => fetch(entry.file).then((response) => response.json()))
    );
    files.forEach(push);
  } catch (error) {
    console.warn('Variant geometry unavailable for offline planning', error);
  }

  return coords;
}

/**
 * Tile URLs for a corridor along the route.
 *
 * Only tiles the track actually passes through are collected, plus a one-tile
 * margin at the closer zooms so panning slightly off the line still shows map
 * rather than grey. A bounding box over the whole loop would be an order of
 * magnitude more tiles for terrain nobody will look at.
 */
export async function planTiles({ basemap = 'opentopomap', minZoom = 11, maxZoom = 14 } = {}) {
  // Imported lazily so that registering the worker — which every page does —
  // does not drag the map module onto pages that have no map.
  const { BASEMAPS } = await import('./map.js');
  const template = BASEMAPS[basemap]?.url;
  if (!template) throw new Error(`Unknown basemap ${basemap}`);

  const coords = await routeCoordinates();
  const urls = new Set();

  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
    const margin = zoom >= 13 ? 1 : 0;
    const seen = new Set();

    coords.forEach(([lon, lat]) => {
      const tx = lonToTileX(lon, zoom);
      const ty = latToTileY(lat, zoom);
      for (let dx = -margin; dx <= margin; dx += 1) {
        for (let dy = -margin; dy <= margin; dy += 1) {
          const key = `${tx + dx}/${ty + dy}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Placeholders are substituted by name, so Esri's reversed
          // {z}/{y}/{x} order needs no special handling here.
          urls.add(fillTemplate(template, zoom, tx + dx, ty + dy));
        }
      }
    });
  }

  return [...urls];
}

/* ------------------------------------------------------------------ */
/* worker messaging                                                   */
/* ------------------------------------------------------------------ */

function listen(handler) {
  const wrapped = (event) => handler(event.data || {});
  navigator.serviceWorker.addEventListener('message', wrapped);
  return () => navigator.serviceWorker.removeEventListener('message', wrapped);
}

/** Download a list of tiles, reporting progress until it finishes. */
export async function downloadTiles(urls, onProgress) {
  const active = await controller();
  if (!active) throw new Error('Offline support is not active yet — reload and try again.');

  return new Promise((resolve, reject) => {
    const stop = listen((message) => {
      if (message.type === 'tmb:prefetch-progress') {
        onProgress?.(message);
      } else if (message.type === 'tmb:prefetch-done') {
        stop();
        resolve(message);
      }
    });

    try {
      active.postMessage({ type: 'tmb:prefetch-tiles', urls });
    } catch (error) {
      stop();
      reject(error);
    }
  });
}

export async function cacheStatus() {
  const active = await controller();
  if (!active) return null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(null);
    }, 4000);
    const stop = listen((message) => {
      if (message.type !== 'tmb:cache-status') return;
      clearTimeout(timer);
      stop();
      resolve(message);
    });
    active.postMessage({ type: 'tmb:cache-status' });
  });
}

export async function clearTiles() {
  const active = await controller();
  if (!active) return null;
  return new Promise((resolve) => {
    const stop = listen((message) => {
      if (message.type !== 'tmb:cache-status') return;
      stop();
      resolve(message);
    });
    active.postMessage({ type: 'tmb:clear-tiles' });
  });
}

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
}
