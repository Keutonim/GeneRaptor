/**
 * Yandex Search API backend (optional, paid, off by default).
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * The adapter only reuses the existing Yandex client — no new protocol code.
 * D27/D28: the key is bound to the operator-configured Yandex endpoint through
 * the shared provider-url resolver, never to a user-supplied URL.
 */
import { searchYandex } from '../yandex-search.mjs';
import { resolveProbeEndpoint, bindProviderKey } from '../provider-url.mjs';
import { isApiKeyConfigured } from '../api-key-probe.mjs';
import { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
import { normalizeSearchResults } from './http.mjs';
import { YANDEX_SEARCH_DEFAULT_ENDPOINT } from './endpoints.mjs';

export const id = 'yandex';
export const label = 'Yandex Search API';
export const requiresKey = true;
export const envKey = 'GENERAPTOR_YANDEX_API_KEY';
export const description = 'Платный Yandex Search API: используется только при явно заданном ключе.';
export const notes = 'По умолчанию выключен. Основной (keyless) backend — DuckDuckGo.';

/** Legacy variable kept for compatibility with existing deployments. */
export const LEGACY_YANDEX_API_KEY_ENV = 'YANDEX_SEARCH_API_KEY';

/** Region codes: 213 — Россия, 10193 — мир с английским интерфейсом. */
const REGION_BY_LANG = { ru: '213', en: '10193' };

export function isConfigured(env = process.env) {
  return isApiKeyConfigured(env?.[envKey]) || isApiKeyConfigured(env?.[LEGACY_YANDEX_API_KEY_ENV]);
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
    env = process.env,
    fetchImpl,
    signal,
    searchImpl = searchYandex,
  } = options;

  const text = String(query || '').trim();
  if (!text) {
    throw new WebSearchError(SEARCH_ERROR_CODES.EMPTY_QUERY, 'Пустой поисковый запрос');
  }

  const envKeyValue = env?.[envKey] || env?.[LEGACY_YANDEX_API_KEY_ENV];
  if (!isApiKeyConfigured(envKeyValue)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.NOT_CONFIGURED,
      `Ключ Yandex Search не настроен (${envKey}).`,
    );
  }

  // Operator endpoint + operator key — a stored/user-supplied URL is never used.
  const bound = bindProviderKey({
    kind: id,
    fixed: true,
    endpointSource: 'env',
    envApiKey: envKeyValue,
  });
  if (!bound.value) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.NOT_CONFIGURED,
      `Ключ Yandex Search не настроен (${envKey}).`,
    );
  }

  await resolveProbeEndpoint({
    kind: id,
    baseUrl: env?.YANDEX_SEARCH_ENDPOINT || YANDEX_SEARCH_DEFAULT_ENDPOINT,
    endpointSource: 'env',
  });

  const region = REGION_BY_LANG[lang] || REGION_BY_LANG.ru;
  const outcome = await searchImpl({
    query: text,
    page: Number(page) || 0,
    region,
    apiKey: bound.value,
    fetchImpl,
    signal,
  });

  const results = Array.isArray(outcome?.results) ? outcome.results : [];
  if (!results.length && outcome?.error) {
    throw new WebSearchError(SEARCH_ERROR_CODES.INTERNAL_ERROR, String(outcome.error));
  }

  return normalizeSearchResults(
    results.map((item) => ({
      title: item?.title,
      url: item?.url,
      snippet: item?.snippet,
    })),
    limit,
  );
}
