/**
 * ResearchSource helpers — normalization + prompt rendering.
 *
 * ResearchSource is the unified evidence-layer record produced by the external
 * web-search layer (see server/lib/web-search/). This module turns the
 * heterogeneous shapes returned by the search backends into a single canonical
 * object, and renders the resulting list into a prompt block for the
 * article-author / factchecker roles.
 */

import { canonicalSignature } from './url-normalize.mjs';
import { isOwnSiteUrl } from './source-domains.mjs';

/** Allowed external research providers (web-search backends + consensus). */
export const RESEARCH_PROVIDERS = [
  'tavily',
  'tavily-keyless',
  'serper',
  'yandex',
  'wikipedia',
  'wikidata',
  'duckduckgo',
  // The narrow verticals of the web-search layer: they are consulted only
  // when the topic of the request matches their domain, and every result
  // carries the id of its own source — so the evidence layer must be able to
  // name them.
  'openalex',
  'crossref',
  'europepmc',
  'gdelt',
  'nominatim',
  'openlibrary',
  'stackexchange',
  'hn',
  'web',
  'consensus',
];

/** Allowed evidence levels (highest → lowest weight). */
export const EVIDENCE_LEVELS = ['canon', 'high', 'medium', 'low'];

/** Stable rank for evidence-level ordering (lower = stronger). */
const EVIDENCE_RANK = {
  canon: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Truncate extractedText in the rendered block to keep prompts small. */
const RENDER_TEXT_LIMIT = 400;

/**
 * Normalize an incoming research-source descriptor (from any provider) into a
 * single canonical object with every field the schema expects.
 *
 * @param {object} input
 * @param {string} input.provider      One of RESEARCH_PROVIDERS.
 * @param {string} [input.url]         Canonical source URL.
 * @param {string} [input.title]
 * @param {string} [input.snippet]     Short SERP-like snippet.
 * @param {string} [input.extractedText] Readability / AI extract (full text).
 * @param {string} [input.evidenceLevel='medium'] One of EVIDENCE_LEVELS.
 * @param {Date|string|null} [input.publishedAt]
 * @param {object|null} [input.metadata] Extra provider data (pmid, mesh, doi…).
 * @param {string|null} [input.query]   Search query that produced this source.
 * @returns {{provider:string, sourceUrl:string, normalizedUrl:string, title:string, snippet:string, extractedText:string, evidenceLevel:string, publishedAt:Date|string|null, metadata:object|null, query:string|null}}
 * @throws {Error} if provider or evidenceLevel is invalid.
 */
export function normalizeResearchSource({
  provider,
  url,
  title,
  snippet,
  extractedText,
  evidenceLevel = 'medium',
  publishedAt = null,
  metadata = null,
  query = null,
} = {}) {
  if (!RESEARCH_PROVIDERS.includes(provider)) {
    throw new Error(
      `normalizeResearchSource: неизвестный provider "${provider}". Допустимо: ${RESEARCH_PROVIDERS.join(', ')}.`
    );
  }

  if (!EVIDENCE_LEVELS.includes(evidenceLevel)) {
    throw new Error(
      `normalizeResearchSource: неизвестный evidenceLevel "${evidenceLevel}". Допустимо: ${EVIDENCE_LEVELS.join(', ')}.`
    );
  }

  const sourceUrl = url || '';
  // normalizedUrl powers the @@unique([articleId, normalizedUrl, provider])
  // constraint — collapsing www/trailing-slash/http-vs-https/query/fragment
  // variants of the same page. Empty when sourceUrl is empty/invalid (NULL in
  // the column, which does not conflict under the composite unique constraint).
  const normalizedUrl = canonicalSignature(sourceUrl);

  // A2: own-site promotion. When the URL points to one of our own site domains
  // (for example example.com), it is NOT external evidence — it is our
  // canonical content. Promote it to the strongest evidence level and flag it,
  // so downstream roles (article-author, factchecker) treat it as the highest
  // truth and renderResearchSourcesBlock floats it to the top of the block.
  // We force 'canon' regardless of the caller-supplied level (canon > high),
  // and stamp metadata.isOwn = true for an audit trail / downstream filtering.
  const own = isOwnSiteUrl(sourceUrl);
  const finalEvidenceLevel = own ? 'canon' : evidenceLevel;
  const finalMetadata = own
    ? { ...(metadata && typeof metadata === 'object' ? metadata : null), isOwn: true }
    : metadata ?? null;

  return {
    provider,
    sourceUrl,
    normalizedUrl,
    title: title || '',
    snippet: snippet || '',
    extractedText: extractedText || '',
    evidenceLevel: finalEvidenceLevel,
    publishedAt: publishedAt ?? null,
    metadata: finalMetadata,
    query: query ?? null,
  };
}

/** Capitalization map per provider for prompt rendering. */
const PROVIDER_LABEL = {
  tavily: 'TAVILY',
  'tavily-keyless': 'TAVILY',
  serper: 'SERPER',
  yandex: 'YANDEX',
  wikipedia: 'WIKIPEDIA',
  wikidata: 'WIKIDATA',
  duckduckgo: 'DUCKDUCKGO',
  openalex: 'OPENALEX',
  crossref: 'CROSSREF',
  europepmc: 'EUROPEPMC',
  gdelt: 'GDELT',
  nominatim: 'NOMINATIM',
  openlibrary: 'OPENLIBRARY',
  stackexchange: 'STACKEXCHANGE',
  hn: 'HACKERNEWS',
  web: 'WEB',
  consensus: 'CONSENSUS',
};

/**
 * Truncate a string to `limit` chars, appending "…" when truncated.
 * @param {string} str
 * @param {number} limit
 * @returns {string}
 */
function truncate(str, limit) {
  if (!str) return '';
  if (str.length <= limit) return str;
  return `${str.slice(0, limit)}…`;
}

/**
 * Render the list of external research sources into a prompt block injected
 * after the specialist/service card.
 *
 * Format (frozen block format):
 *   📚 Внешние источники (evidence-слой):
 *   [DUCKDUCKGO/HIGH] <title> — <extractedText> (<sourceUrl>)
 *   ...
 *
 * Sources are ordered canon → high → medium → low (strongest evidence first),
 * then by a stable secondary key (title) so the block is deterministic.
 *
 * @param {Array<object>|null|undefined} externalResearch
 * @returns {string} The block string, or '' when the list is empty/null.
 */
export function renderResearchSourcesBlock(externalResearch) {
  if (!Array.isArray(externalResearch) || externalResearch.length === 0) {
    return '';
  }

  const ordered = [...externalResearch].sort((a, b) => {
    const rankA = EVIDENCE_RANK[a.evidenceLevel] ?? EVIDENCE_RANK.low;
    const rankB = EVIDENCE_RANK[b.evidenceLevel] ?? EVIDENCE_RANK.low;
    if (rankA !== rankB) return rankA - rankB;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

  const lines = ordered.map((src) => {
    const provider = PROVIDER_LABEL[src.provider] || String(src.provider || '').toUpperCase();
    const level = String(src.evidenceLevel || 'medium').toUpperCase();
    const title = src.title || '(без названия)';
    const text = truncate(src.extractedText || '', RENDER_TEXT_LIMIT);
    const url = src.sourceUrl || '';
    return `[${provider}/${level}] ${title} — ${text} (${url})`;
  });

  return ['📚 Внешние источники (evidence-слой):', ...lines].join('\n');
}

/**
 * M1: ResearchSource.metadata is a JSON-encoded STRING on
 * SQLite (no Json column type). These two helpers are the single
 * (de)serialization boundary for that column.
 *
 * @param {object|null|undefined} metadata - normalized-source metadata object
 * @returns {string|undefined} JSON string, or undefined to skip the write
 */
export function serializeResearchMetadata(metadata) {
  if (metadata === undefined || metadata === null) return undefined;
  return JSON.stringify(metadata);
}

/**
 * @param {string|null|undefined} raw - DB column value
 * @returns {object|null} parsed object (null when absent or unparsable)
 */
export function parseResearchMetadata(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
