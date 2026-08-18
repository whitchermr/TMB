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
    expect: ['day-title', 'day-stats', 'segments'],
    wantsMap: true,
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
    contains: [['stops', 'Contamines', 'a lodging stop']],
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
  print: {
    label: 'print.html',
    file: 'print.html',
    module: '../../assets/js/pages/print.js',
    url: 'https://example.test/print.html',
    expect: ['brief', 'brief-foot'],
    contains: [
      ['brief', 'Day 1', 'a numbered hiking day'],
      ['brief', 'Day 7', 'the last hiking day'],
      ['brief', 'Scenery and photo stops', 'the scenery section'],
      ['brief', 'Tonight', 'the lodging block'],
    ],
    // One elevation profile per hiking day, drawn as inline SVG.
    minSvg: 7,
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
