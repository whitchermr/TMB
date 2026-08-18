/**
 * Metric / imperial formatting. The preference is device-local, since which
 * units you think in is a property of the reader, not of the trip.
 */

import { pref, setPref } from './store.js';

const KEY = 'units';

export function current() {
  return pref(KEY, 'metric') === 'imperial' ? 'imperial' : 'metric';
}

export function set(value) {
  setPref(KEY, value === 'imperial' ? 'imperial' : 'metric');
}

export function toggle() {
  set(current() === 'metric' ? 'imperial' : 'metric');
  return current();
}

export function isImperial() {
  return current() === 'imperial';
}

/** Distance from metres. */
export function distance(metres, { decimals = 1, unit = true } = {}) {
  if (metres == null || !Number.isFinite(metres)) return '—';
  if (isImperial()) {
    const miles = metres / 1609.344;
    return `${miles.toFixed(decimals)}${unit ? ' mi' : ''}`;
  }
  const km = metres / 1000;
  return `${km.toFixed(decimals)}${unit ? ' km' : ''}`;
}

export function distanceUnit() {
  return isImperial() ? 'mi' : 'km';
}

/** Elevation from metres, rounded — nobody needs decimal feet. */
export function elevation(metres, { unit = true } = {}) {
  if (metres == null || !Number.isFinite(metres)) return '—';
  if (isImperial()) {
    return `${Math.round(metres * 3.28084).toLocaleString()}${unit ? ' ft' : ''}`;
  }
  return `${Math.round(metres).toLocaleString()}${unit ? ' m' : ''}`;
}

export function elevationUnit() {
  return isImperial() ? 'ft' : 'm';
}

/** Signed elevation change, for gain/loss badges. */
export function elevationDelta(metres, sign) {
  if (metres == null || !Number.isFinite(metres)) return '—';
  const prefix = sign === 'gain' ? '+' : sign === 'loss' ? '−' : '';
  return `${prefix}${elevation(Math.abs(metres))}`;
}

export function speed(kmh) {
  if (kmh == null || !Number.isFinite(kmh)) return '—';
  return isImperial() ? `${(kmh / 1.609344).toFixed(1)} mph` : `${kmh.toFixed(1)} km/h`;
}

/** Raw numeric conversions, for chart axes that render their own labels. */
export function toDisplayDistance(metres) {
  return isImperial() ? metres / 1609.344 : metres / 1000;
}

export function toDisplayElevation(metres) {
  return isImperial() ? metres * 3.28084 : metres;
}

/** Duration in hours as "4h 25m". */
export function duration(hours) {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return '—';
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}
