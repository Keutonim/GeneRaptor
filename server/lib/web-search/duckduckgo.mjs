/**
 * Unofficial web-search backend (DuckDuckGo HTML endpoint) — OPT-IN ONLY.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * There is NO official DuckDuckGo search API: this endpoint is scraped HTML,
 * so it is not a stable contract, it may throttle or challenge the request at
 * any time, and its use is a ToS/reputational risk for a public OSS project.
 * It is therefore NOT part of the automatic chain and NOT the default — it
 * runs only when the operator explicitly selects it
 * (`GENERAPTOR_SEARCH_BACKEND=duckduckgo`).
 *
 * We do NOT try to bypass a challenge: when the endpoint answers with an
 * anomaly/challenge page we return an empty result set and let the caller
 * degrade.
 */
import { load } from 'cheerio';
import { researchUserAgent } from '../research-user-agent.mjs';
import { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
import { fetchWithTimeout, normalizeSearchResults, DEFAULT_TIMEOUT_MS } from './http.mjs';
import { DUCKDUCKGO_ENDPOINT } from './endpoints.mjs';
import { unwrapDuckDuckGoUrl } from './redirect-unwrap.mjs';

export const id = 'duckduckgo';
export const label = 'DuckDuckGo (неофициальный скрейпинг, opt-in)';
export const requiresKey = false;
export const envKey = null;
/** Unofficial endpoint — no stable API contract behind it. */
export const unofficial = true;
/** No official API exists behind this endpoint. */
export const official = false;
/** Must be selected explicitly; it never runs inside the automatic chain. */
export const optIn = true;
export const description =
  'Неофициальный keyless HTML-скрейпинг DuckDuckGo. Официального поискового API у DuckDuckGo нет.';
export const notes =
  'ВНИМАНИЕ: неофициальный скрейпинг, офлайн по умолчанию. Включается только явным выбором оператора (GENERAPTOR_SEARCH_BACKEND=duckduckgo). Эндпоинт может в любой момент ограничить или заблокировать запрос; обход антибот-проверок не выполняется.';

/** Fixed endpoint — the keyless backend sends no key, so it has no endpoint to bind. */
export { DUCKDUCKGO_ENDPOINT };

/** Markers of the anti-bot challenge page. */
const BLOCKED_MARKERS = [
  'anomaly.js',
  'anomaly-modal',
  'bots use duckduckgo too',
  'challenge-form',
  'unfortunately, bots use',
];

const LANG_PARAMS = {
  ru: { kl: 'ru-ru', acceptLanguage: 'ru-RU,ru;q=0.9,en;q=0.6' },
  en: { kl: 'wt-wt', acceptLanguage: 'en-US,en;q=0.9' },
};

/** The keyless backend is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * Unwraps the DuckDuckGo redirect wrapper (`/l/?uddg=<encoded target>`).
 *
 * The implementation lives in the shared redirect-unwrap module; the
 * legacy semantics are preserved verbatim (non-http(s) → '', protocol-relative
 * `//host/…` → `https:`, `uddg=` searched as a substring). The public export
 * path `duckduckgo.mjs:unwrapDuckDuckGoUrl` is unchanged.
 *
 * @param {string} href
 * @returns {string} an absolute http(s) URL, or '' when unusable
 */
export { unwrapDuckDuckGoUrl };

/**
 * Parses a DuckDuckGo HTML answer into the shared contract.
 *
 * @param {string} html
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
export function parseDuckDuckGoHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const $ = load(html);
  const results = [];

  $('div.result, div.web-result, table tr').each((_, element) => {
    const node = $(element);
    const link = node.find('a.result__a').first().length
      ? node.find('a.result__a').first()
      : node.find('a.result-link').first();
    if (!link.length) return;

    const title = link.text().replace(/\s+/g, ' ').trim();
    const url = unwrapDuckDuckGoUrl(link.attr('href') || '');
    if (!title || !url) return;

    const snippetNode = node.find('a.result__snippet').first().length
      ? node.find('a.result__snippet').first()
      : node.find('.result__snippet').first();
    const snippet = snippetNode.text().replace(/\s+/g, ' ').trim();

    results.push({ title, url, snippet });
  });

  return results;
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
    page = 0,
    fetchImpl,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const text = String(query || '').trim();
  if (!text) {
    throw new WebSearchError(SEARCH_ERROR_CODES.EMPTY_QUERY, 'Пустой поисковый запрос');
  }

  const langParams = LANG_PARAMS[lang] || LANG_PARAMS.ru;
  const body = new URLSearchParams({
    q: text,
    kl: langParams.kl,
  });
  const offset = Math.max(0, Number(page) || 0) * Math.max(1, Number(limit) || 5);
  if (offset > 0) body.set('s', String(offset));

  const response = await fetchWithTimeout(
    DUCKDUCKGO_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': langParams.acceptLanguage,
        'User-Agent': researchUserAgent('web search (keyless)'),
      },
      body: body.toString(),
    },
    { timeoutMs, signal, fetchImpl },
  );

  if (response?.status === 429) {
    throw new WebSearchError(SEARCH_ERROR_CODES.QUOTA_EXHAUSTED, 'DuckDuckGo временно ограничил запросы');
  }
  if (!response?.ok) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.HTTP_ERROR,
      `DuckDuckGo ответил HTTP ${response?.status ?? 'unknown'}`,
    );
  }

  const html = await response.text();
  const lowered = String(html || '').toLowerCase();
  if (BLOCKED_MARKERS.some((marker) => lowered.includes(marker))) {
    // No bypass attempt: the caller simply degrades to an empty result set.
    throw new WebSearchError(
      SEARCH_ERROR_CODES.BLOCKED,
      'DuckDuckGo показал антибот-проверку; обход не выполняется',
    );
  }

  return normalizeSearchResults(parseDuckDuckGoHtml(html), limit);
}
