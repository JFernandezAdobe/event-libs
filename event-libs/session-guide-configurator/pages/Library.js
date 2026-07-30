import {
  useState, useMemo, useCallback, html,
} from '../../v1/deps/htm-preact.js';
import SearchInput from '../components/SearchInput.js';
import Tier1ConfigPicker from '../components/Tier1ConfigPicker.js';
import EventPicker from '../components/EventPicker.js';
import ManualEventLookup from '../components/ManualEventLookup.js';
import Modal from '../components/Modal.js';
import { useNavigation } from '../context/NavigationContext.js';
import { useConfigs } from '../context/ConfigsContext.js';
import { useEventEnv } from '../context/EventEnvContext.js';
import { getDisplayTitle, formatUpdatedTime } from '../utils.js';
import { EVENT_BROWSE_ENABLED } from '../constants.js';

export default function Library() {
  const { goToEditor } = useNavigation();
  const {
    configs,
    startNewConfig,
    startDuplicateConfig,
    startEditConfig,
    removeConfig,
  } = useConfigs();
  const { envName, setEnv } = useEventEnv();

  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  // 'tier1' (default — pick an event that already has a Tier 1 Event Configurator
  // config, this app's real source of truth, PLAN.md §2) | 'browse' (ESP catalog) |
  // 'manual' (Event ID entry) — the latter two are explicit fallbacks for an event
  // that doesn't have a Tier 1 config yet, reached via Tier1ConfigPicker's own link.
  const [pickerMode, setPickerMode] = useState('tier1');
  const [rowPendingDelete, setRowPendingDelete] = useState(null);
  // If EventPicker's listAllEvents() fails for any reason, fail over to
  // ManualEventLookup for the rest of the session (sticky per page load, not
  // per open, so a transient failure doesn't force a doomed re-attempt).
  const [browseFailed, setBrowseFailed] = useState(false);

  const filteredConfigs = useMemo(() => {
    const term = search.trim().toLowerCase();
    const sorted = [...configs].sort(
      (a, b) => new Date(b.updated || 0) - new Date(a.updated || 0),
    );
    if (!term) return sorted;
    return sorted.filter(
      (row) => (row.componentName || '').toLowerCase().includes(term)
        || (row.backendEventTitle || '').toLowerCase().includes(term)
        || (row.eventId || '').toLowerCase().includes(term),
    );
  }, [configs, search]);

  const handleSearch = useCallback((e) => setSearch(e.target.value), []);

  const openNewPicker = useCallback(() => {
    setPickerMode('tier1');
    setPickerOpen(true);
  }, []);

  const switchToAlternativePicker = useCallback(() => {
    setPickerMode(EVENT_BROWSE_ENABLED && !browseFailed ? 'browse' : 'manual');
  }, [browseFailed]);

  const openEdit = useCallback((row) => {
    // Restores the ESP env this row was created against before opening it — a full
    // page reload resets EventEnvContext's override to its default (prod), same
    // reasoning as Tier 1 Event Configurator's own openEdit.
    setEnv(row.eventServiceEnv || 'prod');
    startEditConfig(row);
    goToEditor();
  }, [setEnv, startEditConfig, goToEditor]);

  // No event re-picking, unlike Tier 1 Event Configurator's cross-event Duplicate —
  // clones the row onto the same event (see ConfigsContext.js/PLAN.md §4.1).
  const handleDuplicate = useCallback((row) => {
    setEnv(row.eventServiceEnv || 'prod');
    startDuplicateConfig(row);
    goToEditor();
  }, [setEnv, startDuplicateConfig, goToEditor]);

  // eventServiceEnv is only ever supplied by Tier1ConfigPicker (the picked event's
  // config's own authored env) — EventPicker/ManualEventLookup don't supply one, so
  // this falls back to whatever the global env picker is currently set to, same as
  // before this picker gained a third mode.
  const handlePickEvent = useCallback((event, eventServiceEnv) => {
    setPickerOpen(false);
    const env = eventServiceEnv || envName;
    setEnv(env);
    startNewConfig(event, env);
    goToEditor();
  }, [startNewConfig, envName, setEnv, goToEditor]);

  const handleBrowseError = useCallback((message) => {
    setBrowseFailed(true);
    setPickerMode('manual');
    window.lana?.log(`session-guide-configurator: EventPicker failed, falling back to ManualEventLookup. ${message}`);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!rowPendingDelete) return;
    await removeConfig(rowPendingDelete.configId);
    setRowPendingDelete(null);
  }, [rowPendingDelete, removeConfig]);

  return html`
    <div class="sgc-page">
      <div class="sgc-library__header">
        <div>
          <h1 class="sgc-page__title">Session Guide Configurator</h1>
          <p class="sgc-page__subtitle">Per-event Session Guide config, exported as a link to paste into the event page.</p>
        </div>
        <button type="button" class="sgc-btn sgc-btn--primary sgc-btn--l" onClick=${openNewPicker}>New config</button>
      </div>

      <${SearchInput} \
        id="sgc-library-search" \
        placeholder="Search by component name, event title, or Event ID" \
        value=${search} \
        onInput=${handleSearch} \
        className="sgc-library__search" \
      />

      ${filteredConfigs.length === 0 && html`
        <p class="sgc-library__empty">
          No configs yet — click "New config" to author one for an event.
        </p>
      `}

      ${filteredConfigs.length > 0 && html`
        <ul class="sgc-library__list">
          ${filteredConfigs.map((row) => html`
            <li class="sgc-library__item" key=${row.configId}>
              <div class="sgc-library__item-info">
                <span class="sgc-library__item-title-row">
                  <span class="sgc-library__item-title">${getDisplayTitle(row)}</span>
                  ${row.eventServiceEnv && row.eventServiceEnv !== 'prod' && html`
                    <span class="sgc-library__item-env">${row.eventServiceEnv}</span>
                  `}
                </span>
                <span class="sgc-library__item-meta">
                  ${row.backendEventTitle ? `${row.backendEventTitle} · ` : ''}${row.eventId} · updated ${formatUpdatedTime(row.updated)}
                </span>
              </div>
              <div class="sgc-library__item-actions">
                <button type="button" class="sgc-btn sgc-btn--quiet" onClick=${() => openEdit(row)}>Edit</button>
                <button type="button" class="sgc-btn sgc-btn--quiet" onClick=${() => handleDuplicate(row)}>Duplicate</button>
                <button type="button" class="sgc-btn sgc-btn--quiet sgc-btn--danger" onClick=${() => setRowPendingDelete(row)}>Delete</button>
              </div>
            </li>
          `)}
        </ul>
      `}

      ${pickerMode === 'tier1' && html`
        <${Tier1ConfigPicker} \
          isOpen=${pickerOpen} \
          onClose=${() => setPickerOpen(false)} \
          onSelect=${handlePickEvent} \
          onSwitchToAlternative=${switchToAlternativePicker} \
        />
      `}
      ${pickerMode === 'browse' && html`
        <${EventPicker} \
          isOpen=${pickerOpen} \
          onClose=${() => setPickerOpen(false)} \
          onSelect=${handlePickEvent} \
          onError=${handleBrowseError} \
          title="New config — pick an event" \
        />
      `}
      ${pickerMode === 'manual' && html`
        <${ManualEventLookup} \
          isOpen=${pickerOpen} \
          onClose=${() => setPickerOpen(false)} \
          onSelect=${handlePickEvent} \
          title="New config — enter an Event ID" \
        />
      `}

      <${Modal} \
        isOpen=${!!rowPendingDelete} \
        onClose=${() => setRowPendingDelete(null)} \
        onConfirm=${confirmDelete} \
        title="Delete config?" \
        confirmText="Delete" \
        size="small" \
      >
        <p>
          This removes
          ${' '}<strong>${rowPendingDelete && getDisplayTitle(rowPendingDelete)}</strong> from the library.
          The sheet has no version history, so this can't be undone.
        </p>
      </${Modal}>
    </div>
  `;
}
