/**
 * Run one page controller against the DOM shim and fail on any error.
 *
 * This is the closest thing to opening the site in a browser that this machine
 * can do — headless Brave hangs on crashpad no matter which flags are passed.
 * The page's real HTML is parsed, real trip data is read off disk through the
 * fetch shim, and the page's actual module is imported and allowed to run. It
 * passes only if nothing threw, nothing was logged as an error, and the
 * containers it is meant to fill actually ended up with content.
 *
 * One page per process, because a page module runs its work at import time and
 * an ES module is only ever evaluated once per realm.
 *
 *   jsc -m tools/test/page_smoke.js -- index
 */

import { installDom, SyntheticEvent } from './dom.js';

/* ------------------------------------------------------------------ */
/* pages under test                                                    */
/* ------------------------------------------------------------------ */

/**
 * `expect` lists element ids that must hold rendered content once the page has
 * settled — the ones a blank-page bug would leave empty, which is exactly what
 * static analysis cannot see.
 */
const PAGES = {
  index: {
    label: 'index.html',
    file: 'index.html',
    module: '../../assets/js/pages/index.js',
    url: 'https://example.test/index.html',
    expect: ['trip-summary', 'trip-stats', 'day-list', 'variant-toggle', 'map-legend'],
    wantsMap: true,
    contains: [
      ['day-list', 'Les Houches', 'the first stage'],
      ['day-list', 'Courmayeur', 'the Italian stage'],
      ['trip-stats', ' mi', 'a distance in the totals'],
    ],
  },
  day: {
    label: 'day.html?d=day-01',
    file: 'day.html',
    module: '../../assets/js/pages/day.js',
    url: 'https://example.test/day.html?d=day-01',
    expect: ['day-title', 'day-stats', 'segments', 'waypoint-list', 'sun-stats', 'day-select'],
    wantsMap: true,
    contains: [
      ['day-title', 'Les Contamines', 'the day-1 destination'],
      ['waypoint-list', 'Col de Voza', 'a day-1 scenery stop'],
      ['sun-stats', ':', 'a clock time in the sun panel'],
      // The credit is rendered from the photo entry, so finding a licence in the
      // scenery list proves the photograph itself was rendered with it.
      ['waypoint-list', 'CC BY', 'a photo credit beside a scenery stop'],
      // A landmark with no photograph at all, which the list used to assume.
      ['waypoint-list', 'Christ Roi', 'a history-only landmark'],
      // Prose and a citation together prove the writeup rendered rather than just
      // the heading, and that the offline copy carries its sources with it.
      ['waypoint-list', '1934', 'a date from a landmark writeup'],
      ['waypoint-list', 'Sources', 'the citations under a writeup'],
      ['map-legend', 'Historic', 'the historic pin in the legend'],
    ],
    interact: interactDay,
  },
  day4: {
    // Day 4 is the Courmayeur–Arnouvaz bus day, so it exercises the transit
    // branch that pure hiking days never reach.
    label: 'day.html?d=day-04 (transit)',
    file: 'day.html',
    module: '../../assets/js/pages/day.js',
    url: 'https://example.test/day.html?d=day-04',
    expect: ['day-title', 'day-stats', 'segments', 'skip-day'],
    wantsMap: true,
    contains: [
      // The route data knows a bus covers part of this day but not when it runs,
      // so the segment has to offer somewhere to find that out.
      ['segments', 'Times', 'a link to the times for the bus leg'],
      ['skip-day', 'Skip this day', 'the way round the whole day'],
    ],
    interact: interactDayTransit,
  },
  plan: {
    label: 'plan.html',
    file: 'plan.html',
    module: '../../assets/js/pages/plan.js',
    url: 'https://example.test/plan.html',
    expect: [
      'plan-stats',
      'plan-table',
      'model-compare',
      'light-table',
      'rest-list',
      'start-date-note',
    ],
    contains: [
      ['plan-table', 'Jul', 'dates derived from the start date'],
      ['light-table', 'Col', 'a col in the light plan'],
      // No device preference is set in the shim, so this is the committed group
      // default coming through — miles, not kilometres.
      ['plan-stats', ' mi', 'distances default to miles'],
      ['start-date-note', 'Hiking day 1', 'the arrival day is distinguished from day 1'],
    ],
    interact: interactPlan,
  },
  stays: {
    label: 'stays.html',
    file: 'stays.html',
    module: '../../assets/js/pages/stays.js',
    url: 'https://example.test/stays.html',
    expect: ['stay-stats', 'stops'],
    contains: [
      ['stops', 'Contamines', 'a lodging stop'],
      ['stops', 'Getting here', 'a link to getting to a stop'],
    ],
    interact: interactStaysTransit,
  },
  money: {
    label: 'money.html',
    file: 'money.html',
    module: '../../assets/js/pages/money.js',
    url: 'https://example.test/money.html',
    expect: ['money-stats', 'balances', 'settle', 'categories', 'people-list', 'rates-list'],
    contains: [
      ['categories', 'lodging', 'the lodging category'],
      ['rates-list', 'EUR', 'the euro rate'],
    ],
  },
  packing: {
    label: 'packing.html',
    file: 'packing.html',
    module: '../../assets/js/pages/packing.js',
    url: 'https://example.test/packing.html',
    expect: ['packing-stats', 'packing-groups', 'packing-who', 'sync-panel'],
    contains: [
      ['packing-groups', 'Sleeping bag liner', 'a default item'],
      ['packing-groups', 'essential', 'the essential marker'],
      ['packing-stats', '0 of ', 'nothing packed yet'],
      // An endpoint is configured but this device holds no passphrase, so the
      // page has to ask for one rather than implying edits are reaching anyone.
      ['sync-panel', 'Join the group list', 'that this device has not joined yet'],
      ['packing-who', 'David', 'the people to pack as'],
    ],
    interact: interactPacking,
  },
  print: {
    label: 'print.html',
    file: 'print.html',
    module: '../../assets/js/pages/print.js',
    url: 'https://example.test/print.html',
    expect: ['brief', 'brief-foot'],
    contains: [
      ['brief', 'Day 1', 'a numbered hiking day'],
      ['brief', 'Day 6', 'the last hiking day'],
      ['brief', 'Scenery and photo stops', 'the scenery section'],
      ['brief', 'Tonight', 'the lodging block'],
    ],
    // One elevation profile per hiking day, drawn as inline SVG.
    minSvg: 6,
  },
  transit: {
    // Day 4 is Courmayeur to Champex-Lac, the longest day and the realistic
    // "skip a day" query. Getting round it by vehicle needs every change the
    // search allows, so this exercises the handover from the day page and a
    // multi-leg journey through Orsières in one load. `changes=3` is explicit
    // because the default of 2 is genuinely not enough for this pair.
    label: 'transit.html?day=day-04',
    file: 'transit.html',
    module: '../../assets/js/pages/transit.js',
    url: 'https://example.test/transit.html?day=day-04&changes=3',
    expect: [
      'from-place',
      'to-place',
      'journey-summary',
      'journeys',
      'on-demand',
      'trip-board',
      'board-summary',
      'provenance',
      'map-legend',
    ],
    wantsMap: true,
    contains: [
      ['from-place', 'Courmayeur', 'the day-4 origin, prefilled from the query string'],
      ['to-place', 'Champex', 'the day-4 destination'],
      ['from-place', 'Geneva', 'the airport as a pickable origin'],
      ['journeys', 'Orsières', 'the change on the way to Champex'],
      ['journeys', 'change', 'the number of changes on a journey'],
      ['journey-summary', 'Fastest', 'the summary stats'],
      ['provenance', 'transit-notes', 'where the provenance is written down'],
      // The board is the way into the page now, so the things that make a row
      // worth reading are asserted rather than just its presence.
      ['trip-board', 'Skip the walk', 'the skip option on a walking day'],
      ['trip-board', 'Hôtel Arolla', 'the hotel for the off-trail Chapieux night'],
      ['trip-board', 'Bourg-Saint-Maurice', 'and where that bed actually is'],
      ['trip-board', 'Ride to bed', 'the ride that reaches it'],
      ['trip-board', 'last 18:20', 'with the deadline for catching it'],
      ['trip-board', 'To the start', 'the morning bus down to the day-1 trailhead'],
      ['trip-board', 'per vehicle', 'a taxi quote kept in per-vehicle terms'],
      ['board-summary', 'way round', 'the count of days that can be skipped'],
      // A deadline resting on an unverified timetable has to say so on its face,
      // not in a tooltip nobody hovers on a phone.
      ['trip-board', 'unverified', 'a deadline flagged as resting on an unverified timetable'],
      ['board-summary', 'unverified', 'and counted in the header so it is not missed'],
    ],
    interact: interactTransit,
  },
  about: {
    label: 'about.html',
    file: 'about.html',
    module: '../../assets/js/pages/about.js',
    url: 'https://example.test/about.html',
    // No service worker in the shim, so the panel should explain itself rather
    // than sit on "Checking offline support…" forever.
    expect: ['offline-state'],
    contains: [['offline-state', 'https', 'the reason offline caching is unavailable']],
  },
};

/* ------------------------------------------------------------------ */
/* interactions                                                        */
/* ------------------------------------------------------------------ */

/**
 * The transit page's three interactive parts.
 *
 * All three are behavioural and invisible to static analysis: search only fills
 * on input, selecting a leg has to open that service rather than swallow the
 * click into the journey card, and an out-of-season date has to say nothing runs
 * instead of quietly rendering an empty list that reads as a broken page.
 */
function interactTransit(document) {
  const search = document.getElementById('search-input');
  search.value = 'forclaz';
  search.dispatchEvent(new SyntheticEvent('input', { bubbles: true }));
  const results = document.getElementById('search-results');
  ok(results.textContent.includes('Forclaz'), 'searching finds the Col de la Forclaz');
  ok(
    results.querySelectorAll('[data-set-field="from-place"]').length > 0,
    'a place result offers to become the origin'
  );

  // An unaccented query has to find an accented name, since nobody types the
  // grave accent in "Orsières" on a phone.
  search.value = 'orsieres';
  search.dispatchEvent(new SyntheticEvent('input', { bubbles: true }));
  ok(
    document.getElementById('search-results').textContent.includes('Orsières'),
    'an unaccented query finds the accented place'
  );

  const journeys = document.querySelectorAll('[data-journey]');
  ok(journeys.length > 0, 'the page found at least one journey');
  ok(
    journeys[0].getAttribute('data-selected') === 'true',
    'the first journey starts selected'
  );

  // The honesty mechanism: how far a journey's times can be trusted belongs on
  // the journey, not in a footnote nobody reads. Which of the three levels it
  // shows depends on whether tools/fetch_transit.py has run, so what is asserted
  // is that the wording is one of them — a level the page has no label for would
  // otherwise render as a bare slug and look deliberate.
  const CONFIDENCE_WORDING = [
    'Published 2027 timetable',
    '2026 pattern, times will shift',
    'Indicative only',
  ];
  ok(
    CONFIDENCE_WORDING.some((wording) => journeys[0].textContent.includes(wording)),
    'a journey says how much its times can be trusted',
    journeys[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 120)
  );

  // Clicking a leg must open that service, not select the journey around it.
  const leg = journeys[0].querySelector('[data-service]');
  ok(Boolean(leg), 'a journey leg carries the service it uses');
  leg.click();
  const detail = document.getElementById('service-detail');
  ok(detail.textContent.includes('Stops'), 'clicking a leg shows that service in detail');
  ok(detail.textContent.includes('Departures from'), 'with its departure times');
  ok(
    detail.textContent.includes('checked'),
    'and the date the record was last verified'
  );

  // The stops in the detail panel are themselves links to a place, which is how
  // you find out where a bus stop actually is.
  const stop = detail.querySelector('[data-place]');
  ok(Boolean(stop), 'the detail panel links each stop to its place');
  stop.click();
  ok(
    document.getElementById('service-detail').textContent.includes('Open in maps'),
    'a place shows a wayfinding link'
  );

  const swap = document.getElementById('swap-places');
  const before = document.getElementById('from-place').value;
  swap.click();
  ok(
    document.getElementById('to-place').value === before,
    'swapping exchanges the two ends'
  );
  swap.click();

  // Out of season the answer is "nothing runs on this date", which must be said
  // rather than left as an empty list that reads as a broken page. The Swiss
  // Entremont lines run all year, so this needs a genuinely seasonal pair — the
  // Chapieux navette only exists between June and September.
  document.getElementById('from-place').value = 'les-chapieux';
  document.getElementById('to-place').value = 'ville-des-glaciers';
  const date = document.getElementById('journey-date');
  date.value = '2027-01-15';
  date.dispatchEvent(new SyntheticEvent('change', { bubbles: true }));
  const winter = document.getElementById('journeys').textContent;
  ok(
    winter.includes('No scheduled service'),
    'an out-of-season date explains itself instead of rendering nothing'
  );
  ok(
    winter.includes('out of season'),
    'and names the service that is closed for the winter'
  );

  // Back in season the same pair has to work, so the empty state above was the
  // date and not a broken pair.
  date.value = '2027-07-08';
  date.dispatchEvent(new SyntheticEvent('change', { bubbles: true }));
  ok(
    document.querySelectorAll('[data-journey]').length > 0,
    'the same pair in July finds the navette'
  );
}

/**
 * The landmark accordion in the planner's day-by-day table.
 *
 * Worth driving rather than only inspecting, because the two things most likely
 * to break are behavioural: the panel has to survive render() rebuilding the
 * whole table body, and opening a second stage has to close the first.
 */
function interactPlan(document) {
  const toggles = document.querySelectorAll('[data-history-for]');
  ok(toggles.length > 0, 'stages with landmarks offer a history toggle');
  if (!toggles.length) return;

  const panelFor = (button) => document.getElementById(button.getAttribute('aria-controls'));

  ok(
    toggles.every((button) => panelFor(button)?.hidden),
    'every landmark panel starts closed'
  );

  const first = toggles[0];
  first.click();
  ok(!panelFor(first).hidden, 'clicking a stage opens its landmark panel');
  ok(
    document.querySelector(`[data-history-for="${first.dataset.historyFor}"]`)
      ?.getAttribute('aria-expanded') === 'true',
    'the open stage reports aria-expanded=true'
  );

  // The table body is rebuilt on every click, so re-query rather than reusing the
  // detached element from before.
  const live = (id) => document.querySelector(`[data-history-for="${id}"]`);
  const openPanel = () =>
    document.querySelectorAll('.stage-history').filter((row) => !row.hidden);

  ok(openPanel().length === 1, 'exactly one panel is open');
  ok(
    openPanel()[0].textContent.includes('Sources'),
    'the open panel shows the writeup and its sources'
  );
  // Opening a stage should show what its landmarks are, not several screens of
  // chronology; the same disclosure the day page uses applies inside the panel.
  const writeups = openPanel()[0].querySelectorAll('.history__more');
  ok(writeups.length > 0, 'the open stage lists its landmarks');
  ok(
    writeups.every((panel) => !panel.open),
    'each landmark in the panel starts collapsed'
  );
  writeups[0].querySelector('summary').click();
  ok(writeups[0].open, 'a landmark in the panel opens on its own');
  // The click replaced the button, so focus has to have been moved to its
  // replacement rather than left on a detached node.
  ok(
    document.activeElement === live(first.dataset.historyFor),
    'focus stays on the toggle after the table is rebuilt'
  );

  const ids = toggles.map((button) => button.dataset.historyFor);
  if (ids.length > 1) {
    live(ids[1]).click();
    ok(openPanel().length === 1, 'opening a second stage closes the first');
    ok(document.getElementById(`history-${ids[0]}`).hidden, 'the first stage is now closed');
    live(ids[1]).click();
  } else {
    live(ids[0]).click();
  }

  ok(openPanel().length === 0, 'clicking the open stage again closes it');

  // Re-rendering for an unrelated reason must not close a panel someone is
  // reading. Changing the pace slider is the realistic way that happens.
  live(ids[0]).click();
  const pace = document.getElementById('pace');
  pace.value = '4.2';
  pace.dispatchEvent(new SyntheticEvent('change', { bubbles: true }));
  ok(
    openPanel().length === 1,
    'the open panel survives a re-render triggered by the pace control'
  );
}

/**
 * The writeup disclosures in the day page scenery list.
 *
 * The whole point of the disclosure is that the list is short until asked, so
 * "starts closed" is the assertion that matters most. The rest guards the two
 * ways this can go wrong quietly: the row is itself a button that pans the map,
 * and the list is rebuilt whenever a unit or variant changes.
 */
function interactDay(document) {
  const panels = () => document.querySelectorAll('.history__more');
  const openOnes = () => panels().filter((panel) => panel.open);

  ok(panels().length > 1, 'the day has more than one landmark writeup');
  ok(openOnes().length === 0, 'every writeup starts collapsed');

  // Nesting is the whole mechanism: eras rendered as siblings of the <details>
  // instead of children would look identical in a text dump and never collapse.
  ok(
    panels().every(
      (panel) =>
        panel.querySelector('.history__eras') && panel.querySelector('.history__sources')
    ),
    'the chronology and sources sit inside the disclosure'
  );
  ok(
    document
      .querySelectorAll('.history__eras')
      .every((list) => list.parentNode?.tagName === 'details'),
    'no chronology is left outside a disclosure'
  );

  const summaryOf = (panel) => panel.querySelector('summary');
  const before = globalThis.L.record.panTo;

  summaryOf(panels()[0]).click();
  ok(openOnes().length === 1, 'clicking a writeup opens it');
  ok(
    globalThis.L.record.panTo === before,
    'opening a writeup does not pan the map',
    'the click reached the row handler'
  );

  // Unlike the planner's stages, these are independent: someone comparing two
  // landmarks on the same day should not have the first close as they open the
  // second.
  summaryOf(panels()[1]).click();
  ok(openOnes().length === 2, 'a second writeup opens without closing the first');

  summaryOf(panels()[0]).click();
  ok(openOnes().length === 1, 'clicking an open writeup closes it');

  // Switching units re-renders the whole list from scratch.
  const metric = document.querySelector('[data-units="metric"]');
  ok(Boolean(metric), 'the header offers a units toggle to re-render with');
  metric.click();
  ok(
    openOnes().length === 1,
    'an open writeup survives the re-render from switching units'
  );

  // The row still does its job for a click outside the writeup.
  const row = document.querySelector('.wp');
  const beforeRow = globalThis.L.record.panTo;
  row.querySelector('.wp__name').click();
  ok(
    globalThis.L.record.panTo > beforeRow,
    'clicking the row itself still pans the map'
  );
}

/**
 * The links from a day into the transit page.
 *
 * A link whose label renders but whose href points at an unfiltered page is the
 * failure worth catching: it looks right in a text dump and costs the reader the
 * two selections they had just made. So this checks the query string, and checks
 * it against the day being viewed rather than a literal, since renumbering the
 * itinerary would otherwise leave a passing test asserting the wrong day.
 */
function interactDayTransit(document) {
  const params = (element) => new URLSearchParams(element.getAttribute('href').split('?')[1] || '');

  // Read the day's own ends out of the itinerary rather than restating them, so
  // that reshaping the trip cannot leave this passing against a stale pair.
  const viewing = JSON.parse(readFile('data/itinerary.json')).days.find(
    (day) => day.id === 'day-04'
  );

  const skip = params(document.getElementById('skip-day'));
  ok(skip.get('from') === viewing.from, 'skipping the day starts where the day starts');
  ok(skip.get('to') === viewing.to, 'and ends where it ends', `expected ${viewing.to}`);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(skip.get('date') || ''), 'on the date of the day itself');

  const leg = document.getElementById('segments').querySelector('a');
  const ride = params(leg);
  ok(Boolean(ride.get('from') && ride.get('to')), 'the bus leg link carries both of its ends');
  ok(ride.get('date') === skip.get('date'), 'and the same date as the day');
}

/**
 * The "getting here" links on the lodging cards.
 *
 * Chamonix is the one stop reached from outside the region, so it is the one
 * whose origin cannot be the default — a link from itself to itself would render
 * perfectly and find nothing.
 */
function interactStaysTransit(document) {
  const links = document
    .getElementById('stops')
    .querySelectorAll('a')
    .filter((a) => (a.getAttribute('href') || '').startsWith('transit.html'));

  ok(links.length > 1, 'more than one stop offers a way of getting there');

  const queries = links.map((a) => new URLSearchParams(a.getAttribute('href').split('?')[1]));
  ok(
    queries.every((q) => q.get('to') && q.get('from') !== q.get('to')),
    'no card links a stop to itself'
  );
  ok(
    queries.some((q) => q.get('to') === 'chamonix' && q.get('from') === 'geneva-airport'),
    'base is reached from the airport'
  );
}

/**
 * Packing: ticking an item, and adding one to the shared list.
 *
 * The two halves of the page have to stay separate, and that separation is
 * invisible in a text dump. A tick is device-local and must not become a shared
 * change; adding an item is shared and must queue one, carrying the name of
 * whoever made it. Both survive the full re-render each one triggers.
 */
function interactPacking(document) {
  const ticks = () => document.querySelectorAll('[data-packed-for]');
  const packedRows = () =>
    document.querySelectorAll('.pack-item').filter((row) => row.dataset.packed === 'true');
  const stats = () => document.getElementById('packing-stats').textContent;

  ok(ticks().length > 20, 'the default list rendered its items');
  ok(packedRows().length === 0, 'nothing starts ticked');

  const first = ticks()[0];
  const firstId = first.dataset.packedFor;
  first.click();
  ok(packedRows().length === 1, 'ticking an item marks its row packed');
  ok(stats().includes('1 of '), 'the packed count follows the tick');
  // The list is rebuilt from scratch by the tick, so the tick has to have been
  // re-rendered as checked rather than reset.
  ok(
    document.querySelector(`[data-packed-for="${firstId}"]`)?.checked === true,
    'the tick survives the re-render it caused'
  );
  ok(
    document.activeElement === document.querySelector(`[data-packed-for="${firstId}"]`),
    'focus stays on the tick after the re-render'
  );

  // A tick is mine alone. If it leaked into the shared log it would show up as
  // something waiting to publish.
  ok(
    !document.getElementById('sync-panel').textContent.includes('not published'),
    'ticking an item does not become a shared change'
  );

  // Every commit is authored by the sync service's own token, so an operation
  // with no name on it cannot be traced to anyone afterwards. The page refuses
  // the shared half until someone says who they are.
  const hint = () => document.getElementById('packing-who-hint');
  ok(hint().hidden === false, 'an unnamed device is asked to choose someone');
  document.getElementById('add-item').click();
  ok(
    document.getElementById('item-dialog').open !== true,
    'adding is refused while nobody is chosen'
  );
  ok(
    hint().textContent.includes('Choose yourself above first'),
    'the refusal says what to do about it'
  );

  const who = document.getElementById('packing-who');
  who.value = 'p1';
  who.dispatchEvent(new SyntheticEvent('change', { bubbles: true }));
  ok(hint().hidden === true, 'choosing someone clears the prompt');
  // Ticks made before choosing are filed under 'anon'. They have to follow the
  // person, or identifying yourself looks like it wiped your progress.
  ok(packedRows().length === 1, 'a tick made before choosing survives being claimed');

  document.querySelector(`[data-packed-for="${firstId}"]`).click();
  ok(packedRows().length === 0, 'un-ticking an item clears it again');

  // Adding to the list is the shared half.
  const before = ticks().length;
  document.getElementById('add-item').click();
  ok(document.getElementById('item-dialog').open === true, 'Add opens the item dialog');
  document.getElementById('item-name').value = 'Spare bootlaces';
  document.getElementById('item-essential').checked = true;
  document.getElementById('item-save').click();

  ok(ticks().length === before + 1, 'saving adds the item to the list');
  ok(
    (JSON.parse(globalThis.localStorage.getItem('tmb:outbox')) || []).some(
      (op) => op.by === 'p1'
    ),
    'the queued change records who made it'
  );
  ok(
    document.getElementById('packing-groups').textContent.includes('Spare bootlaces'),
    'the new item is shown'
  );
  ok(
    document.getElementById('sync-panel').textContent.includes('not published'),
    'the new item is queued as a shared change'
  );
  ok(stats().includes('Added by the group'), 'the stats distinguish added items');

  // Removing a default has to be recoverable, which is the whole reason removal
  // is an operation rather than a deletion. A named default is used rather than
  // whichever row sorted first, so the assertion cannot drift with the list.
  const target = 'pk-liner';
  const removedPanel = () => document.getElementById('packing-removed');
  const inList = (id) => Boolean(document.querySelector(`[data-edit-item="${id}"]`));

  ok(removedPanel().textContent.trim() === '', 'nothing is listed as removed yet');
  ok(inList(target), 'the item about to be removed is on the list');

  document.querySelector(`[data-edit-item="${target}"]`).click();
  ok(
    document.getElementById('item-delete').hidden === false,
    'editing an existing item offers removal'
  );
  // The shim declines every confirm() by default; standing in for the user
  // agreeing is the only way to reach the code past the guard.
  globalThis.window.confirm = () => true;
  document.getElementById('item-delete').click();

  ok(!inList(target), 'the removed item leaves the list');
  ok(
    Boolean(document.querySelector(`[data-restore="${target}"]`)),
    'the removed default is offered back rather than lost'
  );

  document.querySelector(`[data-restore="${target}"]`).click();
  ok(inList(target), 'restoring puts it back on the list');
  ok(removedPanel().textContent.trim() === '', 'nothing is left listed as removed');
}

/* ------------------------------------------------------------------ */
/* runner                                                              */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

function ok(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    print(`    pass  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` (${detail})` : ''}`);
    print(`    FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function describeArg(value) {
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value).slice(0, 240);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Capture console output so a page that reports an error cannot pass. */
function captureConsole(sink) {
  globalThis.console = {
    log: (...args) => print(`      log:  ${args.map(describeArg).join(' ')}`),
    info: () => {},
    debug: () => {},
    // Warnings are expected: the shim has no service worker and no clipboard.
    warn: (...args) => print(`      warn: ${args.map(describeArg).join(' ')}`),
    error: (...args) => sink.push(args.map(describeArg).join(' ')),
  };
}

async function run(page) {
  print(`\n  ${page.label}`);

  const consoleErrors = [];
  captureConsole(consoleErrors);

  const handle = installDom(readFile(page.file), {
    url: page.url,
    readFile: (path) => readFile(path),
  });

  let threw = null;
  try {
    await import(page.module);
    await handle.drain();
  } catch (error) {
    threw = error;
  }

  ok(!threw, 'module runs without throwing', threw && (threw.message || String(threw)));

  const missingFiles = handle.errors.filter((entry) => entry.startsWith('fetch 404'));
  ok(missingFiles.length === 0, 'every file it requests exists', missingFiles.join('; '));

  const reported = [
    ...consoleErrors,
    ...handle.errors.filter((entry) => !entry.startsWith('fetch 404')),
  ];
  ok(reported.length === 0, 'reports no errors', reported.join(' | '));

  // A load failure renders a notice instead of the page, which would otherwise
  // look like a pass on every "rendered content" assertion below.
  const notice = handle.document.querySelector('.notice--warm');
  ok(!notice, 'no load-error notice on the page', notice && notice.textContent.trim().slice(0, 160));

  page.expect.forEach((id) => {
    const element = handle.document.getElementById(id);
    if (!element) {
      ok(false, `#${id} exists`, 'not found in the page');
      return;
    }
    const filled = element.textContent.trim().length > 0 || element.descendants().length > 0;
    ok(filled, `#${id} rendered content`);
  });

  (page.contains || []).forEach(([id, needle, description]) => {
    const element = handle.document.getElementById(id);
    const text = element ? element.textContent : '';
    ok(text.includes(needle), `#${id} shows ${description}`, `no '${needle}' in the rendered text`);
  });

  if (page.minSvg) {
    const count = handle.document.querySelectorAll('svg').length;
    ok(count >= page.minSvg, `drew ${page.minSvg}+ elevation profiles`, `found ${count}`);
  }

  // Interactions run last so a failure here cannot mask a rendering problem.
  if (page.interact) {
    await page.interact(handle.document);
    await handle.drain();
  }

  if (page.wantsMap) {
    ok(globalThis.L.record.maps > 0, 'created a map');
    ok(
      globalThis.L.record.polylines.length > 0,
      'drew the route',
      `${globalThis.L.record.polylines.length} polylines`
    );
    ok(
      globalThis.L.record.markers.length > 0,
      'placed markers',
      `${globalThis.L.record.markers.length} markers`
    );
  }

  return handle;
}

/* ------------------------------------------------------------------ */

const args = typeof arguments !== 'undefined' ? arguments : [];
const key = args[0] || null;
const page = PAGES[key];
if (!page) {
  print(`unknown page '${key}'. Known: ${Object.keys(PAGES).join(', ')}`);
  throw new Error('bad page key');
}

// `--dump <id>` prints what the page actually rendered, which is the quickest
// way to eyeball wording and numbers without a browser.
const dumpId = args[1] === '--dump' ? args[2] || page.expect[0] : null;

const handle = await run(page);

if (dumpId) {
  const element = handle.document.getElementById(dumpId);
  print(`\n----- #${dumpId} rendered text -----`);
  print(element ? element.textContent.replace(/\n{3,}/g, '\n\n') : '(element not found)');
}

print(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  throw new Error(`${page.label}: ${failures.length} check(s) failed`);
}
