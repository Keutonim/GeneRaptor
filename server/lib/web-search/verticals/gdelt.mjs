/**
 * GDELT vertical — world news and events.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless and official. The provider publishes the limits: at most 250
 * articles per request and the window of the last 3 months. The live 429
 * body of the API asks for "one request every 5 seconds"
 * (results/search-verticals-api-spec.md §6.3 / conflict 8 [live]) — the
 * throttler keeps the client inside that interval.
 */
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from '../http.mjs';
import { fetchVerticalJson } from './http.mjs';
import { createThrottle } from './throttle.mjs';
import { VERTICAL_ENDPOINTS } from '../endpoints.mjs';

export const id = 'gdelt';
export const label = 'GDELT';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const vertical = true;
export const description =
  'Мировые новости и события: публичный индекс мировых СМИ с окном в три месяца.';
export const notes =
  'Без ключа и без карты. Не более 250 статей за запрос, окно — последние 3 месяца; интервал между запросами — не менее 5 секунд (требование самого API).';

const MAX_RECORDS = 250;
const WINDOW = '3m';
const MIN_INTERVAL_MS = 5000;

const throttle = createThrottle(MIN_INTERVAL_MS);

/** The vertical is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/** Reset the throttle (used by the tests and by a manual restart). */
export function resetThrottle() {
  throttle.reset();
}

/**
 * @param {object} article
 * @returns {string}
 */
export function articleSnippet(article) {
  const domain = String(article?.domain ?? '').trim();
  const seen = String(article?.seendate ?? '').trim();
  const language = String(article?.language ?? '').trim();
  return [domain, seen, language].filter(Boolean).join(' — ');
}

/**
 * @param {string} query
 * @param {object} [options]
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function search(query, options = {}) {
  const { limit = 5, fetchImpl, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const text = String(query || '').trim();
  if (!text) {
    throw new WebSearchError(SEARCH_ERROR_CODES.EMPTY_QUERY, 'Пустой поисковый запрос');
  }

  await throttle({ now: options.now, sleep: options.sleep });

  const maxRecords = Math.min(Math.max(1, Number(limit) || 5), MAX_RECORDS);
  // The official GDELT DOC 2.0 documentation names the output mode `ArtList`
  // (capital A and L) — results/search-verticals-api-spec.md §6.1 [оф].
  const url = `${VERTICAL_ENDPOINTS.gdelt}?query=${encodeURIComponent(text)}` +
    `&mode=ArtList&format=json&maxrecords=${maxRecords}&timespan=${WINDOW}`;

  const payload = await fetchVerticalJson(url, { scope: id, fetchImpl, signal, timeoutMs });
  const articles = payload?.articles;
  if (!Array.isArray(articles)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'GDELT вернул неожиданный формат ответа',
    );
  }

  const results = articles.map((article) => ({
    title: String(article?.title ?? ''),
    url: String(article?.url ?? ''),
    snippet: articleSnippet(article),
  }));

  return normalizeSearchResults(results, limit);
}
