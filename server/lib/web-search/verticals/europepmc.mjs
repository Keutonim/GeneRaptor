/**
 * Europe PMC vertical — biomedical literature.
 *
 * Contract: `search(query, { limit, lang })` → `Array<{ title, url, snippet }>`.
 *
 * Keyless and official. No numeric limit is published. The request asks for
 * `resultType=core`: the evidence layer is snippet-only, so the abstract
 * (`abstractText`, present only in core) is the snippet this vertical exists
 * for — the spec sanctions core "when the abstract is needed"
 * (results/search-verticals-api-spec.md §5.2 [live]). Records without an
 * abstract degrade to the author/journal/year line, never to an empty snippet.
 */
import { WebSearchError, SEARCH_ERROR_CODES } from '../errors.mjs';
import { normalizeSearchResults, DEFAULT_TIMEOUT_MS } from '../http.mjs';
import { fetchVerticalJson, toSnippet } from './http.mjs';
import { VERTICAL_ENDPOINTS } from '../endpoints.mjs';

export const id = 'europepmc';
export const label = 'Europe PMC';
export const requiresKey = false;
export const envKey = null;
export const official = true;
export const vertical = true;
export const description =
  'Биомедицинская литература: статьи, авторы и журналы из открытого индекса Europe PMC.';
export const notes =
  'Без ключа и без карты. Числовой лимит не опубликован; используется тип выдачи `resultType=core`, чтобы сниппет нёс абстракт статьи (`abstractText`).';

const MAX_PAGE_SIZE = 100;

/** The vertical is always available — it needs no credentials. */
export function isConfigured() {
  return true;
}

/**
 * @param {object} item
 * @returns {string}
 */
export function articleUrl(item) {
  // The authoritative url is the full-text list (spec §5.2 [live]): the DOI
  // entry first, then any other full-text url. The constructed article url
  // below is only the fallback for records without a fullTextUrlList.
  const fullText = Array.isArray(item?.fullTextUrlList?.fullTextUrl)
    ? item.fullTextUrlList.fullTextUrl
    : [];
  const doiEntry = fullText.find((entry) => String(entry?.site ?? '').toUpperCase() === 'DOI' && entry?.url);
  if (doiEntry) return String(doiEntry.url).trim();
  const anyEntry = fullText.find((entry) => entry?.url);
  if (anyEntry) return String(anyEntry.url).trim();

  const pmid = String(item?.pmid ?? '').trim();
  if (pmid) return `https://europepmc.org/article/MED/${pmid}`;
  const pmcid = String(item?.pmcid ?? '').trim();
  if (pmcid) return `https://europepmc.org/article/PMC/${pmcid}`;
  const doi = String(item?.doi ?? '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  if (doi) return `https://doi.org/${doi}`;
  const idValue = String(item?.id ?? '').trim();
  return idValue ? `https://europepmc.org/article/${idValue}` : '';
}

/**
 * @param {object} item
 * @returns {string}
 */
export function articleSnippet(item) {
  // The abstract is the primary snippet (core records, spec §5.2 [live]);
  // it may carry HTML markup, so it is cleaned and cut like any provider text.
  const abstract = toSnippet(item?.abstractText ?? '');
  if (abstract) return abstract;
  const authors = String(item?.authorString ?? '').trim();
  const journal = String(item?.journalTitle ?? '').trim();
  const year = String(item?.pubYear ?? '').trim();
  return [authors, journal, year].filter(Boolean).join(' — ');
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

  const pageSize = Math.min(Math.max(1, Number(limit) || 5), MAX_PAGE_SIZE);
  const url = `${VERTICAL_ENDPOINTS.europepmc}?query=${encodeURIComponent(text)}` +
    `&format=json&resultType=core&pageSize=${pageSize}`;

  const payload = await fetchVerticalJson(url, { scope: id, fetchImpl, signal, timeoutMs });
  const items = payload?.resultList?.result;
  if (!Array.isArray(items)) {
    throw new WebSearchError(
      SEARCH_ERROR_CODES.INVALID_RESPONSE,
      'Europe PMC вернул неожиданный формат ответа',
    );
  }

  const results = items.map((item) => ({
    title: String(item?.title ?? ''),
    url: articleUrl(item),
    snippet: articleSnippet(item),
  }));

  return normalizeSearchResults(results, limit);
}
