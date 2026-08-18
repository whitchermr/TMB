#!/usr/bin/env python3
"""
Check the waypoint photographs and, more importantly, their credits.

Most tests here protect the numbers. This one protects a promise: the photos are
used under licences that require the photographer to be named and the licence
identified. A missing author is not a cosmetic bug, it is a term of use we have
stopped honouring, so an empty credit fails the build.

The rest is drift detection. data/photos.json is generated alongside the files in
assets/photos/, and the two can fall out of step — a file deleted by hand, a
download truncated, a waypoint renamed. Byte sizes are compared because they are
recorded at download time and are the cheapest way to notice a half-written file
without decoding an image.

Coverage is reported but does not fail: Commons genuinely has no usable photo of
some places, and the pages are built to show a scenery stop without one.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

# Licences that let us redistribute the file with credit. Anything outside this
# set should never have made it past tools/fetch_photos.py.
ALLOWED = ("cc0", "cc by", "public domain")

failures: list[str] = []
notes: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def main() -> int:
    photos_path = ROOT / "data" / "photos.json"
    if not photos_path.exists():
        print("photos: data/photos.json is missing — run tools/fetch_photos.py")
        return 1

    waypoints = json.loads((ROOT / "data" / "waypoints.json").read_text())["waypoints"]
    entries = json.loads(photos_path.read_text())["photos"]

    # A historic-only landmark earns its place with a writeup, so it is not a
    # coverage gap. Counting it as one would make the tally never reach full and
    # so stop meaning anything.
    photo_ids = {
        waypoint["id"]
        for waypoint in waypoints
        if "photographic" in waypoint.get("roles", ["photographic"])
    }
    waypoint_ids = {waypoint["id"] for waypoint in waypoints}
    seen: set[str] = set()

    for entry in entries:
        wid = entry.get("waypointId", "?")

        if wid in seen:
            fail(f"{wid}: appears twice in photos.json")
        seen.add(wid)

        if wid not in waypoint_ids:
            fail(f"{wid}: has a photo but no longer exists in waypoints.json")

        path = ROOT / entry["file"]
        if not path.exists():
            fail(f"{wid}: {entry['file']} is referenced but not on disk")
            continue

        # Case matters on the GitHub Pages filesystem even though it does not on
        # this Mac, so compare the real name rather than trusting exists().
        if path.name not in {child.name for child in path.parent.iterdir()}:
            fail(f"{wid}: {entry['file']} differs in case from the file on disk")

        actual = path.stat().st_size
        if entry.get("bytes") != actual:
            fail(
                f"{wid}: {entry['file']} is {actual} bytes, "
                f"photos.json records {entry.get('bytes')} — re-run the pipeline"
            )
        if actual < 10_000:
            fail(f"{wid}: {entry['file']} is only {actual} bytes, likely truncated")

        credit = entry.get("credit") or {}
        author = (credit.get("author") or "").strip()
        licence = (credit.get("licence") or "").strip()

        if not author or author.lower() == "unknown":
            fail(f"{wid}: no photographer recorded, which the licence requires")
        if not licence:
            fail(f"{wid}: no licence recorded")
        elif not any(licence.lower().startswith(prefix) for prefix in ALLOWED):
            fail(f"{wid}: licence {licence!r} is not one we can redistribute")
        if not credit.get("source"):
            fail(f"{wid}: no source URL, so the credit cannot be checked")

        if not (entry.get("alt") or "").strip():
            fail(f"{wid}: no alt text, so the photo is invisible to a screen reader")

        for field in ("width", "height"):
            if not isinstance(entry.get(field), int) or entry[field] <= 0:
                fail(f"{wid}: {field} is missing, so the page cannot reserve space")

    uncovered = [wid for wid in photo_ids if wid not in seen]
    if uncovered:
        notes.append(
            f"{len(uncovered)} of {len(photo_ids)} scenery stops have no photo: "
            + ", ".join(sorted(uncovered))
        )

    # Files in assets/photos/ that nothing points at are dead weight in the repo
    # and in the offline cache.
    referenced = {entry["file"] for entry in entries}
    photo_dir = ROOT / "assets" / "photos"
    if photo_dir.exists():
        for child in sorted(photo_dir.iterdir()):
            if child.is_file() and not child.name.startswith("."):
                relative = str(child.relative_to(ROOT))
                if relative not in referenced:
                    notes.append(f"{relative} is on disk but not listed in photos.json")

    for note in notes:
        print(f"  note  {note}")
    for failure in failures:
        print(f"  FAIL  {failure}")

    total = len(photo_ids)
    landmarks = len(waypoint_ids) - total
    print(
        f"photos: {len(seen)}/{total} stops illustrated, "
        f"{landmarks} history-only landmarks, {len(failures)} problems"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
