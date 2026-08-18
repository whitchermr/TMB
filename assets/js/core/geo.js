/**
 * Client-side geometry, mirroring tools/tmblib.py.
 *
 * Coordinates are GeoJSON order — [longitude, latitude] — everywhere except at
 * the Leaflet boundary, which wants [lat, lon]. Conversion happens in map.js.
 */

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export function haversine(a, b) {
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const dLat = lat2 - lat1;
  const dLon = (b[0] - a[0]) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function cumulativeDistances(coords) {
  const cum = [0];
  for (let i = 0; i < coords.length - 1; i += 1) {
    cum.push(cum[i] + haversine(coords[i], coords[i + 1]));
  }
  return cum;
}

export function bounds(coords) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  coords.forEach(([lon, lat]) => {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  });
  return { minLon, minLat, maxLon, maxLat };
}

/**
 * Perpendicular-project a point onto a polyline.
 *
 * Uses a local equirectangular approximation per segment, which is accurate to
 * well under a metre over an area this size. Returns null for degenerate input.
 */
export function projectOntoTrack(point, coords, cum) {
  if (!coords || coords.length < 2) return null;
  const distances = cum || cumulativeDistances(coords);
  let best = null;

  for (let i = 0; i < coords.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    const latScale = (EARTH_RADIUS_M * Math.PI) / 180;
    const lonScale = latScale * Math.cos(a[1] * DEG);

    const px = (point[0] - a[0]) * lonScale;
    const py = (point[1] - a[1]) * latScale;
    const bx = (b[0] - a[0]) * lonScale;
    const by = (b[1] - a[1]) * latScale;

    const lengthSq = bx * bx + by * by;
    let t = lengthSq === 0 ? 0 : (px * bx + py * by) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const cx = t * bx;
    const cy = t * by;
    const offset = Math.hypot(px - cx, py - cy);

    if (best === null || offset < best.offset_m) {
      best = {
        offset_m: offset,
        position_m: distances[i] + t * (distances[i + 1] - distances[i]),
        index: i,
        t,
        snapped: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
      };
    }
  }
  return best;
}

/** Index of the track vertex nearest an arc-length position. */
export function indexAtDistance(cum, positionM) {
  if (!cum || cum.length === 0) return 0;
  let lo = 0;
  let hi = cum.length - 1;
  if (positionM <= cum[0]) return 0;
  if (positionM >= cum[hi]) return hi;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= positionM) lo = mid;
    else hi = mid;
  }
  return positionM - cum[lo] <= cum[hi] - positionM ? lo : hi;
}

/** Linear interpolation of a value series at an arc-length position. */
export function valueAtDistance(cum, values, positionM) {
  if (!values || values.length === 0) return null;
  const index = indexAtDistance(cum, positionM);
  const before = Math.max(0, Math.min(index, values.length - 2));
  const span = cum[before + 1] - cum[before];
  if (!span) return values[before];
  const t = Math.max(0, Math.min(1, (positionM - cum[before]) / span));
  const a = values[before];
  const b = values[before + 1];
  if (a == null || b == null) return a ?? b;
  return a + (b - a) * t;
}

/**
 * Attach position-along-the-day to each waypoint.
 *
 * A waypoint further than `detourThresholdM` from the track is treated as a
 * detour: it keeps its projected position (so it still sorts sensibly into the
 * day) but records the extra out-and-back distance and climb it costs.
 */
export function locateWaypoints(waypoints, track, cum, elevations, detourThresholdM = 400) {
  return waypoints
    .map((waypoint) => {
      const projection = projectOntoTrack([waypoint.lon, waypoint.lat], track, cum);
      if (!projection) return null;

      const isDetour = waypoint.isDetour === true || projection.offset_m > detourThresholdM;
      const trackElevation = valueAtDistance(cum, elevations, projection.position_m);

      return {
        ...waypoint,
        position_m: projection.position_m,
        offset_m: projection.offset_m,
        fraction: cum.length ? projection.position_m / cum[cum.length - 1] : 0,
        isDetour,
        detour: isDetour
          ? {
              distance_m: projection.offset_m * 2,
              gain_m:
                waypoint.elevation_m != null && trackElevation != null
                  ? Math.max(0, Math.round(waypoint.elevation_m - trackElevation))
                  : null,
            }
          : null,
        trackElevation_m: trackElevation,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.position_m - b.position_m);
}

/** Compass label from a bearing string or degrees, for photo facing hints. */
export function facingLabel(facing) {
  const names = {
    N: 'north',
    NE: 'north-east',
    E: 'east',
    SE: 'south-east',
    S: 'south',
    SW: 'south-west',
    W: 'west',
    NW: 'north-west',
  };
  return names[facing] || facing || '';
}
