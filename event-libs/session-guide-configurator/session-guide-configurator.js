import { render, html } from '../v1/deps/htm-preact.js';
import { DAProvider } from './context/DAContext.js';
import { NavigationProvider } from './context/NavigationContext.js';
import { ConfigsProvider } from './context/ConfigsContext.js';
import { EventEnvProvider } from './context/EventEnvContext.js';
import SessionGuideConfigurator from './SessionGuideConfigurator.js';

// No Spectrum Web Components — plain HTML/CSS (session-guide-configurator.css),
// same precedent as tier-1-event-configurator.
async function init() {
  render(
    html`
      <${DAProvider}>
        <${EventEnvProvider}>
          <${NavigationProvider}>
            <${ConfigsProvider}>
              <${SessionGuideConfigurator} />
            </${ConfigsProvider}>
          </${NavigationProvider}>
        </${EventEnvProvider}>
      </${DAProvider}>
    `,
    document.getElementById('app'),
  );
}

init();
