/**
 * The manual cover flow on the REAL server (defects 1+2).
 *
 * The reproduction the tech lead reported live:
 *   POST /api/articles/:id/cover  → 200 (the cover exists),
 *   GET  /api/articles/:id/cover  → 200 image/png (the bytes are served),
 *   GET  /api/articles/:id/content → coverFile missing + coverStatus not 'ready'
 *   → the M6 panel (src/features/generation/CoverPanel.tsx:49-50) never shows
 *     the cover it just generated.
 *
 * This suite drives the real Express app + the real test DB. Only the two
 * network edges are mocked (the LLM compression call and the image call) —
 * everything else (routes, cover service, cover store, prisma) runs for real.
 *
 * Mocking strategy (same pattern as tests/unit/cover-service.test.mjs):
 * vi.mock with importOriginal so the modules keep every other export.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  callRouterAI: vi.fn(),
  generateImage: vi.fn(),
}));

vi.mock('../../server/agent-role-execution.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  callRouterAI: h.callRouterAI,
}));

vi.mock('../../server/lib/routerai-images.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  generateImage: h.generateImage,
}));

import { createTestApp, startServer, truncateAll, testPrisma } from '../helpers.mjs';
// The e2e mock must not drift from the real route (defect 3).
import { buildContentPayload, ARTICLE_ID } from '../e2e/fake-api.ts';

/** PNG magic bytes — the store keeps the bytes verbatim, the route serves them. */
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const BRIEF = 'Краткий бриф: чистка лица, показания, цена.';
const IMAGE_COST = 4.82;

let server;
let baseUrl;
let dataDir;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await truncateAll();
  dataDir = mkdtempSync(join(tmpdir(), 'gr-cover-manual-'));
  vi.stubEnv('GENERAPTOR_DATA_DIR', dataDir);
  vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');
  vi.clearAllMocks();
  h.callRouterAI.mockResolvedValue({
    status: 200,
    data: {
      choices: [{ message: { content: BRIEF } }],
      usage: { cost: 0.05 },
    },
  });
  h.generateImage.mockResolvedValue({
    buffer: PNG_BYTES,
    costRub: IMAGE_COST,
    raw: { data: [{ b64_json: '***' }] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

/** An article with a base version — the cover flow needs the article text. */
async function seedArticle(overrides = {}) {
  const article = await testPrisma.article.create({
    data: { topic: 'Чистка лица', targetLength: 1000, status: 'ready', ...overrides },
  });
  await testPrisma.articleVersion.create({
    data: {
      articleId: article.id,
      version: 1,
      platform: 'base',
      title: 'Чистка лица',
      description: 'Ультразвуковая чистка лица',
      contentHtml: '<p>Текст статьи про ультразвуковую чистку лица.</p>',
      contentText: 'Текст статьи про ультразвуковую чистку лица.',
      characterCount: 44,
    },
  });
  return article;
}

async function postCover(articleId, body = {}) {
  const res = await fetch(`${baseUrl}/api/articles/${articleId}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

async function getContent(articleId) {
  const res = await fetch(`${baseUrl}/api/articles/${articleId}/content`);
  return { res, body: await res.json() };
}

describe('the manual cover flow', () => {
  it('the content route reports the cover that the manual POST just generated', async () => {
    const article = await seedArticle();

    // 1. The manual generation (empty body = first generation).
    const post = await postCover(article.id, {});
    expect(post.res.status).toBe(200);
    expect(post.body.success).toBe(true);
    expect(post.body.data.coverFile).toBe(`${article.id}-1.png`);

    // 2. The content route must carry the file reference AND the ready state —
    //    this is what the M6 panel keys on (CoverPanel.tsx:49-50).
    const content = await getContent(article.id);
    expect(content.res.status).toBe(200);
    expect(content.body.data).toHaveProperty('coverFile');
    expect(content.body.data.coverFile).toBe(`${article.id}-1.png`);
    expect(content.body.data.coverStatus).toBe('ready');
    expect(content.body.data.coverSkipReason).toBeNull();
    // The pre-existing content contract stays intact.
    expect(content.body.data.coverUrl).toBe(`/api/articles/${article.id}/cover`);

    // 3. The binary route serves exactly those bytes.
    const cover = await fetch(`${baseUrl}/api/articles/${article.id}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toContain('image/png');
    const bytes = Buffer.from(await cover.arrayBuffer());
    expect(bytes.equals(PNG_BYTES)).toBe(true);

    // 4. The DB row itself carries the ready channel (defect 2) — the content
    //    route above only reported what the row already held.
    const row = await testPrisma.article.findUnique({ where: { id: article.id } });
    expect(row.coverStatus).toBe('ready');
    expect(row.coverSkipReason).toBeNull();
    expect(row.coverFile).toBe(`${article.id}-1.png`);
  });

  it('a previously failed cover becomes ready after a manual generation', async () => {
    // The reported live symptom: the cover phase failed earlier, the panel
    // stayed in the failure state (CoverPanel.tsx:97-101) even though the
    // manual generation succeeded.
    const article = await seedArticle({
      coverStatus: 'failed',
      coverSkipReason: 'cover_generation_failed',
    });

    const post = await postCover(article.id, {});
    expect(post.res.status).toBe(200);

    const content = await getContent(article.id);
    expect(content.body.data.coverStatus).toBe('ready');
    expect(content.body.data.coverSkipReason).toBeNull();
    expect(content.body.data.coverFile).toBe(`${article.id}-1.png`);
  });

  it('reports no cover before the first generation', async () => {
    const article = await seedArticle();

    const content = await getContent(article.id);

    expect(content.res.status).toBe(200);
    expect(content.body.data).toHaveProperty('coverFile');
    expect(content.body.data.coverFile).toBeNull();
    expect(content.body.data.coverStatus).toBeNull();
  });

  it('the e2e mock answers with the same content payload as the real route', async () => {
    // Dev-5b (defect 3): the mock used to answer with a payload the real
    // server never produced — which hid the missing coverFile. The key sets
    // must stay identical.
    const article = await seedArticle();
    await postCover(article.id, {});

    const content = await getContent(article.id);
    const mockPayload = buildContentPayload({
      exchanged: true,
      coverReady: true,
      deleted: false,
      coverBodies: [],
      created: [],
    });

    expect(Object.keys(mockPayload).sort()).toEqual(Object.keys(content.body.data).sort());
    // The file names differ by construction (the mock has a fixed article id)
    // — the cover channel itself must agree.
    expect(mockPayload.coverStatus).toBe(content.body.data.coverStatus);
    expect(mockPayload.coverSkipReason).toBe(content.body.data.coverSkipReason);
    expect(mockPayload.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
  });

  it('the e2e mock matches the real route before the first cover too', async () => {
    // The same drift guard for the "no cover yet" state — the payload shape
    // must not depend on whether the cover exists.
    const article = await seedArticle();

    const content = await getContent(article.id);
    const mockPayload = buildContentPayload({
      exchanged: true,
      coverReady: false,
      deleted: false,
      coverBodies: [],
      created: [],
    });

    expect(Object.keys(mockPayload).sort()).toEqual(Object.keys(content.body.data).sort());
    expect(mockPayload.coverFile).toBeNull();
    expect(mockPayload.coverStatus).toBeNull();
    expect(mockPayload.coverUrl).toBeNull();
  });
});
