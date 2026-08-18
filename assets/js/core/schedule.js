/**
 * Dates, walking-time models, and arrival estimates.
 *
 * Times are computed segment by segment along the elevation profile rather than
 * from a day's totals, because a day with one big climb takes much longer than a
 * day with the same ascent spread out. That also means every waypoint gets a
 * real estimated arrival time, which is what makes the light planning useful.
 */

import { indexAtDistance } from './geo.js';

/* ------------------------------------------------------------------ */
/* dates                                                               */
/* ------------------------------------------------------------------ */

export function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function formatDate(dateIso, { weekday = true, year = false } = {}) {
  const date = new Date(`${dateIso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateIso;
  return date.toLocaleDateString(undefined, {
    weekday: weekday ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    year: year ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

/**
 * Walk the itinerary from the start date, assigning one calendar day to each
 * entry. Nothing stores a date, so changing the start or inserting a rest day
 * reflows the whole trip.
 */
export function buildCalendar(itinerary, startDate) {
  let hikeNumber = 0;
  return itinerary.days.map((day, index) => {
    if (day.kind === 'hike') hikeNumber += 1;
    return {
      ...day,
      index,
      date: addDays(startDate, index),
      hikeNumber: day.kind === 'hike' ? hikeNumber : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* walking time models                                                 */
/* ------------------------------------------------------------------ */

/**
 * Naismith's rule with Langmuir's descent correction.
 *
 * Base: flat distance at the chosen speed, plus one hour per 600 m of ascent.
 * Langmuir then subtracts 10 min/300 m for gentle descent (5–12°) where you
 * gain time, and adds 10 min/300 m for steep descent (over 12°) where careful
 * footwork costs time.
 */
function naismithSeconds(distanceM, deltaM, flatSpeedKmh) {
  const flatSeconds = (distanceM / 1000 / flatSpeedKmh) * 3600;
  if (deltaM > 0) {
    return flatSeconds + (deltaM / 600) * 3600;
  }
  if (deltaM < 0 && distanceM > 0) {
    const drop = -deltaM;
    const gradeDeg = Math.atan2(drop, distanceM) * (180 / Math.PI);
    if (gradeDeg > 12) return flatSeconds + (drop / 300) * 600;
    if (gradeDeg >= 5) return Math.max(0, flatSeconds - (drop / 300) * 600);
  }
  return flatSeconds;
}

/**
 * Tobler's hiking function: speed = 6 * exp(-3.5 * |slope + 0.05|) km/h.
 *
 * A continuous curve rather than a rule of thumb, peaking on a gentle downhill.
 * Scaled so that its flat-ground speed matches the chosen pace, which keeps the
 * two models directly comparable.
 */
function toblerSeconds(distanceM, deltaM, flatSpeedKmh) {
  if (distanceM <= 0) return 0;
  const slope = deltaM / distanceM;
  const toblerKmh = 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
  const toblerFlat = 6 * Math.exp(-3.5 * 0.05);
  const scaled = toblerKmh * (flatSpeedKmh / toblerFlat);
  return (distanceM / 1000 / Math.max(0.4, scaled)) * 3600;
}

export const MODELS = {
  naismith: { label: 'Naismith + Langmuir', fn: naismithSeconds },
  tobler: { label: 'Tobler hiking function', fn: toblerSeconds },
};

/* ------------------------------------------------------------------ */
/* per-leg timing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Cumulative moving time along a leg, in seconds, one entry per track point.
 * Transit segments are excluded because they are not walked.
 */
export function movingTimeSeries(leg, pace) {
  const model = MODELS[pace.model] ? pace.model : 'naismith';
  const step = MODELS[model].fn;
  const cum = leg.cumulative_m || [];
  const elevations = leg.elevation_m || [];
  const series = [0];

  for (let i = 1; i < cum.length; i += 1) {
    const distance = cum[i] - cum[i - 1];
    const a = elevations[i - 1];
    const b = elevations[i];
    const delta = a != null && b != null ? b - a : 0;
    series.push(series[i - 1] + step(distance, delta, pace.flatSpeedKmh));
  }
  return series;
}

/**
 * Total elapsed hours for a leg, including breaks.
 *
 * Breaks scale with moving time rather than being a flat addition, plus one
 * lunch stop on any day long enough to warrant it.
 */
export function legDuration(leg, pace) {
  const series = movingTimeSeries(leg, pace);
  const movingSeconds = series[series.length - 1] || 0;
  const movingHours = movingSeconds / 3600;
  const breakHours = (movingHours * (pace.breakMinutesPerHour || 0)) / 60;
  const lunchHours = movingHours >= 3 ? (pace.lunchMinutes || 0) / 60 : 0;

  return {
    movingHours,
    breakHours,
    lunchHours,
    totalHours: movingHours + breakHours + lunchHours,
    series,
  };
}

/**
 * Elapsed hours at an arc-length position, breaks included.
 *
 * Breaks are spread proportionally through the day so a waypoint's arrival
 * estimate accounts for the stops taken before reaching it.
 */
export function elapsedAt(leg, pace, positionM, timing) {
  const { series, movingHours, breakHours, lunchHours } = timing || legDuration(leg, pace);
  const cum = leg.cumulative_m || [];
  if (!cum.length) return 0;

  const index = indexAtDistance(cum, positionM);
  const before = Math.max(0, Math.min(index, series.length - 2));
  const span = cum[before + 1] - cum[before];
  const t = span ? Math.max(0, Math.min(1, (positionM - cum[before]) / span)) : 0;
  const movingSeconds = series[before] + (series[before + 1] - series[before]) * t;
  const movingSoFar = movingSeconds / 3600;

  const fraction = movingHours > 0 ? movingSoFar / movingHours : 0;
  // Lunch only counts once you are past roughly the middle of the day.
  const lunchSoFar = fraction > 0.5 ? lunchHours : 0;
  return movingSoFar + breakHours * fraction + lunchSoFar;
}

/* ------------------------------------------------------------------ */
/* trip rollup                                                         */
/* ------------------------------------------------------------------ */

/** Totals across every hiking day, for the overview header. */
export function tripTotals(legs) {
  return legs.reduce(
    (total, leg) => {
      const stats = leg?.stats;
      if (!stats) return total;
      return {
        distance_m: total.distance_m + (stats.distance_m || 0),
        transit_m: total.transit_m + (leg.transitDistance_m || 0),
        gain_m: total.gain_m + (stats.gain_m || 0),
        loss_m: total.loss_m + (stats.loss_m || 0),
        days: total.days + 1,
        maxElevation_m: Math.max(total.maxElevation_m, stats.maxElevation_m ?? -Infinity),
      };
    },
    { distance_m: 0, transit_m: 0, gain_m: 0, loss_m: 0, days: 0, maxElevation_m: -Infinity }
  );
}

/** Which variant applies to a day: explicit override, else the global default. */
export function variantFor(day, settings) {
  return day.variantOverride || settings.defaultVariant || 'shortcut';
}
