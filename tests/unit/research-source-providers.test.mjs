/**
 * Contract test: every search backend must be a valid research provider.
 *
 * The worker stores the backend id as the ResearchSource.provider, so an
 * unknown id would make `normalizeResearchSource` throw and silently drop the
 * whole evidence layer.
 */
import { describe, it, expect } from 'vitest';
import { RESEARCH_PROVIDERS, normalizeResearchSource } from '../../server/lib/research-source.mjs';
import { SEARCH_BACKEND_IDS } from '../../server/lib/web-search/index.mjs';

describe('research providers vs search backends', () => {
  it('accepts every search backend id as a research provider', () => {
    for (const id of SEARCH_BACKEND_IDS) {
      expect(RESEARCH_PROVIDERS).toContain(id);
    }
  });

  it('normalizes a source produced by each backend id', () => {
    for (const id of SEARCH_BACKEND_IDS) {
      const source = normalizeResearchSource({
        provider: id,
        url: 'https://example.com/page',
        title: 'Example',
        snippet: 'Snippet',
        extractedText: 'Snippet',
      });
      expect(source.provider).toBe(id);
      expect(source.sourceUrl).toBe('https://example.com/page');
    }
  });
});
