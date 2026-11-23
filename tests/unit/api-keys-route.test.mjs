/**
 * Unit (integration-style) tests for the API-keys route
 * server/routes/api-keys.mjs.
 *
 * Contract under test:
 *   GET  /api/settings/api-keys → 200 {success:true,data:{providers:[...]}};
 *         ровно два провайдера (routerai / yandexSearch), значения ключей
 *         НИКОГДА не попадают в тело; `configured` врёт только если ключ
 *         действительно не настроен; `hint` непустой только когда не настроен;
 *   POST /api/settings/api-keys/test → всегда 200 при корректном body,
 *         результат (ok/message/latencyMs/checkedAt) в теле; 400 при
 *         неизвестном провайдере и при отсутствии provider.
 *
 * Сеть не используется: при пустом env проба вообще не ходит наружу
 * (проверяется, что fetch вызывался только на локальный тест-сервер).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Redis не поднимаем — очередь замокана (как в tests/integration/*).
vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  redisClient: { ping: vi.fn(async () => 'PONG') },
  articleGenerationQueue: { add: vi.fn() },
  sourceCrawlQueue: { add: vi.fn() },
  publicationQueue: { add: vi.fn() },
  autoGenerationQueue: { add: vi.fn(), removeRepeatable: vi.fn() },
  closeQueues: vi.fn(async () => {}),
}));

import { createTestApp, startServer } from '../helpers.mjs';

const BASE = '/api/settings/api-keys';
const SECRET = 'sk-route-secret-value-654321';

let server;
let baseUrl;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.stubEnv('ROUTERAI_API_KEY', '');
  vi.stubEnv('YANDEX_SEARCH_API_KEY', '');
});

async function call(method, path, { body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

describe('GET /api/settings/api-keys', () => {
  it('200 + ровно два провайдера с envKey и configured', async () => {
    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.providers)).toBe(true);
    expect(body.data.providers).toHaveLength(2);

    const routerai = body.data.providers.find((p) => p.id === 'routerai');
    const yandex = body.data.providers.find((p) => p.id === 'yandexSearch');
    expect(routerai).toMatchObject({
      id: 'routerai',
      label: 'RouterAI',
      envKey: 'ROUTERAI_API_KEY',
    });
    expect(yandex).toMatchObject({
      id: 'yandexSearch',
      label: 'Yandex Search API',
      envKey: 'YANDEX_SEARCH_API_KEY',
    });
    // Три состояния, а не два: configured + probeStatus.
    for (const provider of body.data.providers) {
      expect(['ok', 'warning', 'error', 'unknown']).toContain(provider.probeStatus);
    }
  });

  it('пустой env → configured:false + непустой hint + probeStatus:unknown (не «сломан»)', async () => {
    const { body } = await call('GET', BASE);

    for (const provider of body.data.providers) {
      expect(provider.configured).toBe(false);
      expect(typeof provider.hint).toBe('string');
      expect(provider.hint.length).toBeGreaterThan(0);
      expect(provider.hint).toContain(provider.envKey);
      // Ключа нет → о нём ничего не известно, но «сломанным» он не назван.
      expect(provider.probeStatus).toBe('unknown');
    }
  });

  it('заданный env → configured:true + hint:null, значение ключа в теле НЕТ', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', SECRET);
    vi.stubEnv('YANDEX_SEARCH_API_KEY', SECRET);

    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    for (const provider of body.data.providers) {
      expect(provider.configured).toBe(true);
      expect(provider.hint).toBeNull();
    }
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('плейсхолдер из .env.example считается не настроенным', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', 'put_routerai_key_here');

    const { body } = await call('GET', BASE);

    const routerai = body.data.providers.find((p) => p.id === 'routerai');
    expect(routerai.configured).toBe(false);
    expect(typeof routerai.hint).toBe('string');
  });
});

describe('POST /api/settings/api-keys/test', () => {
  it('пустой env → 200 ok:false + «Ключ не настроен на сервере», сеть не трогается', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { status, body } = await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.provider).toBe('routerai');
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toBe('Ключ не настроен на сервере');
    expect(typeof body.data.latencyMs).toBe('number');
    expect(typeof body.data.checkedAt).toBe('string');

    const externalCalls = fetchSpy.mock.calls.filter(([url]) => !String(url).startsWith(baseUrl));
    expect(externalCalls).toHaveLength(0);
  });

  it('yandexSearch при пустом env → 200 ok:false', async () => {
    const { status, body } = await call('POST', `${BASE}/test`, { body: { provider: 'yandexSearch' } });

    expect(status).toBe(200);
    expect(body.data.provider).toBe('yandexSearch');
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toBe('Ключ не настроен на сервере');
  });

  it('неизвестный провайдер → 400 «Неизвестный провайдер»', async () => {
    const { status, body } = await call('POST', `${BASE}/test`, { body: { provider: 'unknown' } });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Неизвестный провайдер');
  });

  it('без provider → 400 «Не указан провайдер»', async () => {
    const { status, body } = await call('POST', `${BASE}/test`, { body: {} });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Не указан провайдер');
  });

  it('тело ответа никогда не содержит значения ключа', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', SECRET);

    const { body } = await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });

    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
