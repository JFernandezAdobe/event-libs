import { useState, useEffect } from '../../v1/deps/htm-preact.js';
import { html } from '../htm-wrapper.js';
import Modal from './Modal.js';
import { useSchedulesUI, useSchedulesOperations, useSchedulesData } from '../context/SchedulesContext.js';

export default function DeleteConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  scheduleTitle,
  scheduleId,
}) {
  const { isDeleting } = useSchedulesUI();
  const { findScheduleReferences } = useSchedulesOperations();
  const { eventFolder } = useSchedulesData();
  const [affectedPaths, setAffectedPaths] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState(null);

  const runScan = () => {
    if (!scheduleId || !eventFolder) return;
    setIsScanning(true);
    setScanError(null);
    setAffectedPaths([]);
    findScheduleReferences(scheduleId, eventFolder)
      .then((result) => {
        if (result.ok) setAffectedPaths(result.data || []);
        else setScanError(result.error || 'Could not scan documents for references.');
      })
      .finally(() => setIsScanning(false));
  };

  useEffect(() => {
    if (!isOpen) return;
    runScan();
  }, [isOpen, scheduleId, eventFolder]);

  const handleConfirm = async () => {
    // Block deletion until the reference scan succeeds — deleting on an
    // incomplete scan could leave dangling schedule links in documents.
    if (isScanning || scanError) return;
    try {
      await onConfirm(affectedPaths);
      onClose();
    } catch (error) {
      window.lana?.log(`Error deleting schedule: ${error}`);
    }
  };

  return html`
    <${Modal} \
      isOpen=${isOpen} \
      onClose=${onClose} \
      title="Delete Schedule" \
      confirmText=${isDeleting ? 'Deleting...' : 'Delete'} \
      cancelText="Cancel" \
      onConfirm=${handleConfirm} \
      confirmDisabled=${isScanning || !!scanError} \
      size="small" \
    >
      <div class="delete-confirmation">
        <p>Are you sure you want to delete <strong>"${scheduleTitle || 'Untitled'}"</strong>?</p>

        ${isScanning && html`<p class="delete-confirmation__searching">Scanning for references in DA documents...</p>`}

        ${!isScanning && scanError && html`
          <div class="delete-confirmation__warning">
            <p class="delete-confirmation__warning-text">⚠️ ${scanError}</p>
            <sp-button treatment="outline" static-color="black" size="s" onClick=${runScan}>Retry scan</sp-button>
          </div>
        `}

        ${!isScanning && !scanError && affectedPaths.length > 0 && html`
          <div class="delete-confirmation__warning">
            <p class="delete-confirmation__warning-text">
              ⚠️ <strong>Warning:</strong> This schedule is embedded in ${affectedPaths.length} document(s).
              Deleting it removes those references from the <strong>document source</strong> — the change
              won't be live until you open and publish each page.
            </p>
            <ul class="delete-confirmation__affected-pages">
              ${affectedPaths.map((p) => html`<li key=${p}>${p}</li>`)}
            </ul>
          </div>
        `}

        ${!isScanning && !scanError && affectedPaths.length === 0 && html`
          <p class="delete-confirmation__safe">No references found in DA documents.</p>
        `}
      </div>
    </${Modal}>
  `;
}
