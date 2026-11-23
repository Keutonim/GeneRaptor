/**
 * Tavily Search backend.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Two modes:
 *   - `keyless` — the officially documented zero-setup mode
 *     (POST https://api.tavily.com/search + header `X-Tavily-Access-Mode: keyless`):
 *     no account, no API key, no card. It is rate-limited with an unpublished
 *     numeric limit, so the search layer must fall back to the next backend.
 *   - `keyed`   — the free account tier (1 000 credits/month, no card);
 *     the key comes from the user's environment only.
 *
 * D27/D28: the endpoint is FIXED. The API key is only ever bound to that
 * canonical endpoint through the shared provider-url resolver — a stored or
 * user-supplied provider URL can never receive it.
 */
import { resolveProbeEndpoint, bindProviderKey } from '../provider-url.mjs';
import { isApiKeyConfigured } from '../api-key-probe.mjs';
import { researchUserAgent } from '../research-user-agent.mjs';
import { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
import { fetchWithTimeout, normalizeSearchResults, DEFAULT_TIMEOUT_MS } from './http.mjs';
import { TAVILY_ENDPOINT } from './endpoints.mjs';

export const id = 'tavily';
export const label = 'Tavily';
export const requiresKey = true;
export const envKey = 'GENERAPTOR_TAVILY_API_KEY';
export const description =
  'Tavily Search: бесплатный аккаунт (1 000 кредитов/мес, карта не нужна) — «качественный» режим без Google-SERP.';
export const notes =
  'Ключ отправляется только на фиксированный endpoint api.tavily.com. Без ключа доступен официальный keyless-режим (см. tavily-keyless).';

/** Fixed canonical endpoint — never user-supplied. */
export { TAVILY_ENDPOINT };

const MAX_RESULTS = 20;

/**
 * Markers of the official keyless refusal.
 *
 * The keyless mode has NO published numeric limit and NO HTTP error code for
 * it: the provider answers HTTP 200 with a natural-language instruction
 * ("you hit the limit, sign up for a free API key"). The instruction is the
 * only signal, so it has to be recognised in the body of the response.
 */
const KEYLESS_INSTRUCTION_MARKERS = Object.freeze([
  'keyless',
  'rate limit',
  'rate-limit',
  'sign up',
  'signing up',
  'free api key',
  'too many requests',
  'limit reached',
]);

export function isConfigured(env = process.env) {
  return isApiKeyConfigured(env?.[envKey]);
}

/**
 * Read the response body as text (the body can be consumed only once).
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readBody(response) {
  if (typeof response?.text === 'function') {
    const text = await response.text().catch(() => '');
    if (typeof text === 'string' && text.trim()) return text;
  }
  if (typeof response?.json === 'function') {
    const payload = await response.json().catch(() => null);
    if (payload) return JSON.stringify(payload);
  }
  return '';
}

/**
 * @param {string} text
 * @returns {object|null}
 */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Does the body look like the keyless refusal instruction?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeKeylessInstruction(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return false;
  return KEYLESS_INSTRUCTION_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * @param {string} query
 * @param {object} [options]
 * @param {'keyless'|'keyed'} [options.mode]
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function search(query, options = {}) {
  const {
    limit = 5,
    lang = 'ru',
    env = process.env,
    fetchImpl,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    mode = 'keyed',
  } = options;

  const text = String(query || '').trim();
  if (!text) {
    throw new WebSearchError(SEARCH_ERROR_CODES.EMPTY_QUERY, 'Пустой поисковый запрос');
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': researchUserAgent(mode === 'keyless' ? 'web search (tavily keyless)' : 'web search (tavily)'),
  };

  if (mode === 'keyless') {
    // Official zero-setup mode: no account, no key, no card.
    headers['X-Tavily-Access-Mode'] = 'keyless';
  } else {
    // The key is bound to the canonical endpoint only.
    const bound = bindProviderKey({
      kind: id,
      fixed: true,
      endpointSource: 'canonical',
      envApiKey: env?.[envKey],
    });
    if (!bound.value) {
      throw new WebSearchError(
        SEARCH_ERROR_CODES.NOT_CONFIGURED,
        `Ключ Tavily не настроен (${envKey}).`,
      );
    }
    headers.Authorization = `Bearer ${bound.value}`;
  }

  const endpoint = await resolveProbeEndpoint({
    kind: id,
    baseUrl: TAVILY_ENDPOINT,
    endpointSource: 'canonical',
  });

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: text,
        max_results: Math.min(Math.max(1, Number(limit) || 5), MAX_RESULTS),
        search_depth: 'basic',
        topic: 'general',
        include_answer: false,
        include_images: false,
      }),
    },
    { timeoutMs, signal, fetchImpl },
  );

  if (response?.status === 429 || response?.status === 402) {
    // 402 — the free credit balance of the account is spent; 429 — the rate
    // limit of the tier is reached. Both are "the quota is gone", not a bug.
    throw new WebSearchError(
      SEARCH_ERROR_CODES.QUOTA_EXHAUSTED,
      'Исчерпан лимит запросов Tavily (keyless-режим rate-limited)',
    );
  }
  if (response?.status === 401 || response?.status === 403) {
    // In the keyed mode the provider rejects the key; in the keyless mode
    // there is no key at all — the provider simply refuses to serve an
    // anonymous request, and the reason must say exactly that.
    throw new WebSearchError(
      mode === 'keyless'
        ? SEARCH_ERROR_CODES.KEYLESS_UNAVAILABLE
        : SEARCH_ERROR_CODES.NOT_CONFIGURED,
      mode === 'keyless'
        ? 'Tavily keyless-режим недоступен для этого запроса (HTTP ' + (response?.status ?? 'unknown') + ')'
        : 'Ключ Tavily отклонён провайдером',
    );
  }
  if (!response?.ok) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.HTTP_ERROR,
      `Tavily ответил HTTP ${response?.status ?? 'unknown'}`,
    );
  }

  const body = await readBody(response);
  const payload = parseJson(body);
  if (!payload || !Array.isArray(payload.results)) {
    // The keyless mode reports the exhausted anonymous budget with a
    // natural-language instruction instead of an HTTP error code — that is a
    // refusal of the keyless mode, not a broken response.
    if (mode === 'keyless' && looksLikeKeylessInstruction(body)) {
      throw new WebSearchError(
        SEARCH_ERROR_CODES.KEYLESS_UNAVAILABLE,
        'Tavily keyless-режим исчерпал анонимный лимит (провайдер вернул текстовую инструкцию)',
      );
    }
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Tavily вернул неожиданный формат ответа',
    );
  }

  const results = payload.results.map((item) => ({
    title: String(item?.title ?? ''),
    url: String(item?.url ?? ''),
    snippet: String(item?.content ?? item?.raw_content ?? ''),
  }));

  return normalizeSearchResults(results, limit);
}
