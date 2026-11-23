/**
 * Nominatim vertical — geocoding and places (OpenStreetMap).
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless and official, but the usage policy is strict: a descriptive
 * User-Agent is mandatory and the absolute maximum is 1 request per second —
 * a client that violates it gets blocked. The throttler keeps the request
 * rate inside the published limit; the results are meant to be cached, which
 * the search layer does by construction (one call per request, at most two
 * verticals per request).
 */
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from '../http.mjs';
import { fetchVerticalJson } from './http.mjs';
import { createThrottle } from './throttle.mjs';
import { VERTICAL_ENDPOINTS } from '../endpoints.mjs';

export const id = 'nominatim';
export const label = 'Nominatim (OpenStreetMap)';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const vertical = true;
export const description =
  'География и адреса: геокодирование и поиск мест по данным OpenStreetMap.';
export const notes =
  'Без ключа и без карты. Политика провайдера: обязательный описательный User-Agent и не более 1 запроса в секунду — этот лимит соблюдает троттлер.';

const MAX_LIMIT = 40;
const MIN_INTERVAL_MS = 1000;

const throttle = createThrottle(MIN_INTERVAL_MS);

/** The vertical is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/** Reset the throttle (used by the tests and by a manual restart). */
export function resetThrottle() {
  throttle.reset();
}

/**
 * @param {object} place
 * @returns {string}
 */
export function placeUrl(place) {
  const lat = String(place?.lat ?? '').trim();
  const lon = String(place?.lon ?? '').trim();
  if (!lat || !lon) return '';
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
}

/**
 * @param {object} place
 * @returns {string}
 */
export function placeSnippet(place) {
  const kind = String(place?.type ?? '').trim();
  const group = String(place?.class ?? '').trim();
  const city = String(place?.address?.city ?? place?.address?.town ?? place?.address?.village ?? '').trim();
  return [group, kind, city].filter(Boolean).join(' — ');
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

  await throttle({ now: options.now, sleep: options.sleep });

  const count = Math.min(Math.max(1, Number(limit) || 5), MAX_LIMIT);
  const url = `${VERTICAL_ENDPOINTS.nominatim}?q=${encodeURIComponent(text)}` +
    `&format=jsonv2&limit=${count}&addressdetails=1`;

  const payload = await fetchVerticalJson(url, { scope: id, fetchImpl, signal, timeoutMs });
  if (!Array.isArray(payload)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Nominatim вернул неожиданный формат ответа',
    );
  }

  const results = payload.map((place) => ({
    title: String(place?.display_name ?? ''),
    url: placeUrl(place),
    snippet: placeSnippet(place),
  }));

  return normalizeSearchResults(results, limit);
}
