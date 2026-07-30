import { useState, useRef, html } from '../../v1/deps/htm-preact.js';
import { getEspEvent } from '../../v1/utils/esp-controller.js';
import Modal from './Modal.js';
import { useEventEnv } from '../context/EventEnvContext.js';
import { EVENT_SERVICE_ENV_OPTIONS } from '../constants.js';

// Candidate for promotion to a shared location (identical to Tier 1 Event
// Configurator's own ManualEventLookup.js aside from the class prefix) — see
// PLAN.md §8.
//
// New Config/Duplicate's fallback when EventPicker's browse fails at
// runtime (Library.js's browseFailed). Also the one place to target a
// non-prod ESP tier — the choice persists for the rest of the session.
export default function ManualEventLookup({
  isOpen, onClose, onSelect, title = 'Enter an Event ID',
}) {
  const { envName, setEnv } = useEventEnv();
  const [eventId, setEventId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [foundEvent, setFoundEvent] = useState(null);
  // Bumped on every lookup/env change so a stale response can't overwrite newer state.
  const requestIdRef = useRef(0);

  const reset = () => {
    setEventId('');
    setIsLoading(false);
    setError(null);
    setFoundEvent(null);
  };

  const handleEnvChange = (e) => {
    requestIdRef.current += 1;
    setEnv(e.target.value);
    setError(null);
    setFoundEvent(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleLookup = async () => {
    const trimmed = eventId.trim();
    if (!trimmed || isLoading) return;
    const requestId = (requestIdRef.current += 1);
    setIsLoading(true);
    setError(null);
    setFoundEvent(null);
    const result = await getEspEvent(trimmed);
    if (requestId !== requestIdRef.current) return;
    setIsLoading(false);
    if (!result.ok) {
      setError(result.status === 404 ? 'No event found with that ID.' : (result.error?.message || 'Failed to look up event — please retry.'));
      return;
    }
    setFoundEvent(result.data);
  };

  const handleUse = () => {
    if (!foundEvent) return;
    onSelect(foundEvent);
    reset();
  };

  return html`
    <${Modal} isOpen=${isOpen} onClose=${handleClose} title=${title} showActions=${false} size="small">
      <div class="sgc-manual-lookup">
        <p class="sgc-manual-lookup__hint">
          Enter the Event ID exactly as it appears in ESP or the event page's own metadata.
        </p>
        <label class="sgc-manual-lookup__env-row">
          <span class="sgc-manual-lookup__env-label">Environment</span>
          <select class="sgc-field sgc-manual-lookup__env-select" value=${envName} onChange=${handleEnvChange}>
            ${EVENT_SERVICE_ENV_OPTIONS.map((opt) => html`<option value=${opt.value} key=${opt.value}>${opt.label}</option>`)}
          </select>
        </label>
        <div class="sgc-manual-lookup__row">
          <input
            type="text"
            class="sgc-field sgc-manual-lookup__input"
            placeholder="Event ID"
            value=${eventId}
            onInput=${(e) => setEventId(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') handleLookup(); }}
          />
          <button
            type="button"
            class="sgc-btn sgc-btn--primary"
            onClick=${handleLookup}
            disabled=${isLoading || !eventId.trim()}
          >
            ${isLoading ? 'Looking up…' : 'Look up'}
          </button>
        </div>
        ${error && html`<p class="sgc-manual-lookup__error">${error}</p>`}
        ${foundEvent && html`
          <div class="sgc-manual-lookup__result">
            <p class="sgc-manual-lookup__result-title">${foundEvent.enTitle || foundEvent.eventId}</p>
            <p class="sgc-manual-lookup__result-meta">
              ${foundEvent.eventId} · ${foundEvent.published ? 'Published' : 'Draft'}
            </p>
            <button type="button" class="sgc-btn sgc-btn--primary" onClick=${handleUse}>Use this event</button>
          </div>
        `}
      </div>
    </${Modal}>
  `;
}
