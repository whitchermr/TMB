#!/usr/bin/env python3
"""Shared geometry and I/O helpers for the TMB route pipeline.

Coordinates are GeoJSON order throughout: [longitude, latitude] in WGS84
decimal degrees. Distances are metres.

Stdlib only — the pipeline must run without pip or npm.
"""

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

EARTH_RADIUS_M = 6371008.8

# Two OSM nodes sharing an ID come back with byte-identical coordinates, so
# stitching only needs a tolerance to absorb float round-trips (~1 cm).
COORD_TOL = 1e-7


# --------------------------------------------------------------------------
# I/O
# --------------------------------------------------------------------------


def write_json(path, obj, compact=True):
    """Write JSON, creating parent directories.

    Route/profile files are written compactly because they are large arrays of
    numbers; hand-edited trip files stay indented and readable.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    else:
        text = json.dumps(obj, indent=2, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8")
    return path


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def round_coords(coords, precision=6):
    """Trim coordinate precision. 6 dp is ~11 cm — far beyond trail accuracy."""
    return [[round(lon, precision), round(lat, precision)] for lon, lat in coords]


# --------------------------------------------------------------------------
# Distance and bearing
# --------------------------------------------------------------------------


def haversine(a, b):
    """Great-circle distance in metres between [lon, lat] points."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, h)))


def line_length_m(coords):
    return sum(haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def cumulative_distances(coords):
    """Cumulative distance in metres at each vertex, starting at 0."""
    cum = [0.0]
    for i in range(len(coords) - 1):
        cum.append(cum[-1] + haversine(coords[i], coords[i + 1]))
    return cum


def bearing_deg(a, b):
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


# --------------------------------------------------------------------------
# Local planar projection
#
# The whole route fits in a ~60 km box, so an equirectangular projection about
# a local origin is accurate to well under a metre and makes point-to-segment
# projection simple arithmetic.
# --------------------------------------------------------------------------


def _planar(coord, origin):
    lat_scale = EARTH_RADIUS_M * math.pi / 180.0
    lon_scale = lat_scale * math.cos(math.radians(origin[1]))
    return ((coord[0] - origin[0]) * lon_scale, (coord[1] - origin[1]) * lat_scale)


def project_point_onto_line(point, coords, cum=None):
    """Perpendicular-project a point onto a polyline.

    Returns a dict with the arc-length position along the line, the snapped
    coordinate, the offset from the line, and the segment index. Used to place
    stage towns and viewpoints at their true position along the trail rather
    than snapping to the nearest vertex.
    """
    if cum is None:
        cum = cumulative_distances(coords)

    best = None
    for i in range(len(coords) - 1):
        a, b = coords[i], coords[i + 1]
        origin = a
        px, py = _planar(point, origin)
        ax, ay = 0.0, 0.0
        bx, by = _planar(b, origin)
        dx, dy = bx - ax, by - ay
        seg_len_sq = dx * dx + dy * dy
        if seg_len_sq == 0:
            t = 0.0
        else:
            t = ((px - ax) * dx + (py - ay) * dy) / seg_len_sq
            t = max(0.0, min(1.0, t))
        cx, cy = ax + t * dx, ay + t * dy
        offset = math.hypot(px - cx, py - cy)
        if best is None or offset < best["offset_m"]:
            snapped = [
                a[0] + t * (b[0] - a[0]),
                a[1] + t * (b[1] - a[1]),
            ]
            best = {
                "offset_m": offset,
                "position_m": cum[i] + t * (cum[i + 1] - cum[i]),
                "snapped": snapped,
                "segment": i,
                "t": t,
            }
    return best


# --------------------------------------------------------------------------
# Polyline assembly and slicing
# --------------------------------------------------------------------------


def _same(a, b):
    return abs(a[0] - b[0]) <= COORD_TOL and abs(a[1] - b[1]) <= COORD_TOL


def chain_ways(ways):
    """Stitch OSM member ways into maximal connected polylines.

    Member ways arrive in relation order but individual ways may be digitised
    against the direction of travel, so each candidate is tested at both ends
    of the growing chain and reversed when needed. Returns a list of chains,
    longest-first.
    """
    remaining = [list(w) for w in ways if len(w) >= 2]
    chains = []

    while remaining:
        chain = remaining.pop(0)
        extended = True
        while extended and remaining:
            extended = False
            for index, way in enumerate(remaining):
                if _same(way[0], chain[-1]):
                    chain.extend(way[1:])
                elif _same(way[-1], chain[-1]):
                    chain.extend(list(reversed(way))[1:])
                elif _same(way[-1], chain[0]):
                    chain = way[:-1] + chain
                elif _same(way[0], chain[0]):
                    chain = list(reversed(way))[:-1] + chain
                else:
                    continue
                remaining.pop(index)
                extended = True
                break
        chains.append(chain)

    chains.sort(key=line_length_m, reverse=True)
    return chains


def rotate_closed_loop(coords, position_m):
    """Re-cut a closed loop so it starts at the given arc-length position.

    The returned loop is closed (first point repeated at the end).
    """
    cum = cumulative_distances(coords)
    total = cum[-1]
    position_m = position_m % total

    start_point, start_index = _interpolate_at(coords, cum, position_m)
    rotated = [start_point]
    rotated.extend(coords[start_index + 1 :])
    # Drop the duplicated closing vertex before wrapping around.
    if _same(coords[0], coords[-1]):
        rotated.extend(coords[1 : start_index + 1])
    else:
        rotated.extend(coords[: start_index + 1])
    rotated.append(list(start_point))
    return _dedupe(rotated)


def _interpolate_at(coords, cum, position_m):
    """Point at an arc-length position, plus the index of the vertex before it."""
    if position_m <= 0:
        return list(coords[0]), 0
    if position_m >= cum[-1]:
        return list(coords[-1]), len(coords) - 2
    lo, hi = 0, len(cum) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if cum[mid] <= position_m:
            lo = mid
        else:
            hi = mid
    span = cum[lo + 1] - cum[lo]
    t = 0.0 if span == 0 else (position_m - cum[lo]) / span
    a, b = coords[lo], coords[lo + 1]
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], lo


def slice_line(coords, start_m, end_m, cum=None):
    """Extract the sub-polyline between two arc-length positions."""
    if cum is None:
        cum = cumulative_distances(coords)
    start_m = max(0.0, min(start_m, cum[-1]))
    end_m = max(0.0, min(end_m, cum[-1]))
    if end_m <= start_m:
        return []

    start_point, start_index = _interpolate_at(coords, cum, start_m)
    end_point, end_index = _interpolate_at(coords, cum, end_m)

    out = [start_point]
    out.extend(coords[start_index + 1 : end_index + 1])
    out.append(end_point)
    return _dedupe(out)


def _dedupe(coords):
    out = [coords[0]]
    for point in coords[1:]:
        if not _same(point, out[-1]):
            out.append(point)
    return out


def decimate_indices(coords, spacing_m=25.0, angle_deg=20.0):
    """Indices of the vertices to keep when thinning a polyline.

    A vertex is kept when it is at least `spacing_m` from the previous kept
    vertex, or when the trail turns by more than `angle_deg` (so switchbacks
    survive). The result serves as both the rendered geometry and the sampling
    grid for elevation lookups, which keeps map and profile in exact agreement.

    Indices rather than coordinates are returned so callers can also look up
    each kept vertex's true along-trail distance in the full-resolution series.
    Measuring the thinned line instead would under-report distance by around 1%,
    because simplification cuts the corners off every switchback.
    """
    if len(coords) <= 2:
        return list(range(len(coords)))

    kept = [0]
    for i in range(1, len(coords) - 1):
        since_last = haversine(coords[kept[-1]], coords[i])
        if since_last >= spacing_m:
            kept.append(i)
            continue
        turn = abs(
            ((bearing_deg(coords[i], coords[i + 1]) - bearing_deg(coords[i - 1], coords[i])) + 180)
            % 360
            - 180
        )
        if turn >= angle_deg and since_last >= spacing_m * 0.2:
            kept.append(i)
    kept.append(len(coords) - 1)

    out = [kept[0]]
    for index in kept[1:]:
        if not _same(coords[index], coords[out[-1]]):
            out.append(index)
    return out


def decimate_line(coords, spacing_m=25.0, angle_deg=20.0):
    """Thinned copy of a polyline. See decimate_indices for the rules."""
    return [list(coords[i]) for i in decimate_indices(coords, spacing_m, angle_deg)]


# --------------------------------------------------------------------------
# Elevation statistics
# --------------------------------------------------------------------------


def smooth_elevations(elevations, window=5):
    """Centred moving average, used before computing cumulative gain.

    DEM sampling adds metre-scale noise that a naive sum of positive deltas
    turns into hundreds of metres of phantom climbing.
    """
    if window <= 1 or len(elevations) < window:
        return list(elevations)
    half = window // 2
    out = []
    for i in range(len(elevations)):
        lo = max(0, i - half)
        hi = min(len(elevations), i + half + 1)
        chunk = [e for e in elevations[lo:hi] if e is not None]
        out.append(sum(chunk) / len(chunk) if chunk else elevations[i])
    return out


def gain_loss(elevations, threshold_m=5.0):
    """Cumulative ascent and descent using run-based hysteresis.

    Consecutive deltas of the same sign are accumulated into a run, and the run
    only counts once it exceeds `threshold_m`. This is the standard way to stop
    DEM noise from inflating totals, and it is what makes computed figures
    comparable to published stage profiles.
    """
    values = [e for e in elevations if e is not None]
    if len(values) < 2:
        return 0.0, 0.0

    gain = 0.0
    loss = 0.0
    run = 0.0
    for i in range(1, len(values)):
        delta = values[i] - values[i - 1]
        if run == 0 or (run > 0) == (delta > 0):
            run += delta
        else:
            if abs(run) >= threshold_m:
                if run > 0:
                    gain += run
                else:
                    loss -= run
            run = delta
    if abs(run) >= threshold_m:
        if run > 0:
            gain += run
        else:
            loss -= run
    return gain, loss
