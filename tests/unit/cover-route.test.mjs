/**
 * Cover route: POST /api/articles/:id/cover — route
 * unit tests (response envelope + cover routes).
 *
 * M5: the cover flow has NO WordPress dependency — the binary lands in the
 * local store and the response carries the local route + the file reference.
 *
 * Pattern: tests/unit/cover-service.test.mjs mocks (db / callRouterAI /
 * routerai-images) + tests/unit/tg-publish-route router-stack invocation. The
 * REAL cover-service runs underneath (route → T2 integration proof);
 * prisma/HTTP are mocked — no DB, no network.
 *
 * Contract under test:
 *   - 200 envelope { success:true, data:{…8 fields} } (§2.1 + M5);
 *   - non-UUID id → 400 cover_invalid_article_id (zero DB reads);
 *   - unknown article → 404 cover_article_not_found;
 *   - concurrent second call while the first is in flight → 409
 *     cover_in_progress; the in-flight slot is released after BOTH a
 *     successful and a failed run (a third call then succeeds);
 *   - refinement > 500 chars → 400 cover_invalid_refinement; fresh:true
 *     wins over a long refinement (§2.1 precedence);
 *   - every error body carries success:false + error + code.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  articleUpdate: vi.fn(),
  articleVersionFindFirst: vi.fn(),
  agentRunCreate: vi.fn(),
  agentRunFindMany: vi.fn(),
  coverSettingsFindFirst: vi.fn(),
  providerConfigFindMany: vi.fn(),
  callRouterAI: vi.fn(),
  generateImage: vi.fn(),
}));

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    article: { findUnique: h.articleFindUnique, update: h.articleUpdate },
    articleVersion: { findFirst: h.articleVersionFindFirst },
    agentRun: { create: h.agentRunCreate, findMany: h.agentRunFindMany },
    coverSettings: { findFirst: h.coverSettingsFindFirst },
    providerConfig: { findMany: h.providerConfigFindMany },
    specialist: { findUnique: vi.fn() },
  },
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn(), getJobs: vi.fn() },
}));

vi.mock('../../server/agent-role-execution.mjs', () => ({
  callRouterAI: h.callRouterAI,
}));

vi.mock('../../server/lib/routerai-images.mjs', () => {
  // Real CoverImageError re-implemented inside the factory (tg-publish pattern).
  class CoverImageError extends Error {
    constructor(code, message, options) {
      super(message, options);
      this.name = 'CoverImageError';
      this.code = code;
    }
  }
  return { CoverImageError, generateImage: h.generateImage };
});

// articles.mjs imports the REAL cover-service — which runs on the mocks above.
import { articlesRouter } from '../../server/routes/articles.mjs';

const ARTICLE_ID = '33333333-3333-4333-8333-333333333333';
const IMAGE_COST = 4.82;
const BRIEF = 'Краткий бриф: чистка лица, показания, цена.';

let dataDir = '';
let coversDir = '';

function makeArticle(overrides = {}) {
  return {
    id: ARTICLE_ID,
    topic: 'Чистка лица Ultrasound',
    status: 'ready',
    wpPostId: null,
    coverUrl: null,
    coverFile: null,
    coverModel: null,
    coverPrompt: null,
    coverCostRub: null,
    coverGeneratedAt: null,
    ...overrides,
  };
}

function makeVersion(overrides = {}) {
  return {
    id: 'ver-1',
    articleId: ARTICLE_ID,
    platform: 'base',
    title: 'Чистка лица',
    contentText: 'Текст статьи про ультразвуковую чистку лица.',
    contentHtml: '<p>Текст статьи про ультразвуковую чистку лица.</p>',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

/** Invoke a route handler directly from the router stack (tg-route pattern). */
async function callRoute(path, { method = 'post', params = { id: ARTICLE_ID }, body = {} } = {}) {
  const layer = articlesRouter.stack.find(
    (l) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
  await layer.route.stack[0].handle({ params, body }, res);
  return res;
}

const postCover = (body = {}, params = { id: ARTICLE_ID }) =>
  callRoute('/articles/:id/cover', params ? { params, body } : { params });

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'generaptor-cover-route-'));
  coversDir = join(dataDir, 'covers');
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(coversDir, { recursive: true, force: true });
  vi.stubEnv('GENERAPTOR_DATA_DIR', dataDir);
  h.articleFindUnique.mockResolvedValue(makeArticle());
  h.articleVersionFindFirst.mockResolvedValue(makeVersion());
  h.articleUpdate.mockResolvedValue({});
  h.agentRunCreate.mockResolvedValue({});
  h.agentRunFindMany.mockResolvedValue([]);
  h.coverSettingsFindFirst.mockResolvedValue(null); // DEFAULTS
  h.providerConfigFindMany.mockResolvedValue([]);
  h.callRouterAI.mockResolvedValue({
    status: 200,
    data: {
      choices: [{ message: { content: BRIEF } }],
      usage: { cost: 0.05 },
    },
  });
  h.generateImage.mockResolvedValue({
    buffer: Buffer.from('fake-png-bytes'),
    costRub: IMAGE_COST,
    raw: { data: [{ b64_json: '***' }] },
  });
  vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');
  vi.stubEnv('ROUTERAI_MODEL_STANDARD', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/articles/:id/cover — envelope (cases 41/45)', () => {
  it('200 { success:true, data:{…} } with the exact §2.1 data shape', async () => {
    const res = await postCover();

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        coverUrl: `/api/articles/${ARTICLE_ID}/cover`,
        coverFile: `${ARTICLE_ID}-1.png`,
        model: 'qwen/qwen-image-2.1-pro',
        costRub: IMAGE_COST,
        spentThisMonthRub: expect.any(Number),
        monthlyCapRub: 300,
        promptPreview: expect.any(String),
        warnings: [],
      },
    });
    expect(res.payload.data.promptPreview.length).toBeGreaterThan(0);
    // D8: the article write never carries status.
    const updateArg = h.articleUpdate.mock.calls[0][0];
    expect(updateArg.data).not.toHaveProperty('status');
  });

  it('passes body {refinement, fresh} through to the service (fresh wins)', async () => {
    // fresh:true + refinement → refinement discarded («Сгенерировать заново»).
    await postCover({ refinement: 'сделай фон светлее', fresh: true });
    let updateArg = h.articleUpdate.mock.calls[0][0];
    expect(updateArg.data.coverPrompt).not.toContain('сделай фон светлее');
    expect(updateArg.data.coverPrompt).not.toContain('Дополнительные указания');

    // refinement without fresh → the section IS composed into the prompt.
    await postCover({ refinement: 'сделай фон светлее' });
    updateArg = h.articleUpdate.mock.calls[1][0];
    expect(updateArg.data.coverPrompt).toContain('Дополнительные указания');
    expect(updateArg.data.coverPrompt).toContain('сделай фон светлее');
  });

  it('empty body → first generation (no refinement section)', async () => {
    await postCover({});

    const updateArg = h.articleUpdate.mock.calls[0][0];
    expect(updateArg.data.coverPrompt).not.toContain('Дополнительные указания');
  });
});

describe('route gates → error envelope (cases 42/44/45)', () => {
  it('non-UUID id → 400 { success:false, error, code:"cover_invalid_article_id" } and zero DB reads', async () => {
    const res = await postCover({}, { id: 'not-a-uuid' });

    expect(res.statusCode).toBe(400);
    expect(res.payload.success).toBe(false);
    expect(res.payload.code).toBe('cover_invalid_article_id');
    expect(typeof res.payload.error).toBe('string');
    expect(res.payload.error.length).toBeGreaterThan(0);
    expect(h.articleFindUnique).not.toHaveBeenCalled();
  });

  it('unknown article → 404 code cover_article_not_found', async () => {
    h.articleFindUnique.mockResolvedValue(null);

    const res = await postCover();

    expect(res.statusCode).toBe(404);
    expect(res.payload).toMatchObject({
      success: false,
      code: 'cover_article_not_found',
    });
    expect(typeof res.payload.error).toBe('string');
  });

  it('refinement of 501 chars → 400 code cover_invalid_refinement, no image call', async () => {
    const res = await postCover({ refinement: 'а'.repeat(501) });

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      success: false,
      code: 'cover_invalid_refinement',
    });
    expect(h.generateImage).not.toHaveBeenCalled();
    expect(h.articleUpdate).not.toHaveBeenCalled();
  });

  it('disabled settings → 403 code cover_disabled (error envelope intact)', async () => {
    h.coverSettingsFindFirst.mockResolvedValue({ enabled: false });

    const res = await postCover();

    expect(res.statusCode).toBe(403);
    expect(res.payload).toMatchObject({ success: false, code: 'cover_disabled' });
    expect(typeof res.payload.error).toBe('string');
  });

  it('missing integrations → 503 code cover_not_configured', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', '');

    const res = await postCover();

    expect(res.statusCode).toBe(503);
    expect(res.payload).toMatchObject({ success: false, code: 'cover_not_configured' });
  });

  it('image failure → 502 code cover_generation_failed (upstream semantics)', async () => {
    h.generateImage.mockRejectedValue(new Error('routerai 500'));

    const res = await postCover();

    expect(res.statusCode).toBe(502);
    expect(res.payload).toMatchObject({ success: false, code: 'cover_generation_failed' });
  });
});

describe('in-flight guard via the route (case 43)', () => {
  it('concurrent second call → 409 cover_in_progress; slot released after success', async () => {
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    h.generateImage.mockImplementationOnce(() => gate.then(() => ({
      buffer: Buffer.from('first-png'),
      costRub: IMAGE_COST,
      raw: { data: [{ b64_json: '***' }] },
    })));

    const first = postCover();
    // Let the first request reach the generateImage await point.
    await vi.waitFor(() => expect(h.generateImage).toHaveBeenCalledTimes(1));

    const second = await postCover();
    expect(second.statusCode).toBe(409);
    expect(second.payload).toMatchObject({ success: false, code: 'cover_in_progress' });

    releaseFirst();
    const firstRes = await first;
    expect(firstRes.statusCode).toBe(200);

    // Slot released after success: a third call runs the full flow again.
    const third = await postCover();
    expect(third.statusCode).toBe(200);
    expect(h.generateImage).toHaveBeenCalledTimes(2);
  });

  it('slot released after a FAILED run too — next call proceeds', async () => {
    h.generateImage.mockRejectedValueOnce(new Error('routerai 500'));

    const failed = await postCover();
    expect(failed.statusCode).toBe(502);
    expect(failed.payload).toMatchObject({ success: false, code: 'cover_generation_failed' });

    // In-flight slot must be free even after the failure (finally-release).
    const next = await postCover();
    expect(next.statusCode).toBe(200);
  });
});
