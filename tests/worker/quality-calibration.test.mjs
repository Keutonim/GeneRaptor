// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker test: quality-calibration (2026-08-21).
 *
 * G1(c)/(d): mergeEmptySections в saveFinalVersion ДО sanitize/normalize —
 *   скелетные H2-секции (<100 симв. тела) сливаются в предыдущие, их
 *   нормализованные заголовки уходят в постчек-контекст (mergedHeadings) и
 *   исключаются из HEAD-SECTION-COVERAGE. Прод-данные: 6/6 статей фейлили
 *   BODY-NO-EMPTY-SECTIONS.
 *
 * G2: верхний стоп по объёму в чанк-цикле article-author — перед запросом
 *   очередного чанка считается накопленный объём склейки; пороги с резервом
 *   хвоста FIX-D2 (FAQ ~3000 + подпись ~200): soft = (target−CHUNK_TAIL_
 *   RESERVE_CHARS)/target, но не ниже 60%; hard = soft + 0.20. Без резерва
 *   soft-стоп на 95% давал финал >1.4× target (FAQ добавляется после склейки).
 *   Прод-данные: 5/6 статей 1.4–4× target.
 */

import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
// §6-A3 FIX-LEN (2026-08-25): резерв хвоста 3200 → 4000 — единая константа
// с постпроцессором; пороги ниже вычисляются от неё, не хардкодом.
import { CHUNK_TAIL_RESERVE_CHARS } from '../../server/article-post-processor.mjs';

const TOPIC = 'Чистка лица';

const { callRouterAIMock, broadcastProgressMock, calibState } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  // Управление прогоном:
  //   authorMarkdown — single-call вывод автора (скелетная секция для G1c);
  //   chunkChars[batchIndex] — объём батча для G2 (chunk-путь);
  //   authorInstructions — перехваченные user-инструкции каждого author-вызова;
  //   faqAnswerChars — длина ответа FAQ-генератора (FIX-D2: реалистичный хвост);
  //   workerAuthorDraft — агрегированный чанк-черновик из context.authorDraft
  //   (для сквозного passthrough factchecker/humanizer);
  //   shortStructure — FIX-D3: структура с 2 секциями → single-call автора
  //   даже при target ≥ CHUNK_THRESHOLD (нужно для переполненного тела).
  calibState: {
    authorMarkdown: '',
    chunkChars: [],
    authorInstructions: [],
    faqAnswerChars: 0,
    workerAuthorDraft: '',
    shortStructure: false,
  },
}));

vi.mock('../../server/agent-role-execution.mjs', async (importOriginal) => ({
  resolveEnvNumber: (await importOriginal()).resolveEnvNumber,
  buildSemanticCoreContext: (await importOriginal()).buildSemanticCoreContext,
  callRouterAI: callRouterAIMock,
  callRouterAIWithFallbackChain: async (payload, { chainInfo } = {}) => {
    const result = await callRouterAIMock(payload);
    if (chainInfo) chainInfo.model = payload.model;
    return result;
  },
  buildRoleExecutionPayload: (opts) => {
    // Захват агрегированного черновика (как в chunk-dedupe.test.mjs): его
    // воркер прокидывает в context.authorDraft ПОСЛЕ чанк-склейки.
    if (opts?.context?.authorDraft) {
      calibState.workerAuthorDraft = opts.context.authorDraft;
    }
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
// Паттерн article-generation.test.mjs: без моков реальный research-этап
// (блок keyless-бэкенда, Yandex-раунды) делает прогоны недетерминированными.
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

/** Структура для single-call G1c-кейса: 3 секции, «Показания» станет скелетом. */
function singleCallStructure() {
  return {
    h1Ru: 'Чистка лица: что это и как проходит',
    sectionsRu: [
      {
        headingRu: 'Что такое чистка лица',
        purposeRu: 'Определение процедуры',
        keyPointsRu: ['Определение'],
      },
      {
        headingRu: 'Показания',
        purposeRu: 'Когда нужна чистка',
        keyPointsRu: ['Расширенные поры'],
      },
      {
        headingRu: 'Противопоказания',
        purposeRu: 'Ограничения',
        keyPointsRu: ['Воспаления'],
      },
    ],
    logicRu: 'От простого к сложному',
    internalLinkMapRu: [],
  };
}

/** Структура из 12 секций → 6 батчей по 2 (G2, chunk-путь). */
function chunkedStructure() {
  const sections = Array.from({ length: 12 }, (_, i) => ({
    headingRu: `Секция ${String(i + 1).padStart(2, '0')}`,
    purposeRu: `Раскрыть секцию ${i + 1}`,
    keyPointsRu: [`Тезис ${i + 1}`],
  }));
  return { h1Ru: 'Чистка лица: виды процедур', sectionsRu: sections, logicRu: 'x', internalLinkMapRu: [] };
}

/** Уникальный русский текст РОВНО targetChars (для точного контроля объёма). */
function exactLengthText(prefix, targetChars) {
  const parts = [];
  let len = 0;
  let i = 0;
  while (len < targetChars) {
    i += 1;
    const s = `Абзац ${prefix} №${i} о составе и действии процедуры чистки лица для разных типов кожи.`;
    parts.push(s);
    len += s.length + 1;
  }
  return parts.join(' ').slice(0, Math.max(0, targetChars));
}

/** Markdown батча G2 ТОЧНОЙ суммарной длины chars: ведущий H1 (батч 0) + H2
 *  секций, под КАЖДЫМ заголовком своё тело (иначе нечётные секции стали бы
 *  скелетами и слились G1(c)-мержем). Последнее тело добивается до ровного
 *  итога — пороги G2 чувствительны к накопленной сумме. */
function chunkBatchMarkdown(batchIndex, sectionNumbers, chars) {
  const structure = chunkedStructure();
  const assemble = (bodies) => {
    const lines = [];
    if (batchIndex === 0) lines.push(`# ${structure.h1Ru}`, '');
    sectionNumbers.forEach((n, i) => {
      lines.push(`## ${structure.sectionsRu[n - 1].headingRu}`, '');
      lines.push(exactLengthText(`батч${batchIndex}-с${n}`, bodies[i]));
      lines.push('');
    });
    return lines.join('\n').trim();
  };
  const approx = Math.max(120, Math.floor((chars - 80) / sectionNumbers.length));
  const bodies = sectionNumbers.map(() => approx);
  const diff = chars - assemble(bodies).length;
  bodies[bodies.length - 1] = Math.max(120, bodies[bodies.length - 1] + diff);
  return assemble(bodies);
}

callRouterAIMock.mockImplementation(async (payload) => {
  const systemMsg = payload?.messages?.find((m) => m.role === 'system')?.content || '';
  if (/SEO-копирайтер/iu.test(systemMsg)) {
    // FIX-D2: ответ FAQ-генератора управляемой длины — по умолчанию короткий;
    // faqAnswerChars > 0 даёт реалистичный хвост (~10 Q/A × ~280 симв.).
    const answer =
      calibState.faqAnswerChars > 0
        ? ('Короткий честный ответ с обоснованием из практики косметолога: чистка лица подбирается по типу кожи, учитывая противопоказания и сезонность, а результат закрепляется домашним уходом. ').repeat(10).slice(0, calibState.faqAnswerChars)
        : `Короткий честный ответ с обоснованием.`;
    const items = Array.from({ length: 10 }, (_, i) => ({
      question: `Неочевидный вопрос №${i + 1} про чистку лица?`,
      answer: answer.replace('№', `№ вариант ${i + 1}:`),
    }));
    return {
      status: 200,
      data: { choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: 50, completion_tokens: 150 } },
    };
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

  if (roleId === 'structure-architect') {
    const singleCall = Boolean(calibState.authorMarkdown);
    const output = singleCall ? singleCallStructure() : chunkedStructure();
    // FIX-D3: 2 секции → single-call автора даже при target ≥ CHUNK_THRESHOLD.
    if (singleCall && calibState.shortStructure) {
      output.sectionsRu = output.sectionsRu.slice(0, 2);
    }
    return {
      status: 200,
      data: { choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } },
    };
  }

  // ── G2: chunk-вызовы автора — объём батча из calibState.chunkChars ──
  if (roleId === 'article-author' && calibState.chunkChars.length) {
    const batchIndex = calibState.authorInstructions.length; // 0-based
    const sectionNumbers = [batchIndex * 2 + 1, batchIndex * 2 + 2];
    // Захватываем финальную user-инструкцию (base + chunk/finish-надбавка).
    const lastMsg = [...payload.messages].reverse().find((m) => m.role === 'user');
    calibState.authorInstructions.push(lastMsg?.content || '');
    const markdown = chunkBatchMarkdown(batchIndex, sectionNumbers, calibState.chunkChars[batchIndex] ?? 1500);
    const output = {
      ...(batchIndex === 0 ? { titleRu: 'Чистка лица', descriptionRu: 'Описание' } : {}),
      sectionMarkdownRu: markdown,
      faqRu: [],
      claimsForReviewRu: [],
      riskyPhrasesRu: [],
    };
    return {
      status: 200,
      data: { choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 400 } },
    };
  }

  // Single-call автора: заданный markdown (G1c-кейс) или дефолтная фикстура.
  if (roleId === 'article-author') {
    const lastMsg = [...payload.messages].reverse().find((m) => m.role === 'user');
    calibState.authorInstructions.push(lastMsg?.content || '');
    const output = {
      ...roleOutputs['article-author'],
      ...(calibState.authorMarkdown ? { articleMarkdownRu: calibState.authorMarkdown } : {}),
    };
    return {
      status: 200,
      data: { choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 400 } },
    };
  }

  // Фактчекер/humanizer пропускают авторский текст насквозь (не переписывают):
  // в chunk-режиме — агрегированный черновик воркера, в single-call — заданный.
  if (roleId === 'factchecker') {
    const source = calibState.chunkChars.length
      ? calibState.workerAuthorDraft
      : calibState.authorMarkdown || roleOutputs['article-author'].articleMarkdownRu;
    const output = { ...roleOutputs.factchecker, ...(source ? { checkedArticleMarkdownRu: source } : {}) };
    return {
      status: 200,
      data: { choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } },
    };
  }
  if (roleId === 'humanizer') {
    const source = calibState.chunkChars.length
      ? calibState.workerAuthorDraft
      : calibState.authorMarkdown || roleOutputs['article-author'].articleMarkdownRu;
    const output = { ...roleOutputs.humanizer, ...(source ? { finalArticleMarkdownRu: source } : {}) };
    return {
      status: 200,
      data: { choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } },
    };
  }

  const output = roleOutputs[roleId] || { stub: true };
  return {
    status: 200,
    data: { choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } },
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

  await prisma.companyProfile.create({ data: { name: 'Calibration компания', activeText: 'Профиль.' } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  calibState.authorMarkdown = '';
  calibState.chunkChars = [];
  calibState.authorInstructions = [];
  calibState.faqAnswerChars = 0;
  calibState.workerAuthorDraft = '';
  calibState.shortStructure = false;
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

async function createArticle(targetLength) {
  const id = crypto.randomUUID();
  await prisma.article.create({
    data: { id, topic: TOPIC, targetLength },
  });
  return id;
}

async function getArticleWithReport(articleId) {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 }, agentRuns: true },
  });
  const run = article.agentRuns.find((r) => r.agentName === 'Пост-проверка качества');
  return { article, version: article.versions[0], report: run ? JSON.parse(run.outputJson) : null };
}

describe('processArticleGeneration — G1(c)/(d): слияние пустых секций до постчека', () => {
  test('скелетная секция слита: заголовок удалён, текст сохранён, coverage/empty секции зелёные', async () => {
    // Автор (и сквозной factchecker/humanizer) оставил секцию-скелет
    // «Показания» (<100 симв. тела) между здоровыми секциями.
    calibState.authorMarkdown = [
      '# Чистка лица: что это и как проходит', '',
      '## Что такое чистка лица', '',
      exactLengthText('введение', 600), '',
      '## Показания', '',
      'Расширенные поры и чёрные точки.', '', // скелет: 33 симв. < 100
      '## Противопоказания', '',
      exactLengthText('противопоказания', 600), '',
    ].join('\n');

    const articleId = await createArticle(4000); // < CHUNK_THRESHOLD → single-call
    await processArticleGeneration({ data: { articleId }, id: 'job-g1c-merge', updateProgress: vi.fn() });

    const { article, version, report } = await getArticleWithReport(articleId);
    expect(article.status).toBe('ready');
    expect(version).toBeTruthy();
    const md = version.contentMarkdown;

    // СКЕЛЕТ УШЁЛ ДО ПОСТЧЕКА: заголовка «Показания» в финале нет, текст приклеен.
    expect(md).not.toMatch(/^##\s+Показания$/m);
    expect(md).toContain('Расширенные поры и чёрные точки.');
    // Соседние секции живы.
    expect(md).toContain('## Что такое чистка лица');
    expect(md).toContain('## Противопоказания');

    // Постчек: пустых секций нет; слитый заголовок не «потерян» для coverage.
    expect(report).toBeTruthy();
    const empty = report.rules.find((r) => r.id === 'BODY-NO-EMPTY-SECTIONS');
    expect(empty.status).toBe('pass');
    const coverage = report.rules.find((r) => r.id === 'HEAD-SECTION-COVERAGE');
    expect(coverage.status).toBe('pass');
    expect(coverage.details.coverage).toBe(1);
    // mergedHeadings реально доехали до контекста: «показания» вне ожиданий.
    expect(coverage.details.expected).toBe(2); // 3 секции − 1 слитая
  }, 30000);

  test('все секции здоровые → слияние ничего не трогает (регресс)', async () => {
    calibState.authorMarkdown = [
      '# Чистка лица: что это и как проходит', '',
      '## Что такое чистка лица', '',
      exactLengthText('введение', 600), '',
      '## Показания', '',
      exactLengthText('показания', 600), '',
      '## Противопоказания', '',
      exactLengthText('противопоказания', 600), '',
    ].join('\n');

    const articleId = await createArticle(4000);
    await processArticleGeneration({ data: { articleId }, id: 'job-g1c-healthy', updateProgress: vi.fn() });

    const { version, report } = await getArticleWithReport(articleId);
    const md = version.contentMarkdown;
    for (const h of ['## Что такое чистка лица', '## Показания', '## Противопоказания']) {
      expect(md).toContain(h);
    }
    const coverage = report.rules.find((r) => r.id === 'HEAD-SECTION-COVERAGE');
    expect(coverage.status).toBe('pass');
    expect(coverage.details.expected).toBe(3); // ничего не слито
  }, 30000);
});

describe('processArticleGeneration — G2: верхний стоп по объёму в чанк-цикле', () => {
  // FIX-D2 + §6-A3: пороги с резервом хвоста (CHUNK_TAIL_RESERVE_CHARS = 4000
  // симв., импорт выше): target 12000 → soft = (12000−4000)/12000 ≈ 0.667
  // (8000), hard ≈ 0.867 (10400). target 10000 → soft 0.60 (6000 —
  // абсолютный пол CHUNK_STOP_RATIO_FLOOR), hard 0.80 (8000).

  /** Отчёт рана автора: outputJson.chunked. */
  async function authorChunkTelemetry(article) {
    const run = article.agentRuns.find((r) => r.agentName === 'Агент автора' && r.outputJson);
    return JSON.parse(run.outputJson).chunked;
  }

  test('многословный автор: 4×2630 chars при target 12000 → hard-стоп, 5 вызовов вместо 6, финальная инструкция «ЗАВЕРШЕНИЕ…НЕ нужны»', async () => {
    // §6-A3: пороги от резерва 4000 — после 3 батчей ≈7894 (<soft 8000),
    // после 4 ≈10526 ≥ hard 10400 → принудительный завершающий вызов.
    calibState.chunkChars = [2630, 2630, 2630, 2630, 2630, 2630];

    const articleId = await createArticle(12000);
    await processArticleGeneration({ data: { articleId }, id: 'job-g2-hard', updateProgress: vi.fn() });

    const { article } = await getArticleWithReport(articleId);
    expect(article.status).toBe('ready');

    // Чанк-вызовов меньше плановых 6: 4 секционных + 1 принудительный завершающий.
    expect(calibState.authorInstructions.length).toBe(5);

    // Финальная инструкция — принудительное завершение: без новых секций.
    const lastInstruction = calibState.authorInstructions[4];
    expect(lastInstruction).toMatch(/ЗАВЕРШЕНИЕ СТАТЬИ/u);
    expect(lastInstruction).toMatch(/новые секции НЕ нужны/u);
    expect(lastInstruction).not.toMatch(/Напиши секции/u); // секции НЕ запрашивались

    // Телеметрия: volumeStop=hard, batchesDone=5 из 6.
    const chunked = await authorChunkTelemetry(article);
    expect(chunked.volumeStop).toBe('hard');
    expect(chunked.batchesDone).toBe(5);
    expect(chunked.batches).toBe(6);
  }, 30000);

  test('умеренный автор: накоплено soft..hard перед батчем 5 → soft-стоп, батч 5 последний с «ПОСЛЕДНИЙ фрагмент»', async () => {
    // 4 батча × 2500 = 10000 ∈ [soft 8000, hard 10400) → soft перед батчем 5.
    calibState.chunkChars = [2500, 2500, 2500, 2500, 2000, 2000];

    const articleId = await createArticle(12000);
    await processArticleGeneration({ data: { articleId }, id: 'job-g2-soft', updateProgress: vi.fn() });

    const { article } = await getArticleWithReport(articleId);
    expect(article.status).toBe('ready');

    // Батч 5 (индекс 4) — последний: секции 9–10 ещё запрашиваются, батча 6 нет.
    expect(calibState.authorInstructions.length).toBe(5);
    const lastInstruction = calibState.authorInstructions[4];
    expect(lastInstruction).toMatch(/Напиши секции \[9-10\]/u);
    expect(lastInstruction).toMatch(/ЗАВЕРШЕНИЕ СТАТЬИ/u);
    expect(lastInstruction).toMatch(/ПОСЛЕДНИЙ фрагмент/u);

    const chunked = await authorChunkTelemetry(article);
    expect(chunked.volumeStop).toBe('soft');
    expect(chunked.batchesDone).toBe(5);
  }, 30000);

  test('лаконичный автор: 6×700 chars при target 12000 → все 6 батчей как раньше, без завершающих инструкций', async () => {
    calibState.chunkChars = [700, 700, 700, 700, 700, 700];

    const articleId = await createArticle(12000);
    await processArticleGeneration({ data: { articleId }, id: 'job-g2-no-stop', updateProgress: vi.fn() });

    const { article } = await getArticleWithReport(articleId);
    expect(article.status).toBe('ready');

    // Все 6 батчей, ни одной завершающей инструкции.
    expect(calibState.authorInstructions.length).toBe(6);
    for (const instruction of calibState.authorInstructions) {
      expect(instruction).not.toMatch(/ЗАВЕРШЕНИЕ СТАТЬИ/u);
    }
    expect(calibState.authorInstructions[5]).toMatch(/Напиши секции \[11-12\]/u);

    const chunked = await authorChunkTelemetry(article);
    expect(chunked.volumeStop).toBeNull();
    expect(chunked.batchesDone).toBe(6);
  }, 30000);

  // FIX-D2 QA: soft-стоп учитывает бюджет хвоста (FAQ ~3к + подпись): финал
  // с реально вставленным FAQ остаётся в окне BODY-LENGTH-RANGE 0.7–1.4×.
  test('FIX-D2: verbose-мок + реалистичный FAQ → финал 4×2500+FAQ ≈1.3× target 10000 → BODY-LENGTH-RANGE pass', async () => {
    // target 10000: soft 6000 (пол — §6-A3 резерв 4000), hard 8000. 3 батча =
    // 7500 ≥ 6000 → soft на 4-м вызове (он последний) → контент ≈10000.
    // FAQ (~3000) + подпись (0) → финал ≈13000 ≈ 1.3× — в окне. Без резерва
    // (старый порог 9500) было бы 5 батчей ≈12500 + 3000 = 1.55× → LENGTH fail.
    calibState.chunkChars = [2500, 2500, 2500, 2500, 2500, 2500];
    calibState.faqAnswerChars = 260; // 10 Q/A ≈ 3000 симв. — реалистичный хвост

    const articleId = await createArticle(10000);
    await processArticleGeneration({ data: { articleId }, id: 'job-g2-fixd2', updateProgress: vi.fn() });

    const { article, version, report } = await getArticleWithReport(articleId);
    expect(article.status).toBe('ready');

    // Soft-стоп на 4-м вызове (после 3 батчей 7500 ≥ 6000).
    expect(calibState.authorInstructions.length).toBe(4);
    expect(calibState.authorInstructions[3]).toMatch(/ПОСЛЕДНИЙ фрагмент/u);
    const chunked = await authorChunkTelemetry(article);
    expect(chunked.volumeStop).toBe('soft');

    // FAQ реально вставлен в финал (хвост, ради которого резерв).
    expect(version.contentMarkdown).toContain('## 10 необычных вопросов');
    expect((version.contentMarkdown.match(/<h3|### /g) || []).length).toBeGreaterThanOrEqual(10);

    // Финальный объём С хвостом — в окне 0.7–1.4× (до фикса — 1.5×+ fail).
    const lengthRule = report.rules.find((r) => r.id === 'BODY-LENGTH-RANGE');
    expect(lengthRule.status).toBe('pass');
    expect(lengthRule.details.ratio).toBeGreaterThanOrEqual(0.7);
    expect(lengthRule.details.ratio).toBeLessThanOrEqual(1.4);
  }, 30000);

  // F2(a) quality-final (2026-08-21): soft-stop инструкция обязана задавать
  // ЯВНЫЙ лимит объёма финального фрагмента — «заверши кратко» модель читала
  // как «пиши как раньше» (e2e: финальный чанк 4–5к символов).
  test('F2(a): soft-stop инструкция содержит ЯВНЫЙ лимит ~1500 символов финального фрагмента', async () => {
    // Тот же сценарий, что soft-стоп выше: 4×2500 = 10000 ∈ [soft 8000, hard 10400).
    calibState.chunkChars = [2500, 2500, 2500, 2500, 2000, 2000];

    const articleId = await createArticle(12000);
    await processArticleGeneration({ data: { articleId }, id: 'job-f2a-soft-limit', updateProgress: vi.fn() });

    const { article } = await getArticleWithReport(articleId);
    expect(article.status).toBe('ready');
    expect(calibState.authorInstructions.length).toBe(5);

    const lastInstruction = calibState.authorInstructions[4];
    expect(lastInstruction).toMatch(/ЗАВЕРШЕНИЕ СТАТЬИ/u);
    expect(lastInstruction).toMatch(/не более\s*~\s*1500 символов/u);
    expect(lastInstruction).toMatch(/одним-двумя абзацами/u);
    expect(lastInstruction).toMatch(/Не начинай новых тем/u);
  }, 30000);
});

describe('processArticleGeneration — F2(b): детерминированный трим переполненного тела', () => {
  // G2-стоп — вероятностная мера (модель может игнорировать лимит финального
  // фрагмента). Страховка — детерминированный трим в saveFinalVersion ПОСЛЕ
  // сборки/слияния/sanitize, ДО линкера/FAQ/подписи: тело >1.30× target →
  // срезаем ЦЕЛЫЕ завершающие абзацы последней контентной секции (пол 1.05×).

  test('тело 1.75× target 4000 → трим до ≤1.3×: хвостовые абзацы срезаны, заголовки целы, лог trimmedWrapParagraphs', async () => {
    // 3 секции структуры healthy; последняя — 5 абзацев, из них 4 хвостовых
    // срезаются. Итог до трима ≈6900 (1.73×), после ≈4900 ∈ [1.05×..1.3×].
    // P2-2/S2 (2026-09-18, Director option A): 2000 → 1600 в первых двух
    // секциях — детерминированный блок записи (~870 симв. до FAQ) не должен
    // выталкивать тело за потолок 1.3×; после ≈4.1k + блок ≈ 5.0k ≤ 5200.
    calibState.authorMarkdown = [
      '# Чистка лица: что это и как проходит', '',
      '## Что такое чистка лица', '',
      exactLengthText('введение', 1600), '',
      '## Показания', '',
      exactLengthText('показания', 1600), '',
      '## Противопоказания', '',
      exactLengthText('противопоказания-1', 800), '',
      exactLengthText('противопоказания-2', 500), '',
      exactLengthText('противопоказания-3', 500), '',
      exactLengthText('противопоказания-4', 500), '',
      exactLengthText('противопоказания-5', 500), '',
    ].join('\n');

    const articleId = await createArticle(4000); // single-call (< CHUNK_THRESHOLD)
    let trimCall = false;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await processArticleGeneration({ data: { articleId }, id: 'job-f2b-trim', updateProgress: vi.fn() });
      // Захватываем ДО mockRestore() — restore сбрасывает историю вызовов.
      trimCall = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes('trimmedWrapParagraphs'))
      );
    } finally {
      warnSpy.mockRestore();
    }

    const { article, version } = await getArticleWithReport(articleId);
    expect(article.versions.length).toBeGreaterThan(0);
    const md = version.contentMarkdown;

    // Заголовки и первый абзац последней секции целы.
    expect(md).toMatch(/^## Что такое чистка лица$/m);
    expect(md).toMatch(/^## Показания$/m);
    expect(md).toMatch(/^## Противопоказания$/m);
    expect(md).toContain('Абзац противопоказания-1');
    // Завершающие абзацы последней секции срезаны с конца.
    expect(md).not.toContain('противопоказания-5');
    expect(md).not.toContain('противопоказания-4');

    // Тело (до FAQ-хвоста) в окне [1.05× .. 1.30×] target.
    const body = md.split('## 10 необычных вопросов')[0];
    expect(body.length).toBeGreaterThan(4000 * 1.05);
    expect(body.length).toBeLessThanOrEqual(4000 * 1.3);

    // Лог: trimmedWrapParagraphs + до/после.
    expect(trimCall).toBe(true);
  }, 30000);

  test('тело в норме (≈1.0× target) → трим не срабатывает (регресс)', async () => {
    calibState.authorMarkdown = [
      '# Чистка лица: что это и как проходит', '',
      '## Что такое чистка лица', '',
      exactLengthText('введение', 1200), '',
      '## Показания', '',
      exactLengthText('показания', 1200), '',
      '## Противопоказания', '',
      exactLengthText('противопоказания', 1200), '',
    ].join('\n');

    const articleId = await createArticle(4000);
    let trimCall = false;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await processArticleGeneration({ data: { articleId }, id: 'job-f2b-no-trim', updateProgress: vi.fn() });
      trimCall = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes('trimmedWrapParagraphs'))
      );
    } finally {
      warnSpy.mockRestore();
    }

    const { version } = await getArticleWithReport(articleId);
    const body = version.contentMarkdown.split('## 10 необычных вопросов')[0];
    expect(body).toContain('Абзац противопоказания');
    // Все абзацы на месте — ничего не срезано.
    for (const m of ['введение', 'показания', 'противопоказания']) {
      expect(body).toContain(`Абзац ${m}`);
    }
    expect(trimCall).toBe(false);
  }, 30000);

  // FIX-D3 (QA-вердикт 2026-08-21): база трима = (target − CHUNK_TAIL_RESERVE_CHARS)
  // в ОБА порога — maxChars = base×1.30, floorChars = base×1.05. Без резерва
  // (до фикса): трим останавливался на 13к, +FAQ 3к+подпись ≈ 16.2к = 1.62× →
  // BODY-LENGTH-RANGE fail — трим ломал ровно то, что чинил.
  test('FIX-D3: target 10k, тело ~1.5×, реалистичный FAQ ~3000 → финал ≤1.4× → BODY-LENGTH-RANGE pass', async () => {
    calibState.shortStructure = true; // 2 секции → single-call при target 10k
    calibState.faqAnswerChars = 260; // 10 Q/A ≈ 3000 симв. — реалистичный хвост
    // §6-A3 (резерв 4000 → база 6000, окно трима [6300..7800]): защищённое
    // тело (введение 5500 + базовый 800 + заголовки) ≈ 6.4к ≤ 7800 → хвост
    // РЕЖЕТСЯ до окна. Тело ~15.4к (1.54× target): S1 5500 (единственный
    // абзац — защищён), S2: базовый 800 (защищён) + 10 хвостовых по 900 —
    // срезаются с конца.
    // P2-2/S2 (2026-09-18, Director option A): хвостовые абзацы 900 → 1500 —
    // трим обязан срезать ВСЕ хвосты до защищённого остатка (~6.4к), чтобы
    // тело + детерминированный блок записи (~870 симв. до FAQ) осталось
    // ≤ 7800 (база×1.3); при 900 после трима оставался один хвост → 7.3к +
    // блок = 8.2к > 7800.
    calibState.authorMarkdown = [
      '# Чистка лица: что это и как проходит', '',
      '## Что такое чистка лица', '',
      exactLengthText('введение', 5500), '',
      '## Показания', '',
      exactLengthText('показания-базовый', 800), '',
      ...Array.from({ length: 10 }, (_, i) => exactLengthText(`показания-хвост-${i + 1}`, 1500)).flatMap((p) => [p, '']),
    ].join('\n');

    const articleId = await createArticle(10000);
    await processArticleGeneration({ data: { articleId }, id: 'job-f2b-fixd3', updateProgress: vi.fn() });

    const { article, version, report } = await getArticleWithReport(articleId);
    expect(article.status).toBe('ready');

    // Тело (до FAQ-хвоста) в окне [1.05× .. 1.30×] базы (target − резерв).
    const trimBase = 10_000 - CHUNK_TAIL_RESERVE_CHARS; // §6-A3: 4000 → 6000
    const body = version.contentMarkdown.split('## 10 необычных вопросов')[0];
    expect(body.length).toBeGreaterThan(trimBase * 1.05);
    expect(body.length).toBeLessThanOrEqual(trimBase * 1.3);
    // Хвостовые абзацы срезаны с конца, защищённые целы.
    expect(body).toContain('Абзац введение');
    expect(body).toContain('Абзац показания-базовый');
    expect(body).not.toContain('показания-хвост-10');
    // FAQ реально вставлен (~3000 симв. поверх тела).
    expect(version.contentMarkdown).toContain('## 10 необычных вопросов');

    // Финал С хвостом — в окне BODY-LENGTH-RANGE 0.7–1.4× (до фикса ≈1.6× fail).
    const lengthRule = report.rules.find((r) => r.id === 'BODY-LENGTH-RANGE');
    expect(lengthRule.status).toBe('pass');
    expect(lengthRule.details.ratio).toBeLessThanOrEqual(1.4);
  }, 30000);
});

