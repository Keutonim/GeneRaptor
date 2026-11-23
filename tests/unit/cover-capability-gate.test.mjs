/**
 * M5 — D9 capability gate for covers.
 *
 * Only images-capable providers may produce covers. A provider that cannot
 * generate images must surface a MACHINE-READABLE code (not a generic 500),
 * so the UI can say «Обложки недоступны: активный провайдер не поддерживает
 * изображения» (docs/ui-design.md §9).
 *
 * The gate consumes the M3 provider layer as-is (providers.mjs is off-limits
 * for this milestone) — only the consumer side is under test here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  callRouterAI: vi.fn(),
  generateImage: vi.fn(),
  resolveCoverProvider: vi.fn(),
  resolveActiveProvider: vi.fn(),
}));

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    article: { findUnique: h.articleFindUnique, update: h.articleUpdate },
    articleVersion: { findFirst: h.articleVersionFindFirst },
    agentRun: { create: h.agentRunCreate, findMany: h.agentRunFindMany },
    coverSettings: { findFirst: h.coverSettingsFindFirst },
    providerConfig: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../../server/agent-role-execution.mjs', () => ({ callRouterAI: h.callRouterAI }));

vi.mock('../../server/lib/routerai-images.mjs', () => ({
  CoverImageError: class CoverImageError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  },
  generateImage: h.generateImage,
}));

vi.mock('../../server/lib/providers.mjs', () => ({
  resolveCoverProvider: h.resolveCoverProvider,
  resolveActiveProvider: h.resolveActiveProvider,
}));

const { generateCoverForArticle } = await import('../../server/lib/cover-service.mjs');

const ARTICLE_ID = '33333333-3333-4333-8333-333333333333';

let dataDir;

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), 'gr-cover-gate-'));
  vi.stubEnv('GENERAPTOR_DATA_DIR', dataDir);
  h.articleFindUnique.mockResolvedValue({
    id: ARTICLE_ID,
    topic: 'Чистка лица Ultrasound',
    status: 'ready',
    coverUrl: null,
    coverFile: null,
  });
  h.articleVersionFindFirst.mockResolvedValue({
    id: 'ver-1',
    articleId: ARTICLE_ID,
    platform: 'base',
    contentText: 'Текст статьи.',
    contentHtml: '<p>Текст статьи.</p>',
  });
  h.articleUpdate.mockResolvedValue({});
  h.agentRunCreate.mockResolvedValue({});
  h.agentRunFindMany.mockResolvedValue([]);
  h.coverSettingsFindFirst.mockResolvedValue(null);
  h.callRouterAI.mockResolvedValue({
    status: 200,
    data: { choices: [{ message: { content: 'Краткий бриф.' } }], usage: { cost: 0.05 } },
  });
  h.generateImage.mockResolvedValue({ buffer: Buffer.from('img'), costRub: 4.82, raw: {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('D9: capability gate', () => {
  it('refuses an images-incapable provider with a machine code (not a generic 500)', async () => {
    h.resolveCoverProvider.mockResolvedValue({
      ok: false,
      code: 'cover_provider_images_unsupported',
    });
    h.resolveActiveProvider.mockResolvedValue({
      kind: 'ollama',
      label: 'Ollama',
      imagesCapability: 'no',
      enabled: true,
    });

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_provider_images_unsupported',
      status: 503,
    });

    expect(h.generateImage).not.toHaveBeenCalled();
    expect(h.articleUpdate).not.toHaveBeenCalled();
  });

  it('reports "not configured" when no provider at all is configured', async () => {
    h.resolveCoverProvider.mockResolvedValue({
      ok: false,
      code: 'cover_provider_images_unsupported',
    });
    h.resolveActiveProvider.mockResolvedValue(null);

    await expect(generateCoverForArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'cover_not_configured',
      status: 503,
    });

    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('uses the endpoint and the key of the images-capable provider', async () => {
    h.resolveCoverProvider.mockResolvedValue({
      ok: true,
      kind: 'routerai',
      label: 'RouterAI',
      baseUrl: 'https://provider.example/api/v1',
      apiKey: 'provider-key',
      coverModel: null,
    });
    h.resolveActiveProvider.mockResolvedValue({
      kind: 'routerai',
      label: 'RouterAI',
      imagesCapability: 'yes',
      enabled: true,
    });

    await generateCoverForArticle({ articleId: ARTICLE_ID });

    expect(h.generateImage).toHaveBeenCalledTimes(1);
    const [args] = h.generateImage.mock.calls[0];
    expect(args.baseUrl).toBe('https://provider.example/api/v1');
    expect(args.apiKey).toBe('provider-key');
    expect(args.model).toBe('qwen/qwen-image-2.1-pro');
  });
});
