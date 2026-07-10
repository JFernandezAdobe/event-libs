import { useState, useEffect } from '../../v1/deps/htm-preact.js';
import { html } from '../htm-wrapper.js';
import Modal from './Modal.js';
import { useSchedulesOperations } from '../context/SchedulesContext.js';

// Lists the docs that embed the active schedule (from the reverse index) and,
// on confirm, rewrites the embedded link in each so it reflects the current
// schedule. Source-only — it never publishes; authors publish the pages.
export default function UpdatePagesModal({ isOpen, onClose, schedule }) {
  const { getScheduleRefs, propagateSchedule } = useSchedulesOperations();
  const [paths, setPaths] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const loadRefs = () => {
    if (!schedule?.scheduleId) return;
    setIsLoading(true);
    setLoadError(null);
    setPaths([]);
    getScheduleRefs(schedule.scheduleId)
      .then((result) => {
        if (result.ok) setPaths(result.data || []);
        else setLoadError(result.error || 'Could not load referencing pages.');
      })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    if (!isOpen) return;
    loadRefs();
  }, [isOpen, schedule?.scheduleId]);

  const handleConfirm = async () => {
    if (isLoading || loadError || isUpdating || paths.length === 0) return;
    setIsUpdating(true);
    try {
      await propagateSchedule(schedule, paths);
      onClose();
    } catch (error) {
      window.lana?.log(`Error updating pages: ${error}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const canConfirm = !isLoading && !loadError && !isUpdating && paths.length > 0;

  return html`
    <${Modal} \
      isOpen=${isOpen} \
      onClose=${onClose} \
      title="Update pages" \
      confirmText=${isUpdating ? 'Updating...' : 'Update pages'} \
      cancelText="Cancel" \
      onConfirm=${handleConfirm} \
      confirmDisabled=${!canConfirm} \
      size="small" \
    >
      <div class="delete-confirmation">
        ${isLoading && html`<p class="delete-confirmation__searching">Loading referencing pages...</p>`}

        ${!isLoading && loadError && html`
          <div class="delete-confirmation__warning">
            <p class="delete-confirmation__warning-text">⚠️ ${loadError}</p>
            <sp-button treatment="outline" static-color="black" size="s" onClick=${loadRefs}>Retry</sp-button>
          </div>
        `}

        ${!isLoading && !loadError && paths.length > 0 && html`
          <div class="delete-confirmation__warning">
            <p class="delete-confirmation__warning-text">
              This updates the embedded schedule in ${paths.length} document(s) to match
              <strong>"${schedule?.title || 'Untitled'}"</strong>. Changes are saved to the
              <strong>document source only</strong> — open and publish each page to make them live.
            </p>
            <ul class="delete-confirmation__affected-pages">
              ${paths.map((p) => html`<li key=${p}>${p}</li>`)}
            </ul>
            <p class="delete-confirmation__note">
              Based on the last sync. Pages that embedded this schedule after the last sync won't be listed —
              run Sync to refresh.
            </p>
          </div>
        `}

        ${!isLoading && !loadError && paths.length === 0 && html`
          <p class="delete-confirmation__safe">
            No pages reference this schedule (as of the last sync). Run Sync if you've recently embedded it.
          </p>
        `}
      </div>
    </${Modal}>
  `;
}
