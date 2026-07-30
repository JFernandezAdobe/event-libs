import { useEffect, useRef, html } from '../../v1/deps/htm-preact.js';

// Candidate for promotion to a shared location (identical to Tier 1 Event
// Configurator's own Modal.js aside from the class prefix) — see PLAN.md §8.
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  confirmDisabled = false,
  showActions = true,
  size = 'medium',
}) {
  const modalRef = useRef(null);
  const firstFocusableRef = useRef(null);
  const lastFocusableRef = useRef(null);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen && modalRef.current) {
      modalRef.current.focus();
      const focusable = modalRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length > 0) {
        [firstFocusableRef.current, lastFocusableRef.current] = [focusable[0], focusable[focusable.length - 1]];
      }
    }
  }, [isOpen]);

  const handleKeyDown = (e) => {
    if (e.key === 'Tab') {
      if (e.shiftKey) {
        if (document.activeElement === firstFocusableRef.current) {
          e.preventDefault();
          lastFocusableRef.current?.focus();
        }
      } else if (document.activeElement === lastFocusableRef.current) {
        e.preventDefault();
        firstFocusableRef.current?.focus();
      }
    }
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!isOpen) return null;

  const sizeClass = { small: 'modal-small', medium: 'modal-medium', large: 'modal-large' }[size] || 'modal-medium';

  const renderActions = () => {
    if (!showActions) return null;
    return html`
      <div class="modal-actions">
        <button type="button" class="sgc-btn sgc-btn--outline sgc-btn--l" onClick=${onClose}>
          ${cancelText}
        </button>
        <button type="button" class="sgc-btn sgc-btn--primary sgc-btn--l" onClick=${onConfirm} disabled=${confirmDisabled}>
          ${confirmText}
        </button>
      </div>
    `;
  };

  return html`
    <div class="modal-overlay" onClick=${handleBackdropClick} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal ${sizeClass}" ref=${modalRef} tabindex="-1" onKeyDown=${handleKeyDown} role="document">
        <div class="modal-header">
          ${title && html`<h2 id="modal-title" class="modal-title">${title}</h2>`}
          <button type="button" class="sgc-btn sgc-btn--icon modal-close" onClick=${onClose} aria-label="Close modal">
            <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 18 18" width="18">
              <path fill="currentColor" fill-rule="evenodd" d="M13.243,3.343,9,7.586,4.757,3.343a.5.5,0,0,0-.707,0l-.707.707a.5.5,0,0,0,0,.707L7.586,9,3.343,13.243a.5.5,0,0,0,0,.707l.707.707a.5.5,0,0,0,.707,0L9,10.414l4.243,4.243a.5.5,0,0,0,.707,0l.707-.707a.5.5,0,0,0,0-.707L10.414,9l4.243-4.243a.5.5,0,0,0,0-.707l-.707-.707A.5.5,0,0,0,13.243,3.343Z"/>
            </svg>
          </button>
        </div>
        <div class="modal-content ${showActions ? '' : 'modal-content--standalone'}">
          ${children}
        </div>
        ${renderActions()}
      </div>
    </div>
  `;
}
