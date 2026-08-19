/**
 * Shared edits without a server: a log of operations applied over the committed file.
 *
 * The committed JSON under data/ stays the starting point, but instead of asking
 * someone to paste a whole file into GitHub, an edit here becomes one small
 * operation — "upsert this item", "remove that one" — appended to a log that
 * everybody reads. The current state of a file is `reduce(committed, log)`.
 *
 * Operations rather than whole files, for one specific reason: two people saving
 * a whole file at the same time means the second write is rejected for a stale
 * revision, and whoever retries last silently erases the other's work. Two
 * operations on different records compose instead, so nobody has to coordinate.
 *
 * The log is appended through a Cloudflare Worker that holds the GitHub token as
 * a secret (see docs/sync-setup.md). Until an endpoint and passphrase are both
 * configured this module never touches the network: operations still queue in
 * localStorage and still show up locally, which is also exactly what happens
 * partway up a col with no signal.
 */

import * as store from './store.js';

const OUTBOX_KEY = 'tmb:outbox';
const LOG_PREFIX = 'tmb:synclog:';
const KEY_PREF = 'sync:key';
const ENDPOINT_PREF = 'sync:endpoint';

/**
 * Which collections the log may touch, as `file` (a key of store.FILES) to the
 * array properties within it.
 *
 * tools/sync-worker/worker.js carries the same table and rejects anything
 * outside it, so that a leaked passphrase cannot reach a file nobody meant to
 * expose. A test asserts the two copies agree.
 */
export const COLLECTIONS = {
  packing: ['items'],
};

// A single record is small by nature; anything larger is a bug or an attack, and
// rejecting it here keeps the log readable as a diff.
const MAX_VALUE_BYTES = 4096;
const MAX_OPS_PER_REQUEST = 50;
const REQUEST_TIMEOUT_MS = 8000;
// Publishing is held back briefly so that operations made together become one
// commit. This is about keeping the log readable and saving round trips, not
// about Pages: the log is committed to a branch Pages does not build, so a commit
// here costs no deploy. Deliberately short, because anything still inside the
// window when a tab closes waits for that person's next visit — which is also why
// leaving the page publishes on the way out.
const FLUSH_DELAY_MS = 2500;

const logs = new Map();
const listeners = new Set();

let outboxCache = null;
let flushTimer = null;
let state = { phase: 'off', message: '', lastSyncAt: null };

/* ------------------------------------------------------------------ */
/* operations                                                          */
/* ------------------------------------------------------------------ */

export function isAllowed(file, collection) {
  return Boolean(COLLECTIONS[file]?.includes(collection));
}

/** Whether a file is edited through the log rather than through store drafts. */
export function isSynced(file) {
  return Boolean(COLLECTIONS[file]);
}

/**
 * Why an operation is unacceptable, or null when it is fine. Kept as one
 * function so the queue, the reducer and the Worker all agree on what a valid
 * operation looks like.
 */
export function validate(op) {
  if (!op || typeof op !== 'object') return 'not an object';
  if (typeof op.id !== 'string' || !op.id) return 'missing id';
  if (typeof op.at !== 'string' || Number.isNaN(Date.parse(op.at))) return 'missing or bad at';
  if (op.op !== 'upsert' && op.op !== 'remove') return `unknown op '${op.op}'`;
  if (!isAllowed(op.file, op.collection)) {
    return `${op.file}.${op.collection} is not open to sync`;
  }
  if (typeof op.key !== 'string' || !op.key) return 'missing key';
  if (op.op === 'upsert') {
    if (!op.value || typeof op.value !== 'object' || Array.isArray(op.value)) {
      return 'upsert needs an object value';
    }
    if (op.value.id !== op.key) return 'value.id must match key';
    if (JSON.stringify(op.value).length > MAX_VALUE_BYTES) return 'value too large';
  }
  return null;
}

function makeOp(fields) {
  return {
    id: store.newId('op-'),
    at: new Date().toISOString(),
    by: store.pref('me', null),
    ...fields,
  };
}

/** Add or replace a record. Pass a value whose `id` is the record's key. */
export function upsert(file, collection, value) {
  return queue(makeOp({ file, collection, op: 'upsert', key: value.id, value }));
}

export function remove(file, collection, key) {
  return queue(makeOp({ file, collection, op: 'remove', key }));
}

/* ------------------------------------------------------------------ */
/* the reducer                                                         */
/* ------------------------------------------------------------------ */

/**
 * Apply operations to a committed file, oldest first.
 *
 * An upsert replaces the whole record rather than merging field by field. Two
 * people editing the same record at once therefore means the later save wins
 * outright — the right trade for a packing list, and small enough to reason
 * about, which per-field merging would not be.
 */
export function reduce(base, ops) {
  const next = structuredClone(base);

  [...ops].sort(compareOps).forEach((op) => {
    if (validate(op)) return;
    const collection = next[op.collection];
    if (!Array.isArray(collection)) return;

    const index = collection.findIndex((record) => record?.id === op.key);
    if (op.op === 'remove') {
      if (index >= 0) collection.splice(index, 1);
      return;
    }
    if (index >= 0) collection[index] = structuredClone(op.value);
    else collection.push(structuredClone(op.value));
  });

  return next;
}

// Ties are broken on id so that two operations recorded in the same millisecond
// land in the same order on every device, rather than depending on which one a
// particular client happened to receive first.
function compareOps(left, right) {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* outbox and cached log                                               */
/* ------------------------------------------------------------------ */

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn(`Ignoring unreadable ${key}`, error);
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error('Could not write to localStorage — it may be full', error);
  }
}

function allOutbox() {
  if (!outboxCache) outboxCache = readJson(OUTBOX_KEY, []);
  return outboxCache;
}

function saveOutbox(ops) {
  outboxCache = ops;
  writeJson(OUTBOX_KEY, ops);
}

/** Operations saved on this device that the group has not confirmed yet. */
export function pending(file) {
  return allOutbox().filter((op) => !file || op.file === file);
}

export function queue(op) {
  const problem = validate(op);
  if (problem) throw new Error(`Refusing to queue an invalid change: ${problem}`);
  saveOutbox([...allOutbox(), op]);
  notify();
  scheduleFlush(op.file);
  return op;
}

function scheduleFlush(file) {
  if (flushTimer) clearTimeout(flushTimer);
  // A full batch goes now rather than waiting, since the request would have to be
  // split anyway and holding it back only delays the rest.
  if (pending(file).length >= MAX_OPS_PER_REQUEST) {
    flushTimer = null;
    flush(file).catch(() => {});
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush(file).catch(() => {});
  }, FLUSH_DELAY_MS);
}

/** Throw away this device's unsent changes. */
export function discardPending(file) {
  saveOutbox(file ? allOutbox().filter((op) => op.file !== file) : []);
  notify();
}

/** Load the last log this device saw. Call before the first render. */
export function init(file) {
  if (!logs.has(file)) logs.set(file, readJson(LOG_PREFIX + file, []));
  if (state.phase === 'off' && isConfigured()) state = { ...state, phase: 'idle' };
  return logs.get(file);
}

export function log(file) {
  return logs.get(file) || [];
}

function setLog(file, ops) {
  logs.set(file, ops);
  writeJson(LOG_PREFIX + file, ops);
  // Anything the group has now confirmed no longer needs replaying from here.
  const confirmed = new Set(ops.map((op) => op.id));
  const rest = allOutbox().filter((op) => !confirmed.has(op.id));
  if (rest.length !== allOutbox().length) saveOutbox(rest);
}

/* ------------------------------------------------------------------ */
/* reading the current state                                           */
/* ------------------------------------------------------------------ */

/**
 * The file as the group currently has it, including this device's unsent edits
 * so that saving feels immediate with no signal.
 */
export function view(file) {
  return reduce(store.get(file), [...log(file), ...pending(file)]);
}

/**
 * Records present in the committed file that operations have since removed.
 * The page offers these back rather than losing a curated default for good.
 */
export function removedFrom(file, collection) {
  const current = new Set(
    (view(file)[collection] || []).map((record) => record.id)
  );
  return (store.get(file)[collection] || []).filter((record) => !current.has(record.id));
}

/* ------------------------------------------------------------------ */
/* the network half                                                    */
/* ------------------------------------------------------------------ */

export function endpoint() {
  const override = store.pref(ENDPOINT_PREF, null);
  if (override) return String(override).replace(/\/+$/, '');
  try {
    return String(store.get('settings').sync?.endpoint || '').replace(/\/+$/, '');
  } catch {
    // Reachable before settings has loaded; treated as unconfigured, which only
    // ever means "queue locally and try again later".
    return '';
  }
}

export function passphrase() {
  return store.pref(KEY_PREF, null);
}

export function isConfigured() {
  return Boolean(endpoint() && passphrase());
}

export function setPassphrase(value) {
  store.setPref(KEY_PREF, value ? String(value).trim() : null);
  state = { ...state, phase: isConfigured() ? 'idle' : 'off', message: '' };
  notify();
}

export function status() {
  return { ...state, pending: pending().length, configured: isConfigured() };
}

function offline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function request(path, options) {
  const url = `${endpoint()}${path}`;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('the sync service did not answer')), REQUEST_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      fetch(url, {
        ...options,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${passphrase()}`,
          ...(options?.headers || {}),
        },
      }),
      timeout,
    ]);
    if (response.status === 401) throw new Error('the group passphrase was not accepted');
    if (!response.ok) throw new Error(`the sync service returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the group's log for a file. Safe to call when unconfigured or offline. */
export async function pull(file) {
  if (!isConfigured() || offline()) return log(file);
  state = { ...state, phase: 'syncing', message: '' };
  notify();
  try {
    const body = await request(`/log?file=${encodeURIComponent(file)}`, { method: 'GET' });
    setLog(file, Array.isArray(body.log) ? body.log.filter((op) => !validate(op)) : []);
    state = { phase: 'idle', message: '', lastSyncAt: new Date().toISOString() };
  } catch (error) {
    state = { ...state, phase: 'error', message: error.message };
  }
  notify();
  return log(file);
}

/**
 * Send this device's queued operations. The response carries the whole log back,
 * so one round trip both publishes and catches up.
 */
export async function flush(file) {
  const queued = pending(file).slice(0, MAX_OPS_PER_REQUEST);
  if (!queued.length) return log(file);
  if (!isConfigured() || offline()) {
    state = {
      ...state,
      phase: isConfigured() ? 'waiting' : 'off',
      message: isConfigured() ? 'saved on this device; will publish when back online' : '',
    };
    notify();
    return log(file);
  }

  state = { ...state, phase: 'syncing', message: '' };
  notify();
  try {
    const body = await request('/ops', { method: 'POST', body: JSON.stringify({ ops: queued }) });
    setLog(file, Array.isArray(body.log) ? body.log.filter((op) => !validate(op)) : []);
    state = { phase: 'idle', message: '', lastSyncAt: new Date().toISOString() };
  } catch (error) {
    state = { ...state, phase: 'error', message: error.message };
  }
  notify();
  return log(file);
}

/* ------------------------------------------------------------------ */
/* catching up automatically                                           */
/* ------------------------------------------------------------------ */

/**
 * Publish anything queued and pick up anyone else's changes, for every file this
 * page has loaded.
 */
export function catchUp() {
  [...logs.keys()].forEach((file) => {
    flush(file)
      .then(() => (pending(file).length ? null : pull(file)))
      .catch(() => {});
  });
}

/**
 * Publish without waiting out the debounce, and without pulling — there is no
 * point reading the group's log for a page nobody is looking at.
 */
export function publishPending() {
  [...logs.keys()].forEach((file) => {
    if (pending(file).length) flush(file).catch(() => {});
  });
}

// Attached on import rather than left to each page to remember. Both handlers do
// nothing until a page has called init() and sync is configured, so this costs a
// page that never syncs two listeners and no requests.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', catchUp);
  // Coming back to a tab left open in a pocket is the usual way someone finds
  // out what the rest of the group changed while they were walking. Leaving is
  // the last chance to publish anything still inside the debounce window: a phone
  // going into a pocket is the common case and the request completes there, while
  // a genuine close still falls back to the outbox on the next visit.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') publishPending();
    else catchUp();
  });
}

/* ------------------------------------------------------------------ */
/* change notification                                                 */
/* ------------------------------------------------------------------ */

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('Sync listener failed', error);
    }
  });
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('tmb:sync'));
  }
}
