/**
 * Own-site domain detection — flags URLs that belong to our own sites.
 *
 * External search providers (duckduckgo, serper, yandex) occasionally surface URLs that
 * point back to our own sites (for example `example.com`). Such URLs are not
 * "external evidence" — they are our canonical content. This module lets the
 * research-source pipeline promote them to `evidenceLevel: 'canon'` and mark
 * `metadata.isOwn`, so downstream roles treat them as the highest-truth source.
 *
 * The list of own domains is derived from `sourceRegistry` (server/source-registry.mjs),
 * so registering a new site automatically makes its domain recognised here.
 * GeneRaptor ships an EMPTY registry — a deployment registers its own sites via
 * `GENERAPTOR_SOURCE_REGISTRY`. With an empty registry no URL is "own", every
 * provider result stays external evidence, and the research layer degrades to
 * plain web search instead of failing.
 *
 * Only EXACT host matches count (after lowercasing + stripping the leading `www.`).
 * We deliberately do NOT do suffix matching, to avoid spoofing like
 * `evil-example.com` or `example.com.evil.com`.
 */

import { sourceRegistry } from '../source-registry.mjs';

/**
 * Extract the bare hostname from a baseUrl in the registry.
 * Strips scheme and leading `www.`, lowercases. Returns '' on failure.
 * @param {string} baseUrl
 * @returns {string}
 */
function hostFromBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return '';
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return '';
  }
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Returns the list of own domains (bare hosts, no scheme/www).
 * Derived from `sourceRegistry` so it stays in sync with the registry.
 * @returns {string[]}
 */
export function ownDomains() {
  const hosts = new Set();
  for (const src of sourceRegistry) {
    const host = hostFromBaseUrl(src?.baseUrl);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/** Memoised host set (computed once per registry state). */
let _ownHosts = null;
let _ownHostsKey = null;
function ownHosts() {
  const key = sourceRegistry.map((src) => src?.baseUrl || '').join('|');
  if (_ownHosts === null || _ownHostsKey !== key) {
    _ownHosts = new Set(ownDomains());
    _ownHostsKey = key;
  }
  return _ownHosts;
}

/**
 * Does `url` point to one of our own registered sites?
 *
 * Matches on EXACT host equality (after lowercasing + stripping leading `www.`).
 * No suffix matching — `evil-example.com` is NOT our site.
 *
 * @param {string} url The URL to test.
 * @param {string} [_sourceSiteId] Optional source-site id (accepted for API
 *   symmetry; the registry is the source of truth, so this does not change the
 *   result — kept so callers can pass it through without conditional logic).
 * @returns {boolean}
 */
export function isOwnSiteUrl(url, _sourceSiteId) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return false;

  return ownHosts().has(host);
}
