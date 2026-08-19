/** Lodging: candidates versus the booked choice, per overnight stop. */

import * as store from '../core/store.js';
import * as units from '../core/units.js';
import * as schedule from '../core/schedule.js';
import * as money from '../core/money.js';
import { escapeHtml } from '../ui/map.js';
import { mountChrome, showLoadError, onRefresh, openChangesDialog } from '../ui/nav.js';

const state = { editing: null };

const STATUS_CHIP = {
  idea: '',
  contacted: 'chip--info',
  held: 'chip--warm',
  booked: 'chip--accent',
  rejected: 'chip--danger',
};

async function main() {
  mountChrome();
  await store.init(['settings', 'itinerary', 'stays', 'people', 'rates']);
  state.anchors = (await store.loadRouteFile('anchors')).anchors;

  wireDialog();
  render();
  onRefresh(render);
}

/** Nights per stop, derived from the itinerary rather than stored twice. */
function nightsByStop() {
  const nights = new Map();
  store.get('itinerary').days.forEach((day) => {
    if (!day.stayAt) return;
    nights.set(day.stayAt, (nights.get(day.stayAt) || 0) + 1);
  });
  return nights;
}

/** Which dates each stop is occupied, for display. */
function datesByStop() {
  const settings = store.get('settings');
  const calendar = schedule.buildCalendar(store.get('itinerary'), settings.trip.startDate);
  const dates = new Map();
  calendar.forEach((day) => {
    if (!day.stayAt) return;
    if (!dates.has(day.stayAt)) dates.set(day.stayAt, []);
    dates.get(day.stayAt).push(day.date);
  });
  return dates;
}

function render() {
  const stays = store.get('stays');
  const rates = store.get('rates');
  const people = store.get('people');
  const nights = nightsByStop();
  const dates = datesByStop();

  renderStats(stays, rates, people, nights);

  document.getElementById('stops').innerHTML = stays.stops
    .map((stop) => renderStop(stop, rates, people, nights, dates))
    .join('');

  document.querySelectorAll('[data-add-option]').forEach((button) => {
    button.addEventListener('click', () => openDialog(button.dataset.addOption, null));
  });
  document.querySelectorAll('[data-edit-option]').forEach((element) => {
    element.addEventListener('click', () => {
      openDialog(element.dataset.stop, element.dataset.editOption);
    });
  });
  document.querySelectorAll('[data-book]').forEach((button) => {
    button.addEventListener('click', () => {
      const { stop, book } = button.dataset;
      store.update('stays', (data) => {
        const target = data.stops.find((entry) => entry.stopId === stop);
        if (!target) return;
        // Clicking the booked option again releases it, which is the natural
        // way to undo a mis-click.
        target.bookedOptionId = target.bookedOptionId === book ? null : book;
      });
    });
  });
  document.querySelectorAll('[data-nights-for]').forEach((input) => {
    input.addEventListener('change', () => {
      store.update('stays', (data) => {
        const target = data.stops.find((entry) => entry.stopId === input.dataset.nightsFor);
        if (target) target.nights = Math.max(0, Number(input.value) || 0);
      });
    });
  });
}

function renderStats(stays, rates, people, nights) {
  const headcount = people.people.length || 1;
  let booked = 0;
  let estimated = 0;
  let bookedCount = 0;
  let openCount = 0;

  stays.stops.forEach((stop) => {
    if (stop.includeInBudget === false) return;
    const nightCount = stop.nights || nights.get(stop.stopId) || 1;
    const chosen = stop.options.find((option) => option.id === stop.bookedOptionId);
    const candidates = stop.options.filter((option) => option.status !== 'rejected');

    if (chosen) {
      bookedCount += 1;
      booked += money.toBase(chosen.pricePerPerson * nightCount, chosen.currency, rates);
    } else if (candidates.length) {
      openCount += 1;
      const cheapest = candidates.reduce(
        (best, option) => (!best || option.pricePerPerson < best.pricePerPerson ? option : best),
        null
      );
      estimated += money.toBase(
        cheapest.pricePerPerson * nightCount,
        cheapest.currency,
        rates
      );
    } else {
      openCount += 1;
    }
  });

  const totalPerPerson = booked + estimated;

  document.getElementById('stay-stats').innerHTML = `
    ${stat('Booked', String(bookedCount), `of ${bookedCount + openCount} stops`)}
    ${stat('Still open', String(openCount), openCount ? 'needs a decision' : 'all settled')}
    ${stat('Confirmed', money.formatBase(booked, rates), 'per person')}
    ${stat('Estimated', money.formatBase(estimated, rates), 'cheapest candidate')}
    ${stat('Lodging total', money.formatBase(totalPerPerson, rates), 'per person')}
    ${stat('Group total', money.formatBase(totalPerPerson * headcount, rates), `${headcount} people`)}
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

function renderStop(stop, rates, people, nights, dates) {
  const nightCount = stop.nights ?? nights.get(stop.stopId) ?? 1;
  const stopDates = dates.get(stop.stopId) || [];
  const anchor = state.anchors[stop.stopId];
  const excluded = stop.includeInBudget === false;

  const dateLabel = stopDates.length
    ? stopDates.map((date) => schedule.formatDate(date)).join(', ')
    : 'not scheduled';

  const options = stop.options.length
    ? stop.options
        .map((option) => renderOption(stop, option, nightCount, rates, people))
        .join('')
    : '<p class="empty">No options yet.</p>';

  return `
    <section class="card">
      <div class="card__head">
        <div>
          <h2>${escapeHtml(stop.label)}</h2>
          <small class="faint">
            ${escapeHtml(dateLabel)}
            ${anchor?.country ? ` · ${escapeHtml(anchor.country)}` : ''}
            ${excluded ? ' · excluded from the trail budget' : ''}
          </small>
        </div>
        <div class="row row--tight">
          <label class="row row--tight" style="gap:.3rem">
            <span class="faint" style="font-size:.78rem">Nights</span>
            <input type="number" min="0" step="1" value="${nightCount}"
              data-nights-for="${stop.stopId}" style="width:4.2rem" />
          </label>
          <a class="btn btn--sm" href="${transitLink(stop, stopDates[0])}"
             title="Buses, trains and taxis to and from here">Getting here</a>
          <button class="btn btn--sm" data-add-option="${stop.stopId}">Add option</button>
        </div>
      </div>
      <div class="card__body">
        <div class="stack stack--tight">${options}</div>
        ${
          stop.note
            ? `<p class="notice" style="margin-top:.75rem">${escapeHtml(stop.note)}</p>`
            : ''
        }
      </div>
    </section>
  `;
}

/**
 * Link to the transit page for arriving at this stop.
 *
 * Defaults the origin to base rather than the previous night's stop, because the
 * question a lodging card raises is "how do we get to this one" — usually asked
 * while booking, from home, before any walking has happened.
 */
function transitLink(stop, date) {
  const params = new URLSearchParams({ to: stop.stopId, t: '09:00' });
  if (stop.stopId === 'chamonix') params.set('from', 'geneva-airport');
  if (date) params.set('date', date);
  return `transit.html?${params}`;
}

function renderOption(stop, option, nightCount, rates, people) {
  const isBooked = stop.bookedOptionId === option.id;
  const perPerson = (option.pricePerPerson || 0) * nightCount;
  const payer = people.people.find((person) => person.id === option.paidBy);

  return `
    <div class="option" data-booked="${isBooked}" data-status="${option.status || 'idea'}">
      <div class="option__top">
        <strong>${escapeHtml(option.name)}</strong>
        <span class="option__price">
          ${money.formatMoney(option.pricePerPerson || 0, option.currency, rates)}
          <span class="faint" style="font-weight:500">/person/night</span>
        </span>
      </div>
      <div class="row row--tight">
        <span class="chip">${escapeHtml(option.type || 'hotel')}</span>
        <span class="chip ${STATUS_CHIP[option.status] || ''}">${escapeHtml(
          option.status || 'idea'
        )}</span>
        ${option.halfBoard ? '<span class="chip chip--accent">half board</span>' : ''}
        ${isBooked ? '<span class="chip chip--accent">our choice</span>' : ''}
        ${payer ? `<span class="chip">paid by ${escapeHtml(payer.name)}</span>` : ''}
        ${
          option.ref
            ? `<span class="chip mono">${escapeHtml(option.ref)}</span>`
            : ''
        }
      </div>
      ${
        nightCount > 1
          ? `<small class="faint numeric">
              ${nightCount} nights = ${money.formatMoney(perPerson, option.currency, rates)} per person
              (${money.formatBase(money.toBase(perPerson, option.currency, rates), rates)})
            </small>`
          : `<small class="faint numeric">
              ${money.formatBase(money.toBase(perPerson, option.currency, rates), rates)} per person
            </small>`
      }
      ${option.note ? `<div class="wp__notes">${escapeHtml(option.note)}</div>` : ''}
      <div class="row row--tight" style="margin-top:.2rem">
        <button class="btn btn--sm" data-stop="${stop.stopId}" data-edit-option="${option.id}">
          Edit
        </button>
        <button class="btn btn--sm ${isBooked ? '' : 'btn--primary'}"
          data-stop="${stop.stopId}" data-book="${option.id}">
          ${isBooked ? 'Un-book' : 'Mark as booked'}
        </button>
        ${
          option.url
            ? `<a class="btn btn--sm" href="${escapeHtml(option.url)}" target="_blank"
                 rel="noopener noreferrer">Open link</a>`
            : ''
        }
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* option dialog                                                       */
/* ------------------------------------------------------------------ */

function wireDialog() {
  const dialog = document.getElementById('option-dialog');

  document.getElementById('option-save').addEventListener('click', () => {
    const value = readDialog();
    if (!value.name) {
      window.alert('A name is required.');
      return;
    }

    store.update('stays', (data) => {
      const stop = data.stops.find((entry) => entry.stopId === state.editing.stopId);
      if (!stop) return;

      if (state.editing.optionId) {
        const index = stop.options.findIndex((entry) => entry.id === state.editing.optionId);
        if (index >= 0) stop.options[index] = { ...stop.options[index], ...value };
      } else {
        const id = store.newId('opt-');
        stop.options.push({ id, ...value });
        // Choosing "booked" while creating an option should also select it,
        // otherwise the status and the actual choice disagree.
        if (value.status === 'booked') stop.bookedOptionId = id;
      }

      if (state.editing.optionId && value.status === 'booked') {
        stop.bookedOptionId = state.editing.optionId;
      }
    });

    dialog.close();
    openChangesDialog('stays');
  });

  document.getElementById('option-delete').addEventListener('click', () => {
    if (!state.editing?.optionId) return dialog.close();
    if (!window.confirm('Delete this lodging option?')) return;
    store.update('stays', (data) => {
      const stop = data.stops.find((entry) => entry.stopId === state.editing.stopId);
      if (!stop) return;
      stop.options = stop.options.filter((entry) => entry.id !== state.editing.optionId);
      if (stop.bookedOptionId === state.editing.optionId) stop.bookedOptionId = null;
    });
    dialog.close();
  });
}

function openDialog(stopId, optionId) {
  state.editing = { stopId, optionId };
  const dialog = document.getElementById('option-dialog');
  const stop = store.get('stays').stops.find((entry) => entry.stopId === stopId);
  const option = optionId ? stop?.options.find((entry) => entry.id === optionId) : null;

  const currency = document.getElementById('option-currency');
  currency.innerHTML = store
    .get('rates')
    .rates.map((rate) => `<option value="${rate.currency}">${rate.currency}</option>`)
    .join('');

  const payer = document.getElementById('option-paidby');
  payer.innerHTML = `<option value="">— nobody yet —</option>${store
    .get('people')
    .people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join('')}`;

  document.getElementById('option-title').textContent = option
    ? `Edit — ${stop.label}`
    : `New option — ${stop.label}`;
  document.getElementById('option-delete').hidden = !option;

  const set = (id, value) => {
    document.getElementById(id).value = value ?? '';
  };
  set('option-name', option?.name);
  set('option-type', option?.type || 'hotel');
  set('option-price', option?.pricePerPerson);
  // Default to the local currency of the country the stop is in.
  const country = state.anchors[stopId]?.country || '';
  set('option-currency', option?.currency || (country.includes('CH') ? 'CHF' : 'EUR'));
  set('option-status', option?.status || 'idea');
  set('option-paidby', option?.paidBy || '');
  set('option-ref', option?.ref);
  set('option-url', option?.url);
  set('option-note', option?.note);
  document.getElementById('option-halfboard').checked = option?.halfBoard === true;

  dialog.showModal();
}

function readDialog() {
  const value = (id) => document.getElementById(id).value.trim();
  return {
    name: value('option-name'),
    type: value('option-type'),
    pricePerPerson: Number(value('option-price')) || 0,
    currency: value('option-currency'),
    status: value('option-status'),
    paidBy: value('option-paidby') || null,
    ref: value('option-ref'),
    url: value('option-url'),
    note: value('option-note'),
    halfBoard: document.getElementById('option-halfboard').checked,
  };
}

main().catch(showLoadError);
