/**
 * Contract tests for the attribution of the search results in the worker.
 *
 * The web-search layer returns the provider of every item: the id of the main
 * engine or the id of a narrow vertical. The worker must use THAT value —
 * otherwise a vertical source would be stored in the evidence layer under the
 * name of the main engine, and the attribution of the article would lie.
 */
import { describe, it, expect } from 'vitest';
import { researchProviderFor } from '../../server/workers/article-generation.mjs';
import { RESEARCH_PROVIDERS } from '../../server/lib/research-source.mjs';
import { VERTICAL_BACKEND_IDS } from '../../server/lib/web-search/verticals/index.mjs';

describe('worker — provider of a search result', () => {
  it('takes the provider of the item itself', () => {
    expect(researchProviderFor({ provider: 'europepmc' }, 'serper')).toBe('europepmc');
  });

  it('falls back to the backend of the search when the item has no provider', () => {
    expect(researchProviderFor({}, 'serper')).toBe('serper');
  });

  it('falls back to "web" when nothing is known', () => {
    expect(researchProviderFor({}, null)).toBe('web');
    expect(researchProviderFor({}, '')).toBe('web');
  });

  it('never returns a provider the evidence layer does not know', () => {
    expect(researchProviderFor({ provider: 'unknown-source' }, 'serper')).toBe('serper');
    expect(researchProviderFor({ provider: 'unknown-source' }, null)).toBe('web');
  });

  it('accepts every vertical id as a research provider', () => {
    for (const id of VERTICAL_BACKEND_IDS) {
      expect(RESEARCH_PROVIDERS).toContain(id);
    }
  });
});
