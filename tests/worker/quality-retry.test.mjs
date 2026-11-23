// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker test: quality-gate retry-loop (Dev-B Task 4 + 5).
 *
 * Covers three scenarios:
 *   1. quality-controller returns finalizationAllowed=false on the first 2
 *      attempts, then true on the 3rd → pipeline regenerates from
 *      article-author twice and finally produces status='ready' with MORE than
 *      13 AgentRuns (duplicated article-author + factchecker + ... runs).
 *   2. quality-controller returns finalizationAllowed=false 4 times (exceeding
 *      MAX_QUALITY_RETRIES=2 → 3 attempts total) AND fixture content < 500 chars
 *      → article status='failed', error mentions «качества».
 *   3. Same exhaustion, but content > 500 chars → status='needs_review',
 *      version saved, NO throw (best-effort salvage guard).
 *
 * MAX_QUALITY_RETRIES pinned to 2 at the top of this file (before worker import)
 * so the retry cap is 3 attempts regardless of the production default (now 5).
 *
 * Mirrors tests/worker/fallback-auth.test.mjs setup (mock callRouterAI +
 * parseRoleExecutionResult + real test DB). Uses the shared fixtures in
 * tests/fixtures/role-outputs.mjs, but overrides quality-controller output
 * dynamically based on a mutable call counter.
 *
 * The structure-architect fixture ships 2 sections (< 3) so the chunked
 * generation branch is bypassed and we exercise the single-call path —
 * isolating the retry-loop behaviour.
 *
 * HARDENING (2026-09-19, from a bisect / QA risk flag):
 *  - per-test timeout raised 30s → 60s: these DB-bound tests run 9–15s
 *    standalone and crossed the hard 30s limit under full-suite load;
 *  - mock QC call counter keyed per articleTopic (see qualityGate below) so a
 *    timed-out test's orphaned worker loop cannot cascade into sibling
 *    assertions (R1 flake: qualityControllerCalls 3→6, salvage test
 *    finalized 'ready' instead of 'needs_review').
 *
 * HARDENING (2026-10-25 — cover-settings tab + agent-prompt v2 wave):
 *  - per-test timeout raised 60s → 120s (same precedent as 30→60 and as
 *    f9c4efe for fallback-auth 30→60): the full-suite run of this wave was
 *    2462/2463, the single failure being «2 bad verdicts then success →
 *    regenerates from article-author» (line 294) hitting the 60s hard timeout
 *    under full-suite load. Standalone the file passes 3/3 (97s, the test
 *    itself 44s) → no functional regression, only DB-bound load flakiness.
 *    Only the timeout changed — the test logic is untouched.
 */

// Pin MAX_QUALITY_RETRIES=2 BEFORE importing the worker. The worker reads this
// env var at module-load time (article-generation.mjs:88). Production default
// is now 5 (6 attempts); we force 2 here so the exhaustion tests run 3 attempts
// deterministically and fast.
process.env.MAX_QUALITY_RETRIES = '2';

import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ── vi.hoisted: mock fns + mutable quality-gate state ────────────────────
// `qualityGate` is read by the callRouterAI mock on each quality-controller
// invocation to decide whether finalization is allowed. Each test sets it
// before running the worker; the mock increments the per-article counter.
// `useLargeContent`: when true, article-author returns >500-char markdown so
// the needs_review salvage guard triggers on retry exhaustion (test 3).
// HARDENING: the QC counter is keyed PER ARTICLE TOPIC (unique per
// test — createArticle) instead of one flat shared number. Root cause of the
// flake (bisect R1): under full-suite load a test crossed the
// hard per-test timeout; vitest moved on, but the timed-out test's worker
// loop kept running and kept incrementing the flat counter DURING the
// sibling tests, corrupting their verdicts and count assertions.
const { callRouterAIMock, broadcastProgressMock, qualityGate } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  qualityGate: {
    badVerdictsBeforeSuccess: 0,
    useLargeContent: false,
    // Per-article counter: { [articleTopic]: qcCalls }.
    qcCallsByArticle: {},
  },
}));

// Large article markdown (>500 chars) for the needs_review salvage test.
// Short fixture (450 chars) would fall below the 500-char salvage threshold.
const LARGE_ARTICLE_MARKDOWN = '# Большая статья для needs_review\n\n'.padEnd(600, 'а');

// ── Mock agent-role-execution.mjs (same shape as fallback-auth.test.mjs) ──
// P1 (2026-08-16): buildSemanticCoreContext (SEO-ядро) — реальная реализация
// (воркер зовёт её через dynamic import после semantic-strategist).
vi.mock('../../server/agent-role-execution.mjs', async (importOriginal) => ({
  resolveEnvNumber: (await importOriginal()).resolveEnvNumber,
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
      // HARDENING: articleTitle is embedded so the callRouterAI mock
      // can attribute each role call to ITS OWN article (unique per test).
      {
        role: 'user',
        content: JSON.stringify({
          roleId: opts?.roleId,
          articleTitle: opts?.context?.articleTitle ?? null,
        }),
      },
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

// ── callRouterAI: returns canned role outputs, but quality-controller output
//    depends on the mutable counter so the first N calls return a bad verdict.
callRouterAIMock.mockImplementation(async (payload) => {
  const { roleOutputs } = await import('../fixtures/role-outputs.mjs');
  let roleId = null;
  let articleTitle = null;
  try {
    const userMsg = payload?.messages?.find((m) => m.role === 'user');
    if (userMsg) {
      const parsed = JSON.parse(userMsg.content);
      roleId = parsed?.roleId ?? null;
      articleTitle = parsed?.articleTitle ?? null;
    }
  } catch {
    // ignore parse errors
  }

  // Override quality-controller verdict based on the PER-ARTICLE call counter.
  let output = roleOutputs[roleId] || { stub: true };
  // When useLargeContent is set, article-author/factchecker/humanizer return
  // >500-char content so the needs_review salvage guard triggers on exhaustion.
  if (qualityGate.useLargeContent && (roleId === 'article-author' || roleId === 'factchecker' || roleId === 'humanizer')) {
    const base = roleOutputs[roleId] || {};
    const field = roleId === 'article-author'
      ? 'articleMarkdownRu'
      : roleId === 'factchecker'
        ? 'checkedArticleMarkdownRu'
        : 'finalArticleMarkdownRu';
    output = { ...base, [field]: LARGE_ARTICLE_MARKDOWN };
  }
  if (roleId === 'quality-controller') {
    // HARDENING: increment under this article's own key — an
    // orphaned loop from a timed-out test cannot touch another article's
    // counter or flip its verdicts.
    const qcCalls = (qualityGate.qcCallsByArticle[articleTitle] =
      (qualityGate.qcCallsByArticle[articleTitle] || 0) + 1);
    const isBad = qcCalls <= qualityGate.badVerdictsBeforeSuccess;
    output = {
      ...roleOutputs['quality-controller'],
      finalizationAllowed: !isBad,
      verdictRu: isBad
        ? 'Статья требует доработки'
        : roleOutputs['quality-controller'].verdictRu,
      criticalIssuesRu: isBad
        ? ['Медицинские тезисы не подтверждены', 'Слабая структура']
        : [],
    };
  }

  // Ensure factchecker cooperates: reviewRequired=true only mirrors a real
  // bad verdict path, but the retry trigger is finalizationAllowed===false
  // (quality-controller). We keep factchecker.reviewRequired=false so only the
  // quality-controller drives the retry, matching the spec's primary signal.
  return {
    status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    },
  };
});

// ── Import worker after mocks ────────────────────────────────────────────
const { processArticleGeneration } = await import(
  '../../server/workers/article-generation.mjs'
);

// ── Shared fixture ids ───────────────────────────────────────────────────

beforeAll(async () => {
  await prisma.$connect();

  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  await prisma.companyProfile.create({ data: { name: 'Quality-retry компания', activeText: 'Профиль.' } });


});

afterAll(async () => {
  await prisma.$disconnect();
});

// Reset mutable quality-gate state between tests so each starts clean.
// HARDENING: fresh per-article map. Each test still uses its own
// unique articleTopic, so this is hygiene only — isolation itself comes from
// the per-article keying (orphan-proof even without this reset).
beforeEach(() => {
  qualityGate.qcCallsByArticle = {};
  qualityGate.badVerdictsBeforeSuccess = 0;
  qualityGate.useLargeContent = false;
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

// ── Helper: create a fresh article for one test run ──────────────────────
// targetLength=15000 keeps the article below the chunked threshold (20000)
// AND the structure fixture has only 2 sections (< 3) — so the single-call
// path is exercised and the retry-loop is the sole focus.
async function createArticle() {
  const id = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id,
      topic: 'Тема статьи ' + id.slice(0, 8),
      targetLength: 15000,
    },
  });
  return id;
}

/** HARDENING: article topic = the per-article counter key. */
const topicOf = (articleId) => 'Тема статьи ' + articleId.slice(0, 8);

describe('processArticleGeneration — quality-gate retry-loop', () => {
  test('2 bad verdicts then success → regenerates from article-author, status=ready, >12 AgentRuns', async () => {
    qualityGate.badVerdictsBeforeSuccess = 2; // first 2 QC calls bad, 3rd good

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-q-retry-2', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Article finalized as ready on the 3rd attempt.
    expect(updated.status).toBe('ready');

    // A version with content was produced.
    expect(updated.versions.length).toBeGreaterThan(0);
    expect(updated.versions[0].contentText.length).toBeGreaterThan(0);

    // Quality-controller was called exactly 3 times (2 bad + 1 good).
    expect(qualityGate.qcCallsByArticle[topicOf(articleId)]).toBe(3);

    // article-author was called 3 times (1 initial + 2 retries). Each
    // regeneration re-runs article-author → factchecker → seo-reviewer →
    // quality-controller. So AgentRuns must exceed the 11-role baseline.
    const authorRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент автора');
    expect(authorRuns.length).toBe(3);

    // Total AgentRuns > 12 (11-role chain + 1 post-check run = 12 baseline,
    // plus extra article-author/factchecker/seo-reviewer/quality-controller
    // runs from the 2 retries = +8).
    expect(updated.agentRuns.length).toBeGreaterThan(12);
  }, 120000);

  test('exhaustion with short content (<500 chars) → status=failed, error mentions качества', async () => {
    // MAX_QUALITY_RETRIES pinned to 2 (env set at top of file) → 3 total attempts.
    // Fixture article-author content is 450 chars (< 500 salvage threshold).
    // badVerdictsBeforeSuccess=4 means QC stays bad through all 3 attempts →
    // no salvage (content too short) → failed + throw.
    qualityGate.badVerdictsBeforeSuccess = 4;
    qualityGate.useLargeContent = false;

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-q-retry-fail', updateProgress: vi.fn() };

    // Worker throws because the quality-gate exhausts retries and content is too short to salvage.
    await expect(processArticleGeneration(job)).rejects.toThrow(/качеств/i);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Article must be failed — NOT ready, NOT needs_review.
    expect(updated.status).toBe('failed');
    // U3: failed — причина сброшена.
    expect(updated.needsReviewReason).toBeNull();

    // No version saved (content too short → no salvage).
    expect(updated.versions.length).toBe(0);

    // Quality-controller was called exactly 3 times (the retry cap).
    expect(qualityGate.qcCallsByArticle[topicOf(articleId)]).toBe(3);

    // article-author was called 3 times (1 initial + 2 retries).
    const authorRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент автора');
    expect(authorRuns.length).toBe(3);

    // At least one AgentRun/progress message mentions the quality failure.
    const qualityErrorRuns = updated.agentRuns.filter(
      (r) => r.error && /качеств/i.test(r.error)
    );
    // The failure reason is logged on the throwing AgentRun (quality-controller)
    // OR broadcast via progress. We assert the article error surface exists.
    expect(qualityErrorRuns.length + broadcastProgressMock.mock.calls.filter(
      (call) => {
        const msg = JSON.stringify(call);
        return /качеств/i.test(msg);
      }
    ).length).toBeGreaterThan(0);
  }, 120000);

  test('exhaustion with salvageable content (>500 chars) → status=needs_review, version saved, NO throw', async () => {
    // MAX_QUALITY_RETRIES pinned to 2 (env set at top of file) → 3 total attempts.
    // useLargeContent=true → article-author/factchecker/humanizer return >500-char
    // markdown. badVerdictsBeforeSuccess=4 → QC stays bad through all 3 attempts.
    // Salvage guard: content > 500 chars → save version, status=needs_review, return (no throw).
    qualityGate.badVerdictsBeforeSuccess = 4;
    qualityGate.useLargeContent = true;

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-q-retry-needs-review', updateProgress: vi.fn() };

    // Worker does NOT throw — the salvage guard saves the best content and returns.
    await processArticleGeneration(job);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Article is needs_review — NOT failed, NOT ready.
    expect(updated.status).toBe('needs_review');

    // U3: причина QC-исчерпания персистится в колонке (feedback последней попытки).
    expect(updated.needsReviewReason).toMatch(/^Качество не сошлось за \d+ попыток\. Замечания: /);
    expect(updated.needsReviewReason.length).toBeLessThanOrEqual(200);

    // A version was salvaged with content > 500 chars.
    expect(updated.versions.length).toBeGreaterThan(0);
    expect(updated.versions[0].contentText.length).toBeGreaterThan(500);

    // Quality-controller was called exactly 3 times (the retry cap).
    expect(qualityGate.qcCallsByArticle[topicOf(articleId)]).toBe(3);

    // article-author was called 3 times (1 initial + 2 retries).
    const authorRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент автора');
    expect(authorRuns.length).toBe(3);
  }, 120000);
});

