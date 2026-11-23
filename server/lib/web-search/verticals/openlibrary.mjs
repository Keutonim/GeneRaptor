/**
 * OpenLibrary vertical — books, authors and editions.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless and official. The usage policy allows 1 request per second
 * without identification (3 with a User-Agent and an email); the throttler
 * keeps the client inside the published limit.
 */
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from '../http.mjs';
import { fetchVerticalJson } from './http.mjs';
import { createThrottle } from './throttle.mjs';
import { VERTICAL_ENDPOINTS } from '../endpoints.mjs';

export const id = 'openlibrary';
export const label = 'OpenLibrary';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const vertical = true;
export const description =
  'Книги, авторы и издания: открытый каталог Open Library.';
export const notes =
  'Без ключа и без карты. Политика провайдера: 1 запрос в секунду без идентификации — этот лимит соблюдает троттлер.';

const MAX_LIMIT = 100;
const MIN_INTERVAL_MS = 1000;

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
 * @param {object} doc
 * @returns {string}
 */
export function bookUrl(doc) {
  const key = String(doc?.key ?? '').trim();
  return key ? `https://openlibrary.org${key}` : '';
}

/**
 * @param {object} doc
 * @returns {string}
 */
export function bookSnippet(doc) {
  const authors = Array.isArray(doc?.author_name)
    ? doc.author_name.slice(0, 3).map((name) => String(name ?? '').trim()).filter(Boolean).join(', ')
    : '';
  const year = String(doc?.first_publish_year ?? '').trim();
  return [authors, year].filter(Boolean).join(' — ');
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

  const count = Math.min(Math.max(1, Number(limit) || 5), MAX_LIMIT);
  const url = `${VERTICAL_ENDPOINTS.openlibrary}?q=${encodeURIComponent(text)}` +
    `&fields=key,title,author_name,first_publish_year&limit=${count}`;

  const payload = await fetchVerticalJson(url, { scope: id, fetchImpl, signal, timeoutMs });
  const docs = payload?.docs;
  if (!Array.isArray(docs)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'OpenLibrary вернул неожиданный формат ответа',
    );
  }

  const results = docs.map((doc) => ({
    title: String(doc?.title ?? ''),
    url: bookUrl(doc),
    snippet: bookSnippet(doc),
  }));

  return normalizeSearchResults(results, limit);
}
