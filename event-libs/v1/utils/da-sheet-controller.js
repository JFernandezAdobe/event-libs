// Generic DA admin-API sheet CRUD, shared by every DA app that stores a config library
// as a single sheet (tier-1-event-configurator, session-guide-configurator, ...) —
// extracted 2026-07-30 rather than left as a third independently-drifting copy.
// App-specific concerns (row key, upsert/delete semantics, schema migration) stay in
// each app's own scripts/da-controller.js, built on top of these primitives.

const DA_ADMIN_ORIGIN = 'https://admin.da.live';

let daToken = null;
let sdkDaFetch = null;

export function setDaToken(token) {
  daToken = token;
}

export function setDaFetch(fn) {
  sdkDaFetch = fn;
}

// Prefer the DA SDK's authenticated fetch when it has been provided; otherwise
// fall back to the global fetch (auth is then supplied via the Bearer token).
function doFetch(url, options) {
  return (sdkDaFetch || fetch)(url, options);
}

// admin.da.live sits behind a CDN that weakens ETags (W/"...") when it gzips a
// response. R2/S3 reject weak validators on a conditional write, so strip the
// W/ prefix to recover the strong ETag that If-Match compares against.
function normalizeEtag(etag) {
  if (!etag) return undefined;
  return etag.replace(/^W\//, '');
}

function getHeaders(method = 'GET', body = null) {
  const headers = new Headers();
  if (daToken) headers.append('Authorization', `Bearer ${daToken}`);
  if (body) headers.append('content-type', 'application/json');
  // no-store bypasses the browser cache — otherwise a cached GET can return a
  // stale ETag, so the very next conditional write's If-Match fails against
  // the CDN's actual current ETag and surfaces as a false-positive Conflict.
  return {
    method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
  };
}

async function daFetch(path, options = {}) {
  const url = `${DA_ADMIN_ORIGIN}${path}`;
  let resp;
  try {
    resp = await doFetch(url, options);
  } catch (err) {
    window.lana?.log(`DA fetch network error: ${err} — ${url}`);
    return { ok: false, status: 0, error: 'Network error' };
  }
  if (!resp.ok) {
    const error = await resp.text().catch(() => resp.statusText);
    window.lana?.log(`DA fetch error ${resp.status}: ${url} — ${error}`);
    return { ok: false, status: resp.status, error };
  }
  const etag = resp.headers.get('ETag');
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await resp.json();
    return { ok: true, status: resp.status, data, etag };
  }
  return { ok: true, status: resp.status, etag };
}

// A malformed config string (bad manual edit, truncated write) shouldn't take
// down the whole library load — log and default that one row to {} instead.
export function parseRowConfig(row, logPrefix) {
  if (typeof row.config !== 'string') return row.config ?? {};
  try {
    return JSON.parse(row.config);
  } catch (error) {
    window.lana?.log(`${logPrefix}: malformed config JSON for row, defaulting to {}. ${error}`);
    return {};
  }
}

// Reads a sheet and returns its rows plus the ETag, so callers can perform
// conditional (optimistic-locking) writes with writeSheet. Rows are returned raw
// (caller decides how to parse/validate `config` and which key identifies a row).
export async function readSheet(org, repo, path) {
  const result = await daFetch(`/source/${org}/${repo}${path}`, getHeaders('GET'));
  if (!result.ok) return result;
  // Admin API always returns { ":type":"sheet", "data":[...objects] } for .json sheet files
  const rows = result.data?.data ?? [];
  return { ok: true, data: rows, etag: result.etag };
}

// Writes the full sheet. { etag } → If-Match (write only if unchanged);
// { create: true } → If-None-Match: * (only if the sheet doesn't exist yet);
// neither → unconditional. A precondition failure returns status:412 so
// callers can re-read and retry instead of clobbering a concurrent write.
export async function writeSheet(org, repo, path, rows, { etag, create } = {}) {
  const serialized = rows.map((row) => ({
    ...row,
    config: typeof row.config === 'string' ? row.config : JSON.stringify(row.config ?? {}),
  }));

  // DA admin API accepts the same object format it returns on GET
  const payload = JSON.stringify({
    ':type': 'sheet',
    ':sheetname': 'data',
    total: serialized.length,
    limit: serialized.length,
    offset: 0,
    data: serialized,
  });

  const url = `${DA_ADMIN_ORIGIN}/source/${org}/${repo}${path}`;
  const formData = new FormData();
  formData.append('data', new Blob([payload], { type: 'application/json' }), 'blob');

  const headers = new Headers();
  if (daToken) headers.append('Authorization', `Bearer ${daToken}`);
  if (etag) headers.append('If-Match', etag);
  else if (create) headers.append('If-None-Match', '*');

  let resp;
  try {
    resp = await doFetch(url, { method: 'POST', headers, body: formData });
  } catch (err) {
    window.lana?.log(`DA writeSheet network error: ${err} — ${url}`);
    return { ok: false, status: 0, error: 'Network error' };
  }
  if (resp.status === 412) {
    return { ok: false, status: 412, conflict: true, error: 'Sheet changed concurrently' };
  }
  if (!resp.ok) {
    const error = await resp.text().catch(() => resp.statusText);
    return { ok: false, status: resp.status, error };
  }
  return { ok: true, status: resp.status, etag: resp.headers.get('ETag') };
}

const MAX_WRITE_RETRIES = 4;
const CONFLICT_ERROR = 'Conflict: the config library sheet was changed by someone else. Please retry.';

// Optimistic-locking read-modify-write: reads the sheet + ETag, applies
// mutate(rows), writes conditionally, and retries on a 412 conflict.
// mutate(rows) returns { rows, result, skip? } — skip avoids a needless write.
export async function mutateSheet(org, repo, path, mutate) {
  for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const read = await readSheet(org, repo, path);
    if (!read.ok && read.status !== 404) return read;
    const rows = read.ok ? (read.data || []) : [];
    // Existing sheet → If-Match its etag (or unconditional if etag unavailable).
    // Missing sheet (404) → If-None-Match:* to guard concurrent first creation.
    const opts = read.ok ? { etag: normalizeEtag(read.etag) } : { create: true };
    const { rows: newRows, result, skip } = mutate(rows);
    if (skip) return { ok: true, data: result, skipped: true };
    // eslint-disable-next-line no-await-in-loop
    const write = await writeSheet(org, repo, path, newRows, opts);
    if (write.ok) return { ok: true, data: result };
    if (write.status !== 412) return write;
  }
  return { ok: false, status: 412, error: CONFLICT_ERROR };
}
