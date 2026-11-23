import { describe, it, expect } from 'vitest';
import { renderBibliography } from '../../server/lib/bibliography.mjs';

describe('renderBibliography — footnote block (B2)', () => {
  it('returns empty string for an empty / null / non-array sourceMap', () => {
    expect(renderBibliography([])).toBe('');
    expect(renderBibliography(null)).toBe('');
    expect(renderBibliography(undefined)).toBe('');
    expect(renderBibliography('not an array')).toBe('');
    expect(renderBibliography({})).toBe('');
  });

  it('builds a "## Источники" section with a numbered list of markdown links', () => {
    const md = renderBibliography([
      { n: '1', provider: 'duckduckgo', sourceUrl: 'https://example.org/11/', title: 'Study A' },
      { n: '2', provider: 'duckduckgo', sourceUrl: 'https://example.org/22/', title: 'Study B' },
    ]);
    expect(md).toContain('## Источники');
    expect(md).toContain('1. [Study A](https://example.org/11/)');
    expect(md).toContain('2. [Study B](https://example.org/22/)');
  });

  it('does not emit a block when no entry has a usable url', () => {
    const md = renderBibliography([
      { n: '1', provider: 'duckduckgo', sourceUrl: '', title: 'No URL' },
      { n: '2', provider: 'duckduckgo', sourceUrl: null, title: 'Null URL' },
    ]);
    expect(md).toBe('');
  });

  it('skips entries without a url but keeps the ones with a url', () => {
    const md = renderBibliography([
      { n: '1', provider: 'duckduckgo', sourceUrl: 'https://example.com/a', title: 'A' },
      { n: '2', provider: 'duckduckgo', sourceUrl: '', title: 'No URL' },
      { n: '3', provider: 'duckduckgo', sourceUrl: 'https://example.com/b', title: 'B' },
    ]);
    expect(md).toContain('[A](https://example.com/a)');
    expect(md).toContain('[B](https://example.com/b)');
    expect(md).not.toContain('No URL');
    // numbering is contiguous after skipping
    expect(md).toMatch(/1\.\s+\[A\]/);
    expect(md).toMatch(/2\.\s+\[B\]/);
  });

  it('uses the title as anchor text, falling back to the url when title is missing', () => {
    const md = renderBibliography([
      { n: '1', provider: 'duckduckgo', sourceUrl: 'https://example.com/x', title: '' },
    ]);
    expect(md).toContain('[https://example.com/x](https://example.com/x)');
  });

  it('deduplicates entries that share the same url (keeps first title)', () => {
    const md = renderBibliography([
      { n: '1', provider: 'duckduckgo', sourceUrl: 'https://example.com/same', title: 'First' },
      { n: '2', provider: 'yandex', sourceUrl: 'https://example.com/same', title: 'Second' },
    ]);
    expect(md).toContain('[First](https://example.com/same)');
    expect(md).not.toContain('Second');
    // only one entry remains
    expect(md.match(/^\d+\./gm).length).toBe(1);
  });

  it('escapes nothing destructive — keeps the url intact in the href', () => {
    const md = renderBibliography([
      { n: '1', provider: 'duckduckgo', sourceUrl: 'https://example.com/path?x=1&y=2', title: 'Q' },
    ]);
    expect(md).toContain('](https://example.com/path?x=1&y=2)');
  });

  it('handles a card entry (own service) like any other source', () => {
    const md = renderBibliography([
      { n: 'card', provider: 'internal', sourceUrl: 'https://example.com/services/x', title: 'Ботулинотерапия' },
      { n: '1', provider: 'duckduckgo', sourceUrl: 'https://example.org/1', title: 'Doc' },
    ]);
    expect(md).toContain('[Ботулинотерапия](https://example.com/services/x)');
    expect(md).toContain('[Doc](https://example.org/1)');
  });

  it('is appendable: the block ends with a single trailing newline for clean join', () => {
    const md = renderBibliography([
      { n: '1', provider: 'duckduckgo', sourceUrl: 'https://example.com/a', title: 'A' },
    ]);
    // starts with the heading line, no leading blank line (caller adds spacing)
    expect(md.startsWith('## Источники')).toBe(true);
  });
});
