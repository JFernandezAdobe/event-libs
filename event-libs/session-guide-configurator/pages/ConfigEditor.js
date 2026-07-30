import { useState, html } from '../../v1/deps/htm-preact.js';
import { useNavigation } from '../context/NavigationContext.js';
import { useConfigs } from '../context/ConfigsContext.js';
import { getDisplayTitle } from '../utils.js';

export default function ConfigEditor() {
  const { goToLibrary } = useNavigation();
  const {
    activeConfig, saveActiveConfig, clearActiveConfig, updateComponentName, updateConfigField,
  } = useConfigs();

  const [isSaving, setIsSaving] = useState(false);

  const handleCancel = () => {
    clearActiveConfig();
    goToLibrary();
  };

  const componentNameMissing = !activeConfig?.componentName?.trim();

  const handleSave = async () => {
    if (componentNameMissing) return;
    setIsSaving(true);
    try {
      const result = await saveActiveConfig();
      if (result.ok) goToLibrary();
    } finally {
      setIsSaving(false);
    }
  };

  if (!activeConfig) return null;

  return html`
    <div class="sgc-page sgc-editor">
      <div class="sgc-editor__header">
        <button type="button" class="sgc-btn sgc-btn--icon" onClick=${handleCancel} aria-label="Back to library">←</button>
        <div class="sgc-editor__header-text">
          <h1 class="sgc-editor__title">${getDisplayTitle(activeConfig)}</h1>
          <p class="sgc-editor__event-id">${activeConfig.eventId} · Backend title: ${activeConfig.backendEventTitle}</p>
        </div>
      </div>

      <section class="sgc-editor__section">
        <h2>Component name</h2>
        <p class="sgc-editor__section-hint">Distinguishes this config from others authored for the same event (e.g. a widget vs. full-page variant).</p>
        <input
          type="text"
          class="sgc-field sgc-editor__title-input"
          placeholder="e.g. MAX 26 — Widget"
          value=${activeConfig.componentName}
          onInput=${(e) => updateComponentName(e.target.value)}
        />
        ${componentNameMissing && html`
          <p class="sgc-editor__error">Component name is required before saving.</p>
        `}
      </section>

      <section class="sgc-editor__section">
        <h2>Page mode</h2>
        <p class="sgc-editor__section-hint">Embedded on page mounts as a drawer widget; Full page renders as a dedicated page layout.</p>
        <label class="sgc-editor__radio">
          <input
            type="radio"
            name="surface"
            value="widget"
            checked=${activeConfig.config.surface === 'widget'}
            onChange=${() => updateConfigField('surface', 'widget')}
          />
          Embedded on page
        </label>
        <label class="sgc-editor__radio">
          <input
            type="radio"
            name="surface"
            value="page"
            checked=${activeConfig.config.surface === 'page'}
            onChange=${() => updateConfigField('surface', 'page')}
          />
          Full page
        </label>
      </section>

      <section class="sgc-editor__section">
        <h2>Theme</h2>
        <label class="sgc-editor__radio">
          <input
            type="radio"
            name="theme"
            value="light"
            checked=${activeConfig.config.theme === 'light'}
            onChange=${() => updateConfigField('theme', 'light')}
          />
          Light
        </label>
        <label class="sgc-editor__radio">
          <input
            type="radio"
            name="theme"
            value="dark"
            checked=${activeConfig.config.theme === 'dark'}
            onChange=${() => updateConfigField('theme', 'dark')}
          />
          Dark
        </label>
      </section>

      <div class="sgc-editor__actions">
        <button type="button" class="sgc-btn sgc-btn--outline sgc-btn--l" onClick=${handleCancel}>Cancel</button>
        <button
          type="button"
          class="sgc-btn sgc-btn--primary sgc-btn--l"
          onClick=${handleSave}
          disabled=${isSaving || componentNameMissing}
        >
          ${isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  `;
}
