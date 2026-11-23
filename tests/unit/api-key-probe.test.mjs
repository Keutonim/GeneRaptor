/**
 * Unit tests for server/lib/api-key-probe.mjs.
 *
 * Contract under test:
 *   - a probe NEVER returns the key value (nor any fragment of it);
 *   - an empty key → NO network call at all;
 *   - RouterAI: GET /models → 200 = ok; 401/403 = key rejected (error);
 *     404/405 = fallback to POST /chat/completions; 429 = warning (key valid,
 *     rate-limited); 5xx / network / timeout = warning («не удалось проверить»);
 *   - Yandex Search: POST searchAsync with the SAME structured body as
 *     server/lib/yandex-search.mjs (query.searchType/queryText/page,
 *     responseFormat, region, groupSpec) → 2xx = ok; 401/403 = error;
 *     429 = warning; 400 (proto syntax error) = generic warning WITHOUT the
 *     provider body text;
 *   - NO retries (one attempt per probe step).
 *
 * The network is never touched: `fetchImpl` is injected.
 */
import { describe, test, expect, vi } from 'vitest';

import {
  probeRouterAiKey,
  probeYandexSearchKey,
  probeSerperSearchKey,
  probeTavilySearchKey,
  isApiKeyConfigured,
} from '../../server/lib/api-key-probe.mjs';

const SECRET = 'sk-test-secret-value-123456';

/** Минимальный ответ fetch: ok/status/text. */
function res(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** fetch-заглушка, которая уважает AbortSignal (для теста таймаута). */
function hangingFetch() {
  return vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
  );
}

describe('isApiKeyConfigured (паритет с server/routes/health.mjs isConfigured)', () => {
  test('непустая реальная строка → configured', () => {
    expect(isApiKeyConfigured(SECRET)).toBe(true);
  });

  test('пустая строка / undefined / не-строка → не configured', () => {
    expect(isApiKeyConfigured('')).toBe(false);
    expect(isApiKeyConfigured(undefined)).toBe(false);
    expect(isApiKeyConfigured(null)).toBe(false);
    expect(isApiKeyConfigured(123)).toBe(false);
  });

  test('плейсхолдеры из .env.example → не configured', () => {
    expect(isApiKeyConfigured('put_routerai_key_here')).toBe(false);
    expect(isApiKeyConfigured('change_me')).toBe(false);
    expect(isApiKeyConfigured('your_api_key')).toBe(false);
  });
});

describe('probeRouterAiKey', () => {
  test('200 на GET /models → ok:true, ключ принят', async () => {
    const fetchImpl = vi.fn(async () => res(200, '{"data":[]}'));

    const result = await probeRouterAiKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    expect(result.message).toContain('Ключ принят RouterAI');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/models');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  test('401 → level:error, в сообщении нет значения ключа, повторных попыток нет', async () => {
    const fetchImpl = vi.fn(async () => res(401, 'unauthorized'));

    const result = await probeRouterAiKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.message).toContain('Ключ отклонён RouterAI (HTTP 401)');
    expect(result.message).not.toContain(SECRET);
    expect(result.statusCode).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('403 → level:error', async () => {
    const fetchImpl = vi.fn(async () => res(403, 'forbidden'));

    const result = await probeRouterAiKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.message).toContain('Ключ отклонён RouterAI (HTTP 403)');
  });

  test('429 → level:warning (ключ валиден, лимит частоты), НЕ error', async () => {
    const fetchImpl = vi.fn(async () => res(429, 'rate limited'));

    const result = await probeRouterAiKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toContain('частот');
    expect(result.message).not.toContain(SECRET);
    expect(result.statusCode).toBe(429);
  });

  test('404 → фолбэк на POST /chat/completions, 200 там = ok', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/models')) return res(404, 'not found');
      return res(200, '{"choices":[]}');
    });

    const result = await probeRouterAiKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [fallbackUrl, fallbackInit] = fetchImpl.mock.calls[1];
    expect(String(fallbackUrl)).toContain('/chat/completions');
    expect(fallbackInit.method).toBe('POST');
    const body = JSON.parse(fallbackInit.body);
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
    expect(typeof body.model).toBe('string');
    expect(body.model.length).toBeGreaterThan(0);
  });

  test('404 → фолбэк тоже отклонён (401) → level:error', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/models')) return res(404, 'not found');
      return res(401, 'nope');
    });

    const result = await probeRouterAiKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.statusCode).toBe(401);
    expect(result.message).not.toContain(SECRET);
  });

  test('пустой ключ → ok:false + level:warning БЕЗ сетевого вызова', async () => {
    const fetchImpl = vi.fn(async () => res(200));

    const result = await probeRouterAiKey('', { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toBe('Ключ не настроен на сервере');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('сетевая ошибка → level:warning, без текста тела провайдера в сообщении', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed: provider-body-secret-text');
    });

    const result = await probeRouterAiKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toContain('Проверка не прошла: нет связи с провайдером');
    expect(result.message).not.toContain('provider-body-secret-text');
    expect(result.message).not.toContain(SECRET);
  });

  test('таймаут → level:warning, сообщение о связи', async () => {
    const fetchImpl = hangingFetch();

    const result = await probeRouterAiKey(SECRET, { fetchImpl, timeoutMs: 10 });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toContain('Проверка не прошла: нет связи с провайдером');
    expect(result.message).not.toContain(SECRET);
  });

  test('HTTP 500 → level:warning, ретраев нет (ровно один вызов), ключ не утёк', async () => {
    const fetchImpl = vi.fn(async () => res(500, `boom ${SECRET}`));

    const result = await probeRouterAiKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.statusCode).toBe(500);
    expect(result.message).not.toContain(SECRET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('probeYandexSearchKey', () => {
  test('2xx → ok:true, ключ принят, тело запроса — структурированная форма yandex-search.mjs', async () => {
    const fetchImpl = vi.fn(async () => res(200, '{"id":"op-1"}'));

    const result = await probeYandexSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    expect(result.message).toContain('Ключ принят Yandex Search API');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/searchAsync');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Api-Key ${SECRET}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Accept-Language']).toBe('ru-RU,ru;q=0.9');

    const body = JSON.parse(init.body);
    expect(body.query).toMatchObject({
      searchType: 'SEARCH_TYPE_RU',
      page: '0',
    });
    expect(typeof body.query.queryText).toBe('string');
    expect(body.query.queryText.length).toBeGreaterThan(0);
    expect(body.responseFormat).toBe('FORMAT_HTML');
    expect(body.region).toBe('213');
    expect(body.groupSpec).toMatchObject({
      groupMode: 'GROUP_MODE_FLAT',
      groupsOnPage: '50',
      docsInGroup: '1',
    });
  });

  test('403 → level:error, ключ не утёк', async () => {
    const fetchImpl = vi.fn(async () => res(403, 'forbidden'));

    const result = await probeYandexSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.message).toContain('Ключ отклонён Yandex Search API (HTTP 403)');
    expect(result.message).not.toContain(SECRET);
    expect(result.statusCode).toBe(403);
  });

  test('429 → level:warning (ключ валиден, rate limit), НЕ error', async () => {
    const fetchImpl = vi.fn(async () =>
      res(429, '{"code":8,"message":"search rate limit exceeded, retry later"}'),
    );

    const result = await probeYandexSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toContain('частот');
    expect(result.message).not.toContain('rate limit exceeded');
    expect(result.message).not.toContain(SECRET);
  });

  test('400 с proto-ошибкой → generic level:warning, текст тела провайдера НЕ попадает в ответ', async () => {
    const fetchImpl = vi.fn(async () =>
      res(400, '{"code":3,"message":"proto: syntax error (line 1:10): unexpected token"}'),
    );

    const result = await probeYandexSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).not.toContain('proto: syntax error');
    expect(result.message).not.toContain('unexpected token');
    expect(result.message).not.toContain(SECRET);
    expect(result.statusCode).toBe(400);
  });

  test('пустой ключ → ok:false + level:warning БЕЗ сетевого вызова', async () => {
    const fetchImpl = vi.fn(async () => res(200));

    const result = await probeYandexSearchKey('   ', { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toBe('Ключ не настроен на сервере');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('HTTP 500 → level:warning, ретраев нет', async () => {
    const fetchImpl = vi.fn(async () => res(500, 'oops'));

    const result = await probeYandexSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.statusCode).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('сетевая ошибка → level:warning без текста тела провайдера', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down: yandex-body-text');
    });

    const result = await probeYandexSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toContain('Проверка не прошла: нет связи с провайдером');
    expect(result.message).not.toContain('yandex-body-text');
    expect(result.message).not.toContain(SECRET);
  });
});

/**
 * Search-backend probes (Serper / Tavily).
 *
 * Contract:
 *   - an empty key → NO network call at all;
 *   - the key is sent ONLY to the canonical provider endpoint;
 *   - 200 = ok; 401/403 = key rejected (error); 429 = warning (quota);
 *   - the response NEVER contains the key value.
 */
describe('probeSerperSearchKey', () => {
  test('пустой ключ → сеть не трогаем', async () => {
    const fetchImpl = vi.fn(async () => res(200, '{}'));

    const result = await probeSerperSearchKey('   ', { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toBe('Ключ не настроен на сервере');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('HTTP 200 → ok, ключ уходит только на канонический endpoint', async () => {
    const fetchImpl = vi.fn(async () => res(200, '{"organic":[]}'));

    const result = await probeSerperSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://google.serper.dev/search');
    expect(options.headers['X-API-KEY']).toBe(SECRET);
    expect(result.message).not.toContain(SECRET);
  });

  test('HTTP 401 → level:error', async () => {
    const fetchImpl = vi.fn(async () => res(401, 'nope'));

    const result = await probeSerperSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.statusCode).toBe(401);
    expect(result.message).not.toContain(SECRET);
  });

  test('HTTP 429 → level:warning (лимит исчерпан)', async () => {
    const fetchImpl = vi.fn(async () => res(429, 'slow down'));

    const result = await probeSerperSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.statusCode).toBe(429);
  });

  test('HTTP 402 → level:warning, code:quota_exhausted (баланс кредитов исчерпан)', async () => {
    const fetchImpl = vi.fn(async () => res(402, 'credits exhausted'));

    const result = await probeSerperSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.statusCode).toBe(402);
    expect(result.code).toBe('quota_exhausted');
    expect(result.message).not.toContain(SECRET);
  });

  test('сетевая ошибка → level:warning', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });

    const result = await probeSerperSearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).not.toContain(SECRET);
  });
});

describe('probeTavilySearchKey', () => {
  test('пустой ключ → сеть не трогаем', async () => {
    const fetchImpl = vi.fn(async () => res(200, '{}'));

    const result = await probeTavilySearchKey('   ', { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toBe('Ключ не настроен на сервере');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('HTTP 200 → ok, ключ уходит только на канонический endpoint', async () => {
    const fetchImpl = vi.fn(async () => res(200, '{"results":[]}'));

    const result = await probeTavilySearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(options.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(result.message).not.toContain(SECRET);
  });

  test('HTTP 403 → level:error', async () => {
    const fetchImpl = vi.fn(async () => res(403, 'forbidden'));

    const result = await probeTavilySearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.statusCode).toBe(403);
    expect(result.message).not.toContain(SECRET);
  });

  test('HTTP 429 → level:warning (лимит исчерпан)', async () => {
    const fetchImpl = vi.fn(async () => res(429, 'slow down'));

    const result = await probeTavilySearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.statusCode).toBe(429);
  });

  test('HTTP 402 → level:warning, code:quota_exhausted (баланс кредитов исчерпан)', async () => {
    const fetchImpl = vi.fn(async () => res(402, 'credits exhausted'));

    const result = await probeTavilySearchKey(SECRET, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.statusCode).toBe(402);
    expect(result.code).toBe('quota_exhausted');
    expect(result.message).not.toContain(SECRET);
  });
});
