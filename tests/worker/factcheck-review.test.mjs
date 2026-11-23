// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker test: W1.1 (2026-08-17) — factchecker.reviewRequired больше не
 * блокирует финализацию бесконечно.
 *
 * Прод-механика (analyst-report §1.4, П3): промпт фактчекера требует
 * reviewRequired=true почти для любой мед-статьи («остались утверждения,
 * требующие врача»), а блок-условие QC-gate считало его равным вердикту
 * «качество не прошло» → 4–6 прогонов автора (~30 мин, ~90k токенов).
 *
 * Фикс: если quality-controller разрешает финализацию (finalizationAllowed=true),
 * reviewRequired даёт автору не более MAX_FACTCHECK_REVIEW_PASSES=2 ревизионных
 * проходов, после которых статья финализируется (решение логируется).
 * finalizationAllowed=false работает как раньше (перегенерация до
 * MAX_QUALITY_RETRIES → needs_review/failed).
 *
 * MAX_QUALITY_RETRIES pinned to 2 (before worker import) → exhaustion = 3
 * attempts, mirroring tests/worker/quality-retry.test.mjs.
 *
 * HARDENING (2026-09-19, from a bisect / QA risk flag):
 *  - per-test timeout raised 30s → 60s → 120s (WP wave: +247 tests raised pool
 *    contention; these DB-bound tests run 9–15s
 *    standalone and crossed the hard 30s limit under full-suite load;
 *  - mock call counters keyed per articleTopic (see gate below) so a timed-out
 *    test's orphaned worker loop cannot cascade into sibling assertions.
 */

process.env.MAX_QUALITY_RETRIES = '2';

import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ── vi.hoisted: mock fns + mutable gate state ────────────────────────────
// `gate` управляет вердиктами на каждую итерацию QC-цикла:
//   badVerdictsBeforeSuccess — сколько ПЕРВЫХ вызовов QC вернут allowed=false;
//   reviewRequiredAlways — фактчекер всегда требует ревью (прод-поведение).
//
// HARDENING (2026-09-19, bisect R1): call counters are keyed
// PER ARTICLE TOPIC, not flat shared numbers. Root cause of the earlier flake:
// under full-suite load a test crossed the hard per-test timeout; vitest moved
// on, but the timed-out test's worker loop kept running and kept incrementing
// the flat counter DURING the sibling tests, corrupting their QC verdicts and
// count assertions (qualityControllerCalls 3→6 cascade). Keying by article
// title (unique per test — createArticle) attributes every mock call to its
// OWN article, so an orphaned loop can no longer pollute sibling assertions.
const { callRouterAIMock, broadcastProgressMock, gate } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  gate: {
    badVerdictsBeforeSuccess: 0,
    reviewRequiredAlways: true,
    // Per-article counters: { [articleTopic]: calls }.
    qcCallsByArticle: {},
    factcheckerCallsByArticle: {},
  },
}));

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

const prisma = new PrismaClient();

// ── callRouterAI: canned role outputs; QC-вердикт зависит от счётчика,
//    фактчекер ВСЕГДА reviewRequired (прод-режим). ─────────────────────────
// HARDENING: counters are incremented per articleTitle (see gate
// above) — orphaned loops from a timed-out test cannot touch another
// article's counter.
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
    // ignore
  }

  let output = roleOutputs[roleId] || { stub: true };

  if (roleId === 'factchecker') {
    gate.factcheckerCallsByArticle[articleTitle] =
      (gate.factcheckerCallsByArticle[articleTitle] || 0) + 1;
    if (gate.reviewRequiredAlways) {
      output = { ...output, reviewRequired: true };
    }
  }

  if (roleId === 'quality-controller') {
    const qcCalls = (gate.qcCallsByArticle[articleTitle] =
      (gate.qcCallsByArticle[articleTitle] || 0) + 1);
    const isBad = qcCalls <= gate.badVerdictsBeforeSuccess;
    output = {
      ...roleOutputs['quality-controller'],
      finalizationAllowed: !isBad,
      verdictRu: isBad ? 'Статья требует доработки' : roleOutputs['quality-controller'].verdictRu,
      criticalIssuesRu: isBad ? ['Медицинские тезисы не подтверждены'] : [],
    };
  }

  return {
    status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    },
  };
});

const { processArticleGeneration } = await import(
  '../../server/workers/article-generation.mjs'
);


beforeAll(async () => {
  await prisma.$connect();
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  await prisma.companyProfile.create({ data: { name: 'Factcheck-review компания', activeText: 'Профиль.' } });

});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  // HARDENING: fresh per-article maps. Each test still uses its own
  // unique articleTopic, so this is hygiene only — isolation itself comes
  // from the per-article keying (orphan-proof even without this reset).
  gate.qcCallsByArticle = {};
  gate.factcheckerCallsByArticle = {};
  gate.badVerdictsBeforeSuccess = 0;
  gate.reviewRequiredAlways = true;
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

/** Свежая статья: targetLength ниже chunk-порога, structure-фикстура 2 секции → single-call путь. */
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

const countRuns = (article, nameRu) =>
  article.agentRuns.filter((r) => r.agentName === nameRu).length;

describe('processArticleGeneration — W1.1: reviewRequired больше не блокирует бесконечно', () => {
  test('(а) reviewRequired=true ×2 ревизионных прохода + finalizationAllowed=true → финализация (ready), автор ровно 3 прогона', async () => {
    // QC всегда allowed=true, фактчекер всегда reviewRequired=true (прод-режим).
    gate.badVerdictsBeforeSuccess = 0;
    gate.reviewRequiredAlways = true;

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w11-review-finalize', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Статья финализирована штатно, а не needs_review/failed.
    expect(updated.status).toBe('ready');
    expect(updated.versions.length).toBeGreaterThan(0);

    // QC-цикл: 1 исходный проход + 2 ревизионных = 3 итерации QC.
    expect(gate.qcCallsByArticle[topicOf(articleId)]).toBe(3);
    expect(gate.factcheckerCallsByArticle[topicOf(articleId)]).toBe(3);

    // Автор запускался ровно 3 раза (1 + 2 ревизии), НЕ до исчерпания
    // MAX_QUALITY_RETRIES+1 и не бесконечно.
    expect(countRuns(updated, 'Агент автора')).toBe(3);
  }, 120000);

  test('(б) finalizationAllowed=false → цикл продолжается как раньше: исчерпание → needs_review', async () => {
    // QC всегда отклоняет → старое поведение: перегенерации до лимита
    // (MAX_QUALITY_RETRIES=2 → 3 попытки), контент фиксстуры > 500 chars? —
    // фикстура ~450 chars < 500 → failed-ветка; используем её (как раньше).
    gate.badVerdictsBeforeSuccess = 99;
    gate.reviewRequiredAlways = true;

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w11-qc-blocked', updateProgress: vi.fn() };

    await expect(processArticleGeneration(job)).rejects.toThrow(/качеств/i);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { agentRuns: true },
    });
    expect(updated.status).toBe('failed');
    expect(gate.qcCallsByArticle[topicOf(articleId)]).toBe(3);
    expect(countRuns(updated, 'Агент автора')).toBe(3);
  }, 120000);

  test('(в) счётчик ревизионных проходов НЕ сбрасывается между QC-итерациями (микс: QC-block → review-block → финализация)', async () => {
    // Итерация 1: QC allowed=false (блок). Итерация 2: allowed=true +
    // reviewRequired=true → ещё одна ревизия. Итерация 3: allowed=true +
    // reviewRequired=true, но счётчик проходов уже 2 → финализация.
    // Если бы счётчик сбрасывался на каждой итерации — цикл ушёл бы в 4+ прогона.
    gate.badVerdictsBeforeSuccess = 1;
    gate.reviewRequiredAlways = true;

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w11-mixed-counter', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    expect(updated.status).toBe('ready');
    expect(gate.qcCallsByArticle[topicOf(articleId)]).toBe(3);
    // Ключевой инвариант: счётчик накоплен (1 QC-блок + 1 review-блок = 2
    // ревизии) → на 3-й итерации финализация, автор ровно 3 прогона.
    expect(countRuns(updated, 'Агент автора')).toBe(3);
  }, 120000);
});

