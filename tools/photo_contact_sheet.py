#!/usr/bin/env python3
"""
Build a one-page contact sheet of every waypoint photograph, for review by eye.

tools/fetch_photos.py picks photos by score, and a score cannot tell a panorama
of a col from a well-lit photograph of the signpost at that col. This renders all
of them side by side with the name of the stop and what the itinerary says we are
looking for, so a wrong one is obvious in a couple of seconds of scrolling.

To replace one: note its Commons title, add an entry to PICKS in
tools/fetch_photos.py, and re-run

    tools/fetch_photos.py --only <waypointId> --force

Writes docs/photo-review.html. Open it directly in a browser; it needs no server.
"""

from __future__ import annotations

import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "photo-review.html"

DAY_LABELS = {
    "day-01": "Day 1 — Les Houches to Les Contamines",
    "day-02": "Day 2 — Les Contamines to Les Chapieux",
    "day-03": "Day 3 — Les Mottets to Courmayeur",
    "day-04": "Day 4 — Courmayeur to La Fouly",
    "day-05": "Day 5 — La Fouly to Champex",
    "day-06": "Day 6 — Champex to Trient",
    "day-07": "Day 7 — Trient to Chamonix",
}


def main() -> int:
    waypoints = json.loads((ROOT / "data" / "waypoints.json").read_text())["waypoints"]
    photos = {
        entry["waypointId"]: entry
        for entry in json.loads((ROOT / "data" / "photos.json").read_text())["photos"]
    }

    cards: dict[str, list[str]] = {}
    for waypoint in waypoints:
        entry = photos.get(waypoint["id"])
        subject = (waypoint.get("photo") or {}).get("subject") or ""
        # The sheet lives in docs/, so paths have to climb out to the repo root.
        image = (
            f'<img src="../{html.escape(entry["file"])}" alt="" loading="lazy" />'
            if entry
            else '<div class="missing">no photo</div>'
        )
        credit = (
            f'{html.escape(entry["credit"]["author"])} · {html.escape(entry["credit"]["licence"])}'
            if entry
            else "—"
        )
        commons = html.escape(entry["credit"]["commonsTitle"]) if entry else ""
        cards.setdefault(waypoint["dayId"], []).append(
            f"""
        <figure class="card{'' if entry else ' card--missing'}">
          {image}
          <figcaption>
            <strong>{html.escape(waypoint['name'])}</strong>
            <span class="prio">priority {waypoint.get('priority', '?')}</span>
            <span class="subject">{html.escape(subject)}</span>
            <span class="credit">{credit}</span>
            <code>{commons}</code>
          </figcaption>
        </figure>"""
        )

    sections = "\n".join(
        f"<h2>{html.escape(DAY_LABELS.get(day, day))}</h2>\n<div class=\"grid\">"
        + "\n".join(items)
        + "</div>"
        for day, items in cards.items()
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Waypoint photo review — TMB</title>
<style>
  body {{ font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         margin: 0; padding: 1.5rem; background: #f6f7f5; color: #16241c; }}
  h1 {{ margin: 0 0 .3rem; font-size: 1.5rem; }}
  h2 {{ margin: 2rem 0 .6rem; font-size: 1rem; text-transform: uppercase;
        letter-spacing: .04em; color: #3f5a4a; border-bottom: 1px solid #ccd3cd;
        padding-bottom: .3rem; }}
  p.lede {{ margin: 0 0 .5rem; color: #46504a; max-width: 60rem; }}
  .grid {{ display: grid; gap: 1rem;
           grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }}
  .card {{ margin: 0; background: #fff; border: 1px solid #d7ddd8; border-radius: 8px;
           overflow: hidden; }}
  .card--missing {{ border-color: #b3474a; }}
  .card img {{ display: block; width: 100%; aspect-ratio: 4/3; object-fit: cover; }}
  .missing {{ display: grid; place-items: center; aspect-ratio: 4/3;
              background: #f4e9e9; color: #8a3a3d; font-weight: 600; }}
  figcaption {{ padding: .5rem .6rem .6rem; display: grid; gap: .18rem; }}
  .prio {{ font-size: .7rem; color: #6b736d; }}
  .subject {{ font-size: .82rem; color: #3a453e; }}
  .credit {{ font-size: .74rem; color: #6b736d; }}
  code {{ font-size: .66rem; color: #7a827c; word-break: break-all; }}
</style>
</head>
<body>
<h1>Waypoint photo review</h1>
<p class="lede">
  {len(photos)} of {len(waypoints)} scenery stops have a photograph. Check that each
  one shows the view named underneath it. To swap one, copy its Commons title into
  <code>PICKS</code> in <code>tools/fetch_photos.py</code> and re-run
  <code>tools/fetch_photos.py --only &lt;id&gt; --force</code>.
</p>
{sections}
</body>
</html>
""",
        encoding="utf-8",
    )

    print(f"wrote {OUT.relative_to(ROOT)} — {len(photos)}/{len(waypoints)} with photos")
    return 0


if __name__ == "__main__":
    sys.exit(main())
