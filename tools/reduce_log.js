/**
 * Apply an operation log to a data file, using the site's own reducer.
 *
 * Exists so that tools/squash_sync.py does not have to reimplement the rules in
 * assets/js/core/sync.js. Two implementations of "the later edit wins" would
 * eventually disagree, and the disagreement would look like data loss rather
 * than like a bug.
 *
 *   jsc -m tools/reduce_log.js -- base.json ops.json
 */

// Shimmed before the import, which is why the import is dynamic: sync.js clones
// through structuredClone, and the JavaScriptCore shell has no such global.
globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

const args = typeof arguments !== 'undefined' ? arguments : [];
if (args.length < 2) {
  throw new Error('usage: jsc -m tools/reduce_log.js -- base.json ops.json');
}

const sync = await import('../assets/js/core/sync.js');

const base = JSON.parse(readFile(args[0]));
const ops = JSON.parse(readFile(args[1]));

print(JSON.stringify(sync.reduce(base, Array.isArray(ops) ? ops : ops.ops || []), null, 2));
