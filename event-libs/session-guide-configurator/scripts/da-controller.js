import {
  setDaToken, setDaFetch, readSheet, mutateSheet, parseRowConfig,
} from '../../v1/utils/da-sheet-controller.js';
import { CONFIGS_SHEET_PATH } from '../constants.js';

export { setDaToken, setDaFetch };

// Rows are keyed by their own configId, not eventId — an event can have many configs
// (widget + page variants, testing variants; see PLAN.md §2/§5), so there's no
// event-based dedup/migration logic to mirror from Tier 1 Event Configurator here.
function parseRows(rawRows) {
  return rawRows
    .filter((row) => row && row.configId)
    .map((row) => ({ ...row, config: parseRowConfig(row, 'session-guide-configurator') }));
}

export async function getConfigs(org, repo) {
  const result = await readSheet(org, repo, CONFIGS_SHEET_PATH);
  if (!result.ok && result.status === 404) return { ok: true, data: [] };
  if (!result.ok) return result;
  return { ok: true, data: parseRows(result.data) };
}

// Upsert-by-configId: replaces the existing row for this config, or appends a new one.
export async function upsertConfig(org, repo, {
  configId, componentName, eventId, backendEventTitle, eventServiceEnv, config,
}) {
  const updated = new Date().toISOString();
  const stampedConfig = { ...config, eventId, updated };
  const newRow = {
    configId, componentName, eventId, backendEventTitle, eventServiceEnv, config: stampedConfig, updated,
  };

  const result = await mutateSheet(org, repo, CONFIGS_SHEET_PATH, (rows) => {
    const idx = rows.findIndex((r) => r.configId === configId);
    if (idx === -1) return { rows: [newRow, ...rows], result: newRow };
    const next = [...rows];
    next[idx] = newRow;
    return { rows: next, result: newRow };
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data };
}

export async function deleteConfig(org, repo, configId) {
  let found = false;
  const result = await mutateSheet(org, repo, CONFIGS_SHEET_PATH, (rows) => {
    const next = rows.filter((r) => r.configId !== configId);
    if (next.length === rows.length) return { rows, result: null, skip: true };
    found = true;
    return { rows: next, result: null };
  });
  if (!result.ok) return result;
  if (!found) return { ok: false, status: 404, error: 'Config not found' };
  return { ok: true };
}
