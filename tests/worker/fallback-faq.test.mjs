// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker test: W1.3 (2026-08-17, e2e-гэп от 16.08) — skipFaq только для
 * ИСТИННОГО шаблона.
 *
 * Прод-механика (analyst-report П2): finalizeWithFallback всегда передавал
 * saveFinalVersion({skipFaq:true}) — все 3 прод-статьи без LLM-FAQ. Но fallback
 * с ХОРОШИМ авторским текстом (structuredOutputs['article-author'] существует —
 * напр., таймаут фактчекера после успешного автора) — статья полноценная, и
 * FAQ обязан попытаться (у generateUnusualFaqMarkdown есть свой fail-safe:
 * любой сбой → WARN → статья без FAQ).
 *
 * Фикс: skipFaq=true только когда авторского вывода нет В МОМЕНТ входа в
 * finalizeWithFallback (истинный шаблон из структуры).
 */

import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

const { callRouterAIMock, broadcastProgressMock, scenarioState } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  // scenario: 'author-then-fc-fail' — роли из фикстур, фактчекер падает
  // (fetch failed) → fallback при живом авторском тексте;
  // 'author-template' — САМ автор падает transient-ошибкой → mid-pipeline
  // шаблон из структуры, затем фактчекер падает → fallback на шаблоне;
  // 'all-fail' — все вызовы падают → истинный шаблон.
  scenarioState: { scenario: 'author-then-fc-fail' },
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
// без моков research-этап ходил в реальную сеть (блок keyless-бэкенда, Yandex-раунды
// консенсуса) поверх уже мокнутых LLM-сценариев — тесты 30–60с и ротацонные
// таймауты (флейк воспроизводился и на HEAD до волны). Семантика FAQ-кейсов
// (skipFaq/идемпотентность) от research-источников не зависит.
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

const prisma = new PrismaClient();

/** Валидный FAQ-ответ: 10 вопросов → блок «## 10 необычных вопросов про …». */
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

/** Вызовы FAQ-генератора определяются по системному промпту (как в fallback.test.mjs). */
const faqCallCount = () =>
  callRouterAIMock.mock.calls.filter(([payload]) =>
    /SEO-копирайтер/iu.test(
      payload?.messages?.find((m) => m.role === 'system')?.content || ''
    )
  ).length;

callRouterAIMock.mockImplementation(async (payload) => {
  if (scenarioState.scenario === 'all-fail') {
    throw new Error('fetch failed');
  }

  // FAQ-генератор (serveвный вызов, без roleId).
  const systemMsg = payload?.messages?.find((m) => m.role === 'system')?.content || '';
  if (/SEO-копирайтер/iu.test(systemMsg)) {
    return faqResponse('fallback-FAQ');
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

  // Сценарий: автор отработал успешно, фактчекер падает по сети →
  // finalizeWithFallback при живом авторском тексте.
  // 'author-template': сам автор падает transient → mid-pipeline шаблон.
  if (scenarioState.scenario === 'author-template' && roleId === 'article-author') {
    throw new Error('fetch failed');
  }
  if (roleId === 'factchecker') {
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
  // M2: the suite runs on SQLite + the in-process runner (see the header) —
  // the live-PG bailout of M0/M1 is gone.
  await prisma.$connect();
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  await prisma.companyProfile.create({ data: { name: 'Fallback-FAQ компания', activeText: 'Профиль.' } });

});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  scenarioState.scenario = 'author-then-fc-fail';
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

/** targetLength=15000 < пути chunking (фикстура структуры и так 2 секции). */
async function createArticle() {
  const id = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id,
      topic: 'Имплантация зубов: fallback FAQ',
      targetLength: 15000,
    },
  });
  return id;
}

async function getVersions(articleId) {
  const updated = await prisma.article.findUnique({
    where: { id: articleId },
    include: { versions: { orderBy: { createdAt: 'desc' } }, agentRuns: true },
  });
  return updated;
}

describe('processArticleGeneration — W1.3: skipFaq только для истинного шаблона', () => {
  test('(а) fallback при живом авторском тексте → FAQ-генерация вызывается и блок вставлен', async () => {
    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w13-author-fallback', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const updated = await getVersions(articleId);

    // Fallback-финализация прошла (фактчекер упал по сети после успешного автора).
    expect(updated.status).toBe('ready');
    expect(
      updated.agentRuns.filter((r) => r.error && r.error.startsWith('fallback:')).length
    ).toBeGreaterThan(0);

    // FAQ-генератор ВЫЗВАН (не skipFaq) — ровно один вызов.
    expect(faqCallCount()).toBe(1);

    // Блок вставлен в финальную версию.
    expect(updated.versions.length).toBeGreaterThan(0);
    const md = updated.versions[0].contentMarkdown;
    expect(md).toContain('## 10 необычных вопросов');
    expect((md.match(/## 10 необычных вопросов/g) || []).length).toBe(1);
    expect(md.split('\n').filter((l) => l.startsWith('### ')).length).toBe(10);
  }, 60000);

  test('(б) истинный шаблон (авторского вывода нет) → FAQ-генератор НЕ вызывается', async () => {
    scenarioState.scenario = 'all-fail';

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w13-true-template', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const updated = await getVersions(articleId);
    expect(updated.status).toBe('ready');
    expect(updated.versions.length).toBeGreaterThan(0);

    // Истинный шаблон: LLM недоступна с первой роли → skipFaq, ноль вызовов FAQ.
    expect(faqCallCount()).toBe(0);
    expect(updated.versions[0].contentMarkdown).not.toMatch(/необычн[а-яё]*\s+вопрос/i);
  }, 60000);

  test('(в) retry (повторный прогон job) → в каждой версии ровно один FAQ-блок', async () => {    const articleId = await createArticle();

    // Попытка 1: автор ок, фактчекер падает → fallback + FAQ.
    await processArticleGeneration({ data: { articleId }, id: 'job-w13-retry-1', updateProgress: vi.fn() });

    // W4.3 (2026-08-17): повтор job при финальном статусе (ready) теперь выходит
    // идемпотентно БЕЗ новой версии. Реальный retry-сценарий с новой версией —
    // попытка упала ПОСЛЕ сохранения версии, но ДО финального статуса
    // (статус застрял «процессный») → откатываем статус, как при краше
    // между articleVersion.create и article.update.
    await prisma.article.update({ where: { id: articleId }, data: { status: 'factcheck' } });

    // Попытка 2 (BullMQ-подобный повтор): тот же сценарий → новая версия.
    await processArticleGeneration({ data: { articleId }, id: 'job-w13-retry-2', updateProgress: vi.fn() });

    const updated = await getVersions(articleId);
    expect(updated.status).toBe('ready');
    expect(updated.versions.length).toBe(2);

    for (const version of updated.versions) {
      const md = version.contentMarkdown;
      expect((md.match(/## 10 необычных вопросов/g) || []).length).toBe(1);
      expect(md.split('\n').filter((l) => l.startsWith('### ')).length).toBe(10);
    }
  }, 90000);
});

  // M2: revived with the suite — the helpers are module-level and the suite
  // runs on SQLite with the in-process runner.
  test('(г) FIX-M2: transient-сбой автора → mid-pipeline шаблон + фактчекер упал → 0 FAQ-вызовов', async () => {
    // Автор упал transient-ошибкой → воркер кладёт ШАБЛОН из структуры в
    // structuredOutputs['article-author'] и ведёт пайплайн дальше. Фактчекер
    // тоже падает → finalizeWithFallback. Шаблон неотличим от живого автора?
    // Тогда skipFaq=false → FAQ-вызов по мёртвому провайдеру (~9 мин до
    // fail-safe). Фикс: шаблон помечен _fallbackTemplate → skipFaq=true.
    scenarioState.scenario = 'author-template';

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-fixm2-author-template', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const updated = await getVersions(articleId);
    expect(updated.status).toBe('ready');
    expect(updated.versions.length).toBeGreaterThan(0);

    // Шаблонный автор: FAQ-генератор НЕ вызывается вовсе.
    expect(faqCallCount()).toBe(0);
    expect(updated.versions[0].contentMarkdown).not.toMatch(/необычн[а-яё]*\s+вопрос/i);

    // При этом это именно mid-pipeline шаблон автора (не «перворолевый»):
    // автор-ран существует и помечен fallback-ошибкой, статья готова.
    const authorRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент автора');
    expect(authorRuns.length).toBe(1);
    expect(authorRuns[0].error).toMatch(/^fallback: /);
  }, 60000);

