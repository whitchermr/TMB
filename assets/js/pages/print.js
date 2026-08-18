/**
 * Printable trail brief, and a single-file export of every data file.
 *
 * The phone is the primary way everyone will read this, but phones die and the
 * Alps have long stretches without signal, so this renders the same numbers as
 * a paper brief: one page per hiking day with the profile, the timings, the
 * scenery stops and where we sleep that night.
 *
 * Profiles are inline SVG rather than the interactive canvas chart, because SVG
 * prints at printer resolution and needs no layout pass to size itself.
 */

import * as store from '../core/store.js';
import * as units from '../core/units.js';
import * as schedule from '../core/schedule.js';
import * as sun from '../core/sun.js';
import * as money from '../core/money.js';
import { locateWaypoints, facingLabel } from '../core/geo.js';
import { escapeHtml } from '../ui/map.js';
import { mountChrome, showLoadError, onRefresh } from '../ui/nav.js';

const state = { legs: new Map() };

const OPTIONS = {
  scenery: 'opt-scenery',
  lodging: 'opt-lodging',
  profile: 'opt-profile',
  money: 'opt-money',
};

async function main() {
  mountChrome();
  await store.init();

  state.legIndex = await store.loadRouteFile('legIndex');
  state.anchors = (await store.loadRouteFile('anchors')).anchors;

  await Promise.all(
    state.legIndex.map(async (entry) => {
      state.legs.set(
        `${entry.dayId}-${entry.variant}`,
        await store.loadLeg(entry.dayId, entry.variant)
      );
    })
  );

  wireControls();
  render();
  onRefresh(render);
}

function wireControls() {
  document.getElementById('print').addEventListener('click', () => window.print());
  document.getElementById('export-all').addEventListener('click', exportBundle);

  Object.entries(OPTIONS).forEach(([key, id]) => {
    const input = document.getElementById(id);
    const saved = store.pref(`brief:${key}`);
    if (saved !== null) input.checked = Boolean(saved);
    input.addEventListener('change', () => {
      store.setPref(`brief:${key}`, input.checked);
      render();
    });
  });
}

function shown(key) {
  return document.getElementById(OPTIONS[key])?.checked ?? true;
}

/**
 * Every editable file in one download, so the trip can be backed up or handed
 * over in a single step instead of seven.
 */
function exportBundle() {
  const bundle = {
    $comment:
      'TMB trip snapshot. Each key matches a file under data/. Import the ' +
      'individual sections from the unsaved-changes dialog, or commit them ' +
      'over the matching files.',
    exportedAt: new Date().toISOString(),
    files: Object.fromEntries(
      Object.keys(store.FILES).map((name) => [store.pathFor(name), store.get(name)])
    ),
  };

  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tmb-trip-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
/* rendering                                                          */
/* ------------------------------------------------------------------ */

function render() {
  const settings = store.get('settings');
  const itinerary = store.get('itinerary');
  const calendar = schedule.buildCalendar(itinerary, settings.trip.startDate);
  const hikeDays = calendar.filter((day) => day.kind === 'hike');

  const sections = [
    coverSection(settings, calendar, hikeDays),
    ...calendar.map((day) => daySection(day, settings)).filter(Boolean),
    shown('money') ? moneySection(settings) : '',
  ];

  document.getElementById('brief').innerHTML = sections.filter(Boolean).join('');
  document.getElementById('brief-foot').textContent =
    `${settings.trip.name} — printed ${schedule.formatDate(
      new Date().toISOString().slice(0, 10),
      { weekday: false, year: true }
    )}. Trail data © OpenStreetMap contributors.`;
}

/* cover ------------------------------------------------------------- */

function coverSection(settings, calendar, hikeDays) {
  const legs = hikeDays.map((day) => legFor(day, settings)).filter(Boolean);
  const totals = schedule.tripTotals(legs);
  const totalHours = legs.reduce(
    (sum, leg) => sum + schedule.legDuration(leg, settings.pace).totalHours,
    0
  );
  const people = store.get('people').people;
  const startHour = sun.parseHour(settings.pace.startTime) ?? 8;

  const rows = calendar
    .map((day) => {
      if (day.kind !== 'hike') {
        return `
          <tr>
            <td>${schedule.formatDate(day.date)}</td>
            <td>—</td>
            <td colspan="5">${escapeHtml(day.label || '')}</td>
            <td>${escapeHtml(state.anchors[day.stayAt]?.name || '')}</td>
          </tr>`;
      }
      const leg = legFor(day, settings);
      if (!leg) return '';
      const timing = schedule.legDuration(leg, settings.pace);
      return `
        <tr>
          <td>${schedule.formatDate(day.date)}</td>
          <td class="num">${day.hikeNumber}</td>
          <td>${escapeHtml(day.stage || '')}</td>
          <td class="num">${units.distance(leg.stats.distance_m)}</td>
          <td class="num">${units.elevationDelta(leg.stats.gain_m, 'gain')}</td>
          <td class="num">${units.elevationDelta(leg.stats.loss_m, 'loss')}</td>
          <td class="num">${units.duration(timing.totalHours)}</td>
          <td>${escapeHtml(state.anchors[day.stayAt]?.name || '')}</td>
        </tr>`;
    })
    .join('');

  return `
    <section class="brief__day">
      <h1>${escapeHtml(settings.trip.name)}</h1>
      <p class="muted">
        ${schedule.formatDate(calendar[0]?.date, { weekday: true, year: true })}
        –
        ${schedule.formatDate(calendar[calendar.length - 1]?.date, {
          weekday: true,
          year: true,
        })}
        · ${hikeDays.length} hiking days · walking from
        ${escapeHtml(settings.pace.startTime || '08:00')} at
        ${units.speed(settings.pace.flatSpeedKmh)} on the flat
      </p>

      <div class="stats" style="margin:.7rem 0">
        ${stat('Distance', units.distance(totals.distance_m), 'on foot')}
        ${stat('Ascent', units.elevationDelta(totals.gain_m, 'gain'), '', 'gain')}
        ${stat('Descent', units.elevationDelta(totals.loss_m, 'loss'), '', 'loss')}
        ${stat('On foot', units.duration(totalHours), 'estimated moving + breaks')}
        ${stat('High point', units.elevation(totals.maxElevation_m), '')}
      </div>

      <h2>Walkers</h2>
      <p>${people.map((person) => escapeHtml(person.name)).join(' · ') || '—'}</p>

      <h2 style="margin-top:.6rem">Itinerary</h2>
      <table class="brief-table">
        <thead>
          <tr>
            <th>Date</th><th class="num">Day</th><th>Stage</th>
            <th class="num">Dist</th><th class="num">Up</th><th class="num">Down</th>
            <th class="num">Time</th><th>Sleep</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="faint" style="margin-top:.5rem;font-size:.78rem">
        Times assume a ${startHour ? sun.formatHour(startHour) : '08:00'} start,
        ${settings.pace.breakMinutesPerHour} min of breaks per walking hour and a
        ${settings.pace.lunchMinutes} min lunch, using
        ${schedule.MODELS[settings.pace.model]?.label || settings.pace.model}.
        Treat them as a range, not a promise.
      </p>
    </section>
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

/* per day ----------------------------------------------------------- */

function daySection(day, settings) {
  if (day.kind !== 'hike') return restSection(day, settings);

  const leg = legFor(day, settings);
  if (!leg) return '';

  const timing = schedule.legDuration(leg, settings.pace);
  const startHour = sun.parseHour(settings.pace.startTime) ?? 8;
  const finish = startHour + timing.totalHours;
  const start = state.anchors[day.from];
  const times = start ? sun.sunTimes(day.date, start.lat, start.lon) : null;

  const waypoints = locateWaypoints(
    store.get('waypoints').waypoints.filter((point) => point.dayId === day.id),
    leg.track,
    leg.cumulative_m,
    leg.elevation_m
  );

  return `
    <section class="brief__day">
      <div class="row row--between" style="align-items:baseline">
        <h2>Day ${day.hikeNumber} — ${escapeHtml(day.stage || '')}</h2>
        <span class="faint">${schedule.formatDate(day.date, {
          weekday: true,
          year: true,
        })}</span>
      </div>
      <p class="muted" style="margin:.15rem 0 .5rem">
        ${escapeHtml(leg.label)}${
          leg.note ? ` · ${escapeHtml(leg.note)}` : ''
        }
      </p>

      <div class="stats" style="margin-bottom:.6rem">
        ${stat('Distance', units.distance(leg.stats.distance_m), '')}
        ${stat('Ascent', units.elevationDelta(leg.stats.gain_m, 'gain'), '', 'gain')}
        ${stat('Descent', units.elevationDelta(leg.stats.loss_m, 'loss'), '', 'loss')}
        ${stat('Time', units.duration(timing.totalHours), `${units.duration(timing.movingHours)} moving`)}
        ${stat(
          'Clock',
          `${sun.formatHour(startHour)} → ${sun.formatHour(finish)}`,
          times ? `sunset ${sun.formatHour(times.sunset)}` : ''
        )}
        ${stat('High point', units.elevation(leg.stats.maxElevation_m), '')}
      </div>

      ${shown('profile') ? profileSvg(leg, waypoints) : ''}

      <div class="brief__grid">
        <div>
          <h3>Along the way</h3>
          ${segmentTable(leg, settings, timing, startHour)}
        </div>
        <div>
          <h3>Light</h3>
          ${lightTable(day, times)}
        </div>
      </div>

      ${shown('scenery') ? sceneryTable(leg, settings, timing, startHour, waypoints, times) : ''}
      ${shown('lodging') ? lodgingBlock(day) : ''}
    </section>
  `;
}

function restSection(day, settings) {
  const stop = state.anchors[day.stayAt];
  const times = stop ? sun.sunTimes(day.date, stop.lat, stop.lon) : null;
  return `
    <section class="brief__day">
      <div class="row row--between" style="align-items:baseline">
        <h2>${escapeHtml(day.label || (day.kind === 'rest' ? 'Rest day' : 'Travel'))}</h2>
        <span class="faint">${schedule.formatDate(day.date, {
          weekday: true,
          year: true,
        })}</span>
      </div>
      ${day.note ? `<p class="muted">${escapeHtml(day.note)}</p>` : ''}
      ${
        times
          ? `<p class="faint">Sunrise ${sun.formatHour(times.sunrise)} ·
             sunset ${sun.formatHour(times.sunset)} at
             ${escapeHtml(stop.name)}</p>`
          : ''
      }
      ${shown('lodging') ? lodgingBlock(day) : ''}
    </section>
  `;
}

/**
 * Inline SVG profile. Uses a viewBox with no fixed size so the print
 * stylesheet can scale it to the page width without a re-render.
 */
function profileSvg(leg, waypoints) {
  const cum = leg.cumulative_m || [];
  const elevations = leg.elevation_m || [];
  if (cum.length < 2) return '';

  const W = 1000;
  const H = 200;
  const pad = { top: 10, right: 8, bottom: 22, left: 42 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const total = cum[cum.length - 1] || 1;
  const valid = elevations.filter((value) => value != null);
  const low = Math.min(...valid);
  const high = Math.max(...valid);
  const span = Math.max(120, high - low);
  const bottomValue = Math.max(0, low - span * 0.1);
  const topValue = high + span * 0.1;

  const x = (metres) => pad.left + (metres / total) * plotW;
  const y = (metres) =>
    pad.top + plotH - ((metres - bottomValue) / (topValue - bottomValue)) * plotH;

  const points = [];
  for (let i = 0; i < cum.length; i += 1) {
    if (elevations[i] == null) continue;
    points.push(`${x(cum[i]).toFixed(1)},${y(elevations[i]).toFixed(1)}`);
  }
  if (points.length < 2) return '';

  const area = `M${x(0).toFixed(1)},${(pad.top + plotH).toFixed(1)} L${points.join(
    ' L'
  )} L${x(total).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;

  const factor = units.isImperial() ? 3.28084 : 1;
  const gridStep = niceStep((topValue - bottomValue) * factor, 4) / factor;
  const grid = [];
  for (
    let value = Math.ceil(bottomValue / gridStep) * gridStep;
    value <= topValue;
    value += gridStep
  ) {
    grid.push(`
      <line x1="${pad.left}" y1="${y(value).toFixed(1)}" x2="${W - pad.right}"
        y2="${y(value).toFixed(1)}" stroke="#c9cec9" stroke-width="0.8" />
      <text x="${pad.left - 5}" y="${(y(value) + 3.5).toFixed(1)}" font-size="11"
        text-anchor="end" fill="#6b736d">${Math.round(value * factor).toLocaleString()}</text>
    `);
  }

  const displayMax = units.toDisplayDistance(total);
  const distStep = niceStep(displayMax, 5);
  const ticks = [];
  for (let value = 0; value <= displayMax + 1e-9; value += distStep) {
    const metres = units.isImperial() ? value * 1609.344 : value * 1000;
    if (metres > total) break;
    ticks.push(`
      <line x1="${x(metres).toFixed(1)}" y1="${pad.top}" x2="${x(metres).toFixed(1)}"
        y2="${pad.top + plotH}" stroke="#e0e3df" stroke-width="0.8" />
      <text x="${x(metres).toFixed(1)}" y="${H - 8}" font-size="11" text-anchor="middle"
        fill="#6b736d">${Number(value.toFixed(distStep < 1 ? 1 : 0))}</text>
    `);
  }

  const marks = waypoints
    .filter((point) => point.position_m != null && point.priority === 1)
    .map(
      (point) => `
        <line x1="${x(point.position_m).toFixed(1)}" y1="${pad.top}"
          x2="${x(point.position_m).toFixed(1)}" y2="${pad.top + plotH}"
          stroke="#7c4512" stroke-width="0.9" stroke-dasharray="3 2" />
        <circle cx="${x(point.position_m).toFixed(1)}" cy="${pad.top + 3}" r="3"
          fill="#7c4512" />`
    )
    .join('');

  return `
    <svg class="brief__profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      role="img" aria-label="Elevation profile for ${escapeHtml(leg.stage || 'the day')}">
      ${grid.join('')}
      ${ticks.join('')}
      <path d="${area}" fill="#1d4d35" fill-opacity="0.14" />
      <polyline points="${points.join(' ')}" fill="none" stroke="#1d4d35"
        stroke-width="1.8" stroke-linejoin="round" />
      ${marks}
      <text x="${W - pad.right}" y="${H - 8}" font-size="11" text-anchor="end"
        fill="#3a403c">${units.distanceUnit()}</text>
      <text x="4" y="${pad.top + 4}" font-size="11" fill="#3a403c">${units.elevationUnit()}</text>
    </svg>
  `;
}

function niceStep(range, target) {
  const raw = range / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw || 1));
  const normalised = raw / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

function segmentTable(leg, settings, timing, startHour) {
  const rows = leg.segments
    .map((segment) => {
      const from = state.anchors[segment.from]?.name || segment.from;
      const to = state.anchors[segment.to]?.name || segment.to;
      if (segment.type === 'transit') {
        return `
          <tr>
            <td>${escapeHtml(from)} → ${escapeHtml(to)}</td>
            <td class="num">${units.distance(segment.distance_m)}</td>
            <td colspan="2">transit${
              segment.note ? ` — ${escapeHtml(segment.note)}` : ''
            }</td>
          </tr>`;
      }
      const endM = leg.cumulative_m[segment.trackEnd] ?? 0;
      const arrival = startHour + schedule.elapsedAt(leg, settings.pace, endM, timing);
      return `
        <tr>
          <td>${escapeHtml(from)} → ${escapeHtml(to)}</td>
          <td class="num">${units.distance(segment.distance_m)}</td>
          <td class="num">${units.elevationDelta(segment.gain_m, 'gain')}</td>
          <td class="num">${sun.formatHour(arrival)}</td>
        </tr>`;
    })
    .join('');

  return `
    <table class="brief-table">
      <thead>
        <tr><th>Section</th><th class="num">Dist</th><th class="num">Up</th><th class="num">By</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function lightTable(day, times) {
  if (!times) return '<p class="faint">No location for sun times.</p>';
  const entries = [
    ['First light', times.dawn],
    ['Sunrise', times.sunrise],
    ['Golden hour ends', times.goldenMorningEnd],
    ['Golden hour starts', times.goldenEveningStart],
    ['Sunset', times.sunset],
    ['Last light', times.dusk],
  ];
  return `
    <table class="brief-table">
      <tbody>
        ${entries
          .map(
            ([label, value]) =>
              `<tr><td>${label}</td><td class="num">${sun.formatHour(value)}</td></tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p class="faint" style="font-size:.75rem;margin-top:.3rem">
      Local time at ${escapeHtml(state.anchors[day.from]?.name || 'the start')}.
    </p>
  `;
}

function sceneryTable(leg, settings, timing, startHour, waypoints, times) {
  if (!waypoints.length) return '';
  const rows = waypoints
    .slice()
    .sort((a, b) => (a.position_m ?? 0) - (b.position_m ?? 0))
    .map((point) => {
      const arrival = startHour + schedule.elapsedAt(leg, settings.pace, point.position_m, timing);
      const match = sun.lightMatch(point.photo?.bestLight, arrival, times);
      return `
        <tr>
          <td class="num">${units.distance(point.position_m)}</td>
          <td>
            <strong>${escapeHtml(point.name)}</strong>${
              point.isDetour ? ' <span class="chip chip--info">detour</span>' : ''
            }
            ${
              point.photo?.subject
                ? `<br /><span class="faint">${escapeHtml(point.photo.subject)}</span>`
                : ''
            }
          </td>
          <td class="num">${units.elevation(point.elevation_m)}</td>
          <td class="num">${sun.formatHour(arrival)}</td>
          <td>
            ${escapeHtml(point.photo?.bestLight || 'any')}
            ${
              point.photo?.facing
                ? `<br /><span class="faint">facing ${escapeHtml(
                    facingLabel(point.photo.facing)
                  )}</span>`
                : ''
            }
            ${
              match === 'miss'
                ? '<br /><span class="faint">arriving outside that light</span>'
                : ''
            }
          </td>
        </tr>`;
    })
    .join('');

  return `
    <h3 style="margin-top:.7rem">Scenery and photo stops</h3>
    <table class="brief-table">
      <thead>
        <tr>
          <th class="num">At</th><th>Stop</th><th class="num">Elev</th>
          <th class="num">ETA</th><th>Best light</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function lodgingBlock(day) {
  if (!day.stayAt) return '';
  const stop = store.get('stays').stops.find((entry) => entry.stopId === day.stayAt);
  if (!stop) return '';

  const rates = store.get('rates');
  const booked = stop.options?.find((option) => option.id === stop.bookedOptionId);

  if (booked) {
    return `
      <h3 style="margin-top:.7rem">Tonight — ${escapeHtml(stop.label)}</h3>
      <p class="print-url">
        <strong>${escapeHtml(booked.name)}</strong>
        <span class="chip chip--accent">booked</span>
        · ${escapeHtml(booked.type || 'lodging')}
        · ${money.formatMoney(booked.pricePerPerson, booked.currency, rates)} per person
        ${booked.halfBoard ? ' · half board' : ''}
        ${booked.phone ? `<br />${escapeHtml(booked.phone)}` : ''}
        ${booked.bookingRef ? `<br />Ref ${escapeHtml(booked.bookingRef)}` : ''}
        ${booked.url ? `<br /><a href="${escapeHtml(booked.url)}">${escapeHtml(booked.url)}</a>` : ''}
        ${booked.note ? `<br /><span class="faint">${escapeHtml(booked.note)}</span>` : ''}
      </p>
    `;
  }

  const candidates = (stop.options || []).slice(0, 4);
  return `
    <h3 style="margin-top:.7rem">Tonight — ${escapeHtml(stop.label)}</h3>
    <p class="faint" style="margin:0 0 .3rem">Not booked yet. Candidates:</p>
    ${
      candidates.length
        ? `<table class="brief-table">
            <tbody>
              ${candidates
                .map(
                  (option) => `
                    <tr>
                      <td>${escapeHtml(option.name)}</td>
                      <td>${escapeHtml(option.type || '')}</td>
                      <td class="num">${money.formatMoney(
                        option.pricePerPerson,
                        option.currency,
                        rates
                      )}</td>
                      <td>${escapeHtml(option.status || '')}</td>
                    </tr>`
                )
                .join('')}
            </tbody>
          </table>`
        : '<p class="faint">No options recorded.</p>'
    }
  `;
}

/* money ------------------------------------------------------------- */

function moneySection(settings) {
  const peopleFile = store.get('people');
  const headcount = peopleFile.people.length || 1;
  const rates = store.get('rates');
  const expenses = [
    ...store.get('expenses').expenses,
    ...money.derivedStayExpenses(store.get('stays'), peopleFile, store.get('itinerary')),
  ];

  const projected = money.forecast(expenses, peopleFile, rates);
  const transfers = money.settleUp(money.balances(expenses, peopleFile, rates));

  return `
    <section class="brief__day">
      <h2>Money</h2>
      <div class="stats" style="margin:.6rem 0">
        ${stat('Projected total', money.formatBase(projected.total, rates), 'booked and estimated')}
        ${stat(
          'Per person',
          money.formatBase(projected.total / headcount, rates),
          `${headcount} walkers`
        )}
        ${stat(
          'Budget',
          money.formatBase(settings.money.budgetPerPerson, rates),
          'per person'
        )}
      </div>

      <h3>Settling up</h3>
      ${
        transfers.length
          ? `<table class="brief-table">
              <tbody>
                ${transfers
                  .map(
                    (transfer) => `
                      <tr>
                        <td>${escapeHtml(transfer.fromName)} pays
                            ${escapeHtml(transfer.toName)}</td>
                        <td class="num">${money.formatBase(transfer.amount, rates)}</td>
                      </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
          : '<p class="faint">Nothing outstanding on paid expenses.</p>'
      }
      <p class="faint" style="font-size:.78rem;margin-top:.4rem">
        Only expenses with a payer count toward settling up; estimates are in the
        projected total but not in the balances.
      </p>
    </section>
  `;
}

main().catch(showLoadError);
