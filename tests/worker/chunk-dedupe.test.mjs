// Runs on SQLite with the in-process runner (no external services).
/**
 * Worker test: W1.2 (2026-08-17) — дедупликация заголовков при chunk-склейке
 * article-author.
 *
 * Прод-механика (analyst-report §1.6, П1): каждый chunk-батч эмитит свой
 * `# {тема}` (сырец «Чистка лица» = 5×H1) → heading-normalizer понижает H1#2+
 * до H2 → санитайзер дедуплит только СМЕЖНЫЕ заголовки → разнесённые дубли
 * выживают (итог: тема ×4 в H2, FAQ ×3 и т.д.).
 *
 * Фикс в worker-склейке (sanitizer/normalizer не трогаем — у них свои тесты):
 *   1) strip ведущих заголовков-тем (H1/H2, нормализованный текст ≈ теме
 *      статьи) в чанках 2+ — первый чанк сохраняет H1 темы;
 *   2) страховочный дедуп НЕСМЕЖНЫХ одинаковых H2 по всему документу
 *      (keep-first, контент секции сохраняется).
 *
 * Настройка: 12 секций структуры → 6 батчей (CHUNK_SECTION_SIZE=2),
 * targetLength=10000 ≥ CHUNK_THRESHOLD → работает chunk-путь.
 */

import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

const TOPIC = 'Чистка лица';
const H1 = 'Чистка лица: виды процедур';

const { callRouterAIMock, broadcastProgressMock, chunkState } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  // Управление содержимым батчей: chunkState.headers[batchIndex] — какие
  // доп. H2 включить в батч; leadingTopic[batchIndex] — каким ведущим заголовком
  // темы начать (вариации регистра/пунктуации); midBatchH1Topic[batchIndex] —
  // вставить `# {тема}` В СЕРЕДИНУ батча (после первой секции);
  // trailingArtifact[batchIndex] — дописать в хвост батча служебную пометку
  // продолжения (U5: «*(Продолжение следует в следующем батче...)*»).
  chunkState: {
    authorBatchCalls: 0,
    leadingTopic: [],
    extraHeadings: [],
    midBatchH1Topic: [],
    trailingArtifact: [],
    lastAuthorMarkdown: '',
    // Агрегированный (уже дедуплицированный воркером) черновик автора —
    // его видит factchecker/humanizer через context.authorDraft, как в бою.
    workerAuthorDraft: '',
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
  buildRoleExecutionPayload: (opts) => {
    // Захватываем authorDraft из контекста — то, что воркер прокинул роли
    // ПОСЛЕ chunk-агрегации и дедупликации (context.authorDraft).
    if (opts?.context?.authorDraft) {
      chunkState.workerAuthorDraft = opts.context.authorDraft;
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
// Паттерн wall-clock-тестов: чанк-тесты держат 30s-таймаут, а реальный
// research-этап (Yandex-раунды консенсуса + блок keyless-бэкенда) при
// деградации сети съедал весь бюджет → каскад таймаутов (флаки, не регресс).
// Мок даёт детерминированный research ≈ 0мс — чанк-логика не зависит от него.
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

/** Структура из 12 секций → 6 батчей по 2 секции. */
function buildStructureOutput() {
  const sections = Array.from({ length: 12 }, (_, i) => ({
    headingRu: `Секция ${String(i + 1).padStart(2, '0')}`,
    purposeRu: `Раскрыть секцию ${i + 1}`,
    keyPointsRu: [`Тезис ${i + 1}`],
  }));
  return {
    h1Ru: H1,
    sectionsRu: sections,
    logicRu: 'От простого к сложному',
    internalLinkMapRu: [],
  };
}

/** Markdown одного батча: ведущий заголовок темы + H2 секций + уникальный текст. */
function buildBatchMarkdown(batchIndex, sectionNumbers, structureOutput) {
  const leading = chunkState.leadingTopic[batchIndex] ?? `# ${H1}`;
  const lines = [leading, ''];
  for (const n of sectionNumbers) {
    const heading = structureOutput.sectionsRu[n - 1].headingRu;
    // quality-calibration G1(c): тело секции ≥100 симв. — иначе скелетные
    // секции сливаются mergeEmptySections ДО постчека (это теперь инвариант
    // пайплайна) и тесты дедупа теряли бы легитимные заголовки.
    lines.push(
      `## ${heading}`, '',
      `Уникальный абзац секции ${n}: раскрываем тему ${TOPIC} подробно, вариант ${batchIndex + 1}-${n}. `,
      `Дополняем показаниями, противопоказаниями и индивидуальным подбором методики для типа кожи пациента.`, '',
    );
    // TL-ревью W1.2: опциональный H1-тема В СЕРЕДИНЕ батча (не ведущий) —
    // стрип его не видит, дедуп обязан снять ДО нормализатора.
    if (n === sectionNumbers[0] && chunkState.midBatchH1Topic[batchIndex]) {
      lines.push(`# ${H1}`, '', 'Паразитный абзац после повторного H1-темы внутри чанка, уникальный текст.', '');
    }
  }
  for (const extra of chunkState.extraHeadings[batchIndex] ?? []) {
    lines.push(`## ${extra.heading}`, '', `${extra.body}`, '');
  }
  // U5: служебная пометка продолжения в хвосте батча (прод-паттерн 00983341).
  if (chunkState.trailingArtifact[batchIndex]) {
    lines.push(chunkState.trailingArtifact[batchIndex], '');
  }
  return lines.join('\n').trim();
}

callRouterAIMock.mockImplementation(async (payload) => {
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
    const output = buildStructureOutput();
    return {
      status: 200,
      data: {
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
    };
  }

  if (roleId === 'article-author') {
    const batchIndex = chunkState.authorBatchCalls; // 0-based
    chunkState.authorBatchCalls += 1;
    const sectionNumbers = [batchIndex * 2 + 1, batchIndex * 2 + 2];
    const markdown = buildBatchMarkdown(batchIndex, sectionNumbers, buildStructureOutput());
    // Черновик автора = склейка всех батчей (как делает worker); фактчекер и
    // humanizer ниже «переписывают» именно его — иначе фикстуры имплантации
    // перекрыли бы контент чанков в extractFinalArticle.
    chunkState.lastAuthorMarkdown = chunkState.lastAuthorMarkdown
      ? `${chunkState.lastAuthorMarkdown}\n\n${markdown}`
      : markdown;
    const output = {
      ...(batchIndex === 0 ? { titleRu: H1, descriptionRu: 'Описание' } : {}),
      sectionMarkdownRu: markdown,
      faqRu: [],
      claimsForReviewRu: [],
      riskyPhrasesRu: [],
    };
    return {
      status: 200,
      data: {
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 100, completion_tokens: 400, total_tokens: 500 },
      },
    };
  }

  // Фактчекер и humanizer работают поверх агрегированного черновика автора
  // (context.authorDraft — то, что воркер собрал И дедуплицировал в W1.2).
  if (roleId === 'factchecker') {
    const output = { ...roleOutputs.factchecker, checkedArticleMarkdownRu: chunkState.workerAuthorDraft };
    return {
      status: 200,
      data: {
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
    };
  }
  if (roleId === 'humanizer') {
    const output = { ...roleOutputs.humanizer, finalArticleMarkdownRu: chunkState.workerAuthorDraft };
    return {
      status: 200,
      data: {
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
    };
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

  await prisma.companyProfile.create({ data: { name: 'Chunk-dedupe компания', activeText: 'Профиль.' } });

});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  chunkState.authorBatchCalls = 0;
  chunkState.leadingTopic = [];
  chunkState.extraHeadings = [];
  chunkState.midBatchH1Topic = [];
  chunkState.trailingArtifact = [];
  chunkState.lastAuthorMarkdown = '';
  chunkState.workerAuthorDraft = '';
  callRouterAIMock.mockClear();
  broadcastProgressMock.mockClear();
});

/** Свежая статья: 12 секций структуры, targetLength ≥ CHUNK_THRESHOLD → chunk-путь. */
async function createArticle() {
  const id = crypto.randomUUID();
  await prisma.article.create({
    data: {
      id,
      topic: TOPIC,
      targetLength: 10000,
    },
  });
  return id;
}

async function getLatestVersion(articleId) {
  const updated = await prisma.article.findUnique({
    where: { id: articleId },
    include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  return { article: updated, version: updated?.versions?.[0] };
}

describe('processArticleGeneration — W1.2: дедуп заголовков при chunk-склейке', () => {
  test('(а) 6 чанков каждый с ведущим `# Тема` → итог: 1 H1, 0 дублей темы в H2', async () => {
    // Все 6 батчей начинают с заголовка темы; батч 3 — вариация регистра и
    // пунктуации (нормализация обязана считать её той же темой).
    chunkState.leadingTopic = [
      `# ${H1}`,
      `# ${H1}`,
      `# ${H1}`,
      `# чистка лица: виды процедур!`,
      `# ${H1}`,
      `# ${H1}`,
    ];

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w12-topic-strip', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const { article, version } = await getLatestVersion(articleId);
    expect(article.status).toBe('ready');
    expect(version).toBeTruthy();

    const md = version.contentMarkdown;
    // Chunk-путь действительно работал: 6 батчей.
    expect(chunkState.authorBatchCalls).toBe(6);

    // Ровно один H1 на весь документ.
    const h1Lines = md.split('\n').filter((l) => /^# /.test(l));
    expect(h1Lines).toHaveLength(1);
    expect(h1Lines[0]).toContain('Чистка лица');

    // Тема не дублируется на уровне H2 (нормализованное сравнение: регистр,
    // пунктуация). Нормализатор без фикса понизил бы 5 лишних H1 именно сюда.
    const topicH2 = md
      .split('\n')
      .filter((l) => /^##\s+/i.test(l))
      .filter((l) => l.toLowerCase().replace(/[.,!:;—–«»()]+/g, '').replace(/\s+/g, ' ').trim().endsWith('чистка лица виды процедур'));
    expect(topicH2).toHaveLength(0);

    // Секции структуры не пострадали: все 12 уникальных H2 на месте.
    for (let i = 1; i <= 12; i++) {
      expect(md).toContain(`## Секция ${String(i).padStart(2, '0')}`);
    }
  }, 30000);

  test('(б) одинаковый H2 «Заключение» в разных чанках → остаётся первый; легитимный повтор H2 с РАЗНЫМ текстом живёт; контент не теряется', async () => {
    const long = (s) => `${s} Дополняем абзац до содержательного объёма, чтобы секция не выглядела скелетной для G1(c)-слияния.`;
    chunkState.extraHeadings = [
      [], // батч 1
      [{ heading: 'Противопоказания', body: long('Абзац о противопоказаниях общего характера, уникальный текст один.') }], // батч 2
      [], // батч 3
      [{ heading: 'Заключение', body: long('Первое заключение: итоги чанка четыре, уникальный текст.') }], // батч 4
      [{ heading: 'Противопоказания к чистке лица', body: long('Абзац о противопоказаниях именно к чистке лица, другой текст.') }], // батч 5
      [{ heading: 'Заключение', body: long('Второе заключение: дублирующий заголовок, тело должно сохраниться.') }], // батч 6
    ];

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w12-h2-dedupe', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const { version } = await getLatestVersion(articleId);
    const md = version.contentMarkdown;

    // «Заключение» ×2 в разных местах → keep-first, ровно один заголовок.
    expect((md.match(/^## Заключение$/gm) || []).length).toBe(1);

    // Легитимные РАЗНЫЕ H2 не тронуты — оба «Противопоказания…» живы.
    expect(md).toContain('## Противопоказания\n');
    expect(md).toContain('## Противопоказания к чистке лица');

    // Контент секции с удалённым дублем заголовка сохранён (теряется только
    // строка заголовка, не тело).
    expect(md).toContain('Второе заключение: дублирующий заголовок, тело должно сохраниться.');
    expect(md).toContain('Первое заключение: итоги чанка четыре, уникальный текст.');
  }, 30000);

  test('(в) TL-ревью: H1-тема В СЕРЕДИНЕ чанка снимается дедупом ДО нормализатора (иначе станет дублем H2)', async () => {
    // Стрип ведущих заголовков этот кейс не видит: `# Тема` стоит ПОСЛЕ первой
    // секции батча. Дедуп склейки обязан снять его до saveFinalVersion —
    // heading-normalizer понижает лишние H1 до H2 уже ПОСЛЕ дедупа, и без
    // фикса тема задублировалась бы в финальном markdown.
    chunkState.midBatchH1Topic = [false, true, false, true, false, false];

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w12-midchunk-h1', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const { article, version } = await getLatestVersion(articleId);
    expect(article.status).toBe('ready');
    const md = version.contentMarkdown;

    // Ровно один H1 на весь документ (ведущий H1 чанка 1; mid-chunk H1 сняты).
    const h1Lines = md.split('\n').filter((l) => /^# /.test(l));
    expect(h1Lines).toHaveLength(1);
    expect(h1Lines[0]).toContain('Чистка лица');

    // Тема не дублируется на уровне H2 (именно туда normalizer понизил бы
    // неснятые mid-chunk H1).
    const topicH2 = md
      .split('\n')
      .filter((l) => /^##\s+/.test(l))
      .map((l) => l.toLowerCase().replace(/[.,!:;—–«»()]+/g, '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.endsWith('чистка лица виды процедур'));
    expect(topicH2).toHaveLength(0);

    // Контент под снятыми H1 сохранён; все 12 секций живы.
    expect(md).toContain('Паразитный абзац после повторного H1-темы внутри чанка, уникальный текст.');
    for (let i = 1; i <= 12; i++) {
      expect(md).toContain(`## Секция ${String(i).padStart(2, '0')}`);
    }
  }, 30000);

  test('(г) QA-ревью W1: markdown-таблица в теле секции не тронута дедупом (дедуп активен в том же документе)', async () => {
    // Таблица обязана пережить strip → dedupeNonAdjacentH2 (drop по индексам
    // строк) → sanitize/normalize. Строки таблицы не похожи на заголовки, но
    // проверяем поведенчески: дедуп в этом же документе РАБОТАЕТ (дубль H2
    // снят), а таблица в финальном contentMarkdown идентична исходной.
    const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |';
    chunkState.extraHeadings = [
      [], // батч 1
      [{ heading: 'Таблица цен', body: `Сравнение в таблице:\n\n${TABLE}\n\nАбзац после таблицы, уникальный текст. Дополняем пояснением колонок и выводом по сравнению методов для пациента.` }], // батч 2
      [{ heading: 'Заключение', body: 'Первое заключение с таблицей выше, уникальный текст, дополненный обобщением сравнения методов чистки лица.' }], // батч 3
      [], // батч 4
      [], // батч 5
      [{ heading: 'Заключение', body: 'Дублирующее заключение — заголовок снимется, тело останется. Дополняем его до содержательного объёма секции отдельным предложением.' }], // батч 6
    ];

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-w12-qa-table', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const { article, version } = await getLatestVersion(articleId);
    expect(article.status).toBe('ready');
    const md = version.contentMarkdown;

    // Дедуп в этом документе действительно сработал: дубль «Заключение» снят.
    expect((md.match(/^## Заключение$/gm) || []).length).toBe(1);
    expect(md).toContain('Дублирующее заключение — заголовок снимется, тело останется.');

    // Таблица не тронута: все три строки на месте, порядок сохранён.
    expect(md).toContain('| a | b |');
    expect(md).toContain('|---|---|');
    expect(md).toContain('| 1 | 2 |');
    expect(md.indexOf('| a | b |')).toBeLessThan(md.indexOf('|---|---|'));
    expect(md.indexOf('|---|---|')).toBeLessThan(md.indexOf('| 1 | 2 |'));
    expect(md).toContain('Абзац после таблицы, уникальный текст.');

    // Секции целы.
    for (let i = 1; i <= 12; i++) {
      expect(md).toContain(`## Секция ${String(i).padStart(2, '0')}`);
    }
  }, 30000);

  test('(д-U5) чанки 1–5 заканчиваются «*(Продолжение следует в следующем батче...)*» → хвост-обрезка до join, артефактов в финале нет', async () => {
    // Прод-паттерн 00983341: модель знает про серию батчей и «вежливо»
    // оставляет мета-пометку читателю. Артефакт живёт в хвосте НЕпоследних
    // чанков; воркер обязан снять его ДО склейки (реестр chunk-artifacts).
    chunkState.trailingArtifact = [
      '*(Продолжение следует в следующем батче...)*',
      '*(Продолжение следует в следующем батче...)*',
      'Продолжение следует',
      '[Продолжение]',
      'To be continued...',
      null, // последний чанк — без артефакта (и не должен резаться)
    ];

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-u5-chunk-artifacts', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const { article, version } = await getLatestVersion(articleId);
    expect(article.status).toBe('ready');
    const md = version.contentMarkdown;

    // Chunk-путь работал: 6 батчей.
    expect(chunkState.authorBatchCalls).toBe(6);

    // Ни одного артефакта продолжения в финальном markdown.
    expect(md).not.toContain('Продолжение следует');
    expect(md).not.toContain('батче');
    expect(md).not.toContain('[Продолжение]');
    expect(md).not.toContain('To be continued');

    // Контент чанков не пострадал: все 12 секций и их абзацы живы.
    for (let i = 1; i <= 12; i++) {
      expect(md).toContain(`## Секция ${String(i).padStart(2, '0')}`);
      expect(md).toContain(`Уникальный абзац секции ${i}:`);
    }

    // Интеграционно: постчек-ран финализации не имеет fail по BODY-NO-CHUNK-ARTIFACTS.
    const postcheckRuns = await prisma.agentRun.findMany({
      where: { articleId, agentName: 'Пост-проверка качества' },
    });
    expect(postcheckRuns).toHaveLength(1);
    const report = JSON.parse(postcheckRuns[0].outputJson);
    const artifactRule = report.rules.find((r) => r.id === 'BODY-NO-CHUNK-ARTIFACTS');
    expect(artifactRule.status).toBe('pass');
  }, 30000);

  test('(е-U5) артефакт в хвосте ПОСЛЕДНЕГО чанка не режется склейкой — его снимает санитайзер финальной сборки', async () => {
    chunkState.trailingArtifact = [
      null, null, null, null, null,
      '*(Продолжение следует в следующем батче...)*', // последний чанк
    ];

    const articleId = await createArticle();
    const job = { data: { articleId }, id: 'job-u5-last-chunk', updateProgress: vi.fn() };

    await processArticleGeneration(job);

    const { article, version } = await getLatestVersion(articleId);
    expect(article.status).toBe('ready');
    // Санитайзер saveFinalVersion вычистил артефакт из финала (2-й уровень защиты).
    expect(version.contentMarkdown).not.toContain('Продолжение следует');
    expect(version.contentMarkdown).toContain('## Секция 12');
  }, 30000);
});

