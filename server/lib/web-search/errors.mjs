/**
 * Typed errors for the pluggable web-search layer.
 *
 * Every backend failure is expressed as a `WebSearchError` with a stable
 * `code`, so the facade can degrade gracefully (empty result set + reason)
 * instead of propagating provider-specific exceptions.
 */

export const SEARCH_ERROR_CODES = Object.freeze({
  EMPTY_QUERY: 'empty_query',
  NOT_CONFIGURED: 'not_configured',
  /**
   * The keyless mode of a backend was refused by the provider (no key is
   * involved — the provider declined to serve an anonymous request).
   */
  KEYLESS_UNAVAILABLE: 'keyless_unavailable',
  NETWORK_UNAVAILABLE: 'network_unavailable',
  TIMEOUT: 'timeout',
  BLOCKED: 'blocked',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  HTTP_ERROR: 'http_error',
  INVALID_RESPONSE: 'invalid_response',
  INTERNAL_ERROR: 'internal_error',
});

export class WebSearchError extends Error {
  /**
   * @param {string} code one of SEARCH_ERROR_CODES
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'WebSearchError';
    this.code = code;
  }
}
