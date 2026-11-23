import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Default env so the module reads a non-placeholder key. Tests that need the
// "not configured" branch override YANDEX_SEARCH_API_KEY per-test.
process.env.YANDEX_SEARCH_API_KEY = 'AQVN_test_key';
process.env.YANDEX_SEARCH_ENDPOINT =
  'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync';
process.env.YANDEX_OPERATION_ENDPOINT =
  'https://operation.api.cloud.yandex.net/operations';

// Import after env is set; the module reads env at import time for the
// endpoint constants, and at call time for the key.
const {
  startYandexSearch,
  pollYandexOperation,
  searchYandex,
  parseYandexHtml,
  decodeBase64Html,
} = await import('../../server/lib/yandex-search.mjs');

// Minimal SERP HTML used across parsing tests. Includes one organic result
// (external url), one Yandex-internal link (must be filtered), and one item
// without an h2 (must be skipped).
const SAMPLE_HTML = `
<ul>
  <li class="serp-item">
    <h2><a href="https://example.com/epil">Лазерная эпиляция Москва</a></h2>
    <div class="organic__content">Лучший салон красоты</div>
  </li>
  <li class="serp-item">
    <h2><a href="https://ya.ru/x">Yandex internal</a></h2>
  </li>
  <li class="serp-item"><div>no h2 here</div></li>
</ul>`;

const SAMPLE_HTML_B64 = Buffer.from(SAMPLE_HTML, 'utf-8').toString('base64');

/**
 * Build a fetch mock that returns a JSON body. Captures the call for assertions.
 */
function jsonFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  fn.calls = calls;
  return fn;
}

describe('decodeBase64Html', () => {
  it('decodes base64 back to the original UTF-8 string', () => {
    const original = '<html>привет мир</html>';
    const b64 = Buffer.from(original, 'utf-8').toString('base64');
    expect(decodeBase64Html(b64)).toBe(original);
  });

  it('preserves cyrillic characters', () => {
    const original = 'Лазерная эпиляция';
    const b64 = Buffer.from(original, 'utf-8').toString('base64');
    expect(decodeBase64Html(b64)).toBe(original);
  });

  it('handles empty string', () => {
    expect(decodeBase64Html('')).toBe('');
  });
});

describe('parseYandexHtml', () => {
  it('extracts url, title and snippet from organic results', () => {
    const results = parseYandexHtml(SAMPLE_HTML);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/epil');
    expect(results[0].title).toBe('Лазерная эпиляция Москва');
    expect(results[0].snippet).toBe('Лучший салон красоты');
  });

  it('filters out Yandex-internal links', () => {
    const results = parseYandexHtml(SAMPLE_HTML);
    expect(results.every((r) => !r.url.includes('ya.ru'))).toBe(true);
    expect(results.every((r) => !r.url.includes('yandex.'))).toBe(true);
  });

  it('skips items without an h2', () => {
    const results = parseYandexHtml(SAMPLE_HTML);
    expect(results.find((r) => r.title === '')).toBeUndefined();
  });

  it('parses mobile-format div[data-cid] containers when no li.serp-item', () => {
    const html = `
      <div data-cid="1">
        <h2><a href="https://mobile.example.com">Mobile Result</a></h2>
        <div class="organic__content">mobile snippet</div>
      </div>`;
    const results = parseYandexHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://mobile.example.com');
    expect(results[0].title).toBe('Mobile Result');
  });

  it('returns [] for empty or non-string input', () => {
    expect(parseYandexHtml('')).toEqual([]);
    expect(parseYandexHtml(null)).toEqual([]);
  });
});

describe('startYandexSearch', () => {
  let originalKey;

  beforeEach(() => {
    originalKey = process.env.YANDEX_SEARCH_API_KEY;
    process.env.YANDEX_SEARCH_API_KEY = 'AQVN_test_key';
  });
  afterEach(() => {
    process.env.YANDEX_SEARCH_API_KEY = originalKey;
    vi.unstubAllGlobals();
  });

  it('POSTs to the async endpoint with correct body, headers and returns operation id', async () => {
    const fetchMock = jsonFetch({ id: 'op-123' });
    vi.stubGlobal('fetch', fetchMock);

    const opId = await startYandexSearch({ query: 'лазерная эпиляция Москва', page: 0 });
    expect(opId).toBe('op-123');

    expect(fetchMock.calls).toHaveLength(1);
    const { url, opts } = fetchMock.calls[0];

    // Correct endpoint.
    expect(url).toBe(
      'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync'
    );
    expect(opts.method).toBe('POST');

    // Api-Key auth header.
    expect(opts.headers.Authorization).toBe('Api-Key AQVN_test_key');
    expect(opts.headers['Content-Type']).toBe('application/json');

    // Body mirrors yaps.py _start_search.
    const body = JSON.parse(opts.body);
    expect(body.query.searchType).toBe('SEARCH_TYPE_RU');
    expect(body.query.queryText).toBe('лазерная эпиляция Москва');
    expect(body.query.page).toBe('0');
    expect(body.responseFormat).toBe('FORMAT_HTML');
    expect(body.region).toBe('213');
    expect(body.groupSpec.groupMode).toBe('GROUP_MODE_FLAT');
    expect(body.groupSpec.groupsOnPage).toBe('50');
    expect(body.groupSpec.docsInGroup).toBe('1');
  });

  it('throws when the API key is not configured (placeholder)', async () => {
    process.env.YANDEX_SEARCH_API_KEY = 'put_yandex_search_api_key_here';
    await expect(startYandexSearch({ query: 'test query' })).rejects.toThrow(
      /не настроен/i
    );
  });

  it('throws when the API returns no operation id', async () => {
    const fetchMock = jsonFetch({});
    vi.stubGlobal('fetch', fetchMock);
    await expect(startYandexSearch({ query: 'test' })).rejects.toThrow(
      /operation id/i
    );
  });

  it('throws on non-retryable 4xx error', async () => {
    const fetchMock = jsonFetch(
      { error: { message: 'Unauthorized' } },
      { status: 401 }
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(startYandexSearch({ query: 'test' })).rejects.toThrow(
      /Unauthorized/
    );
  });
});

describe('pollYandexOperation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns done=false while the operation is still running', async () => {
    const fetchMock = jsonFetch({ done: false });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollYandexOperation('op-123');
    expect(result.done).toBe(false);
    expect(result.results).toBeUndefined();
  });

  it('returns done=false on 404 (operation not ready)', async () => {
    const calls = [];
    const fetchMock = vi.fn(async (url) => {
      calls.push(url);
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollYandexOperation('op-404');
    expect(result.done).toBe(false);
    expect(calls[0]).toBe(
      'https://operation.api.cloud.yandex.net/operations/op-404'
    );
  });

  it('decodes base64 rawData and returns parsed results when done', async () => {
    const fetchMock = jsonFetch({
      done: true,
      response: { rawData: SAMPLE_HTML_B64 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollYandexOperation('op-done');
    expect(result.done).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe('https://example.com/epil');
    expect(result.results[0].title).toBe('Лазерная эпиляция Москва');
  });

  it('returns done=true with empty results when rawData is missing', async () => {
    const fetchMock = jsonFetch({ done: true, response: {} });
    vi.stubGlobal('fetch', fetchMock);
    const result = await pollYandexOperation('op-empty');
    expect(result.done).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('uses the Authorization Api-Key header', async () => {
    const fetchMock = jsonFetch({ done: false });
    vi.stubGlobal('fetch', fetchMock);
    await pollYandexOperation('op-123');
    const { opts } = fetchMock.calls[0];
    expect(opts.headers.Authorization).toBe('Api-Key AQVN_test_key');
  });
});

describe('searchYandex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs the full cycle: start → poll(not done) → poll(done) → returns results', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url) => {
      call += 1;
      if (call === 1) {
        // startYandexSearch POST → operation id
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'op-full' }),
          text: async () => JSON.stringify({ id: 'op-full' }),
        };
      }
      if (call === 2) {
        // first poll: not done
        return { ok: true, status: 200, json: async () => ({ done: false }) };
      }
      // subsequent polls: done with results
      return {
        ok: true,
        status: 200,
        json: async () => ({
          done: true,
          response: { rawData: SAMPLE_HTML_B64 },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchYandex({
      query: 'лазерная эпиляция',
      intervalMs: 1, // speed up the test
      maxAttempts: 10,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe('https://example.com/epil');
    expect(result.totalOperations).toBeGreaterThanOrEqual(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    // At least 3 fetch calls: start + at least one not-done + one done.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('returns empty results on poll timeout (maxAttempts exhausted, never done)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'op-slow' }),
          text: async () => JSON.stringify({ id: 'op-slow' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ done: false }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchYandex({
      query: 'test',
      intervalMs: 1,
      maxAttempts: 3,
    });

    expect(result.results).toEqual([]);
    expect(result.totalOperations).toBe(3);
    expect(result.error).toMatch(/таймаут/i);
  });
});
