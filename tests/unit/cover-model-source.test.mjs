/**
 * S5 T6 — cover_settings.model is THE applied cover model (single source).
 *
 * The cover tier pin in provider.models.cover is a transport field the cover
 * service never reads; the settings row is. These tests prove it at the
 * service-call level with the standard hoisted-mock harness (same pattern as
 * cover-service.test.mjs): NO live network, NO paid LLM calls.
 *
 *  - a stored settings model reaches generateImage AND Article.coverModel;
 *  - a diverging provider.models.cover pin does NOT win;
 *  - no settings row → honest defaults (configured:false), no crash;
 *  - enabled:false → the machine code cover_disabled, generateImage untouched.
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

const { generateCoverForArticle, CoverFlowError } = await import('../../server/lib/cover-service.mjs');
const { COVER_SETTINGS_DEFAULTS } = await import('../../server/lib/cover-settings.mjs');

const ARTICLE_ID = '44444444-4444-4444-8444-444444444444';
const IMAGE_BYTES = Buffer.from('fake-png-bytes');

let dataDir = '';

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

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'generaptor-cover-model-'));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(join(dataDir, 'covers'), { recursive: true, force: true });
  vi.stubEnv('GENERAPTOR_DATA_DIR', dataDir);
  vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');
  vi.stubEnv('ROUTERAI_MODEL_STANDARD', '');
  h.articleFindUnique.mockResolvedValue({
    id: ARTICLE_ID,
    topic: 'Чистка лица Ultrasound',
    status: 'ready',
    coverUrl: null,
    coverFile: null,
    coverModel: null,
    coverPrompt: null,
    coverCostRub: null,
    coverGeneratedAt: null,
  });
  h.articleVersionFindFirst.mockResolvedValue({
    id: 'ver-1',
    articleId: ARTICLE_ID,
    platform: 'base',
    title: 'Чистка лица',
    contentText: 'Текст статьи про ультразвуковую чистку лица.',
    contentHtml: '<p>Текст статьи.</p>',
    createdAt: new Date('2026-10-01T10:00:00Z'),
  });
  h.articleUpdate.mockResolvedValue({});
  h.agentRunCreate.mockResolvedValue({});
  h.agentRunFindMany.mockResolvedValue([]);
  h.coverSettingsFindFirst.mockResolvedValue(null);
  h.providerConfigFindMany.mockResolvedValue([]);
  h.callRouterAI.mockResolvedValue({
    status: 200,
    data: { choices: [{ message: { content: 'Краткий бриф.' } }], usage: { cost: 0.05 } },
  });
  h.generateImage.mockResolvedValue({
    buffer: IMAGE_BYTES,
    costRub: 4.82,
    raw: { data: [{ b64_json: '***' }] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cover-service: the settings row is the single cover-model source (S5 T6)', () => {
  it('a stored settings model reaches generateImage and Article.coverModel', async () => {
    h.coverSettingsFindFirst.mockResolvedValue(makeSettingsRow({ model: 'test/cover-model-x' }));
    const result = await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.generateImage).toHaveBeenCalledTimes(1);
    expect(h.generateImage.mock.calls[0][0].model).toBe('test/cover-model-x');
    expect(h.articleUpdate.mock.calls.at(-1)[0].data.coverModel).toBe('test/cover-model-x');
    expect(result.model).toBe('test/cover-model-x');
  });

  it('a diverging provider.models.cover pin does not win over the settings row', async () => {
    h.coverSettingsFindFirst.mockResolvedValue(makeSettingsRow({ model: 'test/cover-model-x' }));
    h.providerConfigFindMany.mockResolvedValue([
      {
        kind: 'routerai',
        enabled: true,
        baseUrl: null,
        apiKey: null,
        modelsJson: JSON.stringify({ cover: 'legacy/cover-model' }),
      },
    ]);
    await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.generateImage.mock.calls[0][0].model).toBe('test/cover-model-x');
    expect(h.articleUpdate.mock.calls.at(-1)[0].data.coverModel).toBe('test/cover-model-x');
  });

  it('no settings row → honest defaults (configured:false), no crash', async () => {
    h.coverSettingsFindFirst.mockResolvedValue(null);
    const result = await generateCoverForArticle({ articleId: ARTICLE_ID });
    expect(h.generateImage.mock.calls[0][0].model).toBe(COVER_SETTINGS_DEFAULTS.model);
    expect(result.model).toBe(COVER_SETTINGS_DEFAULTS.model);
  });

  it('enabled:false → cover_disabled machine code, generateImage untouched', async () => {
    h.coverSettingsFindFirst.mockResolvedValue(makeSettingsRow({ enabled: false }));
    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_disabled',
    });
    expect(h.generateImage).not.toHaveBeenCalled();
  });
});