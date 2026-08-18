/**
 * Waypoint photographs and the credit that has to travel with them.
 *
 * The images are freely licensed but not free of obligations: CC BY and CC BY-SA
 * both require the photographer to be named and the licence identified wherever
 * the photo appears. So there is no way to render one of these without a credit,
 * which is why every caller goes through here rather than writing its own <img>.
 *
 * The credit shown next to the photo is text, not a link. A scenery row is
 * already a single clickable thing that focuses the map, and nesting a link
 * inside it would be both invalid and confusing on a touch screen. The links —
 * to the file on Commons and to the licence deed — live in the credits list on
 * about.html, which is the "reasonably practicable" place for them.
 */

import * as store from '../core/store.js';
import { escapeHtml } from './map.js';

let byWaypoint = null;

/** Load photos.json once and index it by waypoint. Safe to call repeatedly. */
export async function load() {
  if (byWaypoint) return byWaypoint;
  try {
    const file = await store.loadRouteFile('photos');
    byWaypoint = new Map(file.photos.map((entry) => [entry.waypointId, entry]));
  } catch (error) {
    // A missing photo file should cost the scenery list its pictures, nothing
    // more — the distances and timings matter more than the illustrations.
    console.warn('Waypoint photos unavailable', error);
    byWaypoint = new Map();
  }
  return byWaypoint;
}

export function forWaypoint(id) {
  return byWaypoint?.get(id) ?? null;
}

export function count() {
  return byWaypoint?.size ?? 0;
}

/** "Ada Lovelace · CC BY-SA 4.0", already escaped. */
export function creditText(entry) {
  if (!entry) return '';
  const { author, licence } = entry.credit;
  return `${escapeHtml(author)}${licence ? ` · ${escapeHtml(licence)}` : ''}`;
}

/**
 * A photo for a scenery row.
 *
 * width and height are set from the file so the browser reserves the right space
 * before the image arrives, which stops the list jumping around as photos load
 * over a slow connection — the normal case on the trail.
 */
export function figure(entry, { className = 'wp-photo' } = {}) {
  if (!entry) return '';
  return `
    <figure class="${className}">
      <img src="${escapeHtml(entry.file)}" alt="${escapeHtml(entry.alt || '')}"
        width="${entry.width}" height="${entry.height}"
        loading="lazy" decoding="async" />
      <figcaption>${creditText(entry)}</figcaption>
    </figure>
  `;
}
