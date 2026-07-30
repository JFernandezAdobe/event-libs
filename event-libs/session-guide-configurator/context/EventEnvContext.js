import {
  createContext, useState, useContext, useCallback, useMemo, html,
} from '../../v1/deps/htm-preact.js';
import { setEventServiceEnvOverride, getEventServiceEnv } from '../../v1/utils/utils.js';

const EventEnvContext = createContext();

// Reactive wrapper around utils.js's module-level env override, so a plain
// variable (needed for non-React callers too) can still drive a re-render.
const EventEnvProvider = ({ children }) => {
  const [envName, setEnvName] = useState(() => getEventServiceEnv().name);

  const setEnv = useCallback((name) => {
    setEventServiceEnvOverride(name);
    setEnvName(getEventServiceEnv().name);
  }, []);

  const value = useMemo(() => ({ envName, setEnv }), [envName, setEnv]);

  return html`
    <${EventEnvContext.Provider} value=${value}>
      ${children}
    </${EventEnvContext.Provider}>
  `;
};

const useEventEnv = () => useContext(EventEnvContext);

export { EventEnvProvider, useEventEnv };
