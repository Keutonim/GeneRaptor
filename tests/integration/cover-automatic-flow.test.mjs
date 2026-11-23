/**
 * Dev-11 (D3) — the AUTOMATIC cover path on the REAL server + the REAL DB.
 *
 * The defect: server/lib/cover-service.mjs:138 selected the
 * field `serviceId` — removed from the Article model with the WordPress
 * unhook (M5). Prisma validates a `select` against the LIVE schema and
 * throws:
 *
 *   PrismaClientValidationError: Invalid `prisma.article.findUnique()` invocation
 *   ... select: { id: true, coverRequested: true, coverUrl: true, serviceId: true }
 *
 * The throw happens BEFORE the flow starts (the first read of the hook), so
 * the automatic cover — generated as part of the article completion, with no
 * manual request — never produced a cover at all.
 *
 * Why a REAL database here: the unit suites mock `server/db.mjs`, and a mock
 * cannot know which fields the schema has. Only the real Prisma client
 * validates the select against prisma/schema.prisma — so only a real-DB test
 * can see this class of defect.
 *
 * Covered prisma accesses of server/lib/cover-service.mjs:
 *   1. article.findUnique (the hook's select)      → case 1 + case 2
 *   2. article.update (the phase channel writes)    → case 1 + case 2
 *   3. article.findUnique (no select, the flow)     → case 1
 *   4. articleVersion.findFirst (the content guard) → case 1
 *   5. article.update (the six cover* columns)      → case 1
 *   6. agentRun.create (the success ledger row)     → case 1
 *   7. agentRun.create (the failure ledger row)     → case 3
 *   8. agentRun.findMany (the budget gate)          → case 1
 *
 * Only the two network edges are mocked (the LLM compression call and the
 * image call) — the cover service, the cover store and prisma run for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

import { maybeGenerateCover } from '../../server/lib/cover-service.mjs';
import { testPrisma, truncateAll } from '../helpers.mjs';

/** PNG magic bytes — the store keeps the bytes verbatim. */
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const BRIEF = 'Краткий бриф: чистка лица, показания, цена.';
const IMAGE_COST = 4.82;

let dataDir;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gr-cover-auto-'));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll();
  vi.stubEnv('GENERAPTOR_DATA_DIR', dataDir);
  vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');
  vi.clearAllMocks();
  h.callRouterAI.mockResolvedValue({
    status: 200,
    data: { choices: [{ message: { content: BRIEF } }], usage: { cost: 0.05 } },
  });
  h.generateImage.mockResolvedValue({
    buffer: PNG_BYTES,
    costRub: IMAGE_COST,
    raw: { data: [{ b64_json: '***' }] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The settings row that turns the automatic path on. */
async function seedAutoCoverSettings() {
  return testPrisma.coverSettings.create({
    data: {
      enabled: true,
      autoGenerate: true,
      promptTemplate: 'Обложка к статье: {brief}',
    },
  });
}

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

describe('the automatic cover path (D3)', () => {
  it('autoGenerate=true → the article ends up with a cover file and coverStatus ready', async () => {
    await seedAutoCoverSettings();
    const article = await seedArticle();

    await maybeGenerateCover(article.id);

    // The image was generated through the (mocked) provider.
    expect(h.generateImage).toHaveBeenCalledTimes(1);

    // The DB row carries the file reference and the ready channel.
    const row = await testPrisma.article.findUnique({ where: { id: article.id } });
    expect(row.coverFile).toBe(`${article.id}-1.png`);
    expect(row.coverStatus).toBe('ready');
    expect(row.coverSkipReason).toBeNull();
    expect(row.coverRequested).toBe(false);
    // The legacy coverUrl still points at the binary route.
    expect(row.coverUrl).toBe(`/api/articles/${article.id}/cover`);

    // The binary really landed in the local cover store.
    expect(existsSync(join(dataDir, 'covers', `${article.id}-1.png`))).toBe(true);

    // The ledger row exists (the money was spent).
    const runs = await testPrisma.agentRun.findMany({ where: { articleId: article.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
  });

  it('coverRequested=true (the checkbox on the main page) → the same cover', async () => {
    // autoGenerate is OFF here — the per-article request alone must trigger it.
    await testPrisma.coverSettings.create({
      data: { enabled: true, autoGenerate: false, promptTemplate: 'Обложка к статье: {brief}' },
    });
    const article = await seedArticle({ coverRequested: true });

    await maybeGenerateCover(article.id);

    expect(h.generateImage).toHaveBeenCalledTimes(1);
    const row = await testPrisma.article.findUnique({ where: { id: article.id } });
    expect(row.coverFile).toBe(`${article.id}-1.png`);
    expect(row.coverStatus).toBe('ready');
    expect(row.coverRequested).toBe(false);
    expect(existsSync(join(dataDir, 'covers', `${article.id}-1.png`))).toBe(true);
  });

  it('a failed image call still writes the ledger row and marks the article failed', async () => {
    // The failure path (recordFailedRun → agentRun.create) must stay in sync
    // with the schema too — it is the other agentRun write of the service.
    await seedAutoCoverSettings();
    const article = await seedArticle();
    h.generateImage.mockRejectedValue(new Error('routerai 500'));

    await maybeGenerateCover(article.id);

    const row = await testPrisma.article.findUnique({ where: { id: article.id } });
    expect(row.coverStatus).toBe('failed');
    expect(row.coverSkipReason).toBe('cover_generation_failed');
    expect(row.coverFile).toBeNull();

    const runs = await testPrisma.agentRun.findMany({ where: { articleId: article.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
  });
});
