/**
 * Cover checkbox wave (design-cover-checkbox §7.2): POST /api/articles/:id/start
 * reads the optional boolean `coverRequested` and persists the request.
 *
 * Contract under test:
 *   - absent field → the column is NOT touched (a pending request survives a
 *     plain re-start); the response still echoes the stored flag;
 *   - true → coverRequested=true + coverStatus='requested' (the §4.2 badge
 *     channel), stale reason cleared;
 *   - true + the article already has a cover → double-spend guard: flag stored
 *     false + skipped / cover_exists (S7);
 *   - false → explicit decline clears a «зависший» request (flag + status +
 *     reason);
 *   - non-boolean → 400 {code:'cover_requested_invalid'}, no write, no enqueue;
 *   - the response adds coverRequested (effective value) additively;
 *   - the queue job payload is unchanged ({articleId} only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  articleUpdate: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    article: { findUnique: h.articleFindUnique, update: h.articleUpdate },
    articleVersion: { findFirst: vi.fn() },
    agentRun: { create: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    coverSettings: { findFirst: vi.fn() },
    platform: { findUnique: vi.fn() },
  },
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: h.queueAdd, getJobs: vi.fn() },
}));

import { articlesRouter } from '../../server/routes/articles.mjs';

const ARTICLE_ID = '55555555-5555-4555-8555-555555555555';

function makeArticle(overrides = {}) {
  return {
    id: ARTICLE_ID,
    topic: 'Тестовая статья',
    status: 'draft',
    coverRequested: false,
    coverStatus: null,
    coverSkipReason: null,
    coverUrl: null,
    ...overrides,
  };
}

async function callStart(body) {
  const layer = articlesRouter.stack.find(
    (l) => l.route?.path === '/articles/:id/start' && l.route.methods.post,
  );
  if (!layer) throw new Error('route not found: POST /articles/:id/start');
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
  await layer.route.stack[0].handle({ params: { id: ARTICLE_ID }, body }, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.articleFindUnique.mockResolvedValue(makeArticle());
  h.articleUpdate.mockResolvedValue({});
  h.queueAdd.mockResolvedValue(undefined);
});

describe('POST /api/articles/:id/start — coverRequested (docs/ui-design.md §9)', () => {
  it('coverRequested:true → stored true + coverStatus:"requested", response echoes true', async () => {
    const res = await callStart({ coverRequested: true });

    expect(res.statusCode).toBe(200);
    expect(res.payload.success).toBe(true);
    expect(res.payload.data).toMatchObject({
      articleId: ARTICLE_ID,
      message: 'Генерация поставлена в очередь',
      coverRequested: true,
    });
    const data = h.articleUpdate.mock.calls[0][0].data;
    expect(data.coverRequested).toBe(true);
    expect(data.coverStatus).toBe('requested');
    expect(data.coverSkipReason).toBeNull();
    // The rest of the /start reset behavior is untouched.
    expect(data.status).toBe('queued');
    expect(h.queueAdd).toHaveBeenCalledWith('generate', { articleId: ARTICLE_ID });
  });

  it('S7 guard: true + existing coverUrl → double-spend guard (false + skipped/cover_exists)', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({ coverUrl: 'https://…/cover.png' }),
    );

    const res = await callStart({ coverRequested: true });

    expect(res.statusCode).toBe(200);
    expect(res.payload.data.coverRequested).toBe(false);
    const data = h.articleUpdate.mock.calls[0][0].data;
    expect(data.coverRequested).toBe(false);
    expect(data.coverStatus).toBe('skipped');
    expect(data.coverSkipReason).toBe('cover_exists');
  });

  it('coverRequested:false → explicit decline clears a stuck request', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({ coverRequested: true, coverStatus: 'requested' }),
    );

    const res = await callStart({ coverRequested: false });

    expect(res.statusCode).toBe(200);
    expect(res.payload.data.coverRequested).toBe(false);
    const data = h.articleUpdate.mock.calls[0][0].data;
    expect(data.coverRequested).toBe(false);
    expect(data.coverStatus).toBeNull();
    expect(data.coverSkipReason).toBeNull();
  });

  it('field absent → the column is NOT in the update; response echoes the stored flag', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle({ coverRequested: false }));

    const res = await callStart({});

    expect(res.statusCode).toBe(200);
    expect(res.payload.data.coverRequested).toBe(false);
    const data = h.articleUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('coverRequested');
    expect(data).not.toHaveProperty('coverStatus');
    expect(data).not.toHaveProperty('coverSkipReason');
  });

  it('field absent + a pending stored request → response reports true (request survives)', async () => {
    h.articleFindUnique.mockResolvedValue(
      makeArticle({ coverRequested: true, coverStatus: 'requested' }),
    );

    const res = await callStart({});

    expect(res.payload.data.coverRequested).toBe(true);
    expect(h.articleUpdate.mock.calls[0][0].data).not.toHaveProperty('coverRequested');
  });

  it('non-boolean coverRequested → 400 code cover_requested_invalid, no write, no enqueue', async () => {
    const res = await callStart({ coverRequested: 'yes' });

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      success: false,
      code: 'cover_requested_invalid',
    });
    expect(typeof res.payload.error).toBe('string');
    expect(h.articleUpdate).not.toHaveBeenCalled();
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it('unknown article → 404 before any cover handling', async () => {
    h.articleFindUnique.mockResolvedValue(null);

    const res = await callStart({ coverRequested: true });

    expect(res.statusCode).toBe(404);
    expect(h.articleUpdate).not.toHaveBeenCalled();
  });
});
