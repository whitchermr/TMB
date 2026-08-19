/** Transit: how to get anywhere on the loop without walking there. */

import * as store from '../core/store.js';
import * as units from '../core/units.js';
import * as schedule from '../core/schedule.js';
import * as money from '../core/money.js';
import * as transit from '../core/transit.js';
import * as links from '../core/links.js';
import * as mapUi from '../ui/map.js';
import { escapeHtml } from '../ui/map.js';
import { mountChrome, showLoadError, onRefresh } from '../ui/nav.js';

const state = {
  ctx: null,
  calendar: [],
  selected: 0,
  detail: null,
  layers: [],
  markers: [],
};

const CONFIDENCE_CHIP = {
  'scheduled-2027': 'chip--accent',
  'pattern-2026': 'chip--info',
  estimate: 'chip--warm',
};

const MODE_LABEL = {
  bus: 'Bus',
  coach: 'Coach',
  train: 'Train',
  navette: 'Navette',
};

async function main() {
  mountChrome();
  await mapUi.whenLeafletReady();
  await store.init(['settings', 'itinerary', 'stays', 'transit', 'rates']);

  const settings = store.get('settings');
  state.calendar = schedule.buildCalendar(store.get('itinerary'), settings.trip.startDate);

  const anchors = (await store.loadRouteFile('anchors')).anchors;
  // The generated schedules file is optional in practice: it ships empty until
  // the GTFS pipeline has been run, and a missing one must leave the curated
  // patterns working rather than empty the page.
  let schedules = null;
  try {
    schedules = await store.loadRouteFile('transitSchedules');
  } catch (error) {
    console.warn('Transit schedules unavailable; using curated patterns only', error);
  }

  state.handle = mapUi.createMap('map', {
    basemap: store.pref('basemap', settings.map.defaultBasemap),
  });
  mapUi.mountBasemapControls(document.getElementById('map-controls'), state.handle);
  const setBasemap = state.handle.setBasemap;
  state.handle.setBasemap = (key) => {
    setBasemap(key);
    store.setPref('basemap', key);
  };

  buildContext(anchors, schedules);
  applyUrl();
  wireControls();
  render();
  onRefresh(() => {
    buildContext(anchors, schedules);
    render();
  });
}

function buildContext(anchors, schedules) {
  state.ctx = transit.context({
    transit: store.get('transit'),
    anchors,
    stays: store.get('stays'),
    schedules,
    pace: store.get('settings').pace,
    rates: store.get('rates'),
  });
}

/* ------------------------------------------------------------------ */
/* url and form state                                                  */
/* ------------------------------------------------------------------ */

/**
 * Read the query string into the form.
 *
 * `?day=day-04` is how the day page hands over, so arriving that way should land
 * on that day's two ends and its actual date rather than making someone re-pick
 * what they were already looking at.
 */
function applyUrl() {
  const params = new URLSearchParams(window.location.search);
  const groups = transit.placeGroups(state.ctx);
  const fallback = groups[0]?.places[0]?.id || '';

  fillPlaceSelect('from-place', groups);
  fillPlaceSelect('to-place', groups);

  const day = params.get('day')
    ? state.calendar.find((entry) => entry.id === params.get('day'))
    : null;

  const from = params.get('from') || day?.from || 'chamonix';
  const to = params.get('to') || day?.to || 'les-houches';
  setValue('from-place', transit.placeById(state.ctx, from) ? from : fallback);
  setValue('to-place', transit.placeById(state.ctx, to) ? to : fallback);
  setValue('journey-date', params.get('date') || day?.date || firstWalkingDate());
  setValue('journey-time', params.get('t') || '08:00');
  setValue('max-transfers', params.get('changes') || '2');
  setValue('search-input', params.get('q') || '');

  document.getElementById('journey-context').textContent = day
    ? `Prefilled from ${day.stage || day.label || day.id}`
    : '';
}

/** The first day anyone actually walks, which is the day after arrival. */
function firstWalkingDate() {
  const hike = state.calendar.find((day) => day.kind === 'hike');
  return hike?.date || state.calendar[0]?.date || '';
}

function fillPlaceSelect(id, groups) {
  document.getElementById(id).innerHTML = groups
    .map(
      (group) => `
        <optgroup label="${escapeHtml(group.label)}">
          ${group.places
            .map(
              (place) =>
                `<option value="${escapeHtml(place.id)}">${escapeHtml(place.name)}${
                  place.hasLodging ? ' — we sleep here' : ''
                }</option>`
            )
            .join('')}
        </optgroup>
      `
    )
    .join('');
}

function setValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value ?? '';
}

function readValue(id) {
  return document.getElementById(id)?.value || '';
}

function query() {
  return {
    from: readValue('from-place'),
    to: readValue('to-place'),
    date: readValue('journey-date'),
    time: readValue('journey-time') || '08:00',
    maxTransfers: Number(readValue('max-transfers')) || 0,
  };
}

/** Keep the address bar in step so a journey can be sent to someone. */
function pushUrl() {
  const { from, to, date, time, maxTransfers } = query();
  const params = new URLSearchParams({ from, to, date, t: time, changes: String(maxTransfers) });
  const search = readValue('search-input');
  if (search) params.set('q', search);
  // Reuse the current path rather than naming the page, so this survives a
  // rename and works unchanged under a GitHub Pages project subpath.
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

function wireControls() {
  ['from-place', 'to-place', 'journey-date', 'journey-time', 'max-transfers'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      state.selected = 0;
      state.detail = null;
      pushUrl();
      render();
    });
  });

  document.getElementById('swap-places').addEventListener('click', () => {
    const from = readValue('from-place');
    setValue('from-place', readValue('to-place'));
    setValue('to-place', from);
    state.selected = 0;
    pushUrl();
    render();
  });

  document.getElementById('search-input').addEventListener('input', () => {
    renderSearch();
    pushUrl();
  });

  // Delegated because both lists are rebuilt on every render.
  document.addEventListener('click', (event) => {
    const journey = event.target.closest?.('[data-journey]');
    if (journey) {
      state.selected = Number(journey.dataset.journey);
      render();
      return;
    }
    const service = event.target.closest?.('[data-service]');
    if (service) {
      state.detail = { kind: 'service', id: service.dataset.service };
      renderDetail();
      return;
    }
    const place = event.target.closest?.('[data-place]');
    if (place) {
      state.detail = { kind: 'place', id: place.dataset.place };
      renderDetail();
      return;
    }
    const pick = event.target.closest?.('[data-set-place]');
    if (pick) {
      setValue(pick.dataset.setField, pick.dataset.setPlace);
      state.selected = 0;
      pushUrl();
      render();
      return;
    }
    // A board row loads its own pair into the planner. Changes go to 3 because
    // several of these pairs genuinely need three vehicles, and a row that
    // advertised a connection the search below then failed to find would be
    // worse than no row at all.
    const plan = event.target.closest?.('[data-plan-from]');
    if (plan) {
      setValue('from-place', plan.dataset.planFrom);
      setValue('to-place', plan.dataset.planTo);
      setValue('journey-date', plan.dataset.planDate);
      setValue('journey-time', '06:00');
      setValue('max-transfers', '3');
      state.selected = 0;
      state.detail = null;
      pushUrl();
      render();
      document.getElementById('journey-context').textContent = plan.dataset.planLabel;
      document.getElementById('journeys-anchor')?.scrollIntoView({ behavior: 'smooth' });
    }
  });
}

/* ------------------------------------------------------------------ */
/* render                                                             */
/* ------------------------------------------------------------------ */

function render() {
  const options = query();
  state.journeys = transit.journeys(state.ctx, options);
  if (state.selected >= state.journeys.length) state.selected = 0;

  renderBoard();
  renderSummary(options);
  renderJourneys(options);
  renderOnDemand(options);
  renderSearch();
  renderDetail();
  renderProvenance();
  drawMap();
}

/**
 * One row per day of the trip: how to skip the walk, and how to reach the bed.
 *
 * This replaced a row of numbered buttons that only made sense if you already
 * knew what you were looking for. The realistic question is "can I skip Thursday,
 * and what does it cost" — so the answer is on the row, and the two dropdowns
 * below are for the case this board does not cover rather than the way in.
 */
function renderBoard() {
  const board = transit.dayOptions(state.ctx, state.calendar, { time: '06:00' });
  const skippable = board.filter((row) => row.skip?.reach === 'scheduled').length;
  const walking = board.filter((row) => row.skip).length;
  // Counted in the header because an unverified deadline buried on one row of
  // eleven is a thing nobody goes looking for until the evening it matters.
  const unverified = board
    .flatMap((row) => [row.toTrail, row.skip, row.toBed])
    .filter(
      (entry) => entry?.confidence === 'estimate' || entry?.lastDepartureConfidence === 'estimate'
    ).length;

  document.getElementById('board-summary').textContent = [
    `${skippable} of ${walking} walking days have a way round`,
    unverified ? `${unverified} rest on unverified timetables` : null,
    'tap a row to plan it',
  ]
    .filter(Boolean)
    .join(' · ');

  document.getElementById('trip-board').innerHTML = board.map(renderBoardRow).join('');
}

function renderBoardRow(row) {
  const { day } = row;
  // The arrival is Day 0 rather than "Travel": the group counts the trip from the
  // night it lands, so day 1 is the first day of walking and the numbering here
  // has to match the way people already talk about it.
  const label = day.hikeNumber
    ? `Day ${day.hikeNumber}`
    : day.kind === 'rest'
      ? 'Rest day'
      : day.index === 0
        ? 'Day 0'
        : 'Travel';

  return `
    <div class="board-row" data-day="${escapeHtml(day.id)}">
      <div class="board-row__head">
        <span class="board-row__day">${escapeHtml(label)}</span>
        <span class="board-row__date numeric">${escapeHtml(schedule.formatDate(day.date))}</span>
      </div>
      <div class="board-row__stage">${escapeHtml(day.stage || day.label || '')}</div>
      ${row.toTrail ? connectionRow('To the start', row.toTrail, day) : ''}
      ${row.skip ? connectionRow('Skip the walk', row.skip, day) : ''}
      ${renderBed(row, day)}
    </div>
  `;
}

/**
 * One tappable connection, carrying the numbers that decide whether to use it.
 *
 * The last departure is on the face of it rather than a click away, because it is
 * the only figure here that can strand someone: a walking day is a decision made
 * in the morning against a deadline in the evening.
 */
function connectionRow(label, connection, day) {
  const rates = store.get('rates');
  const quote = connection.onDemandFare;

  const chips = [];
  if (connection.reach === 'scheduled') {
    chips.push(
      `<span class="chip">${connection.departures.length} departure${
        connection.departures.length === 1 ? '' : 's'
      }</span>`
    );
    chips.push(
      `<span class="chip">${escapeHtml(transit.formatDuration(connection.fastestMinutes))}</span>`
    );
    if (connection.fromFare) {
      chips.push(
        `<span class="chip">${
          connection.fromFare.total === 0
            ? 'Free'
            : `from ${escapeHtml(money.formatBase(connection.fromFare.total, rates))}`
        }</span>`
      );
    }
    // The deadline is the one number here that can strand somebody, so when it
    // rests on an unverified timetable it says so on its face rather than in a
    // tooltip. The Martigny bed is reached on a PostBus pattern nobody has
    // confirmed for 2027, and a confident-looking 19:07 would be trusted.
    if (connection.lastDeparture != null) {
      const shaky = connection.lastDepartureConfidence === 'estimate';
      chips.push(
        `<span class="chip ${shaky ? 'chip--danger' : 'chip--warm'}" title="${escapeHtml(
          shaky
            ? 'This deadline comes from an unverified timetable. Check with the operator before relying on it.'
            : 'The last departure that still gets there today.'
        )}">
          last ${escapeHtml(transit.formatTime(connection.lastDeparture))}${
            shaky ? ' — unverified' : ''
          }
        </span>`
      );
    }
    if (connection.confidence) {
      chips.push(
        `<span class="chip ${CONFIDENCE_CHIP[connection.confidence] || ''}" title="${escapeHtml(
          transit.CONFIDENCE_LABELS[connection.confidence] || ''
        )}">${escapeHtml(
          transit.CONFIDENCE_LABELS[connection.confidence] || connection.confidence
        )}</span>`
      );
    }
  } else if (connection.reach === 'on-demand') {
    chips.push('<span class="chip chip--warm">No timetable — ring for a ride</span>');
  } else {
    chips.push('<span class="chip chip--danger">No road link on file</span>');
  }

  // Per vehicle, kept visibly apart from the per-person fare above: a taxi split
  // six ways and a bus ticket are not the same kind of number, and showing them
  // in the same units would make the taxi look like the cheap option.
  if (quote) {
    chips.push(
      `<span class="chip chip--info">taxi ${escapeHtml(
        money.formatMoney(quote.amount, quote.currency, rates)
      )} per vehicle${quote.upTo ? ` (up to ${quote.upTo})` : ''}</span>`
    );
  }

  return `
    <button class="board-conn" type="button"
      data-plan-from="${escapeHtml(connection.from)}"
      data-plan-to="${escapeHtml(connection.to)}"
      data-plan-date="${escapeHtml(connection.date)}"
      data-plan-label="${escapeHtml(`${label} — ${day.stage || day.label || day.id}`)}">
      <span class="board-conn__label">
        ${escapeHtml(label)}
        <small class="faint">${escapeHtml(
          transit.placeName(state.ctx, connection.from)
        )} → ${escapeHtml(transit.placeName(state.ctx, connection.to))}</small>
      </span>
      <span class="row row--tight board-conn__chips">${chips.join('')}</span>
    </button>
  `;
}

/**
 * Tonight's bed, and the ride to it when it is not where the day ends.
 *
 * Two of these nights are in a different town from the trail stop they serve, so
 * the hotel is named on the row rather than left to the Stays page — the ride and
 * the reason for the ride belong together.
 */
function renderBed(row, day) {
  if (!row.bed) return '';
  const option = row.bed.option;
  const detail = [];
  if (row.bed.offTrail) {
    detail.push(`down in ${transit.placeName(state.ctx, row.bed.placeId)}`);
  }
  if (option?.checkIn) detail.push(`check-in ${option.checkIn}`);

  return `
    <div class="board-row__bed">
      <span class="board-row__bed-name">
        ${escapeHtml(option ? option.name : 'No hotel recorded')}
        ${detail.length ? `<small class="faint">${escapeHtml(detail.join(' · '))}</small>` : ''}
      </span>
      ${option ? bedLinks(option) : ''}
    </div>
    ${row.toBed ? connectionRow('Ride to bed', row.toBed, day) : ''}
  `;
}

/** Directions, a phone number and the booking, for the hotel on this row. */
function bedLinks(option) {
  const maps = links.mapsUrls(option);
  const tel = links.telUrl(option.phone);
  const parts = [];

  if (maps) {
    parts.push(
      `<a class="btn btn--sm" href="${escapeHtml(maps.google)}" target="_blank" rel="noopener">Map</a>`
    );
  }
  if (tel) {
    parts.push(`<a class="btn btn--sm" href="${escapeHtml(tel)}">Call</a>`);
  }
  if (option.url) {
    parts.push(
      `<a class="btn btn--sm" href="${escapeHtml(
        option.url
      )}" target="_blank" rel="noopener">Booking</a>`
    );
  }
  return parts.length ? `<span class="row row--tight">${parts.join('')}</span>` : '';
}

function renderSummary({ from, to, date }) {
  const fromPlace = transit.placeById(state.ctx, from);
  const toPlace = transit.placeById(state.ctx, to);
  const best = state.journeys[0];
  const direct = transit.directDistanceM(state.ctx, from, to);

  document.getElementById('journey-heading').textContent =
    fromPlace && toPlace ? `${fromPlace.name} to ${toPlace.name}` : 'Journeys';
  document.getElementById('journey-count').textContent = date
    ? `${schedule.formatDate(date, { year: true })} · ${state.journeys.length} option${
        state.journeys.length === 1 ? '' : 's'
      }`
    : '';

  document.getElementById('journey-summary').innerHTML = [
    stat('Fastest', best ? transit.formatDuration(best.totalMinutes) : '—', best ? `arrive ${transit.formatTime(best.arriveMinutes)}` : 'no service'),
    stat('Changes', best ? String(best.transfers) : '—', best && best.walkMinutes ? `plus ${best.walkMinutes} min on foot` : 'vehicle to vehicle'),
    stat('Cheapest', cheapestLabel(), state.journeys.length ? 'one way, per person' : ''),
    stat('As the crow flies', direct != null ? units.distance(direct) : '—', 'straight line'),
  ].join('');
}

function cheapestLabel() {
  if (!state.journeys.length) return '—';
  const rates = store.get('rates');
  const priced = state.journeys.map((journey) => ({
    journey,
    total: journey.fares.reduce(
      (sum, fare) => sum + money.toBase(fare.amount, fare.currency, rates),
      0
    ),
  }));
  const best = priced.reduce((low, entry) => (entry.total < low.total ? entry : low), priced[0]);
  if (best.journey.free || best.total === 0) return 'Free';
  return money.formatBase(best.total, rates);
}

function stat(label, value, sub = '') {
  return `
    <div class="stat">
      <span class="stat__label">${escapeHtml(label)}</span>
      <span class="stat__value">${escapeHtml(value)}</span>
      ${sub ? `<span class="stat__sub">${escapeHtml(sub)}</span>` : ''}
    </div>
  `;
}

function renderJourneys({ from, to }) {
  const container = document.getElementById('journeys');
  if (!state.journeys.length) {
    container.innerHTML = emptyExplanation(from, to);
    return;
  }
  container.innerHTML = state.journeys
    .map((journey, index) => renderJourney(journey, index))
    .join('');
}

/**
 * Say why there is nothing, not just that there is nothing.
 *
 * Several of these pairs have no scheduled route at all — Les Chapieux to
 * Courmayeur is separated by a col with no road over it — and "no results" would
 * read as a broken page rather than the real answer, which is that the taxi
 * below is how it is done.
 */
function emptyExplanation(from, to) {
  const fromPlace = transit.placeById(state.ctx, from);
  const toPlace = transit.placeById(state.ctx, to);
  if (!fromPlace || !toPlace || from === to) {
    return '<p class="empty">Pick two different places.</p>';
  }

  const date = readValue('journey-date');
  const seasonal = transit
    .servicesAt(state.ctx, from)
    .filter((service) => service.season && !transit.runsOn(service, date));

  return `
    <div class="notice notice--caveat">
      <strong>No scheduled service found on this date.</strong>
      <p style="margin:.4rem 0 0">
        Nothing joins ${escapeHtml(fromPlace.name)} to ${escapeHtml(toPlace.name)} within
        ${escapeHtml(readValue('max-transfers'))} change${readValue('max-transfers') === '1' ? '' : 's'}
        after ${escapeHtml(readValue('journey-time'))}. Try allowing more changes, an earlier
        start, or one of the on-demand options below.
      </p>
      ${
        seasonal.length
          ? `<p style="margin:.4rem 0 0" class="faint">
              ${escapeHtml(seasonal.map((service) => service.name).join('; '))} —
              out of season on this date.
            </p>`
          : ''
      }
    </div>
  `;
}

function renderJourney(journey, index) {
  const rates = store.get('rates');
  const selected = index === state.selected;
  const fareText = journey.free
    ? 'Free'
    : journey.fares
        .map((fare) => money.formatMoney(fare.amount, fare.currency, rates))
        .join(' + ') || '—';

  return `
    <article class="journey" data-journey="${index}" data-selected="${selected}"
      role="button" tabindex="0">
      <div class="journey__top">
        <strong class="numeric">
          ${transit.formatTime(journey.departMinutes)} → ${transit.formatTime(journey.arriveMinutes)}
        </strong>
        <span class="journey__duration numeric">${escapeHtml(
          transit.formatDuration(journey.totalMinutes)
        )}</span>
      </div>
      <div class="row row--tight">
        <span class="chip">${journey.transfers} change${journey.transfers === 1 ? '' : 's'}</span>
        <span class="chip ${CONFIDENCE_CHIP[journey.confidence] || ''}"
          title="${escapeHtml(transit.CONFIDENCE_LABELS[journey.confidence] || '')}">
          ${escapeHtml(transit.CONFIDENCE_LABELS[journey.confidence] || journey.confidence)}
        </span>
        <span class="chip">${escapeHtml(fareText)}</span>
        ${journey.walkMinutes ? `<span class="chip">${journey.walkMinutes} min on foot</span>` : ''}
      </div>
      <div class="segments" style="margin-top:.5rem">
        ${journey.legs.map(renderLeg).join('')}
      </div>
    </article>
  `;
}

function renderLeg(leg) {
  const clock = `${transit.formatTime(leg.departMinutes)}–${transit.formatTime(leg.arriveMinutes)}`;
  const where = `${escapeHtml(transit.placeName(state.ctx, leg.from))} → ${escapeHtml(
    transit.placeName(state.ctx, leg.to)
  )}`;

  if (leg.kind === 'walk') {
    const climb =
      leg.ascent_m > 0
        ? ` · ${units.elevation(leg.ascent_m)} up`
        : leg.ascent_m < 0
          ? ` · ${units.elevation(-leg.ascent_m)} down`
          : '';
    return `
      <div class="segment">
        <span class="segment__num numeric">${clock}</span>
        <span class="segment__label">
          On foot — ${where}
          <small class="faint">${escapeHtml(units.distance(leg.distance_m))}${climb}</small>
        </span>
      </div>
    `;
  }

  const operator = transit.operatorById(state.ctx, leg.service.operator);
  return `
    <div class="segment segment--transit" data-service="${escapeHtml(leg.serviceId)}"
      role="button" tabindex="0" title="Show details for this service">
      <span class="segment__num numeric">${clock}</span>
      <span class="segment__label">
        ${escapeHtml(MODE_LABEL[leg.service.mode] || leg.service.mode)}${
          leg.service.line ? ` ${escapeHtml(leg.service.line)}` : ''
        } — ${where}
        <small class="faint">${escapeHtml(operator?.name || leg.service.operator)}</small>
      </span>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* on demand                                                          */
/* ------------------------------------------------------------------ */

function renderOnDemand({ from, to }) {
  const options = transit.onDemandBetween(state.ctx, from, to);
  const container = document.getElementById('on-demand');

  if (!options.length) {
    container.innerHTML =
      '<p class="empty">No taxi or transfer company on file covers both of these. Try a nearby hub.</p>';
    return;
  }

  const rates = store.get('rates');
  container.innerHTML = options
    .map((option) => {
      const operator = option.operatorRecord;
      const fares = option.quotedFares.length
        ? option.quotedFares
            .map(
              (fare) => `
                <div class="row row--tight">
                  <span class="chip">${escapeHtml(
                    money.formatMoney(fare.amount, fare.currency, rates)
                  )}</span>
                  <small class="faint">
                    ${fare.upTo ? `up to ${fare.upTo} people` : escapeHtml(fare.basis || '')}
                    ${fare.note ? ` · ${escapeHtml(fare.note)}` : ''}
                  </small>
                </div>
              `
            )
            .join('')
        : '<small class="faint">Ask for a quote — no published fare for this pair.</small>';

      return `
        <div class="option">
          <div class="option__top">
            <strong>${escapeHtml(option.name)}</strong>
            <span class="chip ${CONFIDENCE_CHIP[option.confidence] || ''}">${escapeHtml(
              transit.CONFIDENCE_LABELS[option.confidence] || option.confidence
            )}</span>
          </div>
          ${fares}
          ${option.leadTime ? `<div class="wp__notes">${escapeHtml(option.leadTime)}</div>` : ''}
          ${contactRow(operator)}
        </div>
      `;
    })
    .join('');
}

/**
 * Phone, hours and booking link for an operator.
 *
 * A `tel:` link rather than printed digits, because the realistic moment for
 * this is standing at a stop with one bar of signal.
 */
function contactRow(operator) {
  if (!operator) return '';
  return `
    <div class="row row--tight" style="margin-top:.35rem">
      ${
        operator.phone
          ? `<a class="btn btn--sm btn--primary" href="tel:${escapeHtml(operator.phone)}">
              Call ${escapeHtml(operator.phone)}
            </a>`
          : ''
      }
      ${
        operator.bookingUrl
          ? `<a class="btn btn--sm" href="${escapeHtml(operator.bookingUrl)}"
               target="_blank" rel="noopener noreferrer">Book</a>`
          : ''
      }
      ${
        operator.website && operator.website !== operator.bookingUrl
          ? `<a class="btn btn--sm" href="${escapeHtml(operator.website)}"
               target="_blank" rel="noopener noreferrer">Website</a>`
          : ''
      }
      ${
        operator.email
          ? `<a class="btn btn--sm" href="mailto:${escapeHtml(operator.email)}">Email</a>`
          : ''
      }
    </div>
    ${operator.hours ? `<small class="faint">${escapeHtml(operator.hours)}</small>` : ''}
  `;
}

/* ------------------------------------------------------------------ */
/* search                                                            */
/* ------------------------------------------------------------------ */

function renderSearch() {
  const term = readValue('search-input');
  const container = document.getElementById('search-results');
  if (!term.trim()) {
    container.innerHTML =
      '<p class="empty">Type to search places, lines, stop names and operators.</p>';
    return;
  }

  const hits = transit.search(state.ctx, term);
  if (!hits.length) {
    container.innerHTML = `<p class="empty">Nothing matches “${escapeHtml(term)}”.</p>`;
    return;
  }

  container.innerHTML = hits
    .map((hit) => {
      const actions =
        hit.kind === 'place'
          ? `<button class="btn btn--sm" data-set-place="${escapeHtml(hit.id)}"
               data-set-field="from-place">From</button>
             <button class="btn btn--sm" data-set-place="${escapeHtml(hit.id)}"
               data-set-field="to-place">To</button>`
          : '';
      const attribute = hit.kind === 'service' ? 'data-service' : 'data-place';
      return `
        <div class="option">
          <div class="option__top">
            <strong ${hit.kind === 'operator' ? '' : `${attribute}="${escapeHtml(hit.id)}"`}
              role="button" tabindex="0" style="cursor:pointer">
              ${escapeHtml(hit.label)}
            </strong>
            <span class="chip">${escapeHtml(hit.kind)}</span>
          </div>
          ${hit.sub ? `<small class="faint">${escapeHtml(hit.sub)}</small>` : ''}
          ${actions ? `<div class="row row--tight" style="margin-top:.35rem">${actions}</div>` : ''}
        </div>
      `;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* detail panel                                                       */
/* ------------------------------------------------------------------ */

function renderDetail() {
  const container = document.getElementById('service-detail');
  const heading = document.getElementById('detail-heading');

  const target =
    state.detail ||
    (state.journeys?.[state.selected]?.legs.find((leg) => leg.kind === 'ride')
      ? {
          kind: 'service',
          id: state.journeys[state.selected].legs.find((leg) => leg.kind === 'ride').serviceId,
        }
      : null);

  if (!target) {
    heading.textContent = 'Details';
    container.innerHTML =
      '<p class="empty">Pick a journey leg, or a search result, to see stops, fares and who to ring.</p>';
    return;
  }

  if (target.kind === 'place') {
    const place = transit.placeById(state.ctx, target.id);
    if (!place) return;
    heading.textContent = place.name;
    container.innerHTML = renderPlaceDetail(place);
    return;
  }

  const service = transit.serviceById(state.ctx, target.id);
  if (!service) return;
  heading.textContent = service.name;
  container.innerHTML = renderServiceDetail(service);
}

function renderPlaceDetail(place) {
  const calling = transit.servicesAt(state.ctx, place.id);
  return `
    <div class="stack stack--tight">
      <div class="row row--tight">
        <span class="chip">${escapeHtml(place.role)}</span>
        ${place.country ? `<span class="chip">${escapeHtml(place.country)}</span>` : ''}
        ${place.hasLodging ? '<span class="chip chip--accent">we sleep here</span>' : ''}
        ${
          place.precision === 'approximate'
            ? '<span class="chip chip--warm">position approximate</span>'
            : ''
        }
      </div>
      ${place.stopName ? `<div><strong>Stop:</strong> ${escapeHtml(place.stopName)}</div>` : ''}
      ${place.address ? `<div class="faint">${escapeHtml(place.address)}</div>` : ''}
      ${place.note ? `<p class="wp__notes">${escapeHtml(place.note)}</p>` : ''}
      ${coordRow(place)}
      <div>
        <strong>Services calling here</strong>
        <div class="segments" style="margin-top:.35rem">
          ${
            calling.length
              ? calling
                  .map(
                    (service) => `
                      <div class="segment segment--transit" data-service="${escapeHtml(service.id)}"
                        role="button" tabindex="0">
                        <span class="segment__label">${escapeHtml(service.name)}</span>
                      </div>
                    `
                  )
                  .join('')
              : '<p class="empty">Nothing scheduled. On foot or by taxi only.</p>'
          }
        </div>
      </div>
    </div>
  `;
}

/**
 * Coordinates plus a wayfinding link.
 *
 * A geo: URI opens whatever map app the phone already has, including offline
 * ones, which matters more here than a link to a website that needs signal.
 */
function coordRow(place) {
  if (place.lat == null) return '';
  const pair = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
  return `
    <div class="row row--tight">
      <span class="mono faint">${escapeHtml(pair)}</span>
      <a class="btn btn--sm" href="geo:${place.lat},${place.lon}">Open in maps</a>
    </div>
  `;
}

function renderServiceDetail(service) {
  const operator = transit.operatorById(state.ctx, service.operator);
  const rates = store.get('rates');
  const date = readValue('journey-date');
  const departures = transit.departureTimes(service);

  return `
    <div class="stack stack--tight">
      <div class="row row--tight">
        <span class="chip">${escapeHtml(MODE_LABEL[service.mode] || service.mode)}</span>
        ${service.line ? `<span class="chip mono">${escapeHtml(service.line)}</span>` : ''}
        <span class="chip ${CONFIDENCE_CHIP[service.confidence] || ''}">${escapeHtml(
          transit.CONFIDENCE_LABELS[service.confidence] || service.confidence
        )}</span>
        ${
          service.fare
            ? `<span class="chip">${
                service.fare.basis === 'free'
                  ? 'Free'
                  : `${escapeHtml(
                      money.formatMoney(service.fare.amount, service.fare.currency, rates)
                    )} ${escapeHtml(service.fare.basis || '')}`
              }</span>`
            : ''
        }
        <span class="chip ${transit.runsOn(service, date) ? 'chip--accent' : 'chip--danger'}">
          ${transit.runsOn(service, date) ? 'runs on this date' : 'not on this date'}
        </span>
      </div>

      ${service.note ? `<p class="wp__notes">${escapeHtml(service.note)}</p>` : ''}

      <div>
        <strong>Stops</strong>
        <div class="segments" style="margin-top:.35rem">
          ${service.stops
            .map((stop) => {
              const place = transit.placeById(state.ctx, stop.place);
              return `
                <div class="segment" data-place="${escapeHtml(stop.place)}"
                  role="button" tabindex="0">
                  <span class="segment__num numeric">+${stop.offsetMinutes} min</span>
                  <span class="segment__label">
                    ${escapeHtml(place?.name || stop.place)}
                    ${place?.stopName ? `<small class="faint">${escapeHtml(place.stopName)}</small>` : ''}
                  </span>
                </div>
              `;
            })
            .join('')}
        </div>
        ${
          service.bidirectional
            ? '<small class="faint">Also runs the other way along the same stops.</small>'
            : ''
        }
      </div>

      <div>
        <strong>Departures from ${escapeHtml(
          transit.placeName(state.ctx, service.stops[0].place)
        )}</strong>
        <p class="numeric" style="margin:.25rem 0 0">
          ${departures.map((time) => transit.formatTime(time)).join(' · ') || '—'}
        </p>
        ${
          service.frequency
            ? `<small class="faint">
                Every ${escapeHtml(String(service.frequency.everyMinutes))} minutes,
                ${escapeHtml(service.frequency.first)} to ${escapeHtml(service.frequency.last)}.
              </small>`
            : ''
        }
      </div>

      ${seasonRow(service)}
      ${bookingRow(service)}
      ${
        service.caveat
          ? `<p class="notice notice--caveat" style="margin:0">${escapeHtml(service.caveat)}</p>`
          : ''
      }
      ${contactRow(operator)}
      ${operator?.note ? `<small class="faint">${escapeHtml(operator.note)}</small>` : ''}
      ${sourceRow(service)}
    </div>
  `;
}

function seasonRow(service) {
  const days = service.days;
  const dayText =
    !days || days === 'daily'
      ? 'Every day'
      : Array.isArray(days)
        ? days.map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ')
        : String(days);
  return `
    <div>
      <strong>When it runs</strong>
      <div class="faint">
        ${escapeHtml(dayText)}${
          service.season
            ? ` · ${escapeHtml(monthDay(service.season.from))} to ${escapeHtml(
                monthDay(service.season.to)
              )}`
            : ' · all year'
        }
      </div>
    </div>
  `;
}

function monthDay(value) {
  const [month, day] = String(value).split('-');
  const names = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${Number(day)} ${names[Number(month) - 1] || month}`;
}

function bookingRow(service) {
  const booking = service.booking;
  if (!booking) return '';
  return `
    <div>
      <strong>Tickets</strong>
      <div class="faint">${escapeHtml(booking.where || booking.kind || '')}</div>
      ${booking.note ? `<div class="wp__notes">${escapeHtml(booking.note)}</div>` : ''}
      ${
        booking.url
          ? `<div class="row row--tight" style="margin-top:.35rem">
              <a class="btn btn--sm btn--primary" href="${escapeHtml(booking.url)}"
                 target="_blank" rel="noopener noreferrer">Buy a ticket</a>
            </div>`
          : ''
      }
    </div>
  `;
}

/**
 * Where the record came from and when someone last checked.
 *
 * Not decoration: these are third-party timetables under their own terms, and
 * the trip is far enough out that every French and Italian season here will be
 * republished before anyone travels.
 */
function sourceRow(service) {
  const parts = [];
  if (service.source?.url) {
    parts.push(
      `<a href="${escapeHtml(service.source.url)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(service.source.title || service.source.url)}
      </a>`
    );
  }
  if (service.scheduleSource) {
    parts.push(`feed: ${escapeHtml(service.scheduleSource)}`);
  }
  if (service.verifiedOn) {
    parts.push(`checked ${escapeHtml(schedule.formatDate(service.verifiedOn, { year: true }))}`);
  }
  return parts.length ? `<small class="faint">${parts.join(' · ')}</small>` : '';
}

function renderProvenance() {
  const feeds = state.ctx.sources;
  const byConfidence = transit.CONFIDENCE.map((level) => ({
    level,
    count: state.ctx.services.filter((service) => service.confidence === level).length,
  })).filter((entry) => entry.count);

  document.getElementById('provenance').innerHTML = `
    <div class="row row--tight">
      ${byConfidence
        .map(
          (entry) =>
            `<span class="chip ${CONFIDENCE_CHIP[entry.level]}">${entry.count} ${escapeHtml(
              transit.CONFIDENCE_LABELS[entry.level]
            )}</span>`
        )
        .join('')}
    </div>
    <p class="muted" style="margin:.6rem 0 0">
      Every service here is hand-recorded from an operator's own timetable, with
      the date it was checked. Swiss times can be re-derived from the published
      2027 timetable; the French and Italian summer seasons will be republished
      before the trip, so treat anything marked as a 2026 pattern as the right
      shape with the wrong minutes.
    </p>
    ${
      feeds.length
        ? `<div style="margin-top:.6rem">
            <strong>Feeds</strong>
            <ul class="faint" style="margin:.3rem 0 0; padding-left:1.1rem">
              ${feeds
                .map(
                  (feed) => `<li>
                    ${escapeHtml(feed.name || feed.id)}
                    ${feed.licence ? ` — ${escapeHtml(feed.licence)}` : ''}
                    ${
                      feed.attribution ? `<br /><small>${escapeHtml(feed.attribution)}</small>` : ''
                    }
                  </li>`
                )
                .join('')}
            </ul>
          </div>`
        : `<p class="faint" style="margin:.6rem 0 0">
            No GTFS extract has been generated yet, so every time on this page is
            the hand-recorded one. Run <code class="mono">tools/fetch_transit.py</code>
            to attach published times where a feed exists.
          </p>`
    }
    <p class="faint" style="margin:.6rem 0 0">
      Full provenance and the pre-travel re-verification checklist are in
      <code class="mono">docs/transit-notes.md</code>.
    </p>
  `;
}

/* ------------------------------------------------------------------ */
/* map                                                                */
/* ------------------------------------------------------------------ */

/**
 * Draw the selected journey as straight hops between its stops.
 *
 * Deliberately not road geometry: none is committed for these services, and
 * inventing a plausible-looking line would imply a precision that is not there.
 * Dashed segments read as "a vehicle goes between these two points".
 */
function drawMap() {
  state.layers.forEach((layer) => state.handle.map.removeLayer(layer));
  state.markers.forEach((marker) => state.handle.map.removeLayer(marker));
  state.layers = [];
  state.markers = [];

  const journey = state.journeys[state.selected];
  const points = [];

  if (journey) {
    journey.legs.forEach((leg) => {
      const a = transit.coordsOf(state.ctx, leg.from);
      const b = transit.coordsOf(state.ctx, leg.to);
      if (!a || !b) return;
      const layer = mapUi.drawTrack(state.handle.map, [a, b], {
        color:
          leg.kind === 'walk'
            ? mapUi.VARIANT_COLORS.shortcut
            : mapUi.VARIANT_COLORS.transit,
        weight: leg.kind === 'walk' ? 4 : 3,
        dashArray: leg.kind === 'walk' ? null : '2 7',
      });
      if (layer) state.layers.push(layer);
      points.push(a, b);
    });

    const stops = [];
    journey.legs.forEach((leg, index) => {
      if (index === 0) stops.push({ id: leg.from, number: 'A' });
      stops.push({ id: leg.to, number: index === journey.legs.length - 1 ? 'B' : String(index + 1) });
    });
    state.markers.push(
      ...mapUi.addStopMarkers(
        state.handle.map,
        stops
          .map((stop) => {
            const place = transit.placeById(state.ctx, stop.id);
            return place && place.lat != null ? { ...place, number: stop.number } : null;
          })
          .filter(Boolean)
      )
    );
  } else {
    // Nothing runs, so show where the two ends are — that is still the useful
    // thing to look at when working out whether a taxi is worth it.
    [readValue('from-place'), readValue('to-place')].forEach((id, index) => {
      const place = transit.placeById(state.ctx, id);
      if (!place || place.lat == null) return;
      points.push([place.lon, place.lat]);
      state.markers.push(
        ...mapUi.addStopMarkers(state.handle.map, [{ ...place, number: index ? 'B' : 'A' }])
      );
    });
  }

  if (points.length) mapUi.fitTo(state.handle.map, points);

  document.getElementById('map-legend').innerHTML = [
    `<span style="color:${mapUi.VARIANT_COLORS.transit}"><i class="dashed"></i> Scheduled service</span>`,
    `<span style="color:${mapUi.VARIANT_COLORS.shortcut}"><i></i> On foot</span>`,
    '<span class="faint">Straight hops between stops, not the road</span>',
  ].join('');
}

main().catch(showLoadError);
