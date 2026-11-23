/**
 * Cover service without WordPress.
 *
 * The cover flow must work with ZERO WordPress env vars: the binary is
 * stored as a file under <data-dir>/covers/ and the DB keeps the file
 * reference — never a WordPress URL.
 *
 * Real code under test: cover-service + cover-store + cover-settings +
 * cover-pricing + cover-prompt. Mocked: db / callRouterAI / routerai-images.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync as readTextFile } from 'node:fs';

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

const { generateCoverForArticle } = await import('../../server/lib/cover-service.mjs');
const { COVERS_DIR_NAME } = await import('../../server/lib/cover-store.mjs');

const ARTICLE_ID = '33333333-3333-4333-8333-333333333333';
const IMAGE_BYTES = Buffer.from('fake-png-bytes');
const IMAGE_COST = 4.82;
const BRIEF = 'Краткий бриф: чистка лица, показания, цена.';

let dataDir;

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), 'gr-cover-local-'));
  vi.stubEnv('GENERAPTOR_DATA_DIR', dataDir);
  vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');

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
    contentText: 'Текст статьи про ультразвуковую чистку лица.',
    contentHtml: '<p>Текст статьи.</p>',
    createdAt: new Date('2026-10-01T10:00:00Z'),
  });
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
    buffer: IMAGE_BYTES,
    costRub: IMAGE_COST,
    raw: { data: [{ b64_json: '***' }] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cover service: no WordPress anywhere', () => {
  it('generates a cover with ZERO WordPress env vars', async () => {
    const result = await generateCoverForArticle({ articleId: ARTICLE_ID });

    expect(result.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
    expect(h.articleUpdate).toHaveBeenCalledTimes(1);
  });

  it('stores the binary as a file under <data-dir>/covers/', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });

    const coversDir = join(dataDir, COVERS_DIR_NAME);
    const entries = readdirSync(coversDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(`${ARTICLE_ID}-1.png`);
    expect(readFileSync(join(coversDir, entries[0])).equals(IMAGE_BYTES)).toBe(true);
  });

  it('stores the file reference in the DB, never a WordPress URL', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });

    const [updateArg] = h.articleUpdate.mock.calls[0];
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
    expect(updateArg.data.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
    expect(updateArg.data.coverFile).toBe(`${ARTICLE_ID}-1.png`);
    expect(updateArg.data.coverUrl).not.toContain('http');
    expect(updateArg.data).not.toHaveProperty('status');
  });

  it('records the stored file in the ledger row', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });

    const [ledgerArg] = h.agentRunCreate.mock.calls[0];
    const output = JSON.parse(ledgerArg.data.outputJson);
    expect(output.coverFile).toBe(`${ARTICLE_ID}-1.png`);
    expect(output.coverUrl).toBe(`/api/articles/${ARTICLE_ID}/cover`);
    expect(output.bytes).toBe(IMAGE_BYTES.length);
  });

  it('has no dangling relative imports (source-level unhook proof)', async () => {
    const sourceUrl = new URL('../../server/lib/cover-service.mjs', import.meta.url);
    const source = readTextFile(sourceUrl, 'utf8');
    const specifiers = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const target = new URL(specifier, sourceUrl);
      expect(existsSync(fileURLToPath(target))).toBe(true);
    }
  });
});

describe('D4: refine vs fresh semantics', () => {
  /** The composed prompt that reached the image provider. */
  function composedPrompt() {
    return h.generateImage.mock.calls[0][0].prompt;
  }

  it('generates without a refinement when the body carries none (fresh)', async () => {
    await generateCoverForArticle({ articleId: ARTICLE_ID });

    expect(h.generateImage).toHaveBeenCalledTimes(1);
    expect(composedPrompt()).not.toContain('Дополнительные указания');
    expect(h.agentRunCreate.mock.calls[0][0].data.inputJson).not.toContain('refinement');
  });

  it('passes a refinement into the prompt (regenerate-with-refinement)', async () => {
    await generateCoverForArticle({
      articleId: ARTICLE_ID,
      refinement: 'Сделай фон светлым',
    });

    expect(composedPrompt()).toContain('Сделай фон светлым');
    expect(JSON.parse(h.agentRunCreate.mock.calls[0][0].data.inputJson).refinement).toBe(
      'Сделай фон светлым',
    );
  });

  it('ignores the refinement when fresh:true is set (fresh wins)', async () => {
    await generateCoverForArticle({
      articleId: ARTICLE_ID,
      refinement: 'Сделай фон светлым',
      fresh: true,
    });

    expect(composedPrompt()).not.toContain('Сделай фон светлым');
    expect(JSON.parse(h.agentRunCreate.mock.calls[0][0].data.inputJson).refinement).toBeUndefined();
  });

  it('rejects a refinement that is not a string', async () => {
    await expect(
      generateCoverForArticle({ articleId: ARTICLE_ID, refinement: 42 }),
    ).rejects.toMatchObject({ code: 'cover_invalid_refinement', status: 400 });

    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('rejects a refinement longer than 500 characters', async () => {
    await expect(
      generateCoverForArticle({ articleId: ARTICLE_ID, refinement: 'я'.repeat(501) }),
    ).rejects.toMatchObject({ code: 'cover_invalid_refinement', status: 400 });

    expect(h.generateImage).not.toHaveBeenCalled();
  });
});
