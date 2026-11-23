/**
 * URL normalization — produces a canonical signature for deduplication.
 *
 * Research sources (ResearchSource) arrive from multiple providers and multiple
 * consensus rounds. The same page is often recorded under different URL shapes
 * that all resolve to the same content:
 *
 *   https://site.ru/foo/        (trailing slash)
 *   https://www.site.ru/foo     (www prefix)
 *   https://SITE.ru/foo         (uppercase host)
 *   http://site.ru/foo?ref=bar  (http + query)
 *
 * `canonicalSignature` collapses these into a single stable string so that
 * 1. the dedup script can find semantic duplicates, and
 * 2. the `@@unique([articleId, normalizedUrl, provider])` constraint prevents
 *    new duplicates from being inserted.
 *
 * Design choices:
 *   - Protocol is forced to `https` (the canonical scheme for content pages).
 *   - Hostname is lowercased and the leading `www.` is stripped.
 *   - Path case is PRESERVED (segments are not lowercased) — many servers treat
 *     `/Foo` and `/foo` as different pages, so collapsing case would create
 *     false-positive merges. Only the host is case-insensitive.
 *   - Trailing slashes are removed (`/foo/` → `/foo`); multiple trailing
 *     slashes collapse too (`/foo//` → `/foo`).
 *   - Query string and fragment are dropped.
 *   - Port is preserved (a different port is a different origin).
 *   - Invalid / non-string / empty input returns `''` (safe for dedup keys —
 *     empty signatures simply don't match each other for non-empty URLs).
 *
 * Derived from the canonical-signature pattern used for crawled pages,
 * but tailored for the ResearchSource use case (keeps the protocol, returns '' not null).
 */

/**
 * Normalize a URL into a canonical signature for deduplication.
 *
 * @param {string} urlString
 * @returns {string} Canonical signature (e.g. `https://site.ru/foo`), or `''`
 *                   when the input is empty / non-string / not a parseable URL.
 */
export function canonicalSignature(urlString) {
  if (typeof urlString !== 'string') return '';
  const trimmed = urlString.trim();
  if (!trimmed) return '';

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return '';
  }

  // Only http(s) URLs are meaningful research-source URLs.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';

  // lowercase host + strip leading www.
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  // port (empty string for the scheme default ports — keep others)
  const port = u.port && u.port !== '' ? `:${u.port}` : '';
  // pathname without trailing slashes (root '/' becomes '')
  let path = u.pathname.replace(/\/+$/, '');
  if (path === '') path = '';

  return `https://${host}${port}${path}`;
}
