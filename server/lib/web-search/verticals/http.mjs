/**
 * Shared HTTP helper of the narrow verticals.
 *
 * Every vertical is keyless and official: it takes no credential, so there is
 * nothing to bind and nothing to leak. The helper centralises the parts that
 * must not differ between the domains:
 *   - the research User-Agent (contract D19 — Wikimedia, Nominatim, OpenLibrary
 *     and Crossref explicitly require a descriptive User-Agent);
 *   - the mapping of the provider status codes onto the stable degradation
 *     codes of the layer (429/402 → quota exhausted, 401/403 → not configured,
 *     any other failure → http error, broken body → invalid response).
 */
import { researchUserAgent } from '../../research-user-agent.mjs';
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { fetchWithTimeout } from '../http.mjs';

/**
 * Performs the GET request of a vertical and returns the parsed JSON body.
 *
 * @param {string} url canonical endpoint with the query
 * @param {object} options
 * @param {string} options.scope short source attribution for the User-Agent
 * @param {Function} [options.fetchImpl] injected fetch (tests)
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.headers] extra headers (never credentials)
 * @returns {Promise<any>}
 */
export async function fetchVerticalJson(url, options = {}) {
  const { scope, fetchImpl, signal, timeoutMs, headers = {} } = options;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': researchUserAgent(`web search (${scope})`),
        ...headers,
      },
    },
    { timeoutMs, signal, fetchImpl },
  );

  const status = Number(response?.status) || 0;

  if (status === 429 || status === 402) {
    // 429 — the rate limit of the tier; 402 — the free budget is spent.
    throw new WebSearchError(
      SEARCH_ERROR_CODES.QUOTA_EXHAUSTED,
      `${scope}: исчерпан лимит запросов провайдера (HTTP ${status})`,
    );
  }
  if (status === 401 || status === 403) {
    // A keyless provider answers 403 when it refuses to serve the client.
    throw new WebSearchError(
      SEARCH_ERROR_CODES.NOT_CONFIGURED,
      `${scope}: провайдер отклонил запрос (HTTP ${status})`,
    );
  }
  if (!response?.ok) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.HTTP_ERROR,
      `${scope} ответил HTTP ${status || 'unknown'}`,
    );
  }

  const payload = await response.json().catch(() => null);
  if (payload === null || payload === undefined) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      `${scope} вернул неожиданный формат ответа`,
    );
  }
  return payload;
}

/**
 * Cuts a provider text down to a snippet size and removes HTML markup.
 *
 * @param {any} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function toSnippet(value, maxLength = 300) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}
