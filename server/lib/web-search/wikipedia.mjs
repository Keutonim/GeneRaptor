/**
 * Wikipedia backend — official MediaWiki Action API (CirrusSearch).
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless, free and official: this is the guaranteed-free fallback layer of
 * the search chain. MediaWiki etiquette requires a descriptive User-Agent
 * with contact information — otherwise the IP may be blocked without notice —
 * so the shared research User-Agent is sent on every request. Per-wiki rate
 * limits exist; the API reports them with the `ratelimited` error code.
 */
import { researchUserAgent } from '../research-user-agent.mjs';
import { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
import { fetchWithTimeout, normalizeSearchResults, DEFAULT_TIMEOUT_MS } from './http.mjs';
import { wikipediaApiEndpoint, WIKIPEDIA_HOSTS, WIKIPEDIA_DEFAULT_HOST } from './endpoints.mjs';

export const id = 'wikipedia';
export const label = 'Wikipedia (MediaWiki API)';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const description =
  'Официальный keyless-слой: MediaWiki Action API (CirrusSearch) — гарантированно бесплатная энциклопедия.';
export const notes =
  'Без ключа и без карты. Отправляется User-Agent с контактом (этика MediaWiki). Лимиты per-wiki, при превышении — ошибка ratelimited.';

const MAX_LIMIT = 50;

const HTML_ENTITIES = {
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&amp;': '&',
};

/** The encyclopedic layer is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * Strips the search-highlight markup MediaWiki puts into the snippet.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripMarkup(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(quot|apos|#39|lt|gt|nbsp|amp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} query
 * @param {object} [options]
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function search(query, options = {}) {
  const {
    limit = 5,
    lang = 'ru',
    fetchImpl,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const text = String(query || '').trim();
  if (!text) {
    throw new WebSearchError(SEARCH_ERROR_CODES.EMPTY_QUERY, 'Пустой поисковый запрос');
  }

  const host = WIKIPEDIA_HOSTS[lang] || WIKIPEDIA_DEFAULT_HOST;
  const endpoint = wikipediaApiEndpoint(lang);
  const url = `${endpoint}?action=query&list=search&srsearch=${encodeURIComponent(text)}` +
    `&srlimit=${Math.min(Math.max(1, Number(limit) || 5), MAX_LIMIT)}&srprop=snippet&format=json&formatversion=2&utf8=1`;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': researchUserAgent('web search (wikipedia)'),
      },
    },
    { timeoutMs, signal, fetchImpl },
  );

  const payload = response?.json ? await response.json().catch(() => null) : null;

  const errorCode = String(payload?.error?.code || '').toLowerCase();
  if (response?.status === 429 || errorCode === 'ratelimited') {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.QUOTA_EXHAUSTED,
      'Превышен лимит запросов к Wikipedia (ratelimited)',
    );
  }
  if (!response?.ok) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.HTTP_ERROR,
      `Wikipedia ответил HTTP ${response?.status ?? 'unknown'}`,
    );
  }

  const hits = payload?.query?.search;
  if (!Array.isArray(hits)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Wikipedia вернул неожиданный формат ответа',
    );
  }

  const results = hits.map((item) => ({
    title: String(item?.title ?? ''),
    url: `https://${host}/wiki/${encodeURIComponent(String(item?.title ?? ''))}`,
    snippet: stripMarkup(item?.snippet),
  }));

  return normalizeSearchResults(results, limit);
}
