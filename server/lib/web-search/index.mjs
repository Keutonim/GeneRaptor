/**
 * Pluggable web-search layer — the single entry point for external search.
 *
 * Product contract:
 *   - the product works out of the box: the default backend is KEYLESS
 *     (Tavily keyless — the officially documented zero-setup mode);
 *   - several backends behind ONE contract:
 *       `search(query, { limit, lang }) -> Array<{ title, url, snippet }>`;
 *   - the backend is selected through the environment
 *     (`GENERAPTOR_SEARCH_BACKEND`);
 *   - every failure degrades gracefully: `searchWeb()` never throws, it
 *     returns an empty result set plus a stable `reason` code.
 *
 * Automatic chain (used when the backend is `auto`):
 *   Serper (Google SERP, key present) → Tavily free (key present) →
 *   Tavily keyless → Wikipedia → Wikidata → graceful empty result.
 *
 * The unofficial DuckDuckGo scraping backend is NOT part of the chain: it
 * runs only when it is explicitly selected.
 *
 * D27/D28: search endpoints are FIXED. An environment key is only ever sent to
 * the canonical endpoint of its own backend — never to a user-supplied or
 * foreign endpoint.
 */
import { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from './http.mjs';
import { canonicalSignature } from '../url-normalize.mjs';
import { matchVerticals, MAX_VERTICALS } from './topic-match.mjs';
import { getVerticalBackend, describeVerticalBackends, VERTICAL_BACKEND_IDS } from './verticals/index.mjs';
import * as tavilyBackend from './tavily.mjs';
import * as tavilyKeylessBackend from './tavily-keyless.mjs';
import * as serperBackend from './serper.mjs';
import * as yandexBackend from './yandex.mjs';
import * as wikipediaBackend from './wikipedia.mjs';
import * as wikidataBackend from './wikidata.mjs';
import * as duckduckgoBackend from './duckduckgo.mjs';

export { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
export { describeVerticalBackends, VERTICAL_BACKEND_IDS } from './verticals/index.mjs';

export const SEARCH_BACKEND_ENV = 'GENERAPTOR_SEARCH_BACKEND';
export const TAVILY_API_KEY_ENV = 'GENERAPTOR_TAVILY_API_KEY';
export const SERPER_API_KEY_ENV = 'GENERAPTOR_SERPER_API_KEY';
export const YANDEX_API_KEY_ENV = 'GENERAPTOR_YANDEX_API_KEY';
export const SEARCH_LANG_ENV = 'GENERAPTOR_SEARCH_LANG';
export const SEARCH_TIMEOUT_ENV = 'GENERAPTOR_SEARCH_TIMEOUT_MS';

/** All supported backends (display order). */
export const SEARCH_BACKEND_IDS = Object.freeze([
  'tavily',
  'serper',
  'yandex',
  'tavily-keyless',
  'wikipedia',
  'wikidata',
  'duckduckgo',
]);

/**
 * The keyless safety net — always available, never needs a credential.
 */
export const KEYLESS_SEARCH_CHAIN = Object.freeze([
  'tavily-keyless',
  'wikipedia',
  'wikidata',
]);

/**
 * The automatic fallback chain.
 *
 * Serper.dev is the primary engine (Google SERP), Tavily free is the
 * fallback (the keyed free tier first, then the official keyless mode), and
 * Wikipedia / Wikidata stay as the guaranteed-free safety net.
 *
 * The unofficial scraping backend is deliberately absent from it, and so is
 * the paid Yandex backend: Yandex is opt-in only and is used when it is
 * explicitly selected.
 */
export const AUTO_SEARCH_CHAIN = Object.freeze([
  'serper',
  'tavily',
  ...KEYLESS_SEARCH_CHAIN,
]);

/** The backend that is tried first when nothing is configured. */
export const DEFAULT_SEARCH_BACKEND = 'tavily-keyless';

const BACKENDS = {
  tavily: tavilyBackend,
  serper: serperBackend,
  yandex: yandexBackend,
  'tavily-keyless': tavilyKeylessBackend,
  wikipedia: wikipediaBackend,
  wikidata: wikidataBackend,
  duckduckgo: duckduckgoBackend,
};

const DEFAULT_LIMIT = 5;
// Public upper bound of the searchWeb contract — do NOT lower it to a single
// backend's capacity: Serper actually returns <= 10 results per answer
// (SERPER_MAX_RESULTS), while Tavily/Wikipedia honor up to 25. A smaller
// actual answer is backward compatible; the public limit stays 25.
const MAX_LIMIT = 25;

/**
 * Maximal number of results one vertical may add to the answer.
 *
 * The shared `limit` of the request bounds every single source: a vertical
 * never returns more than `min(limit, VERTICAL_RESULT_LIMIT)` items, and the
 * main engine never returns more than `limit` items. The merged list is
 * therefore bounded by `limit + VERTICAL_RESULT_LIMIT × consulted verticals`.
 */
export const VERTICAL_RESULT_LIMIT = 3;

/**
 * Timeout of one vertical request — smaller than the timeout of the main
 * engine, so a slow narrow source cannot hold the whole answer hostage.
 */
export const VERTICAL_TIMEOUT_MS = 8000;

/**
 * @param {string} id
 * @returns {object|null} the backend module
 */
export function getSearchBackend(id) {
  return Object.prototype.hasOwnProperty.call(BACKENDS, id) ? BACKENDS[id] : null;
}

/**
 * Resolves the configured backend selection.
 *
 * @param {object} [env]
 * @returns {{id: string, source: 'default'|'env', requested: string|null, warning: string|null}}
 */
export function resolveSearchBackend(env = process.env) {
  const raw = String(env?.[SEARCH_BACKEND_ENV] ?? '').trim().toLowerCase();
  if (!raw) {
    return { id: 'auto', source: 'default', requested: null, warning: null };
  }
  if (raw === 'auto') {
    return { id: 'auto', source: 'env', requested: 'auto', warning: null };
  }
  if (getSearchBackend(raw)) {
    return { id: raw, source: 'env', requested: raw, warning: null };
  }
  return {
    id: 'auto',
    source: 'env',
    requested: raw,
    warning:
      `Неизвестный поисковый backend "${raw}" — используется keyless-цепочка по умолчанию ` +
      '(Tavily keyless → Wikipedia → Wikidata).',
  };
}

/**
 * @param {object} [env]
 * @returns {'ru'|'en'}
 */
export function getSearchLang(env = process.env) {
  const raw = String(env?.[SEARCH_LANG_ENV] ?? '').trim().toLowerCase();
  return raw === 'en' ? 'en' : 'ru';
}

/**
 * @param {object} [env]
 * @returns {number} request timeout in ms
 */
export function getSearchTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(String(env?.[SEARCH_TIMEOUT_ENV] ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_TIMEOUT_MS;
}

/**
 * @param {string} id
 * @param {object} [env]
 * @returns {boolean}
 */
export function isBackendConfigured(id, env = process.env) {
  const backend = getSearchBackend(id);
  if (!backend) return false;
  return typeof backend.isConfigured === 'function' ? backend.isConfigured(env) : true;
}

/**
 * The effective order of the automatic chain for the current environment.
 *
 * @param {object} [env]
 * @returns {string[]}
 */
export function getAutoSearchChain(env = process.env) {
  return AUTO_SEARCH_CHAIN.filter((id) => isBackendConfigured(id, env));
}

/**
 * Machine-readable description of the available backends — used by the
 * settings page and by the `/api/search/backends` endpoint.
 *
 * @param {object} [env]
 * @returns {Array<object>}
 */
export function describeSearchBackends(env = process.env) {
  const resolved = resolveSearchBackend(env);
  const autoChain = getAutoSearchChain(env);
  const effectiveFirst = autoChain[0] || DEFAULT_SEARCH_BACKEND;

  return SEARCH_BACKEND_IDS.map((id, order) => {
    const backend = getSearchBackend(id);
    const configured = isBackendConfigured(id, env);
    const inChain = AUTO_SEARCH_CHAIN.includes(id);
    const selected = resolved.id === 'auto' ? id === effectiveFirst : resolved.id === id;
    return {
      id,
      label: backend.label,
      description: backend.description,
      notes: backend.notes,
      requiresKey: Boolean(backend.requiresKey),
      configured,
      available: configured,
      envKey: backend.envKey || null,
      official: backend.official !== false,
      unofficial: Boolean(backend.unofficial),
      optIn: Boolean(backend.optIn),
      inAutoChain: inChain,
      order,
      selected,
    };
  });
}

function clampLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Runs a web search across the configured backend(s).
 *
 * The call NEVER throws: any backend failure degrades into an empty result
 * set with a stable `reason` code, so article generation keeps working when
 * the network, the key or the quota is unavailable.
 *
 * @param {object} [options]
 * @param {string} options.query
 * @param {number} [options.limit]
 * @param {'ru'|'en'} [options.lang]
 * @param {number} [options.page]
 * @param {string} [options.backend] explicit backend id ('auto' by default)
 * @param {object} [options.env]
 * @param {Function} [options.fetchImpl] injected fetch (tests)
 * @returns {Promise<{results: Array<{title: string, url: string, snippet: string, provider?: string}>, backend: string|null, degraded: boolean, reason: string|null, lang: string, limit: number, attempts: Array<object>}>}
 */
export async function searchWeb(options = {}) {
  const env = options.env || process.env;
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const limit = clampLimit(options.limit);
  const lang = options.lang === 'en' ? 'en' : getSearchLang(env);
  const page = Number.isFinite(Number(options.page)) && Number(options.page) > 0
    ? Math.floor(Number(options.page))
    : 0;

  const resolved = resolveSearchBackend(env);
  const requested = options.backend
    ? String(options.backend).trim().toLowerCase()
    : resolved.id;

  const attempts = [];

  if (!query) {
    return {
      results: [],
      backend: null,
      degraded: true,
      reason: SEARCH_ERROR_CODES.EMPTY_QUERY,
      lang,
      limit,
      attempts,
    };
  }

  let order;
  if (requested === 'auto') {
    order = getAutoSearchChain(env);
  } else if (getSearchBackend(requested)) {
    // An explicitly selected backend is tried first; the keyless safety net
    // stays as the fallback, so an exhausted quota never means "no search at
    // all". Another keyed provider is NOT silently used instead.
    order = [requested, ...KEYLESS_SEARCH_CHAIN.filter((id) => id !== requested)];
  } else {
    order = [];
  }

  if (!order.length) {
    return {
      results: [],
      backend: null,
      degraded: true,
      reason: SEARCH_ERROR_CODES.NOT_CONFIGURED,
      lang,
      limit,
      attempts,
    };
  }

  let reason = null;
  let emptySeen = false;
  let lastBackend = null;
  let primary = null;

  for (const id of order) {
    const backend = getSearchBackend(id);
    lastBackend = id;

    if (backend.requiresKey && !isBackendConfigured(id, env)) {
      reason = SEARCH_ERROR_CODES.NOT_CONFIGURED;
      attempts.push({ backend: id, ok: false, code: reason, count: 0 });
      continue;
    }

    try {
      const raw = await backend.search(query, {
        limit,
        lang,
        page,
        env,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? getSearchTimeoutMs(env),
        // A user-supplied provider URL is deliberately NOT forwarded: search
        // endpoints are fixed, so a stored URL can never receive a key.
      });
      const results = normalizeSearchResults(raw, limit, id);
      attempts.push({ backend: id, ok: true, code: null, count: results.length });
      if (results.length) {
        primary = { id, results };
        break;
      }
      emptySeen = true;
    } catch (err) {
      const code = err instanceof WebSearchError ? err.code : SEARCH_ERROR_CODES.INTERNAL_ERROR;
      reason = code;
      attempts.push({ backend: id, ok: false, code, count: 0 });
    }
  }

  // The narrow verticals are a SEPARATE tier: they are consulted only on the
  // first page and only when the topic of the request matches a vertical.
  // Their results are ADDED to the answer of the main engine (deduplicated
  // by the canonical URL) — they never replace it.
  const vertical = await runVerticalStage({
    query,
    page,
    limit,
    lang,
    env,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? getSearchTimeoutMs(env),
    attempts,
  });

  if (primary) {
    return {
      results: mergeResults(primary.results, vertical.results),
      backend: primary.id,
      degraded: false,
      reason: null,
      lang,
      limit,
      attempts,
    };
  }

  // The main chain found nothing — a vertical that fits the topic becomes the
  // source of the answer instead of an empty result set.
  if (vertical.results.length) {
    return {
      results: vertical.results,
      backend: vertical.results[0].provider,
      degraded: false,
      reason: null,
      lang,
      limit,
      attempts,
    };
  }

  return {
    results: [],
    backend: lastBackend,
    degraded: true,
    reason: reason || (emptySeen ? 'empty_results' : SEARCH_ERROR_CODES.INTERNAL_ERROR),
    lang,
    limit,
    attempts,
  };
}

/**
 * Merges the results of the main engine with the results of the verticals and
 * removes the duplicates by the canonical signature of the URL.
 *
 * @param {Array<object>} mainResults
 * @param {Array<object>} verticalResults
 * @returns {Array<object>}
 */
export function mergeResults(mainResults, verticalResults) {
  const seen = new Set();
  const merged = [];
  for (const item of [...(mainResults || []), ...(verticalResults || [])]) {
    const url = String(item?.url ?? '').trim();
    const key = canonicalSignature(url) || url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/**
 * Runs the vertical stage of the search.
 *
 * The stage is skipped completely when the request is not the first page or
 * when no vertical matches the topic of the query — then not a single request
 * to a vertical host is made.
 *
 * @param {object} options
 * @param {Array<object>} options.attempts the attempt log of the request
 * @returns {Promise<{results: Array<object>}>}
 */
async function runVerticalStage(options = {}) {
  const {
    query,
    page,
    limit,
    lang,
    env,
    fetchImpl,
    signal,
    timeoutMs,
    attempts,
  } = options;

  const empty = { results: [] };
  if (page !== 0) return empty;

  const matches = matchVerticals(query, { limit: MAX_VERTICALS });
  if (!matches.length) return empty;

  const perVerticalLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), VERTICAL_RESULT_LIMIT);
  const verticalTimeoutMs = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, VERTICAL_TIMEOUT_MS);

  const outcomes = await Promise.all(matches.map(async (match) => {
    const backend = getVerticalBackend(match.id);
    if (!backend) {
      return { id: match.id, ok: false, code: SEARCH_ERROR_CODES.NOT_CONFIGURED, results: [] };
    }
    try {
      const raw = await backend.search(query, {
        limit: perVerticalLimit,
        lang,
        page: 0,
        env,
        fetchImpl,
        signal,
        timeoutMs: verticalTimeoutMs,
      });
      return {
        id: match.id,
        ok: true,
        code: null,
        results: normalizeSearchResults(raw, perVerticalLimit, match.id),
      };
    } catch (err) {
      // A failing vertical NEVER breaks the answer of the main engine: it is
      // skipped and recorded in the attempt log.
      const code = err instanceof WebSearchError ? err.code : SEARCH_ERROR_CODES.INTERNAL_ERROR;
      return { id: match.id, ok: false, code, results: [] };
    }
  }));

  const results = [];
  for (const outcome of outcomes) {
    attempts.push({
      backend: outcome.id,
      ok: outcome.ok,
      code: outcome.code,
      count: outcome.results.length,
    });
    results.push(...outcome.results);
  }

  return { results };
}
