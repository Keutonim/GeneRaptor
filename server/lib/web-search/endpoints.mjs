/**
 * Canonical endpoints of the web-search backends.
 *
 * The endpoints are FIXED constants on purpose (D27/D28): a search API key is
 * only ever sent to the canonical endpoint of its own backend, never to a
 * user-supplied or foreign URL. The module is intentionally dependency-free
 * so any layer (backends, key probes) can import it without a cycle.
 */

/** Tavily canonical endpoint (official keyless mode + keyed mode). */
export const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

/** Serper.dev canonical endpoint (the key is bound here and nowhere else). */
export const SERPER_ENDPOINT = 'https://google.serper.dev/search';

/** Yandex Search canonical endpoints (operator-overridable via env). */
export const YANDEX_SEARCH_DEFAULT_ENDPOINT =
  'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync';
export const YANDEX_OPERATION_DEFAULT_ENDPOINT =
  'https://operation.api.cloud.yandex.net/operations';

/**
 * Wikipedia / Wikidata MediaWiki Action API endpoints.
 *
 * Both are official, keyless and free. Wikipedia is language-scoped
 * (ru/en), Wikidata is multilingual.
 */
export const WIKIPEDIA_HOSTS = Object.freeze({ ru: 'ru.wikipedia.org', en: 'en.wikipedia.org' });
export const WIKIPEDIA_DEFAULT_HOST = WIKIPEDIA_HOSTS.ru;
export const WIKIDATA_HOST = 'www.wikidata.org';

/**
 * @param {string} lang 'ru' | 'en'
 * @returns {string} the MediaWiki Action API endpoint of the language wiki
 */
export function wikipediaApiEndpoint(lang = 'ru') {
  const host = WIKIPEDIA_HOSTS[lang] || WIKIPEDIA_DEFAULT_HOST;
  return `https://${host}/w/api.php`;
}

/**
 * @param {string} lang 'ru' | 'en'
 * @returns {string} the Wikidata Action API endpoint
 */
export function wikidataApiEndpoint(lang = 'ru') {
  return `https://${WIKIDATA_HOST}/w/api.php`;
}

/**
 * Unofficial best-effort scraping backend — kept only as an explicit opt-in.
 * There is no official DuckDuckGo search API, so this endpoint is not a
 * stable contract and may challenge the request at any time.
 */
export const DUCKDUCKGO_ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * Canonical endpoints of the narrow verticals.
 *
 * The verticals are keyless: they take no credential, so there is nothing to
 * bind — and their addresses are constants for the same reason the main
 * backends have constants (D27/D28): a search request must never be able to
 * reach a user-supplied host.
 *
 * Sources of the limits that the code respects (verified 2026-11-16/17,
 * results/search-serper-terms.md §4 + results/search-verticals-api-spec.md):
 *   - OpenAlex   — 10 requests/s without a key, $0.10/day shared-IP budget, 429;
 *   - Crossref   — public pool 5 requests/s and 1 concurrent request, 429
 *                  (the polite pool with mailto answers 3/s live);
 *   - Europe PMC — no published numeric limit, `resultType=core` for abstracts;
 *   - GDELT      — maxrecords ≤ 250, the window is the last 3 months,
 *                  one request per 5 seconds (the live 429 instruction);
 *   - Nominatim  — 1 request/s absolute maximum, descriptive User-Agent;
 *   - OpenLibrary— 1 request/s without identification;
 *   - StackExchange — keyless quota 300 requests/day per IP (live), 10 000/day
 *                  with a registered key, 30 requests/s per IP, `backoff`;
 *   - HN (Algolia) — no published limits, own throttling.
 */
export const VERTICAL_ENDPOINTS = Object.freeze({
  openalex: 'https://api.openalex.org/works',
  crossref: 'https://api.crossref.org/works',
  europepmc: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search',
  gdelt: 'https://api.gdeltproject.org/api/v2/doc/doc',
  nominatim: 'https://nominatim.openstreetmap.org/search',
  openlibrary: 'https://openlibrary.org/search.json',
  stackexchange: 'https://api.stackexchange.com/2.3/search/advanced',
  hn: 'https://hn.algolia.com/api/v1/search',
});
