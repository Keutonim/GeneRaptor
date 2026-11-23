// Runs on SQLite with the in-process runner (no external services).
/**
 * Integration tests for the Stage 4 backend additions:
 *   - GET /api/articles pagination (?page=&pageSize= or ?limit=&offset=)
 *   - PUT /api/articles/:id/content (manual editor save, Bug #15)
 *
 * Run alongside the rest of the suite via `npm test`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTestApp,
  seedFixture,
  startServer,
  testPrisma,
  truncateAll,
} from '../helpers.mjs';

let server;
let baseUrl;
let fixture;

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
  fixture = await seedFixture();
});

afterEach(async () => {
  await truncateAll();
});

async function createArticle(overrides = {}) {
  const article = await testPrisma.article.create({
    data: {
      topic: overrides.topic || 'Тестовая статья',
      targetLength: overrides.targetLength || 60000,
      status: overrides.status || 'ready',
    },
  });
  if (overrides.withVersion) {
    await testPrisma.articleVersion.create({
      data: {
        articleId: article.id,
        version: 1,
        platform: 'base',
        title: article.topic,
        contentText: overrides.versionText || 'Исходный контент статьи.',
        contentHtml: overrides.versionHtml || null,
        characterCount: (overrides.versionText || 'Исходный контент статьи.').length,
      },
    });
  }
  return article;
}

async function fetchJson(path, init) {
  const res = await fetch(baseUrl + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

describe('GET /api/articles — pagination (Bug #8)', () => {
  beforeEach(async () => {
    // Seed 25 articles to exercise pagination.
    for (let i = 0; i < 25; i++) {
      await createArticle({ topic: `Статья ${i}` });
    }
  });

  it('returns a flat array when no pagination params (legacy compatibility)', async () => {
    const { status, body } = await fetchJson('/api/articles');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // Default limit is 50, so all 25 fit on the default page.
    expect(body.data.length).toBe(25);
  });

  it('returns paginated envelope with ?page=&pageSize=', async () => {
    const { status, body } = await fetchJson('/api/articles?page=1&pageSize=10');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('items');
    expect(body.data).toHaveProperty('total', 25);
    expect(body.data).toHaveProperty('limit', 10);
    expect(body.data).toHaveProperty('offset', 0);
    expect(body.data.items.length).toBe(10);
  });

  it('respects ?page=2 (offset math)', async () => {
    const { body } = await fetchJson('/api/articles?page=2&pageSize=10');
    expect(body.data.offset).toBe(10);
    expect(body.data.items.length).toBe(10);
  });

  it('respects ?limit=&offset=', async () => {
    const { body } = await fetchJson('/api/articles?limit=5&offset=20');
    expect(body.data.total).toBe(25);
    expect(body.data.offset).toBe(20);
    expect(body.data.items.length).toBe(5);
  });

  it('clamps oversized limit to MAX_LIMIT', async () => {
    const { body } = await fetchJson('/api/articles?limit=99999');
    expect(body.data.limit).toBeLessThanOrEqual(500);
  });

  it('returns empty items on page beyond range', async () => {
    const { body } = await fetchJson('/api/articles?page=99&pageSize=10');
    expect(body.data.items.length).toBe(0);
    expect(body.data.total).toBe(25);
  });
});

describe('PUT /api/articles/:id/content (Bug #15 — editor save)', () => {
  it('rejects invalid article id (400)', async () => {
    const { status, body } = await fetchJson('/api/articles/not-a-uuid/content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentText: 'x' }),
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('rejects missing contentText and contentHtml (400)', async () => {
    const article = await createArticle({ withVersion: true });
    const { status, body } = await fetchJson(`/api/articles/${article.id}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 404 for unknown article', async () => {
    const { status } = await fetchJson('/api/articles/550e8400-e29b-41d4-a716-446655440000/content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentText: 'x' }),
    });
    expect(status).toBe(404);
  });

  it('creates a new version with provided contentText', async () => {
    const article = await createArticle({ withVersion: true });
    const newText = 'Полностью переписанный контент статьи.';
    const { status, body } = await fetchJson(`/api/articles/${article.id}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentText: newText }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.characterCount).toBe(newText.length);

    // Verify a new version was persisted.
    const versions = await testPrisma.articleVersion.findMany({
      where: { articleId: article.id, platform: 'base' },
      orderBy: { createdAt: 'desc' },
    });
    expect(versions.length).toBe(2);
    expect(versions[0].contentText).toBe(newText);
    expect(versions[0].version).toBe(2);
    expect(versions[1].version).toBe(1);
  });

  it('GET /articles/:id/content returns the latest saved version', async () => {
    const article = await createArticle({ withVersion: true, versionText: 'Старый текст' });
    await fetchJson(`/api/articles/${article.id}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentText: 'Новый текст' }),
    });
    const { body } = await fetchJson(`/api/articles/${article.id}/content`);
    expect(body.data.contentText).toBe('Новый текст');
  });

  it('advances article status from intermediate to ready', async () => {
    const article = await createArticle({ status: 'generation', withVersion: true });
    const { status } = await fetchJson(`/api/articles/${article.id}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentText: 'x' }),
    });
    expect(status).toBe(200);
    const updated = await testPrisma.article.findUnique({ where: { id: article.id } });
    expect(updated.status).toBe('ready');
  });

  it('does NOT downgrade a published article status', async () => {
    const article = await createArticle({ status: 'published', withVersion: true });
    await fetchJson(`/api/articles/${article.id}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentText: 'x' }),
    });
    const updated = await testPrisma.article.findUnique({ where: { id: article.id } });
    expect(updated.status).toBe('published');
  });
});

/* ── Cover wave (2026-10-24, plan-photo §2.4, case 52) ───────────────── */

describe('GET /api/articles/:id/content — cover fields (case 52)', () => {
  it('returns cover fields when the article has a cover; pre-existing fields unchanged', async () => {
    // The developer .env carries real integration keys into vitest — force
    // the feature-off branch deterministically (no key → coverAvailable false).
    vi.stubEnv('ROUTERAI_API_KEY', '');
    const article = await createArticle({ withVersion: true, versionText: 'Старый текст' });
    const generatedAt = new Date('2026-10-24T10:30:00Z');
    await testPrisma.article.update({
      where: { id: article.id },
      data: {
        coverUrl: 'https://a.example.com/wp-content/uploads/2026/10/cover.png',
        coverModel: 'qwen/qwen-image-2.1-pro',
        coverCostRub: 4.82,
        coverGeneratedAt: generatedAt,
      },
    });

    const { status, body } = await fetchJson(`/api/articles/${article.id}/content`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    expect(body.data.coverUrl).toBe('https://a.example.com/wp-content/uploads/2026/10/cover.png');
    expect(body.data.coverModel).toBe('qwen/qwen-image-2.1-pro');
    // Decimal leaves the API as a plain Number.
    expect(body.data.coverCostRub).toBe(4.82);
    expect(typeof body.data.coverCostRub).toBe('number');
    expect(body.data.coverGeneratedAt).toBe(generatedAt.toISOString());
    // Test env has no WP integration config → feature-off total.
    expect(body.data.coverAvailable).toBe(false);

    // Pre-existing fields keep their values (additive change only).
    // M2: публикационных полей (rentry/wp/tg) в /content больше нет.
    expect(body.data.contentText).toBe('Старый текст');
    expect(body.data.title).toBe(article.topic);

    vi.unstubAllEnvs();
  });

  it('article without cover → cover fields null, coverAvailable false', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', '');
    const article = await createArticle({ withVersion: true, versionText: 'Без обложки' });

    const { status, body } = await fetchJson(`/api/articles/${article.id}/content`);
    expect(status).toBe(200);
    expect(body.data.coverUrl).toBeNull();
    expect(body.data.coverModel).toBeNull();
    expect(body.data.coverCostRub).toBeNull();
    expect(body.data.coverGeneratedAt).toBeNull();
    expect(body.data.coverAvailable).toBe(false);

    vi.unstubAllEnvs();
  });
});
