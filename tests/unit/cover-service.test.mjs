/**
 * Unit tests for server/lib/cover-service.mjs.
 *
 * M5: the cover flow is UNHOOKED from WordPress — the binary lands in the
 * local store (<data-dir>/covers/) and the DB keeps the file reference.
 * These tests therefore assert the local-store contract, not a WP upload.
 *
 * Mocking strategy (the standard vi.hoisted + vi.mock pattern for route-level
 * suites):
 * vi.hoisted spies + vi.mock for db / callRouterAI / routerai-images.
 * cover-settings, cover-pricing, cover-prompt and cover-store run for real on
 * top of the mocked prisma client. NO live network anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // The provider layer (M3) resolves the active provider through this table.
    providerConfig: { findMany: h.providerConfigFindMany },
  },
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

const {
  generateCoverForArticle,
  CoverFlowError,
  COVER_AGENT_NAME,
} = await import('../../server/lib/cover-service.mjs');
const { COMPRESSION_PROMPT } = await import('../../server/lib/cover-prompt.mjs');
const { monthStartMs } = await import('../../server/lib/cover-pricing.mjs');

const ARTICLE_ID = '33333333-3333-4333-8333-333333333333';
const IMAGE_COST = 4.82;
const COMPRESSION_COST = 0.05;
const BRIEF = 'Краткий бриф: чистка лица, показания, цена.';
const IMAGE_BYTES = Buffer.from('fake-png-bytes');

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

function makeSettingsRow(overrides = {}) {
  return {
    id: 'sett-1',
    enabled: true,
    model: 'qwen/qwen-image-2.1-pro',
    compressionModel: null,
    promptTemplate: 'Шаблон обложки. {articleBrief}',
    aspectRatio: '16:9',
    resolution: '1K',
    quality: 'high',
    outputFormat: 'png',
    autoGenerate: false,
    monthlyCapRub: 300,
    updatedAt: new Date('2026-10-20T10:00:00Z'),
    ...overrides,
  };
}

function lastUpdateData() {
  const call = h.articleUpdate.mock.calls.at(-1);
  return call ? call[0].data : undefined;
}

function lastAgentRunData() {
  const call = h.agentRunCreate.mock.calls.at(-1);
  return call ? call[0].data : undefined;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'generaptor-cover-service-'));
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
      usage: { cost: COMPRESSION_COST },
    },
  });
  h.generateImage.mockResolvedValue({
    buffer: IMAGE_BYTES,
    costRub: IMAGE_COST,
    raw: { data: [{ b64_json: '***' }] },
  });
  vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');
  vi.stubEnv('ROUTERAI_MODEL_STANDARD', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cover-service: happy path (case 28)', () => {
  it('updates the article with the cover fields and never touches status (D8)', async () => {
    const result = await generateCoverForArticle({ articleId: ARTICLE_ID });

    expect(h.articleUpdate).toHaveBeenCalledTimes(1);
    const [updateArg] = h.articleUpdate.mock.calls[0];
    expect(updateArg.where).toEqual({ id: ARTICLE_ID });
    expect(Object.keys(updateArg.data).sort()).toEqual([
      'coverCostRub',
      'coverFile',
      'coverGeneratedAt',
      'coverModel',
      'coverPrompt',
      'coverSkipReason',
      'coverStatus',
      'coverUrl',
    ]);
    expect(updateArg.data).not.toHaveProperty('status');
    expect(updateArg.data.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
    expect(updateArg.data.coverFile).toBe(`${ARTICLE_ID}-1.png`);
    expect(updateArg.data.coverModel).toBe('qwen/qwen-image-2.1-pro');
    expect(updateArg.data.coverCostRub).toBe(IMAGE_COST);
    expect(updateArg.data.coverGeneratedAt).toBeInstanceOf(Date);
    // Default template has no {articleBrief} token → brief appended as a section.
    expect(updateArg.data.coverPrompt).toContain(`Содержание статьи: ${BRIEF}`);

    expect(Object.keys(result).sort()).toEqual([
      'costRub',
      'coverFile',
      'coverUrl',
      'model',
      'monthlyCapRub',
      'promptPreview',
      'spentThisMonthRub',
      'warnings',
    ]);
    expect(result.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
    expect(result.coverFile).toBe(`${ARTICLE_ID}-1.png`);
    expect(result.model).toBe('qwen/qwen-image-2.1-pro');
    expect(result.costRub).toBe(IMAGE_COST);
    expect(result.spentThisMonthRub).toBeCloseTo(4.82, 10);
    expect(result.monthlyCapRub).toBe(300);
    expect(typeof result.promptPreview).toBe('string');
    expect(result.promptPreview.length).toBeGreaterThan(0);
    expect(result.promptPreview).toBe(updateArg.data.coverPrompt.slice(0, 300));
    expect(result.warnings).toEqual([]);
  });

  it('loads the full article row without a select clause', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.articleFindUnique).toHaveBeenCalledWith({ where: { id: ARTICLE_ID } });
  });
});

// Dev-5b (defect 2): the manual flow wrote the six cover fields but never
// coverStatus — a previously failed cover stayed in the failure state in
// CoverPanel.tsx:97-101, so the panel never reflected the new cover.
describe('cover-service: the cover channel reaches the DB', () => {
  it('marks the cover ready in the same update that stores the binary', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });

    const data = lastUpdateData();
    expect(data.coverStatus).toBe('ready');
    expect(data.coverSkipReason).toBeNull();
  });

  it('clears a stale failure state of the previous cover', async () => {
    // The article already carries a failed cover → the manual generation must
    // overwrite the channel, not leave the panel in the failure state.
    h.articleFindUnique.mockResolvedValue(
      makeArticle({
        coverStatus: 'failed',
        coverSkipReason: 'cover_generation_failed',
        coverFile: `${ARTICLE_ID}-9.png`,
      }),
    );

    await generateCoverForArticle({ articleId: ARTICLE_ID });

    const data = lastUpdateData();
    expect(data.coverStatus).toBe('ready');
    expect(data.coverSkipReason).toBeNull();
    expect(data.coverFile).toBe(`${ARTICLE_ID}-1.png`);
  });
});

describe('cover-service: local cover store (M5)', () => {
  it('writes the binary under <data-dir>/covers and keeps the reference in the DB', async () => {
    const result = await generateCoverForArticle({ articleId: ARTICLE_ID });

    const storedPath = join(coversDir, `${ARTICLE_ID}-1.png`);
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath)).toEqual(IMAGE_BYTES);

    // The DB stores the FILE REFERENCE — never a remote URL.
    expect(lastUpdateData().coverFile).toBe(`${ARTICLE_ID}-1.png`);
    expect(lastUpdateData().coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
    expect(result.coverUrl.startsWith('http')).toBe(false);
  });

  it('numbers the next cover of the same article', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    await generateCoverForArticle({ articleId: ARTICLE_ID });

    expect(existsSync(join(coversDir, `${ARTICLE_ID}-1.png`))).toBe(true);
    expect(existsSync(join(coversDir, `${ARTICLE_ID}-2.png`))).toBe(true);
    expect(lastUpdateData().coverFile).toBe(`${ARTICLE_ID}-2.png`);
  });

  it('500 cover_save_failed when the binary cannot be stored, no article update', async () => {
    // A FILE where the covers directory must be → the store cannot write.
    rmSync(coversDir, { recursive: true, force: true });
    writeFileSync(coversDir, 'not-a-directory');

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_save_failed',
      status: 500,
    });
    expect(h.articleUpdate).not.toHaveBeenCalled();
    const data = lastAgentRunData();
    expect(data.status).toBe('failed');
    expect(data.costRub).toBe(IMAGE_COST);
  });
});

describe('cover-service: ledger row on success (case 29, 38)', () => {
  it('creates an agentRun with COVER_AGENT_NAME, costRub and startedAt/finishedAt', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });

    expect(h.agentRunCreate).toHaveBeenCalledTimes(1);
    const data = lastAgentRunData();
    expect(data.articleId).toBe(ARTICLE_ID);
    expect(data.agentName).toBe('Генерация обложки');
    expect(data.agentName).toBe(COVER_AGENT_NAME);
    expect(data.status).toBe('success');
    expect(data.costRub).toBe(IMAGE_COST);
    expect(data.startedAt).toBeInstanceOf(Date);
    expect(data.finishedAt).toBeInstanceOf(Date);
    expect(data.error).toBeFalsy();

    const input = JSON.parse(data.inputJson);
    expect(input.model).toBe('qwen/qwen-image-2.1-pro');
    expect(input.provider).toBe('routerai');
    expect(input.resolution).toBe('1K');
    expect(input.aspectRatio).toBe('16:9');
    expect(input.quality).toBe('high');
    expect(input.outputFormat).toBe('png');
    expect(input.prompt).toBe(lastUpdateData().coverPrompt);
    expect(input.refinement).toBeUndefined();

    const output = JSON.parse(data.outputJson);
    expect(output.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
    expect(output.coverFile).toBe(`${ARTICLE_ID}-1.png`);
    expect(output.bytes).toBe(Buffer.byteLength('fake-png-bytes'));
    expect(typeof output.durationMs).toBe('number');
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof output.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(output.generatedAt))).toBe(false);
    expect(output.compressionCostRub).toBe(COMPRESSION_COST);
  });

  it('records the refinement in inputJson and in the composed prompt', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID, refinement: 'Добавь акцию месяца' });
    const input = JSON.parse(lastAgentRunData().inputJson);
    expect(input.refinement).toBe('Добавь акцию месяца');
    expect(lastUpdateData().coverPrompt).toContain('Дополнительные указания: Добавь акцию месяца');
  });
});

describe('cover-service: budget gate before any spend (cases 30, 31, 37)', () => {
  it('402 cover_budget_exceeded when spent >= cap, nothing called downstream', async () => {
    h.agentRunFindMany.mockResolvedValue([
      { costRub: 300, startedAt: new Date(), finishedAt: new Date() },
    ]);

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_budget_exceeded',
      status: 402,
    });
    expect(h.callRouterAI).not.toHaveBeenCalled();
    expect(h.generateImage).not.toHaveBeenCalled();
    expect(h.articleUpdate).not.toHaveBeenCalled();
    expect(h.agentRunCreate).not.toHaveBeenCalled();
  });

  it('402 when spent + known estimate would exceed the cap', async () => {
    h.agentRunFindMany.mockResolvedValue([
      { costRub: 297.5, startedAt: new Date(), finishedAt: null },
    ]);

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_budget_exceeded',
      status: 402,
    });
    expect(h.callRouterAI).not.toHaveBeenCalled();
    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('queries the ledger for the MSK month including null-startedAt rows', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });

    expect(h.agentRunFindMany).toHaveBeenCalledTimes(1);
    const where = h.agentRunFindMany.mock.calls[0][0].where;
    expect(where.agentName).toBe('Генерация обложки');
    expect(where.OR).toEqual([{ startedAt: { gte: new Date(monthStartMs(new Date())) } }, { startedAt: null }]);
  });

  it('counts Prisma Decimal-like costRub values from the ledger', async () => {
    h.agentRunFindMany.mockResolvedValue([
      { costRub: { toNumber: () => 299 }, startedAt: new Date(), finishedAt: null },
    ]);
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_budget_exceeded',
    });
  });
});

describe('cover-service: image failure after compression (case 33)', () => {
  it('502 cover_generation_failed, no store write/update, failed ledger row with zero image cost', async () => {
    const { CoverImageError } = await import('../../server/lib/routerai-images.mjs');
    h.generateImage.mockRejectedValue(new CoverImageError('cover_generation_failed', 'routerai images http 500 at /images'));

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_generation_failed',
      status: 502,
    });
    expect(h.articleUpdate).not.toHaveBeenCalled();
    expect(existsSync(join(coversDir, `${ARTICLE_ID}-1.png`))).toBe(false);
    const data = lastAgentRunData();
    expect(data.status).toBe('failed');
    expect(data.costRub).toBe(0);
    expect(data.startedAt).toBeInstanceOf(Date);
    expect(JSON.parse(data.outputJson).compressionCostRub).toBe(COMPRESSION_COST);
  });

  it('propagates cover_not_configured from the image client as 503', async () => {
    const { CoverImageError } = await import('../../server/lib/routerai-images.mjs');
    h.generateImage.mockRejectedValue(new CoverImageError('cover_not_configured', 'ROUTERAI_API_KEY is not set'));

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_not_configured',
      status: 503,
    });
  });
});

describe('cover-service: fresh regeneration and refinement guards (case 34)', () => {
  it('fresh:true ignores the refinement entirely', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID, refinement: 'Старое уточнение', fresh: true });
    const prompt = lastUpdateData().coverPrompt;
    expect(prompt).not.toContain('Старое уточнение');
    expect(prompt).not.toContain('Дополнительные указания');
    expect(JSON.parse(lastAgentRunData().inputJson).refinement).toBeUndefined();
  });

  it('400 cover_invalid_refinement for >500 chars, before touching the DB', async () => {
    await expect(
      generateCoverForArticle({ articleId: ARTICLE_ID, refinement: 'x'.repeat(501) }),
    ).rejects.toMatchObject({ code: 'cover_invalid_refinement', status: 400 });
    expect(h.articleFindUnique).not.toHaveBeenCalled();
  });

  it('400 cover_invalid_refinement for a non-string refinement', async () => {
    await expect(
      generateCoverForArticle({ articleId: ARTICLE_ID, refinement: 42 }),
    ).rejects.toMatchObject({ code: 'cover_invalid_refinement', status: 400 });
  });

  it('400 cover_invalid_article_id for a non-UUID id', async () => {
    await expect(generateCoverForArticle({ articleId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'cover_invalid_article_id',
      status: 400,
    });
    expect(h.articleFindUnique).not.toHaveBeenCalled();
  });

  it('404 cover_article_not_found when the row is missing', async () => {
    h.articleFindUnique.mockResolvedValue(null);
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_article_not_found',
      status: 404,
    });
  });
});

describe('cover-service: feature and content guards (§4 steps 4-5)', () => {
  it('403 cover_disabled when settings.enabled is false', async () => {
    h.coverSettingsFindFirst.mockResolvedValue(makeSettingsRow({ enabled: false }));
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_disabled',
      status: 403,
    });
    expect(h.callRouterAI).not.toHaveBeenCalled();
  });

  it('503 cover_not_configured without any provider configured', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', '');
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_not_configured',
      status: 503,
    });
    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('400 cover_empty_article when no base version exists', async () => {
    h.articleVersionFindFirst.mockResolvedValue(null);
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_empty_article',
      status: 400,
    });
    expect(h.callRouterAI).not.toHaveBeenCalled();
  });

  it('400 cover_empty_article when the base version has no usable text', async () => {
    h.articleVersionFindFirst.mockResolvedValue(makeVersion({ contentText: null, contentHtml: null }));
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_empty_article',
      status: 400,
    });
    expect(h.callRouterAI).not.toHaveBeenCalled();
  });
});

describe('cover-service: compression failure isolation (case 36)', () => {
  it('callRouterAI rejection → 502 cover_compression_failed, nothing downstream', async () => {
    h.callRouterAI.mockRejectedValue(new Error('network down'));

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_compression_failed',
      status: 502,
    });
    expect(h.generateImage).not.toHaveBeenCalled();
    expect(h.articleUpdate).not.toHaveBeenCalled();
    expect(h.agentRunCreate).not.toHaveBeenCalled();
  });

  it('empty compression output → 502 cover_compression_failed', async () => {
    h.callRouterAI.mockResolvedValue({
      status: 200,
      data: { choices: [{ message: { content: '   ' } }], usage: { cost: 0.01 } },
    });
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_compression_failed',
      status: 502,
    });
    expect(h.generateImage).not.toHaveBeenCalled();
    expect(h.agentRunCreate).not.toHaveBeenCalled();
  });

  it('non-200 compression status → 502 cover_compression_failed', async () => {
    h.callRouterAI.mockResolvedValue({ status: 500, data: {} });
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_compression_failed',
      status: 502,
    });
    expect(h.generateImage).not.toHaveBeenCalled();
  });
});

describe('cover-service: compression model resolution (case 39)', () => {
  it('uses the stored compressionModel override', async () => {
    h.coverSettingsFindFirst.mockResolvedValue(makeSettingsRow({ compressionModel: 'custom/compressor' }));
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.callRouterAI.mock.calls[0][0].model).toBe('custom/compressor');
  });

  it('falls back to env ROUTERAI_MODEL_STANDARD when no override', async () => {
    vi.stubEnv('ROUTERAI_MODEL_STANDARD', 'env/standard');
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.callRouterAI.mock.calls[0][0].model).toBe('env/standard');
  });

  it('falls back to deepseek/deepseek-v4-flash when neither is set', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.callRouterAI.mock.calls[0][0].model).toBe('deepseek/deepseek-v4-flash');
  });

  it('resolves the env model at read time — env changes between requests take effect', async () => {
    vi.stubEnv('ROUTERAI_MODEL_STANDARD', 'env/one');
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    vi.stubEnv('ROUTERAI_MODEL_STANDARD', 'env/two');
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.callRouterAI.mock.calls[0][0].model).toBe('env/one');
    expect(h.callRouterAI.mock.calls[1][0].model).toBe('env/two');
  });
});

describe('cover-service: compression call contract (case 40)', () => {
  it('passes { maxRetries: 1, timeoutMs: 60000 } as the call budget', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.callRouterAI.mock.calls[0][1]).toEqual({ maxRetries: 1, timeoutMs: 60_000 });
  });

  it('sends a non-streaming chat payload with COMPRESSION_PROMPT as system', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    const payload = h.callRouterAI.mock.calls[0][0];
    expect(payload.stream).toBe(false);
    expect(payload.messages[0]).toEqual({ role: 'system', content: COMPRESSION_PROMPT });
    expect(payload.messages[1].role).toBe('user');
    expect(payload.messages[1].content).toContain('Заголовок статьи: Чистка лица Ultrasound');
    expect(payload.messages[1].content).toContain('Текст статьи про ультразвуковую чистку лица.');
  });

  it('truncates the source text to 12000 characters', async () => {
    const longText = 'A'.repeat(14000) + 'TAILMARKER';
    h.articleVersionFindFirst.mockResolvedValue(makeVersion({ contentText: longText, contentHtml: null }));
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    const userContent = h.callRouterAI.mock.calls[0][0].messages[1].content;
    expect(userContent).not.toContain('TAILMARKER');
    expect(userContent).toContain('A'.repeat(12000 - 10));
  });

  it('falls back to htmlToPlainText when contentText is missing', async () => {
    h.articleVersionFindFirst.mockResolvedValue(
      makeVersion({ contentText: null, contentHtml: '<p>Только HTML содержимое</p>' }),
    );
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    const userContent = h.callRouterAI.mock.calls[0][0].messages[1].content;
    expect(userContent).toContain('Только HTML содержимое');
    expect(userContent).not.toContain('<p>');
  });
});

describe('cover-service: store contract and in-flight guard (case 43 pre-check)', () => {
  it('passes the effective settings to generateImage', async () => {
    h.coverSettingsFindFirst.mockResolvedValue(
      makeSettingsRow({ model: 'google/gemini-3.1-flash-image', aspectRatio: '4:5', resolution: '2K', quality: 'medium', outputFormat: 'jpeg' }),
    );
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google/gemini-3.1-flash-image',
        aspectRatio: '4:5',
        resolution: '2K',
        quality: 'medium',
        outputFormat: 'jpeg',
      }),
    );
    expect(existsSync(join(coversDir, `${ARTICLE_ID}-1.jpeg`))).toBe(true);
  });

  it('409 cover_in_progress on a concurrent call, released after success', async () => {
    let releaseImage;
    h.generateImage.mockImplementationOnce(
      () => new Promise((resolve) => { releaseImage = resolve; }),
    );

    const first = generateCoverForArticle({ articleId: ARTICLE_ID });
    await vi.waitFor(() => expect(h.generateImage).toHaveBeenCalledTimes(1));

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_in_progress',
      status: 409,
    });

    releaseImage({ buffer: IMAGE_BYTES, costRub: IMAGE_COST, raw: {} });
    await expect(first).resolves.toMatchObject({ coverFile: `${ARTICLE_ID}-1.png` });

    // Slot released → a follow-up call proceeds.
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).resolves.toBeTruthy();
  });

  it('releases the in-flight slot after a failure too', async () => {
    const { CoverImageError } = await import('../../server/lib/routerai-images.mjs');
    h.generateImage.mockRejectedValueOnce(new CoverImageError('cover_generation_failed', 'boom'));
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_generation_failed',
    });
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).resolves.toBeTruthy();
  });
});

describe('cover-service: CoverFlowError shape', () => {
  it('exposes code/status/message and is an Error', async () => {
    h.articleFindUnique.mockResolvedValue(null);
    try {
      await generateCoverForArticle({ articleId: ARTICLE_ID });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoverFlowError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('CoverFlowError');
      expect(err.code).toBe('cover_article_not_found');
      expect(err.status).toBe(404);
      expect(err.message).toBe('Статья не найдена.');
    }
  });
});
