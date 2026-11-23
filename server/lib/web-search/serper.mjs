/**
 * Serper.dev search backend (optional, user-provided API key, free tier).
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * D27/D28: the endpoint is FIXED. The API key is only ever bound to that
 * canonical endpoint through the shared provider-url resolver — a stored or
 * user-supplied provider URL can never receive it.
 *
 * RISK (verified 2026-11-16, results/search-serper-terms.md §1.3): serper.dev
 * publishes NO official API documentation — the endpoint host, the auth header
 * name and the response shape below are the project contract, not a published
 * specification. The canonical endpoint is kept as `google.serper.dev/search`
 * (the Google vertical of Serper) and the key is bound to that host ONLY
 * (never to a user-supplied URL). If Serper ever publishes a different
 * canonical host, this constant and the header name below must change with
 * it — and the free tier (2 500 queries, no card) has no published
 * periodicity, so the quota may be exhausted at any time.
 *
 * LIVE CEILING (verified 2026-11-20, results/s4-serper-live-probe.md):
 * the provider accepted `num:25` but returned only 10 records — the real
 * capacity of the answer is 10 on the current plan. The backend therefore
 * asks for `min(limit, SERPER_MAX_RESULTS)`; the PUBLIC contract is untouched
 * (searchWeb/route limit stays 25 — a smaller actual answer is backward
 * compatible). Serper does not support pagination (`page` is not part of the
 * request body), so consensus rounds stop when a round adds no new links.
 */
import { resolveProbeEndpoint, bindProviderKey } from '../provider-url.mjs';
import { isApiKeyConfigured } from '../api-key-probe.mjs';
import { researchUserAgent } from '../research-user-agent.mjs';
import { WebSearchError, SEARCH_ERROR_CODES } from './errors.mjs';
import { fetchWithTimeout, normalizeSearchResults, DEFAULT_TIMEOUT_MS } from './http.mjs';
import { SERPER_ENDPOINT } from './endpoints.mjs';
import { unwrapRedirectUrl } from './redirect-unwrap.mjs';

export const id = 'serper';
export const label = 'Serper.dev';
export const requiresKey = true;
export const envKey = 'GENERAPTOR_SERPER_API_KEY';
export const description = 'Google-поиск через Serper.dev: бесплатный тариф, нужен ключ пользователя.';
export const notes = 'Ключ отправляется только на фиксированный endpoint Serper.dev.';

/** Fixed canonical endpoint — never user-supplied. */
export { SERPER_ENDPOINT };

/**
 * Live ceiling of one Serper answer: the live probe sent num:25 and received
 * 10 records (results/s4-serper-live-probe.md, 2026-11-20). Asking for more
 * is a false promise — the provider truncates to 10 anyway.
 */
export const SERPER_MAX_RESULTS = 10;

const GL_BY_LANG = { ru: 'ru', en: 'us' };
const HL_BY_LANG = { ru: 'ru', en: 'en' };

export function isConfigured(env = process.env) {
  return isApiKeyConfigured(env?.[envKey]);
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
    env = process.env,
    fetchImpl,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const text = String(query || '').trim();
  if (!text) {
    throw new WebSearchError(SEARCH_ERROR_CODES.EMPTY_QUERY, 'Пустой поисковый запрос');
  }

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
      `Ключ Serper не настроен (${envKey}).`,
    );
  }

  const endpoint = await resolveProbeEndpoint({
    kind: id,
    baseUrl: SERPER_ENDPOINT,
    endpointSource: 'canonical',
  });

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': bound.value,
        'User-Agent': researchUserAgent('web search (serper)'),
      },
      body: JSON.stringify({
        q: text,
        num: Math.min(Math.max(1, Number(limit) || 5), SERPER_MAX_RESULTS),
        gl: GL_BY_LANG[lang] || GL_BY_LANG.ru,
        hl: HL_BY_LANG[lang] || HL_BY_LANG.ru,
      }),
    },
    { timeoutMs, signal, fetchImpl },
  );

  if (response?.status === 429 || response?.status === 402) {
    // 402 — the credit balance of the account is spent; 429 — the rate limit
    // of the tier is reached. Both mean "the quota is gone".
    throw new WebSearchError(
      SEARCH_ERROR_CODES.QUOTA_EXHAUSTED,
      'Исчерпан лимит запросов Serper.dev',
    );
  }
  if (response?.status === 401 || response?.status === 403) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.NOT_CONFIGURED,
      'Ключ Serper.dev отклонён провайдером',
    );
  }
  if (!response?.ok) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.HTTP_ERROR,
      `Serper.dev ответил HTTP ${response?.status ?? 'unknown'}`,
    );
  }

  const payload = await response.json().catch(() => null);
  if (!payload || !Array.isArray(payload.organic)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Serper.dev вернул неожиданный формат ответа',
    );
  }

  const results = payload.organic.map((item) => ({
    title: String(item?.title ?? ''),
    url: String(item?.link ?? ''),
    snippet: String(item?.snippet ?? ''),
  }));

  // Observability: when the raw answer carries redirect wrappers, report
  // the count and the rule ids ONCE — never full URLs, never the key. The
  // unwrapping itself happens in the shared normalizeSearchResults below.
  let wrapperCount = 0;
  const wrapperIds = new Set();
  for (const item of results) {
    const probe = unwrapRedirectUrl(item.url);
    if (probe.status !== 'plain') {
      wrapperCount += 1;
      if (probe.wrapper) wrapperIds.add(probe.wrapper);
    }
  }
  if (wrapperCount > 0) {
    console.warn(
      `[web-search][serper] Redirect-обёрток в выдаче: ${wrapperCount} (${[...wrapperIds].join(', ')}) — развёрнуты/отброшены политикой развёртки redirect-обёрток`,
    );
  }

  return normalizeSearchResults(results, limit);
}
