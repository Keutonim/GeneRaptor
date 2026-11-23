// The evidence layer must persist on the REAL SQLite test database.
//
// The hole this file closes: the worker suites mock web-search to an EMPTY
// result, so the researchSource.createMany path never ran with data — and
// SQLite rejects the duplicate-skipping argument the worker used. The live
// generation logged «Web-search failed (non-blocking): Unknown argument …»
// and stored ZERO sources while the article still went ready.
//
// Here the search layer is mocked to a NON-EMPTY batch (no network, no keys),
// but Prisma is the REAL client against the per-run SQLite file provisioned
// by tests/global-setup.mjs (prisma db push from prisma/schema.prisma).
// The LLM is mocked exactly like tests/worker/article-generation.test.mjs.
//
// Contract:
//   - sources of the search batch ARE rows in research_source (batch dedup
//     by (normalizedUrl, provider) — the @@unique key of the schema);
//   - a second generation run with the same batch neither fails nor duplicates;
//   - a URL already stored for the article is excluded without a conflict;
//   - the persistence helper itself is idempotent, race-safe (P2002 fallback)
//     and keeps NULL-normalizedUrl rows non-conflicting.
import { vi, test, expect, beforeAll, afterAll, describe, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { canonicalSignature } from '../../server/lib/url-normalize.mjs';

// ── vi.hoisted: mock fns shared by the vi.mock factories and the tests ─────
const { callRouterAIMock, broadcastProgressMock, searchWebMock } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  searchWebMock: vi.fn(),
}));

// ── Mock agent-role-execution.mjs (same seam as article-generation.test) ───
vi.mock('../../server/agent-role-execution.mjs', async (importOriginal) => ({
  resolveEnvNumber: (await importOriginal()).resolveEnvNumber,
  buildSemanticCoreContext: (await importOriginal()).buildSemanticCoreContext,
  callRouterAI: callRouterAIMock,
  callRouterAIWithFallbackChain: async (payload, { chainInfo } = {}) => {
    const result = await callRouterAIMock(payload);
    if (chainInfo) chainInfo.model = payload.model;
    return result;
  },
  buildRoleExecutionPayload: (opts) => ({
    model: 'deepseek-v3.2',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: JSON.stringify({ roleId: opts?.roleId }) },
    ],
    temperature: 0.7,
    max_tokens: 2000,
  }),
  parseRoleExecutionResult: ({ roleId, response }) => {
    const content = response?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    return {
      roleId,
      content,
      parsed,
      structured: { hasContract: true, ok: true, data: parsed, summaryRu: 'summary' },
      structuredSummaryRu: 'summary',
      finishReason: 'stop',
      usage: response?.usage ?? null,
    };
  },
}));

vi.mock('../../server/websocket.mjs', () => ({
  broadcastProgress: broadcastProgressMock,
  createWebSocketServer: vi.fn(),
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn() },
  sourceCrawlQueue: { add: vi.fn() },
  publicationQueue: { add: vi.fn() },
  addJob: vi.fn(),
}));

// ── Web-search: a NON-EMPTY keyless batch, deterministic, zero network ─────
// Two raw URLs normalize to ONE signature (www + trailing slash) — the batch
// itself carries a duplicate the persistence path must collapse. The same
// batch is returned for every consensus page, so the expansion path re-saves
// already-known URLs on every round (idempotency through the real worker).
const SEARCH_RESULTS = [
  {
    url: 'https://example.com/implantaciya/',
    title: 'Имплантация зубов — обзор',
    snippet: 'Сниппет про имплантацию.',
  },
  {
    url: 'https://www.example.com/implantaciya',
    title: 'Имплантация зубов — обзор (www)',
    snippet: 'Тот же канонический URL.',
  },
  {
    url: 'https://other.ru/zubnye-implantaty',
    title: 'Зубные имплантаты',
    snippet: 'Второй независимый источник.',
  },
];

searchWebMock.mockImplementation(async () => ({
  results: SEARCH_RESULTS,
  backend: 'wikipedia',
  degraded: false,
  reason: null,
  lang: 'ru',
  limit: 5,
  attempts: [],
}));

vi.mock('../../server/lib/web-search/index.mjs', () => ({
  searchWeb: searchWebMock,
}));

// ── Real Prisma client → the per-run SQLite test DB (global-setup env) ─────
const prisma = new PrismaClient();

// ── Canned LLM outputs (same fixtures as the happy-path worker suite) ──────
const FAQ_SYSTEM_MARKER_RE = /SEO-копирайтер/iu;
const CANNED_FAQ_ITEMS = Array.from({ length: 10 }, (_, i) => ({
  question: `Неочевидный вопрос про имплантацию №${i + 1}?`,
  answer: `Краткий ответ ${i + 1}. Обоснование из двух предложений, чтобы блок выглядел реальным.`,
}));

callRouterAIMock.mockImplementation(async (payload) => {
  const systemMsg = payload?.messages?.find((m) => m.role === 'system')?.content || '';
  if (FAQ_SYSTEM_MARKER_RE.test(systemMsg)) {
    return {
      status: 200,
      data: {
        choices: [{ message: { content: JSON.stringify({ items: CANNED_FAQ_ITEMS }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
    };
  }
  const { roleOutputs } = await import('../fixtures/role-outputs.mjs');
  let roleId = null;
  try {
    const userMsg = payload?.messages?.find((m) => m.role === 'user');
    if (userMsg) roleId = JSON.parse(userMsg.content).roleId;
  } catch {
    // ignore parse errors
  }
  const output = roleOutputs[roleId] || { stub: true };
  return {
    status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    },
  };
});

// ── Import the worker AFTER the mocks are in place ─────────────────────────
const { processArticleGeneration } = await import('../../server/workers/article-generation.mjs');

let warnSpy;
let articleId;

/** A persistence-ready row batch (the shape the worker maps search into). */
function batchFor(id) {
  return [
    {
      articleId: id,
      provider: 'wikipedia',
      query: 'Имплантация зубов',
      sourceUrl: 'https://example.com/implantaciya/',
      normalizedUrl: canonicalSignature('https://example.com/implantaciya/'),
      title: 'Имплантация зубов — обзор',
      snippet: 'Сниппет про имплантацию.',
      extractedText: 'Сниппет про имплантацию.',
      evidenceLevel: 'medium',
    },
    {
      articleId: id,
      provider: 'wikipedia',
      query: 'Имплантация зубов',
      sourceUrl: 'https://other.ru/zubnye-implantaty',
      normalizedUrl: canonicalSignature('https://other.ru/zubnye-implantaty'),
      title: 'Зубные имплантаты',
      snippet: 'Второй независимый источник.',
      extractedText: 'Второй независимый источник.',
      evidenceLevel: 'medium',
    },
  ];
}

async function createArticle(topic = 'Имплантация зубов: гид') {
  const id = crypto.randomUUID();
  await prisma.article.create({ data: { id, topic, targetLength: 50000 } });
  return id;
}

function jobFor(id, suffix) {
  return { data: { articleId: id }, id: `test-job-${suffix}`, updateProgress: vi.fn() };
}

beforeAll(async () => {
  await prisma.$connect();
  // One consensus round is enough: the mock returns the same batch per page.
  process.env.CONSENSUS_MAX_ROUNDS = '1';
  await prisma.researchSource.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();
  await prisma.companyProfile.create({
    data: { name: 'Тестовая компания', activeText: 'Компания с 2010 года.' },
  });
});

afterAll(async () => {
  delete process.env.CONSENSUS_MAX_ROUNDS;
  await prisma.$disconnect();
});

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** No «Web-search failed (non-blocking)» line may appear in the worker log. */
function expectNoSearchFailure() {
  const failures = warnSpy.mock.calls
    .map((args) => String(args[0] ?? ''))
    .filter((line) => line.includes('Web-search failed'));
  expect(failures).toEqual([]);
}

describe('Evidence layer on the real SQLite DB (worker path)', () => {
  test('search batch is persisted: rows exist, batch duplicate collapsed', async () => {
    articleId = await createArticle();
    await processArticleGeneration(jobFor(articleId, 'persist-1'));

    const updated = await prisma.article.findUnique({ where: { id: articleId } });
    expect(updated.status).toBe('ready');

    const rows = await prisma.researchSource.findMany({ where: { articleId } });
    // 3 search results → 2 canonical URLs → exactly 2 rows.
    expect(rows.length).toBe(2);
    const signatures = rows.map((r) => r.normalizedUrl).sort();
    expect(signatures).toEqual(
      [
        canonicalSignature('https://example.com/implantaciya/'),
        canonicalSignature('https://other.ru/zubnye-implantaty'),
      ].sort()
    );
    expect(rows.every((r) => r.provider === 'wikipedia')).toBe(true);
    expect(rows.every((r) => r.snippet && r.snippet.length > 0)).toBe(true);
    expectNoSearchFailure();
  }, 30000);

  test('second run with the same batch: no failure, no duplicates', async () => {
    // The runner exits idempotently on a final status (W4.3) — requeue the
    // article the way POST /start does, so the research path runs again.
    await prisma.article.update({
      where: { id: articleId },
      data: { status: 'queued', needsReviewReason: null },
    });
    await processArticleGeneration(jobFor(articleId, 'persist-2'));

    const rows = await prisma.researchSource.findMany({ where: { articleId } });
    expect(rows.length).toBe(2);
    expectNoSearchFailure();
  }, 30000);

  test('a URL already stored for the article is excluded without a conflict', async () => {
    const id = await createArticle('Имплантация зубов: повторный источник');
    // Pre-existing row under the SAME unique key the batch will carry.
    await prisma.researchSource.create({
      data: {
        articleId: id,
        provider: 'wikipedia',
        query: 'Имплантация зубов',
        sourceUrl: 'https://example.com/implantaciya/',
        normalizedUrl: canonicalSignature('https://example.com/implantaciya/'),
        title: 'Сохранено раньше',
        snippet: 'Ранее сохранённый сниппет.',
        evidenceLevel: 'medium',
      },
    });

    await processArticleGeneration(jobFor(id, 'persist-3'));

    const rows = await prisma.researchSource.findMany({ where: { articleId: id } });
    expect(rows.length).toBe(2);
    const preExisting = rows.find((r) => r.title === 'Сохранено раньше');
    expect(preExisting).toBeTruthy(); // the old row is untouched, not duplicated
    expectNoSearchFailure();
  }, 30000);
});

describe('Persistence helper on the real SQLite DB', () => {
  // Imported lazily: before the fix the export does not exist and these
  // tests fail with «persistResearchSources is not a function» (RED).
  let persistResearchSources;
  beforeAll(async () => {
    ({ persistResearchSources } = await import('../../server/workers/article-generation.mjs'));
  });

  test('second call with the same batch inserts nothing', async () => {
    const id = await createArticle('Идемпотентность хелпера');
    const batch = batchFor(id);
    const first = await persistResearchSources(id, batch);
    expect(first).toBe(2);
    const second = await persistResearchSources(id, batch);
    expect(second).toBe(0);
    const rows = await prisma.researchSource.findMany({ where: { articleId: id } });
    expect(rows.length).toBe(2);
  });

  test('concurrent calls with the same batch: P2002 fallback, no duplicates', async () => {
    const id = await createArticle('Гонка двух вставок');
    const batch = batchFor(id);
    // Both callers pass the «already stored» check before either inserts:
    // one createMany wins, the other hits the unique constraint and must
    // fall back to per-row inserts without throwing.
    const results = await Promise.all([
      persistResearchSources(id, batch),
      persistResearchSources(id, batch),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(2);
    const rows = await prisma.researchSource.findMany({ where: { articleId: id } });
    expect(rows.length).toBe(2);
  });

  test('rows without a normalized URL never conflict (NULLs are distinct)', async () => {
    const id = await createArticle('Источники без URL');
    const nullRows = [
      {
        articleId: id,
        provider: 'consensus',
        query: 'q',
        sourceUrl: '',
        normalizedUrl: null,
        title: 'Синтетический факт 1',
        snippet: 's1',
        extractedText: 's1',
        evidenceLevel: 'high',
      },
      {
        articleId: id,
        provider: 'consensus',
        query: 'q',
        sourceUrl: '',
        normalizedUrl: null,
        title: 'Синтетический факт 2',
        snippet: 's2',
        extractedText: 's2',
        evidenceLevel: 'high',
      },
    ];
    await persistResearchSources(id, nullRows);
    await persistResearchSources(id, nullRows);
    const rows = await prisma.researchSource.findMany({ where: { articleId: id } });
    // NULL normalizedUrl never collides under the unique constraint —
    // both calls keep their rows (the pre-fix duplicate-skipping semantics).
    expect(rows.length).toBe(4);
  });
});

// ── Wrappers are unwrapped BEFORE dedup and persistence ────────────────────
// On the base candidate two goto wrappers collapse into ONE row whose
// normalizedUrl is «https://google.com/goto». The policy must store the two
// REAL targets as two distinct, meaningful rows instead. Synthetic fixture,
// zero network (the search layer is mocked above).
describe('Redirect wrappers are unwrapped before persistence', () => {
  test('two goto wrappers with different targets → two rows with meaningful normalizedUrl', async () => {
    const id = await createArticle('Имплантация зубов: развёртка обёрток');
    // The search layer is mocked at the module boundary, so the fixture is
    // passed through the REAL normalizeSearchResults — the exact normalization
    // the real searchWeb applies to every backend answer (index.mjs:330).
    // The worker therefore receives precisely what the live layer delivers.
    const { normalizeSearchResults } = await import('../../server/lib/web-search/http.mjs');
    const rawBatch = [
      {
        url: 'https://www.google.com/goto?url=https%3A%2F%2Fexample.com%2Fimplant-one',
        title: 'Источник один',
        snippet: 'Сниппет первого источника.',
      },
      {
        url: 'https://www.google.com/goto?url=https%3A%2F%2Fother.ru%2Fimplant-two',
        title: 'Источник два',
        snippet: 'Сниппет второго источника.',
      },
    ];
    searchWebMock.mockImplementationOnce(async () => ({
      results: normalizeSearchResults(rawBatch, 5, 'serper'),
      backend: 'serper',
      degraded: false,
      reason: null,
      lang: 'ru',
      limit: 5,
      attempts: [],
    }));

    await processArticleGeneration(jobFor(id, 'persist-unwrap-1'));

    const rows = await prisma.researchSource.findMany({
      where: { articleId: id, provider: 'serper' },
    });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.normalizedUrl).sort()).toEqual(
      [
        canonicalSignature('https://example.com/implant-one'),
        canonicalSignature('https://other.ru/implant-two'),
      ].sort(),
    );
    for (const row of rows) {
      expect(row.normalizedUrl).not.toContain('google.com/goto');
      expect(row.sourceUrl).not.toContain('google.com/goto');
    }
    expectNoSearchFailure();
  }, 30000);
});