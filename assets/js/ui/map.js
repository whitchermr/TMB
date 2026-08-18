/**
 * Leaflet map wrapper.
 *
 * Leaflet is loaded from a CDN as a global (`L`) because the project has no
 * build step. Everything here takes GeoJSON-order [lon, lat] coordinates to
 * match the rest of the codebase and flips them at the Leaflet boundary.
 *
 * All basemaps are keyless and were verified live. Attribution strings are
 * required by the respective licences — do not strip them.
 */

import { isHistoric, isPhotographic } from '../core/geo.js';

const OSM_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export const BASEMAPS = {
  opentopomap: {
    label: 'Topo',
    url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 17,
      attribution: `Map data ${OSM_ATTRIB}, SRTM | Rendering &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    },
  },
  imagery: {
    label: 'Satellite',
    // Esri uses {z}/{y}/{x}, reversed from the usual XYZ order.
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: {
      maxZoom: 18,
      attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
    },
  },
  swisstopo: {
    label: 'swisstopo',
    url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
    options: {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.swisstopo.admin.ch">swisstopo</a>',
    },
    note: 'Switzerland only — blank over France and Italy.',
  },
  osm: {
    label: 'Street',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: OSM_ATTRIB },
  },
};

const WAYMARKED = {
  url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
  options: {
    maxZoom: 18,
    opacity: 0.65,
    attribution: '<a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a> (CC-BY-SA)',
  },
};

export const VARIANT_COLORS = {
  shortcut: '#2f6f4e',
  classic: '#b5651d',
  arpette: '#7d5ba6',
  optional: '#7d5ba6',
  transit: '#6b7d8f',
};

const toLatLng = ([lon, lat]) => [lat, lon];

/* ------------------------------------------------------------------ */

export function createMap(element, { basemap = 'opentopomap', overlay = false } = {}) {
  const map = L.map(element, {
    zoomControl: true,
    // Canvas keeps thousands of vertices smooth, especially on phones.
    preferCanvas: true,
    scrollWheelZoom: false,
    tap: true,
  });

  // Scroll-wheel zoom hijacks page scrolling, which is hostile on a long page.
  // Enable it only once the user has deliberately interacted with the map.
  map.on('focus click', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());

  L.control.scale({ imperial: true, metric: true, position: 'bottomleft' }).addTo(map);

  const layers = {};
  Object.entries(BASEMAPS).forEach(([key, config]) => {
    layers[key] = L.tileLayer(config.url, config.options);
  });

  let active = layers[basemap] ? basemap : 'opentopomap';
  layers[active].addTo(map);

  const waymarked = L.tileLayer(WAYMARKED.url, WAYMARKED.options);
  if (overlay) waymarked.addTo(map);

  return {
    map,
    layers,
    setBasemap(key) {
      if (!layers[key] || key === active) return;
      map.removeLayer(layers[active]);
      layers[key].addTo(map);
      active = key;
      // Keep the trail above the freshly added tile layer.
      map.eachLayer((layer) => {
        if (layer.bringToFront && !(layer instanceof L.TileLayer)) layer.bringToFront();
      });
    },
    activeBasemap: () => active,
    setOverlay(on) {
      if (on) waymarked.addTo(map);
      else map.removeLayer(waymarked);
    },
  };
}

/** Basemap + overlay controls rendered as normal buttons rather than a Leaflet control. */
export function mountBasemapControls(container, handle, { showOverlay = true } = {}) {
  const group = document.createElement('div');
  group.className = 'btn-group';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Base map');
  group.innerHTML = Object.entries(BASEMAPS)
    .map(
      ([key, config]) =>
        `<button type="button" data-basemap="${key}"${
          config.note ? ` title="${config.note}"` : ''
        }>${config.label}</button>`
    )
    .join('');

  const sync = () => {
    group.querySelectorAll('[data-basemap]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.basemap === handle.activeBasemap()));
    });
  };

  group.addEventListener('click', (event) => {
    const button = event.target.closest('[data-basemap]');
    if (!button) return;
    handle.setBasemap(button.dataset.basemap);
    sync();
  });

  container.append(group);
  sync();

  if (showOverlay) {
    const toggle = document.createElement('label');
    toggle.className = 'checkbox';
    toggle.innerHTML = `<input type="checkbox"> Trail waymarks`;
    toggle.querySelector('input').addEventListener('change', (event) => {
      handle.setOverlay(event.target.checked);
    });
    container.append(toggle);
  }
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

export function drawTrack(map, coords, options = {}) {
  if (!coords || coords.length < 2) return null;
  return L.polyline(coords.map(toLatLng), {
    color: options.color || VARIANT_COLORS.shortcut,
    weight: options.weight ?? 4,
    opacity: options.opacity ?? 0.9,
    dashArray: options.dashArray,
    lineJoin: 'round',
    lineCap: 'round',
    interactive: options.interactive ?? false,
    pane: options.pane,
  }).addTo(map);
}

export function fitTo(map, coords, padding = 0.12) {
  if (!coords || !coords.length) return;
  const latLngs = coords.map(toLatLng);
  map.fitBounds(L.latLngBounds(latLngs).pad(padding), { animate: false });
}

/* ------------------------------------------------------------------ */
/* markers                                                             */
/* ------------------------------------------------------------------ */

function divIcon(className, html = '') {
  return L.divIcon({ className: '', html: `<div class="${className}">${html}</div>` });
}

/** Numbered markers for the overnight stops. */
export function addStopMarkers(map, stops, { onClick } = {}) {
  return stops.map((stop, index) => {
    const marker = L.marker(toLatLng([stop.lon, stop.lat]), {
      icon: divIcon('pin pin--stop', String(stop.number ?? index + 1)),
      title: stop.name,
      keyboard: true,
      zIndexOffset: 500,
    }).addTo(map);

    marker.bindTooltip(stop.name, { direction: 'top', offset: [0, -12] });
    if (onClick) marker.on('click', () => onClick(stop));
    return marker;
  });
}

/**
 * Scenery and landmark waypoints, sized by priority and shaped by role.
 *
 * A place that is both photographic and historic gets the photographic pin: the
 * light is the thing you have to arrive on time for, so that is the cue worth
 * putting on the map.
 *
 * `summaryFor` supplies the tooltip line for a waypoint with no photo subject.
 * It is a callback rather than a lookup here so this module stays unaware of the
 * history file, which imports escapeHtml from it.
 */
export function addWaypointMarkers(map, waypoints, { onClick, summaryFor } = {}) {
  return waypoints.map((waypoint) => {
    const classes = ['pin', 'pin--wp'];
    if (isHistoric(waypoint) && !isPhotographic(waypoint)) classes.push('pin--wp-historic');
    if (waypoint.priority === 1) classes.push('pin--wp-1');
    if (waypoint.isDetour) classes.push('pin--detour');

    const marker = L.marker(toLatLng([waypoint.lon, waypoint.lat]), {
      icon: divIcon(classes.join(' ')),
      title: waypoint.name,
      keyboard: true,
      zIndexOffset: waypoint.priority === 1 ? 400 : 200,
    }).addTo(map);

    const bits = [`<strong>${escapeHtml(waypoint.name)}</strong>`];
    if (waypoint.elevation_m) bits.push(`${Math.round(waypoint.elevation_m)} m`);
    const summary = waypoint.photo?.subject || summaryFor?.(waypoint);
    if (summary) bits.push(escapeHtml(summary));
    marker.bindTooltip(bits.join('<br>'), { direction: 'top', offset: [0, -10] });

    if (onClick) marker.on('click', () => onClick(waypoint));
    return marker;
  });
}

/** Marker that follows the elevation-chart cursor. */
export function createCursor(map) {
  let marker = null;
  return {
    move(coord) {
      if (!coord) return;
      const latLng = toLatLng(coord);
      if (marker) {
        marker.setLatLng(latLng);
      } else {
        marker = L.marker(latLng, {
          icon: divIcon('pin pin--cursor'),
          interactive: false,
          zIndexOffset: 1000,
        }).addTo(map);
      }
    },
    hide() {
      if (marker) {
        map.removeLayer(marker);
        marker = null;
      }
    },
  };
}

export function escapeHtml(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
}

/** Wait for the CDN script to define L, so a slow network fails clearly. */
export function whenLeafletReady(timeoutMs = 10000) {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (window.L) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error('Leaflet failed to load from the CDN — check the connection.'));
      }
    }, 50);
  });
}
