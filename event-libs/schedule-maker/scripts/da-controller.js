import { DA_ADMIN_ORIGIN } from '../constants.js';

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

// How many document fetches to run at once when scanning. The per-doc source
// fetch is the sync bottleneck, so a bounded pool is far faster than a
// sequential loop while staying polite to the admin API. Raise cautiously and
// watch for 429s / a latency plateau — fetchText retries throttled requests so
// higher values degrade to backoff rather than dropped docs.
const SCAN_CONCURRENCY = 50;

const MAX_FETCH_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Backoff before the next retry: honor a Retry-After header when present,
// otherwise exponential (0.3s, 0.6s, 1.2s, …) capped at 4s.
function retryDelay(attempt, retryAfter) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  return Math.min(2 ** attempt * 300, 4000);
}

// Runs `fn` over items with at most `limit` in flight at a time, preserving the
// input order in the returned results array.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await fn(items[i], i);
    }
  };
  const size = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}

function getHeaders(method = 'GET', body = null) {
  const headers = new Headers();
  if (daToken) headers.append('Authorization', `Bearer ${daToken}`);
  if (body) headers.append('content-type', 'application/json');
  return { method, headers, body: body ? JSON.stringify(body) : undefined };
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

export async function listEventFolders(org, repo) {
  const result = await daFetch(`/list/${org}/${repo}`, getHeaders('GET'));
  if (!result.ok) return result;
  const folders = (result.data || []).filter((item) => !item.ext);
  return { ok: true, data: folders };
}

export async function listFolder(org, repo, path) {
  const result = await daFetch(`/list/${org}/${repo}${path}`, getHeaders('GET'));
  if (!result.ok) return result;
  const items = (result.data || []).sort((a, b) => {
    if (!a.ext && b.ext) return -1;
    if (a.ext && !b.ext) return 1;
    return a.path.localeCompare(b.path);
  });
  return { ok: true, data: items };
}

// Reads a sheet and returns its rows plus the ETag, so callers can perform
// conditional (optimistic-locking) writes with writeSheet.
async function readSheet(org, repo, path) {
  const result = await daFetch(`/source/${org}/${repo}${path}`, getHeaders('GET'));
  if (!result.ok) return result;
  // Admin API always returns { ":type":"sheet", "data":[...objects] } for .json sheet files
  const raw = result.data?.data ?? [];

  const rows = raw
    .filter((row) => row && row.scheduleId)
    .map((row) => ({
      ...row,
      blocks: typeof row.blocks === 'string' ? JSON.parse(row.blocks) : (row.blocks ?? []),
    }));
  return { ok: true, data: rows, etag: result.etag };
}

// Writes the full sheet. Concurrency control via conditional headers:
//   - { etag }          → If-Match: <etag>   (write only if unchanged since read)
//   - { create: true }  → If-None-Match: *   (write only if the sheet doesn't exist yet)
//   - neither           → unconditional      (last-write-wins; e.g. etag unavailable)
// `create` is ignored when an etag is given. A precondition failure returns
// { ok:false, status:412, conflict:true } so callers can re-read and retry
// rather than silently clobber a concurrent write.
async function writeSheet(org, repo, path, rows, { etag, create } = {}) {
  // eslint-disable-next-line no-unused-vars
  const serialized = rows.map(({ status, isComplete, ...row }) => ({
    ...row,
    blocks: typeof row.blocks === 'string' ? row.blocks : JSON.stringify(row.blocks ?? []),
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

  const url = `https://admin.da.live/source/${org}/${repo}${path}`;
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

// Reads a plain sheet (no schedule-specific row transforms) — used for the
// schedule→docs reverse index sheet.
async function readRawSheet(org, repo, path) {
  const result = await daFetch(`/source/${org}/${repo}${path}`, getHeaders('GET'));
  if (!result.ok) return result;
  return { ok: true, rows: result.data?.data ?? [], etag: result.etag };
}

// Writes a plain sheet as-is. The reverse index is derived state (rebuilt on
// every sync), so writes are unconditional — a concurrent sync writes the same
// derived rows, so last-write-wins is harmless here.
async function writeRawSheet(org, repo, path, rows) {
  const payload = JSON.stringify({
    ':type': 'sheet', ':sheetname': 'data', total: rows.length, limit: rows.length, offset: 0, data: rows,
  });
  const url = `${DA_ADMIN_ORIGIN}/source/${org}/${repo}${path}`;
  const formData = new FormData();
  formData.append('data', new Blob([payload], { type: 'application/json' }), 'blob');
  const headers = new Headers();
  if (daToken) headers.append('Authorization', `Bearer ${daToken}`);
  let resp;
  try {
    resp = await doFetch(url, { method: 'POST', headers, body: formData });
  } catch (err) {
    window.lana?.log(`DA writeRawSheet network error: ${err} — ${url}`);
    return { ok: false, status: 0 };
  }
  return { ok: resp.ok, status: resp.status };
}

const MAX_WRITE_RETRIES = 4;
const CONFLICT_ERROR = 'Conflict: the schedule sheet was changed by someone else. Please retry.';

// Optimistic-locking read-modify-write for a single sheet. Reads the sheet with
// its ETag, applies `mutate(rows)`, then writes conditionally. On a 412 conflict
// (a concurrent write landed in between) it re-reads and retries, so the mutation
// is always applied on top of the latest state instead of clobbering it.
//
// `mutate(rows)` must return { rows, result, skip? }. When skip is true the write
// is not performed (the schedule isn't in this sheet), avoiding a needless
// version bump.
async function mutateSheet(org, repo, path, mutate) {
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

export async function getSchedules(org, repo, eventFolder) {
  const basePath = eventFolder.startsWith('/') ? eventFolder : `/${eventFolder}`;
  const [activeResult, draftResult] = await Promise.all([
    readSheet(org, repo, `${basePath}/schedules-active.json`),
    readSheet(org, repo, `${basePath}/schedules-draft.json`),
  ]);

  const activeRows = activeResult.ok ? (activeResult.data || []) : [];
  const draftRows = draftResult.ok ? (draftResult.data || []) : [];

  const activeSchedules = activeRows.map((row) => ({ ...row, status: 'active' }));
  const draftSchedules = draftRows.map((row) => ({ ...row, status: 'draft' }));

  return { ok: true, data: [...activeSchedules, ...draftSchedules] };
}

export async function createSchedule(org, repo, eventFolder, schedule) {
  const newSchedule = {
    ...schedule,
    scheduleId: crypto.randomUUID(),
    createdTime: new Date().toISOString(),
    modificationTime: new Date().toISOString(),
  };

  const basePath = eventFolder.startsWith('/') ? eventFolder : `/${eventFolder}`;
  const path = `${basePath}/schedules-draft.json`;

  const result = await mutateSheet(org, repo, path, (rows) => ({
    rows: [newSchedule, ...rows],
    result: newSchedule,
  }));
  if (!result.ok) return result;
  return { ok: true, data: { ...newSchedule, status: 'draft' } };
}

export async function updateSchedule(org, repo, eventFolder, scheduleId, updates) {
  const basePath = eventFolder.startsWith('/') ? eventFolder : `/${eventFolder}`;
  const activePath = `${basePath}/schedules-active.json`;
  const draftPath = `${basePath}/schedules-draft.json`;
  const updatedSchedule = { ...updates, scheduleId, modificationTime: new Date().toISOString() };

  // Read both sheets to locate the schedule, then conditionally write the one
  // it lives in. If a concurrent sync moved/changed it (412), re-read and retry.
  for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [activeResult, draftResult] = await Promise.all([
      readSheet(org, repo, activePath),
      readSheet(org, repo, draftPath),
    ]);
    const activeRows = activeResult.ok ? (activeResult.data || []) : [];
    const draftRows = draftResult.ok ? (draftResult.data || []) : [];
    const activeIdx = activeRows.findIndex((r) => r.scheduleId === scheduleId);
    const draftIdx = draftRows.findIndex((r) => r.scheduleId === scheduleId);

    if (activeIdx !== -1) {
      activeRows[activeIdx] = { ...activeRows[activeIdx], ...updatedSchedule };
      // eslint-disable-next-line no-await-in-loop
      const write = await writeSheet(org, repo, activePath, activeRows, { etag: normalizeEtag(activeResult.etag) });
      if (write.ok) return { ok: true, data: { ...activeRows[activeIdx], status: 'active' } };
      if (write.status !== 412) return write;
    } else if (draftIdx !== -1) {
      draftRows[draftIdx] = { ...draftRows[draftIdx], ...updatedSchedule };
      // eslint-disable-next-line no-await-in-loop
      const write = await writeSheet(org, repo, draftPath, draftRows, { etag: normalizeEtag(draftResult.etag) });
      if (write.ok) return { ok: true, data: { ...draftRows[draftIdx], status: 'draft' } };
      if (write.status !== 412) return write;
    } else {
      return { ok: false, status: 404, error: 'Schedule not found' };
    }
  }
  return { ok: false, status: 412, error: CONFLICT_ERROR };
}

// Fetches a document's text with retry/backoff on throttling (429) and transient
// server errors (5xx / network). Returns:
//   { ok: true, text }  — success (text is '' for a 404, i.e. the doc is gone,
//                          which is safe to treat as "contains no schedules")
//   { ok: false }       — could not be read after retries; the caller must treat
//                          this as an error, NOT as an empty doc, so a throttled
//                          fetch never silently misclassifies a schedule.
async function fetchText(org, repo, path) {
  const url = `${DA_ADMIN_ORIGIN}/source/${org}/${repo}${path}`;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
    let resp;
    try {
      // eslint-disable-next-line no-await-in-loop
      resp = await doFetch(url, getHeaders('GET'));
    } catch {
      if (attempt < MAX_FETCH_ATTEMPTS - 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelay(attempt));
        continue;
      }
      return { ok: false };
    }
    if (resp.ok) return { ok: true, text: await resp.text(), etag: resp.headers.get('ETag') };
    if (resp.status === 404) return { ok: true, text: '' };
    if (resp.status === 429 || resp.status >= 500) {
      if (attempt < MAX_FETCH_ATTEMPTS - 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelay(attempt, resp.headers.get('Retry-After')));
        continue;
      }
      return { ok: false };
    }
    // Non-retriable (401/403/other 4xx) — surface as unreadable.
    return { ok: false };
  }
  return { ok: false };
}

async function listAllFiles(org, repo, path) {
  const result = await daFetch(`/list/${org}/${repo}${path}`, getHeaders('GET'));
  if (!result.ok) return [];
  const items = Array.isArray(result.data) ? result.data : [];
  const files = [];
  const folderFetches = [];
  items.forEach((item) => {
    const itemPath = item.path.replace(`/${org}/${repo}`, '');
    if (!item.ext) {
      folderFetches.push(listAllFiles(org, repo, itemPath));
    } else {
      files.push(itemPath);
    }
  });
  const nested = await Promise.all(folderFetches);
  return [...files, ...nested.flat()];
}

// One-pass sync: scans all HTML docs, updates active/draft for every known schedule,
// and discovers any new schedules embedded in docs but not yet in any sheet.
export async function syncSchedules(org, repo, eventFolder, scanPath = null) {
  const basePath = eventFolder.startsWith('/') ? eventFolder : `/${eventFolder}`;
  const searchPath = scanPath ?? basePath;
  const activePath = `${basePath}/schedules-active.json`;
  const draftPath = `${basePath}/schedules-draft.json`;

  // Only fetch HTML documents — skip JSON sheets, images, fonts, etc.
  const allFiles = await listAllFiles(org, repo, searchPath);
  const docFiles = allFiles.filter((f) => f.endsWith('.html'));

  // Single pass: collect every scheduleId found in any doc. Done once — the doc
  // scan is the expensive part and its result is independent of the sheets.
  const foundIds = new Set();
  const foundData = new Map(); // scheduleId → decoded object (for new discoveries)
  // Fetch + scan docs in parallel (bounded). Scanning happens inside the worker
  // so each doc's text can be garbage-collected before the next batch.
  let unreadable = 0;
  const perDocFinds = await mapWithConcurrency(docFiles, SCAN_CONCURRENCY, async (filePath) => {
    const res = await fetchText(org, repo, filePath);
    if (!res.ok) { unreadable += 1; return []; }
    if (!res.text) return [];
    const finds = [];
    const re = /schedule=([A-Za-z0-9+/=%-]{20,})/g;
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(res.text)) !== null) {
      const decoded = decodeScheduleParam(m[1]);
      if (decoded?.scheduleId) finds.push(decoded);
    }
    return finds;
  });
  // Abort rather than misclassify: a doc we couldn't read might reference a
  // schedule, so treating it as empty could wrongly demote active → draft.
  if (unreadable > 0) {
    return {
      ok: false,
      status: 503,
      error: `Sync aborted: ${unreadable} document(s) could not be read (rate limited or unavailable). Please retry — lower SCAN_CONCURRENCY if this persists.`,
    };
  }
  // Build the reverse index (scheduleId → docs) while collecting ids.
  // perDocFinds is index-aligned with docFiles, so docFiles[i] is the source doc.
  const refIndex = new Map(); // scheduleId → Set(docPath)
  perDocFinds.forEach((finds, i) => {
    const docPath = docFiles[i];
    for (const decoded of finds) {
      foundIds.add(decoded.scheduleId);
      if (!foundData.has(decoded.scheduleId)) foundData.set(decoded.scheduleId, decoded);
      if (!refIndex.has(decoded.scheduleId)) refIndex.set(decoded.scheduleId, new Set());
      refIndex.get(decoded.scheduleId).add(docPath);
    }
  });

  // Reclassification is deterministic given foundIds, so it is safe to re-run on
  // a 412 conflict. Read both sheets, recompute, and write both conditionally.
  let movedToActive = 0;
  let movedToDraft = 0;
  let newlyDiscovered = [];
  for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [activeResult, draftResult] = await Promise.all([
      readSheet(org, repo, activePath),
      readSheet(org, repo, draftPath),
    ]);
    let activeRows = activeResult.ok ? (activeResult.data || []) : [];
    let draftRows = draftResult.ok ? (draftResult.data || []) : [];
    const knownIds = new Set([...activeRows, ...draftRows].map((r) => r.scheduleId));

    const toDeactivate = activeRows.filter((r) => !foundIds.has(r.scheduleId));
    const toActivate = draftRows.filter((r) => foundIds.has(r.scheduleId));

    activeRows = [
      ...activeRows.filter((r) => foundIds.has(r.scheduleId)),
      ...toActivate,
    ];
    draftRows = [
      ...draftRows.filter((r) => !foundIds.has(r.scheduleId)),
      ...toDeactivate,
    ];

    const discovered = [];
    for (const [id, data] of foundData) {
      if (!knownIds.has(id)) {
        const row = {
          scheduleId: id,
          title: data.title || '',
          blocks: data.blocks || [],
          createdTime: new Date().toISOString(),
          modificationTime: new Date().toISOString(),
        };
        activeRows.push(row);
        discovered.push(row);
      }
    }

    // eslint-disable-next-line no-await-in-loop
    const [w1, w2] = await Promise.all([
      writeSheet(org, repo, activePath, activeRows, activeResult.ok ? { etag: normalizeEtag(activeResult.etag) } : { create: true }),
      writeSheet(org, repo, draftPath, draftRows, draftResult.ok ? { etag: normalizeEtag(draftResult.etag) } : { create: true }),
    ]);
    if (w1.ok && w2.ok) {
      movedToActive = toActivate.length;
      movedToDraft = toDeactivate.length;
      newlyDiscovered = discovered;
      // Persist the reverse index for the "Update pages" propagation feature.
      // Best-effort: a failure here doesn't fail the sync (the index is derived
      // and propagation re-verifies each doc before writing).
      const refRows = [...refIndex.entries()]
        .map(([id, paths]) => ({ scheduleId: id, paths: JSON.stringify([...paths]) }));
      // eslint-disable-next-line no-await-in-loop
      await writeRawSheet(org, repo, `${basePath}/schedule-refs.json`, refRows);
      return {
        ok: true,
        data: {
          active: activeRows,
          draft: draftRows,
          newlyDiscovered,
          movedToActive,
          movedToDraft,
        },
      };
    }
    if (w1.status === 412 || w2.status === 412) continue;
    return w1.ok ? w2 : w1;
  }
  return { ok: false, status: 412, error: 'Conflict during sync — the sheets changed. Please retry.' };
}


const SCHEDULE_PARAM_RE = /\?schedule=([A-Za-z0-9+/=%-]{20,})/g;

// Handles both correctly-encoded links (single decodeURIComponent) and legacy
// double-encoded links where encodeURIComponent was applied before searchParams.set.
function decodeScheduleParam(raw) {
  const attempts = [
    () => atob(decodeURIComponent(raw)),
    () => atob(decodeURIComponent(decodeURIComponent(raw))),
    () => atob(raw),
  ];
  for (const attempt of attempts) {
    try {
      const obj = JSON.parse(attempt());
      if (obj?.scheduleId) return obj;
    } catch { /* try next */ }
  }
  return null;
}

function matchesScheduleId(b64, scheduleId) {
  const decoded = decodeScheduleParam(b64);
  return decoded?.scheduleId === scheduleId;
}

export async function findScheduleReferences(org, repo, scheduleId, scanPath = '/') {
  const basePath = scanPath.startsWith('/') ? scanPath : `/${scanPath}`;
  const allFiles = await listAllFiles(org, repo, basePath);
  const files = allFiles.filter((f) => f.endsWith('.html'));
  let unreadable = 0;
  const flags = await mapWithConcurrency(files, SCAN_CONCURRENCY, async (filePath) => {
    const res = await fetchText(org, repo, filePath);
    if (!res.ok) { unreadable += 1; return false; }
    if (!res.text) return false;
    const re = new RegExp(SCHEDULE_PARAM_RE.source, 'g');
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(res.text)) !== null) {
      if (matchesScheduleId(m[1], scheduleId)) return true;
    }
    return false;
  });
  // A missed doc could hide a reference — for delete this would leave a dangling
  // link, and for status it would misclassify. Surface the error instead.
  if (unreadable > 0) {
    return {
      ok: false,
      status: 503,
      error: `${unreadable} document(s) could not be read (rate limited or unavailable). Please retry.`,
    };
  }
  const affected = files.filter((_, i) => flags[i]);
  return { ok: true, data: affected };
}

async function removeScheduleFromDocs(org, repo, affectedPaths, scheduleId) {
  // Matches a full <a ...href="...?schedule=<b64>...">...</a> element
  const anchorRe = /<a\s[^>]*href=["']([^"']*)["'][^>]*>[\s\S]*?<\/a>/gi;

  await Promise.all(affectedPaths.map(async (filePath) => {
    const url = `${DA_ADMIN_ORIGIN}/source/${org}/${repo}${filePath}`;
    const resp = await doFetch(url, getHeaders('GET'));
    if (!resp.ok) return;
    const text = await resp.text();
    let changed = false;
    const cleaned = text.replace(anchorRe, (match, href) => {
      const paramMatch = href.match(/[?&]schedule=([A-Za-z0-9+/=%-]{20,})/);
      if (paramMatch && matchesScheduleId(paramMatch[1], scheduleId)) {
        changed = true;
        return ''; // remove the entire anchor element
      }
      return match;
    });
    if (!changed) return;
    const mimeType = filePath.endsWith('.json') ? 'application/json' : 'text/html';
    const formData = new FormData();
    formData.append('data', new Blob([cleaned], { type: mimeType }), filePath.split('/').pop());
    const headers = new Headers();
    if (daToken) headers.append('Authorization', `Bearer ${daToken}`);
    await doFetch(url, { method: 'POST', headers, body: formData });
  }));
}

// Reads the reverse index and returns the doc paths recorded for a schedule.
// The index is refreshed on each sync, so results reflect the last sync — a
// link pasted since then won't appear until the next sync.
export async function getScheduleRefs(org, repo, eventFolder, scheduleId) {
  const basePath = eventFolder.startsWith('/') ? eventFolder : `/${eventFolder}`;
  const res = await readRawSheet(org, repo, `${basePath}/schedule-refs.json`);
  if (!res.ok) return { ok: true, data: [] };
  const row = (res.rows || []).find((r) => r.scheduleId === scheduleId);
  if (!row?.paths) return { ok: true, data: [] };
  try {
    return { ok: true, data: JSON.parse(row.paths) };
  } catch {
    return { ok: true, data: [] };
  }
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Mirrors ScheduleURLUtility.copyScheduleToClipboard's link text.
function scheduleLinkText(schedule) {
  const { title, modificationTime } = schedule;
  const date = modificationTime
    ? new Date(modificationTime).toLocaleString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    })
    : '';
  return date ? `Schedule: ${title} – ${date}` : `Schedule: ${title}`;
}

// Conditional write of a document's source (If-Match). Source-only — this never
// previews or publishes; authors publish the pages themselves.
async function writeDoc(org, repo, filePath, content, { etag } = {}) {
  const url = `${DA_ADMIN_ORIGIN}/source/${org}/${repo}${filePath}`;
  const mimeType = filePath.endsWith('.json') ? 'application/json' : 'text/html';
  const formData = new FormData();
  formData.append('data', new Blob([content], { type: mimeType }), filePath.split('/').pop());
  const headers = new Headers();
  if (daToken) headers.append('Authorization', `Bearer ${daToken}`);
  if (etag) headers.append('If-Match', etag);
  let resp;
  try {
    resp = await doFetch(url, { method: 'POST', headers, body: formData });
  } catch {
    return { ok: false, status: 0 };
  }
  return { ok: resp.ok, status: resp.status };
}

// Rewrites the embedded schedule link in each doc so it reflects the current
// schedule (new base64 payload + refreshed link text). Source-only, conditional
// per doc, retried on 412. Docs where the link is no longer present (stale index
// entry) are skipped, not failed. `schedule` must be the encode-ready object
// (same shape ScheduleURLUtility encodes). Returns { updated, skipped, failed }.
export async function propagateScheduleToDocs(org, repo, schedule, paths) {
  const { scheduleId } = schedule;
  if (!scheduleId || !paths?.length) return { ok: true, data: { updated: [], skipped: [], failed: [] } };

  const newB64 = btoa(JSON.stringify(schedule));
  const newText = escapeHtml(scheduleLinkText(schedule));
  const anchorRe = /(<a\b[^>]*href=["']([^"']*)["'][^>]*>)([\s\S]*?)(<\/a>)/gi;
  const paramRe = /([?&]schedule=)[A-Za-z0-9+/=%-]{20,}/i;

  const updated = [];
  const skipped = [];
  const failed = [];

  await mapWithConcurrency(paths, SCAN_CONCURRENCY, async (filePath) => {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await fetchText(org, repo, filePath);
      if (!doc.ok) { failed.push(filePath); return; }
      if (!doc.text) { skipped.push(filePath); return; } // doc gone since sync

      let changed = false;
      const next = doc.text.replace(anchorRe, (m, openTag, href, inner, closeTag) => {
        const pm = href.match(/[?&]schedule=([A-Za-z0-9+/=%-]{20,})/i);
        if (!pm || !matchesScheduleId(pm[1], scheduleId)) return m;
        changed = true;
        const newOpen = openTag.replace(paramRe, `$1${encodeURIComponent(newB64)}`);
        return `${newOpen}${newText}${closeTag}`;
      });
      if (!changed) { skipped.push(filePath); return; } // link not present (stale index)

      // eslint-disable-next-line no-await-in-loop
      const w = await writeDoc(org, repo, filePath, next, { etag: normalizeEtag(doc.etag) });
      if (w.ok) { updated.push(filePath); return; }
      if (w.status !== 412) { failed.push(filePath); return; }
      // 412 → doc changed under us; re-read and retry
    }
    failed.push(filePath);
  });

  return { ok: failed.length === 0, data: { updated, skipped, failed } };
}

export async function deleteSchedule(org, repo, eventFolder, scheduleId, affectedPaths = []) {
  if (affectedPaths.length > 0) await removeScheduleFromDocs(org, repo, affectedPaths, scheduleId);
  const basePath = eventFolder.startsWith('/') ? eventFolder : `/${eventFolder}`;
  const activePath = `${basePath}/schedules-active.json`;
  const draftPath = `${basePath}/schedules-draft.json`;

  let found = false;
  const removeRow = (rows) => {
    const next = rows.filter((r) => r.scheduleId !== scheduleId);
    if (next.length === rows.length) return { rows, result: null, skip: true };
    found = true;
    return { rows: next, result: null };
  };

  const activeRes = await mutateSheet(org, repo, activePath, removeRow);
  if (!activeRes.ok && activeRes.status !== 404) return activeRes;
  const draftRes = await mutateSheet(org, repo, draftPath, removeRow);
  if (!draftRes.ok && draftRes.status !== 404) return draftRes;

  if (!found) return { ok: false, status: 404, error: 'Schedule not found' };
  return { ok: true };
}

export async function refreshScheduleStatus(org, repo, eventFolder, scheduleId) {
  const searchResult = await findScheduleReferences(org, repo, scheduleId);
  // Don't misclassify on a failed scan — propagate the error so the caller retries.
  if (!searchResult.ok) return searchResult;
  const isActive = searchResult.data.length > 0;

  const basePath = eventFolder.startsWith('/') ? eventFolder : `/${eventFolder}`;
  const activePath = `${basePath}/schedules-active.json`;
  const draftPath = `${basePath}/schedules-draft.json`;

  // Moving a row between two sheets isn't a single atomic op, so make it
  // idempotent: remove from both, add to the correct one, and only write the
  // sheets that actually change. Retry on 412 — recomputing from a fresh read
  // converges even after a partial (one-sheet-succeeded) write.
  for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [activeResult, draftResult] = await Promise.all([
      readSheet(org, repo, activePath),
      readSheet(org, repo, draftPath),
    ]);
    const activeRows = activeResult.ok ? (activeResult.data || []) : [];
    const draftRows = draftResult.ok ? (draftResult.data || []) : [];
    const inActive = activeRows.findIndex((r) => r.scheduleId === scheduleId);
    const inDraft = draftRows.findIndex((r) => r.scheduleId === scheduleId);

    const row = inActive !== -1 ? activeRows[inActive] : (inDraft !== -1 ? draftRows[inDraft] : null);
    if (!row) return { ok: false, status: 404, error: 'Schedule not found' };

    const wasInActive = inActive !== -1;
    const wasInDraft = inDraft !== -1;
    const activeChanged = isActive ? !wasInActive : wasInActive;
    const draftChanged = isActive ? wasInDraft : !wasInDraft;

    if (!activeChanged && !draftChanged) {
      return { ok: true, data: { status: isActive ? 'active' : 'draft' } };
    }

    const nextActive = activeRows.filter((r) => r.scheduleId !== scheduleId);
    const nextDraft = draftRows.filter((r) => r.scheduleId !== scheduleId);
    if (isActive) nextActive.push(row);
    else nextDraft.push(row);

    const writes = [];
    if (activeChanged) writes.push(writeSheet(org, repo, activePath, nextActive, activeResult.ok ? { etag: normalizeEtag(activeResult.etag) } : { create: true }));
    if (draftChanged) writes.push(writeSheet(org, repo, draftPath, nextDraft, draftResult.ok ? { etag: normalizeEtag(draftResult.etag) } : { create: true }));
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(writes);
    if (results.every((r) => r.ok)) {
      return { ok: true, data: { status: isActive ? 'active' : 'draft' } };
    }
    if (results.some((r) => r.status === 412)) continue;
    return results.find((r) => !r.ok);
  }
  return { ok: false, status: 412, error: CONFLICT_ERROR };
}
