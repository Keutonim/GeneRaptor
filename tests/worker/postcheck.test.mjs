// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker test: W2.2 (2026-08-17) — постпродакшен-проверка в saveFinalVersion.
 *
 * Инварианты:
 *  (а) report-режим (POSTCHECK_MODE default): отчёт пишется в служебный
 *      AgentRun «Пост-проверка качества», статус статьи НЕ меняется
 *      (даже при verdict=fail — как все 3 прод-статьи W1);
 *  (б) enforce + verdict=fail → needs_review ВМЕСТО ready (fallback-путь тоже);
 *  (в) enforce + verdict≠fail → ready как раньше;
 *  (г) сбой самого postcheck (throw) → fail-safe: статья сохраняется как раньше,
 *      служебного рана нет;
 *  (д) один вызов saveFinalVersion → ровно один служебный ран (нет дублей).
 */

import { vi, test, expect, beforeAll, afterAll, describe, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { POSTCHECK_RULE_IDS } from '../../server/lib/article-postcheck.mjs';

const { callRouterAIMock, broadcastProgressMock, scenarioState } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  // scenario: 'happy' — все роли ок (нормальная финализация);
  // 'author-then-fc-fail' — автор ок, фактчекер падает → fallback при живом
  // авторе (прод-паттерн: hasSuccessfulFactcheckRun=false → FACTCHECK-COVERAGE major).
  scenarioState: { scenario: 'happy', postcheckThrow: false },
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

// ── Внешние поисковые провайдеры → мгновенный пустой результат ────────────
// quality-calibration (2026-08-21): паттерн article-generation.test.mjs —
// файл ходил в research-этап БЕЗ моков (реальные Yandex-раунды консенсуса +
// блок keyless-бэкенда): тесты 20–52с каждый, при параллельной нагрузке — ротацонные
// 60s-таймауты ((б)/(в)/(д) в разных прогонах). Семантика кейсов (postcheck,
// enforce, fallback) от источников не зависит — детерминируем research ≈ 0мс.
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

// Контролируемый сбой самого валидатора: postcheckThrow=true → throw (тест г).
vi.mock('../../server/lib/article-postcheck.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    runArticlePostcheck: (...args) => {
      if (scenarioState.postcheckThrow) throw new Error('postcheck boom');
      return original.runArticlePostcheck(...args);
    },
  };
});

const prisma = new PrismaClient();

/** Валидный FAQ-ответ генератора: 10 вопросов → «## 10 необычных вопросов…». */
function faqResponse(topic) {
  const items = Array.from({ length: 10 }, (_, i) => ({
    question: `Неочевидный вопрос №${i + 1} про ${topic}?`,
    answer: `Короткий честный ответ №${i + 1} с обоснованием.`,
  }));
  return {
    status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify({ items }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 150, total_tokens: 200 },
    },
  };
}

callRouterAIMock.mockImplementation(async (payload) => {
  const systemMsg = payload?.messages?.find((m) => m.role === 'system')?.content || '';
  if (/SEO-копирайтер/iu.test(systemMsg)) {
    return faqResponse('постчек');
  }

  const { roleOutputs } = await import('../fixtures/role-outputs.mjs');
  let roleId = null;
  try {
    const userMsg = payload?.messages?.find((m) => m.role === 'user');
    const match = userMsg ? /"roleId"\s*:\s*"([^"]+)"/.exec(userMsg.content) : null;
    if (match) roleId = match[1];
  } catch {
    // ignore
  }

  // Прод-паттерн: успешный автор → фактчекер падает по сети → fallback.
  if (scenarioState.scenario === 'author-then-fc-fail' && roleId === 'factchecker') {
    throw new Error('fetch failed');
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

const { processArticleGeneration } = await import(
  '../../server/workers/article-generation.mjs'
);


beforeAll(async () => {
  await prisma.$connect();
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  await prisma.companyProfile.create({ data: { name: 'Постчек компания', activeText: 'Профиль.' } });

});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  scenarioState.scenario = 'happy';
  scenarioState.postcheckThrow = false;
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

afterEach(() => {
  delete process.env.POSTCHECK_MODE;
});

async function createArticle(targetLength) {
  const id = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id,
      topic: 'Имплантация зубов: постпроверка',
      targetLength,
    },
  });
  return id;
}

async function getArticle(articleId) {
  return prisma.article.findUnique({
    where: { id: articleId },
    include: { versions: { orderBy: { createdAt: 'desc' } }, agentRuns: true },
  });
}

function postcheckRuns(article) {
  return article.agentRuns.filter((r) => r.agentName === 'Пост-проверка качества');
}

describe('processArticleGeneration — W2.2: постпроверка в saveFinalVersion', () => {
  test('(а) report-режим по умолчанию: verdict=fail НЕ меняет ready, служебный ран создан', async () => {
    // Прод-паттерн: fallback при живом авторе → нет фактчека (major) + недобор
    // объёма (major) → verdict=fail. POSTCHECK_MODE не задан → report.
    scenarioState.scenario = 'author-then-fc-fail';
    delete process.env.POSTCHECK_MODE;

    const articleId = await createArticle(15000);
    await processArticleGeneration({ data: { articleId }, id: 'job-w22-report', updateProgress: vi.fn() });

    const article = await getArticle(articleId);
    expect(article.status).toBe('ready'); // report-режим: статус не тронут
    expect(article.versions.length).toBe(1);

    const runs = postcheckRuns(article);
    expect(runs).toHaveLength(1); // один вызов saveFinalVersion → один ран
    expect(runs[0].status).toBe('completed');

    const report = JSON.parse(runs[0].outputJson);
    expect(report.version).toBe(1);
    expect(report.verdict).toBe('fail');
    expect(report.rules).toHaveLength(POSTCHECK_RULE_IDS.length); // 27 + 7 seo-round A5 + FIX-S4 per-key + LINKS-SPECIALIST-PRESENT
    expect(report.rules.find((r) => r.id === 'FACTCHECK-COVERAGE').status).toBe('fail');
    // Финализация шла через fallback → метрика PROCESS-FINALIZATION это фиксирует.
    expect(report.rules.find((r) => r.id === 'PROCESS-FINALIZATION').status).toBe('fail');
    expect(report.rules.find((r) => r.id === 'PROCESS-FINALIZATION').details.finalizedVia).toBe('fallback');
    expect(report.summary.pass + report.summary.fail + report.summary.skipped).toBe(POSTCHECK_RULE_IDS.length);
  }, 60000);

  test('(б) enforce + verdict=fail → needs_review вместо ready (fallback-путь)', async () => {
    scenarioState.scenario = 'author-then-fc-fail';
    process.env.POSTCHECK_MODE = 'enforce';

    const articleId = await createArticle(15000);
    await processArticleGeneration({ data: { articleId }, id: 'job-w22-enforce-fail', updateProgress: vi.fn() });

    const article = await getArticle(articleId);
    expect(article.status).toBe('needs_review');
    expect(article.versions.length).toBe(1); // версия СОХРАНЕНА — статья не потеряна
    // U3: причина enforce-постчека персистится в колонке (формат «Качество: N проваленных правил (…)»).
    expect(article.needsReviewReason).toMatch(/^Качество: \d+ проваленных правил \(/);
    expect(article.needsReviewReason.length).toBeLessThanOrEqual(200);

    const report = JSON.parse(postcheckRuns(article)[0].outputJson);
    expect(report.verdict).toBe('fail');

    // Причина видна в WS-прогрессе (существующий механизм needs_review).
    const messages = broadcastProgressMock.mock.calls
      .map(([, payload]) => payload?.message || '')
      .filter((m) => m.includes('постпроверк') || m.includes('Пост-проверк'));
    expect(messages.length).toBeGreaterThan(0);
  }, 60000);

  test('(в) enforce + verdict≠fail → ready как раньше', async () => {
    scenarioState.scenario = 'happy';
    process.env.POSTCHECK_MODE = 'enforce';

    // Фикстура ~1.2k симв. + FAQ: длина в норме, фактчек есть.
    // P2-2/S2 (2026-09-18, Director option A): 1000 → 2000 — детерминированный
    // блок записи (~870 симв., слот §1.3) поднял финал до ~1.94k; при target
    // 2000 соотношение ≈0.97× — снова внутри окна BODY-LENGTH-RANGE.
    const articleId = await createArticle(2000);
    await processArticleGeneration({ data: { articleId }, id: 'job-w22-enforce-ok', updateProgress: vi.fn() });

    const article = await getArticle(articleId);
    expect(article.status).toBe('ready');
    // U3: enforce + verdict≠fail → ready, причина пустая.
    expect(article.needsReviewReason).toBeNull();

    const report = JSON.parse(postcheckRuns(article)[0].outputJson);
    expect(['ok', 'warn']).toContain(report.verdict);
  }, 60000);

  test('(г) сбой самого postcheck → fail-safe: статья сохранена, рана нет', async () => {
    scenarioState.scenario = 'happy';
    scenarioState.postcheckThrow = true;
    delete process.env.POSTCHECK_MODE;

    const articleId = await createArticle(1000);
    await processArticleGeneration({ data: { articleId }, id: 'job-w22-throw', updateProgress: vi.fn() });

    const article = await getArticle(articleId);
    expect(article.status).toBe('ready');
    expect(article.versions.length).toBe(1);
    expect(article.versions[0].contentMarkdown).toContain('## 10 необычных вопросов');
    expect(postcheckRuns(article)).toHaveLength(0); // без отчёта, но не без статьи
  }, 60000);

  test('(д) retry job: новая версия → свой отчёт, дублей в одном вызове нет', async () => {
    scenarioState.scenario = 'author-then-fc-fail';

    const articleId = await createArticle(15000);
    await processArticleGeneration({ data: { articleId }, id: 'job-w22-retry-1', updateProgress: vi.fn() });

    // W4.3 (2026-08-17): повтор job при финальном статусе (ready) выходит
    // идемпотентно без новой версии. Новая версия при retry бывает только если
    // первая попытка упала ПОСЛЕ сохранения версии, но ДО финального статуса
    // (краш между articleVersion.create и article.update) — имитируем его.
    await prisma.article.update({ where: { id: articleId }, data: { status: 'factcheck' } });

    await processArticleGeneration({ data: { articleId }, id: 'job-w22-retry-2', updateProgress: vi.fn() });

    const article = await getArticle(articleId);
    expect(article.versions.length).toBe(2);
    expect(postcheckRuns(article)).toHaveLength(2); // по одному на версию
    for (const run of postcheckRuns(article)) {
      const report = JSON.parse(run.outputJson);
      expect(report.version).toBe(1);
    }
  }, 90000);
});

