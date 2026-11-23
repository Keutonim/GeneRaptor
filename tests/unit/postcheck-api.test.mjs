/**
 * Unit tests для пост-чек экспозиции в API (W2.3, 2026-08-17).
 *
 * Чистые функции из server/routes/articles.mjs:
 *  - parsePostcheckReport — парсер outputJson служебного рана
 *    «Пост-проверка качества» (frozen-контракт Dev-A) с try/catch → null;
 *  - postcheckVerdict — 'ok'|'warn'|'fail'|null для лёгкого рендера;
 *  - buildNeedsReviewReason — «Качество: N проваленных правил (id…)»;
 *  - buildPostcheckFields — композит по массиву agentRuns.
 *
 * Плюс контракт GET /api/articles/:id/details через router-stack (паттерн
 * article-progress.test.mjs, Prisma замокан — юнит, без БД) и зафиксированное
 * решение W2.3: список (serializeArticle) НЕ несёт postcheck-полей.
 */
import { test, expect, describe, beforeEach, vi } from 'vitest';

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    article: { findUnique: vi.fn(), update: vi.fn() },
    // U6 (ux-fixes): GET /articles/:id/content читает версию отсюда.
    articleVersion: { findFirst: vi.fn() },
  },
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn(), getJobs: vi.fn() },
}));

import {
  articlesRouter,
  serializeArticle,
  POSTCHECK_AGENT_NAME,
  POSTCHECK_VERDICTS,
  NEEDS_REVIEW_FALLBACK_REASON,
  parsePostcheckReport,
  postcheckVerdict,
  buildNeedsReviewReason,
  buildPostcheckFields,
} from '../../server/routes/articles.mjs';
import { prisma } from '../../server/db.mjs';
// U6: РЕАЛЬНАЯ функция (мок не нужен): контракт — роут выводит contentText
// именно через неё. До мержа фикса Dev-A (перенососохраняющий вывод) эта же
// формула остаётся верной: тест ниже проверяет источник (html), а не форму
// переносов — форма подтянется фиксом A автоматически.
import { htmlToPlainText } from '../../server/lib/markdown-renderer.mjs';

const ARTICLE_ID = '11111111-1111-4111-8111-111111111111';

/** Валидный отчёт по замороженному контракту Dev-A (version:1). */
function makeReport(overrides = {}) {
  return {
    version: 1,
    verdict: 'fail',
    rules: [
      { id: 'no_h1', block: 'html', severity: 'critical', status: 'fail', message: 'H1 отсутствует' },
      { id: 'empty_faq', block: 'faq', severity: 'major', status: 'pass', message: 'FAQ на месте' },
      { id: 'thin_intro', block: 'intro', severity: 'minor', status: 'skipped', message: 'пропущен' },
    ],
    summary: { pass: 1, fail: 1, skipped: 1 },
    ...overrides,
  };
}

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    agentName: POSTCHECK_AGENT_NAME,
    status: 'completed',
    outputJson: JSON.stringify(makeReport()),
    startedAt: new Date('2026-08-17T10:00:00Z'),
    finishedAt: new Date('2026-08-17T10:00:05Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  parsePostcheckReport                                               */
/* ------------------------------------------------------------------ */

describe('parsePostcheckReport — парсер outputJson', () => {
  test('валидный JSON контракта → нормализованный отчёт (verdict/rules/summary на месте)', () => {
    const parsed = parsePostcheckReport(JSON.stringify(makeReport()));
    expect(parsed).not.toBeNull();
    expect(parsed.verdict).toBe('fail');
    expect(parsed.version).toBe(1);
    expect(parsed.rules).toHaveLength(3);
    expect(parsed.summary).toEqual({ pass: 1, fail: 1, skipped: 1 });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['пустая строка', ''],
    ['пробельная строка', '   '],
  ])('отсутствие значения (%s) → null, без исключения', (_name, value) => {
    expect(parsePostcheckReport(value)).toBeNull();
  });

  test.each([
    ['битый JSON', '{verdict:'],
    ['JSON-строка', '"ok"'],
    ['JSON-число', '42'],
    ['JSON-массив', '[{"verdict":"ok"}]'],
    ['JSON-null', 'null'],
    ['объект без verdict', JSON.stringify({ version: 1, rules: [] })],
    ['левый verdict', JSON.stringify({ version: 1, verdict: 'maybe', rules: [] })],
  ])('кривое значение (%s) → null', (_name, value) => {
    expect(parsePostcheckReport(value)).toBeNull();
  });

  test('rules не массив → нормализуется в [] (отчёт жив, парсинг не валится)', () => {
    const parsed = parsePostcheckReport(JSON.stringify({ version: 1, verdict: 'ok', rules: 'nope' }));
    expect(parsed).not.toBeNull();
    expect(parsed.rules).toEqual([]);
  });

  test('summary отсутствует/кривой → пересчитывается из rules по status', () => {
    const parsed = parsePostcheckReport(
      JSON.stringify({ version: 1, verdict: 'warn', rules: makeReport().rules, summary: 5 })
    );
    expect(parsed.summary).toEqual({ pass: 1, fail: 1, skipped: 1 });
  });

  test('version отсутствует → дефолт 1 (контракт v1)', () => {
    const parsed = parsePostcheckReport(JSON.stringify({ verdict: 'ok', rules: [], summary: { pass: 0, fail: 0, skipped: 0 } }));
    expect(parsed.version).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  postcheckVerdict                                                   */
/* ------------------------------------------------------------------ */

describe('postcheckVerdict — вычисление вердикта', () => {
  test.each(POSTCHECK_VERDICTS)('валидный verdict %s пробрасывается как есть', (verdict) => {
    expect(postcheckVerdict({ verdict })).toBe(verdict);
  });

  test.each([
    ['нет отчёта', null],
    ['пустой объект', {}],
  ])('%s → null', (_name, report) => {
    expect(postcheckVerdict(report)).toBeNull();
  });

  test('parsePostcheckReport(null) и postcheckVerdict(null) связаны: кривой JSON → null-вердикт', () => {
    expect(postcheckVerdict(parsePostcheckReport('{oops'))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  buildNeedsReviewReason                                             */
/* ------------------------------------------------------------------ */

describe('buildNeedsReviewReason — причина needs_review', () => {
  test("verdict='fail' → «Качество: N проваленных правил (список id)»", () => {
    const reason = buildNeedsReviewReason(makeReport({ verdict: 'fail' }));
    expect(reason).toBe('Качество: 1 проваленных правил (no_h1)');
  });

  test('несколько провалов → все id в скобках', () => {
    const report = makeReport({
      verdict: 'fail',
      rules: [
        { id: 'a', status: 'fail' },
        { id: 'b', status: 'fail' },
        { id: 'c', status: 'pass' },
      ],
    });
    expect(buildNeedsReviewReason(report)).toBe('Качество: 2 проваленных правил (a, b)');
  });

  test.each(['ok', 'warn'])('verdict=%s → null ( причина нужна только для fail)', (verdict) => {
    expect(buildNeedsReviewReason(makeReport({ verdict }))).toBeNull();
  });

  test('нет отчёта → null', () => {
    expect(buildNeedsReviewReason(null)).toBeNull();
  });

  test('fail без проваленных правил (рассинхрон контракта) → нейтральная строка, не null', () => {
    const reason = buildNeedsReviewReason(makeReport({ verdict: 'fail', rules: [] }));
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).not.toContain('undefined');
    expect(reason).not.toContain('NaN');
  });

  test('больше 5 проваленных id → список обрезается до 5 с хвостом «+N» (строка не раздувается)', () => {
    const rules = Array.from({ length: 8 }, (_, i) => ({ id: `rule_${i}`, status: 'fail' }));
    const reason = buildNeedsReviewReason(makeReport({ verdict: 'fail', rules }));
    expect(reason).toBe('Качество: 8 проваленных правил (rule_0, rule_1, rule_2, rule_3, rule_4 +3)');
    expect(reason.length).toBeLessThan(120);
  });
});

/* ------------------------------------------------------------------ */
/*  buildPostcheckFields — композит по agentRuns                       */
/* ------------------------------------------------------------------ */

describe('buildPostcheckFields — из массива ранов', () => {
  test('берёт ПОСЛЕДНИЙ постчек-ран (перезапуск после правки перебивает старый)', () => {
    const fresh = makeRun({
      outputJson: JSON.stringify(makeReport({ verdict: 'ok', rules: [], summary: { pass: 0, fail: 0, skipped: 0 } })),
      startedAt: new Date('2026-08-17T12:00:00Z'),
    });
    const stale = makeRun({ startedAt: new Date('2026-08-17T10:00:00Z') });
    const fields = buildPostcheckFields([stale, fresh, makeRun({ agentName: 'seo-reviewer' })]);
    expect(fields.postcheckVerdict).toBe('ok');
    expect(fields.needsReviewReason).toBeNull();
    expect(fields.postcheck.checkedAt).toBe(fresh.finishedAt);
  });

  test('служебные раны других агентов игнорируются; пустой список → все поля null', () => {
    const fields = buildPostcheckFields([makeRun({ agentName: 'factchecker' })]);
    expect(fields.postcheck).toBeNull();
    expect(fields.postcheckVerdict).toBeNull();
    expect(fields.needsReviewReason).toBeNull();
    expect(buildPostcheckFields([]).postcheck).toBeNull();
    expect(buildPostcheckFields(undefined)).toEqual({
      postcheck: null,
      postcheckVerdict: null,
      needsReviewReason: null,
    });
  });

  test('ран есть, но outputJson кривой → postcheck:null, verdict:null (не 500)', () => {
    const fields = buildPostcheckFields([makeRun({ outputJson: 'not json {' })]);
    expect(fields.postcheck).toBeNull();
    expect(fields.postcheckVerdict).toBeNull();
    expect(fields.needsReviewReason).toBeNull();
  });

  test('fail-отчёт → verdict fail + reason с id проваленных правил', () => {
    const fields = buildPostcheckFields([makeRun()]);
    expect(fields.postcheckVerdict).toBe('fail');
    expect(fields.needsReviewReason).toBe('Качество: 1 проваленных правил (no_h1)');
    // Полный отчёт (чек-лист для W3) приезжает целиком.
    expect(fields.postcheck.rules).toHaveLength(3);
  });

  /* FIX-3 (QA#1 W2): QC-needs_review с НЕ-fail постчеком раньше давал
     needsReviewReason=null — W3-UI показывал needs_review без причины.
     Фолбэк: статус needs_review → generic-причина-константа. */

  test('FIX-3: needs_review + ok-постчек → generic-фолбэк вместо null', () => {
    const okRun = makeRun({
      outputJson: JSON.stringify(makeReport({ verdict: 'ok', rules: [], summary: { pass: 0, fail: 0, skipped: 0 } })),
    });
    const fields = buildPostcheckFields([okRun], { articleStatus: 'needs_review' });
    expect(fields.postcheckVerdict).toBe('ok');
    expect(fields.needsReviewReason).toBe(NEEDS_REVIEW_FALLBACK_REASON);
    expect(typeof NEEDS_REVIEW_FALLBACK_REASON).toBe('string');
    expect(NEEDS_REVIEW_FALLBACK_REASON.length).toBeGreaterThan(0);
  });

  test('FIX-3: needs_review + warn-постчек / вообще без постчек-рана → тот же фолбэк', () => {
    const warnRun = makeRun({
      outputJson: JSON.stringify(makeReport({ verdict: 'warn', rules: [], summary: { pass: 0, fail: 0, skipped: 0 } })),
    });
    expect(buildPostcheckFields([warnRun], { articleStatus: 'needs_review' }).needsReviewReason)
      .toBe(NEEDS_REVIEW_FALLBACK_REASON);
    expect(buildPostcheckFields([], { articleStatus: 'needs_review' }).needsReviewReason)
      .toBe(NEEDS_REVIEW_FALLBACK_REASON);
  });

  test('FIX-3: needs_review + fail-постчек → причина из правил, НЕ фолбэк (специфичнее)', () => {
    expect(buildPostcheckFields([makeRun()], { articleStatus: 'needs_review' }).needsReviewReason)
      .toBe('Качество: 1 проваленных правил (no_h1)');
  });

  test('FIX-3: статус не needs_review (ready) + ok-постчек → null, фолбэк не срабатывает', () => {
    const okRun = makeRun({
      outputJson: JSON.stringify(makeReport({ verdict: 'ok', rules: [], summary: { pass: 0, fail: 0, skipped: 0 } })),
    });
    expect(buildPostcheckFields([okRun], { articleStatus: 'ready' }).needsReviewReason).toBeNull();
    // Без опции (статус неизвестен) поведение прежнее — не ломает старых вызовов.
    expect(buildPostcheckFields([okRun]).needsReviewReason).toBeNull();
  });

  /* U3 (ux-fixes 2026-08-18): колонка Article.needsReviewReason (worker
     Dev-A: wall-clock «Превышен бюджет времени генерации (25 мин)», QC-retries)
     приоритетнее причины из постчек-рана: постчек в report-режиме — только
     свидетель, статус ставит воркер. Колонка появляется в схеме параллельно —
     доступ нейтральный (undefined до prisma generate). */

  test('U3: колонка есть + fail-постчек → причина из колонки (wall-clock честнее правил)', () => {
    const fields = buildPostcheckFields([makeRun()], {
      articleStatus: 'needs_review',
      articleNeedsReviewReason: 'Превышен бюджет времени генерации (25 мин)',
    });
    // Отчёт живёт своей жизнью: вердикт fail остаётся видимым в чек-листе.
    expect(fields.postcheckVerdict).toBe('fail');
    expect(fields.needsReviewReason).toBe('Превышен бюджет времени генерации (25 мин)');
  });

  test('U3: колонка есть + ok-постчек + ready → всё равно колонка (персист — источник правды)', () => {
    const okRun = makeRun({
      outputJson: JSON.stringify(makeReport({ verdict: 'ok', rules: [], summary: { pass: 0, fail: 0, skipped: 0 } })),
    });
    expect(
      buildPostcheckFields([okRun], {
        articleStatus: 'ready',
        articleNeedsReviewReason: 'Качество не сошлось за 3 попытки',
      }).needsReviewReason
    ).toBe('Качество не сошлось за 3 попытки');
  });

  test('U3: колонка-пустышка ("" / "  ") → null, цепочка проваливается до постчека/фолбэка', () => {
    expect(
      buildPostcheckFields([makeRun()], { articleNeedsReviewReason: '' }).needsReviewReason
    ).toBe('Качество: 1 проваленных правил (no_h1)');
    expect(
      buildPostcheckFields([], {
        articleStatus: 'needs_review',
        articleNeedsReviewReason: '   ',
      }).needsReviewReason
    ).toBe(NEEDS_REVIEW_FALLBACK_REASON);
  });

  test('U3: колонки нет (undefined — до миграции Dev-A) → прежнее поведение не изменилось', () => {
    expect(
      buildPostcheckFields([makeRun()], { articleStatus: 'needs_review' }).needsReviewReason
    ).toBe('Качество: 1 проваленных правил (no_h1)');
    expect(buildPostcheckFields([makeRun()], { articleStatus: 'needs_review' }).needsReviewReason).not.toBe(
      NEEDS_REVIEW_FALLBACK_REASON
    );
  });
});

/* ------------------------------------------------------------------ */
/*  GET /api/articles/:id/details — контракт через router stack        */
/* ------------------------------------------------------------------ */

/** Вызывает GET /articles/:id/details напрямую (без HTTP-сервера). */
async function fetchDetails(article) {
  prisma.article.findUnique.mockResolvedValue(article);
  const layer = articlesRouter.stack.find((l) => l.route?.path === '/articles/:id/details');
  if (!layer) throw new Error('details route not found');
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
  await layer.route.stack[0].handle({ params: { id: ARTICLE_ID } }, res);
  return res.payload;
}

function makeDbArticle(overrides = {}) {
  return {
    id: ARTICLE_ID,
    topic: 'Тема',
    status: 'ready',
    targetLength: 20000,
    language: 'ru',
    versions: [{ characterCount: 12345 }],
    researchSources: [],
    agentRuns: [],
    ...overrides,
  };
}

describe('GET /articles/:id/details — postcheck-поля', () => {
  test('постчек-ран есть → postcheck (полный отчёт), postcheckVerdict, needsReviewReason', async () => {
    const details = await fetchDetails(makeDbArticle({ agentRuns: [makeRun()] }));
    expect(details.postcheck).not.toBeNull();
    expect(details.postcheck.verdict).toBe('fail');
    expect(details.postcheck.rules).toHaveLength(3);
    expect(details.postcheckVerdict).toBe('fail');
    expect(details.needsReviewReason).toBe('Качество: 1 проваленных правил (no_h1)');
    // Прежние поля ответа не тронуты (аддитивность).
    expect(details.language).toBe('ru');
    expect(details.agentRuns).toHaveLength(1);
    expect(details.sourcesTotal).toBe(0);
    expect(details.characterCount).toBe(12345);
  });

  test('обратная совместимость: старая статья без постчек-рана → postcheck:null, verdict:null, reason:null', async () => {
    const details = await fetchDetails(
      makeDbArticle({ agentRuns: [{ agentName: 'article-author', status: 'completed', outputJson: '{}' }] })
    );
    expect(details.postcheck).toBeNull();
    expect(details.postcheckVerdict).toBeNull();
    expect(details.needsReviewReason).toBeNull();
  });

  test('кривой outputJson у постчек-рана → postcheck:null (200, не 500)', async () => {
    const details = await fetchDetails(makeDbArticle({ agentRuns: [makeRun({ outputJson: '{{{' })] }));
    expect(details.postcheck).toBeNull();
    expect(details.postcheckVerdict).toBeNull();
    expect(details.needsReviewReason).toBeNull();
  });

  test('несколько постчек-ранов → в details попадает последний', async () => {
    const fresh = makeRun({
      outputJson: JSON.stringify(makeReport({ verdict: 'warn', rules: [], summary: { pass: 0, fail: 0, skipped: 0 } })),
      startedAt: new Date('2026-08-17T12:00:00Z'),
      finishedAt: new Date('2026-08-17T12:00:07Z'),
    });
    const details = await fetchDetails(
      makeDbArticle({ agentRuns: [makeRun(), makeRun({ agentName: 'humanizer' }), fresh] })
    );
    expect(details.postcheckVerdict).toBe('warn');
    expect(details.postcheck.checkedAt).toBe(fresh.finishedAt);
    expect(details.needsReviewReason).toBeNull();
  });

  test('FIX-3 (роут): needs_review + ok-постчек → needsReviewReason = generic-фолбэк', async () => {
    const okRun = makeRun({
      outputJson: JSON.stringify(makeReport({ verdict: 'ok', rules: [], summary: { pass: 0, fail: 0, skipped: 0 } })),
    });
    const details = await fetchDetails(makeDbArticle({ status: 'needs_review', agentRuns: [okRun] }));
    expect(details.postcheckVerdict).toBe('ok');
    expect(details.needsReviewReason).toBe(NEEDS_REVIEW_FALLBACK_REASON);
  });

  test('FIX-3 (роут): needs_review + fail-постчек → причина из правил (фолбэк не перекрывает)', async () => {
    const details = await fetchDetails(makeDbArticle({ status: 'needs_review', agentRuns: [makeRun()] }));
    expect(details.needsReviewReason).toBe('Качество: 1 проваленных правил (no_h1)');
  });

  test('U3 (роут): article.needsReviewReason (wall-clock) перекрывает постчек-причину в /details', async () => {
    const wallClock = 'Превышен бюджет времени генерации (25 мин)';
    const details = await fetchDetails(
      makeDbArticle({
        status: 'needs_review',
        needsReviewReason: wallClock,
        agentRuns: [makeRun()], // fail-постчек со своей, теперь вторичной, причиной
      })
    );
    // Чек-лист постчека не пострадал (правила — информации ради).
    expect(details.postcheckVerdict).toBe('fail');
    expect(details.postcheck.rules).toHaveLength(3);
    // Но причина статуса — из колонки, а не «Качество: 1 проваленных правил».
    expect(details.needsReviewReason).toBe(wallClock);
  });

  test('U3 (роут): колонки нет (undefined — до миграции) → причина из постчека, как раньше', async () => {
    const details = await fetchDetails(
      makeDbArticle({ status: 'needs_review', agentRuns: [makeRun()] })
    );
    expect(details.needsReviewReason).toBe('Качество: 1 проваленных правил (no_h1)');
  });
});

/* ------------------------------------------------------------------ */
/*  POST /articles/:id/start — сброс needsReviewReason в РОУТЕ (U3)    */
/* ------------------------------------------------------------------ */

/**
 * Tech-lead review (ux-fixes): /start обязан сбрасывать причину сам, не
 * полагаясь на воркер (worker сбрасывает только при первом per-role апдейте).
 * Иначе в окне «queued → подхват job» карточка деталей рендерит СТАРУЮ
 * причину (гейт needsReviewReason != null, без проверки статуса) у статьи,
 * которая уже перегенерируется.
 */
describe('POST /articles/:id/start — U3: причина сбрасывается в роуте, а не только в воркере', () => {
  async function postStart(article) {
    prisma.article.findUnique.mockResolvedValue(article);
    prisma.article.update.mockResolvedValue({ ...article, status: 'queued', needsReviewReason: null });
    const layer = articlesRouter.stack.find((l) => l.route?.path === '/articles/:id/start');
    if (!layer) throw new Error('start route not found');
    const res = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.payload = data;
        return this;
      },
    };
    await layer.route.stack[0].handle({ params: { id: ARTICLE_ID } }, res);
    return res;
  }

  test('рестарт needs_review-статьи → update с { status: queued, needsReviewReason: null } одним вызовом', async () => {
    const res = await postStart(
      makeDbArticle({
        status: 'needs_review',
        needsReviewReason: 'Превышен бюджет времени генерации (25 мин) — контент сохранён, требуется проверка',
      })
    );
    expect(res.statusCode).toBe(200);
    expect(prisma.article.update).toHaveBeenCalledTimes(1);
    expect(prisma.article.update).toHaveBeenCalledWith({
      where: { id: ARTICLE_ID },
      data: {
        status: 'queued',
        needsReviewReason: null,
      },
    });
  });

  test('запуск failed-статьи с причиной — сброс тоже происходит (единый апдейт статуса)', async () => {
    const res = await postStart(makeDbArticle({ status: 'failed', needsReviewReason: 'старая' }));
    expect(res.statusCode).toBe(200);
    expect(prisma.article.update).toHaveBeenCalledWith({
      where: { id: ARTICLE_ID },
      data: {
        status: 'queued',
        needsReviewReason: null,
      },
    });
  });
});

/* ------------------------------------------------------------------ */
/*  GET /articles/:id/content — contentText свеже-выведен из html (U6)  */
/* ------------------------------------------------------------------ */

/**
 * U6 (ux-fixes): хранимый contentText старых версий — «каша в одну строку»
 * (легаси-вывод со схлопнутыми пробелами). Роут обязан отдавать СВЕЖЕ
 * выведенный текст из contentHtml версии через РЕАЛЬНУЮ htmlToPlainText
 * (после фикса Dev-A — перенососохраняющую): ретро-полечение старых статей
 * без миграции. Хранимое поле остаётся для characterCount/совместимости.
 *
 * Форма переносов НЕ захардкожена: ассерт — источник (html) и функция
 * вывода. Когда фикс A смержится, эти же ассерты начнут проверять и
 * переносы (htmlToPlainText('<p>А</p><p>Б</p>') даст 'А\nБ' — и роут
 * обязан отдать ровно это).
 */
describe('GET /articles/:id/content — contentText из contentHtml, не из хранимого поля', () => {
  const STORED_MUSH = 'каша в одну строку без переносов';

  function makeVersion(overrides = {}) {
    return {
      title: 'Заголовок',
      description: 'Описание',
      contentHtml: '<h2>Раздел</h2><p>Первый абзац.</p><p>Второй абзац.</p>',
      contentText: STORED_MUSH,
      characterCount: 42,
      ...overrides,
    };
  }

  /** Вызывает GET /articles/:id/content напрямую (без HTTP-сервера). */
  async function fetchContent(version) {
    prisma.articleVersion.findFirst.mockResolvedValue(version);
    const layer = articlesRouter.stack.find((l) => l.route?.path === '/articles/:id/content');
    if (!layer) throw new Error('content route not found');
    const res = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.payload = data;
        return this;
      },
    };
    await layer.route.stack[0].handle({ params: { id: ARTICLE_ID } }, res);
    return res;
  }

  test('хранимая «каша» игнорируется: contentText выведен из contentHtml реальной htmlToPlainText', async () => {
    const html = '<h2>Раздел</h2><p>Первый абзац.</p><p>Второй абзац.</p>';
    const res = await fetchContent(makeVersion({ contentHtml: html }));
    expect(res.statusCode).toBe(200);
    expect(res.payload.data.contentText).not.toBe(STORED_MUSH);
    expect(res.payload.data.contentText).toBe(htmlToPlainText(html));
    expect(res.payload.data.contentText).toContain('Первый абзац');
    expect(res.payload.data.contentText).toContain('Второй абзац');
  });

  test('зависит от фикса Dev-A: перенососохраняющий htmlToPlainText → переносы доезжают до ответа', async () => {
    // Фикс A (U6) уже в дереве: реальная функция обязана сохранять переносы
    // между блочными элементами. Если её откатят — тест упадёт ЗДЕСЬ,
    // явно указывая на зависимость (а не на форму ответа роута).
    const html = '<p>Первый абзац</p><p>Второй абзац</p>';
    const expected = htmlToPlainText(html);
    expect(expected).toContain('\n');
    const res = await fetchContent(makeVersion({ contentHtml: html }));
    expect(res.payload.data.contentText).toBe(expected);
  });

  test('источник — именно html: подменили contentHtml → изменился contentText', async () => {
    const alpha = await fetchContent(makeVersion({ contentHtml: '<p>Альфа</p>' }));
    const beta = await fetchContent(makeVersion({ contentHtml: '<p>Бета</p>' }));
    expect(alpha.payload.data.contentText).not.toBe(beta.payload.data.contentText);
    expect(alpha.payload.data.contentText).toContain('Альфа');
    expect(beta.payload.data.contentText).toContain('Бета');
  });

  test('contentHtml отсутствует → фолбэк на хранимый contentText', async () => {
    const res = await fetchContent(
      makeVersion({ contentHtml: null, contentText: 'запасной текст' })
    );
    expect(res.payload.data.contentText).toBe('запасной текст');
  });

  test('нет ни html, ни текста → пустая строка (не undefined/null)', async () => {
    const res = await fetchContent(makeVersion({ contentHtml: null, contentText: null }));
    expect(res.payload.data.contentText).toBe('');
  });

  test('прочие поля ответа не тронуты: title/contentHtml/characterCount — хранимые', async () => {
    const version = makeVersion();
    const res = await fetchContent(version);
    expect(res.payload.data.title).toBe('Заголовок');
    expect(res.payload.data.h1).toBe('Заголовок');
    expect(res.payload.data.contentHtml).toBe(version.contentHtml);
    expect(res.payload.data.characterCount).toBe(42);
  });

  test('версии нет → 404 «Контент статьи не найден»', async () => {
    const res = await fetchContent(null);
    expect(res.statusCode).toBe(404);
    expect(res.payload.error).toBe('Контент статьи не найден');
  });
});

/* ------------------------------------------------------------------ */
/*  Список: needsReviewReason ЕСТЬ (U3), тяжёлых postcheck-полей НЕТ   */
/*                                                                     */
/*  Эволюция контракта W2.3 → U3 (2026-08-18): полное решение «список  */
/*  без postcheck-полей» сохраняется для отчёта (выборка outputJson    */
/*  дорогая), но needsReviewReason — дешёвая колонка Article — теперь   */
/*  пробрасывается в список (эндпоинт очереди показывает причину       */
/*  инлайн, planner A.2).                                              */
/* ------------------------------------------------------------------ */

describe('serializeArticle (список) — U3: needsReviewReason из колонки, постчека по-прежнему нет', () => {
  test('колонка пробрасывается в список как есть', () => {
    const serialized = serializeArticle({
      id: ARTICLE_ID,
      topic: 'Тема',
      status: 'needs_review',
      needsReviewReason: 'Качество не сошлось за 3 попытки',
      agentRuns: [makeRun()],
    });
    expect(serialized.needsReviewReason).toBe('Качество не сошлось за 3 попытки');
    // Прежние поля списка живы.
    expect(serialized.status).toBe('needs_review');
    expect(serialized.progress).toBe(100);
  });

  test('колонки нет / null / пустая → needsReviewReason:null (старые статьи, до миграции Dev-A)', () => {
    expect(
      serializeArticle({ id: ARTICLE_ID, topic: 'Тема', status: 'ready', agentRuns: [] })
        .needsReviewReason
    ).toBeNull();
    expect(
      serializeArticle({
        id: ARTICLE_ID,
        topic: 'Тема',
        status: 'needs_review',
        needsReviewReason: null,
        agentRuns: [],
      }).needsReviewReason
    ).toBeNull();
    expect(
      serializeArticle({
        id: ARTICLE_ID,
        topic: 'Тема',
        status: 'needs_review',
        needsReviewReason: '',
        agentRuns: [],
      }).needsReviewReason
    ).toBeNull();
  });

  test('тяжёлых postcheck-полей в списке по-прежнему нет (контракт W2.3 жив для отчёта)', () => {
    const serialized = serializeArticle({
      id: ARTICLE_ID,
      topic: 'Тема',
      status: 'needs_review',
      agentRuns: [makeRun()],
    });
    expect(serialized).not.toHaveProperty('postcheck');
    expect(serialized).not.toHaveProperty('postcheckVerdict');
  });
});
