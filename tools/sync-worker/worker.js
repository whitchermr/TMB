/*
 * Cloudflare Worker: the only thing in this system allowed to write to GitHub.
 *
 * The site is static, so a browser cannot commit to the repository. Putting a
 * GitHub token in each browser would work and is what most people do, but it
 * means a repository-write credential sitting in localStorage on six phones,
 * shared over a group chat, rotated never. Instead the token lives here as an
 * encrypted secret and the group shares a passphrase, which is useless anywhere
 * except this endpoint and can be changed in one place.
 *
 * Deliberately schema-ignorant. It authenticates, checks that each operation is
 * shaped correctly and aimed at a collection on the allow-list, and appends. It
 * knows nothing about packing lists, so it should not need editing as the same
 * pattern spreads to the other pages.
 *
 * Two routes:
 *   GET  /log?file=packing   -> { log: [...] }
 *   POST /ops   { ops: [...] } -> { log: [...] }   (appends, then returns all)
 *
 * The log is committed to a branch that GitHub Pages does not publish, because
 * every push to the published branch triggers a rebuild and Pages starts
 * throttling around ten of those an hour. Reads come back through here instead
 * of waiting for a deploy, so a saved change is visible to everyone in about a
 * second.
 *
 * Secrets and variables to set (see docs/sync-setup.md):
 *   GITHUB_TOKEN      secret   fine-grained token, Contents read/write, this repo only
 *   SYNC_PASSPHRASE   secret   what the group types into the site once per device
 *   GITHUB_REPO       var      e.g. whitchermr/TMB
 *   ALLOWED_ORIGIN    var      comma-separated, e.g. https://whitchermr.github.io
 *   SYNC_BRANCH       var      optional, defaults to "sync"
 */

/**
 * Which collections may be written, as file to array properties.
 * Must match COLLECTIONS in assets/js/core/sync.js — a test asserts they agree,
 * because a mismatch here is a silently rejected save.
 */
const COLLECTIONS = {
  packing: ['items'],
};

const MAX_VALUE_BYTES = 4096;
const MAX_OPS_PER_REQUEST = 50;
const MAX_BODY_BYTES = 65536;
// Past this the log wants squashing into the committed file (tools/squash_sync.py).
// Refusing rather than growing without limit keeps one bad loop from filling the
// repository, and the message says what to do about it.
const MAX_LOG_OPS = 5000;
const WRITE_ATTEMPTS = 4;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (!(await authorised(request, env))) return fail(401, 'passphrase not accepted', cors);

      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/log') {
        return await handleRead(url, env, cors);
      }
      if (request.method === 'POST' && url.pathname === '/ops') {
        return await handleAppend(request, env, cors);
      }
      return fail(404, 'no such route', cors);
    } catch (error) {
      return fail(500, error.message || 'unexpected failure', cors);
    }
  },
};

/* ------------------------------------------------------------------ */
/* routes                                                             */
/* ------------------------------------------------------------------ */

async function handleRead(url, env, cors) {
  const file = url.searchParams.get('file') || '';
  if (!COLLECTIONS[file]) return fail(400, `'${file}' is not open to sync`, cors);
  const { ops } = await readLog(file, env);
  return json({ log: ops }, cors);
}

async function handleAppend(request, env, cors) {
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return fail(413, 'that request is too large', cors);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail(400, 'body was not JSON', cors);
  }

  const incoming = Array.isArray(parsed.ops) ? parsed.ops : [];
  if (!incoming.length) return fail(400, 'no operations to append', cors);
  if (incoming.length > MAX_OPS_PER_REQUEST) {
    return fail(413, `no more than ${MAX_OPS_PER_REQUEST} operations at a time`, cors);
  }

  // Every operation in one request must target one file, because one request
  // becomes one commit to one log.
  const file = incoming[0].file;
  for (const op of incoming) {
    const problem = validate(op);
    if (problem) return fail(400, `rejected an operation: ${problem}`, cors);
    if (op.file !== file) return fail(400, 'mixed files in one request', cors);
  }

  // Read, append, write — retried, because another member of the group may have
  // committed between the read and the write, which GitHub reports as a stale
  // revision rather than silently overwriting.
  let lastConflict = null;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const { ops, sha } = await readLog(file, env);
    if (ops.length + incoming.length > MAX_LOG_OPS) {
      return fail(507, 'the log is full; run tools/squash_sync.py to fold it in', cors);
    }

    // Skip anything already present, so a client retrying after a timeout that
    // actually succeeded does not double-apply.
    const seen = new Set(ops.map((op) => op.id));
    const fresh = incoming.filter((op) => !seen.has(op.id));
    if (!fresh.length) return json({ log: ops }, cors);

    const next = [...ops, ...fresh];
    const result = await writeLog(file, next, sha, env, describe(fresh));
    if (result.ok) return json({ log: next }, cors);
    if (!result.conflict) return fail(502, `GitHub refused the write: ${result.detail}`, cors);
    lastConflict = result.detail;
  }

  return fail(409, `could not append after ${WRITE_ATTEMPTS} attempts: ${lastConflict}`, cors);
}

function describe(ops) {
  const who = [...new Set(ops.map((op) => op.by).filter(Boolean))].join(', ');
  const what =
    ops.length === 1
      ? `${ops[0].op} ${ops[0].collection}/${ops[0].key}`
      : `${ops.length} changes`;
  return `Sync: ${what}${who ? ` (${who})` : ''}`;
}

/* ------------------------------------------------------------------ */
/* validation — mirrors validate() in assets/js/core/sync.js           */
/* ------------------------------------------------------------------ */

function validate(op) {
  if (!op || typeof op !== 'object') return 'not an object';
  if (typeof op.id !== 'string' || !op.id) return 'missing id';
  if (typeof op.at !== 'string' || Number.isNaN(Date.parse(op.at))) return 'missing or bad at';
  if (op.op !== 'upsert' && op.op !== 'remove') return `unknown op '${op.op}'`;
  if (!COLLECTIONS[op.file]?.includes(op.collection)) {
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

/* ------------------------------------------------------------------ */
/* GitHub                                                             */
/* ------------------------------------------------------------------ */

function logPath(file) {
  return `data/sync/${file}.log.json`;
}

function branch(env) {
  return env.SYNC_BRANCH || 'sync';
}

function api(env, path) {
  return `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
}

function githubHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    // GitHub rejects API requests without one.
    'user-agent': 'tmb-sync-worker',
  };
}

async function readLog(file, env) {
  const url = `${api(env, logPath(file))}?ref=${encodeURIComponent(branch(env))}`;
  const response = await fetch(url, { headers: githubHeaders(env) });

  // No log yet is the normal state before the first save, not an error.
  if (response.status === 404) return { ops: [], sha: null };
  if (!response.ok) throw new Error(`could not read the log (HTTP ${response.status})`);

  const body = await response.json();
  let ops = [];
  try {
    const parsed = JSON.parse(fromBase64(body.content || ''));
    ops = Array.isArray(parsed) ? parsed : Array.isArray(parsed.ops) ? parsed.ops : [];
  } catch {
    // A corrupt log would otherwise block every future save. Starting clean loses
    // less than that, and git history still holds whatever was there.
    ops = [];
  }
  return { ops: ops.filter((op) => !validate(op)), sha: body.sha || null };
}

async function writeLog(file, ops, sha, env, message) {
  const response = await fetch(api(env, logPath(file)), {
    method: 'PUT',
    headers: { ...githubHeaders(env), 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64(`${JSON.stringify(ops, null, 2)}\n`),
      branch: branch(env),
      ...(sha ? { sha } : {}),
    }),
  });

  if (response.ok) return { ok: true };
  const detail = (await response.text()).slice(0, 200);
  // 409 is an explicit conflict; 422 is what GitHub returns for a stale sha.
  return { ok: false, conflict: response.status === 409 || response.status === 422, detail };
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

async function authorised(request, env) {
  const header = request.headers.get('Authorization') || '';
  const offered = header.replace(/^Bearer\s+/i, '');
  if (!env.SYNC_PASSPHRASE || !offered) return false;
  // Compared as digests so the check takes the same time whatever was sent,
  // rather than returning early on the first wrong character.
  const [a, b] = await Promise.all([digest(offered), digest(env.SYNC_PASSPHRASE)]);
  return a === b;
}

async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    // Deliberately short. A browser that caches a refused preflight keeps
    // refusing for this long after ALLOWED_ORIGIN is corrected, and a day of
    // that looks exactly like a broken deployment.
    'access-control-max-age': '600',
    vary: 'Origin',
  };
  if (allowed.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function json(body, cors) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function fail(status, message, cors) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(encoded) {
  const binary = atob(String(encoded).replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
