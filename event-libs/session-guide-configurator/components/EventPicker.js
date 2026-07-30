import {
  useState, useEffect, useMemo, useCallback, html,
} from '../../v1/deps/htm-preact.js';
import { listAllEvents } from '../../v1/utils/esp-controller.js';
import Modal from './Modal.js';
import SearchInput from './SearchInput.js';
import LoadingInline from './LoadingInline.js';

// Candidate for promotion to a shared location (identical to Tier 1 Event
// Configurator's own EventPicker.js aside from the class prefix) — see PLAN.md §8.
const PUBLISH_FILTERS = ['all', 'published', 'draft'];
const PUBLISH_FILTER_LABELS = { all: 'All', published: 'Published', draft: 'Draft' };

export default function EventPicker({
  isOpen, onClose, onSelect, onError, title = 'Select an event',
}) {
  const [events, setEvents] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [publishFilter, setPublishFilter] = useState('all');

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    listAllEvents()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          const message = result.error || 'Failed to load events';
          setError(message);
          // Caller (Library.js) fails over to ManualEventLookup on any
          // failure — no need to classify the error here too.
          onError?.(message);
          return;
        }
        setEvents(result.data);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [isOpen, onError]);

  const filteredEvents = useMemo(() => {
    const term = search.trim().toLowerCase();
    return events.filter((event) => {
      if (publishFilter === 'published' && !event.published) return false;
      if (publishFilter === 'draft' && event.published) return false;
      if (!term) return true;
      const title = (event.enTitle || '').toLowerCase();
      return title.includes(term) || (event.eventId || '').toLowerCase().includes(term);
    });
  }, [events, search, publishFilter]);

  const handleSearch = useCallback((e) => setSearch(e.target.value), []);

  return html`
    <${Modal} isOpen=${isOpen} onClose=${onClose} title=${title} showActions=${false} size="large">
      <div class="sgc-event-picker">
        <div class="sgc-event-picker__controls">
          <${SearchInput} \
            id="sgc-event-picker-search" \
            placeholder="Search by title or Event ID" \
            value=${search} \
            onInput=${handleSearch} \
            className="sgc-event-picker__search" \
          />
          <div class="sgc-event-picker__publish-filter">
            ${PUBLISH_FILTERS.map((f) => html`
              <button \
                type="button" \
                key=${f} \
                class="sgc-event-picker__publish-filter-btn ${f === publishFilter ? 'is-active' : ''}" \
                onClick=${() => setPublishFilter(f)} \
              >
                ${PUBLISH_FILTER_LABELS[f]}
              </button>
            `)}
          </div>
        </div>
        ${isLoading && html`<${LoadingInline} label="Loading events…" />`}
        ${error && html`<p class="sgc-event-picker__status sgc-event-picker__status--error">${error}</p>`}
        ${!isLoading && !error && html`
          <ul class="sgc-event-picker__list">
            ${filteredEvents.map((event) => html`
              <li key=${event.eventId}>
                <button type="button" class="sgc-event-picker__item-btn" onClick=${() => onSelect(event)}>
                  <span class="sgc-event-picker__item-title">${event.enTitle || event.eventId}</span>
                  <span class="sgc-event-picker__item-meta">${event.eventId} · ${event.published ? 'Published' : 'Draft'}</span>
                </button>
              </li>
            `)}
            ${filteredEvents.length === 0 && html`<li class="sgc-event-picker__empty">No events match.</li>`}
          </ul>
        `}
      </div>
    </${Modal}>
  `;
}
