/**
 * Outbound User-Agent contract for the research/search layer
 * (factory hardening, item H-03 / defect D-C5-6).
 *
 * Contract D19 (docs/decisions.md): every outbound research request must
 * identify the crawler as `GeneRaptorResearchBot`. The string used to be
 * duplicated across several clients, so the contract was enforced in several
 * places and could be violated in another one.
 *
 * The guard is BEHAVIOURAL: it intercepts the real HTTP calls the search
 * backends make and inspects the headers they actually send.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const { fetchWithRetry: fetchYandexPage } = await import('../../server/lib/yandex-search.mjs');
const duckduckgo = await import('../../server/lib/web-search/duckduckgo.mjs');
const serper = await import('../../server/lib/web-search/serper.mjs');
const yandexBackend = await import('../../server/lib/web-search/yandex.mjs');

const CONTRACT_ID = 'GeneRaptorResearchBot';

/** Stub global fetch and record every outbound request. */
function recordFetches() {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      return {
        ok: true,
        status: 200,
        url: String(url),
        headers: {
          get: () => null,
          getSetCookie: () => [],
        },
        text: async () => '',
        json: async () => ({}),
      };
    }),
  );
  return calls;
}

function userAgentsOf(calls) {
  return calls.map((call) => call.headers['User-Agent'] || call.headers['user-agent']);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('research User-Agent contract (D19 / D-C5-6)', () => {
  it('yandex research fetches identify as GeneRaptorResearchBot', async () => {
    const calls = recordFetches();
    await fetchYandexPage('https://example.com/article');

    expect(calls.length).toBeGreaterThan(0);
    expect(userAgentsOf(calls)).toEqual([
      'GeneRaptorResearchBot/1.0 (+https://generaptor.local; research evidence gathering)',
    ]);
  });

  it('keyless web search identifies as GeneRaptorResearchBot, not as a browser', async () => {
    const calls = recordFetches();
    await duckduckgo
      .search('gene raptor research', { fetchImpl: globalThis.fetch })
      .catch(() => []);

    expect(calls.length).toBeGreaterThan(0);
    for (const ua of userAgentsOf(calls)) {
      expect(ua).toBeTruthy();
      expect(ua.startsWith(CONTRACT_ID)).toBe(true);
      expect(ua).not.toMatch(/Mozilla/i);
    }
    expect(new Set(userAgentsOf(calls))).toEqual(
      new Set(['GeneRaptorResearchBot/1.0 (+https://generaptor.local; web search (keyless))']),
    );
  });

  it('serper search identifies as GeneRaptorResearchBot, not as a browser', async () => {
    const calls = recordFetches();
    await serper
      .search('gene raptor research', {
        env: { GENERAPTOR_SERPER_API_KEY: 'test-key' },
        fetchImpl: globalThis.fetch,
      })
      .catch(() => []);

    expect(calls.length).toBeGreaterThan(0);
    for (const ua of userAgentsOf(calls)) {
      expect(ua).toBeTruthy();
      expect(ua.startsWith(CONTRACT_ID)).toBe(true);
      expect(ua).not.toMatch(/Mozilla/i);
    }
    expect(new Set(userAgentsOf(calls))).toEqual(
      new Set(['GeneRaptorResearchBot/1.0 (+https://generaptor.local; web search (serper))']),
    );
  });

  it('yandex backend search identifies as GeneRaptorResearchBot', async () => {
    const calls = recordFetches();
    await yandexBackend
      .search('gene raptor research', {
        env: { GENERAPTOR_YANDEX_API_KEY: 'test-key' },
        fetchImpl: globalThis.fetch,
      })
      .catch(() => []);

    expect(calls.length).toBeGreaterThan(0);
    for (const ua of userAgentsOf(calls)) {
      expect(ua).toBeTruthy();
      expect(ua.startsWith(CONTRACT_ID)).toBe(true);
      expect(ua).not.toMatch(/Mozilla/i);
    }
  });
});
