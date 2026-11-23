// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker test: auth/quota errors (401/402/403) must NOT trigger fallback.
 *
 * Mirrors tests/worker/fallback.test.mjs setup, but instead of callRouterAI
 * throwing a network error (→ fallback path), it RETURNS an HTTP error object
 * `{ status: 401|402|403, data: { error } }` — exactly what the real
 * callRouterAI does when RouterAI responds with an auth failure.
 *
 * Expected pipeline behaviour (server/workers/article-generation.mjs):
 *   1. topic-selector call returns { status: 401 }
 *   2. parse → success=false (status not in 2xx)
 *   3. isAuthError(result.status) → true
 *   4. AgentRun for topic-selector → status='failed', error=authErrorMessage(status)
 *   5. Article → status='failed'
 *   6. generateFallbackArticle is NOT invoked; processArticleGeneration throws
 *
 * Contrast with fallback.test.mjs where 'fetch failed' → article 'ready' via fallback.
 */
import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ── vi.hoisted: mock fns + mutable auth-status state ─────────────────────
// `authStatus` is set by each test before invoking the worker; the mock reads
// it to decide which HTTP status to return. Reset to null in beforeEach so a
// test that forgets to set it fails loudly rather than silently returning 200.
const { callRouterAIMock, broadcastProgressMock, authStatus } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  authStatus: { current: null },
}));

// ── Mock agent-role-execution.mjs (same shape as fallback.test.mjs) ──────
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

// ── Mock websocket + queue (no real infra) ───────────────────────────────
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

// ── Prisma (test DB) ──────────────────────────────────────────────────────
const prisma = new PrismaClient();

// ── callRouterAI returns an HTTP auth-error object (does NOT throw) ──────
// Real callRouterAI resolves with { status, data } for non-2xx HTTP responses;
// it only throws for network-level failures. The mock mirrors that contract.
callRouterAIMock.mockImplementation(async () => ({
  status: authStatus.current,
  data: {
    error: {
      message:
        authStatus.current === 401
          ? 'Unauthorized'
          : authStatus.current === 402
            ? 'Payment Required'
            : 'Forbidden',
    },
  },
}));

// ── Import worker after mocks ────────────────────────────────────────────
const { processArticleGeneration } = await import(
  '../../server/workers/article-generation.mjs'
);
// generateFallbackArticle import — used only to assert it is never called.
const fallbackMod = await import('../../server/article-post-processor.mjs');

// ── Shared fixture ids (created once in beforeAll) ───────────────────────

beforeAll(async () => {
  await prisma.$connect();

  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  await prisma.companyProfile.create({ data: { name: 'Auth-err компания', activeText: 'Профиль.' } });


});

afterAll(async () => {
  await prisma.$disconnect();
});

// Reset the mutable auth status before each test so a forgotten set is loud.
beforeEach(() => {
  authStatus.current = null;
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

// ── Helper: create a fresh article for one test run ──────────────────────
async function createArticle() {
  const id = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id,
      topic: 'Тема статьи ' + id.slice(0, 8),
      targetLength: 50000,
    },
  });
  return id;
}

// ── The three auth-error cases ───────────────────────────────────────────
describe('processArticleGeneration — auth errors do not fall back', () => {
  test('status=401 → Article failed, AgentRun error mentions авторизации/401, no fallback', async () => {
    authStatus.current = 401;
    const articleId = await createArticle();

    // Worker throws because the auth-error branch re-throws after marking failed.
    await expect(
      processArticleGeneration({ data: { articleId }, id: 'job-401', updateProgress: vi.fn() })
    ).rejects.toThrow(/авторизации|401/i);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Article must be failed — NOT ready (no silent fallback).
    expect(updated.status).toBe('failed');

    // No fallback version should have been produced.
    expect(updated.versions.length).toBe(0);

    // At least one AgentRun failed with an auth-flavoured Russian message.
    const authRuns = updated.agentRuns.filter(
      (r) => r.status === 'failed' && /авторизации|401|доступ/i.test(r.error || '')
    );
    expect(authRuns.length).toBeGreaterThan(0);
  }, 120000);

  test('status=402 → Article failed (balance/limits), no fallback', async () => {
    authStatus.current = 402;
    const articleId = await createArticle();

    await expect(
      processArticleGeneration({ data: { articleId }, id: 'job-402', updateProgress: vi.fn() })
    ).rejects.toThrow(/авторизации|402|баланс|лимит/i);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    expect(updated.status).toBe('failed');
    expect(updated.versions.length).toBe(0);

    const authRuns = updated.agentRuns.filter(
      (r) => r.status === 'failed' && /авторизации|402|баланс|лимит/i.test(r.error || '')
    );
    expect(authRuns.length).toBeGreaterThan(0);
  }, 120000);

  test('status=403 → Article failed (access denied), no fallback', async () => {
    authStatus.current = 403;
    const articleId = await createArticle();

    await expect(
      processArticleGeneration({ data: { articleId }, id: 'job-403', updateProgress: vi.fn() })
    ).rejects.toThrow(/авторизации|403|доступ/i);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    expect(updated.status).toBe('failed');
    expect(updated.versions.length).toBe(0);

    const authRuns = updated.agentRuns.filter(
      (r) => r.status === 'failed' && /403|доступ|авторизации/i.test(r.error || '')
    );
    expect(authRuns.length).toBeGreaterThan(0);
  }, 120000);

  test('generateFallbackArticle is never invoked on auth errors', async () => {
    // Sanity guard: spy on the real fallback generator and confirm the auth
    // path bypasses it entirely. Uses 401 as a representative case.
    authStatus.current = 401;
    const articleId = await createArticle();

    const spy = vi.spyOn(fallbackMod, 'generateFallbackArticle');

    await expect(
      processArticleGeneration({ data: { articleId }, id: 'job-spy', updateProgress: vi.fn() })
    ).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }, 120000);
});

