// Runs on SQLite + the in-process runner. Pins the
// mocked-provider happy path: topic-only article -> ready, FAQ present,
// AgentRun ledger = 11 roles + postcheck run (chain ends at humanizer).
import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ── vi.hoisted: create mock fns accessible both in vi.mock factories and in tests ──
const { callRouterAIMock, broadcastProgressMock, roleContexts } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  // seo-round TL: аддитивный захват контекстов ролей из замоканного
  // buildRoleExecutionPayload — живые швы worker→payload (siteName и др.)
  // без изменения поведения мока.
  roleContexts: [],
}));

// ── Mock agent-role-execution.mjs (where callRouterAI lives) ─────────────
// P1 (2026-08-16): воркер дергает реальный buildSemanticCoreContext (SEO-ядро)
// через dynamic import — прокидываем настоящую реализацию из модуля.
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
  // buildRoleExecutionPayload is mocked to embed roleId into payload so
  // callRouterAI can pick the right canned output per role.
  // seo-round TL: также записываем контекст роли (см. roleContexts выше).
  buildRoleExecutionPayload: (opts) => {
    roleContexts.push({ roleId: opts?.roleId, context: opts?.context });
    return {
      model: 'deepseek-v3.2',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: JSON.stringify({ roleId: opts?.roleId }) },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    };
  },
  // parseRoleExecutionResult is mocked to extract the structured data from
  // the canned content we returned in callRouterAI.
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

// ── Mock websocket (no real WS server) ───────────────────────────────────
vi.mock('../../server/websocket.mjs', () => ({
  broadcastProgress: broadcastProgressMock,
  createWebSocketServer: vi.fn(),
}));

// ── Mock queue.mjs (no ioredis connection) ───────────────────────────────
vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn() },
  sourceCrawlQueue: { add: vi.fn() },
  publicationQueue: { add: vi.fn() },
  addJob: vi.fn(),
}));

// ── Внешние поисковые провайдеры → мгновенный пустой результат ────────────
// QA-фикс (2026-08-21, вместе с W-retry): файл ходит в research-этап БЕЗ моков
// web-search бэкенды — реальные сетевые fetch (в логах «[Web-search]
// HTTP 403») делали прогоны недетерминированными: случайный тест превышал
// 30с-таймаут и падал (воспроизводилось и на HEAD, до W-retry). Мок — тот же
// паттерн, что в wall-clock-idempotency.test.mjs: research ≈ 0мс, семантика
// кейсов (wordstat/FAQ/подпись/happy-path) от источников не зависит.
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

// ── Prisma (real client → test DB, env set in vitest.config) ──────────────
const prisma = new PrismaClient();

// ── Configure callRouterAI mock to return canned outputs per role ────────
// We import fixtures dynamically inside the mock implementation so the
// vi.mock factory itself stays synchronous (required by Vitest hoisting).
//
// P4 (2026-08-16): mock also handles the FAQ call from saveFinalVersion
// (server/lib/faq-generator.mjs). Detection marker = the FAQ system prompt
// (маркер «SEO-копирайтер» в system prompt; после нейтрализации контентного
// слоя промпт гласит «Ты SEO-копирайтер и эксперт отрасли»).
// `faqScenario` switches per-test behavior:
//   'ok'            → canned JSON with 10 items (default)
//   'garbage'       → non-JSON content (LLM мусор)
//   'throw'         → simulated 502 on the FAQ call
//   'already-present' → humanizer output already carries a FAQ section
// These are plain module-scope lets: the worker is imported once (top-level
// await below), tests mutate the scenario between runs.
let faqScenario = 'ok';

const CANNED_FAQ_ITEMS = Array.from({ length: 10 }, (_, i) => ({
  question: `Неочевидный вопрос про имплантацию №${i + 1}?`,
  answer: `Краткий ответ ${i + 1}. Обоснование из двух предложений, чтобы блок выглядел реальным.`,
}));

const PREEXISTING_FAQ = [
  '',
  '## 10 необычных вопросов про Имплантация зубов',
  '',
  '### Уже вставленный ранее вопрос?',
  '',
  'Ответ уже существующей секции.',
].join('\n');

const FAQ_SYSTEM_MARKER_RE = /SEO-копирайтер/iu;

callRouterAIMock.mockImplementation(async (payload) => {
  // ── P4: служебный FAQ-вызов (не роль — roleId в payload нет) ────────────
  const systemMsg = payload?.messages?.find((m) => m.role === 'system')?.content || '';
  if (FAQ_SYSTEM_MARKER_RE.test(systemMsg)) {
    if (faqScenario === 'garbage') {
      return {
        status: 200,
        data: {
          choices: [{ message: { content: 'Извините, здесь нет JSON.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
      };
    }
    if (faqScenario === 'throw') {
      throw new Error('FAQ call: 502 fetch failed');
    }
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
  let output = roleOutputs[roleId] || { stub: true };
  // Сценарий «FAQ уже есть» (BullMQ-retry идемпотентность): финальный контент
  // берётся из humanizer.finalArticleMarkdownRu — добавляем секцию туда.
  if (faqScenario === 'already-present' && roleId === 'humanizer' && output?.finalArticleMarkdownRu) {
    output = { ...output, finalArticleMarkdownRu: output.finalArticleMarkdownRu + PREEXISTING_FAQ };
  }
  return {
    status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    },
  };
});

// ── Import the worker AFTER mocks are set up ─────────────────────────────
const { processArticleGeneration } = await import('../../server/workers/article-generation.mjs');

// ── Test data ─────────────────────────────────────────────────────────────
let articleId;

beforeAll(async () => {
  await prisma.$connect();

  // Clean slate (M2: 8-model schema — no source/service/specialist tables)
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();

  // M2: site identity = the single CompanyProfile row (author profile).
  await prisma.companyProfile.create({
    data: {
      name: 'Тестовая компания',
      activeText: 'Компания с 2010 года. Сертифицированное оборудование.',
    },
  });

  articleId = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id: articleId,
      topic: 'Имплантация зубов: гид',
      targetLength: 50000,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('processArticleGeneration — happy path', () => {
  test('runs the full 11-role pipeline (chain ends at humanizer) and produces a ready article', async () => {
    const job = {
      data: { articleId },
      id: 'test-job-happy-1',
      updateProgress: vi.fn(),
    };

    await processArticleGeneration(job);

    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: true, agentRuns: true },
    });

    expect(updated.status).toBe('ready');
    expect(updated.versions.length).toBeGreaterThan(0);

    const version = updated.versions[0];
    expect(version.contentHtml).toBeTruthy();
    expect(version.contentText.length).toBeGreaterThan(0);

    // W2.2 (2026-08-17): +1 служебный ран «Пост-проверка качества» —
    // создаётся в saveFinalVersion для каждой финальной версии.
    // M2 (§1.1): 11 ролей + постчек = 12 ранов; цепочка кончается humanizer.
    expect(updated.agentRuns.length).toBe(12);
    const roleNames = updated.agentRuns.map((r) => r.agentName);
    // M2: цепочка ролей кончается humanizer («Агент очеловечивания»).
    expect(roleNames.filter((n) => n === 'Агент очеловечивания')).toHaveLength(1);

    expect(broadcastProgressMock).toHaveBeenCalled();
    expect(job.updateProgress).toHaveBeenCalled();
  }, 30000);
});

describe('processArticleGeneration — P4 (FAQ): хвост статьи на topic-only статье', () => {
  /** Свежая topic-only статья для кейса (M2: FK источника убраны). */
  async function createTailCaseArticle() {
    const id = crypto.randomUUID();
    await prisma.article.create({
      data: {
        id,
        topic: 'Имплантация зубов: хвост статьи',
        targetLength: 50000,
      },
    });
    return id;
  }

  function makeTailJob(articleId) {
    return {
      data: { articleId },
      id: 'test-job-tail-' + Math.random().toString(36).slice(2),
      updateProgress: vi.fn(),
    };
  }

  async function getLatestVersion(articleId) {
    const updated = await prisma.article.findUnique({
      where: { id: articleId },
      include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return { article: updated, version: updated?.versions?.[0] };
  }

  beforeEach(() => {
    faqScenario = 'ok';
  });

  test('(а) FAQ вставлен: «## 10 необычных вопросов» + 10 «### », затем подпись специалиста; все 3 поля несут хвост', async () => {
    const caseArticleId = await createTailCaseArticle();
    await processArticleGeneration(makeTailJob(caseArticleId));

    const { article, version } = await getLatestVersion(caseArticleId);
    expect(article.status).toBe('ready');
    expect(version).toBeTruthy();

    const md = version.contentMarkdown;
    // FAQ-секция присутствует ровно с 10 вопросами.
    // W2/B2 (seo-round): тема — после двоеточия (именительный падеж, без «про»).
    expect(md).toContain('## 10 необычных вопросов: Имплантация зубов: хвост статьи');
    const h3 = md.split('\n').filter((l) => l.startsWith('### '));
    expect(h3).toHaveLength(10);
    expect(md.match(/## 10 необычных вопросов/g)).toHaveLength(1);

    // M2: специалиста у статьи быть не может (FK убраны) — подписи нет,
    // «null» в финальные поля не протекает.
    expect(md).not.toContain('Автор статьи');
    expect(md).not.toContain('null');

    // Все 3 поля несут хвост (единый источник markdown).
    expect(version.contentHtml).toContain('10 необычных вопросов');
    expect((version.contentHtml.match(/<h3/g) || []).length).toBe(10);
    expect(version.contentText).toContain('Неочевидный вопрос про имплантацию №1');
  }, 60000);

  test('(б-1) LLM вернула мусор → статья ready БЕЗ FAQ, подпись остаётся', async () => {
    faqScenario = 'garbage';
    const caseArticleId = await createTailCaseArticle();
    await processArticleGeneration(makeTailJob(caseArticleId));

    const { article, version } = await getLatestVersion(caseArticleId);
    expect(article.status).toBe('ready');
    expect(version.contentMarkdown).not.toMatch(/необычн[а-яё]*\s+вопрос/i);
  }, 60000);

  test('(б-2) FAQ-вызов кинул (502) → статья ready БЕЗ FAQ (fail-safe)', async () => {
    faqScenario = 'throw';
    const caseArticleId = await createTailCaseArticle();
    await processArticleGeneration(makeTailJob(caseArticleId));

    const { article, version } = await getLatestVersion(caseArticleId);
    expect(article.status).toBe('ready');
    expect(version.contentMarkdown).not.toMatch(/необычн[а-яё]*\s+вопрос/i);
  }, 60000);

  test('(в) FAQ уже присутствует в тексте → НЕ дублируется (идемпотентность retry)', async () => {
    faqScenario = 'already-present';
    const caseArticleId = await createTailCaseArticle();
    await processArticleGeneration(makeTailJob(caseArticleId));

    const { version } = await getLatestVersion(caseArticleId);
    const md = version.contentMarkdown;
    expect(md.match(/## 10 необычных вопросов/g)).toHaveLength(1);
    expect(md).toContain('Уже вставленный ранее вопрос?');
    expect(md.split('\n').filter((l) => l.startsWith('### '))).toHaveLength(1);
  }, 60000);

  // ── D6: язык материала — параметр ──
  // генерации, хранится со статьёй и доезжает до контекста ролей (промпт-
  // директива покрыта юнит-тестами agent-role-execution; здесь шов worker).
  test('(г) D6: article.language доезжает до контекста ролей; дефолт ru', async () => {
    const ruId = await createTailCaseArticle();
    await processArticleGeneration(makeTailJob(ruId));
    const ruAuthor = roleContexts.filter((c) => c.roleId === 'article-author').pop();
    expect(ruAuthor?.context?.language).toBe('ru');

    const enId = crypto.randomUUID();
    await prisma.article.create({
      data: { id: enId, topic: 'Dental implants: en language case', targetLength: 50000, language: 'en' },
    });
    roleContexts.length = 0;
    await processArticleGeneration(makeTailJob(enId));
    const enContexts = roleContexts.filter((c) => c.roleId === 'article-author');
    expect(enContexts.length).toBeGreaterThanOrEqual(1);
    expect(enContexts[enContexts.length - 1].context.language).toBe('en');
    const { article } = await getLatestVersion(enId);
    expect(article.status).toBe('ready');
  }, 60000);

  // ── seo-round TL, шов 2 (A4↔B2) + M2: ЖИВОЙ прогон worker → РЕАЛЬНЫЙ ────
  // faq-generator (не мок модуля) → перехваченный callRouterAI. Доказывает,
  // что faqContext.keywords (string[]) теперь собираются из SEO-ядра
  // semantic-strategist (mainQueryRu + кластеры + LSI) и доходят до
  // user-сообщения FAQ-вызова.
  test('(д) seo-round шов: ключи SEO-ядра (semantic-strategist) доходят до промпта FAQ', async () => {
    const caseArticleId = await createTailCaseArticle();
    await processArticleGeneration(makeTailJob(caseArticleId));

    const { article } = await getLatestVersion(caseArticleId);
    expect(article.status).toBe('ready');

    // FAQ-вызов ловим по системному маркеру + теме статьи.
    const faqCalls = callRouterAIMock.mock.calls.filter(([payload]) => {
      const systemMsg = payload?.messages?.find((m) => m.role === 'system')?.content || '';
      const userMsg = payload?.messages?.find((m) => m.role === 'user')?.content || '';
      return FAQ_SYSTEM_MARKER_RE.test(systemMsg) && userMsg.includes('Имплантация зубов: хвост статьи');
    });
    expect(faqCalls.length).toBeGreaterThanOrEqual(1);
    const faqUserMsg = faqCalls[faqCalls.length - 1][0].messages.find((m) => m.role === 'user').content;

    // Секция ключей и инструкция 40% — из B2; в шве не должны потеряться.
    expect(faqUserMsg).toContain('Ключевые фразы для вопросов (SEO-ядро статьи):');
    expect(faqUserMsg).toContain('40% вопросов');
    // Фикстура semantic-strategist: mainQueryRu + кластер + LSI.
    expect(faqUserMsg).toContain('- чистка лица');
    expect(faqUserMsg).toContain('- цена имплантации');
    expect(faqUserMsg).toContain('- титановый винт');
  }, 60000);

  // ── seo-round TL, шов 1 (B1→A) + M2: worker кладёт CompanyProfile.name в ──
  // context.siteName для роли автора (рендер в промпт доказан юнит-тестами
  // agent-role-execution). Воркер-сторона шва: контекст автора несёт имя
  // из одиночной строки CompanyProfile (crawl-источник убран).
  test('(е) seo-round шов: context.siteName автора = CompanyProfile.name', async () => {
    const caseArticleId = await createTailCaseArticle();
    await processArticleGeneration(makeTailJob(caseArticleId));

    const authorContexts = roleContexts.filter((c) => c.roleId === 'article-author');
    expect(authorContexts.length).toBeGreaterThanOrEqual(1);
    const authorContext = authorContexts[authorContexts.length - 1].context;
    // Фикстура beforeAll: CompanyProfile.name = 'Тестовая компания'.
    expect(authorContext.siteName).toBe('Тестовая компания');
  }, 60000);
});
