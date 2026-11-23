// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker test W4.1 (2026-08-17): цепочка резервных моделей на уровне роли.
 *
 * Прод-симптом (3 деплоя подряд, w23-deploy-report): финальные роли падают по
 * «This operation was aborted» после исчерпания ретраев первичной модели.
 * Здесь проверяется ИНТЕГРАЦИЯ воркера: фактчекер (critical-тир,
 * qwen/qwen3.7-plus) падает на первичной модели → цепочка повторяет роль на
 * qwen/qwen3.6-flash → роль completed, статья ready, AgentRun.outputJson
 * несёт аддитивное поле model = реально исполнившая модель. deepseek для
 * крит-роли не вызывается. Глубокая семантика цепочки (3 попытки на звено,
 * kill-switch, thinking/max_tokens) — в юнит-тестах agent-role-execution.
 */

import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

const CRITICAL_MODEL = 'qwen/qwen3.7-plus';
const GENERATION_MODEL = 'qwen/qwen3.6-flash';
const STANDARD_MODEL = 'deepseek/deepseek-v4-flash';

// ── vi.hoisted: mock fns + журнал вызовов { roleId, model } ───────────────
const { callRouterAIMock, broadcastProgressMock, modelCalls, factcheckPrimaryFail } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  modelCalls: [],
  factcheckPrimaryFail: { enabled: false },
}));

vi.mock('../../server/agent-role-execution.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    buildSemanticCoreContext: original.buildSemanticCoreContext,
    resolveEnvNumber: original.resolveEnvNumber,
    callRouterAI: callRouterAIMock,
    // Payload-мок с ЧЕСТНЫМ tier-резолвом модели (как реальный buildRoleExecutionPayload).
    buildRoleExecutionPayload: (opts) => ({
      model: original.resolveRoleModel(original.getExecutableRole(opts?.roleId), {
        criticalModel: CRITICAL_MODEL,
        generationModel: GENERATION_MODEL,
        standardModel: STANDARD_MODEL,
      }),
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: JSON.stringify({ roleId: opts?.roleId }) },
      ],
      temperature: 0.7,
      max_tokens: 4000,
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
    // W4.1: мок цепочки — реальный tier-резолв (resolveFallbackChainModels) +
    // замоканный callRouterAI. Семантика повторяет контракт реальной функции:
    // деградация на throw / non-2xx / пустой контент; auth обрывает цепочку.
    callRouterAIWithFallbackChain: async (payload, { roleId, chainInfo } = {}) => {
      const models = [payload.model, ...original.resolveFallbackChainModels(roleId, {
        generationModel: GENERATION_MODEL,
        standardModel: STANDARD_MODEL,
      })].filter((m, idx, arr) => m && arr.indexOf(m) === idx);
      let lastError;
      let lastResult;
      for (let link = 0; link < models.length; link++) {
        const model = models[link];
        try {
          const p = model === payload.model ? payload : { ...payload, model };
          const result = await callRouterAIMock(p);
          lastResult = result;
          if ([401, 402, 403].includes(result?.status)) break;
          const content = result?.data?.choices?.[0]?.message?.content || '';
          if (result?.status >= 200 && result?.status < 300 && content.trim()) {
            if (chainInfo) {
              chainInfo.model = model;
              chainInfo.fallbackModel = link > 0 ? model : null;
              chainInfo.failedAttempts = link;
            }
            return result;
          }
        } catch (err) {
          lastError = err;
          lastResult = undefined;
        }
      }
      if (chainInfo) {
        chainInfo.model = models[models.length - 1] ?? payload.model;
        chainInfo.fallbackModel = models.length > 1 ? models[models.length - 1] : null;
        chainInfo.failedAttempts = models.length - 1;
      }
      if (lastResult) return lastResult;
      throw lastError ?? new Error('chain mock exhausted');
    },
  };
});

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
// консенсуса) → 30s-таймауты при параллельной нагрузке (изолированно — 9с,
// зелёный). Семантика цепочки моделей от источников не зависит.
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

const FAQ_SYSTEM_MARKER_RE = /SEO-копирайтер/iu;
const CANNED_FAQ_ITEMS = Array.from({ length: 10 }, (_, i) => ({
  question: `Неочевидный вопрос №${i + 1}?`,
  answer: `Краткий ответ ${i + 1}. Обоснование из двух предложений, чтобы блок выглядел реальным.`,
}));

// callRouterAI: журнал { roleId, model }; фактчекер на первичной (крит-тир)
// модели падает прод-симптомом «This operation was aborted», на qwen3.6-flash
// отвечает штатно. Прочие роли — фиксстуры.
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
    // ignore
  }
  modelCalls.push({ roleId, model: payload?.model });

  if (
    factcheckPrimaryFail.enabled &&
    roleId === 'factchecker' &&
    payload?.model === CRITICAL_MODEL
  ) {
    throw new Error('This operation was aborted');
  }

  return {
    status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify(roleOutputs[roleId] || { stub: true }) } }],
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

  await prisma.companyProfile.create({ data: { name: 'Model-chain компания', activeText: 'Профиль.' } });


});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  factcheckPrimaryFail.enabled = false;
  modelCalls.length = 0;
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

/** Свежая статья: targetLength 15000 + структура фикстуры < 3 секций → single-call путь. */
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

function makeJob(articleId) {
  return {
    data: { articleId },
    id: 'job-model-chain-' + Math.random().toString(36).slice(2),
    updateProgress: vi.fn(),
  };
}

describe('processArticleGeneration — W4.1 цепочка резервных моделей', () => {
  test('фактчекер падает на qwen3.7-plus → роль исполняет qwen3.6-flash: completed, outputJson.model, статья ready', async () => {
    factcheckPrimaryFail.enabled = true;

    const articleId = await createArticle();
    await processArticleGeneration(makeJob(articleId));

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Роль спасена цепочкой → полный конвейер, НЕ fallback-финализация.
    expect(updated.status).toBe('ready');
    expect(updated.versions.length).toBeGreaterThan(0);

    const fcRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент фактчекинга');
    expect(fcRuns).toHaveLength(1);
    expect(fcRuns[0].status).toBe('completed');
    expect(fcRuns[0].error).toBeNull();

    // Аддитивное поле model в outputJson: реально исполнившая модель.
    const output = JSON.parse(fcRuns[0].outputJson);
    expect(output.model).toBe(GENERATION_MODEL);
    expect(output.structured?.ok).toBe(true);

    // Модели реально вызывались в порядке цепочки: сначала qwen3.7-plus (упал),
    // затем qwen3.6-flash (успех). deepseek для крит-роли — никогда.
    const fcCalls = modelCalls.filter((c) => c.roleId === 'factchecker');
    expect(fcCalls.map((c) => c.model)).toEqual([CRITICAL_MODEL, GENERATION_MODEL]);
    expect(modelCalls.some((c) => c.roleId === 'factchecker' && c.model === STANDARD_MODEL)).toBe(false);
  }, 30000);

  test('без сбоя первичной модели — вызов ровно один на роль, model = первичная', async () => {
    const articleId = await createArticle();
    await processArticleGeneration(makeJob(articleId));

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { agentRuns: true },
    });
    expect(updated.status).toBe('ready');

    const fcRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент фактчекинга');
    expect(fcRuns).toHaveLength(1);
    expect(JSON.parse(fcRuns[0].outputJson).model).toBe(CRITICAL_MODEL);
    expect(modelCalls.filter((c) => c.roleId === 'factchecker')).toHaveLength(1);
  }, 30000);
});

