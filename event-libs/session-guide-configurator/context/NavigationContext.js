import {
  useState, useContext, useCallback, createContext, html,
} from '../../v1/deps/htm-preact.js';
import { PAGES } from '../constants.js';

const NavigationContext = createContext();

const NavigationProvider = ({ children }) => {
  const [activePage, setActivePage] = useState(PAGES.library);

  const goToLibrary = useCallback(() => {
    setActivePage(PAGES.library);
  }, []);

  const goToEditor = useCallback(() => {
    setActivePage(PAGES.editor);
  }, []);

  const value = {
    activePage,
    goToLibrary,
    goToEditor,
  };

  return html`
    <${NavigationContext.Provider} value=${value}>
      ${children}
    </${NavigationContext.Provider}>
  `;
};

const useNavigation = () => useContext(NavigationContext);

export { NavigationContext, NavigationProvider, useNavigation };
