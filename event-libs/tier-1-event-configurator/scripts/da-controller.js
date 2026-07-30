import {
  setDaToken, setDaFetch, readSheet, mutateSheet, parseRowConfig,
} from '../../v1/utils/da-sheet-controller.js';
import { CONFIGS_SHEET_PATH } from '../constants.js';

export { setDaToken, setDaFetch };

// One-time migration-on-read: old rows had a single `eventTitle` meaning the
// backend title. Now that's `backendEventTitle`, and `eventTitle` means an
// author-set alternative. Doesn't rewrite the sheet; the next save does.
function migrateLegacyTitle(row) {
  const needsRowMigration = row.backendEventTitle === undefined && row.eventTitle !== undefined;
  const { eventTitle: legacyRowTitle, ...rowRest } = row;
  const migratedRow = needsRowMigration
    ? { ...rowRest, backendEventTitle: legacyRowTitle }
    : row;

  const config = migratedRow.config || {};
  const needsConfigMigration = config.backendEventTitle === undefined && config.eventTitle !== undefined;
  if (!needsConfigMigration) return migratedRow;
  const { eventTitle: legacyConfigTitle, ...configRest } = config;
  return {
    ...migratedRow,
    config: { ...configRest, backendEventTitle: legacyConfigTitle, eventTitle: '' },
  };
}

function parseAndMigrateRows(rawRows) {
  return rawRows
    .filter((row) => row && row.eventId)
    .map((row) => migrateLegacyTitle({
      ...row,
      config: parseRowConfig(row, 'tier-1-event-configurator'),
    }));
}

export async function getConfigs(org, repo) {
  const result = await readSheet(org, repo, CONFIGS_SHEET_PATH);
  if (!result.ok && result.status === 404) return { ok: true, data: [] };
  if (!result.ok) return result;
  return { ok: true, data: parseAndMigrateRows(result.data) };
}

// Upsert-by-Event-ID: replaces the existing row for this event, or appends a
// new one — a single write path rather than separate create/update calls, so
// re-picking an already-configured event can never create a duplicate row.
export async function upsertConfig(org, repo, {
  eventId, backendEventTitle, eventServiceEnv, config,
}) {
  const updated = new Date().toISOString();
  const stampedConfig = {
    ...config,
    eventId,
    backendEventTitle,
    updated,
  };
  // eventServiceEnv is row-level only, not stamped into config — it's an
  // authoring-time detail (which ESP tier this event came from), irrelevant
  // to the page that eventually consumes the pasted Config.
  const newRow = {
    eventId, backendEventTitle, eventServiceEnv, config: stampedConfig, updated,
  };

  const result = await mutateSheet(org, repo, CONFIGS_SHEET_PATH, (rows) => {
    // eventId is a top-level column, not inside the stringified `config` blob, so
    // matching against raw (unparsed) rows is safe here.
    const idx = rows.findIndex((r) => r.eventId === eventId);
    if (idx === -1) return { rows: [newRow, ...rows], result: newRow };
    const next = [...rows];
    next[idx] = newRow;
    return { rows: next, result: newRow };
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data };
}

export async function deleteConfig(org, repo, eventId) {
  let found = false;
  const result = await mutateSheet(org, repo, CONFIGS_SHEET_PATH, (rows) => {
    const next = rows.filter((r) => r.eventId !== eventId);
    if (next.length === rows.length) return { rows, result: null, skip: true };
    found = true;
    return { rows: next, result: null };
  });
  if (!result.ok) return result;
  if (!found) return { ok: false, status: 404, error: 'Config not found' };
  return { ok: true };
}
