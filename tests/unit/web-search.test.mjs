/**
 * Contract tests for the pluggable web-search layer.
 *
 * The layer must work out of the box (the keyless Tavily mode is the
 * default), support several backends behind one contract, never use the
 * unofficial scraping backend unless it is explicitly selected, and degrade
 * gracefully: no thrown errors, no 500s, empty result set instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

const TAVILY_PAYLOAD = {
  results: [
    { title: 'Tavily result', url: 'https://example.com/tavily', content: 'Tavily content' },
  ],
};

const WIKIPEDIA_PAYLOAD = {
  query: {
    search: [
      {
        ns: 0,
        title: 'Универсальный генератор',
        pageid: 42,
        snippet: '<span class="searchmatch">Универсальный генератор</span> — описание статьи.',
      },
    ],
  },
};

const WIKIDATA_PAYLOAD = {
  search: [
    {
      id: 'Q42',
      label: 'Универсальный генератор',
      description: 'программное средство',
      concepturi: 'http://www.wikidata.org/entity/Q42',
    },
  ],
};

const DDG_HTML = `
<html><body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First result</a>
    <a class="result__snippet">Snippet one</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://example.org/two">Second result</a>
    <a class="result__snippet">Snippet two</a>
  </div>
</body></html>
`;

const DDG_BLOCKED_HTML = `
<html><body>
  <div id="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div>
  <script src="/dist/anomaly.js"></script>
</body></html>
`;

function jsonResponse(payload, init = {}) {
  return {
    ok: init.ok !== false,
    status: init.status ?? 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/** Fetches nothing; returns the captured calls. */
function captureFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return { calls, fetchImpl };
}

const ENV_KEYS = [
  'GENERAPTOR_SEARCH_BACKEND',
  'GENERAPTOR_TAVILY_API_KEY',
  'GENERAPTOR_SERPER_API_KEY',
  'GENERAPTOR_YANDEX_API_KEY',
  'GENERAPTOR_SEARCH_LANG',
  'GENERAPTOR_SEARCH_TIMEOUT_MS',
  'YANDEX_SEARCH_API_KEY',
];

// The environment of the search layer is global: every suite in this file
// must start from a clean slate, otherwise a key set by one test silently
// changes the automatic chain of the next one.
let savedEnv = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('web-search layer', () => {
  it('exposes at least three backends behind one contract', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    expect(mod.SEARCH_BACKEND_IDS.length).toBeGreaterThanOrEqual(3);
    expect(mod.SEARCH_BACKEND_IDS).toContain('tavily-keyless');
    expect(mod.SEARCH_BACKEND_IDS).toContain('wikipedia');
    expect(mod.SEARCH_BACKEND_IDS).toContain('serper');
    expect(mod.SEARCH_BACKEND_IDS).toContain('yandex');

    for (const id of mod.SEARCH_BACKEND_IDS) {
      const backend = mod.getSearchBackend(id);
      expect(typeof backend.search).toBe('function');
      expect(typeof backend.id).toBe('string');
    }
  });

  it('defaults to the keyless backend when no env is set', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const resolved = mod.resolveSearchBackend(process.env);
    expect(resolved.id).toBe('auto');
    expect(resolved.source).toBe('default');
    expect(mod.DEFAULT_SEARCH_BACKEND).toBe('tavily-keyless');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    const outcome = await mod.searchWeb({ query: 'universal generator', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('tavily-keyless');
    expect(outcome.degraded).toBe(false);
    expect(outcome.results).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TAVILY_ENDPOINT);
    // The keyless backend must never send an API key.
    const headers = calls[0].options.headers || {};
    expect(headers['X-Tavily-Access-Mode']).toBe('keyless');
    expect(headers['X-API-KEY']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it('falls back to the encyclopedic layer when the keyless backend is rate-limited', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('api.tavily.com')) {
        return jsonResponse({ detail: 'keyless rate limit' }, { ok: false, status: 429 });
      }
      if (url.includes('ru.wikipedia.org')) return jsonResponse(WIKIPEDIA_PAYLOAD);
      return jsonResponse(WIKIDATA_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'fallback chain', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('wikipedia');
    expect(outcome.degraded).toBe(false);
    expect(outcome.results[0].url).toContain('ru.wikipedia.org');
    expect(calls).toHaveLength(2);
    expect(outcome.attempts.map((a) => a.backend)).toEqual(['tavily-keyless', 'wikipedia']);
  });

  it('reports an honest reason when the keyless mode is refused (HTTP 403)', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('api.tavily.com')) {
        return jsonResponse('Forbidden', { ok: false, status: 403 });
      }
      if (url.includes('ru.wikipedia.org')) return jsonResponse(WIKIPEDIA_PAYLOAD);
      return jsonResponse(WIKIDATA_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'keyless refused', limit: 5, fetchImpl });

    // The keyless mode is refused by the provider (no key is involved) — the
    // reason must say so, and the chain must continue.
    expect(outcome.attempts[0].code).toBe('keyless_unavailable');
    expect(outcome.backend).toBe('wikipedia');
    expect(outcome.degraded).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('degrades gracefully when every backend of the chain fails', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('api.tavily.com')) {
        return jsonResponse({ detail: 'limit' }, { ok: false, status: 429 });
      }
      if (url.includes('wikipedia.org')) {
        return jsonResponse({ error: { code: 'ratelimited' } }, { ok: false, status: 429 });
      }
      throw new Error('getaddrinfo ENOTFOUND www.wikidata.org');
    });

    const outcome = await mod.searchWeb({ query: 'everything fails', limit: 5, fetchImpl });

    expect(outcome.results).toEqual([]);
    expect(outcome.degraded).toBe(true);
    expect(outcome.reason).toBe('network_unavailable');
    expect(calls).toHaveLength(3);
  });

  it('never uses the unofficial scraping backend by default', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('api.tavily.com')) {
        return jsonResponse({ detail: 'limit' }, { ok: false, status: 429 });
      }
      if (url.includes('wikipedia.org')) {
        return jsonResponse({ error: { code: 'ratelimited' } }, { ok: false, status: 429 });
      }
      return jsonResponse(WIKIDATA_PAYLOAD);
    });

    await mod.searchWeb({ query: 'no unofficial backend', limit: 5, fetchImpl });

    for (const call of calls) {
      expect(call.url).not.toContain('duckduckgo.com');
    }
  });

  it('uses the unofficial backend only when it is explicitly selected', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_BACKEND = 'duckduckgo';

    const { calls, fetchImpl } = captureFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => DDG_HTML,
    }));

    const outcome = await mod.searchWeb({ query: 'opt in', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('duckduckgo');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('duckduckgo.com');
  });

  it('marks the unofficial backend as opt-in and describes its limits', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const described = mod.describeSearchBackends(process.env);
    const ddg = described.find((b) => b.id === 'duckduckgo');

    expect(ddg.unofficial).toBe(true);
    expect(ddg.official).toBe(false);
    expect(ddg.optIn).toBe(true);
    expect(ddg.requiresKey).toBe(false);
    expect(String(ddg.notes).toLowerCase()).toMatch(/неофициальн|скрейп|scrap/i);
  });

  it('returns the contract shape { title, url, snippet }', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    const outcome = await mod.searchWeb({ query: 'contract shape', limit: 5, fetchImpl });

    expect(outcome.results.length).toBeGreaterThan(0);
    for (const item of outcome.results) {
      expect(typeof item.title).toBe('string');
      expect(typeof item.url).toBe('string');
      expect(typeof item.snippet).toBe('string');
      expect(item.url).toMatch(/^https?:\/\//);
    }
  });

  it('honours the limit option', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { fetchImpl } = captureFetch(async () => jsonResponse({
      results: [
        { title: 'A', url: 'https://example.com/a', content: 'a' },
        { title: 'B', url: 'https://example.com/b', content: 'b' },
      ],
    }));

    const outcome = await mod.searchWeb({ query: 'limit me', limit: 1, fetchImpl });
    expect(outcome.results).toHaveLength(1);
  });

  it('selects the backend via GENERAPTOR_SEARCH_BACKEND', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_BACKEND = 'serper';
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';

    const resolved = mod.resolveSearchBackend(process.env);
    expect(resolved.id).toBe('serper');
    expect(resolved.source).toBe('env');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({
      organic: [{ title: 'Serper result', link: 'https://example.com/serper', snippet: 'Serper snippet' }],
    }));

    const outcome = await mod.searchWeb({ query: 'backend selection', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('serper');
    expect(outcome.results[0].url).toBe('https://example.com/serper');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SERPER_ENDPOINT);
  });

  it('prefers a user-configured backend over the keyless fallback', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({
      organic: [{ title: 'Serper result', link: 'https://example.com/serper', snippet: 'Serper snippet' }],
    }));

    const outcome = await mod.searchWeb({ query: 'user backend first', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('serper');
    expect(calls[0].url).toBe(SERPER_ENDPOINT);
  });

  it('falls back to the keyless backend for an unknown backend value', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_BACKEND = 'nonsense';

    const resolved = mod.resolveSearchBackend(process.env);
    expect(resolved.id).toBe('auto');
    expect(resolved.source).toBe('env');
    expect(resolved.warning).toBeTruthy();
  });

  it('degrades gracefully when there is no network', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const fetchImpl = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.tavily.com');
    };

    const outcome = await mod.searchWeb({ query: 'offline', limit: 5, fetchImpl });

    expect(outcome.results).toEqual([]);
    expect(outcome.degraded).toBe(true);
    expect(outcome.reason).toBe('network_unavailable');
  });

  it('degrades gracefully when the quota is exhausted', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_BACKEND = 'serper';
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';

    const fetchImpl = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ message: 'quota exceeded' }),
      text: async () => 'quota exceeded',
    });

    const outcome = await mod.searchWeb({ query: 'quota', limit: 5, fetchImpl });

    expect(outcome.results).toEqual([]);
    expect(outcome.degraded).toBe(true);
    expect(outcome.reason).toBe('quota_exhausted');
  });

  it('skips a selected backend without a key and continues with the keyless chain', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_BACKEND = 'serper';

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('google.serper.dev')) {
        return jsonResponse({ organic: [{ title: 'Never', link: 'https://example.com/x', snippet: 'x' }] });
      }
      return jsonResponse(TAVILY_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'no key', limit: 5, fetchImpl });

    // The selected backend has no key: it must not be called at all.
    expect(calls.filter((c) => c.url.includes('google.serper.dev'))).toHaveLength(0);
    // ...and the keyless chain keeps the product working.
    expect(outcome.backend).toBe('tavily-keyless');
    expect(outcome.degraded).toBe(false);
    expect(outcome.attempts.find((a) => a.backend === 'serper').code).toBe('not_configured');
  });

  it('never sends an env key to a foreign or user-supplied endpoint', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_BACKEND = 'serper';
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ organic: [] }));

    await mod.searchWeb({
      query: 'd27 d28',
      limit: 5,
      fetchImpl,
      // A user-supplied base URL from the settings must never receive a key.
      providerBaseUrl: 'https://user-supplied.example.com/v1',
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].url).toBe(SERPER_ENDPOINT);
    expect(calls[0].options.headers['X-API-KEY']).toBe('serper-secret');
    for (const call of calls) {
      expect(call.url).not.toContain('user-supplied.example.com');
      if (call.url !== SERPER_ENDPOINT) {
        // The key must not travel to any other (fallback) endpoint.
        expect(JSON.stringify(call.options.headers || {})).not.toContain('serper-secret');
      }
    }
  });

  it('does not leak a Yandex key to the keyless backend', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_YANDEX_API_KEY = 'yandex-secret';

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    await mod.searchWeb({ query: 'no leak', limit: 5, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TAVILY_ENDPOINT);
    const headers = calls[0].options.headers || {};
    expect(headers['X-API-KEY']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain('yandex-secret');
  });

  it('does not leak a Serper key to another backend', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_BACKEND = 'yandex';
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';

    const { calls, fetchImpl } = captureFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => DDG_HTML,
    }));

    const outcome = await mod.searchWeb({ query: 'no leak either', limit: 5, fetchImpl });

    expect(outcome.degraded).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('serper-secret');
  });

  it('never sends the Tavily key to the keyless Tavily mode', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_TAVILY_API_KEY = 'tavily-secret';
    process.env.GENERAPTOR_SEARCH_BACKEND = 'tavily-keyless';

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    const outcome = await mod.searchWeb({ query: 'keyless mode', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('tavily-keyless');
    expect(calls).toHaveLength(1);
    const headers = calls[0].options.headers || {};
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain('tavily-secret');
  });

  it('never bypasses a challenge: one request to the unofficial backend, then the keyless chain', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_BACKEND = 'duckduckgo';

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('duckduckgo.com')) {
        return {
          ok: true,
          status: 200,
          text: async () => DDG_BLOCKED_HTML,
        };
      }
      return jsonResponse(TAVILY_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'blocked', limit: 5, fetchImpl });

    // Exactly one attempt against the unofficial backend: the client must not
    // try to bypass the challenge.
    expect(calls.filter((c) => c.url.includes('duckduckgo.com'))).toHaveLength(1);
    expect(outcome.attempts.find((a) => a.backend === 'duckduckgo').code).toBe('blocked');
    // The keyless chain recovers the search instead of failing the request.
    expect(outcome.backend).toBe('tavily-keyless');
    expect(outcome.degraded).toBe(false);
  });

  it('describes the available backends for the settings page', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const described = mod.describeSearchBackends(process.env);

    expect(described.length).toBeGreaterThanOrEqual(3);
    const byId = Object.fromEntries(described.map((b) => [b.id, b]));

    expect(byId['tavily-keyless'].requiresKey).toBe(false);
    expect(byId['tavily-keyless'].configured).toBe(true);
    expect(byId.wikipedia.requiresKey).toBe(false);
    expect(byId.wikipedia.configured).toBe(true);
    expect(byId.tavily.requiresKey).toBe(true);
    expect(byId.tavily.envKey).toBe('GENERAPTOR_TAVILY_API_KEY');
    expect(byId.tavily.configured).toBe(false);
    expect(byId.serper.requiresKey).toBe(true);
    expect(byId.serper.configured).toBe(false);
    expect(byId.serper.envKey).toBe('GENERAPTOR_SERPER_API_KEY');
    expect(byId.yandex.requiresKey).toBe(true);
    expect(byId.yandex.envKey).toBe('GENERAPTOR_YANDEX_API_KEY');
    expect(byId.yandex.configured).toBe(false);

    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';
    const configured = mod.describeSearchBackends(process.env);
    expect(configured.find((b) => b.id === 'serper').configured).toBe(true);
  });

  it('returns an empty result set for an empty query without touching the network', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ organic: [] }));

    const outcome = await mod.searchWeb({ query: '   ', limit: 5, fetchImpl });

    expect(calls).toHaveLength(0);
    expect(outcome.results).toEqual([]);
    expect(outcome.degraded).toBe(true);
    expect(outcome.reason).toBe('empty_query');
  });

  it('supports RU and EN languages', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SEARCH_LANG = 'en';

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('api.tavily.com')) {
        return jsonResponse({ detail: 'limit' }, { ok: false, status: 429 });
      }
      return jsonResponse(WIKIPEDIA_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'language', limit: 5, fetchImpl });

    expect(outcome.lang).toBe('en');
    expect(calls.some((c) => c.url.includes('en.wikipedia.org'))).toBe(true);
  });
});

describe('tavily backend', () => {
  it('uses the official keyless mode without any credential', async () => {
    const backend = await import('../../server/lib/web-search/tavily.mjs');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    const results = await backend.search('universal generator', {
      limit: 5,
      env: {},
      fetchImpl,
      mode: 'keyless',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Tavily result',
      url: 'https://example.com/tavily',
      snippet: 'Tavily content',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TAVILY_ENDPOINT);
    expect(calls[0].options.headers['X-Tavily-Access-Mode']).toBe('keyless');
    expect(calls[0].options.headers.Authorization).toBeUndefined();
  });

  it('sends the key only to the canonical endpoint in the keyed mode', async () => {
    const backend = await import('../../server/lib/web-search/tavily.mjs');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    await backend.search('tavily query', {
      limit: 5,
      env: { GENERAPTOR_TAVILY_API_KEY: 'tvly-secret' },
      fetchImpl,
      mode: 'keyed',
    });

    expect(calls[0].url).toBe(TAVILY_ENDPOINT);
    expect(calls[0].options.headers.Authorization).toBe('Bearer tvly-secret');
    expect(calls[0].options.headers['X-Tavily-Access-Mode']).toBeUndefined();
  });

  it('throws a typed quota error on HTTP 429', async () => {
    const backend = await import('../../server/lib/web-search/tavily.mjs');

    const fetchImpl = async () => jsonResponse({ detail: 'limit' }, { ok: false, status: 429 });

    await expect(backend.search('tavily quota', { limit: 5, env: {}, fetchImpl, mode: 'keyless' }))
      .rejects.toMatchObject({ code: 'quota_exhausted' });
  });

  it('throws a typed not_configured error in the keyed mode without a key', async () => {
    const backend = await import('../../server/lib/web-search/tavily.mjs');

    await expect(backend.search('tavily', { limit: 5, env: {}, fetchImpl: async () => ({}) , mode: 'keyed' }))
      .rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('wikipedia backend', () => {
  it('maps search hits to the contract shape and strips markup', async () => {
    const backend = await import('../../server/lib/web-search/wikipedia.mjs');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(WIKIPEDIA_PAYLOAD));

    const results = await backend.search('универсальный генератор', { limit: 5, fetchImpl });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Универсальный генератор');
    expect(results[0].url).toContain('ru.wikipedia.org/wiki/');
    expect(decodeURIComponent(results[0].url)).toContain('Универсальный генератор');
    expect(results[0].snippet).not.toContain('<span');
    expect(results[0].snippet).toContain('описание статьи');
    expect(calls[0].url).toContain('action=query');
    expect(calls[0].url).toContain('list=search');
  });

  it('sends a descriptive User-Agent with a contact', async () => {
    const backend = await import('../../server/lib/web-search/wikipedia.mjs');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(WIKIPEDIA_PAYLOAD));

    await backend.search('user agent', { limit: 5, fetchImpl });

    const ua = String(calls[0].options.headers?.['User-Agent'] || '');
    expect(ua).toContain('GeneRaptor');
    expect(ua).toContain('http');
  });

  it('maps the MediaWiki ratelimited error to a quota error', async () => {
    const backend = await import('../../server/lib/web-search/wikipedia.mjs');

    const fetchImpl = async () => jsonResponse(
      { error: { code: 'ratelimited', info: 'too many requests' } },
      { ok: false, status: 429 },
    );

    await expect(backend.search('rate limited', { limit: 5, fetchImpl }))
      .rejects.toMatchObject({ code: 'quota_exhausted' });
  });
});

describe('wikidata backend', () => {
  it('maps entity hits to the contract shape', async () => {
    const backend = await import('../../server/lib/web-search/wikidata.mjs');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(WIKIDATA_PAYLOAD));

    const results = await backend.search('универсальный генератор', { limit: 5, fetchImpl });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Универсальный генератор');
    expect(results[0].url).toBe('https://www.wikidata.org/wiki/Q42');
    expect(calls[0].url).toContain('action=wbsearchentities');
  });
});

describe('duckduckgo backend', () => {
  it('is marked as an unofficial opt-in backend', async () => {
    const backend = await import('../../server/lib/web-search/duckduckgo.mjs');

    expect(backend.unofficial).toBe(true);
    expect(backend.optIn).toBe(true);
  });

  it('parses organic results and decodes redirect links', async () => {
    const backend = await import('../../server/lib/web-search/duckduckgo.mjs');

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => DDG_HTML,
    });

    const results = await backend.search('universal generator', { limit: 5, fetchImpl });

    expect(results).toHaveLength(2);
    expect(results[0].url).toBe('https://example.com/one');
    expect(results[0].title).toBe('First result');
    expect(results[0].snippet).toBe('Snippet one');
    expect(results[1].url).toBe('https://example.org/two');
  });

  it('throws a typed blocked error on a challenge page', async () => {
    const backend = await import('../../server/lib/web-search/duckduckgo.mjs');

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => DDG_BLOCKED_HTML,
    });

    await expect(backend.search('blocked', { limit: 5, fetchImpl })).rejects.toMatchObject({
      code: 'blocked',
    });
  });
});

describe('automatic chain order (Serper first, Tavily free as fallback)', () => {
  it('declares the chain as serper → tavily → tavily-keyless → wikipedia → wikidata', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    expect(mod.AUTO_SEARCH_CHAIN).toEqual([
      'serper',
      'tavily',
      'tavily-keyless',
      'wikipedia',
      'wikidata',
    ]);
  });

  it('tries Serper before Tavily when both keys are configured', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';
    process.env.GENERAPTOR_TAVILY_API_KEY = 'tavily-secret';

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('google.serper.dev')) {
        return jsonResponse({
          organic: [{ title: 'Serper result', link: 'https://example.com/serper', snippet: 's' }],
        });
      }
      return jsonResponse(TAVILY_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'both keys', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('serper');
    expect(calls[0].url).toBe(SERPER_ENDPOINT);
    expect(calls).toHaveLength(1);
  });

  it('falls back to the keyed Tavily when only the Tavily key is configured', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_TAVILY_API_KEY = 'tavily-secret';

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    const outcome = await mod.searchWeb({ query: 'only tavily key', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('tavily');
    expect(calls[0].url).toBe(TAVILY_ENDPOINT);
    expect(calls[0].options.headers.Authorization).toBe('Bearer tavily-secret');
  });

  it('keeps the keyless safety net when no key is configured', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    const outcome = await mod.searchWeb({ query: 'no keys at all', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('tavily-keyless');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TAVILY_ENDPOINT);
  });

  it('never calls Yandex or the unofficial scraping backend in the automatic chain', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';
    process.env.GENERAPTOR_TAVILY_API_KEY = 'tavily-secret';
    process.env.GENERAPTOR_YANDEX_API_KEY = 'yandex-secret';

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('google.serper.dev')) {
        return jsonResponse({ organic: [] });
      }
      if (url.includes('api.tavily.com')) {
        return jsonResponse({ results: [] });
      }
      return jsonResponse(WIKIPEDIA_PAYLOAD);
    });

    await mod.searchWeb({ query: 'chain purity', limit: 5, fetchImpl });

    for (const call of calls) {
      expect(call.url).not.toContain('duckduckgo.com');
      expect(call.url).not.toContain('yandex');
    }
  });
});

describe('keyless degradation without an HTTP status code', () => {
  it('treats a natural-language keyless instruction as an unavailable keyless mode', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('api.tavily.com')) {
        // Tavily keyless answers HTTP 200 with an instruction text instead of
        // an error code when the anonymous budget is exhausted.
        return {
          ok: true,
          status: 200,
          json: async () => null,
          text: async () =>
            'You have reached the keyless rate limit. Sign up for a free API key to keep searching.',
        };
      }
      if (url.includes('ru.wikipedia.org')) return jsonResponse(WIKIPEDIA_PAYLOAD);
      return jsonResponse(WIKIDATA_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'keyless budget spent', limit: 5, fetchImpl });

    expect(outcome.attempts[0].backend).toBe('tavily-keyless');
    expect(outcome.attempts[0].code).toBe('keyless_unavailable');
    expect(outcome.backend).toBe('wikipedia');
    expect(outcome.degraded).toBe(false);
  });

  it('keeps an invalid response as an invalid response when no limit is mentioned', async () => {
    const backend = await import('../../server/lib/web-search/tavily.mjs');

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => null,
      text: async () => '<html>maintenance</html>',
    });

    await expect(backend.search('broken payload', { limit: 5, env: {}, fetchImpl, mode: 'keyless' }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('provider quota status codes', () => {
  it('maps HTTP 402 of Serper to an exhausted quota', async () => {
    const backend = await import('../../server/lib/web-search/serper.mjs');

    const fetchImpl = async () => ({
      ok: false,
      status: 402,
      json: async () => ({ message: 'credits exhausted' }),
      text: async () => 'credits exhausted',
    });

    await expect(backend.search('serper credits', {
      limit: 5,
      env: { GENERAPTOR_SERPER_API_KEY: 'serper-secret' },
      fetchImpl,
    })).rejects.toMatchObject({ code: 'quota_exhausted' });
  });

  it('maps HTTP 402 of Tavily to an exhausted quota', async () => {
    const backend = await import('../../server/lib/web-search/tavily.mjs');

    const fetchImpl = async () => ({
      ok: false,
      status: 402,
      json: async () => ({ detail: 'credits exhausted' }),
      text: async () => 'credits exhausted',
    });

    await expect(backend.search('tavily credits', {
      limit: 5,
      env: { GENERAPTOR_TAVILY_API_KEY: 'tavily-secret' },
      fetchImpl,
      mode: 'keyed',
    })).rejects.toMatchObject({ code: 'quota_exhausted' });
  });

  it('maps a rejected Serper key (HTTP 401/403) to not_configured', async () => {
    const backend = await import('../../server/lib/web-search/serper.mjs');

    for (const status of [401, 403]) {
      const fetchImpl = async () => ({
        ok: false,
        status,
        json: async () => ({ message: 'invalid key' }),
        text: async () => 'invalid key',
      });

      await expect(backend.search('serper auth', {
        limit: 5,
        env: { GENERAPTOR_SERPER_API_KEY: 'serper-secret' },
        fetchImpl,
      })).rejects.toMatchObject({ code: 'not_configured' });
    }
  });

  it('maps a rejected Tavily key (HTTP 401/403) to not_configured in the keyed mode', async () => {
    const backend = await import('../../server/lib/web-search/tavily.mjs');

    for (const status of [401, 403]) {
      const fetchImpl = async () => ({
        ok: false,
        status,
        json: async () => ({ detail: 'invalid key' }),
        text: async () => 'invalid key',
      });

      await expect(backend.search('tavily auth', {
        limit: 5,
        env: { GENERAPTOR_TAVILY_API_KEY: 'tavily-secret' },
        fetchImpl,
        mode: 'keyed',
      })).rejects.toMatchObject({ code: 'not_configured' });
    }
  });
});

describe('wikidata backend — degradation', () => {
  it('maps the MediaWiki ratelimited error to a quota error', async () => {
    const backend = await import('../../server/lib/web-search/wikidata.mjs');

    const fetchImpl = async () => jsonResponse(
      { error: { code: 'ratelimited', info: 'too many requests' } },
      { ok: false, status: 429 },
    );

    await expect(backend.search('rate limited', { limit: 5, fetchImpl }))
      .rejects.toMatchObject({ code: 'quota_exhausted' });
  });

  it('maps a broken response to an invalid response', async () => {
    const backend = await import('../../server/lib/web-search/wikidata.mjs');

    const fetchImpl = async () => jsonResponse({});

    await expect(backend.search('broken payload', { limit: 5, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('transport timeout', () => {
  it('maps a provider that never answers to the timeout code', async () => {
    const backend = await import('../../server/lib/web-search/wikipedia.mjs');

    // The fetch hangs until the layer aborts it — the real timeout path.
    const fetchImpl = (url, options = {}) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

    await expect(backend.search('slow provider', { limit: 5, fetchImpl, timeoutMs: 30 }))
      .rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('vertical stage — narrow sources consulted by topic', () => {
  const EUROPEPMC_PAYLOAD = {
    resultList: {
      result: [{ title: 'Europe work', pmid: '12345678', authorString: 'Petrov P.' }],
    },
  };

  const OPENALEX_PAYLOAD = {
    results: [
      {
        display_name: 'Work A',
        doi: '10.1/a',
        primary_location: { landing_page_url: 'https://example.org/work-a' },
      },
    ],
  };

  const GDELT_PAYLOAD = {
    articles: [{ title: 'World news', url: 'https://news.example/a', domain: 'news.example' }],
  };

  it('adds the results of the matching vertical after the main engine', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('ebi.ac.uk')) return jsonResponse(EUROPEPMC_PAYLOAD);
      return jsonResponse(TAVILY_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'лечение диабета инсулином', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('tavily-keyless');
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0].url).toBe('https://example.com/tavily');
    expect(outcome.results[1].url).toBe('https://europepmc.org/article/MED/12345678');
    expect(outcome.results[1].provider).toBe('europepmc');
    expect(outcome.results[0].provider).toBe('tavily-keyless');
    const attempt = outcome.attempts.find((a) => a.backend === 'europepmc');
    expect(attempt).toMatchObject({ ok: true, code: null, count: 1 });
  });

  it('does not call any vertical when the topic does not match', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async () => jsonResponse(TAVILY_PAYLOAD));

    const outcome = await mod.searchWeb({ query: 'universal generator', limit: 5, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(outcome.attempts.some((a) => a.backend === 'europepmc')).toBe(false);
  });

  it('does not consult the verticals on the second page', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('ebi.ac.uk')) return jsonResponse(EUROPEPMC_PAYLOAD);
      return jsonResponse(TAVILY_PAYLOAD);
    });

    const outcome = await mod.searchWeb({
      query: 'лечение диабета инсулином',
      limit: 5,
      page: 1,
      fetchImpl,
    });

    expect(calls.some((c) => c.url.includes('ebi.ac.uk'))).toBe(false);
    expect(outcome.results).toHaveLength(1);
  });

  it('removes the duplicate URLs of the vertical and of the main engine', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { fetchImpl } = captureFetch(async (url) => {
      if (url.includes('ebi.ac.uk')) {
        return jsonResponse({
          resultList: {
            result: [{ title: 'Europe work', pmid: '12345678' }],
          },
        });
      }
      return jsonResponse({
        results: [{ title: 'Same page', url: 'https://europepmc.org/article/MED/12345678', content: 'x' }],
      });
    });

    const outcome = await mod.searchWeb({ query: 'лечение диабета инсулином', limit: 5, fetchImpl });

    const urls = outcome.results.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('keeps the main result when the vertical fails', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { fetchImpl } = captureFetch(async (url) => {
      if (url.includes('ebi.ac.uk')) {
        return jsonResponse({}, { ok: false, status: 500 });
      }
      return jsonResponse(TAVILY_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'лечение диабета инсулином', limit: 5, fetchImpl });

    expect(outcome.degraded).toBe(false);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].url).toBe('https://example.com/tavily');
    expect(outcome.attempts.find((a) => a.backend === 'europepmc')).toMatchObject({
      ok: false,
      code: 'http_error',
    });
  });

  it('uses the vertical as the source when the main chain found nothing', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { fetchImpl } = captureFetch(async (url) => {
      if (url.includes('ebi.ac.uk')) return jsonResponse(EUROPEPMC_PAYLOAD);
      return jsonResponse({ detail: 'limit' }, { ok: false, status: 429 });
    });

    const outcome = await mod.searchWeb({ query: 'лечение диабета инсулином', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('europepmc');
    expect(outcome.degraded).toBe(false);
    expect(outcome.results[0].url).toBe('https://europepmc.org/article/MED/12345678');
  });

  it('consults at most two verticals per request', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('ebi.ac.uk')) return jsonResponse(EUROPEPMC_PAYLOAD);
      if (url.includes('api.openalex.org')) return jsonResponse(OPENALEX_PAYLOAD);
      if (url.includes('gdeltproject.org')) return jsonResponse(GDELT_PAYLOAD);
      return jsonResponse(TAVILY_PAYLOAD);
    });

    const outcome = await mod.searchWeb({
      query: 'научная публикация про лечение диабета и мировые новости',
      limit: 5,
      fetchImpl,
    });

    const verticalCalls = calls.filter((c) =>
      c.url.includes('ebi.ac.uk') ||
      c.url.includes('api.openalex.org') ||
      c.url.includes('gdeltproject.org'),
    );
    expect(verticalCalls).toHaveLength(2);
    const verticalIds = ['openalex', 'crossref', 'europepmc', 'gdelt', 'nominatim', 'openlibrary', 'stackexchange', 'hn'];
    const verticalAttempts = outcome.attempts.filter((a) => verticalIds.includes(a.backend));
    expect(verticalAttempts).toHaveLength(2);
    // The order is deterministic: score first, then the priority of the rule.
    expect(verticalAttempts.map((a) => a.backend)).toEqual(['openalex', 'europepmc']);
  });

  it('never sends a search key to a vertical', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';

    const { calls, fetchImpl } = captureFetch(async (url) => {
      if (url.includes('ebi.ac.uk')) return jsonResponse(EUROPEPMC_PAYLOAD);
      return jsonResponse(TAVILY_PAYLOAD);
    });

    await mod.searchWeb({ query: 'лечение диабета инсулином', limit: 5, fetchImpl });

    const verticalCall = calls.find((c) => c.url.includes('ebi.ac.uk'));
    expect(verticalCall).toBeTruthy();
    expect(JSON.stringify(verticalCall.options.headers || {})).not.toContain('serper-secret');
  });

  it('gives every result a provider', async () => {
    const mod = await import('../../server/lib/web-search/index.mjs');

    const { fetchImpl } = captureFetch(async (url) => {
      if (url.includes('ebi.ac.uk')) return jsonResponse(EUROPEPMC_PAYLOAD);
      return jsonResponse(TAVILY_PAYLOAD);
    });

    const outcome = await mod.searchWeb({ query: 'лечение диабета инсулином', limit: 5, fetchImpl });

    for (const item of outcome.results) {
      expect(typeof item.provider).toBe('string');
      expect(item.provider.length).toBeGreaterThan(0);
    }
  });
});

describe('serper backend', () => {
  it('maps organic results to the contract shape', async () => {
    const backend = await import('../../server/lib/web-search/serper.mjs');

    const fetchImpl = async () => jsonResponse({
      organic: [
        { title: 'Result A', link: 'https://example.com/a', snippet: 'Snippet A' },
        { title: 'Result B', link: 'https://example.com/b', snippet: 'Snippet B' },
      ],
    });

    const results = await backend.search('serper query', {
      limit: 5,
      env: { GENERAPTOR_SERPER_API_KEY: 'serper-secret' },
      fetchImpl,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'Result A',
      url: 'https://example.com/a',
      snippet: 'Snippet A',
    });
  });

  it('throws a typed quota error on HTTP 429', async () => {
    const backend = await import('../../server/lib/web-search/serper.mjs');

    const fetchImpl = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ message: 'quota' }),
      text: async () => 'quota',
    });

    await expect(backend.search('serper quota', {
      limit: 5,
      env: { GENERAPTOR_SERPER_API_KEY: 'serper-secret' },
      fetchImpl,
    })).rejects.toMatchObject({ code: 'quota_exhausted' });
  });

  it('throws a typed not_configured error without a key', async () => {
    const backend = await import('../../server/lib/web-search/serper.mjs');

    await expect(backend.search('serper', { limit: 5, env: {}, fetchImpl: async () => ({}) }))
      .rejects.toMatchObject({ code: 'not_configured' });
  });
});

// ── Redirect wrappers are unwrapped BEFORE dedup ───────────────────────────
// Synthetic fixtures only — no network, no real key. On the base candidate
// canonicalSignature drops the query, so five goto wrappers collapse into ONE
// result (https://google.com/goto); these tests pin the unwrapped behaviour.
describe('Redirect-wrapper unwrapping through searchWeb', () => {
  const GOTO_ORGANIC = [
    { title: 'One', link: 'https://www.google.com/goto?url=https%3A%2F%2Fexample.com%2Fone', snippet: 's1' },
    { title: 'Two', link: 'https://www.google.com/goto?url=https%3A%2F%2Fexample.com%2Ftwo', snippet: 's2' },
    { title: 'Three', link: 'https://www.google.com/goto?url=https%3A%2F%2Fexample.com%2Fthree', snippet: 's3' },
    { title: 'Four', link: 'https://google.com/goto?url=https%3A%2F%2Fexample.org%2Ffour', snippet: 's4' },
    { title: 'Five', link: 'https://www.google.com/goto?url=https%3A%2F%2Fexample.net%2Ffive', snippet: 's5' },
  ];

  it('five goto wrappers become five distinct target URLs (not one collapsed row)', async () => {
    process.env.GENERAPTOR_SEARCH_BACKEND = 'serper';
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';
    const mod = await import('../../server/lib/web-search/index.mjs');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ organic: GOTO_ORGANIC }));

    const outcome = await mod.searchWeb({ query: 'redirect unwrap fixture', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('serper');
    expect(outcome.degraded).toBe(false);
    expect(outcome.reason).toBeNull();
    expect(outcome.attempts[0]).toMatchObject({ backend: 'serper', ok: true, count: 5 });
    expect(outcome.results).toHaveLength(5);
    expect(outcome.results.map((r) => r.url)).toEqual([
      'https://example.com/one',
      'https://example.com/two',
      'https://example.com/three',
      'https://example.org/four',
      'https://example.net/five',
    ]);
    for (const result of outcome.results) {
      expect(result.url).not.toContain('google.com/goto');
    }
    // The key still goes ONLY to the canonical endpoint.
    expect(calls.every((c) => c.url === SERPER_ENDPOINT)).toBe(true);
  });

  it('a broken wrapper is dropped while the valid ones survive (2 goto + 1 broken → 2)', async () => {
    process.env.GENERAPTOR_SEARCH_BACKEND = 'serper';
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';
    const mod = await import('../../server/lib/web-search/index.mjs');
    const { fetchImpl } = captureFetch(async () => jsonResponse({
      organic: [
        GOTO_ORGANIC[0],
        { title: 'Broken', link: 'https://www.google.com/goto?url=javascript%3Aalert(1)', snippet: 'bad' },
        GOTO_ORGANIC[3],
      ],
    }));

    const outcome = await mod.searchWeb({ query: 'redirect unwrap fixture', limit: 5, fetchImpl });

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.map((r) => r.url)).toEqual([
      'https://example.com/one',
      'https://example.org/four',
    ]);
    expect(outcome.attempts[0].count).toBe(2);
  });

  it('normalization warns once per call with the dropped count and rule ids — never full URLs', async () => {
    const { normalizeSearchResults } = await import('../../server/lib/web-search/http.mjs');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = normalizeSearchResults([
      { title: 'Bad one', url: 'https://www.google.com/goto?url=javascript%3Aalert(1)', snippet: 'x' },
      { title: 'Bad two', url: 'https://www.google.com/url?q=', snippet: 'x' },
      { title: 'Good', url: 'https://example.com/ok', snippet: 'x' },
    ], 5);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/ok');
    const wrapperWarns = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((line) => line.includes('redirect-обёрток'));
    expect(wrapperWarns).toHaveLength(1);
    expect(wrapperWarns[0]).toContain('2');
    expect(wrapperWarns[0]).toContain('google-goto');
    expect(wrapperWarns[0]).toContain('google-url');
    expect(wrapperWarns[0]).not.toContain('https://');
    warnSpy.mockRestore();
  });

  it('a DDG href wrapping a google goto is unwrapped twice down to the final target', async () => {
    process.env.GENERAPTOR_SEARCH_BACKEND = 'duckduckgo';
    const mod = await import('../../server/lib/web-search/index.mjs');
    const inner = 'https://www.google.com/goto?url=https%3A%2F%2Fexample.com%2Fchain';
    const html = `
<html><body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(inner)}">Chain result</a>
    <a class="result__snippet">Snippet chain</a>
  </div>
</body></html>`;
    const { fetchImpl } = captureFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => html,
      json: async () => ({}),
    }));

    const outcome = await mod.searchWeb({ query: 'redirect unwrap fixture', limit: 5, fetchImpl });

    expect(outcome.backend).toBe('duckduckgo');
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].url).toBe('https://example.com/chain');
  });
});

// ── The live Serper ceiling is 10 results ──────────────────────────────────
// Live probe (2026-11-20, results/s4-serper-live-probe.md): num:25 was
// accepted but the provider returned 10 records. The backend must ask for
// min(limit, 10); the PUBLIC contract (outcome.limit, route clamp 25) stays.
// The cap is verified on the ACTUAL sent body, not on a constant.
describe('Serper num cap at the live ceiling of 10', () => {
  const TEN_ORGANIC = Array.from({ length: 10 }, (_, i) => ({
    title: `Result ${i + 1}`,
    link: `https://example.com/page-${i + 1}`,
    snippet: `snippet ${i + 1}`,
  }));

  async function serperCallWithLimit(limit) {
    process.env.GENERAPTOR_SEARCH_BACKEND = 'serper';
    process.env.GENERAPTOR_SERPER_API_KEY = 'serper-secret';
    const mod = await import('../../server/lib/web-search/index.mjs');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ organic: TEN_ORGANIC }));
    const outcome = await mod.searchWeb({ query: 'serper num cap fixture', limit, fetchImpl });
    const body = JSON.parse(calls[0].options.body);
    return { outcome, body, calls };
  }

  it('limit 25 sends num:10 in the request body (not 25)', async () => {
    const { body } = await serperCallWithLimit(25);
    expect(body.num).toBe(10);
  });

  it('limit 5 sends num:5 in the request body', async () => {
    const { body } = await serperCallWithLimit(5);
    expect(body.num).toBe(5);
  });

  it('limit 1 sends num:1 in the request body', async () => {
    const { body } = await serperCallWithLimit(1);
    expect(body.num).toBe(1);
  });

  it('the public contract is unchanged: outcome.limit stays 25, results <= 10', async () => {
    const { outcome, calls } = await serperCallWithLimit(25);
    expect(outcome.limit).toBe(25);
    expect(outcome.backend).toBe('serper');
    expect(outcome.degraded).toBe(false);
    expect(outcome.reason).toBeNull();
    expect(outcome.attempts[0]).toMatchObject({ backend: 'serper', ok: true });
    expect(outcome.results.length).toBeLessThanOrEqual(10);
    expect(outcome.results).toHaveLength(10);
    expect(calls[0].url).toBe(SERPER_ENDPOINT);
  });

  it('a code-level limit of 100 is capped to num:10 by the backend itself', async () => {
    const backend = await import('../../server/lib/web-search/serper.mjs');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ organic: TEN_ORGANIC }));
    await backend.search('serper num cap direct', {
      limit: 100,
      env: { GENERAPTOR_SERPER_API_KEY: 'serper-secret' },
      fetchImpl,
    });
    expect(JSON.parse(calls[0].options.body).num).toBe(10);
  });

  it('exports SERPER_MAX_RESULTS = 10 and keeps the garbage-limit default of 5', async () => {
    const backend = await import('../../server/lib/web-search/serper.mjs');
    expect(backend.SERPER_MAX_RESULTS).toBe(10);
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ organic: [] }));
    await backend.search('serper garbage limit', {
      limit: 'not-a-number',
      env: { GENERAPTOR_SERPER_API_KEY: 'serper-secret' },
      fetchImpl,
    });
    expect(JSON.parse(calls[0].options.body).num).toBe(5);
  });
});
