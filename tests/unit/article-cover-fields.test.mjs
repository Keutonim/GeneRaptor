/**
 * Cover checkbox wave (design-cover-checkbox §7.5): the read side of the
 * per-article cover channel.
 *
 *   - serializeArticle (GET /api/articles list) → + coverRequested /
 *     coverStatus / coverSkipReason (QueueItem badge + polling gate §4.3);
 *   - GET /api/articles/:id/details → + coverUrl / coverModel / coverCostRub
 *     (Decimal → Number) / coverGeneratedAt / coverStatus / coverSkipReason —
 *     revives the ArticleDetailsModal cover block (docs/ui-design.md §9);
 *   - GET /api/articles/:id/content → + coverStatus / coverSkipReason next to
 *     the existing cover* fields (the UI poll channel, Director Q3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  articleFindMany: vi.fn(),
  articleCount: vi.fn(),
  agentRunGroupBy: vi.fn(),
  articleVersionFindFirst: vi.fn(),
  coverSettingsFindFirst: vi.fn(),
}));

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    article: {
      findUnique: h.articleFindUnique,
      findMany: h.articleFindMany,
      count: h.articleCount,
      update: vi.fn(),
    },
    articleVersion: { findFirst: h.articleVersionFindFirst },
    agentRun: { create: vi.fn(), findMany: vi.fn(), groupBy: h.agentRunGroupBy },
    coverSettings: { findFirst: h.coverSettingsFindFirst },
    platform: { findUnique: vi.fn() },
  },
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn(), getJobs: vi.fn() },
}));

import { articlesRouter } from '../../server/routes/articles.mjs';

const ARTICLE_ID = '66666666-6666-4666-8666-666666666666';

function makeArticle(overrides = {}) {
  return {
    id: ARTICLE_ID,
    topic: 'Чистка лица',
    targetLength: 60000,
    status: 'ready',
    specialistId: null,
    serviceId: null,
    sourceSiteId: null,
    service: null,
    specialist: null,
    sourceSite: null,
    needsReviewReason: null,
    wordstatKeywords: null,
    wordstatStatus: null,
    agentRuns: [],
    coverRequested: true,
    coverStatus: 'generating',
    coverSkipReason: null,
    coverUrl: null,
    coverMediaId: null,
    coverModel: null,
    coverCostRub: null,
    coverGeneratedAt: null,
    createdAt: new Date('2026-10-24T10:00:00Z'),
    updatedAt: new Date('2026-10-24T10:00:00Z'),
    versions: [],
    publications: [],
    researchSources: [],
    ...overrides,
  };
}

async function callRoute(path, { method = 'get', params = { id: ARTICLE_ID }, query = {} } = {}) {
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
  await layer.route.stack[0].handle({ params, query }, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.articleCount.mockResolvedValue(1);
  h.agentRunGroupBy.mockResolvedValue([]);
  h.articleVersionFindFirst.mockResolvedValue({
    title: 'Чистка лица',
    description: null,
    contentHtml: '<p>Текст</p>',
    contentText: 'Старый текст',
    contentMarkdown: null,
    characterCount: 5,
  });
  h.coverSettingsFindFirst.mockResolvedValue(null); // DEFAULTS
  vi.stubEnv('ROUTERAI_API_KEY', '');
  vi.stubEnv('ROUTERAI_MODEL_STANDARD', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/articles — serializeArticle cover channel fields (§7.5)', () => {
  it('exposes coverRequested/coverStatus/coverSkipReason per item', async () => {
    h.articleFindMany.mockResolvedValue([makeArticle()]);

    const res = await callRoute('/articles');

    expect(res.statusCode).toBe(200);
    const item = res.payload.data[0];
    expect(item.coverRequested).toBe(true);
    expect(item.coverStatus).toBe('generating');
    expect(item.coverSkipReason).toBeNull();
  });

  it('defaults for legacy rows: false/null/null (neutral access)', async () => {
    h.articleFindMany.mockResolvedValue([
      makeArticle({ coverRequested: false, coverStatus: null, coverSkipReason: null }),
    ]);

    const res = await callRoute('/articles');

    const item = res.payload.data[0];
    expect(item.coverRequested).toBe(false);
    expect(item.coverStatus).toBeNull();
    expect(item.coverSkipReason).toBeNull();
    // Pre-existing list contract intact.
    expect(item).toHaveProperty('status', 'ready');
    expect(item).toHaveProperty('progress');
    expect(item).not.toHaveProperty('coverUrl'); // §7.5: coverUrl stays on /content
  });
});

describe('GET /api/articles/:id/details — cover block revival (docs/ui-design.md §9)', () => {
  it('returns the six cover fields; Decimal costRub leaves as a Number', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({
        coverUrl: 'https://example.com/wp-content/uploads/2026/10/cover.png',
        coverMediaId: 41233,
        coverModel: 'qwen/qwen-image-2.1-pro',
        coverCostRub: { toNumber: () => 4.82, valueOf: () => '4.82' },
        coverGeneratedAt: new Date('2026-10-24T12:42:00Z'),
        coverStatus: 'skipped',
        coverSkipReason: 'cover_budget_exceeded',
        versions: [{ characterCount: 5432 }],
      }),
    );

    const res = await callRoute('/articles/:id/details');

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      id: ARTICLE_ID,
      topic: 'Чистка лица',
      coverUrl: 'https://example.com/wp-content/uploads/2026/10/cover.png',
      coverModel: 'qwen/qwen-image-2.1-pro',
      coverCostRub: 4.82,
      coverStatus: 'skipped',
      coverSkipReason: 'cover_budget_exceeded',
    });
    expect(typeof res.payload.coverCostRub).toBe('number');
    // The fake res.json stores the object pre-serialization → Date here;
    // over the wire Express serializes it to the same ISO string.
    expect(new Date(res.payload.coverGeneratedAt).toISOString()).toBe('2026-10-24T12:42:00.000Z');
    // Pre-existing details fields intact.
    expect(res.payload).toHaveProperty('agentRuns');
    expect(res.payload).toHaveProperty('postcheck');
  });

  it('an article without a cover → all cover fields null', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({
        coverRequested: false,
        coverStatus: null,
        coverSkipReason: null,
        versions: [{ characterCount: 1 }],
      }),
    );

    const res = await callRoute('/articles/:id/details');

    expect(res.payload.coverUrl).toBeNull();
    expect(res.payload.coverFile).toBeNull();
    expect(res.payload.coverModel).toBeNull();
    expect(res.payload.coverCostRub).toBeNull();
    expect(res.payload.coverGeneratedAt).toBeNull();
    expect(res.payload.coverStatus).toBeNull();
    expect(res.payload.coverSkipReason).toBeNull();
  });

  // Dev-11 (D1): the details modal draws the cover PICTURE from
  // `data.coverFile` (src/components/ArticleDetailsModal.tsx:253,533) — the
  // route must ship the file reference, not only the legacy coverUrl. Before
  // the fix /details carried no coverFile → the picture never rendered.
  it('carries coverFile so the details modal can render the cover picture', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({
        coverUrl: `/api/articles/${ARTICLE_ID}/cover`,
        coverFile: `${ARTICLE_ID}-1.png`,
        coverModel: 'qwen/qwen-image-2.1-pro',
        coverStatus: 'ready',
        coverSkipReason: null,
        versions: [{ characterCount: 5432 }],
      }),
    );

    const res = await callRoute('/articles/:id/details');

    expect(res.statusCode).toBe(200);
    expect(res.payload).toHaveProperty('coverFile');
    expect(res.payload.coverFile).toBe(`${ARTICLE_ID}-1.png`);
    // The legacy field stays — the response shape stays backward compatible.
    expect(res.payload.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
    // The pre-existing details fields are intact.
    expect(res.payload).toHaveProperty('agentRuns');
    expect(res.payload).toHaveProperty('postcheck');
  });
});

describe('GET /api/articles/:id/content — coverStatus channel (§7.5, Director Q3)', () => {
  it('exposes coverStatus/coverSkipReason next to the existing cover* fields', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({
        coverStatus: 'generating',
        coverSkipReason: null,
        rentryUrl: null,
        rentryEditCode: null,
        tgUrl: null,
        tgMessageId: null,
      }),
    );

    const res = await callRoute('/articles/:id/content');

    expect(res.statusCode).toBe(200);
    expect(res.payload.success).toBe(true);
    expect(res.payload.data.coverStatus).toBe('generating');
    expect(res.payload.data.coverSkipReason).toBeNull();
    // Pre-existing content contract intact.
    expect(res.payload.data.coverUrl).toBeNull();
    expect(res.payload.data.coverAvailable).toBe(false); // key stubbed off
    // U6: contentText is freshly derived from contentHtml ('<p>Текст</p>').
    expect(res.payload.data.contentText).toBe('Текст');
  });

  it('skipped reason travels to the UI (§5 note source)', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({
        coverStatus: 'skipped',
        coverSkipReason: 'cover_budget_exceeded',
        rentryUrl: null,
        rentryEditCode: null,
        tgUrl: null,
        tgMessageId: null,
      }),
    );

    const res = await callRoute('/articles/:id/content');

    expect(res.payload.data.coverStatus).toBe('skipped');
    expect(res.payload.data.coverSkipReason).toBe('cover_budget_exceeded');
  });

  // Dev-5b (defect 1): the M5 panel keys readiness on coverFile
  // (src/features/generation/CoverPanel.tsx:49-50) and the client type
  // declares it (src/features/generation/api.ts:35) — the route must ship it.
  it('exposes coverFile next to coverUrl (the M5 file reference the panel keys on)', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({
        coverUrl: `/api/articles/${ARTICLE_ID}/cover`,
        coverFile: `${ARTICLE_ID}-1.png`,
        coverStatus: 'ready',
        coverSkipReason: null,
        rentryUrl: null,
        rentryEditCode: null,
        tgUrl: null,
        tgMessageId: null,
      }),
    );

    const res = await callRoute('/articles/:id/content');

    expect(res.statusCode).toBe(200);
    expect(res.payload.data.coverFile).toBe(`${ARTICLE_ID}-1.png`);
    // Pre-existing content contract intact.
    expect(res.payload.data.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
  });

  it('coverFile is null when the article has no cover', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({
        coverUrl: null,
        coverFile: null,
        coverStatus: null,
        coverSkipReason: null,
        rentryUrl: null,
        rentryEditCode: null,
        tgUrl: null,
        tgMessageId: null,
      }),
    );

    const res = await callRoute('/articles/:id/content');

    expect(res.payload.data).toHaveProperty('coverFile');
    expect(res.payload.data.coverFile).toBeNull();
  });
});
