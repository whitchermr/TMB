#!/usr/bin/env python3
"""
Exercise tools/fetch_transit.py against a synthetic feed, with no network.

The real feeds are a 53 MB Swiss timetable and a Chamonix file that is republished
every June, so a test that downloaded them would be slow, flaky, and unable to run
in an Alpine valley. Instead a tiny GTFS zip is built here with known times and a
deliberate short-working, and the extractor's own output is checked. That covers
the parts that actually go wrong: direction picked by stop order, stops matched by
proximity rather than id, and offsets averaged across runs.

Also asserts the confidence vocabulary matches assets/js/core/transit.js. The tool
writes that value straight into a file the page reads, so a level invented here
would render as an unlabelled chip rather than fail anywhere.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import fetch_transit  # noqa: E402

failures: list[str] = []
checks = 0


def ok(condition: bool, message: str, detail: str = "") -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(message + (f" — {detail}" if detail else ""))


# --------------------------------------------------------------------------
# A synthetic feed
# --------------------------------------------------------------------------

# Coordinates near the real Swiss Val Ferret places, so proximity matching has
# something true to work against. Deliberately offset by a couple of hundred
# metres: a feed's stop is never exactly where an anchor is.
FEED_STOPS = [
    ("S_ORS", "Orsières, gare", 7.1462, 46.0290),
    ("S_PRAZ", "Praz-de-Fort, village", 7.1130, 45.9880),
    ("S_FOULY", "La Fouly, poste", 7.0960, 45.9330),
    ("S_FERRET", "Ferret, village", 7.1000, 45.9160),
    ("S_NOWHERE", "Bern, Bahnhof", 7.4390, 46.9490),
]

TABLES = {
    "feed_info.txt": [
        "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date",
        "Synthetic,https://example.invalid,fr,20270101,20271231",
    ],
    "routes.txt": [
        "route_id,route_short_name,route_long_name,route_type",
        "R272,272,Orsieres - Ferret,3",
        "R999,999,Somewhere else entirely,3",
    ],
    "calendar.txt": [
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
        # A summer weekday timetable and a thin winter one, which is the shape of
        # every calendar in this corridor.
        "WEEKDAY,1,1,1,1,1,0,0,20270601,20270930",
        "WINTER,1,1,1,1,1,1,1,20270101,20270301",
    ],
    "trips.txt": [
        "route_id,service_id,trip_id,trip_headsign",
        # Two full runs out to Ferret, one short-working that turns at La Fouly,
        # and one in the opposite direction. Only the two full outbound runs
        # should become the service's pattern.
        "R272,WEEKDAY,T_OUT_1,Ferret",
        "R272,WEEKDAY,T_OUT_2,Ferret",
        "R272,WEEKDAY,T_SHORT,Ferret",
        "R272,WEEKDAY,T_BACK,Orsieres",
        # Runs on the right route but only in winter, so it must be filtered out
        # by the basis date rather than by luck.
        "R272,WINTER,T_WINTER,Ferret",
        "R999,WEEKDAY,T_OTHER,Nowhere",
    ],
    "stop_times.txt": [
        "trip_id,stop_id,stop_sequence,arrival_time,departure_time",
        # 08:00 out, 12 / 28 / 36 minutes down the line.
        "T_OUT_1,S_ORS,1,08:00:00,08:00:00",
        "T_OUT_1,S_PRAZ,2,08:12:00,08:12:00",
        "T_OUT_1,S_FOULY,3,08:28:00,08:28:00",
        "T_OUT_1,S_FERRET,4,08:36:00,08:36:00",
        # A slightly slower run, so the averaged offsets land between the two and
        # a test that only ever read the first trip would disagree.
        "T_OUT_2,S_ORS,1,17:00:00,17:00:00",
        "T_OUT_2,S_PRAZ,2,17:14:00,17:14:00",
        "T_OUT_2,S_FOULY,3,17:30:00,17:30:00",
        "T_OUT_2,S_FERRET,4,17:40:00,17:40:00",
        "T_SHORT,S_ORS,1,12:00:00,12:00:00",
        "T_SHORT,S_FOULY,2,12:26:00,12:26:00",
        "T_BACK,S_FERRET,1,09:00:00,09:00:00",
        "T_BACK,S_FOULY,2,09:08:00,09:08:00",
        "T_BACK,S_ORS,3,09:35:00,09:35:00",
        "T_WINTER,S_ORS,1,06:00:00,06:00:00",
        "T_WINTER,S_FERRET,2,06:40:00,06:40:00",
        "T_OTHER,S_NOWHERE,1,10:00:00,10:00:00",
    ],
}


def build_feed(path: Path) -> None:
    # Stop names are quoted because every real one here contains a comma: Swiss
    # feeds name stops "Village, poste". An unquoted fixture would pass while the
    # real feed shifted every column by one.
    stops = ["stop_id,stop_name,stop_lat,stop_lon"] + [
        f'{sid},"{name}",{lat},{lon}' for sid, name, lon, lat in FEED_STOPS
    ]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("stops.txt", "\n".join(stops) + "\n")
        for name, lines in TABLES.items():
            zf.writestr(name, "\n".join(lines) + "\n")


# The curated offsets are deliberately not the fixture's real ones, so a splice
# that quietly kept the curated value instead of the feed's would show up.
SERVICE_OUT = {
    "id": "tmr-272-orsieres-ferret",
    "stops": [
        {"place": "orsieres", "offsetMinutes": 0},
        {"place": "praz-de-fort", "offsetMinutes": 20},
        {"place": "la-fouly", "offsetMinutes": 40},
        {"place": "ferret", "offsetMinutes": 50},
    ],
    "gtfs": {"feed": "swiss-2027", "shortName": "12.272", "towards": "Ferret"},
}

SERVICE_BACK = {
    "id": "synthetic-272-inbound",
    "stops": [
        {"place": "ferret", "offsetMinutes": 0},
        {"place": "la-fouly", "offsetMinutes": 10},
        {"place": "orsieres", "offsetMinutes": 40},
    ],
    "gtfs": {"feed": "swiss-2027", "shortName": "272", "towards": "Orsieres"},
}

# Reaches beyond anything the fixture feed covers, which is the Mont-Blanc Express
# situation: the far end of the line is the reason the service exists and must
# survive the splice.
SERVICE_BEYOND = {
    "id": "synthetic-272-extended",
    "stops": [
        {"place": "orsieres", "offsetMinutes": 0},
        {"place": "la-fouly", "offsetMinutes": 28},
        {"place": "ferret", "offsetMinutes": 36},
        {"place": "champex-lac", "offsetMinutes": 75},
    ],
    "gtfs": {"feed": "swiss-2027", "shortName": "272", "towards": "Ferret"},
}


# --------------------------------------------------------------------------


def check_extraction() -> None:
    transit = json.loads((ROOT / "data" / "transit.json").read_text(encoding="utf-8"))
    located = fetch_transit.curated_places(transit, fetch_transit.read_anchors())

    for place in ("orsieres", "praz-de-fort", "la-fouly", "ferret"):
        ok(place in located, f"{place} has coordinates to match feed stops against")

    with tempfile.TemporaryDirectory() as tmp:
        feed = Path(tmp) / "swiss-2027.zip"
        build_feed(feed)
        entries, notes = fetch_transit.extract(
            feed,
            "swiss-2027",
            [SERVICE_OUT, SERVICE_BACK, SERVICE_BEYOND],
            located,
            dt.date(2027, 7, 14),  # a Wednesday, outside the WINTER calendar
        )

    found = {entry["serviceId"]: entry for entry in entries}
    ok(len(found) == 3, "every declared service was extracted", f"got {sorted(found)}")
    if len(found) != 3:
        for note in notes:
            print(f"        {note.strip()}")
        return

    out = found[SERVICE_OUT["id"]]
    back = found[SERVICE_BACK["id"]]

    ok(
        out["departures"] == ["08:00", "17:00"],
        "the outbound pattern keeps only the runs that go the whole way",
        str(out["departures"]),
    )
    ok(
        back["departures"] == ["09:00"],
        "the inbound direction is told apart by stop order, not by the route",
        str(back["departures"]),
    )
    ok(
        [stop["place"] for stop in out["stops"]] == ["orsieres", "praz-de-fort", "la-fouly", "ferret"],
        "stops come back in travel order",
        str([stop["place"] for stop in out["stops"]]),
    )
    ok(
        [stop["offsetMinutes"] for stop in out["stops"]] == [0, 13, 29, 38],
        "offsets are averaged across the runs rather than taken from the first",
        str([stop["offsetMinutes"] for stop in out["stops"]]),
    )
    ok(out["runs"] == 2, "the short-working is excluded from the run count", str(out["runs"]))
    ok(
        out["confidence"] == "scheduled-2027",
        "a feed whose validity covers the basis date is trusted as published",
        out["confidence"],
    )
    ok(
        all(stop["stopName"] for stop in out["stops"]),
        "each matched stop keeps the feed's own name, for wayfinding",
    )
    ok(
        not any(stop["place"] == "bern" for stop in out["stops"]),
        "a stop 100 km away is not matched to anything",
    )

    # The line number is written "12.272" in the timetable and "272" in the feed,
    # and this service's hint deliberately uses the timetable spelling.
    ok(bool(out["stops"]), "a line number carrying its operator prefix still matches")

    beyond = found[SERVICE_BEYOND["id"]]
    ok(
        [stop["place"] for stop in beyond["stops"]]
        == ["orsieres", "la-fouly", "ferret", "champex-lac"],
        "a stop the feed does not reach survives the splice",
        str([stop["place"] for stop in beyond["stops"]]),
    )
    ok(
        beyond["stops"][-1]["offsetMinutes"] == 75 and "stopId" not in beyond["stops"][-1],
        "and keeps its curated time, unmarked as coming from a feed",
    )
    ok(
        all(stop.get("stopId") for stop in beyond["stops"][:3]),
        "while the stops the feed does reach are credited to it",
    )
    offsets = [stop["offsetMinutes"] for stop in beyond["stops"]]
    ok(offsets == sorted(offsets), "a spliced service still runs forwards", str(offsets))


def check_seasonality() -> None:
    """The basis date has to select the calendar, not just the day of the week.

    Asking in February must return February's timetable rather than the summer
    one, because that is precisely the mistake a seasonal corridor punishes: the
    line exists all year and almost none of the summer runs do.
    """
    with tempfile.TemporaryDirectory() as tmp:
        feed = Path(tmp) / "swiss-2027.zip"
        build_feed(feed)
        transit = json.loads((ROOT / "data" / "transit.json").read_text(encoding="utf-8"))
        located = fetch_transit.curated_places(transit, fetch_transit.read_anchors())
        entries, _ = fetch_transit.extract(
            feed, "swiss-2027", [SERVICE_OUT], located, dt.date(2027, 2, 10)
        )

    ok(len(entries) == 1, "a winter date finds the winter calendar's run")
    if entries:
        ok(
            entries[0]["departures"] == ["06:00"],
            "and none of the summer ones",
            str(entries[0]["departures"]),
        )
        credited = [stop["place"] for stop in entries[0]["stops"] if stop.get("stopId")]
        ok(
            credited == ["orsieres", "ferret"],
            "crediting the feed only for the two stops that run calls at",
            str(credited),
        )


def check_confidence_vocabulary() -> None:
    source = (ROOT / "assets" / "js" / "core" / "transit.js").read_text(encoding="utf-8")
    match = re.search(r"export const CONFIDENCE = \[(.*?)\];", source, re.S)
    ok(match is not None, "core/transit.js still declares a CONFIDENCE list")
    if not match:
        return
    levels = tuple(re.findall(r"'([^']+)'", match.group(1)))
    ok(
        levels == fetch_transit.CONFIDENCE,
        "the pipeline's confidence levels match the site's",
        f"js {levels} vs python {fetch_transit.CONFIDENCE}",
    )


def check_hints_resolve() -> None:
    """Every gtfs block names a feed this tool knows and a route it can find."""
    transit = json.loads((ROOT / "data" / "transit.json").read_text(encoding="utf-8"))
    hinted = [service for service in transit["services"] if service.get("gtfs")]
    ok(bool(hinted), "some service declares feed coverage")

    for service in hinted:
        hint = service["gtfs"]
        where = service["id"]
        ok(hint.get("feed") in fetch_transit.SOURCES, f"{where}: names a known feed", hint.get("feed"))
        ok(
            bool(hint.get("shortName") or hint.get("longName")),
            f"{where}: gives something to match a route on",
        )
        ok(
            len(service.get("stops", [])) >= fetch_transit.MIN_MATCHED_STOPS,
            f"{where}: has enough stops for a pattern to be recognisable",
        )


def main() -> int:
    check_confidence_vocabulary()
    check_hints_resolve()
    check_extraction()
    check_seasonality()

    for failure in failures:
        print(f"  FAIL  {failure}")
    print(f"transit pipeline: {checks} checks run, {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
