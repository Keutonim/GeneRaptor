/**
 * Wikidata backend — official MediaWiki Action API (entity search).
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless, free and official. Wikidata complements Wikipedia with structured
 * facts (entities, dates, labels) and is the last guaranteed-free layer of
 * the search chain before the graceful empty result.
 */
import { researchUserAgent } from '../research-user-agent.mjs';
import { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
import { fetchWithTimeout, normalizeSearchResults, DEFAULT_TIMEOUT_MS } from './http.mjs';
import { wikidataApiEndpoint } from './endpoints.mjs';

export const id = 'wikidata';
export const label = 'Wikidata (MediaWiki API)';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const description =
  'Официальный keyless-слой: Wikidata Action API — структурированные факты, сущности, даты.';
export const notes =
  'Без ключа и без карты. Отправляется User-Agent с контактом (этика MediaWiki). Лимиты per-wiki, при превышении — ошибка ratelimited.';

const MAX_LIMIT = 50;

/** The factual layer is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * Extracts the entity id from `concepturi` (`http://www.wikidata.org/entity/Q42`).
 *
 * @param {object} item
 * @returns {string}
 */
export function entityId(item) {
  const concept = String(item?.concepturi || '');
  const fromConcept = concept.split('/').filter(Boolean).pop();
  return fromConcept || String(item?.id || '');
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

  const endpoint = wikidataApiEndpoint(lang);
  const url = `${endpoint}?action=wbsearchentities&search=${encodeURIComponent(text)}` +
    `&language=${lang === 'en' ? 'en' : 'ru'}&uselang=${lang === 'en' ? 'en' : 'ru'}` +
    `&type=item&limit=${Math.min(Math.max(1, Number(limit) || 5), MAX_LIMIT)}&format=json`;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': researchUserAgent('web search (wikidata)'),
      },
    },
    { timeoutMs, signal, fetchImpl },
  );

  const payload = response?.json ? await response.json().catch(() => null) : null;

  const errorCode = String(payload?.error?.code || '').toLowerCase();
  if (response?.status === 429 || errorCode === 'ratelimited') {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.QUOTA_EXHAUSTED,
      'Превышен лимит запросов к Wikidata (ratelimited)',
    );
  }
  if (!response?.ok) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.HTTP_ERROR,
      `Wikidata ответил HTTP ${response?.status ?? 'unknown'}`,
    );
  }

  const hits = payload?.search;
  if (!Array.isArray(hits)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Wikidata вернул неожиданный формат ответа',
    );
  }

  const results = hits.map((item) => {
    const id = entityId(item);
    return {
      title: String(item?.label || id),
      url: `https://www.wikidata.org/wiki/${id}`,
      snippet: String(item?.description || ''),
    };
  });

  return normalizeSearchResults(results, limit);
}
