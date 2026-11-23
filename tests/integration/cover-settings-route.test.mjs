// Runs on SQLite with the in-process runner (no external services).
/**
 * Integration tests: cover settings API (plan-photo §2.2/§2.3/§5.2, cases 47-51).
 *
 * GET /api/settings/cover → 200 defaults + configured:false (NEVER 404)
 * PUT /api/settings/cover → subset merge, unknown-key rejection, validation
 *
 * Rides the real generaptor_test Postgres through createTestApp (helpers.mjs);
 * cover_settings rows are wiped by truncateAll between cases. No RouterAI /
 * WP calls — settings only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn() },
  sourceCrawlQueue: { add: vi.fn() },
  publicationQueue: { add: vi.fn() },
  autoGenerationQueue: { add: vi.fn(), removeRepeatable: vi.fn() },
  addJob: vi.fn(),
}));

import { createTestApp, startServer, testPrisma, truncateAll, seedFixture } from '../helpers.mjs';

let server;
let baseUrl;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  await seedFixture();
});

async function call(method, path, { body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

const BASE = '/api/settings/cover';

describe('GET /api/settings/cover (case 47)', () => {
  it('empty DB → 200 defaults + configured:false (never 404)', async () => {
    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      configured: false,
      enabled: true,
      model: 'qwen/qwen-image-2.1-pro',
      promptTemplate: expect.any(String),
      aspectRatio: '16:9',
      resolution: '1K',
      quality: 'high',
      outputFormat: 'png',
      autoGenerate: false,
      monthlyCapRub: 300,
      compressionModelSource: 'env',
    });
    // The env tier resolves even with no row.
    expect(typeof body.data.compressionModel).toBe('string');
    expect(body.data.compressionModel.length).toBeGreaterThan(0);
    // The default template carries no literal tokens (buildCoverPrompt
    // appends the brief section when the token is absent) — pin a real
    // fragment. M5 (D1/P2): the template is brand-neutral, so the brand
    // constants must be ABSENT.
    expect(body.data.promptTemplate).toContain('Создай обложку-баннер для статьи.');
    for (const fragment of ['славянск', 'Montserrat', '#ed1c24', '#c3ab7a', '8px']) {
      expect(body.data.promptTemplate).not.toContain(fragment);
    }
  });
});

describe('PUT /api/settings/cover (cases 48-51)', () => {
  it('48. valid subset → 200 persisted; GET after → configured:true', async () => {
    const put = await call('PUT', BASE, { body: { monthlyCapRub: 150, quality: 'medium' } });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
    expect(put.body.data).toMatchObject({
      configured: true,
      monthlyCapRub: 150,
      quality: 'medium',
    });

    const get = await call('GET', BASE);
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({ configured: true, monthlyCapRub: 150, quality: 'medium' });
    // Untouched fields keep the defaults (subset merge).
    expect(get.body.data.model).toBe('qwen/qwen-image-2.1-pro');
    expect(get.body.data.aspectRatio).toBe('16:9');

    const rows = await testPrisma.coverSettings.findMany();
    expect(rows).toHaveLength(1);
  });

  it('49. unknown key → 400 cover_settings_unknown_field, nothing persisted', async () => {
    const { status, body } = await call('PUT', BASE, { body: { monthlyCapRub: 100, bogus: 1 } });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('cover_settings_unknown_field');
    expect(typeof body.error).toBe('string');

    const rows = await testPrisma.coverSettings.findMany();
    expect(rows).toHaveLength(0);
  });

  it('49b. invalid value → 400 validation code, nothing persisted (cap < 0)', async () => {
    const { status, body } = await call('PUT', BASE, { body: { monthlyCapRub: -5 } });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('cover_settings_invalid_cap');

    const rows = await testPrisma.coverSettings.findMany();
    expect(rows).toHaveLength(0);
  });

  it('50. multiline promptTemplate round-trips byte-identically', async () => {
    const template = [
      'Ты — дизайнер обложек косметологической компании.',
      '',
      '{articleBrief}',
      '',
      'Дополнительные указания: {refinement}',
      'Заголовок: {title}',
    ].join('\n\n');

    const put = await call('PUT', BASE, { body: { promptTemplate: template } });
    expect(put.status).toBe(200);
    expect(put.body.data.promptTemplate).toBe(template);

    const get = await call('GET', BASE);
    expect(get.status).toBe(200);
    expect(get.body.data.promptTemplate).toBe(template);

    const row = await testPrisma.coverSettings.findFirst();
    expect(row.promptTemplate).toBe(template);
  });

  it('51. compressionModel:"" → stored null; GET reports source env + resolved from ROUTERAI_MODEL_STANDARD', async () => {
    vi.stubEnv('ROUTERAI_MODEL_STANDARD', 'test-standard-model');

    const put = await call('PUT', BASE, { body: { compressionModel: '' } });
    expect(put.status).toBe(200);
    expect(put.body.data.compressionModel).toBe('test-standard-model');
    expect(put.body.data.compressionModelSource).toBe('env');

    const get = await call('GET', BASE);
    expect(get.status).toBe(200);
    expect(get.body.data.compressionModel).toBe('test-standard-model');
    expect(get.body.data.compressionModelSource).toBe('env');

    const row = await testPrisma.coverSettings.findFirst();
    expect(row.compressionModel).toBeNull();

    vi.unstubAllEnvs();
  });

  it('51b. explicit compressionModel override → source override on GET', async () => {
    const put = await call('PUT', BASE, { body: { compressionModel: 'openai/gpt-5-mini' } });
    expect(put.status).toBe(200);
    expect(put.body.data.compressionModel).toBe('openai/gpt-5-mini');
    expect(put.body.data.compressionModelSource).toBe('override');
  });
});

// ── Cover checkbox wave (design-cover-checkbox §7.6) ─────────────────────────
// The ArticleForm checkbox needs the «интеграции готовы» signal the GET never
// carried: available / unavailableReason use the SAME formula as /content
// (settings.enabled && the active provider can generate images — M5/D9,
// WordPress is NOT part of the cover flow anymore),
// estimatedCoverCostRub feeds the «+~5 ₽» hint, spentThisMonthRub the P2
// budget line. Additive: existing fields unchanged.
describe('GET /api/settings/cover — available/estimated/spend (docs/ui-design.md §9)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('52. no provider at all → available:false + cover_not_configured; estimated 4.82; spent 0', async () => {
    // No env key and no provider row → nothing can generate images.
    vi.stubEnv('ROUTERAI_API_KEY', '');

    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      available: false,
      unavailableReason: 'cover_not_configured',
      estimatedCoverCostRub: 4.82,
      spentThisMonthRub: 0,
    });
    expect(typeof body.data.spentThisMonthRub).toBe('number');
  });

  it('52b. an images-INcapable provider → available:false + cover_provider_images_unsupported', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', '');
    await testPrisma.providerConfig.create({
      data: { kind: 'ollama', baseUrl: 'http://localhost:11434', enabled: true },
    });

    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.data.available).toBe(false);
    expect(body.data.unavailableReason).toBe('cover_provider_images_unsupported');
  });

  it('53. an images-capable provider → available:true + unavailableReason:null', async () => {
    // The vitest env carries ROUTERAI_API_KEY → the routerai env fallback is
    // the images-capable provider. WordPress is irrelevant for covers.
    vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');

    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.data.available).toBe(true);
    expect(body.data.unavailableReason).toBeNull();
  });

  it('54. enabled:false wins over integrations → cover_disabled', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', 'test-key-not-real');
    await call('PUT', BASE, { body: { enabled: false } });

    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.data.enabled).toBe(false);
    expect(body.data.available).toBe(false);
    expect(body.data.unavailableReason).toBe('cover_disabled');
  });

  it('55. unknown-price model → estimatedCoverCostRub:null (hint degrades to «Цена зависит от модели»)', async () => {
    await call('PUT', BASE, { body: { model: 'google/gemini-nano-banana-2.1' } });

    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.data.model).toBe('google/gemini-nano-banana-2.1');
    expect(body.data.estimatedCoverCostRub).toBeNull();
  });

  it('56. spentThisMonthRub sums the cover ledger for the current month', async () => {
    const article = await testPrisma.article.create({
      data: { topic: 'spend-probe', targetLength: 2000 },
    });
    await testPrisma.agentRun.create({
      data: {
        articleId: article.id,
        agentName: 'Генерация обложки',
        status: 'success',
        costRub: 4.82,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.data.spentThisMonthRub).toBeCloseTo(4.82, 2);
  });

  // Design §3.3: при quality:auto цена заранее неизвестна даже для модели с
  // Published-прайсом → чекбокс-подсказка деградирует в «Цена зависит от модели».
  it('57. quality:auto → estimatedCoverCostRub:null even for the flat-priced model; quality:high keeps 4.82', async () => {
    await call('PUT', BASE, { body: { quality: 'auto' } });
    let res = await call('GET', BASE);
    expect(res.body.data.quality).toBe('auto');
    expect(res.body.data.estimatedCoverCostRub).toBeNull();

    await call('PUT', BASE, { body: { quality: 'high' } });
    res = await call('GET', BASE);
    expect(res.body.data.quality).toBe('high');
    expect(res.body.data.estimatedCoverCostRub).toBeCloseTo(4.82, 10);
  });
});
