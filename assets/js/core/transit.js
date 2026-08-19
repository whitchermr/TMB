/**
 * Getting between places that are not joined by a day's walk.
 *
 * The trail is a loop of seven walking days, but the reasons to need this are
 * not: someone's knee gives out and they want to skip a day, a flight lands at
 * Geneva, a hut is full and the bed is down in Martigny instead. So this models
 * a small timetable graph — places, scheduled services, and the short road
 * walks that join them — and answers "how do I get from here to there on this
 * date" rather than storing a fixed set of hand-written journeys.
 *
 * Two things are deliberately modest about it. Journeys stay within one calendar
 * day, because nothing in these valleys runs overnight and pretending otherwise
 * would invent connections. And a service is one stopping pattern in one
 * direction, so a shuttle whose return times are not a mirror of its outbound
 * ones is two records, not one with exceptions.
 *
 * Like the other core modules this takes its data as an argument rather than
 * reading the store, so the whole thing runs under the test harness with nothing
 * but the JSON files on disk. Build a context once, then pass it around.
 */

import { haversine } from './geo.js';
import { MODELS } from './schedule.js';
import { toBase } from './money.js';

/** Minutes to allow when changing from one vehicle to another at a stop. */
export const MIN_TRANSFER_MINUTES = 5;

/**
 * Ordered worst to best. A journey is only as trustworthy as its shakiest leg,
 * so the UI shows the minimum across the legs rather than an average that would
 * hide an unverified connection inside an otherwise solid itinerary.
 */
export const CONFIDENCE = ['estimate', 'pattern-2026', 'scheduled-2027'];

export const CONFIDENCE_LABELS = {
  'scheduled-2027': 'Published 2027 timetable',
  'pattern-2026': '2026 pattern, times will shift',
  estimate: 'Indicative only — verify',
};

const ROLE_GROUPS = [
  { role: 'trailhead', label: 'On the trail' },
  { role: 'stop', label: 'Trail-side stops' },
  { role: 'hub', label: 'Hubs' },
  { role: 'rail', label: 'Stations' },
  { role: 'airport', label: 'Airports' },
];

const DEFAULT_PACE = { model: 'naismith', flatSpeedKmh: 4 };

/* ------------------------------------------------------------------ */
/* context                                                             */
/* ------------------------------------------------------------------ */

/**
 * Bundle the loaded data into one value the rest of the module reads.
 *
 * `schedules` is whatever tools/fetch_transit.py produced and is optional: it
 * ships as an empty placeholder until the pipeline has run, and a missing one
 * must fall back to the curated patterns rather than empty the graph.
 */
export function context({
  transit,
  anchors = {},
  stays = null,
  schedules = null,
  pace = null,
  rates = null,
}) {
  const scheduleIndex = new Map(
    (schedules?.services || []).map((entry) => [entry.serviceId, entry])
  );
  const lodging = new Set((stays?.stops || []).map((stop) => stop.stopId));

  const placeList = transit.places.map((place) => {
    const anchor = place.anchorId ? anchors[place.anchorId] : null;
    return {
      id: place.id,
      name: place.name || anchor?.name || place.id,
      role: place.role || 'stop',
      country: place.country || anchor?.country || '',
      lat: place.lat ?? anchor?.lat ?? null,
      lon: place.lon ?? anchor?.lon ?? null,
      precision: place.precision || (anchor ? 'surveyed' : 'stated'),
      stopName: place.stopName || '',
      address: place.address || '',
      note: place.note || '',
      anchorId: place.anchorId || null,
      hasLodging: lodging.has(place.id),
      onTrail: Boolean(anchor),
    };
  });

  const serviceList = transit.services.map((service) => {
    const extra = scheduleIndex.get(service.id);
    if (!extra) return { ...service, scheduleSource: null };
    // The feed wins on times and stop positions where it has them, and brings
    // its own confidence: a published 2027 timetable is worth more than a 2026
    // pattern standing in for one.
    return {
      ...service,
      departures: extra.departures || service.departures,
      frequency: extra.departures ? undefined : service.frequency,
      stops: extra.stops || service.stops,
      confidence: extra.confidence || service.confidence,
      scheduleSource: extra.source || null,
    };
  });

  return {
    transit,
    places: placeList,
    placeIndex: new Map(placeList.map((place) => [place.id, place])),
    services: serviceList,
    serviceIndex: new Map(serviceList.map((service) => [service.id, service])),
    operatorIndex: new Map(transit.operators.map((operator) => [operator.id, operator])),
    walks: transit.walks || [],
    onDemand: transit.onDemand || [],
    sources: schedules?.sources || [],
    generatedAt: schedules?.generatedAt || null,
    pace: pace || DEFAULT_PACE,
    rates,
    stays,
  };
}

/* ------------------------------------------------------------------ */
/* places, services, operators                                         */
/* ------------------------------------------------------------------ */

export function placeById(ctx, id) {
  return ctx.placeIndex.get(id) || null;
}

export function placeName(ctx, id) {
  return ctx.placeIndex.get(id)?.name || id;
}

export function serviceById(ctx, id) {
  return ctx.serviceIndex.get(id) || null;
}

export function operatorById(ctx, id) {
  return ctx.operatorIndex.get(id) || null;
}

/** Places bucketed for a grouped picker, empty groups dropped. */
export function placeGroups(ctx) {
  return ROLE_GROUPS.map(({ role, label }) => ({
    label,
    places: ctx.places
      .filter((place) => place.role === role)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.places.length);
}

export function coordsOf(ctx, id) {
  const place = placeById(ctx, id);
  return place && place.lat != null ? [place.lon, place.lat] : null;
}

/** Services calling at a place, in either direction. */
export function servicesAt(ctx, placeId) {
  return ctx.services.filter((service) => service.stops.some((stop) => stop.place === placeId));
}

/** Straight-line distance between two places, for a rough sanity figure. */
export function directDistanceM(ctx, from, to) {
  const a = coordsOf(ctx, from);
  const b = coordsOf(ctx, to);
  return a && b ? haversine(a, b) : null;
}

/* ------------------------------------------------------------------ */
/* time helpers                                                        */
/* ------------------------------------------------------------------ */

/** "08:30" to minutes after midnight. Returns null on anything unparseable. */
export function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatTime(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(
    2,
    '0'
  )}`;
}

export function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  return hours ? `${hours} h ${String(total % 60).padStart(2, '0')}` : `${total} min`;
}

/**
 * Does this service run on this date?
 *
 * The season is stored as month-day so a pattern is not tied to one year — the
 * trip is in 2027 and most of these timetables are the 2026 season standing in
 * for it. A window that wraps the new year is handled, though none currently do.
 */
export function runsOn(service, dateIso) {
  const monthDay = String(dateIso).slice(5, 10);
  const season = service.season;
  if (season) {
    const inWindow =
      season.from <= season.to
        ? monthDay >= season.from && monthDay <= season.to
        : monthDay >= season.from || monthDay <= season.to;
    if (!inWindow) return false;
  }

  const days = service.days;
  if (!days || days === 'daily') return true;
  const weekday = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  if (Array.isArray(days)) return days.includes(weekday);
  if (days === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (days === 'weekends') return weekday === 0 || weekday === 6;
  return true;
}

/** Departure times at a service's first stop, as minutes after midnight. */
export function departureTimes(service) {
  if (Array.isArray(service.departures)) {
    return service.departures
      .map(parseTime)
      .filter((value) => value != null)
      .sort((a, b) => a - b);
  }
  const frequency = service.frequency;
  if (!frequency) return [];
  const first = parseTime(frequency.first);
  const last = parseTime(frequency.last);
  const step = Number(frequency.everyMinutes) || 0;
  if (first == null || last == null || step <= 0 || last < first) return [];

  const times = [];
  // Bounded so a bad `everyMinutes` cannot spin here.
  for (let time = first; time <= last && times.length < 200; time += step) {
    times.push(time);
  }
  return times;
}

/* ------------------------------------------------------------------ */
/* directional expansion                                              */
/* ------------------------------------------------------------------ */

/**
 * Every directed run of a service.
 *
 * `bidirectional` means the same vehicle works back down the line. For a
 * turn-up-and-go frequency that is simply the same window in reverse. For a
 * fixed list of departures it is a straight turnaround, so the return leaves the
 * far end as the outbound arrives — which is exactly how these valley shuttles
 * work, and why a service whose return times are genuinely different is stored
 * as its own record instead of relying on this.
 */
export function directedRuns(service) {
  const outbound = { service, stops: service.stops, reversed: false };
  const departures = departureTimes(service);
  const runs = [{ ...outbound, departures }];
  if (!service.bidirectional || !service.stops.length) return runs;

  const total = service.stops[service.stops.length - 1].offsetMinutes;
  const stops = [...service.stops]
    .reverse()
    .map((stop) => ({ ...stop, offsetMinutes: total - stop.offsetMinutes }));

  runs.push({
    service,
    stops,
    reversed: true,
    departures: Array.isArray(service.departures)
      ? departures.map((time) => time + total)
      : departures,
  });
  return runs;
}

/* ------------------------------------------------------------------ */
/* walking legs                                                        */
/* ------------------------------------------------------------------ */

/**
 * Minutes on foot for a declared walk link.
 *
 * Uses the same model as the hiking days rather than a flat walking speed, so a
 * 230 m climb from Trient up to the Forclaz is not costed like level road. Only
 * moving time: these are twenty-minute connections, not days that need a lunch
 * stop budgeted into them.
 */
export function walkMinutes(walk, pace, reversed = false) {
  const model = MODELS[pace?.model] ? pace.model : 'naismith';
  const ascent = reversed ? -(walk.ascent_m || 0) : walk.ascent_m || 0;
  const speed = pace?.flatSpeedKmh || DEFAULT_PACE.flatSpeedKmh;
  return Math.max(1, Math.round(MODELS[model].fn(walk.distance_m || 0, ascent, speed) / 60));
}

/** Walk links out of a place, both directions of every declared link. */
function walksFrom(ctx, placeId) {
  const legs = [];
  ctx.walks.forEach((walk) => {
    if (walk.from === placeId) legs.push({ walk, to: walk.to, reversed: false });
    if (walk.to === placeId) legs.push({ walk, to: walk.from, reversed: true });
  });
  return legs;
}

/* ------------------------------------------------------------------ */
/* journey search                                                      */
/* ------------------------------------------------------------------ */

export function worstConfidence(legs) {
  return legs.reduce((worst, leg) => {
    if (!leg.confidence) return worst;
    if (!worst) return leg.confidence;
    return CONFIDENCE.indexOf(leg.confidence) < CONFIDENCE.indexOf(worst) ? leg.confidence : worst;
  }, null);
}

function summarise(legs) {
  const rides = legs.filter((leg) => leg.kind === 'ride');
  return {
    legs,
    from: legs[0].from,
    to: legs[legs.length - 1].to,
    departMinutes: legs[0].departMinutes,
    arriveMinutes: legs[legs.length - 1].arriveMinutes,
    totalMinutes: legs[legs.length - 1].arriveMinutes - legs[0].departMinutes,
    rides: rides.length,
    transfers: Math.max(0, rides.length - 1),
    walkMinutes: legs
      .filter((leg) => leg.kind === 'walk')
      .reduce((sum, leg) => sum + (leg.arriveMinutes - leg.departMinutes), 0),
    confidence: worstConfidence(legs) || 'estimate',
    fares: rides
      .map((leg) => leg.fare)
      .filter((fare) => fare && fare.basis !== 'free' && fare.amount > 0),
    free: rides.length > 0 && rides.every((leg) => !leg.fare || leg.fare.basis === 'free'),
  };
}

function visitedPlaces(placeId, legs) {
  const seen = new Set([legs.length ? legs[0].from : placeId]);
  legs.forEach((leg) => seen.add(leg.to));
  return seen;
}

/**
 * Add one walking hop to each label, where it gets somewhere new sooner.
 *
 * Only one hop per round: chaining road walks together would be a way of
 * inventing a hiking day, which is what the rest of the site is for.
 */
function walkClosure(ctx, labels) {
  const next = new Map(labels);
  labels.forEach((label, placeId) => {
    const lastLeg = label.legs[label.legs.length - 1];
    if (lastLeg && lastLeg.kind === 'walk') return;
    const seen = visitedPlaces(placeId, label.legs);

    walksFrom(ctx, placeId).forEach(({ walk, to, reversed }) => {
      if (seen.has(to)) return;
      const minutes = walkMinutes(walk, ctx.pace, reversed);
      const arrival = label.arrival + minutes;
      if (arrival >= 1440) return;
      const existing = next.get(to);
      if (existing && existing.arrival <= arrival) return;

      next.set(to, {
        arrival,
        legs: [
          ...label.legs,
          {
            kind: 'walk',
            from: placeId,
            to,
            departMinutes: label.arrival,
            arriveMinutes: arrival,
            distance_m: walk.distance_m,
            ascent_m: reversed ? -(walk.ascent_m || 0) : walk.ascent_m || 0,
            note: walk.note || '',
            confidence: null,
          },
        ],
      });
    });
  });
  return next;
}

/** Ride one service from each label, keeping the earliest arrival per place. */
function rideStep(labels, runs) {
  const next = new Map();

  labels.forEach((label, placeId) => {
    const boarded = new Set(
      label.legs.filter((leg) => leg.kind === 'ride').map((leg) => leg.serviceId)
    );
    const seen = visitedPlaces(placeId, label.legs);
    const lastLeg = label.legs[label.legs.length - 1];
    const buffer = lastLeg && lastLeg.kind === 'ride' ? MIN_TRANSFER_MINUTES : 0;
    const readyAt = label.arrival + buffer;

    runs.forEach((run) => {
      if (boarded.has(run.service.id)) return;
      const boardIndex = run.stops.findIndex((stop) => stop.place === placeId);
      if (boardIndex < 0 || boardIndex === run.stops.length - 1) return;

      const boardOffset = run.stops[boardIndex].offsetMinutes;
      const departure = run.departures.find((time) => time + boardOffset >= readyAt);
      if (departure == null) return;
      const departMinutes = departure + boardOffset;

      for (let i = boardIndex + 1; i < run.stops.length; i += 1) {
        const target = run.stops[i];
        if (seen.has(target.place)) continue;
        const arriveMinutes = departure + target.offsetMinutes;
        // Everything is same-day: a connection that would land after midnight is
        // not one anyone can use.
        if (arriveMinutes >= 1440) continue;

        const existing = next.get(target.place);
        if (existing && existing.arrival <= arriveMinutes) continue;

        next.set(target.place, {
          arrival: arriveMinutes,
          legs: [
            ...label.legs,
            {
              kind: 'ride',
              serviceId: run.service.id,
              service: run.service,
              reversed: run.reversed,
              from: placeId,
              to: target.place,
              departMinutes,
              arriveMinutes,
              fare: run.service.fare || null,
              confidence: run.service.confidence || 'estimate',
            },
          ],
        });
      }
    });
  });

  return next;
}

/**
 * Ranked ways of getting from one place to another on a date.
 *
 * A round-based earliest-arrival search: each round may add one walk and one
 * ride, so `maxTransfers` of 2 allows three vehicles plus the road walks that
 * join them. The graph is small enough that this is instant and, more usefully,
 * predictable — the same inputs always give the same answer.
 */
export function journeys(ctx, { from, to, date, time = '08:00', maxTransfers = 2 } = {}) {
  const startMinutes = parseTime(time);
  if (!ctx || !from || !to || from === to || !date || startMinutes == null) return [];

  const runs = ctx.services
    .filter((service) => runsOn(service, date))
    .flatMap(directedRuns)
    .filter((run) => run.departures.length);

  const found = [];
  const record = (labels) => {
    const label = labels.get(to);
    if (label && label.legs.length) found.push(summarise(label.legs));
  };

  let labels = new Map([[from, { arrival: startMinutes, legs: [] }]]);

  for (let round = 0; round <= maxTransfers; round += 1) {
    labels = walkClosure(ctx, labels);
    record(labels);
    labels = rideStep(labels, runs);
    if (!labels.size) break;
    record(labels);
  }
  record(walkClosure(ctx, labels));

  return dedupe(found).sort(
    (a, b) => a.arriveMinutes - b.arriveMinutes || a.legs.length - b.legs.length
  );
}

function dedupe(journeyList) {
  const seen = new Map();
  journeyList.forEach((journey) => {
    const key = journey.legs
      .map(
        (leg) => `${leg.kind}:${leg.serviceId || ''}:${leg.from}>${leg.to}@${leg.departMinutes}`
      )
      .join('|');
    if (!seen.has(key)) seen.set(key, journey);
  });
  return [...seen.values()];
}

/* ------------------------------------------------------------------ */
/* on-demand options                                                   */
/* ------------------------------------------------------------------ */

/**
 * Taxis and booked transfers that cover a pair of places.
 *
 * Kept out of the journey graph on purpose: they have no departure time, so
 * putting them in would let the search "win" every query with a taxi and bury
 * the bus that costs a twentieth as much. A quoted fare for the exact pair is
 * surfaced when there is one.
 */
export function onDemandBetween(ctx, from, to) {
  return ctx.onDemand
    .filter((option) => {
      const serves = option.serves || [];
      return serves.includes(from) && serves.includes(to);
    })
    .map((option) => ({
      ...option,
      quotedFares: (option.fares || []).filter(
        (fare) => (fare.from === from && fare.to === to) || (fare.from === to && fare.to === from)
      ),
      operatorRecord: operatorById(ctx, option.operator),
    }));
}

/* ------------------------------------------------------------------ */
/* fares                                                              */
/* ------------------------------------------------------------------ */

/**
 * What one journey costs per person, in the base currency.
 *
 * Legs are priced in euros on one side of the massif and francs on the other, so
 * a total means nothing until it is converted — and `null` rather than a wrong
 * number when there is no rate table to convert with, because a figure that
 * silently added CHF to EUR would be believed.
 */
export function journeyFare(ctx, journey) {
  if (!journey) return { total: null, free: false, parts: [] };
  const parts = journey.fares || [];
  if (journey.free) return { total: 0, free: true, parts };
  if (!parts.length || !ctx?.rates) return { total: null, free: false, parts };
  return {
    total: parts.reduce((sum, fare) => sum + toBase(fare.amount, fare.currency, ctx.rates), 0),
    free: false,
    parts,
  };
}

/**
 * The cheapest per-person figure across a set of journeys, as a "from" price.
 *
 * Free counts as a real answer of zero rather than as missing data: the Chamonix
 * valley buses genuinely are free with the Carte d'Hôte, and that is the single
 * most useful thing the board can say about getting to the trailhead.
 */
function fromFareOf(ctx, journeyList) {
  const priced = journeyList
    .map((journey) => journeyFare(ctx, journey))
    .filter((fare) => fare.total != null);
  if (!priced.length) return null;
  return priced.reduce((low, fare) => (fare.total < low.total ? fare : low), priced[0]);
}

/**
 * The cheapest on-demand quote for a pair, kept per vehicle.
 *
 * Never divided by the group size. A taxi is quoted for the car, and dividing by
 * six would produce a per-person number that no longer holds the moment four
 * people take it — so it is carried separately and labelled separately all the
 * way to the screen rather than being folded into `fromFare`.
 */
function onDemandFareOf(ctx, options) {
  const quotes = options
    .flatMap((option) => option.quotedFares || [])
    .filter((fare) => fare.amount > 0);
  if (!quotes.length || !ctx?.rates) return null;
  const cheapest = quotes.reduce(
    (low, fare) =>
      toBase(fare.amount, fare.currency, ctx.rates) < toBase(low.amount, low.currency, ctx.rates)
        ? fare
        : low,
    quotes[0]
  );
  return {
    amount: cheapest.amount,
    currency: cheapest.currency,
    total: toBase(cheapest.amount, cheapest.currency, ctx.rates),
    upTo: cheapest.upTo || null,
    basis: cheapest.basis || 'per vehicle',
    perVehicle: true,
  };
}

/* ------------------------------------------------------------------ */
/* the trip board                                                     */
/* ------------------------------------------------------------------ */

/** Where the group actually sleeps on a given night, which is not always the stop. */
export function bedOf(ctx, day) {
  if (!day?.stayAt) return null;
  const stop = (ctx.stays?.stops || []).find((entry) => entry.stopId === day.stayAt) || null;
  const option = stop?.options?.find((entry) => entry.id === stop.bookedOptionId) || null;
  const placeId = option?.atPlaceId || day.stayAt;
  return {
    stopId: day.stayAt,
    placeId,
    option,
    stop,
    // The two nights this is true of are the reason the board exists.
    offTrail: placeId !== day.stayAt,
  };
}

/** Bound on the departure walk below, so a bad frequency cannot spin. */
const MAX_DEPARTURE_PROBES = 80;

/**
 * When the first vehicle of a journey leaves, which is the thing with a timetable.
 *
 * A journey that opens with a road walk can be started at any minute of the day —
 * the walk up from Trient to the Forclaz does not have departures — so it is the
 * bus at the top that is scarce, and it is the bus that has to be counted.
 */
function firstRideDeparture(journey) {
  const ride = journey.legs.find((leg) => leg.kind === 'ride');
  return ride ? ride.departMinutes : journey.departMinutes;
}

/**
 * The latest you can set off and still make the first vehicle.
 *
 * `journeys()` reports a walk-first journey as leaving at whatever time it was
 * asked about and then waiting at the stop, which is true but useless as a
 * deadline — asked at 06:00 it says 06:00 for a bus at 09:09. Someone standing in
 * Trient wants the opposite end of that: walk up to the Forclaz by 08:07 and the
 * bus is there. So the leading walks are subtracted from the vehicle's time.
 */
function setOffMinutes(journey) {
  const rideIndex = journey.legs.findIndex((leg) => leg.kind === 'ride');
  if (rideIndex < 0) return journey.departMinutes;
  const leadingWalk = journey.legs
    .slice(0, rideIndex)
    .reduce((sum, leg) => sum + (leg.arriveMinutes - leg.departMinutes), 0);
  return journey.legs[rideIndex].departMinutes - leadingWalk;
}

/**
 * Every distinct way of making this trip today, in departure order.
 *
 * One search will not do. `journeys()` answers "leaving after this time, what
 * arrives soonest", so its results cluster at the front of the day and their
 * latest departure is not the day's last. Reporting that as a deadline is worse
 * than reporting nothing: it read as 10:50 for the last navette down from Les
 * Chapieux, when in fact it runs until the evening — and someone would have
 * abandoned a day's walking before lunch on the strength of it.
 *
 * So this steps through the day, each time asking what leaves next. The step is
 * past the first *vehicle*, not past the journey's start, because stepping one
 * minute past a walk start just finds the same bus again: that counted 80
 * imaginary departures a minute apart and still never reached the last one.
 */
function walkDepartures(ctx, from, to, date, time, maxTransfers) {
  const all = [];
  let cursor = parseTime(time);

  for (let probe = 0; probe < MAX_DEPARTURE_PROBES; probe += 1) {
    if (cursor == null || cursor >= 1440) break;
    const found = journeys(ctx, { from, to, date, time: formatTime(cursor), maxTransfers });
    if (!found.length) break;

    // The next vehicle out, which is not necessarily the first result: those are
    // ranked by arrival, so a later bus that overtakes can come first.
    const nextVehicle = Math.min(...found.map(firstRideDeparture));
    all.push(...found.filter((journey) => firstRideDeparture(journey) === nextVehicle));
    cursor = nextVehicle + 1;
  }

  return all;
}

/**
 * One ride shape: how to get from A to B on a date, and the last chance to do it.
 */
function connection(ctx, from, to, date, time, maxTransfers) {
  if (!from || !to || from === to || !date) return null;
  const found = journeys(ctx, { from, to, date, time, maxTransfers });
  const options = onDemandBetween(ctx, from, to);
  const everyDeparture = walkDepartures(ctx, from, to, date, time, maxTransfers);
  const lastOut = everyDeparture.reduce(
    (latest, journey) =>
      !latest || setOffMinutes(journey) > setOffMinutes(latest) ? journey : latest,
    null
  );

  return {
    from,
    to,
    date,
    journeys: found,
    count: found.length,
    // Latest times you could set off, which is what "how skippable is this day"
    // actually means to someone deciding whether to risk it. Set-off rather than
    // the vehicle's own time, because on the legs that begin with a walk up to a
    // col the two differ by the best part of an hour.
    departures: [...new Set(everyDeparture.map(setOffMinutes))].sort((a, b) => a - b),
    fastestMinutes: found.length ? Math.min(...found.map((j) => j.totalMinutes)) : null,
    fromFare: fromFareOf(ctx, everyDeparture.length ? everyDeparture : found),
    onDemand: options,
    onDemandFare: onDemandFareOf(ctx, options),
    lastDeparture: lastOut ? setOffMinutes(lastOut) : null,
    // The deadline's own trustworthiness, not the row's. These genuinely differ:
    // the quickest way down from Trient is a published pattern, while the last one
    // of the day is an unconfirmed PostBus — so a chip taken from the fastest
    // journey would put a reassuring label on the one number that can strand
    // somebody. Whatever is said about the deadline has to come from the journey
    // that sets it.
    lastDepartureConfidence: lastOut ? worstConfidence(lastOut.legs) : null,
    lastDepartureJourney: lastOut,
    confidence: found.length ? worstConfidence(found) : null,
    // What the chip says. Three states, because "no bus" and "a taxi will do it"
    // are different answers and collapsing them would hide the expensive one.
    reach: found.length ? 'scheduled' : options.length ? 'on-demand' : 'none',
  };
}

/**
 * The whole trip, one row per day, answering "can this day be skipped and what
 * does it cost" and "is tonight's bed somewhere a vehicle has to reach".
 *
 * Built from the calendar rather than the itinerary so that every row already
 * knows its real date — a service that only runs on weekdays, or a season that
 * has not opened, has to be judged against the actual day, not a generic one.
 *
 * A day carries up to three connections, deliberately the same shape:
 *   toTrail  last night's bed to where today's walking starts
 *   skip     the walk itself, replaced by vehicles
 *   toBed    where today's walking ends to tonight's bed
 *
 * `toTrail` exists because the group sleeps in Chamonix and starts walking at Les
 * Houches, so hiking day 1 opens with a bus. That is the same shape as the
 * Chapieux night pointing the other way, so it is modelled the same way instead
 * of being special-cased in the page.
 */
export function dayOptions(ctx, calendar, { time = '06:00', maxTransfers = 3 } = {}) {
  return calendar.map((day, index) => {
    const previous = index > 0 ? calendar[index - 1] : null;
    const lastNight = previous ? bedOf(ctx, previous) : null;
    const bed = bedOf(ctx, day);
    const start = day.from || null;
    const end = day.to || day.stayAt || null;

    return {
      day,
      bed,
      hikeNumber: day.hikeNumber,
      // Morning: only when last night's bed is not where today starts.
      toTrail:
        start && lastNight && lastNight.placeId !== start
          ? connection(ctx, lastNight.placeId, start, day.date, time, maxTransfers)
          : null,
      // The skip itself, only meaningful on a day there is a walk to skip.
      skip:
        day.kind === 'hike' && start && day.to
          ? connection(ctx, start, day.to, day.date, time, maxTransfers)
          : null,
      // Evening: only when tonight's bed is not where today ends.
      toBed:
        bed && end && bed.placeId !== end
          ? connection(ctx, end, bed.placeId, day.date, time, maxTransfers)
          : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* text search                                                         */
/* ------------------------------------------------------------------ */

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Search places, services and operators together.
 *
 * Accent- and punctuation-insensitive prefix matching over a few dozen records,
 * which is all this needs: "arp" should find Arp Nouvaz and "forclaz" should
 * find both the col and the bus that serves it, without anyone having to know
 * whether the thing they are looking for is a place, a line or a company.
 */
export function search(ctx, query, { limit = 20 } = {}) {
  const needles = tokens(query);
  if (!needles.length) return [];

  const entries = [
    ...ctx.places.map((place) => ({
      kind: 'place',
      id: place.id,
      label: place.name,
      sub: [place.stopName, place.country].filter(Boolean).join(' · '),
      // What is written on the stop sign counts as strongly as the place name.
      // Anchors carry the name the trail uses — "Arnouvaz" — while the timetable
      // and the sign both say "Arp Nouvaz", and either should find it.
      strong: [place.name, place.stopName],
      haystack: [place.name, place.id, place.stopName, place.address, place.note, place.country],
    })),
    ...ctx.services.map((service) => ({
      kind: 'service',
      id: service.id,
      label: service.name,
      sub: [service.line ? `Line ${service.line}` : '', service.mode].filter(Boolean).join(' · '),
      strong: [service.name, service.line],
      haystack: [
        service.name,
        service.line,
        service.mode,
        service.note,
        operatorById(ctx, service.operator)?.name,
        ...service.stops.map((stop) => placeName(ctx, stop.place)),
      ],
    })),
    ...ctx.transit.operators.map((operator) => ({
      kind: 'operator',
      id: operator.id,
      label: operator.name,
      sub: [operator.country, operator.phone].filter(Boolean).join(' · '),
      haystack: [operator.name, operator.country, operator.note, operator.website],
    })),
  ];

  return entries
    .map((entry) => {
      const hay = tokens(entry.haystack.filter(Boolean).join(' '));
      const label = tokens((entry.strong || [entry.label]).filter(Boolean).join(' '));
      let score = 0;
      needles.forEach((needle) => {
        if (label.includes(needle)) score += 6;
        else if (label.some((word) => word.startsWith(needle))) score += 4;
        else if (hay.some((word) => word.startsWith(needle))) score += 2;
        else if (hay.some((word) => word.includes(needle))) score += 1;
      });
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, limit);
}
