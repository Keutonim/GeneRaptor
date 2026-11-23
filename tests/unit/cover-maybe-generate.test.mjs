/**
 * Cover checkbox wave (design-cover-checkbox §7.4, Director Q3): the
 * post-finalize cover hook `maybeGenerateCover(articleId)` in
 * server/lib/cover-service.mjs.
 *
 * Contract under test:
 *   - condition CREATED here: settings.autoGenerate === true ||
 *     article.coverRequested === true — otherwise a silent no-op (S1);
 *   - existing coverUrl → skipped / cover_exists, coverRequested consumed (S7,
 *     no double spend);
 *   - marks coverStatus='generating' BEFORE running the flow (UI spinner), then
 *     'ready' on success (S2) — coverRequested consumed on ANY terminal outcome;
 *   - SKIP_CODES → coverStatus='skipped', FAIL_CODES → 'failed' (S3/S8), reason
 *     = the machine code; the article status is NEVER touched (D8);
 *   - a settings-read failure never blocks a REQUESTED cover;
 *   - unknown/missing article → silent no-op, no writes.
 *
 * Pattern: tests/unit/cover-route.test.mjs — the REAL cover-service runs on
 * mocked prisma/HTTP (no DB, no network).
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
  class CoverImageError extends Error {
    constructor(code, message, options) {
      super(message, options);
      this.name = 'CoverImageError';
      this.code = code;
    }
  }
  return { CoverImageError, generateImage: h.generateImage };
});

import { maybeGenerateCover, generateCoverForArticle } from '../../server/lib/cover-service.mjs';

const ARTICLE_ID = '44444444-4444-4444-8444-444444444444';
const COVER_ROUTE = `/api/articles/${ARTICLE_ID}/cover`;
const BRIEF = 'Краткий бриф для обложки.';

let dataDir = '';
let coversDir = '';

function makeArticle(overrides = {}) {
  return {
    id: ARTICLE_ID,
    topic: 'Чистка лица',
    status: 'ready',
    coverRequested: true,
    coverUrl: null,
    coverStatus: null,
    coverSkipReason: null,
    wpPostId: null,
    ...overrides,
  };
}

/** All article.update payloads the hook+flow produced, in order. */
const updatePayloads = () => h.articleUpdate.mock.calls.map((c) => c[0].data);

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'generaptor-cover-maybe-'));
  coversDir = join(dataDir, 'covers');
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(coversDir, { recursive: true, force: true });
  vi.stubEnv('GENERAPTOR_DATA_DIR', dataDir);
  h.articleUpdate.mockResolvedValue({});
  h.articleVersionFindFirst.mockResolvedValue({
    id: 'ver-1',
    platform: 'base',
    contentText: 'Текст статьи.',
    contentHtml: null,
  });
  h.agentRunCreate.mockResolvedValue({});
  h.agentRunFindMany.mockResolvedValue([]); // spent = 0
  h.coverSettingsFindFirst.mockResolvedValue(null); // DEFAULTS (cap 300, enabled)
  h.providerConfigFindMany.mockResolvedValue([]);
  h.callRouterAI.mockResolvedValue({
    status: 200,
    data: { choices: [{ message: { content: BRIEF } }], usage: { cost: 0.05 } },
  });
  h.generateImage.mockResolvedValue({
    buffer: Buffer.from('fake-png'),
    costRub: 4.82,
    raw: { data: [{ b64_json: '***' }] },
  });
  vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('maybeGenerateCover — the launch condition (docs/ui-design.md §9)', () => {
  it('S1: no request + autoGenerate off → silent no-op (no writes, no generation)', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle({ coverRequested: false }));

    await maybeGenerateCover(ARTICLE_ID);

    expect(h.articleUpdate).not.toHaveBeenCalled();
    expect(h.generateImage).not.toHaveBeenCalled();
    expect(h.callRouterAI).not.toHaveBeenCalled();
  });

  it('coverRequested=true → the flow runs even with autoGenerate off', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle({ coverRequested: true }));

    await maybeGenerateCover(ARTICLE_ID);

    expect(h.generateImage).toHaveBeenCalledTimes(1);
  });

  it('autoGenerate=true → the flow runs even without a per-article request (S9 seam)', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle({ coverRequested: false }));
    h.coverSettingsFindFirst.mockResolvedValue({ enabled: true, autoGenerate: true });

    await maybeGenerateCover(ARTICLE_ID);

    expect(h.generateImage).toHaveBeenCalledTimes(1);
  });

  it('a settings-read failure never blocks a REQUESTED cover (defaults to autoGenerate:false)', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle({ coverRequested: true }));
    h.coverSettingsFindFirst.mockRejectedValueOnce(new Error('db down'));

    await maybeGenerateCover(ARTICLE_ID);

    // The hook still ran the flow (which re-reads settings on the mock → defaults).
    expect(h.generateImage).toHaveBeenCalledTimes(1);
  });
});

describe('maybeGenerateCover — the state channel (docs/ui-design.md §9)', () => {
  it('S2 happy path: generating → (flow) → ready; coverRequested consumed; stale reason cleared', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle({ coverStatus: 'requested' }));

    await maybeGenerateCover(ARTICLE_ID);

    const payloads = updatePayloads();
    // 1st write: the spinner marker goes to the DB BEFORE the flow runs.
    expect(payloads[0]).toEqual({ coverStatus: 'generating', coverSkipReason: null });
    // 2nd write: the flow's six cover* columns (never status — D8).
    expect(payloads[1]).toMatchObject({ coverUrl: COVER_ROUTE, coverCostRub: 4.82 });
    // 3rd write: terminal ready + flag consumed.
    expect(payloads[2]).toEqual({
      coverStatus: 'ready',
      coverSkipReason: null,
      coverRequested: false,
    });
    // D8: not a single write touches Article.status.
    for (const data of payloads) expect(data).not.toHaveProperty('status');
  });

  it('S7 idempotency: coverUrl already exists → skipped/cover_exists, flag consumed, NO spend', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle({ coverUrl: COVER_ROUTE }));

    await maybeGenerateCover(ARTICLE_ID);

    expect(h.generateImage).not.toHaveBeenCalled();
    expect(h.callRouterAI).not.toHaveBeenCalled();
    const payloads = updatePayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      coverStatus: 'skipped',
      coverSkipReason: 'cover_exists',
      coverRequested: false,
    });
  });

  it('S3 budget exhausted → skipped + cover_budget_exceeded (no image call)', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle());
    h.coverSettingsFindFirst.mockResolvedValue({ enabled: true, monthlyCapRub: 0 });

    await maybeGenerateCover(ARTICLE_ID);

    expect(h.generateImage).not.toHaveBeenCalled();
    const payloads = updatePayloads();
    expect(payloads[0]).toEqual({ coverStatus: 'generating', coverSkipReason: null });
    expect(payloads[1]).toEqual({
      coverStatus: 'skipped',
      coverSkipReason: 'cover_budget_exceeded',
      coverRequested: false,
    });
    for (const data of payloads) expect(data).not.toHaveProperty('status');
  });

  it('S4 covers disabled in settings → skipped + cover_disabled', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle());
    h.coverSettingsFindFirst.mockResolvedValue({ enabled: false });

    await maybeGenerateCover(ARTICLE_ID);

    const payloads = updatePayloads();
    expect(payloads[1]).toEqual({
      coverStatus: 'skipped',
      coverSkipReason: 'cover_disabled',
      coverRequested: false,
    });
  });

  it('S5 no integrations → skipped + cover_not_configured', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle());
    vi.stubEnv('ROUTERAI_API_KEY', '');

    await maybeGenerateCover(ARTICLE_ID);

    const payloads = updatePayloads();
    expect(payloads[1]).toEqual({
      coverStatus: 'skipped',
      coverSkipReason: 'cover_not_configured',
      coverRequested: false,
    });
  });

  it('S8 image failure (spend attempted) → failed + cover_generation_failed, article stays ready', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle({ status: 'ready' }));
    h.generateImage.mockRejectedValue(new Error('routerai 500'));

    await maybeGenerateCover(ARTICLE_ID);

    const payloads = updatePayloads();
    expect(payloads[payloads.length - 1]).toEqual({
      coverStatus: 'failed',
      coverSkipReason: 'cover_generation_failed',
      coverRequested: false,
    });
    for (const data of payloads) expect(data).not.toHaveProperty('status');
    // D8: the article row still says ready (the mock never changed it).
  });

  it('an unknown error without a machine code → failed + cover_generation_failed fallback', async () => {
    h.articleFindUnique.mockResolvedValue(makeArticle());
    h.articleVersionFindFirst.mockRejectedValue(new Error('boom'));

    await maybeGenerateCover(ARTICLE_ID);

    const payloads = updatePayloads();
    expect(payloads[payloads.length - 1]).toEqual({
      coverStatus: 'failed',
      coverSkipReason: 'cover_generation_failed',
      coverRequested: false,
    });
  });
});

describe('maybeGenerateCover — guards', () => {
  it('unknown article → silent no-op (no writes)', async () => {
    h.articleFindUnique.mockResolvedValue(null);

    await maybeGenerateCover(ARTICLE_ID);

    expect(h.articleUpdate).not.toHaveBeenCalled();
    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('coversInProgress (cover_in_progress) maps to FAILED per design FAIL_CODES', async () => {
    // The flow's in-flight guard can only trip when a manual generation is
    // already running for the same article — the hook then records failed +
    // the code, NOT skipped.
    h.articleFindUnique.mockResolvedValue(makeArticle());
    let release;
    h.generateImage.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const first = generateCoverForArticle({ articleId: ARTICLE_ID });
    // Wait until the first run holds the slot (reaches generateImage).
    await vi.waitFor(() => expect(h.generateImage).toHaveBeenCalledTimes(1));

    await maybeGenerateCover(ARTICLE_ID);

    const payloads = updatePayloads();
    expect(payloads[payloads.length - 1]).toEqual({
      coverStatus: 'failed',
      coverSkipReason: 'cover_in_progress',
      coverRequested: false,
    });

    release({ buffer: Buffer.from('x'), costRub: 4.82, raw: {} });
    await first;
  }, 8000);
});
