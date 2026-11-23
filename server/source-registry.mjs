/**
 * Source registry — the list of sites whose pages count as OUR OWN canonical
 * content (not external research evidence).
 *
 * GeneRaptor ships with ZERO default entries: the open-source build must not
 * carry any site brand (name, domains, links) of the original project.
 * The MECHANISM stays — a self-hosted deployment registers its own sites via
 * the `GENERAPTOR_SOURCE_REGISTRY` environment variable (a path to a JSON
 * file). The file is read once at startup, so a restart picks up changes.
 *
 * Registry file shape:
 *
 *   [
 *     {
 *       "id": "my-site",
 *       "name": "My Site",
 *       "baseUrl": "https://example.com",
 *       "specialistsIndex": "https://example.com/team/",
 *       "servicesIndex": "https://example.com/services/",
 *       "prices": "https://example.com/prices/",
 *       "llms": "https://example.com/llms.txt",
 *       "sitemap": "https://example.com/sitemap.xml"
 *     }
 *   ]
 *
 * `doctorsIndex` is still accepted as a legacy alias of `specialistsIndex`
 * (older registry files keep working).
 *
 * Graceful degradation (D2, research layer KEPT): an empty or broken
 * registry NEVER breaks the pipeline. Every provider result then stays
 * external evidence (no promotion to `canon`), and the research layer falls
 * back to plain web search.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Env var holding the path to the deployment's own registry file. */
export const SOURCE_REGISTRY_ENV = 'GENERAPTOR_SOURCE_REGISTRY';

/**
 * Core links of a registered site (home + index pages).
 * Links without a URL are skipped.
 * @returns {{kind: string, label: string, url: string}[]}
 */
export function makeCoreLinks(
  baseUrl,
  specialistsIndex,
  servicesIndex,
  prices,
  llms,
  sitemap
) {
  return [
    { kind: 'home', label: 'Главная', url: baseUrl },
    { kind: 'specialistsIndex', label: 'Специалисты', url: specialistsIndex },
    { kind: 'servicesIndex', label: 'Услуги', url: servicesIndex },
    { kind: 'prices', label: 'Цены', url: prices },
    { kind: 'llms', label: 'llms.txt', url: llms },
    { kind: 'sitemap', label: 'sitemap.xml', url: sitemap },
  ].filter((link) => typeof link.url === 'string' && link.url.trim() !== '');
}

/**
 * Normalize one registry entry. Entries without `id` or `baseUrl` are
 * dropped — a hostless entry can never be matched.
 * @param {unknown} entry
 * @returns {object|null}
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
  if (!id || !baseUrl) return null;

  const core =
    Array.isArray(entry.core) && entry.core.length > 0
      ? entry.core
      : makeCoreLinks(
          baseUrl,
          entry.specialistsIndex ?? entry.doctorsIndex,
          entry.servicesIndex,
          entry.prices,
          entry.llms,
          entry.sitemap
        );

  return { ...entry, id, baseUrl, core };
}

/**
 * Load the registry from the environment. Never throws: a missing or broken
 * file degrades to an empty registry (the pipeline keeps running).
 * @param {Record<string, string|undefined>} [env]
 * @returns {object[]}
 */
function loadRegistry(env = process.env) {
  const raw = env ? env[SOURCE_REGISTRY_ENV] : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  const file = isAbsolute(raw.trim()) ? raw.trim() : resolve(process.cwd(), raw.trim());
  try {
    if (!existsSync(file)) {
      console.warn(
        `[SourceRegistry] ${SOURCE_REGISTRY_ENV} points to a missing file — continuing with an empty registry`
      );
      return [];
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.sites)
        ? parsed.sites
        : [];
    return list.map(normalizeEntry).filter(Boolean);
  } catch (err) {
    console.warn(
      `[SourceRegistry] cannot read the registry file (${err?.message || err}) — continuing with an empty registry`
    );
    return [];
  }
}

/**
 * Registered own sites. Empty by default — GeneRaptor ships no brands.
 * @type {object[]}
 */
export const sourceRegistry = loadRegistry();

/**
 * Look up a registered site by id.
 * @param {string} sourceId
 * @returns {object|null}
 */
export function getSourceById(sourceId) {
  return sourceRegistry.find((source) => source.id === sourceId) || null;
}
