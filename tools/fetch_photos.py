#!/usr/bin/env python3
"""
Find one freely-licensed photograph per scenery waypoint, download it, and record
who took it.

Why this exists
---------------
The scenery list tells you a col is worth stopping at, but a name is not a view.
A photograph of what you are walking towards is the difference between "Col de la
Seigne, panorama" and knowing to have the camera out before the last switchback.

Why Wikimedia Commons, and why the files are downloaded
-------------------------------------------------------
Every image on Commons carries machine-readable licence and authorship metadata,
so a photo can be used with correct credit rather than hotlinked and hoped for.
The files are copied into assets/photos/ instead of linked because the site has to
work in a valley with no signal, and because hotlinking upload.wikimedia.org would
break the no-runtime-CDN rule the rest of the project follows.

Only licences that permit redistribution with attribution are accepted: public
domain, CC0, CC BY and CC BY-SA. NonCommercial and NoDerivatives are rejected —
not because this site sells anything, but because those terms make the file
awkward to reuse and Commons treats them as non-free.

Picking the photo
-----------------
Search alone is unreliable: "Refuge de la Balme" also matches a signpost, a menu
board and someone's boots. So candidates come from both a text search and a
geographic search around the waypoint, and are then scored on whether they look
like a landscape photograph of the named place (see score_candidate). The result
is a best guess, which is why tools/photo_contact_sheet.py exists — the picks are
meant to be reviewed by eye, and pinned in PICKS once approved.

Usage
-----
    tools/fetch_photos.py                     # fill in anything missing
    tools/fetch_photos.py --force             # re-pick everything
    tools/fetch_photos.py --only lac-blanc    # one waypoint
    tools/fetch_photos.py --candidates lac-blanc   # print what it considered
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WAYPOINTS = ROOT / "data" / "waypoints.json"
OUT_JSON = ROOT / "data" / "photos.json"
OUT_DIR = ROOT / "assets" / "photos"
CACHE_DIR = ROOT / "tools" / "cache" / "photos"

API = "https://commons.wikimedia.org/w/api.php"

# Wikimedia asks for a descriptive User-Agent that identifies the tool and gives
# them a way to make contact if it misbehaves.
UA = (
    "TMB-trip-planner/1.0 "
    "(https://github.com/ - static Tour du Mont Blanc planner; "
    "one-off photo fetch for 32 waypoints)"
)

# Width to download. The photo is shown in a card about 340 px wide on a phone,
# so 1200 covers a 3x screen and a tap-to-enlarge without spending 4 MB a file.
THUMB_WIDTH = 1200

# Below this, the best candidate is not convincingly the right place. Leaving the
# waypoint without a photo is honest; the UI handles the gap, and a human can pin
# a file in PICKS instead.
MIN_SCORE = 78.0

FREE_LICENCES = ("cc0", "cc-by-1", "cc-by-2", "cc-by-3", "cc-by-4", "cc-by-sa", "pd", "publicdomain")
BLOCKED_LICENCE_TERMS = ("nc", "nd", "noncommercial", "nonderiv", "fair", "nonfree")

# Search terms per waypoint. The waypoint name is a label on our itinerary, not
# necessarily what a photographer titled their file: "Arnouvaz" is spelled Arnuva
# on the Italian side, and "Lacs de Combal" is Lago di Combal on Commons. Getting
# these right matters far more than any amount of scoring cleverness.
QUERIES: dict[str, list[str]] = {
    "col-de-voza": ["Col de Voza"],
    "bionnassay-glacier-view": ["Glacier de Bionnassay", "Bionnassay glacier", "Aiguille de Bionnassay"],
    "notre-dame-de-la-gorge": ["Notre-Dame de la Gorge", "Notre Dame de la Gorge Contamines"],
    "nant-borrant": ["Chalet de Nant Borrant", "Nant Borrant", "Val Montjoie Contamines"],
    "refuge-de-la-balme": ["Refuge de la Balme Contamines", "La Balme Montjoie"],
    "col-du-bonhomme": ["Col du Bonhomme Savoie", "Col du Bonhomme"],
    "croix-du-bonhomme": ["Col de la Croix du Bonhomme"],
    "refuge-croix-du-bonhomme": ["Refuge de la Croix du Bonhomme", "Refuge Croix du Bonhomme exterieur"],
    "refuge-des-mottets": ["Refuge des Mottets", "Ville des Glaciers Bourg-Saint-Maurice"],
    "col-de-la-seigne": ["Col de la Seigne", "Colle della Seigne"],
    "rifugio-elisabetta": ["Rifugio Elisabetta Soldini", "Rifugio Elisabetta"],
    "lac-combal": ["Lago di Combal", "Lac Combal", "Val Veny Combal"],
    "col-checrouit": ["Col Checrouit", "Checrouit Courmayeur", "Val Veny Checrouit"],
    "rifugio-maison-vieille": ["Rifugio Maison Vieille", "Maison Vieille Courmayeur"],
    "rifugio-bertone": ["Rifugio Giorgio Bertone", "Rifugio Bertone", "Mont de la Saxe Courmayeur"],
    "rifugio-bonatti": ["Rifugio Walter Bonatti", "Rifugio Bonatti"],
    "arnouvaz": ["Arnuva Val Ferret", "Arnouvaz", "Val Ferret Courmayeur"],
    "rifugio-elena": ["Rifugio Elena Val Ferret", "Rifugio Elena"],
    "grand-col-ferret": ["Grand Col Ferret", "Gran Col Ferret"],
    "champex-lac-lake": ["Lac de Champex", "Champex lake", "Champex-Lac Orsieres"],
    "alp-bovine": ["Alpage de Bovine", "Bovine Trient", "Bovine Martigny panorama"],
    "col-de-la-forclaz": ["Col de la Forclaz Valais", "Col de la Forclaz Trient"],
    "fenetre-darpette": ["Fenetre d'Arpette", "Val d'Arpette"],
    "trient-church": ["Church of Trient", "Trient Valais church", "Eglise de Trient"],
    "col-de-balme": ["Col de Balme"],
    "aiguillette-des-posettes": ["Aiguillette des Posettes", "Posettes Vallorcine", "Aiguillettes des Posettes panorama"],
    "le-tour-village": ["Le Tour Chamonix", "Glacier du Tour"],
    "tre-le-champ": ["Tre-le-Champ", "Echelles Aiguilles Rouges", "Tete aux Vents Chamonix", "Argentiere Aiguilles Rouges"],
    "lac-blanc": ["Lac Blanc Chamonix", "Lac Blanc Aiguilles Rouges"],
    "la-flegere": ["La Flegere", "Flegere Chamonix"],
    "le-brevent": ["Le Brevent", "Brevent Chamonix"],
    "refuge-de-bellachat": ["Refuge de Bellachat", "Bellachat Chamonix"],
}

# Files pinned by hand after looking at the contact sheet. Anything listed here
# skips scoring entirely, so a reviewed choice cannot be silently replaced by a
# later run. Keys are waypoint ids, values are Commons "File:..." titles.
PICKS: dict[str, str] = {
    # Nothing on Commons is titled after the ladders themselves, and the search
    # for the hamlet drifts to unrelated files, so the view of Mont Blanc from
    # Tré-le-Champ is pinned by hand.
    "tre-le-champ": "File:Mont Blanc @ Tré-le-Champ @ Chamonix (51483716578).jpg",
    # Geosearch put a chalet terrace 40 m from the viewpoint ahead of the glacier
    # itself. This one was taken from the TMB looking at exactly what we will see.
    "bionnassay-glacier-view": "File:Mont-Blanc et glacier de Bionnassay vus du TMB (juin 2019).JPG",
    # The lake is the point of the stop, and this one is shot in July.
    "champex-lac-lake": "File:Lac de Champex im Juli.jpg",
    # Scoring preferred a named boulder at the col over the reason to look up.
    "col-checrouit": "File:Mont Blanc de Courmayeur @ Col Chécrouit.jpg",
    # Commons has no modern photograph of the chalet itself — only Gallica plates
    # from 1930. This is the Bon Nant torrent we walk beside on the way up to it,
    # which is at least the view rather than a museum piece.
    "nant-borrant": "File:Le Bon Nant @ Val Montjoie (50921669256).jpg",
}

# Words that reliably signal something other than the view: documentation of a
# sign, a close-up, an indoor shot, or a map. Scored down rather than excluded,
# because occasionally the only photo of a refuge is its front door.
NEGATIVE = (
    "sign", "signpost", "panneau", "plaque", "map", "carte", "topo", "profile",
    "table d'orientation", "orientation table", "table d orientation",
    "intérieur", "interieur", "bisse", "engraving", "lithograph", "postcard",
    "brouillard", "brume", "nebbia", " fog", "foggy", "mist", "whiteout",
    "diagram", "logo", "flag", "menu", "interior", "inside", "dortoir", "dormitory",
    "bedroom", "kitchen", "toilet", "food", "meal", "plate", "beer", "cat", "dog",
    "flower", "fleur", "orchid", "butterfly", "insect", "beetle", "snail", "bird",
    "portrait", "selfie", "gravestone", "cross section", "poster", "ticket",
    "sculpture", "monument to", "detail", "closeup", "close-up", "macro",
)

# We walk in the first half of July. A lake under a metre of ice is the same place
# but not the same view, and showing it would mislead rather than help.
WINTER = (
    "ice-covered", "ice covered", "frozen", "snow-covered", "snow covered",
    "winter", "hiver", "inverno", "snowshoe", "raquette", "ski", "skiing",
    "avalanche", "gelé", "verschneit",
)

# Words that suggest the wide view we actually want.
POSITIVE = (
    "panorama", "view", "vue", "vista", "landscape", "paysage", "massif",
    "glacier", "lake", "lac", "lago", "see", "valley", "vallee", "val ",
    "aiguille", "mont blanc", "summit", "sommet", "col ", "pass", "alps",
    "alpes", "sunrise", "sunset", "cirque", "panoramic",
)


class Unhtml(HTMLParser):
    """Commons returns author and credit as HTML fragments with links in them."""

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    @classmethod
    def strip(cls, html: str | None) -> str:
        if not html:
            return ""
        parser = cls()
        parser.feed(html)
        text = "".join(parser.parts)
        return re.sub(r"\s+", " ", text).strip()


def api(params: dict[str, str], cache_key: str) -> dict:
    """Call the Commons API, caching responses so re-runs cost nothing."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", cache_key)[:150]
    cached = CACHE_DIR / f"{safe}.json"
    if cached.exists():
        return json.loads(cached.read_text())

    query = dict(params)
    query.update({"format": "json", "formatversion": "2"})
    url = f"{API}?{urllib.parse.urlencode(query)}"
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.loads(response.read().decode("utf-8"))
            cached.write_text(json.dumps(payload))
            time.sleep(0.35)  # be a polite API consumer
            return payload
        except Exception as error:  # noqa: BLE001 - transient network failures
            if attempt == 3:
                print(f"    ! api failed: {error}", file=sys.stderr)
                return {}
            time.sleep(2 * (attempt + 1))
    return {}


def search_titles(term: str, limit: int = 14) -> list[str]:
    """File titles matching a text search, restricted to the File namespace."""
    payload = api(
        {
            "action": "query",
            "list": "search",
            "srsearch": f"{term} filetype:bitmap",
            "srnamespace": "6",
            "srlimit": str(limit),
        },
        f"search-{term}",
    )
    return [hit["title"] for hit in payload.get("query", {}).get("search", [])]


def geo_titles(lat: float, lon: float, radius: int = 1200, limit: int = 30) -> dict[str, float]:
    """File titles geotagged near a point, mapped to their distance in metres."""
    payload = api(
        {
            "action": "query",
            "list": "geosearch",
            "gscoord": f"{lat}|{lon}",
            "gsradius": str(radius),
            "gslimit": str(limit),
            "gsnamespace": "6",
        },
        f"geo-{lat:.4f}-{lon:.4f}-{radius}",
    )
    return {
        hit["title"]: float(hit.get("dist", radius))
        for hit in payload.get("query", {}).get("geosearch", [])
    }


def image_info(titles: list[str]) -> dict[str, dict]:
    """Licence, size and description for a batch of files."""
    found: dict[str, dict] = {}
    for start in range(0, len(titles), 20):
        batch = titles[start : start + 20]
        payload = api(
            {
                "action": "query",
                "prop": "imageinfo",
                "iiprop": "url|size|mime|extmetadata",
                "iiurlwidth": str(THUMB_WIDTH),
                "titles": "|".join(batch),
            },
            f"info-{'|'.join(batch)}",
        )
        for page in payload.get("query", {}).get("pages", []):
            info = (page.get("imageinfo") or [None])[0]
            if info:
                found[page["title"]] = info
    return found


def licence_of(info: dict) -> tuple[str, str, str]:
    """(machine name, short label, licence url) from the file's metadata."""
    meta = info.get("extmetadata", {})
    return (
        (meta.get("License", {}).get("value") or "").lower(),
        Unhtml.strip(meta.get("LicenseShortName", {}).get("value")),
        meta.get("LicenseUrl", {}).get("value") or "",
    )


def is_free(machine: str, short: str) -> bool:
    haystack = f"{machine} {short}".lower()
    if any(term in re.split(r"[^a-z]+", haystack) for term in ("nc", "nd")):
        return False
    if any(term in haystack for term in BLOCKED_LICENCE_TERMS):
        return False
    return any(machine.startswith(prefix) for prefix in FREE_LICENCES) or "public domain" in haystack


def score_candidate(title: str, info: dict, waypoint: dict, distance_m: float | None) -> float:
    """
    How likely is this file to be the view we want?

    Roughly, in order of weight: it has to be a wide landscape photograph, it
    should be near the waypoint or clearly named after it, and it should not be a
    photo of a signpost.
    """
    machine, short, _ = licence_of(info)
    if not is_free(machine, short):
        return -1e9

    width = info.get("width") or 0
    height = info.get("height") or 0
    if width < 800 or height < 500:
        return -1e9
    if (info.get("mime") or "") not in ("image/jpeg", "image/png", "image/webp"):
        return -1e9

    meta = info.get("extmetadata", {})
    text = " ".join(
        [
            title.lower(),
            Unhtml.strip(meta.get("ImageDescription", {}).get("value")).lower(),
        ]
    )

    score = 0.0

    # A view is wide. Portrait crops of a summit cross are not what we are after.
    ratio = width / height if height else 0
    if 1.25 <= ratio <= 2.4:
        score += 26
    elif ratio > 2.4:
        score += 14  # a stitched panorama, still useful
    else:
        score -= 22

    score += min(width, 4000) / 400  # reward resolution, with diminishing returns

    # Name overlap: every significant word of the waypoint name that appears.
    tokens = [
        token
        for token in re.split(r"[^a-zA-Zà-ÿ]+", waypoint["name"].lower())
        if len(token) > 3 and token not in ("refuge", "rifugio", "chalet", "view", "viewpoint")
    ]
    named = sum(1 for token in tokens if token in text) / len(tokens) if tokens else 0.0
    nearby = distance_m is not None and distance_m <= 700

    # A file has to be tied to this place by something. Text search will happily
    # return a paddy field in Laos for "Tré-le-Champ" if nothing better exists,
    # and a wrong photo is worse than no photo.
    if named < 0.5 and not nearby:
        return -1e9

    score += 42 * named
    if distance_m is not None:
        # Geotagged nearby means the photographer stood roughly where we will,
        # but it is a weaker signal than the title naming the place: a refuge 40 m
        # away is not the glacier the waypoint exists for.
        score += max(0.0, 24 * (1 - distance_m / 1200))

    score += 4 * sum(1 for word in POSITIVE if word in text)
    score -= 16 * sum(1 for word in NEGATIVE if word in text)
    score -= 20 * sum(1 for word in WINTER if word in text)

    # Shot in the season we will be there, according to the camera. Missing dates
    # are common and are not held against a file.
    taken = meta.get("DateTimeOriginal", {}).get("value") or ""
    # Dates arrive in several shapes, including a bare "1930" wrapped in markup.
    stamp = re.match(r"\s*(\d{4})(?:[-:/](\d{2}))?", taken)
    if stamp:
        year = int(stamp.group(1))
        month_number = int(stamp.group(2)) if stamp.group(2) else None
        if month_number and 6 <= month_number <= 9:
            score += 14
        elif month_number in (12, 1, 2, 3, 4):
            score -= 16
        # Commons holds a lot of digitised alpine archives — glass plates and
        # album pages from the 1900s. They are public domain and beautifully
        # composed, and they show a hut that burned down eighty years ago.
        if year < 1990:
            score -= 90

    # Library and museum scans are archival even when undated. The giveaway is
    # the credit line and the maintenance categories, not the photograph itself.
    provenance = " ".join(
        [
            Unhtml.strip(meta.get("Credit", {}).get("value")).lower(),
            (meta.get("Categories", {}).get("value") or "").lower(),
        ]
    )
    if any(
        marker in provenance
        for marker in ("gallica", "bibliothèque nationale", "nationalbibliothek", "glass plate",
                       "photochrom", "engravings", "lithographs", "postcards", "expired")
    ):
        score -= 90

    # CC BY-SA and CC BY are equally usable; a nudge towards the most permissive
    # only breaks ties.
    if machine.startswith(("cc0", "pd", "publicdomain")):
        score += 3

    return score


def gather(waypoint: dict) -> list[tuple[float, str, dict, float | None]]:
    """Every plausible candidate for a waypoint, best first."""
    terms = QUERIES.get(waypoint["id"], [waypoint["name"]])

    titles: list[str] = []
    for term in terms:
        titles.extend(search_titles(term))

    near = geo_titles(waypoint["lat"], waypoint["lon"])
    titles.extend(near.keys())

    unique = list(dict.fromkeys(titles))
    if not unique:
        return []

    infos = image_info(unique)
    scored = []
    for title in unique:
        info = infos.get(title)
        if not info:
            continue
        distance = near.get(title)
        score = score_candidate(title, info, waypoint, distance)
        if score > -1e8:
            scored.append((score, title, info, distance))
    scored.sort(key=lambda row: row[0], reverse=True)
    return scored


def download(info: dict, destination_stem: Path) -> Path | None:
    url = info.get("thumburl") or info.get("url")
    if not url:
        return None
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            content_type = response.headers.get("Content-Type", "image/jpeg")
            data = response.read()
    except Exception as error:  # noqa: BLE001
        print(f"    ! download failed: {error}", file=sys.stderr)
        return None

    extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(
        content_type.split(";")[0].strip(), ".jpg"
    )
    destination = destination_stem.with_suffix(extension)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    time.sleep(0.25)
    return destination


def record(waypoint: dict, title: str, info: dict, path: Path) -> dict:
    machine, short, licence_url = licence_of(info)
    meta = info.get("extmetadata", {})
    return {
        "waypointId": waypoint["id"],
        "file": str(path.relative_to(ROOT)).replace(os.sep, "/"),
        "width": info.get("thumbwidth") or info.get("width"),
        "height": info.get("thumbheight") or info.get("height"),
        "bytes": path.stat().st_size,
        "alt": f"{waypoint['name']} — {waypoint.get('photo', {}).get('subject') or 'view'}",
        "caption": Unhtml.strip(meta.get("ImageDescription", {}).get("value"))[:240] or None,
        "credit": {
            "author": Unhtml.strip(meta.get("Artist", {}).get("value")) or "Unknown",
            "licence": short or machine,
            "licenceUrl": licence_url,
            "source": info.get("descriptionurl") or "",
            "commonsTitle": title,
            "date": (meta.get("DateTimeOriginal", {}).get("value") or "")[:10] or None,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-pick even if a photo exists")
    parser.add_argument("--only", help="limit to one waypoint id")
    parser.add_argument("--candidates", help="print scored candidates for one waypoint and exit")
    args = parser.parse_args()

    waypoints = json.loads(WAYPOINTS.read_text())["waypoints"]

    if args.candidates:
        waypoint = next(w for w in waypoints if w["id"] == args.candidates)
        for score, title, info, distance in gather(waypoint)[:15]:
            machine, short, _ = licence_of(info)
            print(
                f"{score:7.1f}  {info.get('width')}x{info.get('height')}  "
                f"{short or machine:14.14s}  "
                f"{'' if distance is None else f'{distance:5.0f} m'}  {title}"
            )
        return 0

    existing = {}
    if OUT_JSON.exists():
        existing = {
            entry["waypointId"]: entry for entry in json.loads(OUT_JSON.read_text())["photos"]
        }

    targets = [w for w in waypoints if not args.only or w["id"] == args.only]

    # --force re-picks the targeted waypoints only. Clearing the whole map would
    # mean `--only x --force` silently threw away the other 31 entries.
    results: dict[str, dict] = dict(existing)
    if args.force:
        for waypoint in targets:
            results.pop(waypoint["id"], None)

    missing: list[str] = []
    for index, waypoint in enumerate(targets, 1):
        wid = waypoint["id"]
        if wid in results and not args.force and Path(ROOT / results[wid]["file"]).exists():
            print(f"[{index}/{len(targets)}] {wid}: keeping existing")
            continue

        print(f"[{index}/{len(targets)}] {wid}: searching…")

        if wid in PICKS:
            title = PICKS[wid]
            infos = image_info([title])
            candidates = [(0.0, title, infos[title], None)] if title in infos else []
        else:
            candidates = gather(waypoint)

        chosen = None
        strong = [row for row in candidates if wid in PICKS or row[0] >= MIN_SCORE]
        for score, title, info, _distance in strong[:4]:
            path = download(info, OUT_DIR / wid)
            if path:
                chosen = record(waypoint, title, info, path)
                print(f"    ✓ {title}  ({chosen['credit']['licence']}, score {score:.0f})")
                break

        if chosen:
            results[wid] = chosen
        else:
            missing.append(wid)
            print(f"    ✗ no usable photo for {wid}")

    ordered = [results[w["id"]] for w in waypoints if w["id"] in results]
    OUT_JSON.write_text(
        json.dumps(
            {
                "$schema": "tmb/photos/1",
                "$comment": [
                    "Generated by tools/fetch_photos.py — do not hand-edit.",
                    "One freely-licensed photograph per scenery waypoint, copied into",
                    "assets/photos/ so the site works offline. Every entry carries the",
                    "author and licence, which must stay visible wherever the photo is",
                    "shown: that is the condition the images are used under.",
                    "To change a photo, pin its Commons title in the PICKS table in",
                    "tools/fetch_photos.py and re-run with --only <waypointId> --force.",
                ],
                "generatedAt": time.strftime("%Y-%m-%d"),
                "photos": ordered,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )

    total = sum(entry["bytes"] for entry in ordered)
    print(f"\n{len(ordered)}/{len(waypoints)} waypoints have a photo, {total / 1e6:.1f} MB total")
    if missing:
        print(f"missing: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
