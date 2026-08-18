/**
 * Solar event times for a coordinate and date, from the NOAA solar position
 * algorithm. No dependency, accurate to well within a minute — plenty for
 * deciding when to be standing on a col with a camera.
 *
 * All returned times are local wall-clock in the trip's timezone. Chamonix,
 * Courmayeur and Trient all sit in Central European Summer Time, so a fixed
 * UTC+2 offset is correct for a July trip across all three countries.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const TRIP_UTC_OFFSET_HOURS = 2;

/** Days since the J2000.0 epoch, for a UTC date at 00:00. */
function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function solarPosition(julian) {
  const n = julian - 2451545.0;
  const meanLongitude = (280.46646 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.52911 + 0.98560028 * n) % 360) * DEG;

  const center =
    1.914602 * Math.sin(meanAnomaly) +
    0.019993 * Math.sin(2 * meanAnomaly) +
    0.000289 * Math.sin(3 * meanAnomaly);
  const trueLongitude = (meanLongitude + center) * DEG;

  const obliquity = (23.439291 - 0.0000004 * n) * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(trueLongitude));

  // Equation of time in minutes.
  const y = Math.tan(obliquity / 2) ** 2;
  const meanLongitudeRad = meanLongitude * DEG;
  const equationOfTime =
    4 *
    RAD *
    (y * Math.sin(2 * meanLongitudeRad) -
      2 * 0.016708634 * Math.sin(meanAnomaly) +
      4 * 0.016708634 * y * Math.sin(meanAnomaly) * Math.cos(2 * meanLongitudeRad) -
      0.5 * y * y * Math.sin(4 * meanLongitudeRad) -
      1.25 * 0.016708634 ** 2 * Math.sin(2 * meanAnomaly));

  return { declination, equationOfTime };
}

/**
 * Local time in hours (0–24) at which the sun reaches `altitudeDeg`.
 * `morning` picks the rising crossing, otherwise the setting one.
 * Returns null when the sun never reaches that altitude on that day.
 */
function timeAtAltitude(date, lat, lon, altitudeDeg, morning) {
  const julian = julianDay(date);
  const { declination, equationOfTime } = solarPosition(julian);
  const latRad = lat * DEG;

  const cosHourAngle =
    (Math.sin(altitudeDeg * DEG) - Math.sin(latRad) * Math.sin(declination)) /
    (Math.cos(latRad) * Math.cos(declination));

  if (cosHourAngle > 1 || cosHourAngle < -1) return null;

  const hourAngle = Math.acos(cosHourAngle) * RAD;
  const solarNoon = 12 - lon / 15 - equationOfTime / 60 + TRIP_UTC_OFFSET_HOURS;
  return morning ? solarNoon - hourAngle / 15 : solarNoon + hourAngle / 15;
}

/**
 * Key light events for a date and place.
 *
 * Altitudes follow photographic convention: the solar disc centre at −0.833°
 * for sunrise/sunset (accounting for refraction and radius), +6° as the outer
 * edge of golden hour, and −6° for civil twilight / blue hour.
 */
export function sunTimes(dateIso, lat, lon) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;

  const at = (altitude, morning) => timeAtAltitude(date, lat, lon, altitude, morning);

  const events = {
    dawn: at(-6, true),
    sunrise: at(-0.833, true),
    goldenMorningEnd: at(6, true),
    goldenEveningStart: at(6, false),
    sunset: at(-0.833, false),
    dusk: at(-6, false),
  };

  const dayLength =
    events.sunrise != null && events.sunset != null ? events.sunset - events.sunrise : null;

  return { ...events, dayLength };
}

/** Format an hours-past-midnight value as "05:42". Returns "—" for null. */
export function formatHour(hours) {
  if (hours == null || !Number.isFinite(hours)) return '—';
  let value = hours % 24;
  if (value < 0) value += 24;
  const h = Math.floor(value);
  const m = Math.round((value - h) * 60);
  if (m === 60) return `${String((h + 1) % 24).padStart(2, '0')}:00`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Parse "08:00" into hours past midnight. */
export function parseHour(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60;
}

/**
 * Is a given clock time inside good light?
 * Used to flag whether the group will actually reach a viewpoint when its
 * recommended light is happening.
 */
export function lightWindowAt(hours, times) {
  if (hours == null || !times) return null;
  const { dawn, sunrise, goldenMorningEnd, goldenEveningStart, sunset, dusk } = times;
  if (dawn != null && hours < dawn) return 'night';
  if (sunrise != null && hours < sunrise) return 'blue';
  if (goldenMorningEnd != null && hours < goldenMorningEnd) return 'golden';
  if (goldenEveningStart != null && hours < goldenEveningStart) return 'day';
  if (sunset != null && hours < sunset) return 'golden';
  if (dusk != null && hours < dusk) return 'blue';
  return 'night';
}

const WINDOW_LABELS = {
  night: 'dark',
  blue: 'blue hour',
  golden: 'golden hour',
  day: 'full daylight',
};

export function lightWindowLabel(window) {
  return WINDOW_LABELS[window] || '';
}

/**
 * Does the arrival time line up with a waypoint's recommended light?
 *
 * `ideal` windows count as a match, `ok` windows as near enough to be worth
 * shooting, anything else as a miss. A sunrise subject, for instance, is happy
 * in either blue or golden light, so both are ideal rather than one being merely
 * acceptable.
 *
 * Returns 'match', 'near' or 'miss', or null when there is nothing to compare.
 */
const LIGHT_PREFERENCES = {
  // Arriving at a sunrise or sunset subject in flat daylight is a genuine miss,
  // not a near-enough, so neither lists 'day' as acceptable.
  sunrise: { ideal: ['blue', 'golden'], ok: [] },
  sunset: { ideal: ['golden', 'blue'], ok: [] },
  golden: { ideal: ['golden'], ok: ['blue'] },
  blue: { ideal: ['blue'], ok: ['golden'] },
  morning: { ideal: ['golden', 'day'], ok: ['blue'] },
  afternoon: { ideal: ['day', 'golden'], ok: [] },
  midday: { ideal: ['day'], ok: ['golden'] },
};

export function lightMatch(bestLight, arrivalHours, times) {
  if (!bestLight || bestLight === 'any' || arrivalHours == null || !times) return null;
  const preference = LIGHT_PREFERENCES[bestLight];
  if (!preference) return null;

  const window = lightWindowAt(arrivalHours, times);
  if (preference.ideal.includes(window)) return 'match';
  if (preference.ok.includes(window)) return 'near';
  return 'miss';
}
