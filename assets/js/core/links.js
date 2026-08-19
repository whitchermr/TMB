/**
 * Outbound links: booking pages that arrive already filled in, and map links
 * that open in whatever app the phone actually has.
 *
 * The reason this is a module rather than a few template strings at the call
 * site is that these URLs rot. An operator renames a query parameter and the
 * link still opens, still looks right, and quietly searches for the wrong thing
 * — which is worse than no link, because it is believed. So the templates live
 * in data/transit.json next to the operator they belong to, each with the date
 * it was last checked, and this module only expands them. A rotted link is then
 * a one-line data fix that needs no code review.
 *
 * Three tiers of usefulness, and the page should say which one it is offering
 * rather than presenting them all as equal:
 *
 *   prefilled  the operator documents a deep link, so from, to, date and time
 *              all arrive filled in. Only the Swiss operators do this.
 *   route      a page specific to this pair of places, but with no date on it.
 *   operator   the company's front page. A starting point, not an answer.
 *
 * Whatever tier is available, a transit-directions link to the same pair is
 * always offered alongside, because it is prefilled even when nothing else is.
 */

/** Date formats the templates ask for, keyed by the token used in the data. */
const DATE_FORMATS = {
  'YYYY-MM-DD': ({ y, m, d }) => `${y}-${m}-${d}`,
  'DD.MM.YYYY': ({ y, m, d }) => `${d}.${m}.${y}`,
  'MM/DD/YYYY': ({ y, m, d }) => `${m}/${d}/${y}`,
  'DD/MM/YYYY': ({ y, m, d }) => `${d}/${m}/${y}`,
};

const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

function dateParts(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? '').trim());
  return match ? { y: match[1], m: match[2], d: match[3] } : null;
}

export function formatDateFor(isoDate, format = DEFAULT_DATE_FORMAT) {
  const parts = dateParts(isoDate);
  if (!parts) return null;
  const formatter = DATE_FORMATS[format] || DATE_FORMATS[DEFAULT_DATE_FORMAT];
  return formatter(parts);
}

/**
 * Fill `{token}` and `{token|FORMAT}` placeholders, or give up entirely.
 *
 * Returning null on a missing value rather than leaving the token in place is
 * deliberate: a URL containing a literal "{to}" is a broken link that looks like
 * a working one, and it would be shipped by anyone who only glanced at the page.
 * Values are encoded here so a stop name with a comma or an accent in it — most
 * of them, in this valley — survives the round trip.
 */
export function expandTemplate(template, values) {
  if (!template) return null;

  let failed = false;
  const url = String(template).replace(/\{(\w+)(?:\|([^}]+))?\}/g, (_, key, format) => {
    const raw = values[key];
    if (raw == null || raw === '') {
      failed = true;
      return '';
    }
    const value = key === 'date' ? formatDateFor(raw, format || DEFAULT_DATE_FORMAT) : String(raw);
    if (value == null) {
      failed = true;
      return '';
    }
    return encodeURIComponent(value);
  });

  return failed ? null : url;
}

/**
 * What a timetable wants to be given for a place.
 *
 * The name on the stop sign, where it differs from the name the trail uses: a
 * Swiss timetable does not know "Arnouvaz" but does know "Arp Nouvaz", and
 * searching it for the wrong one of the two returns nothing at all.
 */
function queryNameOf(place) {
  if (!place) return null;
  return place.stopName || place.name || place.id || null;
}

/**
 * The best booking action for one ride leg.
 *
 * Takes the leg rather than the service so that the two ends are the ends of
 * this ride, not of the whole line — someone skipping half of day 4 should not
 * be handed a search for the line's terminus.
 */
export function bookingUrl(ctx, leg, { date, time } = {}) {
  if (!ctx || !leg || leg.kind !== 'ride') return null;

  const service = leg.service || ctx.serviceIndex?.get(leg.serviceId) || null;
  if (!service) return null;

  const operator = ctx.operatorIndex?.get(service.operator) || null;
  const from = queryNameOf(ctx.placeIndex?.get(leg.from));
  const to = queryNameOf(ctx.placeIndex?.get(leg.to));

  const template = operator?.deeplink?.template;
  if (template) {
    const href = expandTemplate(template, {
      from,
      to,
      date,
      time,
      line: service.line,
    });
    if (href) {
      return {
        href,
        tier: 'prefilled',
        label: `Book on ${operator.name}`,
        detail: 'Opens with both ends, the date and the time already filled in.',
        verifiedOn: operator.deeplink.verifiedOn || null,
      };
    }
  }

  // A page for this route specifically. No date, but it names the right stops
  // and the right line, which is most of what the reader needs. Only counts if
  // it actually goes somewhere: half the services in the data point `booking.url`
  // at a company front page, which is not a route page in any useful sense.
  const routeUrl = service.booking?.url;
  if (routeUrl && !isBareHomepage(routeUrl)) {
    return {
      href: routeUrl,
      tier: 'route',
      label: `${service.name} timetable`,
      detail: 'The page for this route. Dates have to be entered by hand.',
      verifiedOn: service.verifiedOn || null,
    };
  }

  const fallback = routeUrl || operator?.bookingUrl || operator?.website;
  if (fallback) {
    return {
      href: fallback,
      tier: 'operator',
      label: operator?.name || 'Operator site',
      detail: 'The operator’s own site. Nothing is filled in.',
      verifiedOn: null,
    };
  }

  return null;
}

/**
 * A URL that drops the reader on a front page with nothing filled in.
 *
 * Worth naming because a front page is not an action: it looks like a booking
 * link and leaves the reader to re-enter the two places and the date they had
 * already chosen here, which was the original complaint about this page. The
 * caller pairs anything at this tier with a transit-directions link, which is at
 * least prefilled with the right pair.
 */
export function isBareHomepage(url) {
  const match = /^https?:\/\/[^/?#]+(\/?)($|[?#])/.exec(String(url ?? '').trim());
  return Boolean(match);
}

/**
 * Everything worth offering for one ride leg, best first.
 *
 * The page renders these rather than deciding between them, so that "book this"
 * and "show me where to stand" are never in competition for the same slot. There
 * is always at least one entry that arrives prefilled: when the operator has no
 * deep link, the transit-directions link still knows both ends.
 */
export function legActions(ctx, leg, { date, time } = {}) {
  const actions = [];
  const booking = bookingUrl(ctx, leg, { date, time });
  if (booking) actions.push({ ...booking, role: 'book' });

  const directions = transitDirectionsBetween(ctx, leg?.from, leg?.to);
  if (directions) {
    actions.push({
      href: directions,
      tier: 'prefilled',
      role: 'directions',
      label: 'Open in Maps',
      detail: 'Both ends already filled in, whatever the operator offers.',
      verifiedOn: null,
    });
  }
  return actions;
}

/* ------------------------------------------------------------------ */
/* maps                                                               */
/* ------------------------------------------------------------------ */

function coordString(target) {
  if (!target || target.lat == null || target.lon == null) return null;
  return `${Number(target.lat).toFixed(5)},${Number(target.lon).toFixed(5)}`;
}

/**
 * What to hand a maps app when there are no coordinates.
 *
 * A postal address searches perfectly well, so a hotel whose door position was
 * never verified is still one tap from directions. This is why lat/lon are
 * optional in the data instead of being filled in with a plausible guess.
 */
function searchTermOf(target) {
  if (!target) return null;
  const parts = [target.name, target.address].filter(Boolean);
  return parts.length ? parts.join(', ') : target.id || null;
}

/**
 * Google, Apple and a bare `geo:` for the same point.
 *
 * All three, because the choice is not ours to make: `geo:` is the one that
 * works with an offline map app, which on much of this route is the only kind
 * that works at all, but it is also the one that does nothing on a desktop.
 */
export function mapsUrls(target) {
  const coords = coordString(target);
  const term = searchTermOf(target);
  const label = target?.name || term || 'Location';
  if (!coords && !term) return null;

  const googleQuery = coords || term;
  const urls = {
    label,
    google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(googleQuery)}`,
    // Apple takes a label alongside the coordinates, so the pin is named rather
    // than being an anonymous dot in a field.
    apple: coords
      ? `https://maps.apple.com/?ll=${encodeURIComponent(coords)}&q=${encodeURIComponent(label)}`
      : `https://maps.apple.com/?q=${encodeURIComponent(term)}`,
    geo: coords ? `geo:${coords}?q=${coords}(${encodeURIComponent(label)})` : null,
    hasCoords: Boolean(coords),
  };
  return urls;
}

/** Walking directions to a point, for the last few hundred metres to a door. */
export function walkDirectionsUrl(target) {
  const destination = coordString(target) || searchTermOf(target);
  if (!destination) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    destination
  )}&travelmode=walking`;
}

/**
 * Transit directions between two points.
 *
 * Deliberately carries no departure time: the documented Maps URL parameters do
 * not include one, and the undocumented parameter that does is a base64 blob
 * that would break silently. Better to open on the right pair and let the reader
 * set the time than to build a link that looks precise and is not.
 */
export function transitDirectionsUrl(fromTarget, toTarget) {
  const origin = coordString(fromTarget) || searchTermOf(fromTarget);
  const destination = coordString(toTarget) || searchTermOf(toTarget);
  if (!origin || !destination) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    origin
  )}&destination=${encodeURIComponent(destination)}&travelmode=transit`;
}

/** Transit directions between two ids the transit context knows about. */
export function transitDirectionsBetween(ctx, fromId, toId) {
  if (!ctx) return null;
  return transitDirectionsUrl(ctx.placeIndex?.get(fromId), ctx.placeIndex?.get(toId));
}

/** A dialable link, or null, so a card can drop the row rather than show "—". */
export function telUrl(phone) {
  const digits = String(phone ?? '').replace(/[^\d+]/g, '');
  return digits.length >= 6 ? `tel:${digits}` : null;
}
