/**
 * Per-day detail: map, elevation profile, segment breakdown, light times and the
 * scenery list. Deep-linkable as day.html?d=day-03.
 */

import * as store from '../core/store.js';
import * as units from '../core/units.js';
import * as schedule from '../core/schedule.js';
import * as sun from '../core/sun.js';
import { locateWaypoints, facingLabel } from '../core/geo.js';
import * as mapUi from '../ui/map.js';
import * as photos from '../ui/photo.js';
import { createElevationChart } from '../ui/elevation.js';
import { mountChrome, showLoadError, onRefresh, openChangesDialog } from '../ui/nav.js';

const state = {
  calendar: [],
  hikeDays: [],
  day: null,
  variant: null,
  available: [],
  leg: null,
  compareLeg: null,
  located: [],
  timing: null,
  sunTimes: null,
  handle: null,
  cursor: null,
  chart: null,
  layers: [],
  markers: [],
  editing: null,
};

async function main() {
  mountChrome();
  await mapUi.whenLeafletReady();
  await store.init(['settings', 'itinerary', 'waypoints']);

  const settings = store.get('settings');
  state.calendar = schedule.buildCalendar(store.get('itinerary'), settings.trip.startDate);
  state.hikeDays = state.calendar.filter((day) => day.kind === 'hike');
  state.legIndex = await store.loadRouteFile('legIndex');
  state.anchors = (await store.loadRouteFile('anchors')).anchors;
  await photos.load();

  const requested = new URLSearchParams(window.location.search).get('d');
  state.day = state.hikeDays.find((day) => day.id === requested) || state.hikeDays[0];
  if (!state.day) throw new Error('No hiking days in the itinerary.');

  state.handle = mapUi.createMap('map', {
    basemap: store.pref('basemap', settings.map.defaultBasemap),
  });
  mapUi.mountBasemapControls(document.getElementById('map-controls'), state.handle);
  const setBasemap = state.handle.setBasemap;
  state.handle.setBasemap = (key) => {
    setBasemap(key);
    store.setPref('basemap', key);
  };
  state.cursor = mapUi.createCursor(state.handle.map);

  state.chart = createElevationChart(document.getElementById('profile'), {
    height: '220px',
    onHover: (positionM) => {
      const index = nearestIndex(state.leg.cumulative_m, positionM);
      state.cursor?.move(state.leg.track[index]);
      highlightNearestWaypoint(positionM);
    },
    onLeave: () => {
      state.cursor?.hide();
      highlightNearestWaypoint(null);
    },
  });

  wireNavigation();
  wireWaypointDialog();
  await selectDay(state.day, { fit: true });

  onRefresh(() => {
    state.chart?.redraw();
    renderAll();
  });
}

/* ------------------------------------------------------------------ */
/* day / variant selection                                             */
/* ------------------------------------------------------------------ */

function variantsFor(dayId) {
  return state.legIndex.filter((entry) => entry.dayId === dayId);
}

async function selectDay(day, { fit = true } = {}) {
  state.day = day;
  state.available = variantsFor(day.legId);

  const preferred = store.pref('variant', store.get('settings').defaultVariant || 'shortcut');
  const pick =
    state.available.find((entry) => entry.variant === state.variant) ||
    state.available.find((entry) => entry.variant === preferred) ||
    state.available.find((entry) => !entry.optional) ||
    state.available[0];
  state.variant = pick.variant;

  state.leg = await store.loadLeg(day.legId, state.variant);

  const url = new URL(window.location.href);
  url.searchParams.set('d', day.id);
  window.history.replaceState({}, '', url);

  await refreshLeg({ fit });
}

async function refreshLeg({ fit = false } = {}) {
  const settings = store.get('settings');
  state.timing = schedule.legDuration(state.leg, settings.pace);

  const anchor = state.anchors[state.day.from];
  state.sunTimes = anchor ? sun.sunTimes(state.day.date, anchor.lat, anchor.lon) : null;

  const dayWaypoints = store
    .get('waypoints')
    .waypoints.filter((waypoint) => waypoint.dayId === state.day.id);
  state.located = locateWaypoints(
    dayWaypoints,
    state.leg.track,
    state.leg.cumulative_m,
    state.leg.elevation_m
  );

  const compareOn =
    document.getElementById('compare-toggle')?.checked && state.available.length > 1;
  if (compareOn) {
    const other = state.available.find((entry) => entry.variant !== state.variant);
    state.compareLeg = other ? await store.loadLeg(state.day.legId, other.variant) : null;
  } else {
    state.compareLeg = null;
  }

  drawMap({ fit });
  renderAll();
}

/* ------------------------------------------------------------------ */
/* map                                                                 */
/* ------------------------------------------------------------------ */

function drawMap({ fit }) {
  state.layers.forEach((layer) => state.handle.map.removeLayer(layer));
  state.markers.forEach((marker) => state.handle.map.removeLayer(marker));
  state.layers = [];
  state.markers = [];

  if (state.compareLeg) {
    const layer = mapUi.drawTrack(state.handle.map, state.compareLeg.track, {
      color: mapUi.VARIANT_COLORS[state.compareLeg.variant] || '#999',
      weight: 3,
      opacity: 0.75,
      dashArray: '6 5',
    });
    if (layer) state.layers.push(layer);
  }

  const main = mapUi.drawTrack(state.handle.map, state.leg.track, {
    color: mapUi.VARIANT_COLORS[state.variant] || mapUi.VARIANT_COLORS.shortcut,
    weight: 5,
  });
  if (main) state.layers.push(main);

  state.leg.segments
    .filter((segment) => segment.type === 'transit' && segment.geometry?.length > 1)
    .forEach((segment) => {
      const layer = mapUi.drawTrack(state.handle.map, segment.geometry, {
        color: mapUi.VARIANT_COLORS.transit,
        weight: 3,
        dashArray: '2 7',
      });
      if (layer) state.layers.push(layer);
    });

  const endpoints = [
    { key: state.day.from, number: 'A' },
    { key: state.day.to, number: 'B' },
  ]
    .map(({ key, number }) => {
      const anchor = state.anchors[key];
      return anchor ? { ...anchor, number } : null;
    })
    .filter(Boolean);
  state.markers.push(...mapUi.addStopMarkers(state.handle.map, endpoints));

  state.markers.push(
    ...mapUi.addWaypointMarkers(state.handle.map, state.located, {
      onClick: (waypoint) => focusWaypoint(waypoint.id),
    })
  );

  if (fit) {
    const all = state.compareLeg
      ? [...state.leg.track, ...state.compareLeg.track]
      : state.leg.track;
    mapUi.fitTo(state.handle.map, all);
  }

  document.getElementById('map-legend').innerHTML = [
    `<span style="color:${mapUi.VARIANT_COLORS[state.variant] || mapUi.VARIANT_COLORS.shortcut}"><i></i> ${labelFor(state.variant)}</span>`,
    state.compareLeg
      ? `<span style="color:${mapUi.VARIANT_COLORS[state.compareLeg.variant]}"><i class="dashed"></i> ${labelFor(state.compareLeg.variant)}</span>`
      : '',
    state.leg.transitDistance_m
      ? `<span style="color:${mapUi.VARIANT_COLORS.transit}"><i class="dashed"></i> Bus / navette</span>`
      : '',
    '<span style="color:var(--c-warm)"><i></i> Scenery stop</span>',
  ]
    .filter(Boolean)
    .join('');
}

function labelFor(variant) {
  return state.available.find((entry) => entry.variant === variant)?.label || variant;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll() {
  if (!state.leg) return;
  renderHeader();
  renderVariantToggle();
  renderStats();
  renderChart();
  renderSegments();
  renderSun();
  renderWaypoints();
}

function renderHeader() {
  document.getElementById('day-date').textContent =
    `${schedule.formatDate(state.day.date, { year: true })} · Day ${state.day.hikeNumber}`;
  document.getElementById('day-title').textContent = state.day.stage || state.leg.stage;
  document.getElementById('day-note').textContent = state.day.note || state.leg.note || '';

  const select = document.getElementById('day-select');
  select.innerHTML = state.hikeDays
    .map(
      (day) =>
        `<option value="${day.id}"${day.id === state.day.id ? ' selected' : ''}>Day ${
          day.hikeNumber
        } — ${day.stage}</option>`
    )
    .join('');

  const position = state.hikeDays.findIndex((day) => day.id === state.day.id);
  document.getElementById('prev-day').disabled = position <= 0;
  document.getElementById('next-day').disabled = position >= state.hikeDays.length - 1;

  const compareWrap = document.getElementById('compare-wrap');
  compareWrap.hidden = state.available.length < 2;
}

function renderVariantToggle() {
  const container = document.getElementById('variant-toggle');
  container.innerHTML = state.available
    .map(
      (entry) =>
        `<button type="button" data-variant="${entry.variant}" aria-pressed="${
          entry.variant === state.variant
        }">${entry.label}${entry.optional ? ' *' : ''}</button>`
    )
    .join('');

  container.onclick = async (event) => {
    const button = event.target.closest('[data-variant]');
    if (!button || button.dataset.variant === state.variant) return;
    state.variant = button.dataset.variant;
    state.leg = await store.loadLeg(state.day.legId, state.variant);
    await refreshLeg({ fit: true });
  };
}

function renderStats() {
  const stats = state.leg.stats || {};
  const planned = state.leg.plannedTotals;
  const settings = store.get('settings');
  const start = sun.parseHour(settings.pace.startTime) ?? 8;

  const deltaNote = planned?.gain_m
    ? `planned ${units.elevation(planned.gain_m)}`
    : '';

  document.getElementById('day-stats').innerHTML = `
    ${stat('Distance', units.distance(stats.distance_m), planned?.distance_km ? `planned ${units.distance(planned.distance_km * 1000)}` : '')}
    ${stat('Ascent', units.elevationDelta(stats.gain_m, 'gain'), deltaNote, 'gain')}
    ${stat('Descent', units.elevationDelta(stats.loss_m, 'loss'), '', 'loss')}
    ${stat('High point', units.elevation(stats.maxElevation_m), '')}
    ${stat('On foot', units.duration(state.timing.totalHours), `${units.duration(state.timing.movingHours)} moving`)}
    ${stat('Finish', sun.formatHour(start + state.timing.totalHours), `from ${settings.pace.startTime}`)}
    ${
      state.leg.transitDistance_m
        ? stat('By bus', units.distance(state.leg.transitDistance_m), 'not walked')
        : ''
    }
  `;
}

function stat(label, value, sub = '', modifier = '') {
  return `
    <div class="stat${modifier ? ` stat--${modifier}` : ''}">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${value}</span>
      ${sub ? `<span class="stat__sub">${sub}</span>` : ''}
    </div>
  `;
}

function renderChart() {
  const settings = store.get('settings');
  const series = [
    {
      cumulative_m: state.leg.cumulative_m,
      elevation_m: state.leg.elevation_m,
      color: mapUi.VARIANT_COLORS[state.variant] || mapUi.VARIANT_COLORS.shortcut,
      label: labelFor(state.variant),
      timeAt: (positionM) =>
        schedule.elapsedAt(state.leg, settings.pace, positionM, state.timing),
    },
  ];

  if (state.compareLeg) {
    series.push({
      cumulative_m: state.compareLeg.cumulative_m,
      elevation_m: state.compareLeg.elevation_m,
      color: mapUi.VARIANT_COLORS[state.compareLeg.variant] || '#999',
      label: labelFor(state.compareLeg.variant),
      dashed: true,
    });
  }

  state.chart.setSeries(series);
  state.chart.setWaypoints(state.located);

  document.getElementById('profile-hint').textContent = state.compareLeg
    ? `Solid: ${labelFor(state.variant)} · Dashed: ${labelFor(state.compareLeg.variant)}`
    : 'Drag to read distance, height and elapsed time';
}

function renderSegments() {
  const container = document.getElementById('segments');
  container.innerHTML = state.leg.segments
    .map((segment) => {
      const isTransit = segment.type === 'transit';
      const from = state.anchors[segment.from]?.name || segment.from;
      const to = state.anchors[segment.to]?.name || segment.to;

      const title = segment.variant
        ? `Variant: ${segment.variant.replace(/-/g, ' ')}`
        : `${from ?? '—'} → ${to ?? '—'}`;

      const numbers = isTransit
        ? segment.distance_m
          ? units.distance(segment.distance_m)
          : ''
        : [
            units.distance(segment.distance_m),
            segment.gain_m != null ? units.elevationDelta(segment.gain_m, 'gain') : '',
            segment.loss_m != null ? units.elevationDelta(segment.loss_m, 'loss') : '',
          ]
            .filter(Boolean)
            .join(' · ');

      return `
        <div class="segment${isTransit ? ' segment--transit' : ''}">
          <span class="chip ${isTransit ? '' : 'chip--accent'}">${
            isTransit ? segment.mode || 'transit' : 'walk'
          }</span>
          <span class="segment__label">
            ${mapUi.escapeHtml(title)}
            ${segment.note ? `<br><small class="faint">${mapUi.escapeHtml(segment.note)}</small>` : ''}
          </span>
          <span class="segment__num">${numbers}</span>
        </div>
      `;
    })
    .join('');
}

function renderSun() {
  const times = state.sunTimes;
  const anchor = state.anchors[state.day.from];
  document.getElementById('sun-place').textContent = anchor
    ? `${anchor.name}, ${schedule.formatDate(state.day.date)}`
    : '';

  if (!times) {
    document.getElementById('sun-stats').innerHTML =
      '<p class="faint">No sun times for this day.</p>';
    return;
  }

  document.getElementById('sun-stats').innerHTML = `
    ${stat('First light', sun.formatHour(times.dawn), 'blue hour')}
    ${stat('Sunrise', sun.formatHour(times.sunrise), '')}
    ${stat('Golden ends', sun.formatHour(times.goldenMorningEnd), 'morning')}
    ${stat('Golden starts', sun.formatHour(times.goldenEveningStart), 'evening')}
    ${stat('Sunset', sun.formatHour(times.sunset), '')}
    ${stat('Daylight', units.duration(times.dayLength), '')}
  `;
}

function renderWaypoints() {
  const list = document.getElementById('waypoint-list');
  const settings = store.get('settings');
  const start = sun.parseHour(settings.pace.startTime) ?? 8;

  if (!state.located.length) {
    list.innerHTML = `<li class="empty">
      No scenery notes for this day yet. Use <strong>Add</strong> to record a viewpoint.
    </li>`;
    return;
  }

  list.innerHTML = state.located
    .map((waypoint) => {
      const elapsed = schedule.elapsedAt(
        state.leg,
        settings.pace,
        waypoint.position_m,
        state.timing
      );
      const arrival = start + elapsed;
      const match = sun.lightMatch(waypoint.photo?.bestLight, arrival, state.sunTimes);
      const window = sun.lightWindowAt(arrival, state.sunTimes);

      const tags = [
        waypoint.priority === 1 ? '<span class="chip priority-1">Do not miss</span>' : '',
        waypoint.kind ? `<span class="chip">${waypoint.kind}</span>` : '',
        waypoint.photo?.bestLight && waypoint.photo.bestLight !== 'any'
          ? `<span class="chip chip--warm">best at ${waypoint.photo.bestLight}</span>`
          : '',
        waypoint.photo?.facing
          ? `<span class="chip">looks ${facingLabel(waypoint.photo.facing)}</span>`
          : '',
        match === 'match'
          ? `<span class="chip chip--accent">arriving in ${sun.lightWindowLabel(window)}</span>`
          : match === 'miss'
            ? `<span class="chip chip--danger">arriving in ${sun.lightWindowLabel(window)}</span>`
            : '',
        waypoint.isDetour
          ? `<span class="chip chip--info">detour +${units.distance(
              waypoint.detour?.distance_m ?? 0
            )}${
              waypoint.detour?.gain_m
                ? ` / ${units.elevationDelta(waypoint.detour.gain_m, 'gain')}`
                : ''
            }</span>`
          : '',
      ]
        .filter(Boolean)
        .join('');

      return `
        <li class="wp" data-id="${waypoint.id}" tabindex="0" role="button">
          <div class="wp__dist">
            ${units.distance(waypoint.position_m)}
            <small>${sun.formatHour(arrival)}</small>
            <small>${units.elevation(waypoint.elevation_m ?? waypoint.trackElevation_m)}</small>
          </div>
          <div>
            <div class="wp__name">${mapUi.escapeHtml(waypoint.name)}</div>
            ${photos.figure(photos.forWaypoint(waypoint.id))}
            ${
              waypoint.photo?.subject
                ? `<div class="wp__subject">${mapUi.escapeHtml(waypoint.photo.subject)}</div>`
                : ''
            }
            ${
              waypoint.photo?.notes
                ? `<div class="wp__notes">${mapUi.escapeHtml(waypoint.photo.notes)}</div>`
                : ''
            }
            <div class="wp__tags">${tags}</div>
          </div>
        </li>
      `;
    })
    .join('');

  list.querySelectorAll('.wp').forEach((item) => {
    item.addEventListener('click', () => focusWaypoint(item.dataset.id));
    item.addEventListener('dblclick', () => openWaypointDialog(item.dataset.id));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        focusWaypoint(item.dataset.id);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* interaction                                                         */
/* ------------------------------------------------------------------ */

function focusWaypoint(id) {
  const waypoint = state.located.find((entry) => entry.id === id);
  if (!waypoint) return;
  state.chart.setCursor(waypoint.position_m);
  state.cursor?.move([waypoint.lon, waypoint.lat]);
  state.handle.map.panTo([waypoint.lat, waypoint.lon], { animate: true });
  highlightNearestWaypoint(waypoint.position_m, id);
}

function highlightNearestWaypoint(positionM, exactId) {
  let activeId = exactId || null;
  if (!activeId && positionM != null && state.located.length) {
    const nearest = state.located.reduce((best, waypoint) =>
      Math.abs(waypoint.position_m - positionM) < Math.abs(best.position_m - positionM)
        ? waypoint
        : best
    );
    // Only claim a match when the cursor is genuinely near the waypoint.
    if (Math.abs(nearest.position_m - positionM) < 350) activeId = nearest.id;
  }
  document.querySelectorAll('#waypoint-list .wp').forEach((item) => {
    item.dataset.active = String(item.dataset.id === activeId);
  });
}

function nearestIndex(cumulative, positionM) {
  let lo = 0;
  let hi = cumulative.length - 1;
  if (positionM <= cumulative[0]) return 0;
  if (positionM >= cumulative[hi]) return hi;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= positionM) lo = mid;
    else hi = mid;
  }
  return positionM - cumulative[lo] <= cumulative[hi] - positionM ? lo : hi;
}

function wireNavigation() {
  document.getElementById('day-select').addEventListener('change', async (event) => {
    const day = state.hikeDays.find((entry) => entry.id === event.target.value);
    if (day) await selectDay(day);
  });

  const step = async (delta) => {
    const position = state.hikeDays.findIndex((day) => day.id === state.day.id);
    const next = state.hikeDays[position + delta];
    if (next) await selectDay(next);
  };

  document.getElementById('prev-day').addEventListener('click', () => step(-1));
  document.getElementById('next-day').addEventListener('click', () => step(1));

  document.getElementById('compare-toggle').addEventListener('change', () => refreshLeg());

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select')) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });
}

/* ------------------------------------------------------------------ */
/* waypoint editing                                                    */
/* ------------------------------------------------------------------ */

function wireWaypointDialog() {
  const dialog = document.getElementById('wp-dialog');

  document.getElementById('add-waypoint').addEventListener('click', () => {
    openWaypointDialog(null);
  });

  document.getElementById('wp-save').addEventListener('click', () => {
    const value = readDialog();
    if (!value.name || !Number.isFinite(value.lat) || !Number.isFinite(value.lon)) {
      window.alert('A name and valid coordinates are required.');
      return;
    }

    store.update('waypoints', (data) => {
      if (state.editing) {
        const index = data.waypoints.findIndex((entry) => entry.id === state.editing);
        if (index >= 0) data.waypoints[index] = { ...data.waypoints[index], ...value };
      } else {
        data.waypoints.push({ id: store.newId('wp-'), dayId: state.day.id, ...value });
      }
    });

    dialog.close();
    refreshLeg();
    openChangesDialog('waypoints');
  });

  document.getElementById('wp-delete').addEventListener('click', () => {
    if (!state.editing) return dialog.close();
    if (!window.confirm('Delete this scenery note?')) return;
    store.update('waypoints', (data) => {
      data.waypoints = data.waypoints.filter((entry) => entry.id !== state.editing);
    });
    dialog.close();
    refreshLeg();
  });
}

function openWaypointDialog(id) {
  state.editing = id;
  const dialog = document.getElementById('wp-dialog');
  const waypoint = id
    ? store.get('waypoints').waypoints.find((entry) => entry.id === id)
    : null;

  document.getElementById('wp-dialog-title').textContent = waypoint
    ? 'Edit scenery note'
    : 'New scenery note';
  document.getElementById('wp-delete').hidden = !waypoint;

  const set = (elementId, value) => {
    document.getElementById(elementId).value = value ?? '';
  };
  set('wp-name', waypoint?.name);
  set('wp-kind', waypoint?.kind || 'viewpoint');
  // Default new points to the middle of the day's track, which is far easier to
  // nudge than an empty field.
  const middle = state.leg.track[Math.floor(state.leg.track.length / 2)] || [0, 0];
  set('wp-lat', waypoint?.lat ?? middle[1].toFixed(5));
  set('wp-lon', waypoint?.lon ?? middle[0].toFixed(5));
  set('wp-elev', waypoint?.elevation_m);
  set('wp-priority', String(waypoint?.priority || 2));
  set('wp-light', waypoint?.photo?.bestLight || 'any');
  set('wp-facing', waypoint?.photo?.facing || '');
  set('wp-subject', waypoint?.photo?.subject);
  set('wp-notes', waypoint?.photo?.notes);
  document.getElementById('wp-detour').checked = waypoint?.isDetour === true;

  dialog.showModal();
}

function readDialog() {
  const value = (id) => document.getElementById(id).value.trim();
  const number = (id) => {
    const raw = value(id);
    return raw === '' ? null : Number(raw);
  };

  return {
    name: value('wp-name'),
    kind: value('wp-kind'),
    lat: number('wp-lat'),
    lon: number('wp-lon'),
    elevation_m: number('wp-elev'),
    priority: Number(value('wp-priority')) || 2,
    isDetour: document.getElementById('wp-detour').checked,
    photo: {
      subject: value('wp-subject'),
      facing: value('wp-facing'),
      bestLight: value('wp-light'),
      notes: value('wp-notes'),
    },
  };
}

main().catch(showLoadError);
