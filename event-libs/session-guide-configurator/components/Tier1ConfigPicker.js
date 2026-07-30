import {
  useState, useEffect, useMemo, useCallback, html,
} from '../../v1/deps/htm-preact.js';
import Modal from './Modal.js';
import SearchInput from './SearchInput.js';
import LoadingInline from './LoadingInline.js';
// Deliberate cross-app dependency, not a duplication risk like TRACK_ATTRIBUTE_NAME was
// (PLAN.md §4.6) — Session Guide Configurator is explicitly designed to hook into an
// existing Tier 1 Event Configurator config as its event source (PLAN.md §2), so
// reusing Tier 1's own sheet-read and title-resolution logic directly is the correct
// call, not a copy to keep in sync.
import { getConfigs as getTier1Configs } from '../../tier-1-event-configurator/scripts/da-controller.js';
import { getDisplayTitle as getTier1DisplayTitle } from '../../tier-1-event-configurator/utils.js';
import { useDA } from '../context/DAContext.js';

// Default event-source picker for New config: lists events that already have a Tier 1
// Event Configurator config, since that's this app's real source of truth for event
// data (PLAN.md §2). onSwitchToAlternative lets an author fall back to ESP browse /
// manual Event ID entry for an event that doesn't have a Tier 1 config yet.
export default function Tier1ConfigPicker({
  isOpen, onClose, onSelect, onSwitchToAlternative,
}) {
  const { org, repo } = useDA();
  const [rows, setRows] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isOpen || !org || !repo) return undefined;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getTier1Configs(org, repo).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error || 'Failed to load Tier 1 Event Configurator configs');
        return;
      }
      setRows(result.data);
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [isOpen, org, repo]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (row) => getTier1DisplayTitle(row).toLowerCase().includes(term)
        || (row.eventId || '').toLowerCase().includes(term),
    );
  }, [rows, search]);

  const handleSearch = useCallback((e) => setSearch(e.target.value), []);

  const handleSelect = useCallback((row) => {
    onSelect({ eventId: row.eventId, enTitle: row.backendEventTitle }, row.eventServiceEnv);
  }, [onSelect]);

  return html`
    <${Modal} isOpen=${isOpen} onClose=${onClose} title="New config — pick an event with a Tier 1 config" showActions=${false} size="large">
      <div class="sgc-event-picker">
        <${SearchInput} \
          id="sgc-tier1-picker-search" \
          placeholder="Search by event title or Event ID" \
          value=${search} \
          onInput=${handleSearch} \
          className="sgc-event-picker__search" \
        />
        ${isLoading && html`<${LoadingInline} label="Loading Tier 1 configs…" />`}
        ${error && html`<p class="sgc-event-picker__status sgc-event-picker__status--error">${error}</p>`}
        ${!isLoading && !error && html`
          <ul class="sgc-event-picker__list">
            ${filteredRows.map((row) => html`
              <li key=${row.eventId}>
                <button type="button" class="sgc-event-picker__item-btn" onClick=${() => handleSelect(row)}>
                  <span class="sgc-event-picker__item-title">${getTier1DisplayTitle(row)}</span>
                  <span class="sgc-event-picker__item-meta">
                    ${row.eventId}
                    ${row.eventServiceEnv && row.eventServiceEnv !== 'prod' ? ` · ${row.eventServiceEnv}` : ''}
                  </span>
                </button>
              </li>
            `)}
            ${filteredRows.length === 0 && html`
              <li class="sgc-event-picker__empty">No Tier 1 configs match.</li>
            `}
          </ul>
        `}
        <p class="sgc-tier1-picker__alt">
          Don't see your event?
          <button type="button" class="sgc-btn sgc-btn--quiet" onClick=${onSwitchToAlternative}>
            Pick it another way
          </button>
        </p>
      </div>
    </${Modal}>
  `;
}
