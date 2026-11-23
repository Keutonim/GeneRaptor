/**
 * Unit (integration-style) tests: cooldown пробы API-ключа (TL P2-3).
 *
 * Проблема: кнопка «Проверить подключение» без ограничения частоты жгла
 * квоту провайдера (RouterAI / Yandex считают запросы к лимиту).
 *
 * Контракт под тестом:
 *   - первая проба провайдера — обычная проверка (сетевой запрос уходит);
 *   - повторная проба того же провайдера в течение 30 секунд НЕ делает
 *     сетевой запрос: ответ 200, level='warning', cooldown=true;
 *   - cooldown одного провайдера не блокирует проверку другого;
 *   - GET /api/settings/api-keys продолжает показывать результат РЕАЛЬНОЙ
 *     пробы (а не warning из cooldown);
 *   - значение ключа не попадает в тело ответа.
 *
 * Отдельный файл — у модуля server/routes/api-keys.mjs кэш последней пробы
 * живёт в памяти процесса, а vitest изолирует модули по файлам.
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
import { resetApiKeyProbeCache } from '../../server/routes/api-keys.mjs';

const BASE = '/api/settings/api-keys';
const SECRET = 'sk-cooldown-secret-value-123456';

let server;
let baseUrl;
/** Внешние (не тест-сервер) запросы — их считаем, чтобы доказать cooldown. */
let externalCalls;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  externalCalls = [];
  // Кэш проб живёт в памяти процесса — каждый кейс стартует с чистого.
  resetApiKeyProbeCache();
  vi.stubEnv('ROUTERAI_API_KEY', SECRET);
  vi.stubEnv('YANDEX_SEARCH_API_KEY', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Ставим заглушку на глобальный fetch: запросы к тестовому серверу идут
 * как обычно, внешние — перехватываем и считаем.
 */
function stubFetch() {
  const originalFetch = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = String(url);
    if (target.startsWith(baseUrl)) return originalFetch(url, init);
    externalCalls.push(target);
    // Ответ провайдера: 200 + тело со списком моделей.
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'test-model' }] }),
      text: async () => JSON.stringify({ data: [{ id: 'test-model' }] }),
    };
  });
}

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

describe('POST /api/settings/api-keys/test — cooldown 30 секунд (TL P2-3)', () => {
  it('первая проба — обычная проверка, сетевой запрос уходит', async () => {
    stubFetch();

    const { status, body } = await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.level).toBe('ok');
    expect(body.data.cooldown).toBeUndefined();
    expect(externalCalls.length).toBeGreaterThan(0);
  });

  it('повторная проба в течение 30 с → level=warning, cooldown=true, БЕЗ сетевого запроса', async () => {
    stubFetch();

    const first = await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });
    expect(first.body.data.level).toBe('ok');
    const callsAfterFirst = externalCalls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });

    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(second.body.data.level).toBe('warning');
    expect(second.body.data.cooldown).toBe(true);
    expect(second.body.data.message).toContain('Повторите через');
    // Сеть не трогаем — квота не тратится.
    expect(externalCalls.length).toBe(callsAfterFirst);
  });

  it('cooldown одного провайдера не блокирует проверку другого', async () => {
    stubFetch();

    await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });
    const callsAfterRouter = externalCalls.length;

    const other = await call('POST', `${BASE}/test`, { body: { provider: 'yandexSearch' } });

    expect(other.status).toBe(200);
    expect(other.body.data.cooldown).toBeUndefined();
    expect(other.body.data.provider).toBe('yandexSearch');
    expect(externalCalls.length).toBeGreaterThan(callsAfterRouter);
  });

  it('GET показывает результат РЕАЛЬНОЙ пробы, а не warning из cooldown', async () => {
    stubFetch();

    await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });
    await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });

    const { body } = await call('GET', BASE);
    const routerai = body.data.providers.find((p) => p.id === 'routerai');

    expect(routerai.probeStatus).toBe('ok');
  });

  it('значение ключа не попадает в тело ответа при cooldown', async () => {
    stubFetch();

    await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });
    const second = await call('POST', `${BASE}/test`, { body: { provider: 'routerai' } });

    expect(second.body.data.cooldown).toBe(true);
    expect(JSON.stringify(second.body)).not.toContain(SECRET);
  });
});
