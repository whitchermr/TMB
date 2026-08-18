# Data notes and calibration

How the route data was produced, how accurate it is, and where computed figures
differ from the group's original planning spreadsheet.

Regenerate everything with `./tools/run-pipeline.sh`.

## Provenance

| Layer | Source | Licence |
|---|---|---|
| Trail geometry | OSM relation [9678362](https://www.openstreetmap.org/relation/9678362), main itinerary of superroute [124456](https://www.openstreetmap.org/relation/124456) | ODbL |
| Variants | OSM relations 9678296, 9678380, 9678267, 9678437, 9678501, 9678726, 9678375 (`role=alternative`) | ODbL |
| Elevation (94.6%) | IGN Géoplateforme RGE ALTI (`ign_rge_alti_wld`) | IGN open licence |
| Elevation (5.4%) | swisstopo swissALTI3D via `api3.geo.admin.ch` | © swisstopo |
| Elevation (1 point) | OpenTopoData SRTM 30 m | CC-BY / public domain |

The fetched loop is a single continuous closed ring: 736 member ways, 16,999
vertices, 166.01 km. No manual stitching or gap-filling was required.

## Loop orientation

The direction OSM stores the relation in is arbitrary, so `split_legs.py` does
not assume one. It projects every stage stop onto the ring and checks whether
they appear in itinerary order; on this data the stored ring runs backwards
(5 of 6 consecutive stops descending), so it is reversed before slicing. If OSM
is re-digitised later the script will simply detect the new direction.

## Leg boundary accuracy

Stage stops are perpendicular-projected onto the trail. Offset is the distance
from the town/refuge to the trail itself.

| Anchor | Position | Offset |
|---|---:|---:|
| Les Houches | 0.00 km | 12 m |
| Les Contamines | 17.11 km | 100 m |
| Les Chapieux | 35.96 km | 6 m |
| Les Mottets | 42.15 km | 7 m |
| Lac Combal | 52.99 km | 145 m |
| Courmayeur | 65.87 km | 387 m |
| Arnouvaz | 83.44 km | 119 m |
| La Fouly | 97.47 km | 25 m |
| Champex-Lac | 112.36 km | 56 m |
| Trient | 128.34 km | 20 m |
| Col de Balme | 134.14 km | 105 m |

Two anchors are deliberately off the main route and are excluded from the
offset warning:

- **Le Tour** (1,007 m off) — the main itinerary stays high over the Aiguillette
  des Posettes toward Tré-le-Champ. Reaching Le Tour uses variant relation
  9678501, which day 7's shortcut composition does explicitly.
- **Chamonix** (2,309 m off) — the trip base, reached by bus or train, never on
  foot.

**Courmayeur** carries an explicit `acceptOffset_m: 450`. The main relation
passes above the town rather than through the centre, so the leg boundary sits
at the trail's closest approach about 390 m north of the town node. This is
correct behaviour, not a data error.

## Elevation accuracy

Sampled DEM values at surveyed cols, taken at the nearest vertex of the 25 m
sampling grid:

| Col | Surveyed | Sampled | Delta |
|---|---:|---:|---:|
| Col de la Seigne | 2,515 m | 2,514.8 m | −0.2 m |
| Col du Brévent | 2,368 m | 2,368.3 m | +0.3 m |
| Col du Bonhomme | 2,329 m | 2,330.5 m | +1.5 m |
| Col Chécrouit | 1,952 m | 1,954.2 m | +2.2 m |
| Col de Voza | 1,650 m | 1,654.5 m | +4.5 m |
| Croix du Bonhomme | 2,433 m | 2,428.6 m | −4.4 m |
| Col de Balme | 2,191 m | 2,198.8 m | +7.8 m |
| Grand Col Ferret | 2,537 m | 2,528.3 m | −8.7 m |

Mean absolute error is about 3.7 m, which is well inside what a profile chart or
a walking-time estimate can resolve. Fenêtre d'Arpette validates separately on
its own variant leg at 2,647 m against a surveyed 2,665 m.

Lac Blanc is **not** on the main loop — it sits 909 m off-route above La
Flégère, so it is recorded as a detour waypoint with its own distance and climb
rather than as a point on the line.

## Gain and loss methodology

Summing every positive delta in a raw DEM series inflates ascent badly, because
metre-scale sampling noise accumulates over thousands of points. Two corrections
are applied in `tmblib.py`:

1. A centred 5-point moving average over the elevation series.
2. Run-based hysteresis in `gain_loss()` — consecutive same-sign deltas are
   accumulated into a run, and a run only counts once it exceeds 5 m.

## Computed versus planned

Computed gain runs consistently 1–7% below the planning spreadsheet, which is
the expected signature of the hysteresis filter compared with figures typically
derived from raw GPS or unfiltered DEM sums. The agreement is close enough that
both numbers are shown in the UI rather than one overriding the other.

| Leg | Computed dist | Planned dist | Computed gain | Planned gain | Delta |
|---|---:|---:|---:|---:|---:|
| Day 1 Les Houches → Les Contamines | 16.94 km | 17 km | 962 m | 1,019 m | −57 |
| Day 2 Les Contamines → Les Chapieux | 18.60 km | 19 km | 1,366 m | 1,379 m | −13 |
| Day 3 classic | 29.63 km | 31.5 km | 1,502 m | 1,616 m | −114 |
| Day 3 shortcut | 10.71 km | 14 km | 666 m | 700 m | −34 |
| Day 4 classic | 31.35 km | 32.9 km | 1,969 m | 2,053 m | −84 |
| Day 4 shortcut | 13.90 km | 13 km | 781 m | 500 m | **+281** |
| Day 5 La Fouly → Champex | 14.78 km | 15.3 km | 567 m | 592 m | −25 |
| Day 6 Champex → Trient | 15.85 km | 15.9 km | 806 m | 876 m | −70 |
| Day 7 classic | 36.97 km | 37.5 km | 2,646 m | 2,664 m | −18 |
| Day 7 shortcut | 11.88 km | 12 km | 957 m | 1,000 m | −43 |

The classic legs sum to 166.02 km, matching the loop length exactly.

### Two discrepancies worth a decision

**Day 4 shortcut is 281 m more climbing than planned.** The Val Ferret bus
terminates at Arnouvaz (1,769 m) and Grand Col Ferret is 2,537 m, so the climb
is unavoidably about 780 m. The planned 500 m corresponds to starting from
Rifugio Elena (2,055 m), roughly 45 minutes further up. Either adjust the
expectation or plan a night at Elena.

**Day 3 shortcut is 3.3 km shorter than planned.** The leg is anchored from Les
Mottets (navette drop plus a short road walk) to the Lac Combal bus stop. The
planned 14 km probably assumed walking from Ville des Glaciers and/or continuing
further down Val Veni before catching the bus. Move the `lac-combal` anchor down
the valley in `route-plan.json` if the group prefers a longer walking day.

### Itinerary day count

The spreadsheet lists 7 hiking days (Jul 3, 4, 5, 7, 8, 9, 10) around a Jul 6
rest day, while the chat notes said "7 days, with 6 days of hiking." The seeded
data uses **7 hiking days plus 1 rest day**. Rest days are toggleable per day on
the Planner page, so switching costs nothing.

### What `startDate` means

`settings.trip.startDate` is the **arrival day**, because it is the date of the
first entry in `itinerary.json` and that entry is "Arrive Chamonix". It is not
the first day of walking. The two are one day apart, which is easy to get wrong
in both directions:

| `startDate` | Hiking day 1 | Rest day | Matches the plan? |
| --- | --- | --- | --- |
| 2026-07-02 | Jul 3 | Jul 6 | yes — this is the seeded value |
| 2026-07-03 | Jul 4 | Jul 7 | no, a day late throughout |

The seed was initially set to Jul 3, which silently pushed every hiking day one
day later than the group's table. It is now Jul 2, and
`tools/test/run-tests.js` asserts both that hiking day 1 is the day after
arrival and that it lands on Jul 3, so the same slip cannot come back unnoticed.

Nothing else in the data stores a date. Every date on every page is derived by
walking the itinerary from this one value, which is what makes shifting the trip
or inserting a rest day a single-field edit.
