/**
 * Historic landmarks: the writeup, its caveats, and where to read more.
 *
 * The text has to work with no signal, so a panel renders the whole story rather
 * than a teaser plus a link. Sources are listed for afterwards; nothing in the
 * prose depends on following one.
 *
 * Eras are rendered in the order the file gives them, which a test asserts is
 * chronological. Sorting here instead would hide an authoring mistake rather than
 * surface it.
 */

import * as store from '../core/store.js';
import { escapeHtml } from './map.js';

let byWaypoint = null;

/** Load history.json once and index it by waypoint. Safe to call repeatedly. */
export async function load() {
  if (byWaypoint) return byWaypoint;
  try {
    const file = await store.loadRouteFile('history');
    byWaypoint = new Map(file.entries.map((entry) => [entry.waypointId, entry]));
  } catch (error) {
    // Losing the history should cost the pages their landmark panels and nothing
    // else, the same way a missing photo file only costs the illustrations.
    console.warn('Landmark history unavailable', error);
    byWaypoint = new Map();
  }
  return byWaypoint;
}

export function forWaypoint(id) {
  return byWaypoint?.get(id) ?? null;
}

export function count() {
  return byWaypoint?.size ?? 0;
}

/* ------------------------------------------------------------------ */
/* icons                                                               */
/* ------------------------------------------------------------------ */

// Inline rather than a sprite or a font: there is no build step, and an icon that
// arrives over the network is an icon that is missing on the trail. Both are on a
// 16-unit grid and inherit the surrounding colour so a chip can tint them.
const ICONS = {
  photographic:
    '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.2l.9-1.4A1 1 0 0 1 6.4 2h3.2a1 1 0 0 1 .8.6L11.3 4h1.2A1.5 1.5 0 0 1 14 5.5v7A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5z"/><circle cx="8" cy="8.8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  // A classical column reads as "old" at 16 px in a way that a building or a
  // scroll does not.
  historic:
    '<path d="M1.5 3h13v1.8h-13zM1 13.2h14V15H1zM3.4 5.6h2.1v6.8H3.4zM6.95 5.6h2.1v6.8h-2.1zM10.5 5.6h2.1v6.8h-2.1z"/>',
};

/** Inline SVG for a role, sized to sit on a line of text. */
export function icon(role, { className = 'role-icon' } = {}) {
  const path = ICONS[role];
  if (!path) return '';
  return `<svg class="${className}" viewBox="0 0 16 16" width="13" height="13"
    aria-hidden="true" focusable="false" fill="currentColor">${path}</svg>`;
}

/* ------------------------------------------------------------------ */
/* disclosure state                                                    */
/* ------------------------------------------------------------------ */

// Which writeups the reader has opened. Held here rather than in the DOM because
// both pages rebuild their list wholesale — the planner on the pace control, the
// day page on a variant or unit change — and a writeup someone is halfway through
// must not snap shut because an unrelated number moved.
const opened = new Set();

/**
 * Attach the open/closed bookkeeping to freshly rendered markup.
 *
 * Call after every innerHTML assignment that included body(). The toggle event
 * does not bubble, so this listens on each panel rather than delegating.
 */
export function wire(root) {
  root?.querySelectorAll('.history__more').forEach((panel) => {
    panel.addEventListener('toggle', () => {
      const id = panel.dataset.history;
      if (!id) return;
      if (panel.open) opened.add(id);
      else opened.delete(id);
    });
  });
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function sourceList(sources) {
  if (!sources?.length) return '';
  return `
    <div class="history__sources">
      <span class="history__sources-label">Sources</span>
      <ol>
        ${sources
          .map(
            (source) => `
              <li>
                <a href="${escapeHtml(source.url)}" rel="noopener noreferrer" target="_blank">
                  ${escapeHtml(source.title)}</a>
                <span class="faint">${escapeHtml(source.publisher)}</span>
              </li>`
          )
          .join('')}
      </ol>
    </div>
  `;
}

/**
 * The body of a landmark writeup: the summary, then the chronology behind a
 * disclosure.
 *
 * The summary stays visible because it is the part that says why the place is
 * worth looking at, and because text inside a closed <details> is invisible to
 * the browser's own find-in-page. Everything else collapses: seven landmarks of
 * full chronology is several screens of prose sitting between the arrival times
 * the surrounding list exists to show.
 *
 * Returns '' for a waypoint with no entry so callers can concatenate without
 * checking first.
 */
export function body(entry) {
  if (!entry) return '';

  const eras = entry.eras?.length
    ? `<ol class="history__eras">
        ${entry.eras
          .map(
            (era) => `
              <li>
                <span class="history__year">${escapeHtml(era.year)}</span>
                ${era.label ? `<span class="history__label">${escapeHtml(era.label)}</span>` : ''}
                <p>${escapeHtml(era.text)}</p>
              </li>`
          )
          .join('')}
      </ol>`
    : '';

  const caveat = entry.caveat
    ? `<p class="history__caveat"><strong>Worth knowing:</strong> ${escapeHtml(entry.caveat)}</p>`
    : '';

  const detail = `${eras}${caveat}${sourceList(entry.sources)}`;
  const summary = entry.summary
    ? `<p class="history__summary">${escapeHtml(entry.summary)}</p>`
    : '';

  // Nothing to hide: a bare disclosure that opens onto an empty panel is worse
  // than no disclosure.
  if (!detail) return summary ? `<div class="history">${summary}</div>` : '';

  const count = entry.eras?.length || 0;
  return `
    <div class="history">
      ${summary}
      <details class="history__more" data-history="${escapeHtml(entry.waypointId)}"${
        opened.has(entry.waypointId) ? ' open' : ''
      }>
        <summary class="history__more-toggle">
          <span>Read the history</span>
          ${count ? `<span class="history__more-count">${count} era${count === 1 ? '' : 's'}</span>` : ''}
        </summary>
        ${detail}
      </details>
    </div>
  `;
}
