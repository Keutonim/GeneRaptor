/**
 * Small HTTP helper for the web-search backends.
 *
 * It centralises the timeout / abort handling and converts any transport
 * failure into a typed `WebSearchError` — the search layer must never let a
 * network problem escape as an unhandled rejection.
 */
import { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
import { unwrapRedirectUrl } from './redirect-unwrap.mjs';

export const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * @param {string} url
 * @param {object} [options] fetch options (method, headers, body)
 * @param {object} [config]
 * @param {number} [config.timeoutMs]
 * @param {AbortSignal} [config.signal]
 * @param {Function} [config.fetchImpl] injected fetch (tests)
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, config = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    fetchImpl,
  } = config;

  // Resolved lazily so a stubbed globalThis.fetch is honoured.
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new WebSearchError(SEARCH_ERROR_CODES.NETWORK_UNAVAILABLE, 'fetch недоступен в этом окружении');
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await doFetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new WebSearchError(SEARCH_ERROR_CODES.TIMEOUT, 'Поисковый backend не ответил вовремя');
    }
    throw new WebSearchError(
      SEARCH_ERROR_CODES.NETWORK_UNAVAILABLE,
      `Сеть недоступна: ${err?.message || 'unknown error'}`,
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Normalises a backend result set to the shared contract
 * `{ title, url, snippet }` and drops malformed entries.
 *
 * The optional `provider` is the id of the source that produced the item.
 * It is additive: the contract of the three mandatory fields does not change,
 * but the caller can tell a narrow vertical source from the main engine
 * instead of seeing every item under one name.
 *
 * This is the SINGLE application point of the redirect-wrapper policy.
 * It stands above `mergeResults` (dedup by canonical signature) and above the
 * worker persistence, so a wrapper is unwrapped to its real target before any
 * dedup can collapse it. Filter order: scheme → unwrap → limit. An
 * unwrappable wrapper is dropped; one console.warn per call reports the
 * dropped count and rule ids only — never full URLs, never keys.
 *
 * @param {any} results
 * @param {number} limit
 * @param {string|null} [provider] id of the producing backend
 * @returns {Array<{title: string, url: string, snippet: string, provider?: string}>}
 */
export function normalizeSearchResults(results, limit, provider = null) {
  if (!Array.isArray(results)) return [];
  const out = [];
  const droppedWrapperIds = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title ?? '').trim();
    let url = String(item.url ?? '').trim();
    const snippet = String(item.snippet ?? '').trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const unwrapped = unwrapRedirectUrl(url);
    if (unwrapped.status === 'dropped') {
      droppedWrapperIds.push(unwrapped.wrapper);
      continue;
    }
    if (unwrapped.status === 'unwrapped') url = unwrapped.url;
    const normalized = { title, url, snippet };
    const source = String(provider ?? item.provider ?? '').trim();
    if (source) normalized.provider = source;
    out.push(normalized);
    if (out.length >= limit) break;
  }
  if (droppedWrapperIds.length) {
    const ids = [...new Set(droppedWrapperIds)].join(', ');
    console.warn(`[web-search] Отброшено redirect-обёрток: ${droppedWrapperIds.length} (${ids})`);
  }
  return out;
}
