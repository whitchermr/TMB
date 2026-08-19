/**
 * Shared header, unit toggle and unsaved-changes dialog.
 *
 * Every page calls mountChrome() so the navigation exists in exactly one place
 * rather than being copy-pasted across six HTML files.
 */

import * as store from '../core/store.js';
import * as units from '../core/units.js';
import { register as registerOffline } from './offline.js';

const PAGES = [
  { href: 'index.html', label: 'Route' },
  { href: 'day.html', label: 'Days' },
  { href: 'plan.html', label: 'Planner' },
  { href: 'stays.html', label: 'Stays' },
  { href: 'money.html', label: 'Money' },
  { href: 'packing.html', label: 'Packing' },
  { href: 'transit.html', label: 'Transit' },
  { href: 'print.html', label: 'Brief' },
  { href: 'about.html', label: 'About' },
];

const FILE_LABELS = {
  settings: 'Trip settings',
  itinerary: 'Itinerary',
  waypoints: 'Scenery waypoints',
  people: 'People',
  stays: 'Lodging',
  expenses: 'Expenses',
  rates: 'Exchange rates',
  packing: 'Packing list',
  transit: 'Transit and logistics',
};

function currentPage() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  return path === '' ? 'index.html' : path;
}

export function mountChrome() {
  const header = document.createElement('header');
  header.className = 'app-header';

  const page = currentPage();
  header.innerHTML = `
    <div class="app-header__bar">
      <a class="app-header__brand" href="index.html">
        TMB <span>Tour du Mont Blanc</span>
      </a>
      <nav class="app-nav" aria-label="Sections">
        ${PAGES.map(
          (item) =>
            `<a href="${item.href}"${
              item.href === page ? ' aria-current="page"' : ''
            }>${item.label}</a>`
        ).join('')}
      </nav>
      <span class="app-header__spacer"></span>
      <button class="dirty-badge" id="dirty-badge" type="button" title="Review unsaved changes">
        <span class="dirty-badge__dot"></span><span id="dirty-count">0</span>
      </button>
      <div class="btn-group" role="group" aria-label="Units">
        <button type="button" data-units="metric">km</button>
        <button type="button" data-units="imperial">mi</button>
      </div>
    </div>
  `;
  document.body.prepend(header);

  const unitButtons = [...header.querySelectorAll('[data-units]')];
  const syncUnits = () => {
    unitButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.units === units.current()));
    });
  };
  unitButtons.forEach((button) => {
    button.addEventListener('click', () => {
      units.set(button.dataset.units);
      syncUnits();
      document.dispatchEvent(new CustomEvent('tmb:units'));
    });
  });
  syncUnits();

  const badge = header.querySelector('#dirty-badge');
  const count = header.querySelector('#dirty-count');
  const syncDirty = () => {
    const files = store.dirtyFiles();
    badge.dataset.active = String(files.length > 0);
    count.textContent = `${files.length} unsaved`;
  };
  badge.addEventListener('click', openChangesDialog);
  store.subscribe(syncDirty);
  syncDirty();

  mountFooter();

  // Caching the app shell is worth doing on every visit, so that whichever page
  // someone happened to open last is the one that works in a valley with no
  // signal. Failure is silent because it is an enhancement, not a requirement.
  registerOffline();
}

function mountFooter() {
  const footer = document.createElement('footer');
  footer.className = 'app-footer';
  footer.innerHTML = `
    Trail data © OpenStreetMap contributors (ODbL). Elevation from IGN,
    swisstopo and OpenTopoData. <a href="about.html">Sources and attribution</a>
    · <a href="about.html#offline">Offline maps</a>
    · <a href="print.html">Printable brief</a>.
  `;
  document.body.append(footer);
}

/* ------------------------------------------------------------------ */
/* changes dialog                                                     */
/* ------------------------------------------------------------------ */

let dialog;

function ensureDialog() {
  if (dialog) return dialog;

  dialog = document.createElement('dialog');
  dialog.id = 'changes-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="dialog__head">
      <h2>Unsaved changes</h2>
      <button class="btn btn--sm" value="close">Close</button>
    </form>
    <div class="dialog__body">
      <p class="muted">
        Edits live in this browser only. To share them with the group, copy the
        file below and commit it over the matching file in the repository.
      </p>
      <div class="field">
        <label for="changes-file">File</label>
        <select id="changes-file"></select>
      </div>
      <p class="mono faint" id="changes-path" style="margin:.4rem 0"></p>
      <textarea class="code-block" id="changes-json" spellcheck="false" readonly></textarea>
    </div>
    <div class="dialog__foot">
      <button class="btn btn--danger" type="button" id="changes-revert">Discard this file</button>
      <button class="btn" type="button" id="changes-import">Import…</button>
      <button class="btn" type="button" id="changes-download">Download</button>
      <button class="btn btn--primary" type="button" id="changes-copy">Copy JSON</button>
    </div>
  `;
  document.body.append(dialog);

  const select = dialog.querySelector('#changes-file');
  const output = dialog.querySelector('#changes-json');
  const pathLabel = dialog.querySelector('#changes-path');

  const render = () => {
    const name = select.value;
    if (!name) return;
    output.value = store.exportJson(name);
    pathLabel.textContent = store.pathFor(name);
  };

  select.addEventListener('change', render);

  dialog.querySelector('#changes-copy').addEventListener('click', async (event) => {
    const ok = await store.copyToClipboard(select.value);
    const button = event.currentTarget;
    button.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => {
      button.textContent = 'Copy JSON';
    }, 1600);
  });

  dialog.querySelector('#changes-download').addEventListener('click', () => {
    store.download(select.value);
  });

  dialog.querySelector('#changes-revert').addEventListener('click', () => {
    const name = select.value;
    if (!window.confirm(`Discard local edits to ${FILE_LABELS[name] || name}?`)) return;
    store.revert(name);
    dialog.close();
    window.location.reload();
  });

  dialog.querySelector('#changes-import').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          store.importJson(select.value, String(reader.result));
          window.location.reload();
        } catch (error) {
          window.alert(`That file could not be read as JSON.\n\n${error.message}`);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  });

  dialog.addEventListener('tmb:refresh', () => {
    const dirty = store.dirtyFiles();
    const names = dirty.length ? dirty : Object.keys(store.FILES);
    select.innerHTML = names
      .map(
        (name) =>
          `<option value="${name}">${FILE_LABELS[name] || name}${
            store.isDirty(name) ? ' — edited' : ''
          }</option>`
      )
      .join('');
    render();
  });

  return dialog;
}

export function openChangesDialog(preferredFile) {
  const element = ensureDialog();
  element.dispatchEvent(new CustomEvent('tmb:refresh'));
  if (preferredFile) {
    const select = element.querySelector('#changes-file');
    if ([...select.options].some((option) => option.value === preferredFile)) {
      select.value = preferredFile;
      select.dispatchEvent(new Event('change'));
    }
  }
  element.showModal();
}

/** Convenience for pages: show a fatal load error instead of a blank screen. */
export function showLoadError(error) {
  const main = document.querySelector('.app-main') || document.body;
  const box = document.createElement('div');
  box.className = 'notice notice--warm';
  box.innerHTML = `
    <strong>Could not load trip data.</strong>
    <p style="margin:.4rem 0 0">${String(error.message || error)}</p>
    <p style="margin:.4rem 0 0" class="faint">
      If you opened this file directly, serve the folder over http instead —
      browsers block <code>fetch</code> on <code>file://</code> URLs.
      Run <code class="mono">python3 -m http.server 8000</code> in the project
      folder and open <code class="mono">http://localhost:8000</code>.
    </p>
  `;
  main.prepend(box);
  console.error(error);
}

/** Re-render a page when units change, the store updates, or shared edits land. */
export function onRefresh(handler) {
  document.addEventListener('tmb:units', handler);
  document.addEventListener('tmb:sync', handler);
  store.subscribe(handler);
}
