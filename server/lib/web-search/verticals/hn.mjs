/**
 * Hacker News vertical — startups and tech discussions (Algolia HN Search).
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless and official. No numeric limit is published, so the request stays
 * small (at most 10 hits per request).
 */
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from '../http.mjs';
import { fetchVerticalJson, toSnippet } from './http.mjs';
import { VERTICAL_ENDPOINTS } from '../endpoints.mjs';

export const id = 'hn';
export const label = 'Hacker News';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const vertical = true;
export const description =
  'Стартапы и технологические обсуждения: поиск по архиву Hacker News.';
export const notes =
  'Без ключа и без карты. Числовые лимиты не опубликованы, поэтому запрос ограничен десятью записями.';

const MAX_HITS = 10;

/** The vertical is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * @param {object} hit
 * @returns {string}
 */
export function hitUrl(hit) {
  // A comment hit has url:null (spec §10 [live]) — the story url is the next
  // best target, and the HN discussion item is the last resort.
  const url = String(hit?.url ?? '').trim();
  if (url) return url;
  const storyUrl = String(hit?.story_url ?? '').trim();
  if (storyUrl) return storyUrl;
  const objectId = String(hit?.objectID ?? '').trim();
  return objectId ? `https://news.ycombinator.com/item?id=${objectId}` : '';
}

/**
 * @param {object} hit
 * @returns {string}
 */
export function hitSnippet(hit) {
  // A comment carries its text in comment_text, a text story in story_text
  // (spec §10 [live]); both are HTML and are cleaned like any provider text.
  const text = toSnippet(hit?.story_text ?? hit?.comment_text ?? '');
  if (text) return text;
  const points = Number(hit?.points ?? 0);
  const comments = Number(hit?.num_comments ?? 0);
  return `${points} points, ${comments} comments`;
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

  const hitsPerPage = Math.min(Math.max(1, Number(limit) || 5), MAX_HITS);
  // No tags filter: comment hits (title:null, spec §10 [live]) must be able
  // to arrive — the mapper below handles both stories and comments.
  const url = `${VERTICAL_ENDPOINTS.hn}?query=${encodeURIComponent(text)}` +
    `&hitsPerPage=${hitsPerPage}`;

  const payload = await fetchVerticalJson(url, { scope: id, fetchImpl, signal, timeoutMs });
  const hits = payload?.hits;
  if (!Array.isArray(hits)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Hacker News вернул неожиданный формат ответа',
    );
  }

  const results = hits.map((hit) => ({
    title: String(hit?.title ?? hit?.story_title ?? ''),
    url: hitUrl(hit),
    snippet: hitSnippet(hit),
  }));

  return normalizeSearchResults(results, limit);
}
