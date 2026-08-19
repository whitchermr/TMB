#!/usr/bin/env python3
"""Attach published GTFS departure times to the curated services in data/transit.json.

The curated file is the backbone and this is enrichment, never replacement: a
service exists as a graph edge whether or not a feed covers it, and this tool
only fills in exact times and the stop the vehicle actually calls at. Nothing
here writes data/transit.json.

Feed coverage is inverted relative to need, which is why it works this way. The
Swiss 2027 timetable is published years ahead and covers Martigny, Orsières,
Champex, La Fouly, Trient and the Mont-Blanc Express. Chamonix Mobilité
republishes a single summer file each June. Italy publishes no feed at all, and
neither do the Les Chapieux navette or the Bourg-Saint-Maurice shuttle — the
services a bail-out day actually depends on. Those stay hand-curated.

Which services can be enriched is declared in data/transit.json: a service with
a `gtfs` block names its feed and enough to identify its route and direction.
Stops are matched to places by proximity rather than by id, so a feed renumbering
its stops costs nothing.

    python3 tools/fetch_transit.py                       # everything, cache first
    python3 tools/fetch_transit.py --only tmr-272-orsieres-ferret --force
    python3 tools/fetch_transit.py --offline              # cached zips only
    python3 tools/fetch_transit.py --date 2027-07-14      # basis date for times

The Swiss feed is around 53 MB and expands to gigabytes of stop_times. Raw zips
land in tools/cache/gtfs/, which is gitignored; stop_times.txt is streamed and
filtered rather than read into memory.
"""

import argparse
import csv
import datetime as dt
import io
import json
import sys
import urllib.error
import urllib.request
import zipfile
from collections import Counter, defaultdict

from tmblib import ROOT, haversine, read_json, write_json

TRANSIT_PATH = ROOT / "data" / "transit.json"
ANCHORS_PATH = ROOT / "data" / "route" / "anchors.json"
SETTINGS_PATH = ROOT / "data" / "settings.json"
OUT_PATH = ROOT / "data" / "transit-schedules.json"
CACHE_DIR = ROOT / "tools" / "cache" / "gtfs"

USER_AGENT = "tmb-trip-planner/1.0 (static site timetable precompute)"

# How far a feed's stop may be from a curated place and still be taken as it.
# Generous because a village stop and the trailhead a walk away are the same
# place for planning purposes, and every candidate is resolved to its nearest
# place anyway, so a wide radius adds tolerance rather than confusion.
MATCH_RADIUS_M = 1500.0

# A stopping pattern needs at least this many of the curated service's places to
# be recognisable as that service. Two is the minimum that says anything.
MIN_MATCHED_STOPS = 2

# Mirrors CONFIDENCE in assets/js/core/transit.js. Kept as a literal rather than
# parsed out of the JavaScript, and asserted equal by
# tools/test/check_transit_pipeline.py, because a value this file invents would
# render as an unstyled chip with no label rather than fail.
CONFIDENCE = ("estimate", "pattern-2026", "scheduled-2027")

SOURCES = {
    "swiss-2027": {
        "name": "Swiss timetable 2027 (GTFS)",
        "page": "https://data.opentransportdata.swiss/en/dataset/timetable-2027-gtfs2020",
        "url": "https://data.opentransportdata.swiss/en/dataset/timetable-2027-gtfs2020/permalink",
        "licence": "opentransportdata.swiss terms of use — attribution required",
        "attribution": "Timetable data: opentransportdata.swiss",
    },
    "chamonix": {
        "name": "Chamonix Mobilité (GTFS)",
        "page": "https://transport.data.gouv.fr/datasets?q=chamonix",
        # The resource URL carries the season in it and rotates every June, so it
        # is resolved through the API by title instead of pinned.
        "search": {"api": "https://transport.data.gouv.fr/api/datasets", "match": "chamonix"},
        "licence": "Licence Ouverte / ODbL — see the dataset page",
        "attribution": "Timetable data: Chamonix Mobilité via transport.data.gouv.fr",
    },
}


# --------------------------------------------------------------------------
# Download and cache
# --------------------------------------------------------------------------


def http_get(url, timeout=300):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def resolve_url(source):
    """The zip to download, resolving a search-based source through its API."""
    if source.get("url"):
        return source["url"]

    search = source["search"]
    payload = json.loads(http_get(search["api"], timeout=120).decode("utf-8"))
    needle = search["match"].lower()
    for dataset in payload:
        haystack = f"{dataset.get('title', '')} {dataset.get('slug', '')}".lower()
        if needle not in haystack:
            continue
        for resource in dataset.get("resources", []):
            if str(resource.get("format", "")).upper() == "GTFS" and resource.get("url"):
                return resource["url"]
    raise LookupError(f"no GTFS resource found matching {search['match']!r}")


def cached_zip(feed_id, force=False, offline=False):
    """Path to the feed's zip, downloading it unless told not to."""
    path = CACHE_DIR / f"{feed_id}.zip"
    if path.exists() and not force:
        print(f"  {feed_id}: cached ({path.stat().st_size / 1e6:.1f} MB)")
        return path
    if offline:
        print(f"  {feed_id}: not cached and --offline given, skipping")
        return None

    source = SOURCES[feed_id]
    try:
        url = resolve_url(source)
        print(f"  {feed_id}: downloading {url}")
        payload = http_get(url)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, LookupError, ValueError) as exc:
        print(f"  {feed_id}: download failed — {exc}")
        print(f"           fetch it by hand from {source['page']} and save as {path}")
        return None

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    print(f"  {feed_id}: saved {len(payload) / 1e6:.1f} MB")
    return path


# --------------------------------------------------------------------------
# GTFS reading
# --------------------------------------------------------------------------


def rows(zf, name):
    """Stream a GTFS table as dicts, or nothing at all if the file is absent.

    calendar.txt and feed_info.txt are both optional in the spec and both are
    missing from real feeds, so an absent table has to mean "no information"
    rather than an error.
    """
    if name not in zf.namelist():
        return
    with zf.open(name) as raw:
        # utf-8-sig: several European feeds ship a byte-order mark, which would
        # otherwise end up inside the first column name.
        for row in csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")):
            yield row


def gtfs_date(text):
    try:
        return dt.date(int(text[0:4]), int(text[4:6]), int(text[6:8]))
    except (TypeError, ValueError, IndexError):
        return None


def feed_window(zf):
    """The feed's own validity window, from feed_info if it says, else calendar."""
    for row in rows(zf, "feed_info.txt"):
        start, end = gtfs_date(row.get("feed_start_date")), gtfs_date(row.get("feed_end_date"))
        if start and end:
            return start, end

    starts, ends = [], []
    for row in rows(zf, "calendar.txt"):
        start, end = gtfs_date(row.get("start_date")), gtfs_date(row.get("end_date"))
        if start and end:
            starts.append(start)
            ends.append(end)
    if starts:
        return min(starts), max(ends)
    return None, None


WEEKDAY_COLUMNS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def active_services(zf, date):
    """The set of GTFS service_ids running on one date."""
    active = set()
    column = WEEKDAY_COLUMNS[date.weekday()]
    for row in rows(zf, "calendar.txt"):
        start, end = gtfs_date(row.get("start_date")), gtfs_date(row.get("end_date"))
        if start and end and start <= date <= end and row.get(column) == "1":
            active.add(row["service_id"])

    # Exceptions are applied second because that is what they are for: a feed
    # that expresses everything through calendar_dates.txt alone is legal, and
    # common in France.
    for row in rows(zf, "calendar_dates.txt"):
        if gtfs_date(row.get("date")) != date:
            continue
        if row.get("exception_type") == "1":
            active.add(row["service_id"])
        elif row.get("exception_type") == "2":
            active.discard(row["service_id"])
    return active


def seconds_of(text):
    """GTFS time to seconds after midnight. Hours past 24 are kept as they are."""
    try:
        parts = [int(part) for part in str(text).strip().split(":")]
    except ValueError:
        return None
    if len(parts) < 2:
        return None
    hours, minutes = parts[0], parts[1]
    seconds = parts[2] if len(parts) > 2 else 0
    return hours * 3600 + minutes * 60 + seconds


def clock(seconds):
    """Seconds after midnight as HH:MM, wrapping a post-midnight run round.

    A 24:35 departure is half past midneight, and the site's time model is a
    minute-of-day, so it has to wrap. It reads oddly in a list of departures and
    it is meant to: that run genuinely leaves after the date changes.
    """
    minutes = (seconds // 60) % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


# --------------------------------------------------------------------------
# Bounding the extract
# --------------------------------------------------------------------------


def read_anchors():
    """The anchors keyed by id, unwrapped from the file's total_m envelope."""
    return read_json(ANCHORS_PATH)["anchors"]


def curated_places(transit, anchors):
    """Every place with coordinates, as {id: (lon, lat)}."""
    located = {}
    for place in transit["places"]:
        anchor = anchors.get(place.get("anchorId")) if place.get("anchorId") else None
        lon = place.get("lon", anchor.get("lon") if anchor else None)
        lat = place.get("lat", anchor.get("lat") if anchor else None)
        if lon is not None and lat is not None:
            located[place["id"]] = (lon, lat)
    return located


def match_stops(zf, located, wanted):
    """Feed stops resolved to curated places: {stop_id: {place, distance, ...}}.

    Bounding the extract here is what keeps the output in the low hundreds of
    kilobytes instead of the gigabytes the Swiss feed expands to. The distance is
    kept because a village usually has several stops inside the radius and the
    nearest one is the one worth naming: Ferret and Le Clou/Les Granges are a
    kilometre apart on the same bus, and sending someone to the wrong one costs
    an hour.
    """
    targets = {pid: coord for pid, coord in located.items() if pid in wanted}
    matched = {}

    for row in rows(zf, "stops.txt"):
        try:
            point = (float(row["stop_lon"]), float(row["stop_lat"]))
        except (KeyError, TypeError, ValueError):
            continue
        best, best_distance = None, MATCH_RADIUS_M
        for place_id, target in targets.items():
            distance = haversine(point, target)
            if distance < best_distance:
                best, best_distance = place_id, distance
        if best is None:
            continue
        matched[row["stop_id"]] = {
            "place": best,
            "distance": best_distance,
            "name": row.get("stop_name", ""),
            "lon": round(point[0], 5),
            "lat": round(point[1], 5),
        }

    return matched


def normalise_line(text):
    """A route number reduced to what two feeds can be expected to agree on.

    Swiss timetables write the line as "12.272" where the feed says "272", and
    Chamonix zero-pads its single-digit lines to "01". Neither difference means
    anything, and a substring test loose enough to absorb both would match half
    the country.
    """
    return str(text).strip().lower().split(".")[-1].lstrip("0") or "0"


def route_matches(row, hint):
    """Whether a feed route is the one a curated service's `gtfs` block names."""
    if hint.get("shortName"):
        if normalise_line(row.get("route_short_name", "")) != normalise_line(hint["shortName"]):
            return False
    if hint.get("longName"):
        long_name = str(row.get("route_long_name", "")).strip().lower()
        if hint["longName"].strip().lower() not in long_name:
            return False
    return bool(hint.get("shortName") or hint.get("longName"))


def called_at(trip_stops, matched, wanted):
    """One trip reduced to the curated places it calls at, in travel order.

    Stops outside the curated list are dropped rather than kept as unknowns: the
    Mont-Blanc Express calls at a dozen Valais halts the trip notes have no reason
    to name, and letting them into the sequence would make every trip look like a
    different stopping pattern.
    """
    sequence = []
    for _, stop_id, seconds in sorted(trip_stops):
        info = matched.get(stop_id)
        if not info or info["place"] not in wanted:
            continue
        if sequence and sequence[-1][0] == info["place"]:
            if info["distance"] < matched[sequence[-1][1]]["distance"]:
                sequence[-1] = (info["place"], stop_id, seconds)
            continue
        sequence.append((info["place"], stop_id, seconds))
    return sequence


def follows_order(places, wanted):
    """Whether `places` appear in `wanted`'s order, starting at its first stop.

    Order is what tells the two directions of one line apart, which is the whole
    reason a service is modelled as one direction of one pattern. Requiring the
    first stop as well is what makes `departures` mean the same thing as the
    curated field it replaces — a time at the head of the line.
    """
    if len(places) < MIN_MATCHED_STOPS or not places or places[0] != wanted[0]:
        return False
    index = 0
    for place in places:
        while index < len(wanted) and wanted[index] != place:
            index += 1
        if index >= len(wanted):
            return False
        index += 1
    return True


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------


def extract(zip_path, feed_id, services, located, date):
    """Pull departures and stops for `services` out of one feed.

    Returns (entries, notes) where entries are ready for transit-schedules.json
    and notes explain, per service, what was found or why nothing was.
    """
    entries, notes = [], []
    with zipfile.ZipFile(zip_path) as zf:
        start, end = feed_window(zf)
        covers = bool(start and end and start <= date <= end)
        confidence = "scheduled-2027" if covers else "pattern-2026"
        if not covers:
            notes.append(
                f"  {feed_id}: feed covers {start} to {end}, not {date}; "
                "times extracted will be marked as a pattern"
            )

        wanted = {stop["place"] for service in services for stop in service["stops"]}
        matched = match_stops(zf, located, wanted)
        if not matched:
            notes.append(f"  {feed_id}: no feed stop is within {MATCH_RADIUS_M:.0f} m of a place")
            return entries, notes

        running = active_services(zf, date)

        # route_id to the services that named it, so one pass over trips serves
        # every service on the same line — the two directions of 12.230 share a
        # route and would otherwise cost two passes over the biggest table here.
        routes = defaultdict(list)
        for row in rows(zf, "routes.txt"):
            for service in services:
                if route_matches(row, service["gtfs"]):
                    routes[row["route_id"]].append(service["id"])

        trip_service = {}
        for row in rows(zf, "trips.txt"):
            if row["route_id"] not in routes or row.get("service_id") not in running:
                continue
            headsign = str(row.get("trip_headsign", "")).lower()
            for service_id in routes[row["route_id"]]:
                hint = next(s["gtfs"] for s in services if s["id"] == service_id)
                towards = str(hint.get("towards", "")).lower()
                # An absent headsign is common enough that requiring one would
                # discard whole feeds; stop order decides direction either way.
                if towards and headsign and towards not in headsign:
                    continue
                trip_service.setdefault(row["trip_id"], []).append(service_id)

        if not trip_service:
            notes.append(f"  {feed_id}: no trip on {date} matched any route hint")
            return entries, notes

        by_trip = defaultdict(list)
        for row in rows(zf, "stop_times.txt"):
            trip_id = row["trip_id"]
            if trip_id not in trip_service:
                continue
            seconds = seconds_of(row.get("departure_time") or row.get("arrival_time"))
            if seconds is None:
                continue
            by_trip[trip_id].append((int(row["stop_sequence"]), row["stop_id"], seconds))

        for service in services:
            entry, note = pattern_for(
                service,
                [trip for trip, ids in trip_service.items() if service["id"] in ids],
                by_trip,
                matched,
                confidence,
                feed_id,
                date,
            )
            if entry:
                entries.append(entry)
            notes.append(note)

    return entries, notes


def pattern_for(service, trip_ids, by_trip, matched, confidence, feed_id, date):
    """Choose one stopping pattern for a service and time every run of it.

    Trips on a line rarely all call at the same stops, so the pattern that most
    runs follow is taken as the service and the odd short-working is dropped.
    Averaging the offsets across those runs rather than taking the first trip's
    keeps one padded early-morning run from skewing the whole journey time.
    """
    wanted = [stop["place"] for stop in service["stops"]]
    candidates = {}
    for trip_id in trip_ids:
        sequence = called_at(by_trip.get(trip_id, []), matched, set(wanted))
        if follows_order([place for place, _, _ in sequence], wanted):
            candidates[trip_id] = sequence

    if not candidates:
        return None, f"  {service['id']}: matched a route but no trip calling at its stops in order"

    counts = Counter(tuple(place for place, _, _ in seq) for seq in candidates.values())
    chosen = counts.most_common(1)[0][0]
    runs = [seq for seq in candidates.values() if tuple(p for p, _, _ in seq) == chosen]

    offsets = defaultdict(list)
    stop_ids = {}
    departures = []
    for sequence in runs:
        first = sequence[0][2]
        departures.append(first)
        for place, stop_id, seconds in sequence:
            offsets[place].append(seconds - first)
            stop_ids[place] = stop_id

    spliced, drifted = splice(service, offsets, stop_ids, matched)
    if drifted:
        return None, f"  {service['id']}: feed times disagree with the curated pattern at {drifted}"

    entry = {
        "serviceId": service["id"],
        "feed": feed_id,
        "departures": sorted({clock(seconds) for seconds in departures}),
        "stops": spliced,
        "confidence": confidence,
        "source": SOURCES[feed_id]["name"],
        "basisDate": date.isoformat(),
        "runs": len(runs),
    }
    covered = sum(1 for stop in spliced if stop.get("stopId"))
    note = (
        f"  {service['id']}: {len(entry['departures'])} departures from {len(runs)} runs, "
        f"{covered}/{len(spliced)} stops from the feed"
    )
    return entry, note


def splice(service, offsets, stop_ids, matched):
    """Overwrite the curated offsets the feed covers, keeping the rest as they are.

    A feed almost never covers a whole service: the Swiss timetable carries the
    Mont-Blanc Express as far as Vallorcine and then stops at the border, and the
    French half is what makes that line useful. Replacing the stop list outright
    would quietly shorten the service to whatever the feed knows, so the curated
    list stays authoritative on where a vehicle goes and the feed only corrects
    when it gets there.

    Returns (stops, drifted) where a non-empty `drifted` means the spliced offsets
    stopped increasing — the one thing that must never reach the site, since a leg
    that arrives before it departs would break the journey search rather than just
    read oddly.
    """
    stops = []
    for stop in service["stops"]:
        place = stop["place"]
        if place not in offsets:
            stops.append({"place": place, "offsetMinutes": stop["offsetMinutes"]})
            continue
        info = matched[stop_ids[place]]
        stops.append(
            {
                "place": place,
                "offsetMinutes": round(sum(offsets[place]) / len(offsets[place]) / 60),
                "stopId": stop_ids[place],
                "stopName": info["name"],
                "lon": info["lon"],
                "lat": info["lat"],
            }
        )

    drifted = [
        stops[index]["place"]
        for index in range(1, len(stops))
        if stops[index]["offsetMinutes"] < stops[index - 1]["offsetMinutes"]
    ]
    return stops, drifted


# --------------------------------------------------------------------------


def basis_date(explicit):
    """The date whose timetable is extracted.

    Defaults to the trip's own start date rather than today, because a summer
    seasonal service that does not run in February would come back empty and
    look like a broken pipeline.
    """
    if explicit:
        return dt.date.fromisoformat(explicit)
    settings = read_json(SETTINGS_PATH)
    return dt.date.fromisoformat(settings["trip"]["startDate"])


def run(only=None, force=False, offline=False, date=None):
    transit = read_json(TRANSIT_PATH)
    located = curated_places(transit, read_anchors())
    date = basis_date(date)

    enrichable = [service for service in transit["services"] if service.get("gtfs")]
    if only:
        enrichable = [service for service in enrichable if service["id"] in only]
        missing = set(only) - {service["id"] for service in enrichable}
        for service_id in sorted(missing):
            print(f"  {service_id}: no gtfs block in data/transit.json, nothing to fetch")

    print(f"Basis date {date}, {len(enrichable)} service(s) with feed coverage")
    if not enrichable:
        return 0

    by_feed = defaultdict(list)
    for service in enrichable:
        by_feed[service["gtfs"]["feed"]].append(service)

    previous = read_json(OUT_PATH) if OUT_PATH.exists() else {}
    kept = {
        entry["serviceId"]: entry
        for entry in previous.get("services", [])
        # Without --only this is a full rebuild, so a stale entry for a service
        # whose gtfs block was removed must not survive.
        if only and entry["serviceId"] not in {s["id"] for s in enrichable}
    }

    for feed_id, services in sorted(by_feed.items()):
        if feed_id not in SOURCES:
            print(f"  {feed_id}: unknown feed, skipping {len(services)} service(s)")
            continue
        zip_path = cached_zip(feed_id, force=force, offline=offline)
        if zip_path is None:
            continue
        entries, notes = extract(zip_path, feed_id, services, located, date)
        for note in notes:
            print(note)
        for entry in entries:
            kept[entry["serviceId"]] = entry

    # Only credit a feed that something actually came from, so the attribution
    # the page renders describes the file rather than the tool's ambitions.
    feeds = sorted({entry["feed"] for entry in kept.values() if entry.get("feed") in SOURCES})
    payload = {
        "$schema": "tmb/transit-schedules/1",
        "$comment": [
            "Generated by tools/fetch_transit.py. Do not edit by hand.",
            "Times here override the hand-recorded ones in data/transit.json for the",
            "services a feed covers; everything else keeps its curated pattern.",
        ],
        # Null until something is actually extracted. A timestamp over an empty
        # list would read as "generated, and there is nothing" when the truth is
        # "no feed has been downloaded yet", and the page words itself off this.
        "generatedAt": (
            dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat() if kept else None
        ),
        "sources": [
            {
                "id": feed_id,
                "name": SOURCES[feed_id]["name"],
                "licence": SOURCES[feed_id]["licence"],
                "attribution": SOURCES[feed_id]["attribution"],
                "page": SOURCES[feed_id]["page"],
            }
            for feed_id in feeds
        ],
        "services": [kept[key] for key in sorted(kept)],
    }
    write_json(OUT_PATH, payload, compact=False)

    print(f"\nWrote {len(payload['services'])} service(s) to {OUT_PATH.relative_to(ROOT)}")
    if not payload["services"]:
        print("Nothing extracted — the site falls back to the curated patterns, which is fine.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", action="append", metavar="SERVICE_ID", help="repeatable")
    parser.add_argument("--force", action="store_true", help="re-download cached feeds")
    parser.add_argument("--offline", action="store_true", help="use cached zips only")
    parser.add_argument("--date", help="basis date, YYYY-MM-DD; default is the trip start")
    args = parser.parse_args()
    return run(only=args.only, force=args.force, offline=args.offline, date=args.date)


if __name__ == "__main__":
    sys.exit(main())
