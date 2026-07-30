import {
  createContext, useState, useContext, useCallback, useEffect, html,
} from '../../v1/deps/htm-preact.js';
import {
  getConfigs,
  upsertConfig as upsertConfigController,
  deleteConfig as deleteConfigController,
} from '../scripts/da-controller.js';
import { useDA } from './DAContext.js';
import { getDisplayTitle } from '../utils.js';

const ConfigsContext = createContext();

function emptyConfig() {
  return {
    surface: 'widget',
    theme: 'dark',
    headings: {
      loggedOut: '', loggedIn: '', loggedOutPostEvent: '', loggedInPostEvent: '',
    },
    behaviorFlags: {
      enableScheduling: true,
      enableFavoriting: true,
      enableWatchNowCtas: true,
      enableBrandConciergeRibbon: true,
    },
    filterCategories: [],
    swimlaneOrder: [],
  };
}

const ConfigsProvider = ({ children }) => {
  const { org, repo } = useDA();

  const [configs, setConfigs] = useState([]);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [toastSuccess, setToastSuccess] = useState(null);
  const [toastError, setToastError] = useState(null);

  // The row currently open in the editor — always a full row shape
  // ({ configId, componentName, eventId, backendEventTitle, eventServiceEnv, config }),
  // whether freshly created (New/Duplicate) or loaded from the library (Edit).
  const [activeConfig, setActiveConfig] = useState(null);

  const loadConfigs = useCallback(async () => {
    if (!org || !repo) return;
    setIsInitialLoading(true);
    setError(null);
    try {
      const result = await getConfigs(org, repo);
      if (!result.ok) {
        setError(result.error || 'Failed to load the config library');
        return;
      }
      setConfigs(result.data);
      setHasLoaded(true);
    } finally {
      setIsInitialLoading(false);
    }
  }, [org, repo]);

  useEffect(() => {
    if (org && repo && !hasLoaded) loadConfigs();
  }, [org, repo, hasLoaded, loadConfigs]);

  // Starts a fresh row for a newly picked event. Unlike Tier 1 Event Configurator,
  // there's no dedup-by-event check here — an event can have many configs (widget +
  // page variants, testing variants; see PLAN.md §2/§5), so picking an event that
  // already has other rows is expected, not an error.
  const startNewConfig = useCallback((event, eventServiceEnv) => {
    setActiveConfig({
      configId: crypto.randomUUID(),
      componentName: '',
      eventId: event.eventId,
      backendEventTitle: event.enTitle || event.eventId,
      eventServiceEnv,
      config: emptyConfig(),
    });
  }, []);

  // Clones a row's settings as-is onto the *same* event — no event re-picking, unlike
  // Tier 1 Event Configurator's cross-event Duplicate (which exists only because that
  // tool is one-row-per-event; this one isn't). Component name is pre-filled with a
  // "(copy)" suggestion rather than left blank, since everything else about the clone
  // is deliberately unchanged (PLAN.md §4.1: "Duplicates should copy everything over").
  const startDuplicateConfig = useCallback((sourceRow) => {
    setActiveConfig({
      configId: crypto.randomUUID(),
      componentName: sourceRow.componentName ? `${sourceRow.componentName} (copy)` : '',
      eventId: sourceRow.eventId,
      backendEventTitle: sourceRow.backendEventTitle,
      eventServiceEnv: sourceRow.eventServiceEnv,
      config: { ...sourceRow.config },
    });
  }, []);

  const startEditConfig = useCallback((row) => {
    setActiveConfig(row);
  }, []);

  const clearActiveConfig = useCallback(() => setActiveConfig(null), []);

  // componentName lives at the row level, not inside config (see PLAN.md §5) — its
  // own setter, distinct from updateConfigField below.
  const updateComponentName = useCallback((componentName) => {
    setActiveConfig((prev) => (prev ? { ...prev, componentName } : prev));
  }, []);

  // Sets a single top-level config field (e.g. surface, theme) immutably, so the
  // editor UI (reading activeConfig.config directly) stays in sync automatically.
  const updateConfigField = useCallback((key, value) => {
    setActiveConfig((prev) => {
      if (!prev) return prev;
      return { ...prev, config: { ...prev.config, [key]: value } };
    });
  }, []);

  // Sets a single field within a nested config object (headings.*, behaviorFlags.*),
  // immutably, same reasoning as updateConfigField above.
  const updateNestedConfigField = useCallback((group, key, value) => {
    setActiveConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        config: { ...prev.config, [group]: { ...prev.config[group], [key]: value } },
      };
    });
  }, []);

  const saveActiveConfig = useCallback(async () => {
    if (!activeConfig || !org || !repo) return { ok: false };
    const result = await upsertConfigController(org, repo, activeConfig);
    if (!result.ok) {
      setToastError(result.error || 'Failed to save — please retry');
      return result;
    }
    setConfigs((prev) => {
      const idx = prev.findIndex((r) => r.configId === result.data.configId);
      if (idx === -1) return [result.data, ...prev];
      const next = [...prev];
      next[idx] = result.data;
      return next;
    });
    setActiveConfig(result.data);
    setToastSuccess(`Saved ${getDisplayTitle(result.data)}`);
    return result;
  }, [activeConfig, org, repo]);

  const removeConfig = useCallback(async (configId) => {
    if (!org || !repo) return { ok: false };
    const result = await deleteConfigController(org, repo, configId);
    if (!result.ok) {
      setToastError(result.error || 'Failed to delete — please retry');
      return result;
    }
    setConfigs((prev) => prev.filter((r) => r.configId !== configId));
    setToastSuccess('Config deleted');
    return result;
  }, [org, repo]);

  const clearToastError = useCallback(() => setToastError(null), []);
  const clearToastSuccess = useCallback(() => setToastSuccess(null), []);

  const value = {
    configs,
    isInitialLoading,
    error,
    toastSuccess,
    toastError,
    clearToastError,
    clearToastSuccess,
    setToastError,
    setToastSuccess,
    activeConfig,
    startNewConfig,
    startDuplicateConfig,
    startEditConfig,
    clearActiveConfig,
    updateComponentName,
    updateConfigField,
    updateNestedConfigField,
    saveActiveConfig,
    removeConfig,
  };

  return html`
    <${ConfigsContext.Provider} value=${value}>
      ${children}
    </${ConfigsContext.Provider}>
  `;
};

const useConfigs = () => useContext(ConfigsContext);

export { ConfigsContext, ConfigsProvider, useConfigs };
