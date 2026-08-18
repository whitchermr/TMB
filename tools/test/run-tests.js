/**
 * Test suite for the pure logic modules, run under JavaScriptCore.
 *
 * Executed by tools/test.sh. Browser globals the modules touch (localStorage,
 * fetch, document) are stubbed just enough that importing them succeeds, then
 * the geometry, scheduling, solar and money logic is exercised against the real
 * generated route data on disk.
 *
 *   jsc -m tools/test/run-tests.js
 */

/* ------------------------------------------------------------------ */
/* browser shims                                                       */
/* ------------------------------------------------------------------ */

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};
globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ */
/* tiny test runner                                                    */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
let group = '';

function describe(name) {
  group = name;
  print(`\n  ${name}`);
}

function ok(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    print(`    pass  ${label}`);
  } else {
    failures.push(`${group} — ${label}${detail ? ` (${detail})` : ''}`);
    print(`    FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function near(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  ok(
    delta <= tolerance,
    label,
    `got ${round(actual)}, expected ${round(expected)} +/- ${tolerance}`
  );
}

function round(value) {
  return typeof value === 'number' ? Number(value.toFixed(3)) : String(value);
}

const json = (path) => JSON.parse(readFile(path));

/* ------------------------------------------------------------------ */

import * as geo from '../../assets/js/core/geo.js';
import * as schedule from '../../assets/js/core/schedule.js';
import * as sun from '../../assets/js/core/sun.js';
import * as money from '../../assets/js/core/money.js';

const legIndex = json('data/route/legs/index.json');
const anchors = json('data/route/anchors.json').anchors;
const itinerary = json('data/itinerary.json');
const settings = json('data/settings.json');
const waypoints = json('data/waypoints.json').waypoints;
const people = json('data/people.json');
const rates = json('data/rates.json');
const stays = json('data/stays.json');
const expensesFile = json('data/expenses.json');
const photos = json('data/photos.json').photos;
const history = json('data/history.json').entries;
const { isPhotographic, isHistoric } = geo;
const leg = (dayId, variant) => json(`data/route/legs/${dayId}-${variant}.json`);

print('TMB logic tests');

/* ------------------------------------------------------------------ */
describe('geo: distance and projection');

const seigne = [6.80721, 45.75126];
const bonhomme = [6.7066, 45.73501];
near(geo.haversine(seigne, seigne), 0, 0.001, 'zero distance to self');
near(geo.haversine(seigne, bonhomme), 8035, 400, 'Seigne to Bonhomme is roughly 8 km');

const day03 = leg('day-03', 'classic');
const cum = day03.cumulative_m;
ok(cum[0] === 0, 'cumulative distance starts at zero');
ok(
  cum.every((value, i) => i === 0 || value >= cum[i - 1]),
  'cumulative distance is monotonically increasing'
);
near(
  cum[cum.length - 1],
  day03.stats.distance_m,
  1,
  'stored distance matches the cumulative series'
);

// Cross-check the JS and Python geometry implementations on the full-resolution
// loop, which the pipeline measured at 166.01 km.
const fullLoop = json('data/route/tmb-main.geojson').features[0];
const jsLoopLength = geo.cumulativeDistances(fullLoop.geometry.coordinates);
near(
  jsLoopLength[jsLoopLength.length - 1],
  fullLoop.properties.length_m,
  5,
  'JS haversine reproduces the Python loop length to within 5 m'
);

// Stored distances come from the full-resolution trail, while the track itself
// is simplified for rendering. Re-measuring the simplified line must therefore
// come out slightly short — that gap is the whole reason distances are carried
// over from the original geometry rather than recomputed.
const resimplified = geo.cumulativeDistances(day03.track);
const simplifiedTotal = resimplified[resimplified.length - 1];
const trueTotal = cum[cum.length - 1];
ok(
  simplifiedTotal < trueTotal,
  'the simplified track measures shorter than the true trail'
);
ok(
  (trueTotal - simplifiedTotal) / trueTotal < 0.02,
  'simplification loses under 2% of length',
  `${round(((trueTotal - simplifiedTotal) / trueTotal) * 100)}%`
);

const projected = geo.projectOntoTrack(seigne, day03.track, cum);
ok(projected !== null, 'Col de la Seigne projects onto day 3');
ok(projected.offset_m < 30, 'Seigne sits on the trail', `offset ${round(projected.offset_m)} m`);
ok(
  projected.position_m > 0 && projected.position_m < cum[cum.length - 1],
  'Seigne falls inside the leg'
);

const offRoute = geo.projectOntoTrack([6.88966, 45.98235], day03.track, cum);
ok(offRoute.offset_m > 5000, 'Lac Blanc is nowhere near day 3');

ok(geo.indexAtDistance(cum, -10) === 0, 'index clamps below range');
ok(geo.indexAtDistance(cum, 1e9) === cum.length - 1, 'index clamps above range');

const midElevation = geo.valueAtDistance(cum, day03.elevation_m, cum[cum.length - 1] / 2);
ok(midElevation > 1000 && midElevation < 2600, 'interpolated elevation is plausible');

/* ------------------------------------------------------------------ */
describe('geo: waypoint placement');

const day03Waypoints = waypoints.filter((w) => w.dayId === 'day-03');
const located = geo.locateWaypoints(
  day03Waypoints,
  day03.track,
  cum,
  day03.elevation_m
);
ok(located.length === day03Waypoints.length, 'every day-3 waypoint is placed');
ok(
  located.every((w, i) => i === 0 || w.position_m >= located[i - 1].position_m),
  'waypoints come back sorted by distance along the day'
);

const seigneWaypoint = located.find((w) => w.id === 'col-de-la-seigne');
ok(!seigneWaypoint.isDetour, 'Col de la Seigne is on-route, not a detour');
const combal = located.find((w) => w.id === 'lac-combal');
ok(
  seigneWaypoint.position_m < combal.position_m,
  'Col de la Seigne comes before Lac Combal, matching the direction of travel'
);

// Lac Blanc is flagged in the data as a detour and must be reported as one.
const day07 = leg('day-07', 'classic');
const day07Located = geo.locateWaypoints(
  waypoints.filter((w) => w.dayId === 'day-07'),
  day07.track,
  day07.cumulative_m,
  day07.elevation_m
);
const lacBlanc = day07Located.find((w) => w.id === 'lac-blanc');
ok(lacBlanc.isDetour === true, 'Lac Blanc is reported as a detour');
ok(lacBlanc.detour.distance_m > 500, 'Lac Blanc detour has real extra distance');

/* ------------------------------------------------------------------ */
describe('schedule: dates and rest days');

ok(schedule.addDays('2026-07-03', 0) === '2026-07-03', 'adding zero days is a no-op');
ok(schedule.addDays('2026-07-03', 1) === '2026-07-04', 'adding one day');
ok(schedule.addDays('2026-07-31', 1) === '2026-08-01', 'rolls over a month boundary');
ok(schedule.addDays('2026-12-31', 1) === '2027-01-01', 'rolls over a year boundary');

const calendar = schedule.buildCalendar(itinerary, settings.trip.startDate);
const hikeDays = calendar.filter((d) => d.kind === 'hike');
ok(hikeDays.length === 7, 'seven hiking days', `got ${hikeDays.length}`);
ok(calendar.filter((d) => d.kind === 'rest').length === 1, 'one rest day');

// The itinerary opens with a travel day, so `startDate` is the arrival day and
// hiking starts the day after it. Asserted against the setting rather than a
// literal, so changing the trip dates does not break the test.
ok(
  hikeDays[0].date === schedule.addDays(settings.trip.startDate, 1),
  `day 1 falls the day after arrival (${hikeDays[0].date})`
);
// 2 July 2027 is the date the group chose to start *walking*. It is asserted as a
// literal because it is a decision, not a derivation: the arrival day in
// settings.json has to stay one day behind it, and this is what catches someone
// setting the arrival to the walking date and moving the whole trip.
ok(hikeDays[0].date === '2027-07-02', `day 1 falls on ${hikeDays[0].date}, as planned`);
ok(
  calendar.find((d) => d.kind === 'rest').date === '2027-07-05',
  'the Courmayeur rest day lands on Jul 5'
);
ok(
  hikeDays[hikeDays.length - 1].date === '2027-07-09',
  `the last hiking day falls on ${hikeDays[hikeDays.length - 1].date}`
);
const rest = calendar.find((d) => d.kind === 'rest');
const restIndex = calendar.indexOf(rest);
ok(
  calendar[restIndex - 1].id === 'day-03' && calendar[restIndex + 1].id === 'day-04',
  'the rest day sits between day 3 and day 4'
);
ok(
  hikeDays.every((d, i) => i === 0 || d.hikeNumber === hikeDays[i - 1].hikeNumber + 1),
  'hiking days are numbered consecutively'
);
ok(
  calendar.every((d, i) => i === 0 || d.date > calendar[i - 1].date),
  'dates strictly increase across the whole trip'
);

// Shifting the start date must move everything by the same amount.
const shiftDays = 7;
const shifted = schedule.buildCalendar(
  itinerary,
  schedule.addDays(settings.trip.startDate, shiftDays)
);
ok(
  shifted.every((d, i) => d.date === schedule.addDays(calendar[i].date, shiftDays)),
  'changing the start date shifts every day equally'
);

/* ------------------------------------------------------------------ */
describe('schedule: walking time models');

const pace = settings.pace;
const timing = schedule.legDuration(day03, pace);
ok(timing.totalHours > 0, 'day 3 takes a positive amount of time');
ok(
  timing.totalHours > timing.movingHours,
  'total time exceeds moving time once breaks are added'
);
near(
  timing.breakHours,
  (timing.movingHours * pace.breakMinutesPerHour) / 60,
  0.001,
  'break time scales with moving time'
);

// Naismith: 29.6 km with 1500 m of climb should land in a believable band for a
// long alpine day rather than an implausible number.
ok(
  timing.movingHours > 7 && timing.movingHours < 14,
  'day 3 classic moving time is plausible',
  `${round(timing.movingHours)} h`
);

const slower = schedule.legDuration(day03, { ...pace, flatSpeedKmh: 3 });
const faster = schedule.legDuration(day03, { ...pace, flatSpeedKmh: 5 });
ok(slower.totalHours > timing.totalHours, 'a slower pace takes longer');
ok(faster.totalHours < timing.totalHours, 'a faster pace takes less time');

const tobler = schedule.legDuration(day03, { ...pace, model: 'tobler' });
ok(tobler.totalHours > 0, 'the Tobler model produces a time');
ok(
  Math.abs(tobler.totalHours - timing.totalHours) / timing.totalHours < 0.6,
  'the two models agree within 60%',
  `naismith ${round(timing.totalHours)} h vs tobler ${round(tobler.totalHours)} h`
);

// A day with more climbing over less ground must be slower per kilometre.
const day05 = leg('day-05', 'classic');
const day05Timing = schedule.legDuration(day05, pace);
const day03PerKm = timing.movingHours / (day03.stats.distance_m / 1000);
const day05PerKm = day05Timing.movingHours / (day05.stats.distance_m / 1000);
ok(day03PerKm > day05PerKm, 'the steeper day costs more time per kilometre');

/* ------------------------------------------------------------------ */
describe('schedule: arrival times along a day');

const elapsedStart = schedule.elapsedAt(day03, pace, 0, timing);
const elapsedEnd = schedule.elapsedAt(day03, pace, cum[cum.length - 1], timing);
near(elapsedStart, 0, 0.01, 'zero elapsed time at the trailhead');
near(elapsedEnd, timing.totalHours, 0.05, 'full day elapsed at the finish');

let monotonic = true;
let previous = -1;
for (let i = 0; i <= 20; i += 1) {
  const value = schedule.elapsedAt(day03, pace, (cum[cum.length - 1] * i) / 20, timing);
  if (value < previous - 1e-9) monotonic = false;
  previous = value;
}
ok(monotonic, 'elapsed time never goes backwards along the day');

const seigneElapsed = schedule.elapsedAt(day03, pace, seigneWaypoint.position_m, timing);
ok(
  seigneElapsed > 0 && seigneElapsed < timing.totalHours,
  'Col de la Seigne arrival falls inside the day'
);

/* ------------------------------------------------------------------ */
describe('schedule: trip totals');

const allLegs = hikeDays.map((day) => leg(day.legId, 'classic'));
const totals = schedule.tripTotals(allLegs);
ok(totals.days === 7, 'totals cover seven days');
// The classic legs are consecutive slices of a 166.01 km closed loop.
near(totals.distance_m / 1000, 166.0, 1.5, 'classic legs sum to the full loop length');
ok(totals.gain_m > 9000 && totals.gain_m < 12000, 'total ascent is in the right range',
  `${totals.gain_m} m`);
near(totals.maxElevation_m, 2537, 60, 'high point is Grand Col Ferret');

const shortcutLegs = hikeDays.map((day) => leg(day.legId, 'shortcut'));
const shortcutTotals = schedule.tripTotals(shortcutLegs);
ok(
  shortcutTotals.distance_m < totals.distance_m,
  'the shortcut route is shorter than the classic route'
);
ok(shortcutTotals.transit_m > 0, 'the shortcut route includes bus mileage');

/* ------------------------------------------------------------------ */
describe('sun: solar events');

// Early July in Chamonix: sunrise just before 06:00, sunset just after 21:30,
// and well over 15 hours of daylight.
const chamonix = anchors['chamonix'];
const times = sun.sunTimes('2026-07-04', chamonix.lat, chamonix.lon);
ok(times !== null, 'sun times computed');
near(times.sunrise, 5.87, 0.35, 'sunrise near 05:52');
near(times.sunset, 21.53, 0.35, 'sunset near 21:32');
ok(times.dayLength > 15.2 && times.dayLength < 16.2, 'long midsummer day',
  `${round(times.dayLength)} h`);
ok(times.dawn < times.sunrise, 'first light precedes sunrise');
ok(times.goldenMorningEnd > times.sunrise, 'morning golden hour ends after sunrise');
ok(times.goldenEveningStart < times.sunset, 'evening golden hour starts before sunset');
ok(times.dusk > times.sunset, 'dusk follows sunset');

// Six months later the same place must have a much shorter day.
const winter = sun.sunTimes('2026-01-04', chamonix.lat, chamonix.lon);
ok(winter.dayLength < 9.5, 'a January day is far shorter', `${round(winter.dayLength)} h`);

ok(sun.formatHour(5.5) === '05:30', 'formats a half hour');
ok(sun.formatHour(0) === '00:00', 'formats midnight');
ok(sun.formatHour(13.999) === '14:00', 'rounds up to the next hour cleanly');
ok(sun.formatHour(null) === '—', 'null time renders as a dash');
ok(sun.parseHour('08:00') === 8, 'parses a clock time');
ok(sun.parseHour('nonsense') === null, 'rejects nonsense');

ok(sun.lightWindowAt(times.sunrise + 0.2, times) === 'golden', 'just after sunrise is golden');
ok(sun.lightWindowAt(13, times) === 'day', 'the middle of the day is full daylight');
ok(sun.lightWindowAt(1, times) === 'night', 'the small hours are dark');
ok(sun.lightMatch('sunrise', times.sunrise + 0.1, times) === 'match',
  'a sunrise subject matches a sunrise arrival');
ok(sun.lightMatch('sunrise', 13, times) === 'miss',
  'a sunrise subject misses a midday arrival');

/* ------------------------------------------------------------------ */
describe('money: currency conversion');

near(money.toBase(100, 'USD', rates), 100, 0.001, 'base currency is unchanged');
near(money.toBase(100, 'EUR', rates), 109, 0.001, 'euros convert to dollars');
near(money.toBase(100, 'CHF', rates), 112, 0.001, 'francs convert to dollars');
near(money.toBase(50, 'XXX', rates), 50, 0.001, 'an unknown currency passes through');

/* ------------------------------------------------------------------ */
describe('money: splitting');

const four = {
  people: [
    { id: 'p1', name: 'A', shares: 1 },
    { id: 'p2', name: 'B', shares: 1 },
    { id: 'p3', name: 'C', shares: 1 },
    { id: 'p4', name: 'D', shares: 1 },
  ],
};
const simpleRates = { base: 'USD', rates: [{ currency: 'USD', symbol: '$', toBase: 1 }] };

const equal = money.shareOf(
  { amount: 100, currency: 'USD', paidBy: 'p1', splitMode: 'equal' },
  four,
  simpleRates
);
ok(equal.size === 4, 'an equal split covers everyone');
near([...equal.values()].reduce((a, b) => a + b, 0), 100, 0.001, 'equal shares sum to the total');
near(equal.get('p1'), 25, 0.001, 'each of four pays a quarter');

const subset = money.shareOf(
  { amount: 90, currency: 'USD', paidBy: 'p1', splitMode: 'equal', participants: ['p1', 'p2', 'p3'] },
  four,
  simpleRates
);
ok(subset.size === 3, 'a subset split only covers its participants');
near(subset.get('p2'), 30, 0.001, 'three-way split of 90 is 30 each');
ok(!subset.has('p4'), 'a non-participant owes nothing');

const weighted = money.shareOf(
  {
    amount: 120,
    currency: 'USD',
    paidBy: 'p1',
    splitMode: 'shares',
    splitValues: { p1: 2, p2: 1, p3: 1, p4: 0 },
  },
  four,
  simpleRates
);
near(weighted.get('p1'), 60, 0.001, 'a double share pays double');
near(weighted.get('p2'), 30, 0.001, 'a single share pays half of that');
near(weighted.get('p4') || 0, 0, 0.001, 'a zero share pays nothing');

const exact = money.shareOf(
  {
    amount: 100,
    currency: 'USD',
    paidBy: 'p1',
    splitMode: 'exact',
    splitValues: { p1: 10, p2: 20, p3: 30, p4: 40 },
  },
  four,
  simpleRates
);
near([...exact.values()].reduce((a, b) => a + b, 0), 100, 0.001, 'exact amounts sum to the total');
near(exact.get('p4'), 40, 0.001, 'an exact amount is used verbatim');

const percent = money.shareOf(
  {
    amount: 200,
    currency: 'USD',
    paidBy: 'p1',
    splitMode: 'percent',
    splitValues: { p1: 25, p2: 25, p3: 25, p4: 25 },
  },
  four,
  simpleRates
);
near(percent.get('p1'), 50, 0.001, 'a quarter of 200 is 50');

/* ------------------------------------------------------------------ */
describe('money: balances and settle-up');

const ledger = [
  { id: 'a', amount: 100, currency: 'USD', paidBy: 'p1', splitMode: 'equal' },
  { id: 'b', amount: 60, currency: 'USD', paidBy: 'p2', splitMode: 'equal' },
];
const balanceList = money.balances(ledger, four, simpleRates);
near(
  balanceList.reduce((sum, entry) => sum + entry.net, 0),
  0,
  0.001,
  'balances always sum to zero'
);
near(balanceList.find((b) => b.id === 'p1').net, 60, 0.001, 'p1 paid 100 and owes 40');
near(balanceList.find((b) => b.id === 'p2').net, 20, 0.001, 'p2 paid 60 and owes 40');
near(balanceList.find((b) => b.id === 'p3').net, -40, 0.001, 'p3 paid nothing and owes 40');

const transfers = money.settleUp(balanceList);
ok(transfers.length > 0, 'settle-up produces transfers');
ok(
  transfers.length <= four.people.length - 1,
  'never more transfers than people minus one',
  `${transfers.length} transfers`
);
ok(transfers.every((t) => t.amount > 0), 'every transfer moves a positive amount');

// Applying the transfers must clear every balance.
const settled = new Map(balanceList.map((entry) => [entry.id, entry.net]));
transfers.forEach((transfer) => {
  settled.set(transfer.fromId, settled.get(transfer.fromId) + transfer.amount);
  settled.set(transfer.toId, settled.get(transfer.toId) - transfer.amount);
});
ok(
  [...settled.values()].every((value) => Math.abs(value) < 0.02),
  'applying the transfers zeroes every balance'
);

ok(money.settleUp([{ id: 'p1', name: 'A', net: 0 }]).length === 0,
  'nothing to settle when everyone is square');

/* ------------------------------------------------------------------ */
describe('money: derived lodging and the real ledger');

const derived = money.derivedStayExpenses(stays, people, itinerary);
ok(derived.length > 0, 'lodging produces derived expenses');
ok(derived.every((entry) => entry.derived === true), 'derived entries are flagged');
ok(
  derived.every((entry) => entry.category === 'lodging'),
  'derived entries are categorised as lodging'
);
ok(
  !derived.some((entry) => entry.stopId === 'chamonix'),
  'the excluded Chamonix stop stays out of the budget'
);

const courmayeur = derived.find((entry) => entry.stopId === 'courmayeur');
ok(courmayeur !== undefined, 'Courmayeur lodging is present');
// Two nights at 180 EUR per person for four people.
near(courmayeur.amount, 180 * 2 * people.people.length, 0.01,
  'Courmayeur charges two nights for everyone');

const combined = [...expensesFile.expenses, ...derived];
const realBalances = money.balances(combined, people, rates);
near(
  realBalances.reduce((sum, entry) => sum + entry.net, 0),
  0,
  0.01,
  'the real ledger balances to zero'
);
const total = money.tripTotal(combined, rates);
ok(total > 0, 'the trip has a positive total cost');
const perPerson = total / people.people.length;
ok(perPerson > 200 && perPerson < 5000, 'cost per person is plausible',
  `$${round(perPerson)}`);

const categories = money.byCategory(combined, rates);
ok(categories.length > 0, 'category rollup produces rows');
ok(
  categories.every((row, i) => i === 0 || row.amount <= categories[i - 1].amount),
  'categories are sorted largest first'
);
near(
  categories.reduce((sum, row) => sum + row.amount, 0),
  total,
  0.01,
  'category totals reconcile with the trip total'
);

/* ------------------------------------------------------------------ */
describe('data integrity');

ok(legIndex.length === 15, 'fifteen leg files are indexed', `got ${legIndex.length}`);
ok(
  legIndex.every((entry) => entry.stats && entry.stats.distance_m > 0),
  'every indexed leg has statistics'
);

hikeDays.forEach((day) => {
  const entry = legIndex.find((e) => e.dayId === day.legId && e.variant === 'shortcut');
  ok(entry !== undefined, `day ${day.hikeNumber} has a shortcut leg`);
});

const waypointIds = waypoints.map((w) => w.id);
ok(new Set(waypointIds).size === waypointIds.length, 'waypoint ids are unique');
ok(
  waypoints.every((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon)),
  'every waypoint has coordinates'
);
ok(
  waypoints.every((w) => w.lat > 45 && w.lat < 47 && w.lon > 6 && w.lon < 8),
  'every waypoint sits inside the Mont Blanc region'
);
const dayIds = new Set(itinerary.days.map((d) => d.id));
ok(
  waypoints.every((w) => dayIds.has(w.dayId)),
  'every waypoint references a real itinerary day'
);

const personIds = new Set(people.people.map((p) => p.id));
ok(
  expensesFile.expenses.every((e) => personIds.has(e.paidBy)),
  'every expense payer is a known person'
);
// Renaming someone is expected; renumbering them silently detaches their history.
ok(personIds.size === people.people.length, 'person ids are unique');
ok(
  people.people.every((p) => p.name && p.name.trim() && p.color),
  'everyone has a name and a colour'
);

/* ------------------------------------------------------------------ */
describe('waypoint photographs');

// The scenery list is meant to show what we are walking towards, so a photo stop
// with no picture is a gap in the feature rather than a harmless omission. Scoped
// to photographic waypoints: a historic landmark earns its place with a writeup,
// and requiring a photograph of it too would only invite a decorative one.
const photoIds = new Set(photos.map((entry) => entry.waypointId));
const photoStops = waypoints.filter(isPhotographic);
ok(
  photoStops.every((w) => photoIds.has(w.id)),
  'every scenery stop has a photograph',
  `${photoStops.filter((w) => photoIds.has(w.id)).length} of ${photoStops.length}`
);
// The other direction still holds for everything: a photo block without a
// photograph, or the reverse, means the two files have drifted apart.
ok(
  waypoints.every((w) => isPhotographic(w) === Boolean(w.photo)),
  'a photo block appears exactly on the waypoints that claim to be photographic',
  waypoints
    .filter((w) => isPhotographic(w) !== Boolean(w.photo))
    .map((w) => w.id)
    .join(', ')
);
ok(
  photos.every((entry) => waypointIds.includes(entry.waypointId)),
  'no photograph points at a waypoint that no longer exists'
);
// CC BY and CC BY-SA both make attribution a condition of use, so an entry
// without a photographer is a licence problem, not a missing nicety.
ok(
  photos.every((entry) => entry.credit && entry.credit.author && entry.credit.licence),
  'every photograph names its photographer and licence'
);
ok(
  photos.every((entry) => entry.file.startsWith('assets/photos/')),
  'photographs are stored in the repository rather than hotlinked'
);
ok(
  photos.every((entry) => entry.width > 0 && entry.height > 0),
  'every photograph records its dimensions so pages can reserve space'
);
ok(new Set(people.people.map((p) => p.id)).size === people.people.length,
  'person ids are unique');

/* ------------------------------------------------------------------ */
describe('landmark history');

// The two files are joined only by this id, so a typo in either one silently
// removes a writeup from the site rather than failing anywhere visible.
const historicIds = waypoints.filter(isHistoric).map((w) => w.id);
const historyIds = history.map((entry) => entry.waypointId);
ok(
  historicIds.every((id) => historyIds.includes(id)),
  'every historic landmark has a writeup',
  historicIds.filter((id) => !historyIds.includes(id)).join(', ')
);
ok(
  historyIds.every((id) => waypointIds.includes(id)),
  'no writeup points at a waypoint that no longer exists',
  historyIds.filter((id) => !waypointIds.includes(id)).join(', ')
);
ok(
  historyIds.every((id) => historicIds.includes(id)),
  'no writeup is attached to a waypoint that is not marked historic',
  historyIds.filter((id) => !historicIds.includes(id)).join(', ')
);
ok(new Set(historyIds).size === historyIds.length, 'one writeup per landmark');

// A writeup that renders as an empty panel is worse than no panel, because the
// pin promises something the page does not deliver.
ok(
  history.every((entry) => entry.summary && entry.summary.trim().length > 40),
  'every writeup opens with a real summary'
);
ok(
  history.every((entry) => entry.eras?.length >= 2),
  'every writeup has at least two eras',
  history.filter((entry) => !(entry.eras?.length >= 2)).map((e) => e.waypointId).join(', ')
);
ok(
  history.every((entry) =>
    entry.eras.every((era) => era.year && era.text && era.text.trim().length > 60)
  ),
  'every era carries a date and enough text to stand on its own offline'
);
// The panel renders eras in file order, so the file order has to be the
// chronology. Sorting at render time would hide an authoring mistake instead.
const startYear = (era) => {
  const match = String(era.year).match(/\d{3,4}/);
  return match ? Number(match[0]) : null;
};
ok(
  history.every((entry) => {
    const years = entry.eras.map(startYear).filter((year) => year !== null);
    return years.every((year, index) => index === 0 || years[index - 1] <= year);
  }),
  'eras are written in chronological order',
  history
    .filter((entry) => {
      const years = entry.eras.map(startYear).filter((y) => y !== null);
      return !years.every((y, i) => i === 0 || years[i - 1] <= y);
    })
    .map((e) => e.waypointId)
    .join(', ')
);
// Sources are the whole basis for trusting any of this.
ok(
  history.every((entry) => entry.sources?.length >= 1),
  'every writeup cites at least one source'
);
ok(
  history.every((entry) =>
    entry.sources.every(
      (source) => source.title && source.publisher && /^https:\/\//.test(source.url)
    )
  ),
  'every source has a title, a publisher and an https link'
);
// A landmark is placed by projecting it onto whichever variant is selected, so one
// that only lands on the classic line would vanish from the map on a shortcut day.
const landmarkDays = [...new Set(waypoints.filter(isHistoric).map((w) => w.dayId))];
landmarkDays.forEach((dayId) => {
  const variants = legIndex.filter((entry) => entry.dayId === dayId).map((e) => e.variant);
  const landmarks = waypoints.filter((w) => w.dayId === dayId && isHistoric(w));
  variants.forEach((variant) => {
    const data = leg(dayId, variant);
    const placed = geo.locateWaypoints(
      landmarks,
      data.track,
      data.cumulative_m,
      data.elevation_m
    );
    ok(
      placed.length === landmarks.length &&
        placed.every((w) => Number.isFinite(w.position_m)),
      `${dayId}-${variant}: every landmark is placed on this variant`
    );
  });
});

// A landmark far enough off the trail to need a decision about visiting it has to
// say so in words, because a "detour +2.5 km" chip computed from the straight-line
// offset can be a wild underestimate of the walking actually involved.
const detourLandmarks = waypoints
  .filter(isHistoric)
  .filter((w) => {
    const entry = legIndex.find((e) => e.dayId === w.dayId);
    const data = leg(entry.dayId, entry.variant);
    const [placed] = geo.locateWaypoints([w], data.track, data.cumulative_m, data.elevation_m);
    return placed.isDetour;
  });
ok(
  detourLandmarks.length > 0,
  'at least one landmark is off the line, so the check below is not vacuous'
);
ok(
  detourLandmarks.every((w) => {
    const entry = history.find((e) => e.waypointId === w.id);
    return /off route|not on the|across the valley|from the village|before we|side trip|visible from/i.test(
      entry.summary
    );
  }),
  'an off-route landmark explains in words how to reach or see it',
  detourLandmarks
    .filter((w) => {
      const entry = history.find((e) => e.waypointId === w.id);
      return !/off route|not on the|across the valley|from the village|before we|side trip|visible from/i.test(
        entry.summary
      );
    })
    .map((w) => w.id)
    .join(', ')
);

const stopIds = new Set(stays.stops.map((s) => s.stopId));
const stayTargets = itinerary.days.map((d) => d.stayAt).filter(Boolean);
ok(
  stayTargets.every((target) => stopIds.has(target)),
  'every overnight stop has a stays entry'
);

// Every leg must be internally consistent: arrays of matching length, and
// segment index ranges that actually point into the track.
legIndex.forEach((entry) => {
  const data = leg(entry.dayId, entry.variant);
  const label = `${entry.dayId}-${entry.variant}`;
  ok(
    data.track.length === data.cumulative_m.length &&
      data.track.length === data.elevation_m.length,
    `${label}: track, distance and elevation arrays align`
  );
  ok(
    data.elevation_m.every((value) => value === null || (value > 500 && value < 3000)),
    `${label}: elevations are inside Alpine range`
  );
  ok(data.missingElevation === 0, `${label}: no missing elevation samples`);
  data.segments
    .filter((segment) => segment.type === 'hike' && segment.trackStart != null)
    .forEach((segment) => {
      ok(
        segment.trackEnd < data.track.length && segment.trackStart <= segment.trackEnd,
        `${label}: segment indices point into the track`
      );
    });
});

/* ------------------------------------------------------------------ */

print(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  print('\nFailures:');
  failures.forEach((failure) => print(`  - ${failure}`));
  throw new Error(`${failures.length} test(s) failed`);
}
print('All logic tests passed.');
