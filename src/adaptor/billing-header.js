/**
 * Billing header detection and removal utility.
 *
 * Claude Code inserts x-anthropic-billing-header into the system prompt
 * at the beginning of every request. This module handles detection
 * and removal of that header from both system text and request headers.
 */

// Pattern: x-anthropic-billing-header: ... cch=xxxxx;\n\n
const BILLING_HEADER_REGEX = /^x-anthropic-billing-header:\s*cc_version=[^;]+;\s*cc_entrypoint=[^;]+;\s*cch=[a-z0-9]{5};?\s*(?:\r?\n){1,2}/im;

const BILLING_HEADER_NAME = 'x-anthropic-billing-header';

/**
 * Check if a string starts with the billing header pattern.
 * @param {string} text
 * @returns {boolean}
 */
function hasBillingHeader(text) {
  if (typeof text !== 'string') return false;
  return BILLING_HEADER_REGEX.test(text);
}

/**
 * Remove the billing header from the beginning of a string.
 * @param {string} text
 * @returns {string} Cleaned text
 */
function stripBillingHeader(text) {
  if (typeof text !== 'string') return text;
  return text.replace(BILLING_HEADER_REGEX, '');
}

/**
 * Remove the billing header from system prompt(s).
 * Handles both string and array formats.
 * @param {string|object[]|null|undefined} system
 * @returns {string|object[]|null|undefined} Cleaned system prompt
 */
function stripBillingHeaderFromSystem(system) {
  if (system == null) return system;

  if (typeof system === 'string') {
    const cleaned = stripBillingHeader(system);
    return cleaned !== system ? cleaned : system;
  }

  if (Array.isArray(system)) {
    let changed = false;
    const cleaned = system.map((block) => {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        const newText = stripBillingHeader(block.text);
        if (newText !== block.text) {
          changed = true;
          return { ...block, text: newText };
        }
      }
      return block;
    });
    return changed ? cleaned : system;
  }

  return system;
}

/**
 * Remove the billing header from request headers object.
 * @param {object} headers - Request headers (lowercase keys)
 * @returns {object} Cleaned headers
 */
function stripBillingHeaderFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;

  const result = { ...headers };
  // Check both possible casings
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === BILLING_HEADER_NAME) {
      delete result[key];
    }
  }
  return result;
}

module.exports = {
  BILLING_HEADER_REGEX,
  BILLING_HEADER_NAME,
  hasBillingHeader,
  stripBillingHeader,
  stripBillingHeaderFromSystem,
  stripBillingHeaderFromHeaders,
};
