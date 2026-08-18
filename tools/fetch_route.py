#!/usr/bin/env python3
"""Fetch Tour du Mont Blanc trail geometry from OpenStreetMap via Overpass.

Writes data/route/tmb-main.geojson (the continuous main loop) and one file per
official variant under data/route/variants/.

Source: OSM superroute relation 124456 "Tour du Mont Blanc". The main itinerary
(relation 9678362) is a closed loop; variants are sibling relations tagged
role=alternative. Data is ODbL — attribution is rendered on about.html.

Run via tools/run-pipeline.sh, or directly:
    python3 tools/fetch_route.py [--offline]
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from tmblib import ROOT, chain_ways, line_length_m, write_json

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

MAIN_RELATION = 9678362

# Verified continuous single-line variants under superroute 124456.
VARIANTS = {
    9678296: {"slug": "col-des-fours", "name": "Col des Fours"},
    9678380: {"slug": "fenetre-darpette", "name": "Fenêtre d'Arpette"},
    9678267: {"slug": "col-de-tricot", "name": "Col de Tricot"},
    9678437: {"slug": "les-grands", "name": "Les Grands"},
    9678501: {"slug": "le-tour", "name": "Le Tour"},
    9678726: {"slug": "vallorcine", "name": "Vallorcine"},
    9678375: {"slug": "tete-bernarda", "name": "Tête Bernarda"},
}

RAW_DIR = ROOT / "data" / "route" / "raw"


def build_query():
    ids = ",".join(str(i) for i in [MAIN_RELATION] + sorted(VARIANTS))
    return f"[out:json][timeout:300];rel(id:{ids});out geom;"


def fetch(query):
    """POST the query to Overpass, trying mirrors and backing off on 429/504."""
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error = None
    for attempt in range(4):
        for endpoint in OVERPASS_ENDPOINTS:
            request = urllib.request.Request(
                endpoint,
                data=body,
                headers={
                    "User-Agent": "tmb-trip-planner/1.0 (static site route extraction)",
                    "Accept": "application/json",
                },
            )
            try:
                print(f"  querying {endpoint} (attempt {attempt + 1})...", flush=True)
                with urllib.request.urlopen(request, timeout=300) as response:
                    return json.loads(response.read().decode("utf-8"))
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
                last_error = exc
                print(f"    failed: {exc}", flush=True)
        wait = 10 * (attempt + 1)
        print(f"  backing off {wait}s", flush=True)
        time.sleep(wait)
    raise SystemExit(f"Overpass unreachable after retries: {last_error}")


def ways_from_relation(relation):
    """Extract member way geometries in relation member order.

    Returns a list of (role, [[lon, lat], ...]) in GeoJSON axis order.
    """
    ways = []
    for member in relation.get("members", []):
        if member.get("type") != "way":
            continue
        geometry = member.get("geometry")
        if not geometry:
            continue
        coords = [[pt["lon"], pt["lat"]] for pt in geometry if pt.get("lon") is not None]
        if len(coords) >= 2:
            ways.append((member.get("role", ""), coords))
    return ways


def relation_to_feature(relation, extra_props=None):
    ways = ways_from_relation(relation)
    if not ways:
        raise ValueError(f"relation {relation.get('id')} has no way geometry")

    chains = chain_ways([coords for _role, coords in ways])
    if len(chains) > 1:
        lengths = [line_length_m(c) for c in chains]
        print(
            f"    warning: {len(chains)} disconnected chains "
            f"(lengths m: {[round(x) for x in lengths]}); keeping longest",
            flush=True,
        )
        chains = [max(chains, key=line_length_m)]

    line = chains[0]
    tags = relation.get("tags", {})
    closed = line[0] == line[-1]
    props = {
        "osm_relation": relation.get("id"),
        "name": tags.get("name"),
        "ref": tags.get("ref"),
        "roundtrip": closed,
        "point_count": len(line),
        "length_m": round(line_length_m(line), 1),
        "source": "OpenStreetMap contributors (ODbL)",
    }
    if extra_props:
        props.update(extra_props)
    return {"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": line}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--offline",
        action="store_true",
        help="reuse the cached Overpass payload in data/route/raw/ instead of refetching",
    )
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = RAW_DIR / "overpass-relations.json"

    if args.offline:
        if not raw_path.exists():
            raise SystemExit(f"--offline requested but {raw_path} is missing")
        print(f"Reading cached Overpass payload {raw_path}")
        payload = json.loads(raw_path.read_text())
    else:
        print("Fetching TMB relations from Overpass...")
        payload = fetch(build_query())
        raw_path.write_text(json.dumps(payload))
        print(f"  cached raw payload -> {raw_path.relative_to(ROOT)}")

    relations = {el["id"]: el for el in payload.get("elements", []) if el.get("type") == "relation"}
    if MAIN_RELATION not in relations:
        raise SystemExit(f"main relation {MAIN_RELATION} missing from Overpass response")

    print(f"\nMain loop (relation {MAIN_RELATION}):")
    main_feature = relation_to_feature(
        relations[MAIN_RELATION], {"role": "main", "slug": "tmb-main"}
    )
    coords = main_feature["geometry"]["coordinates"]
    print(f"  {len(coords)} points, {main_feature['properties']['length_m'] / 1000:.2f} km")
    print(f"  closed loop: {main_feature['properties']['roundtrip']}")
    if not main_feature["properties"]["roundtrip"]:
        print("  warning: main route did not close; leg splitting will still work but check the data")

    write_json(
        ROOT / "data" / "route" / "tmb-main.geojson",
        {"type": "FeatureCollection", "features": [main_feature]},
    )
    print("  wrote data/route/tmb-main.geojson")

    print("\nVariants:")
    index = []
    for rel_id, meta in sorted(VARIANTS.items(), key=lambda kv: kv[1]["slug"]):
        relation = relations.get(rel_id)
        if relation is None:
            print(f"  {meta['slug']}: relation {rel_id} not returned, skipping")
            continue
        try:
            feature = relation_to_feature(
                relation, {"role": "alternative", "slug": meta["slug"], "label": meta["name"]}
            )
        except ValueError as exc:
            print(f"  {meta['slug']}: {exc}")
            continue
        out = ROOT / "data" / "route" / "variants" / f"{meta['slug']}.geojson"
        write_json(out, {"type": "FeatureCollection", "features": [feature]})
        km = feature["properties"]["length_m"] / 1000
        print(f"  {meta['slug']}: {km:.2f} km, {feature['properties']['point_count']} points")
        index.append(
            {
                "slug": meta["slug"],
                "label": meta["name"],
                "osm_relation": rel_id,
                "length_m": feature["properties"]["length_m"],
                "file": f"data/route/variants/{meta['slug']}.geojson",
            }
        )

    write_json(ROOT / "data" / "route" / "variants" / "index.json", index)
    print(f"\nDone. {len(index)} variants written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
