/**
 * Tavily Search — official keyless mode (no account, no API key, no card).
 *
 * This is the product default: GeneRaptor works out of the box with zero
 * credentials. The mode is officially documented, but it is rate-limited with
 * an unpublished numeric limit — therefore the search layer always keeps a
 * fallback chain (Wikipedia / Wikidata) and degrades to an empty result set
 * instead of failing.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 */
import * as tavily from './tavily.mjs';

export const id = 'tavily-keyless';
export const label = 'Tavily (keyless, без ключа)';
export const requiresKey = false;
export const envKey = null;
export const description =
  'Официальный keyless-режим Tavily: без аккаунта, без API-ключа и без карты. Работает сразу из коробки.';
export const notes =
  'Rate-limited без опубликованного числового лимита: при исчерпании лимита поиск переключается на следующий backend цепочки. Ключ не используется.';

export { TAVILY_ENDPOINT } from './endpoints.mjs';

/** The keyless mode is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * @param {string} query
 * @param {object} [options]
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function search(query, options = {}) {
  return tavily.search(query, { ...options, mode: 'keyless' });
}
