import { deleteAttendeeFromEvent, getAndCreateAndAddAttendee, getAttendee, getEvent, getCampaign, registerForSessionTime } from '../../utils/esp-controller.js';
import BlockMediator from '../../deps/block-mediator.min.js';
import { signIn, decorateEvent } from '../../utils/decorate.js';
import { dictionaryManager, getInviteOnlyNoCampaignMessage, getRsvpTokenInvalidMessage, getRsvpTokenAlreadyRegisteredMessage, getRsvpInvalidSubmissionMessage, getMultiSelectMoreSuffixMessage } from '../../utils/dictionary-manager.js';
import { getEventConfig, LIBS, getMetadata, getSusiOptions, getValidCampaignIdFromUrl, resolveRoutedCampaignId, shouldForceGuestSignIn } from '../../utils/utils.js';
import { FALLBACK_LOCALES, CAMPAIGN_ID_PATTERN, PHONE_FIELD_RE, PHONE_PATTERN, STANDARD_FIELD_MAX_LENGTHS } from '../../utils/constances.js';
import { BASE_ATTENDEE_DATA_FILTER } from '../../utils/data-utils.js';
import { parseRsvpFieldLimit, stripTags } from '../../utils/sanitize-utils.js';
import { applyImplicitContactMethodsToPayload, getImplicitConsentRaw } from '../../utils/rsvp-consent.js';
import { logError, logWarning } from '../../utils/lana-log.js';

const eventConfig = getEventConfig();
const miloLibs = eventConfig?.miloConfig?.miloLibs ? eventConfig.miloConfig.miloLibs : LIBS;

const { createTag, getConfig } = await import(`${miloLibs}/utils/utils.js`);
const { closeModal, sendAnalytics } = await import(`${miloLibs}/blocks/modal/modal.js`);
const { default: sanitizeComment } = await import(`${miloLibs}/utils/sanitizeComment.js`);
const { decorateDefaultLinkAnalytics } = await import(`${miloLibs}/martech/attributes.js`);
const { default: loadFragment } = await import(`${miloLibs}/blocks/fragment/fragment.js`);

const VALID_REGISTRATION_STATUS = ['registered', 'waitlisted'];

/** Valid `displayAs` flavors for the `text` substrate; each is also a valid
 * native `<input type>` (or `text-area`, handled by its own dispatch entry). */
const TEXT_DISPLAY_AS = new Set(['text', 'email', 'phone', 'number', 'date', 'url', 'text-area']);

const RULE_OPERATORS = {
  equal: '=',
  notEqual: '!=',
  lessThan: '<',
  lessThanOrEqual: '<=',
  greaterThan: '>',
  greaterThanOrEqual: '>=',
  includes: 'inc',
  excludes: 'exc',
};

function snakeToCamel(str) {
  return str
    .split('_')
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
}

/** Consent select uses query-index countryCode as option value; consentId lives on data-consent-id. */
function applyConsentCountrySelectValue(selectEl, stored) {
  if (!stored || typeof stored !== 'string') return;
  const opts = [...selectEl.options].filter((o) => o.value !== '');
  const byCode = opts.find((o) => o.value.toLowerCase() === stored.toLowerCase());
  if (byCode) {
    selectEl.value = byCode.value;
    return;
  }
  const byConsentId = opts.find((o) => o.dataset.consentId === stored);
  if (byConsentId) selectEl.value = byConsentId.value;
}

const MULTI_SELECT_CONDENSED_VISIBLE_COUNT = 2;

export function createSelect(fd) {
  const {
    field, placeholder, options, defval, required, type,
  } = fd;

  const optionValues = options.split(';').map((o) => o.trim());

  const select = createTag('select', { id: field });
  if (placeholder) select.append(createTag('option', { class: 'placeholder-option', selected: '', disabled: '', value: '' }, dictionaryManager.getValue(placeholder, 'rsvp-fields')));
  optionValues.forEach((text) => {
    const optionText = dictionaryManager.getValue(text, 'rsvp-fields');
    const option = createTag('option', { value: text }, optionText);
    select.append(option);
    if (defval === text) select.value = text;
  });

  if (required === 'x') select.setAttribute('required', 'required');

  if (type === 'multi-select') {
    select.classList.add('hidden');
    select.setAttribute('multiple', '');
    select.setAttribute('name', field);

    const placeholderOption = select.querySelector('option.placeholder-option');
    if (placeholderOption) placeholderOption.selected = false;

    const selectWrapper = createTag('div', { class: 'multi-select-wrapper' });
    const customSelect = createTag('div', { class: 'custom-select' });
    const selectedOptions = createTag('span', { class: 'selected-options' }, placeholder || '-', { parent: customSelect });
    const customDropdown = createTag('div', { class: 'custom-dropdown hidden' }, '', { parent: customSelect });

    const selectedValues = new Set();

    optionValues.forEach((text) => {
      const label = createTag('label', {}, dictionaryManager.getValue(text, 'rsvp-fields'), { parent: customDropdown });
      createTag('input', { type: 'checkbox', value: text, class: 'no-submit' }, '', { parent: label });
    });

    // Immutable snapshot of authoring order: re-sorting is always derived from this
    // fixed reference rather than the (possibly already-reordered) live DOM, so a
    // deselected option reliably returns to its original position.
    const originalLabels = Array.from(customDropdown.children);

    const sortDropdownOptions = () => {
      const sorted = [...originalLabels].sort((a, b) => {
        const aSelected = selectedValues.has(a.querySelector('input').value);
        const bSelected = selectedValues.has(b.querySelector('input').value);
        return Number(bSelected) - Number(aSelected);
      });
      sorted.forEach((label) => customDropdown.append(label));
    };

    const updateSelectUI = () => {
      if (selectedValues.size === 0) {
        selectedOptions.textContent = placeholder || '-';
      } else {
        const orderedSelected = optionValues.filter((v) => selectedValues.has(v));
        const visible = orderedSelected.slice(0, MULTI_SELECT_CONDENSED_VISIBLE_COUNT);
        const remaining = orderedSelected.length - visible.length;
        selectedOptions.textContent = remaining > 0
          ? `${visible.join(', ')} ${getMultiSelectMoreSuffixMessage(dictionaryManager, { count: remaining })}`
          : visible.join(', ');
      }

      Array.from(select.options).forEach((opt) => {
        opt.selected = selectedValues.has(opt.value);
      });

      const customSelectBoxes = customDropdown.querySelectorAll('input[type="checkbox"]');
      customSelectBoxes.forEach((cb) => {
        cb.checked = selectedValues.has(cb.value);
      });

      sortDropdownOptions();
    };

    customSelect.addEventListener('click', () => {
      customDropdown.classList.toggle('hidden');
    });

    customDropdown.addEventListener('change', (e) => {
      const input = e.target;
      const { value } = input;

      if (input.checked) {
        selectedValues.add(value);
      } else {
        selectedValues.delete(value);
      }

      updateSelectUI();
    });

    select.addEventListener('change', () => {
      selectedValues.clear();
      Array.from(select.selectedOptions).forEach((opt) => {
        if (opt.disabled) return;
        selectedValues.add(opt.value);
      });

      updateSelectUI();
    });

    selectWrapper.append(select, customSelect, customDropdown);

    return selectWrapper;
  }

  return select;
}

function constructPayload(form) {
  const exceptions = (el) => el.tagName !== 'BUTTON';
  const payload = {};
  [...form.elements].filter(exceptions).forEach((fe) => {
    if (fe.classList.contains('no-submit')) return;

    if (fe.type.match(/(?:checkbox|radio)/)) {
      if (fe.checked) {
        const valueList = fe.value.split('+').map((v) => v.trim());

        if (valueList.length > 1) {
          valueList.forEach((v) => {
            payload[fe.name] = payload[fe.name] ? [...payload[fe.name], v] : [v];
          });
        } else {
          payload[fe.name] = payload[fe.name] ? [...payload[fe.name], fe.value] : [fe.value];
        }
      } else {
        payload[fe.name] = payload[fe.name] || [];
      }
      return;
    }

    if (fe.type === 'select-multiple') {
      const selectedValues = Array.from(fe.selectedOptions)
        .filter((opt) => opt.value)
        .map((opt) => opt.value);
      payload[fe.id] = selectedValues;
      return;
    }

    if (fe.value) payload[fe.id] = fe.value;
  });

  // Post-process checkbox/radio groups. Single-option checkbox groups convert to
  // booleans. Radio groups are mutually exclusive by native radio semantics (shared
  // `name`), so their payload array always has 0 or 1 entries — collapse it to a
  // plain string, since string-typed attendee fields (e.g. industry, jobTitle) have
  // no array-to-string coercion downstream.
  Object.keys(payload).forEach((key) => {
    const fieldWrapper = form.querySelector(`[data-field-id="${key}"]`);
    if (!fieldWrapper || !Array.isArray(payload[key])) return;
    // Base attendee array fields (e.g. contactMethods) must stay arrays for the API
    if (BASE_ATTENDEE_DATA_FILTER[key]?.type === 'array') return;

    if (fieldWrapper.dataset.type === 'radio-group') {
      payload[key] = payload[key].length > 0 ? payload[key][0] : undefined;
      return;
    }

    if (fieldWrapper.dataset.type === 'checkbox' || fieldWrapper.dataset.type === 'checkbox-group') {
      const checkboxes = fieldWrapper.querySelectorAll('input[type="checkbox"]');
      if (checkboxes.length === 1 && payload[key].length <= 1) {
        // Single option checkbox with at most one value - convert to boolean
        payload[key] = payload[key].length > 0;
      }
    }
  });

  return payload;
}

export async function submitForm(bp) {
  const { form, sanitizeList } = bp;
  const payload = constructPayload(form);

  const countrySelect = form.querySelector('select#consentStringId');
  if (countrySelect) {
    const selectedOption = countrySelect.options[countrySelect.selectedIndex];
    if (selectedOption?.dataset?.countryCode) {
      payload.countryRegion = selectedOption.dataset.countryCode;
    }
    const consentId = selectedOption?.dataset?.consentId;
    if (consentId) {
      payload.consentStringId = consentId;
    }
  }

  applyImplicitContactMethodsToPayload(form, payload);

  const isValid = Object.keys(payload).reduce((valid, key) => {
    const field = form.querySelector(`[data-field-id=${key}]`);

    const missingSelection = !payload[key]
      || (Array.isArray(payload[key]) && payload[key].length === 0);
    if (missingSelection && field?.querySelector('.group-container.required')) {
      const el = form.querySelector(`input[name="${key}"]`);
      el.setCustomValidity('A selection is required');
      el.reportValidity();
      const cb = () => {
        el.setCustomValidity('');
        el.reportValidity();
        field.removeEventListener('input', cb);
      };
      field.addEventListener('input', cb);
      return false;
    }

    if (sanitizeList.includes(key)) {
      payload[key] = sanitizeComment(stripTags(payload[key]));
    }

    return valid;
  }, true);

  if (!isValid) return false;

  const campaignId = await resolveRoutedCampaignId();
  if (campaignId) {
    payload.campaignId = campaignId;
  }

  // A valid RSVP token never reaches submitForm unless it's still usable (an
  // invalid token short-circuits before the form is built, see onProfile). A guest
  // registers via the same normal attendee flow as an IMS user — the rsvp token
  // is just threaded through as auth instead of a bearer token, and the final
  // add-to-event call consumes it server-side once the registration succeeds.
  // campaignId (set on payload above) rides along in that call like any other flow.
  const rsvpToken = BlockMediator.get('imsProfile')?.rsvpToken;
  return getAndCreateAndAddAttendee(getMetadata('event-id'), payload, rsvpToken);
}

function clearForm(form) {
  [...form.elements].forEach((fe) => {
    if (fe.type.match(/(?:checkbox|radio)/)) {
      fe.checked = false;
    } else {
      fe.value = '';
    }
  });
}

/**
 * Resolves full state from event and optionally campaign (when campaign ID in URL).
 * @param {string} eventId - Event ID
 * @returns {Promise<{ full: boolean, waitlistEnabled: boolean, usedCampaign: boolean }>}
 */
export async function getFullState(eventId) {
  const eventObj = await getEvent(eventId);
  let full = false;
  let waitlistEnabled = false;
  let usedCampaign = false;

  if (!eventObj.ok) {
    return { full: false, waitlistEnabled: false, usedCampaign: false };
  }

  const { isFull, allowWaitlisting, attendeeCount, attendeeLimit } = eventObj.data;
  full = isFull || (!allowWaitlisting && +attendeeCount >= +attendeeLimit);
  waitlistEnabled = allowWaitlisting;

  const campaignId = new URLSearchParams(window.location.search).get('campaign');
  if (campaignId && CAMPAIGN_ID_PATTERN.test(campaignId)) {
    const campaignInfo = await getCampaign(eventId, campaignId);
    if (campaignInfo.ok && campaignInfo.data.attendeeLimit != null) {
      const { attendeeLimit: campLimit, attendeeCount: campCount, waitlistAttendeeCount } = campaignInfo.data;
      full = campLimit === campCount
        || (campLimit > campCount && waitlistAttendeeCount > 0);
      usedCampaign = true;
    }
  }

  return { full, waitlistEnabled, usedCampaign };
}

export function isWaitlistingEnabled(eventObj) {
  const { allowWaitlisting } = eventObj?.data || {};
  return allowWaitlisting === true || allowWaitlisting === 'true';
}

async function getFullMessageKey(waitlistErrorKey, noWaitlistErrorKey) {
  const eventObj = await getEvent(getMetadata('event-id'));
  return eventObj.ok && isWaitlistingEnabled(eventObj) ? waitlistErrorKey : noWaitlistErrorKey;
}

function getErrorMessage(error) {
  return typeof error === 'string' ? error : error?.message;
}

export async function buildErrorMsg(parent, status, error) {
  const message = getErrorMessage(error);

  let errorMsg;
  if (status === 400 && message === 'Event is full') {
    const errorKey = await getFullMessageKey('event-full-error-msg', 'event-full-no-waitlist-error-msg');
    errorMsg = dictionaryManager.getValue(errorKey);
  } else if (status === 400 && message === 'Authorization token is not valid for attendeeId') {
    await dictionaryManager.initialize();
    errorMsg = getRsvpTokenInvalidMessage(dictionaryManager);
  } else if (status === 400) {
    await dictionaryManager.initialize();
    errorMsg = getRsvpInvalidSubmissionMessage(dictionaryManager);
  } else if (status === 409 && message === 'Campaign is full') {
    const errorKey = await getFullMessageKey('campaign-full-error-msg', 'campaign-full-no-waitlist-error-msg');
    errorMsg = dictionaryManager.getValue(errorKey);
  } else if (status === 409 && BlockMediator.get('imsProfile')?.rsvpToken) {
    // AttendeeAlreadyRegistered — this email is already registered for the event.
    // The token is NOT consumed on this error, so it stays usable for a different
    // guest; the copy must not imply the link itself is dead.
    await dictionaryManager.initialize();
    errorMsg = getRsvpTokenAlreadyRegisteredMessage(dictionaryManager);
  } else if ((status === 401 || status === 404 || status === 410) && BlockMediator.get('imsProfile')?.rsvpToken) {
    // Token header missing (401), not found (404), or expired/revoked (410) — it
    // became invalid between page load and submit (e.g. the same link used in
    // another tab), or the RSVP token header failed to reach the server.
    await dictionaryManager.initialize();
    errorMsg = getRsvpTokenInvalidMessage(dictionaryManager);
  } else {
    errorMsg = dictionaryManager.getValue('rsvp-error-msg');
  }

  const existingErrors = parent.querySelectorAll('.error');
  if (existingErrors.length) {
    existingErrors.forEach((err) => err.remove());
  }

  const errorEl = createTag('p', { class: 'error' }, errorMsg);
  parent.append(errorEl);
  setTimeout(() => {
    errorEl.remove();
  }, 3000);
}

function showSuccessMsgFirstScreen(bp) {
  const rsvpData = BlockMediator.get('rsvpData');

  if (!rsvpData) return;

  clearForm(bp.form);
  bp.form.classList.add('hidden');
  bp.eventHero.classList.add('hidden');

  const { registrationStatus } = rsvpData;

  if (registrationStatus === 'waitlisted') {
    bp.waitlistSuccessScreen?.classList.remove('hidden');
    bp.waitlistSuccessScreen?.querySelector('.first-screen')?.classList.remove('hidden');
  }

  if (registrationStatus === 'registered') {
    bp.rsvpSuccessScreen?.classList.remove('hidden');
    bp.rsvpSuccessScreen?.querySelector('.first-screen')?.classList.remove('hidden');
  }
}

function eventFormSendAnalytics(bp, view) {
  const modal = bp.block.closest('.dialog-modal');
  if (!modal) return;
  const title = getMetadata('event-title');
  const name = title ? ` | ${title}` : '';
  const modalId = modal.id ? ` | ${modal.id}` : '';
  const event = new Event(`${view}${name}${modalId}`);
  sendAnalytics(event);
}

/**
 * Breakout-session auto-registration isn't supported for rsvp-token registrations
 * (no logged-in identity for the /attendees/me call to resolve against) — this is
 * the shared gate used by the submit handler to decide whether to fire it.
 * @param {string} registrationStatus - `registrationStatus` from the submit response.
 * @param {Object} profile - BlockMediator 'imsProfile' value.
 * @returns {boolean} True if auto-registration should run.
 */
export function shouldAutoRegisterSessions(registrationStatus, profile) {
  return registrationStatus === 'registered' && !profile?.rsvpToken;
}

async function autoRegisterSessions() {
  let sessions;
  try {
    sessions = JSON.parse(getMetadata('sessions') || '[]');
  } catch (e) {
    return;
  }

  const autoRegTimes = sessions.flatMap(
    (s) => (s.sessionTimes || []).filter((t) => t.isAutoRegistrationEnabled),
  );
  if (!autoRegTimes.length) return;

  const results = await Promise.allSettled(
    autoRegTimes.map((t) => registerForSessionTime(t.sessionTimeId, 'me', { registrationStatus: 'registered' })),
  );

  const newIds = new Set();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.ok) newIds.add(autoRegTimes[i].sessionId);
    else logWarning('events-form', `Auto-registration failed for session time ${autoRegTimes[i]?.sessionTimeId}`);
  });

  if (!newIds.size) return;
  const existing = BlockMediator.get('registeredSessionIds') || new Set();
  BlockMediator.set('registeredSessionIds', new Set([...existing, ...newIds]));
}

function createButton({ type, label }, bp) {
  const button = createTag('button', { class: 'button' }, dictionaryManager.getValue(label, 'rsvp-fields'));
  if (type === 'submit') {
    button.addEventListener('click', async (event) => {
      if (bp.form.checkValidity()) {
        event.preventDefault();
        button.setAttribute('disabled', true);
        button.classList.add('submitting');
        const respJson = await submitForm(bp);
        if (!respJson) {
          button.removeAttribute('disabled');
          button.classList.remove('submitting');
          return;
        }

        if (respJson.ok) {
          BlockMediator.set('rsvpData', respJson.data);
          eventFormSendAnalytics(bp, 'Form Submit');
          if (shouldAutoRegisterSessions(respJson.data?.registrationStatus, BlockMediator.get('imsProfile'))) autoRegisterSessions();
        } else {
          const { status, error } = respJson;
          const message = getErrorMessage(error);

          if (status === 400 && message === 'Event is full') {
            const eventObj = await getEvent(getMetadata('event-id'));
            if (isWaitlistingEnabled(eventObj)) {
              button.textContent = dictionaryManager.getValue('waitlist-cta-text');
              button.disabled = false;
            } else {
              button.textContent = dictionaryManager.getValue('event-full-cta-text');
              button.disabled = true;
            }
          }

          if (status === 400) {
            BlockMediator.set('rsvpData', null);
          }

          buildErrorMsg(bp.form, status, error);
        }

        button.removeAttribute('disabled');
        button.classList.remove('submitting');
      }
    });
  }

  if (type === 'clear') {
    button.classList.add('outline');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const form = button.closest('form');
      clearForm(form);
    });
  }
  return button;
}

function createHeading({ label }, el) {
  return createTag(el, {}, dictionaryManager.getValue(label, 'rsvp-fields'));
}

function createInput({
  type, field, placeholder, required, defval, pattern, title, limit,
}) {
  const placeholderText = placeholder ? dictionaryManager.getValue(placeholder, 'rsvp-fields') : '';
  const isPhoneField = type === 'tel' || type === 'phone' || (type !== 'text' && typeof field === 'string' && PHONE_FIELD_RE.test(field));
  const attrs = { type: isPhoneField ? 'tel' : type, id: field, placeholder: placeholderText, value: defval };
  if (isPhoneField) {
    attrs.inputmode = 'tel';
    attrs.autocomplete = 'tel';
  }
  const resolvedPattern = pattern || (isPhoneField ? PHONE_PATTERN : null);
  if (resolvedPattern) attrs.pattern = resolvedPattern;
  if (title) attrs.title = title;
  const resolvedLimit = limit ?? STANDARD_FIELD_MAX_LENGTHS[field];
  if (resolvedLimit != null) attrs.maxlength = resolvedLimit;
  const input = createTag('input', attrs);
  if (required === 'x') input.setAttribute('required', 'required');
  return input;
}

function createTextArea({ field, placeholder, required, defval, limit }) {
  const placeholderText = placeholder ? dictionaryManager.getValue(placeholder, 'rsvp-fields') : '';
  const attrs = { id: field, placeholder: placeholderText, value: defval };
  const resolvedLimit = limit ?? STANDARD_FIELD_MAX_LENGTHS[field];
  if (resolvedLimit != null) attrs.maxlength = resolvedLimit;
  const input = createTag('textarea', attrs);
  if (required === 'x') input.setAttribute('required', 'required');
  return input;
}

function createlabel({ field, label, required }) {
  return createTag('label', { for: field, class: required ? 'required' : '' }, dictionaryManager.getValue(label, 'rsvp-fields'));
}

function createCheckItem(item, type, id, def) {
  const itemKebab = item.toLowerCase().replaceAll(' ', '-');
  const defList = def.split(';').map((defItem) => defItem.trim());
  const pseudoEl = createTag('span', { class: `check-item-button ${type}-button` });
  const [customLabel, customVal] = item.split('::');
  const label = createTag('label', { class: `check-item-label ${type}-label`, for: `${id}-${itemKebab}` }, dictionaryManager.getValue(customLabel, 'rsvp-fields') || item);
  const input = createTag(
    'input',
    { type, name: id, value: customVal || item, class: `check-item-input ${type}-input`, id: `${id}-${itemKebab}` },
  );
  if (item && defList.includes(item)) input.setAttribute('checked', '');
  return createTag('div', { class: `check-item-wrap ${type}-input-wrap` }, [input, pseudoEl, label]);
}

function createCheckGroup({ options, field, defval, required }, type) {
  const optionsMap = options.split(';').map((item) => createCheckItem(item.trim(), type, field, defval));
  return createTag(
    'div',
    { class: `group-container ${type}-group-container${required === 'x' ? ' required' : ''}` },
    optionsMap,
  );
}

function createDivider() {
  return '';
}

function processNumRule(tf, operator, a, b) {
  /* c8 ignore next 3 */
  if (!tf.dataset.type.match(/(?:number|date)/)) {
    throw new Error(`Comparison field must be of type number or date for ${operator} rules`);
  }
  const { type } = tf.dataset;
  const a2 = type === 'number' ? parseInt(a, 10) : Date.parse(a);
  const b2 = type === 'number' ? parseInt(b, 10) : Date.parse(b);
  return [a2, b2];
}

function processRule(tf, operator, payloadKey, value, comparisonFunction) {
  if (payloadKey === '') return true;
  try {
    const [a, b] = processNumRule(tf, operator, payloadKey, value);
    return comparisonFunction(a, b);
    /* c8 ignore next 5 */
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`Invalid rule, ${e}`);
    return false;
  }
}

function applyRules(form, rules) {
  const payload = constructPayload(form);
  rules.forEach((field) => {
    const { type, condition: { key, operator, value } } = field.rule;
    const fw = form.querySelector(`[data-field-id=${field.fieldId}]`);
    const tf = form.querySelector(`[data-field-id=${key}]`);
    let force = false;
    switch (operator) {
      case RULE_OPERATORS.equal:
        force = (payload[key] === value);
        break;
      case RULE_OPERATORS.notEqual:
        force = (payload[key] !== value);
        break;
      case RULE_OPERATORS.includes:
        // Handle both boolean and array values
        if (typeof payload[key] === 'boolean') {
          force = payload[key] === true;
        } else if (Array.isArray(payload[key])) {
          force = payload[key].includes(value);
        } else if (typeof payload[key] === 'string') {
          force = payload[key].split(';').map((s) => s.trim()).includes(value);
        }
        break;
      case RULE_OPERATORS.excludes:
        // Handle both boolean and array values
        if (typeof payload[key] === 'boolean') {
          force = payload[key] === false;
        } else if (Array.isArray(payload[key])) {
          force = !payload[key].includes(value);
        } else if (typeof payload[key] === 'string') {
          force = (!payload[key].split(';').map((s) => s.trim()).includes(value));
        }
        break;
      case RULE_OPERATORS.lessThan:
        force = processRule(tf, operator, payload[key], value, (a, b) => a < b);
        break;
      case RULE_OPERATORS.lessThanOrEqual:
        force = processRule(tf, operator, payload[key], value, (a, b) => a <= b);
        break;
      case RULE_OPERATORS.greaterThan:
        force = processRule(tf, operator, payload[key], value, (a, b) => a > b);
        break;
      case RULE_OPERATORS.greaterThanOrEqual:
        force = processRule(tf, operator, payload[key], value, (a, b) => a >= b);
        break;
      default:
        // eslint-disable-next-line no-console
        console.warn(`Unsupported operator ${operator}`);
        return false;
    }
    fw.classList.toggle(type, force);
    return false;
  });
}

function lowercaseKeys(obj) {
  return Object.keys(obj).reduce((acc, key) => {
    acc[key.toLowerCase() === 'default' ? 'defval' : key.toLowerCase()] = obj[key];
    return acc;
  }, {});
}

async function loadConsent(form, consentData) {
  const { path, countryCode } = consentData;
  const submitWrapper = form.querySelector('.events-form-submit-wrapper');
  const submit = submitWrapper.querySelector('button');
  const termsWrapper = form.querySelector('.terms-and-conditions-wrapper');

  submit.disabled = true;
  termsWrapper.innerHTML = '';
  termsWrapper.classList.add('transparent');

  const termsFragLink = createTag('a', { href: `${new URL(path, import.meta.url).href}`, target: '_blank' }, path, { parent: termsWrapper });

  await loadFragment(termsFragLink);

  termsWrapper.classList.remove('transparent');

  const implicitRaw = getImplicitConsentRaw(termsWrapper, consentData);
  if (implicitRaw) {
    termsWrapper.dataset.implicitConsent = implicitRaw;
  } else {
    delete termsWrapper.dataset.implicitConsent;
  }

  const uls = termsWrapper.querySelectorAll('ul');

  const defval = '';
  const required = '';
  const type = 'checkbox';

  uls.forEach((ul) => {
    const pseudoCheckboxes = ul.querySelectorAll('li');
    if (countryCode === 'CN') {
      // FIXME: This is a temporary solution to handle the China case
      Array.from(pseudoCheckboxes).forEach((o) => {
        const valKebab = o.textContent.trim().replaceAll(' ', '-');
        const checkWrap = createTag('div', { class: 'check-item-wrap checkbox-input-wrap' });

        const checkbox = createTag('input', { id: valKebab, type: 'checkbox', class: 'submit-blocker no-submit check-item-input checkbox-input', value: valKebab });
        const checkboxButton = createTag('span', { class: 'check-item-button checkbox-button' });
        const label = createTag('label', { class: 'check-item-label checkbox-label', for: valKebab }, o.innerHTML);

        checkWrap.append(checkbox, checkboxButton, label);
        termsWrapper.append(checkWrap);
      });

      const allCheckboxes = termsWrapper.querySelectorAll('.submit-blocker');

      allCheckboxes.forEach((cb) => {
        cb.addEventListener('change', () => {
          const checkedCheckboxes = Array.from(allCheckboxes).filter((c) => c.checked);
          submit.disabled = checkedCheckboxes.length !== allCheckboxes.length;
        });
      });

      ul.remove();
    } else {
      const options = Array.from(pseudoCheckboxes).map((li) => li.textContent.trim()).join(';');

      if (!options) {
        submit.disabled = false;
        return;
      }

      const field = 'contactMethods';
      termsWrapper.append(createCheckGroup({ options, field, defval, required }, type));

      ul.remove();
    }
  });

  submitWrapper.before(termsWrapper);

  if (countryCode === 'CN') {
    const allCheckboxes = termsWrapper.querySelectorAll('.submit-blocker');
    const checkedCheckboxes = Array.from(allCheckboxes).filter((c) => c.checked);
    submit.disabled = checkedCheckboxes.length !== allCheckboxes.length;

    return;
  }

  submit.disabled = false;
}

function decorateSuccessScreen(screen) {
  if (!screen) return;

  screen.classList.add('form-success-msg');
  const subScreens = screen.querySelectorAll('div');

  const [firstScreen, secondScreen] = subScreens;

  subScreens.forEach((ss, i) => {
    ss.classList.add('hidden');
    const hgroup = createTag('hgroup');
    const eyeBrowText = ss.querySelector('p:first-child');
    const headings = ss.querySelectorAll('h1, h2, h3, h4, h5, h6');

    headings.forEach((h) => {
      hgroup.append(h);
    });

    if (eyeBrowText) {
      eyeBrowText.classList.add('eyebrow');
      hgroup.prepend(eyeBrowText);
    }

    ss.prepend(hgroup);

    if (i === 0) {
      ss.classList.add('first-screen');
      const firstScreenCtas = ss.querySelectorAll('a');

      firstScreenCtas.forEach((cta) => {
        const ctaUrl = new URL(cta.href);
        if (ctaUrl.hash.startsWith('#cancel')) {
          cta.parentElement.classList.add('post-rsvp-button-wrapper');
          cta.classList.add('con-button', 'outline', 'button-l', 'cancel-button');
        } else if (ctaUrl.hash.startsWith('#ok')) {
          cta.classList.add('con-button', 'black', 'button-l', 'ok-button');
        }

        cta.addEventListener('click', async (e) => {
          e.preventDefault();

          cta.classList.add('loading');

          if (cta.classList.contains('cancel-button')) {
            const profile = BlockMediator.get('imsProfile');
            const rsvpData = BlockMediator.get('rsvpData');

            if (profile.account_type === 'guest' && !rsvpData?.attendeeId) {
              cta.classList.remove('loading');
              buildErrorMsg(screen, 500);
              return;
            }

            const rsvpResp = profile.account_type === 'guest'
              ? await deleteAttendeeFromEvent(getMetadata('event-id'), rsvpData.attendeeId)
              : await deleteAttendeeFromEvent(getMetadata('event-id'));

            cta.classList.remove('loading');

            if (!rsvpResp.ok) {
              buildErrorMsg(screen, rsvpResp.status, rsvpResp.error);
              return;
            }

            const { data } = rsvpResp;
            const result = data?.espProvider || data;

            if (!result) {
              buildErrorMsg(screen, 500);
              return;
            }

            const espStatus = result.status;

            if ((espStatus && espStatus !== 204)) {
              buildErrorMsg(screen, espStatus);
              return;
            }

            BlockMediator.set('rsvpData', null);

            firstScreen.classList.add('hidden');
            secondScreen.classList.remove('hidden');
            cta.classList.remove('loading');
          }

          if (cta.classList.contains('ok-button')) {
            const modal = screen.closest('.dialog-modal');
            if (modal) closeModal(modal);
          }
        });
      });
    }

    if (i === 1) {
      ss.classList.add('second-screen');
      const secondScreenCtas = ss.querySelectorAll('a');

      secondScreenCtas.forEach((cta) => {
        const ctaUrl = new URL(cta.href);
        if (ctaUrl.hash.startsWith('#ok')) {
          cta.classList.add('con-button', 'black', 'button-l');
          cta.addEventListener('click', async (e) => {
            e.preventDefault();
            const modal = screen.closest('.dialog-modal');
            if (modal) closeModal(modal);
          });
        }
      });
    }
  });

  screen.classList.add('hidden');
}

async function getConsentQueryIndexUrl() {
  const eventConfig = getEventConfig();
  const miloConfig = eventConfig?.miloConfig;
  const libs = miloConfig?.miloLibs || LIBS;
  const { getLocale } = await import(`${libs}/utils/utils.js`);
  const { prefix } = getLocale(miloConfig?.locales || FALLBACK_LOCALES);
  const moduleUrl = new URL(import.meta.url);
  const domain = `${moduleUrl.protocol}//${moduleUrl.host}`;
  return `${domain}${prefix}/event-libs/assets/consents/consent-query-index.json`;
}

async function addConsentSuite(form) {
  const countryText = dictionaryManager.getValue('country', 'rsvp-fields');
  const fieldWrapper = createTag('div', { class: 'field-wrapper events-form-select-wrapper', 'data-field-id': 'country', 'data-type': 'select' });
  const label = createTag('label', { for: 'consentStringId', class: 'required' }, countryText);
  const countrySelect = createTag('select', { id: 'consentStringId', required: 'required' });
  const termsWrapper = createTag('div', {
    class: 'field-wrapper events-form-full-width terms-and-conditions-wrapper transparent',
    'data-field-id': 'contactMethods',
    'data-type': 'checkbox-group',
  });

  fieldWrapper.append(label, countrySelect);

  const queryIndexUrl = await getConsentQueryIndexUrl();
  const consentStringsIndex = await fetch(queryIndexUrl).then((r) => r.json());

  if (consentStringsIndex) {
    const { data } = consentStringsIndex;
    const defaultOption = createTag('option', { selected: '', disabled: '', value: '' }, countryText);
    countrySelect.append(defaultOption);

    data.forEach((c) => {
      const option = createTag('option', {
        value: c.countryCode,
        'data-country-code': c.countryCode,
        'data-consent-id': c.consentId,
      }, c.countryName);
      countrySelect.append(option);
    });

    countrySelect.addEventListener('change', async (e) => {
      const selectedOption = e.target.options[e.target.selectedIndex];
      const consentData = data.find((c) => c.countryCode === selectedOption?.dataset?.countryCode);

      if (consentData) {
        await loadConsent(form, consentData);
      }
    });
  }

  const submitWrapper = form.querySelector('.events-form-submit-wrapper');
  const eventTermsWrapper = form.querySelector('.event-terms-wrapper');

  if (eventTermsWrapper) {
    eventTermsWrapper.before(fieldWrapper);
    submitWrapper.before(termsWrapper);
  } else {
    submitWrapper.before(fieldWrapper, termsWrapper);
  }
}

export function addTerms(form, terms) {
  if (!terms || terms.textContent === '') return;
  const submitWrapper = form.querySelector('.events-form-submit-wrapper');
  const termsWrapper = createTag('div', { class: 'field-wrapper events-form-full-width event-terms-wrapper field-group-wrapper' });
  const cell = terms.querySelector(':scope > div') || terms;
  const termsContent = cell.querySelectorAll(':scope > p, :scope > ul, :scope > ol');

  termsContent.forEach((el) => {
    termsWrapper.append(el);
  });

  terms.remove();

  submitWrapper.before(termsWrapper);
}

export function getRsvpConfigFromMeta() {
  const raw = getMetadata('rsvp-config');
  if (!raw) return null;

  try {
    const config = JSON.parse(raw);
    if (!config.rsvpFormFields?.length) return null;

    const data = config.rsvpFormFields.map((f) => {
      const field = lowercaseKeys(f);
      if (typeof field.field === 'string') field.field = field.field.trim();
      field.type = field.type || 'text';
      field.required = field.required === true ? 'x' : '';
      if (Array.isArray(field.options)) {
        field.options = field.options.map((o) => (typeof o === 'object' ? o.value : o)).join(';');
      }
      // ESP's field `type` names only the substrate (text/select/multi-select);
      // `displayas` (EMC's displayAs, already stored by ESP) picks the concrete
      // widget within it. Remap to the internal dispatch types this file already
      // implements for the legacy per-cloud JSON path, so scope-config-driven
      // fields render identically. `checkbox` is a legacy wire value from before
      // this taxonomy, remapped to its own pre-existing default rather than
      // passed through, so old data keeps rendering exactly as it did. Any other
      // `type` (heading/legal/divider/submit/clear, or a legacy direct value
      // like `email`/`text-area`) passes through untouched.
      const da = field.displayas;
      if (field.type === 'text') {
        field.type = TEXT_DISPLAY_AS.has(da) ? da : 'text';
      }
      else if (field.type === 'select') {
        field.type = da === 'radio' ? 'radio-group' : 'select';
      }
      else if (field.type === 'multi-select') {
        field.type = da === 'combobox' ? 'multi-select' : 'checkbox-group';
      }
      else if (field.type === 'checkbox') {
        field.type = da === 'dropdown' ? 'multi-select' : 'checkbox';
      }
      return field;
    });

    if (!data.some((f) => f.type === 'submit')) {
      data.push({ field: 'Submit', type: 'submit', label: 'Submit', required: '', options: '' });
    }

    return { data };
  } catch (error) {
    logError('events-form', 'Failed to parse rsvp-config metadata', error);
    return null;
  }
}

async function createForm(bp, formData) {
  const { form, terms } = bp;

  const rsvpConfigData = getRsvpConfigFromMeta();

  let rsvpFieldsData;
  if (!rsvpConfigData) {
    try {
      rsvpFieldsData = JSON.parse(getMetadata('rsvp-form-fields'));
    } catch (error) {
      logError('events-form', 'Failed to parse partners metadata', error);
    }
  }

  let json = rsvpConfigData || formData;
  /* c8 ignore next 4 */
  if (!json) {
    const resp = await fetch(form.href);
    json = await resp.json();
  }

  await dictionaryManager.initialize();

  if (!rsvpConfigData) {
    if (rsvpFieldsData) {
      const { required, visible } = rsvpFieldsData;
      json.data = json.data
        .map((obj) => {
          const lowkey = lowercaseKeys(obj);
          if (typeof lowkey.field === 'string') lowkey.field = lowkey.field.trim();
          if (required.includes(lowkey.field)) lowkey.required = 'x';
          return lowkey;
        })
        .filter((f) => visible.includes(f.field) || ['clear', 'submit'].includes(f.field));
    } else {
      json.data = json.data
        .map((obj) => {
          const lowkey = lowercaseKeys(obj);
          if (typeof lowkey.field === 'string') lowkey.field = lowkey.field.trim();
          return lowkey;
        })
        .filter((f) => ['clear', 'submit'].includes(f.field));
    }
  }

  const formEl = createTag('form');
  const rules = [];
  if (form.href) {
    const [action] = new URL(form.href).pathname.split('.json');
    formEl.dataset.action = action;
  }

  const typeToElement = {
    'multi-select': { fn: createSelect, params: [], label: true, classes: [] },
    select: { fn: createSelect, params: ['something'], label: true, classes: [] },
    heading: { fn: createHeading, params: ['h3'], label: false, classes: [] },
    legal: { fn: createHeading, params: ['p'], label: false, classes: [] },
    checkbox: { fn: createCheckGroup, params: ['checkbox'], label: true, classes: ['field-group-wrapper'] },
    'checkbox-group': { fn: createCheckGroup, params: ['checkbox'], label: true, classes: ['field-group-wrapper'] },
    'radio-group': { fn: createCheckGroup, params: ['radio'], label: true, classes: ['field-group-wrapper'] },
    'text-area': { fn: createTextArea, params: [], label: true, classes: [] },
    submit: { fn: createButton, params: [bp], label: false, classes: ['field-button-wrapper'] },
    clear: { fn: createButton, params: [bp], label: false, classes: ['field-button-wrapper'] },
    divider: { fn: createDivider, params: [], label: false, classes: ['divider'] },
    default: { fn: createInput, params: [], label: true, classes: [] },
  };

  const sanitizeList = [];

  json.data.forEach(async (fd) => {
    fd.type = fd.type || 'text';
    fd.limit = parseRsvpFieldLimit(fd.limit);
    if (fd.type === 'text' || fd.type === 'text-area') sanitizeList.push(fd.field);
    const style = fd.extra ? ` events-form-${fd.extra}` : '';
    const fieldWrapper = createTag(
      'div',
      { class: `field-wrapper events-form-${fd.type}-wrapper${style}`, 'data-field-id': fd.field, 'data-type': fd.type },
    );

    const elParams = typeToElement[fd.type] || typeToElement.default;
    if (elParams.label) fieldWrapper.append(createlabel(fd));
    fieldWrapper.append(elParams.fn(fd, ...elParams.params));
    fieldWrapper.classList.add(...elParams.classes);

    if (fd.rules?.length) {
      try {
        rules.push({ fieldId: fd.field, rule: JSON.parse(fd.rules) });
        /* c8 ignore next 4 */
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`Invalid Rule ${fd.rules}: ${e}`);
      }
    }
    formEl.append(fieldWrapper);
  });

  addTerms(formEl, terms);

  const profile = BlockMediator.get('imsProfile');
  const showConsentForGuest = profile?.account_type === 'guest'
    && (getMetadata('allow-guest-registration') === 'true' || Boolean(profile?.rsvpToken));
  const forceConsent = getMetadata('force-consent-collection') === 'true';
  if (showConsentForGuest || forceConsent) await addConsentSuite(formEl);

  formEl.addEventListener('input', () => applyRules(formEl, rules));
  applyRules(formEl, rules);

  // close all custom-dropdown on click outside
  formEl.addEventListener('click', (e) => {
    const multiSelects = formEl.querySelectorAll('.multi-select-wrapper');

    if (multiSelects.length === 0) return;

    multiSelects.forEach((ms) => {
      const customDropdown = ms.querySelector('.custom-dropdown');
      const customSelect = ms.querySelector('.custom-select');

      if (!customDropdown.classList.contains('hidden') && !customSelect.contains(e.target) && !customDropdown.contains(e.target)) {
        customDropdown.classList.add('hidden');
      }
    });
  });

  decorateEvent(formEl);

  return {
    formEl,
    sanitizeList,
  };
}

function personalizeForm(form, data) {
  if (!data || !form) return;

  Object.entries(data).forEach(([key, value]) => {
    Object.entries(value).forEach(([k, v]) => {
      const matchedInput = form.querySelector(`#${snakeToCamel(k)}`);
      if (matchedInput && v && !matchedInput.v) {
        if (Array.isArray(v)) {
          v.forEach((val) => {
            const option = matchedInput.querySelector(`option[value="${val}"]`);
            if (option) option.selected = true;
          });
        } else if (matchedInput.id === 'consentStringId') {
          applyConsentCountrySelectValue(matchedInput, v);
          if (key === 'profile') matchedInput.disabled = true;
        } else {
          matchedInput.value = v;
          if (key === 'profile') matchedInput.disabled = true;
        }
        matchedInput.dispatchEvent(new Event('change'));
      }
    });
  });
}

function decorateHero(heroEl) {
  heroEl.classList.add('event-form-hero');
}

async function buildEventform(bp, formData) {
  if (!bp.formContainer || !bp.form) return;
  bp.formContainer.classList.add('form-container');
  const { formEl, sanitizeList } = await createForm(bp, formData);

  [bp.rsvpSuccessScreen, bp.waitlistSuccessScreen].forEach((screen) => {
    decorateSuccessScreen(screen);
  });

  if (formEl) {
    bp.form.replaceWith(formEl);
    bp.form = formEl;
    bp.sanitizeList = sanitizeList;
  }
}

function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}

export async function initFormBasedOnRSVPData(bp) {
  const { block } = bp;
  const profile = BlockMediator.get('imsProfile');
  let confirmationViewTracked = false;
  const syncUIWithRSVPStatus = (rsvpData = BlockMediator.get('rsvpData')) => {
    if (!VALID_REGISTRATION_STATUS.includes(rsvpData?.registrationStatus)) return false;
    showSuccessMsgFirstScreen(bp);
    if (!confirmationViewTracked) {
      eventFormSendAnalytics(bp, 'Confirmation Modal View');
      confirmationViewTracked = true;
    }
    return true;
  };

  BlockMediator.subscribe('rsvpData', ({ newValue }) => {
    syncUIWithRSVPStatus(newValue);
  });

  if (syncUIWithRSVPStatus()) return;

  if (profile && profile.account_type !== 'guest') {
    let existingAttendeeData = {};
    const attendeeResp = await getAttendee(getMetadata('event-id'));
    if (attendeeResp.ok) existingAttendeeData = attendeeResp.data;
    if (syncUIWithRSVPStatus()) return;
    personalizeForm(block, { existingAttendeeData, profile });
  }

  const countryInput = block.querySelector('select#consentStringId');
  if (countryInput && countryInput.value === '') {
    const options = Array.from(countryInput.options);
    const findOptionByCountryCode = (code) => {
      if (!code || typeof code !== 'string') return undefined;
      const lower = code.toLowerCase();
      return options.find((o) => o.dataset.countryCode?.toLowerCase() === lower);
    };
    const profileCode = profile?.countryCode;
    const cookieCode = getCookie('international_cookie');
    const navigatorRegion = window.navigator.language.toLowerCase().split('-')[1];
    const option = findOptionByCountryCode(profileCode)
      ?? findOptionByCountryCode(cookieCode)
      ?? (navigatorRegion ? findOptionByCountryCode(navigatorRegion) : undefined);
    if (option) {
      option.selected = true;
      countryInput.value = option.value;
      countryInput.dispatchEvent(new Event('change'));
    }
  }

  if (bp.block.querySelector('.form-success-msg.hidden')) {
    eventFormSendAnalytics(bp, 'Form View');
  }
}

export async function onProfile(bp, formData) {
  const { block, eventHero } = bp;
  const profile = BlockMediator.get('imsProfile');
  const allowGuestReg = getMetadata('allow-guest-registration') === 'true';
  let hasHandledProfile = false;
  const handleProfile = (resolvedProfile) => {
    if (resolvedProfile === undefined || hasHandledProfile) return;
    hasHandledProfile = true;
    const profileForGuestGate = resolvedProfile ?? { account_type: 'guest' };

    if (shouldForceGuestSignIn(profileForGuestGate, allowGuestReg)
      && /#rsvp-form.*/.test(window.location.hash)) {
      // TODO: also check for guestCheckout enablement for future iterations
      signIn(getSusiOptions(getConfig()));
    } else if (resolvedProfile?.rsvpTokenInvalid) {
      // RSVP token has already been used, expired, or was revoked. Show a
      // general error and never build the form — the token is not reusable.
      eventHero.classList.remove('loading');
      decorateHero(bp.eventHero);
      (async () => {
        await dictionaryManager.initialize();
        const msg = getRsvpTokenInvalidMessage(dictionaryManager);
        const error = createTag('p', { class: 'error' }, msg);
        bp.formContainer.append(error);
      })().finally(() => {
        block.classList.remove('loading');
      });
    } else {
      eventHero.classList.remove('loading');
      decorateHero(bp.eventHero);
      (async () => {
        let eventData = BlockMediator.get('eventData');
        if (!eventData) {
          const eventResp = await getEvent(getMetadata('event-id'));
          if (eventResp.ok) BlockMediator.set('eventData', eventResp.data);
          eventData = BlockMediator.get('eventData');
        }
        if (eventData?.inviteOnly && !getValidCampaignIdFromUrl()) {
          await dictionaryManager.initialize();
          const msg = getInviteOnlyNoCampaignMessage(dictionaryManager);
          const error = createTag('p', { class: 'error' }, msg);
          bp.formContainer.append(error);
        } else {
          await buildEventform(bp, formData);
          initFormBasedOnRSVPData(bp);
        }
      })().finally(() => {
        decorateDefaultLinkAnalytics(block);
        block.classList.remove('loading');
      });
    }
  };

  if (profile !== undefined) {
    handleProfile(profile);
  } else {
    const unsubscribe = BlockMediator.subscribe('imsProfile', ({ newValue }) => {
      handleProfile(newValue);
      if (hasHandledProfile) unsubscribe();
    });
  }
}

async function decorateToastArea() {
  await Promise.all([
    import(`${miloLibs}/deps/lit-all.min.js`),
    import(`${miloLibs}/features/spectrum-web-components/dist/theme.js`),
    import(`${miloLibs}/features/spectrum-web-components/dist/toast.js`),
  ]);
  const toastArea = createTag('sp-theme', { color: 'light', scale: 'medium', class: 'toast-area' });
  document.body.append(toastArea);
  return toastArea;
}

function getRsvpConfigUrl() {
  // Get the domain from import.meta.url
  const moduleUrl = new URL(import.meta.url);
  const domain = `${moduleUrl.protocol}//${moduleUrl.host}`;
  
  // Get cloud type (creativecloud or experiencecloud)
  const cloudType = getMetadata('cloud-type');
  if (!cloudType) {
    throw new Error('cloud-type metadata is required');
  }
  
  return `${domain}/event-libs/assets/configs/rsvp/${cloudType.toLowerCase()}.json`;
}

function getFormLink(block, bp) {
  const legacyLink = block.querySelector(':scope > div:nth-of-type(2) a[href$=".json"]');
  const form = createTag('a');

  if (!getRsvpConfigFromMeta()) {
    try {
      form.href = getRsvpConfigUrl();
    } catch (error) {
      logError('events-form', 'Error getting RSVP config URL', error);
      throw error;
    }

    if (legacyLink) {
      legacyLink.href = form.href;
      return legacyLink;
    }
  }

  bp.formContainer.append(form);
  return form;
}

export default async function decorate(block, formData = null) {
  block.classList.add('loading');

  const toastArea = await decorateToastArea();

  const eventHero = block.querySelector(':scope > div:nth-of-type(1)');
  const hasLegacyLink = block.querySelector(':scope > div:nth-of-type(2) a[href$=".json"]');
  let formContainer;
  if (hasLegacyLink) {
    formContainer = block.querySelector(':scope > div:nth-of-type(2)');
  } else {
    const hasEmptyFormContainer = block.querySelector(':scope > div:nth-of-type(2)').innerHTML.trim() === '';
    if (hasEmptyFormContainer) {
      formContainer = block.querySelector(':scope > div:nth-of-type(2)');
    } else {
      formContainer = createTag('div');
      eventHero.after(formContainer);
    }
  }

  const bp = {
    block,
    toastArea,
    eventHero,
    formContainer,
    terms: block.querySelector(':scope > div:nth-of-type(3)'),
    rsvpSuccessScreen: block.querySelector(':scope > div:nth-of-type(4)'),
    waitlistSuccessScreen: block.querySelector(':scope > div:nth-of-type(5)'),
  };

  bp.form = getFormLink(block, bp);

  await onProfile(bp, formData);
}
