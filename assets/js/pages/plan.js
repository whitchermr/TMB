/**
 * Planner: start date, rest days, pace model, and the resulting per-day times.
 *
 * Edits write straight into the settings and itinerary drafts, so the unsaved
 * badge appears and the numbers everywhere else follow the same values.
 */

import * as store from '../core/store.js';
import * as units from '../core/units.js';
import * as schedule from '../core/schedule.js';
import * as sun from '../core/sun.js';
import { locateWaypoints } from '../core/geo.js';
import { escapeHtml } from '../ui/map.js';
import { mountChrome, showLoadError, onRefresh } from '../ui/nav.js';

const state = { legs: new Map(), calendar: [] };

async function main() {
  mountChrome();
  await store.init(['settings', 'itinerary', 'waypoints']);

  state.legIndex = await store.loadRouteFile('legIndex');
  state.anchors = (await store.loadRouteFile('anchors')).anchors;

  await loadLegs();
  wireControls();
  render();

  onRefresh(render);
}

/** Load every variant of every day once, so switching options is instant. */
async function loadLegs() {
  await Promise.all(
    state.legIndex.map(async (entry) => {
      state.legs.set(
        `${entry.dayId}-${entry.variant}`,
        await store.loadLeg(entry.dayId, entry.variant)
      );
    })
  );
}

function legFor(day, settings) {
  const wanted = schedule.variantFor(day, settings);
  return (
    state.legs.get(`${day.legId}-${wanted}`) ||
    state.legs.get(
      `${day.legId}-${
        state.legIndex.find((entry) => entry.dayId === day.legId && !entry.optional)?.variant
      }`
    )
  );
}

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

function wireControls() {
  const settings = store.get('settings');

  const startDate = document.getElementById('start-date');
  startDate.value = settings.trip.startDate;
  startDate.addEventListener('change', () => {
    if (!startDate.value) return;
    store.update('settings', (data) => {
      data.trip.startDate = startDate.value;
    });
  });

  const startTime = document.getElementById('start-time');
  startTime.value = settings.pace.startTime || '08:00';
  startTime.addEventListener('change', () => {
    store.update('settings', (data) => {
      data.pace.startTime = startTime.value || '08:00';
    });
  });

  const pace = document.getElementById('pace');
  pace.value = settings.pace.flatSpeedKmh;
  const commitPace = () => {
    store.update('settings', (data) => {
      data.pace.flatSpeedKmh = Number(pace.value);
    });
  };
  pace.addEventListener('input', () => {
    document.getElementById('pace-value').textContent = units.speed(Number(pace.value));
  });
  pace.addEventListener('change', commitPace);

  const model = document.getElementById('model');
  model.value = settings.pace.model;
  model.addEventListener('change', () => {
    store.update('settings', (data) => {
      data.pace.model = model.value;
    });
  });

  const breaks = document.getElementById('breaks');
  breaks.value = settings.pace.breakMinutesPerHour;
  breaks.addEventListener('change', () => {
    store.update('settings', (data) => {
      data.pace.breakMinutesPerHour = Math.max(0, Number(breaks.value) || 0);
    });
  });

  const lunch = document.getElementById('lunch');
  lunch.value = settings.pace.lunchMinutes;
  lunch.addEventListener('change', () => {
    store.update('settings', (data) => {
      data.pace.lunchMinutes = Math.max(0, Number(lunch.value) || 0);
    });
  });

  const variant = document.getElementById('variant');
  variant.value = settings.defaultVariant;
  variant.addEventListener('change', () => {
    store.update('settings', (data) => {
      data.defaultVariant = variant.value;
    });
    store.setPref('variant', variant.value);
  });

  document.getElementById('add-rest').addEventListener('click', addRestDay);
}

function addRestDay() {
  const settings = store.get('settings');
  const calendar = schedule.buildCalendar(store.get('itinerary'), settings.trip.startDate);
  const hikeDays = calendar.filter((day) => day.kind === 'hike');

  const choice = window.prompt(
    `Insert a rest day after which hiking day? (1–${hikeDays.length})`,
    '3'
  );
  const number = Number(choice);
  if (!number || number < 1 || number > hikeDays.length) return;

  const after = hikeDays[number - 1];
  store.update('itinerary', (data) => {
    const position = data.days.findIndex((day) => day.id === after.id);
    const existing = data.days.filter((day) => day.kind === 'rest').length;
    data.days.splice(position + 1, 0, {
      id: `rest-${String(existing + 1).padStart(2, '0')}-${Date.now().toString(36)}`,
      kind: 'rest',
      label: `Rest day — ${state.anchors[after.to]?.name || 'on route'}`,
      stayAt: after.to,
      note: '',
    });
  });
}

function removeRestDay(id) {
  store.update('itinerary', (data) => {
    data.days = data.days.filter((day) => day.id !== id);
  });
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  const settings = store.get('settings');
  const itinerary = store.get('itinerary');
  state.calendar = schedule.buildCalendar(itinerary, settings.trip.startDate);

  document.getElementById('pace-value').textContent = units.speed(settings.pace.flatSpeedKmh);

  // The date field is the arrival day, not the first day of walking. Spelling
  // out the consequence stops the two being confused, which silently shifts the
  // whole trip by a day.
  const firstHike = state.calendar.find((day) => day.kind === 'hike');
  document.getElementById('start-date-note').textContent = firstHike
    ? `Hiking day 1 is ${schedule.formatDate(firstHike.date, { weekday: true, year: true })}`
    : 'No hiking days in the itinerary';

  document.getElementById('model-note').textContent =
    settings.pace.model === 'tobler'
      ? 'A continuous speed-versus-slope curve, fastest on a gentle downhill.'
      : 'One hour per 600 m of climb, with a credit for gentle descent and a penalty for steep descent.';

  renderStats(settings);
  renderRestDays();
  renderTable(settings);
  renderModelComparison(settings);
  renderLightTable(settings);
}

function renderStats(settings) {
  const hikeDays = state.calendar.filter((day) => day.kind === 'hike');
  const legs = hikeDays.map((day) => legFor(day, settings)).filter(Boolean);
  const totals = schedule.tripTotals(legs);

  const durations = legs.map((leg) => schedule.legDuration(leg, settings.pace).totalHours);
  const totalHours = durations.reduce((sum, hours) => sum + hours, 0);
  const longest = Math.max(...durations, 0);

  document.getElementById('plan-stats').innerHTML = `
    ${stat('Days out', String(state.calendar.length), 'including travel')}
    ${stat('Hiking', String(hikeDays.length), units.distance(totals.distance_m))}
    ${stat('Ascent', units.elevationDelta(totals.gain_m, 'gain'), '', 'gain')}
    ${stat('On foot', units.duration(totalHours), `${units.duration(totalHours / (hikeDays.length || 1))}/day avg`)}
    ${stat('Longest day', units.duration(longest), '')}
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

function renderRestDays() {
  const container = document.getElementById('rest-list');
  const rests = state.calendar.filter((day) => day.kind === 'rest');

  if (!rests.length) {
    container.innerHTML =
      '<p class="empty">No rest days. Adding one pushes every following day back by one.</p>';
    return;
  }

  container.innerHTML = `<div class="stack stack--tight" style="padding:.6rem">${rests
    .map(
      (rest) => `
        <div class="segment">
          <span class="chip chip--info">${schedule.formatDate(rest.date)}</span>
          <span class="segment__label">${escapeHtml(rest.label || 'Rest day')}</span>
          <button class="btn btn--sm btn--danger" data-remove="${rest.id}">Remove</button>
        </div>`
    )
    .join('')}</div>`;

  container.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => removeRestDay(button.dataset.remove));
  });
}

function renderTable(settings) {
  const body = document.querySelector('#plan-table tbody');
  const startHour = sun.parseHour(settings.pace.startTime) ?? 8;

  body.innerHTML = state.calendar
    .map((day) => {
      if (day.kind !== 'hike') {
        return `
          <tr class="is-rest">
            <td>${schedule.formatDate(day.date)}</td>
            <td>—</td>
            <td colspan="9">${escapeHtml(day.label || '')}${
              day.note ? ` <span class="faint">— ${escapeHtml(day.note)}</span>` : ''
            }</td>
          </tr>`;
      }

      const leg = legFor(day, settings);
      if (!leg) {
        return `<tr><td>${schedule.formatDate(day.date)}</td><td>${day.hikeNumber}</td>
          <td colspan="9" class="faint">No route data</td></tr>`;
      }

      const timing = schedule.legDuration(leg, settings.pace);
      const finish = startHour + timing.totalHours;
      const anchor = state.anchors[day.to] || state.anchors[day.from];
      const times = anchor ? sun.sunTimes(day.date, anchor.lat, anchor.lon) : null;
      const margin = times?.sunset != null ? times.sunset - finish : null;

      const options = state.legIndex.filter((entry) => entry.dayId === day.legId);
      const selected = leg.variant;

      const marginCell =
        margin == null
          ? '—'
          : margin < 0
            ? `<span class="chip chip--danger">${units.duration(-margin)} after dark</span>`
            : margin < 1.5
              ? `<span class="chip chip--warm">${units.duration(margin)}</span>`
              : `<span class="numeric">${units.duration(margin)}</span>`;

      return `
        <tr>
          <td>${schedule.formatDate(day.date)}</td>
          <td class="num">${day.hikeNumber}</td>
          <td>${escapeHtml(day.stage || '')}</td>
          <td>
            <select data-variant-for="${day.id}" aria-label="Route option for day ${day.hikeNumber}">
              ${options
                .map(
                  (entry) =>
                    `<option value="${entry.variant}"${
                      entry.variant === selected ? ' selected' : ''
                    }>${escapeHtml(entry.label)}</option>`
                )
                .join('')}
            </select>
          </td>
          <td class="num">${units.distance(leg.stats.distance_m)}</td>
          <td class="num">${units.elevationDelta(leg.stats.gain_m, 'gain')}</td>
          <td class="num">${units.elevationDelta(leg.stats.loss_m, 'loss')}</td>
          <td class="num">${units.duration(timing.totalHours)}</td>
          <td class="num">${sun.formatHour(finish)}</td>
          <td class="num">${sun.formatHour(times?.sunset)}</td>
          <td class="num">${marginCell}</td>
        </tr>`;
    })
    .join('');

  body.querySelectorAll('[data-variant-for]').forEach((select) => {
    select.addEventListener('change', () => {
      store.update('itinerary', (data) => {
        const day = data.days.find((entry) => entry.id === select.dataset.variantFor);
        if (day) day.variantOverride = select.value;
      });
    });
  });
}

function renderModelComparison(settings) {
  const hikeDays = state.calendar.filter((day) => day.kind === 'hike');
  const rows = hikeDays
    .map((day) => {
      const leg = legFor(day, settings);
      if (!leg) return null;
      return {
        day,
        naismith: schedule.legDuration(leg, { ...settings.pace, model: 'naismith' }).totalHours,
        tobler: schedule.legDuration(leg, { ...settings.pace, model: 'tobler' }).totalHours,
      };
    })
    .filter(Boolean);

  const max = Math.max(...rows.flatMap((row) => [row.naismith, row.tobler]), 1);

  document.getElementById('model-compare').innerHTML = `
    <div class="stack stack--tight">
      ${rows
        .map(
          (row) => `
            <div class="bar-row">
              <span>Day ${row.day.hikeNumber}</span>
              <span class="bar">
                <i style="width:${(row.naismith / max) * 100}%"></i>
                <i style="width:${(row.tobler / max) * 100}%;background:var(--c-warm);margin-top:-8px;height:3px;opacity:.9"></i>
              </span>
              <span class="numeric faint">${units.duration(row.naismith)}</span>
            </div>`
        )
        .join('')}
    </div>
    <p class="faint" style="margin:.6rem 0 0;font-size:.78rem">
      Green bars are Naismith, the thin orange overlay is Tobler. Where they
      diverge sharply the day has sustained steep ground, and the estimate is
      worth treating as a range rather than a number.
    </p>
  `;
}

function renderLightTable(settings) {
  const body = document.querySelector('#light-table tbody');
  const startHour = sun.parseHour(settings.pace.startTime) ?? 8;
  const allWaypoints = store.get('waypoints').waypoints;
  const rows = [];

  state.calendar
    .filter((day) => day.kind === 'hike')
    .forEach((day) => {
      const leg = legFor(day, settings);
      if (!leg) return;

      const dayWaypoints = allWaypoints.filter(
        (waypoint) => waypoint.dayId === day.id && waypoint.priority === 1
      );
      if (!dayWaypoints.length) return;

      const located = locateWaypoints(
        dayWaypoints,
        leg.track,
        leg.cumulative_m,
        leg.elevation_m
      );
      const timing = schedule.legDuration(leg, settings.pace);
      const anchor = state.anchors[day.from];
      const times = anchor ? sun.sunTimes(day.date, anchor.lat, anchor.lon) : null;

      located.forEach((waypoint) => {
        const arrival =
          startHour +
          schedule.elapsedAt(leg, settings.pace, waypoint.position_m, timing);
        rows.push({
          day,
          waypoint,
          arrival,
          window: sun.lightWindowAt(arrival, times),
          match: sun.lightMatch(waypoint.photo?.bestLight, arrival, times),
        });
      });
    });

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No priority scenery yet.</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map((row) => {
      const chip =
        row.match === 'match'
          ? 'chip--accent'
          : row.match === 'miss'
            ? 'chip--danger'
            : row.match === 'near'
              ? 'chip--warm'
              : '';
      return `
        <tr>
          <td class="num">${row.day.hikeNumber}</td>
          <td>${escapeHtml(row.waypoint.name)}${
            row.waypoint.isDetour ? ' <span class="chip chip--info">detour</span>' : ''
          }</td>
          <td class="num">${units.distance(row.waypoint.position_m)}</td>
          <td class="num">${sun.formatHour(row.arrival)}</td>
          <td>${escapeHtml(row.waypoint.photo?.bestLight || 'any')}</td>
          <td><span class="chip ${chip}">${sun.lightWindowLabel(row.window) || '—'}</span></td>
        </tr>`;
    })
    .join('');
}

main().catch(showLoadError);
