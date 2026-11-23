/**
 * Bibliography rendering — turns the article-author source registry into a
 * footnote block appended to the article.
 *
 * Pipeline context (B2):
 *   - article-author returns `sourceMapRu`: an array of registry entries shaped
 *     { n, provider, sourceUrl, title } (n = "1".."N" for external sources,
 *     "card" for the service card).
 *   - Inline markers {{src:N}} are stripped before publication
 *     (strip-citations.mjs), so the reader lost every link to a source.
 *   - This module rebuilds that link as a `## Источники` footnote section,
 *     appended to the article markdown BEFORE renderMarkdownToHtml (B1) so the
 *     markdown links `[title](url)` become real `<a>` tags in content_html.
 *
 * Rules:
 *   - Empty / no-url sourceMap → '' (caller must not append anything).
 *   - Entries without a usable url are skipped.
 *   - Entries sharing the same url are deduplicated (first title wins) to avoid
 *     repeating a source that came in under multiple markers/providers.
 *   - Title falls back to the url when missing.
 *   - Numbering is contiguous (1, 2, 3 …) after skipping/dedup, independent of
 *     the author's original `n` values.
 */

/**
 * Is `s` a non-empty string after trimming?
 * @param {unknown} s
 * @returns {boolean}
 */
function isNonEmptyString(s) {
  return typeof s === 'string' && s.trim() !== '';
}

/**
 * Render a sourceMap registry into a `## Источники` markdown footnote block.
 *
 * @param {Array<{n?:string, provider?:string, sourceUrl?:string, title?:string}>|null|undefined} sourceMap
 * @returns {string} The footnote block markdown (no leading/trailing blank line),
 *                   or '' when there is nothing to show.
 */
export function renderBibliography(sourceMap) {
  if (!Array.isArray(sourceMap) || sourceMap.length === 0) return '';

  const seenUrls = new Set();
  const items = [];

  for (const entry of sourceMap) {
    if (!entry || typeof entry !== 'object') continue;

    const url = isNonEmptyString(entry.sourceUrl) ? entry.sourceUrl.trim() : '';
    if (!url) continue; // skip sources without a usable url
    if (seenUrls.has(url)) continue; // dedup by url (first title wins)
    seenUrls.add(url);

    const title = isNonEmptyString(entry.title) ? entry.title.trim() : url;
    items.push({ title, url });
  }

  if (items.length === 0) return '';

  const lines = ['## Источники', ''];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. [${item.title}](${item.url})`);
  });

  return lines.join('\n');
}
