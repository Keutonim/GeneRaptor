// Runs on SQLite with the in-process runner (no external services).
/**
 * Integration tests for GET /api/articles?excludeStatus=... (W4 «Автоматизация»).
 *
 * Guard B, серверная сторона: параметр excludeStatus (CSV → notIn)
 * аддитивен — без него поведение списка НЕ меняется. Ответ обязан нести
 * M2: публикационных полей больше нет — пины только статусной фильтрации.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestApp,
  startServer,
  testPrisma,
  truncateAll,
} from '../helpers.mjs';

let server;
let baseUrl;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
});

async function callList(query = '') {
  const res = await fetch(`${baseUrl}/api/articles${query}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /api/articles?excludeStatus=published_manual (Guard B)', () => {
  it('исключает published_manual, оставляя остальные статусы', async () => {
    const ready = await testPrisma.article.create({ data: { topic: 'Готовая', targetLength: 1000, status: 'ready' } });
    const manual = await testPrisma.article.create({ data: { topic: 'Ручная', targetLength: 1000, status: 'published_manual' } });

    const { status, body } = await callList('?excludeStatus=published_manual');
    expect(status).toBe(200);
    const items = Array.isArray(body) ? body : (body.items ?? body.data);
    const ids = items.map((a) => a.id);
    expect(ids).toContain(ready.id);
    expect(ids).not.toContain(manual.id);
  });

  it('без параметра поведение прежнее: published_manual возвращается в списке', async () => {
    const manual = await testPrisma.article.create({ data: { topic: 'Ручная', targetLength: 1000, status: 'published_manual' } });
    const { body } = await callList('');
    const items = Array.isArray(body) ? body : (body.items ?? body.data);
    expect(items.map((a) => a.id)).toContain(manual.id);
  });

  it('excludeStatus комбинируется со status= (CSV in + notIn)', async () => {
    await testPrisma.article.create({ data: { topic: 'Готовая', targetLength: 1000, status: 'ready' } });
    const manual = await testPrisma.article.create({ data: { topic: 'Ручная', targetLength: 1000, status: 'published_manual' } });
    const { body } = await callList('?status=ready,published_manual&excludeStatus=published_manual');
    const items = Array.isArray(body) ? body : (body.items ?? body.data);
    expect(items.map((a) => a.id)).not.toContain(manual.id);
  });

  it('фикс-раунд P3-6: пустой CSV status + excludeStatus → excludeStatus НЕ теряется', async () => {
    // ?status=, — пустой CSV: раньше ветка if(status) входила, statuses.length===0,
    // where.status не выставлялся и notIn ТЕРЯЛСЯ (очередь показала бы ручные статьи).
    const ready = await testPrisma.article.create({ data: { topic: 'Готовая', targetLength: 1000, status: 'ready' } });
    const manual = await testPrisma.article.create({ data: { topic: 'Ручная', targetLength: 1000, status: 'published_manual' } });
    const { status, body } = await callList(`?status=${encodeURIComponent(',')}&excludeStatus=published_manual`);
    expect(status).toBe(200);
    const items = Array.isArray(body) ? body : (body.items ?? body.data);
    const ids = items.map((a) => a.id);
    expect(ids).not.toContain(manual.id);
    expect(ids).toContain(ready.id);
  });

  it('фикс-раунд P3-6: status=ready + excludeStatus=published_manual → ручной нет, ready есть', async () => {
    const ready = await testPrisma.article.create({ data: { topic: 'Готовая', targetLength: 1000, status: 'ready' } });
    const manual = await testPrisma.article.create({ data: { topic: 'Ручная', targetLength: 1000, status: 'published_manual' } });
    const { status, body } = await callList('?status=ready&excludeStatus=published_manual');
    expect(status).toBe(200);
    const items = Array.isArray(body) ? body : (body.items ?? body.data);
    const ids = items.map((a) => a.id);
    expect(ids).not.toContain(manual.id);
    expect(ids).toContain(ready.id);
  });
});
