/** Route overview: the whole loop, trip totals, and the day list. */

import * as store from '../core/store.js';
import * as units from '../core/units.js';
import * as schedule from '../core/schedule.js';
import * as mapUi from '../ui/map.js';
import { createElevationChart } from '../ui/elevation.js';
import { mountChrome, showLoadError, onRefresh } from '../ui/nav.js';

const state = {
  variant: null,
  legs: new Map(),
  calendar: [],
  handle: null,
  chart: null,
  cursor: null,
  trackLayers: [],
  // Concatenated trip profile plus a lookup from trip distance back to a day.
  profile: null,
};

async function main() {
  mountChrome();
  await mapUi.whenLeafletReady();
  await store.init(['settings', 'itinerary', 'waypoints']);

  const settings = store.get('settings');
  state.variant = store.pref('variant', settings.defaultVariant || 'shortcut');

  const [anchors, loop] = await Promise.all([
    store.loadRouteFile('anchors'),
    store.loadRouteFile('loop'),
  ]);
  state.anchors = anchors.anchors;
  state.loop = loop.features[0].geometry.coordinates;

  state.calendar = schedule.buildCalendar(store.get('itinerary'), settings.trip.startDate);
  await loadLegs();

  buildMap();
  buildChart();
  render();

  onRefresh(() => {
    state.chart?.redraw();
    render();
  });
}

/** Load the active variant for every hiking day, falling back where a day has none. */
async function loadLegs() {
  const index = await store.loadRouteFile('legIndex');
  const available = new Set(index.map((entry) => `${entry.dayId}-${entry.variant}`));

  await Promise.all(
    state.calendar
      .filter((day) => day.kind === 'hike')
      .map(async (day) => {
        const key = available.has(`${day.legId}-${state.variant}`)
          ? state.variant
          : index.find((entry) => entry.dayId === day.legId && !entry.optional)?.variant;
        if (!key) return;
        state.legs.set(day.id, await store.loadLeg(day.legId, key));
      })
  );
}

/* ------------------------------------------------------------------ */
/* map                                                                 */
/* ------------------------------------------------------------------ */

function buildMap() {
  state.handle = mapUi.createMap('map', {
    basemap: store.pref('basemap', store.get('settings').map.defaultBasemap),
  });
  mapUi.mountBasemapControls(document.getElementById('map-controls'), state.handle);

  // Remember the basemap choice per device.
  const original = state.handle.setBasemap;
  state.handle.setBasemap = (key) => {
    original(key);
    store.setPref('basemap', key);
  };

  state.cursor = mapUi.createCursor(state.handle.map);

  const stops = state.calendar
    .filter((day) => day.kind === 'hike')
    .map((day, index) => {
      const anchor = state.anchors[day.to];
      if (!anchor) return null;
      return { ...anchor, number: index + 1, dayId: day.id };
    })
    .filter(Boolean);

  // The start point gets its own marker since no day ends there.
  const start = state.anchors[state.calendar.find((d) => d.kind === 'hike')?.from];
  if (start) {
    mapUi.addStopMarkers(state.handle.map, [{ ...start, number: 0 }]);
  }

  mapUi.addStopMarkers(state.handle.map, stops, {
    onClick: (stop) => {
      window.location.href = `day.html?d=${encodeURIComponent(stop.dayId)}`;
    },
  });

  const highlights = state.calendar
    .filter((day) => day.kind === 'hike' && state.legs.has(day.id))
    .flatMap((day) => {
      const leg = state.legs.get(day.id);
      const layers = [];

      layers.push(
        mapUi.drawTrack(state.handle.map, leg.track, {
          color: mapUi.VARIANT_COLORS[leg.variant] || mapUi.VARIANT_COLORS.shortcut,
          weight: 4,
        })
      );

      leg.segments
        .filter((segment) => segment.type === 'transit' && segment.geometry?.length > 1)
        .forEach((segment) => {
          layers.push(
            mapUi.drawTrack(state.handle.map, segment.geometry, {
              color: mapUi.VARIANT_COLORS.transit,
              weight: 3,
              dashArray: '2 7',
              opacity: 0.8,
            })
          );
        });

      return layers.filter(Boolean);
    });

  state.trackLayers = highlights;

  // The unused portion of the loop still gives useful context.
  mapUi.drawTrack(state.handle.map, state.loop, {
    color: '#8b948e',
    weight: 1.5,
    opacity: 0.35,
  });
  highlights.forEach((layer) => layer.bringToFront?.());

  mapUi.fitTo(state.handle.map, state.loop);

  document.getElementById('map-legend').innerHTML = `
    <span style="color:${mapUi.VARIANT_COLORS[state.variant] || mapUi.VARIANT_COLORS.shortcut}">
      <i></i> Our route
    </span>
    <span style="color:${mapUi.VARIANT_COLORS.transit}"><i class="dashed"></i> Bus / navette</span>
    <span style="color:#8b948e"><i></i> Rest of the TMB loop</span>
    <span><span class="pin pin--stop" style="position:static;margin:0;width:16px;height:16px"></span> Overnight stop</span>
  `;
}

/* ------------------------------------------------------------------ */
/* whole-trip profile                                                  */
/* ------------------------------------------------------------------ */

/**
 * Lay every hiking day end to end on one distance axis, keeping a map from trip
 * distance back to the originating day so the cursor can drive the map marker.
 */
function buildTripProfile() {
  const cumulative = [];
  const elevation = [];
  const coords = [];
  const boundaries = [];
  let offset = 0;

  state.calendar
    .filter((day) => day.kind === 'hike' && state.legs.has(day.id))
    .forEach((day) => {
      const leg = state.legs.get(day.id);
      const legCum = leg.cumulative_m || [];
      const legElevation = leg.elevation_m || [];

      legCum.forEach((distance, i) => {
        // Skip the duplicated joining vertex between consecutive days.
        if (i === 0 && cumulative.length) return;
        cumulative.push(offset + distance);
        elevation.push(legElevation[i] ?? null);
        coords.push(leg.track[i]);
      });

      offset += legCum[legCum.length - 1] || 0;
      boundaries.push({ dayId: day.id, position_m: offset, name: state.anchors[day.to]?.name });
    });

  return { cumulative, elevation, coords, boundaries, total: offset };
}

function buildChart() {
  state.profile = buildTripProfile();

  state.chart = createElevationChart(document.getElementById('trip-profile'), {
    height: '230px',
    onHover: (positionM) => {
      const index = nearestIndex(state.profile.cumulative, positionM);
      state.cursor?.move(state.profile.coords[index]);
    },
    onLeave: () => state.cursor?.hide(),
  });

  state.chart.setSeries([
    {
      cumulative_m: state.profile.cumulative,
      elevation_m: state.profile.elevation,
      color: mapUi.VARIANT_COLORS[state.variant] || mapUi.VARIANT_COLORS.shortcut,
      label: `${state.variant} route`,
    },
  ]);

  // Reuse the waypoint tick mechanism to mark overnight stops.
  state.chart.setWaypoints(
    state.profile.boundaries.slice(0, -1).map((boundary) => ({
      position_m: boundary.position_m,
      priority: 2,
      name: boundary.name,
    }))
  );
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

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  const settings = store.get('settings');
  const legs = [...state.legs.values()];
  const totals = schedule.tripTotals(legs);

  const hikeDays = state.calendar.filter((day) => day.kind === 'hike');
  const restDays = state.calendar.filter((day) => day.kind === 'rest');
  const first = hikeDays[0];
  const last = hikeDays[hikeDays.length - 1];

  const totalHours = legs.reduce(
    (sum, leg) => sum + schedule.legDuration(leg, settings.pace).totalHours,
    0
  );

  document.getElementById('trip-summary').textContent =
    `${hikeDays.length} hiking days and ${restDays.length} rest day` +
    `${restDays.length === 1 ? '' : 's'}, ` +
    `${schedule.formatDate(first.date)} to ${schedule.formatDate(last.date)}. ` +
    `Based in ${settings.trip.base}.`;

  document.getElementById('trip-stats').innerHTML = `
    ${stat('Hiking', units.distance(totals.distance_m), `${hikeDays.length} days`)}
    ${stat('Ascent', units.elevationDelta(totals.gain_m, 'gain'), '', 'gain')}
    ${stat('Descent', units.elevationDelta(totals.loss_m, 'loss'), '', 'loss')}
    ${stat('High point', units.elevation(totals.maxElevation_m), highPointName(legs))}
    ${stat('On foot', units.duration(totalHours), `at ${units.speed(settings.pace.flatSpeedKmh)}`)}
    ${stat('By bus', units.distance(totals.transit_m), 'shuttles and lifts')}
  `;

  renderVariantToggle();
  renderDayList();
}

function highPointName(legs) {
  const best = legs.reduce(
    (top, leg) =>
      (leg.stats?.maxElevation_m ?? -Infinity) > (top?.stats?.maxElevation_m ?? -Infinity)
        ? leg
        : top,
    null
  );
  if (!best) return '';
  const waypoints = store.get('waypoints').waypoints.filter((w) => w.dayId === best.dayId);
  const col = waypoints
    .filter((w) => w.kind === 'col' && !w.isDetour)
    .sort((a, b) => (b.elevation_m || 0) - (a.elevation_m || 0))[0];
  return col ? col.name : best.stage || '';
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

function renderVariantToggle() {
  const container = document.getElementById('variant-toggle');
  const options = [
    { key: 'shortcut', label: 'With shortcuts' },
    { key: 'classic', label: 'Classic TMB' },
  ];
  container.innerHTML = options
    .map(
      (option) =>
        `<button type="button" data-variant="${option.key}" aria-pressed="${
          option.key === state.variant
        }">${option.label}</button>`
    )
    .join('');

  container.onclick = (event) => {
    const button = event.target.closest('[data-variant]');
    if (!button || button.dataset.variant === state.variant) return;
    store.setPref('variant', button.dataset.variant);
    window.location.reload();
  };
}

function renderDayList() {
  const settings = store.get('settings');
  const list = document.getElementById('day-list');

  list.innerHTML = state.calendar
    .map((day) => {
      const leg = state.legs.get(day.id);
      const isHike = day.kind === 'hike';
      const href = isHike ? `day.html?d=${encodeURIComponent(day.id)}` : null;
      const title = day.stage || day.label || '';

      let meta = '';
      if (isHike && leg?.stats) {
        const timing = schedule.legDuration(leg, settings.pace);
        meta = `
          <div class="day-item__meta">
            <span>${units.distance(leg.stats.distance_m)}</span>
            <span>${units.elevationDelta(leg.stats.gain_m, 'gain')}</span>
            <span>${units.elevationDelta(leg.stats.loss_m, 'loss')}</span>
            <span>${units.duration(timing.totalHours)}</span>
            ${
              leg.transitDistance_m
                ? `<span class="faint">+ ${units.distance(leg.transitDistance_m)} transit</span>`
                : ''
            }
          </div>`;
      } else if (day.note) {
        meta = `<div class="day-item__meta"><span>${day.note}</span></div>`;
      }

      const label = `
        <div class="day-item__top">
          <span class="day-item__date">${schedule.formatDate(day.date)}</span>
          ${
            isHike
              ? `<span class="chip chip--accent">Day ${day.hikeNumber}</span>`
              : day.kind === 'rest'
                ? '<span class="chip chip--info">Rest</span>'
                : '<span class="chip">Travel</span>'
          }
        </div>
        <div class="day-item__stage">${title}</div>
        ${meta}
      `;

      return href
        ? `<li><a class="day-item" data-kind="${day.kind}" href="${href}">${label}</a></li>`
        : `<li><div class="day-item" data-kind="${day.kind}">${label}</div></li>`;
    })
    .join('');
}

main().catch(showLoadError);
