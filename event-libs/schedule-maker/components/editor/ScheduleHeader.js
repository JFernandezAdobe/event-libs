import { useState } from '../../../v1/deps/htm-preact.js';
import { html } from '../../htm-wrapper.js';
import { useSchedulesData, useSchedulesOperations, useSchedulesUI } from '../../context/SchedulesContext.js';
import { ScheduleURLUtility, validateSchedule } from '../../utils.js';
import DeleteConfirmationModal from '../DeleteConfirmationModal.js';
import UpdatePagesModal from '../UpdatePagesModal.js';

export default function ScheduleHeader() {
  const { activeSchedule, hasUnsavedChanges } = useSchedulesData();
  const {
    updateScheduleLocally,
    deleteSchedule,
    updateSchedule,
    discardChangesToActiveSchedule,
  } = useSchedulesOperations();
  const { isUpdating, isDeleting, setToastSuccess, setToastError } = useSchedulesUI();

  const [isEditingScheduleTitle, setIsEditingScheduleTitle] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [showUpdatePages, setShowUpdatePages] = useState(false);

  const handleDeleteClick = () => setShowDeleteConfirmation(true);

  const handleDeleteConfirm = async (affectedPaths = []) => {
    if (!activeSchedule) return;
    try {
      await deleteSchedule(activeSchedule.scheduleId, affectedPaths);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      window.lana?.log(`Error deleting schedule: ${error}`);
    }
  };

  const handleCopyLink = async () => {
    if (!activeSchedule) return;
    try {
      const didCopy = await ScheduleURLUtility.copyScheduleToClipboard(activeSchedule);
      if (didCopy) {
        setToastSuccess('Link copied to clipboard');
      } else {
        setToastError('Failed to copy link to clipboard');
      }
    } catch (error) {
      window.lana?.log(`Error copying link: ${error}`);
    }
  };

  const handleSave = async () => {
    if (!activeSchedule) return;
    const validationErrors = validateSchedule(activeSchedule);
    if (validationErrors.length > 0) {
      setToastError(validationErrors.join('\n'));
      return;
    }
    try {
      await updateSchedule(activeSchedule.scheduleId, activeSchedule);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      window.lana?.log(`Error saving schedule: ${error}`);
    }
  };

  if (!activeSchedule) {
    return html`
      <header class="sm-editor__header">
        <h2>No schedule selected</h2>
      </header>
    `;
  }

  return html`
    <header class="sm-editor__header">
      <div class="sm-editor__header-title">
        <sp-textfield \
          type="text" \
          size="xl" \
          id="schedule-title-input" \
          value=${activeSchedule?.title || ''} \
          onInput=${(e) => updateScheduleLocally(e.target.value)} \
          class="sm-input--title ${isEditingScheduleTitle ? '' : 'sm-hidden'}" \
          onBlur=${() => setIsEditingScheduleTitle(false)} \
          onFocusIn=${() => setIsEditingScheduleTitle(true)} \
          placeholder="Enter schedule title" \
        ></sp-textfield>
        <button \
          class="sm-title-button sm-title-button--header ${isEditingScheduleTitle ? 'sm-hidden' : ''}" \
          onclick=${() => { setIsEditingScheduleTitle(true); requestAnimationFrame(() => document.getElementById('schedule-title-input')?.focus()); }} \
        >
          ${activeSchedule?.title || ''}
          <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 18 18" width="18">
            <path fill="currentColor" fill-rule="evenodd" d="M16.783,4.1,13.9,1.216a.607.607,0,0,0-.433-.176h-.019a.687.687,0,0,0-.464.2L2.542,11.686a.5.5,0,0,0-.126.211L1.028,16.55c-.057.188.229.425.391.425a.155.155,0,0,0,.031,0c.138-.032,3.933-1.172,4.656-1.39a.489.489,0,0,0,.207-.124L16.756,5.014a.684.684,0,0,0,.2-.442A.616.616,0,0,0,16.783,4.1ZM5.7,14.658c-1.08.325-2.431.733-3.364,1.011l1-3.365Z"/>
          </svg>
        </button>
      </div>
      <div class="sm-editor__header-actions">
        ${hasUnsavedChanges && html`
          <sp-action-button size="m" onclick=${discardChangesToActiveSchedule} title="Discard unsaved changes">
            <sp-icon slot="icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M1.72949 3.72895C2.12158 3.60834 2.54443 3.82954 2.6665 4.22553L3.19793 5.95569C4.63451 3.62543 7.19416 2.13031 10 2.13031C14.4111 2.13031 18 5.71918 18 10.1303C18 14.5414 14.4111 18.1303 10 18.1303C7.33838 18.1303 4.85839 16.812 3.36669 14.6035C3.13476 14.2602 3.22509 13.7939 3.56835 13.562C3.9121 13.3305 4.37792 13.4213 4.60985 13.7636C5.82225 15.5585 7.8374 16.6303 10 16.6303C13.584 16.6303 16.5 13.7143 16.5 10.1303C16.5 6.54633 13.584 3.63031 10 3.63031C7.79926 3.63031 5.78808 4.76465 4.60009 6.54547L6.14745 6.07025C6.54003 5.95111 6.96288 6.17035 7.08446 6.56683C7.20604 6.96283 6.98387 7.38226 6.58788 7.50384L3.208 8.54193C3.13476 8.56439 3.06054 8.57513 2.9873 8.57513C2.66699 8.57513 2.37011 8.3681 2.27099 8.04534L1.2329 4.66595C1.11132 4.26995 1.3335 3.85053 1.72949 3.72895Z"/>
              </svg>
            </sp-icon>
            Discard
          </sp-action-button>
        `}
        <sp-action-button size="m" onclick=${handleDeleteClick} disabled=${isDeleting}>
          <sp-icon slot="icon">
            <svg width="20" height="21" viewBox="0 0 20 21" fill="currentColor">
              <path d="M8.24903 15.5215C7.84864 15.5215 7.51563 15.2041 7.50098 14.8008L7.25098 8.30078C7.23438 7.88672 7.55762 7.53808 7.97071 7.52246C8.40137 7.52148 8.73438 7.83886 8.74903 8.24218L8.99903 14.7422C9.01563 15.1562 8.69239 15.5049 8.2793 15.5205C8.26856 15.5215 8.25879 15.5215 8.24903 15.5215Z"/>
              <path d="M11.751 15.5215C11.3076 15.5049 10.9844 15.1562 11.001 14.7422L11.251 8.24218C11.2656 7.83886 11.5986 7.52148 11.999 7.52148C12.4424 7.53808 12.7656 7.88672 12.749 8.30078L12.499 14.8008C12.4844 15.2041 12.1514 15.5215 11.751 15.5215Z"/>
              <path d="M17 4.5H13.5V3.75C13.5 2.50977 12.4902 1.5 11.25 1.5H8.75C7.50977 1.5 6.5 2.50977 6.5 3.75V4.5H3C2.58594 4.5 2.25 4.83594 2.25 5.25C2.25 5.66406 2.58594 6 3 6H3.52002L3.94238 16.3418C3.99023 17.5518 4.97851 18.5 6.19043 18.5H13.8096C15.0215 18.5 16.0098 17.5518 16.0576 16.3418L16.48 6H17C17.4141 6 17.75 5.66406 17.75 5.25C17.75 4.83594 17.4141 4.5 17 4.5ZM8 3.75C8 3.33691 8.33691 3 8.75 3H11.25C11.6631 3 12 3.33691 12 3.75V4.5H8V3.75ZM14.5596 16.2812C14.543 16.6846 14.2139 17 13.8096 17H6.19043C5.78613 17 5.45703 16.6846 5.44043 16.2812L5.02075 6H14.9792L14.5596 16.2812Z"/>
            </svg>
          </sp-icon>
          ${isDeleting ? 'Deleting...' : 'Delete'}
        </sp-action-button>
        <sp-action-button size="m" disabled=${hasUnsavedChanges} onclick=${handleCopyLink}>
          <sp-icon slot="icon">
            <svg width="20" height="21" viewBox="0 0 20 21" fill="currentColor">
              <path d="M5.31348 19.248C4.27246 19.248 3.23243 18.8516 2.44043 18.0596C0.856446 16.4756 0.856446 13.8974 2.44043 12.3125L6.3457 8.40722C7.93066 6.82324 10.5078 6.82421 12.0928 8.40722C12.3096 8.62499 12.5 8.86425 12.6592 9.11718C12.8799 9.46777 12.7744 9.93066 12.4238 10.1514C12.0713 10.373 11.6103 10.2656 11.3896 9.91601C11.2891 9.75585 11.168 9.60449 11.0303 9.46679C10.0312 8.46777 8.40527 8.46874 7.40625 9.46777L3.50098 13.373C2.50196 14.373 2.50196 16 3.50098 16.999C4.50196 18 6.12793 17.9961 7.12696 16.999L9.07911 15.0469C9.37208 14.7539 9.84669 14.7539 10.1397 15.0469C10.4326 15.3398 10.4326 15.8144 10.1397 16.1074L8.18751 18.0596C7.39552 18.8516 6.35449 19.2471 5.31348 19.248ZM13.6543 12.5928L17.5596 8.6875C19.1435 7.10254 19.1435 4.52441 17.5596 2.94043C15.9756 1.35645 13.3965 1.35645 11.8125 2.94043L9.86035 4.89258C9.56738 5.18555 9.56738 5.66016 9.86035 5.95313C10.1533 6.2461 10.6279 6.2461 10.9209 5.95313L12.873 4.00098C13.8721 3.00293 15.498 3.00098 16.499 4.00098C17.498 5 17.498 6.62696 16.499 7.62696L12.5938 11.5322C11.5947 12.5312 9.96876 12.5322 8.96974 11.5332C8.83204 11.3955 8.71095 11.2441 8.61036 11.084C8.38966 10.7344 7.92872 10.627 7.57618 10.8486C7.22559 11.0693 7.12013 11.5322 7.34083 11.8828C7.50001 12.1357 7.69044 12.375 7.90724 12.5928C9.49218 14.1777 12.0684 14.1777 13.6543 12.5928Z"/>
            </svg>
          </sp-icon>
          Copy link
        </sp-action-button>
        <sp-action-button size="m" disabled=${hasUnsavedChanges} onclick=${() => setShowUpdatePages(true)} title="Update pages that embed this schedule">
          <sp-icon slot="icon">
            <svg width="20" height="20" viewBox="0 0 18 18" fill="currentColor">
              <path d="M15.5,4H8.837L7.4,2.56A1.5,1.5,0,0,0,6.337,2.12H2.5A1.5,1.5,0,0,0,1,3.62V14.5A1.5,1.5,0,0,0,2.5,16h13A1.5,1.5,0,0,0,17,14.5v-9A1.5,1.5,0,0,0,15.5,4ZM12.06,10.62a3,3,0,0,1-5.06.9V12.5a.5.5,0,0,1-1,0v-2a.5.5,0,0,1,.5-.5h2a.5.5,0,0,1,0,1H7.66a2,2,0,0,0,3.46-.66.5.5,0,1,1,.94.28Z"/>
            </svg>
          </sp-icon>
          Update pages
        </sp-action-button>
        <sp-action-button size="m" onclick=${handleSave} disabled=${isUpdating || !hasUnsavedChanges} class=${hasUnsavedChanges ? 'sm-button--unsaved' : ''}>
          <sp-icon slot="icon">
            <svg width="20" height="21" viewBox="0 0 20 21" fill="currentColor">
              <path d="M15.4067 17.5H3.71777C1.81445 17.5 0.266113 15.9512 0.266113 14.0478C0.266113 12.5547 1.23291 11.2676 2.58984 10.7978C2.54687 10.5674 2.52539 10.333 2.52539 10.0957C2.52539 7.91601 4.33496 6.14258 6.55908 6.14258C6.83887 6.14258 7.1167 6.17188 7.39013 6.23047C8.02734 4.27246 9.8662 2.88379 11.9785 2.88379C14.6494 2.88379 16.8228 5.05664 16.8228 7.72754C16.8228 8.16602 16.7603 8.60059 16.6357 9.02637C18.438 9.55762 19.7388 11.2178 19.7388 13.168C19.7388 15.5566 17.7954 17.5 15.4067 17.5Z"/>
            </svg>
          </sp-icon>
          ${isUpdating ? 'Saving...' : 'Save'}
        </sp-action-button>
      </div>
    </header>
    <${DeleteConfirmationModal} \
      isOpen=${showDeleteConfirmation} \
      onClose=${() => setShowDeleteConfirmation(false)} \
      onConfirm=${handleDeleteConfirm} \
      scheduleTitle=${activeSchedule?.title} \
      scheduleId=${activeSchedule?.scheduleId} \
    />
    <${UpdatePagesModal} \
      isOpen=${showUpdatePages} \
      onClose=${() => setShowUpdatePages(false)} \
      schedule=${activeSchedule} \
    />
  `;
}
