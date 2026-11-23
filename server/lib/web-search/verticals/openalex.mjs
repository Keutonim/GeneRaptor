/**
 * OpenAlex vertical — scientific works, citations and venues.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless and official: the key is optional, the anonymous pool is limited
 * (10 requests/s and a $0.10/day budget shared by the whole IP —
 * results/search-verticals-api-spec.md §3.1 [оф+live]) and the provider
 * answers HTTP 429 when the budget is spent.
 */
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from '../http.mjs';
import { fetchVerticalJson, toSnippet } from './http.mjs';
import { VERTICAL_ENDPOINTS } from '../endpoints.mjs';

export const id = 'openalex';
export const label = 'OpenAlex';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const vertical = true;
export const description =
  'Научные публикации, авторы и цитируемость: открытый индекс работ OpenAlex.';
export const notes =
  'Без ключа и без карты. Анонимный пул: до 10 запросов в секунду и общий дневной бюджет $0.10 на IP; при исчерпании провайдер отвечает HTTP 429.';

const MAX_ROWS = 100;

/** The vertical is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * @param {object} work
 * @returns {string}
 */
export function workUrl(work) {
  const landing = String(work?.primary_location?.landing_page_url ?? '').trim();
  if (landing) return landing;
  const doi = String(work?.doi ?? '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return doi ? `https://doi.org/${doi}` : '';
}

/**
 * Rebuilds the plaintext abstract from the OpenAlex inverted index.
 *
 * OpenAlex ships no plaintext abstract for legal reasons — every word is
 * mapped to its positions and the client must reconstruct the text
 * (results/search-verticals-api-spec.md §3.2 [оф]). The pairs are sorted by
 * ascending position and joined; a malformed index degrades to an empty
 * string, never to a thrown error.
 *
 * @param {object|null} index abstract_inverted_index (word → positions)
 * @returns {string}
 */
export function reconstructAbstract(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return '';
  const pairs = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      const at = Number(position);
      if (Number.isInteger(at) && at >= 0) pairs.push([at, String(word)]);
    }
  }
  if (!pairs.length) return '';
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map(([, word]) => word).join(' ');
}

/**
 * @param {object} work
 * @returns {string}
 */
export function workSnippet(work) {
  // The abstract is the primary snippet (spec §3.2 [оф+live]); when the work
  // has no inverted index, the descriptive line carries the snippet, and the
  // title is the last resort — the snippet never stays empty for a named work.
  const abstract = toSnippet(reconstructAbstract(work?.abstract_inverted_index));
  if (abstract) return abstract;
  const authors = Array.isArray(work?.authorships)
    ? work.authorships
      .map((entry) => String(entry?.author?.display_name ?? '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(', ')
    : '';
  const venue = String(work?.primary_location?.source?.display_name ?? '').trim();
  const year = String(work?.publication_year ?? '').trim();
  const descriptive = [authors, venue, year].filter(Boolean).join(' — ');
  if (descriptive) return descriptive;
  return String(work?.display_name ?? work?.title ?? '').trim();
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

  const rows = Math.min(Math.max(1, Number(limit) || 5), MAX_ROWS);
  const url = `${VERTICAL_ENDPOINTS.openalex}?search=${encodeURIComponent(text)}&per_page=${rows}`;

  const payload = await fetchVerticalJson(url, { scope: id, fetchImpl, signal, timeoutMs });
  const works = payload?.results;
  if (!Array.isArray(works)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'OpenAlex вернул неожиданный формат ответа',
    );
  }

  const results = works.map((work) => ({
    // display_name is "String or null"; `title` is its official alias
    // (spec §3.2 [оф]) — a null display_name must not drop the work.
    title: String(work?.display_name || work?.title || ''),
    url: workUrl(work),
    snippet: workSnippet(work),
  }));

  return normalizeSearchResults(results, limit);
}
