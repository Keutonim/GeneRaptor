// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker tests: cover checkbox wave — the post-finalize cover hook.
 *
 * finalizeCompleted (server/workers/article-generation.mjs) fires
 * maybeGenerateCover(articleId) as a NON-BLOCKING async task AFTER the article
 * reached its terminal status (Director resolution Q3: fire-and-forget with
 * .catch logging; the worker slot is freed immediately). finalizeWithFallback
 * reaches the same hook through finalizeCompleted. finalizeWallClockExhausted
 * never launches the flow — it consumes a pending request as
 * skipped/cover_empty_article (the text is not finished; a cover builds on it).
 *
 * The cover-service module is MOCKED here (the hook's own decision table is
 * unit-tested in tests/unit/cover-maybe-generate.test.mjs); everything else
 * mirrors the other worker suites: the real SQLite test database,
 * agent-role-execution/websocket/queue/search providers mocked.
 */
import { vi, test, expect, beforeAll, afterAll, describe, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// --- Mocks --------------------------------------------------------------------

const { callRouterAIMock, broadcastProgressMock, scenarioState, fakeWorkers, maybeGenerateCoverMock } =
  vi.hoisted(() => ({
    callRouterAIMock: vi.fn(),
    broadcastProgressMock: vi.fn(),
    scenarioState: { scenario: 'happy', useLargeContent: false },
    fakeWorkers: [],
    maybeGenerateCoverMock: vi.fn(),
  }));

vi.mock('../../server/lib/cover-service.mjs', () => ({
  maybeGenerateCover: maybeGenerateCoverMock,
  generateCoverForArticle: vi.fn(),
  CoverFlowError: class CoverFlowError extends Error {
    constructor(code) {
      super(code);
      this.name = 'CoverFlowError';
      this.code = code;
    }
  },
}));

vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWorker extends EventEmitter {
    constructor(queueName, processor, opts) {
      super();
      this.queueName = queueName;
      this.processor = processor;
      this.opts = opts;
      fakeWorkers.push(this);
    }
    async close() { return undefined; }
  }
  class UnrecoverableError extends Error {
    constructor(message) { super(message); this.name = 'UnrecoverableError'; }
  }
  return { Worker: FakeWorker, UnrecoverableError };
});

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
  autoGenerationQueue: { add: vi.fn(), removeRepeatable: vi.fn() },
  addJob: vi.fn(),
}));

// ── Web-search слой → мгновенный пустой результат ─────────────────────────
// Тесты чувствительны ко времени: реальный research-этап со сетевыми
// таймаутами съедал бы бюджет до старта первой роли. Мок даёт детерминированный
// research ≈ 0мс и НИКОГДА не ходит в сеть.
vi.mock('../../server/lib/web-search/index.mjs', () => ({
  // M2 (SQLite revive): the mocked pipeline outruns the 1s wall-clock floor
  // (getGenerationWallClockMs clamps >=1000ms). Wall-clock cases set the env
  // BEFORE the run — burn 1.1s in the research phase so the between-roles
  // budget check deterministically fires on the first role.
  searchWeb: vi.fn(async () => {
    if (process.env.GENERATION_WALL_CLOCK_MS === '1') {
      await new Promise((r) => setTimeout(r, 1100));
    }
    return {
      results: [],
      backend: 'duckduckgo',
      degraded: true,
      reason: 'network_unavailable',
      lang: 'ru',
      limit: 5,
      attempts: [],
    };
  }),
}));

const prisma = new PrismaClient();

const FAQ_SYSTEM_MARKER_RE = /SEO-копирайтер/iu;
const CANNED_FAQ_ITEMS = Array.from({ length: 10 }, (_, i) => ({
  question: `Неочевидный вопрос №${i + 1}?`,
  answer: `Краткий ответ ${i + 1} с обоснованием из двух предложений.`,
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
    roleId = JSON.parse(userMsg.content).roleId;
  } catch {
    // ignore
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

const { processArticleGeneration } = await import('../../server/workers/article-generation.mjs');


beforeAll(async () => {
  await prisma.$connect();
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  await prisma.companyProfile.create({ data: { name: 'Обложка компания', activeText: 'Профиль.' } });

});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  scenarioState.scenario = 'happy';
  scenarioState.useLargeContent = false;
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
  maybeGenerateCoverMock.mockReset();
  maybeGenerateCoverMock.mockResolvedValue(undefined);
  delete process.env.GENERATION_WALL_CLOCK_MS;
  delete process.env.GENERATION_MAX_ATTEMPTS;
  delete process.env.POSTCHECK_MODE;
});

afterEach(async () => {
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
});

async function createArticle({ coverRequested = true, targetLength = 2000 } = {}) {
  const id = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id,
      topic: 'Имплантация зубов: обложка ' + id.slice(0, 8),
      targetLength,
      coverRequested,
    },
  });
  return id;
}

function makeJob(articleId) {
  return {
    data: { articleId },
    id: 'job-cover-' + Math.random().toString(36).slice(2),
    updateProgress: vi.fn(),
  };
}

const getArticle = (articleId) => prisma.article.findUnique({ where: { id: articleId } });

describe('finalizeCompleted → non-blocking cover hook (Director Q3)', () => {
  test('1. happy path: the hook fires exactly once with the articleId; article finalizes ready', async () => {
    delete process.env.POSTCHECK_MODE;
    const articleId = await createArticle({ coverRequested: true });

    await processArticleGeneration(makeJob(articleId));

    const article = await getArticle(articleId);
    expect(article.status).toBe('ready');
    expect(maybeGenerateCoverMock).toHaveBeenCalledTimes(1);
    expect(maybeGenerateCoverMock).toHaveBeenCalledWith(articleId);
  }, 60000);

  test('2. NON-BLOCKING: a hook that never settles does not delay the finalization', async () => {
    delete process.env.POSTCHECK_MODE;
    maybeGenerateCoverMock.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const articleId = await createArticle({ coverRequested: true });

    await processArticleGeneration(makeJob(articleId));

    // The article is already terminal while the cover phase is still "running".
    const article = await getArticle(articleId);
    expect(article.status).toBe('ready');
    expect(maybeGenerateCoverMock).toHaveBeenCalledTimes(1);
  }, 60000);

  test('3. a REJECTED hook promise is caught (no unhandled rejection, finalization intact)', async () => {
    delete process.env.POSTCHECK_MODE;
    maybeGenerateCoverMock.mockRejectedValue(new Error('hook exploded'));
    const articleId = await createArticle({ coverRequested: true });

    await processArticleGeneration(makeJob(articleId));

    const article = await getArticle(articleId);
    expect(article.status).toBe('ready');
  }, 60000);

  test('4. the hook fires for EVERY finalize (condition lives inside the hook, not the worker)', async () => {
    delete process.env.POSTCHECK_MODE;
    const articleId = await createArticle({ coverRequested: false });

    await processArticleGeneration(makeJob(articleId));

    expect(maybeGenerateCoverMock).toHaveBeenCalledTimes(1);
    expect(maybeGenerateCoverMock).toHaveBeenCalledWith(articleId);
  }, 60000);
});

describe('finalizeWallClockExhausted → pending request consumed as skipped (docs/ui-design.md)', () => {
  test('5. wall-clock exhausted with no content + pending request → failed article, cover skipped/cover_empty_article, flag consumed, hook NOT called', async () => {
    process.env.GENERATION_WALL_CLOCK_MS = '1';
    process.env.GENERATION_MAX_ATTEMPTS = '1';
    const articleId = await createArticle({ coverRequested: true });

    // The no-content wall-clock branch REJECTS with UnrecoverableError after
    // it finalized the article (status='failed' + cover columns consumed) —
    // the established contract (wall-clock-idempotency.test.mjs:347).
    await expect(processArticleGeneration(makeJob(articleId))).rejects.toThrow(/бюджет времени/i);

    const article = await getArticle(articleId);
    expect(article.status).toBe('failed'); // no content → the wall-clock fail branch
    expect(maybeGenerateCoverMock).not.toHaveBeenCalled();
    expect(article.coverStatus).toBe('skipped');
    expect(article.coverSkipReason).toBe('cover_empty_article');
    expect(article.coverRequested).toBe(false);
  }, 60000);

  test('6. wall-clock exhausted with no content + NO pending request → cover columns untouched', async () => {
    process.env.GENERATION_WALL_CLOCK_MS = '1';
    process.env.GENERATION_MAX_ATTEMPTS = '1';
    const articleId = await createArticle({ coverRequested: false });

    // Same expected rejection as test 5 — the assertions below verify that
    // the cover columns were NOT touched by the wall-clock path.
    await expect(processArticleGeneration(makeJob(articleId))).rejects.toThrow(/бюджет времени/i);

    const article = await getArticle(articleId);
    expect(article.status).toBe('failed');
    expect(article.coverStatus).toBeNull();
    expect(article.coverSkipReason).toBeNull();
    expect(article.coverRequested).toBe(false);
  }, 60000);
});

