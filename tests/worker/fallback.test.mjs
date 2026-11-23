// Runs on SQLite with the in-process runner (no external services).
import { vi, test, expect, beforeAll, afterAll, describe } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ── vi.hoisted mock fns ──────────────────────────────────────────────────
const { callRouterAIMock, broadcastProgressMock } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
}));

// ── Mock agent-role-execution.mjs ────────────────────────────────────────
vi.mock('../../server/agent-role-execution.mjs', async (importOriginal) => ({
  resolveEnvNumber: (await importOriginal()).resolveEnvNumber,
  // P1 (2026-08-16): buildSemanticCoreContext (SEO-ядро) — реальная реализация.
  buildSemanticCoreContext: (await importOriginal()).buildSemanticCoreContext,
  callRouterAI: callRouterAIMock,
  // W4.1: цепочка резервных моделей — сквозной мок (сам callRouterAI замокан
  // выше; семантика деградации покрыта юнит-тестами agent-role-execution).
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

// ── Mock websocket + queue ───────────────────────────────────────────────
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

// ── Внешние поисковые провайдеры → мгновенный пустой результат ────────────
// quality-calibration (2026-08-21): паттерн article-generation.test.mjs —
// без моков research-этап ходил в реальную сеть (блок keyless-бэкенда, Yandex-раунды
// консенсуса) при уже мокнутом «недоступном» LLM — тест 22с и ротацонные
// таймауты при параллельной нагрузке. Семантика (fallback-шаблон) не зависит.
// ── Web-search слой → мгновенный пустой результат ─────────────────────────
// Тесты чувствительны ко времени: реальный research-этап со сетевыми
// таймаутами съедал бы бюджет до старта первой роли. Мок даёт детерминированный
// research ≈ 0мс и НИКОГДА не ходит в сеть.
vi.mock('../../server/lib/web-search/index.mjs', () => ({
  searchWeb: vi.fn(async () => ({
    results: [],
    backend: 'duckduckgo',
    degraded: true,
    reason: 'network_unavailable',
    lang: 'ru',
    limit: 5,
    attempts: [],
  })),
}));

// ── Prisma (test DB) ──────────────────────────────────────────────────────
const prisma = new PrismaClient();

// ── callRouterAI throws on ALL calls (simulates network outage) ──────────
callRouterAIMock.mockImplementation(async () => {
  throw new Error('fetch failed');
});

// ── Import worker after mocks ────────────────────────────────────────────
const { processArticleGeneration } = await import('../../server/workers/article-generation.mjs');

// ── Test data ─────────────────────────────────────────────────────────────
let articleId;

beforeAll(async () => {
  await prisma.$connect();

  // Clean slate
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  await prisma.companyProfile.create({ data: { name: 'Fallback компания', activeText: 'Профиль компании.' } });



  articleId = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id: articleId,
      topic: 'Консультация врача',
      targetLength: 50000,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('processArticleGeneration — fallback path', () => {
  test('recovers via generateFallbackArticle when callRouterAI always fails', async () => {
    const job = {
      data: { articleId },
      id: 'test-job-fallback-1',
      updateProgress: vi.fn(),
    };

    // Should NOT throw — fallback path handles the error internally.
    await processArticleGeneration(job);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Article finalized as ready (via finalizeWithFallback → finalizeCompleted)
    expect(updated.status).toBe('ready');

    // A fallback version was created with content
    expect(updated.versions.length).toBeGreaterThan(0);
    const version = updated.versions[0];
    expect(version.contentText.length).toBeGreaterThan(0);

    // At least one AgentRun should have an error containing 'fallback'
    const fallbackRuns = updated.agentRuns.filter(
      (r) => r.error && r.error.toLowerCase().includes('fallback')
    );
    expect(fallbackRuns.length).toBeGreaterThan(0);

    // Tech-lead review (2026-08-16, P4): fallback-финализация НЕ дёргает
    // FAQ-генерацию — LLM заведомо недоступна, вызов лишь добавил бы до
    // 5 попыток × ROUTERAI_TIMEOUT_MS бесполезного ожидания.
    const faqCalls = callRouterAIMock.mock.calls.filter(([payload]) =>
      /SEO-копирайтер/iu.test(
        payload?.messages?.find((m) => m.role === 'system')?.content || ''
      )
    );
    expect(faqCalls).toHaveLength(0);
  }, 30000);
});

