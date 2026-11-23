// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker tests W4.2 + W4.3 + W4.5 (2026-08-17) + W-retry (2026-08-21).
 *
 * W4.2 — wall-clock бюджет прогона генерации (env GENERATION_WALL_CLOCK_MS,
 *   default 120 мин): проверяется МЕЖДУ ролями; при исчерпании на последней
 *   попытке — честный needs_review с причиной «Превышен бюджет времени
 *   генерации … попытки исчерпаны (M)» (контент частично готов) или failed,
 *   если контента нет. 0/'off' — проверка отключена. Обычная статья
 *   (в рамках бюджета) не задета.
 * W-retry (2026-08-21) — при исчерпании бюджета прогона и attempt <
 *   GENERATION_MAX_ATTEMPTS (default 2) job НЕ финализируется, а перезапускает
 *   ПРОГОН с нуля: reset как POST /start (status → queued, needsReviewReason →
 *   null), свежий context/structuredOutputs (грязный ретрай исключён),
 *   конечность цикла (ровно maxAttempts прогонов), без дублей версий/постчеков.
 * W4.3 — идемпотентность BullMQ-ретраев: повторный job после успешной
 *   финализации (ready/needs_review) выходит сразу — одна версия, один
 *   постчек-ран, ноль новых LLM-вызовов, статус стабилен.
 * W4.5 — пер-ролевой дайджест [gen-digest] в stdout в конце генерации.
 */

import { vi, test, expect, beforeAll, afterAll, describe, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { agentRoleData } from '../../server/agent-role-data.mjs';

// Прогоны через SSH-туннель к тест-БД добавляют RTT к каждому Prisma-раундтрипу,
// поэтому бюджеты и вносимые задержки масштабируем одним множителем — их
// соотношение (задержка чуть больше бюджета) сохраняется, тайминговая
// семантика тестов не меняется. Локальная БД: множитель 1 (дефолт).
const T = Number(process.env.TEST_TIMING_SCALE || 1);

const { callRouterAIMock, broadcastProgressMock, wallClockState } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  // Мутабельное состояние мока: задержка на роль (мс), large-контент флаг,
  // W-retry: slowRuns — сколько первых прогонов считать «медленными»
  // (Infinity = все — семантика исходных W4.2-тестов), runCount — счётчик
  // начатых прогонов (каждый начинается с topic-selector).
  wallClockState: { delays: {}, useLargeContent: false, slowRuns: Infinity, runCount: 0 },
}));

vi.mock('../../server/agent-role-execution.mjs', async (importOriginal) => ({
  resolveEnvNumber: (await importOriginal()).resolveEnvNumber,
  buildSemanticCoreContext: (await importOriginal()).buildSemanticCoreContext,
  callRouterAI: callRouterAIMock,
  // W4.1: цепочка моделей — сквозной мок (сбои первичных моделей здесь не
  // тестируются; см. tests/worker/model-chain.test.mjs и юнит-тесты).
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
// W4.2-тесты чувствительны ко времени: реальный research-этап (web-search
// бэкенды с сетевыми таймаутами ~4с) съедал бы бюджет до
// старта первой роли. Мок даёт детерминированный research ≈ 0мс.
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

// >500-char контент: порог спасения needs_review (как в quality-retry тестах).
const LARGE_ARTICLE_MARKDOWN = '# Большая статья для wall-clock\n\n'.padEnd(600, 'б');

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

  // W-retry: считаем начатые ПРОГОНЫ (первая роль каждого — topic-selector),
  // замедляем только первые `slowRuns` прогонов (default Infinity = все).
  if (roleId === 'topic-selector') {
    wallClockState.runCount = (wallClockState.runCount || 0) + 1;
  }
  const runIsSlow = (wallClockState.runCount || 1) <= (wallClockState.slowRuns ?? Infinity);

  // W4.2: искусственная задержка роли — продвигаем wall-clock.
  const delay = runIsSlow ? (wallClockState.delays[roleId] || 0) : 0;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

  let output = roleOutputs[roleId] || { stub: true };
  if (wallClockState.useLargeContent && ['article-author', 'factchecker', 'humanizer'].includes(roleId)) {
    const base = roleOutputs[roleId] || {};
    const field = roleId === 'article-author'
      ? 'articleMarkdownRu'
      : roleId === 'factchecker'
        ? 'checkedArticleMarkdownRu'
        : 'finalArticleMarkdownRu';
    output = { ...base, [field]: LARGE_ARTICLE_MARKDOWN };
  }

  return {
    status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    },
  };
});

const {
  processArticleGeneration,
  // W-retry: экспортированы для env-матрицы (чистые функции над process.env).
  getGenerationWallClockMs,
  getGenerationMaxAttempts,
} = await import('../../server/workers/article-generation.mjs');

let savedWallClockEnv;
let savedMaxAttemptsEnv;

beforeAll(async () => {
  await prisma.$connect();

  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  await prisma.companyProfile.create({ data: { name: 'Wall-clock компания', activeText: 'Профиль.' } });


});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  savedWallClockEnv = process.env.GENERATION_WALL_CLOCK_MS;
  delete process.env.GENERATION_WALL_CLOCK_MS;
  savedMaxAttemptsEnv = process.env.GENERATION_MAX_ATTEMPTS;
  delete process.env.GENERATION_MAX_ATTEMPTS;
  wallClockState.delays = {};
  wallClockState.useLargeContent = false;
  wallClockState.slowRuns = Infinity;
  wallClockState.runCount = 0;
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

afterEach(() => {
  if (savedWallClockEnv === undefined) delete process.env.GENERATION_WALL_CLOCK_MS;
  else process.env.GENERATION_WALL_CLOCK_MS = savedWallClockEnv;
  if (savedMaxAttemptsEnv === undefined) delete process.env.GENERATION_MAX_ATTEMPTS;
  else process.env.GENERATION_MAX_ATTEMPTS = savedMaxAttemptsEnv;
});

async function createArticle() {
  const id = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id,
      topic: 'Тема статьи ' + id.slice(0, 8),
      targetLength: 15000, // ниже chunk-порога при структуре фикстуры < 3 секций
    },
  });
  return id;
}

function makeJob(articleId) {
  return {
    data: { articleId },
    id: 'job-wall-clock-' + Math.random().toString(36).slice(2),
    updateProgress: vi.fn(),
  };
}

describe('processArticleGeneration — W4.2 wall-clock бюджет', () => {
  test('бюджет исчерпан после фактчекера → needs_review + причина + версия + постчек-ран + дайджест', async () => {
    process.env.GENERATION_WALL_CLOCK_MS = String(1500 * T);
    // W-retry: max=1 — без повторов, прежнее поведение W4.2 (исчерпание =
    // немедленная финализация). Ретрай-сценарий — в describe ниже.
    process.env.GENERATION_MAX_ATTEMPTS = '1';
    wallClockState.delays = { factchecker: 1700 * T }; // фактчекер перевалил за бюджет
    wallClockState.useLargeContent = true; // контент >500 chars → спасение

    const articleId = await createArticle();
    const digestSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let digestLines = [];

    try {
      await processArticleGeneration(makeJob(articleId));
    } finally {
      digestLines = digestSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.startsWith('[gen-digest]'));
      digestSpy.mockRestore();
    }

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Честный статус: контент частично готов → needs_review, НЕ failed/ready.
    expect(updated.status).toBe('needs_review');
    // U3: причина персистится в колонке (список очереди/карточка читают её).
    expect(updated.needsReviewReason).toMatch(/^Превышен бюджет времени генерации/);
    expect(updated.needsReviewReason).toMatch(/попытки генерации исчерпаны \(1\)/);
    expect(updated.needsReviewReason).toMatch(/контент сохранён, требуется проверка/);
    expect(updated.versions).toHaveLength(1);
    expect(updated.versions[0].contentText.length).toBeGreaterThan(500);

    // Один служебный постчек-ран (внутри saveFinalVersion).
    const postcheckRuns = updated.agentRuns.filter((r) => r.agentName === 'Пост-проверка качества');
    expect(postcheckRuns).toHaveLength(1);

    // Причина доезжает до прогресс-сообщения.
    const messages = broadcastProgressMock.mock.calls.map((call) => JSON.stringify(call));
    expect(messages.some((m) => m.includes('Превышен бюджет времени генерации'))).toBe(true);

    // Роль фактчекера завершилась штатно (упал бюджет, не LLM).
    const fcRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент фактчекинга');
    expect(fcRuns).toHaveLength(1);
    expect(fcRuns[0].status).toBe('completed');

    // W4.5: дайджест залогирован, роли до фактчекера включительно.
    expect(digestLines).toHaveLength(1);
    expect(digestLines[0]).toContain(`articleId=${articleId}`);
    expect(digestLines[0]).toMatch(/totalMs=\d+/);
    expect(digestLines[0]).toMatch(/topic-selector:\d+:ok:0:-/);
    expect(digestLines[0]).toMatch(/factchecker:\d+:ok:0:-/);
    // Ролей после фактчекера (seo-reviewer и далее) в дайджесте нет — стоп-кран.
    expect(digestLines[0]).not.toContain('seo-reviewer:');
  }, 30000);

  test('env-override: явный GENERATION_WALL_CLOCK_MS прочитан (бюджет 1000мс исчерпан до автора; обе попытки → failed)', async () => {
    process.env.GENERATION_WALL_CLOCK_MS = String(1000 * T);
    wallClockState.delays = { 'topic-selector': 1100 * T }; // первая роль перевалила бюджет

    const articleId = await createArticle();
    const digestSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let digestLines = [];

    try {
      // W-retry: max не задан → default 2 — ОБЕ попытки исчерпываются без
      // контента. Контента нет → failed + unrecoverable (BullMQ не должен
      // ретраить прогон, который уже упёрся в бюджет).
      await expect(processArticleGeneration(makeJob(articleId))).rejects.toThrow(/бюджет времени/i);
    } finally {
      digestLines = digestSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.startsWith('[gen-digest]'));
      digestSpy.mockRestore();
    }

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true },
    });
    expect(updated.status).toBe('failed');
    // U3: failed — причина сброшена (не «наследуется» из несостоявшегося рана).
    expect(updated.needsReviewReason).toBeNull();
    expect(updated.versions).toHaveLength(0); // спасать нечего

    // Дайджест фиксирует единственную исполненную роль.
    expect(digestLines).toHaveLength(1);
    expect(digestLines[0]).toMatch(/topic-selector:\d+:ok:0:-/);
    expect(digestLines[0]).not.toContain('brief-preparer:');
  }, 30000);

  test('обычная статья не задета: та же задержка при дефолтном бюджете (120 мин) → ready', async () => {
    // env удалён в beforeEach → дефолт 120 минут; задержка 1.7с в бюджет вписывается.
    wallClockState.delays = { factchecker: 1700 * T };
    wallClockState.useLargeContent = true;

    const articleId = await createArticle();
    await processArticleGeneration(makeJob(articleId));

    const updated = await prisma.article.findUnique({ where: { id: articleId } });
    expect(updated.status).toBe('ready');
    // U3: happy-path — причина пустая.
    expect(updated.needsReviewReason).toBeNull();
  }, 30000);
});

describe('processArticleGeneration — W-retry: перезапуск прогона при исчерпании wall-clock', () => {
  test('max=2: 1-я попытка исчерпана → НОВЫЙ прогон (reset queued как /start) → ready, 1 версия, роли ×2', async () => {
    process.env.GENERATION_WALL_CLOCK_MS = String(1500 * T);
    process.env.GENERATION_MAX_ATTEMPTS = '2';
    wallClockState.delays = { factchecker: 1700 * T }; // 1-я попытка переваливает бюджет
    wallClockState.slowRuns = 1; // W-retry: медленный только первый прогон — второй успевает
    wallClockState.useLargeContent = true;

    const articleId = await createArticle();
    const job = makeJob(articleId);

    // Наблюдатель статуса на старте 2-го прогона: research-этап идёт ДО цикла
    // ролей, когда reset-статус 'queued' ещё не перезаписан per-role апдейтом.
    let statusAtSecondRunStart = null;
    let searchCalls = 0;
    const { searchWeb } = await import('../../server/lib/web-search/index.mjs');
    searchWeb.mockImplementation(async () => {
      searchCalls += 1;
      if (searchCalls === 2) {
        statusAtSecondRunStart = await prisma.article.findUnique({
          where: { id: articleId },
          select: { status: true, needsReviewReason: true },
        });
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
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnText = '';
    try {
      await processArticleGeneration(job);
    } finally {
      warnText = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      warnSpy.mockRestore();
      searchWeb.mockReset().mockImplementation(async () => ({
        results: [],
        backend: 'duckduckgo',
        degraded: true,
        reason: 'network_unavailable',
        lang: 'ru',
        limit: 5,
        attempts: [],
      }));
    }

    // Reset тем же способом, что POST /start: на старте 2-го прогона статья
    // в 'queued', причина прошлого прогона сброшена.
    expect(statusAtSecondRunStart?.status).toBe('queued');
    expect(statusAtSecondRunStart?.needsReviewReason).toBeNull();

    // Предупреждение о перезапуске — с номером исчерпанной попытки.
    expect(warnText).toContain('[wall-clock] попытка 1 исчерпана — перезапуск генерации');

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Второй прогон успешен → ready; брошенный прогон НЕ сохранял версий.
    expect(updated.status).toBe('ready');
    expect(updated.needsReviewReason).toBeNull();
    expect(updated.versions).toHaveLength(1);

    // НОВЫЙ прогон = ключевые роли исполнены дважды (счётчик ×2).
    const fcRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент фактчекинга');
    expect(fcRuns).toHaveLength(2);
    const tsRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент выбора темы');
    expect(tsRuns).toHaveLength(2);

    // Постчек-ран один (только финальная финализация) — ретрай не дублирует.
    expect(updated.agentRuns.filter((r) => r.agentName === 'Пост-проверка качества')).toHaveLength(1);

    // W4.3 после ретрая: повторный job (BullMQ attempts:3) идемпотентен.
    await processArticleGeneration(job);
    const afterRerun = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });
    expect(afterRerun.status).toBe('ready');
    expect(afterRerun.versions).toHaveLength(1);
    expect(afterRerun.agentRuns.filter((r) => r.agentName === 'Пост-проверка качества')).toHaveLength(1);
  }, 30000);

  test('инвариант конечности: успешные, но медленные прогоны — обе попытки завершаются, финал needs_review «попытки исчерпаны (2)»', async () => {
    process.env.GENERATION_WALL_CLOCK_MS = String(1500 * T);
    // GENERATION_MAX_ATTEMPTS не задан → default 2; slowRuns=Infinity (default)
    // — ОБЕ попытки медленные: каждая исчерпывает бюджет и завершается стоп-краном.
    wallClockState.delays = { factchecker: 1700 * T };
    wallClockState.useLargeContent = true;

    const articleId = await createArticle();
    const job = makeJob(articleId);
    await processArticleGeneration(job); // job завершается — цикл прогонов конечен

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });
    expect(updated.status).toBe('needs_review');
    expect(updated.needsReviewReason).toMatch(/попытки генерации исчерпаны \(2\)/);
    expect(updated.needsReviewReason).toMatch(/контент сохранён, требуется проверка/);

    // Ровно ДВА прогона (не бесконечность): фактчекер и выбор темы ×2.
    const fcRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент фактчекинга');
    const tsRuns = updated.agentRuns.filter((r) => r.agentName === 'Агент выбора темы');
    expect(fcRuns).toHaveLength(2);
    expect(tsRuns).toHaveLength(2);

    // Версия и постчек — по одному, несмотря на два прогона.
    expect(updated.versions).toHaveLength(1);
    expect(updated.agentRuns.filter((r) => r.agentName === 'Пост-проверка качества')).toHaveLength(1);
  }, 30000);

  test.each(['0', 'off'])('GENERATION_WALL_CLOCK_MS=%s → проверка отключена: исчерпывающая задержка не финализирует', async (val) => {
    process.env.GENERATION_WALL_CLOCK_MS = val;
    wallClockState.delays = { factchecker: 1700 * T }; // при активном бюджете 1.5с это дало бы needs_review
    wallClockState.useLargeContent = true;

    const articleId = await createArticle();
    await processArticleGeneration(makeJob(articleId));

    const updated = await prisma.article.findUnique({ where: { id: articleId } });
    expect(updated.status).toBe('ready'); // полный конвейер, проверки бюджета не было
    expect(updated.needsReviewReason).toBeNull();
  }, 30000);
});

describe('W-retry env-матрица: getGenerationWallClockMs / getGenerationMaxAttempts', () => {
  // Чистые функции над process.env — без БД/сценариев. Матрица требований:
  // WALL_CLOCK: 0/'off' → 0 (отключен); NaN/пусто → дефолт 120 мин;
  //   >0 → активен (clamp ≥1с); MAX_ATTEMPTS: default 2, 0 → 1, NaN/пусто → 2.
  test.each([
    [undefined, 7_200_000],
    ['', 7_200_000],
    ['abc', 7_200_000], // NaN → дефолт (FIX-F2)
    ['0', 0],
    ['off', 0],
    ['OFF', 0],
    [' off ', 0],
    ['1500', 1500],
    ['7200000', 7_200_000],
    ['500', 1000], // clamp ≥1с
    ['-5000', 1000], // негатив → clamp, не «отключено» и не дефолт
  ])('GENERATION_WALL_CLOCK_MS=%j → %d', (val, expected) => {
    if (val === undefined) delete process.env.GENERATION_WALL_CLOCK_MS;
    else process.env.GENERATION_WALL_CLOCK_MS = val;
    expect(getGenerationWallClockMs()).toBe(expected);
  });

  test.each([
    [undefined, 2],
    ['', 2],
    ['abc', 2], // NaN → дефолт
    ['0', 1], // 0 трактуется как 1 (без повторов)
    ['-1', 1],
    ['1', 1],
    ['2', 2],
    ['3', 3],
    ['2.9', 2], // floor
    ['999999', 5], // кап QA-ревью: каждая попытка несёт полный wall-clock бюджет
  ])('GENERATION_MAX_ATTEMPTS=%j → %d', (val, expected) => {
    if (val === undefined) delete process.env.GENERATION_MAX_ATTEMPTS;
    else process.env.GENERATION_MAX_ATTEMPTS = val;
    expect(getGenerationMaxAttempts()).toBe(expected);
  });
});

describe('processArticleGeneration — W4.3 идемпотентность BullMQ-ретраев', () => {
  test('повторный job после ready выходит идемпотентно: одна версия, один постчек-ран, ноль новых вызовов', async () => {
    const articleId = await createArticle();
    const job = makeJob(articleId);

    // Первый прогон: полный конвейер → ready.
    await processArticleGeneration(job);

    const afterFirst = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });
    expect(afterFirst.status).toBe('ready');
    const versionsAfterFirst = afterFirst.versions.length;
    const postcheckAfterFirst = afterFirst.agentRuns.filter((r) => r.agentName === 'Пост-проверка качества').length;
    const llmCallsAfterFirst = callRouterAIMock.mock.calls.length;
    expect(versionsAfterFirst).toBe(1);
    expect(postcheckAfterFirst).toBe(1);

    // «Повторная доставка» того же job (attempts=3 в проде): guard в начале
    // processArticleGeneration должен выйти ДО перегенерации.
    await processArticleGeneration(job);

    const afterSecond = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    // Одна версия, один постчек-ран, статус стабилен, ни одного нового вызова LLM.
    expect(afterSecond.status).toBe('ready');
    expect(afterSecond.versions).toHaveLength(versionsAfterFirst);
    expect(afterSecond.agentRuns.filter((r) => r.agentName === 'Пост-проверка качества')).toHaveLength(postcheckAfterFirst);
    expect(afterSecond.agentRuns.length).toBe(afterFirst.agentRuns.length);
    expect(callRouterAIMock.mock.calls.length).toBe(llmCallsAfterFirst);
  }, 30000);

  test('needs_review — тоже финальный статус: повторный job не перегенерирует', async () => {
    process.env.GENERATION_WALL_CLOCK_MS = String(1500 * T);
    wallClockState.delays = { factchecker: 1700 * T };
    wallClockState.useLargeContent = true;

    const articleId = await createArticle();
    const job = makeJob(articleId);
    await processArticleGeneration(job);

    const afterFirst = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });
    expect(afterFirst.status).toBe('needs_review');

    await processArticleGeneration(job);

    const afterSecond = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });
    expect(afterSecond.status).toBe('needs_review');
    // U3: причина переживает идемпотентный повтор (ран не перегенерируется).
    expect(afterSecond.needsReviewReason).toMatch(/^Превышен бюджет времени генерации/);
    expect(afterSecond.versions).toHaveLength(afterFirst.versions.length);
    expect(afterSecond.agentRuns.length).toBe(afterFirst.agentRuns.length);
  }, 30000);

  test('U3: /start-рестарт — «наследованная» причина needs_review сбрасывается при новом прогоне', async () => {
    const articleId = await createArticle();
    // Симуляция: статья ушла в needs_review с причиной, затем пользователь
    // нажал /start (статус откатился в процессный) — причина прошлой
    // генерации не должна дожить до конца нового прогона.
    await prisma.article.update({
      where: { id: articleId },
      data: { status: 'factcheck', needsReviewReason: 'Превышен бюджет времени генерации (25 мин) — старая причина' },
    });

    await processArticleGeneration(makeJob(articleId));

    const updated = await prisma.article.findUnique({ where: { id: articleId } });
    expect(updated.status).toBe('ready');
    expect(updated.needsReviewReason).toBeNull();
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// H-06 (hardening): терминальный WS-кадр обязан быть терминальным, а кадры
// РОЛЕЙ — не терминальными.
//
// Симптом 1: финализация по исчерпанию бюджета времени шлёт status:'completed'
// (терминальный статус), но percent = round(step/TOTAL_STAGES*100) < 100 и
// currentStage = step — «генерация завершена» с неполной полосой прогресса.
// Нормальный путь finalizeCompleted шлёт percent:100 / currentStage:TOTAL_STAGES.
//
// Симптом 2 (глубже): завершение КАЖДОЙ роли тоже слалось со статусом
// 'completed'. Клиент считает 'completed' терминальным и переключает экран на
// готовую статью — UI уезжал на результат уже после первой роли.
//
// Проверка поведения: перехватываем реальные WS-кадры (broadcastProgress) и
// требуем, чтобы ЕДИНСТВЕННЫЙ терминальный кадр был на 100 % и на последнем
// этапе, а все кадры ролей имели статус 'running'. Тест НЕ пройдёт, если
// финализация не отправит ни одного completed-кадра (expect(...).toHaveLength(1)
// упадёт) — это защита от «теста, который проходит на пустом результате».
// ─────────────────────────────────────────────────────────────────────────────
describe('H-06 — терминальный WS-кадр needs_review (исчерпание бюджета)', () => {
  test('нуждается в проверке: percent=100, currentStage=totalStages, totalStages=длина каталога ролей', async () => {
    process.env.GENERATION_WALL_CLOCK_MS = String(1500 * T);
    process.env.GENERATION_MAX_ATTEMPTS = '1';
    wallClockState.delays = { factchecker: 1700 * T }; // фактчекер перевалил за бюджет
    wallClockState.useLargeContent = true;             // контент >500 chars → спасение в needs_review

    const articleId = await createArticle();
    const digestSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await processArticleGeneration(makeJob(articleId));
    } finally {
      digestSpy.mockRestore();
    }

    const frames = broadcastProgressMock.mock.calls
      .map((call) => call.find((arg) => arg && typeof arg === 'object' && arg.type === 'article-progress'))
      .filter(Boolean);

    // Кадры ролей — НЕ терминальные: 'completed' означает «прогон завершён».
    const terminalFrames = frames.filter((frame) => frame.status !== 'running');
    expect(terminalFrames).toHaveLength(1);

    const frame = terminalFrames[0];
    expect(frame.status).toBe('completed');
    // Терминальный кадр = 100 % и последний этап конвейера.
    expect(frame.percent).toBe(100);
    expect(frame.totalStages).toBe(agentRoleData.length);
    expect(frame.currentStage).toBe(frame.totalStages);
    // Причина остаётся в кадре — статус терминальный, а не «молчаливый» успех.
    expect(frame.message).toMatch(/needs_review/);
    // Финальный кадр — последний в потоке.
    expect(frames[frames.length - 1]).toBe(frame);

    // Кадры ролей: статус прогона 'running' и прогресс < 100 %.
    const roleFrames = frames.filter((item) => item !== frame);
    expect(roleFrames.length).toBeGreaterThan(0);
    for (const roleFrame of roleFrames) {
      expect(roleFrame.status).toBe('running');
      expect(roleFrame.percent).toBeLessThan(100);
    }
  }, 30000);
});

