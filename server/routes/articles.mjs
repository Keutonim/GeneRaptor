import { Router } from 'express';
import { prisma } from '../db.mjs';
import { articleGenerationQueue } from '../queue.mjs';
import { volumeOptions, isValidVolume } from '../lib/article-volume.mjs';
import { isValidUUID } from '../lib/validation.mjs';
// W4a: карта ролей и таймлайн этапов живут в server/lib/article-stages.mjs —
// единственный источник правды; роут реэкспортит ROLE_STATUS_MAP для старого контракта.
import { buildStageTimeline, stageTotals, ROLE_STATUS_MAP } from '../lib/article-stages.mjs';
import {
  ARTICLE_AUTHOR_AGENT_NAMES,
  classifyArticleRuns,
} from '../lib/article-runs-classifier.mjs';
// W2 (2026-08-14): единый расчёт процента готовности (single source of truth).
// W4a: articleProgressOverview() — тот же расчёт, вынесенный из маршрута.
import { articleProgress, articleProgressOverview } from '../lib/article-progress.mjs';
// Tech-lead W2-review: имя служебного рана — из ЕДИНОГО источника (lib
// Dev-A), а не дублированная строка: дрейф константы молча гасил бы все
// postcheck-поля API (lastPostcheckRun перестал бы находить ран).
import { POSTCHECK_AGENT_NAME } from '../lib/article-postcheck.mjs';
// U6 (ux-fixes 2026-08-18): contentText в GET /:id/content — свежий вывод из
// contentHtml версии (модуль Dev-A; после его U6-фикса — перенососохраняющий).
import { htmlToPlainText } from '../lib/markdown-renderer.mjs';
// Cover wave (2026-10-24): article cover generation — the whole
// flow (gates → budget → compress → generate → local store → atomic write)
// lives in the service; the route is a thin adapter that maps CoverFlowError
// onto {success:false,error,code} with the plan's HTTP statuses.
import { generateCoverForArticle, CoverFlowError, resolveCoverAvailability } from '../lib/cover-service.mjs';
// M5: the cover binary lives in the local store; this
// route serves the bytes and the delete cascade removes the files.
import { readCoverBinary, removeArticleCovers } from '../lib/cover-store.mjs';
// M5 (D9): cover availability follows the IMAGES capability of the active
// provider — not the presence of a WordPress installation. The resolution
// lives in the service (one place, one truth).

const router = Router();

function validateUUID(id) {
  return isValidUUID(id);
}

// ROLE_STATUS_MAP переехал в server/lib/article-stages.mjs (единый источник
// правды для ролей и таймлайна этапов) и реэкспортируется из этого модуля
// ниже — старый контракт импорта для тестов не сломан.

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  W2.3 (2026-08-17): пост-проверка качества — API-экспозишн           */
/*                                                                     */
/*  Frozen-контракт Dev-A (server/lib/article-postcheck.mjs), worker    */
/*  пишет его в AgentRun.outputJson, agentName='Пост-проверка качества':
/*  { version:1, verdict:'ok'|'warn'|'fail',                           */
/*    rules:[{id, block, severity, status:'pass'|'fail'|'skipped',      */
/*            message, details?}],                                      */
/*    summary:{pass,fail,skipped} }                                    */
/*                                                                     */
/*  РЕШЕНИЕ ПО ФОРМЕ API (зафиксировано для W3):                        */
/*  - список GET /api/articles: БЕЗ postcheck-полей. Полный отчёт       */
/*    тяжёлый, а «дешёвого» вердикта без выборки outputJson нет         */
/*    (дублирующую колонку в article сознательно не заводим). Иконка     */
/*    качества в очереди W3 рендерится по status='needs_review',       */
/*    чек-лист — только в детальной карточке.                           */
/*    УТОЧНЕНИЕ U3 (2026-08-18): лёгкая КОЛОНКА needsReviewReason (не   */
/*    постчек-поле, пишет worker) — пробрасывается в список: причина    */
/*    видна инлайн в очереди без единой выборки outputJson.             */
/*  - карточка GET /api/articles/:id/details: полный `postcheck` +      */
/*    лёгкие вычисляемые `postcheckVerdict` и `needsReviewReason`       */
/*    (U3: верх цепочки — колонка Article.needsReviewReason, см.        */
/*    buildPostcheckFields).                                            */
/* ------------------------------------------------------------------ */

const POSTCHECK_VERDICTS = ['ok', 'warn', 'fail'];
const NEEDS_REVIEW_REASON_MAX_IDS = 5;
// FIX-3 (QA#1 W2): needs_review бывает и с НЕ-fail постчеком (QC-loop
// исчерпал MAX_QUALITY_RETRIES и погасил fail, либо постчека нет вовсе) —
// конкретной причины из правил нет, но W3-UI обязан показать непустую
// строку, а не «needs_review без причины».
const NEEDS_REVIEW_FALLBACK_REASON = 'Требуется контроль качества (QC)';

/**
 * Распарсить outputJson постчек-рана в замороженный контракт.
 * Любая кривизна (нет значения / битый JSON / не объект / левый verdict)
 * → null: API отвечает 200 с postcheck:null, а не 500.
 * Слабая нормализация вместо отбраковки: rules не-массив → [], отсутствующий
 * summary пересчитывается из rules по status — рендер W3 не падает на
 * минимально неполных отчётах.
 */
function parsePostcheckReport(outputJson) {
  if (typeof outputJson !== 'string' || outputJson.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(outputJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!POSTCHECK_VERDICTS.includes(parsed.verdict)) return null;
  const rules = Array.isArray(parsed.rules)
    ? parsed.rules.filter((r) => r && typeof r === 'object' && !Array.isArray(r))
    : [];
  const summary =
    parsed.summary && typeof parsed.summary === 'object' && !Array.isArray(parsed.summary)
      ? {
          pass: countRules(parsed.summary.pass),
          fail: countRules(parsed.summary.fail),
          skipped: countRules(parsed.summary.skipped),
        }
      : summarizeRules(rules);
  return { ...parsed, version: parsed.version ?? 1, rules, summary };
}

function countRules(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function summarizeRules(rules) {
  const summary = { pass: 0, fail: 0, skipped: 0 };
  for (const rule of rules) {
    if (rule.status === 'pass' || rule.status === 'fail' || rule.status === 'skipped') {
      summary[rule.status] += 1;
    }
  }
  return summary;
}

/** Вердикт для лёгкого ветвления в UI: 'ok'|'warn'|'fail'|null. */
function postcheckVerdict(report) {
  return report?.verdict ?? null;
}

/**
 * Краткая причина needs_review из последнего постчека. Не-null только при
 * verdict='fail' (в enforce-режиме worker по нему выставляет статус):
 * «Качество: N проваленных правил (id, …)». Список id обрезается до 5 с
 * хвостом «+N», чтобы строка не раздувалась на много-правильных отчётах.
 */
function buildNeedsReviewReason(report) {
  if (!report || report.verdict !== 'fail') return null;
  const failedIds = report.rules
    .filter((r) => r.status === 'fail' && typeof r.id === 'string' && r.id !== '')
    .map((r) => r.id);
  if (failedIds.length === 0) return 'Качество: проверка провалена';
  const shown = failedIds.slice(0, NEEDS_REVIEW_REASON_MAX_IDS).join(', ');
  const rest =
    failedIds.length > NEEDS_REVIEW_REASON_MAX_IDS
      ? ` +${failedIds.length - NEEDS_REVIEW_REASON_MAX_IDS}`
      : '';
  return `Качество: ${failedIds.length} проваленных правил (${shown}${rest})`;
}

/** Момент времени рана для сортировки/отображения (0 = неизвестен). */
function runTimestamp(run) {
  const at = run.startedAt ?? run.finishedAt;
  if (at === null || at === undefined) return 0;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Последний постчек-ран из массива ранов (null, если не было). */
function lastPostcheckRun(agentRuns) {
  if (!Array.isArray(agentRuns)) return null;
  let last = null;
  for (const run of agentRuns) {
    if (!run || run.agentName !== POSTCHECK_AGENT_NAME) continue;
    // >= : при равных/нулевых timestamp побеждает более поздний по порядку.
    if (last === null || runTimestamp(run) >= runTimestamp(last)) last = run;
  }
  return last;
}

/**
 * Композит постчек-полей для GET /:id/details: полный отчёт + вердикт +
 * причина needs_review. Работает по уже выбранным agentRuns (include в
 * /details тянет раны целиком) — ни одного дополнительного запроса.
 *
 * FIX-3 (QA#1 W2): articleStatus='needs_review' + причина из правил null
 * (ok/warn-постчек или его отсутствие) → generic-фолбэк
 * NEEDS_REVIEW_FALLBACK_REASON. Fail-причина из правил всегда приоритетнее.
 *
 * U3 (ux-fixes 2026-08-18): НОВЫЙ верх цепочки — персистентная колонка
 * Article.needsReviewReason (worker Dev-A: wall-clock «Превышен бюджет
 * времени генерации (25 мин)», QC-retries; сброс при /start и финализации).
 * Постчек в report-режиме — свидетель, статус ставит воркер: колонка
 * честнее правил. Пустая строка приравнивается к null (не храним мусор).
 * Итоговая цепочка: колонка → причина fail-правил → generic-фолбэк.
 */
function buildPostcheckFields(
  agentRuns,
  { articleStatus, articleNeedsReviewReason } = {}
) {
  const run = lastPostcheckRun(agentRuns);
  const report = run ? parsePostcheckReport(run.outputJson) : null;
  const persistedReason =
    typeof articleNeedsReviewReason === 'string' && articleNeedsReviewReason.trim() !== ''
      ? articleNeedsReviewReason
      : null;
  return {
    postcheck: report
      ? { ...report, checkedAt: run.finishedAt ?? run.startedAt ?? null }
      : null,
    postcheckVerdict: postcheckVerdict(report),
    needsReviewReason:
      persistedReason ??
      buildNeedsReviewReason(report) ??
      (articleStatus === 'needs_review' ? NEEDS_REVIEW_FALLBACK_REASON : null),
  };
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/* ------------------------------------------------------------------ */
/*  U2 (ux-fixes 2026-08-18): валидация темы POST /articles            */
/*                                                                     */
/*  Реальные прод-кейсы (аналитик 2026-08-20): копипаст колонки         */
/*  SEO-фраз в поле темы («интимная эпиляция  эпиляция            */
/*  интимной зоны  интимная лазерная эпиляция  эпиляция интимных       */
/*  мест», статьи 00983341 / edaa1309) — тема приезжает в воркер        */
/*  уже склеенной, ломая заголовок FAQ и выбор главного запроса.        */
/*                                                                     */
/*  1. Лимит 200 символов (НЕ 120: в проде есть осмысленные темы ~150). */
/*  2. Детект склейки: нормализуем тему (lower, пунктуация → пробел,    */
/*     схлоп пробелов) и ищем повторяющиеся n-граммы — слово или        */
/*     биграмма знаменательных слов, встречающиеся ≥3 раз в разных      */
/*     позициях («слово-фраза дублируется ≥3 раз»). Повтор ×2 —         */
/*     легитимная норма («…колоноскопии … после колоноскопии»).         */
/*  3. Действие — НЕ автонормализация (молча портить тему хуже):        */
/*     400 { error, code:'topic_looks_like_concatenation',              */
/*     suggestion: первая фраза до второго повтора }. Фронт (U2-UI      */
/*     Dev-C) предлагает «Всё равно создать» — повторный POST с         */
/*     confirmConcatenatedTopic:true пропускает ТОЛЬКО этот детект,     */
/*     остальная валидация остаётся.                                   */
/* ------------------------------------------------------------------ */

const TOPIC_MAX_LENGTH = 200;
const TOPIC_CONCATENATION_CODE = 'topic_looks_like_concatenation';
const TOPIC_REPEAT_THRESHOLD = 3;
// B3: «Уточнения к теме» — опциональная строка, trim до записи; код ошибки
// переполнения фиксирован freeze-контрактом (фронт ветвится по нему).
const USER_NOTES_MAX_LENGTH = 1000;

/**
 * Служебные слова, которые в осмысленной теме повторяются легитимно
 * («уход за зубами и дёснами: чистка зубов, массаж дёсен и полоскание» —
 * «и» ×2). На коротких текстах-темах риск ложных срабатываний — только
 * от них, поэтому детект считает лишь знаменательные слова/биграммы.
 */
const TOPIC_STOPWORDS = new Set([
  // ru — предлоги/союзы/частицы/местоимения/связки
  'и', 'в', 'во', 'на', 'с', 'со', 'без', 'для', 'от', 'до', 'по', 'из', 'за',
  'к', 'ко', 'о', 'об', 'обо', 'у', 'при', 'про', 'через', 'после', 'перед',
  'между', 'около', 'под', 'над', 'или', 'но', 'а', 'да', 'же', 'бы', 'ли',
  'не', 'ни', 'тоже', 'также', 'чтобы', 'что', 'как', 'какой', 'какая',
  'какое', 'какие', 'который', 'которая', 'которое', 'которые', 'это', 'этот',
  'эта', 'эти', 'того', 'тому', 'всё', 'все', 'весь', 'вся', 'мы', 'вы', 'он',
  'она', 'они', 'оно', 'его', 'её', 'их', 'мой', 'наш', 'ваш', 'твой', 'свой',
  'есть', 'быть', 'был', 'была', 'было', 'были', 'стал', 'стала', 'стали',
  // lat
  'and', 'or', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'without', 'from', 'by', 'is', 'are', 'be', 'how', 'what', 'when', 'where',
  'why', 'who', 'which', 'this', 'that', 'these', 'those', 'it', 'its',
]);

/** Нормализация темы: lower, не-буквы/не-цифры → пробел, схлоп пробелов. */
function normalizeTopicWords(topic) {
  if (typeof topic !== 'string') return [];
  return topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Повторяющиеся n-граммы темы: униграммы (без служебных слов) и биграммы
 * соседних слов (оба знаменательные), встречающиеся ≥ TOPIC_REPEAT_THRESHOLD
 * раз. Возвращает [{ ngram, positions }] (позиции — индексы слов в
 * нормализованном массиве), либо [].
 */
function repeatingTopicNgrams(topic) {
  const words = normalizeTopicWords(topic);
  const positionsByNgram = new Map();
  const track = (ngram, index) => {
    const positions = positionsByNgram.get(ngram);
    if (positions) positions.push(index);
    else positionsByNgram.set(ngram, [index]);
  };
  words.forEach((word, i) => {
    const isContent = !TOPIC_STOPWORDS.has(word);
    if (isContent) track(word, i);
    const next = words[i + 1];
    if (isContent && next && !TOPIC_STOPWORDS.has(next)) track(`${word} ${next}`, i);
  });
  return [...positionsByNgram.entries()]
    .filter(([, positions]) => positions.length >= TOPIC_REPEAT_THRESHOLD)
    .map(([ngram, positions]) => ({ ngram, positions }));
}

/** Эвристика «тема похожа на склейку поисковых фраз» (см. блок U2 выше). */
function looksLikeConcatenatedTopic(topic) {
  return repeatingTopicNgrams(topic).length > 0;
}

/**
 * Подсказка «оставьте одну фразу»: слова от начала темы до САМОГО РАННЕГО
 * второго повтора любой повторяющейся n-граммы. У реальных SEO-склеек
 * это ровно первая фраза: «интимная эпиляция эпиляция интимной зоны …» →
 * «интимная эпиляция». Крайние служебные слова обрезаются. '' если тема
 * не похожа на склейку.
 */
function buildTopicSuggestion(topic) {
  const repeated = repeatingTopicNgrams(topic);
  if (repeated.length === 0) return '';
  const words = normalizeTopicWords(topic);
  // positions[1] существует всегда (порог ≥3); ≥1, поэтому фраза не пуста.
  const cut = Math.min(...repeated.map(({ positions }) => positions[1]));
  const phrase = words.slice(0, Math.max(1, cut));
  while (phrase.length > 1 && TOPIC_STOPWORDS.has(phrase[0])) phrase.shift();
  while (phrase.length > 1 && TOPIC_STOPWORDS.has(phrase[phrase.length - 1])) phrase.pop();
  return phrase.join(' ');
}

function success(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, message, status = 400) {
  return res.status(status).json({ success: false, error: message });
}

/**
 * Cover wave: local fail() carries no machine code, and the cover
 * contract pins a code on EVERY error body — own helper, same envelope shape
 * as the WP/TG inline errors ({success:false, error, code}).
 */
function failCover(res, code, message, status = 400) {
  return res.status(status).json({ success: false, error: message, code });
}

/**
 * Привести запись Article к формату ArticleDraft, который ожидает UI.
 *
 * T4: бейджи классифицируются чистой функцией classifyArticleRuns по
 * article.agentRuns (узкая проекция { agentName, status, startedAt, error }):
 *  - hasFallback (legacy) — любой run с 'fallback' в error;
 *  - hasTemplateContent — текст статьи реально является шаблоном
 *    (fallback был И автор ни разу не отработал чисто);
 *  - generationStartedAt — минимальный startedAt (T5, таймер очереди).
 * Для списка статей agentRuns приходит отфильтрованным (только fallback-раны
 * и успешные раны автора), поэтому там min(startedAt) передаётся отдельно
 * через options.generationStartedAt (aggregate по ВСЕМ ранам страницы).
 */
function serializeArticle(article, { generationStartedAt } = {}) {
  const { hasFallback, hasTemplateContent, generationStartedAt: firstRunStartedAt } =
    classifyArticleRuns(article.agentRuns);
  return {
    id: article.id,
    topic: article.topic,
    targetLength: article.targetLength,
    status: article.status,
    // D6: material language of the article (ru | en).
    language: article.language || 'ru',
    // B3: owner clarifications (NULL = none) — the UI edit flow re-reads them.
    userNotes: article.userNotes ?? null,
    hasFallback,
    hasTemplateContent,
    generationStartedAt: generationStartedAt ?? firstRunStartedAt ?? null,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    // W2: аддитивно, nullable (error/неизвестный статус → null). Число — из
    // общего хелпера, тот же источник, что и у /:id/progress.
    progress: articleProgress(article.status),
    // U3 (ux-fixes 2026-08-18): персистентная причина needs_review из
    // колонки Article (worker Dev-A: wall-clock/QC). Доступ нейтральный —
    // колонка появляется в схеме параллельно: до `prisma generate` поля
    // нет → undefined → null. `||` (не `??`): пустую строку тоже нормализуем
    // в null. Дешёвая колонка — контракт W2.3 «список без postcheck-полей»
    // жив (тяжёлых выборок outputJson нет), см. блок «РЕШЕНИЕ ПО ФОРМЕ API».
    needsReviewReason: article.needsReviewReason || null,
    // W2.3: постчек-полей в списке НЕТ (см. блок «РЕШЕНИЕ ПО ФОРМЕ API»
    // выше): полный отчёт тяжёлый, дешёвого вердикта без выборки outputJson
    // не существует. Иконка качества в очереди — по status='needs_review',
    // чек-лист — в GET /:id/details.
    // Cover checkbox wave: состояние фазы обложки для бейджа в
    // колонке «Статус» и гейта поллинга очереди. Нейтральный доступ —
    // до `prisma generate` полей нет → undefined → null. coverUrl в список НЕ
    // тащим (он доступен в /content).
    coverRequested: article.coverRequested ?? false,
    coverStatus: article.coverStatus ?? null,
    coverSkipReason: article.coverSkipReason ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  0. GET /api/articles                                               */
/* ------------------------------------------------------------------ */

router.get('/articles', async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};

    // excludeStatus (CSV →
    // notIn) применяется ВСЕГДА, когда параметр передан (Guard B): при
    // непустом status, при ПУСТОМ CSV (?status=, — раньше фильтр терялся:
    // ветка if(status) входила, statuses.length===0, where.status не
    // выставлялся) и без status вовсе. Prisma принимает { in, notIn } в
    // одном фильтре. Пустой CSV по status НЕ даёт in:[] — это опустошило бы
    // выдачу.
    const statuses =
      status && typeof status === 'string'
        ? status.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const excludedStatuses =
      typeof req.query.excludeStatus === 'string'
        ? req.query.excludeStatus.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const statusFilter = {};
    if (statuses.length > 0) statusFilter.in = statuses;
    if (excludedStatuses.length > 0) statusFilter.notIn = excludedStatuses;
    if (statuses.length > 0 || excludedStatuses.length > 0) {
      where.status = statusFilter;
    }
    // Server-side pagination. Default page size keeps existing clients fast;
    // clients can request more via ?limit=&offset= (or ?page=&pageSize=).
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT = 500;
    let limit = DEFAULT_LIMIT;
    let offset = 0;
    if (req.query.limit != null) {
      limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    } else if (req.query.pageSize != null) {
      limit = Math.min(Math.max(parseInt(req.query.pageSize, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    }
    if (req.query.offset != null) {
      offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    } else if (req.query.page != null) {
      offset = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * limit;
    }

    const [articles, total] = await Promise.all([
      prisma.article.findMany({
        where,
        include: {
          versions: { orderBy: { createdAt: 'desc' }, take: 1 },
          // T4: для классификации бейджей нужны (a) все fallback-раны и
          // (b) все УСПЕШНЫЕ раны автора (чистый автор-ран гасит ложный бейдж
          // «Шаблон» — сценарий B/E). Проекция узкая, фильтр отбрасывает всё
          // остальное, поэтому payload сопоставим со старой take:1-пробой:
          // у статьи без fallback-ов приходит максимум один маленький ряд
          // (успешный автор-ран, error: null).
          agentRuns: {
            where: {
              OR: [
                // SQLite has no mode:'insensitive' (PG-only) — LIKE is
                // case-insensitive for ASCII by default there; the classifier
                // (article-runs-classifier) re-checks case-insensitively anyway.
                { error: { contains: 'fallback' } },
                {
                  // FIX-6: успешный автор = completed И пустой error (null ИЛИ '').
                  // Классификатор считает '' успехом — фильтр обязан соглашаться,
                  // иначе список и детальная разойдутся на бейдже «Шаблон».
                  // (null в Prisma надёжнее фильтруется через OR, не через in.)
                  AND: [
                    { agentName: { in: ARTICLE_AUTHOR_AGENT_NAMES } },
                    { status: 'completed' },
                    { OR: [{ error: null }, { error: '' }] },
                  ],
                },
              ],
            },
            select: { agentName: true, status: true, startedAt: true, error: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.article.count({ where }),
    ]);

    // T5: generationStartedAt — min(startedAt) по ВСЕМ ранам статей страницы,
    // одним groupBy (include выше отфильтрован и минимума по всем ранам не даст).
    const pageArticleIds = articles.map((a) => a.id);
    const startedAtRows = pageArticleIds.length
      ? await prisma.agentRun.groupBy({
          by: ['articleId'],
          where: { articleId: { in: pageArticleIds }, startedAt: { not: null } },
          _min: { startedAt: true },
        })
      : [];
    const generationStartedAtById = new Map(
      startedAtRows.map((row) => [row.articleId, row._min.startedAt ?? null])
    );
    const serializeListItem = (article) =>
      serializeArticle(article, {
        generationStartedAt: generationStartedAtById.get(article.id) ?? null,
      });

    // Backwards-compatible response shape:
    // - If client requested pagination explicitly → return { items, total, limit, offset }
    // - Otherwise (legacy clients) → return a flat array
    const wantsPaginated =
      req.query.limit != null || req.query.offset != null ||
      req.query.page != null || req.query.pageSize != null;
    if (wantsPaginated) {
      return success(res, {
        items: articles.map(serializeListItem),
        total,
        limit,
        offset,
      });
    }
    return success(res, articles.map(serializeListItem));
  } catch (err) {
    console.error('[ArticlesRouter] GET /articles error:', err);
    return fail(res, 'Не удалось получить статьи', 500);
  }
});

/* ------------------------------------------------------------------ */
/*  1. POST /api/articles                                              */
/* ------------------------------------------------------------------ */

router.post('/articles', async (req, res) => {
  try {
    // Cover checkbox wave: coverRequested is deliberately NOT
    // accepted here — this route silently drops unknown fields, so a flag sent
    // to create would vanish without an error. It rides POST /:id/start.
    const {
      topic,
      targetLength,
      confirmConcatenatedTopic,
      userNotes,
      // D6: material language ru|en, default ru.
      language,
    } = req.body;
    const errors = [];

    if (isBlank(topic)) {
      errors.push('Тема обязательна');
    } else if (typeof topic !== 'string') {
      errors.push('Тема должна быть строкой');
    } else if (topic.trim().length < 3) {
      errors.push('Тема должна содержать не менее 3 символов');
    } else if (topic.trim().length > TOPIC_MAX_LENGTH) {
      // U2.1: верхний лимит (200, не 120 — осмысленные прод-темы бывают ~150).
      errors.push(`Тема слишком длинная (макс. ${TOPIC_MAX_LENGTH} символов)`);
    }

    // D6: language — опционален; допустимы только 'ru' | 'en'.
    const ARTICLE_LANGUAGES = ['ru', 'en'];
    if (language !== undefined && language !== null && !ARTICLE_LANGUAGES.includes(language)) {
      errors.push('Язык материала должен быть одним из значений: ru, en');
    }

    if (targetLength === undefined || targetLength === null) {
      errors.push('Целевой объем обязателен');
    } else {
      const lengthNum = Number(targetLength);
      if (!Number.isInteger(lengthNum) || !isValidVolume(lengthNum)) {
        errors.push(`Целевой объем должен быть одним из значений: ${volumeOptions.join(', ')} символов`);
      }
    }

    // B3: «Уточнения к теме» — опциональная строка (угол подачи, приоритеты
    // владельца). Trim до записи; переполнение — фиксированный код контракта.
    let trimmedUserNotes = '';
    if (userNotes !== undefined && userNotes !== null) {
      if (typeof userNotes !== 'string') {
        errors.push('Уточнения к теме должны быть строкой');
      } else {
        trimmedUserNotes = userNotes.trim();
        if (trimmedUserNotes.length > USER_NOTES_MAX_LENGTH) {
          return fail(res, 'USER_NOTES_TOO_LONG', 400);
        }
      }
    }

    if (errors.length > 0) {
      return fail(res, errors.join('; '));
    }

    const trimmedTopic = topic.trim();
    const lengthNum = Number(targetLength);

    // U2.2: детект склейки поисковых фраз (см. блок U2 выше). Строго true —
    // осознанное подтверждение кнопкой «Всё равно создать» (фронт Dev-C);
    // override пропускает ТОЛЬКО этот детект, прочая валидация выше уже
    // прошла. Без БД: чистый текстовый чек до выборок существования.
    if (confirmConcatenatedTopic !== true && looksLikeConcatenatedTopic(trimmedTopic)) {
      const suggestion = buildTopicSuggestion(trimmedTopic);
      return res.status(400).json({
        success: false,
        error: `Тема похожа на склейку поисковых фраз — оставьте одну фразу, например: «${suggestion}»`,
        code: TOPIC_CONCATENATION_CODE,
        suggestion,
      });
    }

    const article = await prisma.article.create({
      data: {
        topic: trimmedTopic,
        targetLength: lengthNum,
        status: 'draft',
        // D6: 'ru' default lives in the schema; store only explicit values.
        ...(ARTICLE_LANGUAGES.includes(language) ? { language } : {}),
        // B3: пустые после trim уточнения не храним (NULL = уточнений нет).
        ...(trimmedUserNotes ? { userNotes: trimmedUserNotes } : {}),
      },
    });

    return success(res, serializeArticle(article), 201);
  } catch (err) {
    console.error('[ArticlesRouter] POST /articles error:', err);
    return fail(res, 'Не удалось создать статью', 500);
  }
});

/* ------------------------------------------------------------------ */
/*  2. POST /api/articles/:id/start                                    */
/* ------------------------------------------------------------------ */

router.post('/articles/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    // Cover checkbox wave: the «Сгенерировать
    // обложку» flag rides /start (the create route silently drops unknown
    // fields, and /start already resets the previous run's artifacts).
    const { coverRequested } = req.body || {};

    if (!validateUUID(id)) {
      return fail(res, 'Invalid article id', 400);
    }

    if (coverRequested !== undefined && typeof coverRequested !== 'boolean') {
      return failCover(res, 'cover_requested_invalid', 'coverRequested должен быть boolean', 400);
    }

    const article = await prisma.article.findUnique({ where: { id } });
    if (!article) {
      return fail(res, 'Article not found', 404);
    }

    const allowedStartStatuses = ['draft', 'failed', 'stopped', 'needs_review'];
    if (!allowedStartStatuses.includes(article.status)) {
      const runningStatuses = [
        'running',
        'topic_generation',
        'brief_preparation',
        'knowledge_base',
        'research',
        'semantic_strategy',
        'structure',
        'article_writing',
        'factcheck',
        'seo_review',
        'quality_control',
        'humanize',
      ];
      const messages = {
        queued: 'Article is already queued for generation.',
        ready: 'Article is already ready.',
        published: 'Article is already published.',
        // W «Автоматизация» (2026-10-27): понятный текст вместо общего отказа —
        // перегенерация отмеченной статьи запрещена (published_manual не в
        // allowedStartStatuses выше, поведение прежнее, только формулировка).
        published_manual: 'Статья уже отмечена как опубликованная',
      };
      const message =
        messages[article.status] ||
        (runningStatuses.includes(article.status)
          ? 'Article generation is already running.'
          : 'Cannot start generation from current status');
      return fail(res, message, 400);
    }

    await prisma.article.update({
      where: { id },
      // U3 (tech-lead review): сбрасываем причину ЗДЕСЬ, а не только в воркере
      // (worker:1394). Иначе между POST /start (status→queued) и первым
      // per-role апдейтом колонка держит причину прошлого прогона, а карточка
      // деталей рендерит её без гейта по статусу (needsReviewReason != null) —
      // «Превышен бюджет…» у статьи, которая уже перегенерируется. Списки
      // не affected (гейт needs_review на фронте), детали — affected.
      //
      data: {
        status: 'queued',
        needsReviewReason: null,
        // Cover checkbox wave: the flag is written ONLY when the field
        // was sent — an absent field leaves a pending request intact across a
        // plain re-start. true + existing cover → double-spend guard (S7):
        // consumed as skipped/cover_exists, no second image is bought.
        ...(coverRequested !== undefined
          ? {
              coverRequested: coverRequested === true && !article.coverUrl,
              ...(coverRequested === true
                ? article.coverUrl
                  ? { coverStatus: 'skipped', coverSkipReason: 'cover_exists' }
                  : { coverStatus: 'requested', coverSkipReason: null }
                : { coverStatus: null, coverSkipReason: null }),
            }
          : {}),
      },
    });

    // Используем generated jobId, чтобы избежать дубля задания в очереди при
    // повторном запуске.
    // Job можно найти по data.articleId при остановке.
    await articleGenerationQueue.add('generate', { articleId: id });

    return success(res, {
      articleId: id,
      message: 'Генерация поставлена в очередь',
      //: additive — the effective stored flag (false when the guard above
      // consumed the request; the stored value when the field was absent).
      coverRequested: coverRequested !== undefined ? coverRequested === true && !article.coverUrl : Boolean(article.coverRequested),
    });
  } catch (err) {
    console.error('[ArticlesRouter] POST /articles/:id/start error:', err);
    return fail(res, 'Не удалось запустить генерацию', 500);
  }
});

/* ------------------------------------------------------------------ */
/*  3. POST /api/articles/:id/stop                                     */
/* ------------------------------------------------------------------ */

router.post('/articles/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;

    if (!validateUUID(id)) {
      return fail(res, 'Invalid article id', 400);
    }

    const article = await prisma.article.findUnique({ where: { id } });
    if (!article) {
      return fail(res, 'Article not found', 404);
    }

    // W «Автоматизация» (2026-10-27): 'published_manual' тоже защищён —
    // остановка не должна затирать ручную отметку и возвращать статью в очередь.
    if (
      article.status === 'published' ||
      article.status === 'published_manual' ||
      article.status === 'failed' ||
      article.status === 'ready'
    ) {
      const statusText =
        article.status === 'published'
          ? 'опубликована'
          : article.status === 'published_manual'
          ? 'уже отмечена как опубликованная'
          : article.status === 'failed'
          ? 'завершена с ошибкой'
          : 'готова';
      return fail(res, `Невозможно остановить генерацию: статья ${statusText}`, 400);
    }

    await prisma.article.update({
      where: { id },
      data: { status: 'stopped' },
    });

    // Удаляем ожидающий job по articleId, если он еще не выполнен
    const jobs = await articleGenerationQueue.getJobs(['waiting', 'delayed', 'paused']);
    const job = jobs.find((j) => j.data?.articleId === id);
    if (job) {
      await job.remove();
    }

    return success(res, { message: 'Генерация остановлена' });
  } catch (err) {
    console.error('[ArticlesRouter] POST /articles/:id/stop error:', err);
    return fail(res, 'Не удалось остановить генерацию', 500);
  }
});

/* ------------------------------------------------------------------ */
/*  4. GET /api/articles/:id                                           */
/* ------------------------------------------------------------------ */

router.get('/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!validateUUID(id)) {
      return fail(res, 'Invalid article id', 400);
    }

    const article = await prisma.article.findUnique({
      where: { id },
      include: {
        // T4: узкая проекция всех ранов одной статьи — классификатору достаточно
        // этих полей (hasFallback / hasTemplateContent / generationStartedAt).
        agentRuns: {
          select: { agentName: true, status: true, startedAt: true, error: true },
        },
      },
    });

    if (!article) {
      return fail(res, 'Article not found', 404);
    }

    return success(res, serializeArticle(article));
  } catch (err) {
    console.error('[ArticlesRouter] GET /articles/:id error:', err);
    return fail(res, 'Не удалось получить статью', 500);
  }
});

/* ------------------------------------------------------------------ */
/*  5. GET /api/articles/:id/progress                                  */
/* ------------------------------------------------------------------ */

router.get('/articles/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;

    if (!validateUUID(id)) {
      return fail(res, 'Invalid article id', 400);
    }

    const article = await prisma.article.findUnique({
      where: { id },
      include: {
        agentRuns: {
          orderBy: { startedAt: 'desc' },
        },
      },
    });

    if (!article) {
      return fail(res, 'Article not found', 404);
    }

    // W2 (2026-08-14): percent во ВСЕХ ветках — из articleProgress() (единый
    // источник правды вместе с serializeArticle). Локальный расчёт удалён:
    // needs_review раньше падал в 0% (findIndex → -1), а три копии формулы
    // расходились. Семантические нюансы веток (stageName/currentStage/
    // description) сохранены. error/failed теперь честный null вместо 0.
    //
    // W4a: тот же расчёт живёт в articleProgressOverview() — маршрут
    // только отдаёт результат. Добавлен per-stage таймлайн (stages[]) —
    // он выводится из того же леджера AgentRun, второго источника правды нет.
    const overview = articleProgressOverview({
      status: article.status,
      agentRuns: article.agentRuns,
    });
    const stages = buildStageTimeline(article.agentRuns);
    const totals = stageTotals(stages);

    return success(res, {
      articleId: article.id,
      ...overview,
      overall: { ...overview, ...totals },
      stages,
    });
  } catch (err) {
    console.error('[ArticlesRouter] GET /articles/:id/progress error:', err);
    return fail(res, 'Не удалось получить прогресс генерации', 500);
  }
});

/* ------------------------------------------------------------------ */
/*  6. GET /api/articles/:id/content                                   */
/* ------------------------------------------------------------------ */

router.get('/articles/:id/content', async (req, res) => {
  try {
    const { id } = req.params;

    if (!validateUUID(id)) {
      return fail(res, 'Invalid article id', 400);
    }

    // Cover wave (docs/architecture.md §7): binding + ledger fields for the cover
    // panel state — the Article row is read as a narrow select alongside the
    // version. Additive — null until a cover exists.
    const [article, latestVersion] = await Promise.all([
      prisma.article.findUnique({
        where: { id },
        select: {
          coverUrl: true,
          // M5: the file reference of the stored cover binary.
          // The M6 panel keys readiness on it (CoverPanel.tsx:49-50) and the
          // client type declares it (src/features/generation/api.ts:35) — the
          // route has to ship it, otherwise a generated cover stays invisible.
          coverFile: true,
          coverModel: true,
          coverCostRub: true,
          coverGeneratedAt: true,
          // Cover checkbox wave: the per-article cover phase channel —
          // the UI polls it via this endpoint while coverStatus is
          // requested/generating (Director Q3: the article progress stream
          // closes at status='ready', so cover progress travels here).
          coverStatus: true,
          coverSkipReason: true,
        },
      }),
      prisma.articleVersion.findFirst({
        where: { articleId: id, platform: 'base' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!latestVersion) {
      return fail(res, 'Контент статьи не найден', 404);
    }

    // Cover + M5 (D9): coverAvailable follows the IMAGES capability
    // of the active provider — the presence of a WordPress installation is
    // irrelevant for the cover flow anymore.
    let coverAvailability;
    try {
      coverAvailability = await resolveCoverAvailability();
    } catch (err) {
      console.warn(
        '[ArticlesRouter] GET /articles/:id/content: cover availability unavailable:',
        err instanceof Error ? err.message : err,
      );
      coverAvailability = { available: false, reason: 'cover_not_configured', providerKind: null };
    }

    return success(res, {
      title: latestVersion.title,
      description: latestVersion.description,
      h1: latestVersion.title,
      contentHtml: latestVersion.contentHtml,
      // U6 (ux-fixes 2026-08-18): contentText — СВЕЖЕ выведен из contentHtml
      // версии реальной htmlToPlainText (после фикса Dev-A — перенососохраняющей),
      // а НЕ из хранимого поля: у старых версий текст «кашей в одну строку».
      // Ретро-полечение старых статей без миграции. Хранимое поле остаётся
      // для characterCount/совместимости.
      contentText: latestVersion.contentHtml
        ? htmlToPlainText(latestVersion.contentHtml)
        : (latestVersion.contentText ?? ''),
      characterCount: latestVersion.characterCount,
      // T6: nullable-колонку в схему добавляет программист A. Нейтральный
      // доступ: до `prisma generate` поля просто нет → undefined → null,
      // после — значение или null. Отдельных эндпоинтов не требуется.
      contentMarkdown: latestVersion.contentMarkdown ?? null,
      // Cover wave (2026-10-24, docs/architecture.md §7): additive binding fields.
      // coverCostRub (Prisma Decimal) leaves the API as a plain Number;
      // coverGeneratedAt serializes to ISO via res.json.
      coverUrl: article?.coverUrl ?? null,
      // M5: the file reference of the stored cover binary — the
      // panel reads it to decide that a cover exists (CoverPanel.tsx:49-50).
      coverFile: article?.coverFile ?? null,
      coverModel: article?.coverModel ?? null,
      coverCostRub:
        article?.coverCostRub != null ? Number(article.coverCostRub) : null,
      coverGeneratedAt: article?.coverGeneratedAt ?? null,
      // Cover checkbox wave: the phase channel for the panel refresh
      // loop and the skip/fail note. Neutral access (old prisma client → null).
      coverStatus: article?.coverStatus ?? null,
      coverSkipReason: article?.coverSkipReason ?? null,
      // Feature-off total: the button hides when the flow is disabled or the
      // active provider cannot generate images (M5: the WP storage
      // gate is gone, the gate is the images capability of the provider).
      coverAvailable: coverAvailability.available,
      coverUnavailableReason: coverAvailability.reason,
    });
  } catch (err) {
    console.error('[ArticlesRouter] GET /articles/:id/content error:', err);
    return fail(res, 'Не удалось получить контент статьи', 500);
  }
});

/* ------------------------------------------------------------------ */
/*  6b. PUT /api/articles/:id/content  (manual editor save, Bug #15)   */
/* ------------------------------------------------------------------ */
router.put('/articles/:id/content', async (req, res) => {
  try {
    const { id } = req.params;

    if (!validateUUID(id)) {
      return fail(res, 'Invalid article id', 400);
    }

    const { contentText, contentHtml, title, description } = req.body || {};
    if (contentText == null && contentHtml == null) {
      return fail(res, 'Требуется contentText или contentHtml', 400);
    }

    const article = await prisma.article.findUnique({ where: { id } });
    if (!article) {
      return fail(res, 'Статья не найдена', 404);
    }

    // Take the latest version as the base, override provided fields, persist as a new version.
    const base = await prisma.articleVersion.findFirst({
      where: { articleId: id, platform: 'base' },
      orderBy: { createdAt: 'desc' },
    });

    const text = contentText ?? base?.contentText ?? '';
    const html = contentHtml ?? base?.contentHtml ?? null;
    const finalTitle = title ?? base?.title ?? article.topic;
    const finalDescription = description ?? base?.description ?? null;
    // ArticleVersion.version is an Int with no default; bump the prior version.
    const nextVersion = base ? base.version + 1 : 1;

    const version = await prisma.articleVersion.create({
      data: {
        articleId: id,
        version: nextVersion,
        platform: 'base',
        title: finalTitle,
        description: finalDescription,
        contentHtml: html,
        contentText: text,
        characterCount: text.length,
        // T6: contentMarkdown умышленно НЕ наследуется из base — ручная правка
        // делает markdown-копию устаревшей, новая версия создаётся с NULL.
        // Nullable-колонка => пропуск поля даёт NULL. Явно передавать
        // `contentMarkdown: null` нельзя: пока `prisma generate` не подхватил
        // колонку (её добавляет программист A), Prisma уронит create с
        // Unknown argument.
      },
    });

    // Advance status from intermediate generation stages to a stable 'ready'.
    // W «Автоматизация» (2026-10-27): 'published_manual' в stableStatuses —
    // правка текста НЕ сбрасывает ручную отметку обратно в 'ready' (иначе
    // статья молча вернулась бы в очередь).
    const stableStatuses = ['ready', 'completed', 'published', 'published_manual', 'stopped'];
    if (!stableStatuses.includes(article.status)) {
      await prisma.article.update({ where: { id }, data: { status: 'ready' } });
    }

    return success(res, {
      versionId: version.id,
      characterCount: version.characterCount,
      updatedAt: version.createdAt,
    });
  } catch (err) {
    console.error('[ArticlesRouter] PUT /articles/:id/content error:', err);
    return fail(res, 'Не удалось сохранить контент статьи', 500);
  }
});

/* ------------------------------------------------------------------ */
/*  6c. GET /api/articles/:id/details                                  */
/*     Тема, объём (запрошено/получено), источники по провайдерам,     */
/*     ключи SEO-ядра (топ-N), прогресс по ролям (agentRuns).          */
/* ------------------------------------------------------------------ */

router.get('/articles/:id/details', async (req, res) => {
  const { id } = req.params;
  try {
    if (!validateUUID(id)) {
      return fail(res, 'Invalid article id', 400);
    }

    const article = await prisma.article.findUnique({
      where: { id },
      include: {
        versions: { orderBy: { createdAt: 'desc' }, take: 1 },
        researchSources: true,
        agentRuns: { orderBy: { startedAt: 'asc' } },
      },
    });
    if (!article) return res.status(404).json({ error: 'Article not found' });

    // Группировка researchSources по провайдеру
    const sourcesByProvider = {};
    for (const src of article.researchSources) {
      const p = src.provider || 'unknown';
      if (!sourcesByProvider[p]) sourcesByProvider[p] = [];
      sourcesByProvider[p].push({
        id: src.id,
        title: src.title,
        sourceUrl: src.sourceUrl,
        evidenceLevel: src.evidenceLevel,
        snippet: (src.snippet || '').slice(0, 200),
      });
    }

    const lastVersion = article.versions[0];
    // W2.3: постчек-поля — из уже выбранных agentRuns (include выше тянет
    // раны целиком), без дополнительных запросов. Кривой/отсутствующий
    // outputJson → postcheck:null (обратная совместимость со старыми статьями).
    // FIX-3: articleStatus нужен для generic-фолбэка needsReviewReason.
    // U3: колонка needsReviewReason — верх приоритетной цепочки (нейтральный
    // доступ: до миграции Dev-A поля нет → undefined → null внутри хелпера).
    const postcheckFields = buildPostcheckFields(article.agentRuns, {
      articleStatus: article.status,
      articleNeedsReviewReason: article.needsReviewReason,
    });
    return res.json({
      id: article.id,
      topic: article.topic,
      targetLength: article.targetLength,
      // D6: material language of the article (ru | en).
      language: article.language || 'ru',
      characterCount: lastVersion?.characterCount ?? null,
      sourcesByProvider,
      sourcesTotal: article.researchSources.length,
      agentRuns: article.agentRuns.map((r) => ({
        agentName: r.agentName,
        status: r.status,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costRub: r.costRub ? Number(r.costRub) : null,
        error: r.error ? String(r.error).slice(0, 200) : null,
      })),
      // W2.3: полный отчёт пост-проверки (контракт Dev-A) + лёгкие поля.
      postcheck: postcheckFields.postcheck,
      postcheckVerdict: postcheckFields.postcheckVerdict,
      needsReviewReason: postcheckFields.needsReviewReason,
      // Cover checkbox wave: the details modal already renders
      // the cover block — the backend just never fed it (dead branch). These
      // seven fields revive it and carry the skip/fail note. Decimal → Number
      // like agentRuns.costRub above.
      coverUrl: article.coverUrl ?? null,
      // M5: the FILE REFERENCE of the cover binary (<data-dir>/covers/<id>-<n>.<ext>).
      // The details modal renders /api/articles/:id/cover only when this field is
      // set — without it the cover picture never appears in the modal.
      coverFile: article.coverFile ?? null,
      coverModel: article.coverModel ?? null,
      coverCostRub: article.coverCostRub != null ? Number(article.coverCostRub) : null,
      coverGeneratedAt: article.coverGeneratedAt ?? null,
      coverStatus: article.coverStatus ?? null,
      coverSkipReason: article.coverSkipReason ?? null,
    });
  } catch (err) {
    console.error('[ArticlesRouter] GET /articles/:id/details error:', err);
    return res.status(500).json({ error: `Failed to load details: ${err.message}` });
  }
});

/* ------------------------------------------------------------------ */
/*  9. DELETE /api/articles/:id                                       */
/* ------------------------------------------------------------------ */

router.delete('/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!validateUUID(id)) {
      return fail(res, 'Invalid article id', 400);
    }

    const article = await prisma.article.findUnique({ where: { id } });
    if (!article) {
      return fail(res, 'Article not found', 404);
    }

    await prisma.article.delete({ where: { id } });
    // M5: the delete cascade removes the cover files too — the
    // binary store is the article's storage, not a remote attachment.
    try {
      removeArticleCovers(id);
    } catch (err) {
      console.error('[ArticlesRouter] DELETE /articles/:id: cover cleanup failed:', err);
    }
    return success(res, { message: 'Статья удалена' });
  } catch (err) {
    console.error('[ArticlesRouter] DELETE /articles/:id error:', err);
    return fail(res, 'Не удалось удалить статью', 500);
  }
});

/* ------------------------------------------------------------------ */
/* 11. GET /api/articles/:id/cover (M5) */
/* ------------------------------------------------------------------ */

/**
 * Serve the stored cover binary (the UI expects a binary route
 * on the same path where POST triggers the generation).
 *
 * The bytes come from the LOCAL store (<data-dir>/covers/<articleId>-<n>.<ext>);
 * the DB keeps the file reference. A missing article, a missing reference or
 * a missing file is a 404 with the machine code `cover_not_found`.
 */
router.get('/articles/:id/cover', async (req, res) => {
  const { id } = req.params;
  try {
    if (!validateUUID(id)) {
      return failCover(res, 'cover_invalid_article_id', 'Некорректный идентификатор статьи', 400);
    }

    const article = await prisma.article.findUnique({
      where: { id },
      select: { id: true, coverFile: true },
    });
    if (!article || !article.coverFile) {
      return failCover(res, 'cover_not_found', 'Обложка не найдена', 404);
    }

    const stored = readCoverBinary({ articleId: id, file: article.coverFile });
    if (!stored) {
      return failCover(res, 'cover_not_found', 'Обложка не найдена', 404);
    }

    res.setHeader('Content-Type', stored.contentType);
    res.setHeader('Content-Length', String(stored.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(stored.buffer);
  } catch (err) {
    console.error('[ArticlesRouter] GET /articles/:id/cover error:', err);
    return failCover(res, 'cover_read_failed', 'Не удалось прочитать обложку', 500);
  }
});

/* ------------------------------------------------------------------ */
/* 10. POST /api/articles/:id/cover (cover wave) */
/* ------------------------------------------------------------------ */

/**
 * Generate (or re-generate) the article cover. Body — both fields optional:
 *   { refinement?: string ≤ 500, fresh?: boolean }
 * `fresh:true` wins over `refinement` («Сгенерировать заново»); an empty
 * body is the first generation («Сгенерировать обложку»).
 *
 * The route is a THIN ADAPTER: validation, article load, the in-flight guard
 * and every semantic gate live in server/lib/cover-service.mjs (one
 * concurrent generation per article, released in finally). CoverFlowError
 * arrives with {code,status,message} pinned to the plan's error table —
 * the route maps it onto the response; anything else is an unexpected
 * failure (502 + the generation code, service logged upstream).
 * D8: the flow NEVER writes Article.status.
 */
router.post('/articles/:id/cover', async (req, res) => {
  const { id } = req.params;
  try {
    const { refinement, fresh } = req.body || {};
    const data = await generateCoverForArticle({ articleId: id, refinement, fresh });
    return success(res, data);
  } catch (err) {
    if (err instanceof CoverFlowError) {
      return failCover(res, err.code, err.message, err.status);
    }
    console.error('[ArticlesRouter] POST /articles/:id/cover error:', err);
    return failCover(
      res,
      'cover_generation_failed',
      'Не удалось получить изображение у модели. Попробуйте ещё раз.',
      502,
    );
  }
});

/* ------------------------------------------------------------------ */

// Экспортировано для юнит-тестов согласованности прогресса (W2): тесты
// сверяют serializeArticle.progress с расчётом /:id/progress и картой ролей.
// W2.3: постчек-хелперы экспортированы для tests/unit/postcheck-api.test.mjs.
// U2 (ux-fixes): topic-детектор (эвристика склейки) — спецификация в блоке
// U2 выше; контракт темы покрыт tests/integration/article-topic-edge-cases.test.mjs.
export {
  router as articlesRouter,
  serializeArticle,
  ROLE_STATUS_MAP,
  POSTCHECK_AGENT_NAME,
  POSTCHECK_VERDICTS,
  NEEDS_REVIEW_FALLBACK_REASON,
  parsePostcheckReport,
  postcheckVerdict,
  buildNeedsReviewReason,
  buildPostcheckFields,
  TOPIC_MAX_LENGTH,
  TOPIC_CONCATENATION_CODE,
  looksLikeConcatenatedTopic,
  buildTopicSuggestion,
};
