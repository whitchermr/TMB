/** Packing: one shared list for the group, ticked off separately by each of us. */

import * as store from '../core/store.js';
import * as sync from '../core/sync.js';
import { escapeHtml } from '../ui/map.js';
import { mountChrome, showLoadError, onRefresh } from '../ui/nav.js';

const FILE = 'packing';
const COLLECTION = 'items';

const state = { editing: null, filter: 'all', refocus: null, nameBlocked: false };

async function main() {
  mountChrome();
  await store.init(['settings', 'people', 'packing']);
  sync.init(FILE);

  wireControls();
  wireDialog();
  render();
  onRefresh(render);

  // Catching up with the group happens after the first paint, so a slow or
  // missing sync service delays nothing anyone is waiting to read.
  sync.pull(FILE).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* who is packing, and what they have packed                           */
/* ------------------------------------------------------------------ */

/**
 * Ticks are stored per person rather than per device, so that switching who is
 * packing on a shared tablet shows that person's progress instead of merging two
 * people's lists into one meaningless set.
 */
function packedKey() {
  return `packing:packed:${store.pref('me', null) || 'anon'}`;
}

function packedMap() {
  const value = store.pref(packedKey(), {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isPacked(id) {
  return packedMap()[id] === true;
}

function setPacked(id, packed) {
  const next = { ...packedMap() };
  if (packed) next[id] = true;
  else delete next[id];
  store.setPref(packedKey(), next);
}

/**
 * Ticks made before anyone is chosen are filed under 'anon', so without this a
 * person who ticked half the list and then picked their name would watch the lot
 * disappear. Their own ticks win over the anonymous ones, since those were the
 * deliberate ones.
 */
function adoptAnonymousTicks(personId) {
  const anon = store.pref('packing:packed:anon', null);
  if (!anon || typeof anon !== 'object' || !Object.keys(anon).length) return;
  const mine = store.pref(`packing:packed:${personId}`, {}) || {};
  store.setPref(`packing:packed:${personId}`, { ...anon, ...mine });
  store.setPref('packing:packed:anon', {});
}

/**
 * Shared edits are the only record of who changed what: every commit is authored
 * by whoever's token the sync service holds, so an unnamed device would publish
 * operations that nobody can trace back.
 */
function requireName() {
  if (store.pref('me', null)) return true;
  state.nameBlocked = true;
  render();
  const select = document.getElementById('packing-who');
  select.focus?.();
  select.scrollIntoView?.({ block: 'center' });
  return false;
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

/**
 * Listeners sit on the containers rather than on each row, because a tick
 * re-renders the whole list and there are enough rows that re-binding fifty
 * handlers on every tap would be felt on a phone.
 */
function wireControls() {
  document.getElementById('packing-who').addEventListener('change', (event) => {
    const chosen = event.target.value || null;
    state.nameBlocked = false;
    if (chosen) adoptAnonymousTicks(chosen);
    store.setPref('me', chosen);
  });

  document.getElementById('packing-filter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    render();
  });

  document.getElementById('add-item').addEventListener('click', () => {
    if (requireName()) openDialog(null);
  });

  const groups = document.getElementById('packing-groups');
  groups.addEventListener('change', (event) => {
    const box = event.target.closest('[data-packed-for]');
    if (!box) return;
    state.refocus = box.dataset.packedFor;
    setPacked(box.dataset.packedFor, box.checked);
  });
  groups.addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-item]');
    if (button && requireName()) openDialog(button.dataset.editItem);
  });

  document.getElementById('packing-removed').addEventListener('click', (event) => {
    const button = event.target.closest('[data-restore]');
    if (!button) return;
    if (!requireName()) return;
    const original = store
      .get(FILE)
      [COLLECTION].find((item) => item.id === button.dataset.restore);
    if (original) sync.upsert(FILE, COLLECTION, original);
  });

  document.getElementById('sync-panel').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sync]');
    if (!button) return;
    if (button.dataset.sync === 'connect') {
      const entered = window.prompt('Group passphrase for sharing changes');
      if (entered) sync.setPassphrase(entered);
    }
    if (button.dataset.sync === 'forget') sync.setPassphrase(null);
    if (button.dataset.sync === 'refresh') sync.pull(FILE).catch(() => {});
    if (button.dataset.sync === 'publish') sync.flush(FILE).catch(() => {});
  });
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  const file = sync.view(FILE);
  const items = Array.isArray(file[COLLECTION]) ? file[COLLECTION] : [];
  const categories = Array.isArray(file.categories) ? file.categories : [];

  renderWho();
  renderWhoHint();
  renderFilter();
  renderStats(items);
  renderSync();
  renderGroups(items, categories);
  renderRemoved();

  if (state.refocus) {
    document.querySelector(`[data-packed-for="${state.refocus}"]`)?.focus();
    state.refocus = null;
  }
}

function renderWho() {
  const select = document.getElementById('packing-who');
  const me = store.pref('me', null);
  select.innerHTML = `<option value="">— choose yourself —</option>${store
    .get('people')
    .people.map(
      (person) =>
        `<option value="${person.id}"${person.id === me ? ' selected' : ''}>${escapeHtml(
          person.name
        )}</option>`
    )
    .join('')}`;
  select.value = me || '';
}

function renderWhoHint() {
  const hint = document.getElementById('packing-who-hint');
  if (store.pref('me', null)) {
    hint.hidden = true;
    state.nameBlocked = false;
    return;
  }
  hint.hidden = false;
  hint.className = state.nameBlocked ? 'notice notice--warm' : 'notice';
  hint.innerHTML = state.nameBlocked
    ? '<strong>Choose yourself above first.</strong> Changes to the list are shared with the group and recorded against your name.'
    : '<strong>Choose yourself above before you start.</strong> Changes to the list are shared with the group and recorded against your name, and what you tick off is kept per person rather than per device.';
}

function renderFilter() {
  document.querySelectorAll('#packing-filter [data-filter]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
  });
}

function renderStats(items) {
  const packed = items.filter((item) => isPacked(item.id));
  const essentialsLeft = items.filter((item) => item.essential && !isPacked(item.id));
  const defaults = new Set(store.get(FILE)[COLLECTION].map((item) => item.id));
  const added = items.filter((item) => !defaults.has(item.id));

  document.getElementById('packing-stats').innerHTML = `
    ${stat('Packed', `${packed.length} of ${items.length}`, forWhom())}
    ${stat('Still to pack', String(items.length - packed.length))}
    ${stat(
      'Essentials left',
      String(essentialsLeft.length),
      essentialsLeft.length ? 'do these first' : 'all accounted for'
    )}
    ${stat('Added by the group', String(added.length), 'beyond the default list')}
  `;
}

function forWhom() {
  const me = store.pref('me', null);
  const person = store.get('people').people.find((entry) => entry.id === me);
  return person ? person.name : 'nobody chosen yet';
}

function stat(label, value, sub = '') {
  return `
    <div class="stat">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${escapeHtml(value)}</span>
      ${sub ? `<span class="stat__sub">${escapeHtml(sub)}</span>` : ''}
    </div>
  `;
}

function renderGroups(items, categories) {
  const shown = items.filter(matchesFilter);
  const buckets = categories
    .map((category) => ({
      category,
      rows: shown.filter((item) => item.category === category.id),
    }))
    .filter((bucket) => bucket.rows.length);

  // An operation can name a category that no longer exists in the committed
  // file, and silently dropping those items would look like data loss.
  const known = new Set(categories.map((category) => category.id));
  const orphans = shown.filter((item) => !known.has(item.category));
  if (orphans.length) {
    buckets.push({ category: { id: '', label: 'Uncategorised' }, rows: orphans });
  }

  const container = document.getElementById('packing-groups');
  if (!buckets.length) {
    container.innerHTML = `<p class="empty">${
      items.length ? 'Nothing matches that filter.' : 'The list is empty.'
    }</p>`;
    return;
  }

  container.innerHTML = buckets
    .map(
      ({ category, rows }) => `
        <section class="card">
          <div class="card__head">
            <h2>${escapeHtml(category.label)}</h2>
            <span class="chip">${rows.filter((item) => isPacked(item.id)).length}/${
              rows.length
            } packed</span>
          </div>
          <div class="card__body">
            ${sortRows(rows).map(renderItem).join('')}
          </div>
        </section>
      `
    )
    .join('');
}

function matchesFilter(item) {
  if (state.filter === 'left') return !isPacked(item.id);
  if (state.filter === 'essential') return item.essential === true;
  return true;
}

// Essentials first, then alphabetically, so the things that matter are at the top
// of each category rather than wherever they happened to be added.
function sortRows(rows) {
  return [...rows].sort((left, right) => {
    if (Boolean(left.essential) !== Boolean(right.essential)) return left.essential ? -1 : 1;
    return String(left.name).localeCompare(String(right.name));
  });
}

function renderItem(item) {
  const packed = isPacked(item.id);
  return `
    <div class="pack-item" data-packed="${packed}">
      <label class="checkbox pack-item__tick">
        <input type="checkbox" data-packed-for="${escapeHtml(item.id)}"${
          packed ? ' checked' : ''
        } />
        <span class="sr-only">Packed: ${escapeHtml(item.name)}</span>
      </label>
      <div class="pack-item__body">
        <div class="pack-item__name">
          <span>${escapeHtml(item.name)}</span>
          ${item.essential ? '<span class="chip chip--warm">essential</span>' : ''}
        </div>
        ${item.note ? `<div class="wp__notes">${escapeHtml(item.note)}</div>` : ''}
      </div>
      <button class="btn btn--sm" type="button" data-edit-item="${escapeHtml(item.id)}">
        Edit
      </button>
    </div>
  `;
}

function renderRemoved() {
  const removed = sync.removedFrom(FILE, COLLECTION);
  const container = document.getElementById('packing-removed');
  if (!removed.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <details class="card">
      <summary class="card__head" style="cursor: pointer">
        <h2>Removed from the default list</h2>
        <span class="chip">${removed.length}</span>
      </summary>
      <div class="card__body">
        <p class="muted" style="margin-top: 0">
          Removing an item hides it for the group rather than deleting it, so
          anything taken off in haste can come back.
        </p>
        ${removed
          .map(
            (item) => `
              <div class="pack-item" data-packed="false">
                <div class="pack-item__body">
                  <div class="pack-item__name"><span>${escapeHtml(item.name)}</span></div>
                  ${item.note ? `<div class="wp__notes">${escapeHtml(item.note)}</div>` : ''}
                </div>
                <button class="btn btn--sm" type="button" data-restore="${escapeHtml(
                  item.id
                )}">Restore</button>
              </div>
            `
          )
          .join('')}
      </div>
    </details>
  `;
}

/* ------------------------------------------------------------------ */
/* sharing panel                                                       */
/* ------------------------------------------------------------------ */

const PHASE = {
  idle: ['chip--accent', 'in step with the group'],
  syncing: ['chip--info', 'syncing…'],
  waiting: ['chip--warm', 'waiting for a connection'],
  error: ['chip--danger', 'could not reach the group'],
  off: ['', 'this device only'],
};

function renderSync() {
  const status = sync.status();
  const waiting = status.pending
    ? `<span class="chip chip--warm">${status.pending} not published yet</span>`
    : '';

  if (!sync.endpoint()) {
    document.getElementById('sync-panel').innerHTML = `
      <div class="card__body">
        <p class="notice" style="margin: 0">
          <strong>Sharing is not switched on yet.</strong>
          Changes are kept on this device and stay visible here, but nobody else
          sees them until the sync service is configured. ${waiting}
        </p>
      </div>
    `;
    return;
  }

  if (!status.configured) {
    document.getElementById('sync-panel').innerHTML = `
      <div class="card__body row row--between">
        <div>
          <strong>Join the group list</strong> ${waiting}
          <p class="muted" style="margin: 0.2rem 0 0">
            One passphrase, shared with the group, lets this device publish changes.
          </p>
        </div>
        <button class="btn btn--primary" type="button" data-sync="connect">
          Enter passphrase
        </button>
      </div>
    `;
    return;
  }

  const [chipClass, label] = PHASE[status.phase] || PHASE.idle;
  document.getElementById('sync-panel').innerHTML = `
    <div class="card__body row row--between">
      <div class="row row--tight">
        <span class="chip ${chipClass}">${escapeHtml(label)}</span>
        ${waiting}
        ${
          status.phase === 'error' && status.message
            ? `<small class="faint">${escapeHtml(status.message)}</small>`
            : ''
        }
      </div>
      <div class="row row--tight">
        <button class="btn btn--sm" type="button" data-sync="forget">Sign out</button>
        <button class="btn btn--sm" type="button" data-sync="refresh">Refresh</button>
        ${
          status.pending
            ? '<button class="btn btn--sm btn--primary" type="button" data-sync="publish">Publish now</button>'
            : ''
        }
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* item dialog                                                         */
/* ------------------------------------------------------------------ */

function wireDialog() {
  const dialog = document.getElementById('item-dialog');

  document.getElementById('item-save').addEventListener('click', () => {
    const name = document.getElementById('item-name').value.trim();
    if (!name) {
      window.alert('An item needs a name.');
      return;
    }

    sync.upsert(FILE, COLLECTION, {
      id: state.editing || store.newId('pk-'),
      name,
      category: document.getElementById('item-category').value,
      essential: document.getElementById('item-essential').checked,
      note: document.getElementById('item-note').value.trim(),
    });

    dialog.close();
  });

  document.getElementById('item-delete').addEventListener('click', () => {
    if (!state.editing) return dialog.close();
    if (!window.confirm('Remove this from the list for everyone?')) return;
    sync.remove(FILE, COLLECTION, state.editing);
    dialog.close();
  });
}

function openDialog(itemId) {
  state.editing = itemId;
  const file = sync.view(FILE);
  const item = itemId ? file[COLLECTION].find((entry) => entry.id === itemId) : null;

  document.getElementById('item-category').innerHTML = file.categories
    .map(
      (category) =>
        `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`
    )
    .join('');

  document.getElementById('item-title').textContent = item ? 'Edit item' : 'New item';
  document.getElementById('item-delete').hidden = !item;
  document.getElementById('item-name').value = item?.name || '';
  document.getElementById('item-category').value =
    item?.category || file.categories[0]?.id || '';
  document.getElementById('item-note').value = item?.note || '';
  document.getElementById('item-essential').checked = item?.essential === true;

  document.getElementById('item-dialog').showModal();
}

main().catch(showLoadError);
