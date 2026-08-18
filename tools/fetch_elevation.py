#!/usr/bin/env python3
"""Fill in elevation for every leg point, then compute distance/gain/loss stats.

Providers are tried in order of accuracy for the terrain they cover:

  1. IGN Geoplateforme RGE ALTI (1 m) — France plus a strip across both borders.
     No API key, and the tile/altimetry APIs are exempt from Geoplateforme rate
     limiting, so this handles the bulk of the route in a handful of requests.
  2. swisstopo swissALTI3D (2 m) — the Swiss sections IGN does not reach.
     No API key. Single point per request, so these run on a small thread pool.
  3. OpenTopoData SRTM 30 m — Italian Val Veni / Val Ferret and anything the
     national services return as nodata. Rate limited to 1 request/second.

Results are cached in data/route/cache/elevation.json keyed by rounded
coordinate, so re-running is nearly free and legs that share geometry (the
shortcut and classic variants of days 1, 2, 5 and 6 are identical) cost nothing
extra.

    python3 tools/fetch_elevation.py [--only-cached] [--providers ign,swisstopo,opentopodata]
"""

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from tmblib import (
    ROOT,
    cumulative_distances,
    gain_loss,
    read_json,
    smooth_elevations,
    write_json,
)

LEGS_DIR = ROOT / "data" / "route" / "legs"
CACHE_PATH = ROOT / "data" / "route" / "cache" / "elevation.json"

# Cache/lookup key precision. 5 dp is ~1.1 m — finer than any DEM here, and
# coarse enough that shared geometry between variants hits the same key.
KEY_PRECISION = 5

USER_AGENT = "tmb-trip-planner/1.0 (static site elevation precompute)"

IGN_BATCH = 150
IGN_URL = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json"

SWISSTOPO_URL = "https://api3.geo.admin.ch/rest/services/height"
SWISSTOPO_WORKERS = 8
# Generous box around Switzerland; the API returns nothing useful outside it.
CH_BBOX = (45.79, 47.85, 5.9, 10.55)

OPENTOPO_URL = "https://api.opentopodata.org/v1/srtm30m"
OPENTOPO_BATCH = 100
OPENTOPO_DELAY = 1.1

NODATA = -9999.0


def key_of(lon, lat):
    return f"{round(lat, KEY_PRECISION)},{round(lon, KEY_PRECISION)}"


def http_get(url, timeout=90):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def valid(value):
    return value is not None and value > NODATA and math.isfinite(value)


# --------------------------------------------------------------------------
# Provider 1 — IGN RGE ALTI
# --------------------------------------------------------------------------


def fetch_ign(points, cache):
    """points: list of (lon, lat). Batched GET; returns count resolved."""
    resolved = 0
    total_batches = (len(points) + IGN_BATCH - 1) // IGN_BATCH

    for batch_index in range(total_batches):
        batch = points[batch_index * IGN_BATCH : (batch_index + 1) * IGN_BATCH]
        query = urllib.parse.urlencode(
            {
                "lon": "|".join(f"{lon:.6f}" for lon, _ in batch),
                "lat": "|".join(f"{lat:.6f}" for _, lat in batch),
                "resource": "ign_rge_alti_wld",
                "delimiter": "|",
                "zonly": "true",
                "indent": "false",
            }
        )
        try:
            payload = http_get(f"{IGN_URL}?{query}")
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as exc:
            print(f"    batch {batch_index + 1}/{total_batches} failed: {exc}")
            continue

        values = payload.get("elevations") or []
        if len(values) != len(batch):
            print(f"    batch {batch_index + 1}: expected {len(batch)} values, got {len(values)}")
        for (lon, lat), value in zip(batch, values):
            if isinstance(value, dict):
                value = value.get("z")
            try:
                value = float(value)
            except (TypeError, ValueError):
                continue
            if valid(value):
                cache[key_of(lon, lat)] = {"e": round(value, 1), "src": "ign-rgealti"}
                resolved += 1

        done = min((batch_index + 1) * IGN_BATCH, len(points))
        print(f"    {done}/{len(points)} points ({resolved} resolved)", flush=True)

    return resolved


# --------------------------------------------------------------------------
# Provider 2 — swisstopo swissALTI3D
# --------------------------------------------------------------------------


def wgs84_to_lv95(lat, lon):
    """swisstopo's published closed-form approximation, accurate to about 1 m.

    Used instead of the reframe web service so no extra network round-trip is
    needed per point.
    """
    phi = (lat * 3600 - 169028.66) / 10000.0
    lam = (lon * 3600 - 26782.5) / 10000.0
    easting = (
        2600072.37
        + 211455.93 * lam
        - 10938.51 * lam * phi
        - 0.36 * lam * phi * phi
        - 44.54 * lam**3
    )
    northing = (
        1200147.07
        + 308807.95 * phi
        + 3745.25 * lam * lam
        + 76.63 * phi * phi
        - 194.56 * lam * lam * phi
        + 119.79 * phi**3
    )
    return easting, northing


def in_switzerland(lat, lon):
    lat_min, lat_max, lon_min, lon_max = CH_BBOX
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


def fetch_swisstopo(points, cache):
    swiss = [(lon, lat) for lon, lat in points if in_switzerland(lat, lon)]
    if not swiss:
        print("    no candidate points inside the Swiss bounding box")
        return 0

    print(f"    {len(swiss)} points inside Switzerland, {SWISSTOPO_WORKERS} workers")

    def one(point):
        lon, lat = point
        easting, northing = wgs84_to_lv95(lat, lon)
        query = urllib.parse.urlencode(
            {"easting": f"{easting:.2f}", "northing": f"{northing:.2f}", "sr": "2056"}
        )
        for _ in range(3):
            try:
                payload = http_get(f"{SWISSTOPO_URL}?{query}", timeout=45)
                value = float(payload.get("height"))
                return point, value
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, TypeError):
                time.sleep(0.5)
        return point, None

    resolved = 0
    with ThreadPoolExecutor(max_workers=SWISSTOPO_WORKERS) as pool:
        for index, (point, value) in enumerate(pool.map(one, swiss), start=1):
            if valid(value):
                lon, lat = point
                cache[key_of(lon, lat)] = {"e": round(value, 1), "src": "swisstopo-alti3d"}
                resolved += 1
            if index % 250 == 0 or index == len(swiss):
                print(f"    {index}/{len(swiss)} points ({resolved} resolved)", flush=True)

    return resolved


# --------------------------------------------------------------------------
# Provider 3 — OpenTopoData SRTM 30 m
# --------------------------------------------------------------------------


def fetch_opentopodata(points, cache):
    resolved = 0
    total_batches = (len(points) + OPENTOPO_BATCH - 1) // OPENTOPO_BATCH

    for batch_index in range(total_batches):
        batch = points[batch_index * OPENTOPO_BATCH : (batch_index + 1) * OPENTOPO_BATCH]
        locations = "|".join(f"{lat:.6f},{lon:.6f}" for lon, lat in batch)
        query = urllib.parse.urlencode({"locations": locations, "interpolation": "cubic"})
        try:
            payload = http_get(f"{OPENTOPO_URL}?{query}")
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as exc:
            print(f"    batch {batch_index + 1}/{total_batches} failed: {exc}")
            time.sleep(5)
            continue

        for (lon, lat), result in zip(batch, payload.get("results", [])):
            value = result.get("elevation")
            if valid(value):
                cache[key_of(lon, lat)] = {"e": round(float(value), 1), "src": "opentopodata-srtm30m"}
                resolved += 1

        done = min((batch_index + 1) * OPENTOPO_BATCH, len(points))
        print(f"    {done}/{len(points)} points ({resolved} resolved)", flush=True)
        if batch_index + 1 < total_batches:
            time.sleep(OPENTOPO_DELAY)

    return resolved


PROVIDERS = {
    "ign": ("IGN RGE ALTI (France + border strip, 1 m)", fetch_ign),
    "swisstopo": ("swisstopo swissALTI3D (Switzerland, 2 m)", fetch_swisstopo),
    "opentopodata": ("OpenTopoData SRTM 30 m (Italy + gaps)", fetch_opentopodata),
}


# --------------------------------------------------------------------------
# Leg statistics
# --------------------------------------------------------------------------


def annotate_leg(leg, cache):
    """Attach the elevation series and derived stats to a leg in place."""
    track = leg["track"]
    elevations = []
    sources = {}
    missing = 0

    for lon, lat in track:
        entry = cache.get(key_of(lon, lat))
        if entry is None:
            elevations.append(None)
            missing += 1
        else:
            elevations.append(entry["e"])
            sources[entry["src"]] = sources.get(entry["src"], 0) + 1

    # Bridge isolated gaps by linear interpolation so the profile stays drawable.
    elevations = interpolate_gaps(elevations)
    smoothed = smooth_elevations(elevations, window=5)
    gain, loss = gain_loss(smoothed, threshold_m=5.0)

    known = [e for e in elevations if e is not None]
    cumulative = leg.get("cumulative_m") or cumulative_distances(track)

    leg["elevation_m"] = [round(e, 1) if e is not None else None for e in elevations]
    leg["elevationSource"] = sources
    leg["missingElevation"] = missing
    leg["stats"] = {
        "distance_m": round(cumulative[-1], 1) if cumulative else 0.0,
        "gain_m": round(gain),
        "loss_m": round(loss),
        "minElevation_m": round(min(known)) if known else None,
        "maxElevation_m": round(max(known)) if known else None,
        "startElevation_m": round(known[0]) if known else None,
        "endElevation_m": round(known[-1]) if known else None,
    }

    # Per-segment gain/loss so a day made of several pieces can be broken down.
    for segment in leg["segments"]:
        if segment.get("type") != "hike":
            continue
        start, end = segment.get("trackStart"), segment.get("trackEnd")
        if start is None or end is None or end <= start:
            continue
        chunk = smoothed[start : end + 1]
        seg_gain, seg_loss = gain_loss(chunk, threshold_m=5.0)
        segment["gain_m"] = round(seg_gain)
        segment["loss_m"] = round(seg_loss)

    return leg


def interpolate_gaps(values):
    out = list(values)
    n = len(out)
    index = 0
    while index < n:
        if out[index] is not None:
            index += 1
            continue
        start = index
        while index < n and out[index] is None:
            index += 1
        before = out[start - 1] if start > 0 else None
        after = out[index] if index < n else None
        if before is None and after is None:
            continue
        if before is None:
            fill = [after] * (index - start)
        elif after is None:
            fill = [before] * (index - start)
        else:
            span = index - start + 1
            fill = [before + (after - before) * (k + 1) / span for k in range(index - start)]
        out[start:index] = fill
    return out


# --------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--providers",
        default="ign,swisstopo,opentopodata",
        help="comma-separated provider order",
    )
    parser.add_argument(
        "--only-cached",
        action="store_true",
        help="recompute leg statistics from the cache without any network calls",
    )
    args = parser.parse_args()

    leg_files = sorted(p for p in LEGS_DIR.glob("*.json") if p.name != "index.json")
    if not leg_files:
        raise SystemExit("No leg files found. Run tools/split_legs.py first.")

    legs = {path: read_json(path) for path in leg_files}

    cache = {}
    if CACHE_PATH.exists():
        cache = read_json(CACHE_PATH)
        print(f"Loaded {len(cache)} cached elevations")

    unique = {}
    for leg in legs.values():
        for lon, lat in leg["track"]:
            unique.setdefault(key_of(lon, lat), (lon, lat))
    print(f"{len(unique)} unique points across {len(legs)} legs")

    if not args.only_cached:
        for name in [p.strip() for p in args.providers.split(",") if p.strip()]:
            if name not in PROVIDERS:
                print(f"Unknown provider '{name}', skipping")
                continue
            pending = [point for key, point in unique.items() if key not in cache]
            if not pending:
                print("\nAll points resolved.")
                break
            label, fetcher = PROVIDERS[name]
            print(f"\n{label}: {len(pending)} points outstanding")
            resolved = fetcher(pending, cache)
            print(f"  resolved {resolved} points")
            write_json(CACHE_PATH, cache)

    write_json(CACHE_PATH, cache)
    outstanding = [key for key in unique if key not in cache]
    if outstanding:
        print(f"\nWARNING: {len(outstanding)} points still have no elevation; gaps will be interpolated")

    print("\nLeg statistics:")
    print(
        f"  {'leg':26s} {'dist km':>8s} {'gain m':>7s} {'loss m':>7s}"
        f" {'planned gain':>13s} {'delta':>7s}"
    )
    manifest = read_json(LEGS_DIR / "index.json")
    manifest_by_id = {(m["dayId"], m["variant"]): m for m in manifest}

    for path, leg in legs.items():
        annotate_leg(leg, cache)
        write_json(path, leg)

        stats = leg["stats"]
        planned = leg.get("plannedTotals") or {}
        planned_gain = planned.get("gain_m")
        delta = f"{stats['gain_m'] - planned_gain:+d}" if planned_gain else "-"
        print(
            f"  {path.name:26s} {stats['distance_m'] / 1000:8.2f} {stats['gain_m']:7d}"
            f" {stats['loss_m']:7d} {planned_gain if planned_gain else '-':>13} {delta:>7s}"
        )

        entry = manifest_by_id.get((leg["dayId"], leg["variant"]))
        if entry is not None:
            entry["stats"] = stats
            entry["elevationSource"] = leg["elevationSource"]

    write_json(LEGS_DIR / "index.json", manifest, compact=False)

    mix = {}
    for entry in cache.values():
        mix[entry["src"]] = mix.get(entry["src"], 0) + 1
    print("\nElevation source mix:")
    for src, count in sorted(mix.items(), key=lambda kv: -kv[1]):
        print(f"  {src:24s} {count:6d} points ({count / max(1, len(cache)) * 100:5.1f}%)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
