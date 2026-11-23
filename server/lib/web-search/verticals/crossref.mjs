/**
 * Crossref vertical — DOI metadata of publications and journals.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless and official. The public pool is limited (5 requests/s, one
 * concurrent request); the provider answers HTTP 429 on a violation and
 * HTTP 403 to a blocked client.
 */
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from '../http.mjs';
import { fetchVerticalJson, toSnippet } from './http.mjs';
import { VERTICAL_ENDPOINTS } from '../endpoints.mjs';

export const id = 'crossref';
export const label = 'Crossref';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const vertical = true;
export const description =
  'Издательские метаданные: DOI, издатели, журналы и выпуски — реестр Crossref.';
export const notes =
  'Без ключа и без карты. Публичный пул ограничен (5 запросов в секунду, один одновременный запрос), при превышении — HTTP 429.';

const MAX_ROWS = 100;

/** The vertical is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * @param {object} item
 * @returns {string}
 */
export function itemUrl(item) {
  const url = String(item?.URL ?? '').trim();
  if (url) return url;
  const doi = String(item?.DOI ?? '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return doi ? `https://doi.org/${doi}` : '';
}

/**
 * @param {object} item
 * @returns {string}
 */
export function itemSnippet(item) {
  // The abstract is the primary snippet when the record carries one
  // (spec §4.2 [live]); it may be JATS-like XML, so it is cleaned and cut.
  const abstract = toSnippet(item?.abstract ?? '');
  if (abstract) return abstract;
  // NOTE: the imprint field of Crossref is deliberately not used here — the
  // name of that field is a stripped-feature token of the repository gate
  // (tests/unit/generaptor-strip-gate.test.mjs), and the journal + the year
  // carry the same information for the reader.
  const container = Array.isArray(item?.['container-title'])
    ? String(item['container-title'][0] ?? '').trim()
    : '';
  const year = item?.issued?.['date-parts']?.[0]?.[0];
  return [container, year ? String(year) : ''].filter(Boolean).join(' — ');
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
  const url = `${VERTICAL_ENDPOINTS.crossref}?query.bibliographic=${encodeURIComponent(text)}&rows=${rows}`;

  const payload = await fetchVerticalJson(url, { scope: id, fetchImpl, signal, timeoutMs });
  const items = payload?.message?.items;
  if (!Array.isArray(items)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Crossref вернул неожиданный формат ответа',
    );
  }

  const results = items.map((item) => ({
    title: Array.isArray(item?.title) ? String(item.title[0] ?? '') : String(item?.title ?? ''),
    url: itemUrl(item),
    snippet: itemSnippet(item),
  }));

  return normalizeSearchResults(results, limit);
}
