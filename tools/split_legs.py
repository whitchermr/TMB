#!/usr/bin/env python3
"""Cut the TMB loop into per-day legs described by data/route/route-plan.json.

Writes one file per day/variant to data/route/legs/ plus a legs/index.json
manifest. Elevation is filled in afterwards by tools/fetch_elevation.py.

The loop's stored direction is arbitrary, so this script determines travel
direction empirically: it projects every stage stop onto the loop and reverses
the loop if the stops do not appear in itinerary order. That avoids hard-coding
an assumption about how OSM happened to digitise the relation.

    python3 tools/split_legs.py [--spacing 25] [--diagnose]
"""

import argparse
import sys

from tmblib import (
    ROOT,
    cumulative_distances,
    decimate_indices,
    decimate_line,
    haversine,
    line_length_m,
    project_point_onto_line,
    read_json,
    rotate_closed_loop,
    round_coords,
    slice_line,
    write_json,
)

LEGS_DIR = ROOT / "data" / "route" / "legs"

# An anchor further than this from the trail is almost certainly mis-typed or in
# the wrong valley, which would silently produce a wrong leg boundary.
OFFSET_WARN_M = 250.0


def load_main_loop(plan):
    geo = read_json(ROOT / plan["mainRoute"])
    return geo["features"][0]["geometry"]["coordinates"]


def anchor_point(anchors, key):
    a = anchors[key]
    return [a["lon"], a["lat"]]


def orient_loop(loop, plan):
    """Rotate the loop to the start anchor and orient it in itinerary order."""
    anchors = plan["anchors"]
    stage_keys = [k for k, v in anchors.items() if v.get("isStageStop")]
    itinerary_order = [plan["startAnchor"]]
    for day in plan["days"]:
        for key in (day.get("from"), day.get("to")):
            if key in stage_keys and key not in itinerary_order:
                itinerary_order.append(key)

    start = project_point_onto_line(anchor_point(anchors, plan["startAnchor"]), loop)
    loop = rotate_closed_loop(loop, start["position_m"])

    def positions(candidate):
        cum = cumulative_distances(candidate)
        return [
            project_point_onto_line(anchor_point(anchors, key), candidate, cum)["position_m"]
            for key in itinerary_order
        ]

    forward = positions(loop)
    ascending = sum(1 for i in range(len(forward) - 1) if forward[i + 1] > forward[i])
    descending = len(forward) - 1 - ascending

    if descending > ascending:
        print(f"  stops run backwards along the stored loop ({descending}/{len(forward) - 1}), reversing")
        loop = list(reversed(loop))
        loop = rotate_closed_loop(loop, project_point_onto_line(anchor_point(anchors, plan["startAnchor"]), loop)["position_m"])
    else:
        print(f"  stored loop already runs in itinerary order ({ascending}/{len(forward) - 1})")

    return loop, itinerary_order


def resolve_anchors(loop, plan, itinerary_order):
    """Project every anchor onto the oriented loop and report its offset."""
    cum = cumulative_distances(loop)
    total = cum[-1]
    resolved = {}

    for key, meta in plan["anchors"].items():
        projection = project_point_onto_line([meta["lon"], meta["lat"]], loop, cum)
        resolved[key] = {
            "key": key,
            "name": meta["name"],
            "lat": meta["lat"],
            "lon": meta["lon"],
            "country": meta.get("country"),
            "note": meta.get("note"),
            "isStageStop": bool(meta.get("isStageStop")),
            "onMainRoute": meta.get("onMainRoute", True),
            "acceptOffset_m": meta.get("acceptOffset_m"),
            "position_m": projection["position_m"],
            "offset_m": projection["offset_m"],
            "snapped": projection["snapped"],
        }

    # The loop was rotated to begin at the start anchor, so that anchor sits at
    # both ends of the line. Pin it to 0 for use as a segment start and to the
    # full length for use as a segment end, otherwise day 1 collapses to nothing.
    start = resolved[plan["startAnchor"]]
    start["position_m"] = 0.0
    start["finish_position_m"] = total

    print("\n  anchor projections (offset = distance from anchor to trail):")
    for key in sorted(resolved, key=lambda k: resolved[k]["position_m"]):
        info = resolved[key]
        allowed = info["acceptOffset_m"] or OFFSET_WARN_M
        if not info["onMainRoute"]:
            flag = "  (off main route by design)"
        elif info["offset_m"] > allowed:
            flag = "  <-- check this"
        elif info["acceptOffset_m"]:
            flag = "  (known offset, accepted)"
        else:
            flag = ""
        print(
            f"    {info['position_m'] / 1000:7.2f} km  offset {info['offset_m']:7.1f} m  {key}{flag}"
        )

    return resolved, total


def variant_geometry(slug):
    geo = read_json(ROOT / "data" / "route" / "variants" / f"{slug}.geojson")
    return geo["features"][0]["geometry"]["coordinates"]


def build_segment(segment, loop, cum, resolved, total, previous_end):
    """Resolve one declared segment into concrete geometry plus metadata."""
    kind = segment["type"]

    if "variant" in segment:
        coords = variant_geometry(segment["variant"])
        if previous_end is not None:
            # Variants are stored in OSM's arbitrary direction; connect whichever
            # end is closer to where the previous segment left off.
            if haversine(previous_end, coords[-1]) < haversine(previous_end, coords[0]):
                coords = list(reversed(coords))
        return {
            "type": kind,
            "source": "variant",
            "variant": segment["variant"],
            "note": segment.get("note"),
            "coordinates": coords,
        }

    start_key, end_key = segment["from"], segment["to"]
    start = resolved.get(start_key)
    end = resolved.get(end_key)

    if start is None or end is None:
        # Off-trail transit endpoint (e.g. Chamonix): keep it as a labelled
        # segment with no trail geometry.
        return {
            "type": kind,
            "source": "offRoute",
            "from": start_key,
            "to": end_key,
            "mode": segment.get("mode"),
            "note": segment.get("note"),
            "coordinates": [],
        }

    start_m = start["position_m"]
    end_m = end.get("finish_position_m", end["position_m"])
    if end_m <= start_m:
        end_m = end["position_m"] if end["position_m"] > start_m else total

    coords = slice_line(loop, start_m, end_m, cum)
    return {
        "type": kind,
        "source": "main",
        "from": start_key,
        "to": end_key,
        "mode": segment.get("mode"),
        "note": segment.get("note"),
        "start_m": start_m,
        "end_m": end_m,
        "coordinates": coords,
    }


def build_variant(day, variant_key, variant, loop, cum, resolved, total, spacing):
    segments = []
    previous_end = None

    for declared in variant["segments"]:
        resolved_segment = build_segment(declared, loop, cum, resolved, total, previous_end)
        coords = resolved_segment["coordinates"]
        if coords:
            previous_end = coords[-1]
        segments.append(resolved_segment)

    track = []
    # Distances come from the full-resolution geometry, sampled at the kept
    # vertices, so the profile's x-axis reflects the real trail length.
    track_cum = []
    walked_m = 0.0
    out_segments = []
    hiking_m = 0.0
    transit_m = 0.0

    for segment in segments:
        coords = segment["coordinates"]

        if segment["type"] == "hike" and len(coords) >= 2:
            full_cum = cumulative_distances(coords)
            indices = decimate_indices(coords, spacing_m=spacing)
            thinned = [list(coords[i]) for i in indices]
            thinned_cum = [full_cum[i] for i in indices]

            # Avoid duplicating the shared vertex where two hike segments meet.
            if track and haversine(track[-1], thinned[0]) < 1.0:
                thinned = thinned[1:]
                thinned_cum = thinned_cum[1:]

            start_index = max(0, len(track) - (1 if track else 0))
            track.extend(thinned)
            track_cum.extend(walked_m + value for value in thinned_cum)

            length = full_cum[-1]
            walked_m += length
            hiking_m += length

            out_segments.append(
                {
                    "type": "hike",
                    "from": segment.get("from"),
                    "to": segment.get("to"),
                    "variant": segment.get("variant"),
                    "note": segment.get("note"),
                    "distance_m": round(length, 1),
                    "trackStart": start_index,
                    "trackEnd": len(track) - 1,
                }
            )
        else:
            thinned = decimate_line(coords, spacing_m=spacing) if len(coords) >= 2 else list(coords)
            length = line_length_m(coords) if len(coords) >= 2 else None
            if length:
                transit_m += length
            out_segments.append(
                {
                    "type": segment["type"],
                    "from": segment.get("from"),
                    "to": segment.get("to"),
                    "mode": segment.get("mode"),
                    "note": segment.get("note"),
                    "distance_m": round(length, 1) if length else None,
                    "geometry": round_coords(thinned) if thinned else [],
                }
            )

    cum_track = track_cum if len(track_cum) >= 2 else [0.0]

    return {
        "dayId": day["id"],
        "variant": variant_key,
        "label": variant.get("label", variant_key),
        "optional": bool(variant.get("optional")),
        "stage": day.get("stage"),
        "from": day.get("from"),
        "to": day.get("to"),
        "note": variant.get("note"),
        "plannedTotals": variant.get("plannedTotals"),
        "hikingDistance_m": round(hiking_m, 1),
        "transitDistance_m": round(transit_m, 1),
        "segments": out_segments,
        "track": round_coords(track),
        "cumulative_m": [round(d, 1) for d in cum_track],
        "elevation_m": None,
        "elevationSource": None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spacing", type=float, default=25.0, help="target vertex spacing in metres")
    parser.add_argument("--diagnose", action="store_true", help="report anchor projections and exit")
    args = parser.parse_args()

    plan = read_json(ROOT / "data" / "route" / "route-plan.json")

    print("Loading main loop...")
    loop = load_main_loop(plan)
    print(f"  {len(loop)} points, {line_length_m(loop) / 1000:.2f} km")

    print("\nOrienting loop...")
    loop, itinerary_order = orient_loop(loop, plan)
    resolved, total = resolve_anchors(loop, plan, itinerary_order)
    cum = cumulative_distances(loop)

    bad = [
        k
        for k, v in resolved.items()
        if v["onMainRoute"] and v["offset_m"] > (v["acceptOffset_m"] or OFFSET_WARN_M)
    ]
    if bad:
        print(f"\n  WARNING: anchors far from the trail: {', '.join(bad)}")

    if args.diagnose:
        return 0

    print(f"\nBuilding legs (target spacing {args.spacing:.0f} m)...")
    LEGS_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []

    for day in plan["days"]:
        for variant_key, variant in day["variants"].items():
            leg = build_variant(day, variant_key, variant, loop, cum, resolved, total, args.spacing)
            filename = f"{day['id']}-{variant_key}.json"
            write_json(LEGS_DIR / filename, leg)

            planned = leg.get("plannedTotals") or {}
            planned_km = planned.get("distance_km")
            computed_km = leg["hikingDistance_m"] / 1000
            delta = f" (planned {planned_km} km)" if planned_km else ""
            transit = (
                f" + {leg['transitDistance_m'] / 1000:.1f} km transit"
                if leg["transitDistance_m"]
                else ""
            )
            print(
                f"  {filename:28s} {computed_km:6.2f} km hiking{transit}"
                f"  {len(leg['track']):5d} pts{delta}"
            )

            manifest.append(
                {
                    "dayId": day["id"],
                    "variant": variant_key,
                    "label": leg["label"],
                    "optional": leg["optional"],
                    "stage": leg["stage"],
                    "file": f"data/route/legs/{filename}",
                    "hikingDistance_m": leg["hikingDistance_m"],
                    "transitDistance_m": leg["transitDistance_m"],
                    "pointCount": len(leg["track"]),
                }
            )

    write_json(LEGS_DIR / "index.json", manifest, compact=False)

    # Persist the oriented loop so the map draws the same direction the legs use.
    oriented = decimate_line(loop, spacing_m=args.spacing)
    write_json(
        ROOT / "data" / "route" / "tmb-loop-oriented.geojson",
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "name": "Tour du Mont Blanc — main loop",
                        "direction": plan["direction"],
                        "length_m": round(total, 1),
                        "point_count": len(oriented),
                        "source": "OpenStreetMap contributors (ODbL), relation 9678362",
                    },
                    "geometry": {"type": "LineString", "coordinates": round_coords(oriented)},
                }
            ],
        },
    )

    write_json(
        ROOT / "data" / "route" / "anchors.json",
        {
            "total_m": round(total, 1),
            "anchors": {
                k: {
                    "name": v["name"],
                    "lat": v["lat"],
                    "lon": v["lon"],
                    "country": v["country"],
                    "note": v["note"],
                    "isStageStop": v["isStageStop"],
                    "position_m": round(v["position_m"], 1),
                    "offset_m": round(v["offset_m"], 1),
                }
                for k, v in resolved.items()
            },
        },
        compact=False,
    )

    print(f"\nWrote {len(manifest)} legs, oriented loop ({len(oriented)} pts), and anchors.json")
    print("Next: python3 tools/fetch_elevation.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
