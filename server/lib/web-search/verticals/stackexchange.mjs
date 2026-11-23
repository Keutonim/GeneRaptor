/**
 * StackExchange vertical — practical programming questions.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless and official. The live keyless wrapper reports quota_max: 300 per
 * day per IP (results/search-verticals-api-spec.md, conflict 1 [live]); the
 * official 10 000/day default applies to applications with a registered key
 * [оф /docs/throttle]. The hard parallel limit is 30 requests/s per IP [оф].
 * The quota is read from the wrapper (quota_remaining), and a `backoff` value
 * is treated as an exhausted quota instead of hammering the endpoint.
 */
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from '../http.mjs';
import { fetchVerticalJson, toSnippet } from './http.mjs';
import { VERTICAL_ENDPOINTS } from '../endpoints.mjs';

export const id = 'stackexchange';
export const label = 'Stack Exchange';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const vertical = true;
export const description =
  'Практические вопросы по программированию: база ответов сообщества Stack Exchange.';
export const notes =
  'Без ключа и без карты. Квота без ключа — 300 запросов в сутки на IP (живой ответ API), с зарегистрированным ключом — 10 000 в сутки; жёсткий лимит — 30 запросов в секунду на IP. Квота читается из ответа (quota_remaining), сигнал `backoff` трактуется как исчерпанная квота.';

const MAX_PAGESIZE = 100;
const SITE = 'stackoverflow';

/** The vertical is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * @param {object} item
 * @returns {string}
 */
export function questionSnippet(item) {
  const body = item?.body_markdown ?? item?.body ?? '';
  const tags = Array.isArray(item?.tags) ? item.tags.slice(0, 5).join(', ') : '';
  return [toSnippet(body), tags].filter(Boolean).join(' — ');
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

  const pageSize = Math.min(Math.max(1, Number(limit) || 5), MAX_PAGESIZE);
  const url = `${VERTICAL_ENDPOINTS.stackexchange}?order=desc&sort=relevance` +
    `&q=${encodeURIComponent(text)}&site=${SITE}&pagesize=${pageSize}&filter=withbody`;

  // spec §9.4 [оф]: "always set the Accept-Encoding header". Node fetch
  // decompresses a gzipped response transparently, so the body parses as JSON
  // whether or not Content-Encoding comes back set.
  const payload = await fetchVerticalJson(url, {
    scope: id,
    fetchImpl,
    signal,
    timeoutMs,
    headers: { 'Accept-Encoding': 'gzip' },
  });

  if (Number(payload?.backoff) > 0) {
    // The provider asks the client to back off — that is a quota signal.
    throw new WebSearchError(
      SEARCH_ERROR_CODES.QUOTA_EXHAUSTED,
      'Stack Exchange попросил отступить (backoff) — лимит запросов исчерпан',
    );
  }

  const items = payload?.items;
  if (!Array.isArray(items)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Stack Exchange вернул неожиданный формат ответа',
    );
  }

  // The keyless quota is read from the wrapper, not from a constant
  // (spec conflict 1 [live]: quota_max/quota_remaining). When the quota is
  // spent AND the response carries no items, that is an exhausted quota — a
  // successful last response still returns its items.
  if (Number(payload?.quota_remaining) === 0 && items.length === 0) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.QUOTA_EXHAUSTED,
      'Stack Exchange: дневная квота запросов исчерпана (quota_remaining = 0)',
    );
  }

  const results = items.map((item) => ({
    title: String(item?.title ?? ''),
    url: String(item?.link ?? ''),
    snippet: questionSnippet(item),
  }));

  return normalizeSearchResults(results, limit);
}
